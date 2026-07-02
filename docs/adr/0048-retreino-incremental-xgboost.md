# 0048 - Retreino Incremental XGBoost

## Status

Aceita

## Contexto

A ADR 0039 definiu retreino incremental local com lineage e fallback explícito para backends sem atualização incremental segura. Naive Bayes stdlib, `sklearn_text_classifier` e `sklearn_regressor` já tinham caminhos incrementais próprios, mas os artefatos XGBoost ainda eram sempre treinados por lote.

O backend XGBoost atual gera artefatos `xgboost_text_classifier` e `xgboost_regressor` com estimadores serializados em `modelBase64` e vetorizadores em `vectorizerBase64`. O runtime gerado e a avaliação local já consomem esse formato por `predict`, então a atualização incremental deve preservar esse contrato.

## Decisão

O worker passa a marcar artefatos XGBoost como `incrementalCapable: true` e a gravar `trainingRows` e `boostedRounds`.

Quando `incremental: true` encontra artefato base compatível, o worker:

- carrega o vetorizador e o estimador XGBoost anteriores;
- transforma o lote novo com o vetorizador base;
- chama `fit(..., xgb_model=base_estimator.get_booster())` para continuar o booster;
- registra `baseRunId`, `baseArtifactUri`, linhas de atualização, linhas de validação, rounds base e rounds totais.

Para classificação textual, a continuação só é aplicada quando as classes do lote novo já existem no artefato base. Quando o lote incremental não contém todas as classes, o worker adiciona linhas sintéticas com peso zero apenas para satisfazer a validação do wrapper scikit-learn do XGBoost, sem alterar o peso estatístico do lote real.

Quando o artefato base não é compatível, ou quando surgem classes novas na classificação, o worker retreina com o lote atual e registra fallback explícito.

## Consequências

Projetos que usam XGBoost para classificação textual ou regressão tabular passam a ter retreino incremental local com lineage, sem mudar o formato consumido pelo Studio e pelo runtime gerado.

A estratégia continua sendo continuação de booster sobre o lote novo, não reprocessamento do histórico completo. Se a atualização exigir mudança de vocabulário ou inclusão de classes novas, o resultado deixa claro que houve fallback.

A ADR 0049 removeu o fallback obrigatório de SentenceTransformers ao adicionar uma estratégia incremental própria para os estimadores sobre embeddings.
