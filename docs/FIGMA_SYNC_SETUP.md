# Sincronização automática Figma → ClickUp (tasks de desenvolvimento)

Function em [functions/figma-webhook.js](../functions/figma-webhook.js). Pra cada cliente
cadastrado em `FIGMA_CLIENTS` no topo do arquivo, ela lê a página **"Prototype"** do arquivo
do Figma e cria/atualiza no ClickUp: um **item** (nível 2, sob a stage "Desenvolvimento" do
cliente) por frame de topo, e uma **demanda** (nível 4, oculta do cliente) por seção dentro
desse frame. Essas tasks nunca aparecem no cronograma que o cliente vê — são só pra
organizar o trabalho dos devs.

**Disparo:** igual à sync do ClickUp, um workflow agendado do GitHub Actions
([.github/workflows/figma-sync-schedule.yml](../.github/workflows/figma-sync-schedule.yml))
chama essa function de 45 em 45 minutos, só em dias úteis, das 08:30 às 18:15 (América/São
Paulo, UTC-3). Não é um webhook em tempo real do Figma — uma chamada só do Worker não
aguenta percorrer todos os itens de um cliente sem estourar o limite de subrequests do
plano free do Cloudflare (50 por invocação), então o endpoint funciona em duas etapas por
cliente: lista os itens, depois sincroniza um por um.

## Estrutura esperada no arquivo do Figma

- **Página**: sempre uma página chamada exatamente **"Prototype"** — é a única que a sync lê.
- **Frames de topo** dessa página = os itens (páginas do site: Home, PDP, About...). Cada
  seção dentro de um frame (filho direto dele) = uma demanda.
- **Sections do Figma** (o agrupamento visual, não confundir com Frame) viram elas mesmas
  uma task com o nome do agrupamento, e os frames que estão dentro ficam aninhados um nível
  abaixo dela. Hoje tem duas Sections com tratamento especial:
  - **"Responsividade"**: regra fixa, sempre ignorada por inteiro (é onde entra a versão
    mobile das páginas — o conteúdo dela nunca vira task).
  - **"Componentes"**: os frames dentro (Cart, Menu, etc.) viram itens soltos, mas **sem**
    sincronizar o conteúdo interno como demanda — são componentes reutilizáveis pequenos,
    não páginas, não faz sentido quebrar em pedaços.
  - Qualquer outra Section (ex: "Páginas Adicionais") segue o padrão normal: Section → Frame
    → Demanda, três níveis.
- **"X Desktop" e "X Mobile"**: se dois frames de topo tiverem o mesmo nome base com esse
  sufixo, viram um item só ("X"), usando sempre o Desktop como fonte do conteúdo (cai pro
  Mobile se só ele existir). Frames sem esse sufixo ficam cada um com seu próprio item.
- **Profundidade fixa**: a sync nunca desce mais que 1 nível abaixo de um item (ou 2, se
  ele estiver dentro de uma Section). Se uma demanda tiver frames dentro dela no Figma (ex:
  um formulário com peças separadas), essas peças **não** viram sub-tasks — não dá pra
  distinguir de forma confiável "isso é um agrupamento de verdade" de "isso é só o conteúdo
  interno normal da demanda" só pela estrutura. Se precisar desse nível de detalhe pra um
  caso específico, marque como Section no Figma (mesmo mecanismo do "Componentes"/"Páginas
  Adicionais") — é um sinal intencional, não uma adivinhação da automação.
- **Frame/seção oculto** (o "olho fechado" no Figma) nunca vira task — não precisa apagar
  do arquivo, só deixar oculto já basta.
- **Identificação por node-id**: a automação guarda o id do node do Figma numa tag na task
  do ClickUp (`figma-298-1175`) e busca por ela a cada sync — nunca por nome. Renomear um
  frame no Figma só renomeia a task correspondente, não quebra nem duplica nada.

## Adicionar um cliente novo

1. O arquivo do Figma do cliente precisa ter a página "Prototype" organizada conforme a
   seção acima.
2. A task-mãe do cliente no ClickUp precisa ter uma subtask chamada "Desenvolvimento" — é
   dentro dela que os itens entram (mesma task-mãe já usada pela sync do ClickUp, ver
   [CLICKUP_SYNC_SETUP.md](./CLICKUP_SYNC_SETUP.md)).
3. Adicione uma entrada em `FIGMA_CLIENTS` no topo de `functions/figma-webhook.js`, com o
   `fileKey` do arquivo do Figma (pega na URL: `figma.com/design/{file_key}/...`) e o
   `taskId` da task-mãe do cliente no ClickUp.
4. Adicione o mesmo `name` (igual ao que você usou no passo 3) no array `CLIENTS` dentro de
   `.github/workflows/figma-sync-schedule.yml` — lista separada da do ClickUp, mesma lógica
   de "uma chamada por vez" pra não estourar limite de subrequests.
5. Commit e push.

## Variáveis de ambiente (Cloudflare Pages)

Mesmo lugar de sempre (Dashboard do projeto → **Settings → Environment variables** →
**Production**):

| Nome | Valor |
|---|---|
| `FIGMA_API_TOKEN` | Personal Access Token do Figma (Settings → Security → Personal access tokens), com escopo **File content: Read** |
| `FIGMA_WEBHOOK_PASSCODE` | String aleatória forte — precisa bater com o secret do GitHub Actions abaixo |

`CLICKUP_API_TOKEN` já existe do projeto do ClickUp e é reaproveitado aqui (a function
também cria/renomeia tasks, não só lê).

## Secret no GitHub Actions

Cadastre em **GitHub → Settings do repositório → Secrets and variables → Actions → New
repository secret**:

| Nome | Valor |
|---|---|
| `FIGMA_WEBHOOK_PASSCODE` | O mesmo valor exato colocado no Cloudflare acima |

## Testar

- Manualmente, sem esperar o horário: GitHub → aba **Actions** → workflow **"Figma to
  ClickUp sync"** → **Run workflow**.
- Confira o log da execução — deve mostrar a lista de itens de cada cliente e, pra cada um,
  `HTTP 200` com o resultado (`no changes`, `criado: ...`, `renomeado: ...` ou
  `pulado (repetido em outro item): ...`).
- Confira no ClickUp se as tasks apareceram sob "Desenvolvimento" do cliente certo.

## Notas

- Cada task criada ganha um comentário com o link direto pro frame/seção no Figma (modo
  design, não apresentação — pula e dá zoom no node certo sem precisar de nenhuma
  configuração de Flow no Figma). O link vai como comentário rico (texto "Ver no Figma" com
  link anexado), não como URL solta — assim fica clicável de verdade sem a integração
  nativa do ClickUp com o Figma converter pra formato de apresentação sozinha.
- Uma demanda com o mesmo nome em mais de um item (ex: "Footer" repetido em toda página) só
  vira task na primeira vez — nos itens seguintes, a criação é pulada.
- Se um frame/section for removido do Figma, a task correspondente **não** é apagada
  automaticamente — fica órfã no ClickUp até alguém decidir o que fazer com ela.
