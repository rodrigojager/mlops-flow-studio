import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const isolated = process.platform === "win32" ? path.join(root, ".venv", "Scripts", "python.exe") : path.join(root, ".venv", "bin", "python");
const python = existsSync(isolated) ? isolated : process.env.PYTHON ?? "python";
const runtimes = ["generated/support-ticket-runtime", "generated/legal-classification-runtime"];

for (const runtime of runtimes) {
  await run(python, ["-m", "pytest", "tests", "-q"], path.join(root, runtime));
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONPATH: "", MLOPS_RUNTIME_API_KEY: "test-runtime-api-key-with-32-characters" },
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} terminou com código ${code} em ${cwd}.`)));
  });
}
