# Sincronização automática ClickUp → GitHub → Cloudflare Pages (clientes recorrentes)

Function em [functions/clickup-webhook.js](../functions/clickup-webhook.js). Ela percorre a lista
`CLIENTS` no topo do arquivo — para cada cliente, busca todas as subtasks da task-mãe dele e
reescreve o array `months` no HTML correspondente, commitando direto na branch `main`. O
Cloudflare Pages já publica sozinho a partir desse commit.

**Disparo:** não é mais um webhook em tempo real do ClickUp. Um workflow agendado do GitHub
Actions ([.github/workflows/clickup-sync-schedule.yml](../.github/workflows/clickup-sync-schedule.yml))
chama essa function de 45 em 45 minutos, só em dias úteis, das 08:30 às 18:15 (América/São_Paulo,
UTC-3). Fora desses horários/dias, nada roda — mudanças no ClickUp só aparecem no relatório na
próxima janela agendada, não instantaneamente.

## Adicionar um cliente recorrente novo

1. Crie a task-mãe do cliente na lista **Demandas** no ClickUp (mesmo nível de "Humara"), com as
   demandas como subtasks dela.
2. Copie uma pasta de cliente existente (ex: `humara/`) pra uma pasta nova com o slug do cliente
   (ex: `uplift-fitness/`), ajustando `<title>`, o `<h1>` e zerando o array `months` pra um mês
   vazio (`demands: []`) — a primeira sincronização preenche o resto.
3. Adicione uma entrada em `CLIENTS` no topo de `functions/clickup-webhook.js` com o `taskId` da
   task-mãe (pega no final da URL da task no ClickUp) e o `filePath` do HTML novo.
4. Commit e push. **Não precisa mexer no agendamento** — o mesmo workflow já dispara a sync de
   todos os clientes cadastrados em `CLIENTS`, incluindo o novo.

## 1. Variáveis de ambiente (Cloudflare Pages)

Dashboard do projeto → **Settings → Environment variables** → adicionar em **Production**:

| Nome | Valor |
|---|---|
| `CLICKUP_API_TOKEN` | Personal API Token do ClickUp (Settings → Apps → API Token) |
| `GITHUB_TOKEN` | Fine-grained PAT com permissão **Contents: Read and write** apenas no repo `portal-clientes` |
| `CLICKUP_WEBHOOK_SECRET` | Qualquer string aleatória forte — só precisa bater com o secret do passo 2, não vem mais de um webhook do ClickUp |

Depois de salvar, redeploy o projeto pra ele pegar as variáveis novas.

## 2. Secret no GitHub Actions

O workflow assina a requisição com HMAC-SHA256 igual o ClickUp fazia, usando o mesmo valor de
`CLICKUP_WEBHOOK_SECRET` de cima. Cadastre em **GitHub → Settings do repositório → Secrets and
variables → Actions → New repository secret**:

| Nome | Valor |
|---|---|
| `CLICKUP_WEBHOOK_SECRET` | O mesmo valor exato colocado no Cloudflare no passo 1 |

Se você tinha um webhook do ClickUp criado de um setup anterior, apague-o (ele não é mais
necessário e ficaria só acumulando tentativas de entrega que ninguém escuta):

```bash
curl -X GET "https://api.clickup.com/api/v2/team/9013388773/webhook" -H "Authorization: SEU_CLICKUP_API_TOKEN"
# pega o "id" do webhook na resposta, depois:
curl -X DELETE "https://api.clickup.com/api/v2/webhook/SEU_WEBHOOK_ID" -H "Authorization: SEU_CLICKUP_API_TOKEN"
```

## 3. Testar

- Manualmente, sem esperar o horário: GitHub → aba **Actions** → workflow **"ClickUp scheduled
  sync"** → **Run workflow** (usa o `workflow_dispatch` do arquivo).
- Confira o log da execução — deve mostrar `HTTP 200` e uma linha por cliente (`synced` ou
  `no changes`).
- Confira se apareceu um novo commit em `main` no GitHub tocando o `index.html` do cliente que
  mudou, e o deploy do Cloudflare Pages.

Se o cron agendado não disparar sozinho no horário esperado, lembre que o GitHub Actions não
garante pontualidade exata em `schedule:` — em períodos de alta demanda ele pode atrasar alguns
minutos (ou raramente pular uma execução). Isso é esperado; não é bug da automação.

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
