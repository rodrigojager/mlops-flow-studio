# 0043 - Editor Visual de Contratos de API Externa

## Status

Aceita

## Contexto

Fontes API externas já tinham contrato no `project.yaml` com método, URL, headers por referência de segredo, `bodyTemplate`, paginação, timeout e mocks persistidos. A UI, porém, expunha apenas um editor básico de mocks, deixando partes importantes do contrato dependentes de edição manual do JSON.

O plano exige conectores de API com método, URL, headers seguros, paginação simples, preview e contratos/mock editáveis.

## Decisão

O painel de Projeto passa a exibir um editor visual de contratos de API externa. Para cada fonte API, a UI permite editar:

- método HTTP;
- URL;
- timeout;
- modo e parâmetros de paginação;
- headers por referência de segredo em JSON;
- `bodyTemplate` em JSON;
- mocks persistidos com request/response.

O worker de preview real passa a aceitar os métodos `GET`, `POST`, `PUT`, `PATCH` e `DELETE`, usando `bodyTemplate` como payload JSON para métodos com corpo. O modo seguro continua preferindo mocks persistidos e não usa rede real sem confirmação.

## Consequências

- O usuário consegue configurar a maior parte do contrato API pelo Studio, sem depender do editor JSON bruto.
- Segredos continuam por referência (`env:`/`secret:`) e são resolvidos apenas na execução real.
- Paginação ainda é contrato configurável; execução paginada real continua como evolução posterior.
