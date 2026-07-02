# Support Ticket Classification Project

## Purpose

Cópia de trabalho editável do exemplo multiclasse inicial. A UI carrega este projeto pela Control API e pode salvar alterações em `project.yaml` e `pipeline.flow.json`.

---

## Folder Structure

```text
support_ticket_classification/
├── project.yaml
├── pipeline.flow.json
└── data/
    └── tickets.csv
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar configurações do projeto | `project.yaml` | `../../packages/mlops-spec/CONTEXT.md` |
| Alterar DAG visual | `pipeline.flow.json` | `../../packages/mlops-spec/CONTEXT.md` |
| Comparar com exemplo canônico | `../../examples/support_ticket_classification/` | `../../examples/support_ticket_classification/CONTEXT.md` |
