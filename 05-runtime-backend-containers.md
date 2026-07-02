# Runtime, backend e containers

O plano MLOps pede uma plataforma com Control Plane, workers, registry, experimentos, APIs de inferência e containers reimportáveis. O Agent Flow Studio já tem padrões úteis para separar API de desenvolvimento, sandbox e runtime final.

## Separação essencial

Copie a ideia, não necessariamente a mesma tecnologia:

| Camada | Agent Flow Studio | Plataforma MLOps |
| --- | --- | --- |
| API local de desenvolvimento | `apps/builder-api` | `apps/control-api` ou `apps/studio-api` |
| UI | `apps/builder-ui` | `apps/mlops-ui` |
| Spec | `packages/flow-spec` | `packages/mlops-spec` |
| Codegen | `packages/codegen-langgraph` | `packages/codegen-inference-api` |
| Runtime final | FastAPI/Docker gerado | FastAPI/Docker de inferência |
| Sandbox | processo local do runtime gerado | treino, avaliação, inferência ou container importado |
| Artefatos | `generated/` | APIs, modelos, relatórios, containers, manifests |

## Backend de controle

O plano MLOps recomenda FastAPI para o Control Plane. O repositório atual usa Fastify para a Builder API. Há duas opções válidas:

1. Copiar a Builder API em TypeScript para ganhar velocidade na UI local, specs e codegen.
2. Reimplementar o Control Plane em FastAPI, copiando os padrões de rotas, validação, workspace e artefatos.

Se a nova ferramenta for muito focada em ML desde o início, FastAPI no Control Plane pode reduzir atrito com pandas, MLflow, SQLAlchemy, workers e bibliotecas Python. Ainda assim, copie a arquitetura da Builder API:

- rotas finas;
- serviços separados;
- validação de payload;
- erros estruturados;
- path safety;
- workspace local versionável;
- artefatos em `generated/`;
- endpoints para validar, gerar, aprovar, operar runtime e listar histórico.

## Rotas recomendadas para o Control Plane

Inspiradas em `../apps/builder-api/src/server.ts`:

```text
GET  /health

GET  /project-schema
GET  /pipeline-schema

GET  /projects
POST /projects
GET  /projects/{project_id}
PUT  /projects/{project_id}
POST /projects/{project_id}/validate
GET  /projects/{project_id}/export
POST /projects/import

POST /projects/{project_id}/sources
POST /projects/{project_id}/ingest
GET  /runs/{run_id}
GET  /projects/{project_id}/runs

POST /projects/{project_id}/features/build
POST /projects/{project_id}/experiments/run
GET  /projects/{project_id}/leaderboard
POST /projects/{project_id}/backtests/run

POST /models/{model_name}/versions/{version}/approve
POST /models/{model_name}/versions/{version}/promote
POST /models/{model_name}/versions/{version}/rollback

POST /containers/build
POST /containers/import
GET  /containers/{container_id}
POST /containers/{container_id}/smoke

GET  /artifacts
GET  /artifacts/file
GET  /artifacts/archive

GET  /container-runtime/status
POST /container-runtime/build
POST /container-runtime/cancel
POST /container-runtime/up
POST /container-runtime/down
POST /container-runtime/smoke
POST /container-runtime/inspect
GET  /container-runtime/history
```

## Runtime de inferência

Base a copiar:

- `../generated/reference-interview-runtime/app/main.py`
- `../generated/reference-interview-runtime/app/service.py`
- `../generated/reference-interview-runtime/app/settings.py`
- `../generated/reference-interview-runtime/app/auth.py`
- `../generated/reference-interview-runtime/app/idempotency.py`
- `../generated/reference-interview-runtime/app/cache.py`
- `../generated/reference-interview-runtime/Dockerfile`
- `../generated/reference-interview-runtime/docker-compose.yml`

Contrato recomendado:

```text
GET  /health
GET  /metadata
GET  /model-card
POST /predict
POST /predict/batch
POST /feedback
GET  /openapi.json
GET  /docs
```

O `/metadata` deve expor:

- `platform_compatible`
- `platform_spec_version`
- `project_name`
- `model_name`
- `model_version`
- `algorithm`
- `feature_set_version`
- `training_dataset_version`
- `input_schema`
- `output_schema`
- `artifact_manifest`
- `created_at`

## Idempotência

Copiar de:

- `../generated/reference-interview-runtime/app/idempotency.py`
- ADR `../docs/adr/0002-idempotencia-explicita-nao-derivada-de-chave-de-negocio.md`

Para MLOps:

- Use idempotência em operações mutáveis:
  - criar projeto;
  - iniciar ingestão;
  - iniciar treino;
  - promover modelo;
  - criar predição, se o consumidor exigir deduplicação;
  - registrar feedback/label real.
- Não derive idempotência de `project_id`, `model_name` ou chave de negócio.
- Persistir hash do payload e resposta.

## Eventos e logs

Copiar a separação de eventos operacionais e dados visíveis:

- No Agent Flow: `transcript` e `events`.
- No MLOps: `prediction_logs` ou `reports` e `events`.

Eventos sugeridos:

- `ingestion_started`
- `ingestion_completed`
- `data_quality_failed`
- `feature_build_started`
- `feature_build_completed`
- `experiment_started`
- `model_trained`
- `model_evaluated`
- `backtest_completed`
- `approval_requested`
- `model_approved`
- `model_rejected`
- `container_built`
- `container_smoke_passed`
- `container_imported`
- `prediction_logged`
- `drift_detected`
- `retrain_suggested`

## Docker e smoke test

Copiar de:

- `../apps/builder-api/src/docker-runtime.ts`
- `../apps/builder-ui/src/App.tsx`, função `GeneratedArtifactPanel`

Adaptação do smoke:

1. `GET /health`.
2. `GET /metadata`.
3. Validar se `platform_compatible` é `true`.
4. Ler `input_schema`.
5. Enviar amostra para `POST /predict`.
6. Validar `output_schema`.
7. Medir latência.
8. Se houver `/predict/batch`, testar lote pequeno.
9. Registrar resultado no histórico.

## Workers e jobs

O Agent Flow Studio ainda não implementa workers pesados, mas documenta jobs futuros. Para MLOps, jobs são obrigatórios desde cedo.

Sugestão:

- Control Plane recebe comandos.
- Worker executa ingestão, features, treino, avaliação, backtesting, build e monitoramento.
- Redis pode ser usado para filas simples no MVP.
- Celery ou Prefect são opções naturais.
- Postgres guarda metadados e status.
- Object storage guarda datasets, modelos e artefatos.

Padrões que ainda assim podem ser copiados:

- status estruturado;
- histórico local;
- logs limitados e filtráveis;
- cancelamento;
- progresso incremental;
- `startedAt`, `finishedAt`, `message`, `ok`, `status`, `logs`.

## Banco de dados

Copiar como ponto de partida:

- `../generated/reference-interview-runtime/app/models.py`
- `../generated/reference-interview-runtime/app/repo.py`
- `../generated/reference-interview-runtime/migrations/001_init.sql`

Criar tabelas MLOps:

- `projects`
- `data_sources`
- `datasets`
- `feature_sets`
- `experiment_runs`
- `model_versions`
- `container_versions`
- `prediction_logs`
- `backtest_runs`
- `monitoring_reports`
- `idempotency_records`
- `pipeline_events`
- `job_runs`

## Segurança

Copiar:

- API key simples por header.
- `.env.example`.
- `.env` ignorado no zip de artefatos.
- secrets por nome de variável, não por valor.
- runtime local com auth desativável para desenvolvimento.

Para MLOps, adicionar:

- mascaramento de PII em logs;
- controle de acesso por projeto;
- permissões para promover modelo;
- trilha de auditoria;
- cuidado especial com pickle e container importado;
- sandbox para artefatos não confiáveis.

## Reimportação de containers

Ainda não existe pronta no Agent Flow Studio, mas há base suficiente:

- preview de artefatos;
- zip;
- validação de metadata;
- smoke;
- Docker compose;
- path safety;
- histórico.

Implementação recomendada:

1. Criar `ContainerImportManager`.
2. Aceitar pasta local primeiro.
3. Depois zip/tarball.
4. Depois imagem Docker.
5. Validar manifests.
6. Rodar smoke em sandbox.
7. Registrar como nativo ou black-box.
8. Gerar projeto derivado editável.
