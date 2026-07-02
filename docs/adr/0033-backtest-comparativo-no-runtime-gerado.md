# 0033 - Backtest Comparativo no Runtime Gerado

## Status

Aceita

## Contexto

O plano exige que novas versões e modelos sejam comparados contra uma versão atual antes de substituir o que está rodando. A avaliação local já calculava métricas e snapshots para um modelo específico, mas o runtime gerado ainda não tinha uma forma autônoma de comparar candidatos, produzir evidências visuais simples e persistir esse resultado fora do Studio.

## Decisão

O runtime FastAPI gerado passa a expor `POST /backtest`.

Esse endpoint recebe `records`, `labels`, lista opcional de `model_ids`, `baseline_model_id` opcional e `neutral_band`. Ele avalia os modelos selecionados com a mesma lógica de métricas de `POST /evaluate`, usa o modelo ativo como baseline quando nenhum baseline é informado, compara a métrica primária e retorna:

- `baseline_model_id` e `candidate_model_ids`;
- métricas por modelo;
- avaliações completas por modelo;
- evidências com `color` igual a `green`, `red` ou `neutral`;
- recomendação agregada `promote`, `reject` ou `review`.

O resultado é persistido em `evaluation_runs` e `metric_snapshots` pelo mesmo mecanismo de avaliação operacional já existente. Verde indica melhora relevante fora da banda neutra, vermelho indica piora relevante e neutro indica variação dentro do threshold configurado.

## Consequências

- O runtime gerado consegue comparar modelos sem depender do Studio ou do MLflow.
- A UI e automações externas podem consumir uma evidência objetiva para decidir promoção manual ou futura promoção automatizada.
- O primeiro incremento cobre backtest por payload enviado ao endpoint. O Studio incorporou depois backtest local por fontes configuradas. Backtests temporais, execuções a partir de SQL/API externa diretamente no runtime e políticas automáticas de promoção continuam como evolução posterior.
