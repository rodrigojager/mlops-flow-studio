# 0050 - Manifestos de Dataset Versionado no Treino

## Status

Aceita

## Contexto

O plano exige `dataset_manifest.yaml`, lineage e versionamento de dados. O worker já treinava a partir de CSV, SQLite, PostgreSQL e API externa, mas o resultado de treino guardava apenas `sourceId`, `sourceType`, `sourceMode` e métricas. Isso dificultava auditar qual schema, qualidade e origem segura produziram um run, especialmente para SQL/API.

Armazenar todas as linhas brutas de SQL/API por padrão seria arriscado por dados sensíveis e por tamanho. O MVP precisa primeiro de um manifesto versionado seguro.

## Decisão

Cada `train-baseline` passa a persistir um artefato `dataset_version` em `artifacts/dataset_versions/`.

O manifesto registra:

- `runId`, `sourceId`, `sourceType`, `sourceMode` e `target`;
- schema inferido por coluna, incluindo `sensitive`;
- `schemaHash` e `rowDigest` calculados sobre linhas mascaradas;
- qualidade básica: contagem de linhas, colunas, ausências por coluna, target ausente e duplicatas mascaradas;
- descriptor seguro da fonte, sem serializar segredos reais;
- amostra mascarada limitada.

Para SQL, o descriptor guarda `connectionRef`, tipo de conexão e hash da query. Para API, guarda método, host/path sem valores de query, nomes de headers, hash do body template, paginação e detalhes seguros da execução ou mock.

O `training-result.json` referencia o dataset versionado em `datasetVersion` e também o lista em `artifacts`. O codegen copia `artifacts/dataset_versions` para `.mlops/artifacts/dataset_versions` e usa o resumo do latest training result para seed idempotente da tabela operacional `dataset_versions`.

## Consequências

Runs de treino passam a ter lineage de dados auditável e reimportável sem armazenar linhas sensíveis brutas.

Snapshots replayáveis com materialização controlada das linhas completas ficam fora desta decisão e são tratados separadamente na ADR 0051, com política explícita de retenção e mascaramento.
