# Projects

## Purpose

Projetos MLOps de trabalho local editáveis pelo Studio. Diferem de `examples/` porque podem ser alterados livremente pela UI e pela Control API. Casos específicos são instâncias/templates; o Studio deve continuar aceitando DAGs genéricos com capacidades opcionais.

---

## Folder Structure

```text
projects/
├── support_ticket_classification/  # cópia de trabalho do exemplo multiclasse inicial
└── legal_ai_classification/        # cópia editável do exemplo jurídico
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Abrir projeto principal no Studio | `support_ticket_classification/` | `support_ticket_classification/CONTEXT.md` |
| Abrir projeto jurídico no Studio | `legal_ai_classification/` | `legal_ai_classification/CONTEXT.md` |
| Validar referência .NET jurídica | `legal_ai_classification/dotnet/` | `legal_ai_classification/dotnet/README.md` |
| Criar novo projeto pela API | `../apps/control-api/` | `../apps/control-api/CONTEXT.md` |
| Ajustar contratos usados por projetos | `../packages/mlops-spec/` | `../packages/mlops-spec/CONTEXT.md` |
| Alterar templates instanciáveis | `../templates/` | `../templates/CONTEXT.md` |
