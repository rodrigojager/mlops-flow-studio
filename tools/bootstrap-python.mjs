import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const venvDir = path.resolve(root, ".venv");
const relativeVenv = path.relative(root, venvDir);
if (relativeVenv.startsWith("..") || path.isAbsolute(relativeVenv)) {
  throw new Error("O ambiente Python deve permanecer dentro do workspace.");
}

const recreate = process.argv.includes("--recreate");
const optional = process.argv.includes("--optional");
if (recreate && existsSync(venvDir)) {
  await rm(venvDir, { recursive: true, force: true });
}
if (!existsSync(venvDir)) {
  await run(process.env.PYTHON ?? "python", ["-m", "venv", venvDir]);
}

const python = venvPython(venvDir);
await run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
const lockFile = path.join(root, "requirements", optional ? "python-optional.lock" : "python.lock");
await run(python, ["-m", "pip", "install", "--requirement", lockFile]);
await run(python, ["-m", "pip", "check"]);
console.log(JSON.stringify({ status: "ok", python, lockFile: path.relative(root, lockFile), optional }, null, 2));

function venvPython(directory) {
  return process.platform === "win32" ? path.join(directory, "Scripts", "python.exe") : path.join(directory, "bin", "python");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} terminou com código ${code}.`)));
  });
}
