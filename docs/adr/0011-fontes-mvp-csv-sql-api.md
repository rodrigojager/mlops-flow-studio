# Fontes MVP: CSV, SQL e API externa

Decidimos que o MVP deve suportar três tipos de fonte desde o início: CSV/upload, banco SQL e API externa. Playwright scraping fica para depois. Essa escolha atende os fluxos reais esperados sem antecipar a complexidade de automação de navegador, mas exige que a spec, a palette visual e a ingestão já tratem conexão segura, query, headers, paginação simples e preview de schema/resposta.

Para API externa, o contrato da fonte também pode declarar `api.mocks`: respostas sintéticas versionáveis com request/response. O worker usa esses mocks para preview e treino seguro sem rede externa quando a execução não foi confirmada como real. Quando a execução é real, o worker chama a API configurada e resolve segredos apenas por referência `env:...`.

O Studio mostra quando uma fonte API tem mocks persistidos. A ADR 0043 evoluiu essa superfície para um editor visual de contrato API, cobrindo método, URL, timeout, paginação, headers por referência de segredo, `bodyTemplate` e mocks com request/response. A ADR 0044 liga esse contrato à execução real do worker para paginação por `page` e `cursor`. O JSON completo do projeto continua disponível para casos avançados.

Isso permite que o Studio valide o fluxo visual e gere artefatos reproduzíveis mesmo quando a API externa não está disponível no momento do desenvolvimento.
