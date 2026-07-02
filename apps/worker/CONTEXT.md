# Worker

## Purpose

Worker Python local para executar tarefas MLOps fora da Control API: preview seguro/real de fontes, mocks persistidos para fonte API externa, preview real de API com métodos `GET`/`POST`/`PUT`/`PATCH`/`DELETE`, headers por segredo, `bodyTemplate` e paginação por `page` ou `cursor`, execução de blocos Python isolada por subprocesso com timeout ou por container Docker com política `none`/`allowlist`/`open`, helper HTTP auditável, auditoria estática de imports/chamadas diretas, allowlist e mocks por contrato, treino baseline por CSV/SQL/API com artefatos/resultado persistido, manifesto de dataset versionado com schema, qualidade, digest e amostra mascarada, e snapshot replayável opcional em JSONL por `datasetSnapshotMode` (`manifest`, `masked_rows` ou `full_rows` com `allowSensitiveDatasetSnapshot=true`) com retenção opcional por `datasetSnapshotRetentionDays`, retreino incremental local com lineage para Naive Bayes stdlib, `sklearn_text_classifier`, `sklearn_regressor`, XGBoost e SentenceTransformers com estimador incremental, fallback explícito em backends batch restantes, avaliação local de artefatos treinados com snapshots de métricas, backtest comparativo local por CSV/SQL/API com janela temporal opcional, comparação entre períodos arbitrários, agregações diária/semanal/mensal e janelas móveis de 7/30 dias, eventos estruturados JSONL para jobs assíncronos, backends opcionais scikit-learn/XGBoost, embeddings SentenceTransformers/BERT opcionais com estimador scikit-learn, plano avançado de fine-tuning BERT/GPU auditável por artefato com guarda `MLOPS_ENABLE_BERT_FINE_TUNING`, e logging MLflow opcional.

---

## Folder Structure

```text
worker/
├── package.json
├── requirements-optional.txt
├── mlops_worker/
│   ├── __init__.py
│   └── cli.py       # protocolo JSON por stdin/stdout
└── tests/
    └── test_worker.py
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Executar bloco Python | `mlops_worker/cli.py` | `../../docs/adr/0006-blocos-deterministicos-como-funcoes-python-contratadas.md`, `../../docs/adr/0017-chamadas-externas-em-blocos-python-com-politica-e-mock.md`, `../../docs/adr/0040-isolamento-de-blocos-python-por-subprocesso.md`, `../../docs/adr/0042-isolamento-containerizado-opcional-para-blocos-python.md`, `../../docs/adr/0045-politica-de-rede-containerizada-para-blocos-python.md` |
| Preview CSV/SQL/API | `mlops_worker/cli.py` | `../../docs/adr/0011-fontes-mvp-csv-sql-api.md`, `../../docs/adr/0043-editor-visual-de-contratos-de-api-externa.md`, `../../docs/adr/0044-execucao-paginada-real-de-fontes-api.md` |
| Preview real PostgreSQL/API | `mlops_worker/cli.py` e `requirements-optional.txt` | `../../docs/implementation-status.md` |
| Treinar baseline e persistir resultado | `mlops_worker/cli.py` | `../../docs/plan.md` |
| Executar retreino incremental local | `mlops_worker/cli.py` | `../../docs/adr/0039-retreino-incremental-local-com-lineage.md`, `../../docs/adr/0046-retreino-incremental-scikit-learn-textual.md`, `../../docs/adr/0047-retreino-incremental-scikit-learn-regressao.md`, `../../docs/adr/0048-retreino-incremental-xgboost.md`, `../../docs/adr/0049-retreino-incremental-sentence-transformers.md` |
| Treinar a partir de SQL/API | `mlops_worker/cli.py` | `../../docs/adr/0011-fontes-mvp-csv-sql-api.md`, `../../docs/adr/0044-execucao-paginada-real-de-fontes-api.md` |
| Treinar embeddings SentenceTransformers/BERT opcionais | `mlops_worker/cli.py` e `requirements-optional.txt` | `../../docs/plan.md`, `../../docs/implementation-status.md` |
| Avaliar artefato treinado | `mlops_worker/cli.py` | `../../docs/adr/0030-avaliacao-local-com-snapshots-de-metricas.md` |
| Executar backtest comparativo local | `mlops_worker/cli.py` | `../../docs/adr/0034-backtest-local-comparativo-por-fontes-do-studio.md`, `../../docs/adr/0035-janela-temporal-no-backtest-local.md`, `../../docs/adr/0036-backtest-local-multi-janela-mensal.md`, `../../docs/adr/0038-backtest-local-granularidades-diaria-semanal-e-janelas-moveis.md`, `../../docs/adr/0041-comparacao-entre-periodos-no-backtest-local.md` |
| Treinar candidatos XGBoost opcionais | `mlops_worker/cli.py` | `../../docs/implementation-status.md` |
| Alterar eventos de job | `mlops_worker/cli.py` | `../../docs/adr/0028-jobs-assincronos-do-worker-na-control-api.md` |
| Registrar treino no MLflow | `mlops_worker/cli.py` | `../../docs/adr/0027-mlflow-como-integracao-opcional-de-primeira-classe.md` |
| Habilitar dependências reais | `requirements-optional.txt` | `../../docs/local-environment.md` |
| Testar worker | `tests/test_worker.py` | `mlops_worker/cli.py` |

## Commands

```powershell
npm run test:worker
```
