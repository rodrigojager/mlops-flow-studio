import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { MLOpsProject, PipelineFlow, RuntimeManifest } from "@mlops-flow-studio/mlops-spec";
import { CONTRACT_VERSION, inferRuntimeInfrastructure, inferRuntimeManifestCapabilities } from "@mlops-flow-studio/mlops-spec";
import { renderContractTestPy } from "./templates/contract-test.ts";
import { renderDashboardPy } from "./templates/dashboard.ts";
import { renderMainPy } from "./templates/main.ts";
import { renderRepositoryPy } from "./templates/repository.ts";
import { renderRuntimePy } from "./templates/runtime.ts";

export interface GenerateInferenceApiOptions {
  project: MLOpsProject;
  pipeline: PipelineFlow;
  projectRoot: string;
  outDir: string;
}

export interface RuntimeFile {
  relativePath: string;
  content: string;
}

export async function generateInferenceApi(options: GenerateInferenceApiOptions): Promise<void> {
  const { project, pipeline, projectRoot, outDir } = options;
  assertSafeOutputDirectory(outDir);
  await resetOutputDirectory(outDir);
  await mkdir(path.join(outDir, "app", "metadata"), { recursive: true });
  await mkdir(path.join(outDir, "app", "custom_code"), { recursive: true });
  await mkdir(path.join(outDir, "migrations"), { recursive: true });
  await mkdir(path.join(outDir, "tests"), { recursive: true });
  await mkdir(path.join(outDir, ".mlops"), { recursive: true });
  await mkdir(path.join(outDir, ".mlops", "artifacts"), { recursive: true });

  const trainingSnapshot = await collectTrainingSnapshot(projectRoot, project);
  const manifest = await runtimeManifest(project, pipeline, projectRoot);
  const generatedMeta = await generatedMetadata(project, pipeline, projectRoot, trainingSnapshot.latest);
  const canonicalManifests = renderCanonicalManifestFiles(project, pipeline, manifest, trainingSnapshot.latest);
  const orchestrationManifest = renderOrchestrationManifest(project, manifest);

  const projectYaml = YAML.stringify(project);
  await writeFile(path.join(outDir, ".mlops", "project.yaml"), projectYaml, "utf-8");
  await writeFile(path.join(outDir, ".mlops", "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
  await writeFile(path.join(outDir, ".mlops", "generated-meta.json"), `${JSON.stringify(generatedMeta, null, 2)}\n`, "utf-8");
  await writeFile(path.join(outDir, ".mlops", "runtime.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  for (const file of canonicalManifests) {
    await writeFile(path.join(outDir, ".mlops", file.relativePath), file.content, "utf-8");
  }
  await writeFile(path.join(outDir, ".mlops", "orchestration_manifest.yaml"), orchestrationManifest, "utf-8");
  if (trainingSnapshot.runsRoot) {
    await cp(trainingSnapshot.runsRoot, path.join(outDir, ".mlops", "artifacts", "training_runs"), { recursive: true, force: true });
  }
  if (trainingSnapshot.datasetVersionsRoot) {
    await cp(trainingSnapshot.datasetVersionsRoot, path.join(outDir, ".mlops", "artifacts", "dataset_versions"), { recursive: true, force: true });
  }
  if (trainingSnapshot.latest) {
    const latest = `${JSON.stringify(trainingSnapshot.latest, null, 2)}\n`;
    await writeFile(path.join(outDir, ".mlops", "latest-training-result.json"), latest, "utf-8");
    await writeFile(path.join(outDir, "app", "metadata", "latest-training-result.json"), latest, "utf-8");
  }

  await writeFile(path.join(outDir, "app", "metadata", "project.json"), `${JSON.stringify(project, null, 2)}\n`, "utf-8");
  await writeFile(path.join(outDir, "app", "metadata", "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
  await writeFile(path.join(outDir, "app", "metadata", "runtime.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  for (const codePath of customCodePaths(pipeline)) {
    const source = path.join(projectRoot, codePath);
    const target = path.join(outDir, "app", "custom_code", codePath.replace(/^code[\\/]/, ""));
    const reimportTarget = path.join(outDir, ".mlops", "custom_code", codePath);
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(path.dirname(reimportTarget), { recursive: true });
    if (await pathExists(source)) {
      await cp(source, target, { force: true });
      await cp(source, reimportTarget, { force: true });
    }
  }

  for (const file of renderRuntimeFiles(project, pipeline, manifest, trainingSnapshot.latest)) {
    const target = path.join(outDir, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf-8");
  }
}

async function resetOutputDirectory(outDir: string): Promise<void> {
  try {
    await rm(outDir, { recursive: true, force: true });
  } catch (error) {
    if (!isPermissionError(error)) {
      throw error;
    }
    await removeOutputDirectoryContents(outDir);
  }
}

async function removeOutputDirectoryContents(outDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === ".pytest_cache") {
      continue;
    }
    const target = path.join(outDir, entry.name);
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      if (isPermissionError(error)) {
        continue;
      }
      throw error;
    }
  }
}

function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES");
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function projectFingerprint(project: MLOpsProject, projectRoot: string): Promise<string> {
  return createHash("sha256")
    .update(stableJson({ project, assets: await fingerprintAssets(projectRoot, ["project.yaml"]) }))
    .digest("hex");
}

export async function pipelineFingerprint(pipeline: PipelineFlow, projectRoot: string): Promise<string> {
  return createHash("sha256")
    .update(stableJson({ pipeline, assets: await fingerprintAssets(projectRoot, customCodePaths(pipeline)) }))
    .digest("hex");
}

async function runtimeManifest(project: MLOpsProject, pipeline: PipelineFlow, projectRoot: string): Promise<RuntimeManifest> {
  const capabilities = inferRuntimeManifestCapabilities(pipeline, project);
  const infrastructure = inferRuntimeInfrastructure(capabilities);
  return {
    id: `${project.id}-runtime`,
    projectId: project.id,
    projectVersion: project.version,
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    projectHash: await projectFingerprint(project, projectRoot),
    pipelineHash: await pipelineFingerprint(pipeline, projectRoot),
    activeModelId: activeModelId(pipeline),
    executionProfile: project.execution.profile,
    persistence: project.runtime.persistence,
    capabilities,
    infrastructure,
    endpoints: [
      "GET /health",
      "GET /metadata",
      "GET /environment/gpu",
      "GET /model-card",
      "GET /models",
      "GET /models/active",
      "GET /models/{model_id}",
      "POST /models/register",
      "POST /models/{model_id}/promote",
      "GET /metrics/model",
      "GET /metrics/runtime",
      "POST /predict",
      "POST /feedback",
      "GET /feedback/summary",
      "POST /retraining/requests",
      "POST /retraining/requests/{request_id}/approve",
      "GET /retraining/requests/{request_id}/training-set",
      "POST /retraining/requests/{request_id}/complete",
      "GET /retraining/status",
      "POST /evaluate",
      "POST /backtest",
      "POST /drift",
      "GET /drift/latest",
      "GET /promotion/status",
      "GET /deployment/status",
      "POST /deployment/shadow",
      "POST /deployment/canary",
      "POST /deployment/rollback",
      "GET /experiments/ab-tests",
      "GET /experiments/ab-tests/latest",
      "POST /experiments/ab-tests",
      "POST /experiments/ab-tests/{experiment_id}/complete",
      "GET /domain/legal",
      "GET /embeddings/profiles",
      "POST /embeddings/profiles/register",
      "POST /embeddings/profiles/{profile_id}/activate",
      "POST /embeddings/search",
      "POST /embeddings/reindex",
      "GET /dashboard",
    ],
  };
}

async function generatedMetadata(project: MLOpsProject, pipeline: PipelineFlow, projectRoot: string, latestTrainingResult: Record<string, unknown> | null) {
  return {
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    projectId: project.id,
    projectVersion: project.version,
    projectHash: await projectFingerprint(project, projectRoot),
    pipelineHash: await pipelineFingerprint(pipeline, projectRoot),
    reimportPackage: ".mlops",
    generatedAt: new Date().toISOString(),
    sourceFiles: ["project.yaml", project.pipelineRef],
    latestTrainingRunId: latestTrainingResult?.runId ?? null,
  };
}

function renderCanonicalManifestFiles(project: MLOpsProject, pipeline: PipelineFlow, manifest: RuntimeManifest, latestTrainingResult: Record<string, unknown> | null): RuntimeFile[] {
  const generatedAt = manifest.generatedAt;
  const activeModel = activeModelId(pipeline);
  const modelNodes = pipeline.nodes.filter((node) => node.type === "model");
  const pythonNodes = pipeline.nodes.filter((node) => node.type === "python_function");
  const dataSourceNodes = pipeline.nodes.filter((node) => node.type === "data_source");
  const dependencies = pythonDependencies(project, pipeline, latestTrainingResult);
  const capabilities = manifest.capabilities;
  const infrastructure = manifest.infrastructure;
  const rawDatasetVersion = latestTrainingResult ? latestTrainingResult.datasetVersion : null;
  const latestDatasetVersion = isRecord(rawDatasetVersion) ? rawDatasetVersion : null;
  const latestRunId = typeof latestTrainingResult?.runId === "string" ? latestTrainingResult.runId : null;
  const bestModelId = typeof latestTrainingResult?.bestModelId === "string" ? latestTrainingResult.bestModelId : null;
  const leaderboard = Array.isArray(latestTrainingResult?.leaderboard) ? latestTrainingResult.leaderboard.filter(isRecord) : [];
  const base = {
    contract: CONTRACT_VERSION,
    projectId: project.id,
    projectVersion: project.version,
    generatedAt,
  };
  const files: Array<{ relativePath: string; value: Record<string, unknown> }> = [
    {
      relativePath: "capabilities.yaml",
      value: {
        ...base,
        kind: "capability_manifest",
        principle: "Pipeline é um DAG configurável; capacidades e providers são opcionais e inferidos do grafo.",
        capabilities,
        infrastructure,
        templates: {
          validationCase: project.template?.validationCase === true,
          templateId: project.template?.id ?? null,
          category: project.template?.category ?? "custom",
        },
      },
    },
    {
      relativePath: "data_source.yaml",
      value: {
        ...base,
        kind: "data_source",
        connectors: project.dataSources.map((source) => {
          const boundNodes = dataSourceNodes.filter((node) => node.dataSourceId === source.id);
          return {
            id: source.id,
            type: source.type,
            label: source.label,
            description: source.description ?? null,
            sensitive: source.sensitive,
            schemaHash: hashObject(source.schema ?? {}),
            schema: source.schema ?? {},
            sensitiveFields: source.sensitiveFields,
            descriptor: safeDataSourceDescriptor(source),
            secretReferences: dataSourceSecretReferences(source),
            pipelineBindings: boundNodes.map((node) => ({
              nodeId: node.id,
              label: node.label ?? node.id,
              outgoingEdges: pipeline.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to),
            })),
          };
        }),
        connectorTypes: Array.from(new Set(project.dataSources.map((source) => source.type))).sort(),
        safety: {
          secretsByReferenceOnly: true,
          rawRowsIncluded: false,
          sqlQueryStoredAsHashOnly: true,
          apiHeaderValuesStoredAsReferencesOnly: true,
        },
      },
    },
    {
      relativePath: "dataset_manifest.yaml",
      value: {
        ...base,
        kind: "dataset_manifest",
        target: project.problem.target,
        sources: project.dataSources.map((source) => ({
          id: source.id,
          type: source.type,
          label: source.label,
          sensitive: source.sensitive,
          schemaHash: hashObject(source.schema ?? {}),
          schema: source.schema ?? {},
          sensitiveFields: source.sensitiveFields,
          descriptor: safeDataSourceDescriptor(source),
        })),
        latestDatasetVersion: latestDatasetVersion
          ? {
            id: latestDatasetVersion.datasetVersionId ?? latestDatasetVersion.id ?? null,
            sourceId: latestDatasetVersion.sourceId ?? null,
            sourceType: latestDatasetVersion.sourceType ?? null,
            sourceMode: latestDatasetVersion.sourceMode ?? null,
            rowCount: latestDatasetVersion.rowCount ?? null,
            schemaHash: latestDatasetVersion.schemaHash ?? null,
            rowArtifact: latestDatasetVersion.rowArtifact ?? null,
          }
          : null,
      },
    },
    {
      relativePath: "feature_set.yaml",
      value: {
        ...base,
        kind: "feature_set",
        features: inferFeatureSet(project, pipeline),
        transformations: pipeline.nodes
          .filter((node) => ["preprocess", "embedding", "operator", "python_function"].includes(node.type))
          .map((node) => ({
            id: node.id,
            type: node.type,
            label: node.label,
            dependencies: node.dependencies ?? [],
            configHash: hashObject(node.config ?? {}),
          })),
        dependencies,
        leakageChecks: [
          "target_excluded_from_features",
          "sensitive_fields_masked_in_previews",
          "temporal_split_required_for_temporal_problems",
        ],
      },
    },
    {
      relativePath: "experiment_manifest.yaml",
      value: {
        ...base,
        kind: "experiment_manifest",
        latestTrainingRunId: latestRunId,
        problemType: project.problem.type,
        primaryMetric: project.metrics.primary,
        secondaryMetrics: project.metrics.secondary,
        candidates: modelNodes.map((node) => ({
          id: node.id,
          label: node.label,
          algorithm: node.algorithm ?? null,
          framework: node.framework ?? null,
          role: node.modelRole ?? null,
          task: node.task ?? project.problem.type,
          dependencies: node.dependencies ?? [],
          metrics: leaderboard.find((item) => item.modelId === node.id)?.metrics ?? null,
        })),
        pythonBlocks: pythonNodes.map((node) => ({
          id: node.id,
          label: node.label,
          entrypoint: node.python?.entrypoint ?? null,
          networkPolicy: node.python?.networkPolicy ?? "none",
          dependencies: node.python?.dependencies ?? [],
        })),
      },
    },
    {
      relativePath: "training_manifest.yaml",
      value: {
        ...base,
        kind: "training_manifest",
        latestTrainingRunId: latestRunId,
        status: latestTrainingResult?.status ?? null,
        trainingMode: latestTrainingResult?.trainingMode ?? null,
        datasetVersionId: latestDatasetVersion?.datasetVersionId ?? null,
        bestModelId,
        activeModelId: activeModel,
        primaryMetric: latestTrainingResult?.primaryMetric ?? project.metrics.primary,
        leaderboard: leaderboard.map((item) => ({
          modelId: item.modelId ?? null,
          label: item.label ?? null,
          algorithm: item.algorithm ?? null,
          metrics: item.metrics ?? {},
        })),
        promotionEvidence: Array.isArray(latestTrainingResult?.promotionEvidence) ? latestTrainingResult.promotionEvidence : [],
        artifacts: Array.isArray(latestTrainingResult?.artifacts) ? latestTrainingResult.artifacts : [],
      },
    },
    {
      relativePath: "promotion_policy.yaml",
      value: {
        ...base,
        kind: "promotion_policy",
        policyId: project.promotionPolicy.id,
        mode: project.promotionPolicy.mode,
        baseline: project.promotionPolicy.baseline,
        primaryMetric: project.metrics.primary,
        secondaryMetrics: project.metrics.secondary,
        activeModelId: activeModel,
        bestModelId,
        rules: project.promotionPolicy.rules,
        ruleCount: countPromotionRules(project.promotionPolicy.rules),
        source: "project.yaml#promotionPolicy",
        application: {
          recommendationEndpoint: "GET /promotion/status",
          manualApprovalRequired: project.promotionPolicy.mode !== "automatic",
          promotionAppliedByStudio: true,
        },
      },
    },
    {
      relativePath: "model_card.yaml",
      value: {
        ...base,
        kind: "model_card",
        activeModelId: activeModel,
        bestModelId,
        intendedUse: project.modelCard.intendedUse,
        limitations: project.modelCard.limitations,
        monitoring: project.modelCard.monitoring,
        riskLevel: project.modelCard.riskLevel,
        problem: project.problem,
        metrics: project.metrics,
        sensitiveFields: project.sensitiveFields,
      },
    },
    {
      relativePath: "api_manifest.yaml",
      value: {
        ...base,
        kind: "api_manifest",
        runtimeId: manifest.id,
        apiName: project.runtime.apiName,
        routePrefix: project.runtime.routePrefix,
        endpoints: manifest.endpoints.map((endpoint) => {
          const [method, route] = endpoint.split(" ", 2);
          return { method, path: route, contractEndpoint: true };
        }),
        persistence: manifest.persistence,
        dashboard: project.runtime.dashboard,
        dataSourceEndpoints: dataSourceNodes.map((node) => ({
          nodeId: node.id,
          dataSourceId: node.dataSourceId ?? null,
          type: project.dataSources.find((source) => source.id === node.dataSourceId)?.type ?? null,
        })),
      },
    },
    {
      relativePath: "container_manifest.yaml",
      value: {
        ...base,
        kind: "container_manifest",
        runtimeId: manifest.id,
        image: {
          dockerfile: "Dockerfile",
          compose: "docker-compose.yml",
          gpuCompose: "docker-compose.gpu.yml",
          orchestrationCompose: "docker-compose.orchestration.yml",
          labels: {
            "io.mlops-flow.contract": CONTRACT_VERSION,
            "io.mlops-flow.project-id": project.id,
            "io.mlops-flow.project-version": project.version,
            "io.mlops-flow.project-hash": manifest.projectHash,
            "io.mlops-flow.pipeline-hash": manifest.pipelineHash,
            "io.mlops-flow.active-model-id": activeModel,
            "io.mlops-flow.execution-profile": project.execution.profile,
          },
        },
        ports: { api: "env:API_HOST_PORT", postgres: "internal-only" },
        executionProfile: project.execution.profile,
        persistence: project.runtime.persistence,
        smokeTests: manifest.endpoints.filter((endpoint) => ["GET /health", "GET /metadata", "GET /models/active", "POST /predict"].includes(endpoint)),
      },
    },
  ];

  return files.map((file) => ({ relativePath: file.relativePath, content: YAML.stringify(file.value) }));
}

function countPromotionRules(rules: unknown[]): number {
  let total = 0;
  for (const rule of rules) {
    if (!isRecord(rule)) {
      continue;
    }
    if (rule.kind === "group" && Array.isArray(rule.rules)) {
      total += countPromotionRules(rule.rules);
      continue;
    }
    total += 1;
  }
  return total;
}

function safeDataSourceDescriptor(source: MLOpsProject["dataSources"][number]): Record<string, unknown> {
  if (source.type === "csv") {
    return { path: source.csv?.path ?? null, delimiter: source.csv?.delimiter ?? ",", encoding: source.csv?.encoding ?? "utf-8" };
  }
  if (source.type === "sql") {
    return { connectionRef: source.sql?.connectionRef ?? null, queryHash: hashObject({ query: source.sql?.query ?? "" }), previewLimit: source.sql?.previewLimit ?? null };
  }
  if (source.type === "api") {
    const url = source.api?.url;
    let safeUrl: Record<string, unknown> | null = null;
    if (url) {
      try {
        const parsed = new URL(url);
        safeUrl = { protocol: parsed.protocol, host: parsed.host, pathname: parsed.pathname };
      } catch {
        safeUrl = { invalid: true };
      }
    }
    return {
      method: source.api?.method ?? "GET",
      url: safeUrl,
      headerRefs: Object.keys(source.api?.headers ?? {}).sort(),
      paginationMode: source.api?.pagination?.mode ?? "none",
      timeoutSeconds: source.api?.timeoutSeconds ?? null,
      mocks: (source.api?.mocks ?? []).map((mock) => ({ id: mock.id, description: mock.description })),
    };
  }
  return {};
}

function dataSourceSecretReferences(source: MLOpsProject["dataSources"][number]): Record<string, unknown> {
  if (source.type === "sql") {
    return { connectionRef: source.sql?.connectionRef ?? null };
  }
  if (source.type === "api") {
    return {
      headers: Object.entries(source.api?.headers ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, ref]) => ({ name, ref })),
    };
  }
  return {};
}

function inferFeatureSet(project: MLOpsProject, pipeline: PipelineFlow): Array<Record<string, unknown>> {
  const sensitiveFields = new Set(project.sensitiveFields);
  const sourceFields = project.dataSources.flatMap((source) => Object.keys(source.schema ?? {}));
  const inferred = sourceFields.length ? sourceFields : ["input"];
  return Array.from(new Set(inferred))
    .filter((field) => field !== project.problem.target)
    .map((field) => ({ name: field, sensitive: sensitiveFields.has(field), source: "project_schema", pipelineHash: hashObject(pipeline.nodes.map((node) => ({ id: node.id, type: node.type }))) }));
}

function hashObject(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function renderOrchestrationManifest(project: MLOpsProject, manifest: RuntimeManifest): string {
  return YAML.stringify({
    kind: "orchestration_manifest",
    contract: CONTRACT_VERSION,
    projectId: project.id,
    projectVersion: project.version,
    runtimeId: manifest.id,
    generatedAt: manifest.generatedAt,
    optional: true,
    requirementsFile: "requirements-orchestration.txt",
    composeFile: "docker-compose.orchestration.yml",
    runners: [
      {
        id: "prefect",
        label: "Prefect",
        entrypoint: "orchestration/prefect_flow.py",
        flows: [
          { name: "runtime_readiness_flow", mode: "read_only", endpoints: ["GET /health", "GET /metadata", "GET /models/active", "GET /metrics/runtime"] },
          { name: "controlled_retraining_request_flow", mode: "mutable_confirmed", endpoints: ["POST /retraining/requests", "POST /retraining/requests/{request_id}/approve"] },
        ],
      },
      {
        id: "celery",
        label: "Celery",
        entrypoint: "orchestration/celery_app.py",
        tasks: [
          { name: "mlops_runtime.health", mode: "read_only", endpoints: ["GET /health"] },
          { name: "mlops_runtime.readiness", mode: "read_only", endpoints: ["GET /health", "GET /metadata", "GET /models/active", "GET /metrics/runtime"] },
          { name: "mlops_runtime.request_retraining", mode: "mutable_confirmed", endpoints: ["POST /retraining/requests", "POST /retraining/requests/{request_id}/approve"] },
        ],
      },
    ],
    safety: {
      dependenciesAreOptional: true,
      composeOverlayIsOptional: true,
      mutableTasksRequireConfirm: true,
      secretsByReferenceOnly: true,
      defaultRuntimeBaseUrl: "env:RUNTIME_BASE_URL",
      celeryBrokerUrl: "env:CELERY_BROKER_URL",
      celeryResultBackend: "env:CELERY_RESULT_BACKEND",
      redisDataVolume: "mlops-orchestration-redis",
    },
  });
}

function renderRuntimeFiles(project: MLOpsProject, pipeline: PipelineFlow, manifest: RuntimeManifest, latestTrainingResult: Record<string, unknown> | null): RuntimeFile[] {
  const dependencies = pythonDependencies(project, pipeline, latestTrainingResult);
  return [
    { relativePath: "README.md", content: renderReadme(project, manifest) },
    { relativePath: "requirements.txt", content: `${dependencies.join("\n")}\n` },
    { relativePath: "requirements-dev.txt", content: renderDevRequirements() },
    { relativePath: "requirements-orchestration.txt", content: renderOrchestrationRequirements() },
    { relativePath: ".env.example", content: renderEnvExample(project, manifest) },
    { relativePath: "Dockerfile", content: renderDockerfile(project, pipeline, manifest) },
    { relativePath: "docker-compose.yml", content: renderDockerCompose(project) },
    { relativePath: "docker-compose.capabilities.yml", content: renderDockerComposeCapabilities(manifest) },
    { relativePath: "docker-compose.gpu.yml", content: renderDockerComposeGpu() },
    { relativePath: "docker-compose.orchestration.yml", content: renderDockerComposeOrchestration() },
    { relativePath: "orchestration/__init__.py", content: "" },
    { relativePath: "orchestration/README.md", content: renderOrchestrationReadme(project) },
    { relativePath: "orchestration/prefect_flow.py", content: renderPrefectFlowPy(project) },
    { relativePath: "orchestration/celery_app.py", content: renderCeleryAppPy(project) },
    { relativePath: "grpc/README.md", content: renderGrpcReadme(project) },
    { relativePath: "grpc/legal_classification.proto", content: renderGrpcProto(project) },
    { relativePath: "migrations/001_init.sql", content: renderMigrationSql() },
    { relativePath: "app/__init__.py", content: "" },
    { relativePath: "app/settings.py", content: renderSettingsPy() },
    { relativePath: "app/security.py", content: renderSecurityPy() },
    { relativePath: "app/lifecycle.py", content: renderLifecyclePy() },
    { relativePath: "app/db.py", content: renderDbPy() },
    { relativePath: "app/repository.py", content: renderRepositoryPy() },
    { relativePath: "app/environment.py", content: renderEnvironmentPy() },
    { relativePath: "app/runtime.py", content: renderRuntimePy() },
    { relativePath: "app/dashboard.py", content: renderDashboardPy() },
    { relativePath: "app/main.py", content: renderMainPy() },
    { relativePath: "tests/test_contract.py", content: renderContractTestPy() },
  ];
}

function renderReadme(project: MLOpsProject, manifest: RuntimeManifest): string {
  return `# ${project.name}

Runtime FastAPI gerado pelo MLOps Flow Studio.

## Execução local

\`\`\`powershell
python -m venv .venv
.\\.venv\\Scripts\\Activate.ps1
python -m pip install -r requirements.txt
$env:MLOPS_RUNTIME_API_KEY="gere-uma-chave-aleatoria-com-32-ou-mais-caracteres"
uvicorn app.main:app --reload --port 8080
\`\`\`

## Docker

\`\`\`powershell
Copy-Item .env.example .env
# Edite MLOPS_RUNTIME_API_KEY e POSTGRES_PASSWORD em .env antes de continuar.
docker compose up -d --build
\`\`\`

Para evitar conflito com serviços locais, sobrescreva as portas publicadas:

\`\`\`powershell
$env:API_HOST_PORT="18080"; docker compose up -d --build
\`\`\`

## Capacidades opcionais

O grafo pode pedir providers em modo \`container\` para capacidades como Qdrant, MLflow ou worker. Esses serviços ficam em um overlay separado:

\`\`\`powershell
docker compose -f docker-compose.yml -f docker-compose.capabilities.yml up -d --build
\`\`\`

Serviços inferidos neste runtime:

${manifest.infrastructure.services.length ? manifest.infrastructure.services.map((service) => `- \`${service.id}\` (${service.provider}, mode=${service.mode}, required=${service.required})`).join("\n") : "- Nenhum provider em modo container foi solicitado pelo grafo."}

## GPU/CUDA

Perfil de execução gerado: \`${project.execution.profile}\`.

Use o overlay GPU quando quiser subir a API com runtime NVIDIA:

\`\`\`powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
Invoke-RestMethod http://127.0.0.1:8080/environment/gpu -Headers @{ Authorization = "Bearer $env:MLOPS_RUNTIME_API_KEY" }
\`\`\`

O endpoint \`/environment/gpu\` mostra driver visível no container, disponibilidade de Torch/CUDA e fallback efetivo para CPU.

Todos os endpoints, exceto \`/health\`, \`/dashboard\` e a documentação OpenAPI, exigem \`Authorization: Bearer <MLOPS_RUNTIME_API_KEY>\`. O dashboard solicita a chave e a mantém apenas em \`sessionStorage\`.

## Orquestração opcional

O runtime inclui wrappers Prefect/Celery e um overlay opcional com Redis:

\`\`\`powershell
docker compose -f docker-compose.yml -f docker-compose.orchestration.yml up -d --build orchestration-redis celery-worker
\`\`\`

Para subir também o servidor Prefect local:

\`\`\`powershell
docker compose -f docker-compose.yml -f docker-compose.orchestration.yml --profile prefect up -d --build
\`\`\`

## Endpoints principais

${manifest.endpoints.map((endpoint) => `- \`${endpoint}\``).join("\n")}

O pacote de reimportação fica em \`.mlops/\` e não contém segredos reais.
`;
}

function renderOrchestrationRequirements(): string {
  return [
    "prefect>=3,<4",
    "celery>=5,<6",
    "redis>=5,<6",
    "httpx>=0.27,<1",
    "",
  ].join("\n");
}

function renderDevRequirements(): string {
  return [
    "-r requirements.txt",
    "pytest==9.0.2",
    "httpx==0.28.1",
    "",
  ].join("\n");
}

function renderOrchestrationReadme(project: MLOpsProject): string {
  return `# Orquestração opcional

Este diretório contém wrappers opcionais para operar o runtime \`${project.runtime.apiName}\` com Prefect ou Celery.

As dependências não fazem parte do runtime mínimo. Instale apenas quando quiser usar esse modo:

\`\`\`powershell
python -m pip install -r requirements-orchestration.txt
\`\`\`

Variáveis esperadas:

- \`RUNTIME_BASE_URL\`: URL do runtime, por padrão \`http://127.0.0.1:8080\`.
- \`CELERY_BROKER_URL\`: broker Celery, por padrão \`redis://127.0.0.1:6379/0\`.
- \`CELERY_RESULT_BACKEND\`: backend Celery, por padrão igual ao broker.

Para usar Redis/Celery com Docker Compose sem transformar isso em dependência do runtime mínimo:

\`\`\`powershell
docker compose -f docker-compose.yml -f docker-compose.orchestration.yml up -d --build orchestration-redis celery-worker
\`\`\`

Para iniciar também um servidor Prefect local opcional:

\`\`\`powershell
docker compose -f docker-compose.yml -f docker-compose.orchestration.yml --profile prefect up -d --build
\`\`\`

Os fluxos read-only consultam health, metadata, modelo ativo e métricas. Fluxos mutáveis de retreino exigem \`confirm=True\`.
`;
}

function renderGrpcReadme(project: MLOpsProject): string {
  return `# gRPC opcional

Este diretório contém o contrato gRPC interno sugerido para \`${project.runtime.apiName}\`.

O runtime mínimo continua expondo REST/FastAPI. Use o arquivo \`legal_classification.proto\` quando houver um gateway .NET, worker interno ou serviço dedicado que precise de chamadas de baixa latência com contrato estável.

O contrato usa \`google.protobuf.Struct\` para preservar compatibilidade com o schema MLOps e evitar acoplar clientes internos a um modelo de domínio incompleto.
`;
}

function renderGrpcProto(project: MLOpsProject): string {
  const javaPackage = `mlops.${project.id.replace(/[^A-Za-z0-9_]/g, "_")}.grpc`;
  return `syntax = "proto3";

package mlops.legal.v1;

import "google/protobuf/struct.proto";

option csharp_namespace = "MLOps.FlowStudio.LegalClassification.Grpc";
option java_multiple_files = true;
option java_package = "${javaPackage}";

service LegalClassificationService {
  rpc Classify (ClassifyRequest) returns (ClassifyResponse);
  rpc GetEmbeddingProfiles (GetEmbeddingProfilesRequest) returns (EmbeddingProfilesResponse);
  rpc SearchEmbeddings (EmbeddingSearchRequest) returns (EmbeddingSearchResponse);
}

message ClassifyRequest {
  google.protobuf.Struct input = 1;
  bool trace = 2;
}

message ClassifyResponse {
  string run_id = 1;
  string model_version_id = 2;
  string prediction = 3;
  double confidence = 4;
  google.protobuf.Struct decision = 5;
  google.protobuf.Struct explanation = 6;
  google.protobuf.Struct review = 7;
  repeated google.protobuf.Struct top_candidates = 8;
  google.protobuf.Struct embedding_profile = 9;
  google.protobuf.Struct cache = 10;
}

message GetEmbeddingProfilesRequest {}

message EmbeddingProfilesResponse {
  string active_profile_id = 1;
  repeated google.protobuf.Struct profiles = 2;
  google.protobuf.Struct substitution_contract = 3;
}

message EmbeddingSearchRequest {
  string query = 1;
  string collection = 2;
  int32 top_k = 3;
  string profile_id = 4;
}

message EmbeddingSearchResponse {
  string status = 1;
  string profile_id = 2;
  string collection = 3;
  repeated google.protobuf.Struct results = 4;
  string implementation = 5;
}
`;
}

function renderPrefectFlowPy(project: MLOpsProject): string {
  return `from __future__ import annotations

import json
import os
from typing import Any

try:
    import httpx
except Exception:  # pragma: no cover - dependencia opcional
    httpx = None

try:
    from prefect import flow, task
except Exception:  # pragma: no cover - dependencia opcional
    flow = None
    task = None


RUNTIME_BASE_URL = os.getenv("RUNTIME_BASE_URL", "http://127.0.0.1:8080").rstrip("/")
RUNTIME_API_KEY = os.getenv("MLOPS_RUNTIME_API_KEY", "")


def _identity_decorator(*_args: Any, **_kwargs: Any):
    def wrap(fn):
        return fn
    return wrap


flow_decorator = flow if flow is not None else _identity_decorator
task_decorator = task if task is not None else _identity_decorator


def require_dependencies() -> None:
    missing = []
    if httpx is None:
        missing.append("httpx")
    if flow is None or task is None:
        missing.append("prefect")
    if missing:
        raise RuntimeError("Instale dependencias opcionais com: python -m pip install -r requirements-orchestration.txt. Ausentes: " + ", ".join(sorted(set(missing))))


def request_json(method: str, path: str, base_url: str = RUNTIME_BASE_URL, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    require_dependencies()
    assert httpx is not None
    if not RUNTIME_API_KEY:
        raise RuntimeError("MLOPS_RUNTIME_API_KEY é obrigatória para chamar o runtime.")
    url = base_url.rstrip("/") + path
    with httpx.Client(timeout=30.0) as client:
        response = client.request(method, url, json=payload, headers={"Authorization": "Bearer " + RUNTIME_API_KEY})
        response.raise_for_status()
        return response.json()


@task_decorator(name="runtime_health")
def runtime_health(base_url: str = RUNTIME_BASE_URL) -> dict[str, Any]:
    return request_json("GET", "/health", base_url)


@task_decorator(name="runtime_metadata")
def runtime_metadata(base_url: str = RUNTIME_BASE_URL) -> dict[str, Any]:
    return request_json("GET", "/metadata", base_url)


@task_decorator(name="runtime_active_model")
def runtime_active_model(base_url: str = RUNTIME_BASE_URL) -> dict[str, Any]:
    return request_json("GET", "/models/active", base_url)


@task_decorator(name="runtime_metrics")
def runtime_metrics(base_url: str = RUNTIME_BASE_URL) -> dict[str, Any]:
    return request_json("GET", "/metrics/runtime", base_url)


@flow_decorator(name="mlops-runtime-readiness")
def runtime_readiness_flow(base_url: str = RUNTIME_BASE_URL) -> dict[str, Any]:
    require_dependencies()
    return {
        "project": ${JSON.stringify(project.id)},
        "health": runtime_health(base_url),
        "metadata": runtime_metadata(base_url),
        "active_model": runtime_active_model(base_url),
        "runtime_metrics": runtime_metrics(base_url),
    }


@flow_decorator(name="mlops-controlled-retraining-request")
def controlled_retraining_request_flow(base_url: str = RUNTIME_BASE_URL, requested_by: str = "prefect", reason: str = "orchestration_request", confirm: bool = False) -> dict[str, Any]:
    require_dependencies()
    if not confirm:
        raise ValueError("Fluxo mutavel exige confirm=True.")
    request_body = request_json(
        "POST",
        "/retraining/requests",
        base_url,
        {
            "trigger": "manual",
            "reason": reason,
            "requested_by": requested_by,
            "min_feedback_count": 1,
        },
    )
    request_id = str(request_body["request_id"])
    approval_body = request_json(
        "POST",
        "/retraining/requests/" + request_id + "/approve",
        base_url,
        {"confirm": True, "approved_by": requested_by},
    )
    return {"request": request_body, "approval": approval_body}


if __name__ == "__main__":
    print(json.dumps(runtime_readiness_flow(), indent=2, ensure_ascii=False))
`;
}

function renderCeleryAppPy(project: MLOpsProject): string {
  return `from __future__ import annotations

import os
from typing import Any

try:
    import httpx
except Exception:  # pragma: no cover - dependencia opcional
    httpx = None

try:
    from celery import Celery
except Exception:  # pragma: no cover - dependencia opcional
    Celery = None


RUNTIME_BASE_URL = os.getenv("RUNTIME_BASE_URL", "http://127.0.0.1:8080").rstrip("/")
RUNTIME_API_KEY = os.getenv("MLOPS_RUNTIME_API_KEY", "")
CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", "redis://127.0.0.1:6379/0")
CELERY_RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", CELERY_BROKER_URL)

celery_app = Celery("mlops_runtime_orchestration", broker=CELERY_BROKER_URL, backend=CELERY_RESULT_BACKEND) if Celery is not None else None


def _identity_decorator(*_args: Any, **_kwargs: Any):
    def wrap(fn):
        return fn
    return wrap


def task_decorator(*args: Any, **kwargs: Any):
    if celery_app is None:
        return _identity_decorator(*args, **kwargs)
    return celery_app.task(*args, **kwargs)


def require_dependencies() -> None:
    missing = []
    if httpx is None:
        missing.append("httpx")
    if celery_app is None:
        missing.append("celery")
    if missing:
        raise RuntimeError("Instale dependencias opcionais com: python -m pip install -r requirements-orchestration.txt. Ausentes: " + ", ".join(sorted(set(missing))))


def request_json(method: str, path: str, base_url: str | None = None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    require_dependencies()
    assert httpx is not None
    if not RUNTIME_API_KEY:
        raise RuntimeError("MLOPS_RUNTIME_API_KEY é obrigatória para chamar o runtime.")
    url = (base_url or RUNTIME_BASE_URL).rstrip("/") + path
    with httpx.Client(timeout=30.0) as client:
        response = client.request(method, url, json=payload, headers={"Authorization": "Bearer " + RUNTIME_API_KEY})
        response.raise_for_status()
        return response.json()


@task_decorator(name="mlops_runtime.health")
def runtime_health(base_url: str | None = None) -> dict[str, Any]:
    return request_json("GET", "/health", base_url)


@task_decorator(name="mlops_runtime.readiness")
def runtime_readiness(base_url: str | None = None) -> dict[str, Any]:
    return {
        "project": ${JSON.stringify(project.id)},
        "health": request_json("GET", "/health", base_url),
        "metadata": request_json("GET", "/metadata", base_url),
        "active_model": request_json("GET", "/models/active", base_url),
        "runtime_metrics": request_json("GET", "/metrics/runtime", base_url),
    }


@task_decorator(name="mlops_runtime.request_retraining")
def request_controlled_retraining(base_url: str | None = None, requested_by: str = "celery", reason: str = "orchestration_request", confirm: bool = False) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Tarefa mutavel exige confirm=True.")
    request_body = request_json(
        "POST",
        "/retraining/requests",
        base_url,
        {
            "trigger": "manual",
            "reason": reason,
            "requested_by": requested_by,
            "min_feedback_count": 1,
        },
    )
    request_id = str(request_body["request_id"])
    approval_body = request_json(
        "POST",
        "/retraining/requests/" + request_id + "/approve",
        base_url,
        {"confirm": True, "approved_by": requested_by},
    )
    return {"request": request_body, "approval": approval_body}


if __name__ == "__main__":
    if celery_app is None:
        raise SystemExit("Instale dependencias opcionais com: python -m pip install -r requirements-orchestration.txt")
    print("Celery app pronta: mlops_runtime_orchestration. Inicie com 'celery -A orchestration.celery_app worker --loglevel=INFO'.")
`;
}

function renderEnvExample(project: MLOpsProject, manifest: RuntimeManifest): string {
  const hasQdrant = manifest.infrastructure.services.some((service) => service.id === "qdrant");
  const hasMlflow = manifest.infrastructure.services.some((service) => service.id === "mlflow");
  const mlflow = project.runtime.mlflow.enabled || hasMlflow ? "http://mlflow:5000" : "";
  return `APP_NAME=${project.runtime.apiName}
MLOPS_RUNTIME_API_KEY=replace-with-a-random-key-of-at-least-32-characters
POSTGRES_PASSWORD=replace-with-a-random-url-safe-password
DATABASE_URL=sqlite:///./mlops_runtime.db
EXECUTION_PROFILE=${project.execution.profile}
MLFLOW_TRACKING_URI=${mlflow}
QDRANT_URL=${hasQdrant ? "http://qdrant:6333" : ""}
STORE_FULL_PAYLOAD=false
`;
}

function renderDockerfile(project: MLOpsProject, pipeline: PipelineFlow, manifest: RuntimeManifest): string {
  const labels: Record<string, string> = {
    "org.opencontainers.image.title": project.runtime.apiName,
    "org.opencontainers.image.description": `Runtime FastAPI gerado pelo MLOps Flow Studio para ${project.name}.`,
    "io.mlops-flow.contract": CONTRACT_VERSION,
    "io.mlops-flow.project-id": project.id,
    "io.mlops-flow.project-name": project.name,
    "io.mlops-flow.project-version": project.version,
    "io.mlops-flow.project-hash": manifest.projectHash,
    "io.mlops-flow.pipeline-hash": manifest.pipelineHash,
    "io.mlops-flow.active-model-id": activeModelId(pipeline),
    "io.mlops-flow.execution-profile": project.execution.profile,
    "io.mlops-flow.endpoints": JSON.stringify(manifest.endpoints),
  };
  const labelLines = Object.entries(labels)
    .map(([key, value], index) => `      ${key}=${dockerLabelValue(value)}${index === Object.keys(labels).length - 1 ? "" : " \\"}`)
    .join("\n");
  return `FROM python:3.12-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

LABEL \\
${labelLines}

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin runtime
COPY --chown=runtime:runtime . /app

EXPOSE 8080

USER runtime

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \\
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
`;
}

function dockerLabelValue(value: string): string {
  return JSON.stringify(value);
}

function renderDockerCompose(project: MLOpsProject): string {
  const gpuBlock =
    project.execution.profile === "gpu_cuda"
      ? `
    gpus: all
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
`
      : "";
  return `services:
  postgres:
    image: postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
    restart: unless-stopped
    environment:
      POSTGRES_DB: mlops
      POSTGRES_USER: mlops
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mlops -d mlops"]
      interval: 3s
      timeout: 3s
      retries: 20
    volumes:
      - mlops-db-data:/var/lib/postgresql/data

  api:
    build: .
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      APP_NAME: ${JSON.stringify(project.runtime.apiName)}
      MLOPS_RUNTIME_API_KEY: \${MLOPS_RUNTIME_API_KEY:?MLOPS_RUNTIME_API_KEY must be set}
      DATABASE_URL: postgresql+psycopg://mlops:\${POSTGRES_PASSWORD}@postgres:5432/mlops
      EXECUTION_PROFILE: ${project.execution.profile}
      STORE_FULL_PAYLOAD: "false"
      NVIDIA_VISIBLE_DEVICES: ${project.execution.profile === "gpu_cuda" ? "all" : "void"}
      NVIDIA_DRIVER_CAPABILITIES: compute,utility
    ports:
      - "127.0.0.1:\${API_HOST_PORT:-8080}:8080"
    read_only: true
    tmpfs:
      - /tmp
      - /home/runtime/.cache
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
${gpuBlock}
volumes:
  mlops-db-data:
`;
}

function renderDockerComposeCapabilities(manifest: RuntimeManifest): string {
  const services = manifest.infrastructure.services;
  if (!services.length) {
    return `# Nenhuma capacidade com provider em modo container foi solicitada pelo grafo.
services: {}
`;
  }

  const hasQdrant = services.some((service) => service.id === "qdrant");
  const hasMlflow = services.some((service) => service.id === "mlflow");
  const hasWorker = services.some((service) => service.id === "runtime-worker");
  const serviceBlocks: string[] = [];
  const volumes: string[] = [];

  if (hasQdrant) {
    serviceBlocks.push(`  qdrant:
    image: qdrant/qdrant:v1.12.6
    ports:
      - "127.0.0.1:\${QDRANT_HOST_PORT:-6333}:6333"
      - "127.0.0.1:\${QDRANT_GRPC_HOST_PORT:-6334}:6334"
    volumes:
      - mlops-qdrant-data:/qdrant/storage`);
    volumes.push("  mlops-qdrant-data:");
  }

  if (hasMlflow) {
    serviceBlocks.push(`  mlflow:
    image: ghcr.io/mlflow/mlflow:v2.17.2
    ports:
      - "127.0.0.1:\${MLFLOW_HOST_PORT:-5000}:5000"
    volumes:
      - mlops-mlflow-data:/mlflow
    command: >
      mlflow server
      --host 0.0.0.0
      --port 5000
      --backend-store-uri sqlite:////mlflow/mlflow.db
      --default-artifact-root /mlflow/artifacts`);
    volumes.push("  mlops-mlflow-data:");
  }

  if (hasWorker) {
    serviceBlocks.push(`  runtime-redis:
    image: redis:7-alpine
    volumes:
      - mlops-runtime-redis:/data

  runtime-worker:
    build: .
    depends_on:
      - api
      - runtime-redis
    environment:
      RUNTIME_BASE_URL: \${RUNTIME_BASE_URL:-http://api:8080}
      MLOPS_RUNTIME_API_KEY: \${MLOPS_RUNTIME_API_KEY:?MLOPS_RUNTIME_API_KEY must be set}
      CELERY_BROKER_URL: redis://runtime-redis:6379/0
      CELERY_RESULT_BACKEND: redis://runtime-redis:6379/0
      QDRANT_URL: \${QDRANT_URL:-http://qdrant:6333}
      MLFLOW_TRACKING_URI: \${MLFLOW_TRACKING_URI:-http://mlflow:5000}
    command: >
      sh -c "python -m pip install -r requirements-orchestration.txt && celery -A orchestration.celery_app worker --loglevel=\${CELERY_LOG_LEVEL:-INFO}"`);
    volumes.push("  mlops-runtime-redis:");
  }

  return `# Overlay gerado a partir de runtime.manifest.json/infrastructure.services.
# Use apenas quando quiser subir providers opcionais declarados pelo grafo.
services:
${serviceBlocks.join("\n\n")}
${volumes.length ? `\nvolumes:\n${[...new Set(volumes)].join("\n")}\n` : ""}`;
}

function renderDockerComposeGpu(): string {
  return `services:
  api:
    environment:
      EXECUTION_PROFILE: gpu_cuda
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,utility
    gpus: all
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
`;
}

function renderDockerComposeOrchestration(): string {
  return `services:
  orchestration-redis:
    image: redis:7-alpine
    volumes:
      - mlops-orchestration-redis:/data

  celery-worker:
    build: .
    depends_on:
      - orchestration-redis
    environment:
      RUNTIME_BASE_URL: \${RUNTIME_BASE_URL:-http://api:8080}
      MLOPS_RUNTIME_API_KEY: \${MLOPS_RUNTIME_API_KEY:?MLOPS_RUNTIME_API_KEY must be set}
      CELERY_BROKER_URL: redis://orchestration-redis:6379/0
      CELERY_RESULT_BACKEND: redis://orchestration-redis:6379/0
    command: >
      sh -c "python -m pip install -r requirements-orchestration.txt && celery -A orchestration.celery_app worker --loglevel=\${CELERY_LOG_LEVEL:-INFO}"

  prefect-server:
    profiles: ["prefect"]
    build: .
    ports:
      - "127.0.0.1:\${PREFECT_HOST_PORT:-4200}:4200"
    volumes:
      - mlops-prefect-data:/home/runtime/.prefect
    command: >
      sh -c "python -m pip install -r requirements-orchestration.txt && prefect server start --host 0.0.0.0"

volumes:
  mlops-orchestration-redis:
  mlops-prefect-data:
`;
}

function renderSettingsPy(): string {
  return `import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "MLOps Inference API")
    database_url: str = os.getenv("DATABASE_URL", "sqlite:///./mlops_runtime.db")
    execution_profile: str = os.getenv("EXECUTION_PROFILE", "cpu")
    mlflow_tracking_uri: str = os.getenv("MLFLOW_TRACKING_URI", "")
    store_full_payload: bool = os.getenv("STORE_FULL_PAYLOAD", "false").lower() in {"1", "true", "yes", "on"}
    runtime_api_key: str = os.getenv("MLOPS_RUNTIME_API_KEY", "")
    database_connect_attempts: int = int(os.getenv("DATABASE_CONNECT_ATTEMPTS", "30"))
    database_connect_delay_seconds: float = float(os.getenv("DATABASE_CONNECT_DELAY_SECONDS", "1"))

    def __post_init__(self) -> None:
        if len(self.runtime_api_key) < 24:
            raise RuntimeError("MLOPS_RUNTIME_API_KEY deve ter pelo menos 24 caracteres.")


settings = Settings()
`;
}

function renderSecurityPy(): string {
  return `from hmac import compare_digest
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .settings import settings


bearer_scheme = HTTPBearer(auto_error=False, scheme_name="RuntimeBearer")
PUBLIC_PATHS = {"/health", "/dashboard", "/docs", "/redoc", "/openapi.json"}


def require_api_key(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> str | None:
    if request.url.path in PUBLIC_PATHS:
        return None
    if credentials is None or credentials.scheme.lower() != "bearer" or not compare_digest(credentials.credentials, settings.runtime_api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token inválido ou ausente.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return credentials.credentials
`;
}

function renderLifecyclePy(): string {
  return `from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import init_db
from .repository import record_event, seed_domain_metadata, seed_training_metadata
from .runtime import latest_training_result, project, runtime_manifest


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    domain_seed = seed_domain_metadata(project)
    training_seed = seed_training_metadata(latest_training_result, project, runtime_manifest)
    record_event("startup", "Runtime iniciado", {"project_id": project["id"], "version": project["version"], "domain_seed": domain_seed, "training_seed": training_seed})
    yield
`;
}

function renderDbPy(): string {
  return `from datetime import datetime, timezone
from time import sleep
from sqlalchemy import Boolean, Column, DateTime, Float, Integer, JSON, MetaData, String, Table, Text, create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from .settings import settings


engine: Engine = create_engine(settings.database_url, pool_pre_ping=True)
metadata = MetaData()


ingestion_runs = Table("ingestion_runs", metadata, Column("id", String, primary_key=True), Column("source_id", String), Column("status", String), Column("started_at", DateTime(timezone=True)), Column("finished_at", DateTime(timezone=True)), Column("details", JSON))
dataset_versions = Table("dataset_versions", metadata, Column("id", String, primary_key=True), Column("layer", String), Column("uri", String), Column("schema_hash", String), Column("lineage", JSON), Column("quality", JSON), Column("created_at", DateTime(timezone=True)))
feature_set_versions = Table("feature_set_versions", metadata, Column("id", String, primary_key=True), Column("features", JSON), Column("transformations", JSON), Column("dependencies", JSON), Column("created_at", DateTime(timezone=True)))
legal_categories = Table("legal_categories", metadata, Column("code", String, primary_key=True), Column("name", String), Column("target", String), Column("critical", Boolean), Column("requires_human_review", Boolean), Column("workflow_step_codes", JSON), Column("metadata_json", JSON), Column("created_at", DateTime(timezone=True)))
legal_workflow_steps = Table("legal_workflow_steps", metadata, Column("code", String, primary_key=True), Column("name", String), Column("rite", String), Column("order_index", Integer), Column("step_type", String), Column("requires_document", Boolean), Column("requires_human_review", Boolean), Column("sla_hours", Integer), Column("metadata_json", JSON), Column("created_at", DateTime(timezone=True)))
legal_workflow_transitions = Table("legal_workflow_transitions", metadata, Column("id", String, primary_key=True), Column("from_step", String), Column("to_step", String), Column("rite", String), Column("condition", Text), Column("severity", String), Column("active", Boolean), Column("created_at", DateTime(timezone=True)))
legal_processes = Table("legal_processes", metadata, Column("id", String, primary_key=True), Column("process_identifier", String), Column("current_workflow_step", String), Column("metadata_json", JSON), Column("created_at", DateTime(timezone=True)), Column("updated_at", DateTime(timezone=True)))
legal_documents = Table("legal_documents", metadata, Column("id", String, primary_key=True), Column("process_id", String), Column("prediction_run_id", String), Column("prediction_row_id", String), Column("category_code", String), Column("workflow_step_code", String), Column("text_hash", String), Column("metadata_json", JSON), Column("created_at", DateTime(timezone=True)))
legal_andamentos = Table("legal_andamentos", metadata, Column("id", String, primary_key=True), Column("process_id", String), Column("workflow_step_code", String), Column("category_code", String), Column("prediction_row_id", String), Column("status", String), Column("details", JSON), Column("created_at", DateTime(timezone=True)))
embedding_profiles = Table("embedding_profiles", metadata, Column("id", String, primary_key=True), Column("provider", String), Column("model_name", String), Column("model_version", String), Column("model_digest", String), Column("dimension", Integer), Column("similarity_metric", String), Column("preprocessing_version", String), Column("chunking_version", String), Column("status", String), Column("vector_collections", JSON), Column("metadata_json", JSON), Column("created_at", DateTime(timezone=True)))
vector_collections = Table("vector_collections", metadata, Column("id", String, primary_key=True), Column("profile_id", String), Column("logical_name", String), Column("collection_name", String), Column("backend", String), Column("dimension", Integer), Column("similarity_metric", String), Column("status", String), Column("metadata_json", JSON), Column("created_at", DateTime(timezone=True)))
embedding_records = Table("embedding_records", metadata, Column("id", String, primary_key=True), Column("profile_id", String), Column("collection_name", String), Column("entity_type", String), Column("entity_id", String), Column("chunk_id", String), Column("vector", JSON), Column("vector_hash", String), Column("metadata_json", JSON), Column("created_at", DateTime(timezone=True)))
training_runs = Table("training_runs", metadata, Column("id", String, primary_key=True), Column("status", String), Column("algorithm", String), Column("params", JSON), Column("metrics", JSON), Column("artifacts", JSON), Column("started_at", DateTime(timezone=True)), Column("finished_at", DateTime(timezone=True)))
model_versions = Table("model_versions", metadata, Column("id", String, primary_key=True), Column("status", String), Column("algorithm", String), Column("metrics", JSON), Column("artifact_uri", String), Column("is_active", Boolean), Column("created_at", DateTime(timezone=True)))
promotion_decisions = Table("promotion_decisions", metadata, Column("id", String, primary_key=True), Column("candidate_model_id", String), Column("decision", String), Column("evidence", JSON), Column("approved_by", String), Column("created_at", DateTime(timezone=True)))
deployment_rollouts = Table("deployment_rollouts", metadata, Column("id", String, primary_key=True), Column("kind", String), Column("status", String), Column("active_model_id", String), Column("candidate_model_id", String), Column("traffic_percent", Float), Column("reason", Text), Column("requested_by", String), Column("details", JSON), Column("created_at", DateTime(timezone=True)), Column("completed_at", DateTime(timezone=True)))
ab_experiments = Table("ab_experiments", metadata, Column("id", String, primary_key=True), Column("status", String), Column("baseline_model_id", String), Column("candidate_model_id", String), Column("traffic_split_percent", Float), Column("primary_metric", String), Column("winner_model_id", String), Column("reason", Text), Column("requested_by", String), Column("details", JSON), Column("created_at", DateTime(timezone=True)), Column("completed_at", DateTime(timezone=True)))
prediction_runs = Table("prediction_runs", metadata, Column("id", String, primary_key=True), Column("model_version_id", String), Column("status", String), Column("latency_ms", Float), Column("created_at", DateTime(timezone=True)))
prediction_rows = Table("prediction_rows", metadata, Column("id", String, primary_key=True), Column("run_id", String), Column("model_version_id", String), Column("input_digest", String), Column("input_masked", JSON), Column("output", JSON), Column("latency_ms", Float), Column("created_at", DateTime(timezone=True)))
prediction_feedback = Table("prediction_feedback", metadata, Column("id", String, primary_key=True), Column("run_id", String), Column("row_id", String), Column("model_version_id", String), Column("predicted_value", JSON), Column("actual_label", JSON), Column("correct", Boolean), Column("source", String), Column("reviewer", String), Column("comment", Text), Column("created_at", DateTime(timezone=True)))
retraining_requests = Table("retraining_requests", metadata, Column("id", String, primary_key=True), Column("status", String), Column("trigger", String), Column("reason", Text), Column("requested_by", String), Column("approved_by", String), Column("feedback_count", Integer), Column("feedback_accuracy", Float), Column("active_model_id", String), Column("policy", JSON), Column("details", JSON), Column("created_at", DateTime(timezone=True)), Column("approved_at", DateTime(timezone=True)), Column("completed_at", DateTime(timezone=True)))
evaluation_runs = Table("evaluation_runs", metadata, Column("id", String, primary_key=True), Column("status", String), Column("metrics", JSON), Column("details", JSON), Column("created_at", DateTime(timezone=True)))
metric_snapshots = Table("metric_snapshots", metadata, Column("id", String, primary_key=True), Column("scope", String), Column("metrics", JSON), Column("created_at", DateTime(timezone=True)))
drift_runs = Table("drift_runs", metadata, Column("id", String, primary_key=True), Column("status", String), Column("score", Float), Column("details", JSON), Column("created_at", DateTime(timezone=True)))
app_events = Table("app_events", metadata, Column("id", Integer, primary_key=True, autoincrement=True), Column("event_type", String), Column("message", Text), Column("details", JSON), Column("created_at", DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)))


def init_db() -> None:
    attempts = max(1, settings.database_connect_attempts)
    for attempt in range(1, attempts + 1):
        try:
            metadata.create_all(engine)
            return
        except OperationalError:
            if attempt == attempts:
                raise
            sleep(max(0.0, settings.database_connect_delay_seconds))
`;
}


function renderEnvironmentPy(): string {
  return `import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any
from .settings import settings


def gpu_environment() -> dict[str, Any]:
    nvidia = nvidia_smi_status()
    container = container_gpu_status()
    python = python_torch_cuda_status()
    requested_gpu = settings.execution_profile in {"gpu_cuda", "auto"}
    torch_cuda_available = python.get("cudaAvailable") is True
    gpu_detected = nvidia.get("available") is True or container.get("available") is True or torch_cuda_available
    effective_execution = "gpu_cuda" if requested_gpu and torch_cuda_available else "cpu"
    if not requested_gpu:
        recommendation = "cpu_profile"
    elif torch_cuda_available:
        recommendation = "gpu_cuda_ready"
    elif gpu_detected:
        recommendation = "gpu_driver_ready_python_cpu_fallback"
    else:
        recommendation = "cpu_only"
    return {
        "status": "ok",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "recommendation": recommendation,
        "fallback": effective_execution,
        "nvidiaSmi": nvidia,
        "container": container,
        "python": python,
        "summary": {
            "executionProfile": settings.execution_profile,
            "requestedGpu": requested_gpu,
            "gpuDetected": bool(gpu_detected),
            "containerNvidiaVisible": container.get("available") is True,
            "torchCudaAvailable": bool(torch_cuda_available),
            "canUseGpuProfile": bool(torch_cuda_available),
            "effectiveExecution": effective_execution,
        },
    }


def nvidia_smi_status() -> dict[str, Any]:
    if not shutil.which("nvidia-smi"):
        return {"available": False, "reason": "nvidia-smi não encontrado no PATH"}
    query = run_command([
        "nvidia-smi",
        "--query-gpu=name,driver_version,memory.total,memory.used,memory.free,utilization.gpu",
        "--format=csv,noheader,nounits",
    ])
    if not query["ok"]:
        return {"available": False, "reason": query["reason"], "stderr": query.get("stderr")}
    full = run_command(["nvidia-smi"])
    cuda_version = None
    if full["ok"]:
        match = __import__("re").search(r"CUDA Version:\\s*([0-9.]+)", full.get("stdout", ""))
        cuda_version = match.group(1) if match else None
    gpus = []
    for line in query.get("stdout", "").splitlines():
        if not line.strip():
            continue
        parts = [item.strip() for item in line.split(",", 5)]
        if len(parts) != 6:
            continue
        name, driver_version, total, used, free, utilization = parts
        gpus.append({
            "name": name,
            "driverVersion": driver_version,
            "cudaVersion": cuda_version,
            "memoryTotalMiB": parse_int(total),
            "memoryUsedMiB": parse_int(used),
            "memoryFreeMiB": parse_int(free),
            "utilizationGpuPercent": parse_int(utilization),
        })
    return {"available": bool(gpus), "gpus": gpus}


def container_gpu_status() -> dict[str, Any]:
    visible_devices = os.getenv("NVIDIA_VISIBLE_DEVICES", "")
    capabilities = os.getenv("NVIDIA_DRIVER_CAPABILITIES", "")
    cuda_version = os.getenv("CUDA_VERSION", "")
    available = bool(visible_devices and visible_devices.lower() not in {"none", "void"})
    return {
        "available": available,
        "visibleDevices": visible_devices,
        "driverCapabilities": capabilities,
        "cudaVersionEnv": cuda_version,
    }


def python_torch_cuda_status() -> dict[str, Any]:
    base: dict[str, Any] = {
        "available": True,
        "python": sys.executable,
        "pythonVersion": sys.version.split()[0],
    }
    try:
        import torch  # type: ignore
    except Exception as error:
        return {**base, "torchInstalled": False, "cudaAvailable": False, "deviceCount": 0, "devices": [], "reason": str(error)}
    cuda_available = bool(torch.cuda.is_available())
    devices = []
    if cuda_available:
        for index in range(torch.cuda.device_count()):
            properties = torch.cuda.get_device_properties(index)
            devices.append({
                "index": index,
                "name": torch.cuda.get_device_name(index),
                "memoryTotalMiB": round(properties.total_memory / 1024 / 1024),
            })
    return {
        **base,
        "torchInstalled": True,
        "torchVersion": getattr(torch, "__version__", None),
        "torchCudaVersion": getattr(torch.version, "cuda", None),
        "cudaAvailable": cuda_available,
        "deviceCount": len(devices),
        "devices": devices,
    }


def run_command(args: list[str]) -> dict[str, Any]:
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10, check=False)
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": "timeout"}
    except Exception as error:
        return {"ok": False, "reason": str(error)}
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    return {
        "ok": result.returncode == 0,
        "reason": stderr or stdout or f"exit code {result.returncode}",
        "stdout": stdout,
        "stderr": stderr,
    }


def parse_int(value: str) -> int | None:
    try:
        return round(float(value))
    except ValueError:
        return None
`;
}

function renderMigrationSql(): string {
  return `CREATE TABLE IF NOT EXISTS ingestion_runs (id text PRIMARY KEY, source_id text, status text, started_at timestamptz, finished_at timestamptz, details jsonb);
CREATE TABLE IF NOT EXISTS dataset_versions (id text PRIMARY KEY, layer text, uri text, schema_hash text, lineage jsonb, quality jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS feature_set_versions (id text PRIMARY KEY, features jsonb, transformations jsonb, dependencies jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS legal_categories (code text PRIMARY KEY, name text, target text, critical boolean, requires_human_review boolean, workflow_step_codes jsonb, metadata_json jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS legal_workflow_steps (code text PRIMARY KEY, name text, rite text, order_index integer, step_type text, requires_document boolean, requires_human_review boolean, sla_hours integer, metadata_json jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS legal_workflow_transitions (id text PRIMARY KEY, from_step text, to_step text, rite text, condition text, severity text, active boolean, created_at timestamptz);
CREATE TABLE IF NOT EXISTS legal_processes (id text PRIMARY KEY, process_identifier text, current_workflow_step text, metadata_json jsonb, created_at timestamptz, updated_at timestamptz);
CREATE TABLE IF NOT EXISTS legal_documents (id text PRIMARY KEY, process_id text, prediction_run_id text, prediction_row_id text, category_code text, workflow_step_code text, text_hash text, metadata_json jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS legal_andamentos (id text PRIMARY KEY, process_id text, workflow_step_code text, category_code text, prediction_row_id text, status text, details jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS embedding_profiles (id text PRIMARY KEY, provider text, model_name text, model_version text, model_digest text, dimension integer, similarity_metric text, preprocessing_version text, chunking_version text, status text, vector_collections jsonb, metadata_json jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS vector_collections (id text PRIMARY KEY, profile_id text, logical_name text, collection_name text, backend text, dimension integer, similarity_metric text, status text, metadata_json jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS embedding_records (id text PRIMARY KEY, profile_id text, collection_name text, entity_type text, entity_id text, chunk_id text, vector jsonb, vector_hash text, metadata_json jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS training_runs (id text PRIMARY KEY, status text, algorithm text, params jsonb, metrics jsonb, artifacts jsonb, started_at timestamptz, finished_at timestamptz);
CREATE TABLE IF NOT EXISTS model_versions (id text PRIMARY KEY, status text, algorithm text, metrics jsonb, artifact_uri text, is_active boolean, created_at timestamptz);
CREATE TABLE IF NOT EXISTS promotion_decisions (id text PRIMARY KEY, candidate_model_id text, decision text, evidence jsonb, approved_by text, created_at timestamptz);
CREATE TABLE IF NOT EXISTS deployment_rollouts (id text PRIMARY KEY, kind text, status text, active_model_id text, candidate_model_id text, traffic_percent double precision, reason text, requested_by text, details jsonb, created_at timestamptz, completed_at timestamptz);
CREATE TABLE IF NOT EXISTS ab_experiments (id text PRIMARY KEY, status text, baseline_model_id text, candidate_model_id text, traffic_split_percent double precision, primary_metric text, winner_model_id text, reason text, requested_by text, details jsonb, created_at timestamptz, completed_at timestamptz);
CREATE TABLE IF NOT EXISTS prediction_runs (id text PRIMARY KEY, model_version_id text, status text, latency_ms double precision, created_at timestamptz);
CREATE TABLE IF NOT EXISTS prediction_rows (id text PRIMARY KEY, run_id text, model_version_id text, input_digest text, input_masked jsonb, output jsonb, latency_ms double precision, created_at timestamptz);
CREATE TABLE IF NOT EXISTS prediction_feedback (id text PRIMARY KEY, run_id text, row_id text, model_version_id text, predicted_value jsonb, actual_label jsonb, correct boolean, source text, reviewer text, comment text, created_at timestamptz);
CREATE TABLE IF NOT EXISTS retraining_requests (id text PRIMARY KEY, status text, trigger text, reason text, requested_by text, approved_by text, feedback_count integer, feedback_accuracy double precision, active_model_id text, policy jsonb, details jsonb, created_at timestamptz, approved_at timestamptz, completed_at timestamptz);
CREATE TABLE IF NOT EXISTS evaluation_runs (id text PRIMARY KEY, status text, metrics jsonb, details jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS metric_snapshots (id text PRIMARY KEY, scope text, metrics jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS drift_runs (id text PRIMARY KEY, status text, score double precision, details jsonb, created_at timestamptz);
CREATE TABLE IF NOT EXISTS app_events (id bigserial PRIMARY KEY, event_type text, message text, details jsonb, created_at timestamptz);
`;
}

function pythonDependencies(project: MLOpsProject, pipeline: PipelineFlow, latestTrainingResult: Record<string, unknown> | null): string[] {
  const dependencies = new Set([
    "fastapi==0.132.0",
    "uvicorn[standard]==0.41.0",
    "pydantic==2.12.5",
    "sqlalchemy==2.0.48",
    "psycopg[binary]==3.3.3",
  ]);
  const artifactModelIds = trainingArtifactModelIds(latestTrainingResult);
  const hasTrainingArtifacts = artifactModelIds.size > 0;
  for (const dependency of project.dependencies) {
    if (!hasTrainingArtifacts && isTrainingOnlyDependency(dependency)) {
      continue;
    }
    dependencies.add(dependency);
  }
  for (const node of pipeline.nodes) {
    if (isDisabledNode(node)) {
      continue;
    }
    if (node.type === "model" && !artifactModelIds.has(node.id)) {
      continue;
    }
    for (const dependency of node.dependencies ?? []) {
      dependencies.add(dependency);
    }
    for (const dependency of node.python?.dependencies ?? []) {
      dependencies.add(dependency);
    }
  }
  return [...dependencies].sort((left, right) => left.localeCompare(right));
}

function trainingArtifactModelIds(latestTrainingResult: Record<string, unknown> | null): Set<string> {
  const result = new Set<string>();
  const artifacts = Array.isArray(latestTrainingResult?.artifacts) ? latestTrainingResult.artifacts : [];
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) {
      continue;
    }
    for (const key of ["modelId", "model_id", "id"]) {
      if (typeof artifact[key] === "string" && artifact[key]) {
        result.add(artifact[key]);
      }
    }
  }
  if (typeof latestTrainingResult?.bestModelId === "string" && artifacts.length > 0) {
    result.add(latestTrainingResult.bestModelId);
  }
  return result;
}

function isTrainingOnlyDependency(dependency: string): boolean {
  const packageName = dependency.trim().toLowerCase().split(/[<>=!~\[\s]/, 1)[0];
  return ["catboost", "lightgbm", "scikit-learn", "sentence-transformers", "torch", "xgboost"].includes(packageName);
}

function isDisabledNode(node: PipelineFlow["nodes"][number]): boolean {
  const config = node.config;
  return !!config && typeof config === "object" && "enabled" in config && config.enabled === false;
}

function activeModelId(pipeline: PipelineFlow): string {
  const active = pipeline.nodes.find((node) => node.type === "model" && node.modelRole === "active");
  const candidate = pipeline.nodes.find((node) => node.type === "model");
  return active?.id ?? candidate?.id ?? "deterministic_baseline";
}

function customCodePaths(pipeline: PipelineFlow): string[] {
  return Array.from(
    new Set(
      pipeline.nodes
        .flatMap((node) => (node.python?.codePath ? [normalizeRelativePath(node.python.codePath)] : []))
        .sort((left, right) => left.localeCompare(right)),
    ),
  );
}

async function collectTrainingSnapshot(projectRoot: string, project: MLOpsProject): Promise<{ runsRoot: string | null; datasetVersionsRoot: string | null; latest: Record<string, unknown> | null }> {
  const runsRoot = path.join(projectRoot, "artifacts", "training_runs");
  const datasetVersionsRoot = path.join(projectRoot, "artifacts", "dataset_versions");
  const existingDatasetVersionsRoot = (await pathExists(datasetVersionsRoot)) ? datasetVersionsRoot : null;
  if (!(await pathExists(runsRoot))) {
    return { runsRoot: null, datasetVersionsRoot: existingDatasetVersionsRoot, latest: null };
  }
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const runs: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      runs.push(await readTrainingResult(path.join(runsRoot, entry.name), entry.name, project));
    } catch {
      continue;
    }
  }
  return {
    runsRoot,
    datasetVersionsRoot: existingDatasetVersionsRoot,
    latest: runs.sort((left, right) => trainingRunTimestamp(right) - trainingRunTimestamp(left))[0] ?? null,
  };
}

async function readTrainingResult(runDir: string, fallbackRunId: string, project: MLOpsProject): Promise<Record<string, unknown>> {
  const resultPath = path.join(runDir, "training-result.json");
  const raw = JSON.parse(await readFile(resultPath, "utf-8")) as unknown;
  if (!isRecord(raw)) {
    throw new Error(`training-result.json precisa ser objeto em ${fallbackRunId}.`);
  }
  const item = await stat(resultPath);
  const leaderboard = Array.isArray(raw.leaderboard) ? raw.leaderboard : [];
  const primaryMetric = typeof raw.primaryMetric === "string" ? raw.primaryMetric : project.metrics.primary;
  return {
    ...raw,
    status: typeof raw.status === "string" ? raw.status : "ok",
    kind: typeof raw.kind === "string" ? raw.kind : "training_result",
    runId: typeof raw.runId === "string" ? raw.runId : fallbackRunId,
    projectId: typeof raw.projectId === "string" ? raw.projectId : project.id,
    problemType: typeof raw.problemType === "string" ? raw.problemType : project.problem.type,
    target: typeof raw.target === "string" ? raw.target : project.problem.target,
    primaryMetric,
    bestModelId: typeof raw.bestModelId === "string" ? raw.bestModelId : inferBestModelId(leaderboard, primaryMetric),
    leaderboard,
    promotionEvidence: Array.isArray(raw.promotionEvidence) ? raw.promotionEvidence : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : item.mtime.toISOString(),
    updatedAt: item.mtime.toISOString(),
  };
}

function inferBestModelId(leaderboard: unknown[], primaryMetric: string): string | null {
  if (!leaderboard.length) {
    return null;
  }
  const minimize = ["rmse", "mae", "log_loss", "latency_p95_ms", "error_rate", "drift_score"].includes(primaryMetric);
  const candidates = leaderboard.filter(isRecord);
  const sorted = candidates.sort((left, right) => {
    const leftValue = metricValue(left, primaryMetric, minimize);
    const rightValue = metricValue(right, primaryMetric, minimize);
    return minimize ? leftValue - rightValue : rightValue - leftValue;
  });
  return typeof sorted[0]?.modelId === "string" ? sorted[0].modelId : null;
}

function metricValue(model: Record<string, unknown>, metric: string, minimize: boolean): number {
  const metrics = isRecord(model.metrics) ? model.metrics : {};
  const value = Number(metrics[metric]);
  if (Number.isFinite(value)) {
    return value;
  }
  return minimize ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

function trainingRunTimestamp(run: Record<string, unknown>): number {
  const created = typeof run.createdAt === "string" ? Date.parse(run.createdAt) : NaN;
  if (Number.isFinite(created)) {
    return created;
  }
  const updated = typeof run.updatedAt === "string" ? Date.parse(run.updatedAt) : NaN;
  return Number.isFinite(updated) ? updated : 0;
}

async function fingerprintAssets(projectRoot: string, relativePaths: string[]): Promise<Array<{ path: string; sha256: string }>> {
  const assets: Array<{ path: string; sha256: string }> = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(projectRoot, relativePath);
    if (!(await pathExists(absolutePath))) {
      continue;
    }
    const item = await stat(absolutePath);
    if (item.isDirectory()) {
      for (const child of await listRelativeFiles(absolutePath)) {
        const content = await readFile(path.join(absolutePath, child));
        assets.push({ path: `${relativePath}/${child}`.replaceAll(path.sep, "/"), sha256: createHash("sha256").update(content).digest("hex") });
      }
    } else {
      const content = await readFile(absolutePath);
      assets.push({ path: relativePath.replaceAll(path.sep, "/"), sha256: createHash("sha256").update(content).digest("hex") });
    }
  }
  return assets.sort((left, right) => left.path.localeCompare(right.path));
}

async function listRelativeFiles(root: string, current = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || path.isAbsolute(normalized) || parts.includes("..")) {
    throw new Error(`Caminho relativo inválido: ${value}`);
  }
  return parts.join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function assertSafeOutputDirectory(outDir: string): void {
  const resolved = path.resolve(outDir);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new Error("outDir não pode ser a raiz do disco.");
  }
}
