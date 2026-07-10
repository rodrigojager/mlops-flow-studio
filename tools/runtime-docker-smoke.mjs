import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";

const options = parseArgs(process.argv.slice(2));
const outDir = path.resolve(options.outDir ?? "generated/support-ticket-runtime");
const composePath = path.join(outDir, "docker-compose.yml");
const apiPort = Number(options.apiPort ?? (options.baseUrl ? new URL(options.baseUrl).port || 8080 : await freePort()));
const baseUrl = options.baseUrl ?? `http://127.0.0.1:${apiPort}`;
const runtimeApiKey = options.apiKey ?? randomBytes(32).toString("base64url");
const postgresPassword = options.postgresPassword ?? randomBytes(24).toString("base64url");
const timeoutMs = Number(options.timeoutMs ?? 600_000);
const startedAt = new Date().toISOString();
const commands = [];
const composeEnv = {
  ...process.env,
  API_HOST_PORT: String(apiPort),
  MLOPS_RUNTIME_API_KEY: runtimeApiKey,
  POSTGRES_PASSWORD: postgresPassword,
};

try {
  await runDocker(["--version"], process.cwd(), 30_000, composeEnv);
  await runDocker(["compose", "version"], process.cwd(), 30_000, composeEnv);
  if (!options.skipBuild) {
    commands.push(await runDocker(composeArgs(["build"]), process.cwd(), timeoutMs, composeEnv));
  }
  commands.push(await runDocker(composeArgs(["up", "-d", ...(options.skipBuild ? [] : ["--build"])]), process.cwd(), timeoutMs, composeEnv));
  await waitForHealth(baseUrl, Number(options.waitMs ?? 120_000));
  const smoke = await runSmokeChecks(baseUrl, Number(options.checkTimeoutMs ?? 60_000));
  const report = {
    status: smoke.status,
    outDir: relative(outDir),
    baseUrl,
    apiPort,
    startedAt,
    finishedAt: new Date().toISOString(),
    docker: { commands },
    smoke,
  };
  await writeReport(outDir, report);
  console.log(JSON.stringify(report, null, 2));
  if (smoke.status !== "ok") {
    process.exitCode = 1;
  }
} catch (error) {
  const report = {
    status: "error",
    outDir: relative(outDir),
    baseUrl,
    apiPort,
    startedAt,
    finishedAt: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
    docker: { commands },
  };
  await writeReport(outDir, report).catch(() => {});
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  if (!options.keepUp) {
    await runDocker(composeArgs(["down", "--volumes", "--remove-orphans"]), process.cwd(), 120_000, composeEnv).catch((error) => {
      console.error(JSON.stringify({ status: "cleanup_error", message: error instanceof Error ? error.message : String(error) }, null, 2));
    });
  }
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--skip-build") {
      parsed.skipBuild = true;
    } else if (arg === "--keep-up") {
      parsed.keepUp = true;
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
          reject(new Error("Não foi possível reservar porta livre."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function composeArgs(args) {
  return ["compose", "-f", composePath, "--project-directory", outDir, ...args];
}

function runDocker(args, cwd, timeoutMs, env) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("docker", args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`docker ${args.join(" ")} excedeu ${timeoutMs} ms.`));
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
        command: `docker ${args.join(" ")}`,
        exitCode: code,
        signal,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
      };
      if (code === 0) {
        resolve(result);
      } else {
        reject(new Error(`${result.command} falhou com exitCode ${code}: ${result.stderr || result.stdout}`));
      }
    });
  });
}

async function waitForHealth(baseUrl, waitMs) {
  const deadline = Date.now() + waitMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health", baseUrl));
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Runtime não respondeu /health em ${waitMs} ms. Último erro: ${lastError}`);
}

async function runSmokeChecks(baseUrl, timeoutMs) {
  const started = performance.now();
  const checks = [];
  checks.push(await check(baseUrl, "health", "GET", "/health", undefined, timeoutMs, (body) => isObject(body) && body.status === "ok"));
  checks.push(await check(baseUrl, "metadata", "GET", "/metadata", undefined, timeoutMs, (body) => isObject(body) && body.contract === "mlops-flow-v1"));
  const modelsCheck = await check(baseUrl, "models", "GET", "/models", undefined, timeoutMs, (body) => isObject(body) && Array.isArray(body.models));
  checks.push(modelsCheck);
  checks.push(await check(baseUrl, "active_model", "GET", "/models/active", undefined, timeoutMs, (body) => isObject(body) && typeof body.id === "string"));
  checks.push(await check(baseUrl, "model_metrics", "GET", "/metrics/model", undefined, timeoutMs, isObject));
  checks.push(await check(baseUrl, "runtime_metrics", "GET", "/metrics/runtime", undefined, timeoutMs, (body) => isObject(body) && typeof body.prediction_count === "number"));
  const predictCheck = await check(baseUrl, "predict", "POST", "/predict", { input: { text: "smoke ticket teste", email: "smoke@example.com" } }, timeoutMs, (body) => isObject(body) && typeof body.run_id === "string" && typeof body.model_version_id === "string");
  checks.push(predictCheck);
  const predictBody = isObject(predictCheck.body) ? predictCheck.body : {};
  const modelsBody = isObject(modelsCheck.rawBody) && Array.isArray(modelsCheck.rawBody.models) ? modelsCheck.rawBody.models : [];
  const smokeModel = modelsBody.find((item) => isObject(item) && typeof item.id === "string" && item.id !== predictBody.model_version_id)
    ?? modelsBody.find((item) => isObject(item) && typeof item.id === "string");
  const smokeModelId = String(smokeModel?.id ?? predictBody.model_version_id ?? "");
  const registryDetail = await check(baseUrl, "model_registry_detail", "GET", `/models/${encodeURIComponent(smokeModelId)}`, undefined, timeoutMs, (body) => isObject(body) && body.registered === true);
  const candidateAlreadyRegistered = isObject(registryDetail.rawBody) && registryDetail.rawBody.registered === true;
  if (!candidateAlreadyRegistered) {
    const registrationCheck = await check(baseUrl, "model_registration", "POST", "/models/register", { confirm: true, model_id: smokeModelId, algorithm: "smoke_candidate", status: "candidate", requested_by: "smoke" }, timeoutMs, (body) => isObject(body) && isObject(body.model) && body.model.id === smokeModelId);
    if (registrationCheck.status === "ok" || registrationCheck.statusCode !== 404) {
      checks.push(registrationCheck);
    }
  }
  checks.push(await check(baseUrl, "deployment_status", "GET", "/deployment/status", undefined, timeoutMs, (body) => isObject(body) && body.status === "ok"));
  checks.push(await check(baseUrl, "deployment_shadow", "POST", "/deployment/shadow", { confirm: true, model_id: smokeModelId, requested_by: "smoke", reason: "Smoke operacional shadow." }, timeoutMs, (body) => isObject(body) && isObject(body.rollout) && body.rollout.kind === "shadow"));
  checks.push(await check(baseUrl, "deployment_shadow_predict", "POST", "/predict", { input: { text: "smoke ticket teste shadow", email: "shadow@example.com" } }, timeoutMs, (body) => isObject(body) && isObject(body.deployment) && body.deployment.mode === "shadow" && isObject(body.shadow_prediction)));
  checks.push(await check(baseUrl, "deployment_canary", "POST", "/deployment/canary", { confirm: true, model_id: smokeModelId, traffic_percent: 50, requested_by: "smoke", reason: "Smoke operacional canary." }, timeoutMs, (body) => isObject(body) && isObject(body.rollout) && body.rollout.kind === "canary"));
  checks.push(await check(baseUrl, "deployment_canary_predict", "POST", "/predict", { input: { text: "smoke ticket teste canary", email: "canary@example.com" } }, timeoutMs, (body) => isObject(body) && isObject(body.deployment) && body.deployment.mode === "canary"));
  checks.push(await check(baseUrl, "deployment_rollback", "POST", "/deployment/rollback", { confirm: true, requested_by: "smoke", reason: "Smoke operacional rollback." }, timeoutMs, (body) => isObject(body) && isObject(body.rollout) && body.rollout.kind === "rollback" && isObject(body.deployment) && body.deployment.mode === "active"));
  checks.push(await check(baseUrl, "feedback", "POST", "/feedback", { run_id: predictBody.run_id, actual_label: "prediction" in predictBody ? predictBody.prediction : "smoke", source: "smoke" }, timeoutMs, (body) => isObject(body) && typeof body.feedback_id === "string" && body.correct === true));
  checks.push(await check(baseUrl, "feedback_summary", "GET", "/feedback/summary", undefined, timeoutMs, (body) => isObject(body) && typeof body.feedback_count === "number"));
  const retrainingCheck = await check(baseUrl, "retraining_request", "POST", "/retraining/requests", { min_feedback_count: 1, requested_by: "smoke", reason: "Smoke operacional de retreino controlado." }, timeoutMs, (body) => isObject(body) && typeof body.request_id === "string" && ["pending_review", "blocked"].includes(String(body.status)));
  checks.push(retrainingCheck);
  const retrainingBody = isObject(retrainingCheck.body) ? retrainingCheck.body : {};
  checks.push(await check(baseUrl, "retraining_approval", "POST", `/retraining/requests/${encodeURIComponent(String(retrainingBody.request_id ?? ""))}/approve`, { confirm: true, approved_by: "smoke" }, timeoutMs, (body) => isObject(body) && body.status === "approved_pending_runner"));
  checks.push(await check(baseUrl, "retraining_training_set", "GET", `/retraining/requests/${encodeURIComponent(String(retrainingBody.request_id ?? ""))}/training-set`, undefined, timeoutMs, (body) => isObject(body) && typeof body.row_count === "number" && Array.isArray(body.rows)));
  checks.push(await check(baseUrl, "retraining_completion", "POST", `/retraining/requests/${encodeURIComponent(String(retrainingBody.request_id ?? ""))}/complete`, { confirm: true, completed_by: "smoke", success: true, job_id: "smoke", training_run_id: "smoke", model_id: "smoke" }, timeoutMs, (body) => isObject(body) && body.status === "completed"));
  checks.push(await check(baseUrl, "retraining_status", "GET", "/retraining/status", undefined, timeoutMs, (body) => isObject(body) && typeof body.request_count === "number"));
  checks.push(await check(baseUrl, "dashboard", "GET", "/dashboard", undefined, timeoutMs, (body) => typeof body === "string" && body.includes("MLOps Runtime Dashboard")));
  const failed = checks.filter((item) => item.status !== "ok");
  return {
    status: failed.length === 0 ? "ok" : "error",
    latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      predictionLogged: checks.some((item) => item.name === "predict" && item.status === "ok"),
      feedbackLogged: checks.some((item) => item.name === "feedback" && item.status === "ok"),
      retrainingRequested: checks.some((item) => item.name === "retraining_request" && item.status === "ok"),
      retrainingCompleted: checks.some((item) => item.name === "retraining_completion" && item.status === "ok"),
      deploymentObserved: checks.some((item) => item.name === "deployment_status" && item.status === "ok"),
      deploymentRolledBack: checks.some((item) => item.name === "deployment_rollback" && item.status === "ok"),
    },
    checks,
  };
}

async function check(baseUrl, name, method, endpoint, body, timeoutMs, validate) {
  const url = new URL(endpoint, baseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${runtimeApiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const parsed = parseBody(text, response.headers.get("content-type") ?? "");
    const ok = response.ok && validate(parsed);
    const result = {
      name,
      status: ok ? "ok" : "error",
      method,
      url,
      statusCode: response.status,
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
      body: compact(parsed),
      message: ok ? undefined : "Resposta do runtime não atendeu ao contrato esperado.",
    };
    Object.defineProperty(result, "rawBody", { value: parsed, enumerable: false });
    return result;
  } catch (error) {
    return {
      name,
      status: "error",
      method,
      url,
      statusCode: null,
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(text, contentType) {
  if (contentType.includes("application/json")) {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }
  return text;
}

function compact(value) {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 2000) {
    return { truncated: true, preview: `${serialized.slice(0, 1500)}...` };
  }
  return value;
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function writeReport(outDir, report) {
  const reportPath = path.join(outDir, ".mlops", "docker-smoke-report.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

function trimOutput(value) {
  const trimmed = value.trim();
  return trimmed.length > 5000 ? `${trimmed.slice(-5000)}` : trimmed;
}

function relative(value) {
  return path.relative(process.cwd(), value).replaceAll(path.sep, "/");
}
