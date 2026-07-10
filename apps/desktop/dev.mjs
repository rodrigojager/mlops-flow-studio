import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../..");
const apiHost = process.env.MLOPS_DESKTOP_CONTROL_API_HOST || "127.0.0.1";
const apiPort = Number(process.env.MLOPS_DESKTOP_CONTROL_API_PORT || 3334);
const uiHost = "127.0.0.1";
const uiPort = Number(process.env.MLOPS_DESKTOP_UI_PORT || 5273);
const apiBaseUrl = `http://${apiHost}:${apiPort}`;
const uiUrl = `http://${uiHost}:${uiPort}`;
const apiToken = process.env.MLOPS_STUDIO_API_TOKEN?.trim() || randomBytes(32).toString("base64url");
const children = new Set();
const require = createRequire(import.meta.url);

function log(scope, message) {
  console.log(`[desktop:${scope}] ${message}`);
}

function spawnManaged(scope, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout?.on("data", (chunk) => log(scope, chunk.toString().trimEnd()));
  child.stderr?.on("data", (chunk) => log(`${scope}:error`, chunk.toString().trimEnd()));
  child.on("exit", (code, signal) => {
    children.delete(child);
    log(scope, `finalizado code=${code ?? "null"} signal=${signal ?? "null"}`);
  });
  child.on("error", (error) => {
    children.delete(child);
    log(`${scope}:error`, error.message);
  });
  return child;
}

async function waitForUrl(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const headers = url.startsWith(apiBaseUrl) ? { authorization: `Bearer ${apiToken}` } : undefined;
      const response = await fetch(url, { headers });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timeout aguardando ${url}${lastError ? `: ${lastError.message}` : ""}`);
}

function stopChild(child) {
  if (!child || child.killed) {
    return;
  }
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function stopAll() {
  for (const child of children) {
    stopChild(child);
  }
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopAll();
  process.exit(143);
});

const tsxCli = path.join(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs");
const viteCli = path.join(workspaceRoot, "node_modules", "vite", "bin", "vite.js");
const electronBin = require("electron");
for (const requiredPath of [tsxCli, viteCli, electronBin]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Dependência executável não encontrada em ${requiredPath}. Execute npm install antes de iniciar o desktop.`);
  }
}

spawnManaged("api", process.execPath, [tsxCli, "apps/control-api/src/server.ts"], {
  HOST: apiHost,
  PORT: String(apiPort),
  MLOPS_STUDIO_WORKSPACE: workspaceRoot,
  MLOPS_STUDIO_API_TOKEN: apiToken,
});

spawnManaged("ui", process.execPath, [viteCli, "--config", "apps/mlops-ui/vite.config.ts", "--host", uiHost, "--port", String(uiPort), "--strictPort"], {
  VITE_CONTROL_API_URL: apiBaseUrl,
  VITE_CONTROL_API_TOKEN: apiToken,
});

await Promise.all([
  waitForUrl(`${apiBaseUrl}/projects`, 30_000),
  waitForUrl(uiUrl, 30_000),
]);

const electron = spawnManaged("electron", electronBin, ["apps/desktop/main.mjs"], {
  MLOPS_DESKTOP_UI_URL: uiUrl,
  MLOPS_DESKTOP_MANAGED_SERVICES: "0",
  MLOPS_DESKTOP_CONTROL_API_HOST: apiHost,
  MLOPS_DESKTOP_CONTROL_API_PORT: String(apiPort),
  MLOPS_STUDIO_API_TOKEN: apiToken,
});

electron.on("exit", (code) => {
  stopAll();
  process.exit(code ?? 0);
});
