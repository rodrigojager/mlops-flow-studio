# Auditoria do Gate de Aceite do MVP

Data: 2026-07-01.

Fonte: `docs/plan.md`, seção 18.

## Resumo

O gate do MVP está implementado e validado. A evidência automatizada é forte para contratos, worker, geração, runtime, Docker smoke, reimportação por API/UI, jobs, promoção, observabilidade, feedback, retreino, deployment e experiência visual de fontes.

A bateria final de 2026-07-01 passou para o corte MVP. O único cuidado residual observado foi um trace nativo de access violation emitido por dependência Python (`pyarrow`/`pandas` via `sklearn`/`xgboost`) depois de `pytest`, embora o processo tenha retornado exit code 0 e os testes tenham passado.

## Itens

1. Montar visualmente um projeto com CSV, SQL ou API externa.
Status: implementado e validado.
Evidência: UI React Flow com palette/inspector, fontes CSV/SQL/API no projeto exemplo, preview seguro/real e auditoria visual versionada. `npm run audit:visual` em 2026-07-01 confirmou os três tipos de fonte, editou contrato de API, adicionou mock e validou o vínculo visual de um nó `data_source` pelo inspector.

2. Configurar classificação multiclasse ou regressão.
Status: implementado.
Evidência: schemas `mlops-spec`, exemplo multiclasse com 27 classes, projeto editável e worker cobrindo classificação/regressão.

3. Incluir ao menos um bloco Python editável/testável.
Status: implementado.
Evidência: pipeline exemplo tem bloco Python determinístico, Control API/worker executam bloco por subprocesso ou container, testes cobrem isolamento, timeout, mocks e política de rede.

4. Treinar modelos candidatos.
Status: implementado.
Evidência: worker treina baseline, scikit-learn, XGBoost e SentenceTransformers opcionais; Control API cobre treino síncrono e por job; há training runs persistidos.

5. Comparar métricas e evidências.
Status: implementado.
Evidência: leaderboard, evaluation runs, backtest comparativo, evidências verde/vermelho/neutro, snapshots de métricas e status de promoção.

6. Avaliar política de promoção com rule builder.
Status: implementado.
Evidência: rule builder tipado na UI, promotion policy no schema, status de promoção na Control API e auditoria visual validando interação de adicionar regra.

7. Aprovar manualmente um candidato.
Status: implementado.
Evidência: `POST /projects/:projectId/promotion/apply`, atualização de `pipeline.flow.json`, auditoria local em `artifacts/promotion_decisions/` e testes da Control API.

8. Gerar runtime FastAPI autônomo com dashboard.
Status: implementado.
Evidência: `codegen:example`, runtime gerado em `generated/support-ticket-runtime`, dashboard operacional e testes pytest do runtime.

9. Gerar Docker Compose com app e Postgres.
Status: implementado.
Evidência: codegen gera `docker-compose.yml`, `Dockerfile`, `.env.example` e overlay `docker-compose.gpu.yml`; Control API e smoke Docker validam arquivos.

10. Buildar e subir o runtime.
Status: implementado e validado anteriormente.
Evidência: `npm run smoke:runtime:docker -- --outDir generated/support-ticket-runtime --waitMs 180000` passou com build/up/down do Compose em portas livres.

11. Rodar smoke completo, incluindo banco, modelo ativo, metadata, métricas e `/predict`.
Status: implementado e validado anteriormente.
Evidência: smoke Docker com 21/21 checks, incluindo health, metadata, modelo ativo, métricas, predict, feedback, retreino, deployment e dashboard.

12. Fazer predição e registrar prediction logs.
Status: implementado.
Evidência: runtime persiste `prediction_runs` e `prediction_rows`; pytest valida `POST /predict`, máscara de campo sensível e evento `prediction_completed`.

13. Ver observabilidade no dashboard/endpoints.
Status: implementado.
Evidência: endpoints MLOps, dashboard gerado, inspeção remota read-only, métricas runtime/modelo, feedback, retreino, drift e deployment cobertos por testes/smokes.

14. Exportar e reimportar pasta/zip gerada no Studio.
Status: implementado.
Evidência: Control API cobre exportação de zip e reimportação por pasta `.mlops`, zip gerado, `app/metadata`, Git, Docker image e runtime remoto black-box.

15. Renderizar novamente o projeto no canvas a partir do pacote de reimportação.
Status: implementado e validado.
Evidência: `npm run audit:visual` em 2026-07-01 reimportou `generated/support-ticket-runtime` via fluxo de Artefatos, selecionou o projeto reimportado e confirmou o canvas React Flow com 11 nós e 11 arestas, além do inspector.

## Próximas Ações

1. O pós-MVP explícito já avançou para Playwright com login/crawl profundo confirmado, validação OpenAPI rasa com smoke real controlado, plano avançado BERT/GPU auditável, fallback Git black-box genérico, probe Git/Dockerfile sandboxado e overlay opcional Prefect/Celery.
2. O que resta fora do corte atual depende de ambiente consumidor ou risco operacional maior: crawling irrestrito/transacional, validação completa de JSON Schema, execução real prolongada de fine-tuning em GPU, inferência por subir servidor externo e operação produtiva com priorização/deploy remoto de Prefect/Celery.
3. Se a estabilidade Python nativa virar critério obrigatório, isolar os testes do runtime em venv própria ou ajustar versões de `pyarrow`/`pandas`/Python no ambiente consumidor.
