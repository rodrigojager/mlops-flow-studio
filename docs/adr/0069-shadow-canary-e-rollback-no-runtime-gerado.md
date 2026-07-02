# 0069 - Shadow, Canary e Rollback no Runtime Gerado

## Status

Aceita

## Contexto

Depois do fluxo de feedback real, retreino controlado e promoção local do modelo retreinado no Studio, o runtime autônomo ainda precisava oferecer um caminho operacional para testar candidatos sem troca abrupta de produção.

O runtime gerado já mantém catálogo de modelos, modelo ativo, logs de predição e eventos operacionais. A próxima decisão é controlar shadow, canary e rollback dentro do próprio runtime, sem depender do Studio em tempo de inferência e sem treinar dentro da API final.

## Decisão

O runtime gerado passa a incluir a tabela `deployment_rollouts` e os endpoints:

- `GET /deployment/status`
- `POST /deployment/shadow`
- `POST /deployment/canary`
- `POST /deployment/rollback`

`POST /deployment/shadow` exige `confirm=true` e um `model_id` existente. O runtime continua respondendo com o modelo ativo, mas executa o candidato em paralelo e inclui `shadow_prediction` compacta na resposta de `/predict`.

`POST /deployment/canary` exige `confirm=true`, `model_id` existente e `traffic_percent` maior que 0 e menor que 100. O roteamento usa bucket determinístico derivado do payload, permitindo que uma fração estável das entradas seja atendida pelo candidato, enquanto o restante segue para o modelo ativo.

`POST /deployment/rollback` exige `confirm=true`, marca o rollout ativo como `rolled_back`, registra um rollout de rollback concluído e faz `/predict` voltar ao modo ativo.

O dashboard gerado passa a mostrar o modo de deployment. O manifesto do runtime lista os quatro endpoints. O smoke da Control API e o smoke Docker verificam status de deployment, shadow, predição shadow, canary, predição canary e rollback. A inspeção remota continua read-only e consulta apenas `GET /deployment/status`.

## Consequências

- O runtime autônomo consegue validar candidatos em shadow e canary sem o Studio rodando.
- O rollback é explícito, auditável e não depende de reverter arquivos gerados.
- O smoke operacional cobre mudança e restauração de estado do deployment, além de health, métricas, feedback e retreino.
- A implementação não publica artefatos novos no runtime remoto; ela opera sobre modelos já presentes no runtime gerado.
- Automação externa com Prefect/Celery, deploy remoto de novos artefatos e importação black-box continuam como incrementos separados.
