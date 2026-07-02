# 0074 - Automação opcional Prefect/Celery no runtime

## Status

Aceita

## Contexto

O plano deixa Prefect/Celery para quando os jobs assíncronos justificarem automação além da fila local/filesystem do Studio. A base atual já possui jobs persistidos, fila compartilhada, replay de snapshots, retreino aprovado a partir de runtime remoto, promoção controlada e shadow/canary/rollback.

Adicionar um orquestrador obrigatório neste ponto aumentaria infraestrutura e dependências do runtime autônomo. Ainda assim, o runtime gerado precisa oferecer um caminho claro para quem quiser automatizar health checks, readiness e solicitações controladas de retreino em ambientes maiores.

## Decisão

O runtime gerado passa a incluir artefatos opcionais de orquestração:

- `requirements-orchestration.txt`;
- `docker-compose.orchestration.yml`;
- `orchestration/prefect_flow.py`;
- `orchestration/celery_app.py`;
- `.mlops/orchestration_manifest.yaml`.

Esses artefatos não entram no `requirements.txt` principal e não são necessários para subir a API. O compose de orquestração é um overlay opcional: materializa Redis persistido para broker/result backend, um worker Celery e um servidor Prefect local atrás do profile `prefect`. Os fluxos read-only consultam health, metadata, modelo ativo e métricas. Fluxos mutáveis de retreino exigem confirmação explícita.

A validação de manifestos da Control API exige o manifesto de orquestração no runtime gerado e valida seu cabeçalho mínimo.

## Consequências

O runtime continua autônomo e leve por padrão, mas já sai com ponte documentada e executável para Prefect/Celery quando a operação pedir agendamento, workers externos ou filas transacionais.

Operar esse overlay em produção, definir priorização avançada e fazer deploy remoto de fluxos continuam decisões de infraestrutura do ambiente consumidor, não pré-requisitos do Studio.
