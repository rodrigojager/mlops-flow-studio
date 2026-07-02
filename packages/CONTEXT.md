# Packages

## Purpose

Pacotes compartilhados do monorepo. Hoje concentram contratos MLOps e codegen do runtime de inferência.

---

## Folder Structure

```text
packages/
├── mlops-spec/              # schemas, diagnósticos e CLI
└── codegen-inference-api/   # gerador de runtime FastAPI autônomo
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar contratos | `mlops-spec/` | `mlops-spec/CONTEXT.md` |
| Alterar codegen Python | `codegen-inference-api/` | `codegen-inference-api/CONTEXT.md` |
| Adicionar schema novo | `mlops-spec/src/index.ts` | `../docs/domain/CONTEXT.md` |
| Adicionar artefato gerado | `codegen-inference-api/src/index.ts` | `../docs/plan.md` |
