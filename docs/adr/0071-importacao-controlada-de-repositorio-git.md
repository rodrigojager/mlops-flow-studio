# 0071 - Importação controlada de repositório Git

## Status

Aceita

## Contexto

O plano prevê importação robusta de repositórios Git arbitrários. O Studio já conseguia reimportar pasta local, zip gerado e runtime white-box por `app/metadata`, mas ainda não havia um caminho explícito para pegar um runtime versionado em Git.

Um repositório Git pode conter código, hooks, scripts, segredos acidentais ou artefatos não confiáveis. A importação não deve executar código do repositório nem inferir pipeline quando não houver contrato MLOps.

## Decisão

A Control API aceita `POST /projects/import-runtime` com `sourceGitUrl` e exige `confirmExternalSource: true`. O importador:

- aceita repositório local dentro do workspace ou URL `http`/`https` sem credenciais;
- aceita `sourceGitRef` simples para branch, tag ou ref;
- clona URL remota em diretório temporário dentro de `generated/`;
- para repositório local, apenas lê a árvore de trabalho versionada;
- exige `.mlops/project.yaml` com `.mlops/pipeline.flow.json` ou `app/metadata/project.*` com `app/metadata/pipeline.flow.json`;
- reaproveita o mesmo caminho de importação white-box/pacote `.mlops`;
- não executa hooks, scripts, containers, notebooks, pickles ou código do repositório.

A UI expõe `Git` e `Ref` na seção Reimportação, chamando o mesmo endpoint com confirmação explícita.

## Consequências

Runtimes versionados em Git passam a voltar ao canvas quando já preservam o contrato MLOps. Repositórios sem `.mlops` ou `app/metadata` continuam rejeitados, evitando engenharia reversa implícita e importação opaca.

Importação controlada de imagem Docker por `docker image inspect` foi tratada separadamente na ADR 0072. Reconstrução de projeto a partir de repositório sem contrato, inferência automática por execução de container e engenharia reversa de artefatos continuam pendentes até existir sandbox e analisadores adequados.
