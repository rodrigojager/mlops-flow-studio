# Templates

## Purpose

Templates são pacotes de partida para instanciar pipelines MLOps/IA. Eles não definem o núcleo do produto: o núcleo executa DAGs genéricos com capacidades e providers plugáveis.

---

## Folder Structure

```text
templates/
├── support_ticket_classification/
└── legal_classification/
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar template jurídico de validação | `legal_classification/` | `../examples/legal_ai_classification/CONTEXT.md` |
| Alterar template inicial de suporte | `support_ticket_classification/` | `../examples/support_ticket_classification/CONTEXT.md` |
| Alterar contrato de capacidades | `../packages/mlops-spec/` | `../packages/mlops-spec/CONTEXT.md` |
