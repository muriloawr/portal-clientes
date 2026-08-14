// Helpers compartilhados entre as Cloudflare Pages Functions que sincronizam
// dados do ClickUp pro GitHub (clickup-webhook.js e team-dashboard-sync.js).
// Prefixo "_" na pasta garante que o Cloudflare Pages não trata isso como rota.

export const REPO_OWNER = 'muriloawr';
export const REPO_NAME = 'portal-clientes';
export const BRANCH = 'main';

// --- assinatura HMAC (autentica as chamadas do GitHub Actions) ---

export async function computeSignature(rawBody, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  return [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// --- ClickUp ---

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// O limite do ClickUp é ~100 req/min por token, valendo pro token inteiro (não
// só por function, e compartilhado até com scripts/figma-sync.js, que pode
// rodar ao mesmo tempo). A janela parece ser fixa por minuto, não deslizante:
// depois de um 429, as chamadas seguintes continuam falhando em cascata até a
// janela virar — esperar só alguns segundos não resolve. Mesmos valores do
// scripts/figma-sync.js (já validado em produção); Worker HTTP não tem limite
// de wall-clock, só de CPU time, e esperar (sleep) não consome CPU, então
// segurar aqui não estoura nada.
export const CLICKUP_REQUEST_DELAY_MS = 650; // ~92 req/min, com margem abaixo do limite
export const CLICKUP_MAX_RETRIES = 5;
export const CLICKUP_RETRY_WAIT_MS = 65000; // um pouco mais que 1 min, pra garantir que a janela virou

export async function clickUpFetch(url, options, attempt = 1) {
  const res = await fetch(url, options);
  if (res.status === 429 && attempt <= CLICKUP_MAX_RETRIES) {
    await sleep(CLICKUP_RETRY_WAIT_MS);
    return clickUpFetch(url, options, attempt + 1);
  }
  await sleep(CLICKUP_REQUEST_DELAY_MS);
  return res;
}

// --- GitHub ---

export async function getGithubFile(filePath, token) {
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}?ref=${BRANCH}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'clickup-sync-worker',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const binary = atob(data.content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const content = new TextDecoder('utf-8').decode(bytes);
  return { content, sha: data.sha };
}

export async function commitGithubFile(filePath, content, sha, commitMessage, token) {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  const base64 = btoa(binary);

  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'clickup-sync-worker',
    },
    body: JSON.stringify({
      message: commitMessage,
      content: base64,
      sha,
      branch: BRANCH,
    }),
  });
  if (!res.ok) throw new Error(`GitHub PUT error: ${res.status} ${await res.text()}`);
}

// --- strings ---

// Escapa crase também (não só \, ' e \n) — necessário sempre que o resultado é
// interpolado dentro de um template literal no HTML/JS gerado.
export function escapeJs(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/`/g, '\\`').replace(/\n/g, '\\n');
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
