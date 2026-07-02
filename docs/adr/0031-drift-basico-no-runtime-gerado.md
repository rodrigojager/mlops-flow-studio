# 0031 - Drift Básico no Runtime Gerado

## Status

Aceita

## Contexto

O plano exige observabilidade desde o MVP, incluindo drift básico visível. O schema operacional já previa `drift_runs`, mas o runtime gerado ainda não calculava nem persistia drift de forma operacional.

## Decisão

O runtime FastAPI gerado passa a expor:

- `POST /drift`, recebendo `reference_records`, `current_records`, `feature_keys` opcionais e thresholds;
- `GET /drift/latest`, retornando a última execução persistida;
- `GET /metrics/runtime`, incluindo `drift_count` e o último `drift_score`.

O cálculo inicial é determinístico e leve:

- features sensíveis e o target são ignorados;
- features numéricas usam deslocamento de média normalizado pelo desvio padrão da referência;
- features categóricas usam distância de variação total entre distribuições;
- o score geral usa o maior score por feature;
- status `ok`, `warning` ou `alert` é derivado dos thresholds.

Cada execução grava `drift_runs`, um snapshot em `metric_snapshots` com escopo `drift` e um evento em `app_events`. O dashboard gerado mostra o score de drift no resumo.

## Consequências

- O runtime fica mais próximo da saída MLOps esperada, sem depender do Studio ou do MLflow para observabilidade básica.
- O algoritmo é propositalmente simples e auditável; PSI, KS-test, drift por embedding e comparação temporal ficam para evoluções posteriores.
- O endpoint exige amostra de referência e amostra atual explícitas nesta etapa, evitando inferir baseline a partir de logs mascarados ou incompletos.
