# 0068 - Promoção Controlada do Modelo Retreinado

## Status

Aceita

## Contexto

O fluxo de retreino controlado já cobre solicitação no runtime, aprovação manual, execução real no worker do Studio com feedback do runtime e conclusão remota auditável. Depois disso, o modelo retreinado ainda precisa passar por uma etapa explícita de promoção, em vez de virar produção automaticamente.

O runtime remoto que originou a solicitação não recebe artefatos novos durante o job. Portanto, a promoção segura neste incremento deve acontecer no projeto do Studio, reutilizando a trilha local de promoção, auditoria e sincronização MLflow best-effort. Publicar o novo modelo em um runtime remoto fica para uma etapa posterior de geração/deploy controlado, shadow/canary ou rollback.

## Decisão

A Control API expõe `POST /projects/:projectId/retraining/from-runtime/jobs/:jobId/promotion/apply`.

A rota:

- exige `confirm=true`;
- exige que o job pertença ao projeto informado;
- exige que o job esteja vinculado a retreino de runtime remoto;
- exige job `completed`;
- exige conclusão remota registrada em `job.retraining.completion.status = "ok"`;
- usa `runId` e `bestModelId` do resultado do job;
- reutiliza `applyPromotionDecision` para aplicar as regras de promoção, atualizar `pipeline.flow.json`, gravar auditoria em `artifacts/promotion_decisions/` e sincronizar MLflow quando configurado;
- registra `job.retraining.promotion` com decisão, run, candidato, modelo ativo anterior e novo modelo ativo;
- adiciona evento estruturado `runtime_retraining_model_promoted` ao job.

A UI passa a mostrar o botão "Promover retreino" no job elegível e exibe status de promoção e modelo promovido no painel de jobs.

## Consequências

- O ciclo request remoto -> job real -> conclusão remota -> promoção local fica fechado e auditável no Studio.
- A promoção não acontece implicitamente ao fim do treino; o usuário ainda confirma a mudança de modelo ativo.
- A decisão reaproveita as regras existentes de promoção, incluindo rejeição/revisão e overrides explícitos no backend.
- O runtime remoto em execução não é alterado diretamente. Deploy remoto controlado, shadow/canary e rollback permanecem como próximos incrementos.
