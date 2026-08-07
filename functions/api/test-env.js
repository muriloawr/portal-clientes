// Rota de diagnóstico descartável — lista só os NOMES das variáveis de
// ambiente visíveis pra Function, nunca os valores. Apagar assim que o
// problema da CLERK_PUBLISHABLE_KEY sumindo estiver resolvido.
export async function onRequestGet(context) {
  const { env } = context;
  const keys = Object.keys(env).sort();
  return new Response(JSON.stringify({ keys }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
