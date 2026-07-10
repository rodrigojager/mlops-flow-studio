import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
const outDir = path.resolve(options.outDir ?? "generated/support-ticket-runtime");
const venvDir = path.resolve(options.venvDir ?? ".mlops-studio/orchestration-smoke-venv");
const pythonBin = process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python");
const port = Number(options.port ?? await freePort());
const baseUrl = `http://127.0.0.1:${port}`;
const runtimeApiKey = randomBytes(32).toString("base64url");
const startedAt = new Date().toISOString();
const commands = [];

try {
  await mkdir(venvDir, { recursive: true });
  commands.push(await run(process.env.PYTHON ?? "python", ["-m", "venv", venvDir], process.cwd(), 120_000));
  if (!options.skipInstall) {
    commands.push(await run(pythonBin, ["-m", "pip", "install", "--upgrade", "pip"], process.cwd(), 180_000));
    commands.push(await run(pythonBin, ["-m", "pip", "install", "-r", path.join(outDir, "requirements-orchestration.txt")], process.cwd(), Number(options.installTimeoutMs ?? 600_000)));
  }
  const smokeScriptPath = path.join(outDir, ".mlops", "orchestration-smoke.py");
  await mkdir(path.dirname(smokeScriptPath), { recursive: true });
  await writeFile(smokeScriptPath, pythonSmokeScript(), "utf-8");
  const smoke = await run(pythonBin, [smokeScriptPath, outDir, baseUrl], outDir, Number(options.timeoutMs ?? 180_000), {
    ...process.env,
    PREFECT_LOGGING_LEVEL: "CRITICAL",
    PREFECT_API_URL: "",
    PREFECT_SERVER_ALLOW_EPHEMERAL_MODE: "true",
    CELERY_BROKER_URL: "memory://",
    CELERY_RESULT_BACKEND: "cache+memory://",
    MLOPS_RUNTIME_API_KEY: runtimeApiKey,
  });
  commands.push(smoke);
  const parsedSmoke = JSON.parse(smoke.stdout.trim());
  const report = {
    status: parsedSmoke.status,
    outDir: relative(outDir),
    venvDir: relative(venvDir),
    baseUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    commands: compactCommands(commands),
    smoke: parsedSmoke,
  };
  await writeReport(outDir, report);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "ok") {
    process.exitCode = 1;
  }
} catch (error) {
  const report = {
    status: "error",
    outDir: relative(outDir),
    venvDir: relative(venvDir),
    baseUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    commands: compactCommands(commands),
    message: error instanceof Error ? error.message : String(error),
  };
  await writeReport(outDir, report).catch(() => {});
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--skip-install") {
      parsed.skipInstall = true;
    } else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = args[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Nao foi possivel reservar porta livre."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function run(command, args, cwd, timeoutMs, env = process.env) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} excedeu ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        command: `${command} ${args.join(" ")}`,
        exitCode: code,
        signal,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        stdout: trim(stdout),
        stderr: trim(stderr),
      };
      if (code === 0) {
        resolve(result);
      } else {
        reject(new Error(`${result.command} falhou com exitCode ${code}: ${result.stderr || result.stdout}`));
      }
    });
  });
}

function pythonSmokeScript() {
  return String.raw`
from __future__ import annotations

import importlib
import json
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

runtime_root = Path(sys.argv[1]).resolve()
base_url = sys.argv[2].rstrip("/")
sys.path.insert(0, str(runtime_root))

logging.getLogger("prefect").disabled = True
logging.getLogger("prefect._internal.concurrency").disabled = True

request_log: list[dict[str, object]] = []
runtime_api_key = os.environ["MLOPS_RUNTIME_API_KEY"]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _read_body(self) -> dict[str, object]:
        length = int(self.headers.get("content-length") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def _authorized(self) -> bool:
        return self.headers.get("authorization") == "Bearer " + runtime_api_key

    def _send(self, status: int, body: dict[str, object]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        path = urlparse(self.path).path
        request_log.append({"method": "GET", "path": path})
        responses = {
            "/health": {"status": "ok"},
            "/metadata": {"contract": "mlops-flow-v1", "projectId": "orchestration-smoke"},
            "/models/active": {"id": "active_model", "status": "active"},
            "/metrics/runtime": {"prediction_count": 0, "error_count": 0},
        }
        body = responses.get(path)
        if body is None:
            self._send(404, {"error": "not_found", "path": path})
            return
        self._send(200, body)

    def do_POST(self) -> None:
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        path = urlparse(self.path).path
        body = self._read_body()
        request_log.append({"method": "POST", "path": path, "body": body})
        if path == "/retraining/requests":
            self._send(200, {"request_id": "req-smoke", "status": "pending_review"})
            return
        if path == "/retraining/requests/req-smoke/approve":
            if body.get("confirm") is not True:
                self._send(400, {"error": "confirm_required"})
                return
            self._send(200, {"request_id": "req-smoke", "status": "approved_pending_runner"})
            return
        self._send(404, {"error": "not_found", "path": path})


server_url = urlparse(base_url)
server = ThreadingHTTPServer((server_url.hostname or "127.0.0.1", int(server_url.port or 80)), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

try:
    prefect_flow = importlib.import_module("orchestration.prefect_flow")
    celery_app = importlib.import_module("orchestration.celery_app")

    def _noop_event(*_args, **_kwargs):
        return None

    try:
        import prefect.context as prefect_context
        import prefect.events.utilities as prefect_events_utilities
        import prefect.flow_engine as prefect_flow_engine
        prefect_events_utilities.emit_event = _noop_event
        prefect_flow_engine.emit_event = _noop_event
        prefect_context.AssetContext.emit_events = lambda self, state: None
    except Exception:
        pass

    prefect_readiness = prefect_flow.runtime_readiness_flow(base_url)
    prefect_retraining = prefect_flow.controlled_retraining_request_flow(base_url, requested_by="prefect-smoke", reason="smoke", confirm=True)

    def call_task(task_obj, *args, **kwargs):
        if hasattr(task_obj, "run"):
            return task_obj.run(*args, **kwargs)
        return task_obj(*args, **kwargs)

    celery_readiness = call_task(celery_app.runtime_readiness, base_url)
    celery_retraining = call_task(celery_app.request_controlled_retraining, base_url, requested_by="celery-smoke", reason="smoke", confirm=True)

    required_paths = {
        ("GET", "/health"),
        ("GET", "/metadata"),
        ("GET", "/models/active"),
        ("GET", "/metrics/runtime"),
        ("POST", "/retraining/requests"),
        ("POST", "/retraining/requests/req-smoke/approve"),
    }
    seen = {(str(item["method"]), str(item["path"])) for item in request_log}
    missing = sorted([f"{method} {path}" for method, path in required_paths - seen])
    status = "ok" if not missing else "error"
    print(json.dumps({
        "status": status,
        "baseUrl": base_url,
        "prefect": {
            "readinessProject": prefect_readiness.get("project") if isinstance(prefect_readiness, dict) else None,
            "retrainingStatus": prefect_retraining.get("approval", {}).get("status") if isinstance(prefect_retraining, dict) else None,
        },
        "celery": {
            "readinessProject": celery_readiness.get("project") if isinstance(celery_readiness, dict) else None,
            "retrainingStatus": celery_retraining.get("approval", {}).get("status") if isinstance(celery_retraining, dict) else None,
            "taskCount": len(celery_app.celery_app.tasks) if getattr(celery_app, "celery_app", None) is not None else 0,
        },
        "requestCount": len(request_log),
        "missing": missing,
    }, ensure_ascii=False))
    if status != "ok":
        raise SystemExit(1)
finally:
    try:
        from prefect.events.worker import EventsWorker
        EventsWorker.drain_all(timeout=10)
    except Exception:
        pass
    server.shutdown()
    server.server_close()
`;
}

async function writeReport(outDir, report) {
  const reportPath = path.join(outDir, ".mlops", "orchestration-smoke-report.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

function compactCommands(commands) {
  return commands.map((command) => ({
    ...command,
    stdout: trim(command.stdout),
    stderr: trim(command.stderr),
  }));
}

function trim(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 8000 ? trimmed.slice(-8000) : trimmed;
}

function relative(value) {
  return path.relative(process.cwd(), value).replaceAll(path.sep, "/");
}
