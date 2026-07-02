# 0053 - Recuperação Explícita de Jobs Interrompidos

## Status

Aceita

## Contexto

ADR 0037 separou a execução de jobs em runners destacados para sobreviver ao restart da Control API enquanto o runner continuasse ativo. Quando o runner destacado caía ou a máquina era reiniciada, a Control API marcava o job como `failed` ao reler o snapshot persistido.

Isso preservava a verdade do processo, mas impedia uma retomada local simples mesmo quando o request original do job continuava salvo em `.mlops-studio/worker-jobs/`.

## Decisão

Jobs persistidos com status `running` e sem runner ativo passam a ser restaurados como `recoverable`, não como falha final.

A Control API expõe:

- `POST /worker-jobs/:jobId/recover`

Esse endpoint valida que o job está `recoverable`, confirma a existência do request persistido, marca o job como `running`, registra evento `worker_job_recovered` e inicia um novo runner destacado para reexecutar o request.

A UI mostra jobs `recoverable` na lista de jobs e oferece a ação `Retomar`.

## Consequências

Treinos, previews, avaliações, backtests e blocos Python interrompidos pelo runner podem ser retomados manualmente sem recriar o job na UI.

A recuperação é replay do request persistido. Operações não idempotentes podem gerar novos artefatos ou repetir chamadas externas; por isso a retomada é explícita, não automática.

Fila externa distribuída, múltiplos workers coordenados e leases compartilhados entre máquinas continuam fora desta decisão.
