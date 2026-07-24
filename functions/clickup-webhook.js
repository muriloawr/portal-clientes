// Cloudflare Pages Function — POST /clickup-webhook
// Disparada pelo workflow agendado do GitHub Actions (não mais por um webhook do
// ClickUp). Para cada cliente cadastrado em CLIENTS, busca o estado completo das
// subtasks da task-mãe dele (por taskId, direto — não importa em qual lista/espaço
// do ClickUp essa task está) e re-commita o array `months` no HTML correspondente
// no GitHub. O deploy do Cloudflare Pages já dispara sozinho a partir do commit.
// Adicionar um cliente novo é só adicionar uma entrada em CLIENTS.

// Clientes com um serviço só usam `taskId` (escreve `const months = [...]` no HTML).
// Clientes com mais de um serviço (ex: CRO + CRM) usam `services`, cada um com seu
// próprio taskId — escreve `const services = [{ key, label, months }, ...]` no HTML,
// e o front-end mostra uma aba por serviço.
const CLIENTS = [
  { name: 'Humara', taskId: 'wdpu2ybtwm', filePath: 'humara/index.html' },
  { name: 'Uplift Fitness', taskId: '86aewgr7t', filePath: 'uplift-fitness/index.html' },
  { name: 'InfinitAge', taskId: '86aeu720q', filePath: 'infinitage/index.html' },
  {
    name: 'Adah Beauty Tech',
    filePath: 'adah-beauty-tech/index.html',
    services: [
      { key: 'cro', label: 'CRO', taskId: '86aeu71ur' },
      { key: 'crm', label: 'CRM', taskId: 'wdpu2ydp1p' },
    ],
  },
];

const REPO_OWNER = 'muriloawr';
const REPO_NAME = 'portal-clientes';
const BRANCH = 'main';

const STATUS_MAP = {
  'a fazer': 'a-fazer',
  'em análise': 'em-analise',
  'em andamento': 'em-andamento',
  'concluído': 'feito',
  // 'fechado' é omitido de propósito: arquivado do mês, não aparece no relatório
};

const MONTH_LABELS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export async function onRequestPost(context) {
  const { request, env } = context;
  const rawBody = await request.text();

  const signature = request.headers.get('X-Signature');
  const expectedSig = await computeSignature(rawBody, env.CLICKUP_WEBHOOK_SECRET);
  if (!signature || !timingSafeEqual(expectedSig, signature)) {
    return new Response('Invalid signature', { status: 401 });
  }

  const results = [];
  for (const client of CLIENTS) {
    try {
      results.push(`${client.name}: ${await syncClient(client, env)}`);
    } catch (err) {
      results.push(`${client.name}: FAILED - ${err.message}`);
    }
  }

  const anyFailed = results.some(r => r.includes('FAILED'));
  return new Response(results.join('\n'), { status: anyFailed ? 500 : 200 });
}

export async function onRequestGet() {
  return new Response('clickup-webhook: use POST', { status: 200 });
}

async function syncClient(client, env) {
  const { content, sha } = await getGithubFile(client.filePath, env.GITHUB_TOKEN);

  let updated;
  if (client.services) {
    const services = [];
    for (const service of client.services) {
      const months = await buildMonths(service.taskId, env.CLICKUP_API_TOKEN);
      services.push({ key: service.key, label: service.label, months });
    }
    updated = replaceServicesArray(content, services);
  } else {
    const months = await buildMonths(client.taskId, env.CLICKUP_API_TOKEN);
    updated = replaceMonthsArray(content, months);
  }

  if (updated === content) return 'no changes';

  await commitGithubFile(client.filePath, updated, sha, client.name, env.GITHUB_TOKEN);
  return 'synced';
}

// --- assinatura ---

async function computeSignature(rawBody, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  return [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// --- ClickUp ---

async function fetchSubtasks(taskId, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}?include_subtasks=true`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`ClickUp API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.subtasks || [];
}

function monthKeyLabel(dateMs) {
  const d = new Date(dateMs);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const label = `${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`;
  return { key, label };
}

function formatDeadline(dateMs) {
  const d = new Date(dateMs);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function buildMonths(taskId, token) {
  const subtasks = await fetchSubtasks(taskId, token);
  const monthsMap = new Map();

  for (const t of subtasks) {
    const statusRaw = (t.status && t.status.status ? t.status.status : '').toLowerCase();
    const status = STATUS_MAP[statusRaw];
    if (!status) continue; // 'fechado' ou status não mapeado: não entra no relatório

    const refDateMs = t.due_date ? Number(t.due_date) : Number(t.date_created);
    const { key, label } = monthKeyLabel(refDateMs);

    if (!monthsMap.has(key)) monthsMap.set(key, { key, label, demands: [] });
    monthsMap.get(key).demands.push({
      title: t.name,
      deadline: t.due_date ? formatDeadline(Number(t.due_date)) : '',
      status,
      owner: t.assignees && t.assignees[0] ? t.assignees[0].username.split(' ')[0] : '',
      hours: t.time_estimate ? Math.round((Number(t.time_estimate) / 3600000) * 100) / 100 : null,
      _sort: refDateMs,
    });
  }

  const months = [...monthsMap.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const m of months) {
    // Demandas com prazo vêm primeiro (ordenadas por data); sem prazo ficam depois,
    // independente de terem horas registradas ou já estarem concluídas.
    m.demands.sort((a, b) => {
      const aHasDeadline = a.deadline !== '';
      const bHasDeadline = b.deadline !== '';
      if (aHasDeadline !== bHasDeadline) return aHasDeadline ? -1 : 1;
      return a._sort - b._sort;
    });
    m.demands.forEach(d => delete d._sort);
  }
  return months;
}

function escapeJs(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function monthsArrayLiteral(months) {
  const body = months.map(m => {
    const demandsJs = m.demands.map(d =>
      `        { title: '${escapeJs(d.title)}', deadline: '${escapeJs(d.deadline)}', status: '${d.status}', owner: '${escapeJs(d.owner)}', hours: ${d.hours == null ? 'null' : d.hours} },`,
    ).join('\n');
    return `    {\n      key: '${m.key}',\n      label: '${escapeJs(m.label)}',\n      demands: [\n${demandsJs}\n      ],\n    },`;
  }).join('\n');
  return `[\n${body}\n  ]`;
}

function monthsToJs(months) {
  return `const months = ${monthsArrayLiteral(months)};`;
}

function servicesToJs(services) {
  const body = services.map(s =>
    `    { key: '${s.key}', label: '${escapeJs(s.label)}', months: ${monthsArrayLiteral(s.months)} },`,
  ).join('\n');
  return `const services = [\n${body}\n  ];`;
}

function replaceMonthsArray(html, months) {
  const regex = /const\s+months\s*=\s*\[[\s\S]*?\];/;
  if (!regex.test(html)) throw new Error('months array not found in HTML');
  return html.replace(regex, monthsToJs(months));
}

function replaceServicesArray(html, services) {
  const regex = /const\s+services\s*=\s*\[[\s\S]*?\];/;
  if (!regex.test(html)) throw new Error('services array not found in HTML');
  return html.replace(regex, servicesToJs(services));
}

// --- GitHub ---

async function getGithubFile(filePath, token) {
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}?ref=${BRANCH}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'clickup-sync-worker',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const binary = atob(data.content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const content = new TextDecoder('utf-8').decode(bytes);
  return { content, sha: data.sha };
}

async function commitGithubFile(filePath, content, sha, clientName, token) {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  const base64 = btoa(binary);

  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'clickup-sync-worker',
    },
    body: JSON.stringify({
      message: `sync: atualiza relatório ${clientName} a partir do ClickUp`,
      content: base64,
      sha,
      branch: BRANCH,
    }),
  });
  if (!res.ok) throw new Error(`GitHub PUT error: ${res.status} ${await res.text()}`);
}
