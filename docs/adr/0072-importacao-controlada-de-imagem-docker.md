# 0072 - Importação controlada de imagem Docker

## Status

Aceita

## Contexto

O plano prevê importação robusta de runtimes externos, incluindo imagens Docker. Uma imagem pode conter um runtime válido, mas também pode incluir código opaco, variáveis de ambiente sensíveis, entrypoints destrutivos ou dependências não confiáveis.

Executar a imagem apenas para descobrir seu contrato ampliaria o risco operacional. Ao mesmo tempo, runtimes gerados pelo Studio já podem carregar metadados suficientes em labels Docker e no pacote `.mlops`.

## Decisão

O codegen passa a emitir labels MLOps no `Dockerfile` gerado, incluindo contrato, projeto, versão, hashes, modelo ativo, perfil de execução e endpoints do manifesto.

A Control API aceita `POST /projects/import-runtime` com `sourceDockerImage` e exige `confirmExternalSource: true`. O importador:

- executa somente `docker image inspect`;
- não executa `docker run`, Compose, entrypoint ou scripts da imagem;
- cria um projeto/pipeline sintético black-box com fonte API apontando para uma execução controlada futura da imagem;
- persiste `.mlops/docker-image-inspect.json` sanitizado;
- não serializa `Config.Env` para evitar vazamento de segredos;
- usa labels MLOps quando disponíveis e fallback seguro para `POST /predict` quando não há endpoints declarados.

A UI expõe `Imagem Docker` e `Porta` na seção Reimportação, chamando a mesma rota com confirmação explícita.

## Consequências

Imagens geradas pelo Studio passam a ser reconhecíveis por metadados OCI/MLOps e podem voltar ao canvas como black-box auditável sem executar código não confiável.

Imagens sem labels ou sem endpoints continuam importadas apenas como representação sintética mínima por padrão. Reconstrução de pipeline interno, extração de código e inferência automática de contrato por subir o runtime permanecem fora do escopo.

A ADR 0077 complementa esta decisão com um probe OpenAPI opcional e sandboxado, sem rede e sem executar o entrypoint original da imagem.
