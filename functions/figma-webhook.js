// Cloudflare Pages Function — POST /figma-webhook
// Disparada pelo webhook FILE_UPDATE do Figma (ou manualmente, com o mesmo
// passcode, pra teste). Pra cada cliente cadastrado em FIGMA_CLIENTS, a
// página "Prototype" do arquivo tem frames de topo que viram itens (nível 2,
// sob a stage "Desenvolvimento" do cliente), e os filhos diretos de cada um
// viram demandas (nível 4, ocultas do cliente). Se o frame estiver dentro de
// uma Section do Figma (ex: "Componentes", "Páginas Adicionais"), a Section
// vira uma task com o nome do agrupamento e o frame fica aninhado um nível
// abaixo dela (a demanda cai mais um nível). Regra fixa: a Section
// "Responsividade" (onde entra a versão mobile) é sempre ignorada por
// inteiro. Identificação é sempre por node-id do Figma (guardado numa tag na
// task do ClickUp, tipo "figma-298-1175", buscada direto por tag na lista —
// nem descrição nem tag vêm completas no endpoint de listagem de subtasks),
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
  if (payload.find_by_tag) {
    const url = `https://api.clickup.com/api/v2/list/${LIST_ID}/task?tags[]=${encodeURIComponent(payload.find_by_tag)}&include_closed=true&subtasks=true`;
    const res = await fetch(url, { headers: { Authorization: env.CLICKUP_API_TOKEN } });
    const data = await res.json();
    return new Response(JSON.stringify({ url, status: res.status, count: data.tasks ? data.tasks.length : null, raw: data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (payload.list_comments) {
    const res = await fetch(`https://api.clickup.com/api/v2/task/${payload.list_comments}/comment`, {
      headers: { Authorization: env.CLICKUP_API_TOKEN },
    });
    const data = await res.json();
    const summary = (data.comments || []).map(c => ({ id: c.id, comment_text: c.comment_text, comment: c.comment }));
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (payload.delete_comment) {
    const res = await fetch(`https://api.clickup.com/api/v2/comment/${payload.delete_comment}`, {
      method: 'DELETE',
      headers: { Authorization: env.CLICKUP_API_TOKEN },
    });
    return new Response(`status ${res.status}`, { status: 200 });
  }
  if (payload.post_comment_task_id) {
    const created = await addClickUpComment(payload.post_comment_task_id, 'Ver no Figma', payload.post_comment_url, env.CLICKUP_API_TOKEN);
    return new Response(JSON.stringify(created), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (payload.inspect_node) {
    const client = FIGMA_CLIENTS.find(c => c.fileKey === payload.file_key || c.name === payload.client);
    if (!client) return new Response('client not found', { status: 400 });
    const fileData = await fetchFigmaFile(client.fileKey, env.FIGMA_API_TOKEN);
    const found = findNodeById(fileData.document, payload.inspect_node);
    if (!found) return new Response('node not found', { status: 404 });
    const summary = {
      id: found.id,
      name: found.name,
      type: found.type,
      children: (found.children || []).map(c => ({ id: c.id, name: c.name, type: c.type })),
    };
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

// Cada "unidade" é um frame de topo (dentro ou fora de uma Section do
// Figma), junto com o grupo (Section) a que pertence, se houver.
async function getSyncUnits(client, figmaToken) {
  const fileData = await fetchFigmaFile(client.fileKey, figmaToken);
  const prototypePage = (fileData.document.children || []).find(
    c => c.type === 'CANVAS' && c.name === 'Prototype',
  );
  if (!prototypePage) throw new Error('Pagina "Prototype" nao encontrada no arquivo');

  const units = [];
  for (const node of childrenInPanelOrder(prototypePage)) {
    if (!isVisible(node)) continue;
    if (node.type === 'SECTION') {
      // Regra fixa: a section "Responsividade" (onde entra a versão mobile)
      // é sempre ignorada por inteiro.
      if (node.name.trim().toLowerCase() === 'responsividade') continue;
      for (const child of childrenInPanelOrder(node)) {
        if (!isVisible(child)) continue;
        units.push({ frame: resolveEffectiveNode(child), group: { id: node.id, name: node.name } });
      }
    } else {
      units.push({ frame: resolveEffectiveNode(node), group: null });
    }
  }
  return mergeDesktopMobileUnits(units);
}

// Frame/seção com o "olho fechado" no Figma (visible: false) não vira task —
// nem como item nem como demanda. Não precisa apagar do arquivo, só deixar
// oculto já basta.
function isVisible(node) {
  return node.visible !== false;
}

// A API do Figma devolve `children` na ordem inversa do painel de camadas
// (o que aparece no TOPO do painel é o ÚLTIMO do array). Inverte pra criar
// as tasks na mesma ordem de leitura do painel, de cima pra baixo.
function childrenInPanelOrder(node) {
  return [...(node.children || [])].reverse();
}

// Frames "X Desktop" e "X Mobile" viram um item só, "X" — pro cliente não
// importa a plataforma, e o conteúdo do Mobile sempre acompanha o Desktop.
// Usa sempre o Desktop como fonte de nome/demandas (cai pro Mobile se só
// ele existir). Frames sem esse sufixo ficam exatamente como estão, cada
// um seu próprio item — mesmo que o nome se repita entre dois frames com
// ids diferentes. Só mescla dentro do mesmo grupo (Section).
function mergeDesktopMobileUnits(units) {
  const buckets = new Map();
  for (const u of units) {
    const key = u.group ? u.group.id : '__none__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(u);
  }
  const result = [];
  for (const list of buckets.values()) {
    const merged = mergeDesktopMobile(list.map(u => u.frame));
    const group = list[0].group;
    for (const frame of merged) result.push({ frame, group });
  }
  return result;
}

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
  const units = await getSyncUnits(client, figmaToken);
  return units.map(u => ({
    id: u.frame.id,
    name: u.frame.name,
    group: u.group ? u.group.name : null,
    demandas: (u.frame.children || []).filter(isVisible).length,
  }));
}

// Sections do Figma (ex: "Componentes", "Páginas Adicionais") viram elas
// mesmas uma task com o nome do agrupamento, e os frames que estão dentro
// ficam aninhados dentro dela (um nível a mais), com as demandas de cada
// frame um nível abaixo disso. Frames fora de qualquer section continuam
// direto sob "Desenvolvimento", como sempre.
async function syncOneItem(client, itemNodeId, env) {
  const log = [];
  const units = await getSyncUnits(client, env.FIGMA_API_TOKEN);
  const unit = units.find(u => u.frame.id === itemNodeId);
  if (!unit) throw new Error(`Frame com node-id ${itemNodeId} nao encontrado na pagina Prototype`);

  const devTaskId = await findDevelopmentTaskId(client.taskId, env.CLICKUP_API_TOKEN);

  let parentForFrame = devTaskId;
  if (unit.group) {
    const groupMap = await syncFigmaLevel([unit.group], devTaskId, env.CLICKUP_API_TOKEN, client.fileKey, log, null);
    parentForFrame = groupMap.get(unit.group.id);
  }

  const itemMap = await syncFigmaLevel([unit.frame], parentForFrame, env.CLICKUP_API_TOKEN, client.fileKey, log, null);
  const itemTaskId = itemMap.get(unit.frame.id);

  const demandaNodes = childrenInPanelOrder(unit.frame).filter(isVisible);
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
// `clientNameForDedup` é opcional (só faz sentido abaixo do nível de item):
// quando presente, cada demanda nova também recebe uma tag por nome
// (`demanda-{cliente}-{nome}`) e, se essa tag já existir em qualquer outro
// nó, a criação é pulada — evita repetir "Footer" etc. em todo item.
//
// Recursiva: se os filhos de um nó forem TODOS do tipo Frame (ex: um frame
// "Formulário do Produto" contendo só os frames "Form" e "Imagem"), eles
// viram sub-tasks aninhadas dele, e assim por diante — profundidade
// dinâmica, sem limite fixo. Filhos de tipo misto (texto, ícone, instância
// etc — conteúdo normal dentro de uma demanda tipo Footer) não geram
// recursão, ficam só o conteúdo interno da task de qualquer forma.
async function syncFigmaLevel(figmaNodes, parentTaskId, token, fileKey, log, clientNameForDedup) {
  const resultMap = new Map();
  for (const node of figmaNodes) {
    try {
      let taskId;
      const existingTask = await findClickUpTaskByTag(nodeIdToTag(node.id), token);
      if (existingTask) {
        if (existingTask.name !== node.name) {
          await renameClickUpTask(existingTask.id, node.name, token);
          log.push(`renomeado: '${existingTask.name}' -> '${node.name}'`);
          await sleep(300);
        }
        taskId = existingTask.id;
        resultMap.set(node.id, taskId);
      } else {
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
        // manda. Comentário rico (texto "Ver no Figma" com link anexado) —
        // confirmado que fica hyperlink de verdade na aba de comentários,
        // diferente da URL em crase (que fica estática, sem link).
        await addClickUpComment(created.id, 'Ver no Figma', figmaDesignLink(fileKey, node.id), token);
        log.push(`criado: '${node.name}' (task ${created.id})`);
        taskId = created.id;
        resultMap.set(node.id, taskId);
        await sleep(300);
      }

      const childNodes = childrenInPanelOrder(node).filter(isVisible);
      const isFrameGroup = childNodes.length > 0 && childNodes.every(c => c.type === 'FRAME');
      if (isFrameGroup) {
        await syncFigmaLevel(childNodes, taskId, token, fileKey, log, clientNameForDedup);
      }
    } catch (err) {
      // Um nó com problema (ex: nome que gera tag inválida) não deve
      // derrubar o resto do item — loga e segue pros outros.
      log.push(`FALHOU: '${node.name}' (${node.id}) - ${err.message}`);
    }
  }
  return resultMap;
}

function nameDedupTag(clientName, demandaName) {
  // Camadas de texto no Figma às vezes ficam com o nome igual ao conteúdo
  // (parágrafos inteiros) quando ninguém renomeia a layer — trunca antes de
  // virar tag, senão o ClickUp rejeita como inválida.
  return `demanda-${slugify(clientName)}-${slugify(demandaName).slice(0, 50)}`;
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

function findNodeById(node, id) {
  if (node.id === id) return node;
  for (const child of (node.children || [])) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
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
  const res = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?tags[]=${encodeURIComponent(tag)}&include_closed=true&subtasks=true`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`ClickUp API error (tag search): ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.tasks && data.tasks[0] ? data.tasks[0] : null;
}

// Comentário rico (texto com link anexado) — confirmado pelo usuário que
// fica como hyperlink de verdade na aba de comentários do ClickUp,
// diferente de uma URL em crase (que fica estática).
async function addClickUpComment(taskId, text, url, token) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: [{ text, attributes: { link: url } }] }),
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
