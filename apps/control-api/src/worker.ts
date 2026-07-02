import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkerInvocation {
  workspaceRoot: string;
  projectRoot: string;
  command: "run-python-block" | "preview-source" | "train-baseline" | "evaluate-model" | "backtest-models";
  project: unknown;
  pipeline: unknown;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface WorkerFailureDetails {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  parsedOutput?: unknown;
}

export class WorkerExecutionError extends Error {
  constructor(
    message: string,
    public readonly details: WorkerFailureDetails,
  ) {
    super(message);
    this.name = "WorkerExecutionError";
  }
}

export function workerPythonExecutable(): string {
  return process.env.MLOPS_WORKER_PYTHON || "python";
}

export async function runWorker(invocation: WorkerInvocation): Promise<unknown> {
  const workerScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../worker/mlops_worker/cli.py");
  const pythonExecutable = workerPythonExecutable();
  const timeoutMs = Math.max(1000, Math.min(invocation.timeoutMs ?? 30_000, 120_000));
  const request = {
    command: invocation.command,
    projectRoot: invocation.projectRoot,
    project: invocation.project,
    pipeline: invocation.pipeline,
    ...(invocation.payload ?? {}),
  };

  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [workerScript], {
      cwd: invocation.workspaceRoot,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new WorkerExecutionError(`Não foi possível iniciar o worker Python: ${error.message}`, {
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          timedOut,
        }),
      );
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const parsedOutput = parseWorkerOutput(stdout);
      if (exitCode !== 0 || timedOut) {
        reject(
          new WorkerExecutionError(timedOut ? "Worker Python excedeu o timeout." : "Worker Python falhou.", {
            exitCode,
            signal,
            stdout,
            stderr,
            timedOut,
            parsedOutput,
          }),
        );
        return;
      }
      if (parsedOutput === undefined) {
        reject(
          new WorkerExecutionError("Worker Python não retornou JSON válido.", {
            exitCode,
            signal,
            stdout,
            stderr,
            timedOut,
          }),
        );
        return;
      }
      resolve(parsedOutput);
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf-8");
  });
}

function parseWorkerOutput(stdout: string): unknown {
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
