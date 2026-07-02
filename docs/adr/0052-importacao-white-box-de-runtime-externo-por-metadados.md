# 0052 - Importação White-Box de Runtime Externo por Metadados

## Status

Aceita

## Contexto

A reimportação já funcionava para runtimes gerados pelo Studio via pacote `.mlops` ou zip exportado. Isso não cobria runtimes externos que preservam metadados white-box em `app/metadata`, mas não carregam a pasta `.mlops`.

Importar uma API arbitrária, imagem Docker ou serviço remoto sem contratos do Studio continuaria sendo black-box e não permitiria validação de projeto, pipeline, lineage ou políticas.

## Decisão

`POST /projects/import-runtime` passa a aceitar duas origens white-box:

- pacote `.mlops` completo, mantendo o fluxo anterior;
- runtime com `app/metadata/project.json` ou `app/metadata/project.yaml` e `app/metadata/pipeline.flow.json`.

Quando a origem usa `app/metadata`, a Control API valida o projeto e o pipeline, cria um pacote `.mlops` mínimo no projeto importado, sintetiza `runtime.manifest.json` e `generated-meta.json`, preserva `latest-training-result.json` quando presente e tenta remapear `app/custom_code` para os `codePath` declarados no pipeline.

O mesmo detector é usado para zips extraídos, desde que o zip continue dentro de `generated/` e passe pela validação contra caminhos inseguros.

## Consequências

O Studio consegue importar runtimes white-box que não foram gerados diretamente por ele, desde que tragam contratos suficientes para reconstruir o projeto local.

Importação black-box de endpoints remotos, imagens Docker sem metadados, repositórios Git arbitrários ou runtimes sem `project`/`pipeline` continua fora do escopo.
