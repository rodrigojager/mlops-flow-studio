# Jobs assíncronos do worker na Control API

Decidimos introduzir jobs assíncronos do worker na própria Control API antes de adotar uma fila persistente externa. O primeiro caso coberto foi treino baseline, porque é a operação local que mais rapidamente fica longa e precisa de status, logs e cancelamento sem travar a interface. O contrato foi estendido para preview de fonte, execução de bloco Python, avaliação e backtest.

## Consequências

- A Control API mantém um registro em memória para resposta imediata, mas o estado autoritativo dos jobs assíncronos fica em snapshots JSON em `.mlops-studio/worker-jobs/`.
- Cada job tem um request persistido e um runner TypeScript destacado, conforme ADR 0037, para que execução e persistência continuem mesmo se a Control API for reiniciada.
- O worker pode emitir eventos estruturados JSONL no stderr quando recebe `emitEvents: true`; o runner separa esses eventos do stderr bruto e expõe `events` no job persistido.
- A UI pode iniciar treino, avaliação, backtest, preview e bloco Python como job, acompanhar progresso na aba Studio e cancelar o processo Python quando ainda estiver em execução.
- Jobs restaurados que estavam `running` continuam como `running` quando o `runnerPid` ainda está ativo. Se o runner não existir mais, o job é marcado como `recoverable` e pode ser retomado explicitamente pelo request persistido, conforme ADR 0053.
- Os endpoints síncronos continuam existindo para previews, blocos Python, treinos curtos e avaliações curtas.
- O histórico operacional persistente continua sendo o `training-result.json` e as tabelas/artefatos do runtime gerado; o registro de jobs em memória é uma camada de orquestração local do Studio.
- A evolução para fila filesystem compartilhada com múltiplos hosts foi registrada depois na ADR 0059, preservando o contrato visual principal.

## Contrato inicial

- `POST /projects/:projectId/train-baseline/jobs` inicia job de treino baseline.
- `POST /projects/:projectId/evaluate-model/jobs` inicia job de avaliação de modelo.
- `POST /projects/:projectId/backtest-models/jobs` inicia job de backtest local.
- `POST /projects/:projectId/data-sources/:sourceId/preview/jobs` inicia job de preview de fonte.
- `POST /projects/:projectId/python-nodes/:nodeId/run/jobs` inicia job de bloco Python.
- `GET /worker-jobs` lista os jobs conhecidos pela sessão da Control API.
- `GET /worker-jobs/:jobId` retorna status, eventos estruturados, logs brutos filtrados e resultado.
- `POST /worker-jobs/:jobId/recover` retoma jobs `recoverable` a partir do request persistido.
- `DELETE /worker-jobs/:jobId` cancela jobs em execução e mantém idempotência para jobs já finalizados.
