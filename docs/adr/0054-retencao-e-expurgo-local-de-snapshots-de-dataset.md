# 0054 - Retenção e Expurgo Local de Snapshots de Dataset

## Status

Aceita

## Contexto

ADR 0051 adicionou snapshots replayáveis em JSONL para datasets de treino, mas a retenção ainda era manual. Snapshots mascarados ou completos podem crescer e, no caso `full_rows`, preservar dados sensíveis por mais tempo que o necessário.

O MVP ainda não precisa de storage remoto ou política distribuída, mas precisa de um controle local simples para declarar expiração e remover snapshots expirados.

## Decisão

`train-baseline` aceita `datasetSnapshotRetentionDays`, inteiro entre 1 e 3650.

Quando o treino materializa linhas por `datasetSnapshotMode` (`masked_rows` ou `full_rows`), o `rowArtifact` registra:

- `retention.policy`;
- `retention.days`;
- `retention.expiresAt`.

Sem `datasetSnapshotRetentionDays`, a política registrada é `manual`.

A Control API expõe:

- `POST /projects/:projectId/dataset-snapshots/purge-expired`

O endpoint varre `artifacts/dataset_versions/*.json`, remove arquivos `.rows.jsonl` expirados e atualiza o manifesto com `available: false`, `purgedAt`, `purgedPath` e motivo do expurgo.

## Consequências

O Studio passa a ter expurgo local auditável para snapshots materializados, sem depender de object storage ou serviço externo.

Criptografia, storage remoto, políticas distribuídas, retenção por tamanho global e replay coordenado entre workers continuam fora desta decisão.
