# 0051 - Snapshots Replayáveis de Dataset com Retenção Explícita

## Status

Aceita

## Contexto

ADR 0050 adicionou manifestos de dataset versionado para treinos CSV/SQL/API sem armazenar linhas brutas. Isso resolveu auditoria de schema, digest, qualidade e origem, mas não permitia replay local exato do conjunto carregado para treino quando a fonte era SQL/PostgreSQL ou API externa.

Persistir linhas completas por padrão é arriscado por tamanho e por dados sensíveis. Mesmo campos não declarados como sensíveis podem conter dados pessoais. O Studio precisa permitir replay sob pedido explícito, mantendo o comportamento seguro como padrão.

## Decisão

`train-baseline` aceita `datasetSnapshotMode`:

- `manifest`: padrão; grava apenas o manifesto seguro.
- `masked_rows`: grava `artifacts/dataset_versions/<datasetVersionId>.rows.jsonl` com todas as linhas carregadas para treino e campos sensíveis mascarados.
- `full_rows`: grava o mesmo JSONL preservando as linhas completas, mas somente quando `allowSensitiveDatasetSnapshot=true`.

O manifesto `dataset_version` passa a incluir `rowArtifact` com disponibilidade, modo, formato, caminho relativo, contagem de linhas, digest do payload armazenado e indicador `sensitiveFieldsRetained`.

A Control API valida e repassa esses campos para o worker. O codegen já copia `artifacts/dataset_versions` para o pacote `.mlops`, então o snapshot JSONL acompanha o runtime gerado quando foi solicitado no treino.

## Consequências

SQL/PostgreSQL e API externa passam a ter replay local auditável das linhas carregadas, sem reexecutar a fonte externa, desde que o operador escolha `masked_rows` ou autorize explicitamente `full_rows`.

O padrão continua sem retenção de linhas. Retenção e expurgo local foram detalhados depois na ADR 0054. Criptografia, object storage e replay distribuído continuam fora desta decisão.
