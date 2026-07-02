# 0047 - Retreino Incremental Scikit-learn para Regressão

## Status

Aceita

## Contexto

A ADR 0039 definiu retreino incremental local com lineage e fallback explícito para backends sem atualização incremental segura. A ADR 0046 resolveu o backend textual `sklearn_text_classifier`, mas o backend `sklearn_regressor` ainda usava `DictVectorizer` com `Ridge`, uma composição batch sem `partial_fit`.

O plano pede regressão supervisionada e retreino controlado. Para manter o runtime autônomo e a avaliação local compatíveis, o artefato de regressão precisa continuar expondo um estimador scikit-learn serializado em `modelBase64` capaz de responder a `predict([dict])`.

## Decisão

O backend `sklearn_regressor` passa a usar uma composição incremental:

- `FeatureHasher` para representar dicionários de features sem vocabulário treinado;
- `SGDRegressor.partial_fit` como regressor incremental;
- `modelBase64` continua contendo um `Pipeline` scikit-learn compatível com `predict([dict])`;
- `vectorizerBase64`, `regressorBase64` e `incrementalCapable: true` são gravados no artefato para permitir atualização posterior;
- quando `incremental: true` encontra um artefato base compatível, o worker carrega hasher/regressor e aplica `partial_fit` no lote novo;
- quando o artefato base não é compatível, o worker retreina com o lote atual e registra fallback explícito.

O resultado mantém `baseRunId`, `baseArtifactUri`, `updateRows`, `validationRows`, estratégia aplicada e resumo em `incremental.appliedModels`.

## Consequências

Projetos de regressão que usam `framework: sklearn`, `algorithm: ridge_regression` ou `algorithm: linear_regression` passam a ter retreino incremental real via scikit-learn, preservando predição por artefato no Studio e no runtime gerado.

A troca muda o algoritmo treinado efetivo para `feature_hasher_sgd_regressor`, mesmo quando o campo visual ainda carrega um algoritmo histórico como `ridge_regression`. Esse detalhe aparece em `trainedAlgorithm`.

A ADR 0049 removeu o fallback obrigatório de SentenceTransformers ao adicionar uma estratégia incremental própria para os estimadores sobre embeddings.
