# 0036 - Backtest Local Multi-Janela Mensal

## Status

Aceita

## Contexto

O backtest local já aceitava uma janela temporal simples, mas ainda agregava a decisão em um único resultado. Para problemas com comportamento temporal, uma única métrica agregada pode esconder regressões em períodos específicos.

## Decisão

O backtest local passa a aceitar `windowGranularity: "month"` quando `timeColumn` é informado.

O worker mantém o cálculo agregado do backtest completo e também cria `windowResults` mensais. Cada janela contém período, quantidade de linhas, métricas por modelo, evidências verde/vermelho/neutro, modelo recomendado e recomendação da janela.

A Control API propaga `windowGranularity` nas rotas de backtest síncrono e por job. A UI adiciona o seletor de agregação no painel de avaliação/backtest e exibe os resultados por janela.

## Consequências

- O Studio consegue revelar regressões temporais mensais sem exigir scripts externos.
- O histórico de `evaluation_runs` preserva tanto a decisão agregada quanto as decisões por janela.
- O primeiro agrupamento suportado foi mensal. Granularidades semanais, diárias e janelas móveis foram registradas depois na ADR 0038.
