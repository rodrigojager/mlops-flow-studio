# 0070 - Importação black-box controlada de runtime remoto

## Status

Aceita

## Contexto

O Studio já inspeciona runtimes remotos em modo read-only por `POST /runtime/remote/inspect` e já reimporta runtimes white-box quando encontra `.mlops` ou `app/metadata`. Ainda faltava transformar um endpoint remoto observável, mas sem `project`/`pipeline`, em um projeto editável no canvas sem fingir que o Studio conhece a implementação interna.

Importar um runtime sem contrato completo tem risco operacional: artefatos, dados de treino, código, dependências e política de promoção podem não estar disponíveis. Também não é aceitável executar container, pickle ou código remoto durante a importação.

## Decisão

A Control API aceita `POST /projects/import-runtime` com `remoteBaseUrl` apenas quando `confirmBlackBox: true` é informado. A importação executa a inspeção remota read-only existente, rejeita runtimes inalcançáveis e cria um projeto sintético com:

- fonte API `remote_runtime_api` apontando para `/predict`;
- DAG visual mínimo com endpoint remoto, modelo ativo remoto e saída observada;
- `.mlops/project.yaml`, `.mlops/pipeline.flow.json`, `.mlops/runtime.manifest.json`, `.mlops/generated-meta.json` e `.mlops/remote-inspection.json`;
- metadados `importedFrom: remote_black_box`, `readOnly: true` e limitações explícitas.

A UI expõe a ação no painel Runtime remoto como `Importar black-box`, reutilizando a URL remota e o destino de reimportação.

## Consequências

O Studio passa a representar endpoints remotos observáveis no canvas e pode preservar a inspeção como evidência auditável. A importação não recupera artefatos, treinamento, código nem pipeline interno, e não substitui a importação white-box quando `.mlops` ou `app/metadata` estão disponíveis.

Imagem Docker por inspeção read-only foi tratada depois na ADR 0072, e repositório Git com contrato MLOps foi tratado na ADR 0071. Engenharia reversa de runtime sem endpoints observáveis, Git sem contrato e inferência por execução de container continuam fora deste incremento até existir sandbox adequado para esse tipo de entrada.
