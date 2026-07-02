# 0059 - Fila Filesystem Compartilhada para Workers Distribuídos

## Status

Aceita

## Contexto

A Control API já possuía jobs assíncronos persistidos em `.mlops-studio/worker-jobs/`, runner destacado, recuperação explícita de jobs interrompidos e fila FIFO local com concorrência configurável. Isso atende uma máquina de desenvolvimento, mas o plano prevê evolução quando houver necessidade de múltiplos workers, retomada após queda do runner/máquina e execução distribuída.

Trazer Redis, Prefect ou Celery agora aumentaria infraestrutura obrigatória antes de o produto precisar de um orquestrador completo. Ao mesmo tempo, o projeto já usa artefatos locais e storage filesystem/S3 para interoperabilidade operacional.

## Decisão

A Control API passa a suportar uma fila filesystem compartilhada para jobs do worker. Quando `MLOPS_STUDIO_WORKER_QUEUE_ROOT` ou `buildApp({ workerJobQueueRoot })` estiver configurado, os snapshots JSON e requests de jobs passam a ser persistidos nesse diretório externo.

Cada instância da Control API recebe um `workerId` por `MLOPS_STUDIO_WORKER_ID` ou `buildApp({ workerJobWorkerId })`. O dispatcher usa:

- claims atômicos por job em `.claims/`;
- slots atômicos por concorrência em `.slots/`;
- heartbeat do runner destacado;
- TTL configurável por `MLOPS_STUDIO_WORKER_CLAIM_TTL_MS` ou `buildApp({ workerJobClaimTtlMs })`;
- `runnerWorkerId`, `queueBackend`, `claimPath` e `slotPath` no snapshot do job.

O endpoint `GET /worker-jobs/queue` informa o backend ativo, `workerId`, diretório compartilhado e TTL quando a fila externa está habilitada. O contrato visual de jobs permanece o mesmo: `queued`, `running`, `completed`, `failed`, `cancelled` e `recoverable`.

## Consequências

- Múltiplas instâncias da Control API podem apontar para o mesmo diretório de fila e coordenar execução sem disparar o mesmo job duas vezes.
- O limite de concorrência passa a ser aplicado por slots compartilhados no backend filesystem.
- Jobs em execução por outro host não são marcados como perdidos enquanto o heartbeat do snapshot estiver fresco.
- A solução continua simples e compatível com desenvolvimento local, volumes compartilhados e workers em hosts controlados.
- Redis, Prefect, Celery ou outra fila transacional ainda podem substituir esse backend se houver necessidade de semântica mais forte, retries avançados, priorização, auditoria centralizada ou operação em infraestrutura maior.
