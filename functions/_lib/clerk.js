// Verificação de token do Clerk sem nenhuma dependência npm — usa só
// crypto.subtle nativo do runtime do Cloudflare. Trocado no lugar de
// @clerk/backend porque esse projeto nunca teve wrangler.toml, e a flag
// nodejs_compat (exigida pela lib) não estava sendo reconhecida no deploy
// via integração Git, mesmo configurada certinho no painel — em vez de
// arriscar um wrangler.toml (que pode fazer o painel parar de aplicar as
// variáveis/vinculações já configuradas), verificamos o JWT na mão contra
// a "JWT public key" fixa do Clerk (RS256), que é justamente o caminho
// "networkless" que o próprio Clerk recomenda pra edge/serverless.

const encoder = new TextEncoder();

function base64urlToUint8Array(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64urlDecodeJSON(b64url) {
  const bytes = base64urlToUint8Array(b64url);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importClerkPublicKey(pem) {
  return crypto.subtle.importKey(
    'spki',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

// Verifica o token Bearer de uma requisição contra a chave pública do
// Clerk. Devolve { ok: true, userId } ou { ok: false, status, error } —
// nunca lança, pra quem chama poder responder o erro direto sem try/catch
// próprio.
export async function verifyClerkAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, status: 401, error: 'malformed token' };
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = base64urlDecodeJSON(headerB64);
    payload = base64urlDecodeJSON(payloadB64);
  } catch (err) {
    return { ok: false, status: 401, error: 'malformed token payload' };
  }

  if (header.alg !== 'RS256') {
    return { ok: false, status: 401, error: `unexpected alg: ${header.alg}` };
  }

  if (!env.CLERK_JWT_KEY) {
    return { ok: false, status: 500, error: 'CLERK_JWT_KEY não configurada' };
  }

  let key;
  try {
    key = await importClerkPublicKey(env.CLERK_JWT_KEY);
  } catch (err) {
    return { ok: false, status: 500, error: 'CLERK_JWT_KEY inválida: ' + err.message };
  }

  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlToUint8Array(sigB64);

  let valid;
  try {
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  } catch (err) {
    return { ok: false, status: 401, error: 'falha ao verificar assinatura: ' + err.message };
  }
  if (!valid) return { ok: false, status: 401, error: 'assinatura inválida' };

  const nowSec = Math.floor(Date.now() / 1000);
  const clockSkew = 5;
  if (typeof payload.exp === 'number' && payload.exp + clockSkew < nowSec) {
    return { ok: false, status: 401, error: 'token expirado' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf - clockSkew > nowSec) {
    return { ok: false, status: 401, error: 'token ainda não válido' };
  }
  if (!payload.sub) {
    return { ok: false, status: 401, error: 'token sem sub' };
  }

  return { ok: true, userId: payload.sub };
}
