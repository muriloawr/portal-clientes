-- Schema do banco D1 pro módulo Financeiro + Dados Cadastrais.
-- Rodar uma vez no D1 Console (Cloudflare dashboard) depois de criar o banco.
-- Ver docs/FINANCEIRO_SETUP.md pro passo a passo completo.
--
-- Comentários ficam em linha própria (não no fim da linha do código) porque
-- o D1 Console às vezes cola tudo numa linha só, e um comentário "--" no
-- fim da linha engole o resto do SQL até a próxima quebra de linha real.

-- clients.slug bate com a pasta/URL, ex: 'sellevia'.
-- clients.name bate com CLIENTS[].name em clickup-webhook.js.
-- clients.clerk_user_id fica NULL até o dono criar o login desse cliente.
-- clients.financeiro_task_id fica NULL até a task-mãe ser descoberta na lista "Financeiro".
CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  clerk_user_id TEXT UNIQUE,
  financeiro_task_id TEXT UNIQUE,
  razao_social TEXT,
  cnpj TEXT,
  endereco TEXT,
  contato_nome TEXT,
  contato_email TEXT,
  contato_telefone TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- invoices.clickup_task_id é o id da subtask no ClickUp, chave de upsert idempotente.
-- invoices.label é o nome da subtask, ex: "Agosto 2026".
-- invoices.status é o status cru do ClickUp, minúsculo.
-- invoices.paid é 0/1, derivado do status.
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  clickup_task_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  due_date INTEGER,
  paid_date INTEGER,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_invoices_client ON invoices(client_id);

-- invoice_links.kind é 'nf' ou 'boleto'.
-- invoice_links.url é o link do Google Drive, lido de comentário na subtask.
-- invoice_links.comment_id é o id do comentário de origem, pra rastreio.
CREATE TABLE invoice_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  comment_id TEXT,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(invoice_id, kind)
);
