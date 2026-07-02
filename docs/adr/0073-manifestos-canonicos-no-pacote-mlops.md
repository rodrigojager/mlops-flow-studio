# 0073 - Manifestos canônicos no pacote MLOps

## Status

Aceita

## Contexto

O plano define contratos canônicos para dataset, feature set, experimento, treino, política de promoção, model card, API e container. O runtime gerado já levava `project.yaml`, `pipeline.flow.json`, `runtime.manifest.json` e `generated-meta.json`, mas essas visões ficavam implícitas dentro do projeto, do pipeline ou dos artefatos de treino.

Isso era suficiente para reimportar, mas deixava mais fraco o contrato de auditoria para ferramentas externas e para inspeção humana do pacote `.mlops`.

## Decisão

O codegen passa a materializar no pacote `.mlops`:

- `dataset_manifest.yaml`;
- `feature_set.yaml`;
- `experiment_manifest.yaml`;
- `training_manifest.yaml`;
- `promotion_policy.yaml`;
- `model_card.yaml`;
- `api_manifest.yaml`;
- `container_manifest.yaml`.

Esses arquivos são derivados dos contratos existentes, do manifesto do runtime e do último resultado de treino quando disponível. Eles não duplicam segredos reais: fontes SQL usam referência de conexão e hash da query; fontes API preservam host/path, método, referências de headers e mocks, sem valores de segredo.

A validação de manifestos da Control API passa a exigir esses arquivos no runtime gerado e verifica `kind`, `contract`, `projectId` e `generatedAt`.

## Consequências

O pacote `.mlops` fica mais próximo dos contratos canônicos do plano e mais fácil de auditar ou integrar com ferramentas externas sem carregar o Studio.

Os manifestos são uma visão materializada derivada. A fonte autoritativa para edição continua sendo `project.yaml`, `pipeline.flow.json`, artefatos de treino e `runtime.manifest.json`.
