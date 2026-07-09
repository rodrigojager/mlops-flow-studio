# Examples

## Purpose

Projetos MLOps de exemplo usados como smoke dos contratos, da UI e do codegen. Casos de domínio, como jurídico, são templates de validação ou partida, não camadas fixas da ferramenta.

---

## Folder Structure

```text
examples/
├── support_ticket_classification/  # multiclasse com CSV, SQL, API, modelos e decisor Python
└── legal_ai_classification/        # classificação jurídica híbrida com embeddings, workflow e LLM controlado
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Validar exemplo principal | `support_ticket_classification/` | `support_ticket_classification/CONTEXT.md` |
| Validar exemplo jurídico | `legal_ai_classification/` | `legal_ai_classification/CONTEXT.md` |
| Alterar catálogo de templates | `../templates/` | `../templates/CONTEXT.md` |
| Criar novo exemplo | `examples/` | `../docs/plan.md` |
| Ajustar contratos usados por exemplos | `../packages/mlops-spec/` | `../packages/mlops-spec/CONTEXT.md` |
