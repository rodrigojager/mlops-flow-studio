# Legal AI Classification

## Purpose

Exemplo canônico de classificação jurídica híbrida. Materializa a primeira fatia do plano expandido: histórico rotulado, classes jurídicas internas, workflow, embeddings versionados, classificador supervisionado, camada semântica, decisor de regras, baixa confiança, LLM controlado e política de promoção/rollback.

---

## Folder Structure

```text
legal_ai_classification/
├── project.yaml        # contrato do projeto jurídico, fontes, métricas, política e runtime
├── pipeline.flow.json  # DAG visual com camadas de inferência híbrida
└── data/
    └── legal_documents.csv  # dados sintéticos para validação e treino baseline
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar categorias, métricas ou runtime | `project.yaml` | `../../packages/mlops-spec/CONTEXT.md` |
| Alterar DAG visual ou camadas do decisor | `pipeline.flow.json` | `../../packages/mlops-spec/CONTEXT.md` |
| Alterar dataset sintético | `data/legal_documents.csv` | `project.yaml` |
| Gerar runtime jurídico | `../../generated/legal-classification-runtime/` | `../../packages/codegen-inference-api/CONTEXT.md` |

## Commands

```powershell
npm run validate:legal-example
npm run codegen:legal-example
```
