# 0029 - Aplicação Manual de Promoção com Auditoria Local

## Status

Aceita

## Contexto

O plano define que a promoção no MVP é recomendada automaticamente pelas regras e aplicada manualmente. Até agora, o Studio calculava a recomendação, mostrava as evidências e permitia ações diretas no registry MLflow, mas não havia uma operação única de "aplicar promoção" que mudasse o modelo ativo do projeto e deixasse uma trilha local auditável.

MLflow pode refletir aliases e estágios, mas não deve ser a fonte única do estado operacional porque o runtime gerado precisa continuar autônomo e reimportável sem depender do servidor MLflow.

## Decisão

A Control API expõe `POST /projects/:projectId/promotion/apply` com `confirm: true`. A operação:

- escolhe o último treino ou o `runId` informado;
- valida a recomendação atual e bloqueia `review`/`reject` sem override explícito;
- promove o `candidateModelId` do leaderboard para `modelRole: active` no `pipeline.flow.json`;
- rebaixa o ativo anterior para `modelRole: baseline`;
- grava um arquivo JSON em `artifacts/promotion_decisions/` com run, evidências, modelo anterior, modelo novo, horário e resultado de sincronização externa;
- tenta sincronizar MLflow de forma best-effort quando há tracking URI e model version correspondente, usando alias `champion` e estágio `Production` por padrão.

A UI chama essa operação a partir da seção Promoção, atualiza a pipeline em memória e mantém o catálogo MLflow como reflexo externo opcional.

## Consequências

- O Studio passa a ter um estado aplicado de modelo ativo antes de gerar o runtime.
- A decisão fica versionável e reimportável como artefato local do projeto.
- MLflow continua complementar: falha ou ausência de model version não impede a promoção local.
- A promoção automática futura deve reutilizar o mesmo endpoint, apenas mudando quem fornece a confirmação e os overrides permitidos pela política.
