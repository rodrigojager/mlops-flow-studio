# 0049 - Retreino Incremental SentenceTransformers

## Status

Aceita

## Contexto

A ADR 0039 definiu retreino incremental local com lineage e fallback explícito para backends sem atualização incremental segura. Os caminhos de Naive Bayes stdlib, scikit-learn e XGBoost já tinham estratégias incrementais. O backend SentenceTransformers ainda usava embeddings opcionais com estimadores batch (`LogisticRegression` e `Ridge`), então o retreino incremental era tratado como fallback.

O plano pede embeddings/BERT quando configurado, mas o runtime gerado precisa continuar autônomo e consumir o mesmo artefato serializado em `modelBase64`. Como fine-tuning real de BERT depende de ambiente online/GPU e custo maior, a estratégia incremental local deve atuar sobre embeddings congelados.

## Decisão

O backend SentenceTransformers passa a usar estimadores incrementais sobre embeddings:

- `SGDClassifier(loss="log_loss").partial_fit` para classificação textual;
- `SGDRegressor.partial_fit` para regressão;
- `modelBase64` continua contendo o estimador scikit-learn compatível com `predict`;
- `incrementalCapable: true`, `trainingRows`, `embeddingModel` e `normalizeEmbeddings` são gravados no artefato;
- quando `incremental: true` encontra artefato base compatível, o worker recalcula embeddings do lote novo com o mesmo modelo/configuração e aplica `partial_fit`;
- quando a configuração de embedding mudou, o artefato base não é compatível ou surgem classes novas na classificação, o worker retreina com o lote atual e registra fallback explícito.

O resultado mantém `baseRunId`, `baseArtifactUri`, `updateRows`, `validationRows`, estratégia aplicada e resumo em `incremental.appliedModels`.

## Consequências

Projetos que usam SentenceTransformers para classificação textual ou regressão passam a ter retreino incremental local com lineage sem mudar o formato consumido pelo Studio e pelo runtime gerado.

Essa decisão não implementa fine-tuning de BERT nem valida download/modelo real em ambiente online/GPU. Ela congela o encoder e atualiza o estimador supervisionado sobre os embeddings.
