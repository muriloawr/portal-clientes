// Página descartável só pra testar o login do Clerk + verificação de token
// na Function real, de ponta a ponta. Acessar em /test-clerk. Apagar esse
// arquivo depois que o login estiver confirmado de verdade (com print do
// resultado, não só a página carregando).
export async function onRequestGet(context) {
  const { env } = context;
  const pubKey = env.CLERK_PUBLISHABLE_KEY || '';
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Teste Clerk</title>
<style>
  body{font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 20px;}
  pre{background:#f2f2f2;padding:14px;border-radius:8px;white-space:pre-wrap;word-break:break-all;}
  button{padding:10px 18px;font-size:14px;cursor:pointer;}
</style>
</head>
<body>
<h1>Teste Clerk</h1>
<div id="sign-in"></div>
<button id="test-btn" style="display:none;">Testar API (/api/cliente/teste)</button>
<pre id="result"></pre>

<script defer crossorigin="anonymous" src="https://clerk.vanzaklabs.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js" data-clerk-publishable-key="${pubKey}"></script>
<script>
window.addEventListener('load', function () {
  waitForClerk();
});
function waitForClerk() {
  if (!window.Clerk) { setTimeout(waitForClerk, 100); return; }
  window.Clerk.load().then(function () {
    hideClerkBranding();
    if (window.Clerk.user) {
      showTestButton();
    } else {
      window.Clerk.mountSignIn(document.getElementById('sign-in'), {
        forceRedirectUrl: '/test-clerk',
        signUpForceRedirectUrl: '/test-clerk',
      });
      window.Clerk.addListener(function (payload) {
        if (payload.user) showTestButton();
      });
    }
  }).catch(function (err) {
    document.getElementById('result').textContent = 'Erro carregando Clerk: ' + err.message;
  });
}
// Esconde o rodapé "Secured by Clerk" — gambiarra frágil (não é feature
// suportada no plano free, pode quebrar em qualquer atualização do
// Clerk). Busca por texto em vez de nome de classe porque o Clerk usa
// hash de classe aleatório a cada carregamento (cl-internal-XXXXX).
// MutationObserver porque o Clerk re-renderiza o widget e pode trazer o
// rodapé de volta se só escondermos uma vez.
function hideClerkBranding() {
  function findAndHide() {
    document.querySelectorAll('body *').forEach(function (el) {
      if (el.children.length === 0 && el.textContent && el.textContent.trim() === 'Secured by') {
        var node = el;
        for (var i = 0; i < 5 && node.parentElement; i++) {
          if (node.parentElement.textContent.trim().length > (node.textContent.trim().length + 20)) break;
          node = node.parentElement;
        }
        if (node.style.display !== 'none') node.style.display = 'none';
      }
    });
  }
  findAndHide();
  new MutationObserver(findAndHide).observe(document.body, { childList: true, subtree: true });
}
function showTestButton() {
  document.getElementById('sign-in').style.display = 'none';
  var btn = document.getElementById('test-btn');
  btn.style.display = 'inline-block';
  var userIdLine = document.createElement('div');
  userIdLine.textContent = 'userId: ' + window.Clerk.user.id;
  document.body.insertBefore(userIdLine, btn);
  btn.addEventListener('click', function () {
    window.Clerk.session.getToken().then(function (token) {
      return fetch('/api/cliente/teste', { headers: { Authorization: 'Bearer ' + token } });
    }).then(function (res) {
      return res.text().then(function (body) {
        document.getElementById('result').textContent = 'HTTP ' + res.status + '\\n' + body;
      });
    }).catch(function (err) {
      document.getElementById('result').textContent = 'Erro: ' + err.message;
    });
  });
}
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
