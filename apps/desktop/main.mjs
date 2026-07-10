import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../..");
const uiDistIndex = path.join(workspaceRoot, "apps", "mlops-ui", "dist", "index.html");
const preloadPath = path.join(currentDir, "preload.cjs");
const apiHost = process.env.MLOPS_DESKTOP_CONTROL_API_HOST || process.env.HOST || "127.0.0.1";
const apiPort = Number(process.env.MLOPS_DESKTOP_CONTROL_API_PORT || process.env.PORT || 3334);
const apiBaseUrl = `http://${apiHost}:${apiPort}`;
const apiToken = process.env.MLOPS_STUDIO_API_TOKEN?.trim() || randomBytes(32).toString("base64url");
process.env.MLOPS_STUDIO_API_TOKEN = apiToken;
const managedServices = process.env.MLOPS_DESKTOP_MANAGED_SERVICES !== "0";
const smokeMode = process.env.MLOPS_DESKTOP_SMOKE === "1";

let mainWindow = null;
let controlApiProcess = null;
let isQuitting = false;

if (smokeMode) {
  app.disableHardwareAcceleration();
}

function desktopLog(scope, message) {
  console.log(`[desktop:${scope}] ${message}`);
}

function controlApiCommand() {
  const nodeExecPath = process.env.npm_node_execpath || "node";
  const tsxCliPath = path.join(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCliPath)) {
    throw new Error(`tsx não encontrado em ${tsxCliPath}. Execute npm install antes de abrir o desktop.`);
  }
  return {
    command: nodeExecPath,
    args: [tsxCliPath, "apps/control-api/src/server.ts"],
  };
}

async function waitForUrl(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${apiToken}` } });
      if (response.ok) {
        return true;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timeout aguardando ${url}${lastError ? `: ${lastError.message}` : ""}`);
}

async function startControlApi() {
  if (!managedServices) {
    return;
  }

  desktopLog("api", `verificando Control API em ${apiBaseUrl}`);
  try {
    await waitForUrl(`${apiBaseUrl}/projects`, 800);
    desktopLog("api", `usando Control API existente em ${apiBaseUrl}`);
    return;
  } catch {
    // No API is listening yet; Electron will own the local process.
  }

  desktopLog("api", "iniciando Control API via tsx");
  const command = controlApiCommand();
  controlApiProcess = spawn(command.command, command.args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: apiHost,
      PORT: String(apiPort),
      MLOPS_STUDIO_WORKSPACE: workspaceRoot,
      MLOPS_STUDIO_API_TOKEN: apiToken,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  controlApiProcess.stdout?.on("data", (chunk) => desktopLog("api", chunk.toString().trimEnd()));
  controlApiProcess.stderr?.on("data", (chunk) => desktopLog("api:error", chunk.toString().trimEnd()));
  controlApiProcess.on("error", (error) => desktopLog("api:error", error.message));
  controlApiProcess.on("exit", (code, signal) => {
    controlApiProcess = null;
    if (!isQuitting) {
      desktopLog("api", `processo finalizado com code=${code ?? "null"} signal=${signal ?? "null"}`);
    }
  });

  await waitForUrl(`${apiBaseUrl}/projects`, smokeMode ? 15_000 : 30_000);
  desktopLog("api", `Control API pronta em ${apiBaseUrl}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    title: "MLOps Flow Studio",
    backgroundColor: "#0f172a",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!smokeMode) {
      mainWindow?.show();
    }
  });

  mainWindow.webContents.once("did-finish-load", () => {
    if (smokeMode) {
      desktopLog("smoke", `UI carregada: ${mainWindow?.webContents.getURL() ?? "unknown"}`);
      setTimeout(() => app.quit(), 250);
    }
  });

  mainWindow.webContents.once("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    if (smokeMode) {
      desktopLog("smoke:error", `falha ao carregar ${validatedUrl}: ${errorCode} ${errorDescription}`);
      process.exitCode = 1;
      app.quit();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedAppUrl(url)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedAppUrl(url)) {
      return;
    }
    event.preventDefault();
    shell.openExternal(url);
  });

  const devUrl = process.env.MLOPS_DESKTOP_UI_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    return;
  }

  if (!existsSync(uiDistIndex)) {
    mainWindow.loadURL(renderMissingBuildPage());
    return;
  }

  mainWindow.loadFile(uiDistIndex);
}

function isTrustedAppUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return true;
    }
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function renderMissingBuildPage() {
  const html = `
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>MLOps Flow Studio Desktop</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; font-family: Segoe UI, sans-serif; }
      main { max-width: 720px; padding: 32px; border: 1px solid #334155; border-radius: 20px; background: #111827; }
      code { color: #86efac; }
    </style>
  </head>
  <body>
    <main>
      <h1>Build da UI não encontrado</h1>
      <p>Execute <code>npm run build:desktop</code> na raiz do projeto e abra novamente com <code>npm run start:desktop</code>.</p>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function stopControlApi() {
  if (!controlApiProcess || controlApiProcess.killed) {
    return;
  }
  if (process.platform === "win32" && controlApiProcess.pid) {
    spawn("taskkill", ["/pid", String(controlApiProcess.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  controlApiProcess.kill("SIGTERM");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady()
    .then(startControlApi)
    .then(createWindow)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (smokeMode) {
        desktopLog("startup:error", message);
        process.exitCode = 1;
      } else {
        dialog.showErrorBox("Erro ao iniciar o MLOps Flow Studio", message);
      }
      app.quit();
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopControlApi();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
