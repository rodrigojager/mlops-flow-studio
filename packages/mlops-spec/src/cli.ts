import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  analyzeMLOpsProject,
  mlopsProjectJsonSchema,
  parseMLOpsProject,
  parsePipelineFlow,
  pipelineFlowJsonSchema,
  promotionPolicyJsonSchema,
  runtimeManifestJsonSchema,
} from "./index.ts";

async function main() {
  const [command = "validate", target = "."] = process.argv.slice(2);
  if (command === "schema") {
    printSchema(target);
    return;
  }
  if (command !== "validate") {
    fail(`Comando desconhecido: ${command}`);
  }

  const root = path.resolve(target);
  const rootStat = await stat(root);
  const projectPath = rootStat.isDirectory() ? path.join(root, "project.yaml") : root;
  const pipelinePath = rootStat.isDirectory() ? path.join(root, "pipeline.flow.json") : path.join(path.dirname(root), "pipeline.flow.json");
  const project = parseMLOpsProject(await readStructuredFile(projectPath));
  const pipeline = parsePipelineFlow(await readStructuredFile(pipelinePath));
  const analysis = analyzeMLOpsProject(project, pipeline);

  console.log(JSON.stringify({ status: analysis.status, summary: analysis.summary, diagnostics: analysis.diagnostics }, null, 2));
  if (analysis.status !== "ok") {
    process.exitCode = 1;
  }
}

function printSchema(target: string): void {
  if (target === "project") {
    console.log(JSON.stringify(mlopsProjectJsonSchema(), null, 2));
    return;
  }
  if (target === "pipeline") {
    console.log(JSON.stringify(pipelineFlowJsonSchema(), null, 2));
    return;
  }
  if (target === "promotion-policy") {
    console.log(JSON.stringify(promotionPolicyJsonSchema(), null, 2));
    return;
  }
  if (target === "runtime-manifest") {
    console.log(JSON.stringify(runtimeManifestJsonSchema(), null, 2));
    return;
  }
  fail("schema deve ser project, pipeline, promotion-policy ou runtime-manifest.");
}

async function readStructuredFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf-8");
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    return YAML.parse(raw);
  }
  return JSON.parse(raw);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
