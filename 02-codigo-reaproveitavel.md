# Código reaproveitável

Este arquivo lista arquivos, funções, classes, interfaces e padrões que podem ser copiados para a nova plataforma MLOps. A recomendação é copiar para outro projeto e renomear o domínio, sem criar importações compartilhadas entre as duas soluções.

## Prioridade alta

### 1. Especificação canônica com Zod

Arquivos:

- `../packages/flow-spec/src/index.ts`
- `../packages/flow-spec/src/cli.ts`

O que copiar:

- `NodeTypeSchema`, `NodeSchema`, `EdgeSchema`, `AgentFlowSchema`, `RuntimeManifestSchema`.
- `parseAgentFlow`, `analyzeAgentFlow`, `parseRuntimeManifest`.
- `FlowDiagnostic`, `FlowAnalysisResult`, `FlowAnalysisSummary`.
- Exportação de JSON Schema via `zodToJsonSchema`.

Como adaptar:

- `AgentFlowSchema` vira `MlProjectSchema` ou `MlPipelineSchema`.
- `NodeTypeSchema` vira algo como `PipelineStepTypeSchema`, com tipos:
  - `data_source`
  - `ingest`
  - `data_quality`
  - `feature_build`
  - `train_model`
  - `evaluate_model`
  - `backtest`
  - `promote_model`
  - `build_container`
  - `import_container`
  - `monitor_drift`
  - `approval_gate`
  - `custom_code`
- `FlowDiagnostic` pode ser copiado quase direto para diagnosticar projeto, pipeline, dataset, feature set, modelo e container.

Valor para MLOps:

- Evita contratos informais.
- Permite validação visual na UI.
- Dá base para codegen, import/export e reimportação.

### 2. Workspace local versionável

Arquivos:

- `../apps/builder-api/src/workspace.ts`
- `../apps/builder-api/src/server.ts`

O que copiar:

- `WorkspaceError`
- `normalizeWorkspaceRoot`
- `safeResolve`
- `toWorkspaceRelative`
- padrão de `load*`, `save*`, `validate*`, `export*`, `import*`
- gravação atômica com arquivo temporário e `rename`
- proteção contra path traversal em assets
- validação de assets referenciados
- listagem e preview de artefatos gerados
- geração de zip sem depender de ferramenta externa

Como adaptar:

- `flows/{flowId}` vira `projects/{projectId}`.
- `prompts/` vira, por exemplo, `manifests/`, `features/`, `schemas/`, `scripts/` ou `templates/`.
- `exportFlowWorkspace` vira `exportMlProjectWorkspace`.
- `importFlowWorkspace` vira `importMlProjectWorkspace`.

Valor para MLOps:

- O MVP pode operar localmente e versionar tudo em Git.
- Facilita revisão de `project.yaml`, `feature_set.yaml`, `training_manifest.yaml`, `model_card.yaml` e schemas.
- Evita banco de dados do builder antes de ser necessário.

### 3. Fingerprint determinístico e aprovação por hash

Arquivos:

- `../packages/codegen-langgraph/src/index.ts`
- `../apps/builder-api/src/workspace.ts`

O que copiar:

- `stableJson`
- `flowFingerprint`
- `flowProjectFingerprint`
- `fingerprintAssets`
- `generatedProjectMetadata`
- `approveLangGraphSandbox`
- `readLangGraphSandboxApprovalStatus`
- `generateApprovedRuntime`

Como adaptar:

- `flowHash` vira `projectHash`, `pipelineHash`, `trainingHash` ou `containerHash`.
- Hash deve cobrir:
  - `project.yaml`
  - pipeline de treino
  - schemas de dados
  - feature manifests
  - scripts de transformação/treino
  - manifests de container
  - model card
  - dados de amostra usados no smoke, se forem parte do contrato
- Hash não deve cobrir valores reais de segredo.

Valor para MLOps:

- Impede promover container ou modelo com base em uma versão diferente da testada.
- Ajuda rollback e auditoria.
- Dá fundamento para reimportação confiável.

### 4. Docker Runtime Manager

Arquivo:

- `../apps/builder-api/src/docker-runtime.ts`

Classes, funções e interfaces úteis:

- `DockerRuntimeManager`
- `DockerRuntimeStatus`
- `DockerRuntimeOperationResult`
- `DockerRuntimeHistoryEntry`
- `DockerRuntimeSmokeResult`
- `DockerRuntimeInspection`
- `build`, `cancel`, `prepareEnv`, `configurePorts`, `up`, `down`, `smoke`, `inspect`, `history`
- `parseDockerBuildProgress`
- `withBuildProgressTail`
- `normalizeRuntimeUrl`
- `readDockerCompose`
- `writeDockerCompose`
- `parseComposePs`

Como adaptar:

- `DockerRuntimeManager` vira `ModelContainerRuntimeManager`.
- Smoke test deixa de chamar `/sessions` e passa a chamar:
  - `GET /health`
  - `GET /metadata`
  - `POST /predict`
  - opcionalmente `POST /predict/batch`
- `resourceName` deixa de ser `sessions` e vira `modelName`, `apiName` ou `predictPath`.
- Validar `container_manifest.yaml` e `model_card.yaml`, além de `Dockerfile` e `docker-compose.yml`.

Valor para MLOps:

- O plano exige build, execução, inspeção, reimportação e smoke de containers. Esta classe já resolve boa parte da operação local.

### 5. Studio runs, diffs e comparação

Arquivo:

- `../apps/builder-api/src/studio-runs.ts`

O que copiar:

- `StudioRunSummary`
- `StudioRunRecord`
- `StudioStateSnapshot`
- `StudioStateDiffEntry`
- `saveStudioRun`
- `listStudioRuns`
- `loadStudioRun`
- `compareStudioRuns`
- `buildStateSnapshots`
- `diffRecords`
- análise causal com `buildCausalAnalysis`

Como adaptar:

- `StudioRun` vira `PipelineRun`, `ExperimentRun`, `BacktestRun` ou `SimulationRun`.
- `session` vira `job`, `run`, `experiment` ou `prediction_batch`.
- `events` continuam como eventos.
- `stateSnapshots` passam a representar:
  - dataset bruto/limpo/features
  - parâmetros de treino
  - métricas
  - status de etapas
  - artefatos gerados
  - logs e erros por etapa

Valor para MLOps:

- Dá base para comparar experimentos, backtests, versões de modelo e simulações de container.
- A análise causal pode apontar qual etapa quebrou e quais etapas ficaram impactadas.

## Prioridade média

### 6. Sandbox local

Arquivo:

- `../apps/builder-api/src/sandbox.ts`

O que copiar:

- `SandboxManager`
- `SandboxStatus`
- `start`, `status`, `stop`, `stopAll`
- `waitForHealth`
- coleta de logs com limite
- controle de porta

Como adaptar:

- Para MLOps, criar sandboxes diferentes:
  - sandbox de API de inferência
  - sandbox de treino local
  - sandbox de container importado
  - sandbox de backtest
- Em vez de sempre subir `uvicorn app.main:app`, permitir comandos por tipo de artefato.

### 7. Runtime Python/FastAPI gerado

Arquivos:

- `../packages/codegen-langgraph/src/pythonRuntimeTemplates.ts`
- `../generated/reference-interview-runtime/app/main.py`
- `../generated/reference-interview-runtime/app/service.py`
- `../generated/reference-interview-runtime/app/repo.py`
- `../generated/reference-interview-runtime/app/models.py`
- `../generated/reference-interview-runtime/app/schemas.py`
- `../generated/reference-interview-runtime/app/idempotency.py`
- `../generated/reference-interview-runtime/app/cache.py`
- `../generated/reference-interview-runtime/app/auth.py`
- `../generated/reference-interview-runtime/app/settings.py`

O que copiar:

- Estrutura FastAPI com `create_app`.
- `/health` e `/metadata`.
- Pydantic schemas.
- Camada `service.py` separada de endpoints.
- Camada `repo.py` separada de serviço.
- SQLAlchemy models.
- `run_idempotent` e `normalize_idempotency_key`.
- Cache Redis com fallback em memória.
- Settings por `.env`, com validação.
- API key opcional por header.

Como adaptar:

- Criar template de inferência:
  - `GET /health`
  - `GET /metadata`
  - `GET /model-card`
  - `POST /predict`
  - `POST /predict/batch`
  - opcionalmente `POST /feedback` ou `POST /predictions/{request_id}/actual`
- Criar tabelas:
  - `prediction_logs`
  - `model_events`
  - `idempotency_records`
  - talvez `batch_prediction_runs`

### 8. Codegen de artefatos

Arquivos:

- `../packages/codegen-langgraph/src/index.ts`
- `../packages/codegen-langgraph/src/pythonRuntimeTemplates.ts`
- `../packages/codegen-langgraph/src/pythonBundleTemplates.ts`
- `../packages/codegen-langgraph/src/cli.ts`
- `../packages/codegen-langgraph/src/manifest-cli.ts`

O que copiar:

- `RuntimeFile`
- padrão `render*Files`
- criação de diretórios e cópia de assets
- geração de `.agent-flow/generated-meta.json`
- geração de runtime individual e bundle por manifesto
- CLIs simples para geração

Como adaptar:

- `renderPythonRuntimeFiles` vira `renderPythonInferenceApiFiles`.
- `renderPythonMultiAgentBundleFiles` vira `renderPythonModelBundleFiles`.
- Gerar:
  - API de inferência
  - Dockerfile
  - docker-compose
  - `.env.example`
  - `metadata/`
  - `artifacts/`
  - `tests/`
  - `README.md`

### 9. UI React Flow e inspector

Arquivos:

- `../apps/builder-ui/src/App.tsx`
- `../apps/builder-ui/src/api.ts`
- `../apps/builder-ui/src/types.ts`
- `../apps/builder-ui/src/styles.css`

O que copiar:

- Shell principal.
- Topbar com ações e status.
- Palette de nós.
- React Flow com nodes, edges, minimap, controls e status classes.
- Inspector contextual.
- Painéis de arquivos, validação, JSON, artefatos, runtime e studio.
- Tema claro/escuro persistente.
- Atalhos globais.
- Cliente API em `api.ts`.
- Tipos frontend em `types.ts`.

Como adaptar:

- Palette MLOps:
  - Fonte de dados
  - Ingestão
  - Validação
  - Features
  - Treino
  - Avaliação
  - Backtest
  - Aprovação
  - Container
  - Monitoramento
  - Código customizado
- Inspector por tipo de etapa.
- Timeline e node IO por execução de pipeline.

## Prioridade baixa ou uso como referência

### 10. Nós de agente específicos

Arquivos:

- Partes de `../generated/reference-interview-runtime/app/graph.py`
- Partes de `../packages/flow-spec/src/index.ts`

Reaproveitar só como referência:

- `llm_prompt`
- `human_input`
- `rag_retrieval`
- `safety_gate`

No MLOps, alguns conceitos podem reaparecer em explicabilidade, scraping com Playwright, aprovação humana e análise textual, mas não são o centro da plataforma.

### 11. LangGraph

Use como referência de orquestração de grafo, não como dependência obrigatória da plataforma MLOps. Para pipelines de ML, Prefect, Celery, Dagster ou execução própria podem ser mais adequados.

## Bibliotecas atuais que podem continuar

Frontend:

- `react`
- `react-dom`
- `@xyflow/react`
- `lucide-react`
- `vite`

Backend TypeScript/local studio:

- `fastify`
- `yaml`
- `zod`
- `zod-to-json-schema`
- `tsx`
- `typescript`

Runtime Python:

- `fastapi`
- `uvicorn`
- `pydantic`
- `pydantic-settings`
- `sqlalchemy`
- `redis`
- `pytest`
- `httpx`

Para MLOps, adicionar:

- `pandas`
- `pyarrow`
- `scikit-learn`
- `xgboost`
- `lightgbm`
- `mlflow`
- `boto3` ou cliente S3/MinIO
- `prefect` ou `celery`
- `playwright`
- `evidently`, se for usar drift pronto
- `transformers`
- `sentence-transformers`
