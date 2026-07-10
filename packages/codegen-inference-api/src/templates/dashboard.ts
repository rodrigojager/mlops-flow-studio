export function renderDashboardPy(): string {
  return `from secrets import token_urlsafe

from fastapi.responses import HTMLResponse


def dashboard_html() -> HTMLResponse:
    nonce = token_urlsafe(18)
    html = """
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MLOps Runtime Dashboard</title>
  <style nonce="__CSP_NONCE__">
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #1f2937; }
    header { background: #111827; color: white; padding: 18px 24px; }
    main { padding: 20px 24px; display: grid; gap: 18px; }
    section { background: white; border: 1px solid #d8dee8; border-radius: 8px; padding: 16px; }
    h1 { margin: 0; font-size: 20px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .card { border: 1px solid #d8dee8; border-radius: 8px; padding: 12px; background: #fbfcfe; }
    .green { border-color: #22c55e; background: #ecfdf3; }
    .red { border-color: #ef4444; background: #fef2f2; }
    .neutral { border-color: #d8dee8; }
    .auth { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .auth input { min-width: min(420px, 80vw); padding: 9px 11px; border: 1px solid #9ca3af; border-radius: 6px; }
    .auth button { padding: 9px 14px; border: 0; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; }
    code, pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      section, .card { background: #1f2937; border-color: #374151; }
      .green { background: #052e16; border-color: #22c55e; }
      .red { background: #450a0a; border-color: #ef4444; }
    }
  </style>
</head>
<body>
  <header><h1>MLOps Runtime Dashboard</h1></header>
  <main>
    <section><h2>Autenticação</h2><form id="auth-form" class="auth"><input id="api-key" type="password" autocomplete="current-password" placeholder="MLOPS_RUNTIME_API_KEY" aria-label="Chave da API" /><button type="submit">Carregar dashboard</button></form></section>
    <section><h2>Resumo</h2><div id="summary" class="grid"></div></section>
    <section><h2>Promoção</h2><div id="promotion" class="grid"></div></section>
    <section><h2>Métricas</h2><pre id="metrics">Carregando...</pre></section>
  </main>
  <script nonce="__CSP_NONCE__">
    const keyInput = document.getElementById('api-key');
    const authForm = document.getElementById('auth-form');
    keyInput.value = sessionStorage.getItem('mlopsRuntimeApiKey') || '';
    async function getJson(path) {
      const apiKey = sessionStorage.getItem('mlopsRuntimeApiKey') || '';
      const response = await fetch(path, { headers: { Authorization: 'Bearer ' + apiKey } });
      if (!response.ok) throw new Error('HTTP ' + response.status + ' em ' + path);
      return response.json();
    }
    function card(label, value, className = "") {
      const element = document.createElement('div');
      const allowedClass = ['green', 'red', 'neutral'].includes(className) ? className : 'neutral';
      element.classList.add('card', allowedClass);
      const strong = document.createElement('strong');
      strong.textContent = String(label ?? '');
      const valueElement = document.createElement('code');
      valueElement.textContent = String(value ?? '');
      element.append(strong, document.createElement('br'), valueElement);
      return element;
    }
    function replaceCards(targetId, values) {
      document.getElementById(targetId).replaceChildren(...values.map((item) => card(item.label, item.value, item.className)));
    }
    async function load() {
      const [metadata, gpu, active, runtime, model, promotion, feedback, retraining, deployment] = await Promise.all([
        getJson('/metadata'), getJson('/environment/gpu'), getJson('/models/active'), getJson('/metrics/runtime'), getJson('/metrics/model'), getJson('/promotion/status'), getJson('/feedback/summary'), getJson('/retraining/status'), getJson('/deployment/status')
      ]);
      replaceCards('summary', [
        { label: 'Projeto', value: metadata.project.name },
        { label: 'Modelo ativo', value: active.id },
        { label: 'Predições', value: runtime.prediction_count },
        { label: 'Feedbacks', value: feedback.feedback_count },
        { label: 'Acurácia feedback', value: feedback.feedback_accuracy === null ? 'n/d' : feedback.feedback_accuracy },
        { label: 'Retreinos pendentes', value: retraining.pending_count },
        { label: 'Deployment', value: deployment.mode },
        { label: 'Drift', value: runtime.drift_score },
        { label: 'Perfil', value: metadata.execution_profile },
        { label: 'Execução efetiva', value: gpu.summary.effectiveExecution },
      ]);
      replaceCards('promotion', promotion.evidence.map((item) => ({
        label: item.label || item.ruleId || item.rule_id,
        value: (item.reason || '') + ' Valor: ' + item.value,
        className: item.color,
      })));
      document.getElementById('metrics').textContent = JSON.stringify({ model, runtime, feedback, retraining, deployment, gpu }, null, 2);
    }
    authForm.addEventListener('submit', (event) => {
      event.preventDefault();
      sessionStorage.setItem('mlopsRuntimeApiKey', keyInput.value);
      load().catch((error) => { document.getElementById('metrics').textContent = String(error); });
    });
    if (keyInput.value) load().catch((error) => { document.getElementById('metrics').textContent = String(error); });
  </script>
</body>
</html>
"""
    html = html.replace("__CSP_NONCE__", nonce)
    return HTMLResponse(html, headers={
        "Content-Security-Policy": f"default-src 'self'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    })
`;
}
