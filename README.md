# Sugestões de reaproveitamento para a nova plataforma MLOps

Este material analisa o que existe no Agent Flow Studio e aponta o que pode ser copiado, duplicado ou usado como base para uma nova ferramenta independente de MLOps, conforme o plano em `../plano_plataforma_mlops.txt`.

A conclusão principal é que o repositório atual não deve ser reaproveitado como biblioteca compartilhada, mas contém uma base muito útil de produto, arquitetura, UI e código para uma plataforma que também precisa transformar uma especificação declarativa em artefatos executáveis, testáveis, aprováveis, empacotáveis e operáveis em Docker.

## Estado atual

Este workspace foi inicializado como ICM e já contém o primeiro incremento executável. Os pontos de entrada agora são:

- [IDENTITY.md](./IDENTITY.md): identidade, regras e mapa do workspace.
- [CONTEXT.md](./CONTEXT.md): roteamento principal para sessões LLM.
- [docs/plan.md](./docs/plan.md): plano revisado e melhorado para implementação.
- [docs/domain/CONTEXT.md](./docs/domain/CONTEXT.md): linguagem de domínio MLOps.
- [packages/mlops-spec](./packages/mlops-spec/CONTEXT.md): contratos Zod, catálogo de métricas e diagnósticos.
- [packages/codegen-inference-api](./packages/codegen-inference-api/CONTEXT.md): gerador de runtime FastAPI autônomo.
- [apps/control-api](./apps/control-api/CONTEXT.md): API local do Studio.
- [apps/desktop](./apps/desktop/CONTEXT.md): shell Electron para abrir o Studio como app local.
- [apps/mlops-ui](./apps/mlops-ui/CONTEXT.md): UI visual com canvas e inspector.
- [apps/worker](./apps/worker/CONTEXT.md): worker Python para preview, sandbox de bloco e treino baseline.
- [projects/support_ticket_classification](./projects/support_ticket_classification/CONTEXT.md): cópia de trabalho carregável no Studio.
- [examples/support_ticket_classification](./examples/support_ticket_classification/CONTEXT.md): exemplo multiclasse inicial.

## Leitura recomendada

- [01-mapeamento-dominios.md](./01-mapeamento-dominios.md): equivalências entre Agent Flow Studio e a plataforma MLOps.
- [02-codigo-reaproveitavel.md](./02-codigo-reaproveitavel.md): arquivos, funções, classes e padrões que podem ser copiados.
- [03-ui-ux-reaproveitavel.md](./03-ui-ux-reaproveitavel.md): aprendizados de interface e experiência que devem ser preservados.
- [04-contratos-manifestos.md](./04-contratos-manifestos.md): como adaptar Flow Spec, manifestos, hash e aprovação para MLOps.
- [05-runtime-backend-containers.md](./05-runtime-backend-containers.md): padrões de API, sandbox, jobs, runtime Docker e smoke test.
- [06-roadmap-de-duplicacao.md](./06-roadmap-de-duplicacao.md): sequência prática para iniciar o novo projeto copiando partes deste.

## Implementação Inicial

O primeiro corte implementado cobre:

1. Monorepo npm com workspaces.
2. `packages/mlops-spec` com contratos de projeto, DAG, fontes, métricas, promoção, runtime manifest e CLI.
3. `packages/codegen-inference-api` gerando FastAPI, dashboard, endpoints MLOps, schema operacional, Dockerfile, Compose com Postgres, testes e pacote `.mlops`.
4. `apps/control-api` para criar, salvar, validar, gerar e listar artefatos de projetos.
5. `apps/worker` para preview CSV/SQL/API mockável, execução de bloco Python e treino baseline.
6. `apps/control-api` integrada ao worker por JSON stdin/stdout.
7. `apps/mlops-ui` para autoria visual inicial com React Flow, preview, execução de bloco e treino baseline.
8. Projeto de trabalho `projects/support_ticket_classification` carregável pela UI.
9. Exemplo canônico `examples/support_ticket_classification` com 27 classes, CSV, SQL, API, XGBoost, embedding opcional, decisor Python e CSV sintético.

Comandos principais:

```powershell
npm install
npm run bootstrap:python
npm run bootstrap:python:optional # MLflow, sentence-transformers e XGBoost
npm run lint
npm run typecheck
npm run validate:example
npm run codegen:example
npm run test:control-api
npm run test:worker
npm run build:mlops-ui
npm run dev:control-api
npm run dev:mlops-ui
npm run dev:desktop
npm run start:desktop
npm run verify
```

Launcher local no Windows:

```powershell
.\start-mlops-flow-studio.cmd
```

Portas locais padrão:

- Control API: `http://127.0.0.1:3334`
- UI: `http://127.0.0.1:5273`

Desktop Electron:

```powershell
npm run dev:desktop      # desenvolvimento: Control API + Vite + Electron
npm run start:desktop    # produção local: build da UI + Electron
```

O shell Electron mantém a Control API separada do runtime FastAPI gerado. Ele apenas inicia o Studio local e carrega a UI buildada ou o servidor Vite no modo desenvolvimento.

## Segurança local e runtime

- Os launchers geram um token aleatório e o propagam entre a UI/Electron e a Control API. Ao iniciar a API isoladamente, defina `MLOPS_STUDIO_API_TOKEN` (mínimo de 24 caracteres) e passe o mesmo valor como `VITE_CONTROL_API_TOKEN` à UI.
- CORS aceita apenas origens loopback configuradas e `file://` autenticado; origens web externas são recusadas.
- O runtime FastAPI exige `MLOPS_RUNTIME_API_KEY` em Bearer token, exceto em `/health`, `/dashboard` e na documentação OpenAPI. O dashboard solicita essa chave e usa CSP estrita.
- O Compose publica somente a API em `127.0.0.1`; Postgres e Redis permanecem internos. Copie `.env.example` para `.env` e substitua todos os placeholders antes de subir um runtime fora do Studio.
- Segredos gerados pelo Docker Runtime Manager ficam em `.mlops-studio/runtime-secrets/`, fora de Git e dos artefatos exportáveis.

Validação completa e smokes reproduzíveis:

```powershell
npm run audit:visual
npm run test:generated
npm run smoke:runtime:docker -- --outDir generated/support-ticket-runtime --waitMs 180000
```

## Principais recursos aproveitáveis

1. Monorepo com separação entre `apps/`, `packages/`, `examples/`, `generated/`, `docs/` e `tools/`.
2. Especificação canônica em TypeScript/Zod com JSON Schema exportável.
3. Workspace local versionável baseado em arquivos, sem banco obrigatório para o builder no MVP.
4. Importação/exportação de workspace com proteção contra path traversal.
5. Codegen que transforma especificação declarativa em runtime Python/FastAPI/Docker.
6. Hash determinístico cobrindo especificação, schemas, prompts, arquivos e código customizado.
7. Gate de aprovação por hash antes de gerar o runtime final.
8. Separação entre sandbox de validação e runtime final Docker.
9. FastAPI runtime com `/health`, `/metadata`, OpenAPI, autenticação simples, idempotência e eventos.
10. Docker Runtime Manager com build, cancelamento, up, down, smoke, inspeção e histórico.
11. Sandbox local controlado pela API do builder.
12. Studio local com runs, eventos, state snapshots, diffs, comparação e cadeia causal.
13. UI com React Flow, inspector contextual, artefatos, runtime, tema claro/escuro e status por nó.
14. Design system e regras UX voltadas a ferramenta operacional, não landing page.
15. Testes de paridade, codegen, builder API, runtime Python e auditoria visual com Playwright.

## O que muda no domínio

No Agent Flow Studio, o objeto central é um agente visual com nós, arestas, sessões, eventos e runtime gerado. Na plataforma MLOps, o objeto central deve ser um projeto de ML com fontes de dados, pipelines, datasets, features, experimentos, modelos, versões, containers, predições e monitoramento.

Mesmo assim, a estrutura mental é parecida:

```text
Desenhar -> Testar -> Depurar -> Aprovar -> Gerar API Docker
```

vira:

```text
Definir projeto -> Ingerir dados -> Treinar/avaliar -> Aprovar modelo -> Gerar API Docker -> Monitorar/retreinar
```

## Regra para copiar código

Copie para a nova pasta do projeto MLOps e renomeie o domínio no código. Não importe diretamente de `agent-flow-studio`.

Exemplos:

- `flow-spec` pode virar `mlops-spec`.
- `builder-api` pode virar `control-api` ou `studio-api`.
- `builder-ui` pode virar `mlops-ui`.
- `codegen-langgraph` pode virar `codegen-inference-api`.
- `DockerRuntimeManager` pode virar `ContainerRuntimeManager`.
- `StudioRun` pode virar `MLOpsRun`, `PipelineRun` ou `ExperimentRun`.

## Cuidados

- Não copie nomes de domínio antigos sem adaptação: `agent`, `flow`, `session`, `turn`, `transcript` devem virar termos MLOps quando fizer sentido.
- Não carregue LangGraph como dependência central do novo runtime, a menos que a nova ferramenta realmente use grafos LangGraph. A ideia reutilizável é o padrão de codegen e runtime independente.
- Não misture a API de controle com a API de inferência. O plano MLOps deixa isso explícito e o repositório atual já demonstra a separação entre Builder API e runtime gerado.
- Preserve arquivos em UTF-8 e use acentos reais em português.
