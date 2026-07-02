# Referência — Datathon Passos Mágicos

Repo: `https://github.com/rodrigojager/datathon-passos-magicos`

## Por Que Esta Referência Importa

Este repositório é um exemplo concreto de saída que o MLOps Flow Studio deve conseguir gerar, adaptar ou reimportar: uma aplicação FastAPI containerizável que gerencia dados, treino, múltiplos modelos, predição, comparação, monitoramento, dashboard e artefatos.

## Estrutura Observada

```text
app/
  main.py              # FastAPI, endpoints e dashboard
  templates/           # páginas HTML do dashboard
src/
  modeling.py          # treino, seleção, bundles e predição
  storage.py           # ingestão e deduplicação
  normalization.py     # schema canônico
  monitoring.py        # drift
  dashboard_data.py    # dados do dashboard
  db_models.py         # tabelas operacionais
Dockerfile
docker-compose.yml
requirements.txt
tests/
```

## Capacidades Relevantes

- `GET /health`.
- `POST /data/normalize`, `POST /data/ingest`, `POST /data/bootstrap` e `GET /data/status`.
- `POST /train`.
- `POST /predict` com seleção opcional de modelo candidato.
- Rotas de monitoramento para drift, métricas, logs, baseline, insights e comparação de modelos.
- Dashboard em `/dashboard`, `/dashboard/models`, `/dashboard/predict`, `/dashboard/drift`, `/dashboard/logs` e `/dashboard/docs`.
- Docker Compose com aplicação e PostgreSQL.
- Persistência de ingestões, registros canônicos, treinos, predições, avaliações, drift e eventos.
- Bundles `joblib` para modelo principal e modelos candidatos.

## Impacto no Plano

O runtime gerado pelo MLOps Flow Studio deve ser tratado como uma aplicação MLOps operacional, não apenas como um microserviço fino de inferência. O endpoint `/predict` continua sendo essencial, mas a saída esperada também pode incluir endpoints de treino, ingestão, comparação, monitoramento e dashboard local.

## Limites Para o MVP

- Não exige multiusuário.
- Não exige Kubernetes.
- Não exige BERT.
- Não exige serviço distribuído de filas logo no início.
- Não exige deploy real em produção.

O foco inicial é provar o ciclo local: dados -> treino de candidatos -> seleção/aprovação -> aplicação FastAPI -> Docker -> smoke -> reimportação por manifesto.
