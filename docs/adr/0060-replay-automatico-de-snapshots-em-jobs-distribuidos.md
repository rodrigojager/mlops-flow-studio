# 0060 - Replay Automático de Snapshots em Jobs Distribuídos

## Status

Aceita

## Contexto

Snapshots replayáveis de dataset já eram materializados em JSONL, podiam ser expurgados localmente, arquivados em filesystem ou S3/MinIO e restaurados com validação de digest e criptografia opcional. A fila filesystem compartilhada também passou a permitir múltiplos hosts coordenados por claims e slots.

Ainda faltava ligar esses recursos: quando um job distribuído roda em um host que não tem a fonte original disponível, ele deveria conseguir usar o snapshot versionado como entrada de replay sem exigir intervenção manual.

## Decisão

A Control API passa a preparar jobs de treino, avaliação e backtest com replay automático de dataset quando:

- `MLOPS_STUDIO_WORKER_DATASET_REPLAY` ou `buildApp({ workerJobDatasetReplay })` está em `auto`, que é o padrão;
- o job não recebeu `mockRows` explícito;
- a fonte original não deve ser usada diretamente no contexto do job, por exemplo CSV local ausente ou fonte SQL/API sem execução real confirmada;
- existe snapshot replayável local ou snapshot arquivado em storage externo configurado.

Quando o snapshot local foi expurgado, a Control API tenta restaurá-lo a partir do storage externo configurado antes de iniciar o runner. Depois valida o digest lógico do JSONL e injeta as linhas como `mockRows` no request persistido do worker. O job registra evento `dataset_snapshot_replayed` com `datasetVersionId`, `sourceId`, contagem de linhas, modo do row artifact e indicação de restore.

O modo pode ser desligado por `MLOPS_STUDIO_WORKER_DATASET_REPLAY=off` ou `buildApp({ workerJobDatasetReplay: "off" })`.

## Consequências

- Jobs distribuídos conseguem treinar, avaliar ou rodar backtest mesmo quando a fonte CSV/SQL/API original não está disponível no host executor.
- O replay usa o mesmo contrato de `mockRows` já suportado pelo worker, evitando duplicar carregadores de dados no Python.
- O replay não sobrescreve `mockRows` explícito e não substitui uma execução `real` confirmada pelo usuário.
- A precisão depende do snapshot disponível: snapshots `masked_rows` preservam segurança por padrão, enquanto `full_rows` continuam exigindo autorização explícita no momento de materialização.
- O recurso cobre replay operacional automático, mas não substitui uma política completa de retreino distribuído, priorização de jobs ou orquestração transacional avançada.
