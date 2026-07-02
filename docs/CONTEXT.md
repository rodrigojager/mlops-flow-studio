# Docs

## Purpose

Documentação de planejamento do MLOps Flow Studio. Esta pasta consolida o plano revisado, linguagem de domínio, status e decisões arquiteturais.

---

## Folder Structure

```text
docs/
├── CONTEXT.md
├── plan.md
├── reference-datathon-passos-magicos.md
├── local-environment.md
├── implementation-status.md
├── mvp-acceptance-audit.md
├── domain/
│   └── CONTEXT.md
└── adr/
    └── CONTEXT.md
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Entender o plano atual | `plan.md` | `../IDENTITY.md` |
| Entender a saída concreta esperada | `reference-datathon-passos-magicos.md` | `plan.md` |
| Ver ambiente local e GPU/CUDA | `local-environment.md` | `plan.md` |
| Ver status do workspace | `implementation-status.md` | `plan.md` |
| Auditar gate do MVP | `mvp-acceptance-audit.md` | `plan.md` |
| Rastrear scraping Playwright controlado | `adr/0078-scraping-playwright-controlado.md` | `adr/CONTEXT.md` |
| Atualizar termos do domínio | `domain/CONTEXT.md` | `../CONTEXT-MAP.md` |
| Criar decisão arquitetural | `adr/` | `adr/CONTEXT.md` |
| Rastrear origem do plano | `../plano_plataforma_mlops.txt` e `../01-*.md` a `../06-*.md` | `plan.md` |
