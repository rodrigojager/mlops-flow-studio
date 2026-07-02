# 0078 - Scraping Playwright controlado

## Status

Aceita

## Contexto

O plano pós-MVP lista Playwright scraping como uma evolução possível do Studio. O objetivo é permitir inspeção de páginas, documentações e superfícies web, incluindo um crawl interno limitado e auditável, sem transformar o Studio em crawler irrestrito nem depender de navegação manual.

Scraping de páginas externas tem risco de SSRF, vazamento de credenciais em URL, navegação não auditada e artefatos difíceis de reproduzir.

## Decisão

A Control API passa a expor `POST /tools/playwright-scrape` para scraping controlado via Playwright.

O endpoint:

- aceita somente URLs `http` ou `https`;
- rejeita URLs com credenciais;
- permite `localhost`, `127.0.0.1` e `::1` sem confirmação adicional;
- exige `confirmExternalNavigation: true` para URLs externas;
- limita o crawl opcional a links internos de mesma origem, com `maxDepth` entre 0 e 2 e `maxPages` entre 1 e 10 por padrão;
- permite crawl profundo controlado com `confirmDeepCrawl: true`, elevando os limites para `maxDepth` até 5 e `maxPages` até 50;
- aceita login controlado por formulário quando `confirmAuthenticatedScrape: true`, `auth.loginUrl` usa a mesma origem da URL alvo e a senha é fornecida apenas por referência `env:VAR`;
- coleta título, descrição, canonical, headings, links, forms e candidatos a OpenAPI/Swagger/Redoc;
- opcionalmente captura screenshot;
- grava relatório JSON e screenshot em `.mlops-studio/playwright-scrapes/`.

A Control API também passa a expor `POST /projects/import-scrape` para transformar um relatório de scrape em projeto black-box assistido. Essa importação:

- exige `confirmBlackBox: true`;
- lê apenas relatórios dentro de `.mlops-studio/playwright-scrapes/`;
- cria projeto e DAG sintéticos com fontes API derivadas da página, candidatos OpenAPI/Swagger/Redoc e forms;
- grava o relatório original em `.mlops/playwright-scrape-report.json`;
- preserva `runtime.manifest.json` e `generated-meta.json` com limitações explícitas.

Antes da gravação, `POST /projects/import-scrape/preview` monta a mesma proposta em memória e retorna projeto, pipeline, fontes, endpoints e limitações para revisão visual. A prévia e a importação aceitam edições explícitas por fonte para incluir/remover candidato, ajustar label, descrição, método, URL, timeout e body template JSON antes de persistir o projeto.

Para validar contratos detectados antes da gravação, `POST /tools/openapi-contract-preview` busca um JSON OpenAPI por `GET`, exige `confirmExternalNavigation: true` para URLs externas, rejeita URLs com credenciais, limita a resposta a 1 MB, valida a presença de `paths` e retorna título, versão, endpoints HTTP reconhecidos, operações, content-types, schemas resumidos e exemplos sintéticos de request/response, latência, status HTTP e warnings auditáveis.

Para testar payload antes da importação, `POST /tools/openapi-operation-smoke` executa uma única chamada HTTP controlada para a operação escolhida. O endpoint exige `confirmOperationCall: true`, exige `confirmExternalNavigation: true` para URLs externas, rejeita credenciais na URL, valida de forma rasa o request contra o descritor OpenAPI recebido, envia o exemplo sintético como JSON quando o método permite body, valida a resposta JSON contra o descritor de resposta quando informado e retorna sucesso HTTP, status, content-type, latência, resultado de validação e prévia limitada da resposta.

## Consequências

O item pós-MVP de Playwright scraping vira uma capacidade auditável e testável da Control API e pode alimentar importação assistida de superfícies web sem sinais estáticos. A UI usa crawl interno limitado por padrão para descobrir documentação e páginas próximas sem ultrapassar a origem inicial, permite elevar limites com confirmação explícita e pode executar login por formulário sem persistir senha no relatório.

Validação semântica profunda completa de JSON Schema, crawling irrestrito e execução autenticada de fluxos transacionais continuam fora desta decisão.
