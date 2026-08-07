import { verifyClerkAuth } from '../_lib/clerk.js';

// Rota descartável só pra confirmar que a verificação de token do Clerk
// funciona de ponta a ponta antes de construir a API real em cima. Apagar
// depois que a Fase 2 do plano estiver validada (junto com
// functions/_test-clerk.js).
export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await verifyClerkAuth(request, env);
  return new Response(JSON.stringify(auth), {
    status: auth.ok ? 200 : (auth.status || 401),
    headers: { 'Content-Type': 'application/json' },
  });
}
