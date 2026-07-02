# 0067 - Conclusão Automática de Retreino Aprovado

## Status

Aceita

## Contexto

O Studio já consegue detectar uma solicitação de retreino aprovada em um runtime remoto, baixar o training-set derivado de feedback real e executar um job incremental no worker local. Sem uma conclusão explícita de volta ao runtime, a solicitação remota permaneceria em `approved_pending_runner`, mesmo depois de o job ter terminado no Studio.

O runtime gerado deve continuar autônomo e não deve executar treino pesado dentro da API de inferência. Ainda assim, ele precisa registrar quando o runner externo concluiu ou falhou.

## Decisão

O runtime gerado passa a expor `POST /retraining/requests/{request_id}/complete`. A chamada exige `confirm=true` e recebe metadados do runner externo, incluindo executor, sucesso/falha, `job_id`, `training_run_id`, `model_id`, mensagem e métricas.

A Control API passa a observar jobs de retreino vinculados a runtime remoto. Quando um job termina como `completed`, `failed` ou `cancelled`, ela tenta finalizar a solicitação remota:

- `completed` registra `success=true` e status remoto `completed`;
- `failed` ou `cancelled` registra `success=false` e status remoto `runner_failed`;
- cada tentativa fica anotada em `job.retraining.completion`;
- o job recebe evento estruturado `runtime_retraining_request_completed` ou `runtime_retraining_request_completion_failed`;
- a Control API limita novas tentativas quando a conclusão já foi registrada ou quando as tentativas se esgotam.

A UI mostra o status de conclusão, status remoto e número de tentativas no painel de jobs. O smoke do runtime valida também o endpoint de conclusão.

## Consequências

- O ciclo solicitação -> aprovação -> job no Studio -> conclusão no runtime fica auditável de ponta a ponta.
- O runtime mantém a responsabilidade operacional de registrar a conclusão, mas não assume o treino.
- Falhas de comunicação com o runtime não apagam o resultado local do job; elas ficam explícitas no job para inspeção e retentativa limitada.
- Promoção controlada do modelo retreinado, shadow/canary/rollback e automações externas continuam como próximos incrementos.
