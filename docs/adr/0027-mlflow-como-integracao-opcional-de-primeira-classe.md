# MLflow como integração opcional de primeira classe

Decidimos que MLflow deve se encaixar como integração self-hosted opcional de primeira classe para experiment tracking, model registry e artifact tracking, mas não como substituto do MLOps Flow Studio. O Studio continua responsável por autoria visual, DAG, rule builder, codegen, debug, runtime autônomo e reimportação; o runtime gerado não deve depender de MLflow para predizer.

## Consequências

- O Studio deve manter uma representação própria e versionável do projeto em `project.yaml`, `pipeline.flow.json` e `.mlops/`.
- O histórico mínimo de treino, métricas, evidências de promoção e artefatos precisa existir mesmo quando MLflow estiver desligado.
- Quando MLflow estiver habilitado, ele deve sincronizar experiments, runs, métricas, artefatos e versões de modelo, sem virar requisito para executar o container gerado.
- A primeira integração operacional registra runs, métricas numéricas e artefatos de treino no MLflow a partir do worker quando `runtime.mlflow.enabled` estiver ativo, `mlflow` estiver instalado e a tracking URI estiver resolvida.
- Quando MLflow estiver habilitado mas indisponível, o treino deve continuar e retornar `mlflow.status` com motivo explícito, sem impedir persistência local.
- A Control API expõe status MLflow por projeto resolvendo `trackingUriRef`, testando `/health`, verificando pacote `mlflow` no Python do worker, compose local opcional e último run persistido.
- A Control API também consulta o REST API do MLflow para listar experimentos, runs, registered models e model versions quando o servidor está online, sem depender do pacote Python `mlflow`.
- O catálogo inclui links de navegação best-effort para a UI do MLflow, mas esses links não são requisito para o runtime gerado nem para o Studio funcionar.
- A Control API expõe ações mutáveis confirmadas para definir alias, apagar alias e transicionar estágio de model version no registry externo. Essas ações exigem `confirm: true` e tracking URI resolvida.
- A UI mostra status, catálogo e ações comuns de registry MLflow na aba Runtime sem exigir MLflow online para o Studio funcionar.
- O rule builder visual continua sendo a fonte de decisão de promoção na experiência do Studio; MLflow pode armazenar ou refletir essa decisão via tags, aliases e registry.
- Promoções automáticas futuras devem chamar essas ações somente depois de evidência aprovada pelo rule builder, mantendo a decisão explicável no Studio antes de refletir o estado no MLflow.
- A aplicação manual de promoção grava primeiro a decisão local e tenta sincronizar alias/estágio no MLflow como best-effort quando consegue resolver a model version correspondente.
- O runtime exportado deve expor endpoints simples como `/metrics/model`, `/models/active` e `/promotion/status`, consumindo metadados e artefatos embarcados ou uma integração configurada, mas mantendo modo standalone.

## Mapeamento Inicial

- `training_result` local equivale a um run de experimento.
- `leaderboard` local equivale à comparação de modelos de um run.
- `promotionEvidence` local equivale à decisão explicável de promoção.
- `mlflow.runId` dentro de `training_result` aponta para o run externo quando o registro remoto/local foi bem-sucedido.
- Artefatos em `.mlops/artifacts/training_runs/` são o fallback local para artifact store.
- O runtime standalone deve preferir o artefato de modelo embarcado para inferência quando o formato for suportado e usar fallback determinístico apenas quando não houver modelo carregável.
- `bestModelId` e estados de promoção podem mapear para aliases/tags como `challenger`, `champion`, `rejected` e `production`, mas o alias no MLflow não substitui a decisão local registrada no Studio.
