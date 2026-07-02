# 0045 - Política de Rede Containerizada para Blocos Python

## Status

Aceita

## Contexto

A ADR 0042 introduziu `isolationMode: "container"` apenas para blocos Python com `networkPolicy: "none"`. Isso endureceu o sandbox sem rede real, mas deixava `allowlist` e `open` no isolamento por subprocesso quando o bloco precisava fazer chamadas externas auditáveis.

O plano pede política de rede por bloco com `none`, `allowlist` e `open`, sempre com auditoria de chamadas, segredos por referência e mocks baseados em contrato.

## Decisão

O worker passa a aceitar `isolationMode: "container"` também para `networkPolicy: "allowlist"` e `networkPolicy: "open"`.

Para execução containerizada:

- `none` continua usando `docker run --network none`;
- `allowlist` e `open` usam a rede Docker configurada em `MLOPS_PYTHON_BLOCK_CONTAINER_NETWORK`, com fallback para `bridge`;
- o container preserva `--read-only`, `--tmpfs`, `--cap-drop ALL`, `--security-opt no-new-privileges`, limite de CPU e limite de memória;
- o payload enviado ao processo filho mantém `networkPolicy`, `allowedHosts`, mocks e timeout;
- o helper `context["http_request"]` continua sendo o único caminho suportado para rede real auditável;
- imports diretos de clientes HTTP, `socket`, `urllib`, `requests` e chamadas diretas como `open` continuam bloqueados pela auditoria estática.

Com isso, `allowlist` restringe chamadas reais aos hosts declarados e `open` libera rede ampla apenas via helper auditável, sem vazar valores de segredo no retorno ou nos eventos.

## Consequências

Blocos Python que precisam chamar APIs externas podem optar por isolamento em container sem perder a auditoria de `networkCalls`.

O fallback `bridge` funciona como padrão local. Ambientes que precisam isolar egress de forma mais rígida podem apontar `MLOPS_PYTHON_BLOCK_CONTAINER_NETWORK` para uma rede Docker administrada pela infraestrutura.

Esta decisão não adiciona proxy, firewall dinâmico ou múltiplos workers. A política continua centrada no helper auditável e na auditoria estática do código do bloco.
