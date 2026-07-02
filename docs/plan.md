# Plano Consolidado — MLOps Flow Studio

## 1. Visão do Produto

O MLOps Flow Studio é uma ferramenta visual para montar, testar, gerar, operar localmente e reimportar aplicações MLOps autônomas. Ele reaproveita o modelo mental do Agent Flow Studio, mas troca o domínio de agentes por projetos de Machine Learning: dados, pipelines, modelos, métricas, promoção, observabilidade e containers.

A saída principal do produto não é só uma API `/predict`. A saída é uma aplicação FastAPI MLOps autônoma, containerizável, com dashboard operacional, Postgres, múltiplos modelos candidatos, endpoints MLOps, artefatos, manifestos e pacote de reimportação.

O fluxo guia é:

```text
visual -> treino -> comparação -> aprovação -> runtime autônomo -> Docker/Postgres -> smoke -> observabilidade -> reimportação
```

O runtime gerado deve rodar em outra máquina sem o Studio instalado. O Studio serve para autoria visual, debug, validação, geração, build, smoke, inspeção, comparação e reimportação. No futuro, o Studio pode se conectar a runtimes remotos para observabilidade, mas essa conexão é opcional.

## 2. Referências

### Agent Flow Studio

Reaproveitar por duplicação/adaptação, não como dependência compartilhada:

| Origem | Destino | Uso |
| --- | --- | --- |
| `packages/flow-spec` | `packages/mlops-spec` | Zod, JSON Schema, diagnóstico e metadados visuais. |
| `apps/builder-api` | `apps/control-api` | Workspace local, import/export, artefatos, sandbox, Docker manager e runs. |
| `apps/builder-ui` | `apps/mlops-ui` | Shell operacional, React Flow, inspector, statusbar, artefatos, runtime e Studio. |
| `packages/codegen-langgraph` | `packages/codegen-inference-api` | Codegen, templates, hash, aprovação e geração de runtime. |
| runtime FastAPI gerado | templates MLOps | FastAPI, settings, auth, idempotência, repo, models, cache e testes. |
| ferramentas de teste/auditoria | `tools/` | Paridade, smoke, pytest e auditoria visual Playwright. |

### Datathon Passos Mágicos

O repositório `https://github.com/rodrigojager/datathon-passos-magicos` é a referência concreta de saída. Ele demonstra uma aplicação FastAPI com Docker Compose, Postgres, ingestão, treino, comparação de modelos, predição, drift, logs, dashboard e artefatos `joblib`.

O MLOps Flow Studio deve conseguir gerar, adaptar ou reimportar aplicações desse tipo, com mais contrato, observabilidade e edição visual.

### MLflow

MLflow se encaixa como componente self-hosted integrado, não como substituto do Studio. Ele pode assumir tracking de experimentos, registro de modelos, versionamento de artefatos de modelo e comparação de runs, enquanto o MLOps Flow Studio continua responsável por autoria visual, DAG, rule builder, geração de runtime autônomo, pacote de reimportação, dashboard gerado e debug no canvas.

No MVP, MLflow deve ser tratado como integração opcional de primeira classe:

- Control API/worker podem logar parâmetros, métricas, tags e artefatos em MLflow.
- Modelos candidatos podem ser registrados no MLflow Model Registry.
- O Studio pode linkar para run/model version no MLflow UI.
- O runtime gerado deve continuar autônomo e não depender do MLflow para predizer.
- O Docker Compose de desenvolvimento pode oferecer serviço MLflow opcional, com backend Postgres e artifact store local/volume.

## 3. Princípios Fechados

- **Visual-first**: o usuário deve montar a maior parte do projeto pelo canvas, palette e inspector.
- **Dois caminhos de autoria**: manual canvas-first e assistido por wizard/copiloto. Os dois produzem os mesmos arquivos editáveis.
- **IA materializada**: IA interna ou agente externo pode gerar arquivos, mas o Studio deve renderizar tudo como grafo, contrato, código ou artefato inspecionável.
- **Runtime autônomo**: o runtime gerado não depende do Studio para rodar.
- **Sem SaaS no MVP**: multiusuário, tenants, RBAC e colaboração em tempo real ficam fora do primeiro corte.
- **Sem Kubernetes como premissa**: Kubernetes só entra se houver requisito real de infraestrutura.
- **Reimportação é central**: toda saída gerada inclui pacote de reimportação/reconfiguração.
- **Segurança por padrão**: segredos por referência, dados sensíveis mascarados e exports com aviso.
- **Observabilidade desde o MVP**: modelo ativo, métricas, promoção, prediction logs, eventos e drift básico devem ser visíveis.

## 4. Experiência Visual

O Studio deve se parecer com uma ferramenta operacional da mesma família do Agent Flow Studio:

```text
Topbar
Left panel / Palette
Canvas central
Inspector contextual
Statusbar
```

Abas iniciais:

```text
Projeto | Pipeline | Studio | Artefatos | Runtime | Settings
```

O usuário deve poder:

- arrastar blocos para o canvas;
- conectar etapas;
- configurar cada bloco no inspector;
- editar campos do projeto a qualquer momento;
- gerar pipeline por IA e editar o resultado;
- abrir arquivos gerados por agentes externos;
- validar specs e manifests;
- executar blocos/pipeline em sandbox;
- ver input/output, logs, métricas e artefatos;
- gerar runtime, buildar container, rodar smoke e reimportar.

### Estados Visuais

Estados de projeto/runtime:

- `draft`
- `dirty`
- `valid`
- `invalid`
- `tested`
- `approved`
- `approval_outdated`
- `generated`
- `built`
- `running`
- `smoke_passed`
- `smoke_failed`
- `imported`
- `active_model`
- `promotion_pending`

Estados no canvas:

- nó aguardando: neutro;
- nó em execução: contorno/progresso;
- nó concluído: contorno de sucesso;
- nó falhou: contorno de erro e link para logs;
- nó pulado: apagado com motivo;
- nó bloqueado: dependência indicada;
- aresta executada: realce de passagem de dados;
- bloco composto: estado agregado do pior estado interno.

Timeline hierárquica é complementar. O debug principal acontece no canvas.

### Preview de Input/Output

O inspector mostra preview seguro por padrão:

- schema/shape;
- contagens;
- primeiras amostras;
- estatísticas básicas;
- artefatos;
- logs curtos;
- erro/traceback;
- aviso de dados sensíveis.

Inspeção completa acontece via artefato, viewer dedicado, download ou amostra expandida.

## 5. Domínio e Escopo de Modelagem

O MVP deve suportar:

- classificação multiclasse, inclusive muitas classes, como 27;
- regressão supervisionada;
- pipelines multi-etapa;
- DAG de inferência com fan-out e fan-in;
- XGBoost;
- embeddings/BERT quando necessário;
- blocos Python determinísticos;
- regra condicional;
- composição de resposta final.

Exemplos de topologia:

```text
Entrada -> Tratamento -> Modelo -> Decisor determinístico -> Saída
```

```text
Entrada
  -> Modelo A
  -> Modelo B
  -> Modelo C
      -> Operador sobre saídas
      -> Decisor determinístico
      -> Saída
```

## 6. Contratos Canônicos

Contratos versionáveis desde o início:

- `project.yaml`: problema, target, métricas, fontes, políticas, responsáveis, risco e perfil de execução.
- `pipeline.flow.json`: DAG visual, etapas, arestas, parâmetros, posições, input/output.
- `data_source.yaml`: CSV/upload, SQL, API externa e conectores futuros.
- `dataset_manifest.yaml`: camada, versão, URI, schema hash, lineage e qualidade.
- `feature_set.yaml`: features, transformações, dependências e checks de leakage.
- `experiment_manifest.yaml`: algoritmo, parâmetros, métricas, artefatos e ambiente.
- `training_manifest.yaml`: datasets, feature set, métricas, aprovação e modelo treinado.
- `model_card.yaml`: uso pretendido, limitações, risco e monitoramento.
- `api_manifest.yaml`: endpoints, schemas, runtime e limites.
- `container_manifest.yaml`: compatibilidade, imagem, artefatos e smoke tests.
- `promotion_policy.yaml` ou seção equivalente: regras de promoção.
- `.mlops/generated-meta.json`: hash, origem, versão de codegen e pacote de reimportação.

O hash de aprovação cobre specs, pipelines, schemas, features, scripts, dependências, manifests, mocks e artefatos por digest. Segredos reais nunca entram no hash; referências a segredo entram.

## 7. Fontes de Dados

Fontes MVP:

- CSV/upload;
- banco SQL;
- API externa.

No MVP original, Playwright scraping ficava para depois. No pós-MVP atual, já existe scraping controlado de uma página raiz com login por formulário opcional, crawl interno e crawl profundo confirmado de mesma origem, relatório auditável, wizard de contrato antes da importação, validação OpenAPI com operações, schemas resumidos, descritores rasos de payload, exemplos sintéticos, smoke real controlado com validação de request/response, aplicação da operação no contrato e importação assistida como projeto black-box.

Conectores SQL devem ter query configurável, referência segura de conexão e preview de schema. Conectores de API externa devem ter método, URL, headers por referência de segredo, paginação simples e preview de resposta.

Segredos são sempre por referência, como `env:SUPPORT_API_TOKEN` ou `secret:POSTGRES_URL`.

## 8. Blocos, DAG e Regras

### Blocos Python

Blocos determinísticos e operadores podem ser funções Python editáveis no inspector:

```python
def run(input: dict, context: dict) -> dict:
    classe_ampla = input["classe_ampla"]
    score = input["score"]

    if score < 0.55:
        return {"decisao": "revisao_manual", "motivo": "score_baixo"}

    return {"decisao": f"seguir_{classe_ampla}", "motivo": "score_suficiente"}
```

Cada bloco declara:

- `input_schema`;
- `output_schema`;
- exemplos de teste;
- dependências Python extras, se houver;
- política de rede, se houver chamada externa;
- contrato/mock de API externa, quando aplicável.

O Studio executa em sandbox, mostra input/output/logs/erro e inclui o código no hash.

### Blocos Compostos

Blocos compostos encapsulam subgrafos. No MVP, a UI pode limitar a um nível, mas o modelo de dados, execução, hash e navegação devem suportar N níveis no futuro.

Um bloco composto tem contrato próprio de entrada/saída, estado agregado, input/output agregado e inspeção das etapas internas.

### Rule Builder Visual

Promoção, validação e roteamento condicional usam rule builder visual tipado:

- variáveis disponíveis por contexto;
- tipos: contínuo, discreto, booleano, categórico, relatório/matriz;
- operadores por tipo;
- thresholds;
- comparação contra valor absoluto, baseline, modelo ativo ou melhor anterior;
- grupos `AND`/`OR`;
- severidade: bloqueia, exige revisão ou alerta.

Quando o visual não cobre o caso, usa-se regra Python avançada, que retorna valores simples consumidos pelo rule builder.

### Chamadas Externas em Blocos

Política de rede:

- `none`: sem rede;
- `allowlist`: apenas hosts/rotas permitidos;
- `open`: exceção explícita para rede ampla.

Mesmo em `open`, registrar host, método, status, duração, timeout, erro e referência de segredo, sem vazar segredo real. Para teste, usar mocks baseados em contrato.

## 9. Observabilidade, Métricas e Promoção

Todo runtime gerado deve expor contrato MLOps mínimo:

| Endpoint | Responsabilidade |
| --- | --- |
| `GET /health` | Saúde técnica da app, banco e modelo. |
| `GET /metadata` | Identidade do runtime, projeto, versão, modelo ativo, hashes, dataset/feature set e backend de persistência. |
| `GET /model-card` | Uso pretendido, limitações, risco e monitoramento. |
| `GET /models` | Modelos/candidatos disponíveis. |
| `GET /models/active` | Modelo ativo, versão, threshold, métricas e artefatos. |
| `GET /metrics/model` | Métricas offline de treino/validação/teste. |
| `GET /metrics/runtime` | Métricas operacionais: predições, erros, latência, drift e versão ativa. |
| `POST /predict` | Predição com registro de run e modelo usado. |
| `POST /evaluate` ou `POST /backtest` | Avaliação com labels ou histórico. |
| `GET /promotion/status` | Resultado das regras de promoção. |

Promoção no MVP é recomendada automaticamente, mas aplicada manualmente. A UI mostra evidências:

- verde: melhoria relevante que conta para promoção;
- vermelho: regressão, violação ou risco;
- neutro: variação dentro do threshold, mesmo se numericamente melhor;
- texto, delta, ícone e motivo, nunca só cor.

## 10. Persistência e Schema Operacional

Persistência principal: PostgreSQL no Docker Compose gerado, em container separado da app FastAPI.

Também suportar:

- Postgres externo via `DATABASE_URL`;
- SQLite apenas como fallback de desenvolvimento quando permitido.

Tabelas mínimas:

| Tabela | Responsabilidade |
| --- | --- |
| `ingestion_runs` | Execuções de ingestão. |
| `dataset_versions` | Versões de dados raw, clean, features, splits e predictions. |
| `feature_set_versions` | Versões de features e transformações. |
| `training_runs` | Execuções de treino e candidatos avaliados. |
| `model_versions` | Modelos, status, artefatos, métricas e versão ativa. |
| `promotion_decisions` | Recomendação, aprovação, deltas, thresholds e evidências. |
| `prediction_runs` | Execuções de predição. |
| `prediction_rows` | Linhas preditas, output, modelo, digest/input mascarado e latência. |
| `evaluation_runs` | Avaliações e backtests. |
| `metric_snapshots` | Métricas offline e operacionais. |
| `drift_runs` | Relatórios e alertas de drift. |
| `app_events` | Eventos operacionais, logs estruturados e erros. |

MLflow não substitui esse schema operacional. Ele complementa tracking e registry, mas o runtime gerado ainda precisa das tabelas próprias para prediction logs, promotion decisions, runtime metrics, app events, drift e reimportação.

## 11. Dados Sensíveis e Segurança

Regras:

- schemas podem marcar `sensitive: true`;
- previews mascaram campos sensíveis;
- logs não gravam valores sensíveis completos;
- prediction logs guardam payload completo só se o projeto permitir explicitamente;
- padrão: payload mascarado + metadados + digest do input;
- exports e downloads avisam quando podem conter dados sensíveis;
- `.env` real nunca entra em export, hash ou pacote de reimportação;
- `.env.example` entra com nomes esperados;
- código customizado usa apenas campos e segredos permitidos.

## 12. Dependências e GPU/CUDA

Dependências Python são configuradas e visíveis no Studio:

- por projeto;
- por bloco;
- consolidadas em `requirements.txt` ou `pyproject.toml`;
- com origem por bloco;
- com diagnóstico de conflitos simples;
- incluídas no hash;
- destacando pacotes pesados como `torch`, `transformers` e `sentence-transformers`.

Perfis de execução:

- `cpu`;
- `gpu_cuda`;
- `auto`.

GPU/CUDA entra no MVP como opção. O notebook atual tem NVIDIA GeForce RTX 2050 com 4 GB de VRAM, driver funcional e Docker com runtime `nvidia`. O Studio deve mostrar smoke CUDA, uso de VRAM, impacto de build e fallback CPU.

No pós-MVP atual, embeddings SentenceTransformers/BERT continuam seguros por padrão: o worker usa encoder congelado com estimador incremental e registra um plano avançado de fine-tuning BERT/GPU quando `fineTuning` é configurado, incluindo device, epochs, batch, mixed precision, gradient checkpointing, limite de linhas e guarda ambiental `MLOPS_ENABLE_BERT_FINE_TUNING` antes de qualquer execução pesada.

## 13. Runtime Gerado

O runtime gerado contém:

- FastAPI;
- dashboard operacional;
- endpoints MLOps;
- schema operacional;
- modelos e artefatos;
- Dockerfile;
- Docker Compose com app e Postgres;
- `.env.example`;
- pacote `.mlops/` de reimportação;
- tests/pytest;
- `requirements.txt` ou `pyproject.toml`;
- metadata e manifests.

O runtime deve rodar fora do Studio e informar via `/metadata`:

- compatibilidade com a plataforma;
- versão do contrato;
- modelo ativo;
- backend de persistência;
- perfil de execução CPU/GPU;
- dependências críticas;
- chamadas externas reais e mocks disponíveis;
- hashes/digests de artefatos.

## 14. Dashboard Gerado

Páginas padrão:

- Visão geral;
- Dados;
- Modelos;
- Predição;
- Monitoramento;
- Logs/eventos;
- Docs/metadata.

No MVP, o Studio permite:

- ativar/desativar páginas;
- escolher métricas destacadas;
- selecionar modelo/pipeline padrão de teste;
- definir rótulos amigáveis;
- preservar configuração no pacote de reimportação.

## 15. Reimportação

Toda saída gerada inclui pacote de reimportação/reconfiguração, mesmo com overhead:

- specs;
- manifests;
- schemas;
- contratos de blocos;
- código customizado permitido;
- mocks/contratos de APIs externas;
- dependências;
- mapa de artefatos com digests;
- `.mlops/generated-meta.json`.

No MVP, reimportar pasta local ou zip gerado pela própria ferramenta. No pós-MVP atual, imagem Docker, runtime remoto black-box, Git com sinais estáticos, Git sem sinais estáticos por fallback black-box genérico confirmado e Git/Dockerfile com probe OpenAPI sandboxado opt-in já existem. Engenharia reversa profunda por execução automática do servidor do runtime continua fora do corte.

## 16. Arquitetura do Repositório

Estrutura alvo:

```text
apps/
  control-api/
  worker/
  mlops-ui/
packages/
  mlops-spec/
  codegen-inference-api/
projects/
examples/
generated/
tools/
docs/
```

`worker` pode começar como módulo/CLI chamado pela Control API. O primeiro incremento de execução longa usa jobs na Control API para preview, blocos Python, treino baseline, avaliação e backtest, com runner destacado, status, eventos estruturados, stdout/stderr, cancelamento, requests e snapshots em `.mlops-studio/worker-jobs/`. Fila persistente externa só vira obrigatória quando houver necessidade de múltiplos workers, retomada após queda do próprio runner ou da máquina, auditoria completa ou execução distribuída. No pós-MVP atual, o runtime gerado já inclui overlay opcional `docker-compose.orchestration.yml` com Redis, worker Celery e servidor Prefect em profile, sem tornar isso dependência do runtime mínimo.

MLflow pode entrar como perfil opcional de infra local:

```text
infra/
  docker-compose.mlflow.yml
```

ou como serviço opcional no compose de desenvolvimento, sem virar dependência obrigatória do runtime exportado.

## 17. Fases de Implementação

### Fase 0 — Base do Monorepo

- `package.json`, workspaces e TypeScript base.
- `.gitignore`.
- estrutura `apps/`, `packages/`, `projects/`, `examples/`, `generated/`, `tools/`.
- scripts placeholders.

### Fase 1 — `packages/mlops-spec`

- schemas Zod;
- tipos de problema;
- tipos de etapa;
- DAG com fan-out/fan-in;
- metadados visuais;
- diagnósticos;
- CLI;
- JSON Schema.

### Fase 2 — `apps/control-api`

- workspace local de projetos;
- import/export;
- validação;
- artefatos;
- runs;
- sandbox;
- Docker runtime manager;
- reimportação inicial.

### Fase 3 — `apps/mlops-ui`

- shell visual;
- palette MLOps;
- canvas React Flow;
- inspector;
- statusbar;
- debug visual no grafo;
- rule builder;
- editor de bloco Python;
- dependências;
- perfil CPU/GPU;
- tema claro/escuro.

### Fase 4 — Ciclo Python MLOps

- ingestão CSV/SQL/API;
- validação;
- features;
- classificação multiclasse;
- regressão;
- XGBoost;
- embeddings/BERT quando configurado;
- blocos Python;
- leaderboard;
- integração opcional com MLflow Tracking e Model Registry;
- promoção manual;
- persistência operacional.

### Fase 5 — Codegen de Runtime

- aplicação FastAPI autônoma;
- endpoints MLOps;
- dashboard;
- schema operacional;
- Dockerfile;
- Compose com Postgres;
- pacote `.mlops/`;
- testes.

### Fase 6 — Docker, Smoke e Reimportação

- build/up/down/inspect/logs/history;
- smoke completo;
- reimportação de pasta/zip;
- validação de manifestos;
- renderização de volta no canvas.

### Fase 7 — Exemplos

- `support_ticket_classification`;
- exemplo sintético multi-etapa com texto/embeddings, XGBoost e regra determinística.

### Fase 8 — Testes e Auditoria

- typecheck;
- testes de spec;
- testes de API;
- testes de codegen;
- pytest do runtime;
- smoke Docker;
- auditoria visual Playwright.

## 18. Gate de Aceite do MVP

O MVP só está pronto quando:

1. Montar visualmente um projeto com CSV, SQL ou API externa.
2. Configurar classificação multiclasse ou regressão.
3. Incluir ao menos um bloco Python editável/testável.
4. Treinar modelos candidatos.
5. Comparar métricas e evidências.
6. Avaliar política de promoção com rule builder.
7. Aprovar manualmente um candidato.
8. Gerar runtime FastAPI autônomo com dashboard.
9. Gerar Docker Compose com app e Postgres.
10. Buildar e subir o runtime.
11. Rodar smoke completo, incluindo banco, modelo ativo, metadata, métricas e `/predict`.
12. Fazer predição e registrar prediction logs.
13. Ver observabilidade no dashboard/endpoints.
14. Exportar e reimportar pasta/zip gerada no Studio.
15. Renderizar novamente o projeto no canvas a partir do pacote de reimportação.

## 19. Depois do MVP

No pós-MVP atual, já existem:

- Playwright scraping controlado com login por formulário, crawl interno/profundo confirmado, importação assistida e validação OpenAPI com operações, schemas resumidos, exemplos de payload aplicáveis ao contrato e smoke real controlado de operação com checagem rasa de request/response.
- Studio conectado a runtimes remotos por inspeção read-only e importação black-box controlada.
- monitoramento mais amplo, incluindo feedback, retreino, deployment, drift, MLflow e dashboard do runtime;
- labels reais e feedback;
- retreino controlado;
- shadow/canary/rollback;
- importação robusta de imagem Docker, repo Git e modo black-box, incluindo fallback Git genérico confirmado quando não há sinais estáticos e probe OpenAPI sandboxado opt-in para Git/Dockerfile;
- MinIO/S3 para snapshots, Redis como overlay opcional de orquestração e MLflow mais completo;
- Prefect/Celery opcional com overlay Redis/Celery/Prefect quando jobs assíncronos justificarem.

Ficam fora do corte atual: crawling irrestrito/transacional, validação completa de JSON Schema, execução real prolongada de fine-tuning em GPU, inferência automática por subir servidor externo e operação produtiva com priorização/deploy remoto de Prefect/Celery.

## 20. Cuidados Críticos

- Não misturar treino pesado dentro da API de inferência final sem controle.
- Não sobrescrever produção sem versão, aprovação e rollback.
- Não escolher modelo só por accuracy.
- Não usar split aleatório em problema temporal.
- Não permitir data leakage.
- Não registrar PII desnecessária.
- Não serializar segredos reais.
- Não exportar `.env`.
- Não carregar pickle/container importado sem sandbox.
- Não tratar BERT como sempre melhor.
- Não criar dashboard vazio sem eventos úteis.
- Não transformar saída de IA em caixa-preta.
