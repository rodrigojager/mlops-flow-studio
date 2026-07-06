# Apps

## Purpose

Aplicações executáveis do Studio. Hoje contém a Control API local, a UI visual, o worker Python local e o shell Electron desktop.

---

## Folder Structure

```text
apps/
├── control-api/    # Fastify API para workspace, validação e geração
├── desktop/        # Electron para abrir o Studio como app local
├── mlops-ui/       # React/Vite UI com canvas, palette e inspector
└── worker/         # Python worker para sandbox, preview e treino
```

---

## Routing

| Task | Go To | Load First |
|------|-------|------------|
| Alterar API local | `control-api/` | `control-api/CONTEXT.md` |
| Alterar shell Electron | `desktop/` | `desktop/CONTEXT.md` |
| Alterar interface visual | `mlops-ui/` | `mlops-ui/CONTEXT.md` |
| Alterar worker Python | `worker/` | `worker/CONTEXT.md` |
| Integrar UI e API | `mlops-ui/src/api.ts` e `control-api/src/server.ts` | `../packages/mlops-spec/CONTEXT.md` |
