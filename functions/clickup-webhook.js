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
  { name: 'A Confiteria', taskId: 'wdpu2ydp1t', filePath: 'a-confiteria/index.html' },
  { name: 'Orgânico Natural', taskId: 'wdpu2ydp1u', filePath: 'organico-natural/index.html' },
  {
    name: 'Adah Beauty Tech',
    filePath: 'adah-beauty-tech/index.html',
    services: [
      { key: 'cro', label: 'CRO', taskId: '86aeu71ur' },
      { key: 'crm', label: 'CRM', taskId: 'wdpu2ydp1p' },
    ],
  },
  // Clientes de projeto (type: 'projeto') usam uma task-mãe com subtasks que
  // viram etapas — qualquer nome serve (não precisa ser Protótipo/
  // Desenvolvimento/Integrações/Reuniões, o nome de cada cliente pode ser
  // diferente), cada uma com itens client-facing como subtasks dela.
  // Demandas dentro desses itens (nível 3) ficam ocultas de propósito.
  { name: 'Sellévia', type: 'projeto', taskId: 'wdpu2yadde', filePath: 'sellevia/index.html' },
  { name: 'Booma', type: 'projeto', taskId: 'wdpu2ybtcm', filePath: 'booma/index.html' },
  { name: 'Beleza Brasileira', type: 'projeto', taskId: 'wdpu2y7wq1', filePath: 'beleza-brasileira/index.html' },
  { name: 'Yasmin Beauty', type: 'projeto', taskId: '86ahgcemc', filePath: 'yasmin-beauty/index.html' },
  { name: 'Beeva', type: 'projeto', taskId: 'wdpu2ydyzj', filePath: 'beeva/index.html' },
  { name: 'PROTS', type: 'projeto', taskId: 'wdpu2ybucf', filePath: 'prots/index.html' },
  { name: 'TAG Grading Brazil', type: 'projeto', taskId: 'wdpu2yejnj', filePath: 'tag-grading/index.html' },
];

const REPO_OWNER = 'muriloawr';
const REPO_NAME = 'portal-clientes';
const BRANCH = 'main';

// Lista "Projetos" no ClickUp — mesma lista de onde vem a task-mãe de cada
// cliente tipo "projeto" e onde a sync do Figma já procura a task-mãe pelo
// taskId. Task-mãe nova com status "CLIENTES" nessa lista = cliente novo
// pra provisionar automaticamente (ver discoverAndProvisionNewClients).
const CLIENT_DISCOVERY_LIST_ID = '901324765433';

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

  // Cada invocação do Worker tem um limite de subrequests (50 no plano free do
  // Cloudflare). Sincronizar todos os clientes numa chamada só estourava esse
  // limite conforme mais clientes (principalmente os de projeto, que fazem uma
  // requisição extra por item só pra buscar o comentário) foram sendo
  // cadastrados. Por isso o body pode pedir um cliente específico — o workflow
  // do GitHub Actions faz uma chamada HTTP por cliente, cada uma com orçamento
  // de subrequests zerado de novo. Sem "client" no body, sincroniza todos (só
  // útil pra poucos clientes / teste manual).

  // Roda em toda invocação (o workflow chama uma vez por cliente cadastrado,
  // então isso acontece várias vezes por ciclo — mas só faz trabalho de
  // verdade quando existe task com status "CLIENTES" que ainda não está no
  // CLIENTS abaixo; nunca em reação a um evento em tempo real, só dentro
  // dessa mesma rotina agendada). Isolado em try/catch pra uma falha aqui
  // nunca derrubar a sync normal dos clientes já cadastrados.
  let discoveryResults = [];
  try {
    discoveryResults = await discoverAndProvisionNewClients(env);
  } catch (err) {
    discoveryResults = [`descoberta de clientes novos: FAILED - ${err.message}`];
  }

  let clientFilter = null;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && parsed.client) clientFilter = parsed.client;
  } catch (err) {
    // corpo sem JSON válido: trata como "sincronizar todos"
  }

  const targets = clientFilter ? CLIENTS.filter(c => c.name === clientFilter) : CLIENTS;
  if (clientFilter && targets.length === 0) {
    return new Response(`Unknown client: ${clientFilter}`, { status: 400 });
  }

  const results = [...discoveryResults];
  for (const client of targets) {
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
  if (client.type === 'projeto') {
    const stages = await buildProjectStages(client.taskId, env.CLICKUP_API_TOKEN);
    updated = replaceStagesArray(content, stages);
  } else if (client.services) {
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

// --- ClickUp: clientes de projeto ---

async function fetchComment(taskId, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`ClickUp API error (comment): ${res.status} ${await res.text()}`);
  const data = await res.json();
  const first = data.comments && data.comments[0];
  return first ? (first.comment_text || '').trim() : '';
}

function formatDateRange(startMs, dueMs) {
  if (startMs && dueMs && Number(startMs) !== Number(dueMs)) {
    return `${formatDeadline(Number(startMs))} - ${formatDeadline(Number(dueMs))}`;
  }
  if (dueMs) return formatDeadline(Number(dueMs));
  if (startMs) return formatDeadline(Number(startMs));
  return '';
}

function statusKeyOf(t) {
  const raw = (t.status && t.status.status ? t.status.status : '').toLowerCase();
  return raw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '-');
}

async function buildProjectStages(taskId, token) {
  const stageTasks = await fetchSubtasks(taskId, token);
  const stages = [];

  for (const stageTask of stageTasks) {
    const isMeetings = /reuni|meeting/i.test(stageTask.name);
    // A etapa "Desenvolvimento" recebe tasks da sync Figma->ClickUp, que
    // sempre cria um comentário "Ver no Figma" (link interno pros devs) em
    // cada task — isso não pode vazar como subtítulo no cronograma do
    // cliente, então pula a busca de comentário pra essa etapa inteira.
    const isDevelopment = /desenvolv|development/i.test(stageTask.name);
    // Comentário da etapa em si (não dos itens dela) — tasks diferentes, não
    // tem risco de pegar o "Ver no Figma" que a sync do Figma deixa nos itens.
    const stageSubtitle = await fetchComment(stageTask.id, token);
    const children = await fetchSubtasks(stageTask.id, token);
    const items = [];

    for (const item of children) {
      const subtitle = isDevelopment ? '' : await fetchComment(item.id, token);
      const refDateMs = item.due_date ? Number(item.due_date) : (item.start_date ? Number(item.start_date) : Number(item.date_created));

      if (isMeetings) {
        // Cai pro start_date quando não tem due_date — mesmo fallback que o
        // ramo normal já faz via formatDateRange, senão reunião com só data
        // de início preenchida no ClickUp fica sem data no cronograma.
        const meetingDateMs = item.due_date ? Number(item.due_date) : (item.start_date ? Number(item.start_date) : null);
        items.push({
          title: item.name,
          subtitle,
          date: meetingDateMs ? formatDeadline(meetingDateMs) : '',
          dueMs: meetingDateMs,
          _sort: refDateMs,
        });
      } else {
        items.push({
          title: item.name,
          subtitle,
          statusKey: statusKeyOf(item),
          owner: item.assignees && item.assignees[0] ? item.assignees[0].username.split(' ')[0] : '',
          date: formatDateRange(item.start_date, item.due_date),
          _sort: refDateMs,
        });
      }
    }

    items.sort((a, b) => a._sort - b._sort);
    items.forEach(it => delete it._sort);

    // Tag de reunião é definida pela posição, não por tag manual do ClickUp: a
    // primeira é sempre Kick-off, a última é sempre a entrega final, e as do meio
    // são Revisão.
    if (isMeetings) {
      items.forEach((it, idx) => {
        if (idx === 0) it.tag = 'Kickoff';
        else if (idx === items.length - 1) it.tag = 'Entrega Final do Projeto';
        else it.tag = 'Revisão';
      });
    }

    stages.push({
      key: stageTask.id,
      label: stageTask.name,
      subtitle: stageSubtitle,
      dateRange: formatDateRange(stageTask.start_date, stageTask.due_date),
      statusKey: statusKeyOf(stageTask),
      startMs: stageTask.start_date ? Number(stageTask.start_date) : null,
      dueMs: stageTask.due_date ? Number(stageTask.due_date) : null,
      isMeetings,
      items,
    });
  }

  return stages;
}

function stagesArrayLiteral(stages) {
  const body = stages.map(s => {
    const itemsJs = s.items.map(it => {
      if (s.isMeetings) {
        return `        { title: '${escapeJs(it.title)}', subtitle: '${escapeJs(it.subtitle)}', tag: '${escapeJs(it.tag)}', date: '${escapeJs(it.date)}', dueMs: ${it.dueMs == null ? 'null' : it.dueMs} },`;
      }
      return `        { title: '${escapeJs(it.title)}', subtitle: '${escapeJs(it.subtitle)}', statusKey: '${it.statusKey}', owner: '${escapeJs(it.owner)}', date: '${escapeJs(it.date)}' },`;
    }).join('\n');
    return `    {\n      key: '${escapeJs(s.key)}',\n      label: '${escapeJs(s.label)}',\n      subtitle: '${escapeJs(s.subtitle)}',\n      dateRange: '${escapeJs(s.dateRange)}',\n      statusKey: '${s.statusKey}',\n      startMs: ${s.startMs == null ? 'null' : s.startMs},\n      dueMs: ${s.dueMs == null ? 'null' : s.dueMs},\n      isMeetings: ${s.isMeetings},\n      items: [\n${itemsJs}\n      ],\n    },`;
  }).join('\n');
  return `[\n${body}\n  ]`;
}

function stagesToJs(stages) {
  return `const stages = ${stagesArrayLiteral(stages)};`;
}

function replaceStagesArray(html, stages) {
  const regex = /const\s+stages\s*=\s*\[[\s\S]*?\];/;
  if (!regex.test(html)) throw new Error('stages array not found in HTML');
  return html.replace(regex, stagesToJs(stages));
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

// --- descoberta e provisionamento de clientes novos ---

// Task diretamente na lista "Projetos" (não subtask de nada) com status
// "CLIENTES" = task-mãe de um cliente novo. Se o taskId dela ainda não
// está em CLIENTS, provisiona sozinho: cria a página (template padrão tipo
// "projeto", em branco até a task-mãe ganhar subtasks/etapas), cadastra em
// CLIENTS (esse mesmo arquivo) e adiciona o nome no workflow agendado.
async function fetchListTasks(listId, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`ClickUp API error (list tasks): ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.tasks || [];
}

async function discoverAndProvisionNewClients(env) {
  const tasks = await fetchListTasks(CLIENT_DISCOVERY_LIST_ID, env.CLICKUP_API_TOKEN);
  const candidates = tasks.filter(t => statusKeyOf(t) === 'clientes');
  if (candidates.length === 0) return [];

  // Confere contra o conteúdo ATUAL desse arquivo no GitHub (não contra o
  // CLIENTS em memória, que é o código já publicado antes dessa execução) —
  // assim, se essa mesma invocação já provisionou um cliente há poucas
  // linhas atrás, não tenta de novo pro mesmo taskId.
  let { content: ownSource, sha: ownSha } = await getGithubFile('functions/clickup-webhook.js', env.GITHUB_TOKEN);
  const newOnes = candidates.filter(t => !ownSource.includes(`taskId: '${t.id}'`));
  if (newOnes.length === 0) return [];

  const results = [];
  for (const task of newOnes) {
    try {
      const msg = await provisionNewClient(task, ownSource, ownSha, env);
      results.push(`novo cliente "${task.name}": ${msg}`);
      const refreshed = await getGithubFile('functions/clickup-webhook.js', env.GITHUB_TOKEN);
      ownSource = refreshed.content;
      ownSha = refreshed.sha;
    } catch (err) {
      results.push(`novo cliente "${task.name}": FAILED - ${err.message}`);
    }
  }
  return results;
}

async function provisionNewClient(task, ownSource, ownSha, env) {
  const slug = uniqueSlug(slugify(task.name), ownSource);
  const filePath = `${slug}/index.html`;
  const html = buildNewClientHtml(task.name, task.id);

  // 1) cria a página do cliente (sha omitido = GitHub cria o arquivo)
  await commitGithubFile(filePath, html, undefined, task.name, env.GITHUB_TOKEN);

  // 2) cadastra em CLIENTS, nesse mesmo arquivo
  const updatedSource = insertClientEntry(ownSource, task.name, task.id, filePath);
  await commitGithubFile('functions/clickup-webhook.js', updatedSource, ownSha, task.name, env.GITHUB_TOKEN);

  // 3) adiciona o nome no array bash do workflow agendado — se isso falhar,
  // a página e o CLIENTS já foram, só falta alguém adicionar o nome manual
  // no workflow pra entrar no ciclo de sync.
  try {
    const { content: wfContent, sha: wfSha } = await getGithubFile('.github/workflows/clickup-sync-schedule.yml', env.GITHUB_TOKEN);
    const updatedWf = insertWorkflowClientName(wfContent, task.name);
    if (updatedWf !== wfContent) {
      await commitGithubFile('.github/workflows/clickup-sync-schedule.yml', updatedWf, wfSha, task.name, env.GITHUB_TOKEN);
    }
  } catch (err) {
    throw new Error(`página e CLIENTS ok, mas falhou ao atualizar o workflow: ${err.message}`);
  }

  return `provisionado (${filePath})`;
}

function slugify(str) {
  return String(str)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueSlug(base, ownSource) {
  const safeBase = base || 'cliente';
  let slug = safeBase;
  let n = 2;
  while (ownSource.includes(`filePath: '${slug}/index.html'`)) {
    slug = `${safeBase}-${n}`;
    n++;
  }
  return slug;
}

function insertClientEntry(source, clientName, taskId, filePath) {
  const regex = /(const\s+CLIENTS\s*=\s*\[[\s\S]*?)\n(\];)/;
  if (!regex.test(source)) throw new Error('CLIENTS array não encontrado em functions/clickup-webhook.js');
  const entry = `  { name: '${escapeJs(clientName)}', type: 'projeto', taskId: '${taskId}', filePath: '${filePath}' },`;
  return source.replace(regex, `$1\n${entry}\n$2`);
}

function insertWorkflowClientName(yaml, clientName) {
  const regex = /(CLIENTS=\(\n(?:[ \t]*"[^"\n]*"\n)+)([ \t]*\))/;
  const match = yaml.match(regex);
  if (!match) throw new Error('bloco CLIENTS=( ... ) não encontrado no workflow');
  const indentMatch = match[1].match(/\n([ \t]*)"/);
  const indent = indentMatch ? indentMatch[1] : '            ';
  const escaped = String(clientName).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
  return yaml.replace(regex, `$1${indent}"${escaped}"\n$2`);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Template padrão "projeto" pra cliente provisionado sozinho — mesmo
// padrão visual e mesma lógica (Go Live, prazo final robusto, subtítulo de
// etapa via comentário) usada nos clientes cadastrados manualmente, só que
// com logo de agência genérico (Vanzak Labs) em vez de logo do cliente, já
// que a automação não tem como saber a marca dele. Sem template literals
// aninhados dentro do script gerado (usa concatenação de string) — evita
// qualquer conflito de crase com o template literal desta função.
function buildNewClientHtml(clientName, taskId) {
  const safeName = escapeHtml(clientName);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cronograma - ${safeName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=clash-grotesk@600&display=swap">
<style>
  :root{
    --bg:#F2F6FC;
    --panel:#FFFFFF;
    --ink:#0B1C33;
    --ink-soft:#5A6B85;
    --line:#DCE5F0;
    --brand:#015EC5;
    --tint-1:#EAF1FC;
    --tint-2:#C7DCF5;
    --grey-bg:#EDEFF2;
  }
  *{box-sizing:border-box;}
  html{overflow-x:hidden;}
  body{
    margin:0;color:var(--ink);font-family:'Inter',sans-serif;font-weight:500;padding:0 0 90px;
    background:var(--bg);
    position:relative;overflow-x:hidden;
  }
  body::after{
    content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
    background:
      radial-gradient(circle at 88% -8%, rgba(1,94,197,0.16), transparent 42%),
      radial-gradient(circle at -6% 18%, rgba(1,94,197,0.08), transparent 38%);
  }
  body::before{
    content:"";position:fixed;inset:0;
    background-image:radial-gradient(rgba(11,28,51,0.07) 1px, transparent 1px);
    background-size:22px 22px;pointer-events:none;z-index:0;
    mask-image:linear-gradient(to bottom, rgba(0,0,0,0.9), rgba(0,0,0,0.15) 60%, transparent 100%);
  }
  .wrap{max-width:1080px;margin:0 auto;padding:40px 24px 0;position:relative;z-index:1;}
  .topbar{height:5px;width:100%;background:linear-gradient(90deg, var(--tint-1), var(--brand) 50%, var(--ink));background-size:200% 100%;animation:flow 7s ease-in-out infinite alternate;position:relative;z-index:1;}
  @keyframes flow{0%{background-position:0% 0;}100%{background-position:100% 0;}}

  .head{margin-bottom:28px;padding-bottom:22px;border-bottom:1px solid rgba(11,28,51,0.14);}
  .agency-logo{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:15px;letter-spacing:0.06em;color:var(--brand);text-transform:uppercase;}
  .eyebrow{font-family:'Inter',sans-serif;font-size:12px;color:var(--ink-soft);margin:14px 0 10px;display:flex;align-items:center;gap:7px;}
  .live-dot{width:7px;height:7px;border-radius:50%;background:#2FBE6C;flex-shrink:0;box-shadow:0 0 0 0 rgba(47,190,108,0.6);animation:pulse 1.8s infinite;}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(47,190,108,0.55);}70%{box-shadow:0 0 0 7px rgba(47,190,108,0);}100%{box-shadow:0 0 0 0 rgba(47,190,108,0);}}
  h1{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:32px;margin:0;line-height:1.1;color:var(--ink);}

  .bar-wrap{margin-bottom:34px;}
  .bar-edges{display:flex;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:6px;}
  .bar-caption{display:flex;justify-content:space-between;margin-top:14px;flex-wrap:wrap;gap:14px;}
  .status-side{display:flex;flex-direction:column;gap:2px;flex-shrink:0;}
  .status-side.right{align-items:flex-end;text-align:right;}
  .cap-label{font-family:'Inter',sans-serif;font-size:11.5px;color:var(--ink-soft);}
  .cap-value{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:17px;color:var(--brand);line-height:1.2;}
  .cap-value.muted{color:var(--ink);font-size:15px;}
  .status-next{font-size:11.5px;color:var(--ink-soft);}
  .overview-track-wrap{position:relative;height:8px;}
  .overview-track{height:8px;border-radius:4px;background:var(--line);overflow:hidden;position:relative;}
  .overview-fill{position:absolute;top:0;left:0;height:100%;width:0%;background:var(--brand);border-radius:4px;transition:width .7s ease;}
  .tick{position:absolute;top:50%;width:9px;height:9px;border-radius:50%;background:var(--panel);border:2px solid var(--brand);transform:translate(-50%,-50%);z-index:2;}
  .tick .tick-tip{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;font-family:'Inter',sans-serif;font-size:10.5px;padding:4px 9px;border-radius:7px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s ease;}
  .tick:hover .tick-tip{opacity:1;}
  .tick:hover{background:var(--brand);}
  .now-marker{position:absolute;top:50%;width:12px;height:12px;border-radius:50%;background:var(--ink);border:2px solid var(--panel);transform:translate(-50%,-50%);box-shadow:0 1px 4px rgba(11,28,51,0.35);z-index:3;}

  .stage-block{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 26px;margin-top:22px;box-shadow:0 1px 2px rgba(11,28,51,0.04);}
  .stage-block-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:10px 16px;margin-bottom:6px;}
  .stage-block h2{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:17px;margin:0;}
  .stage-tag{font-family:'Inter',sans-serif;font-size:11px;padding:4px 11px;border-radius:20px;background:var(--bg);color:var(--ink-soft);white-space:nowrap;flex-shrink:0;}
  .stage-block .sub{font-size:12.5px;color:var(--ink-soft);margin-bottom:14px;}

  .phase-row{display:grid;grid-template-columns:1fr 100px 190px 90px;gap:26px;align-items:center;padding:13px 0;border-top:1px solid var(--line);}
  .phase-row:first-of-type{border-top:none;}
  .phase-head{font-family:'Inter',sans-serif;font-size:10.5px;color:var(--ink-soft);padding:12px 0 6px;border-top:none;}
  .phase-name{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:14.5px;}
  .phase-sub{font-size:12px;color:var(--ink-soft);margin-top:2px;}
  .phase-owner{font-size:13px;color:var(--ink-soft);display:flex;align-items:center;gap:7px;}
  .owner-avatar{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--brand);color:#fff;font-size:10.5px;font-weight:500;flex-shrink:0;}
  .phase-status{font-size:11px;padding:4px 10px;border-radius:20px;text-align:center;white-space:nowrap;background:var(--grey-bg);color:var(--ink-soft);}
  .phase-status.active{background:var(--tint-2);color:var(--brand);}
  .phase-status.solid{background:var(--brand);color:#fff;}
  .phase-dates{font-family:'Inter',sans-serif;font-size:12px;color:var(--ink-soft);text-align:right;}

  .meetings{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px 26px;margin-top:32px;box-shadow:0 1px 2px rgba(11,28,51,0.04);}
  .meetings h2{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:18px;margin:0 0 4px;}
  .meetings .sub{font-size:13px;color:var(--ink-soft);margin-bottom:14px;}
  .meeting-row{display:grid;grid-template-columns:130px 1fr auto;gap:16px;align-items:center;padding:12px 0;border-top:1px solid var(--line);}
  .meeting-row:first-of-type{border-top:none;}
  .m-date{font-family:'Inter',sans-serif;font-size:13px;font-weight:500;color:var(--brand);}
  .m-title{font-size:14px;}
  .m-tag{font-family:'Inter',sans-serif;font-size:11px;padding:4px 11px;border-radius:20px;background:var(--tint-1);color:var(--brand);white-space:nowrap;}
  .m-tag.final{background:var(--ink);color:#fff;}

  .empty-state{padding:24px 0;text-align:center;color:var(--ink-soft);font-size:13.5px;}

  .footnote{margin-top:26px;font-size:12px;color:var(--ink-soft);text-align:center;}

  @media (max-width:640px){
    .phase-head{display:none;}
    .phase-row{
      grid-template-columns:1fr 1fr;
      grid-template-areas:"main main" "owner dates" "status status";
      gap:8px;
    }
    .phase-main{grid-area:main;}
    .phase-owner{grid-area:owner;}
    .phase-status{grid-area:status;justify-self:start;width:fit-content;}
    .phase-dates{grid-area:dates;text-align:left;}
    .phase-dates::before{content:"Prazo";display:block;font-size:9.5px;color:var(--ink-soft);margin-bottom:3px;}
    .meeting-row{grid-template-columns:1fr;gap:4px;}
    .meeting-row .m-date,.meeting-row .m-tag{justify-self:start;}
    .bar-caption{flex-direction:column;gap:8px;}
    .status-side.right{align-items:flex-start;text-align:left;margin-top:8px;}
  }
</style>
</head>
<body>
<div class="topbar"></div>
<div class="wrap">

  <div class="head">
    <div class="agency-logo">Vanzak Labs</div>
    <div class="eyebrow"><span class="live-dot"></span>Cronograma do Projeto</div>
    <h1>${safeName}</h1>
  </div>

  <div class="bar-wrap" id="barWrap">
    <div class="bar-edges">
      <div><span class="cap-label">Kick-off</span><br><span class="cap-value muted" id="edgeStart">-</span></div>
      <div style="text-align:right;"><span class="cap-label">Go Live</span><br><span class="cap-value muted" id="edgeEnd">-</span></div>
    </div>
    <div class="overview-track-wrap">
      <div class="overview-track"><div class="overview-fill" id="overviewFill"></div></div>
      <div id="overviewTicks"></div>
    </div>
    <div class="bar-caption">
      <div class="status-side">
        <span class="cap-label">Etapa atual</span>
        <span class="cap-value" id="capCurrent">-</span>
        <span class="status-next" id="capNext">-</span>
      </div>
      <div class="status-side right">
        <span class="cap-label" id="kpiDaysLabel">Faltam para o Go Live</span>
        <span class="cap-value muted" id="kpiDaysLeft">-</span>
      </div>
    </div>
  </div>

  <div id="stageSections"></div>

  <div class="meetings" id="meetingsSection">
    <h2 id="meetingsTitle">Reuniões previstas</h2>
    <div class="sub" id="meetingsSub"></div>
    <div id="meetingList"></div>
  </div>

  <div class="footnote">Atualizado sempre que uma etapa muda de status</div>

</div>

<script>
  // --- dados: um objeto por etapa do projeto. Sincronizado automaticamente a partir do ClickUp. ---
  // Página criada automaticamente pela rotina de descoberta de clientes
  // novos (status "CLIENTES" na lista Projetos), a partir da task ${taskId}.
  // Fica vazio até a task-mãe ganhar subtasks (etapas) — qualquer nome de
  // subtask vira etapa, sem lista fixa.
  const stages = [];

  const STATUS_LABELS = {
    'pendentes': 'Pendente',
    'planejamento': 'Planejamento',
    'importante': 'Importante',
    'em-andamento': 'Em andamento',
    'concluido': 'Concluído',
    'fechado': 'Fechado',
  };

  function statusLabel(key) {
    return STATUS_LABELS[key] || key || '-';
  }

  function fmtFull(date) {
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtShort(date) {
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
  }

  const flow = stages.filter(function (s) { return !s.isMeetings; });
  const meetingsStage = stages.find(function (s) { return s.isMeetings; });
  const meetings = meetingsStage ? meetingsStage.items : [];

  const kickoffMs = (meetings.length && meetings[0].dueMs) ? meetings[0].dueMs
    : (flow.length && flow[0].startMs) ? flow[0].startMs
    : null;
  const flowDueValues = flow.map(function (s) { return s.dueMs; }).filter(Boolean);
  const flowFinalMs = flowDueValues.length ? Math.max.apply(null, flowDueValues) : null;
  const meetingsFinalMs = meetings.length ? meetings[meetings.length - 1].dueMs : null;
  const finalMs = Math.max(flowFinalMs || 0, meetingsFinalMs || 0) || null;

  function renderTimeline() {
    const wrap = document.getElementById('barWrap');
    if (!kickoffMs || !finalMs || finalMs <= kickoffMs) { wrap.style.display = 'none'; return; }

    const now = Date.now();
    const pct = function (ms) { return Math.min(100, Math.max(0, ((ms - kickoffMs) / (finalMs - kickoffMs)) * 100)); };

    document.getElementById('edgeStart').textContent = fmtFull(new Date(kickoffMs));
    document.getElementById('edgeEnd').textContent = fmtFull(new Date(finalMs));
    const midnight = function (ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const diffDays = Math.round((midnight(finalMs) - midnight(now)) / 86400000);
    const daysEl = document.getElementById('kpiDaysLeft');
    const daysLabelEl = document.getElementById('kpiDaysLabel');
    if (diffDays > 1) {
      daysLabelEl.textContent = 'Faltam para o Go Live';
      daysEl.textContent = diffDays + ' dias';
    } else if (diffDays === 1) {
      daysLabelEl.textContent = 'Faltam para o Go Live';
      daysEl.textContent = '1 dia';
    } else if (diffDays === 0) {
      daysLabelEl.textContent = 'Go Live';
      daysEl.textContent = 'Hoje';
    } else {
      daysLabelEl.textContent = 'Go Live';
      daysEl.textContent = 'Prazo encerrado';
    }
    document.getElementById('overviewFill').style.width = pct(now).toFixed(1) + '%';

    document.getElementById('overviewTicks').innerHTML = meetings.filter(function (m) { return m.dueMs; }).map(function (m) {
      return '<div class="tick" style="left:' + pct(m.dueMs).toFixed(1) + '%;">' +
        '<div class="tick-tip"><b>' + m.title + '</b> &middot; ' + fmtShort(new Date(m.dueMs)) + '</div></div>';
    }).join('');

    if (now >= kickoffMs && now <= finalMs) {
      const marker = document.createElement('div');
      marker.className = 'now-marker';
      marker.style.left = pct(now).toFixed(1) + '%';
      document.querySelector('.overview-track-wrap').appendChild(marker);
    }

    let currentIdx = flow.findIndex(function (s) { return s.statusKey !== 'concluido' && s.statusKey !== 'fechado'; });
    const capCurrent = document.getElementById('capCurrent');
    const capNext = document.getElementById('capNext');
    if (currentIdx === -1) {
      const finalMeeting = meetings.length ? meetings[meetings.length - 1] : null;
      if (finalMeeting && finalMeeting.dueMs && now < finalMeeting.dueMs) {
        capCurrent.textContent = finalMeeting.title + ' · ' + fmtShort(new Date(finalMeeting.dueMs));
      } else {
        capCurrent.textContent = 'Projeto entregue';
      }
      capNext.textContent = '';
    } else {
      const s = flow[currentIdx];
      capCurrent.textContent = s.label + (s.dueMs ? ' · até ' + fmtShort(new Date(s.dueMs)) : '');
      const nextS = flow[currentIdx + 1];
      capNext.textContent = nextS
        ? nextS.label + (nextS.startMs ? ' · inicia em ' + fmtShort(new Date(nextS.startMs)) : '')
        : 'Go Live · ' + fmtShort(new Date(finalMs));
    }
  }

  function renderStages() {
    document.getElementById('stageSections').innerHTML = flow.map(function (s) {
      var rows;
      if (s.items.length === 0) {
        rows = '<div class="empty-state">Nenhum item registrado ainda.</div>';
      } else {
        var head = '<div class="phase-row phase-head"><div></div><div>Responsável</div>' +
          '<div style="text-align:center;">Status</div><div style="text-align:right;">Prazo</div></div>';
        var body = s.items.map(function (it) {
          var statusClass = (it.statusKey === 'concluido' || it.statusKey === 'fechado') ? ' solid'
            : (it.statusKey === 'em-andamento') ? ' active'
            : '';
          var ownerHtml = it.owner ? ('<span class="owner-avatar">' + it.owner.charAt(0) + '</span>' + it.owner) : '-';
          return '<div class="phase-row">' +
            '<div class="phase-main"><div class="phase-name">' + it.title + '</div><div class="phase-sub">' + (it.subtitle || '') + '</div></div>' +
            '<div class="phase-owner">' + ownerHtml + '</div>' +
            '<div class="phase-status' + statusClass + '">' + statusLabel(it.statusKey) + '</div>' +
            '<div class="phase-dates">' + (it.date || '-') + '</div>' +
          '</div>';
        }).join('');
        rows = head + body;
      }
      var tagHtml = s.dateRange ? ('<span class="stage-tag">' + s.dateRange + '</span>') : '';
      var subHtml = s.subtitle ? ('<div class="sub">' + s.subtitle + '</div>') : '';
      return '<div class="stage-block">' +
        '<div class="stage-block-head"><h2>' + s.label + '</h2>' + tagHtml + '</div>' +
        subHtml + rows +
      '</div>';
    }).join('');
  }

  function renderMeetings() {
    const section = document.getElementById('meetingsSection');
    if (!meetingsStage) { section.style.display = 'none'; return; }
    document.getElementById('meetingsTitle').textContent = meetingsStage.label || 'Reuniões previstas';
    document.getElementById('meetingsSub').textContent = meetingsStage.subtitle || '';
    const listEl = document.getElementById('meetingList');
    if (meetings.length === 0) {
      listEl.innerHTML = '<div class="empty-state">Nenhuma reunião registrada ainda.</div>';
    } else {
      listEl.innerHTML = meetings.map(function (m, i) {
        var tagHtml = m.tag
          ? ('<div class="m-tag' + (i === meetings.length - 1 ? ' final' : '') + '">' + m.tag + '</div>')
          : '<div></div>';
        return '<div class="meeting-row">' +
          '<div class="m-date">' + (m.date || '-') + '</div>' +
          '<div class="m-title">' + m.title + '<div class="phase-sub">' + (m.subtitle || '') + '</div></div>' +
          tagHtml +
        '</div>';
      }).join('');
    }
  }

  renderTimeline();
  renderStages();
  renderMeetings();
</script>
</body>
</html>
`;
}
