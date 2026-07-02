# 0056 - Storage Externo de Snapshots de Dataset por Filesystem

## Status

Aceita

## Contexto

Snapshots replayáveis de dataset já podiam ser materializados localmente em JSONL por `datasetSnapshotMode` e expurgados por política de retenção. Isso resolvia auditoria local e reprodutibilidade básica, mas ainda deixava o replay preso ao diretório do projeto.

O plano prevê replay distribuído, storage remoto, criptografia e backends como MinIO/S3 no futuro. Implementar um backend S3 completo agora adicionaria dependências e credenciais antes de haver necessidade operacional clara.

## Decisão

A Control API passa a suportar um storage externo de snapshots por filesystem, configurado por `MLOPS_STUDIO_DATASET_SNAPSHOT_STORE` ou por `buildApp({ datasetSnapshotStoreRoot })`.

Dois endpoints operacionais foram adicionados:

- `POST /projects/:projectId/dataset-snapshots/archive`
- `POST /projects/:projectId/dataset-snapshots/restore`

O arquivamento copia o JSONL replayável e o manifesto de dataset para o store externo, grava metadado `.archive.json`, registra `externalArchive` no manifesto local e verifica o digest lógico do JSONL. A restauração lê o metadado arquivado, valida o SHA-256 físico e o digest lógico, copia o JSONL de volta ao projeto e registra `restoredFrom`.

## Consequências

- Snapshots locais podem sobreviver a expurgo local e ser restaurados a partir de um diretório externo ou volume montado.
- O contrato ganha um primeiro ponto de extensão para backends remotos sem introduzir dependência de nuvem no MVP.
- Esta ADR cobre apenas o primeiro backend por filesystem; o backend S3/MinIO foi registrado depois na ADR 0058.
- A criptografia por chave referenciada foi registrada depois na ADR 0057.
- Replay distribuído automático continua fora desta decisão.
