# 0058 - Storage Remoto S3/MinIO para Snapshots de Dataset

## Status

Aceita

## Contexto

Snapshots replayáveis de dataset já podiam ser arquivados em storage externo por filesystem, com verificação de digest e criptografia AES-256-GCM opcional por chave referenciada. Esse caminho atende volume local ou diretório montado, mas não cobre ambientes em que o arquivo precisa sobreviver fora da máquina do Studio, ser compartilhado entre hosts ou ser mantido em object storage compatível com MinIO/S3.

O plano lista MinIO/S3 como evolução posterior ao MVP, e o status consolidado apontava armazenamento remoto de snapshots como lacuna explícita.

## Decisão

A Control API passa a suportar dois backends de storage externo para archive/restore de snapshots de dataset:

- `filesystem`, configurado por `MLOPS_STUDIO_DATASET_SNAPSHOT_STORE` ou `buildApp({ datasetSnapshotStoreRoot })`;
- `s3`, configurado por `MLOPS_STUDIO_DATASET_SNAPSHOT_STORE_BACKEND=s3`, `MLOPS_STUDIO_DATASET_SNAPSHOT_S3_BUCKET`, `MLOPS_STUDIO_DATASET_SNAPSHOT_S3_PREFIX`, `MLOPS_STUDIO_DATASET_SNAPSHOT_S3_ENDPOINT`, `MLOPS_STUDIO_DATASET_SNAPSHOT_S3_REGION`, `MLOPS_STUDIO_DATASET_SNAPSHOT_S3_ACCESS_KEY_ID`, `MLOPS_STUDIO_DATASET_SNAPSHOT_S3_SECRET_ACCESS_KEY`, `MLOPS_STUDIO_DATASET_SNAPSHOT_S3_SESSION_TOKEN` e `MLOPS_STUDIO_DATASET_SNAPSHOT_S3_FORCE_PATH_STYLE`, ou pelos campos equivalentes de `buildApp`.

O backend S3 usa o SDK oficial `@aws-sdk/client-s3`. O fluxo de archive grava o JSONL, o manifesto de dataset e o metadado `.archive.json` como objetos. O fluxo de restore lista os metadados arquivados, baixa o objeto de linhas, valida SHA-256 físico, SHA-256 do plaintext quando houver criptografia, digest lógico do JSONL e restaura o snapshot local.

Os metadados preservam a semântica anterior:

- `externalArchive` no manifesto local;
- `restoredFrom` após restore;
- `fileSha256`, `plaintextSha256` e digest lógico;
- metadados de AES-GCM sem gravar a chave real;
- paths `s3://bucket/key` e chaves de objeto quando o backend for S3.

## Consequências

- Snapshots podem ser arquivados em MinIO local, MinIO remoto ou AWS S3 sem mudar o contrato dos endpoints.
- O backend filesystem continua sendo o padrão compatível quando `MLOPS_STUDIO_DATASET_SNAPSHOT_STORE_BACKEND` não é `s3`.
- MinIO normalmente usa `forcePathStyle=true`; AWS S3 pode usar credenciais padrão do ambiente quando access key e secret key não forem informadas explicitamente.
- O teste automatizado cobre S3/MinIO por servidor path-style fake usando o SDK S3 real, mas não substitui um smoke manual contra um bucket real.
- Replay distribuído automático e coordenação entre múltiplos workers continuam decisões separadas.
