# 0038 - Backtest Local com Granularidades Diária, Semanal e Janelas Móveis

## Status

Aceita

## Contexto

O backtest local já suportava janela temporal simples e agregação mensal por `windowGranularity: "month"`. Isso ajudava a enxergar regressões por mês, mas ainda deixava descobertos casos em que o comportamento muda em ciclos mais curtos ou precisa ser acompanhado por janelas móveis.

## Decisão

O backtest local passa a aceitar `windowGranularity` com os valores `none`, `day`, `week`, `month`, `rolling_7d` e `rolling_30d`.

As granularidades `day`, `week` e `month` agrupam linhas por calendário em UTC. As janelas `rolling_7d` e `rolling_30d` usam cada data observada como fim de janela e avaliam as linhas dentro do intervalo móvel correspondente.

O contrato de saída continua usando `windowResults`, com período, quantidade de linhas, métricas por modelo, evidências, modelo recomendado e recomendação por janela. A Control API valida os novos valores e a UI expõe as opções no painel de avaliação/backtest.

## Consequências

- O Studio consegue detectar regressões em períodos curtos sem scripts externos.
- Chamadas existentes com `none` ou `month` continuam compatíveis.
- Janelas móveis podem gerar mais avaliações por backtest; o MVP limita esse custo pelo `maxRows` já existente no worker.
