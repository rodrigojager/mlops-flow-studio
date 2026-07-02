# Support Ticket Classification

## Purpose

Exemplo inicial de classificação multiclasse com 27 classes. Exercita CSV, SQL, API externa, fan-out/fan-in, XGBoost, embedding opcional, decisor Python e política de promoção.

---

## Folder Structure

```text
support_ticket_classification/
├── project.yaml        # contrato do projeto, fontes, métricas, política e runtime
├── pipeline.flow.json  # DAG visual versionável
└── data/
    └── tickets.csv     # dados sintéticos para preview e treino baseline
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar problema ou métricas | `project.yaml` | `../../packages/mlops-spec/CONTEXT.md` |
| Alterar DAG visual | `pipeline.flow.json` | `../../packages/mlops-spec/CONTEXT.md` |
| Gerar runtime | `../../generated/support-ticket-runtime/` | `../../packages/codegen-inference-api/CONTEXT.md` |

## Commands

```powershell
npm run validate:example
npm run codegen:example
```
