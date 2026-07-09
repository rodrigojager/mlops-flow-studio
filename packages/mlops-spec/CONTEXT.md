# MLOps Spec

## Purpose

Contrato canônico TypeScript/Zod para projetos MLOps, pipelines DAG, fontes, métricas, promoção, runtime manifest e diagnósticos.

---

## Folder Structure

```text
mlops-spec/
├── package.json
└── src/
    ├── index.ts  # schemas, tipos, catálogo de métricas e análise
    └── cli.ts    # validação e export de JSON Schema
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar schema de projeto | `src/index.ts` | `../../docs/domain/CONTEXT.md` |
| Alterar capacidades/providers opcionais | `src/index.ts` | `../../templates/CONTEXT.md` |
| Alterar análise/diagnósticos | `src/index.ts` | `../../docs/plan.md` |
| Alterar CLI | `src/cli.ts` | `src/index.ts` |
| Validar exemplo | `../../examples/support_ticket_classification/` | `../../examples/CONTEXT.md` |

## Capability Contract

`PipelineNode` pode declarar `capability`, `requires` e `provider`. A inferência de capacidades deve continuar genérica: Qdrant, MLflow, worker e LLM são providers opcionais ativados pelo grafo ou por `runtime.capabilities.providers`, não camadas fixas do produto.

## Commands

```powershell
npm run validate:example
npm run schema:project
```
