# Mapa de Contextos

## Contextos ICM

| Contexto | Função |
| --- | --- |
| `IDENTITY.md` | Identidade, regras e mapa Layer 0 do workspace. |
| `CONTEXT.md` | Roteamento raiz para sessões LLM. |
| `apps/CONTEXT.md` | Roteamento das aplicações executáveis do Studio. |
| `apps/control-api/CONTEXT.md` | Roteamento da API local de controle. |
| `apps/desktop/CONTEXT.md` | Roteamento do shell Electron desktop. |
| `apps/mlops-ui/CONTEXT.md` | Roteamento da interface visual. |
| `apps/worker/CONTEXT.md` | Roteamento do worker Python local. |
| `packages/CONTEXT.md` | Roteamento dos pacotes compartilhados. |
| `packages/mlops-spec/CONTEXT.md` | Roteamento dos contratos e diagnósticos MLOps. |
| `packages/codegen-inference-api/CONTEXT.md` | Roteamento do gerador de runtime FastAPI. |
| `projects/CONTEXT.md` | Roteamento dos projetos MLOps de trabalho local. |
| `projects/support_ticket_classification/CONTEXT.md` | Roteamento da cópia editável do exemplo principal. |
| `examples/CONTEXT.md` | Roteamento dos projetos de exemplo. |
| `examples/support_ticket_classification/CONTEXT.md` | Roteamento do exemplo multiclasse principal. |
| `infra/CONTEXT.md` | Roteamento da infraestrutura opcional. |
| `docs/CONTEXT.md` | Roteamento da documentação do projeto. |
| `docs/domain/CONTEXT.md` | Linguagem ubíqua, termos preferidos e termos a evitar. |
| `docs/adr/CONTEXT.md` | Convenção para decisões arquiteturais futuras. |

## Fontes de Planejamento

| Fonte | Quando carregar |
| --- | --- |
| `plano_plataforma_mlops.txt` | Quando precisar validar o escopo original do produto MLOps. |
| `01-mapeamento-dominios.md` | Quando adaptar conceitos do Agent Flow Studio para MLOps. |
| `02-codigo-reaproveitavel.md` | Quando decidir quais arquivos, classes e funções copiar. |
| `03-ui-ux-reaproveitavel.md` | Quando alterar experiência visual, navegação e Studio local. |
| `04-contratos-manifestos.md` | Quando mexer em schemas, manifestos, hash, aprovação ou reimportação. |
| `05-runtime-backend-containers.md` | Quando mexer em Control Plane, runtime, Docker, smoke test e sandbox. |
| `06-roadmap-de-duplicacao.md` | Quando executar a duplicação inicial do código. |
| `docs/reference-datathon-passos-magicos.md` | Quando precisar entender a aplicação/container MLOps que serve como referência concreta de saída. |
| `docs/local-environment.md` | Quando precisar verificar premissas do notebook atual, GPU/CUDA, Docker e runtime NVIDIA. |

## Código Implementado

| Fonte | Quando carregar |
| --- | --- |
| `packages/mlops-spec/src/index.ts` | Quando alterar schemas, tipos, métricas, rule builder ou diagnósticos. |
| `packages/codegen-inference-api/src/index.ts` | Quando alterar runtime FastAPI, dashboard, Docker, schema operacional ou pacote `.mlops`. |
| `apps/control-api/src/server.ts` | Quando alterar workspace local, rotas de projeto, validação e geração. |
| `apps/control-api/src/worker.ts` | Quando alterar a ponte entre Control API e worker Python. |
| `apps/control-api/src/worker-job-runner.ts` | Quando alterar execução destacada, retomada, timeout ou cancelamento de jobs assíncronos. |
| `apps/mlops-ui/src/App.tsx` | Quando alterar canvas, inspector, abas ou fluxo visual. |
| `apps/worker/mlops_worker/cli.py` | Quando alterar sandbox Python, preview de fontes ou treino baseline. |
| `projects/support_ticket_classification/project.yaml` | Quando alterar a cópia de trabalho que a UI abre. |
| `projects/support_ticket_classification/pipeline.flow.json` | Quando alterar o DAG editável pelo Studio. |
| `examples/support_ticket_classification/project.yaml` | Quando validar o contrato de projeto multiclasse inicial. |
| `examples/support_ticket_classification/pipeline.flow.json` | Quando validar DAG com CSV, SQL, API, modelos e Python. |

## Projeto de Origem

O projeto de origem fica em:

```text
C:\Users\rodrigo.pinheiro\Desktop\agent-flow-studio
```

Use-o como fonte de duplicação. Não crie dependência direta entre os repositórios.
