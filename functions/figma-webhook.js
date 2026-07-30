// Cloudflare Pages Function — POST /figma-webhook
// Disparada pelo webhook FILE_UPDATE do Figma (ou manualmente, com o mesmo
// passcode, pra teste). Pra cada cliente cadastrado em FIGMA_CLIENTS, a
// página "Prototype" do arquivo tem frames de topo que viram itens (nível 2,
// sob a stage "Desenvolvimento" do cliente), e os filhos diretos de cada um
// viram demandas (nível 4, ocultas do cliente). Identificação é sempre por
// node-id do Figma (guardado numa tag na task do ClickUp, tipo
// "figma-298-1175", buscada direto por tag na lista — nem descrição nem tag
// vêm completas no endpoint de listagem de subtasks), nunca por nome — nome
// pode mudar à vontade que a automação continua reconhecendo a mesma task.
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

  // Modo administrativo temporário, pra limpar tasks criadas por engano sem
  // depender da cota da integração MCP do ClickUp (token separado, cota
  // própria). Remover depois que não precisar mais.
  if (Array.isArray(payload.delete_task_ids)) {
    const log = await deleteClickUpTasks(payload.delete_task_ids, env.CLICKUP_API_TOKEN);
    return new Response(log.join('\n'), { status: 200 });
  }
  if (payload.list_clickup_subtasks) {
    const subtasks = await fetchClickUpSubtasks(payload.list_clickup_subtasks, env.CLICKUP_API_TOKEN);
    const summary = subtasks.map(t => ({ id: t.id, name: t.name, tags: t.tags }));
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (payload.get_clickup_task) {
    const res = await fetch(`https://api.clickup.com/api/v2/task/${payload.get_clickup_task}`, {
      headers: { Authorization: env.CLICKUP_API_TOKEN },
    });
    const data = await res.json();
    return new Response(JSON.stringify({ id: data.id, name: data.name, tags: data.tags }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  const rawNodes = (prototypePage.children || []).map(resolveEffectiveNode);
  return mergeDesktopMobile(rawNodes);
}

// Frames "X Desktop" e "X Mobile" viram um item só, "X" — pro cliente não
// importa a plataforma, e o conteúdo do Mobile sempre acompanha o Desktop.
// Usa sempre o Desktop como fonte de nome/demandas (cai pro Mobile se só
// ele existir). Frames sem esse sufixo (Cart, Menu, componentes soltos
// etc.) ficam exatamente como estão, cada um seu próprio item — mesmo que
// o nome se repita entre dois frames com ids diferentes.
function mergeDesktopMobile(nodes) {
  const groups = new Map();
  const result = [];
  for (const node of nodes) {
    const m = node.name.match(/^(.*?)\s+(Desktop|Mobile)$/i);
    if (!m) {
      result.push(node);
      continue;
    }
    const base = m[1].trim();
    const variant = m[2].toLowerCase();
    if (!groups.has(base)) groups.set(base, {});
    groups.get(base)[variant] = node;
  }
  for (const [base, g] of groups) {
    const source = g.desktop || g.mobile;
    result.push({ ...source, name: base });
  }
  return result;
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
  const itemMap = await syncFigmaLevel([itemNode], devTaskId, env.CLICKUP_API_TOKEN, client.fileKey, log, null);
  const itemTaskId = itemMap.get(itemNode.id);

  const demandaNodes = itemNode.children || [];
  if (demandaNodes.length > 0) {
    await syncFigmaLevel(demandaNodes, itemTaskId, env.CLICKUP_API_TOKEN, client.fileKey, log, client.name);
  }

  return log;
}

// Se um frame de topo só embrulha um único filho (ex: um frame sem nome
// útil contendo só a página de verdade dentro), usa o filho como o nó
// efetivo em vez do embrulho — evita depender de organização manual no
// Figma. Link de design funciona em cima de qualquer node-id diretamente,
// então não precisa mais rastrear o id do frame de fora separado.
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
// Figma. `include_subtasks=true` não devolve tags nem descrição completas
// (só campos "core" tipo nome/status), então em vez de listar os filhos
// existentes e cruzar localmente, busca cada node-id direto por tag na lista
// inteira (`?tags[]=...`) — funciona não importa embaixo de qual task ela
// esteja hoje. Retorna um mapa node-id do Figma → id da task no ClickUp,
// pros filhos usarem como parent.
// `clientNameForDedup` é opcional (só faz sentido pro nível de demanda):
// quando presente, cada demanda nova também recebe uma tag por nome
// (`demanda-{cliente}-{nome}`) e, se essa tag já existir em qualquer outro
// nó, a criação é pulada — evita repetir "Footer" etc. em todo item.
async function syncFigmaLevel(figmaNodes, parentTaskId, token, fileKey, log, clientNameForDedup) {
  const resultMap = new Map();
  for (const node of figmaNodes) {
    const existingTask = await findClickUpTaskByTag(nodeIdToTag(node.id), token);
    if (existingTask) {
      if (existingTask.name !== node.name) {
        await renameClickUpTask(existingTask.id, node.name, token);
        log.push(`renomeado: '${existingTask.name}' -> '${node.name}'`);
        await sleep(300);
      }
      resultMap.set(node.id, existingTask.id);
      continue;
    }

    const nameTag = clientNameForDedup ? nameDedupTag(clientNameForDedup, node.name) : null;
    if (nameTag) {
      const dupTask = await findClickUpTaskByTag(nameTag, token);
      if (dupTask) {
        log.push(`pulado (repetido em outro item): '${node.name}'`);
        continue;
      }
    }

    const tags = nameTag ? [nodeIdToTag(node.id), nameTag] : [nodeIdToTag(node.id)];
    const created = await createClickUpTask(parentTaskId, node.name, tags, token);
    // Link só na criação — repetir a cada sync duplicaria o comentário.
    // Vai em comentário (não descrição) porque a integração nativa do
    // ClickUp com o Figma reconhece link solto e converte pra formato de
    // apresentação (proto) sozinha, sobrescrevendo o /design/ que a gente
    // manda. Formatação de código (crase) evita esse auto-unfurl, mantendo
    // a URL exata — sem preview visual, mas com o link certo.
    await addClickUpComment(created.id, `\`${figmaDesignLink(fileKey, node.id)}\``, token);
    log.push(`criado: '${node.name}' (task ${created.id})`);
    resultMap.set(node.id, created.id);
    await sleep(300);
  }
  return resultMap;
}

function nameDedupTag(clientName, demandaName) {
  return `demanda-${slugify(clientName)}-${slugify(demandaName)}`;
}

function slugify(str) {
  return str
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Link de design (editor), não de prototype/apresentação — pula e dá zoom
// direto em qualquer node-id, sem precisar de Flow starting point nem
// depender de conexões entre telas. Uso interno (devs), não client-facing.
function figmaDesignLink(fileKey, nodeId) {
  return `https://www.figma.com/design/${fileKey}?node-id=${nodeId.replace(':', '-')}`;
}

function nodeIdToTag(nodeId) {
  return `figma-${nodeId.replace(':', '-')}`;
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

async function createClickUpTask(parentTaskId, name, tags, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, tags, parent: parentTaskId }),
  });
  if (!res.ok) throw new Error(`ClickUp API error (create): ${res.status} ${await res.text()}`);
  return res.json();
}

// Busca uma task pela tag na lista inteira (não só nos filhos de uma task
// específica) — como as tags que a gente usa são únicas por node-id/nome,
// encontrar por tag já garante que é a task certa, não importa embaixo de
// qual item ela esteja.
async function findClickUpTaskByTag(tag, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?tags[]=${encodeURIComponent(tag)}&include_closed=true`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`ClickUp API error (tag search): ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.tasks && data.tasks[0] ? data.tasks[0] : null;
}

async function addClickUpComment(taskId, commentText, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment_text: commentText }),
  });
  if (!res.ok) throw new Error(`ClickUp API error (comment): ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteClickUpTasks(taskIds, token) {
  const log = [];
  for (const id of taskIds) {
    const res = await fetch(`https://api.clickup.com/api/v2/task/${id}`, {
      method: 'DELETE',
      headers: { Authorization: token },
    });
    log.push(res.ok ? `apagado: ${id}` : `FALHOU: ${id} (${res.status})`);
    await sleep(300);
  }
  return log;
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
