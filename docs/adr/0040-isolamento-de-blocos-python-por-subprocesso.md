# 0040 - Isolamento de Blocos Python por Subprocesso

## Status

Aceita

## Contexto

Blocos Python customizados eram auditados estaticamente e executados pelo worker, mas o `exec` ainda acontecia no mesmo processo Python que orquestrava a requisição. Isso protegia a Control API por já haver um worker separado, porém não isolava o worker de loops infinitos, abortos ou efeitos colaterais do código do usuário.

O plano pede sandbox mais forte por processo/container. Container por bloco ainda exige empacotamento, montagem de arquivos e política de rede mais ampla, mas a separação por subprocesso já reduz o blast radius local e cria uma base compatível com evolução para container.

## Decisão

Cada execução de `run-python-block` passa a criar um subprocesso Python dedicado usando o próprio CLI do worker em modo filho. O processo pai continua responsável por carregar projeto/pipeline, validar política, auditar imports/chamadas diretas, emitir eventos estruturados e consolidar a resposta.

O subprocesso recebe apenas o payload necessário do bloco, executa a função `run(input, context)`, captura stdout/stderr, aplica timeout e devolve JSON com output e `networkCalls`. O helper HTTP auditável continua disponível dentro do contexto do bloco.

O resultado passa a indicar `isolation: "process"`.

## Consequências

- Loops infinitos e travamentos de bloco Python podem ser interrompidos por timeout sem travar o processo pai do worker.
- A auditoria e os eventos HTTP continuam centralizados no fluxo do worker.
- A ADR 0042 adicionou isolamento containerizado opcional para blocos sem rede real, e a ADR 0045 estendeu esse isolamento para `allowlist` e `open`. Cgroups/política de recursos avançada e fila persistente externa continuam como evolução para cargas não confiáveis ou distribuídas.
