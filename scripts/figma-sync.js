#!/usr/bin/env node
// Sincroniza Frames do Figma -> tasks de desenvolvimento no ClickUp.
// Roda direto no GitHub Actions (ver .github/workflows/figma-sync-schedule.yml),
// sem depender do Cloudflare — essa parte só mexe no ClickUp, não no site do
// cliente, então não tem motivo pra morar na mesma infra da sync que atualiza
// o cronograma (essa sim precisa do Cloudflare, pra commitar/publicar o HTML).
// Sem limite de subrequests aqui (runner do GitHub Actions, não Worker), então
// sincroniza tudo numa execução só, sem chunking artificial.
//
// Pra cada cliente cadastrado em FIGMA_CLIENTS, lê a página "Prototype" do
// arquivo do Figma e cria/atualiza no ClickUp: um item (nível 2, sob a stage
// "Desenvolvimento" do cliente) por frame de topo, e uma demanda (nível 4,
// oculta do cliente) por seção dentro desse frame. Se o frame estiver dentro
// de uma Section do Figma (ex: "Componentes", "Páginas Adicionais"), a
// Section vira uma task com o nome do agrupamento e o frame fica aninhado um
// nível abaixo dela. Regra fixa: a Section "Responsividade" (onde entra a
// versão mobile) é sempre ignorada por inteiro. "Componentes" é outra
// exceção: os frames lá dentro não têm o conteúdo interno sincronizado como
// demanda — são componentes reutilizáveis pequenos, não páginas.
//
// Profundidade sempre fixa (item -> demanda, ou Section -> item -> demanda):
// não desce mais fundo que isso em nenhum caso, mesmo que o Figma permita.
// Identificação é sempre por node-id do Figma (guardado numa tag na task do
// ClickUp), nunca por nome — nome pode mudar à vontade que a automação
// continua reconhecendo a mesma task. Ver docs/FIGMA_SYNC_SETUP.md.

const FIGMA_CLIENTS = [
  { name: 'PROTS', fileKey: '8pk8WhFEFBO42cKnXtHai5', taskId: 'wdpu2ybucf' },
];

const LIST_ID = '901324765433'; // lista "Projetos" no ClickUp

const FIGMA_API_TOKEN = process.env.FIGMA_API_TOKEN;
const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;

async function main() {
  if (!FIGMA_API_TOKEN || !CLICKUP_API_TOKEN) {
    console.error('Faltam FIGMA_API_TOKEN e/ou CLICKUP_API_TOKEN nas variáveis de ambiente.');
    process.exit(1);
  }

  let anyFailed = false;
  for (const client of FIGMA_CLIENTS) {
    console.log(`\n=== ${client.name} ===`);
    try {
      const failed = await syncClient(client);
      if (failed) anyFailed = true;
    } catch (err) {
      console.error(`${client.name}: FAILED - ${err.message}`);
      anyFailed = true;
    }
  }

  if (anyFailed) {
    console.error('\nUm ou mais itens falharam.');
    process.exit(1);
  }
}

async function syncClient(client) {
  const units = await getSyncUnits(client);
  const devTaskId = await findDevelopmentTaskId(client.taskId);

  let anyFailed = false;
  for (const unit of units) {
    const log = [];
    try {
      let parentForFrame = devTaskId;
      if (unit.group) {
        parentForFrame = await findOrCreateTask(unit.group, devTaskId, client.fileKey, log);
      }
      const itemTaskId = await findOrCreateTask(unit.frame, parentForFrame, client.fileKey, log);

      const isComponentesGroup = unit.group && unit.group.name.trim().toLowerCase() === 'componentes';
      if (!isComponentesGroup) {
        const demandaNodes = childrenInPanelOrder(unit.frame).filter(isVisible);
        if (demandaNodes.length > 0) {
          const failed = await syncChildrenOneLevel(demandaNodes, itemTaskId, client.fileKey, log, client.name);
          if (failed) anyFailed = true;
        }
      }
    } catch (err) {
      log.push(`FALHOU: '${unit.frame.name}' (${unit.frame.id}) - ${err.message}`);
      anyFailed = true;
    }
    console.log(`${unit.frame.name}: ${log.length === 0 ? 'no changes' : log.join('; ')}`);
  }
  return anyFailed;
}

// --- sincronização ---

// Cada "unidade" é um frame de topo (dentro ou fora de uma Section do
// Figma), junto com o grupo (Section) a que pertence, se houver.
async function getSyncUnits(client) {
  const fileData = await fetchFigmaFile(client.fileKey);
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

// Se um frame de topo só embrulha um único filho (ex: um frame sem nome
// útil contendo só a página de verdade dentro), usa o filho como o nó
// efetivo em vez do embrulho — evita depender de organização manual no
// Figma. Link de design funciona em cima de qualquer node-id diretamente,
// então não precisa rastrear o id do frame de fora separado.
function resolveEffectiveNode(node) {
  let current = node;
  while (current.children && current.children.length === 1) {
    current = current.children[0];
  }
  return current;
}

async function findDevelopmentTaskId(clientTaskId) {
  const stages = await fetchClickUpSubtasks(clientTaskId);
  const dev = stages.find(t => /desenvolv/i.test(t.name));
  if (!dev) throw new Error('Stage "Desenvolvimento" nao encontrada na task-mae');
  return dev.id;
}

// Acha (por tag) ou cria uma task pra um único nó do Figma, sem checar
// filhos nem dedupe por nome — usado pros dois primeiros níveis fixos
// (group/Section e item) que não competem por nome com nada.
async function findOrCreateTask(node, parentTaskId, fileKey, log) {
  const existingTask = await findClickUpTaskByTag(nodeIdToTag(node.id));
  if (existingTask) {
    if (existingTask.name !== node.name) {
      await renameClickUpTask(existingTask.id, node.name);
      log.push(`renomeado: '${existingTask.name}' -> '${node.name}'`);
      await sleep(300);
    }
    return existingTask.id;
  }
  const created = await createClickUpTask(parentTaskId, node.name, [nodeIdToTag(node.id)]);
  await addClickUpComment(created.id, 'Ver no Figma', figmaDesignLink(fileKey, node.id));
  log.push(`criado: '${node.name}' (task ${created.id})`);
  await sleep(300);
  return created.id;
}

// Cria/renomeia as demandas (filhos diretos de um item) a partir dos nós do
// Figma — não desce mais fundo que isso, sem exceção. `include_subtasks=true`
// não devolve tags nem descrição completas (só campos "core" tipo
// nome/status), então em vez de listar os filhos existentes e cruzar
// localmente, busca cada node-id direto por tag na lista inteira
// (`?tags[]=...`) — funciona não importa embaixo de qual task ela esteja
// hoje. `clientNameForDedup`: cada demanda nova também recebe uma tag por
// nome (`demanda-{cliente}-{nome}`) e, se essa tag já existir em qualquer
// outro item, a criação é pulada — evita repetir "Footer" etc. em todo item.
async function syncChildrenOneLevel(figmaNodes, parentTaskId, fileKey, log, clientNameForDedup) {
  let anyFailed = false;
  for (const node of figmaNodes) {
    try {
      const existingTask = await findClickUpTaskByTag(nodeIdToTag(node.id));
      if (existingTask) {
        if (existingTask.name !== node.name) {
          await renameClickUpTask(existingTask.id, node.name);
          log.push(`renomeado: '${existingTask.name}' -> '${node.name}'`);
          await sleep(300);
        }
        continue;
      }

      const nameTag = clientNameForDedup ? nameDedupTag(clientNameForDedup, node.name) : null;
      if (nameTag) {
        const dupTask = await findClickUpTaskByTag(nameTag);
        if (dupTask) {
          log.push(`pulado (repetido em outro item): '${node.name}'`);
          continue;
        }
      }

      const tags = nameTag ? [nodeIdToTag(node.id), nameTag] : [nodeIdToTag(node.id)];
      const created = await createClickUpTask(parentTaskId, node.name, tags);
      // Link só na criação — repetir a cada sync duplicaria o comentário.
      // Vai em comentário (não descrição) porque a integração nativa do
      // ClickUp com o Figma reconhece link solto e converte pra formato de
      // apresentação (proto) sozinha, sobrescrevendo o /design/ que a gente
      // manda. Comentário rico (texto "Ver no Figma" com link anexado) fica
      // hyperlink de verdade na aba de comentários, diferente de uma URL
      // solta (que fica estática, sem link).
      await addClickUpComment(created.id, 'Ver no Figma', figmaDesignLink(fileKey, node.id));
      log.push(`criado: '${node.name}' (task ${created.id})`);
      await sleep(300);
    } catch (err) {
      // Um nó com problema (ex: nome que gera tag inválida) não deve
      // derrubar o resto do item — loga e segue pros outros.
      log.push(`FALHOU: '${node.name}' (${node.id}) - ${err.message}`);
      anyFailed = true;
    }
  }
  return anyFailed;
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

// --- Figma ---

async function fetchFigmaFile(fileKey) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
    headers: { 'X-Figma-Token': FIGMA_API_TOKEN },
  });
  if (!res.ok) throw new Error(`Figma API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// --- ClickUp ---

async function fetchClickUpSubtasks(taskId) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}?include_subtasks=true`, {
    headers: { Authorization: CLICKUP_API_TOKEN },
  });
  if (!res.ok) throw new Error(`ClickUp API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.subtasks || [];
}

async function createClickUpTask(parentTaskId, name, tags) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task`, {
    method: 'POST',
    headers: { Authorization: CLICKUP_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, tags, parent: parentTaskId }),
  });
  if (!res.ok) throw new Error(`ClickUp API error (create): ${res.status} ${await res.text()}`);
  return res.json();
}

// Busca uma task pela tag na lista inteira (não só nos filhos de uma task
// específica) — como as tags que a gente usa são únicas por node-id/nome,
// encontrar por tag já garante que é a task certa, não importa embaixo de
// qual item ela esteja.
async function findClickUpTaskByTag(tag) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?tags[]=${encodeURIComponent(tag)}&include_closed=true&subtasks=true`, {
    headers: { Authorization: CLICKUP_API_TOKEN },
  });
  if (!res.ok) throw new Error(`ClickUp API error (tag search): ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.tasks && data.tasks[0] ? data.tasks[0] : null;
}

// Comentário rico (texto com link anexado) — fica como hyperlink de verdade
// na aba de comentários do ClickUp, diferente de uma URL em texto solto
// (que fica estática, sem link).
async function addClickUpComment(taskId, text, url) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: 'POST',
    headers: { Authorization: CLICKUP_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: [{ text, attributes: { link: url } }] }),
  });
  if (!res.ok) throw new Error(`ClickUp API error (comment): ${res.status} ${await res.text()}`);
  return res.json();
}

async function renameClickUpTask(taskId, name) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    method: 'PUT',
    headers: { Authorization: CLICKUP_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`ClickUp API error (rename): ${res.status} ${await res.text()}`);
  return res.json();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
