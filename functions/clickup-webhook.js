// Cloudflare Pages Function — POST /clickup-webhook
// Disparada pelo workflow agendado do GitHub Actions (não mais por um webhook do
// ClickUp). Para cada cliente cadastrado em CLIENTS, busca o estado completo das
// subtasks da task-mãe dele (por taskId, direto — não importa em qual lista/espaço
// do ClickUp essa task está) e re-commita o array `months` no HTML correspondente
// no GitHub. O deploy do Cloudflare Pages já dispara sozinho a partir do commit.
// Adicionar um cliente novo é só adicionar uma entrada em CLIENTS.

import {
  computeSignature, timingSafeEqual, clickUpFetch,
  getGithubFile, commitGithubFile, escapeJs, escapeHtml,
} from './_lib/clickup-shared.js';

// Cada cliente pode combinar dois tipos de engajamento na MESMA página:
// - `projectTaskId`: task-mãe na lista "Projetos", com subtasks que viram
//   etapas (cronograma com barra Kick-off/Go Live) — qualquer nome de
//   subtask serve, sem lista fixa.
// - `services`: um ou mais serviços recorrentes (CRO/CRM/Planejamento/
//   Social Media), cada um com seu taskId — vira aba por serviço, relatório
//   mensal (`buildMonths`).
// Cliente com só `taskId` solto (sem os dois campos acima) é o caso mais
// simples: um serviço recorrente único, sem abas. Cliente com os dois
// (`projectTaskId` + `services`) ganha a sidebar Projeto/Serviços — ver
// upgradeToComboHtml.
const CLIENTS = [
  { name: 'Humara', taskId: 'wdpu2ybtwm', filePath: 'humara/index.html' },
  { name: 'Uplift Fitness', taskId: '86aewgr7t', filePath: 'uplift-fitness/index.html' },
  { name: 'InfinitAge', taskId: '86aeu720q', filePath: 'infinitage/index.html' },
    { name: 'A Confiteria', services: [{ key: 'crm', label: 'CRM', taskId: 'wdpu2ydp1t' }, { key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezry' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75f' }], filePath: 'a-confiteria/index.html' },
    { name: 'Orgânico Natural', services: [{ key: 'crm', label: 'CRM', taskId: 'wdpu2ydp1u' }, { key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezrr' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75c' }], filePath: 'organico-natural/index.html' },
  {
    name: 'Adah Beauty Tech',
    filePath: 'adah-beauty-tech/index.html',
    services: [
      { key: 'cro', label: 'CRO', taskId: '86aeu71ur' },
      { key: 'crm', label: 'CRM', taskId: 'wdpu2ydp1p' },
    ],
  },
    { name: 'Sellévia', projectTaskId: 'wdpu2yadde', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yeztr' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75r' }], filePath: 'sellevia/index.html' },
    { name: 'Booma Organic', projectTaskId: 'wdpu2ybtcm', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezrt' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75d' }], filePath: 'booma/index.html' },
  { name: 'Beleza Brasileira', projectTaskId: 'wdpu2y7wq1', filePath: 'beleza-brasileira/index.html' },
  { name: 'Yasmin Beauty', projectTaskId: '86ahgcemc', filePath: 'yasmin-beauty/index.html' },
    { name: 'Beeva', projectTaskId: 'wdpu2ydyzj', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yeztp' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75p' }], filePath: 'beeva/index.html' },
  { name: 'PROTS', projectTaskId: 'wdpu2ybucf', filePath: 'prots/index.html' },
  { name: 'TAG Grading Brazil', projectTaskId: 'wdpu2yejnj', filePath: 'tag-grading/index.html' },
    { name: 'Cookie Dreams', projectTaskId: '86ahp88m4', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezrz' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75g' }], filePath: 'cookie-dreams/index.html' },
  { name: 'MUUPI', projectTaskId: '86agvb320', filePath: 'muupi/index.html' },
  { name: 'Mye Mye', projectTaskId: 'wdpu2ye60e', filePath: 'mye-mye/index.html' },
  { name: 'Piny', projectTaskId: 'wdpu2ye60b', filePath: 'piny/index.html' },
  { name: 'AIB Beauty', projectTaskId: 'wdpu2ye60a', filePath: 'aib-beauty/index.html' },
    { name: 'Bako Cosmetics', projectTaskId: 'wdpu2ye3hg', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yeztn' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75n' }], filePath: 'bako/index.html' },
  { name: 'Kunha P', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yeztq' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75q' }], filePath: 'kunha-p/index.html' },
  { name: 'SenseBe', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yeztk' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75m' }], filePath: 'sensebe/index.html' },
  { name: 'Bash Beauty', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezt3' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75k' }], filePath: 'bash-beauty/index.html' },
  { name: 'Nutrado', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezt2' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75j' }], filePath: 'nutrado/index.html' },
  { name: 'Pure Shower', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezt1' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75h' }], filePath: 'pure-shower/index.html' },
  { name: 'Luminati', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezrx' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75e' }], filePath: 'luminati/index.html' },
  { name: 'iHerb', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezrv' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf759' }], filePath: 'iherb/index.html' },
  { name: 'Lalume', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezrp' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75a' }], filePath: 'lalume/index.html' },
  { name: 'White Align', services: [{ key: 'planejamento', label: 'Planejamento', taskId: 'wdpu2yezrn' }, { key: 'social-media', label: 'Social Media', taskId: 'wdpu2yf75b' }], filePath: 'white-align/index.html' },
];

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
  // nunca derrubar a sync normal dos clientes já cadastrados. Descoberta de
  // serviços recorrentes só roda se a de projeto não achou nada pra fazer —
  // rodar as duas sempre somaria custo de subrequests à toa na maioria das
  // invocações, que não têm nada novo em nenhuma das duas.
  let discoveryResults = [];
  try {
    discoveryResults = await discoverAndProvisionNewClients(env);
    if (discoveryResults.length === 0) {
      discoveryResults = await discoverAndSyncRecurringServices(env);
    }
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

  // Projeto e serviços são independentes — um cliente pode ter os dois na
  // mesma página (sidebar) e cada bloco só mexe no seu próprio
  // `const stages/services = [...]`, sem interferir um no outro.
  let updated = content;

  if (client.projectTaskId) {
    const stages = await buildProjectStages(client.projectTaskId, env.CLICKUP_API_TOKEN);
    updated = replaceStagesArray(updated, stages);
  }

  if (client.services) {
    const services = [];
    for (const service of client.services) {
      const months = await buildMonths(service.taskId, env.CLICKUP_API_TOKEN);
      services.push({ key: service.key, label: service.label, months });
    }
    updated = replaceServicesArray(updated, services);
  } else if (!client.projectTaskId) {
    // Nem projeto nem serviços múltiplos: cliente simples de serviço único.
    const months = await buildMonths(client.taskId, env.CLICKUP_API_TOKEN);
    updated = replaceMonthsArray(updated, months);
  }

  // Checa mudança real ANTES de tocar em generatedAt (que fica numa região
  // separada do HTML) — assim "Atualizado em" só avança quando o cronograma
  // de verdade mudou, sem commitar (e disparar deploy) a cada ciclo do cron
  // à toa.
  if (updated === content) return 'no changes';

  updated = replaceGeneratedAt(updated, Date.now());
  await commitGithubFile(client.filePath, updated, sha, `sync: atualiza relatório ${client.name} a partir do ClickUp`, env.GITHUB_TOKEN);
  return 'synced';
}

async function fetchSubtasks(taskId, token) {
  const res = await clickUpFetch(`https://api.clickup.com/api/v2/task/${taskId}?include_subtasks=true`, {
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
  const res = await clickUpFetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
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
      // Item sem due_date/start_date sempre por último — cair pra
      // date_created (quando a task foi criada no ClickUp) ordenava pela
      // ordem de criação em vez de "sem prazo definido", o que colocava
      // reuniões/itens sem data em posições aleatórias no meio da lista.
      const refDateMs = item.due_date ? Number(item.due_date) : (item.start_date ? Number(item.start_date) : Number.MAX_SAFE_INTEGER);

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

    // Tag de reunião é definida pela posição, não por tag manual do ClickUp:
    // a primeira é sempre Kick-off, a última é sempre a entrega final, e as
    // do meio são Revisão. Exceção por nome: "Go-Live" sempre vira
    // Implementação, não importa a posição — sem isso, um Go-Live sem prazo
    // (que agora vai pro fim da lista por não ter data) herdaria a tag de
    // entrega final só por acaso estar por último.
    if (isMeetings) {
      items.forEach((it, idx) => {
        if (idx === 0) it.tag = 'Kick-off';
        else if (idx === items.length - 1) it.tag = 'Entrega Final';
        else it.tag = 'Revisão';
        if (/go[\s-]?live/i.test(it.title)) it.tag = 'Implementação';
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
  const regex = /(?:const|var)\s+stages\s*=\s*\[[\s\S]*?\];/;
  if (!regex.test(html)) throw new Error('stages array not found in HTML');
  return html.replace(regex, stagesToJs(stages));
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

function servicesArrayLiteral(services) {
  const body = services.map(s =>
    `    { key: '${s.key}', label: '${escapeJs(s.label)}', months: ${monthsArrayLiteral(s.months)} },`,
  ).join('\n');
  return `[\n${body}\n  ]`;
}

function servicesToJs(services) {
  return `const services = ${servicesArrayLiteral(services)};`;
}

function replaceMonthsArray(html, months) {
  const regex = /(?:const|var)\s+months\s*=\s*\[[\s\S]*?\];/;
  if (!regex.test(html)) throw new Error('months array not found in HTML');
  return html.replace(regex, monthsToJs(months));
}

function replaceServicesArray(html, services) {
  const regex = /(?:const|var)\s+services\s*=\s*\[[\s\S]*?\];/;
  if (!regex.test(html)) throw new Error('services array not found in HTML');
  return html.replace(regex, servicesToJs(services));
}

function replaceGeneratedAt(html, ms) {
  const regex = /(?:const|var)\s+generatedAt\s*=\s*[^;]+;/;
  if (!regex.test(html)) throw new Error('generatedAt not found in HTML');
  return html.replace(regex, `const generatedAt = ${ms};`);
}

// --- descoberta e provisionamento de clientes novos ---

// Task diretamente na lista "Projetos" (não subtask de nada) com status
// "CLIENTES" = task-mãe de um cliente novo. Se o taskId dela ainda não
// está em CLIENTS, provisiona sozinho: cria a página (template padrão tipo
// "projeto", em branco até a task-mãe ganhar subtasks/etapas), cadastra em
// CLIENTS (esse mesmo arquivo) e adiciona o nome no workflow agendado.
async function fetchListTasks(listId, token) {
  const res = await clickUpFetch(`https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true`, {
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
  // CLIENTS em memória, que é o código já publicado antes dessa execução).
  const { content: ownSource, sha: ownSha } = await getGithubFile('functions/clickup-webhook.js', env.GITHUB_TOKEN);
  const newOnes = candidates.filter(t => !ownSource.includes(`projectTaskId: '${t.id}'`));
  if (newOnes.length === 0) return [];

  // Só UM candidato por invocação — provisionar (buscar etapas existentes,
  // criar a página, commitar CLIENTS e o workflow) já consome boa parte do
  // limite de 50 subrequests por invocação do Worker, e essa mesma
  // invocação ainda precisa sobrar orçamento pra sincronizar o cliente que
  // o workflow pediu de verdade (visto na prática: 4 clientes novos ao
  // mesmo tempo estourava o limite na segunda tentativa da mesma
  // invocação). Com vários clientes novos aparecendo juntos, o resto do
  // lote é pego pelas próximas invocações do mesmo ciclo, uma por vez.
  const task = newOnes[0];
  try {
    const msg = await provisionNewClient(task, ownSource, ownSha, env);
    return [`novo cliente "${task.name}": ${msg}`];
  } catch (err) {
    return [`novo cliente "${task.name}": FAILED - ${err.message}`];
  }
}

async function provisionNewClient(task, ownSource, ownSha, env) {
  const slug = uniqueSlug(slugify(task.name), ownSource);
  const filePath = `${slug}/index.html`;
  // Busca o estado atual da task-mãe — se ela já tiver subtasks (etapas)
  // na hora do provisionamento, a página já nasce preenchida em vez de
  // esperar o próximo ciclo de sync normal pra ela aparecer.
  const stages = await buildProjectStages(task.id, env.CLICKUP_API_TOKEN);
  const html = buildClientHtml(task.name, task.id, stages, null);

  // 1) cria (ou atualiza, se uma tentativa anterior já criou mas falhou
  // depois) a página do cliente — sha omitido só quando o arquivo ainda
  // não existe, senão o GitHub rejeita a criação com 422.
  let pageSha;
  try {
    pageSha = (await getGithubFile(filePath, env.GITHUB_TOKEN)).sha;
  } catch (err) {
    pageSha = undefined;
  }
  await commitGithubFile(filePath, html, pageSha, `sync: provisiona cliente ${task.name}`, env.GITHUB_TOKEN);

  // 2) cadastra em CLIENTS, nesse mesmo arquivo — só insere se ainda não
  // está lá (retry depois de falha parcial não deve duplicar a entrada).
  if (!ownSource.includes(`projectTaskId: '${task.id}'`)) {
    const updatedSource = insertClientEntry(ownSource, task.name, task.id, filePath);
    await commitGithubFile('functions/clickup-webhook.js', updatedSource, ownSha, `sync: cadastra cliente ${task.name} em CLIENTS`, env.GITHUB_TOKEN);
  }

  // 3) adiciona o nome no array bash do workflow agendado — página e
  // CLIENTS já valem mesmo se isso falhar (ex: token sem escopo "workflow"),
  // então só anota no retorno em vez de derrubar o provisionamento inteiro
  // (derrubar aqui deixava o próximo candidato do lote com sha desatualizado).
  let workflowNote = '';
  try {
    const { content: wfContent, sha: wfSha } = await getGithubFile('.github/workflows/clickup-sync-schedule.yml', env.GITHUB_TOKEN);
    const updatedWf = insertWorkflowClientName(wfContent, task.name);
    if (updatedWf !== wfContent) {
      await commitGithubFile('.github/workflows/clickup-sync-schedule.yml', updatedWf, wfSha, `sync: adiciona cliente ${task.name} no workflow agendado`, env.GITHUB_TOKEN);
    }
  } catch (err) {
    workflowNote = ` — falta adicionar "${task.name}" manualmente no workflow (${err.message})`;
  }

  return `provisionado (${filePath})${workflowNote}`;
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
  const entry = `  { name: '${escapeJs(clientName)}', projectTaskId: '${taskId}', filePath: '${filePath}' },`;
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

// --- descoberta de serviços recorrentes (space "Clientes Recorrentes") ---

// Cada lista é um serviço; task com status CLIENTES dentro dela = esse
// cliente contrata esse serviço. Um cliente pode aparecer em várias listas
// ao mesmo tempo (ex: Planejamento + Social Media) — todas as aparições
// viram abas na mesma página. Correspondência com clientes de projeto
// (lista "Projetos") é por NOME EXATO da task — mesma convenção usada em
// todo o resto do arquivo.
const RECURRING_SERVICE_LISTS = [
  { id: '901321909248', key: 'cro', label: 'CRO' },
  { id: '1000240000006366', key: 'crm', label: 'CRM' },
  { id: '1000240000007728', key: 'planejamento', label: 'Planejamento' },
  { id: '1000240000008018', key: 'social-media', label: 'Social Media' },
];

async function discoverAndSyncRecurringServices(env) {
  const byName = new Map();
  for (const list of RECURRING_SERVICE_LISTS) {
    const tasks = await fetchListTasks(list.id, env.CLICKUP_API_TOKEN);
    for (const t of tasks) {
      if (statusKeyOf(t) !== 'clientes') continue;
      if (!byName.has(t.name)) byName.set(t.name, []);
      byName.get(t.name).push({ key: list.key, label: list.label, taskId: t.id });
    }
  }
  if (byName.size === 0) return [];

  const { content: ownSource, sha: ownSha } = await getGithubFile('functions/clickup-webhook.js', env.GITHUB_TOKEN);

  for (const [name, foundServices] of byName) {
    const alreadyHasAll = foundServices.every(s => ownSource.includes(`taskId: '${s.taskId}'`));
    if (alreadyHasAll) continue;

    // Só UM cliente por invocação — igual ao provisionamento de projeto:
    // buscar meses de N serviços (várias chamadas cada) + regenerar a
    // página + commitar CLIENTS (e o workflow, se novo) é caro demais pra
    // fazer vários de uma vez sem estourar o limite de subrequests.
    try {
      const msg = await syncRecurringServicesForClient(name, foundServices, ownSource, ownSha, env);
      return [`serviços recorrentes "${name}": ${msg}`];
    } catch (err) {
      return [`serviços recorrentes "${name}": FAILED - ${err.message}`];
    }
  }
  return [];
}

// Acha o objeto inteiro de um cliente em CLIENTS pelo nome — varredura de
// profundidade de chaves em vez de regex, porque a entrada pode ter um
// array `services` aninhado com objetos dentro (chaves desbalanceadas
// quebrariam um regex ingênuo tipo /\{[^{}]*\}/).
function extractClientEntryText(source, name) {
  const marker = `name: '${escapeJs(name)}'`;
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) return null;
  let start = markerIdx;
  while (start > 0 && source[start] !== '{') start--;
  if (source[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function findClientEntryInfo(source, name) {
  const entryText = extractClientEntryText(source, name);
  if (!entryText) return null;
  const filePathMatch = entryText.match(/filePath:\s*'([^']*)'/);
  const projectTaskIdMatch = entryText.match(/projectTaskId:\s*'([^']*)'/);
  return {
    entryText,
    filePath: filePathMatch ? filePathMatch[1] : null,
    projectTaskId: projectTaskIdMatch ? projectTaskIdMatch[1] : null,
  };
}

// Objeto "nu", sem vírgula/indentação — extractClientEntryText também
// devolve o entry existente nesse mesmo formato, então upsertClientEntry
// pode trocar um pelo outro sem duplicar a vírgula que já está no source.
function buildClientEntryLiteral(name, projectTaskId, services, filePath) {
  const parts = [`name: '${escapeJs(name)}'`];
  if (projectTaskId) parts.push(`projectTaskId: '${projectTaskId}'`);
  const servicesLiteral = services.map(s => `{ key: '${s.key}', label: '${escapeJs(s.label)}', taskId: '${s.taskId}' }`).join(', ');
  parts.push(`services: [${servicesLiteral}]`);
  parts.push(`filePath: '${filePath}'`);
  return `{ ${parts.join(', ')} }`;
}

// Substitui a entrada existente no lugar exato onde ela já estava (preserva
// posição/vizinhos/vírgula no array) ou, se o cliente é novo, insere no fim
// com sua própria indentação e vírgula — mesmo padrão do insertClientEntry.
function upsertClientEntry(source, existingEntryText, entryLiteral) {
  if (existingEntryText) return source.replace(existingEntryText, entryLiteral);
  const regex = /(const\s+CLIENTS\s*=\s*\[[\s\S]*?)\n(\];)/;
  if (!regex.test(source)) throw new Error('CLIENTS array não encontrado em functions/clickup-webhook.js');
  return source.replace(regex, `$1\n  ${entryLiteral},\n$2`);
}

// `foundServices` já é o estado ATUAL e completo (acabou de escanear as 4
// listas de novo) — não precisa mesclar com o que já existia, só
// reconstrói a entrada inteira com o que tem agora. Se o cliente já tinha
// `projectTaskId` (era um cliente "projeto" que ganhou serviço recorrente),
// preserva e busca as etapas de novo também — a página vira combo com
// sidebar automaticamente (buildClientHtml decide isso sozinho a partir de
// stages+services presentes).
async function syncRecurringServicesForClient(name, foundServices, ownSource, ownSha, env) {
  const info = findClientEntryInfo(ownSource, name);
  const isNewClient = !info;
  const filePath = info && info.filePath ? info.filePath : `${uniqueSlug(slugify(name), ownSource)}/index.html`;
  const projectTaskId = info ? info.projectTaskId : null;

  const stages = projectTaskId ? await buildProjectStages(projectTaskId, env.CLICKUP_API_TOKEN) : null;
  const services = [];
  for (const s of foundServices) {
    const months = await buildMonths(s.taskId, env.CLICKUP_API_TOKEN);
    services.push({ key: s.key, label: s.label, months });
  }
  const html = buildClientHtml(name, projectTaskId || foundServices[0].taskId, stages, services);

  let pageSha;
  try {
    pageSha = (await getGithubFile(filePath, env.GITHUB_TOKEN)).sha;
  } catch (err) {
    pageSha = undefined;
  }
  await commitGithubFile(filePath, html, pageSha, `sync: atualiza serviços recorrentes de ${name}`, env.GITHUB_TOKEN);

  const entryLiteral = buildClientEntryLiteral(name, projectTaskId, foundServices, filePath);
  const updatedSource = upsertClientEntry(ownSource, info ? info.entryText : null, entryLiteral);
  await commitGithubFile('functions/clickup-webhook.js', updatedSource, ownSha, `sync: atualiza serviços de ${name} em CLIENTS`, env.GITHUB_TOKEN);

  let workflowNote = '';
  if (isNewClient) {
    try {
      const { content: wfContent, sha: wfSha } = await getGithubFile('.github/workflows/clickup-sync-schedule.yml', env.GITHUB_TOKEN);
      const updatedWf = insertWorkflowClientName(wfContent, name);
      if (updatedWf !== wfContent) {
        await commitGithubFile('.github/workflows/clickup-sync-schedule.yml', updatedWf, wfSha, `sync: adiciona ${name} no workflow agendado`, env.GITHUB_TOKEN);
      }
    } catch (err) {
      workflowNote = ` — falta adicionar "${name}" manualmente no workflow (${err.message})`;
    }
  }

  return `${isNewClient ? 'provisionado' : 'atualizado'} (${filePath}, ${foundServices.length} serviço(s))${workflowNote}`;
}

// Gera a página do cliente — projeto (barra Kick-off/Go Live), serviços
// recorrentes (abas de serviço + mês, estilo Adah Beauty Tech), ou os dois
// juntos numa sidebar Projeto/Serviços (vira hambúrguer no mobile).
// `stages`/`services` ausente = seção ausente. Reaproveitado tanto pra
// provisionar cliente novo quanto pra "upgrade" de cliente existente que
// ganhou uma seção nova (ver discoverAndProvisionNewClients/
// discoverAndSyncRecurringServices) — nesses casos a página inteira é
// regenerada, não editada cirurgicamente, já que nenhuma delas é editada à
// mão. CSS/HTML usam template literals normalmente (sem interpolação de
// runtime dentro); só o <script> gerado usa concatenação de string, pra
// não ter crase aninhada dentro do template literal desta função —
// stagesArrayLiteral/servicesArrayLiteral são seguros de interpolar porque
// escapeJs também escapa crase.
function buildClientHtml(clientName, taskId, stages, services) {
  const safeName = escapeHtml(clientName);
  const hasProject = Array.isArray(stages);
  const hasServices = Array.isArray(services) && services.length > 0;
  const isCombo = hasProject && hasServices;
  const defaultSection = hasProject ? 'projeto' : 'servicos';

  const hoursEnabledJs = hasServices ? services.map(s => `'${s.key}': false`).join(', ') : '';

  const sidebarCss = !isCombo ? '' : `
  .app-shell{display:flex;align-items:flex-start;}
  .app-sidebar{width:180px;flex-shrink:0;padding-top:40px;}
  .app-sidebar nav{display:flex;flex-direction:column;gap:4px;position:sticky;top:24px;}
  .app-nav-btn{display:block;width:100%;font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:14px;color:var(--ink-soft);background:none;border:none;border-radius:10px;padding:10px 14px;cursor:pointer;text-align:left;transition:all .15s ease;}
  .app-nav-btn:hover{background:var(--tint-1);color:var(--ink);}
  .app-nav-btn.active{background:var(--brand);color:#fff;}
  .app-main{flex:1;min-width:0;}
  .app-section{display:none;}
  .app-section.active{display:block;}
  .app-hamburger{display:none;}
  .app-drawer-overlay{display:none;}
  @media (max-width:860px){
    .app-shell{display:block;}
    .app-sidebar{display:none;}
    .app-hamburger{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;position:sticky;top:0;background:var(--bg);z-index:10;border-bottom:1px solid var(--line);margin:0 -24px 12px;}
    .app-hamburger-title{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:15px;}
    .app-hamburger button{background:var(--panel);border:1px solid var(--line);border-radius:8px;width:38px;height:34px;font-size:16px;cursor:pointer;}
    .app-drawer{position:fixed;top:0;left:0;bottom:0;width:70%;max-width:260px;background:var(--panel);z-index:30;padding:24px 18px;transform:translateX(-100%);transition:transform .2s ease;box-shadow:2px 0 16px rgba(11,28,51,.15);}
    .app-drawer.open{transform:translateX(0);}
    .app-drawer-overlay{position:fixed;inset:0;background:rgba(11,28,51,.35);z-index:20;}
    .app-drawer-overlay.open{display:block;}
  }`;

  const projectCss = !hasProject ? '' : `
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
  @media (max-width:640px){
    .phase-head{display:none;}
    .phase-row{grid-template-columns:1fr 1fr;grid-template-areas:"main main" "owner dates" "status status";gap:8px;}
    .phase-main{grid-area:main;}
    .phase-owner{grid-area:owner;}
    .phase-status{grid-area:status;justify-self:start;width:fit-content;}
    .phase-dates{grid-area:dates;text-align:left;}
    .phase-dates::before{content:"Prazo";display:block;font-size:9.5px;color:var(--ink-soft);margin-bottom:3px;}
    .meeting-row{grid-template-columns:1fr;gap:4px;}
    .meeting-row .m-date,.meeting-row .m-tag{justify-self:start;}
    .bar-caption{flex-direction:column;gap:8px;}
    .status-side.right{align-items:flex-start;text-align:left;margin-top:8px;}
  }`;

  const servicesCss = !hasServices ? '' : `
  .service-tabs{display:flex;gap:22px;margin-bottom:22px;flex-wrap:wrap;}
  .service-tab-btn{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:15px;background:none;color:var(--ink-soft);border:none;border-bottom:2px solid transparent;padding:6px 2px 10px;cursor:pointer;transition:all .15s ease;}
  .service-tab-btn:hover{color:var(--ink);}
  .service-tab-btn.active{color:var(--ink);border-bottom-color:var(--brand);}
  .tabs{display:flex;gap:8px;margin-bottom:26px;flex-wrap:wrap;}
  .tab-btn{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:13.5px;background:var(--panel);color:var(--ink-soft);border:1px solid var(--line);padding:9px 18px;border-radius:20px;cursor:pointer;transition:all .15s ease;}
  .tab-btn:hover{border-color:var(--brand);color:var(--brand);}
  .tab-btn.active{background:var(--brand);color:#fff;border-color:var(--brand);}
  .tab-btn .current-mark{display:inline-block;width:6px;height:6px;border-radius:50%;background:#2FBE6C;margin-left:7px;vertical-align:middle;}
  .month-panel{display:none;}
  .month-panel.active{display:block;animation:fadeIn .3s ease;}
  @keyframes fadeIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
  .summary{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:24px;}
  .summary-item{display:flex;flex-direction:column;gap:2px;}
  .summary-label{font-family:'Inter',sans-serif;font-size:11px;color:var(--ink-soft);white-space:nowrap;}
  .summary-value{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:20px;color:var(--brand);}
  .summary-value.ink{color:var(--ink);}
  .demands{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:8px 26px;box-shadow:0 1px 2px rgba(11,28,51,0.04);}
  .demand-row{display:grid;grid-template-columns:1fr 130px 90px 80px 130px;gap:14px;align-items:center;padding:16px 0;border-top:1px solid var(--line);}
  .demand-row.no-hours{grid-template-columns:1fr 130px 90px 130px;}
  .demand-row:first-of-type{border-top:none;}
  .demand-head{font-family:'Inter',sans-serif;font-size:10.5px;color:var(--ink-soft);padding:12px 0 6px;}
  .d-title{font-family:'Inter',sans-serif;font-weight:500;font-size:14px;color:var(--ink);}
  .d-desc{font-size:12px;color:var(--ink-soft);margin-top:2px;}
  .d-owner{font-size:13px;color:var(--ink-soft);display:flex;align-items:center;gap:7px;}
  .d-deadline{font-family:'Inter',sans-serif;font-size:13px;color:var(--ink);text-align:center;}
  .d-hours{font-family:'Inter',sans-serif;font-size:13px;color:var(--ink);text-align:center;}
  .status{font-size:11px;padding:4px 10px;border-radius:20px;text-align:center;white-space:nowrap;}
  .status.a-fazer{background:var(--tint-1);color:var(--ink-soft);}
  .status.em-andamento{background:var(--tint-2);color:var(--brand);}
  .status.feito{background:var(--brand);color:#fff;}
  .status.em-analise{background:var(--panel);color:var(--ink-soft);border:1px dashed var(--line);}
  @media (max-width:720px){
    .demand-row{display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-areas:"main main main" "owner deadline hours" "status status status";gap:8px;padding:16px 0;}
    .demand-head{display:none;}
    .demand-head + .demand-row{border-top:none;}
    .d-main{grid-area:main;}
    .d-owner{grid-area:owner;}
    .d-deadline{grid-area:deadline;text-align:left;}
    .d-deadline::before{content:"Prazo";display:block;font-size:9.5px;color:var(--ink-soft);margin-bottom:3px;}
    .d-hours{grid-area:hours;text-align:left;}
    .d-hours::before{content:"Horas";display:block;font-size:9.5px;color:var(--ink-soft);margin-bottom:3px;}
    .status{grid-area:status;justify-self:start;width:fit-content;}
    .demand-row.no-hours{grid-template-columns:1fr 1fr;grid-template-areas:"main main" "owner deadline" "status status";}
    .summary{gap:14px;flex-wrap:nowrap;}
    .summary-label{font-size:10px;}
  }`;

  const headerMarkup = !isCombo ? '' : `
<div class="app-hamburger" id="appHamburger">
  <span class="app-hamburger-title">${safeName}</span>
  <button id="appHamburgerBtn" type="button" aria-label="Menu">&#9776;</button>
</div>
<div class="app-drawer-overlay" id="appDrawerOverlay"></div>`;

  const sidebarMarkup = !isCombo ? '' : `
  <div class="app-sidebar">
    <nav>
      ${hasProject ? '<button class="app-nav-btn" data-section="projeto">Projeto</button>' : ''}
      ${hasServices ? '<button class="app-nav-btn" data-section="servicos">Serviços</button>' : ''}
    </nav>
  </div>
  <div class="app-drawer" id="appDrawer">
    <nav>
      ${hasProject ? '<button class="app-nav-btn" data-section="projeto">Projeto</button>' : ''}
      ${hasServices ? '<button class="app-nav-btn" data-section="servicos">Serviços</button>' : ''}
    </nav>
  </div>`;

  const projectInner = !hasProject ? '' : `
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
  </div>`;

  const servicesInner = !hasServices ? '' : `
  <div class="service-tabs" id="serviceTabs"></div>
  <div class="tabs" id="tabs"></div>
  <div id="monthPanels"></div>`;

  const projectSection = !hasProject ? '' : (isCombo
    ? `<div class="app-section" data-section="projeto">${projectInner}</div>`
    : projectInner);
  const servicesSection = !hasServices ? '' : (isCombo
    ? `<div class="app-section" data-section="servicos">${servicesInner}</div>`
    : servicesInner);

  const footnoteText = isCombo
    ? 'Atualizado sempre que houver uma mudança de status'
    : hasProject
      ? 'Atualizado sempre que uma etapa muda de status'
      : 'Atualizado sempre que uma solicitação muda de status';

  // --- <script> gerado: concatenação de string em vez de template literal,
  // pra não ter crase aninhada dentro do template literal desta função. ---

  const projectScript = !hasProject ? '' : `
  // Página criada/atualizada automaticamente pela rotina de descoberta na
  // lista "Projetos" (status CLIENTES), a partir da task ${taskId}. Qualquer
  // nome de subtask vira etapa, sem lista fixa.
  var stages = ${stagesArrayLiteral(stages)};

  var STATUS_LABELS = {
    'pendentes': 'Pendente', 'planejamento': 'Planejamento', 'importante': 'Importante',
    'em-andamento': 'Em andamento', 'concluido': 'Concluído', 'fechado': 'Fechado',
  };
  function statusLabel(key) { return STATUS_LABELS[key] || key || '-'; }
  function fmtFull(date) { return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  function fmtShort(date) { return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', ''); }

  var flow = stages.filter(function (s) { return !s.isMeetings; });
  var meetingsStage = stages.find(function (s) { return s.isMeetings; });
  var meetings = meetingsStage ? meetingsStage.items : [];

  var kickoffMs = (meetings.length && meetings[0].dueMs) ? meetings[0].dueMs
    : (flow.length && flow[0].startMs) ? flow[0].startMs
    : null;
  var flowDueValues = flow.map(function (s) { return s.dueMs; }).filter(Boolean);
  var flowFinalMs = flowDueValues.length ? Math.max.apply(null, flowDueValues) : null;
  var meetingsFinalMs = meetings.length ? meetings[meetings.length - 1].dueMs : null;
  var finalMs = Math.max(flowFinalMs || 0, meetingsFinalMs || 0) || null;

  function renderTimeline() {
    var wrap = document.getElementById('barWrap');
    if (!kickoffMs || !finalMs || finalMs <= kickoffMs) { wrap.style.display = 'none'; return; }
    var now = Date.now();
    var pct = function (ms) { return Math.min(100, Math.max(0, ((ms - kickoffMs) / (finalMs - kickoffMs)) * 100)); };
    document.getElementById('edgeStart').textContent = fmtFull(new Date(kickoffMs));
    document.getElementById('edgeEnd').textContent = fmtFull(new Date(finalMs));
    var midnight = function (ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    var diffDays = Math.round((midnight(finalMs) - midnight(now)) / 86400000);
    var daysEl = document.getElementById('kpiDaysLeft');
    var daysLabelEl = document.getElementById('kpiDaysLabel');
    if (diffDays > 1) { daysLabelEl.textContent = 'Faltam para o Go Live'; daysEl.textContent = diffDays + ' dias'; }
    else if (diffDays === 1) { daysLabelEl.textContent = 'Faltam para o Go Live'; daysEl.textContent = '1 dia'; }
    else if (diffDays === 0) { daysLabelEl.textContent = 'Go Live'; daysEl.textContent = 'Hoje'; }
    else { daysLabelEl.textContent = 'Go Live'; daysEl.textContent = 'Prazo encerrado'; }
    document.getElementById('overviewFill').style.width = pct(now).toFixed(1) + '%';
    document.getElementById('overviewTicks').innerHTML = meetings.filter(function (m) { return m.dueMs; }).map(function (m) {
      return '<div class="tick" style="left:' + pct(m.dueMs).toFixed(1) + '%;">' +
        '<div class="tick-tip"><b>' + m.title + '</b> &middot; ' + fmtShort(new Date(m.dueMs)) + '</div></div>';
    }).join('');
    if (now >= kickoffMs && now <= finalMs) {
      var marker = document.createElement('div');
      marker.className = 'now-marker';
      marker.style.left = pct(now).toFixed(1) + '%';
      document.querySelector('.overview-track-wrap').appendChild(marker);
    }
    var currentIdx = flow.findIndex(function (s) { return s.statusKey !== 'concluido' && s.statusKey !== 'fechado'; });
    var capCurrent = document.getElementById('capCurrent');
    var capNext = document.getElementById('capNext');
    if (currentIdx === -1) {
      var finalMeeting = meetings.length ? meetings[meetings.length - 1] : null;
      if (finalMeeting && finalMeeting.dueMs && now < finalMeeting.dueMs) {
        capCurrent.textContent = finalMeeting.title + ' · ' + fmtShort(new Date(finalMeeting.dueMs));
      } else {
        capCurrent.textContent = 'Projeto entregue';
      }
      capNext.textContent = '';
    } else {
      var s = flow[currentIdx];
      capCurrent.textContent = s.label + (s.dueMs ? ' · até ' + fmtShort(new Date(s.dueMs)) : '');
      var nextS = flow[currentIdx + 1];
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
            : (it.statusKey === 'em-andamento') ? ' active' : '';
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
    var section = document.getElementById('meetingsSection');
    if (!meetingsStage) { section.style.display = 'none'; return; }
    document.getElementById('meetingsTitle').textContent = meetingsStage.label || 'Reuniões previstas';
    document.getElementById('meetingsSub').textContent = meetingsStage.subtitle || '';
    var listEl = document.getElementById('meetingList');
    if (meetings.length === 0) {
      listEl.innerHTML = '<div class="empty-state">Nenhuma reunião registrada ainda.</div>';
    } else {
      listEl.innerHTML = meetings.map(function (m, i) {
        var tagHtml = m.tag
          ? ('<div class="m-tag' + (m.tag === 'Entrega Final' ? ' final' : '') + '">' + m.tag + '</div>')
          : '<div></div>';
        return '<div class="meeting-row">' +
          '<div class="m-date">' + (m.date || '-') + '</div>' +
          '<div class="m-title">' + m.title + '<div class="phase-sub">' + (m.subtitle || '') + '</div></div>' +
          tagHtml +
        '</div>';
      }).join('');
    }
  }
`;

  const servicesScript = !hasServices ? '' : `
  var services = ${servicesArrayLiteral(services)};
  var SERVICE_STATUS_LABEL = { 'a-fazer': 'A fazer', 'em-andamento': 'Em andamento', 'feito': 'Feito', 'em-analise': 'Em análise' };
  function formatHours(n) {
    if (n == null) return '-';
    var totalMinutes = Math.round(n * 60);
    var h = Math.floor(totalMinutes / 60);
    var m = totalMinutes % 60;
    if (h === 0) return m + 'm';
    if (m === 0) return h + 'h';
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }
  // Sem horas por padrão pra serviço recém-descoberto — ajuste manual aqui
  // se algum serviço específico deve mostrar a coluna.
  var HOURS_ENABLED = { ${hoursEnabledJs} };
  var activeServiceKey = services[0].key;
  function currentService() { return services.find(function (s) { return s.key === activeServiceKey; }) || services[0]; }

  function renderServiceTabs() {
    document.getElementById('serviceTabs').innerHTML = services.map(function (s) {
      return '<button class="service-tab-btn' + (s.key === activeServiceKey ? ' active' : '') + '" data-service="' + s.key + '">' + s.label + '</button>';
    }).join('');
    document.querySelectorAll('.service-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { showService(btn.dataset.service); });
    });
  }

  function renderTabs(currentKey) {
    var months = currentService().months;
    document.getElementById('tabs').innerHTML = months.map(function (m) {
      return '<button class="tab-btn' + (m.key === currentKey ? ' active' : '') + '" data-key="' + m.key + '">' +
        m.label + (isRealCurrentMonth(m.key) ? '<span class="current-mark"></span>' : '') + '</button>';
    }).join('');
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { showMonth(btn.dataset.key); });
    });
  }

  function isRealCurrentMonth(key) {
    var now = new Date();
    var nowKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    return key === nowKey;
  }

  function renderPanels() {
    var months = currentService().months;
    var showHours = HOURS_ENABLED[activeServiceKey] !== false;
    document.getElementById('monthPanels').innerHTML = months.map(function (m) {
      var total = m.demands.length;
      var done = m.demands.filter(function (d) { return d.status === 'feito'; }).length;
      var doing = m.demands.filter(function (d) { return d.status === 'em-andamento'; }).length;
      var hasHours = showHours && m.demands.some(function (d) { return d.hours != null; });
      var totalHours = m.demands.reduce(function (sum, d) { return sum + (d.hours || 0); }, 0);
      var rowsHtml;
      if (total === 0) {
        rowsHtml = '<div class="empty-state"><b>Nenhuma solicitação registrada ainda</b>Assim que houverem solicitações ou pontos da reunião mensal, eles aparecem aqui.</div>';
      } else {
        var head = '<div class="demand-row demand-head' + (showHours ? '' : ' no-hours') + '">' +
          '<div>Demanda</div><div>Responsável</div><div style="text-align:center;">Prazo</div>' +
          (showHours ? '<div style="text-align:center;">Horas</div>' : '') + '<div>Status</div></div>';
        var body = m.demands.map(function (d) {
          var ownerHtml = d.owner ? ('<span class="owner-avatar">' + d.owner.charAt(0) + '</span>' + d.owner) : '-';
          return '<div class="demand-row' + (showHours ? '' : ' no-hours') + '">' +
            '<div class="d-main"><div class="d-title">' + d.title + '</div><div class="d-desc">' + (d.desc || '') + '</div></div>' +
            '<div class="d-owner">' + ownerHtml + '</div>' +
            '<div class="d-deadline">' + (d.deadline || '-') + '</div>' +
            (showHours ? ('<div class="d-hours">' + formatHours(d.hours) + '</div>') : '') +
            '<div class="status ' + d.status + '">' + (SERVICE_STATUS_LABEL[d.status] || '-') + '</div>' +
          '</div>';
        }).join('');
        rowsHtml = head + body;
      }
      var hoursSummary = hasHours ? ('<div class="summary-item"><span class="summary-value ink">' + formatHours(totalHours) + '</span><span class="summary-label">horas utilizadas</span></div>') : '';
      return '<div class="month-panel" id="panel-' + m.key + '">' +
        '<div class="summary">' +
          '<div class="summary-item"><span class="summary-value">' + total + '</span><span class="summary-label">solicitações</span></div>' +
          '<div class="summary-item"><span class="summary-value ink">' + doing + '</span><span class="summary-label">em andamento</span></div>' +
          '<div class="summary-item"><span class="summary-value ink">' + done + '</span><span class="summary-label">feitas</span></div>' +
          hoursSummary +
        '</div>' +
        '<div class="demands">' + rowsHtml + '</div>' +
      '</div>';
    }).join('');
  }

  function showMonth(key) {
    document.querySelectorAll('.month-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + key); });
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.key === key); });
  }

  function defaultMonthKey(months) {
    if (!months.length) return null;
    var now = new Date();
    var nowKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var found = months.some(function (m) { return m.key === nowKey; });
    return found ? nowKey : months[months.length - 1].key;
  }

  function showService(key) {
    activeServiceKey = key;
    renderServiceTabs();
    renderPanels();
    var monthKey = defaultMonthKey(currentService().months);
    renderTabs(monthKey);
    if (monthKey) showMonth(monthKey);
  }
`;

  const sidebarScript = !isCombo ? '' : `
  function showAppSection(key) {
    document.querySelectorAll('.app-section').forEach(function (s) { s.classList.toggle('active', s.dataset.section === key); });
    document.querySelectorAll('.app-nav-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.section === key); });
    var drawer = document.getElementById('appDrawer');
    var overlay = document.getElementById('appDrawerOverlay');
    if (drawer) drawer.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }
  document.querySelectorAll('.app-nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { showAppSection(btn.dataset.section); });
  });
  var appHamburgerBtn = document.getElementById('appHamburgerBtn');
  if (appHamburgerBtn) appHamburgerBtn.addEventListener('click', function () {
    document.getElementById('appDrawer').classList.add('open');
    document.getElementById('appDrawerOverlay').classList.add('open');
  });
  var appOverlayEl = document.getElementById('appDrawerOverlay');
  if (appOverlayEl) appOverlayEl.addEventListener('click', function () {
    document.getElementById('appDrawer').classList.remove('open');
    appOverlayEl.classList.remove('open');
  });
`;

  const initCalls = [
    hasProject ? 'renderTimeline(); renderStages(); renderMeetings();' : '',
    hasServices ? 'showService(activeServiceKey);' : '',
    isCombo ? `showAppSection('${defaultSection}');` : '',
  ].filter(Boolean).join('\n  ');

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
  .logo{height:34px;}
  .head-meta{font-size:12px;color:var(--ink-soft);margin-top:8px;}
  .eyebrow{font-family:'Inter',sans-serif;font-size:12px;color:var(--ink-soft);margin:14px 0 10px;display:flex;align-items:center;gap:7px;}
  .live-dot{width:7px;height:7px;border-radius:50%;background:#2FBE6C;flex-shrink:0;box-shadow:0 0 0 0 rgba(47,190,108,0.6);animation:pulse 1.8s infinite;}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(47,190,108,0.55);}70%{box-shadow:0 0 0 7px rgba(47,190,108,0);}100%{box-shadow:0 0 0 0 rgba(47,190,108,0);}}
  h1{font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:32px;margin:0;line-height:1.1;color:var(--ink);}
  .owner-avatar{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--brand);color:#fff;font-size:10.5px;font-weight:500;flex-shrink:0;}
  .empty-state{padding:24px 0;text-align:center;color:var(--ink-soft);font-size:13.5px;}
  .empty-state b{display:block;font-family:'Clash Grotesk',sans-serif;font-weight:600;font-size:15px;color:var(--ink);margin-bottom:6px;}
  .footnote{margin-top:26px;font-size:12px;color:var(--ink-soft);text-align:center;}
  ${sidebarCss}
  ${projectCss}
  ${servicesCss}
</style>
</head>
<body>
<div class="topbar"></div>${headerMarkup}
<div class="${isCombo ? 'app-shell' : ''}">${sidebarMarkup}
  <div class="${isCombo ? 'app-main' : ''}">
    <div class="wrap">

      <div class="head">
        <svg class="logo" viewBox="0 0 334 183" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8.54633 62.1595H0L5.5249 0.346292H13.8123L10.9635 32.2052L22.4449 0.346292H30.7323L8.54633 62.1595ZM72.9719 62.1595L74.7848 40.776H66.0658L58.2964 62.1595H50.009L73.5762 0.259719H84.7123L81.2593 62.1595H72.9719ZM69.0009 32.5515H75.3891L77.2882 10.0425L69.0009 32.5515ZM137.915 47.9615L149.311 0H157.598L142.75 62.5058H129.887L134.031 14.1114L122.895 62.5058H114.607L128.937 0H142.318L137.915 47.9615ZM200.01 54.1082L198.025 62.1595H176.788L198.111 8.3976H189.306L191.119 0.346292H209.592L188.27 54.1082H200.01ZM254.595 62.1595L256.407 40.776H247.688L239.919 62.1595H231.632L255.199 0.259719H266.335L262.882 62.1595H254.595ZM250.624 32.5515H257.012L258.911 10.0425L250.624 32.5515ZM314.704 61.8132L313.495 27.7034L311.769 29.8677L304.345 62.073H296.316L310.474 0.346292H318.502L315.481 13.7651L323.854 0.346292H333.782L321.524 18.1804L323.077 61.8132H314.704Z" fill="#015EC5"/>
          <path d="M15.7461 168.916H34.6414L31.766 181.823H0L22.5922 83.2321H35.4629L15.7461 168.916ZM121.218 181.823L124.093 147.907H110.264L97.9407 181.823H84.7962L122.176 83.644H139.839L134.362 181.823H121.218ZM114.919 134.862H125.051L128.064 99.1604L114.919 134.862ZM232.577 123.602C234.904 126.623 235.863 130.743 234.904 135.274L227.921 165.346C225.867 174.408 216.831 181.823 207.794 181.823H187.529L209.848 84.0559H227.921C237.78 84.4679 241.477 94.0798 239.286 103.143L236 116.737C235.452 119.208 234.22 121.543 232.577 123.602ZM210.806 168.641C212.723 168.641 214.503 167.131 214.914 165.346L221.76 135.274C222.171 133.352 220.938 131.978 219.158 131.978H211.901L203.549 168.641H210.806ZM219.843 97.1007L214.777 118.796H220.254C221.349 118.796 222.718 117.835 222.992 116.599L226.278 103.005C226.963 100.259 226.278 97.238 224.361 97.1007H219.843ZM295.739 182.647C285.333 182.647 278.898 174.134 281.362 163.835L284.785 148.868H298.067L294.644 163.835C293.959 166.856 295.876 169.328 298.888 169.328C301.901 169.328 304.776 166.856 305.461 163.835L308.473 150.79L292.042 117.423L295.876 100.396C298.341 89.9604 308.61 81.447 319.016 81.447C329.285 81.447 335.72 89.9604 333.256 100.396L329.833 115.226H316.551L319.974 100.396C320.796 97.238 319.016 94.9037 316.004 94.9037C312.991 94.9037 309.979 97.238 309.157 100.396L306.282 112.892L322.713 146.259L318.742 163.835C316.277 174.134 306.008 182.647 295.739 182.647Z" fill="#015EC5"/>
        </svg>
        <div class="eyebrow"><span class="live-dot"></span>${isCombo ? 'Acompanhamento do Cliente' : hasProject ? 'Cronograma do Projeto' : 'Relatório de Acompanhamento'}</div>
        <h1>${safeName}</h1>
        <div class="head-meta" id="generatedAt">Atualizado em -</div>
      </div>

      ${projectSection}
      ${servicesSection}

      <div class="footnote">${footnoteText}</div>

    </div>
  </div>
</div>

<script>
  var generatedAt = null;
${projectScript}${servicesScript}${sidebarScript}
  document.getElementById('generatedAt').textContent = generatedAt
    ? 'Atualizado em ' + new Date(generatedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Ainda não sincronizado';

  ${initCalls}
</script>
</body>
</html>
`;
}
