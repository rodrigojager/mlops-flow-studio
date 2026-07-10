import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workerPythonExecutable } from "./worker.ts";

type WorkerJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface WorkerJobEvent {
  kind: "worker_event";
  timestamp?: string;
  level?: string;
  type?: string;
  message?: string;
  [key: string]: unknown;
}

interface WorkerJobState {
  jobId: string;
  command: string;
  projectId: string;
  projectRoot: string;
  status: WorkerJobStatus;
  sourceId?: string;
  nodeId?: string;
  mode?: string;
  label?: string;
  queuedAt?: string;
  runnerStartedAt?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  events: WorkerJobEvent[];
  stderrEventBuffer?: string;
  result?: unknown;
  error?: string;
  requestPath?: string;
  runnerPid?: number;
  workerPid?: number;
  runnerWorkerId?: string;
  queueBackend?: "local" | "filesystem";
  claimPath?: string;
  slotPath?: string;
}

const args = parseArgs(process.argv.slice(2));
let persistSequence = 0;
void runWorkerJob(args).catch(async (error) => {
  try {
    const state = await readJobState(args.jobStoreRoot, args.jobId);
    state.status = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    state.finishedAt = new Date().toISOString();
    await persistJobState(args.jobStoreRoot, state);
    await releaseJobLocks(args.jobStoreRoot, state);
  } finally {
    process.exitCode = 1;
  }
});

async function runWorkerJob(options: { workspaceRoot: string; jobStoreRoot: string; workerId: string; jobId: string; timeoutMs: number }): Promise<void> {
  const state = await readJobState(options.jobStoreRoot, options.jobId);
  if (state.status !== "running") {
    return;
  }
  const requestPath = resolveJobDataPath(options.workspaceRoot, options.jobStoreRoot, state.requestPath ?? `${safeWorkerJobFileName(options.jobId)}.request.json`);
  const request = JSON.parse(await readFile(requestPath, "utf-8")) as unknown;
  state.runnerPid = process.pid;
  state.runnerWorkerId = options.workerId;
  await persistJobState(options.jobStoreRoot, state);

  const workerScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../worker/mlops_worker/cli.py");
  const child = spawn(workerPythonExecutable(), [workerScript], {
    cwd: options.workspaceRoot,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  state.workerPid = child.pid;
  await persistJobState(options.jobStoreRoot, state);

  const latest = state;
  let persistQueue = Promise.resolve();
  const persist = () => {
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(() => persistJobState(options.jobStoreRoot, latest));
    return persistQueue;
  };
  const heartbeat = setInterval(() => {
    latest.runnerPid = process.pid;
    latest.runnerWorkerId = options.workerId;
    void writeJobLockHeartbeat(options.jobStoreRoot, latest).then(() => persist()).catch(() => undefined);
  }, 2_000);
  const timeout = setTimeout(() => {
    if (latest.status !== "running") {
      return;
    }
    latest.timedOut = true;
    latest.error = "Worker Python excedeu o timeout.";
    child.kill("SIGKILL");
  }, Math.max(1000, Math.min(options.timeoutMs, 1_800_000)));
  const cancelPoll = setInterval(() => {
    void readJobState(options.jobStoreRoot, options.jobId).then((current) => {
      if (current.status === "cancelled" && latest.status === "running") {
        latest.status = "cancelled";
        latest.error = current.error ?? "Job cancelado pelo usuário.";
        latest.finishedAt = current.finishedAt ?? new Date().toISOString();
        child.kill("SIGKILL");
      }
    }).catch(() => undefined);
  }, 1000);

  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    latest.stdout = capWorkerLog(`${latest.stdout}${String(chunk)}`);
    void persist().catch(() => undefined);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    latest.stderr = capWorkerLog(`${latest.stderr}${text}`);
    appendWorkerEvents(latest, text);
    void persist().catch(() => undefined);
  });

  child.stdin.end(`${JSON.stringify(request)}\n`, "utf-8");

  await new Promise<void>((resolve) => {
    child.on("error", (error) => {
      latest.status = "failed";
      latest.error = `Não foi possível iniciar o worker Python: ${error.message}`;
      latest.finishedAt = new Date().toISOString();
      resolve();
    });
    child.on("close", (exitCode, signal) => {
      latest.exitCode = exitCode;
      latest.signal = signal;
      latest.finishedAt = latest.finishedAt ?? new Date().toISOString();
      if (latest.status === "cancelled") {
        resolve();
        return;
      }
      const parsedOutput = parseWorkerJobOutput(latest.stdout);
      if (exitCode !== 0 || latest.timedOut) {
        latest.status = "failed";
        latest.error = latest.timedOut ? "Worker Python excedeu o timeout." : "Worker Python falhou.";
        if (parsedOutput !== undefined) {
          latest.result = parsedOutput;
        }
        resolve();
        return;
      }
      if (parsedOutput === undefined) {
        latest.status = "failed";
        latest.error = "Worker Python não retornou JSON válido.";
        resolve();
        return;
      }
      latest.status = "completed";
      latest.result = parsedOutput;
      resolve();
    });
  });

  clearTimeout(timeout);
  clearInterval(cancelPoll);
  clearInterval(heartbeat);
  await persist();
  await releaseJobLocks(options.jobStoreRoot, latest);
}

function parseArgs(argv: string[]): { workspaceRoot: string; jobStoreRoot: string; workerId: string; jobId: string; timeoutMs: number } {
  const getValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const workspaceRoot = getValue("--workspaceRoot");
  const jobStoreRoot = getValue("--jobStoreRoot");
  const workerId = getValue("--workerId");
  const jobId = getValue("--jobId");
  if (!workspaceRoot || !jobId) {
    throw new Error("--workspaceRoot e --jobId são obrigatórios.");
  }
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  return {
    workspaceRoot: resolvedWorkspaceRoot,
    jobStoreRoot: path.resolve(jobStoreRoot ?? workerJobDefaultStoreDir(resolvedWorkspaceRoot)),
    workerId: safeWorkerId(workerId ?? `runner-${process.pid}`),
    jobId,
    timeoutMs: Number(getValue("--timeoutMs") ?? 600_000),
  };
}

async function readJobState(jobStoreRoot: string, jobId: string): Promise<WorkerJobState> {
  const raw = JSON.parse(await readFile(workerJobPath(jobStoreRoot, jobId), "utf-8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Job inválido: ${jobId}`);
  }
  return raw as WorkerJobState;
}

async function persistJobState(jobStoreRoot: string, state: WorkerJobState): Promise<void> {
  const storeDir = workerJobStoreDir(jobStoreRoot);
  await mkdir(storeDir, { recursive: true });
  const target = workerJobPath(jobStoreRoot, state.jobId);
  const temp = path.join(storeDir, `.${safeWorkerJobFileName(state.jobId)}.${Date.now()}.${process.pid}.${persistSequence += 1}.tmp`);
  await writeFile(temp, `${JSON.stringify({ ...state, stderrEventBuffer: "" }, null, 2)}\n`, "utf-8");
  await retryRename(temp, target);
}

async function retryRename(source: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (!["EPERM", "EACCES", "EBUSY"].includes(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

function workerJobPath(jobStoreRoot: string, jobId: string): string {
  return path.join(workerJobStoreDir(jobStoreRoot), `${safeWorkerJobFileName(jobId)}.json`);
}

function workerJobStoreDir(jobStoreRoot: string): string {
  return path.resolve(jobStoreRoot);
}

function workerJobDefaultStoreDir(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, ".mlops-studio", "worker-jobs");
}

function safeWorkerJobFileName(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function resolveJobDataPath(workspaceRoot: string, jobStoreRoot: string, targetPath: string): string {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedJobStoreRoot = path.resolve(jobStoreRoot);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : targetPath.startsWith(".mlops-studio/") || targetPath.startsWith(".mlops-studio\\")
      ? path.resolve(resolvedWorkspaceRoot, targetPath)
      : path.resolve(resolvedJobStoreRoot, targetPath);
  if (!pathIsWithin(resolved, resolvedWorkspaceRoot) && !pathIsWithin(resolved, resolvedJobStoreRoot)) {
    throw new Error(`Caminho fora do workspace/fila de jobs: ${targetPath}`);
  }
  return resolved;
}

async function writeJobLockHeartbeat(jobStoreRoot: string, state: WorkerJobState): Promise<void> {
  const heartbeat = `${JSON.stringify({
    jobId: state.jobId,
    workerId: state.runnerWorkerId,
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
  }, null, 2)}\n`;
  await Promise.all([
    state.claimPath ? writeFile(path.join(resolveQueuePath(jobStoreRoot, state.claimPath), "heartbeat.json"), heartbeat, "utf-8") : Promise.resolve(),
    state.slotPath ? writeFile(path.join(resolveQueuePath(jobStoreRoot, state.slotPath), "heartbeat.json"), heartbeat, "utf-8") : Promise.resolve(),
  ]);
}

async function releaseJobLocks(jobStoreRoot: string, state: WorkerJobState): Promise<void> {
  await Promise.all([
    state.claimPath ? rm(resolveQueuePath(jobStoreRoot, state.claimPath), { recursive: true, force: true }) : Promise.resolve(),
    state.slotPath ? rm(resolveQueuePath(jobStoreRoot, state.slotPath), { recursive: true, force: true }) : Promise.resolve(),
  ]);
}

function resolveQueuePath(jobStoreRoot: string, targetPath: string): string {
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(jobStoreRoot, targetPath);
  if (!pathIsWithin(resolved, jobStoreRoot)) {
    throw new Error(`Caminho fora da fila de jobs: ${targetPath}`);
  }
  return resolved;
}

function pathIsWithin(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoot = path.resolve(rootPath);
  const normalizedCandidate = resolvedCandidate.toLowerCase();
  const normalizedRoot = resolvedRoot.toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function safeWorkerId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 96) || `runner-${process.pid}`;
}

function appendWorkerEvents(job: WorkerJobState, chunk: string): void {
  const lines = `${job.stderrEventBuffer ?? ""}${chunk}`.split(/\r?\n/);
  job.stderrEventBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const event = parseWorkerEvent(line.trim());
    if (event) {
      job.events.push(event);
    }
  }
  if (job.events.length > 200) {
    job.events = job.events.slice(job.events.length - 200);
  }
}

function parseWorkerEvent(line: string): WorkerJobEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { kind?: unknown }).kind !== "worker_event") {
      return null;
    }
    return parsed as WorkerJobEvent;
  } catch {
    return null;
  }
}

function parseWorkerJobOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function capWorkerLog(value: string): string {
  const maxLength = 128 * 1024;
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}
