# MLOps Flow Studio

## Purpose

Workspace para planejar e iniciar uma plataforma visual de ciclo de vida completo de modelos de Machine Learning. Use este arquivo como roteamento ICM da raiz; o plano consolidado fica em `docs/plan.md`.

---

## Session Start

1. Leia `IDENTITY.md` para entender regras, status e mapa do workspace.
2. Leia `docs/plan.md` para o plano revisado de produto, arquitetura e duplicação.
3. Leia `docs/domain/CONTEXT.md` para usar a linguagem correta do domínio MLOps.
4. Leia os arquivos `01-*.md` a `06-*.md` quando precisar rastrear a origem de uma decisão de reaproveitamento.

---

## Folder Structure

```text
mlops flow studio/
├── IDENTITY.md
├── CONTEXT.md
├── CONTEXT-MAP.md
├── README.md
├── plano_plataforma_mlops.txt
├── 01-mapeamento-dominios.md
├── 02-codigo-reaproveitavel.md
├── 03-ui-ux-reaproveitavel.md
├── 04-contratos-manifestos.md
├── 05-runtime-backend-containers.md
├── 06-roadmap-de-duplicacao.md
├── package.json
├── tsconfig.base.json
├── apps/
│   ├── control-api/
│   ├── mlops-ui/
│   └── worker/
├── packages/
│   ├── mlops-spec/
│   └── codegen-inference-api/
├── projects/
│   └── support_ticket_classification/
├── examples/
│   └── support_ticket_classification/
├── infra/
├── generated/
├── tools/
└── docs/
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Entender o plano revisado | `docs/plan.md` | `IDENTITY.md` |
| Entender o plano original | `plano_plataforma_mlops.txt` | `docs/plan.md` |
| Entender a aplicação/container esperada como saída | `docs/reference-datathon-passos-magicos.md` | `docs/plan.md` |
| Decidir o que copiar do Agent Flow Studio | `02-codigo-reaproveitavel.md` e `06-roadmap-de-duplicacao.md` | `docs/plan.md` |
| Adaptar UI/UX sem atrito | `03-ui-ux-reaproveitavel.md` | `docs/plan.md` |
| Alterar contratos e manifestos | `04-contratos-manifestos.md` | `docs/domain/CONTEXT.md` |
| Trabalhar em backend, runtime e containers | `05-runtime-backend-containers.md` | `docs/plan.md` |
| Alterar contratos Zod e diagnósticos | `packages/mlops-spec/` | `packages/mlops-spec/CONTEXT.md` |
| Alterar gerador FastAPI/Docker | `packages/codegen-inference-api/` | `packages/codegen-inference-api/CONTEXT.md` |
| Alterar Control API local | `apps/control-api/` | `apps/control-api/CONTEXT.md` |
| Alterar UI visual | `apps/mlops-ui/` | `apps/mlops-ui/CONTEXT.md` |
| Alterar worker Python | `apps/worker/` | `apps/worker/CONTEXT.md` |
| Editar projeto de trabalho no Studio | `projects/support_ticket_classification/` | `projects/support_ticket_classification/CONTEXT.md` |
| Validar exemplo principal | `examples/support_ticket_classification/` | `examples/support_ticket_classification/CONTEXT.md` |
| Atualizar linguagem do domínio | `docs/domain/CONTEXT.md` | `CONTEXT-MAP.md` |
| Criar ADR | `docs/adr/` | `docs/adr/CONTEXT.md` |

---

## Notes

Preserve UTF-8 e use acentos reais em português. A estratégia deste workspace é copiar/adaptar código do `agent-flow-studio` para cá, mantendo a nova plataforma independente.
