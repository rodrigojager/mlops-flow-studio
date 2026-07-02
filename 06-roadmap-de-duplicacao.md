# Roadmap de duplicação para o novo projeto MLOps

Este roteiro assume que a nova ferramenta ficará em outra pasta e receberá código copiado/adaptado do Agent Flow Studio.

## Fase 0 - Criar a base do repositório

Copiar a estrutura:

```text
apps/
packages/
projects/
generated/
examples/
docs/
tools/
```

Adaptar `package.json` do repositório atual:

- manter workspaces `apps/*` e `packages/*`;
- manter scripts de typecheck, testes, build UI e validação;
- renomear de `agent-flow-builder` para algo como `mlops-platform`.

Arquivos de referência:

- `../package.json`
- `../tsconfig.json`
- `../tsconfig.base.json`
- `../README.md`
- `../CONTEXT.md`
- `../IDENTITY.md`

## Fase 1 - Criar `packages/mlops-spec`

Copiar:

- `../packages/flow-spec/package.json`
- `../packages/flow-spec/src/index.ts`
- `../packages/flow-spec/src/cli.ts`

Renomear:

- `AgentFlowSchema` para `MlPipelineSchema`.
- `RuntimeManifestSchema` para `MlRuntimeManifestSchema` ou `ModelBundleManifestSchema`.
- `FlowDiagnostic` para `MlDiagnostic`.
- `analyzeAgentFlow` para `analyzeMlPipeline`.

Entregável:

- validar `project.yaml` ou `pipeline.flow.json`;
- produzir diagnósticos;
- exportar JSON Schema.

Critério de aceite:

- um projeto MLOps mínimo inválido aponta erros claros;
- um projeto válido passa no CLI.

## Fase 2 - Criar `apps/control-api`

Escolha uma opção:

- Copiar `../apps/builder-api` em TypeScript/Fastify e adaptar.
- Ou criar FastAPI, copiando os padrões de organização.

Se copiar TypeScript:

Copiar:

- `server.ts`
- `workspace.ts`
- `sandbox.ts`
- `studio-runs.ts`
- `docker-runtime.ts`
- `server.test.ts`

Renomear:

- `Flow` para `Project` ou `Pipeline`.
- `SandboxManager` para `MlSandboxManager`.
- `DockerRuntimeManager` para `ModelContainerRuntimeManager`.
- `StudioRun` para `PipelineRun` ou `ExperimentRun`.

Entregável:

- CRUD local de projetos;
- validação;
- import/export;
- listagem de artefatos;
- runs locais;
- status de container.

## Fase 3 - Criar `apps/mlops-ui`

Copiar:

- `../apps/builder-ui`

Manter:

- React/Vite.
- React Flow.
- Lucide icons.
- tema claro/escuro.
- topbar, left panel, canvas, inspector e statusbar.

Renomear UI:

- `Flow` para `Projeto` ou `Pipeline`.
- `Palette` para `Etapas`.
- `Studio` para `Studio` ou `Execuções`.
- `Artefato` mantém.
- `Runtime` mantém.
- `API Docker` mantém.

Primeira palette MLOps:

- Fonte de dados
- Ingestão
- Validação
- Features
- Treino
- Avaliação
- Leaderboard
- Backtest
- Aprovação
- Container
- Predição
- Monitoramento
- Código customizado

Critério de aceite:

- criar projeto;
- desenhar pipeline;
- salvar;
- validar;
- ver JSON;
- ver artefatos vazios/gerados;
- alternar tema.

## Fase 4 - Criar `packages/codegen-inference-api`

Copiar:

- `../packages/codegen-langgraph/src/index.ts`
- `../packages/codegen-langgraph/src/pythonRuntimeTemplates.ts`
- `../packages/codegen-langgraph/src/pythonBundleTemplates.ts`
- CLIs de geração.

Remover ou isolar:

- dependência central em LangGraph, se não for usada.
- nós LLM específicos do domínio de agente.

Criar templates Python:

- `app/main.py`
- `app/settings.py`
- `app/schemas.py`
- `app/service.py`
- `app/model_loader.py`
- `app/features.py`
- `app/inference.py`
- `app/repo.py`
- `app/models.py`
- `app/idempotency.py`
- `app/auth.py`
- `metadata/*.yaml`
- `artifacts/`
- `tests/test_inference_runtime.py`
- `Dockerfile`
- `docker-compose.yml`
- `.env.example`
- `README.md`

Critério de aceite:

- gerar API de inferência mínima mockada;
- subir localmente;
- `/health`, `/metadata`, `/predict` funcionando;
- teste pytest passando.

## Fase 5 - Implementar o ciclo MVP do plano MLOps

Ordem recomendada:

1. Criar projeto.
2. Registrar fonte CSV.
3. Rodar ingestão local.
4. Salvar raw e clean.
5. Validar schema.
6. Gerar features tabulares simples.
7. Treinar Logistic Regression, Random Forest e XGBoost.
8. Criar leaderboard.
9. Registrar experimento.
10. Aprovar modelo manualmente.
11. Gerar API de inferência.
12. Build Docker.
13. Smoke `/predict`.
14. Registrar prediction log.
15. Reimportar pasta do container por manifesto.

## Fase 6 - Adaptar Docker Runtime Manager

Copiar `DockerRuntimeManager` e alterar:

- target esperado de `fastapi-runtime` para `mlops-inference-runtime`;
- leitura de `.agent-flow/generated-meta.json` para `.mlops/generated-meta.json`;
- smoke de `/sessions` para `/predict`;
- histórico em `.mlops/container-runtime-history/`;
- campos `flowId`, `flowVersion`, `flowHash` para `projectId`, `modelVersion`, `artifactHash`.

Critério de aceite:

- preparar `.env`;
- configurar portas;
- build;
- cancelar build;
- up;
- inspect;
- smoke;
- down;
- histórico filtrável.

## Fase 7 - Adaptar Studio runs para experimentos

Copiar `studio-runs.ts` e alterar:

- `session` para `run`.
- `transcript` para `report` ou `outputs`.
- `events` permanece.
- `nodeCount` vira `stepCount`.
- `messageCount` vira `outputCount` ou `artifactCount`.

Adicionar métricas:

- accuracy;
- macro F1;
- RMSE;
- latency p95;
- cost;
- row count;
- feature count;
- dataset version;
- model version.

Critério de aceite:

- comparar dois experimentos;
- ver deltas de métrica;
- abrir etapa e ver input/output;
- exportar run.

## Fase 8 - Criar projetos de exemplo

Criar em `examples/`:

- `support_ticket_classification`
- `churn_prediction`
- `price_regression`

Cada exemplo deve ter:

- dataset pequeno ou gerado;
- `project.yaml`;
- pipeline;
- schemas;
- feature set;
- treino;
- model card;
- API gerada;
- testes.

Isso copia o papel de `../examples/reference-interview-runtime`.

## Fase 9 - Testes de paridade

Copiar a ideia de:

- `../tools/verify_runtime_parity.py`
- `../packages/codegen-langgraph/src/codegen.test.ts`
- `../apps/builder-api/src/server.test.ts`
- `../tools/ui-theme-audit.spec.cjs`

Criar testes:

- spec valida projeto;
- codegen gera runtime;
- runtime responde `/predict`;
- Docker smoke funciona com runner mockado;
- UI build passa;
- auditoria visual cobre tema claro/escuro, pipeline, experimentos e container.

## Fase 10 - Evolução após MVP

Depois do ciclo CSV -> modelos -> leaderboard -> container -> reimportação:

- API externa;
- Playwright scraping;
- MLflow;
- MinIO/S3;
- DVC ou lakeFS;
- drift;
- retreino por gatilho;
- shadow/canary;
- black-box container import;
- BERT embeddings;
- explicabilidade;
- monitoramento real.

## Erros a evitar

- Começar pela UI completa antes de provar runtime e ciclo de artefato.
- Misturar Control Plane e inferência pesada no mesmo endpoint.
- Promover modelo sem aprovação e hash.
- Exportar `.env` real.
- Reimportar pickle ou container sem sandbox.
- Criar dashboards vazios antes de registrar eventos úteis.
- Copiar nomes de agente quando o domínio é MLOps.
- Escolher modelo só por accuracy.
- Ignorar latência, custo e explicabilidade.
- Sobrescrever produção sem versionamento.
