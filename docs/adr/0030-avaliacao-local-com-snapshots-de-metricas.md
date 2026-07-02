# 0030 - Avaliação Local com Snapshots de Métricas

## Status

Aceita

## Contexto

O plano exige `POST /evaluate` ou `POST /backtest`, métricas offline fáceis de consultar e snapshots versionados. O Studio já treinava modelos e gravava `training-result.json`, mas ainda não havia uma execução dedicada para avaliar um artefato treinado contra uma fonte com labels depois do treino.

## Decisão

O worker passa a ter o comando `evaluate-model`. A operação:

- lê CSV, SQLite/PostgreSQL ou API externa pelos mesmos contratos usados em preview/treino;
- exige linhas com `problem.target`;
- carrega um `training-result.json` e o artefato do `modelId` escolhido;
- executa predição local com os loaders já suportados pelo runtime gerado;
- calcula métricas de classificação ou regressão;
- grava `artifacts/evaluation_runs/<evaluationId>/evaluation-result.json`;
- grava `artifacts/metric_snapshots/<evaluationId>-metrics.json`;
- emite eventos estruturados para jobs assíncronos.

A Control API expõe execução síncrona, job assíncrono e listagem de avaliações. A UI mostra o último resultado, histórico e botão de avaliação no Studio.

O runtime FastAPI gerado também expõe `POST /evaluate`. Esse endpoint aceita `records` e `labels` opcionais, calcula métricas de classificação ou regressão usando o alvo do projeto, grava `evaluation_runs`, `metric_snapshots` e `app_events` no banco operacional e retorna `evaluation_id`, métricas e amostra resumida.

## Consequências

- O Studio passa a separar treino e avaliação, preparando comparação pós-promoção.
- Snapshots de métricas ficam disponíveis sem depender de MLflow.
- O runtime gerado passa a ter avaliação operacional persistida, preservando autonomia fora do Studio.
- Backtests comparativos básicos no runtime, backtest local por fontes do Studio e drift básico foram incorporados posteriormente. Políticas automáticas de promoção continuam como evolução posterior.
