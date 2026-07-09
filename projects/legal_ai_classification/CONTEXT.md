# Legal AI Classification Project

## Purpose

Cópia de trabalho editável do exemplo jurídico. A UI pode abrir, alterar e salvar `project.yaml` e `pipeline.flow.json`, preservando a estrutura do plano expandido: histórico rotulado, classes jurídicas internas, workflow, embeddings versionados, classificador supervisionado, camada semântica, decisor de regras, baixa confiança, LLM controlado e política de promoção/rollback.

---

## Folder Structure

```text
legal_ai_classification/
├── project.yaml        # contrato do projeto jurídico, fontes, métricas, política e runtime
├── pipeline.flow.json  # DAG visual com camadas de inferência híbrida
├── data/
│   └── legal_documents.csv  # dados sintéticos para validação e treino baseline
└── dotnet/
    ├── src/    # referência Clean Architecture para API transacional jurídica
    └── tests/  # contratos executáveis de domínio e aplicação
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar categorias, métricas ou runtime | `project.yaml` | `../../packages/mlops-spec/CONTEXT.md` |
| Alterar DAG visual ou camadas do decisor | `pipeline.flow.json` | `../../packages/mlops-spec/CONTEXT.md` |
| Alterar dataset sintético | `data/legal_documents.csv` | `project.yaml` |
| Alterar domínio/API .NET | `dotnet/` | `dotnet/README.md` |
| Comparar com exemplo canônico | `../../examples/legal_ai_classification/` | `../../examples/legal_ai_classification/CONTEXT.md` |

## Commands

```powershell
npm run validate:legal-example
npm run codegen:legal-example
dotnet build .\projects\legal_ai_classification\dotnet\LegalAi.Reference.csproj
dotnet run --project .\projects\legal_ai_classification\dotnet\tests\LegalAi.Contract.Tests\LegalAi.Contract.Tests.csproj
```
