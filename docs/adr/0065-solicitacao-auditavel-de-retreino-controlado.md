# 0065 - Solicitação Auditável de Retreino Controlado

## Status

Aceita

## Contexto

O plano pós-MVP inclui retreino controlado a partir de labels reais e feedback. O runtime gerado já aceita feedback por `POST /feedback`, mas executar treino pesado diretamente na API de inferência contraria o cuidado crítico de não misturar treino pesado dentro do runtime final sem controle.

O caminho seguro é separar sinal, aprovação e execução: o runtime captura evidências e cria uma solicitação auditável; o Studio/worker executa o treino em ambiente controlado em um incremento posterior.

## Decisão

O runtime gerado passa a incluir a tabela `retraining_requests` e três endpoints:

- `POST /retraining/requests`: cria uma solicitação de retreino baseada em feedback real, com política mínima, motivo, solicitante, contagem de feedbacks e status inicial.
- `POST /retraining/requests/{request_id}/approve`: aprova manualmente uma solicitação com `confirm=true`, marcando-a como `approved_pending_runner`.
- `GET /retraining/status`: expõe contagem de solicitações, pendências, última solicitação e resumo de feedback.

Quando a contagem de feedbacks é menor que `min_feedback_count`, a solicitação fica `blocked`. Quando há feedback suficiente, fica `pending_review` e só avança para `approved_pending_runner` com aprovação explícita.

O dashboard e `/metrics/runtime` passam a exibir pendências de retreino. O smoke Docker valida criação, aprovação e consulta de status depois de registrar predição e feedback.

## Consequências

- O runtime autônomo passa a materializar pedidos de retreino sem executar treino pesado dentro da API de inferência.
- O fluxo cria uma ponte auditável para o Studio/worker consumir solicitações aprovadas.
- Ainda falta executar o job real de retreino a partir dessas solicitações e ligar o resultado ao ciclo de promoção/rollback.
- A aprovação explícita reduz risco de retreino acidental por feedback insuficiente ou ruidoso.
