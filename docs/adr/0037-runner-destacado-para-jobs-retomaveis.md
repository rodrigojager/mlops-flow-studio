# 0037 - Runner Destacado Para Jobs Retomáveis

## Status

Aceita

## Contexto

Os jobs assíncronos do worker já expunham status, eventos, logs e cancelamento, mas dependiam do ciclo de vida da Control API. Quando a API era fechada ou reiniciada, um job em execução era tratado como interrompido, mesmo que o processo Python pudesse terminar sozinho.

Para a experiência do Studio, isso cria atrito em treinos, avaliações, backtests e blocos Python mais longos. O usuário precisa poder reiniciar a Control API sem perder imediatamente a leitura de um job local que ainda está rodando.

## Decisão

A Control API passa a criar um arquivo de request por job em `.mlops-studio/worker-jobs/` e iniciar um runner TypeScript destacado para cada job.

O runner destacado:

- lê o request persistido;
- inicia o worker Python;
- captura stdout, stderr e eventos estruturados JSONL;
- persiste snapshots atômicos do job no mesmo diretório;
- respeita timeout;
- observa cancelamento gravado pela Control API no arquivo do job;
- grava resultado final mesmo que a Control API tenha sido reiniciada.

A Control API, ao listar ou consultar jobs, relê os snapshots persistidos. Se um job estiver `running` e o `runnerPid` ainda existir, ele continua sendo tratado como em execução. Se o job estiver `running` e o runner não existir mais, ele é marcado como `recoverable`, com erro explícito e retomada manual descrita na ADR 0053.

## Consequências

- Jobs locais de preview, bloco Python, treino, avaliação e backtest podem sobreviver a restart da Control API enquanto o runner destacado continuar ativo.
- A UI mantém o mesmo contrato de polling e passa a enxergar o resultado gravado pelo runner após o restart.
- O cancelamento deixa de depender de referência em memória para o processo filho; a Control API grava `cancelled` no snapshot e o runner encerra o worker Python quando observa essa mudança.
- Esta ADR cobre o runner destacado local. A recuperação explícita por replay do request persistido foi adicionada depois na ADR 0053, e a fila filesystem compartilhada para múltiplos hosts foi registrada na ADR 0059.
- Backends transacionais mais robustos, como Redis, Prefect ou Celery, continuam decisões futuras.
