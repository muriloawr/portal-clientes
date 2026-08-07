// Cloudflare Pages Function — POST /financeiro-sync
// Sincroniza a lista "Financeiro" do ClickUp (task-mãe por cliente, status
// "clientes"; subtask por fatura/mês; link de NF/Boleto do Drive lido de
// comentário no formato "NF: <link>" / "Boleto: <link>") pro D1. Mesmo
// padrão de autenticação HMAC do clickup-webhook.js, disparado pelo mesmo
// workflow agendado — mas diferente de lá, processa TODOS os clientes numa
// chamada só (escrita no D1 é barata; o que force o "um por vez" nos outros
// syncs é o commit no GitHub, que não existe aqui).

import { computeSignature, timingSafeEqual, clickUpFetch } from './_lib/clickup-shared.js';
import { CLIENT_SLUGS, fetchSubtasks, fetchListTasks, statusKeyOf } from './clickup-webhook.js';

const FINANCEIRO_LIST_ID = '1000240000008035';

// Margem de segurança abaixo do limite de 50 subrequests/invocação do plano
// free da Cloudflare — cada task-mãe custa 1 chamada (subtasks) + 1 por
// fatura (comentários). Se estourar, para no meio e retoma no próximo ciclo
// do cron (upsert é idempotente, reprocessar o que já rodou não tem custo).
const MAX_CLICKUP_CALLS = 35;

const LINK_RE = /(NF|Boleto)\s*:\s*(https?:\/\/\S+)/gi;

async function fetchAllComments(taskId, token) {
  const res = await clickUpFetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`ClickUp API error (comment): ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.comments || [];
}

// Varre TODOS os comentários (não só o primeiro) e fica com a ocorrência
// mais recente de cada label — permite o usuário corrigir um link postando
// de novo, sem precisar editar/apagar o comentário antigo.
function extractLinks(comments) {
  const best = {};
  for (const c of comments) {
    const text = c.comment_text || (Array.isArray(c.comment) ? c.comment.map(p => p.text || '').join('') : '') || '';
    const date = Number(c.date) || 0;
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(text))) {
      const kind = m[1].toLowerCase() === 'nf' ? 'nf' : 'boleto';
      const url = m[2].replace(/[),.]+$/, '');
      if (!best[kind] || date >= best[kind].date) {
        best[kind] = { url, date, commentId: c.id };
      }
    }
  }
  return best;
}

async function upsertClient(db, name, financeiroTaskId) {
  const slug = CLIENT_SLUGS[name];
  if (!slug) return null;

  await db.prepare(
    `INSERT INTO clients (slug, name, financeiro_task_id)
     VALUES (?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       name = excluded.name, financeiro_task_id = excluded.financeiro_task_id, updated_at = unixepoch()`,
  ).bind(slug, name, financeiroTaskId).run();

  const row = await db.prepare('SELECT id FROM clients WHERE slug = ?').bind(slug).first();
  return row ? row.id : null;
}

async function upsertInvoice(db, clientId, subtask) {
  const paid = statusKeyOf(subtask) === 'concluido' ? 1 : 0;
  const dueDate = subtask.due_date ? Number(subtask.due_date) : null;
  const paidDate = paid && subtask.date_closed ? Number(subtask.date_closed) : null;
  const statusRaw = (subtask.status && subtask.status.status) || '';

  await db.prepare(
    `INSERT INTO invoices (client_id, clickup_task_id, label, status, paid, due_date, paid_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(clickup_task_id) DO UPDATE SET
       label = excluded.label, status = excluded.status, paid = excluded.paid,
       due_date = excluded.due_date, paid_date = excluded.paid_date, synced_at = unixepoch()`,
  ).bind(clientId, subtask.id, subtask.name, statusRaw, paid, dueDate, paidDate).run();

  const row = await db.prepare('SELECT id FROM invoices WHERE clickup_task_id = ?').bind(subtask.id).first();
  return row ? row.id : null;
}

async function upsertLink(db, invoiceId, kind, link) {
  await db.prepare(
    `INSERT INTO invoice_links (invoice_id, kind, url, comment_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(invoice_id, kind) DO UPDATE SET
       url = excluded.url, comment_id = excluded.comment_id, synced_at = unixepoch()`,
  ).bind(invoiceId, kind, link.url, String(link.commentId || '')).run();
}

async function syncFinanceiro(env) {
  const token = env.CLICKUP_API_TOKEN;
  const db = env.DB;
  const results = [];
  let calls = 0;

  const tasks = await fetchListTasks(FINANCEIRO_LIST_ID, token);
  calls++;
  const clientTasks = tasks.filter(t => statusKeyOf(t) === 'clientes');

  for (const clientTask of clientTasks) {
    if (calls >= MAX_CLICKUP_CALLS) {
      results.push(`parado por limite de subrequests nessa invocação (${calls} chamadas já feitas) — retoma no próximo ciclo`);
      break;
    }

    const slug = CLIENT_SLUGS[clientTask.name];
    if (!slug) {
      results.push(`"${clientTask.name}": nome não bate com nenhum cliente conhecido em CLIENTS — pulado`);
      continue;
    }

    let subtasks;
    try {
      subtasks = await fetchSubtasks(clientTask.id, token);
      calls++;
    } catch (err) {
      results.push(`"${clientTask.name}": FAILED buscando faturas - ${err.message}`);
      continue;
    }

    const clientId = await upsertClient(db, clientTask.name, clientTask.id);

    let invoiceCount = 0;
    let linkCount = 0;
    const missingLinks = [];
    for (const subtask of subtasks) {
      if (calls >= MAX_CLICKUP_CALLS) {
        results.push(`"${clientTask.name}": parado no meio das faturas por limite de subrequests`);
        break;
      }

      const invoiceId = await upsertInvoice(db, clientId, subtask);
      invoiceCount++;

      let comments;
      try {
        comments = await fetchAllComments(subtask.id, token);
        calls++;
      } catch (err) {
        results.push(`"${clientTask.name}" / "${subtask.name}": FAILED buscando comentários - ${err.message}`);
        continue;
      }

      const links = extractLinks(comments);
      if (!links.nf && !links.boleto) missingLinks.push(subtask.name);
      if (links.nf) { await upsertLink(db, invoiceId, 'nf', links.nf); linkCount++; }
      if (links.boleto) { await upsertLink(db, invoiceId, 'boleto', links.boleto); linkCount++; }
    }

    let msg = `"${clientTask.name}": ${invoiceCount} fatura(s), ${linkCount} link(s)`;
    if (missingLinks.length > 0) msg += ` — sem NF/Boleto encontrado em: ${missingLinks.join(', ')}`;
    results.push(msg);
  }

  return results;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const rawBody = await request.text();

  const signature = request.headers.get('X-Signature');
  const expectedSig = await computeSignature(rawBody, env.CLICKUP_WEBHOOK_SECRET);
  if (!signature || !timingSafeEqual(expectedSig, signature)) {
    return new Response('Invalid signature', { status: 401 });
  }

  try {
    const results = await syncFinanceiro(env);
    const anyFailed = results.some(r => r.includes('FAILED'));
    return new Response(results.join('\n') || 'nada pra sincronizar', { status: anyFailed ? 500 : 200 });
  } catch (err) {
    return new Response(`FAILED - ${err.message}`, { status: 500 });
  }
}

export async function onRequestGet() {
  return new Response('financeiro-sync: use POST', { status: 200 });
}
