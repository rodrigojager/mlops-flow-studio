# 0035 - Janela Temporal no Backtest Local

## Status

Aceita

## Contexto

O plano alerta que problemas temporais não devem ser tratados como split aleatório e o status do workspace ainda listava backtests temporais como evolução pendente. O Studio já conseguia executar backtest comparativo local por CSV, SQL ou API, mas avaliava todos os registros carregados da fonte.

## Decisão

O backtest local passa a aceitar `timeColumn`, `windowStart` e `windowEnd`.

A janela é aplicada no worker antes do cálculo das métricas. O filtro é inclusivo, aceita datas ISO como `YYYY-MM-DD` e timestamps ISO completos, e mantém o comportamento anterior quando a janela não é informada. O resultado persiste `temporalWindow` com coluna usada, início, fim, linhas totais, linhas na janela, linhas excluídas e linhas com timestamp inválido.

A Control API propaga esses campos em `POST /projects/:projectId/backtest-models` e `/jobs`. A UI expõe controles simples para coluna temporal, início e fim no painel de avaliação/backtest.

## Consequências

- O Studio passa a cobrir o primeiro caso útil de backtest temporal sem exigir scripts externos.
- O histórico de `evaluation_runs` preserva a janela que gerou cada backtest.
- Este incremento cobre uma janela única. Agregação mensal foi incorporada posteriormente na ADR 0036, e granularidades diária/semanal com janelas móveis foram incorporadas na ADR 0038. Execução temporal avançada diretamente no runtime autônomo continua como evolução posterior.
