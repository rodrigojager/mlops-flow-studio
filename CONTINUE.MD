# Prompt de Continuidade

Use este arquivo como prompt inicial para continuar o trabalho em outra máquina.

## Prompt Para a IA

Você é Codex trabalhando no projeto **MLOps Flow Studio**. Continue a implementação do plano, usando o estado atual do workspace como fonte de verdade. Não reinicie do zero.

Antes de alterar arquivos, leia nesta ordem:

1. `IDENTITY.md`
2. `CONTEXT.md`
3. `CONTEXT-MAP.md`
4. `docs/plan.md`
5. `docs/implementation-status.md`
6. `apps/mlops-ui/CONTEXT.md`
7. `apps/control-api/CONTEXT.md`
8. `packages/codegen-inference-api/CONTEXT.md`

Respeite estas regras:

- Manter todos os arquivos editados em UTF-8, com acentos reais em português brasileiro. Não inserir mojibake e não trocar letras acentuadas por entidades HTML.
- Usar `apply_patch` para edições manuais.
- Não reverter mudanças existentes sem pedido explícito.
- O objetivo amplo ainda é implementar o plano de `docs/plan.md`; não marcar como concluído só porque uma fatia passou.
- Como a pasta pode estar sincronizada pelo Google Drive, ignore diretórios temporários como `.tmp.drivedownload` e `.tmp.driveupload`.

## Estado Atual

O plano principal está documentado em `docs/plan.md`.

O status implementado está documentado em `docs/implementation-status.md`. Ele está bom para o histórico consolidado, e as etapas mais recentes concluídas foram **probe OpenAPI sandboxado de imagem Docker e Git/Dockerfile**, **smoke real dos wrappers Prefect/Celery gerados**, **overlay opcional `docker-compose.orchestration.yml` com Redis/Celery/Prefect**, **plano avançado de fine-tuning BERT/GPU auditável no worker**, e **Playwright scraping controlado com login por formulário, crawl interno/profundo confirmado, wizard/validação OpenAPI de operações, schemas resumidos, descritores rasos de payload, exemplos e smoke real controlado com validação de request/response antes da importação**.

Última fatia completa e validada:

- Importação estática de Git sem contrato cobrindo gRPC/GRPC-gateway, fallback gRPC sem gateway, servidor HTTP legado e fallback black-box genérico para Git sem sinais estáticos com `confirmBlackBox: true`, além de probe OpenAPI opt-in de Git/Dockerfile por `MLOPS_STUDIO_GIT_DOCKERFILE_OPENAPI_SANDBOX=true` e `confirmSandboxExecution: true`.
- Importação de imagem Docker com `docker image inspect` e probe OpenAPI sandboxado opcional por `MLOPS_STUDIO_DOCKER_IMAGE_OPENAPI_SANDBOX=true`.
- Probe Docker com `--network none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit` e limite de memória.
- ADR 0077 atualizada para o probe OpenAPI sandboxado de imagem Docker e Git/Dockerfile.
- `tools/orchestration-smoke.mjs` criado e exposto por `npm run smoke:orchestration`.
- Smoke de orquestração validado com Prefect/Celery reais em venv isolada, contra runtime HTTP local fake, com readiness e retreino controlado aprovados.
- Documentação/status/contextos atualizados para essa fatia.

Validações que já passaram depois da fatia GPU/CUDA:

```powershell
npm run typecheck
npm run test:control-api
npm run build:mlops-ui
npm run test:worker
npm run validate:example
npm run codegen:example
npm run smoke:orchestration
npx tsx packages/codegen-inference-api/src/cli.ts --project projects/support_ticket_classification --out generated/support-ticket-runtime
python -m compileall -q apps\worker generated\support-ticket-runtime\app generated\support-ticket-runtime\tests
python -m pytest tests -q
```

Validação final do corte planejado em 2026-07-02:

```powershell
npm run typecheck
npm run test:control-api
npm run build:mlops-ui
npm run audit:visual
npm run test:worker
npm run codegen:example
npm run validate:example
npm run smoke:orchestration
npx tsx packages/codegen-inference-api/src/cli.ts --project projects/support_ticket_classification --out generated/support-ticket-runtime
python -m compileall -q apps\worker generated\support-ticket-runtime\app generated\support-ticket-runtime\tests
python -m pytest tests -q
npm run smoke:runtime:docker -- --outDir generated/support-ticket-runtime --waitMs 180000
```

Resultados: `test:control-api` 6/6, `test:worker` 26/26, pytest do runtime 4/4 e smoke Docker 21/21. O pytest do runtime ainda emite o trace nativo conhecido de `pyarrow`/`pandas` em Python 3.13 depois dos testes, mas o processo retornou exit code 0.

## Etapa Atual Interrompida

Não há uma edição parcial conhecida neste momento. A auditoria visual Playwright já cobre fontes CSV/SQL/API, edição de contrato de API, adição de mock, vínculo visual de nó `data_source`, reimportação de `generated/support-ticket-runtime` e validação do canvas reimportado com nós e arestas. A bateria final do gate MVP foi executada em 2026-07-01, incluindo Docker smoke 21/21. O primeiro item pós-MVP implementado foi Playwright scraping controlado em `POST /tools/playwright-scrape`, com ADR 0078, confirmação para URL externa, crawl interno limitado de mesma origem por `maxDepth`/`maxPages`, relatórios em `.mlops-studio/playwright-scrapes/`, painel visual "Scraping Playwright" na aba Runtime, validação OpenAPI por `POST /tools/openapi-contract-preview` com endpoints/operações/schemas resumidos, descritores rasos e exemplos de payload, smoke real controlado por `POST /tools/openapi-operation-smoke` com validação de request/response, aplicação de operação validada no wizard, pré-visualização por `POST /projects/import-scrape/preview` e importação assistida por `POST /projects/import-scrape`.

Validação da fatia Playwright scraping:

```powershell
npm run typecheck
npm run test:control-api
npm run build:mlops-ui
npm run audit:visual
```

`test:control-api` passou com 6/6, incluindo scraping contra servidor HTTP local, validação OpenAPI controlada com operações/schemas resumidos, exemplos de payload, smoke real controlado de operação, pré-visualização com edição de contrato por fonte e importação do relatório como projeto black-box assistido. `build:mlops-ui` e `audit:visual` passaram com o painel novo, o "Wizard de contrato antes da importação" e as ações "Pré-visualizar importação", "Validar OpenAPI" e "Importar scrape" renderizados.

## Próximo Trabalho Recomendado

1. O plano planejado deste corte está implementado. Qualquer continuação deve começar por uma nova decisão de escopo, porque o restante está explicitamente fora do corte atual: execução real prolongada de fine-tuning em ambiente consumidor, inferência por subir servidores externos, crawling irrestrito/transacional, validação completa de JSON Schema e operação produtiva remota de Prefect/Celery.

2. Se a estabilidade Python nativa for obrigatória, isolar `generated/support-ticket-runtime` em venv própria ou ajustar versões de `pyarrow`/`pandas`/Python; os testes passaram, mas o ambiente Python 3.13 emitiu trace nativo de access violation depois do `pytest`.

3. Rodar pelo menos:

```powershell
npm run typecheck
npm run build:mlops-ui
npm run audit:visual
```

4. Para fechamento forte, rodar validação ampliada:

```powershell
npm run test:control-api
npm run test:worker
npm run validate:example
npm run codegen:example
npm run smoke:orchestration
npx tsx packages/codegen-inference-api/src/cli.ts --project projects/support_ticket_classification --out generated/support-ticket-runtime
python -m compileall -q apps\worker generated\support-ticket-runtime\app generated\support-ticket-runtime\tests
python -m pytest tests -q
```

5. Rodar varredura de encoding:

```powershell
$mojibake = @([char]0x00C3, [char]0x00C2, [char]0xFFFD, "$([char]0x00E2)$([char]0x20AC)", '&[a-zA-Z]+;') -join '|'
rg -n $mojibake . -g "!node_modules/**" -g "!apps/mlops-ui/dist/**" -g "!.dev-*.log" -g "!projects/**/artifacts/**" -g "!generated/**/.venv/**"
```

Saída sem resultados, com exit code 1 do `rg`, significa que a varredura não encontrou ocorrências.

## Observações Importantes

- Este diretório não parece ser um repositório git no ambiente anterior; `git status` retornou erro de "not a git repository".
- Servidores locais anteriores, se existirem, podem estar antigos. Ao continuar em outra máquina, não assuma que `3335` ou `5175` estão ativos.
- Para testar manualmente:

```powershell
$env:PORT="3335"; npm run dev:control-api
$env:VITE_CONTROL_API_URL="http://127.0.0.1:3335"; npm --workspace @mlops-flow-studio/mlops-ui run dev -- --host 127.0.0.1 --port 5175
```

- Depois abrir `http://127.0.0.1:5175`.
- Se a validação visual por navegador automatizado falhar por limitação de ambiente, registre isso claramente e use `typecheck`/`build`/testes como validação mínima.
