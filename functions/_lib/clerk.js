import { verifyToken } from '@clerk/backend';

// Verifica o token Bearer de uma requisição contra o Clerk. Devolve
// { ok: true, userId } ou { ok: false, status, error } — nunca lança,
// pra quem chama poder responder 401 direto sem try/catch próprio.
//
// @clerk/backend, dependendo da versão, ou lança TokenVerificationError ou
// devolve { data, errors } em vez de lançar — cobre os dois formatos aqui
// porque é a primeira dependência npm deste repo e essa parte não foi
// testada contra a API real ainda (ver Fase 2 do plano).
export async function verifyClerkAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };

  try {
    const result = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    if (result && result.errors) {
      return { ok: false, status: 401, error: result.errors[0]?.message || 'token inválido' };
    }
    const payload = result && result.data ? result.data : result;
    if (!payload || !payload.sub) {
      return { ok: false, status: 401, error: 'payload sem sub' };
    }
    return { ok: true, userId: payload.sub };
  } catch (err) {
    return { ok: false, status: 401, error: err.message || 'falha na verificação' };
  }
}
