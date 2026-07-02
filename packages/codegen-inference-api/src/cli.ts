import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseMLOpsProject, parsePipelineFlow } from "@mlops-flow-studio/mlops-spec";
import { generateInferenceApi } from "./index.ts";

async function main() {
  const args = process.argv.slice(2);
  const projectArg = option(args, "--project") ?? ".";
  const outArg = option(args, "--out") ?? "generated/mlops-runtime";
  const projectRoot = path.resolve(projectArg);
  const outDir = path.resolve(outArg);
  await mkdir(path.dirname(outDir), { recursive: true });
  const project = parseMLOpsProject(YAML.parse(await readFile(path.join(projectRoot, "project.yaml"), "utf-8")));
  const pipeline = parsePipelineFlow(JSON.parse(await readFile(path.join(projectRoot, project.pipelineRef), "utf-8")));
  await generateInferenceApi({ project, pipeline, projectRoot, outDir });
  console.log(JSON.stringify({ status: "ok", outDir }, null, 2));
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
