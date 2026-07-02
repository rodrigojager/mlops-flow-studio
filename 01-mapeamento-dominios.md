# Mapeamento entre Agent Flow Studio e a plataforma MLOps

Este arquivo traduz os conceitos do repositório atual para os conceitos da nova plataforma MLOps. O objetivo é permitir que alguém que domina o Agent Flow Studio se sinta confortável na nova ferramenta.

## Equivalência de domínio

| Agent Flow Studio | Nova plataforma MLOps | Como reaproveitar |
| --- | --- | --- |
| `agent.flow.json` | `project.yaml`, `pipeline.flow.json` ou `training.pipeline.json` | Manter uma especificação declarativa versionável, validada por schema. |
| Flow de agente | Pipeline de ML ou pipeline de inferência | Trocar nós de agente por etapas de ingestão, validação, features, treino, avaliação, backtest, empacotamento e deploy. |
| Nó do flow | Etapa do pipeline | Reaproveitar UI de nós, inspector, status e validação. |
| Aresta | Dependência/ordem de execução | Reaproveitar condições e destaque visual por execução. |
| Prompt Markdown | Manifesto, template, model card, config de feature ou script documentado | A ideia é arquivo externo versionável, não prompt em si. |
| Schema JSON | Schema de dados, input/output de inferência, dataset contract, feature contract | Copiar padrão de arquivos JSON Schema referenciados. |
| Runtime manifest | Manifesto de bundle de modelos/APIs | Adaptar `runtime.manifest.json` para agrupar múltiplas APIs/modelos. |
| Sandbox LangGraph | Sandbox de treino, avaliação ou inferência | Reaproveitar separação entre pacote de teste e runtime final. |
| API Docker final | API de inferência Docker | Reaproveitar codegen, Dockerfile, compose, `/health`, `/metadata`, `/docs`, smoke test. |
| Aprovação por hash | Aprovação de modelo/container por evidência | Copiar hash de projeto e bloqueio de geração/publicação quando artefatos mudam. |
| Studio run | Pipeline run, experiment run, backtest run ou simulation run | Reaproveitar timeline, state snapshots, diffs e comparação. |
| Node IO | Input/output de etapa | Mostrar input/output de ingestão, features, treino, avaliação, predição e container. |
| Transcript | Prediction log ou relatório visível | No MLOps, não há conversa como regra; separar relatório visível de eventos operacionais. |
| Events | Eventos operacionais de execução | Copiar padrão diretamente. |
| Causalidade no grafo | Causa de falha em pipeline ou degradação | Reaproveitar upstream, impacto e nós impactados. |
| `generated/` | Artefatos gerados: APIs, containers, templates, relatórios | Manter inspeção, preview e zip. |
| `examples/` | Projetos MLOps de referência | Criar exemplos de churn, suporte e regressão de preço. |

## Mapeamento para o plano MLOps

| Plano MLOps | Base existente no Agent Flow Studio | Observação |
| --- | --- | --- |
| Control Plane | `apps/builder-api/src/server.ts`, `workspace.ts` | O código atual é Fastify/TypeScript; pode ser copiado como API local ou reescrito em FastAPI mantendo os padrões. |
| Project Registry | `flows/`, `agent.flow.json`, `runtime.manifest.json` | Criar `projects/{id}/project.yaml` e `pipelines/*.json`. |
| Data Registry | `schemas/`, assets referenciados, validação estruturada | Precisa de novo schema/tabelas, mas o padrão de asset versionável é reaproveitável. |
| Feature Registry | Nós `transform_json`, `file_extract`, `rag_retrieval` como inspiração | Criar contratos de feature set e stages de feature engineering. |
| Experiment Engine | `studio-runs.ts` e comparação de runs | Adaptar para comparar métricas, parâmetros, datasets e latência. |
| Model Registry | Aprovação por hash, artefatos e manifests | Criar entidades `model_versions`, `status`, `metrics`, `artifact_uri`, `container_image`. |
| Container Registry | `DockerRuntimeManager`, `.agent-flow/generated-meta.json` | Adaptar para `container_manifest.yaml`, `/metadata`, `/predict`, `/predict/batch`. |
| Reimportação de container | Import/export de workspace e inspeção de artefatos | Ainda não há importação de container real, mas há base de validação, preview, zip e path safety. |
| Sandbox para simulação | `SandboxManager`, Studio Local | Trocar sessão/turno por lote de amostras, predição e backtest. |
| Shadow, canary, rollback | Status, histórico Docker, aprovação | Precisa de domínio novo, mas o estado operacional e histórico já são bons modelos. |
| Rastreabilidade de predições | Eventos, idempotência, tabelas públicas | Adaptar `AgentEvent` e `AgentMessage` para `prediction_logs`, `pipeline_events`, `model_events`. |
| Monitoramento e drift | `analytics`, `scoring`, Studio runs | Criar eventos e relatórios específicos de drift, performance e qualidade de dados. |
| Segurança e governança | API key, secrets por env var, `.env.example`, não exportar `.env` | Copiar a disciplina de segredo fora de hash e artefato público. |

## Fluxo de produto recomendado

Preserve o mesmo modelo mental do Agent Flow Studio, mas com nomes MLOps:

```text
Projetos -> Dados -> Pipelines -> Experimentos -> Modelos -> Containers -> Monitoramento
```

Um fluxo mínimo equivalente ao plano:

1. Criar projeto de ML.
2. Definir fontes de dados.
3. Validar schema e qualidade.
4. Gerar features.
5. Rodar experimentos candidatos.
6. Comparar leaderboard.
7. Rodar backtest ou simulação.
8. Aprovar uma versão.
9. Gerar API de inferência Docker.
10. Fazer smoke test com `/predict`.
11. Registrar predições e eventos.
12. Reimportar container ou projeto por manifesto.

## Termos que devem ser familiares entre as ferramentas

Use a mesma estrutura visual e termos técnicos quando eles continuarem corretos:

- `Artefatos`
- `Runtime`
- `Studio`
- `Runs`
- `Logs`
- `Eventos`
- `Aprovação`
- `API Docker`
- `Manifesto`
- `Schema`
- `Sandbox`
- `Smoke`

Troque termos específicos de agente:

- `Flow` por `Pipeline` ou `Projeto`.
- `Agent` por `Modelo`, `Pipeline` ou `API`.
- `Sessão` por `Execução`, `Experimento`, `Backtest` ou `Simulação`.
- `Turno` por `Step`, `Batch`, `Amostra` ou `Predição`.
- `Transcript` por `Relatório`, `Resultado` ou `Prediction log`.
