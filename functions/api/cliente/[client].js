import { verifyClerkAuth } from '../../_lib/clerk.js';
import { getClientBySlug, getInvoicesForClient } from '../../_lib/d1-client.js';

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const slug = params.client;

  const auth = await verifyClerkAuth(request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status || 401);

  const client = await getClientBySlug(env.DB, slug);
  // Mesma resposta pra "cliente não existe" e "cliente existe mas não é o
  // dono do token" — não vazar pra quem não tem acesso se um slug existe.
  if (!client || client.clerk_user_id !== auth.userId) {
    return jsonResponse({ error: 'not found' }, 404);
  }

  const invoices = await getInvoicesForClient(env.DB, client.id);

  return jsonResponse({
    cadastro: {
      razaoSocial: client.razao_social,
      cnpj: client.cnpj,
      endereco: client.endereco,
      contatoNome: client.contato_nome,
      contatoEmail: client.contato_email,
      contatoTelefone: client.contato_telefone,
    },
    invoices,
  }, 200);
}
