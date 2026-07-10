import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const isolated = process.platform === "win32" ? path.join(root, ".venv", "Scripts", "python.exe") : path.join(root, ".venv", "bin", "python");
const python = existsSync(isolated) ? isolated : process.env.PYTHON ?? "python";
const child = spawn(python, process.argv.slice(2), {
  cwd: root,
  env: { ...process.env, PYTHONPATH: "" },
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
