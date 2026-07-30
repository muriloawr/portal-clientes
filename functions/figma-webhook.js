// Cloudflare Pages Function — POST /figma-webhook
// Disparada pelo webhook FILE_UPDATE do Figma (ou manualmente, com o mesmo
// passcode, pra teste). Pra cada cliente cadastrado em FIGMA_CLIENTS, a
// página "Prototype" do arquivo tem frames de topo que viram itens (nível 2,
// sob a stage "Desenvolvimento" do cliente), e os filhos diretos de cada um
// viram demandas (nível 4, ocultas do cliente). Identificação é sempre por
// node-id do Figma (guardado escondido na descrição da task do ClickUp),
// nunca por nome — nome pode mudar à vontade que a automação continua
// reconhecendo a mesma task.
//
// Cada invocação do Worker tem limite de subrequests (50 no plano free do
// Cloudflare) — processar todos os itens de um cliente numa chamada só
// estoura esse limite rápido (um cliente com vários itens, cada um com várias
// seções, facilmente passa de 50 chamadas pro ClickUp). Por isso o endpoint
// funciona em dois passos, com uma chamada HTTP por item:
//   1. body com `list_items: true` → devolve os itens (frames de topo) do
//      cliente, sem criar nada.
//   2. body com `item_node_id: "<id>"` → sincroniza só aquele item e as
//      demandas dele.
const FIGMA_CLIENTS = [
  { name: 'PROTS', fileKey: '8pk8WhFEFBO42cKnXtHai5', taskId: 'wdpu2ybucf' },
];

const LIST_ID = '901324765433'; // lista "Projetos" no ClickUp

const FIGMA_MARKER_RE = /<!--\s*figma:([^\s]+)\s*-->/;

export async function onRequestPost(context) {
  const { request, env } = context;
  const rawBody = await request.text();

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return new Response('Invalid JSON body', { status: 400 });
  }

  if (!payload.passcode || payload.passcode !== env.FIGMA_WEBHOOK_PASSCODE) {
    return new Response('Invalid passcode', { status: 401 });
  }

  const client = FIGMA_CLIENTS.find(c => c.fileKey === payload.file_key || c.name === payload.client);
  if (!client) {
    return new Response(`Unknown Figma file/client: ${payload.file_key || payload.client}`, { status: 400 });
  }

  try {
    if (payload.list_items) {
      const items = await listItemFrames(client, env.FIGMA_API_TOKEN);
      return new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (payload.item_node_id) {
      const log = await syncOneItem(client, payload.item_node_id, env);
      return new Response(`${client.name} / ${payload.item_node_id}: ${log.length === 0 ? 'no changes' : log.join('; ')}`, { status: 200 });
    }
    return new Response('Body precisa de "list_items": true ou "item_node_id": "<id>"', { status: 400 });
  } catch (err) {
    return new Response(`${client.name}: FAILED - ${err.message}`, { status: 500 });
  }
}

export async function onRequestGet() {
  return new Response('figma-webhook: use POST', { status: 200 });
}

// --- sincronização ---

async function getItemFrames(client, figmaToken) {
  const fileData = await fetchFigmaFile(client.fileKey, figmaToken);
  const prototypePage = (fileData.document.children || []).find(
    c => c.type === 'CANVAS' && c.name === 'Prototype',
  );
  if (!prototypePage) throw new Error('Pagina "Prototype" nao encontrada no arquivo');
  return (prototypePage.children || []).map(resolveEffectiveNode);
}

async function listItemFrames(client, figmaToken) {
  const itemFrames = await getItemFrames(client, figmaToken);
  return itemFrames.map(n => ({ id: n.id, name: n.name, demandas: (n.children || []).length }));
}

async function syncOneItem(client, itemNodeId, env) {
  const log = [];
  const itemFrames = await getItemFrames(client, env.FIGMA_API_TOKEN);
  const itemNode = itemFrames.find(n => n.id === itemNodeId);
  if (!itemNode) throw new Error(`Frame de item com node-id ${itemNodeId} nao encontrado na pagina Prototype`);

  const devTaskId = await findDevelopmentTaskId(client.taskId, env.CLICKUP_API_TOKEN);
  const itemMap = await syncFigmaLevel([itemNode], devTaskId, env.CLICKUP_API_TOKEN, log);
  const itemTaskId = itemMap.get(itemNode.id);

  const demandaNodes = itemNode.children || [];
  if (demandaNodes.length > 0) {
    await syncFigmaLevel(demandaNodes, itemTaskId, env.CLICKUP_API_TOKEN, log);
  }

  return log;
}

// Se um frame de topo só embrulha um único filho (ex: um frame sem nome
// útil contendo só a página de verdade dentro), usa o filho como o nó
// efetivo em vez do embrulho — evita depender de organização manual no Figma.
function resolveEffectiveNode(node) {
  let current = node;
  while (current.children && current.children.length === 1) {
    current = current.children[0];
  }
  return current;
}

async function findDevelopmentTaskId(clientTaskId, token) {
  const stages = await fetchClickUpSubtasks(clientTaskId, token);
  const dev = stages.find(t => /desenvolv/i.test(t.name));
  if (!dev) throw new Error('Stage "Desenvolvimento" nao encontrada na task-mae');
  return dev.id;
}

// Cria/renomeia as tasks de um nível (item ou demandas) a partir dos nós do
// Figma, comparando pelo node-id gravado na descrição. Retorna um mapa
// node-id do Figma → id da task no ClickUp, pros filhos usarem como parent.
async function syncFigmaLevel(figmaNodes, parentTaskId, token, log) {
  const existing = await fetchClickUpSubtasks(parentTaskId, token);
  const byNodeId = new Map();
  for (const t of existing) {
    const m = (t.description || '').match(FIGMA_MARKER_RE);
    if (m) byNodeId.set(m[1], t);
  }

  const resultMap = new Map();
  for (const node of figmaNodes) {
    const existingTask = byNodeId.get(node.id);
    if (existingTask) {
      if (existingTask.name !== node.name) {
        await renameClickUpTask(existingTask.id, node.name, token);
        log.push(`renomeado: '${existingTask.name}' -> '${node.name}'`);
        await sleep(300);
      }
      resultMap.set(node.id, existingTask.id);
    } else {
      const created = await createClickUpTask(parentTaskId, node.name, figmaMarker(node.id), token);
      log.push(`criado: '${node.name}'`);
      resultMap.set(node.id, created.id);
      await sleep(300);
    }
  }
  return resultMap;
}

function figmaMarker(nodeId) {
  return `<!-- figma:${nodeId} -->`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Figma ---

async function fetchFigmaFile(fileKey, token) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
    headers: { 'X-Figma-Token': token },
  });
  if (!res.ok) throw new Error(`Figma API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// --- ClickUp ---

async function fetchClickUpSubtasks(taskId, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}?include_subtasks=true`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`ClickUp API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.subtasks || [];
}

async function createClickUpTask(parentTaskId, name, description, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, parent: parentTaskId }),
  });
  if (!res.ok) throw new Error(`ClickUp API error (create): ${res.status} ${await res.text()}`);
  return res.json();
}

async function renameClickUpTask(taskId, name, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    method: 'PUT',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`ClickUp API error (rename): ${res.status} ${await res.text()}`);
  return res.json();
}
