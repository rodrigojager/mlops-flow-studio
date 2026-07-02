# Contratos e manifestos para a plataforma MLOps

O maior aprendizado técnico do Agent Flow Studio é tratar especificação, assets, manifestos, codegen e runtime como contratos versionáveis. A plataforma MLOps deve copiar esse princípio.

## Base atual a copiar

Arquivos:

- `../packages/flow-spec/src/index.ts`
- `../runtime.manifest.json`
- `../flows/reference-interview/agent.flow.json`
- `../packages/codegen-langgraph/src/index.ts`
- `../apps/builder-api/src/workspace.ts`

Padrões:

- Schema canônico em Zod.
- Exportação de JSON Schema.
- Análise estruturada com diagnósticos.
- Manifesto separado para agrupamento.
- Assets externos referenciados por id e path.
- Hash determinístico do projeto.
- Metadados gerados no artefato.
- Aprovação por hash.

## Contratos novos sugeridos

### 1. `project.yaml`

Define o projeto de ML:

- nome;
- tipo de problema;
- target;
- métrica primária;
- métricas secundárias;
- fontes de dados;
- políticas de aprovação;
- políticas de deploy;
- responsáveis;
- nível de risco.

Equivalente no Agent Flow Studio:

- `agent.flow.json` no nível de identidade e contrato.

### 2. `pipeline.flow.json`

Define o grafo de pipeline:

- etapas;
- dependências;
- condições;
- parâmetros;
- input/output path de cada etapa;
- scripts ou componentes customizados;
- posição visual dos nós.

Equivalente no Agent Flow Studio:

- `nodes`, `edges`, `position`, `type`, `inputPath`, `outputPath`, `resultPath`.

### 3. `data_source.yaml`

Define fonte de dados:

- tipo: CSV, Postgres, API, Playwright, upload, bucket;
- conexão por secret reference;
- query ou rota;
- paginação;
- retries;
- schema esperado;
- política de armazenamento raw.

### 4. `dataset_manifest.yaml`

Registra dataset versionado:

- dataset id;
- versão;
- camada: raw, clean, features, training, validation, test;
- storage URI;
- schema hash;
- row count;
- parent dataset;
- status de qualidade;
- lineage.

### 5. `feature_set.yaml`

Registra features:

- feature set id;
- versão;
- entity id;
- timestamp column;
- lista de features;
- transformação;
- fonte;
- dependências;
- leakage checks;
- reprodutibilidade na inferência.

### 6. `experiment_manifest.yaml`

Registra experimento:

- run id;
- dataset version;
- feature set version;
- algoritmo;
- hiperparâmetros;
- métricas;
- artefatos;
- duração;
- ambiente;
- código usado;
- MLflow run id, se houver.

### 7. `model_card.yaml`

Registra uso pretendido, limitações, risco, dados de treino, métricas e monitoramento exigido.

Equivalente conceitual:

- Documentação e metadados do runtime gerado.

### 8. `training_manifest.yaml`

Registra a versão treinada:

- run id;
- model name;
- version;
- algorithm;
- datasets;
- features;
- métricas;
- aprovação;
- artefatos.

### 9. `api_manifest.yaml`

Registra contrato da API de inferência:

- endpoints;
- input schema;
- output schema;
- runtime;
- dependências;
- comando de start;
- limites de latência;
- batch support.

### 10. `container_manifest.yaml`

Registra o container reimportável:

- spec version;
- project name;
- model name;
- model version;
- algorithm;
- feature set;
- training dataset;
- input/output schemas;
- artifacts;
- imagem;
- created_at;
- testes de smoke;
- compatibilidade com a plataforma.

## Proposta de estrutura de specs no novo repo

```text
packages/
  mlops-spec/
    src/
      index.ts
      cli.ts
apps/
  mlops-ui/
  control-api/
projects/
  classificacao_chamados/
    project.yaml
    pipelines/
      training.pipeline.json
      inference.pipeline.json
    schemas/
      input.schema.json
      output.schema.json
      dataset.schema.json
    features/
      suporte_features_v1.yaml
    manifests/
      model_card.yaml
      training_manifest.yaml
      api_manifest.yaml
      container_manifest.yaml
generated/
  classificacao_chamados-runtime/
```

## Diagnósticos que a spec deve gerar

Copie o modelo de `FlowDiagnostic` e crie códigos como:

- `missing_project_target`
- `unknown_data_source`
- `missing_required_column`
- `invalid_metric_for_problem_type`
- `feature_leakage_risk`
- `unknown_feature_set`
- `missing_training_dataset`
- `missing_input_schema`
- `missing_output_schema`
- `container_manifest_missing`
- `approval_outdated`
- `model_latency_policy_violation`
- `model_quality_policy_violation`
- `unsafe_artifact_path`
- `secret_value_committed`

Cada diagnóstico deve ter:

- severidade;
- código;
- mensagem;
- path;
- id do projeto;
- id da etapa;
- id do asset quando aplicável.

## Hash e aprovação

Copiar o padrão atual:

```text
spec + assets referenciados -> hash determinístico -> aprovação -> runtime final
```

Para MLOps:

```text
project + pipeline + schemas + features + code + manifests + model artifacts -> hash -> aprovação -> container/API
```

Regras:

- valor real de secret não entra no hash;
- referência ao secret entra no hash;
- dados raw grandes não devem entrar no hash inteiro, mas sim versão, URI, schema hash e checksum;
- artefato de modelo deve entrar por digest/checksum, não por bytes dentro do JSON;
- mudança em feature set invalida aprovação;
- mudança em input/output schema invalida container aprovado;
- mudança em política de deploy invalida promoção automática.

## Reimportação

O plano MLOps exige reimportar container, tarball, repo, zip ou pasta local. Adapte o import/export atual:

Base atual:

- `exportFlowWorkspace`
- `importFlowWorkspace`
- `archiveGeneratedArtifact`
- `listGeneratedArtifact`
- `readGeneratedArtifactFile`
- `safeResolveArtifactFile`

Novo fluxo:

1. Receber pasta, zip, tarball, repo ou imagem.
2. Localizar `container_manifest.yaml`.
3. Validar spec version.
4. Ler `api_manifest.yaml`, `model_card.yaml`, `training_manifest.yaml`, `feature_manifest.yaml`.
5. Validar schemas.
6. Rodar `/health`, `/metadata` e `/predict` com amostra.
7. Registrar como nativo ou black-box.
8. Criar projeto derivado editável.
9. Permitir retreinar e exportar nova versão.

## Contrato black-box

Quando o container não seguir o padrão, ainda registrar:

- imagem;
- endpoint;
- input schema inferido ou manual;
- output schema inferido ou manual;
- latência;
- status de smoke;
- limitações;
- se permite backtest;
- se permite retreino nativo.

Esse modo é equivalente ao escape hatch do Agent Flow Studio: não bloqueia o usuário, mas deixa claro o limite de inspeção.
