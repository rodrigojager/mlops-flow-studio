# Infra

## Purpose

Infraestrutura opcional de desenvolvimento. Hoje contém apenas o Compose self-hosted do MLflow, mantido fora do runtime obrigatório.

---

## Folder Structure

```text
infra/
└── docker-compose.mlflow.yml  # MLflow opcional com Postgres e artifact volume
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Usar MLflow local | `docker-compose.mlflow.yml` | `../docs/adr/0027-mlflow-como-integracao-opcional-de-primeira-classe.md` |
| Alterar integração MLflow | `../packages/codegen-inference-api/` | `../docs/plan.md` |
