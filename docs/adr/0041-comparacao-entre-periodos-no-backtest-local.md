# 0041 - Comparação entre Períodos no Backtest Local

## Status

Aceita

## Contexto

O backtest local já avaliava modelos contra fontes do Studio, filtrava uma janela temporal e podia quebrar o resultado em janelas diária, semanal, mensal ou móveis. Esse fluxo mostrava o desempenho dentro de um período, mas ainda não respondia diretamente se o período analisado melhorou ou piorou em relação a outro período arbitrário escolhido pelo usuário.

## Decisão

O backtest local passa a aceitar `comparisonWindowStart` e `comparisonWindowEnd` junto de `timeColumn`, `windowStart` e `windowEnd`.

A janela principal continua filtrando o período analisado. A janela de comparação é aplicada sobre as mesmas linhas de origem antes do filtro principal, avalia a mesma seleção de modelos e retorna `periodComparison` com:

- `currentWindow` e `comparisonWindow`.
- métricas por modelo no período de referência.
- deltas direcionais da métrica primária entre período analisado e referência.
- evidências verde/vermelho/neutro para regressão, melhora ou estabilidade dentro do `neutralBand`.

A Control API apenas propaga os campos ao worker. A UI expõe os campos de referência no painel de avaliação/backtest e renderiza o resumo comparativo no resultado.

## Consequências

- O usuário consegue comparar fevereiro contra janeiro, uma semana contra outra ou qualquer recorte temporal sem script externo.
- O contrato existente de `windowResults` permanece compatível; a comparação entre períodos entra como campo adicional opcional.
- A comparação usa os artefatos já treinados e pode aumentar o custo do backtest proporcionalmente ao número de modelos selecionados.
