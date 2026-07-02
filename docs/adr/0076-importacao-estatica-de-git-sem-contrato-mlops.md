# 0076 - Importação estática de Git sem contrato MLOps

## Status

Aceita

## Contexto

A importação por Git já suportava repositórios com `.mlops` ou `app/metadata`, mas repositórios sem contrato MLOps eram recusados. O plano mantém engenharia reversa profunda fora do MVP, porém há valor em representar runtimes externos quando o repositório expõe sinais estáticos suficientes ou, no mínimo, quando o operador aceita explicitamente um contrato black-box genérico.

## Decisão

Repositórios Git externos sem `.mlops` ou `app/metadata` podem ser importados como projeto black-box sintético quando tiverem OpenAPI com endpoints, Dockerfile com labels MLOps, Compose com labels MLOps, rotas FastAPI/Flask/Starlette/Django detectáveis em arquivos Python, servidores HTTP legados detectáveis por `http.server`/`wsgiref`, rotas Express/Fastify/Koa/Hono/NestJS/Next.js detectáveis em arquivos JavaScript/TypeScript, rotas Go detectáveis em arquivos `.go`, rotas Ruby/Rails/Sinatra/Grape detectáveis em arquivos `.rb`, rotas Java/Spring MVC/JAX-RS detectáveis em arquivos `.java`, rotas ASP.NET Core detectáveis em arquivos `.cs`, rotas PHP/Laravel/Slim/Symfony detectáveis em arquivos `.php` ou gRPC em arquivos `.proto`, com fallback para endpoints `/grpc/{Service}/{Method}` quando não há `google.api.http`. A importação exige `confirmExternalSource: true`. Por padrão, lê apenas arquivos estáticos, não executa código, não sobe servidor e não roda container.

Como extensão controlada, quando o repositório tem Dockerfile, `MLOPS_STUDIO_GIT_DOCKERFILE_OPENAPI_SANDBOX=true` está habilitado e o request informa `confirmSandboxExecution: true`, o Studio pode construir uma imagem temporária com `docker build --network none --pull=false` e executar somente o probe OpenAPI estático com `docker run --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --entrypoint sh`. Esse modo procura arquivos OpenAPI embarcados, não executa o entrypoint original, não sobe servidor do runtime, remove a imagem temporária ao final e registra `sandboxOpenApi`, `git_dockerfile_openapi_sandbox`, `noApplicationEntrypointRun` e `containerSandboxInspection` nos metadados.

Quando nenhum sinal estático é encontrado, a importação ainda pode criar um projeto Git black-box genérico, mas somente com `confirmBlackBox: true`. Nesse modo o Studio não declara endpoints observados, usa `/predict` apenas como placeholder editável da fonte API, registra o sinal `generic_git_repository` e grava limitações explícitas no `.mlops/git-static-inspection.json` e no `.mlops/generated-meta.json`.

O Studio gera `project.yaml`, `pipeline.flow.json`, `.mlops/runtime.manifest.json`, `.mlops/generated-meta.json` e `.mlops/git-static-inspection.json`, preservando endpoints observados, sinais usados e limitações.

## Consequências

O canvas passa a mostrar um DAG sintético para teste e observabilidade manual de runtimes Git sem contrato. A importação continua sem recuperar pipeline interno, artefatos de treino, dados, dependências reais ou código customizado.

Engenharia reversa automática profunda de runtimes sem OpenAPI, labels, rotas estáticas ou OpenAPI embarcado em Dockerfile, inferência completa de métodos HTTP em Django/DRF, análise de roteamento Express/Go/Ruby/Java/ASP.NET Core/PHP/gRPC dinâmico e execução do servidor real do runtime seguem fora do escopo desta decisão. O fallback genérico serve apenas para materializar um contrato editável e auditável no canvas.
