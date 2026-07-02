# 0046 - Retreino Incremental Scikit-learn Textual

## Status

Aceita

## Contexto

A ADR 0039 adicionou retreino incremental real para `standard_lib_text_naive_bayes` e fallback explícito para backends batch. O backend `sklearn_text_classifier` ainda usava `TfidfVectorizer` com `LogisticRegression`, uma combinação treinada por lote e sem atualização incremental segura na implementação local.

O plano pede retreino controlado, lineage e transparência sobre quando o modelo foi realmente atualizado.

## Decisão

O backend `sklearn_text_classifier` passa a usar uma composição incremental:

- `HashingVectorizer` para representação textual sem vocabulário treinado;
- `MultinomialNB.partial_fit` como classificador incremental;
- `modelBase64` continua contendo um estimador scikit-learn compatível com `predict` e `predict_proba`;
- `vectorizerBase64`, `classifierBase64` e `incrementalCapable: true` são gravados no artefato para permitir atualização posterior;
- quando `incremental: true` encontra um artefato base compatível, o worker carrega vetorizador/classificador e aplica `partial_fit` no lote novo;
- quando o artefato base não é compatível, o worker retreina com o lote atual e registra fallback explícito.

O resultado mantém `baseRunId`, `baseArtifactUri`, `updateRows`, `validationRows`, estratégia aplicada e resumo em `incremental.appliedModels`.

## Consequências

Projetos textuais que usam `framework: sklearn` ou `algorithm: logistic_regression` passam a ter retreino incremental real via scikit-learn, preservando predição por artefato no Studio e no runtime gerado.

A troca muda o algoritmo treinado efetivo para `hashing_multinomial_nb`, mesmo quando o campo visual ainda carrega um algoritmo histórico como `logistic_regression`. Esse detalhe aparece em `trainedAlgorithm`.

A ADR 0049 removeu o fallback obrigatório de SentenceTransformers ao adicionar uma estratégia incremental própria para os estimadores sobre embeddings.
