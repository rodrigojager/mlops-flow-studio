# Codegen Inference API

## Purpose

Gerador de runtime FastAPI autônomo a partir de `project.yaml` e `pipeline.flow.json`. Emite API, dashboard, diagnóstico `GET /environment/gpu`, schema operacional com seed idempotente de dataset versions, treino, modelos, promoção, deployment e métricas, `GET /models/{model_id}`, `POST /models/register` e `POST /models/{model_id}/promote` com registry persistido em `model_versions`, decisão em `promotion_decisions`, confirmação explícita e catálogo ativo mesclando pipeline com banco, `GET /embeddings/profiles`, `POST /embeddings/profiles/register`, `POST /embeddings/profiles/{profile_id}/activate`, `POST /embeddings/search` e `POST /embeddings/reindex` com perfis versionados, ativação auditável e troca de modelo de embedding sem mudar contrato de inferência, `POST /predict` com `prediction_runs`, `prediction_rows`, máscara de campos sensíveis, evento `prediction_completed`, roteamento canary determinístico e predição shadow compacta quando há rollout ativo, `POST /feedback` e `GET /feedback/summary` com `prediction_feedback`, evento `prediction_feedback_recorded`, snapshot `scope: feedback` e acurácia por feedback real, `POST /retraining/requests`, aprovação confirmada, `GET /retraining/requests/{request_id}/training-set`, `POST /retraining/requests/{request_id}/complete` e `GET /retraining/status` com `retraining_requests` para retreino controlado sem treinar dentro do runtime, `GET /deployment/status`, `POST /deployment/shadow`, `POST /deployment/canary` e `POST /deployment/rollback` com persistência em `deployment_rollouts`, `GET /experiments/ab-tests`, `GET /experiments/ab-tests/latest`, `POST /experiments/ab-tests` e `POST /experiments/ab-tests/{experiment_id}/complete` com persistência em `ab_experiments`, confirmação explícita, winner e snapshot `scope: ab_test`, `POST /evaluate` com persistência em `evaluation_runs`/`metric_snapshots`, `POST /backtest` com comparação de baseline/candidatos e evidências verde/vermelho/neutro, drift básico com `POST /drift` e `GET /drift/latest`, e retreino automático auditável quando drift fica em `alert`, criando request pendente em `retraining_requests` sem executar treino nem promoção sem aprovação, Dockerfile com labels MLOps/OCI de contrato, projeto, hashes, modelo ativo, perfil de execução e endpoints, Docker Compose com Postgres e portas de host configuráveis por ambiente, overlay `docker-compose.gpu.yml`, overlay opcional `docker-compose.orchestration.yml` com Redis persistido, worker Celery e servidor Prefect em profile, testes, pacote `.mlops` de reimportação com manifestos canônicos de fontes de dados, dataset, feature set, experimento, treino, política de promoção, model card, API, container e orquestração opcional Prefect/Celery, artefatos, dataset versions, snapshots replayáveis de linhas quando presentes e código customizado, artefatos locais de treino quando disponíveis, dependências Python derivadas apenas de nós habilitados e inferência por artefato para formatos stdlib, scikit-learn, XGBoost e SentenceTransformers suportados.

---

## Folder Structure

```text
codegen-inference-api/
├── package.json
└── src/
    ├── index.ts  # codegen, templates Python e fingerprints
    └── cli.ts    # geração por linha de comando
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar endpoints gerados | `src/index.ts` | `../../docs/plan.md` |
| Alterar feedback/labels reais no runtime | `src/index.ts` | `../../docs/adr/0064-labels-reais-e-feedback-no-runtime-gerado.md` |
| Alterar Model Registry do runtime | `src/index.ts` | `../../docs/adr/0027-mlflow-como-integracao-opcional-de-primeira-classe.md` |
| Alterar solicitação de retreino controlado | `src/index.ts` | `../../docs/adr/0065-solicitacao-auditavel-de-retreino-controlado.md`, `../../docs/adr/0067-conclusao-automatica-de-retreino-aprovado.md` |
| Alterar versionamento de embeddings | `src/index.ts` | `../../docs/implementation-status.md` |
| Alterar shadow/canary/rollback do runtime | `src/index.ts` | `../../docs/adr/0069-shadow-canary-e-rollback-no-runtime-gerado.md` |
| Alterar A/B testing do runtime | `src/index.ts` | `../../docs/adr/0033-backtest-comparativo-no-runtime-gerado.md` |
| Alterar uso de métricas/treinos gerados | `src/index.ts` | `../../docs/adr/0027-mlflow-como-integracao-opcional-de-primeira-classe.md` |
| Alterar inferência por artefato | `src/index.ts` | `../../docs/adr/0024-runtime-gerado-autonomo.md` |
| Alterar loaders XGBoost gerados | `src/index.ts` | `../../docs/implementation-status.md` |
| Alterar loaders SentenceTransformers gerados | `src/index.ts` | `../../docs/implementation-status.md` |
| Alterar Docker/Postgres | `src/index.ts` | `../../docs/adr/0013-postgres-gerenciado-como-persistencia-principal.md`, `../../docs/adr/0072-importacao-controlada-de-imagem-docker.md` |
| Alterar GPU/CUDA no runtime gerado | `src/index.ts` | `../../docs/adr/0019-gpu-cuda-como-perfil-de-execucao-no-mvp.md`, `../../docs/local-environment.md` |
| Alterar schema operacional | `src/index.ts` | `../../docs/adr/0014-schema-operacional-minimo-do-runtime.md` |
| Alterar seed operacional do runtime | `src/index.ts` | `../../docs/adr/0014-schema-operacional-minimo-do-runtime.md` |
| Alterar avaliação gerada | `src/index.ts` | `../../docs/adr/0030-avaliacao-local-com-snapshots-de-metricas.md` |
| Alterar backtest gerado | `src/index.ts` | `../../docs/adr/0033-backtest-comparativo-no-runtime-gerado.md` |
| Alterar drift gerado | `src/index.ts` | `../../docs/adr/0031-drift-basico-no-runtime-gerado.md` |
| Alterar reimportação | `src/index.ts` | `../../docs/adr/0023-pacote-de-reimportacao-embarcado-na-saida.md` |
| Alterar manifestos canônicos `.mlops` | `src/index.ts` | `../../docs/adr/0073-manifestos-canonicos-no-pacote-mlops.md`, `../../docs/adr/0075-manifesto-canonico-de-fontes-de-dados.md` |
| Alterar automação Prefect/Celery opcional | `src/index.ts` | `../../docs/adr/0074-automacao-opcional-prefect-celery-no-runtime.md` |
| Alterar providers opcionais por capacidade | `src/index.ts` | `../../packages/mlops-spec/CONTEXT.md`, `../../templates/CONTEXT.md` |

## Capability Outputs

O gerador sempre emite `.mlops/capabilities.yaml` e `docker-compose.capabilities.yml`. O overlay fica vazio quando o DAG não pede provider em modo `container`; se um nó declarar Qdrant, MLflow ou worker como `container`, o serviço correspondente entra nesse overlay sem tornar a arquitetura fixa.

## Commands

```powershell
npm run codegen:example
npm run codegen:legal-example
```
