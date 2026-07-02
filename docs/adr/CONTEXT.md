# ADRs

## Purpose

Decisões arquiteturais do MLOps Flow Studio. Crie ADRs apenas para decisões com trade-off real e custo de reversão relevante.

---

## Folder Structure

```text
adr/
└── CONTEXT.md
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Criar uma nova decisão | `NNNN-titulo-curto.md` | `../plan.md` |
| Revisar decisões existentes | `*.md` | `../plan.md` |

---

## Template

```markdown
# NNNN - Título

## Status

Proposta | Aceita | Substituída

## Contexto

## Decisão

## Consequências
```
