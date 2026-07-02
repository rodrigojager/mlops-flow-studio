# 0055 - Fila Local Persistida de Jobs com Concorrência Configurável

## Status

Aceita

## Contexto

Os jobs assíncronos do worker já eram persistidos em `.mlops-studio/worker-jobs/` e executados por runner destacado. Isso permitia acompanhar eventos/logs, cancelar execuções, retomar jobs cujo runner continuava ativo após restart da Control API e marcar runners perdidos como `recoverable`.

Ainda faltava um controle explícito de fila para evitar disparar todos os jobs ao mesmo tempo e para abrir caminho a múltiplos runners locais coordenados. Naquele momento, uma fila externa distribuída ainda era prematura para o estado do MVP.

## Decisão

A Control API passa a criar jobs no estado `queued` e a usar um dispatcher FIFO local persistido para promover jobs a `running` quando houver vaga. O limite de concorrência é configurável por `MLOPS_STUDIO_WORKER_CONCURRENCY` ou por `buildApp({ workerJobConcurrency })`, com valor padrão conservador.

O estado da fila é exposto por `GET /worker-jobs/queue`. A UI passa a reconhecer `queued`, manter polling enquanto houver jobs enfileirados, permitir cancelamento antes da execução e mostrar horários de entrada na fila e início efetivo do runner.

## Consequências

- A execução local fica mais previsível quando o usuário inicia vários previews, treinos, avaliações ou blocos Python.
- O estado `queued` vira parte do contrato local de jobs da Control API e da UI.
- Esta ADR cobre a fila local inicial; a fila filesystem compartilhada para múltiplos hosts foi registrada depois na ADR 0059.
- Backends como Redis, Prefect ou Celery continuam decisões separadas.
