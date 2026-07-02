# 0057 - Criptografia de Snapshots Arquivados com Chave Referenciada

## Status

Aceita

## Contexto

Snapshots replayáveis podem conter dados de treino mascarados ou, quando explicitamente autorizado, linhas completas. O storage externo por filesystem introduzido para archive/restore melhora a retenção fora do projeto, mas também aumenta o risco de exposição se o diretório externo for compartilhado ou montado em outro volume.

O projeto já exige segredos por referência e proíbe serializar valores reais de segredo em artefatos, manifests ou exports.

## Decisão

Quando `MLOPS_STUDIO_DATASET_SNAPSHOT_ENCRYPTION_KEY` ou `buildApp({ datasetSnapshotEncryptionKey })` estiver configurado, o archive de snapshots grava o JSONL como `.rows.jsonl.enc` usando AES-256-GCM.

A chave real nunca é persistida. Os metadados gravam apenas:

- algoritmo;
- referência da chave (`MLOPS_STUDIO_DATASET_SNAPSHOT_ENCRYPTION_KEY_REF` ou `datasetSnapshotEncryptionKeyRef`);
- fingerprint SHA-256 da chave derivada;
- IV e auth tag necessários para descriptografia;
- SHA-256 físico do arquivo arquivado;
- SHA-256 do plaintext para validar o restore.

O restore de snapshot criptografado exige a chave configurada e valida o fingerprint, o SHA-256 físico, o SHA-256 do plaintext descriptografado e o digest lógico do JSONL.

## Consequências

- Snapshots arquivados podem ficar criptografados em repouso no storage filesystem externo.
- O contrato continua compatível com o archive não criptografado quando nenhuma chave é configurada.
- A segurança depende da proteção da variável de ambiente ou segredo referenciado.
- Backends S3/MinIO futuros podem reutilizar os mesmos metadados de criptografia e validação.
