# MLOps Flow Studio — fábrica visual de modelos e APIs de inferência

Workspace de planejamento e inicialização para uma plataforma MLOps que transforma dados em modelos, modelos em APIs FastAPI, APIs em containers Docker e containers em artefatos reimportáveis, auditáveis e continuamente melhoráveis.

## Rules

- Preserve UTF-8 em todos os arquivos editados.
- Use acentos reais em português brasileiro; não use entidades HTML para letras acentuadas.
- Reaproveite o máximo possível de `C:\Users\rodrigo.pinheiro\Desktop\agent-flow-studio` por duplicação/adaptação local, não por importação compartilhada.
- Não carregue nomes de domínio antigos sem adaptação: `agent`, `flow`, `session`, `turn` e `transcript` devem virar termos MLOps quando fizer sentido.
- Separe Control Plane, workers de jobs pesados e runtime final de inferência.
- O runtime exportado deve rodar independente do Studio e deve ser reimportável por manifesto.
- Todo modelo, dataset, feature set, experimento, container e predição relevante deve ser versionável e rastreável.
- Decisões difíceis de reverter devem ser registradas em ADR.

## Folder Map

```text
mlops flow studio/
├── IDENTITY.md                         # Layer 0: identidade, regras e mapa ICM
├── CONTEXT.md                          # Layer 1: roteamento principal para sessões LLM
├── CONTEXT-MAP.md                      # mapa dos contextos carregáveis
├── README.md                           # síntese dos materiais de reaproveitamento
├── plano_plataforma_mlops.txt          # plano mestre original do produto MLOps
├── 01-mapeamento-dominios.md           # equivalências entre Agent Flow Studio e MLOps
├── 02-codigo-reaproveitavel.md         # arquivos e padrões copiáveis
├── 03-ui-ux-reaproveitavel.md          # padrões de interface a preservar
├── 04-contratos-manifestos.md          # contratos, manifestos, hash e aprovação
├── 05-runtime-backend-containers.md    # backend, runtime, Docker e smoke test
├── 06-roadmap-de-duplicacao.md         # roteiro inicial de duplicação
├── package.json                        # monorepo npm com workspaces e scripts principais
├── package-lock.json                   # lockfile npm gerado para a base atual
├── tsconfig.base.json                  # base TypeScript compartilhada
├── tsconfig.json                       # entrada de typecheck do monorepo
├── apps/                               # aplicações: control-api, mlops-ui e worker
├── packages/                           # pacotes: mlops-spec e codegen-inference-api
├── projects/                           # projetos MLOps versionáveis de desenvolvimento local
├── examples/                           # exemplos executáveis de projetos MLOps
├── infra/                              # infraestrutura opcional, incluindo MLflow local
├── generated/                          # runtimes, APIs, containers e relatórios gerados
├── tools/                              # verificadores, auditorias e scripts auxiliares
└── docs/
    ├── CONTEXT.md                      # roteamento da documentação
    ├── plan.md                         # plano revisado e consolidado
    ├── implementation-status.md        # estado atual do workspace
    ├── domain/                         # linguagem do domínio MLOps
    └── adr/                            # decisões arquiteturais
```

## Current Status

Workspace inicializado como ICM em 2026-06-30. A base executável já inclui monorepo npm, contratos `mlops-spec`, Control API, UI React Flow, worker Python, preview/treino real de APIs paginadas por página ou cursor, integração MLflow opcional, jobs assíncronos com fila FIFO local persistida ou fila filesystem compartilhada para múltiplos hosts coordenados por claims/slots, concorrência configurável, runner destacado retomável após restart da Control API, recuperação explícita de jobs interrompidos e replay automático de snapshots de dataset em jobs distribuídos quando a fonte original não está disponível, observabilidade na UI para fila compartilhada e storage de snapshots, smoke operacional de embeddings/BERT por `GET /environment/embedding`, inspeção read-only de runtimes remotos por `POST /runtime/remote/inspect`, importação black-box controlada de runtime remoto observável por `POST /projects/import-runtime` com `remoteBaseUrl` e confirmação explícita, importação controlada de repositório Git com `.mlops` ou `app/metadata` por `sourceGitUrl`, importação estática de repositório Git sem contrato MLOps quando há OpenAPI, Dockerfile, Compose, gRPC, servidor HTTP legado ou rotas FastAPI/Flask/Starlette/Django/Express/Fastify/Koa/Hono/NestJS/Next.js/Go/Ruby/Java/ASP.NET Core/PHP analisáveis e confirmação explícita, importação controlada de imagem Docker por `sourceDockerImage` com `docker image inspect`, sanitização de `Config.Env` e probe OpenAPI sandboxado opcional quando habilitado, execução de blocos Python isolada por subprocesso com timeout ou por container Docker com política `none`/`allowlist`/`open`, avaliação local com snapshots, manifestos de dataset versionado e snapshots replayáveis opcionais com retenção/expurgo local, archive/restore por storage externo filesystem ou S3/MinIO e criptografia AES-GCM opcional por chave referenciada para treinos CSV/SQL/API, retreino incremental local com lineage para Naive Bayes stdlib, `sklearn_text_classifier`, `sklearn_regressor`, XGBoost e SentenceTransformers com estimador incremental, backtest local comparativo por fontes com janela temporal simples, comparação entre períodos arbitrários, agregações diária/semanal/mensal e janelas móveis de 7/30 dias, codegen de runtime FastAPI autônomo com pacote `.mlops` contendo manifestos canônicos de fontes de dados, dataset, feature set, experimento, treino, política de promoção, model card, API, container e orquestração opcional Prefect/Celery, feedback de labels reais por `POST /feedback`, resumo por `GET /feedback/summary`, solicitação/aprovação auditável de retreino controlado por `/retraining/*`, dataset de feedback por `GET /retraining/requests/{request_id}/training-set`, conclusão externa auditável por `POST /retraining/requests/{request_id}/complete`, shadow/canary/rollback no runtime gerado por `/deployment/*`, disparo de job incremental real no Studio a partir de request aprovado com conclusão automática do request remoto após o job e promoção controlada do modelo retreinado no projeto do Studio, `POST /evaluate`, `POST /backtest` e drift básico persistidos, exportação/reimportação de zip gerado, importação white-box por `app/metadata` e importação black-box remota como projeto sintético auditável, além do exemplo/projeto `support_ticket_classification`. O plano revisado consolidado continua em `docs/plan.md`.
