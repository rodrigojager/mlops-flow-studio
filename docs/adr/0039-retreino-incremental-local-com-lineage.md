# 0039 - Retreino Incremental Local com Lineage

## Status

Aceita

## Contexto

O Studio já treinava modelos candidatos e persistia `training-result.json`, artefatos e histórico de runs. Ainda faltava um caminho de retreino incremental local, capaz de partir de um run anterior e registrar claramente quando houve atualização real do modelo ou apenas retreino completo com lineage.

Nem todos os backends atuais têm atualização incremental segura e compatível. Scikit-learn, XGBoost e SentenceTransformers usados no MVP são treinados por estimadores batch na implementação atual.

## Decisão

O worker passa a aceitar `incremental: true` e `previousRunId` em `train-baseline`.

Para artefatos `standard_lib_text_naive_bayes`, o retreino incremental é aplicado de fato por merge das contagens do modelo anterior com as contagens do lote atual. A ADR 0046 adicionou retreino incremental real para `sklearn_text_classifier` com `HashingVectorizer` e `MultinomialNB.partial_fit`. A ADR 0047 adicionou retreino incremental real para `sklearn_regressor` com `FeatureHasher` e `SGDRegressor.partial_fit`. A ADR 0048 adicionou continuação local de boosters XGBoost para classificação textual e regressão tabular. A ADR 0049 adicionou retreino incremental para SentenceTransformers com embeddings congelados e estimadores `SGDClassifier`/`SGDRegressor`. O novo run mantém `baseRunId`, `trainingMode: "incremental"`, resumo `incremental`, metadados por modelo e metadados no artefato gerado.

Para backends sem atualização incremental local, o worker executa retreino completo com o lote atual e registra fallback explícito no resultado do modelo, sem fingir atualização incremental.

A Control API propaga o contrato opcional. A UI adiciona comandos de retreino incremental síncrono e por job usando o run selecionado como base.

## Consequências

- O Studio ganha caminhos reais de retreino incremental versionado para Naive Bayes stdlib, classificação textual scikit-learn, regressão tabular scikit-learn, XGBoost e SentenceTransformers com estimador incremental.
- O histórico de runs preserva lineage entre o run base e o run retreinado.
- Backends batch continuam corretos e transparentes, mas ainda precisam de implementação incremental específica se isso virar requisito para cada algoritmo.
