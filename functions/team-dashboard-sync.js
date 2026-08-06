// Cloudflare Pages Function — POST /team-dashboard-sync
// Painel interno de gestão: "o que cada pessoa tem pra fazer hoje" + "o que já
// fez nos dias anteriores". Disparada pelo workflow agendado do GitHub Actions
// (mesmo esquema de functions/clickup-webhook.js), na mesma janela de horário
// comercial. Ao contrário do sync de clientes, aqui não há fan-out por item
// (não busca comentário de cada task) — só pagina as 4 listas abaixo, então
// dá pra sincronizar tudo numa invocação só sem estourar o limite de
// subrequests do Worker.
//
// Escopo: listas "Clientes Recorrentes" (CRO, CRM, Planejamento) + "Projetos"
// (Gestão de Projetos). "Horas Extras" fica de fora de propósito — é outro
// tipo de registro, não trabalho do dia a dia.
//
// Só entram tarefas com pelo menos um responsável atribuído (tarefas sem
// responsável são estrutura — task-mãe de cliente, item ainda não distribuído
// — não aparecem "de ninguém" no painel). Status "clientes" também é
// ignorado: é só um marcador de pasta (task com o nome do cliente) usado nas
// listas CRO/CRM, não trabalho de verdade.

import { computeSignature, timingSafeEqual, clickUpFetch, getGithubFile, commitGithubFile, escapeJs } from './_lib/clickup-shared.js';

const LISTS = [
  { id: '901321909248', name: 'CRO' },
  { id: '1000240000006366', name: 'CRM' },
  { id: '1000240000007728', name: 'Planejamento' },
  { id: '901324765433', name: 'Projetos' },
];

const FILE_PATH = 'team-dashboard/index.html';

// "concluído" normalmente falta date_closed no ClickUp (só "fechado", o
// status de arquivamento, grava esse campo de forma confiável) — ambos contam
// como fechado pro painel, mas o histórico cai pro due_date como aproximação
// quando date_closed não existir (ver buildPersonBuckets).
const CLOSED_STATUSES = new Set(['concluído', 'fechado']);
const IN_PROGRESS_STATUS = 'em andamento';
const IGNORED_STATUS = 'clientes';

// Só entra no "Feito recentemente" se a data (de fechamento ou aproximada)
// cair dentro dessa janela — sem isso o histórico ia acumulando pra sempre.
const HISTORY_LOOKBACK_DAYS = 14;
const MAX_PAGES_PER_LIST = 40;

// Janela do "ritmo de entrega" (gráfico de tendência semanal) — independente
// do HISTORY_LOOKBACK_DAYS acima (que é string de dia em fuso SP, pra exibir
// detalhe do que fechou quando). Aqui é só contagem por semana em ms corridos,
// não precisa da mesma precisão de fuso.
const TREND_WEEKS = 8;

export async function onRequestPost(context) {
  const { request, env } = context;
  const rawBody = await request.text();

  const signature = request.headers.get('X-Signature');
  const expectedSig = await computeSignature(rawBody, env.CLICKUP_WEBHOOK_SECRET);
  if (!signature || !timingSafeEqual(expectedSig, signature)) {
    return new Response('Invalid signature', { status: 401 });
  }

  try {
    const members = await fetchWorkspaceMembers(env.CLICKUP_API_TOKEN);
    const allTasks = [];
    for (const list of LISTS) {
      const tasks = await fetchAllListTasks(list.id, list.name, env.CLICKUP_API_TOKEN);
      allTasks.push(...tasks);
    }

    const people = buildPeople(allTasks, members);
    const { content, sha } = await getGithubFile(FILE_PATH, env.GITHUB_TOKEN);

    // Só recommita (e só avança o "Atualizado em") quando algo de verdade
    // mudou — reusar o generatedAt já publicado pra essa comparação evita
    // commitar (e disparar um deploy no Cloudflare) toda vez que o cron
    // roda sem nenhuma mudança real vinda do ClickUp.
    const prevGeneratedAt = extractGeneratedAt(content);
    const sameTimestamp = replaceTeamData(content, { generatedAt: prevGeneratedAt, people });
    if (sameTimestamp === content) return new Response('no changes', { status: 200 });

    const updated = replaceTeamData(content, { generatedAt: Date.now(), people });
    await commitGithubFile(FILE_PATH, updated, sha, 'sync: atualiza painel de gestão a partir do ClickUp', env.GITHUB_TOKEN);
    return new Response('synced', { status: 200 });
  } catch (err) {
    return new Response(`FAILED - ${err.message}`, { status: 500 });
  }
}

export async function onRequestGet() {
  return new Response('team-dashboard-sync: use POST', { status: 200 });
}

// --- ClickUp ---

async function fetchAllListTasks(listId, listName, token) {
  const tasks = [];
  for (let page = 0; page < MAX_PAGES_PER_LIST; page++) {
    const url = `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&subtasks=true&page=${page}`;
    const res = await clickUpFetch(url, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`ClickUp API error (list ${listName}): ${res.status} ${await res.text()}`);
    const data = await res.json();
    const pageTasks = data.tasks || [];
    for (const t of pageTasks) tasks.push({ ...t, _listName: listName });
    if (pageTasks.length === 0 || data.last_page) break;
  }
  return tasks;
}

// Membros do workspace, buscados a cada sync (em vez de uma lista fixa
// mantida à mão) — pré-populam o painel pra quem está com a fila zerada
// ainda aparecer, e servem de allowlist pra excluir quem já saiu da empresa
// (o ClickUp não limpa retroativamente assignees antigos em tasks quando
// alguém é removido do workspace, então sem esse filtro gente desligada
// continuaria aparecendo pra sempre).
async function fetchWorkspaceMembers(token) {
  const res = await clickUpFetch('https://api.clickup.com/api/v2/team', { headers: { Authorization: token } });
  if (!res.ok) throw new Error(`ClickUp API error (team members): ${res.status} ${await res.text()}`);
  const data = await res.json();
  const team = (data.teams || [])[0];
  if (!team) throw new Error('ClickUp API: nenhum workspace retornado em /team');
  return (team.members || [])
    .map(m => m.user)
    .filter(Boolean)
    .map(u => ({ id: u.id, username: u.username || `#${u.id}` }));
}

function statusOf(task) {
  return (task.status && task.status.status ? task.status.status : '').toLowerCase();
}

// Formato "YYYY-MM-DD" no fuso de negócio (America/Sao_Paulo) — o Worker roda
// em UTC, então "devido hoje" comparado direto em UTC erraria o dia perto da
// virada (21h-00h em São Paulo já é o dia seguinte em UTC).
const SP_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
});
function ymdSaoPaulo(ms) {
  return SP_FORMATTER.format(new Date(ms));
}

// Sobe a cadeia `parent` de uma task até achar a task-mãe que representa o
// cliente: em CRO/CRM/Planejamento, pára no primeiro ancestral com status
// "clientes" (o marcador de pasta, ver IGNORED_STATUS); em Projetos, não tem
// esse marcador — a raiz já É o projeto do cliente, então a cadeia sobe até
// o topo. Cache por chamada (não top-level do módulo: o Worker pode reusar
// isolate entre requests, um cache module-level vazaria entre syncs).
function buildClientResolver(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const cache = new Map();
  return function resolveClient(id) {
    if (cache.has(id)) return cache.get(id);
    const path = [];
    let cur = byId.get(id);
    let hops = 0;
    while (cur && hops < 20) {
      path.push(cur.id);
      if (statusOf(cur) === IGNORED_STATUS) break;
      const next = cur.parent ? byId.get(cur.parent) : null;
      if (!next) break;
      cur = next;
      hops++;
    }
    const client = cur ? cur.name : null;
    for (const pid of path) cache.set(pid, client);
    return client;
  };
}

function emptyPerson(id, name) {
  return {
    id, name,
    today: [], overdue: [], upcoming: [], inProgress: [], backlog: [], doneRecent: [],
    weeklyDone: new Array(TREND_WEEKS).fill(0),
  };
}

function buildPeople(tasks, members) {
  const todayStr = ymdSaoPaulo(Date.now());
  const lookbackStartStr = ymdSaoPaulo(Date.now() - HISTORY_LOOKBACK_DAYS * 86400000);
  const resolveClient = buildClientResolver(tasks);
  const memberIds = new Set(members.map(m => m.id));
  const peopleMap = new Map();
  for (const member of members) {
    peopleMap.set(member.id, emptyPerson(member.id, member.username));
  }

  function personEntry(assignee) {
    if (!peopleMap.has(assignee.id)) {
      peopleMap.set(assignee.id, emptyPerson(assignee.id, assignee.username || `#${assignee.id}`));
    }
    return peopleMap.get(assignee.id);
  }

  for (const t of tasks) {
    const assignees = (t.assignees || []).filter(a => memberIds.has(a.id));
    if (assignees.length === 0) continue;
    const status = statusOf(t);
    if (status === IGNORED_STATUS) continue;

    const isClosed = CLOSED_STATUSES.has(status);
    const isInProgress = status === IN_PROGRESS_STATUS;
    const dueMs = t.due_date ? Number(t.due_date) : null;
    const dueStr = dueMs ? ymdSaoPaulo(dueMs) : null;

    const base = {
      id: t.id,
      title: t.name,
      url: t.url,
      list: t._listName,
      client: resolveClient(t.id),
      status,
      dueMs,
    };

    for (const assignee of assignees) {
      const person = personEntry(assignee);

      if (isClosed) {
        const closedMs = t.date_closed ? Number(t.date_closed) : null;
        const approxMs = closedMs == null ? dueMs : null;
        const effectiveMs = closedMs != null ? closedMs : approxMs;
        if (effectiveMs != null) {
          if (ymdSaoPaulo(effectiveMs) >= lookbackStartStr) {
            person.doneRecent.push({ ...base, closedMs: effectiveMs, approx: closedMs == null });
          }
          // Independente da janela acima — bucket semanal pro gráfico de
          // tendência. ageMs pode ser negativo quando cai no fallback
          // approxMs (due date no "futuro" relativo a uma task fechada antes
          // do prazo) — sem essa guarda o índice fica negativo e corrompe o
          // array.
          const ageMs = Date.now() - effectiveMs;
          if (ageMs >= 0 && ageMs < TREND_WEEKS * 7 * 86400000) {
            person.weeklyDone[Math.min(TREND_WEEKS - 1, Math.floor(ageMs / (7 * 86400000)))]++;
          }
        }
        continue;
      }

      if (isInProgress) person.inProgress.push(base);

      if (dueStr === todayStr) person.today.push(base);
      else if (dueStr && dueStr < todayStr) person.overdue.push(base);
      else if (dueStr && dueStr > todayStr) person.upcoming.push(base);
      else if (!isInProgress) person.backlog.push(base);
    }
  }

  const byDueAsc = (a, b) => (a.dueMs || Infinity) - (b.dueMs || Infinity);
  const byClosedDesc = (a, b) => b.closedMs - a.closedMs;

  const people = [...peopleMap.values()];
  for (const p of people) {
    p.today.sort(byDueAsc);
    p.overdue.sort(byDueAsc);
    p.upcoming.sort(byDueAsc);
    p.inProgress.sort(byDueAsc);
    p.backlog.sort((a, b) => a.title.localeCompare(b.title));
    p.doneRecent.sort(byClosedDesc);
  }
  people.sort((a, b) => a.name.localeCompare(b.name));
  return people;
}

// --- serialização pro HTML ---

function taskLiteral(t, extraFields) {
  const extra = extraFields ? `, ${extraFields}` : '';
  const client = t.client ? `'${escapeJs(t.client)}'` : 'null';
  return `{ id: '${escapeJs(t.id)}', title: '${escapeJs(t.title)}', url: '${escapeJs(t.url)}', list: '${escapeJs(t.list)}', client: ${client}, status: '${escapeJs(t.status)}', dueMs: ${t.dueMs == null ? 'null' : t.dueMs}${extra} }`;
}

function taskListLiteral(items, extraFieldsFn) {
  if (items.length === 0) return '[]';
  const body = items.map(t => `        ${taskLiteral(t, extraFieldsFn ? extraFieldsFn(t) : null)},`).join('\n');
  return `[\n${body}\n      ]`;
}

function personLiteral(p) {
  return `    {
      id: ${JSON.stringify(p.id)},
      name: '${escapeJs(p.name)}',
      weeklyDone: ${JSON.stringify(p.weeklyDone)},
      today: ${taskListLiteral(p.today)},
      overdue: ${taskListLiteral(p.overdue)},
      upcoming: ${taskListLiteral(p.upcoming)},
      inProgress: ${taskListLiteral(p.inProgress)},
      backlog: ${taskListLiteral(p.backlog)},
      doneRecent: ${taskListLiteral(p.doneRecent, t => `closedMs: ${t.closedMs}, approx: ${t.approx}`)},
    },`;
}

function teamDataToJs(teamData) {
  const peopleJs = teamData.people.map(personLiteral).join('\n');
  return `const teamData = {\n  generatedAt: ${teamData.generatedAt},\n  people: [\n${peopleJs}\n  ],\n};`;
}

function replaceTeamData(html, teamData) {
  const regex = /const\s+teamData\s*=\s*\{[\s\S]*?\};/;
  if (!regex.test(html)) throw new Error('teamData not found in HTML');
  return html.replace(regex, teamDataToJs(teamData));
}

// Lê o generatedAt já publicado no HTML — usado pra montar uma versão
// "mesmo timestamp" e comparar contra o conteúdo atual (ver onRequestPost),
// sem precisar reimplementar o parser do literal inteiro.
function extractGeneratedAt(html) {
  const m = html.match(/const\s+teamData\s*=\s*\{\s*generatedAt:\s*(\d+|null)/);
  return m ? m[1] : 'null';
}
