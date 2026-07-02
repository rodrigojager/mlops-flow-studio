# 0042 - Isolamento Containerizado Opcional para Blocos Python

## Status

Aceita

## Contexto

A ADR 0040 moveu a execução de blocos Python para um subprocesso dedicado. Isso limita travamentos e loops infinitos, mas ainda compartilha o ambiente do worker, filesystem local e namespace de rede do host.

O plano pede sandbox mais forte por processo/container. Implementar allowlist de rede forte dentro de container exige proxy, firewall ou runtime policy mais elaborada; fazer isso de uma vez aumentaria bastante a superfície de risco.

## Decisão

Blocos Python passam a aceitar `isolationMode` com os valores:

- `process`: padrão compatível, usando subprocesso Python dedicado.
- `container`: execução opcional via `docker run`.

No primeiro incremento, `container` foi aceito apenas com `networkPolicy: "none"`. O worker executa o bloco com:

- `--network none`;
- filesystem do container em modo read-only;
- `tmpfs` limitado em `/tmp`;
- `--cap-drop ALL`;
- `--security-opt no-new-privileges`;
- limite de CPU e memória.

O worker monta o workspace somente leitura para chamar o mesmo modo filho do CLI Python e envia o payload por stdin. A imagem pode ser sobrescrita por `MLOPS_PYTHON_BLOCK_CONTAINER_IMAGE`; o padrão é `python:3.13-slim`.

A UI expõe a escolha de isolamento no inspector do bloco Python. Projetos existentes continuam usando `process`. A ADR 0045 evoluiu esta decisão para aceitar `container` também com `allowlist` e `open`.

## Consequências

- Blocos sem rede real podem rodar em sandbox de container mais forte quando Docker estiver disponível.
- Mocks HTTP continuam funcionando porque são resolvidos dentro do processo filho sem rede real.
- `allowlist` e `open` passaram a poder usar isolamento containerizado na ADR 0045.
- Esse incremento não cria fila persistente externa nem múltiplos workers.
