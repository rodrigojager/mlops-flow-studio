# Chamadas externas em blocos Python com política e mock

Decidimos que blocos Python avançados devem poder fazer chamadas externas quando configurados para isso, inclusive com exceção aberta em casos necessários. Para preservar auditoria e reprodutibilidade, cada bloco declara política de rede, usa segredos por referência, registra logs/eventos da chamada e pode ter uma camada de teste mockada baseada em contrato de request/response antes da execução real.

## Implementação no Studio

O worker expõe um helper auditável no contexto do bloco:

```python
def run(input: dict, context: dict) -> dict:
    response = context["http_request"]("GET", input["url"])
    return {"status": response["httpStatus"], "body": response["json"]}
```

Também é possível usar `context["http"].request(...)`.

As políticas são:

- `none`: rede real bloqueada; mocks compatíveis ainda podem responder sem sair da máquina.
- `allowlist`: rede real só é permitida para `allowedHosts`.
- `open`: exceção explícita para rede ampla e imports Python livres.

O helper resolve headers `env:...` apenas no momento da chamada real, não inclui valores de segredo no retorno, e registra `networkCalls` com método, host, path, status, duração, timeout, mock usado e referências de segredo. Jobs assíncronos também recebem eventos estruturados `python_http_called`, `python_http_mocked`, `python_http_blocked` ou `python_http_failed`.

Esta decisão melhora rastreabilidade e teste local. A execução de blocos Python passou a usar isolamento por subprocesso na ADR 0040. A ADR 0042 adicionou isolamento containerizado opcional para `networkPolicy: "none"`, e a ADR 0045 estendeu esse isolamento para `allowlist` e `open` com rede Docker explícita e política aplicada pelo helper auditável.
