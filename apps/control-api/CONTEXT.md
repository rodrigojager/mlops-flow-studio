# Control API

## Purpose

Fastify API local do Studio. Gerencia projetos em arquivos, valida contratos, chama o worker Python, lista training runs e evaluation runs, calcula status de promoção do último treino, aplica promoção manual com auditoria local, promove modelo retreinado a partir de job remoto concluído, gerencia dependências opcionais do worker incluindo `sentence-transformers`, expõe diagnóstico GPU/CUDA local com fallback CPU, expõe smoke operacional de embeddings em `GET /environment/embedding`, controla preview, treino, retreino incremental, snapshots replayáveis de dataset por `datasetSnapshotMode`, status operacional de snapshots em `GET /projects/:projectId/dataset-snapshots/status`, expurgo local de snapshots expirados, archive/restore de snapshots para storage externo filesystem ou S3/MinIO configurável com criptografia AES-GCM opcional por chave referenciada, avaliação, bloco Python isolado por subprocesso ou por container com política `none`/`allowlist`/`open` e backtest seguro/real de fontes, incluindo APIs paginadas, com janela temporal opcional, comparação entre períodos arbitrários, agregações diária/semanal/mensal e janelas móveis de 7/30 dias, oferece jobs assíncronos persistidos em `.mlops-studio/worker-jobs/` ou em fila filesystem compartilhada por `MLOPS_STUDIO_WORKER_QUEUE_ROOT` para preview, bloco Python, treino baseline, avaliação, backtest e retreino aprovado por runtime remoto com feedback real, conclusão automática do request remoto após o job e promoção controlada do modelo retreinado, com fila FIFO, limite de concorrência configurável, claims/slots para múltiplos hosts, runner destacado, retomada após restart da Control API, status/eventos/logs/cancelamento, recuperação explícita de jobs `recoverable` e replay automático de snapshots por `MLOPS_STUDIO_WORKER_DATASET_REPLAY`, expõe status/health, catálogo e ações confirmadas de registry MLflow por projeto, gera runtimes FastAPI, valida manifestos do pacote `.mlops`, incluindo manifestos canônicos de fontes de dados, dataset, feature set, experimento, treino, política de promoção, model card, API, container e orquestração opcional, exporta zip gerado, reimporta runtimes por pasta, zip, repositório Git com `.mlops` ou `app/metadata`, repositório Git sem contrato MLOps por análise estática de OpenAPI, Dockerfile, Compose, rotas FastAPI/Flask/Starlette/Django/Express/Fastify/Koa/Hono/NestJS/Next.js/Go/Ruby/Java/ASP.NET Core/PHP, gRPC em `.proto`, servidor HTTP legado ou fallback black-box genérico confirmado para Git sem sinais estáticos, sem executar código externo por padrão e com probe OpenAPI opt-in de Git/Dockerfile por `MLOPS_STUDIO_GIT_DOCKERFILE_OPENAPI_SANDBOX=true` + `confirmSandboxExecution: true`, imagem Docker por `docker image inspect` com `sourceDockerImage`, confirmação explícita, projeto sintético black-box, sanitização de `Config.Env` e probe OpenAPI sandboxado opcional por `MLOPS_STUDIO_DOCKER_IMAGE_OPENAPI_SANDBOX=true`, runtime white-box com `app/metadata` ou runtime remoto black-box observável com `remoteBaseUrl` e `confirmBlackBox: true`, lista artefatos dentro de `generated/`, controla Docker Compose do runtime gerado com status, build/up/down, inspect, logs e histórico local, executa smoke completo de runtime local em health, metadata, modelos, modelo ativo, métricas, predição, shadow, canary, rollback, feedback, solicitação/aprovação de retreino, training-set de feedback, conclusão de retreino e dashboard, e inspeciona runtimes remotos em modo read-only por `POST /runtime/remote/inspect`, incluindo `GET /feedback/summary`, `GET /retraining/status` e `GET /deployment/status`.

Também expõe `POST /tools/playwright-scrape` para o primeiro item pós-MVP de Playwright scraping: navegação controlada de uma página raiz com login por formulário opcional, senha por `env:VAR`, crawl interno/profundo confirmado de mesma origem por `maxDepth`/`maxPages`, confirmação obrigatória para URL externa, extração agregada de metadados, headings, links, forms e candidatos OpenAPI/Swagger/Redoc, screenshot opcional e relatório local em `.mlops-studio/playwright-scrapes/`. O endpoint `POST /tools/openapi-contract-preview` valida um JSON OpenAPI detectado com confirmação para URL externa, limite de 1 MB, objeto `paths` obrigatório e retorno de endpoints HTTP, operações, content-types, schemas resumidos, descritores rasos e exemplos sintéticos de request/response. O endpoint `POST /tools/openapi-operation-smoke` executa uma única chamada HTTP controlada de operação OpenAPI com `confirmOperationCall: true`, confirmação para URL externa, validação rasa de request/response por descritores OpenAPI, body JSON derivado do exemplo sintético quando aplicável e retorno de status, latência, content-type, validação e prévia limitada da resposta. O endpoint `POST /projects/import-scrape/preview` monta em memória a proposta de projeto, DAG, fontes, endpoints e limitações para revisão, aceita edições por fonte antes da gravação, e `POST /projects/import-scrape` grava esse relatório como projeto black-box assistido com fontes API sugeridas, DAG sintético, pacote `.mlops`, edições auditadas em `generated-meta.json` e limitações explícitas.

---

## Folder Structure

```text
control-api/
├── package.json
└── src/
    ├── server.ts             # rotas, workspace e starter project
    ├── worker.ts             # ponte JSON stdin/stdout com apps/worker
    ├── worker-job-runner.ts  # runner destacado de jobs assíncronos
    └── server.test.ts        # smoke da API e codegen
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Criar ou carregar projeto | `src/server.ts` | `../../packages/mlops-spec/CONTEXT.md` |
| Validar pipeline/projeto | `src/server.ts` | `../../packages/mlops-spec/src/index.ts` |
| Executar preview/treino/avaliação/bloco | `src/worker.ts` e `src/server.ts` | `../worker/CONTEXT.md`, `../../docs/adr/0030-avaliacao-local-com-snapshots-de-metricas.md`, `../../docs/adr/0042-isolamento-containerizado-opcional-para-blocos-python.md`, `../../docs/adr/0044-execucao-paginada-real-de-fontes-api.md`, `../../docs/adr/0045-politica-de-rede-containerizada-para-blocos-python.md` |
| Executar backtest local | `src/worker.ts` e `src/server.ts` | `../worker/CONTEXT.md`, `../../docs/adr/0034-backtest-local-comparativo-por-fontes-do-studio.md`, `../../docs/adr/0035-janela-temporal-no-backtest-local.md`, `../../docs/adr/0036-backtest-local-multi-janela-mensal.md`, `../../docs/adr/0038-backtest-local-granularidades-diaria-semanal-e-janelas-moveis.md`, `../../docs/adr/0041-comparacao-entre-periodos-no-backtest-local.md` |
| Alterar jobs assíncronos do worker | `src/server.ts`, `src/worker-job-runner.ts` e `src/server.test.ts` | `../../docs/adr/0028-jobs-assincronos-do-worker-na-control-api.md`, `../../docs/adr/0037-runner-destacado-para-jobs-retomaveis.md` |
| Alterar status de fila ou snapshots | `src/server.ts` e `src/server.test.ts` | `../../docs/adr/0058-storage-remoto-s3-minio-para-snapshots-de-dataset.md`, `../../docs/adr/0059-fila-filesystem-compartilhada-para-workers-distribuidos.md`, `../../docs/adr/0061-observabilidade-operacional-de-fila-e-snapshots-no-studio.md` |
| Alterar modo de preview de fonte | `src/server.ts` | `../worker/CONTEXT.md` |
| Listar runs e aplicar promoção | `src/server.ts` | `../worker/CONTEXT.md`, `../../docs/adr/0029-aplicacao-manual-de-promocao-com-auditoria-local.md`, `../../docs/adr/0068-promocao-controlada-do-modelo-retreinado.md` |
| Checar ou instalar opcionais Python | `src/server.ts` | `../worker/CONTEXT.md` |
| Checar embeddings/BERT do worker | `src/server.ts` e `src/server.test.ts` | `../worker/CONTEXT.md`, `../../docs/adr/0062-smoke-operacional-de-embeddings-sentence-transformers.md` |
| Alterar scraping Playwright controlado | `src/server.ts` e `src/server.test.ts` | `../../docs/adr/0078-scraping-playwright-controlado.md` |
| Checar GPU/CUDA local | `src/server.ts` | `../../docs/adr/0019-gpu-cuda-como-perfil-de-execucao-no-mvp.md`, `../../docs/local-environment.md` |
| Alterar status/catálogo/registry MLflow | `src/server.ts` | `../../docs/adr/0027-mlflow-como-integracao-opcional-de-primeira-classe.md` |
| Gerar runtime | `src/server.ts` | `../../packages/codegen-inference-api/CONTEXT.md` |
| Alterar capacidades/providers de manifesto | `src/server.ts` | `../../packages/mlops-spec/CONTEXT.md` |
| Validar manifestos canônicos do runtime | `src/server.ts` | `../../docs/adr/0073-manifestos-canonicos-no-pacote-mlops.md`, `../../docs/adr/0074-automacao-opcional-prefect-celery-no-runtime.md`, `../../docs/adr/0075-manifesto-canonico-de-fontes-de-dados.md` |
| Reimportar runtime gerado, zip, Git, imagem Docker ou remoto black-box | `src/server.ts` | `../../docs/adr/0023-pacote-de-reimportacao-embarcado-na-saida.md`, `../../docs/adr/0032-exportacao-e-reimportacao-de-zip-gerado.md`, `../../docs/adr/0070-importacao-black-box-controlada-de-runtime-remoto.md`, `../../docs/adr/0071-importacao-controlada-de-repositorio-git.md`, `../../docs/adr/0072-importacao-controlada-de-imagem-docker.md`, `../../docs/adr/0076-importacao-estatica-de-git-sem-contrato-mlops.md`, `../../docs/adr/0077-probe-openapi-sandboxado-para-imagens-docker.md` |
| Gerenciar Docker do runtime | `src/server.ts` | `../../packages/codegen-inference-api/CONTEXT.md` |
| Inspecionar runtime remoto | `src/server.ts` | `../../docs/adr/0063-inspecao-read-only-de-runtimes-remotos.md` |
| Alterar contrato de feedback do runtime | `src/server.ts` e `src/server.test.ts` | `../../docs/adr/0064-labels-reais-e-feedback-no-runtime-gerado.md` |
| Alterar contrato de retreino controlado do runtime | `src/server.ts` e `src/server.test.ts` | `../../docs/adr/0065-solicitacao-auditavel-de-retreino-controlado.md`, `../../docs/adr/0067-conclusao-automatica-de-retreino-aprovado.md`, `../../docs/adr/0068-promocao-controlada-do-modelo-retreinado.md` |
| Alterar shadow/canary/rollback do runtime | `src/server.ts` e `src/server.test.ts` | `../../docs/adr/0069-shadow-canary-e-rollback-no-runtime-gerado.md` |
| Testar API | `src/server.test.ts` | `src/server.ts` |

## Commands

```powershell
npm run dev:control-api
npm run test:control-api
```

## Capability Manifests

Projetos novos e importações black-box devem preencher `RuntimeManifest.capabilities` e `RuntimeManifest.infrastructure` por inferência do DAG. Não assuma Qdrant, LLM, MLflow ou worker como dependências globais; eles só aparecem quando o projeto/nó declara provider ou capacidade.
