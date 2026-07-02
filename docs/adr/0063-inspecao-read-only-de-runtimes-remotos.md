# 0063 - Inspeção Read-Only de Runtimes Remotos

## Status

Aceita

## Contexto

O plano coloca "Studio conectado a runtimes remotos" no pós-MVP e mantém importação robusta de imagem Docker, repo Git e modo black-box para uma etapa posterior. O Studio já executa smoke local do runtime Docker, mas esse smoke chama `POST /predict` e foi deliberadamente restrito a localhost.

Para observar runtimes em outra máquina, o Studio precisa de um caminho mais conservador: consultar endpoints públicos de observabilidade sem alterar estado, sem depender do Docker local e sem prometer reimportação quando o runtime não expõe metadados white-box.

## Decisão

A Control API passa a expor `POST /runtime/remote/inspect` como inspeção remota read-only. O endpoint recebe uma `baseUrl` HTTP/HTTPS, rejeita credenciais embutidas na URL e executa apenas chamadas `GET` para:

- `/health`;
- `/metadata`;
- `/openapi.json`;
- `/model-card`;
- `/models`;
- `/models/active`;
- `/metrics/model`;
- `/metrics/runtime`;
- `/promotion/status`;
- `/drift/latest`;
- `/environment/gpu`;
- `/dashboard`.

O resultado classifica o runtime como:

- `white_box`, quando `/metadata` declara `contract: mlops-flow-v1`;
- `partial_contract`, quando há sinais de contrato MLOps sem metadados completos;
- `black_box_observable`, quando o serviço responde mas não expõe contrato reimportável;
- `unreachable`, quando nenhum endpoint responde.

A UI passa a mostrar um painel "Runtime remoto" na aba Runtime, com URL, modo detectado, identidade do projeto/modelo quando disponível, contagem de endpoints e recomendações operacionais.

## Consequências

- O Studio consegue observar runtimes remotos sem executar `/predict` e sem modificar estado do serviço.
- A conexão remota avança o pós-MVP sem abrir importação black-box insegura.
- Runtimes sem `.mlops`, `app/metadata` ou `/metadata` com contrato do Studio continuam não reimportáveis automaticamente.
- O smoke local Docker continua separado, com `/predict` e restrição a localhost.
