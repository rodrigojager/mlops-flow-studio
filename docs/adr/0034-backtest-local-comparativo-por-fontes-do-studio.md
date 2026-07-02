# 0034 - Backtest Local Comparativo por Fontes do Studio

## Status

Aceita

## Contexto

O runtime gerado já expõe `POST /backtest` para comparar modelos a partir de `records` e `labels` enviados ao endpoint. Ainda faltava uma operação no Studio para executar a mesma decisão comparativa usando as fontes configuradas visualmente, incluindo CSV, SQL e API externa, sem exigir que o usuário monte manualmente o payload do endpoint.

## Decisão

O worker Python passa a expor o comando `backtest-models`. A Control API expõe `POST /projects/:projectId/backtest-models` e `POST /projects/:projectId/backtest-models/jobs`. A UI mostra ações de backtest no painel de avaliação.

O backtest local:

- reaproveita os loaders existentes de CSV, SQLite/PostgreSQL e API HTTP;
- usa um `training-result.json` persistido como catálogo dos modelos candidatos;
- compara todos os modelos do leaderboard por padrão, com `modelIds` opcional;
- usa `baselineModelId` explícito ou o melhor modelo do treino como baseline;
- calcula as mesmas métricas de classificação ou regressão usadas pela avaliação local;
- persiste o resultado como `backtest_result` dentro de `artifacts/evaluation_runs`;
- grava snapshot com `scope: backtest`;
- retorna evidências verde/vermelho/neutro com base em `neutralBand`.

## Consequências

- O usuário consegue comparar candidatos visualmente no Studio usando as fontes já configuradas, sem sair para scripts externos.
- O histórico de avaliações passa a conter avaliações simples e backtests, diferenciados por `kind`.
- Janela temporal simples foi incorporada posteriormente ao backtest local. Backtests multi-janela, agregação temporal e execução direta SQL/API dentro do runtime autônomo continuam como evolução posterior.
