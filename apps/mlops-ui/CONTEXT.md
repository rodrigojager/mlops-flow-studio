# MLOps UI

## Purpose

Interface visual do Studio baseada em React, Vite e React Flow. Oferece palette, canvas, inspector, abas operacionais, validação, preview seguro/real de fontes síncrono ou por job, editor visual de contratos de API externa com método, URL, timeout, paginação, headers por segredo, `bodyTemplate` e mocks persistidos, execução de bloco síncrona ou por job com escolha entre isolamento por subprocesso e container, política de rede `none`/`allowlist`/`open`, hosts permitidos, mocks HTTP e auditoria `networkCalls`, treino baseline síncrono ou por job, retreino incremental síncrono ou por job a partir do run selecionado, avaliação de modelo síncrona ou por job, backtest comparativo síncrono ou por job com janela temporal opcional, comparação entre períodos arbitrários, agregações diária/semanal/mensal e janelas móveis de 7/30 dias, debug visual no canvas com estados de nós e arestas derivados de `sourcePreview`, `trainingResult`, `evaluationResult`, `pythonRunResult` e `workerJobs`, incluindo jobs `queued`, `running`, `completed`, `failed`, `cancelled`, `skipped` e `recoverable`, e resumo no inspector, rule builder visual de promoção na aba Studio, painel agregado de fila do worker com backend, worker, slots, claims e concorrência, painel de snapshots de dataset com storage externo, criptografia, contagens locais/remotas e ações de archive/restore/purge, painel de jobs do worker com status/eventos/logs/cancelamento, horários de fila/runner, worker executor quando informado pela Control API, eventos de replay de snapshot, metadados de retreino aprovado, status de conclusão remota, botão de promoção controlada do retreino e botão de retomar jobs `recoverable`, histórico de runs, histórico de avaliações/backtests, status e aplicação manual de promoção, painel MLflow com status, catálogo e ações de registry, ambiente Python, painel GPU/CUDA com fallback CPU, painel Embeddings/BERT com checagem de pacotes, cache local e smoke de `SentenceTransformer.encode`, Docker do runtime com smoke detalhado por endpoint, feedback, retreino controlado, shadow, canary, rollback, conclusão de retreino, inspect, logs e histórico de comandos, painel de Runtime remoto com inspeção read-only de health, metadata, OpenAPI, métricas, feedback, retreino, promoção, deployment, drift, GPU, dashboard e importação black-box controlada, ação para rodar retreino aprovado quando houver `approved_pending_runner`, endpoints MLOps incluindo feedback, retreino, deployment, avaliação, backtest e drift, geração de runtime, validação de manifestos, exportação de zip, reimportação do pacote `.mlops`, zip, repositório Git com `.mlops` ou `app/metadata` e repositório Git sem contrato por análise estática de OpenAPI, Dockerfile, Compose, rotas FastAPI/Flask/Starlette/Django/Express/Fastify/Koa/Hono/NestJS/Next.js/Go/Ruby/Java/ASP.NET Core/PHP, gRPC em `.proto`, servidor HTTP legado ou fallback black-box genérico confirmado via Control API, imagem Docker por inspeção controlada com probe OpenAPI sandboxado opcional quando habilitado na Control API, runtime white-box com `app/metadata` ou runtime remoto black-box observável, e suporte de contrato a retenção/expurgo local de snapshots de dataset.

Também expõe o item pós-MVP de Playwright scraping na aba Runtime, chamando `POST /tools/playwright-scrape` para inspecionar uma URL com login por formulário opcional e crawl interno/profundo confirmado de mesma origem, gravar relatório/screenshot e resumir candidatos OpenAPI/Swagger/Redoc, forms, headings, páginas e links. O formulário de login usa seletores CSS e `passwordRef` por `env:VAR`, sem persistir a senha no relatório. O "Wizard de contrato antes da importação" permite incluir/remover fontes e editar label, descrição, método, URL, timeout e body template JSON antes da gravação. A ação "Validar OpenAPI" chama `POST /tools/openapi-contract-preview` para validar o JSON OpenAPI escolhido, resolver URL relativa contra a página scrapeada e mostrar endpoints, operações, content-types, schemas resumidos, descritores rasos e exemplos de request/response. Cada operação validada pode ser aplicada no wizard para preencher método, path e `bodyTemplate` antes da prévia/importação, ou testada pela ação "Testar payload", que chama `POST /tools/openapi-operation-smoke` e mostra status HTTP, latência, content-type, validação rasa de request/response e prévia da resposta. A ação "Pré-visualizar importação" chama `POST /projects/import-scrape/preview` e mostra a proposta de fontes, endpoints, DAG e limitações antes da gravação. A ação "Importar scrape" chama `POST /projects/import-scrape` e abre o projeto black-box assistido resultante no canvas.

---

## Folder Structure

```text
mlops-ui/
├── package.json
├── index.html
├── vite.config.ts
└── src/
    ├── App.tsx      # shell, canvas, inspector e abas
    ├── api.ts       # cliente da Control API
    ├── types.ts     # tipos usados pela UI
    ├── main.tsx
    └── styles.css
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar canvas ou inspector | `src/App.tsx` | `../../docs/plan.md` |
| Alterar blocos Python no inspector | `src/App.tsx` e `src/types.ts` | `../../docs/adr/0006-blocos-deterministicos-como-funcoes-python-contratadas.md`, `../../docs/adr/0017-chamadas-externas-em-blocos-python-com-politica-e-mock.md`, `../../docs/adr/0040-isolamento-de-blocos-python-por-subprocesso.md`, `../../docs/adr/0042-isolamento-containerizado-opcional-para-blocos-python.md`, `../../docs/adr/0045-politica-de-rede-containerizada-para-blocos-python.md` |
| Alterar chamadas à API/worker | `src/api.ts` | `../control-api/CONTEXT.md` |
| Alterar preview/treino/avaliação por fonte | `src/App.tsx`, `src/api.ts` e `src/types.ts` | `../control-api/CONTEXT.md`, `../../docs/adr/0011-fontes-mvp-csv-sql-api.md`, `../../docs/adr/0030-avaliacao-local-com-snapshots-de-metricas.md`, `../../docs/adr/0043-editor-visual-de-contratos-de-api-externa.md`, `../../docs/adr/0044-execucao-paginada-real-de-fontes-api.md` |
| Alterar backtest local por fonte | `src/App.tsx`, `src/api.ts` e `src/types.ts` | `../control-api/CONTEXT.md`, `../../docs/adr/0034-backtest-local-comparativo-por-fontes-do-studio.md`, `../../docs/adr/0035-janela-temporal-no-backtest-local.md`, `../../docs/adr/0036-backtest-local-multi-janela-mensal.md`, `../../docs/adr/0038-backtest-local-granularidades-diaria-semanal-e-janelas-moveis.md`, `../../docs/adr/0041-comparacao-entre-periodos-no-backtest-local.md` |
| Alterar painel de jobs do worker | `src/App.tsx`, `src/api.ts`, `src/types.ts` e `src/styles.css` | `../../docs/adr/0028-jobs-assincronos-do-worker-na-control-api.md` |
| Alterar observabilidade de fila/snapshots | `src/App.tsx`, `src/api.ts`, `src/types.ts` e `src/styles.css` | `../control-api/CONTEXT.md`, `../../docs/adr/0061-observabilidade-operacional-de-fila-e-snapshots-no-studio.md` |
| Alterar histórico de treino/promoção | `src/App.tsx`, `src/api.ts` e `src/types.ts` | `../control-api/CONTEXT.md`, `../../docs/adr/0029-aplicacao-manual-de-promocao-com-auditoria-local.md`, `../../docs/adr/0068-promocao-controlada-do-modelo-retreinado.md` |
| Alterar ambiente Python/opcionais | `src/App.tsx`, `src/api.ts` e `src/types.ts` | `../control-api/CONTEXT.md` |
| Alterar painel Embeddings/BERT | `src/App.tsx`, `src/api.ts`, `src/types.ts` e `src/styles.css` | `../control-api/CONTEXT.md`, `../../docs/adr/0062-smoke-operacional-de-embeddings-sentence-transformers.md` |
| Alterar painel GPU/CUDA | `src/App.tsx`, `src/api.ts` e `src/types.ts` | `../control-api/CONTEXT.md`, `../../docs/adr/0019-gpu-cuda-como-perfil-de-execucao-no-mvp.md` |
| Alterar painel MLflow ou ações de registry | `src/App.tsx`, `src/api.ts` e `src/types.ts` | `../../docs/adr/0027-mlflow-como-integracao-opcional-de-primeira-classe.md` |
| Alterar Docker/smoke do runtime | `src/App.tsx`, `src/api.ts` e `src/types.ts` | `../control-api/CONTEXT.md` |
| Alterar endpoints de feedback do runtime | `src/App.tsx` e `src/types.ts` | `../../docs/adr/0064-labels-reais-e-feedback-no-runtime-gerado.md` |
| Alterar endpoints de retreino do runtime | `src/App.tsx` e `src/types.ts` | `../../docs/adr/0065-solicitacao-auditavel-de-retreino-controlado.md`, `../../docs/adr/0067-conclusao-automatica-de-retreino-aprovado.md`, `../../docs/adr/0068-promocao-controlada-do-modelo-retreinado.md` |
| Alterar endpoints de deployment do runtime | `src/App.tsx` e `src/types.ts` | `../../docs/adr/0069-shadow-canary-e-rollback-no-runtime-gerado.md` |
| Alterar inspeção de runtime remoto | `src/App.tsx`, `src/api.ts`, `src/types.ts` e `src/styles.css` | `../../docs/adr/0063-inspecao-read-only-de-runtimes-remotos.md` |
| Alterar reimportação/exportação de runtime | `src/App.tsx`, `src/api.ts` e `src/types.ts` | `../../docs/adr/0023-pacote-de-reimportacao-embarcado-na-saida.md`, `../../docs/adr/0032-exportacao-e-reimportacao-de-zip-gerado.md`, `../../docs/adr/0070-importacao-black-box-controlada-de-runtime-remoto.md`, `../../docs/adr/0071-importacao-controlada-de-repositorio-git.md`, `../../docs/adr/0072-importacao-controlada-de-imagem-docker.md` |
| Alterar layout/tema | `src/styles.css` | `../../03-ui-ux-reaproveitavel.md` |
| Alterar tipos de UI | `src/types.ts` | `../../packages/mlops-spec/CONTEXT.md` |

## Commands

```powershell
npm run dev:mlops-ui
npm run build:mlops-ui
npm run audit:visual
```
