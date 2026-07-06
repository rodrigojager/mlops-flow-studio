# MLOps Desktop

## Purpose

Shell Electron local do MLOps Flow Studio. No modo desenvolvimento, `dev.mjs` sobe a Control API e o Vite da UI e abre o Electron apontando para `http://127.0.0.1:5273`. No modo desktop buildado, `main.mjs` inicia a Control API local em `http://127.0.0.1:3334` e carrega `apps/mlops-ui/dist/index.html`.

---

## Folder Structure

```text
desktop/
├── package.json
├── main.mjs     # processo principal Electron
├── preload.cjs  # ponte mínima e isolada para metadados do desktop
└── dev.mjs      # orquestrador local de API, Vite e Electron
```

---

## Commands

```powershell
npm run dev:desktop
npm run build:desktop
npm run start:desktop
```

## Notes

- Preserve `nodeIntegration: false`, `contextIsolation: true` e `sandbox: true`.
- A Control API continua separada do runtime FastAPI gerado; o Electron apenas empacota o Studio local.
- Se alterar a porta padrão da API no desktop buildado, ajuste também `VITE_CONTROL_API_URL` no build da UI.
