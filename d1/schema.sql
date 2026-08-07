-- Schema do banco D1 pro módulo Financeiro + Dados Cadastrais.
-- Rodar uma vez no D1 Console (Cloudflare dashboard) depois de criar o banco.
-- Ver docs/FINANCEIRO_SETUP.md pro passo a passo completo.

CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,           -- bate com a pasta/URL, ex: 'sellevia'
  name TEXT NOT NULL,                  -- bate com CLIENTS[].name em clickup-webhook.js
  clerk_user_id TEXT UNIQUE,           -- NULL até o dono criar o login desse cliente
  financeiro_task_id TEXT UNIQUE,      -- task-mãe na lista "Financeiro", NULL até descoberta
  razao_social TEXT,
  cnpj TEXT,
  endereco TEXT,
  contato_nome TEXT,
  contato_email TEXT,
  contato_telefone TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  clickup_task_id TEXT NOT NULL UNIQUE,   -- subtask id, chave de upsert idempotente
  label TEXT NOT NULL,                    -- nome da subtask, ex: "Agosto 2026"
  status TEXT NOT NULL,                   -- status do ClickUp, minúsculo, cru
  paid INTEGER NOT NULL DEFAULT 0,        -- 0/1, derivado do status
  due_date INTEGER,
  paid_date INTEGER,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_invoices_client ON invoices(client_id);

CREATE TABLE invoice_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  clickup_attachment_id TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- 'nf' | 'boleto' | 'outro'
  filename TEXT NOT NULL,
  mimetype TEXT,
  size INTEGER,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(invoice_id, clickup_attachment_id)
);
