# Sincronização automática Figma → ClickUp (tasks de desenvolvimento)

Script em [scripts/figma-sync.js](../scripts/figma-sync.js), rodado direto pelo runner do
GitHub Actions ([.github/workflows/figma-sync-schedule.yml](../.github/workflows/figma-sync-schedule.yml)),
uma vez por dia à meia-noite (América/São Paulo, UTC-3) — funciona como uma auditoria
diária, não precisa ser tão frequente quanto a sync do cronograma, já que o Figma
normalmente só muda quando alguém termina uma sessão de design. Pra ver o resultado na
hora (sem esperar a meia-noite), dispara manualmente em Actions → "Figma to ClickUp sync"
→ Run workflow.

Essa sync só lê o Figma e cria/atualiza tasks no ClickUp — não mexe no site do cliente —
por isso não depende do Cloudflare (diferente da sync que atualiza o cronograma, essa sim
precisa do Cloudflare pra commitar/publicar o HTML, ver
[CLICKUP_SYNC_SETUP.md](./CLICKUP_SYNC_SETUP.md)). Rodando no runner do GitHub Actions, sem
limite de subrequests, o script sincroniza tudo numa execução só, sem chunking artificial.

A cada execução, o script descobre sozinho quais clientes sincronizar: procura na lista
"Projetos" (mesma usada pela sync do cronograma) as task-mãe com status **CLIENTES** que
tiverem um link do Figma em algum **comentário** (não na descrição — não aparece no
cronograma, e é a raiz do projeto). Cliente sem link no comentário é ignorado, sem erro. Pra
cada um encontrado, lê a página **"Prototype"** do arquivo do Figma e cria/atualiza no
ClickUp: um **item** (nível 2, sob a stage "Desenvolvimento" do cliente) por frame de topo, e
uma **demanda** (nível 4, oculta do cliente) por seção dentro desse frame. Essas tasks nunca
aparecem no cronograma que o cliente vê — são só pra organizar o trabalho dos devs.

## Estrutura esperada no arquivo do Figma

- **Página**: sempre uma página chamada exatamente **"Prototype"** — é a única que a sync lê.
- **Frames de topo** dessa página = os itens (páginas do site: Home, PDP, About...). Cada
  seção dentro de um frame (filho direto dele) = uma demanda. Só nó do tipo **Frame** vira
  item — elemento solto tipo linha/vetor decorativo (usado às vezes só pra separar seções
  visualmente no Figma), direto na página ou dentro de uma Section, é ignorado.
- **Sections do Figma** (o agrupamento visual, não confundir com Frame) viram elas mesmas
  uma task com o nome do agrupamento, e os frames que estão dentro ficam aninhados um nível
  abaixo dela. Hoje tem três Sections com tratamento especial:
  - **"Responsividade"** e **"Mobile"**: regra fixa, essas duas Sections (nome exato, sem
    diferenciar maiúsculas/minúsculas) são sempre ignoradas por inteiro — é onde entra a
    versão mobile das páginas, o conteúdo delas nunca vira task.
  - **"Componentes"**: os frames dentro (Cart, Menu, etc.) viram itens soltos, mas **sem**
    sincronizar o conteúdo interno como demanda — são componentes reutilizáveis pequenos,
    não páginas, não faz sentido quebrar em pedaços.
  - **"LPs Produtos"**: os frames de produto dentro dessa Section são quase idênticos entre
    si (mesma PDP, só muda o conteúdo por produto) — em vez de virar um item por produto, só
    o frame chamado exatamente **"PDP Desktop"** é sincronizado; os demais frames da Section
    são ignorados por inteiro.
  - Qualquer outra Section (ex: "Páginas Adicionais") segue o padrão normal: Section → Frame
    → Demanda, três níveis.
- **Ordem de criação dos itens**: fixa, sempre a mesma independente da ordem das camadas no
  Figma — **Home → PDP → outras páginas soltas → Componentes → Páginas Adicionais → outras
  Sections → LPs Produtos** (sempre por último). Só afeta a ordem em que os itens são
  criados/visitados a cada sync, não muda nada pra item já existente.
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

Sem mexer em código:

1. O arquivo do Figma do cliente precisa ter a página "Prototype" organizada conforme a
   seção acima.
2. A task-mãe do cliente no ClickUp precisa ter uma subtask chamada "Desenvolvimento" — é
   dentro dela que os itens entram (mesma task-mãe já usada pela sync do ClickUp) — e status
   **CLIENTES** na lista "Projetos".
3. Cole o link do arquivo do Figma (ex: `https://www.figma.com/design/{file_key}/...`) num
   **comentário** dessa mesma task-mãe. Só precisa conter a URL em algum lugar do texto — a
   automação extrai o `fileKey` sozinha.
4. Pronto — a próxima execução (diária ou disparo manual) já encontra e sincroniza esse
   cliente sozinha.

## Secrets necessários (GitHub Actions)

Cadastre em **GitHub → Settings do repositório → Secrets and variables → Actions → New
repository secret**:

| Nome | Valor |
|---|---|
| `FIGMA_API_TOKEN` | Personal Access Token do Figma (Settings → Security → Personal access tokens), com escopo **File content: Read** |
| `CLICKUP_API_TOKEN` | Personal API Token do ClickUp (Settings → Apps → API Token) — pode ser o mesmo já usado na sync do cronograma |

Não precisa de nenhum secret duplicado no Cloudflare pra essa parte — os dois tokens ficam
só aqui, e o script roda inteiramente dentro do GitHub Actions.

## Testar

- Manualmente, sem esperar o horário: GitHub → aba **Actions** → workflow **"Figma to
  ClickUp sync"** → **Run workflow**.
- Confira o log da execução — mostra, pra cada cliente, um resultado por item (`no changes`,
  `criado: ...`, `renomeado: ...` ou `pulado (repetido em outro item): ...`).
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
- Não tem mais nenhum endpoint administrativo de debug/limpeza pra essa sync (a versão
  antiga, hospedada no Cloudflare, tinha). Uma limpeza pontual pode ser feita com um script
  ad-hoc chamando a API do ClickUp diretamente com o mesmo `CLICKUP_API_TOKEN`.
