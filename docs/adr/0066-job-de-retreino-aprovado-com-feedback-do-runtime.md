# 0066 - Job de Retreino Aprovado com Feedback do Runtime

## Status

Aceita

## Contexto

O runtime gerado já registra predições, feedback de labels reais e solicitações auditáveis de retreino. A solicitação aprovada não deve treinar dentro da API de inferência, mas também não pode ficar apenas como marcador operacional: o Studio precisa transformar essa aprovação em execução real no worker.

Além disso, usar somente a fonte original do projeto perderia o sinal mais importante do fluxo: os labels reais registrados no runtime.

## Decisão

O runtime gerado passa a expor `GET /retraining/requests/{request_id}/training-set`, um endpoint read-only que monta linhas de treino a partir de `prediction_feedback` unido a `prediction_rows.input_masked`, preenchendo o target do projeto com `actual_label`.

A Control API passa a expor `POST /projects/:projectId/retraining/from-runtime/jobs`. Essa rota:

- consulta `GET /retraining/status` no runtime remoto;
- exige uma solicitação `approved_pending_runner`;
- tenta baixar o training-set de feedback do runtime;
- exige linhas suficientes quando `requireFeedbackRows=true`;
- resolve o último treino local como base incremental;
- enfileira um job real `train-baseline` em modo incremental no worker;
- grava no job metadados do request remoto, origem das linhas, base local e contagem de feedback usada.

A UI passa a permitir iniciar esse job pela seção Runtime remoto quando a inspeção detecta uma solicitação aprovada, e o painel de jobs mostra o vínculo com o request de retreino.

## Consequências

- O fluxo de retreino controlado deixa de ser apenas solicitação/aprovação e passa a disparar execução real no worker do Studio.
- Labels reais do runtime podem alimentar o retreino sem colocar treino pesado dentro da API de inferência.
- O endpoint de training-set respeita a política de payload do runtime: por padrão usa entrada mascarada, e payload completo só aparece quando o runtime foi configurado para armazená-lo.
- A conclusão automática do request remoto após o job e estratégias de shadow/canary/rollback continuam como próximos incrementos.
