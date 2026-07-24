# Sincronização automática ClickUp → GitHub → Cloudflare Pages (clientes recorrentes)

Function em [functions/clickup-webhook.js](../functions/clickup-webhook.js). Um único webhook do
ClickUp (escopado pela lista **Demandas**) dispara essa function, que percorre a lista `CLIENTS`
no topo do arquivo — para cada cliente, busca todas as subtasks da task-mãe dele e reescreve o
array `months` no HTML correspondente, commitando direto na branch `main`. O Cloudflare Pages já
publica sozinho a partir desse commit.

## Adicionar um cliente recorrente novo

1. Crie a task-mãe do cliente na lista **Demandas** no ClickUp (mesmo nível de "Humara"), com as
   demandas como subtasks dela.
2. Copie uma pasta de cliente existente (ex: `humara/`) pra uma pasta nova com o slug do cliente
   (ex: `uplift-fitness/`), ajustando `<title>`, o `<h1>` e zerando o array `months` pra um mês
   vazio (`demands: []`) — a primeira sincronização preenche o resto.
3. Adicione uma entrada em `CLIENTS` no topo de `functions/clickup-webhook.js` com o `taskId` da
   task-mãe (pega no final da URL da task no ClickUp) e o `filePath` do HTML novo.
4. Commit e push. **Não precisa criar webhook novo** — o único webhook já escutando a lista
   Demandas cobre todos os clientes cadastrados em `CLIENTS`.

## 1. Variáveis de ambiente (Cloudflare Pages)

Dashboard do projeto → **Settings → Environment variables** → adicionar em **Production**
(e em Preview, se quiser testar por branch):

| Nome | Valor |
|---|---|
| `CLICKUP_API_TOKEN` | Personal API Token do ClickUp (Settings → Apps → API Token) |
| `GITHUB_TOKEN` | Fine-grained PAT com permissão **Contents: Read and write** apenas no repo `portal-clientes` |
| `CLICKUP_WEBHOOK_SECRET` | Preenche depois do passo 2 (é retornado na criação do webhook) |

Depois de salvar, redeploy o projeto (ou faça um commit qualquer) para o Pages pegar a pasta
`functions/` e as variáveis novas.

## 2. Criar o webhook no ClickUp

Rode isto no seu terminal, com o seu próprio Personal API Token (não peça pra mim rodar — é uma
credencial sua):

```bash
curl -X POST "https://api.clickup.com/api/v2/team/9013388773/webhook" \
  -H "Authorization: SEU_CLICKUP_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "https://SEU-DOMINIO-CLOUDFLARE-PAGES/clickup-webhook",
    "events": ["taskCreated", "taskUpdated", "taskStatusUpdated", "taskDeleted"],
    "list_id": 901321909248
  }'
```

A resposta traz `{"id": "...", "webhook": {"secret": "..."}}` — copie o `secret` para a variável
`CLICKUP_WEBHOOK_SECRET` do passo 1.

- `9013388773` é o `team_id` (workspace).
- `901321909248` é o `list_id` da lista **Demandas**, já escopando o webhook só pra ela.

## 3. Testar

1. Mude o status de qualquer subtask de qualquer task-mãe cadastrada em `CLIENTS`.
2. Confira em alguns segundos se apareceu um novo commit em `main` no GitHub tocando o
   `index.html` daquele cliente (a function resincroniza **todos** os clientes cadastrados a cada
   evento, então pode aparecer mais de um commit se mais de um mudou).
3. Confira o deploy do Cloudflare Pages e o site publicado.

Se algo falhar, os logs da function aparecem em **Cloudflare Pages → seu projeto → Functions →
Real-time Logs** (ou `wrangler pages deployment tail` se preferir CLI). Depois de alterar uma env
var/secret, o Cloudflare avisa que a mudança só vale a partir do **próximo deploy** — então
confirme que rodou um deploy novo depois de salvar antes de testar de novo.

## Notas

- A cada evento, a function ignora o payload específico do webhook e busca de novo **todas** as
  subtasks de **todos** os clientes cadastrados em `CLIENTS` — evita dessincronização se vários
  eventos chegarem em sequência, e cada cliente só gera commit se o conteúdo dele realmente mudou.
- Status `fechado` no ClickUp é omitido do relatório (arquivado do mês).
- Mês é definido pela due date da subtask; sem due date, cai no mês de criação.
- Se uma subtask não tiver responsável atribuído no ClickUp, o campo "owner" fica vazio no
  relatório — a function não inventa dados, só reflete o que está no ClickUp.
- Coluna "Horas" vem do campo **Estimativa de tempo** (`time_estimate`) da subtask no ClickUp,
  convertido de milissegundos pra horas. Na prática é usado como "horas utilizadas" (preenchido
  depois que a tarefa já está em andamento, não como estimativa prévia). Subtask sem esse campo
  preenchido mostra "-". O resumo do mês só exibe "horas utilizadas" quando pelo menos uma demanda
  do mês tem esse campo preenchido.
