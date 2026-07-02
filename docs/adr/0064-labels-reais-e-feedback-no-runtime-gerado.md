# 0064 - Labels Reais e Feedback no Runtime Gerado

## Status

Aceita

## Contexto

O plano pós-MVP inclui labels reais e feedback como caminho para monitoramento mais amplo, retreino controlado e avaliação contínua. O runtime gerado já registrava predições em `prediction_runs` e `prediction_rows`, mas não havia um contrato explícito para receber o rótulo real depois da predição.

Sem esse contrato, o runtime só media uso e latência. Ele não conseguia guardar correções humanas ou labels observados posteriormente, nem expor uma métrica operacional de acerto baseada em feedback real.

## Decisão

O runtime gerado passa a incluir a tabela operacional `prediction_feedback`, com vínculo a `run_id`, `row_id`, `model_version_id`, valor previsto, label real, flag `correct`, origem, revisor, comentário e timestamp.

Dois endpoints entram no contrato do runtime:

- `POST /feedback`: registra o label real de uma predição existente por `run_id` e, opcionalmente, `row_id`.
- `GET /feedback/summary`: retorna contagem de feedbacks, acertos, acurácia de feedback e agregados do modelo ativo.

Quando `correct` não é enviado, o runtime infere o valor comparando `actual_label` com a predição armazenada. Cada feedback também gera evento `prediction_feedback_recorded` e snapshot de métrica com `scope: feedback`.

O dashboard gerado passa a exibir quantidade de feedbacks e acurácia de feedback, e o smoke Docker passa a validar `POST /feedback` e `GET /feedback/summary` depois de `/predict`.

## Consequências

- O runtime autônomo passa a capturar labels reais sem depender do Studio.
- O feedback vira evidência operacional persistida, útil para monitoramento, auditoria e retreino futuro.
- O contrato ainda não aplica retreino automático, shadow/canary ou rollback; ele apenas cria a base auditável para esses fluxos.
- A comparação automática de `actual_label` com a predição é simples e pode ser substituída por tolerâncias ou métricas por domínio em incrementos futuros.
