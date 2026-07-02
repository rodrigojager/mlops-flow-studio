# 0077 - Probe OpenAPI sandboxado para imagens Docker

## Status

Aceita

## Contexto

A importação controlada de imagem Docker começou usando apenas `docker image inspect`, sem executar container. Esse padrão continua sendo o comportamento seguro por padrão, mas limita imagens que não declaram endpoints por labels MLOps e ainda assim embarcam uma especificação OpenAPI estática.

Executar o entrypoint da imagem ou subir o runtime para descobrir contrato continua arriscado. A alternativa aceitável é um probe explícito e limitado, que não inicia a aplicação, não habilita rede e só tenta ler arquivos OpenAPI conhecidos dentro do filesystem da imagem.

## Decisão

A Control API passa a aceitar um probe opcional de OpenAPI em imagens Docker, habilitado apenas por `MLOPS_STUDIO_DOCKER_IMAGE_OPENAPI_SANDBOX=true`. O mesmo mecanismo de leitura estática também pode ser usado em repositórios Git com Dockerfile quando `MLOPS_STUDIO_GIT_DOCKERFILE_OPENAPI_SANDBOX=true` e `confirmSandboxExecution: true`; nesse caso o Studio constrói uma imagem temporária com `docker build --network none --pull=false`, executa o mesmo probe e remove a imagem temporária.

Quando habilitado, o importador usa `docker run` com:

- `--network none`;
- `--read-only`;
- `--cap-drop ALL`;
- `--security-opt no-new-privileges`;
- `--pids-limit 64`;
- `--memory 256m`;
- `--entrypoint sh`.

O script executado procura arquivos OpenAPI em caminhos estáticos conhecidos, como `/openapi.json`, `/openapi.yaml`, `/docs/openapi.json` e `/swagger/v1/swagger.json`. Ele não chama endpoints HTTP, não executa o entrypoint original da imagem, não persiste variáveis de ambiente da imagem e continua exigindo `confirmExternalSource: true`.

O projeto importado permanece black-box sintético. O pacote `.mlops/generated-meta.json` registra `openApiInspectionPath`, `runtimeEndpoints` ou `observedEndpoints`, `noApplicationEntrypointRun` e `containerSandboxInspection` para deixar claro quando houve probe sandboxado.

## Consequências

Imagens sem labels MLOps, mas com OpenAPI embarcado, podem expor endpoints mais ricos no manifesto sintético sem engenharia reversa do runtime.

O comportamento padrão continua sem executar container. Inferência automática por subir servidor, executar entrypoint, acessar rede, montar volumes de host ou extrair pipeline interno segue fora do escopo. No caso Git/Dockerfile, o build também é opt-in e usa rede desativada e política de pull local para evitar baixar bases remotas durante a importação.
