import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { MLOpsProject, PipelineFlow, RuntimeManifest } from "@mlops-flow-studio/mlops-spec";
import { CONTRACT_VERSION, inferRuntimeInfrastructure, inferRuntimeManifestCapabilities } from "@mlops-flow-studio/mlops-spec";

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

  for (const file of renderRuntimeFiles(project, pipeline, manifest)) {
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
  const dependencies = pythonDependencies(project, pipeline);
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
        ports: { api: "env:API_HOST_PORT", postgres: "env:POSTGRES_HOST_PORT" },
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

function renderRuntimeFiles(project: MLOpsProject, pipeline: PipelineFlow, manifest: RuntimeManifest): RuntimeFile[] {
  const dependencies = pythonDependencies(project, pipeline);
  return [
    { relativePath: "README.md", content: renderReadme(project, manifest) },
    { relativePath: "requirements.txt", content: `${dependencies.join("\n")}\n` },
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
uvicorn app.main:app --reload --port 8080
\`\`\`

## Docker

\`\`\`powershell
docker compose up -d --build
\`\`\`

Para evitar conflito com serviços locais, sobrescreva as portas publicadas:

\`\`\`powershell
$env:API_HOST_PORT="18080"; $env:POSTGRES_HOST_PORT="15433"; docker compose up -d --build
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
Invoke-RestMethod http://127.0.0.1:8080/environment/gpu
\`\`\`

O endpoint \`/environment/gpu\` mostra driver visível no container, disponibilidade de Torch/CUDA e fallback efetivo para CPU.

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
    url = base_url.rstrip("/") + path
    with httpx.Client(timeout=30.0) as client:
        response = client.request(method, url, json=payload)
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
    url = (base_url or RUNTIME_BASE_URL).rstrip("/") + path
    with httpx.Client(timeout=30.0) as client:
        response = client.request(method, url, json=payload)
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
DATABASE_URL=postgresql+psycopg://mlops:mlops@postgres:5432/mlops
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
  return `FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

LABEL \\
${labelLines}

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

EXPOSE 8080

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
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: mlops
      POSTGRES_USER: mlops
      POSTGRES_PASSWORD: mlops
    ports:
      - "\${POSTGRES_HOST_PORT:-5433}:5432"
    volumes:
      - mlops-db-data:/var/lib/postgresql/data

  api:
    build: .
    depends_on:
      - postgres
    environment:
      APP_NAME: ${JSON.stringify(project.runtime.apiName)}
      DATABASE_URL: postgresql+psycopg://mlops:mlops@postgres:5432/mlops
      EXECUTION_PROFILE: ${project.execution.profile}
      STORE_FULL_PAYLOAD: "false"
      NVIDIA_VISIBLE_DEVICES: ${project.execution.profile === "gpu_cuda" ? "all" : "void"}
      NVIDIA_DRIVER_CAPABILITIES: compute,utility
    ports:
      - "\${API_HOST_PORT:-8080}:8080"
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
      - "\${QDRANT_HOST_PORT:-6333}:6333"
      - "\${QDRANT_GRPC_HOST_PORT:-6334}:6334"
    volumes:
      - mlops-qdrant-data:/qdrant/storage`);
    volumes.push("  mlops-qdrant-data:");
  }

  if (hasMlflow) {
    serviceBlocks.push(`  mlflow:
    image: ghcr.io/mlflow/mlflow:v2.17.2
    ports:
      - "\${MLFLOW_HOST_PORT:-5000}:5000"
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
    ports:
      - "\${REDIS_HOST_PORT:-6379}:6379"
    volumes:
      - mlops-runtime-redis:/data

  runtime-worker:
    build: .
    depends_on:
      - api
      - runtime-redis
    environment:
      RUNTIME_BASE_URL: \${RUNTIME_BASE_URL:-http://api:8080}
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
    ports:
      - "\${REDIS_HOST_PORT:-6379}:6379"
    volumes:
      - mlops-orchestration-redis:/data

  celery-worker:
    build: .
    depends_on:
      - orchestration-redis
    environment:
      RUNTIME_BASE_URL: \${RUNTIME_BASE_URL:-http://api:8080}
      CELERY_BROKER_URL: redis://orchestration-redis:6379/0
      CELERY_RESULT_BACKEND: redis://orchestration-redis:6379/0
    command: >
      sh -c "python -m pip install -r requirements-orchestration.txt && celery -A orchestration.celery_app worker --loglevel=\${CELERY_LOG_LEVEL:-INFO}"

  prefect-server:
    profiles: ["prefect"]
    build: .
    ports:
      - "\${PREFECT_HOST_PORT:-4200}:4200"
    volumes:
      - mlops-prefect-data:/root/.prefect
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


settings = Settings()
`;
}

function renderDbPy(): string {
  return `from datetime import datetime, timezone
from sqlalchemy import Boolean, Column, DateTime, Float, Integer, JSON, MetaData, String, Table, Text, create_engine
from sqlalchemy.engine import Engine
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
    metadata.create_all(engine)
`;
}

function renderRepositoryPy(): string {
  return `from datetime import datetime, timezone
from hashlib import sha256
from time import perf_counter
from typing import Any
from uuid import uuid4
from sqlalchemy import func, insert, select, text, update
from .db import ab_experiments, app_events, dataset_versions, deployment_rollouts, drift_runs, embedding_profiles, embedding_records, engine, evaluation_runs, legal_andamentos, legal_categories, legal_documents, legal_processes, legal_workflow_steps, legal_workflow_transitions, metric_snapshots, model_versions, prediction_feedback, prediction_rows, prediction_runs, promotion_decisions, retraining_requests, training_runs, vector_collections
from .settings import settings


def now() -> datetime:
    return datetime.now(timezone.utc)


def check_database() -> dict[str, Any]:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"ok": True, "backend": settings.database_url.split(":", 1)[0]}


def record_event(event_type: str, message: str, details: dict[str, Any] | None = None) -> None:
    with engine.begin() as connection:
        connection.execute(insert(app_events).values(event_type=event_type, message=message, details=details or {}, created_at=now()))


def seed_domain_metadata(project: dict[str, Any]) -> dict[str, Any]:
    legal = legal_domain_config(project)
    if not legal:
        return {"seeded": False, "kind": project.get("domain", {}).get("kind", "generic"), "reason": "dominio sem manifesto juridico"}

    created_at = now()
    inserted = {
        "legal_categories": 0,
        "legal_workflow_steps": 0,
        "legal_workflow_transitions": 0,
        "embedding_profiles": 0,
        "vector_collections": 0,
        "embedding_records": 0,
    }
    with engine.begin() as connection:
        for category in legal.get("categories", []):
            if not isinstance(category, dict) or not category.get("code"):
                continue
            code = str(category["code"])
            if connection.execute(select(legal_categories.c.code).where(legal_categories.c.code == code)).first():
                continue
            connection.execute(
                insert(legal_categories).values(
                    code=code,
                    name=category.get("name"),
                    target=category.get("target"),
                    critical=bool(category.get("critical", False)),
                    requires_human_review=bool(category.get("requiresHumanReview", False)),
                    workflow_step_codes=category.get("workflowStepCodes", []),
                    metadata_json={key: value for key, value in category.items() if key not in {"code", "name", "target", "critical", "requiresHumanReview", "workflowStepCodes"}},
                    created_at=created_at,
                )
            )
            inserted["legal_categories"] += 1

        for step in legal.get("workflowSteps", []):
            if not isinstance(step, dict) or not step.get("code"):
                continue
            code = str(step["code"])
            if connection.execute(select(legal_workflow_steps.c.code).where(legal_workflow_steps.c.code == code)).first():
                continue
            connection.execute(
                insert(legal_workflow_steps).values(
                    code=code,
                    name=step.get("name"),
                    rite=step.get("rite"),
                    order_index=step.get("order"),
                    step_type=step.get("stepType"),
                    requires_document=bool(step.get("requiresDocument", False)),
                    requires_human_review=bool(step.get("requiresHumanReview", False)),
                    sla_hours=step.get("slaHours"),
                    metadata_json={key: value for key, value in step.items() if key not in {"code", "name", "rite", "order", "stepType", "requiresDocument", "requiresHumanReview", "slaHours"}},
                    created_at=created_at,
                )
            )
            inserted["legal_workflow_steps"] += 1

        for transition in legal.get("workflowTransitions", []):
            if not isinstance(transition, dict) or not transition.get("from") or not transition.get("to"):
                continue
            transition_id = f"{transition.get('rite', 'default')}:{transition['from']}->{transition['to']}"
            if row_exists(connection, legal_workflow_transitions, transition_id):
                continue
            connection.execute(
                insert(legal_workflow_transitions).values(
                    id=transition_id,
                    from_step=str(transition["from"]),
                    to_step=str(transition["to"]),
                    rite=str(transition.get("rite") or "default"),
                    condition=transition.get("condition"),
                    severity=str(transition.get("severity") or "block"),
                    active=bool(transition.get("active", True)),
                    created_at=created_at,
                )
            )
            inserted["legal_workflow_transitions"] += 1

        for profile in legal.get("embeddingProfiles", []):
            if not isinstance(profile, dict) or not profile.get("id"):
                continue
            profile_id = str(profile["id"])
            if not row_exists(connection, embedding_profiles, profile_id):
                connection.execute(
                    insert(embedding_profiles).values(
                        id=profile_id,
                        provider=profile.get("provider"),
                        model_name=profile.get("modelName"),
                        model_version=profile.get("modelVersion"),
                        model_digest=profile.get("modelDigest"),
                        dimension=profile.get("dimension"),
                        similarity_metric=profile.get("similarityMetric"),
                        preprocessing_version=profile.get("preprocessingVersion"),
                        chunking_version=profile.get("chunkingVersion"),
                        status=profile.get("status"),
                        vector_collections=profile.get("vectorCollections", {}),
                        metadata_json={
                            "normalization": profile.get("normalization"),
                            "pooling": profile.get("pooling"),
                        },
                        created_at=created_at,
                    )
                )
                inserted["embedding_profiles"] += 1
            collections = profile.get("vectorCollections", {}) if isinstance(profile.get("vectorCollections"), dict) else {}
            for logical_name, collection_name in collections.items():
                collection_id = f"{profile_id}:{collection_name}"
                if not row_exists(connection, vector_collections, collection_id):
                    connection.execute(
                        insert(vector_collections).values(
                            id=collection_id,
                            profile_id=profile_id,
                            logical_name=str(logical_name),
                            collection_name=str(collection_name),
                            backend="external_vector_store_or_pgvector",
                            dimension=profile.get("dimension"),
                            similarity_metric=profile.get("similarityMetric"),
                            status=profile.get("status"),
                            metadata_json={"source": "domain_manifest"},
                            created_at=created_at,
                        )
                    )
                    inserted["vector_collections"] += 1
            inserted["embedding_records"] += seed_embedding_placeholders(connection, profile_id, collections, legal, created_at)

    return {"seeded": True, "kind": "legal_classification", **inserted}


def seed_embedding_placeholders(connection, profile_id: str, collections: dict[str, Any], legal: dict[str, Any], created_at: datetime) -> int:
    inserted = 0
    categories_collection = collections.get("categories")
    if categories_collection:
        for category in legal.get("categories", []):
            if not isinstance(category, dict) or not category.get("code"):
                continue
            record_id = f"{profile_id}:category:{category['code']}"
            if row_exists(connection, embedding_records, record_id):
                continue
            connection.execute(
                insert(embedding_records).values(
                    id=record_id,
                    profile_id=profile_id,
                    collection_name=str(categories_collection),
                    entity_type="legal_category",
                    entity_id=str(category["code"]),
                    chunk_id=None,
                    vector=None,
                    vector_hash=None,
                    metadata_json={"name": category.get("name"), "status": "placeholder_until_embedding_job"},
                    created_at=created_at,
                )
            )
            inserted += 1
    workflow_collection = collections.get("workflowSteps")
    if workflow_collection:
        for step in legal.get("workflowSteps", []):
            if not isinstance(step, dict) or not step.get("code"):
                continue
            record_id = f"{profile_id}:workflow_step:{step['code']}"
            if row_exists(connection, embedding_records, record_id):
                continue
            connection.execute(
                insert(embedding_records).values(
                    id=record_id,
                    profile_id=profile_id,
                    collection_name=str(workflow_collection),
                    entity_type="legal_workflow_step",
                    entity_id=str(step["code"]),
                    chunk_id=None,
                    vector=None,
                    vector_hash=None,
                    metadata_json={"name": step.get("name"), "status": "placeholder_until_embedding_job"},
                    created_at=created_at,
                )
            )
            inserted += 1
    return inserted


def legal_domain_config(project: dict[str, Any]) -> dict[str, Any] | None:
    domain = project.get("domain", {})
    if not isinstance(domain, dict) or domain.get("kind") != "legal_classification":
        return None
    legal = domain.get("legal")
    return legal if isinstance(legal, dict) else None


def domain_metadata_summary(project: dict[str, Any]) -> dict[str, Any]:
    legal = legal_domain_config(project)
    if not legal:
        return {"kind": project.get("domain", {}).get("kind", "generic"), "legal": None}
    with engine.connect() as connection:
        counts = {
            "categories": connection.execute(select(func.count()).select_from(legal_categories)).scalar_one(),
            "workflow_steps": connection.execute(select(func.count()).select_from(legal_workflow_steps)).scalar_one(),
            "workflow_transitions": connection.execute(select(func.count()).select_from(legal_workflow_transitions)).scalar_one(),
            "processes": connection.execute(select(func.count()).select_from(legal_processes)).scalar_one(),
            "documents": connection.execute(select(func.count()).select_from(legal_documents)).scalar_one(),
            "andamentos": connection.execute(select(func.count()).select_from(legal_andamentos)).scalar_one(),
            "embedding_profiles": connection.execute(select(func.count()).select_from(embedding_profiles)).scalar_one(),
            "vector_collections": connection.execute(select(func.count()).select_from(vector_collections)).scalar_one(),
            "embedding_records": connection.execute(select(func.count()).select_from(embedding_records)).scalar_one(),
        }
    return {
        "kind": "legal_classification",
        "processIdentifierField": legal.get("processIdentifierField"),
        "documentTextField": legal.get("documentTextField"),
        "categoryTargetField": legal.get("categoryTargetField"),
        "workflowContextField": legal.get("workflowContextField"),
        "decisionPolicy": legal.get("decisionPolicy", {}),
        "llm": legal.get("llm", {}),
        "counts": {key: int(value or 0) for key, value in counts.items()},
    }


def seed_training_metadata(training_result: dict[str, Any] | None, project: dict[str, Any], runtime_manifest: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(training_result, dict) or not training_result.get("runId"):
        return {"seeded": False, "reason": "latest_training_result ausente"}

    run_id = str(training_result["runId"])
    created_at = parse_timestamp(training_result.get("createdAt") or training_result.get("updatedAt"))
    leaderboard = [item for item in training_result.get("leaderboard", []) if isinstance(item, dict)]
    best = next((item for item in leaderboard if item.get("modelId") == training_result.get("bestModelId")), leaderboard[0] if leaderboard else {})
    active_model_id = str(runtime_manifest.get("activeModelId") or "")
    evidence = [item for item in training_result.get("promotionEvidence", []) if isinstance(item, dict)]
    decision = promotion_recommendation(evidence)
    inserted = {"dataset_versions": 0, "training_runs": 0, "model_versions": 0, "promotion_decisions": 0, "metric_snapshots": 0}

    with engine.begin() as connection:
        dataset_version = training_result.get("datasetVersion") if isinstance(training_result.get("datasetVersion"), dict) else {}
        dataset_version_id = str(dataset_version.get("datasetVersionId") or "")
        if dataset_version_id and not row_exists(connection, dataset_versions, dataset_version_id):
            connection.execute(
                insert(dataset_versions).values(
                    id=dataset_version_id,
                    layer="training",
                    uri=dataset_version.get("path") if isinstance(dataset_version.get("path"), str) else None,
                    schema_hash=dataset_version.get("schemaHash") if isinstance(dataset_version.get("schemaHash"), str) else None,
                    lineage={
                        "training_run_id": run_id,
                        "source_id": training_result.get("sourceId"),
                        "source_type": training_result.get("sourceType"),
                        "source_mode": training_result.get("sourceMode"),
                    },
                    quality={
                        "row_count": dataset_version.get("rowCount"),
                        "row_digest": dataset_version.get("rowDigest"),
                        "source_mode": dataset_version.get("sourceMode"),
                    },
                    created_at=created_at,
                )
            )
            inserted["dataset_versions"] += 1

        if not row_exists(connection, training_runs, run_id):
            connection.execute(
                insert(training_runs).values(
                    id=run_id,
                    status=str(training_result.get("status") or "ok"),
                    algorithm=str(best.get("trainedAlgorithm") or best.get("algorithm") or ""),
                    params={
                        "project_id": project.get("id"),
                        "source_id": training_result.get("sourceId"),
                        "source_type": training_result.get("sourceType"),
                        "source_mode": training_result.get("sourceMode"),
                        "problem_type": training_result.get("problemType") or project.get("problem", {}).get("type"),
                        "target": training_result.get("target") or project.get("problem", {}).get("target"),
                        "primary_metric": training_result.get("primaryMetric") or project.get("metrics", {}).get("primary"),
                        "best_model_id": training_result.get("bestModelId"),
                        "row_count": training_result.get("rowCount"),
                    },
                    metrics=best.get("metrics") if isinstance(best.get("metrics"), dict) else {},
                    artifacts=training_result.get("artifacts") if isinstance(training_result.get("artifacts"), list) else [],
                    started_at=created_at,
                    finished_at=created_at,
                )
            )
            inserted["training_runs"] += 1

        for model in leaderboard:
            model_id = str(model.get("modelId") or "")
            if not model_id or row_exists(connection, model_versions, model_id):
                continue
            is_active = model_id == active_model_id
            connection.execute(
                insert(model_versions).values(
                    id=model_id,
                    status="active" if is_active else str(model.get("role") or "candidate"),
                    algorithm=str(model.get("trainedAlgorithm") or model.get("algorithm") or ""),
                    metrics=model.get("metrics") if isinstance(model.get("metrics"), dict) else {},
                    artifact_uri=model.get("artifactUri") if isinstance(model.get("artifactUri"), str) else None,
                    is_active=is_active,
                    created_at=created_at,
                )
            )
            inserted["model_versions"] += 1

        promotion_id = f"{run_id}-promotion"
        if not row_exists(connection, promotion_decisions, promotion_id):
            connection.execute(
                insert(promotion_decisions).values(
                    id=promotion_id,
                    candidate_model_id=str(training_result.get("bestModelId") or ""),
                    decision=decision,
                    evidence=evidence,
                    approved_by=None,
                    created_at=created_at,
                )
            )
            inserted["promotion_decisions"] += 1

        snapshot_id = f"{run_id}-model-metrics"
        if not row_exists(connection, metric_snapshots, snapshot_id):
            connection.execute(
                insert(metric_snapshots).values(
                    id=snapshot_id,
                    scope="model_validation",
                    metrics={
                        "primary_metric": training_result.get("primaryMetric") or project.get("metrics", {}).get("primary"),
                        "best_model_id": training_result.get("bestModelId"),
                        "leaderboard": leaderboard,
                    },
                    created_at=created_at,
                )
            )
            inserted["metric_snapshots"] += 1

    return {"seeded": True, "run_id": run_id, **inserted}


def row_exists(connection, table, row_id: str) -> bool:
    return connection.execute(select(table.c.id).where(table.c.id == row_id)).first() is not None


def parse_timestamp(value: Any) -> datetime:
    if isinstance(value, str) and value:
        normalized = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return now()


def promotion_recommendation(evidence: list[dict[str, Any]]) -> str:
    failed_blockers = [item for item in evidence if item.get("status") == "fail" and item.get("severity", "block") == "block"]
    failed_reviews = [item for item in evidence if item.get("status") == "fail" and item.get("severity", "block") != "block"]
    if failed_blockers:
        return "reject"
    if failed_reviews:
        return "review"
    return "approve"


def registered_model_version(model_id: str) -> dict[str, Any] | None:
    with engine.connect() as connection:
        row = connection.execute(select(model_versions).where(model_versions.c.id == model_id)).mappings().first()
    return serialize_model_version(row)


def register_model_version(
    model_id: str,
    algorithm: str | None,
    artifact_uri: str | None,
    metrics: dict[str, Any] | None,
    status: str | None,
    activate: bool,
    requested_by: str | None,
    confirm: bool,
) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Registro de modelo exige confirm=true.")
    if not model_id or not model_id.strip():
        raise ValueError("model_id é obrigatório.")
    created_at = now()
    with engine.begin() as connection:
        if model_exists(connection, model_id):
            raise ValueError(f"Modelo {model_id} já existe no registry.")
        if activate:
            connection.execute(update(model_versions).values(is_active=False))
        connection.execute(
            insert(model_versions).values(
                id=model_id,
                status=status or ("active" if activate else "registered"),
                algorithm=algorithm or "external",
                metrics=metrics or {},
                artifact_uri=artifact_uri,
                is_active=activate,
                created_at=created_at,
            )
        )
        if activate:
            connection.execute(
                insert(promotion_decisions).values(
                    id=str(uuid4()),
                    candidate_model_id=model_id,
                    decision="approve",
                    evidence={"source": "model_registry_registration", "requested_by": requested_by, "activate": True},
                    approved_by=requested_by,
                    created_at=created_at,
                )
            )
        row = connection.execute(select(model_versions).where(model_versions.c.id == model_id)).mappings().first()
    record_event("model_registered", "Versão de modelo registrada", {"model_id": model_id, "activate": activate, "requested_by": requested_by})
    return {"status": "ok", "model": serialize_model_version(row)}


def promote_model_version(model_id: str, approved_by: str | None, evidence: dict[str, Any] | None, confirm: bool) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Promoção de modelo exige confirm=true.")
    promoted_at = now()
    with engine.begin() as connection:
        row = connection.execute(select(model_versions).where(model_versions.c.id == model_id)).mappings().first()
        if row is None:
            return None
        connection.execute(update(model_versions).values(is_active=False))
        connection.execute(
            update(model_versions)
            .where(model_versions.c.id == model_id)
            .values(status="active", is_active=True)
        )
        decision_id = str(uuid4())
        connection.execute(
            insert(promotion_decisions).values(
                id=decision_id,
                candidate_model_id=model_id,
                decision="approve",
                evidence=evidence or {"source": "manual_registry_promotion"},
                approved_by=approved_by,
                created_at=promoted_at,
            )
        )
        updated = connection.execute(select(model_versions).where(model_versions.c.id == model_id)).mappings().first()
    record_event("model_promoted", "Versão de modelo promovida", {"model_id": model_id, "approved_by": approved_by})
    return {"status": "ok", "model": serialize_model_version(updated), "promotion_decision_id": decision_id}


def serialize_model_version(row: Any) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "status": row["status"],
        "algorithm": row["algorithm"],
        "metrics": row["metrics"] or {},
        "artifact_uri": row["artifact_uri"],
        "is_active": bool(row["is_active"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


def register_embedding_profile(
    profile_id: str,
    provider: str | None,
    model_name: str | None,
    model_version: str | None,
    model_digest: str | None,
    dimension: int | None,
    similarity_metric: str | None,
    preprocessing_version: str | None,
    chunking_version: str | None,
    vector_collection_map: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    requested_by: str | None,
    confirm: bool,
) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Registro de perfil de embedding exige confirm=true.")
    if not profile_id or not profile_id.strip():
        raise ValueError("profile_id é obrigatório.")
    created_at = now()
    collections = vector_collection_map or {}
    with engine.begin() as connection:
        if row_exists(connection, embedding_profiles, profile_id):
            raise ValueError(f"Perfil de embedding {profile_id} já existe.")
        connection.execute(
            insert(embedding_profiles).values(
                id=profile_id,
                provider=provider,
                model_name=model_name,
                model_version=model_version,
                model_digest=model_digest,
                dimension=dimension,
                similarity_metric=similarity_metric or "cosine",
                preprocessing_version=preprocessing_version,
                chunking_version=chunking_version,
                status="registered",
                vector_collections=collections,
                metadata_json=metadata or {},
                created_at=created_at,
            )
        )
        for logical_name, collection_name in collections.items():
            collection_id = f"{profile_id}:{collection_name}"
            if row_exists(connection, vector_collections, collection_id):
                continue
            connection.execute(
                insert(vector_collections).values(
                    id=collection_id,
                    profile_id=profile_id,
                    logical_name=str(logical_name),
                    collection_name=str(collection_name),
                    backend="external_vector_store_or_pgvector",
                    dimension=dimension,
                    similarity_metric=similarity_metric or "cosine",
                    status="registered",
                    metadata_json={"source": "embedding_profile_registry"},
                    created_at=created_at,
                )
            )
        row = connection.execute(select(embedding_profiles).where(embedding_profiles.c.id == profile_id)).mappings().first()
    record_event("embedding_profile_registered", "Perfil de embedding registrado", {"profile_id": profile_id, "requested_by": requested_by})
    return {"status": "ok", "profile": serialize_embedding_profile(row)}


def activate_embedding_profile(profile_id: str, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Ativação de perfil de embedding exige confirm=true.")
    activated_at = now()
    with engine.begin() as connection:
        row = connection.execute(select(embedding_profiles).where(embedding_profiles.c.id == profile_id)).mappings().first()
        if row is None:
            return None
        connection.execute(update(embedding_profiles).values(status="inactive"))
        connection.execute(update(vector_collections).values(status="inactive"))
        connection.execute(update(embedding_profiles).where(embedding_profiles.c.id == profile_id).values(status="active"))
        connection.execute(update(vector_collections).where(vector_collections.c.profile_id == profile_id).values(status="active"))
        updated = connection.execute(select(embedding_profiles).where(embedding_profiles.c.id == profile_id)).mappings().first()
    record_event("embedding_profile_activated", "Perfil de embedding ativado", {"profile_id": profile_id, "requested_by": requested_by, "reason": reason, "activated_at": activated_at.isoformat()})
    return {"status": "ok", "profile": serialize_embedding_profile(updated), "next_step": "reindex_embeddings_for_active_profile"}


def serialize_embedding_profile(row: Any) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "provider": row["provider"],
        "modelName": row["model_name"],
        "modelVersion": row["model_version"],
        "modelDigest": row["model_digest"],
        "dimension": row["dimension"],
        "similarityMetric": row["similarity_metric"],
        "preprocessingVersion": row["preprocessing_version"],
        "chunkingVersion": row["chunking_version"],
        "status": row["status"],
        "vectorCollections": row["vector_collections"] or {},
        "metadata": row["metadata_json"] or {},
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


def deployment_status(default_active_model_id: str) -> dict[str, Any]:
    with engine.connect() as connection:
        active_id = active_model_id_from_store(connection, default_active_model_id)
        latest = latest_deployment_rollout(connection)
        model_rows = connection.execute(select(model_versions)).mappings().fetchall()
    return {
        "status": "ok",
        "active_model_id": active_id,
        "mode": latest["kind"] if latest and latest["status"] == "active" else "active",
        "latest_rollout": serialize_deployment_rollout(latest) if latest else None,
        "models": [
            {
                "id": row["id"],
                "status": row["status"],
                "is_active": bool(row["is_active"]),
                "algorithm": row["algorithm"],
                "metrics": row["metrics"] or {},
            }
            for row in model_rows
        ],
    }


def start_shadow_deployment(default_active_model_id: str, model_id: str, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any]:
    return start_deployment_rollout("shadow", default_active_model_id, model_id, 0.0, requested_by, reason, confirm)


def start_canary_deployment(default_active_model_id: str, model_id: str, traffic_percent: float, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any]:
    if traffic_percent <= 0 or traffic_percent >= 100:
        raise ValueError("Canary exige traffic_percent maior que 0 e menor que 100.")
    return start_deployment_rollout("canary", default_active_model_id, model_id, traffic_percent, requested_by, reason, confirm)


def rollback_deployment(default_active_model_id: str, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Rollback exige confirm=true.")
    completed_at = now()
    with engine.begin() as connection:
        active_id = active_model_id_from_store(connection, default_active_model_id)
        latest = latest_deployment_rollout(connection)
        if latest and latest["status"] == "active":
            connection.execute(
                update(deployment_rollouts)
                .where(deployment_rollouts.c.id == latest["id"])
                .values(
                    status="rolled_back",
                    completed_at=completed_at,
                    details={**dict(latest["details"] or {}), "rollback": {"requested_by": requested_by, "reason": reason, "rolled_back_at": completed_at.isoformat()}},
                )
            )
        rollback_id = str(uuid4())
        connection.execute(
            insert(deployment_rollouts).values(
                id=rollback_id,
                kind="rollback",
                status="completed",
                active_model_id=active_id,
                candidate_model_id=latest["candidate_model_id"] if latest else None,
                traffic_percent=0.0,
                reason=reason,
                requested_by=requested_by,
                details={"rolled_back_rollout_id": latest["id"] if latest else None, "previous_mode": latest["kind"] if latest else "active"},
                created_at=completed_at,
                completed_at=completed_at,
            )
        )
        row = connection.execute(select(deployment_rollouts).where(deployment_rollouts.c.id == rollback_id)).mappings().first()
    record_event("deployment_rollback", "Rollback de deployment registrado", {"rollout_id": rollback_id, "rolled_back_rollout_id": latest["id"] if latest else None})
    return {"status": "ok", "rollout": serialize_deployment_rollout(row), "deployment": deployment_status(default_active_model_id)}


def start_deployment_rollout(kind: str, default_active_model_id: str, model_id: str, traffic_percent: float, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Rollout exige confirm=true.")
    created_at = now()
    with engine.begin() as connection:
        if not model_exists(connection, model_id):
            raise ValueError(f"Modelo {model_id} não existe no runtime.")
        active_id = active_model_id_from_store(connection, default_active_model_id)
        previous = latest_deployment_rollout(connection)
        if previous and previous["status"] == "active":
            connection.execute(
                update(deployment_rollouts)
                .where(deployment_rollouts.c.id == previous["id"])
                .values(status="superseded", completed_at=created_at)
            )
        rollout_id = str(uuid4())
        connection.execute(
            insert(deployment_rollouts).values(
                id=rollout_id,
                kind=kind,
                status="active",
                active_model_id=active_id,
                candidate_model_id=model_id,
                traffic_percent=traffic_percent,
                reason=reason,
                requested_by=requested_by,
                details={"previous_rollout_id": previous["id"] if previous else None},
                created_at=created_at,
                completed_at=None,
            )
        )
        row = connection.execute(select(deployment_rollouts).where(deployment_rollouts.c.id == rollout_id)).mappings().first()
    record_event(f"deployment_{kind}_started", f"Deployment {kind} iniciado", {"rollout_id": row["id"], "candidate_model_id": model_id, "traffic_percent": traffic_percent})
    return {"status": "ok", "rollout": serialize_deployment_rollout(row)}


def model_exists(connection, model_id: str) -> bool:
    return connection.execute(select(model_versions.c.id).where(model_versions.c.id == model_id)).first() is not None


def active_model_id_from_store(connection, default_active_model_id: str) -> str:
    row = connection.execute(select(model_versions.c.id).where(model_versions.c.is_active == True).limit(1)).scalar_one_or_none()
    return str(row or default_active_model_id or "")


def latest_deployment_rollout(connection):
    return connection.execute(select(deployment_rollouts).order_by(deployment_rollouts.c.created_at.desc()).limit(1)).mappings().first()


def serialize_deployment_rollout(row: Any) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "active_model_id": row["active_model_id"],
        "candidate_model_id": row["candidate_model_id"],
        "traffic_percent": row["traffic_percent"],
        "reason": row["reason"],
        "requested_by": row["requested_by"],
        "details": row["details"] or {},
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
    }


def ab_testing_status(default_active_model_id: str) -> dict[str, Any]:
    with engine.connect() as connection:
        active_id = active_model_id_from_store(connection, default_active_model_id)
        latest = latest_ab_experiment(connection)
        active_count = connection.execute(select(func.count()).select_from(ab_experiments).where(ab_experiments.c.status == "active")).scalar_one()
        rows = connection.execute(select(ab_experiments).order_by(ab_experiments.c.created_at.desc()).limit(10)).mappings().fetchall()
    return {
        "status": "ok",
        "active_model_id": active_id,
        "active_count": int(active_count or 0),
        "latest_experiment": serialize_ab_experiment(latest),
        "experiments": [serialize_ab_experiment(row) for row in rows],
    }


def start_ab_test(
    default_active_model_id: str,
    candidate_model_id: str,
    baseline_model_id: str | None,
    traffic_split_percent: float,
    primary_metric: str | None,
    requested_by: str | None,
    reason: str | None,
    guardrails: dict[str, Any] | None,
    confirm: bool,
) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Experimento A/B exige confirm=true.")
    if traffic_split_percent <= 0 or traffic_split_percent >= 100:
        raise ValueError("A/B exige traffic_split_percent maior que 0 e menor que 100.")
    created_at = now()
    with engine.begin() as connection:
        active_id = active_model_id_from_store(connection, default_active_model_id)
        baseline_id = baseline_model_id or active_id
        if not model_exists(connection, baseline_id):
            raise ValueError(f"Modelo baseline {baseline_id} não existe no runtime.")
        if not model_exists(connection, candidate_model_id):
            raise ValueError(f"Modelo candidato {candidate_model_id} não existe no runtime.")
        if baseline_id == candidate_model_id:
            raise ValueError("A/B exige modelos baseline e candidato diferentes.")
        previous = connection.execute(select(ab_experiments).where(ab_experiments.c.status == "active").order_by(ab_experiments.c.created_at.desc()).limit(1)).mappings().first()
        if previous:
            connection.execute(
                update(ab_experiments)
                .where(ab_experiments.c.id == previous["id"])
                .values(status="superseded", completed_at=created_at)
            )
        experiment_id = str(uuid4())
        details = {
            "traffic": {"baseline_percent": 100 - traffic_split_percent, "candidate_percent": traffic_split_percent},
            "guardrails": guardrails or {},
            "previous_experiment_id": previous["id"] if previous else None,
            "routing": "deterministic_hash_assignment_expected_at_gateway_or_runtime_adapter",
        }
        connection.execute(
            insert(ab_experiments).values(
                id=experiment_id,
                status="active",
                baseline_model_id=baseline_id,
                candidate_model_id=candidate_model_id,
                traffic_split_percent=traffic_split_percent,
                primary_metric=primary_metric or "primary",
                winner_model_id=None,
                reason=reason,
                requested_by=requested_by,
                details=details,
                created_at=created_at,
                completed_at=None,
            )
        )
        row = connection.execute(select(ab_experiments).where(ab_experiments.c.id == experiment_id)).mappings().first()
    record_event("ab_test_started", "Experimento A/B iniciado", {"experiment_id": experiment_id, "baseline_model_id": baseline_id, "candidate_model_id": candidate_model_id, "traffic_split_percent": traffic_split_percent})
    return {"status": "ok", "experiment": serialize_ab_experiment(row), "ab_testing": ab_testing_status(default_active_model_id)}


def complete_ab_test(
    experiment_id: str,
    winner_model_id: str | None,
    metrics: dict[str, Any] | None,
    completed_by: str | None,
    confirm: bool,
) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Conclusão de A/B exige confirm=true.")
    completed_at = now()
    with engine.begin() as connection:
        row = connection.execute(select(ab_experiments).where(ab_experiments.c.id == experiment_id)).mappings().first()
        if row is None:
            return None
        if row["status"] == "completed":
            return {"status": "ok", "experiment": serialize_ab_experiment(row)}
        if row["status"] != "active":
            raise ValueError(f"Experimento em status {row['status']} não pode ser concluído.")
        allowed_winners = {row["baseline_model_id"], row["candidate_model_id"], "no_winner"}
        effective_winner = winner_model_id or "no_winner"
        if effective_winner not in allowed_winners:
            raise ValueError("winner_model_id precisa ser baseline, candidato ou no_winner.")
        details = dict(row["details"] or {})
        details["result"] = {
            "winner_model_id": effective_winner,
            "metrics": metrics or {},
            "completed_by": completed_by,
            "completed_at": completed_at.isoformat(),
        }
        connection.execute(
            update(ab_experiments)
            .where(ab_experiments.c.id == experiment_id)
            .values(status="completed", winner_model_id=effective_winner, details=details, completed_at=completed_at)
        )
        connection.execute(
            insert(metric_snapshots).values(
                id=f"{experiment_id}-metrics",
                scope="ab_test",
                metrics={"winner_model_id": effective_winner, "primary_metric": row["primary_metric"], "metrics": metrics or {}},
                created_at=completed_at,
            )
        )
        updated = connection.execute(select(ab_experiments).where(ab_experiments.c.id == experiment_id)).mappings().first()
    record_event("ab_test_completed", "Experimento A/B concluído", {"experiment_id": experiment_id, "winner_model_id": effective_winner})
    return {"status": "ok", "experiment": serialize_ab_experiment(updated)}


def latest_ab_experiment(connection):
    return connection.execute(select(ab_experiments).order_by(ab_experiments.c.created_at.desc()).limit(1)).mappings().first()


def serialize_ab_experiment(row: Any) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "status": row["status"],
        "baseline_model_id": row["baseline_model_id"],
        "candidate_model_id": row["candidate_model_id"],
        "traffic_split_percent": row["traffic_split_percent"],
        "primary_metric": row["primary_metric"],
        "winner_model_id": row["winner_model_id"],
        "reason": row["reason"],
        "requested_by": row["requested_by"],
        "details": row["details"] or {},
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
    }


def mask_payload(payload: dict[str, Any], sensitive_fields: list[str]) -> dict[str, Any]:
    masked: dict[str, Any] = {}
    for key, value in payload.items():
        if key in sensitive_fields:
            masked[key] = "***"
        else:
            masked[key] = value
    return masked


def digest_payload(payload: dict[str, Any]) -> str:
    import json

    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return sha256(raw.encode("utf-8")).hexdigest()


def record_prediction(payload: dict[str, Any], output: dict[str, Any], model_version_id: str, latency_ms: float, sensitive_fields: list[str], project: dict[str, Any] | None = None) -> str:
    run_id = str(uuid4())
    row_id = str(uuid4())
    created_at = now()
    input_masked = payload if settings.store_full_payload else mask_payload(payload, sensitive_fields)
    with engine.begin() as connection:
        connection.execute(insert(prediction_runs).values(id=run_id, model_version_id=model_version_id, status="success", latency_ms=latency_ms, created_at=created_at))
        connection.execute(insert(prediction_rows).values(id=row_id, run_id=run_id, model_version_id=model_version_id, input_digest=digest_payload(payload), input_masked=input_masked, output=output, latency_ms=latency_ms, created_at=created_at))
        if project:
            record_legal_prediction_context(connection, run_id, row_id, payload, output, project, created_at)
    return run_id


def record_legal_prediction_context(connection, run_id: str, row_id: str, payload: dict[str, Any], output: dict[str, Any], project: dict[str, Any], created_at: datetime) -> None:
    legal = legal_domain_config(project)
    if not legal:
        return
    process_field = str(legal.get("processIdentifierField") or "numero_unico")
    text_field = str(legal.get("documentTextField") or "texto")
    workflow_field = str(legal.get("workflowContextField") or "workflow_step_atual")
    process_identifier = payload.get(process_field) or f"prediction:{run_id}"
    process_id = sha256(str(process_identifier).encode("utf-8")).hexdigest()
    workflow_step = payload.get(workflow_field)
    workflow_step_code = str(workflow_step) if workflow_step is not None and str(workflow_step).strip() else None
    category_code = str(output.get("prediction")) if output.get("prediction") is not None else None
    if row_exists(connection, legal_processes, process_id):
        connection.execute(
            update(legal_processes)
            .where(legal_processes.c.id == process_id)
            .values(current_workflow_step=workflow_step_code, updated_at=created_at)
        )
    else:
        connection.execute(
            insert(legal_processes).values(
                id=process_id,
                process_identifier=str(process_identifier),
                current_workflow_step=workflow_step_code,
                metadata_json={"source": "prediction_runtime", "processIdentifierField": process_field},
                created_at=created_at,
                updated_at=created_at,
            )
        )
    document_text = payload.get(text_field)
    text_hash = sha256(str(document_text or "").encode("utf-8")).hexdigest() if document_text is not None else None
    connection.execute(
        insert(legal_documents).values(
            id=row_id,
            process_id=process_id,
            prediction_run_id=run_id,
            prediction_row_id=row_id,
            category_code=category_code,
            workflow_step_code=workflow_step_code,
            text_hash=text_hash,
            metadata_json={
                "documentTextField": text_field,
                "review": output.get("review", {}),
                "decision": output.get("decision", {}),
                "scores": output.get("explanation", {}).get("scores", {}),
            },
            created_at=created_at,
        )
    )
    andamento_id = f"{row_id}-andamento"
    connection.execute(
        insert(legal_andamentos).values(
            id=andamento_id,
            process_id=process_id,
            workflow_step_code=workflow_step_code,
            category_code=category_code,
            prediction_row_id=row_id,
            status=output.get("review", {}).get("status", "recorded"),
            details={
                "blockedRules": output.get("explanation", {}).get("workflow", {}).get("blockedRules", []),
                "humanReviewRequired": output.get("review", {}).get("humanReviewRequired", False),
                "llmReviewRecommended": output.get("decision", {}).get("llmReviewRecommended", False),
            },
            created_at=created_at,
        )
    )


def record_prediction_feedback(
    run_id: str,
    row_id: str | None,
    actual_label: Any,
    correct: bool | None,
    source: str,
    reviewer: str | None,
    comment: str | None,
) -> dict[str, Any] | None:
    with engine.begin() as connection:
        query = select(prediction_rows).where(prediction_rows.c.run_id == run_id)
        if row_id:
            query = query.where(prediction_rows.c.id == row_id)
        row = connection.execute(query.order_by(prediction_rows.c.created_at.desc()).limit(1)).mappings().first()
        if row is None:
            return None
        output = dict(row["output"] or {})
        predicted_value = output.get("prediction")
        effective_correct = bool(correct) if correct is not None else labels_match(actual_label, predicted_value)
        feedback_id = str(uuid4())
        created_at = now()
        connection.execute(
            insert(prediction_feedback).values(
                id=feedback_id,
                run_id=run_id,
                row_id=row["id"],
                model_version_id=row["model_version_id"],
                predicted_value=predicted_value,
                actual_label=actual_label,
                correct=effective_correct,
                source=source,
                reviewer=reviewer,
                comment=comment,
                created_at=created_at,
            )
        )
        connection.execute(
            insert(metric_snapshots).values(
                id=f"{feedback_id}-metrics",
                scope="feedback",
                metrics={
                    "run_id": run_id,
                    "row_id": row["id"],
                    "model_version_id": row["model_version_id"],
                    "predicted_value": predicted_value,
                    "actual_label": actual_label,
                    "correct": effective_correct,
                    "source": source,
                },
                created_at=created_at,
            )
        )
    return {
        "feedback_id": feedback_id,
        "run_id": run_id,
        "row_id": row["id"],
        "model_version_id": row["model_version_id"],
        "predicted_value": predicted_value,
        "actual_label": actual_label,
        "correct": effective_correct,
        "source": source,
        "created_at": created_at.isoformat(),
    }


def labels_match(actual_label: Any, predicted_value: Any) -> bool:
    if actual_label is None or predicted_value is None:
        return False
    try:
        return abs(float(actual_label) - float(predicted_value)) <= 1e-9
    except (TypeError, ValueError):
        pass
    return str(actual_label) == str(predicted_value)


def record_evaluation(result: dict[str, Any]) -> str:
    evaluation_id = str(uuid4())
    snapshot_id = f"{evaluation_id}-metrics"
    created_at = now()
    details = {
        "model_version_id": result.get("model_version_id"),
        "baseline_model_id": result.get("baseline_model_id"),
        "candidate_model_ids": result.get("candidate_model_ids", []),
        "record_count": result.get("record_count"),
        "label_count": result.get("label_count"),
        "primary_metric": result.get("primary_metric"),
        "sample": result.get("sample", []),
        "models": result.get("models", []),
        "evidence": result.get("evidence", []),
    }
    with engine.begin() as connection:
        connection.execute(
            insert(evaluation_runs).values(
                id=evaluation_id,
                status=str(result.get("status") or "ok"),
                metrics=result.get("metrics") if isinstance(result.get("metrics"), dict) else {},
                details=details,
                created_at=created_at,
            )
        )
        connection.execute(
            insert(metric_snapshots).values(
                id=snapshot_id,
                scope="evaluation",
                metrics={
                    "model_version_id": result.get("model_version_id"),
                    "primary_metric": result.get("primary_metric"),
                    "metrics": result.get("metrics") if isinstance(result.get("metrics"), dict) else {},
                },
                created_at=created_at,
            )
        )
    return evaluation_id


def record_drift(result: dict[str, Any]) -> str:
    drift_id = str(uuid4())
    snapshot_id = f"{drift_id}-metrics"
    created_at = now()
    details = {
        "reference_count": result.get("reference_count"),
        "current_count": result.get("current_count"),
        "feature_count": result.get("feature_count"),
        "features": result.get("features", []),
        "thresholds": result.get("thresholds", {}),
    }
    with engine.begin() as connection:
        connection.execute(
            insert(drift_runs).values(
                id=drift_id,
                status=str(result.get("status") or "ok"),
                score=float(result.get("drift_score") or 0.0),
                details=details,
                created_at=created_at,
            )
        )
        connection.execute(
            insert(metric_snapshots).values(
                id=snapshot_id,
                scope="drift",
                metrics={
                    "drift_score": float(result.get("drift_score") or 0.0),
                    "status": result.get("status"),
                    "features": result.get("features", []),
                },
                created_at=created_at,
            )
        )
    return drift_id


def latest_drift() -> dict[str, Any] | None:
    with engine.connect() as connection:
        row = connection.execute(select(drift_runs).order_by(drift_runs.c.created_at.desc()).limit(1)).mappings().first()
    return dict(row) if row else None


def feedback_summary(active_model_id: str | None = None) -> dict[str, Any]:
    with engine.connect() as connection:
        feedback_count = connection.execute(select(func.count()).select_from(prediction_feedback)).scalar_one()
        correct_count = connection.execute(select(func.count()).select_from(prediction_feedback).where(prediction_feedback.c.correct == True)).scalar_one()
        active_count = 0
        active_correct = 0
        if active_model_id:
            active_count = connection.execute(
                select(func.count()).select_from(prediction_feedback).where(prediction_feedback.c.model_version_id == active_model_id)
            ).scalar_one()
            active_correct = connection.execute(
                select(func.count()).select_from(prediction_feedback).where(prediction_feedback.c.model_version_id == active_model_id).where(prediction_feedback.c.correct == True)
            ).scalar_one()
        latest = connection.execute(select(prediction_feedback).order_by(prediction_feedback.c.created_at.desc()).limit(1)).mappings().first()
    latest_feedback = dict(latest) if latest else None
    if latest_feedback and latest_feedback.get("created_at") is not None:
        latest_feedback["created_at"] = latest_feedback["created_at"].isoformat()
    return {
        "feedback_count": int(feedback_count or 0),
        "correct_count": int(correct_count or 0),
        "feedback_accuracy": ratio(correct_count, feedback_count),
        "active_model_id": active_model_id,
        "active_model_feedback_count": int(active_count or 0),
        "active_model_correct_count": int(active_correct or 0),
        "active_model_feedback_accuracy": ratio(active_correct, active_count),
        "latest_feedback": latest_feedback,
    }


def ratio(numerator: Any, denominator: Any) -> float | None:
    denominator_value = int(denominator or 0)
    if denominator_value <= 0:
        return None
    return round(float(numerator or 0) / denominator_value, 6)


def create_retraining_request(
    trigger: str,
    reason: str,
    requested_by: str | None,
    min_feedback_count: int,
    policy: dict[str, Any] | None,
    active_model_id: str,
) -> dict[str, Any]:
    feedback = feedback_summary(active_model_id)
    feedback_count = int(feedback["feedback_count"] or 0)
    status = "pending_review" if feedback_count >= min_feedback_count else "blocked"
    request_id = str(uuid4())
    created_at = now()
    effective_policy = {
        "min_feedback_count": min_feedback_count,
        "source": "runtime_feedback",
        "requires_manual_approval": True,
        **(policy or {}),
    }
    details = {
        "feedback": feedback,
        "blocked_reason": None if status == "pending_review" else "feedback_count_below_minimum",
        "next_step": "approve_then_run_retraining_in_studio_worker",
    }
    with engine.begin() as connection:
        connection.execute(
            insert(retraining_requests).values(
                id=request_id,
                status=status,
                trigger=trigger,
                reason=reason,
                requested_by=requested_by,
                approved_by=None,
                feedback_count=feedback_count,
                feedback_accuracy=feedback["feedback_accuracy"],
                active_model_id=active_model_id,
                policy=effective_policy,
                details=details,
                created_at=created_at,
                approved_at=None,
                completed_at=None,
            )
        )
    return {
        "request_id": request_id,
        "status": status,
        "trigger": trigger,
        "reason": reason,
        "requested_by": requested_by,
        "feedback_count": feedback_count,
        "feedback_accuracy": feedback["feedback_accuracy"],
        "active_model_id": active_model_id,
        "policy": effective_policy,
        "details": details,
        "created_at": created_at.isoformat(),
    }


def approve_retraining_request(request_id: str, approved_by: str | None, confirm: bool) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Aprovação de retreino exige confirm=true.")
    approved_at = now()
    with engine.begin() as connection:
        row = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
        if row is None:
            return None
        if row["status"] == "blocked":
            raise ValueError("Solicitação bloqueada não pode ser aprovada.")
        if row["status"] == "completed":
            raise ValueError("Solicitação já concluída não pode ser aprovada.")
        details = dict(row["details"] or {})
        details["approved"] = {"approved_by": approved_by, "approved_at": approved_at.isoformat()}
        details["next_step"] = "run_controlled_retraining_job_in_studio"
        connection.execute(
            retraining_requests.update()
            .where(retraining_requests.c.id == request_id)
            .values(status="approved_pending_runner", approved_by=approved_by, approved_at=approved_at, details=details)
        )
        updated = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
    return retraining_request_to_dict(updated)


def complete_retraining_request(
    request_id: str,
    completed_by: str | None,
    confirm: bool,
    success: bool,
    result: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Conclusão de retreino exige confirm=true.")
    completed_at = now()
    final_status = "completed" if success else "runner_failed"
    with engine.begin() as connection:
        row = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
        if row is None:
            return None
        if row["status"] == final_status:
            return retraining_request_to_dict(row)
        if row["status"] not in ["approved_pending_runner", "runner_failed"]:
            raise ValueError(f"Solicitação em status {row['status']} não pode ser concluída pelo runner.")
        details = dict(row["details"] or {})
        details["runner"] = {
            "completed_by": completed_by,
            "completed_at": completed_at.isoformat(),
            "success": success,
            "result": result or {},
        }
        details["next_step"] = "review_retrained_model_for_promotion" if success else "inspect_failed_retraining_job"
        connection.execute(
            retraining_requests.update()
            .where(retraining_requests.c.id == request_id)
            .values(status=final_status, completed_at=completed_at, details=details)
        )
        updated = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
    return retraining_request_to_dict(updated)


def retraining_status(active_model_id: str) -> dict[str, Any]:
    with engine.connect() as connection:
        total = connection.execute(select(func.count()).select_from(retraining_requests)).scalar_one()
        pending = connection.execute(select(func.count()).select_from(retraining_requests).where(retraining_requests.c.status.in_(["pending_review", "approved_pending_runner"]))).scalar_one()
        latest = connection.execute(select(retraining_requests).order_by(retraining_requests.c.created_at.desc()).limit(1)).mappings().first()
    return {
        "request_count": int(total or 0),
        "pending_count": int(pending or 0),
        "latest_request": retraining_request_to_dict(latest),
        "feedback": feedback_summary(active_model_id),
    }


def retraining_training_set(request_id: str, target_field: str, limit: int = 1000) -> dict[str, Any] | None:
    safe_limit = max(1, min(int(limit or 1000), 10000))
    with engine.connect() as connection:
        request = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
        if request is None:
            return None
        rows_query = (
            select(prediction_feedback, prediction_rows.c.input_masked)
            .select_from(prediction_feedback.join(prediction_rows, prediction_feedback.c.row_id == prediction_rows.c.id))
            .where(prediction_feedback.c.model_version_id == request["active_model_id"])
            .order_by(prediction_feedback.c.created_at.desc())
            .limit(safe_limit)
        )
        feedback_rows = connection.execute(rows_query).mappings().all()
    rows: list[dict[str, Any]] = []
    skipped = 0
    for feedback in feedback_rows:
        input_payload = feedback.get("input_masked") if isinstance(feedback.get("input_masked"), dict) else {}
        if not input_payload:
            skipped += 1
            continue
        row = dict(input_payload)
        row[target_field] = feedback.get("actual_label")
        rows.append(row)
    return {
        "request_id": request_id,
        "request_status": request["status"],
        "active_model_id": request["active_model_id"],
        "target": target_field,
        "source": "runtime_feedback",
        "row_count": len(rows),
        "skipped_rows": skipped,
        "limit": safe_limit,
        "rows": rows,
        "payload_policy": "masked_unless_STORE_FULL_PAYLOAD_true",
    }


def retraining_request_to_dict(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in ["created_at", "approved_at", "completed_at"]:
        if data.get(key) is not None:
            data[key] = data[key].isoformat()
    return data


def runtime_metrics(active_model_id: str) -> dict[str, Any]:
    with engine.connect() as connection:
        prediction_count = connection.execute(select(func.count()).select_from(prediction_rows)).scalar_one()
        evaluation_count = connection.execute(select(func.count()).select_from(evaluation_runs)).scalar_one()
        drift_count = connection.execute(select(func.count()).select_from(drift_runs)).scalar_one()
        latest_drift_score = connection.execute(select(drift_runs.c.score).order_by(drift_runs.c.created_at.desc()).limit(1)).scalar_one_or_none()
        avg_latency = connection.execute(select(func.avg(prediction_rows.c.latency_ms))).scalar_one()
        retraining_pending = connection.execute(select(func.count()).select_from(retraining_requests).where(retraining_requests.c.status.in_(["pending_review", "approved_pending_runner"]))).scalar_one()
        ab_experiment_count = connection.execute(select(func.count()).select_from(ab_experiments)).scalar_one()
        active_ab_experiment_count = connection.execute(select(func.count()).select_from(ab_experiments).where(ab_experiments.c.status == "active")).scalar_one()
    feedback = feedback_summary(active_model_id)
    return {
        "active_model_id": active_model_id,
        "prediction_count": int(prediction_count or 0),
        "evaluation_count": int(evaluation_count or 0),
        "drift_count": int(drift_count or 0),
        "ab_experiment_count": int(ab_experiment_count or 0),
        "active_ab_experiment_count": int(active_ab_experiment_count or 0),
        "feedback_count": feedback["feedback_count"],
        "feedback_accuracy": feedback["feedback_accuracy"],
        "retraining_pending_count": int(retraining_pending or 0),
        "error_rate": 0.0,
        "latency_avg_ms": float(avg_latency or 0.0),
        "latency_p95_ms": float(avg_latency or 0.0),
        "drift_score": float(latest_drift_score or 0.0),
    }


class Timer:
    def __enter__(self):
        self.started = perf_counter()
        return self

    def __exit__(self, *_args):
        self.latency_ms = (perf_counter() - self.started) * 1000
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

function renderRuntimePy(): string {
  return `import base64
import copy
import hashlib
import json
import math
import pickle
import re
from pathlib import Path
from typing import Any
from sqlalchemy import select
from .db import deployment_rollouts, embedding_profiles as embedding_profiles_table, engine, model_versions


BASE_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = BASE_DIR.parent
METADATA_DIR = BASE_DIR / "metadata"
ARTIFACTS_DIR = PACKAGE_DIR / ".mlops" / "artifacts"


def load_json(name: str) -> dict[str, Any]:
    return json.loads((METADATA_DIR / name).read_text(encoding="utf-8"))


def load_optional_json(name: str) -> dict[str, Any] | None:
    path = METADATA_DIR / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


project = load_json("project.json")
pipeline = load_json("pipeline.flow.json")
runtime_manifest = load_json("runtime.manifest.json")
latest_training_result = load_optional_json("latest-training-result.json")
PREDICTION_CACHE: dict[str, dict[str, Any]] = {}
PREDICTION_CACHE_MAX_ITEMS = 512


def model_catalog() -> list[dict[str, Any]]:
    models = []
    trained_models = trained_model_lookup()
    stored_models = stored_model_lookup()
    active_id = operational_active_model_id()
    seen_model_ids = set()
    for node in pipeline.get("nodes", []):
        if node.get("type") == "model":
            trained = trained_models.get(node["id"], {})
            stored = stored_models.get(node["id"], {})
            seen_model_ids.add(node["id"])
            models.append({
                "id": node["id"],
                "label": node.get("label", node["id"]),
                "algorithm": stored.get("algorithm") or node.get("algorithm") or node.get("framework") or "custom",
                "role": node.get("modelRole", "candidate"),
                "status": "active" if node["id"] == active_id else stored.get("status") or "candidate",
                "metrics": stored.get("metrics") or trained.get("metrics") or synthetic_model_metrics(node["id"]),
                "artifact_uri": stored.get("artifact_uri") or trained.get("artifactUri"),
                "training_run_id": latest_training_result.get("runId") if trained and latest_training_result else None,
                "training_rows": trained.get("trainingRows"),
                "validation_rows": trained.get("validationRows"),
            })
    for model_id, stored in stored_models.items():
        if model_id in seen_model_ids:
            continue
        models.append({
            "id": model_id,
            "label": model_id,
            "algorithm": stored.get("algorithm") or "registered",
            "role": "registered",
            "status": "active" if model_id == active_id or stored.get("is_active") else stored.get("status") or "registered",
            "metrics": stored.get("metrics") or synthetic_model_metrics(model_id),
            "artifact_uri": stored.get("artifact_uri"),
            "training_run_id": None,
            "training_rows": None,
            "validation_rows": None,
        })
    if not models:
        models.append({
            "id": "deterministic_baseline",
            "label": "Deterministic baseline",
            "algorithm": "hash_baseline",
            "role": "active",
            "status": "active",
            "metrics": synthetic_model_metrics("deterministic_baseline"),
        })
    return models


def trained_model_lookup() -> dict[str, dict[str, Any]]:
    if not latest_training_result:
        return {}
    lookup: dict[str, dict[str, Any]] = {}
    for model in latest_training_result.get("leaderboard", []):
        if isinstance(model, dict) and model.get("modelId"):
            lookup[str(model["modelId"])] = model
    return lookup


def stored_model_lookup() -> dict[str, dict[str, Any]]:
    try:
        with engine.connect() as connection:
            rows = connection.execute(select(model_versions)).mappings().fetchall()
        return {
            str(row["id"]): {
                "id": row["id"],
                "status": row["status"],
                "algorithm": row["algorithm"],
                "metrics": row["metrics"] or {},
                "artifact_uri": row["artifact_uri"],
                "is_active": bool(row["is_active"]),
            }
            for row in rows
        }
    except Exception:
        return {}


def resolve_artifact_uri(artifact_uri: str | None) -> Path | None:
    if not artifact_uri:
        return None
    normalized = artifact_uri.replace("\\\\", "/").lstrip("/")
    if normalized.startswith("../") or "/../" in normalized:
        return None
    if normalized.startswith("artifacts/"):
        normalized = normalized.removeprefix("artifacts/")
    candidate = (ARTIFACTS_DIR / normalized).resolve()
    artifacts_root = ARTIFACTS_DIR.resolve()
    if candidate != artifacts_root and artifacts_root not in candidate.parents:
        return None
    return candidate


def load_model_artifact(model: dict[str, Any]) -> dict[str, Any] | None:
    artifact_path = resolve_artifact_uri(model.get("artifact_uri"))
    if not artifact_path or not artifact_path.exists():
        return None
    try:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return artifact if isinstance(artifact, dict) else None


def active_model() -> dict[str, Any]:
    models = model_catalog()
    active_id = operational_active_model_id()
    for model in models:
        if model["id"] == active_id or model["status"] == "active":
            return model
    return models[0]


def model_by_id(model_id: str | None) -> dict[str, Any] | None:
    if not model_id:
        return None
    return next((model for model in model_catalog() if model["id"] == model_id), None)


def operational_active_model_id() -> str:
    try:
        with engine.connect() as connection:
            row = connection.execute(select(model_versions.c.id).where(model_versions.c.is_active == True).limit(1)).scalar_one_or_none()
        return str(row or runtime_manifest["activeModelId"])
    except Exception:
        return runtime_manifest["activeModelId"]


def active_rollout() -> dict[str, Any] | None:
    try:
        with engine.connect() as connection:
            row = connection.execute(
                select(deployment_rollouts)
                .where(deployment_rollouts.c.status == "active")
                .order_by(deployment_rollouts.c.created_at.desc())
                .limit(1)
            ).mappings().first()
        return dict(row) if row else None
    except Exception:
        return None


def synthetic_model_metrics(model_id: str) -> dict[str, float]:
    digest = int(hashlib.sha256(model_id.encode("utf-8")).hexdigest()[:8], 16)
    problem_type = project["problem"]["type"]
    if problem_type == "regression":
        return {"rmse": round(12.0 + digest % 200 / 100, 4), "mae": round(8.0 + digest % 120 / 100, 4), "r2": round(0.72 + digest % 20 / 100, 4)}
    return {"accuracy": round(0.78 + digest % 12 / 100, 4), "f1_macro": round(0.74 + digest % 14 / 100, 4), "f1_weighted": round(0.76 + digest % 12 / 100, 4)}


def model_metrics() -> dict[str, Any]:
    models = model_catalog()
    return {
        "primary_metric": project["metrics"]["primary"],
        "secondary_metrics": project["metrics"].get("secondary", []),
        "latest_training_run_id": latest_training_result.get("runId") if latest_training_result else None,
        "best_model_id": latest_training_result.get("bestModelId") if latest_training_result else None,
        "models": models,
    }


def model_card() -> dict[str, Any]:
    return {
        "project": {"id": project["id"], "name": project["name"], "version": project["version"]},
        **project.get("modelCard", {}),
        "active_model": active_model(),
    }


def predict_payload(payload: dict[str, Any]) -> dict[str, Any]:
    active = active_model()
    rollout = active_rollout()
    if not rollout:
        cached = prediction_cache_get(payload, active)
        if cached:
            return cached
    if rollout and rollout.get("kind") == "canary":
        candidate = model_by_id(str(rollout.get("candidate_model_id") or ""))
        traffic_percent = float(rollout.get("traffic_percent") or 0.0)
        if candidate and rollout_bucket(payload) < traffic_percent:
            output = predict_with_model(payload, candidate)
            output["deployment"] = {"mode": "canary", "rollout_id": rollout["id"], "routed_to": "candidate", "traffic_percent": traffic_percent, "active_model_id": active["id"], "candidate_model_id": candidate["id"]}
            return output
        output = predict_with_model(payload, active)
        output["deployment"] = {"mode": "canary", "rollout_id": rollout["id"], "routed_to": "active", "traffic_percent": traffic_percent, "active_model_id": active["id"], "candidate_model_id": rollout.get("candidate_model_id")}
        return output
    output = predict_with_model(payload, active)
    if rollout and rollout.get("kind") == "shadow":
        candidate = model_by_id(str(rollout.get("candidate_model_id") or ""))
        if candidate:
            shadow_output = predict_with_model(payload, candidate)
            output["deployment"] = {"mode": "shadow", "rollout_id": rollout["id"], "routed_to": "active", "active_model_id": active["id"], "candidate_model_id": candidate["id"]}
            output["shadow_prediction"] = compact_shadow_prediction(shadow_output)
    if not rollout:
        return prediction_cache_put(payload, active, output)
    return output


def prediction_cache_get(payload: dict[str, Any], model: dict[str, Any]) -> dict[str, Any] | None:
    key = prediction_cache_key(payload, model)
    cached = PREDICTION_CACHE.get(key)
    if not cached:
        return None
    output = copy.deepcopy(cached)
    output["cache"] = {"hit": True, "key": key, "strategy": "in_memory_versioned_payload_cache"}
    return output


def prediction_cache_put(payload: dict[str, Any], model: dict[str, Any], output: dict[str, Any]) -> dict[str, Any]:
    key = prediction_cache_key(payload, model)
    stored = copy.deepcopy(output)
    stored.pop("cache", None)
    PREDICTION_CACHE[key] = stored
    while len(PREDICTION_CACHE) > PREDICTION_CACHE_MAX_ITEMS:
        PREDICTION_CACHE.pop(next(iter(PREDICTION_CACHE)))
    response = copy.deepcopy(output)
    response["cache"] = {"hit": False, "key": key, "strategy": "in_memory_versioned_payload_cache"}
    return response


def prediction_cache_key(payload: dict[str, Any], model: dict[str, Any]) -> str:
    raw = json.dumps(
        {
            "payload": payload,
            "projectHash": runtime_manifest.get("projectHash"),
            "pipelineHash": runtime_manifest.get("pipelineHash"),
            "modelVersionId": model.get("id"),
            "legalPolicy": legal_cache_policy_key(),
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def legal_cache_policy_key() -> dict[str, Any]:
    legal = legal_domain()
    if not legal:
        return {}
    embedding_profile = active_legal_embedding_profile(legal) or {}
    return {
        "decisionPolicy": legal_decision_policy(legal).get("version"),
        "embeddingProfileId": embedding_profile.get("id"),
        "embeddingModelVersion": embedding_profile.get("modelVersion"),
        "preprocessingVersion": embedding_profile.get("preprocessingVersion"),
        "chunkingVersion": embedding_profile.get("chunkingVersion"),
        "llmPromptTemplateVersion": (legal.get("llm") or {}).get("promptTemplateVersion") if isinstance(legal.get("llm"), dict) else None,
    }


def predict_with_model(payload: dict[str, Any], model: dict[str, Any]) -> dict[str, Any]:
    problem = project["problem"]
    trace = [{"node_id": node["id"], "type": node["type"], "status": "completed"} for node in pipeline.get("nodes", [])]
    artifact = load_model_artifact(model)
    artifact_prediction = predict_from_artifact(artifact, payload, problem, trace, model) if artifact else None
    if artifact_prediction:
        return enrich_prediction_output(artifact_prediction, payload, trace)

    return enrich_prediction_output(synthetic_predict_payload(payload, model, problem, trace), payload, trace)


def rollout_bucket(payload: dict[str, Any]) -> float:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    digest = int(hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8], 16)
    return float(digest % 10000) / 100.0


def compact_shadow_prediction(output: dict[str, Any]) -> dict[str, Any]:
    return {
        "model_version_id": output.get("model_version_id"),
        "prediction": output.get("prediction"),
        "confidence": output.get("confidence"),
        "inference_source": output.get("inference_source"),
    }


def enrich_prediction_output(output: dict[str, Any], payload: dict[str, Any], trace: list[dict[str, Any]]) -> dict[str, Any]:
    legal = legal_domain()
    if not legal or project["problem"].get("type") == "regression":
        return output

    explanation = legal_explanation(payload, output, legal)
    trace.append({
        "node_id": "legal_decision_policy",
        "type": "domain_policy",
        "status": explanation["review"]["status"],
        "details": {
            "policy_version": explanation["decisionPolicy"]["version"],
            "review_reasons": explanation["review"]["reasons"],
            "final_score": explanation["scores"]["finalScore"],
        },
    })
    output["explanation"] = explanation
    output["review"] = explanation["review"]
    output["decision"] = explanation["decision"]
    output["top_candidates"] = explanation["topCandidates"]
    output["embedding_profile"] = explanation["embeddingProfile"]
    return output


def legal_domain() -> dict[str, Any] | None:
    domain = project.get("domain", {})
    if not isinstance(domain, dict) or domain.get("kind") != "legal_classification":
        return None
    legal = domain.get("legal")
    return legal if isinstance(legal, dict) else None


def legal_explanation(payload: dict[str, Any], output: dict[str, Any], legal: dict[str, Any]) -> dict[str, Any]:
    prediction = str(output.get("prediction") or "")
    categories = legal_categories_by_code(legal)
    category = legal_category_payload(categories.get(prediction), prediction)
    probabilities = output.get("probabilities") if isinstance(output.get("probabilities"), dict) else {}
    candidates = legal_top_candidates(probabilities, prediction, categories)
    classifier_probability = as_float(output.get("confidence"))
    if classifier_probability is None and candidates:
        classifier_probability = as_float(candidates[0].get("probability"))
    semantic_similarity = semantic_similarity_from_payload(payload)
    workflow = legal_workflow_result(payload, prediction, legal)
    policy = legal_decision_policy(legal)
    final_score = legal_final_score(classifier_probability, semantic_similarity, workflow["ruleScore"], policy)
    margin = legal_top_margin(candidates)
    review = legal_review_decision(classifier_probability, margin, workflow, category, legal)
    llm = legal_llm_decision(review, legal)
    decision = {
        "status": review["status"],
        "categoryCode": prediction,
        "categoryName": category.get("name"),
        "confidence": classifier_probability,
        "finalScore": final_score,
        "humanReviewRequired": review["humanReviewRequired"],
        "llmReviewRecommended": llm["recommended"],
    }
    rationale = legal_rationale(category, classifier_probability, semantic_similarity, workflow, final_score, review, llm)
    return {
        "kind": "legal_classification",
        "category": category,
        "decision": decision,
        "scores": {
            "classifierProbability": classifier_probability,
            "semanticSimilarity": semantic_similarity,
            "workflowRuleScore": workflow["ruleScore"],
            "finalScore": final_score,
            "topMargin": margin,
        },
        "topCandidates": candidates,
        "workflow": workflow,
        "decisionPolicy": policy,
        "embeddingProfile": active_legal_embedding_profile(legal),
        "llm": llm,
        "review": review,
        "rationale": rationale,
    }


def legal_categories_by_code(legal: dict[str, Any]) -> dict[str, dict[str, Any]]:
    categories = legal.get("categories", [])
    if not isinstance(categories, list):
        return {}
    return {
        str(category.get("code")): category
        for category in categories
        if isinstance(category, dict) and category.get("code")
    }


def legal_category_payload(category: dict[str, Any] | None, code: str) -> dict[str, Any]:
    source = category or {}
    return {
        "code": code,
        "name": source.get("name") or code,
        "description": source.get("description"),
        "target": source.get("target"),
        "critical": bool(source.get("critical", False)),
        "requiresHumanReview": bool(source.get("requiresHumanReview", False)),
        "workflowStepCodes": list(source.get("workflowStepCodes") or []),
    }


def legal_top_candidates(probabilities: Any, prediction: str, categories: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: dict[str, float] = {}
    if isinstance(probabilities, dict):
        for label, value in probabilities.items():
            numeric = as_float(value)
            if numeric is not None:
                normalized[str(label)] = numeric
    classes = [str(item) for item in project["problem"].get("classes") or []]
    for label in classes:
        normalized.setdefault(label, 0.0)
    if prediction and prediction not in normalized:
        normalized[prediction] = 1.0 if not probabilities else 0.0
    items = sorted(normalized.items(), key=lambda item: item[1], reverse=True)
    return [
        {
            "code": label,
            "name": (categories.get(label) or {}).get("name") or label,
            "probability": round(float(probability), 6),
            "critical": bool((categories.get(label) or {}).get("critical", False)),
            "requiresHumanReview": bool((categories.get(label) or {}).get("requiresHumanReview", False)),
        }
        for label, probability in items[:5]
    ]


def legal_top_margin(candidates: list[dict[str, Any]]) -> float | None:
    if len(candidates) < 2:
        return None
    left = as_float(candidates[0].get("probability")) or 0.0
    right = as_float(candidates[1].get("probability")) or 0.0
    return round(max(0.0, left - right), 6)


def legal_workflow_result(payload: dict[str, Any], prediction: str, legal: dict[str, Any]) -> dict[str, Any]:
    workflow_field = str(legal.get("workflowContextField") or "workflow_step_atual")
    current_step = payload.get(workflow_field)
    current_step = str(current_step) if current_step is not None and str(current_step).strip() else None
    categories = legal_categories_by_code(legal)
    category = categories.get(prediction) or {}
    allowed_steps = [str(item) for item in category.get("workflowStepCodes", [])]
    workflow_steps = legal_workflow_steps_by_code(legal)
    active_transitions = legal_active_transitions(legal)
    transitions_from_current = [
        transition
        for transition in active_transitions
        if current_step and transition.get("from") == current_step
    ]
    review_transitions_to_allowed = [
        transition
        for transition in transitions_from_current
        if transition.get("to") in allowed_steps and transition.get("severity") == "review"
    ]
    blocked_rules: list[str] = []
    if current_step is None:
        status = "unknown"
        allowed = None
        rule_score = 0.5
    elif current_step in allowed_steps:
        status = "accepted"
        allowed = True
        rule_score = 1.0
    elif review_transitions_to_allowed:
        status = "review"
        allowed = False
        rule_score = 0.75
        blocked_rules.append("workflow_requires_transition_confirmation")
    else:
        status = "blocked"
        allowed = False
        rule_score = 0.0
        blocked_rules.append(f"category_{prediction}_not_allowed_from_{current_step}")
    return {
        "contextField": workflow_field,
        "currentStep": current_step,
        "currentStepName": (workflow_steps.get(current_step or "") or {}).get("name"),
        "allowedSteps": allowed_steps,
        "allowedStepNames": [(workflow_steps.get(step) or {}).get("name") or step for step in allowed_steps],
        "allowed": allowed,
        "status": status,
        "ruleScore": rule_score,
        "blockedRules": blocked_rules,
        "availableTransitions": [
            {
                "from": transition.get("from"),
                "to": transition.get("to"),
                "severity": transition.get("severity"),
                "condition": transition.get("condition"),
            }
            for transition in transitions_from_current
        ],
    }


def legal_workflow_steps_by_code(legal: dict[str, Any]) -> dict[str, dict[str, Any]]:
    steps = legal.get("workflowSteps", [])
    if not isinstance(steps, list):
        return {}
    return {
        str(step.get("code")): step
        for step in steps
        if isinstance(step, dict) and step.get("code")
    }


def legal_active_transitions(legal: dict[str, Any]) -> list[dict[str, Any]]:
    transitions = legal.get("workflowTransitions", [])
    if not isinstance(transitions, list):
        return []
    return [
        transition
        for transition in transitions
        if isinstance(transition, dict) and transition.get("active", True)
    ]


def legal_decision_policy(legal: dict[str, Any]) -> dict[str, Any]:
    policy = legal.get("decisionPolicy") if isinstance(legal.get("decisionPolicy"), dict) else {}
    weights = policy.get("weights") if isinstance(policy.get("weights"), dict) else {}
    return {
        "version": policy.get("version") or "legal-decision-policy-v1",
        "lowConfidenceThreshold": as_float(policy.get("lowConfidenceThreshold")) if as_float(policy.get("lowConfidenceThreshold")) is not None else 0.62,
        "topMarginThreshold": as_float(policy.get("topMarginThreshold")) if as_float(policy.get("topMarginThreshold")) is not None else 0.08,
        "weights": {
            "classifierProbability": as_float(weights.get("classifierProbability")) if as_float(weights.get("classifierProbability")) is not None else 0.55,
            "semanticSimilarity": as_float(weights.get("semanticSimilarity")) if as_float(weights.get("semanticSimilarity")) is not None else 0.30,
            "workflowRules": as_float(weights.get("workflowRules")) if as_float(weights.get("workflowRules")) is not None else 0.15,
            "llmReview": as_float(weights.get("llmReview")) if as_float(weights.get("llmReview")) is not None else 0.0,
        },
    }


def legal_final_score(classifier_probability: float | None, semantic_similarity: float | None, workflow_rule_score: float, policy: dict[str, Any]) -> float | None:
    weights = policy.get("weights", {})
    weighted_values: list[tuple[float, float]] = []
    if classifier_probability is not None:
        weighted_values.append((classifier_probability, float(weights.get("classifierProbability", 0.55))))
    if semantic_similarity is not None:
        weighted_values.append((semantic_similarity, float(weights.get("semanticSimilarity", 0.30))))
    weighted_values.append((workflow_rule_score, float(weights.get("workflowRules", 0.15))))
    total_weight = sum(weight for _value, weight in weighted_values if weight > 0)
    if total_weight <= 0:
        return classifier_probability
    return round(sum(value * weight for value, weight in weighted_values if weight > 0) / total_weight, 6)


def legal_review_decision(classifier_probability: float | None, top_margin: float | None, workflow: dict[str, Any], category: dict[str, Any], legal: dict[str, Any]) -> dict[str, Any]:
    policy = legal_decision_policy(legal)
    reasons: list[str] = []
    if classifier_probability is not None and classifier_probability < float(policy["lowConfidenceThreshold"]):
        reasons.append("low_confidence")
    if top_margin is not None and top_margin < float(policy["topMarginThreshold"]):
        reasons.append("top_margin_low")
    if workflow["status"] == "blocked":
        reasons.append("workflow_blocked")
    elif workflow["status"] in {"review", "unknown"}:
        reasons.append("workflow_requires_review")
    if category.get("critical"):
        reasons.append("critical_category")
    if category.get("requiresHumanReview"):
        reasons.append("category_requires_human_review")
    status = "blocked" if "workflow_blocked" in reasons else "review" if reasons else "accepted"
    return {
        "status": status,
        "humanReviewRequired": status != "accepted",
        "reasons": reasons,
        "lowConfidenceThreshold": policy["lowConfidenceThreshold"],
        "topMarginThreshold": policy["topMarginThreshold"],
    }


def legal_llm_decision(review: dict[str, Any], legal: dict[str, Any]) -> dict[str, Any]:
    llm = legal.get("llm") if isinstance(legal.get("llm"), dict) else {}
    trigger_policy = [str(item) for item in llm.get("triggerPolicy", [])] if isinstance(llm.get("triggerPolicy"), list) else []
    matching_triggers = [reason for reason in review.get("reasons", []) if reason in trigger_policy]
    enabled = bool(llm.get("enabled", False))
    return {
        "enabled": enabled,
        "recommended": enabled and bool(matching_triggers),
        "used": False,
        "reason": "llm_disabled_by_policy" if not enabled else "llm_not_invoked_in_local_runtime",
        "triggerPolicy": trigger_policy,
        "matchedTriggers": matching_triggers,
        "promptTemplateVersion": llm.get("promptTemplateVersion") or "legal-low-confidence-v1",
        "maskSensitiveData": bool(llm.get("maskSensitiveData", True)),
        "jsonResponseRequired": bool(llm.get("jsonResponseRequired", True)),
        "mustNotAutoApply": bool(llm.get("mustNotAutoApply", True)),
    }


def legal_rationale(
    category: dict[str, Any],
    classifier_probability: float | None,
    semantic_similarity: float | None,
    workflow: dict[str, Any],
    final_score: float | None,
    review: dict[str, Any],
    llm: dict[str, Any],
) -> list[str]:
    rationale = [
        f"Categoria {category.get('code')} ({category.get('name')}) foi escolhida pelo modelo ativo.",
        f"Probabilidade do classificador: {classifier_probability if classifier_probability is not None else 'n/d'}.",
        f"Score final híbrido: {final_score if final_score is not None else 'n/d'}.",
    ]
    if semantic_similarity is None:
        rationale.append("Similaridade semântica não foi recebida no payload; o score foi reponderado sem a camada vetorial.")
    else:
        rationale.append(f"Similaridade semântica recebida: {semantic_similarity}.")
    if workflow["status"] == "accepted":
        rationale.append("A categoria é compatível com a etapa atual do workflow.")
    elif workflow["status"] == "blocked":
        rationale.append("A categoria viola as regras de workflow configuradas para a etapa atual.")
    else:
        rationale.append("O workflow exige revisão ou não possui etapa atual suficiente para aprovação automática.")
    if review["humanReviewRequired"]:
        rationale.append(f"Revisão humana exigida por: {', '.join(review['reasons'])}.")
    if llm["recommended"]:
        rationale.append("LLM recomendado como quarta camada, mas sem autoaplicação da decisão.")
    return rationale


def active_legal_embedding_profile(legal: dict[str, Any]) -> dict[str, Any] | None:
    profiles = legal.get("embeddingProfiles", [])
    if not isinstance(profiles, list):
        return None
    active = next((profile for profile in profiles if isinstance(profile, dict) and profile.get("status") == "active"), None)
    fallback = next((profile for profile in profiles if isinstance(profile, dict)), None)
    profile = active or fallback
    if not profile:
        return None
    return {
        "id": profile.get("id"),
        "provider": profile.get("provider"),
        "modelName": profile.get("modelName"),
        "modelVersion": profile.get("modelVersion"),
        "modelDigest": profile.get("modelDigest"),
        "dimension": profile.get("dimension"),
        "normalization": profile.get("normalization"),
        "pooling": profile.get("pooling"),
        "preprocessingVersion": profile.get("preprocessingVersion"),
        "chunkingVersion": profile.get("chunkingVersion"),
        "similarityMetric": profile.get("similarityMetric"),
        "vectorCollections": profile.get("vectorCollections", {}),
        "status": profile.get("status"),
    }


def stored_embedding_profile_lookup() -> dict[str, dict[str, Any]]:
    try:
        with engine.connect() as connection:
            rows = connection.execute(select(embedding_profiles_table)).mappings().fetchall()
        return {
            str(row["id"]): {
                "id": row["id"],
                "provider": row["provider"],
                "modelName": row["model_name"],
                "modelVersion": row["model_version"],
                "modelDigest": row["model_digest"],
                "dimension": row["dimension"],
                "normalization": (row["metadata_json"] or {}).get("normalization") if isinstance(row["metadata_json"], dict) else None,
                "pooling": (row["metadata_json"] or {}).get("pooling") if isinstance(row["metadata_json"], dict) else None,
                "preprocessingVersion": row["preprocessing_version"],
                "chunkingVersion": row["chunking_version"],
                "similarityMetric": row["similarity_metric"],
                "vectorCollections": row["vector_collections"] or {},
                "status": row["status"],
                "source": "registry",
            }
            for row in rows
        }
    except Exception:
        return {}


def embedding_profiles() -> dict[str, Any]:
    legal = legal_domain()
    if not legal:
        return {"kind": "embedding_profiles", "activeProfileId": None, "profiles": []}
    stored_profiles = stored_embedding_profile_lookup()
    profiles = []
    seen_profile_ids = set()
    for profile in legal.get("embeddingProfiles", []):
        if isinstance(profile, dict):
            response = active_legal_embedding_profile({"embeddingProfiles": [profile]})
            if response and response.get("id") in stored_profiles:
                response = {**response, **stored_profiles[str(response["id"])], "source": "manifest+registry"}
            if response and response.get("id"):
                seen_profile_ids.add(str(response["id"]))
            profiles.append(response)
    for profile_id, stored in stored_profiles.items():
        if profile_id not in seen_profile_ids:
            profiles.append(stored)
    profiles = [profile for profile in profiles if profile]
    active = next((profile for profile in profiles if profile.get("status") == "active"), None) or active_legal_embedding_profile(legal)
    return {
        "kind": "embedding_profiles",
        "activeProfileId": active.get("id") if active else None,
        "profiles": profiles,
        "substitutionContract": {
            "stableInputs": ["textHash", "entityType", "entityId", "chunkId"],
            "versionedKeys": ["embeddingProfileId", "modelName", "modelVersion", "preprocessingVersion", "chunkingVersion"],
            "architectureInvariant": "Trocar o modelo de embeddings exige novo profile e reindexação, sem alterar o contrato de inferência.",
        },
    }


def embedding_search(query: str, collection: str | None = None, top_k: int = 5, profile_id: str | None = None) -> dict[str, Any]:
    legal = legal_domain()
    if not legal:
        return {"kind": "embedding_search", "status": "empty", "profileId": profile_id, "collection": collection, "results": []}
    profile_catalog = embedding_profiles()
    active = next((profile for profile in profile_catalog.get("profiles", []) if profile.get("id") == profile_catalog.get("activeProfileId")), None) or active_legal_embedding_profile(legal)
    effective_profile_id = profile_id or (active.get("id") if active else None)
    candidates = legal_embedding_search_candidates(legal, collection)
    scored = [
        {
            **candidate,
            "score": lexical_similarity(query, candidate.get("text", "")),
            "profileId": effective_profile_id,
        }
        for candidate in candidates
    ]
    scored = [item for item in scored if item["score"] > 0]
    scored.sort(key=lambda item: item["score"], reverse=True)
    return {
        "kind": "embedding_search",
        "status": "ok",
        "profileId": effective_profile_id,
        "collection": collection or "all",
        "topK": top_k,
        "metric": active.get("similarityMetric") if active else "cosine",
        "results": [
            {
                "entityType": item["entityType"],
                "entityId": item["entityId"],
                "label": item["label"],
                "score": round(float(item["score"]), 6),
                "metadata": item["metadata"],
            }
            for item in scored[: max(1, min(int(top_k or 5), 50))]
        ],
        "implementation": "deterministic_lexical_fallback",
        "message": "Busca local usa fallback lexical determinístico quando o banco vetorial externo não está conectado.",
    }


def legal_embedding_search_candidates(legal: dict[str, Any], collection: str | None) -> list[dict[str, Any]]:
    collection_filter = str(collection or "").strip()
    candidates: list[dict[str, Any]] = []
    if not collection_filter or collection_filter in {"categories", "legal_categories"}:
        for category in legal.get("categories", []):
            if isinstance(category, dict) and category.get("code"):
                candidates.append({
                    "entityType": "legal_category",
                    "entityId": str(category["code"]),
                    "label": category.get("name") or category["code"],
                    "text": " ".join(str(category.get(key) or "") for key in ("code", "name", "description", "target")),
                    "metadata": {"critical": bool(category.get("critical", False)), "workflowStepCodes": category.get("workflowStepCodes", [])},
                })
    if not collection_filter or collection_filter in {"workflowSteps", "workflow_steps", "legal_workflow_steps"}:
        for step in legal.get("workflowSteps", []):
            if isinstance(step, dict) and step.get("code"):
                candidates.append({
                    "entityType": "legal_workflow_step",
                    "entityId": str(step["code"]),
                    "label": step.get("name") or step["code"],
                    "text": " ".join(str(step.get(key) or "") for key in ("code", "name", "description", "rite", "stepType")),
                    "metadata": {"rite": step.get("rite"), "order": step.get("order")},
                })
    return candidates


def lexical_similarity(query: str, text: str) -> float:
    query_tokens = set(tokenize_text(query))
    text_tokens = set(tokenize_text(text))
    if not query_tokens or not text_tokens:
        return 0.0
    overlap = len(query_tokens & text_tokens)
    union = len(query_tokens | text_tokens)
    return overlap / max(1, union)


def tokenize_text(value: str) -> list[str]:
    return re.findall(r"[A-Za-zÀ-ÿ0-9_]+", str(value).lower())


def request_embedding_reindex(profile_id: str | None = None, requested_by: str | None = None, reason: str | None = None, confirm: bool = False) -> dict[str, Any]:
    if not confirm:
        return {
            "status": "requires_confirmation",
            "message": "Reindexação de embeddings exige confirm=true.",
            "profileId": profile_id,
        }
    profiles = embedding_profiles()
    active_profile_id = profiles.get("activeProfileId")
    effective_profile_id = profile_id or active_profile_id
    if not effective_profile_id:
        return {"status": "empty", "message": "Nenhum perfil de embedding configurado.", "profileId": None}
    job_raw = json.dumps({"profileId": effective_profile_id, "requestedBy": requested_by, "reason": reason, "projectHash": runtime_manifest.get("projectHash")}, sort_keys=True, ensure_ascii=False)
    job_id = "embedding-reindex-" + hashlib.sha256(job_raw.encode("utf-8")).hexdigest()[:12]
    return {
        "status": "queued",
        "jobId": job_id,
        "profileId": effective_profile_id,
        "requestedBy": requested_by,
        "reason": reason,
        "mode": "external_worker_required",
        "message": "Runtime registrou a intenção; a geração vetorial pesada deve ser executada por worker dedicado.",
    }


def semantic_similarity_from_payload(payload: dict[str, Any]) -> float | None:
    for key in ("semanticSimilarity", "semantic_similarity", "semantic_score", "score_semantico"):
        value = as_float(payload.get(key))
        if value is not None:
            return value
    return None


def as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(numeric) or math.isinf(numeric):
        return None
    return round(numeric, 6)


def evaluate_records(records: list[dict[str, Any]], labels: list[Any] | None = None) -> dict[str, Any]:
    return evaluate_model_records(active_model(), records, labels)


def evaluate_model_records(model: dict[str, Any], records: list[dict[str, Any]], labels: list[Any] | None = None) -> dict[str, Any]:
    problem = project["problem"]
    target = problem.get("target")
    prepared: list[tuple[dict[str, Any], Any]] = []
    labels = labels or []
    if labels and len(labels) != len(records):
        return {
            "status": "error",
            "message": "labels deve ter o mesmo tamanho de records.",
            "record_count": len(records),
            "label_count": len(labels),
            "model_version_id": model["id"],
            "primary_metric": project["metrics"]["primary"],
            "metrics": {},
            "sample": [],
        }
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            continue
        actual = labels[index] if labels else record.get(target)
        if actual is None or str(actual).strip() == "":
            continue
        prepared.append((record, actual))

    outputs = [predict_with_model(record, model) for record, _actual in prepared]
    predictions = [output.get("prediction") for output in outputs]
    actuals = [actual for _record, actual in prepared]
    if problem["type"] == "regression":
        numeric_pairs = [
            (float(actual), float(prediction))
            for actual, prediction in zip(actuals, predictions)
            if is_number_like(actual) and is_number_like(prediction)
        ]
        metrics = regression_metrics([actual for actual, _prediction in numeric_pairs], [prediction for _actual, prediction in numeric_pairs])
    else:
        actual_labels = [str(actual) for actual in actuals]
        predicted_labels = [str(prediction) for prediction in predictions]
        known_labels = sorted(set(problem.get("classes") or []) | set(actual_labels) | set(predicted_labels))
        probability_rows = [
            output.get("probabilities") if isinstance(output.get("probabilities"), dict) else {}
            for output in outputs
        ]
        metrics = {
            **classification_metrics(actual_labels, predicted_labels, known_labels, probability_rows),
            **classification_operational_metrics(outputs),
        }

    return {
        "status": "ok",
        "model_version_id": model["id"],
        "record_count": len(records),
        "label_count": len(prepared),
        "primary_metric": project["metrics"]["primary"],
        "metrics": metrics,
        "sample": [
            {
                "actual": actuals[index],
                "prediction": predictions[index],
                "input": mask_payload_without_target(prepared[index][0]),
                "inference_source": outputs[index].get("inference_source"),
            }
            for index in range(min(10, len(prepared)))
        ],
    }


def backtest_records(
    records: list[dict[str, Any]],
    labels: list[Any] | None = None,
    model_ids: list[str] | None = None,
    baseline_model_id: str | None = None,
    neutral_band: float = 0.0,
) -> dict[str, Any]:
    catalog = model_catalog()
    selected_ids = set(model_ids or [])
    selected_models = [model for model in catalog if not selected_ids or model["id"] in selected_ids]
    if not selected_models:
        selected_models = [active_model()]

    baseline = next((model for model in selected_models if model["id"] == baseline_model_id), None)
    if baseline is None:
        baseline = next((model for model in selected_models if model["id"] == active_model()["id"]), selected_models[0])
    if baseline["id"] not in {model["id"] for model in selected_models}:
        selected_models = [baseline, *selected_models]

    evaluations = [evaluate_model_records(model, records, labels) for model in selected_models]
    by_model = {item["model_version_id"]: item for item in evaluations}
    primary_metric = project["metrics"]["primary"]
    baseline_result = by_model.get(baseline["id"], evaluations[0])
    baseline_value = numeric_metric_value(baseline_result.get("metrics", {}), primary_metric)
    minimize = metric_should_minimize(primary_metric)
    evidence = [
        model_comparison_evidence(model, by_model.get(model["id"], {}), baseline["id"], baseline_value, primary_metric, minimize, neutral_band)
        for model in selected_models
    ]
    candidate_evidence = [item for item in evidence if item["model_id"] != baseline["id"]]
    failed = [item for item in candidate_evidence if item["status"] == "fail"]
    passed = [item for item in candidate_evidence if item["status"] == "pass"]
    recommendation = "reject" if failed else "approve" if passed else "review"
    return {
        "status": "ok",
        "kind": "backtest_result",
        "baseline_model_id": baseline["id"],
        "candidate_model_ids": [model["id"] for model in selected_models if model["id"] != baseline["id"]],
        "record_count": len(records),
        "label_count": max((item.get("label_count", 0) for item in evaluations), default=0),
        "primary_metric": primary_metric,
        "direction": "minimize" if minimize else "maximize",
        "recommendation": recommendation,
        "metrics": {
            "baseline_model_id": baseline["id"],
            "primary_metric": primary_metric,
            "models": {model_id: result.get("metrics", {}) for model_id, result in by_model.items()},
        },
        "models": evaluations,
        "evidence": evidence,
    }


def numeric_metric_value(metrics: dict[str, Any], metric_name: str) -> float | None:
    value = metrics.get(metric_name)
    if is_number_like(value):
        return float(value)
    return None


def metric_should_minimize(metric_name: str) -> bool:
    return metric_name in {"rmse", "mae", "log_loss", "latency_p95_ms", "error_rate", "drift_score"}


def model_comparison_evidence(
    model: dict[str, Any],
    result: dict[str, Any],
    baseline_model_id: str,
    baseline_value: float | None,
    primary_metric: str,
    minimize: bool,
    neutral_band: float,
) -> dict[str, Any]:
    value = numeric_metric_value(result.get("metrics", {}), primary_metric)
    if model["id"] == baseline_model_id:
        return {
            "model_id": model["id"],
            "label": model.get("label", model["id"]),
            "metric": primary_metric,
            "value": value,
            "baseline_value": baseline_value,
            "delta": 0.0,
            "status": "neutral",
            "color": "neutral",
            "reason": "Modelo usado como baseline do backtest.",
        }
    if value is None or baseline_value is None:
        return {
            "model_id": model["id"],
            "label": model.get("label", model["id"]),
            "metric": primary_metric,
            "value": value,
            "baseline_value": baseline_value,
            "delta": None,
            "status": "neutral",
            "color": "neutral",
            "reason": "Métrica primária indisponível para comparação objetiva.",
        }
    delta = baseline_value - value if minimize else value - baseline_value
    if abs(delta) <= float(neutral_band or 0):
        status, color, reason = "neutral", "neutral", "Variação dentro do threshold neutro."
    elif delta > 0:
        status, color, reason = "pass", "green", "Candidato melhor que o baseline na métrica primária."
    else:
        status, color, reason = "fail", "red", "Candidato pior que o baseline na métrica primária."
    return {
        "model_id": model["id"],
        "label": model.get("label", model["id"]),
        "metric": primary_metric,
        "value": value,
        "baseline_value": baseline_value,
        "delta": round(delta, 6),
        "status": status,
        "color": color,
        "reason": reason,
    }


def calculate_drift(
    reference_records: list[dict[str, Any]],
    current_records: list[dict[str, Any]],
    feature_keys: list[str] | None = None,
    warning_threshold: float = 0.2,
    alert_threshold: float = 0.5,
) -> dict[str, Any]:
    reference = [record for record in reference_records if isinstance(record, dict)]
    current = [record for record in current_records if isinstance(record, dict)]
    features = feature_keys or infer_drift_features(reference, current)
    feature_results = [drift_for_feature(feature, reference, current) for feature in features]
    feature_results = [item for item in feature_results if item is not None]
    drift_score = max([item["score"] for item in feature_results], default=0.0)
    status = "alert" if drift_score >= alert_threshold else "warning" if drift_score >= warning_threshold else "ok"
    color = "red" if status == "alert" else "neutral" if status == "warning" else "green"
    return {
        "status": status,
        "color": color,
        "drift_score": round(float(drift_score), 6),
        "reference_count": len(reference),
        "current_count": len(current),
        "feature_count": len(feature_results),
        "thresholds": {"warning": warning_threshold, "alert": alert_threshold},
        "features": feature_results,
        "message": "Drift básico calculado por diferença estatística simples entre referência e amostra atual.",
    }


def infer_drift_features(reference: list[dict[str, Any]], current: list[dict[str, Any]]) -> list[str]:
    sensitive_fields = set(project.get("sensitiveFields", []))
    target = project["problem"].get("target")
    keys: set[str] = set()
    for record in reference + current:
        keys.update(str(key) for key in record.keys())
    return sorted(key for key in keys if key != target and key not in sensitive_fields)


def drift_for_feature(feature: str, reference: list[dict[str, Any]], current: list[dict[str, Any]]) -> dict[str, Any] | None:
    reference_values = [record.get(feature) for record in reference if record.get(feature) is not None and record.get(feature) != ""]
    current_values = [record.get(feature) for record in current if record.get(feature) is not None and record.get(feature) != ""]
    if not reference_values or not current_values:
        return None
    if numeric_coverage(reference_values) >= 0.8 and numeric_coverage(current_values) >= 0.8:
        score, details = numeric_drift_score(reference_values, current_values)
        kind = "numeric"
        method = "numeric_mean_shift"
    else:
        score, details = categorical_drift_score(reference_values, current_values)
        kind = "categorical"
        method = "categorical_distribution_shift"
    status = "alert" if score >= 0.5 else "warning" if score >= 0.2 else "ok"
    return {
        "feature": feature,
        "kind": kind,
        "method": method,
        "score": round(float(score), 6),
        "status": status,
        **details,
    }


def numeric_coverage(values: list[Any]) -> float:
    return sum(1 for value in values if is_number_like(value)) / max(1, len(values))


def numeric_drift_score(reference_values: list[Any], current_values: list[Any]) -> tuple[float, dict[str, Any]]:
    reference = [float(value) for value in reference_values if is_number_like(value)]
    current = [float(value) for value in current_values if is_number_like(value)]
    if not reference or not current:
        return 0.0, {}
    reference_mean = sum(reference) / len(reference)
    current_mean = sum(current) / len(current)
    reference_variance = sum((value - reference_mean) ** 2 for value in reference) / max(1, len(reference))
    reference_std = math.sqrt(reference_variance)
    if reference_std <= 1e-9:
        score = 0.0 if abs(current_mean - reference_mean) <= 1e-9 else 1.0
    else:
        score = min(1.0, abs(current_mean - reference_mean) / (3 * reference_std))
    return score, {
        "reference_mean": round(reference_mean, 6),
        "current_mean": round(current_mean, 6),
        "reference_std": round(reference_std, 6),
    }


def categorical_drift_score(reference_values: list[Any], current_values: list[Any]) -> tuple[float, dict[str, Any]]:
    reference_counts = value_counts(reference_values)
    current_counts = value_counts(current_values)
    labels = sorted(set(reference_counts) | set(current_counts))
    reference_total = sum(reference_counts.values()) or 1
    current_total = sum(current_counts.values()) or 1
    score = sum(abs(reference_counts.get(label, 0) / reference_total - current_counts.get(label, 0) / current_total) for label in labels) / 2
    return score, {
        "reference_top": top_distribution(reference_counts, reference_total),
        "current_top": top_distribution(current_counts, current_total),
    }


def value_counts(values: list[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        key = str(value)
        counts[key] = counts.get(key, 0) + 1
    return counts


def top_distribution(counts: dict[str, int], total: int) -> list[dict[str, Any]]:
    return [
        {"value": value, "share": round(count / max(1, total), 6)}
        for value, count in sorted(counts.items(), key=lambda item: item[1], reverse=True)[:5]
    ]


def predict_from_artifact(
    artifact: dict[str, Any] | None,
    payload: dict[str, Any],
    problem: dict[str, Any],
    trace: list[dict[str, Any]],
    model: dict[str, Any],
) -> dict[str, Any] | None:
    if not artifact:
        return None
    artifact_type = artifact.get("type")
    if artifact_type == "sklearn_text_classifier":
        estimator = load_pickle_estimator(artifact)
        if estimator is None:
            return None
        text = text_from_payload(payload)
        try:
            prediction = str(estimator.predict([text])[0])
            probabilities = sklearn_probabilities(estimator, [text])
        except Exception:
            return None
        confidence = probabilities.get(prediction)
        return {
            "prediction": prediction,
            "model_version_id": model["id"],
            "confidence": round(float(confidence), 6) if confidence is not None else None,
            "probabilities": probabilities,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "sklearn_regressor":
        estimator = load_pickle_estimator(artifact)
        if estimator is None:
            return None
        try:
            prediction = float(estimator.predict([feature_dict_from_payload(payload)])[0])
        except Exception:
            return None
        return {
            "prediction": round(prediction, 6),
            "model_version_id": model["id"],
            "confidence": None,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "sentence_transformers_text_classifier":
        estimator = load_pickle_estimator(artifact)
        if estimator is None:
            return None
        try:
            matrix = sentence_transformer_matrix(artifact, [payload])
            prediction = str(estimator.predict(matrix)[0])
            probabilities = class_probabilities(estimator, matrix, artifact_classes(artifact))
        except Exception:
            return None
        confidence = probabilities.get(prediction)
        return {
            "prediction": prediction,
            "model_version_id": model["id"],
            "confidence": round(float(confidence), 6) if confidence is not None else None,
            "probabilities": probabilities,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "sentence_transformers_regressor":
        estimator = load_pickle_estimator(artifact)
        if estimator is None:
            return None
        try:
            matrix = sentence_transformer_matrix(artifact, [payload])
            prediction = float(estimator.predict(matrix)[0])
        except Exception:
            return None
        return {
            "prediction": round(prediction, 6),
            "model_version_id": model["id"],
            "confidence": None,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "xgboost_text_classifier":
        estimator = load_pickle_estimator(artifact)
        vectorizer = load_pickle_value(artifact, "vectorizerBase64")
        classes = artifact_classes(artifact)
        if estimator is None or vectorizer is None or not classes:
            return None
        text = text_from_payload(payload)
        try:
            matrix = vectorizer.transform([text])
            encoded_prediction = estimator.predict(matrix)[0]
            prediction = class_from_encoded_prediction(encoded_prediction, classes)
            probabilities = class_probabilities(estimator, matrix, classes)
        except Exception:
            return None
        confidence = probabilities.get(prediction)
        return {
            "prediction": prediction,
            "model_version_id": model["id"],
            "confidence": round(float(confidence), 6) if confidence is not None else None,
            "probabilities": probabilities,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "xgboost_regressor":
        estimator = load_pickle_estimator(artifact)
        vectorizer = load_pickle_value(artifact, "vectorizerBase64")
        if estimator is None or vectorizer is None:
            return None
        try:
            matrix = vectorizer.transform([feature_dict_from_payload(payload)])
            prediction = float(estimator.predict(matrix)[0])
        except Exception:
            return None
        return {
            "prediction": round(prediction, 6),
            "model_version_id": model["id"],
            "confidence": None,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "standard_lib_text_naive_bayes":
        model_payload = artifact.get("model")
        if not isinstance(model_payload, dict):
            return None
        prediction, probabilities = predict_text_naive_bayes(model_payload, payload)
        confidence = probabilities.get(prediction)
        return {
            "prediction": prediction,
            "model_version_id": model["id"],
            "confidence": round(float(confidence), 6) if confidence is not None else None,
            "probabilities": probabilities,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "mean_regressor":
        value = artifact.get("mean")
        if not isinstance(value, (int, float)):
            return None
        return {
            "prediction": round(float(value), 6),
            "model_version_id": model["id"],
            "confidence": None,
            "trace": trace,
            "inference_source": "artifact",
        }
    return None


def load_pickle_estimator(artifact: dict[str, Any]) -> Any | None:
    return load_pickle_value(artifact, "modelBase64")


def sentence_transformer_matrix(artifact: dict[str, Any], payloads: list[dict[str, Any]]) -> Any:
    model_name = str(artifact.get("embeddingModel") or "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
    model = load_sentence_transformer_model(model_name)
    texts = [text_from_payload(payload) for payload in payloads]
    return model.encode(
        texts,
        batch_size=32,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=bool(artifact.get("normalizeEmbeddings", True)),
    )


def load_sentence_transformer_model(model_name: str) -> Any:
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:
        raise RuntimeError("sentence-transformers não está instalado no runtime.") from exc
    return SentenceTransformer(model_name)


def load_pickle_value(artifact: dict[str, Any], key: str) -> Any | None:
    if artifact.get("format") != "pickle_base64":
        return None
    raw = artifact.get(key)
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return pickle.loads(base64.b64decode(raw.encode("ascii")))
    except Exception:
        return None


def artifact_classes(artifact: dict[str, Any]) -> list[str]:
    classes = artifact.get("classes")
    if not isinstance(classes, list):
        return []
    return [str(item) for item in classes]


def class_from_encoded_prediction(value: Any, classes: list[str]) -> str:
    try:
        index = int(value)
    except (TypeError, ValueError):
        return str(value)
    if 0 <= index < len(classes):
        return classes[index]
    return str(value)


def class_probabilities(estimator: Any, inputs: Any, classes: list[str]) -> dict[str, float]:
    if not hasattr(estimator, "predict_proba"):
        return {}
    try:
        probabilities = estimator.predict_proba(inputs)[0]
    except Exception:
        return {}
    return {label: round(float(value), 6) for label, value in zip(classes, probabilities)}


def sklearn_probabilities(estimator: Any, inputs: list[Any]) -> dict[str, float]:
    if not hasattr(estimator, "predict_proba"):
        return {}
    try:
        probabilities = estimator.predict_proba(inputs)[0]
        classes = [str(item) for item in getattr(estimator, "classes_", [])]
    except Exception:
        return {}
    return {label: round(float(value), 6) for label, value in zip(classes, probabilities)}


def predict_text_naive_bayes(model_payload: dict[str, Any], payload: dict[str, Any]) -> tuple[str, dict[str, float]]:
    class_counts = {str(label): int(count) for label, count in model_payload.get("classCounts", {}).items()}
    token_counts = {
        str(label): {str(token): int(count) for token, count in counts.items()}
        for label, counts in model_payload.get("tokenCounts", {}).items()
        if isinstance(counts, dict)
    }
    total_tokens = {str(label): int(count) for label, count in model_payload.get("totalTokens", {}).items()}
    vocabulary = [str(item) for item in model_payload.get("vocabulary", [])]
    if not class_counts:
        classes = project["problem"].get("classes") or ["classe_a", "classe_b"]
        return str(classes[0]), {str(item): round(1 / len(classes), 6) for item in classes}

    vocab_size = max(1, len(vocabulary))
    total_rows = max(1, sum(class_counts.values()))
    tokens = tokenize_payload(payload)
    scores: dict[str, float] = {}
    for label, count in class_counts.items():
        score = math.log(count / total_rows)
        denominator = total_tokens.get(label, 0) + vocab_size
        for token in tokens:
            score += math.log((token_counts.get(label, {}).get(token, 0) + 1) / denominator)
        scores[label] = score
    prediction = max(scores.items(), key=lambda item: item[1])[0]
    return prediction, softmax_scores(scores)


def tokenize_payload(payload: dict[str, Any]) -> list[str]:
    return re.findall(r"[A-Za-zÀ-ÿ0-9_]+", text_from_payload(payload).lower())


def text_from_payload(payload: dict[str, Any]) -> str:
    sensitive_fields = set(project.get("sensitiveFields", []))
    target = project["problem"].get("target")
    return " ".join(
        str(value)
        for key, value in payload.items()
        if key != target and key not in sensitive_fields and value is not None
    )


def feature_dict_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    sensitive_fields = set(project.get("sensitiveFields", []))
    target = project["problem"].get("target")
    features: dict[str, Any] = {}
    for key, value in payload.items():
        if key == target or key in sensitive_fields or value is None or value == "":
            continue
        features[key] = parse_feature_value(value)
    return features


def mask_payload_without_target(payload: dict[str, Any]) -> dict[str, Any]:
    sensitive_fields = set(project.get("sensitiveFields", []))
    target = project["problem"].get("target")
    masked: dict[str, Any] = {}
    for key, value in payload.items():
        if key == target:
            continue
        masked[key] = "***" if key in sensitive_fields else value
    return masked


def is_number_like(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def classification_metrics(actuals: list[str], predictions: list[str], labels: list[str], probability_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    total = max(1, len(actuals))
    accuracy = sum(1 for actual, prediction in zip(actuals, predictions) if actual == prediction) / total
    per_label: dict[str, dict[str, Any]] = {}
    f1_values = []
    weighted_sum = 0.0
    for label in labels:
        tp = sum(1 for actual, prediction in zip(actuals, predictions) if actual == label and prediction == label)
        fp = sum(1 for actual, prediction in zip(actuals, predictions) if actual != label and prediction == label)
        fn = sum(1 for actual, prediction in zip(actuals, predictions) if actual == label and prediction != label)
        support = sum(1 for actual in actuals if actual == label)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_label[label] = {"precision": round(precision, 6), "recall": round(recall, 6), "f1": round(f1, 6), "support": support}
        if support:
            f1_values.append(f1)
            weighted_sum += f1 * support
    matrix = [[sum(1 for actual, prediction in zip(actuals, predictions) if actual == left and prediction == right) for right in labels] for left in labels]
    probabilities = normalize_probability_rows(probability_rows or [], labels, predictions)
    return {
        "accuracy": round(accuracy, 6),
        "f1_macro": round(sum(f1_values) / len(f1_values), 6) if f1_values else 0.0,
        "f1_weighted": round(weighted_sum / total, 6),
        "precision_macro": round(sum(item["precision"] for item in per_label.values()) / max(1, len(per_label)), 6),
        "recall_macro": round(sum(item["recall"] for item in per_label.values()) / max(1, len(per_label)), 6),
        "top_3_accuracy": top_k_accuracy(actuals, probabilities, 3),
        "top_5_accuracy": top_k_accuracy(actuals, probabilities, 5),
        "brier_score": brier_score(actuals, probabilities, labels),
        "expected_calibration_error": expected_calibration_error(actuals, predictions, probabilities),
        "roc_auc_ovr": roc_auc_ovr(actuals, probabilities, labels),
        "pr_auc_macro": pr_auc_macro(actuals, probabilities, labels),
        "semantic_recall_at_5": top_k_accuracy(actuals, probabilities, 5),
        "labels": labels,
        "per_label": per_label,
        "confusion_matrix": matrix,
    }


def normalize_probability_rows(probability_rows: list[dict[str, Any]], labels: list[str], predictions: list[str]) -> list[dict[str, float]]:
    normalized_rows: list[dict[str, float]] = []
    for index, prediction in enumerate(predictions):
        source = probability_rows[index] if index < len(probability_rows) and isinstance(probability_rows[index], dict) else {}
        row: dict[str, float] = {}
        for label in labels:
            value = as_probability(source.get(label))
            row[label] = value if value is not None else 0.0
        if prediction and sum(row.values()) <= 0:
            row[prediction] = 1.0
        normalized_rows.append(row)
    return normalized_rows


def top_k_accuracy(actuals: list[str], probability_rows: list[dict[str, float]], k: int) -> float:
    if not actuals:
        return 0.0
    hits = 0
    for actual, probabilities in zip(actuals, probability_rows):
        top_labels = [label for label, _score in sorted(probabilities.items(), key=lambda item: item[1], reverse=True)[:k]]
        if actual in top_labels:
            hits += 1
    return round(hits / max(1, len(actuals)), 6)


def brier_score(actuals: list[str], probability_rows: list[dict[str, float]], labels: list[str]) -> float:
    if not actuals:
        return 0.0
    total = 0.0
    for actual, probabilities in zip(actuals, probability_rows):
        total += sum((float(probabilities.get(label, 0.0)) - (1.0 if actual == label else 0.0)) ** 2 for label in labels)
    return round(total / max(1, len(actuals)), 6)


def expected_calibration_error(actuals: list[str], predictions: list[str], probability_rows: list[dict[str, float]], bins: int = 10) -> float:
    if not actuals:
        return 0.0
    ece = 0.0
    total = len(actuals)
    for bucket in range(bins):
        lower = bucket / bins
        upper = (bucket + 1) / bins
        indexes = []
        for index, probabilities in enumerate(probability_rows):
            confidence = max(probabilities.values(), default=0.0)
            if (bucket == 0 and confidence >= lower and confidence <= upper) or (confidence > lower and confidence <= upper):
                indexes.append(index)
        if not indexes:
            continue
        accuracy = sum(1 for index in indexes if actuals[index] == predictions[index]) / len(indexes)
        confidence_mean = sum(max(probability_rows[index].values(), default=0.0) for index in indexes) / len(indexes)
        ece += (len(indexes) / total) * abs(accuracy - confidence_mean)
    return round(ece, 6)


def roc_auc_ovr(actuals: list[str], probability_rows: list[dict[str, float]], labels: list[str]) -> float | None:
    auc_values = []
    for label in labels:
        scores = [row.get(label, 0.0) for row in probability_rows]
        auc = binary_roc_auc([actual == label for actual in actuals], scores)
        if auc is not None:
            auc_values.append(auc)
    return round(sum(auc_values) / len(auc_values), 6) if auc_values else None


def binary_roc_auc(positives: list[bool], scores: list[float]) -> float | None:
    positive_scores = [score for is_positive, score in zip(positives, scores) if is_positive]
    negative_scores = [score for is_positive, score in zip(positives, scores) if not is_positive]
    if not positive_scores or not negative_scores:
        return None
    wins = 0.0
    for positive_score in positive_scores:
        for negative_score in negative_scores:
            if positive_score > negative_score:
                wins += 1.0
            elif positive_score == negative_score:
                wins += 0.5
    return wins / (len(positive_scores) * len(negative_scores))


def pr_auc_macro(actuals: list[str], probability_rows: list[dict[str, float]], labels: list[str]) -> float | None:
    values = []
    for label in labels:
        value = average_precision([actual == label for actual in actuals], [row.get(label, 0.0) for row in probability_rows])
        if value is not None:
            values.append(value)
    return round(sum(values) / len(values), 6) if values else None


def average_precision(positives: list[bool], scores: list[float]) -> float | None:
    total_positives = sum(1 for item in positives if item)
    if total_positives <= 0:
        return None
    ranked = sorted(zip(scores, positives), key=lambda item: item[0], reverse=True)
    hits = 0
    precision_sum = 0.0
    for index, (_score, is_positive) in enumerate(ranked, start=1):
        if is_positive:
            hits += 1
            precision_sum += hits / index
    return precision_sum / total_positives


def classification_operational_metrics(outputs: list[dict[str, Any]]) -> dict[str, float]:
    total = max(1, len(outputs))
    low_confidence = 0
    human_review = 0
    llm_review = 0
    workflow_blocked = 0
    for output in outputs:
        review = output.get("review", {}) if isinstance(output.get("review"), dict) else {}
        reasons = review.get("reasons", []) if isinstance(review.get("reasons"), list) else []
        if "low_confidence" in reasons:
            low_confidence += 1
        if bool(review.get("humanReviewRequired", False)):
            human_review += 1
        explanation = output.get("explanation", {}) if isinstance(output.get("explanation"), dict) else {}
        llm = explanation.get("llm", {}) if isinstance(explanation.get("llm"), dict) else {}
        if bool(output.get("decision", {}).get("llmReviewRecommended", False)) or bool(llm.get("recommended", False)):
            llm_review += 1
        workflow = explanation.get("workflow", {}) if isinstance(explanation.get("workflow"), dict) else {}
        if workflow.get("status") == "blocked" or "workflow_blocked" in reasons:
            workflow_blocked += 1
    return {
        "low_confidence_rate": round(low_confidence / total, 6),
        "human_review_rate": round(human_review / total, 6),
        "llm_review_rate": round(llm_review / total, 6),
        "invalid_workflow_transition_rate": round(workflow_blocked / total, 6),
    }


def as_probability(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(numeric) or math.isinf(numeric):
        return None
    return max(0.0, min(1.0, round(numeric, 6)))


def regression_metrics(actuals: list[float], predictions: list[float]) -> dict[str, float]:
    total = max(1, len(actuals))
    if not actuals:
        return {"mae": 0.0, "rmse": 0.0, "r2": 0.0}
    errors = [prediction - actual for actual, prediction in zip(actuals, predictions)]
    mae = sum(abs(error) for error in errors) / total
    rmse = math.sqrt(sum(error * error for error in errors) / total)
    mean_actual = sum(actuals) / total
    ss_tot = sum((actual - mean_actual) ** 2 for actual in actuals)
    ss_res = sum(error * error for error in errors)
    r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
    return {"mae": round(mae, 6), "rmse": round(rmse, 6), "r2": round(r2, 6)}


def parse_feature_value(value: Any) -> Any:
    if isinstance(value, (int, float, bool)):
        return value
    try:
        return float(str(value).replace(",", "."))
    except ValueError:
        return str(value)


def softmax_scores(scores: dict[str, float]) -> dict[str, float]:
    max_score = max(scores.values())
    exps = {label: math.exp(score - max_score) for label, score in scores.items()}
    total = sum(exps.values()) or 1.0
    return {label: round(value / total, 6) for label, value in exps.items()}


def synthetic_predict_payload(payload: dict[str, Any], model: dict[str, Any], problem: dict[str, Any], trace: list[dict[str, Any]]) -> dict[str, Any]:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    digest = int(hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12], 16)
    if problem["type"] == "regression":
        value = round((digest % 100000) / 1000, 4)
        return {"prediction": value, "model_version_id": model["id"], "confidence": None, "trace": trace, "inference_source": "synthetic"}

    classes = problem.get("classes") or ["classe_a", "classe_b"]
    prediction = classes[digest % len(classes)]
    score = round(0.55 + (digest % 4500) / 10000, 4)
    remaining = round(max(0.0, 1.0 - score), 4)
    probabilities = {item: round(remaining / max(1, len(classes) - 1), 4) for item in classes}
    probabilities[prediction] = score
    return {"prediction": prediction, "model_version_id": model["id"], "confidence": score, "probabilities": probabilities, "trace": trace, "inference_source": "synthetic"}


def promotion_status() -> dict[str, Any]:
    policy = project.get("promotionPolicy", {})
    active = active_model()
    if latest_training_result:
        evidence = latest_training_result.get("promotionEvidence", [])
        failed_blockers = [
            item for item in evidence
            if isinstance(item, dict) and item.get("status") == "fail" and item.get("severity", "block") == "block"
        ]
        failed_reviews = [
            item for item in evidence
            if isinstance(item, dict) and item.get("status") == "fail" and item.get("severity", "block") != "block"
        ]
        return {
            "mode": policy.get("mode", "manual_approval"),
            "recommendation": "reject" if failed_blockers else "review" if failed_reviews else "approve",
            "applied": False,
            "active_model": active,
            "candidate_model_id": latest_training_result.get("bestModelId"),
            "latest_training_run_id": latest_training_result.get("runId"),
            "primary_metric": latest_training_result.get("primaryMetric") or project["metrics"]["primary"],
            "evidence": evidence,
        }
    metrics = active.get("metrics", {})
    evidence = []
    for rule in flatten_rules(policy.get("rules", [])):
        if rule.get("kind", "metric") != "metric":
            evidence.append({"ruleId": rule.get("id"), "label": rule.get("label"), "status": "neutral", "color": "neutral", "reason": "Regra Python exige execução em sandbox para evidência completa."})
            continue
        metric_name = rule.get("left", {}).get("metric")
        value = metrics.get(metric_name)
        expected = rule.get("value")
        operator = rule.get("operator")
        status, color, reason = evaluate_rule(metric_name, value, operator, expected, rule.get("neutralBand", 0))
        evidence.append({"ruleId": rule.get("id"), "label": rule.get("label"), "metric": metric_name, "value": value, "operator": operator, "expected": expected, "status": status, "color": color, "reason": reason, "severity": rule.get("severity", "block")})
    failed = [item for item in evidence if item["status"] == "fail" and item.get("severity") == "block"]
    return {
        "mode": policy.get("mode", "manual_approval"),
        "recommendation": "reject" if failed else "approve",
        "applied": False,
        "active_model": active,
        "evidence": evidence,
    }


def flatten_rules(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat = []
    for rule in rules:
        if rule.get("kind") == "group":
            flat.extend(flatten_rules(rule.get("rules", [])))
        else:
            flat.append(rule)
    return flat


def evaluate_rule(metric_name: str, value: Any, operator: str, expected: Any, neutral_band: float) -> tuple[str, str, str]:
    if value is None:
        return "neutral", "neutral", f"Métrica {metric_name} ainda não está disponível."
    try:
        numeric_value = float(value)
        numeric_expected = float(expected)
    except (TypeError, ValueError):
        passed = value == expected if operator == "eq" else value != expected
        return ("pass", "green", "Valor discreto atende a regra.") if passed else ("fail", "red", "Valor discreto viola a regra.")

    delta = numeric_value - numeric_expected
    if abs(delta) <= float(neutral_band or 0):
        return "neutral", "neutral", "Variação dentro do threshold neutro."
    if operator in {"gt", "gte"}:
        passed = numeric_value > numeric_expected if operator == "gt" else numeric_value >= numeric_expected
    elif operator in {"lt", "lte"}:
        passed = numeric_value < numeric_expected if operator == "lt" else numeric_value <= numeric_expected
    elif operator == "eq":
        passed = numeric_value == numeric_expected
    else:
        passed = delta >= 0
    return ("pass", "green", "Evidência melhor que o limiar.") if passed else ("fail", "red", "Evidência pior que o limiar.")
`;
}

function renderDashboardPy(): string {
  return `from fastapi.responses import HTMLResponse


def dashboard_html() -> HTMLResponse:
    return HTMLResponse("""
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MLOps Runtime Dashboard</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #1f2937; }
    header { background: #111827; color: white; padding: 18px 24px; }
    main { padding: 20px 24px; display: grid; gap: 18px; }
    section { background: white; border: 1px solid #d8dee8; border-radius: 8px; padding: 16px; }
    h1 { margin: 0; font-size: 20px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .card { border: 1px solid #d8dee8; border-radius: 8px; padding: 12px; background: #fbfcfe; }
    .green { border-color: #22c55e; background: #ecfdf3; }
    .red { border-color: #ef4444; background: #fef2f2; }
    .neutral { border-color: #d8dee8; }
    code, pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      section, .card { background: #1f2937; border-color: #374151; }
      .green { background: #052e16; border-color: #22c55e; }
      .red { background: #450a0a; border-color: #ef4444; }
    }
  </style>
</head>
<body>
  <header><h1>MLOps Runtime Dashboard</h1></header>
  <main>
    <section><h2>Resumo</h2><div id="summary" class="grid"></div></section>
    <section><h2>Promoção</h2><div id="promotion" class="grid"></div></section>
    <section><h2>Métricas</h2><pre id="metrics">Carregando...</pre></section>
  </main>
  <script>
    async function getJson(path) {
      const response = await fetch(path);
      return response.json();
    }
    function card(label, value, className = "") {
      return '<div class="card ' + className + '"><strong>' + label + '</strong><br><code>' + value + '</code></div>';
    }
    async function load() {
      const [metadata, gpu, active, runtime, model, promotion, feedback, retraining, deployment] = await Promise.all([
        getJson('/metadata'), getJson('/environment/gpu'), getJson('/models/active'), getJson('/metrics/runtime'), getJson('/metrics/model'), getJson('/promotion/status'), getJson('/feedback/summary'), getJson('/retraining/status'), getJson('/deployment/status')
      ]);
      document.getElementById('summary').innerHTML =
        card('Projeto', metadata.project.name) +
        card('Modelo ativo', active.id) +
        card('Predições', runtime.prediction_count) +
        card('Feedbacks', feedback.feedback_count) +
        card('Acurácia feedback', feedback.feedback_accuracy === null ? 'n/d' : feedback.feedback_accuracy) +
        card('Retreinos pendentes', retraining.pending_count) +
        card('Deployment', deployment.mode) +
        card('Drift', runtime.drift_score) +
        card('Perfil', metadata.execution_profile) +
        card('Execução efetiva', gpu.summary.effectiveExecution);
      document.getElementById('promotion').innerHTML = promotion.evidence.map((item) =>
        card(item.label || item.ruleId || item.rule_id, (item.reason || '') + ' Valor: ' + item.value, item.color)
      ).join('');
      document.getElementById('metrics').textContent = JSON.stringify({ model, runtime, feedback, retraining, deployment, gpu }, null, 2);
    }
    load().catch((error) => { document.getElementById('metrics').textContent = String(error); });
  </script>
</body>
</html>
""")
`;
}

function renderMainPy(): string {
  return `from typing import Any
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from .dashboard import dashboard_html
from .db import init_db
from .environment import gpu_environment
from .repository import Timer, ab_testing_status, activate_embedding_profile, approve_retraining_request, check_database, complete_ab_test, complete_retraining_request, create_retraining_request, deployment_status, domain_metadata_summary, feedback_summary, latest_drift, promote_model_version, record_drift, record_evaluation, record_event, record_prediction, record_prediction_feedback, registered_model_version, register_embedding_profile, register_model_version, retraining_status, retraining_training_set, rollback_deployment, runtime_metrics, seed_domain_metadata, seed_training_metadata, start_ab_test, start_canary_deployment, start_shadow_deployment
from .runtime import active_model, backtest_records, calculate_drift, embedding_profiles, embedding_search, evaluate_records, latest_training_result, model_by_id, model_card, model_catalog, model_metrics, predict_payload, project, promotion_status, request_embedding_reindex, runtime_manifest
from .settings import settings


class PredictRequest(BaseModel):
    input: dict[str, Any] = Field(default_factory=dict)
    trace: bool = True


class FeedbackRequest(BaseModel):
    run_id: str
    row_id: str | None = None
    actual_label: Any
    correct: bool | None = None
    source: str = "operator"
    reviewer: str | None = None
    comment: str | None = None


class ModelRegistrationRequest(BaseModel):
    confirm: bool = False
    model_id: str
    algorithm: str | None = None
    artifact_uri: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    status: str | None = None
    activate: bool = False
    requested_by: str | None = None


class ModelPromotionRequest(BaseModel):
    confirm: bool = False
    approved_by: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)


class RetrainingRequest(BaseModel):
    trigger: str = "feedback_threshold"
    reason: str = "Feedback real disponível para retreino controlado."
    requested_by: str | None = None
    min_feedback_count: int = 1
    policy: dict[str, Any] = Field(default_factory=dict)


class RetrainingApprovalRequest(BaseModel):
    confirm: bool = False
    approved_by: str | None = None


class RetrainingCompletionRequest(BaseModel):
    confirm: bool = False
    completed_by: str | None = None
    success: bool = True
    job_id: str | None = None
    training_run_id: str | None = None
    model_id: str | None = None
    message: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)


class DeploymentShadowRequest(BaseModel):
    confirm: bool = False
    model_id: str
    requested_by: str | None = None
    reason: str | None = None


class DeploymentCanaryRequest(BaseModel):
    confirm: bool = False
    model_id: str
    traffic_percent: float = 10.0
    requested_by: str | None = None
    reason: str | None = None


class DeploymentRollbackRequest(BaseModel):
    confirm: bool = False
    requested_by: str | None = None
    reason: str | None = None


class ABTestStartRequest(BaseModel):
    confirm: bool = False
    candidate_model_id: str
    baseline_model_id: str | None = None
    traffic_split_percent: float = 50.0
    primary_metric: str | None = None
    requested_by: str | None = None
    reason: str | None = None
    guardrails: dict[str, Any] = Field(default_factory=dict)


class ABTestCompletionRequest(BaseModel):
    confirm: bool = False
    winner_model_id: str | None = None
    completed_by: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)


class EvaluateRequest(BaseModel):
    records: list[dict[str, Any]] = Field(default_factory=list)
    labels: list[Any] = Field(default_factory=list)


class BacktestRequest(BaseModel):
    records: list[dict[str, Any]] = Field(default_factory=list)
    labels: list[Any] = Field(default_factory=list)
    model_ids: list[str] = Field(default_factory=list)
    baseline_model_id: str | None = None
    neutral_band: float = 0.0


class DriftRequest(BaseModel):
    reference_records: list[dict[str, Any]] = Field(default_factory=list)
    current_records: list[dict[str, Any]] = Field(default_factory=list)
    records: list[dict[str, Any]] = Field(default_factory=list)
    feature_keys: list[str] = Field(default_factory=list)
    warning_threshold: float = 0.2
    alert_threshold: float = 0.5
    auto_retraining: bool = True
    retraining_min_feedback_count: int = 1
    requested_by: str | None = None


class EmbeddingSearchRequest(BaseModel):
    query: str = ""
    collection: str | None = None
    top_k: int = 5
    profile_id: str | None = None


class EmbeddingProfileRegistrationRequest(BaseModel):
    confirm: bool = False
    profile_id: str
    provider: str | None = None
    model_name: str | None = None
    model_version: str | None = None
    model_digest: str | None = None
    dimension: int | None = None
    similarity_metric: str | None = "cosine"
    preprocessing_version: str | None = None
    chunking_version: str | None = None
    vector_collections: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    requested_by: str | None = None


class EmbeddingProfileActivationRequest(BaseModel):
    confirm: bool = False
    requested_by: str | None = None
    reason: str | None = None


class EmbeddingReindexRequest(BaseModel):
    confirm: bool = False
    profile_id: str | None = None
    requested_by: str | None = None
    reason: str | None = None


app = FastAPI(title=settings.app_name, version=project["version"])


@app.on_event("startup")
def startup() -> None:
    init_db()
    domain_seed = seed_domain_metadata(project)
    training_seed = seed_training_metadata(latest_training_result, project, runtime_manifest)
    record_event("startup", "Runtime iniciado", {"project_id": project["id"], "version": project["version"], "domain_seed": domain_seed, "training_seed": training_seed})


@app.get("/health")
def health() -> dict[str, Any]:
    database = check_database()
    return {"status": "ok", "database": database, "active_model": active_model()["id"], "execution_profile": settings.execution_profile}


@app.get("/metadata")
def metadata() -> dict[str, Any]:
    return {
        "contract": runtime_manifest["contract"],
        "project": {"id": project["id"], "name": project["name"], "version": project["version"]},
        "problem": project["problem"],
        "domain": project.get("domain", {"kind": "generic"}),
        "active_model_id": active_model()["id"],
        "project_hash": runtime_manifest["projectHash"],
        "pipeline_hash": runtime_manifest["pipelineHash"],
        "execution_profile": settings.execution_profile,
        "persistence": runtime_manifest["persistence"],
        "mlflow_tracking_uri": settings.mlflow_tracking_uri,
        "endpoints": runtime_manifest["endpoints"],
    }


@app.get("/domain/legal")
def get_legal_domain() -> dict[str, Any]:
    return domain_metadata_summary(project)


@app.get("/embeddings/profiles")
def get_embedding_profiles() -> dict[str, Any]:
    return embedding_profiles()


@app.post("/embeddings/profiles/register")
def register_embedding_profile_endpoint(request: EmbeddingProfileRegistrationRequest) -> dict[str, Any]:
    try:
        return register_embedding_profile(
            request.profile_id,
            request.provider,
            request.model_name,
            request.model_version,
            request.model_digest,
            request.dimension,
            request.similarity_metric,
            request.preprocessing_version,
            request.chunking_version,
            request.vector_collections,
            request.metadata,
            request.requested_by,
            request.confirm,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/embeddings/profiles/{profile_id}/activate")
def activate_embedding_profile_endpoint(profile_id: str, request: EmbeddingProfileActivationRequest) -> dict[str, Any]:
    try:
        result = activate_embedding_profile(profile_id, request.requested_by, request.reason, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Perfil de embedding não encontrado.")
    return result


@app.post("/embeddings/search")
def search_embeddings(request: EmbeddingSearchRequest) -> dict[str, Any]:
    return embedding_search(request.query, request.collection, request.top_k, request.profile_id)


@app.post("/embeddings/reindex")
def reindex_embeddings(request: EmbeddingReindexRequest) -> dict[str, Any]:
    result = request_embedding_reindex(request.profile_id, request.requested_by, request.reason, request.confirm)
    if result.get("status") == "requires_confirmation":
        raise HTTPException(status_code=409, detail=result)
    record_event("embedding_reindex_requested", "Solicitação de reindexação de embeddings registrada", result)
    return result


@app.get("/environment/gpu")
def get_gpu_environment() -> dict[str, Any]:
    return gpu_environment()


@app.get("/model-card")
def get_model_card() -> dict[str, Any]:
    return model_card()


@app.get("/models")
def get_models() -> dict[str, Any]:
    return {"models": model_catalog()}


@app.get("/models/active")
def get_active_model() -> dict[str, Any]:
    return active_model()


@app.post("/models/register")
def register_model(request: ModelRegistrationRequest) -> dict[str, Any]:
    try:
        return register_model_version(
            request.model_id,
            request.algorithm,
            request.artifact_uri,
            request.metrics,
            request.status,
            request.activate,
            request.requested_by,
            request.confirm,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/models/{model_id}")
def get_model(model_id: str) -> dict[str, Any]:
    registered = registered_model_version(model_id)
    if registered:
        return {"registered": True, "model": registered}
    model = model_by_id(model_id)
    if model:
        return {"registered": False, "model": model}
    raise HTTPException(status_code=404, detail="Modelo não encontrado.")


@app.post("/models/{model_id}/promote")
def promote_model(model_id: str, request: ModelPromotionRequest) -> dict[str, Any]:
    try:
        result = promote_model_version(model_id, request.approved_by, request.evidence, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Modelo não encontrado no registry.")
    return result


@app.get("/metrics/model")
def get_model_metrics() -> dict[str, Any]:
    return model_metrics()


@app.get("/metrics/runtime")
def get_runtime_metrics() -> dict[str, Any]:
    return runtime_metrics(active_model()["id"])


@app.post("/predict")
def predict(request: PredictRequest) -> dict[str, Any]:
    with Timer() as timer:
        output = predict_payload(request.input)
    run_id = record_prediction(request.input, output, output["model_version_id"], timer.latency_ms, project.get("sensitiveFields", []), project)
    record_event("prediction_completed", "Predição executada no runtime", {"run_id": run_id, "model_version_id": output["model_version_id"], "inference_source": output.get("inference_source")})
    return {"run_id": run_id, "latency_ms": timer.latency_ms, **output}


@app.post("/feedback")
def feedback(request: FeedbackRequest) -> dict[str, Any]:
    result = record_prediction_feedback(
        request.run_id,
        request.row_id,
        request.actual_label,
        request.correct,
        request.source,
        request.reviewer,
        request.comment,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Predição não encontrada para feedback.")
    record_event("prediction_feedback_recorded", "Feedback de label real registrado", {"feedback_id": result["feedback_id"], "run_id": result["run_id"], "correct": result["correct"]})
    return result


@app.get("/feedback/summary")
def get_feedback_summary() -> dict[str, Any]:
    return feedback_summary(active_model()["id"])


@app.post("/retraining/requests")
def request_retraining(request: RetrainingRequest) -> dict[str, Any]:
    result = create_retraining_request(
        request.trigger,
        request.reason,
        request.requested_by,
        request.min_feedback_count,
        request.policy,
        active_model()["id"],
    )
    record_event("retraining_requested", "Solicitação de retreino controlado registrada", {"request_id": result["request_id"], "status": result["status"], "feedback_count": result["feedback_count"]})
    return result


@app.post("/retraining/requests/{request_id}/approve")
def approve_retraining(request_id: str, request: RetrainingApprovalRequest) -> dict[str, Any]:
    try:
        result = approve_retraining_request(request_id, request.approved_by, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Solicitação de retreino não encontrada.")
    record_event("retraining_approved", "Solicitação de retreino controlado aprovada", {"request_id": request_id, "approved_by": request.approved_by})
    return result


@app.get("/retraining/requests/{request_id}/training-set")
def get_retraining_training_set(request_id: str, limit: int = 1000) -> dict[str, Any]:
    result = retraining_training_set(request_id, project["problem"]["target"], limit)
    if result is None:
        raise HTTPException(status_code=404, detail="Solicitação de retreino não encontrada.")
    return result


@app.post("/retraining/requests/{request_id}/complete")
def complete_retraining(request_id: str, request: RetrainingCompletionRequest) -> dict[str, Any]:
    result_payload = {
        "job_id": request.job_id,
        "training_run_id": request.training_run_id,
        "model_id": request.model_id,
        "message": request.message,
        "metrics": request.metrics,
    }
    try:
        result = complete_retraining_request(request_id, request.completed_by, request.confirm, request.success, result_payload)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Solicitação de retreino não encontrada.")
    record_event("retraining_completed" if request.success else "retraining_failed", "Solicitação de retreino finalizada pelo Studio", {"request_id": request_id, "success": request.success, "training_run_id": request.training_run_id, "model_id": request.model_id})
    return result


@app.get("/retraining/status")
def get_retraining_status() -> dict[str, Any]:
    return retraining_status(active_model()["id"])


@app.post("/evaluate")
def evaluate(request: EvaluateRequest) -> dict[str, Any]:
    result = evaluate_records(request.records, request.labels)
    evaluation_id = record_evaluation(result)
    record_event("evaluation_completed", "Avaliação executada no runtime", {"evaluation_id": evaluation_id, "model_version_id": result.get("model_version_id"), "record_count": result.get("record_count")})
    return {"evaluation_id": evaluation_id, **result}


@app.post("/backtest")
def backtest(request: BacktestRequest) -> dict[str, Any]:
    result = backtest_records(request.records, request.labels, request.model_ids, request.baseline_model_id, request.neutral_band)
    backtest_id = record_evaluation(result)
    record_event("backtest_completed", "Backtest comparativo executado no runtime", {"backtest_id": backtest_id, "baseline_model_id": result.get("baseline_model_id"), "record_count": result.get("record_count")})
    return {"backtest_id": backtest_id, "evaluation_id": backtest_id, **result}


@app.post("/drift")
def drift(request: DriftRequest) -> dict[str, Any]:
    current_records = request.current_records or request.records
    result = calculate_drift(
        request.reference_records,
        current_records,
        request.feature_keys,
        request.warning_threshold,
        request.alert_threshold,
    )
    drift_id = record_drift(result)
    record_event("drift_completed", "Drift calculado no runtime", {"drift_id": drift_id, "status": result.get("status"), "drift_score": result.get("drift_score")})
    auto_retraining = {"triggered": False, "reason": "status_not_alert"}
    if request.auto_retraining and result.get("status") == "alert":
        auto_retraining = {
            "triggered": True,
            "request": create_retraining_request(
                "drift_alert",
                f"Drift em alerta no monitoramento runtime: drift_id={drift_id}",
                request.requested_by or "runtime_drift_monitor",
                request.retraining_min_feedback_count,
                {"source": "drift_monitor", "drift_id": drift_id, "thresholds": result.get("thresholds", {}), "requires_manual_approval": True},
                active_model()["id"],
            ),
        }
        record_event("drift_retraining_requested", "Drift em alerta gerou solicitação de retreino", {"drift_id": drift_id, "request_id": auto_retraining["request"]["request_id"], "status": auto_retraining["request"]["status"]})
    return {"drift_id": drift_id, "auto_retraining": auto_retraining, **result}


@app.get("/drift/latest")
def get_latest_drift() -> dict[str, Any]:
    return latest_drift() or {"status": "empty", "message": "Nenhum drift calculado ainda."}


@app.get("/promotion/status")
def get_promotion_status() -> dict[str, Any]:
    return promotion_status()


@app.get("/deployment/status")
def get_deployment_status() -> dict[str, Any]:
    return deployment_status(active_model()["id"])


@app.post("/deployment/shadow")
def start_shadow(request: DeploymentShadowRequest) -> dict[str, Any]:
    try:
        result = start_shadow_deployment(active_model()["id"], request.model_id, request.requested_by, request.reason, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"deployment": deployment_status(active_model()["id"]), **result}


@app.post("/deployment/canary")
def start_canary(request: DeploymentCanaryRequest) -> dict[str, Any]:
    try:
        result = start_canary_deployment(active_model()["id"], request.model_id, request.traffic_percent, request.requested_by, request.reason, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"deployment": deployment_status(active_model()["id"]), **result}


@app.post("/deployment/rollback")
def rollback(request: DeploymentRollbackRequest) -> dict[str, Any]:
    try:
        return rollback_deployment(active_model()["id"], request.requested_by, request.reason, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/experiments/ab-tests")
def get_ab_tests() -> dict[str, Any]:
    return ab_testing_status(active_model()["id"])


@app.get("/experiments/ab-tests/latest")
def get_latest_ab_test() -> dict[str, Any]:
    latest = ab_testing_status(active_model()["id"])["latest_experiment"]
    return latest or {"status": "empty", "message": "Nenhum experimento A/B registrado."}


@app.post("/experiments/ab-tests")
def create_ab_test(request: ABTestStartRequest) -> dict[str, Any]:
    try:
        return start_ab_test(
            active_model()["id"],
            request.candidate_model_id,
            request.baseline_model_id,
            request.traffic_split_percent,
            request.primary_metric or project.get("metrics", {}).get("primary"),
            request.requested_by,
            request.reason,
            request.guardrails,
            request.confirm,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/experiments/ab-tests/{experiment_id}/complete")
def finish_ab_test(experiment_id: str, request: ABTestCompletionRequest) -> dict[str, Any]:
    try:
        result = complete_ab_test(experiment_id, request.winner_model_id, request.metrics, request.completed_by, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Experimento A/B não encontrado.")
    return result


@app.get("/dashboard")
def dashboard():
    return dashboard_html()
`;
}

function renderContractTestPy(): string {
  return `import base64
import pickle
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select
from app import runtime as runtime_module
from app.db import ab_experiments, app_events, deployment_rollouts, drift_runs, engine, evaluation_runs, metric_snapshots, model_versions, prediction_feedback, prediction_rows, prediction_runs, promotion_decisions, retraining_requests, training_runs
from app.main import app
from app.runtime import latest_training_result, project


class FakeEmbeddingEstimator:
    classes_ = ["classe_a", "classe_b"]

    def predict(self, matrix):
        return ["classe_a" for _row in matrix]

    def predict_proba(self, matrix):
        return [[0.91, 0.09] for _row in matrix]


class FakeSentenceTransformer:
    def encode(self, texts, **_kwargs):
        return [[1.0, 0.0] for _text in texts]


def test_optional_orchestration_artifacts():
    runtime_root = Path(__file__).resolve().parents[1]
    expected_files = [
        "requirements-orchestration.txt",
        "docker-compose.capabilities.yml",
        "docker-compose.orchestration.yml",
        "orchestration/prefect_flow.py",
        "orchestration/celery_app.py",
        "grpc/README.md",
        "grpc/legal_classification.proto",
        ".mlops/capabilities.yaml",
        ".mlops/promotion_policy.yaml",
        ".mlops/orchestration_manifest.yaml",
    ]
    for relative_path in expected_files:
        assert (runtime_root / relative_path).exists()
    promotion_policy = (runtime_root / ".mlops/promotion_policy.yaml").read_text(encoding="utf-8")
    assert "kind: promotion_policy" in promotion_policy
    assert "recommendationEndpoint: GET /promotion/status" in promotion_policy
    manifest = (runtime_root / ".mlops/orchestration_manifest.yaml").read_text(encoding="utf-8")
    assert "kind: orchestration_manifest" in manifest
    assert "composeFile: docker-compose.orchestration.yml" in manifest
    assert "entrypoint: orchestration/prefect_flow.py" in manifest
    assert "entrypoint: orchestration/celery_app.py" in manifest
    capabilities = (runtime_root / ".mlops/capabilities.yaml").read_text(encoding="utf-8")
    assert "kind: capability_manifest" in capabilities
    assert "capabilities:" in capabilities
    compose = (runtime_root / "docker-compose.orchestration.yml").read_text(encoding="utf-8")
    assert "orchestration-redis:" in compose
    assert "celery-worker:" in compose
    assert "prefect-server:" in compose
    proto = (runtime_root / "grpc/legal_classification.proto").read_text(encoding="utf-8")
    assert "service LegalClassificationService" in proto
    assert "rpc Classify" in proto


def test_contract_endpoints():
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        metadata = client.get("/metadata").json()
        assert metadata["contract"] == "mlops-flow-v1"
        gpu_environment = client.get("/environment/gpu")
        assert gpu_environment.status_code == 200
        gpu_body = gpu_environment.json()
        assert gpu_body["status"] == "ok"
        assert "torchCudaAvailable" in gpu_body["summary"]
        assert client.get("/models/active").status_code == 200
        assert client.get("/metrics/model").status_code == 200
        assert client.get("/metrics/runtime").status_code == 200
        response = client.post("/predict", json={"input": {"text": "exemplo", "email": "pessoa@example.com"}})
        assert response.status_code == 200
        body = response.json()
        assert "model_version_id" in body
        assert "run_id" in body
        assert body["inference_source"] in {"artifact", "synthetic"}
        assert body["cache"]["hit"] is False
        cached_response = client.post("/predict", json={"input": {"text": "exemplo", "email": "pessoa@example.com"}})
        assert cached_response.status_code == 200
        assert cached_response.json()["cache"]["hit"] is True
        embedding_profiles = client.get("/embeddings/profiles")
        assert embedding_profiles.status_code == 200
        assert "profiles" in embedding_profiles.json()
        if project.get("domain", {}).get("kind") == "legal_classification":
            assert body["explanation"]["kind"] == "legal_classification"
            assert body["explanation"]["category"]["code"] in project["problem"]["classes"]
            assert body["explanation"]["decisionPolicy"]["version"]
            assert isinstance(body["explanation"]["topCandidates"], list)
            assert body["review"]["status"] in {"accepted", "review", "blocked"}
            assert body["decision"]["humanReviewRequired"] == body["review"]["humanReviewRequired"]
            if project.get("domain", {}).get("legal", {}).get("embeddingProfiles"):
                assert body["embedding_profile"]["id"]
            legal_domain = client.get("/domain/legal")
            assert legal_domain.status_code == 200
            legal_body = legal_domain.json()
            legal_manifest = project["domain"]["legal"]
            assert legal_body["kind"] == "legal_classification"
            assert legal_body["counts"]["categories"] >= len(legal_manifest.get("categories", []))
            assert legal_body["counts"]["workflow_steps"] >= len(legal_manifest.get("workflowSteps", []))
            assert legal_body["counts"]["embedding_profiles"] >= len(legal_manifest.get("embeddingProfiles", []))
            assert legal_body["counts"]["documents"] >= 1
            assert legal_body["counts"]["andamentos"] >= 1
            profile_body = embedding_profiles.json()
            assert profile_body["activeProfileId"] == legal_manifest["embeddingProfiles"][0]["id"]
            embedding_search = client.post("/embeddings/search", json={"query": "sentença recurso apelação", "collection": "categories", "top_k": 3})
            assert embedding_search.status_code == 200
            search_body = embedding_search.json()
            assert search_body["status"] == "ok"
            assert search_body["profileId"] == profile_body["activeProfileId"]
            assert len(search_body["results"]) >= 1
            reindex = client.post("/embeddings/reindex", json={"confirm": True, "requested_by": "pytest", "reason": "validar contrato de reindexação"})
            assert reindex.status_code == 200
            assert reindex.json()["status"] == "queued"
            new_profile_id = "pytest-embedding-" + body["run_id"][:8]
            embedding_register_without_confirm = client.post("/embeddings/profiles/register", json={"profile_id": new_profile_id})
            assert embedding_register_without_confirm.status_code == 409
            embedding_register = client.post(
                "/embeddings/profiles/register",
                json={
                    "confirm": True,
                    "profile_id": new_profile_id,
                    "provider": "sentence-transformers",
                    "model_name": "BAAI/bge-m3",
                    "model_version": "pytest-v2",
                    "dimension": 1024,
                    "similarity_metric": "cosine",
                    "preprocessing_version": "legal-preprocess-v1",
                    "chunking_version": "legal-chunking-v2",
                    "vector_collections": {"categories": new_profile_id + "-categories", "workflowSteps": new_profile_id + "-workflow"},
                    "metadata": {"normalization": "l2", "source": "contract_test"},
                    "requested_by": "pytest",
                },
            )
            assert embedding_register.status_code == 200
            assert embedding_register.json()["profile"]["id"] == new_profile_id
            activate_without_confirm = client.post(f"/embeddings/profiles/{new_profile_id}/activate", json={"requested_by": "pytest"})
            assert activate_without_confirm.status_code == 409
            activate_embedding = client.post(f"/embeddings/profiles/{new_profile_id}/activate", json={"confirm": True, "requested_by": "pytest", "reason": "validar troca versionada"})
            assert activate_embedding.status_code == 200
            assert activate_embedding.json()["profile"]["status"] == "active"
            profile_after_activation = client.get("/embeddings/profiles").json()
            assert profile_after_activation["activeProfileId"] == new_profile_id
            embedding_search_after_activation = client.post("/embeddings/search", json={"query": "sentença recurso apelação", "collection": "categories", "top_k": 3})
            assert embedding_search_after_activation.status_code == 200
            assert embedding_search_after_activation.json()["profileId"] == new_profile_id
            reindex_active = client.post("/embeddings/reindex", json={"confirm": True, "requested_by": "pytest", "reason": "validar reindexação do profile ativo"})
            assert reindex_active.status_code == 200
            assert reindex_active.json()["profileId"] == new_profile_id
            with engine.connect() as connection:
                stored_embedding_event = connection.execute(select(app_events.c.event_type).where(app_events.c.event_type == "embedding_profile_activated").order_by(app_events.c.id.desc()).limit(1)).scalar_one_or_none()
            assert stored_embedding_event == "embedding_profile_activated"
        with engine.connect() as connection:
            stored_prediction_run = connection.execute(
                select(prediction_runs.c.id).where(prediction_runs.c.id == body["run_id"])
            ).scalar_one_or_none()
            stored_prediction_row = connection.execute(
                select(prediction_rows).where(prediction_rows.c.run_id == body["run_id"])
            ).mappings().first()
            stored_prediction_event = connection.execute(
                select(app_events.c.event_type).where(app_events.c.event_type == "prediction_completed").order_by(app_events.c.id.desc()).limit(1)
            ).scalar_one_or_none()
        assert stored_prediction_run == body["run_id"]
        assert stored_prediction_row is not None
        assert stored_prediction_row["input_digest"]
        expected_email = "***" if "email" in project.get("sensitiveFields", []) else "pessoa@example.com"
        assert stored_prediction_row["input_masked"]["email"] == expected_email
        assert stored_prediction_row["output"]["model_version_id"] == body["model_version_id"]
        assert stored_prediction_event == "prediction_completed"
        if latest_training_result:
            models = client.get("/models").json()["models"]
            rollout_candidate = next((item["id"] for item in models if item["id"] != body["model_version_id"]), models[0]["id"])
            deployment_before = client.get("/deployment/status")
            assert deployment_before.status_code == 200
            shadow = client.post("/deployment/shadow", json={"confirm": True, "model_id": rollout_candidate, "requested_by": "pytest", "reason": "validar shadow"})
            assert shadow.status_code == 200
            assert shadow.json()["rollout"]["kind"] == "shadow"
            shadow_prediction = client.post("/predict", json={"input": {"text": "exemplo shadow", "email": "shadow@example.com"}})
            assert shadow_prediction.status_code == 200
            shadow_body = shadow_prediction.json()
            assert shadow_body["deployment"]["mode"] == "shadow"
            assert "shadow_prediction" in shadow_body
            canary = client.post("/deployment/canary", json={"confirm": True, "model_id": rollout_candidate, "traffic_percent": 100, "requested_by": "pytest", "reason": "validar canary"})
            assert canary.status_code == 409
            canary = client.post("/deployment/canary", json={"confirm": True, "model_id": rollout_candidate, "traffic_percent": 50, "requested_by": "pytest", "reason": "validar canary"})
            assert canary.status_code == 200
            assert canary.json()["rollout"]["kind"] == "canary"
            canary_prediction = client.post("/predict", json={"input": {"text": "exemplo canary", "email": "canary@example.com"}})
            assert canary_prediction.status_code == 200
            assert canary_prediction.json()["deployment"]["mode"] == "canary"
            if rollout_candidate != body["model_version_id"]:
                ab_without_confirm = client.post("/experiments/ab-tests", json={"candidate_model_id": rollout_candidate, "traffic_split_percent": 50, "requested_by": "pytest"})
                assert ab_without_confirm.status_code == 409
                ab_start = client.post(
                    "/experiments/ab-tests",
                    json={
                        "confirm": True,
                        "baseline_model_id": body["model_version_id"],
                        "candidate_model_id": rollout_candidate,
                        "traffic_split_percent": 50,
                        "primary_metric": project.get("metrics", {}).get("primary", "f1_macro"),
                        "requested_by": "pytest",
                        "reason": "validar experimento A/B",
                        "guardrails": {"min_sample_size": 10, "max_error_rate": 0.01},
                    },
                )
                assert ab_start.status_code == 200
                ab_body = ab_start.json()
                experiment_id = ab_body["experiment"]["id"]
                assert ab_body["experiment"]["status"] == "active"
                assert ab_body["experiment"]["baseline_model_id"] == body["model_version_id"]
                assert ab_body["experiment"]["candidate_model_id"] == rollout_candidate
                assert ab_body["experiment"]["traffic_split_percent"] == 50
                ab_status = client.get("/experiments/ab-tests")
                assert ab_status.status_code == 200
                assert ab_status.json()["active_count"] >= 1
                assert client.get("/experiments/ab-tests/latest").json()["id"] == experiment_id
                ab_complete = client.post(
                    f"/experiments/ab-tests/{experiment_id}/complete",
                    json={"confirm": True, "winner_model_id": body["model_version_id"], "completed_by": "pytest", "metrics": {"f1_macro": 0.91}},
                )
                assert ab_complete.status_code == 200
                assert ab_complete.json()["experiment"]["status"] == "completed"
                assert ab_complete.json()["experiment"]["winner_model_id"] == body["model_version_id"]
                with engine.connect() as connection:
                    stored_ab = connection.execute(select(ab_experiments).where(ab_experiments.c.id == experiment_id)).mappings().first()
                    stored_ab_snapshot = connection.execute(select(metric_snapshots.c.id).where(metric_snapshots.c.id == f"{experiment_id}-metrics")).scalar_one_or_none()
                    stored_ab_event = connection.execute(select(app_events.c.event_type).where(app_events.c.event_type == "ab_test_completed").order_by(app_events.c.id.desc()).limit(1)).scalar_one_or_none()
                assert stored_ab is not None
                assert stored_ab["status"] == "completed"
                assert stored_ab_snapshot == f"{experiment_id}-metrics"
                assert stored_ab_event == "ab_test_completed"
            rollback = client.post("/deployment/rollback", json={"confirm": True, "requested_by": "pytest", "reason": "validar rollback"})
            assert rollback.status_code == 200
            assert rollback.json()["rollout"]["kind"] == "rollback"
            assert client.get("/deployment/status").json()["mode"] == "active"
            with engine.connect() as connection:
                rollout_count = len(connection.execute(select(deployment_rollouts.c.id)).fetchall())
            assert rollout_count >= 3
        feedback = client.post("/feedback", json={"run_id": body["run_id"], "actual_label": body["prediction"], "source": "pytest"})
        assert feedback.status_code == 200
        feedback_body = feedback.json()
        assert feedback_body["run_id"] == body["run_id"]
        assert feedback_body["correct"] is True
        feedback_summary = client.get("/feedback/summary")
        assert feedback_summary.status_code == 200
        feedback_summary_body = feedback_summary.json()
        assert feedback_summary_body["feedback_count"] >= 1
        assert feedback_summary_body["feedback_accuracy"] == 1.0
        with engine.connect() as connection:
            stored_feedback = connection.execute(
                select(prediction_feedback).where(prediction_feedback.c.id == feedback_body["feedback_id"])
            ).mappings().first()
            stored_feedback_snapshot = connection.execute(
                select(metric_snapshots.c.id).where(metric_snapshots.c.id == f"{feedback_body['feedback_id']}-metrics")
            ).scalar_one_or_none()
            stored_feedback_event = connection.execute(
                select(app_events.c.event_type).where(app_events.c.event_type == "prediction_feedback_recorded").order_by(app_events.c.id.desc()).limit(1)
            ).scalar_one_or_none()
        assert stored_feedback is not None
        assert stored_feedback["actual_label"] == body["prediction"]
        assert stored_feedback_snapshot == f"{feedback_body['feedback_id']}-metrics"
        assert stored_feedback_event == "prediction_feedback_recorded"
        retraining_request = client.post("/retraining/requests", json={"min_feedback_count": 1, "requested_by": "pytest", "reason": "validar retreino controlado"})
        assert retraining_request.status_code == 200
        retraining_body = retraining_request.json()
        assert retraining_body["status"] == "pending_review"
        assert retraining_body["feedback_count"] >= 1
        retraining_status = client.get("/retraining/status")
        assert retraining_status.status_code == 200
        assert retraining_status.json()["pending_count"] >= 1
        approval = client.post(f"/retraining/requests/{retraining_body['request_id']}/approve", json={"confirm": True, "approved_by": "pytest"})
        assert approval.status_code == 200
        approval_body = approval.json()
        assert approval_body["status"] == "approved_pending_runner"
        training_set = client.get(f"/retraining/requests/{retraining_body['request_id']}/training-set")
        assert training_set.status_code == 200
        training_set_body = training_set.json()
        assert training_set_body["row_count"] >= 1
        assert training_set_body["target"] in training_set_body["rows"][0]
        assert training_set_body["rows"][0][training_set_body["target"]] == body["prediction"]
        completion = client.post(
            f"/retraining/requests/{retraining_body['request_id']}/complete",
            json={"confirm": True, "completed_by": "pytest", "success": True, "job_id": "job-pytest", "training_run_id": "train-pytest", "model_id": body["model_version_id"], "metrics": {"feedback_rows": training_set_body["row_count"]}},
        )
        assert completion.status_code == 200
        completion_body = completion.json()
        assert completion_body["status"] == "completed"
        with engine.connect() as connection:
            stored_retraining = connection.execute(
                select(retraining_requests).where(retraining_requests.c.id == retraining_body["request_id"])
            ).mappings().first()
            stored_retraining_event = connection.execute(
                select(app_events.c.event_type).where(app_events.c.event_type == "retraining_completed").order_by(app_events.c.id.desc()).limit(1)
            ).scalar_one_or_none()
        assert stored_retraining is not None
        assert stored_retraining["status"] == "completed"
        assert stored_retraining["completed_at"] is not None
        assert stored_retraining_event == "retraining_completed"
        target = project["problem"]["target"]
        if project["problem"]["type"] == "regression":
            record = {"feature": 1.0, target: 1.0}
        else:
            label = (project["problem"].get("classes") or ["classe_a"])[0]
            record = {"text": f"exemplo {label}", target: label}
        evaluation = client.post("/evaluate", json={"records": [record]})
        assert evaluation.status_code == 200
        evaluation_body = evaluation.json()
        assert evaluation_body["status"] == "ok"
        assert "evaluation_id" in evaluation_body
        if project["problem"]["type"] != "regression":
            for metric_name in ["top_3_accuracy", "top_5_accuracy", "brier_score", "expected_calibration_error", "roc_auc_ovr", "pr_auc_macro", "low_confidence_rate", "human_review_rate", "invalid_workflow_transition_rate"]:
                assert metric_name in evaluation_body["metrics"]
        with engine.connect() as connection:
            stored_evaluation_id = connection.execute(
                select(evaluation_runs.c.id).where(evaluation_runs.c.id == evaluation_body["evaluation_id"])
            ).scalar_one_or_none()
            stored_snapshot_id = connection.execute(
                select(metric_snapshots.c.id).where(metric_snapshots.c.id == f"{evaluation_body['evaluation_id']}-metrics")
            ).scalar_one_or_none()
        assert stored_evaluation_id == evaluation_body["evaluation_id"]
        assert stored_snapshot_id == f"{evaluation_body['evaluation_id']}-metrics"
        backtest = client.post("/backtest", json={"records": [record], "neutral_band": 0.001})
        assert backtest.status_code == 200
        backtest_body = backtest.json()
        assert backtest_body["status"] == "ok"
        assert "backtest_id" in backtest_body
        assert "baseline_model_id" in backtest_body
        assert isinstance(backtest_body["evidence"], list)
        assert any(item["color"] in {"green", "red", "neutral"} for item in backtest_body["evidence"])
        with engine.connect() as connection:
            stored_backtest_id = connection.execute(
                select(evaluation_runs.c.id).where(evaluation_runs.c.id == backtest_body["backtest_id"])
            ).scalar_one_or_none()
        assert stored_backtest_id == backtest_body["backtest_id"]
        drift = client.post(
            "/drift",
            json={
                "reference_records": [{"text": "normal", "priority": "baixa", "amount": 10}],
                "current_records": [{"text": "normal", "priority": "baixa", "amount": 11}],
            },
        )
        assert drift.status_code == 200
        drift_body = drift.json()
        assert "drift_id" in drift_body
        assert "drift_score" in drift_body
        latest_drift = client.get("/drift/latest")
        assert latest_drift.status_code == 200
        assert latest_drift.json()["id"] == drift_body["drift_id"]
        runtime_metrics = client.get("/metrics/runtime").json()
        assert runtime_metrics["drift_count"] >= 1
        assert runtime_metrics["feedback_count"] >= 1
        assert runtime_metrics["feedback_accuracy"] == 1.0
        assert runtime_metrics["retraining_pending_count"] >= 0
        with engine.connect() as connection:
            stored_drift_id = connection.execute(
                select(drift_runs.c.id).where(drift_runs.c.id == drift_body["drift_id"])
            ).scalar_one_or_none()
        assert stored_drift_id == drift_body["drift_id"]
        alert_drift = client.post(
            "/drift",
            json={
                "reference_records": [{"amount": 10}, {"amount": 10}],
                "current_records": [{"amount": 1000}, {"amount": 1000}],
                "warning_threshold": 0.2,
                "alert_threshold": 0.5,
                "requested_by": "pytest",
            },
        )
        assert alert_drift.status_code == 200
        alert_body = alert_drift.json()
        assert alert_body["status"] == "alert"
        assert alert_body["auto_retraining"]["triggered"] is True
        auto_request_id = alert_body["auto_retraining"]["request"]["request_id"]
        with engine.connect() as connection:
            stored_auto_retraining = connection.execute(select(retraining_requests).where(retraining_requests.c.id == auto_request_id)).mappings().first()
            stored_auto_retraining_event = connection.execute(select(app_events.c.event_type).where(app_events.c.event_type == "drift_retraining_requested").order_by(app_events.c.id.desc()).limit(1)).scalar_one_or_none()
        assert stored_auto_retraining is not None
        assert stored_auto_retraining["trigger"] == "drift_alert"
        assert stored_auto_retraining_event == "drift_retraining_requested"
        registered_model_id = "pytest_registered_model_" + body["run_id"][:8]
        register_without_confirm = client.post("/models/register", json={"model_id": registered_model_id, "algorithm": "external_xgboost"})
        assert register_without_confirm.status_code == 409
        registered = client.post(
            "/models/register",
            json={
                "confirm": True,
                "model_id": registered_model_id,
                "algorithm": "external_xgboost",
                "artifact_uri": "registry://pytest/registered-model",
                "metrics": {"f1_macro": 0.93},
                "requested_by": "pytest",
            },
        )
        assert registered.status_code == 200
        assert registered.json()["model"]["id"] == registered_model_id
        model_detail = client.get(f"/models/{registered_model_id}")
        assert model_detail.status_code == 200
        assert model_detail.json()["registered"] is True
        promote_without_confirm = client.post(f"/models/{registered_model_id}/promote", json={"approved_by": "pytest"})
        assert promote_without_confirm.status_code == 409
        promoted = client.post(
            f"/models/{registered_model_id}/promote",
            json={"confirm": True, "approved_by": "pytest", "evidence": {"source": "contract_test", "f1_macro": 0.93}},
        )
        assert promoted.status_code == 200
        assert promoted.json()["model"]["is_active"] is True
        assert client.get("/models/active").json()["id"] == registered_model_id
        with engine.connect() as connection:
            stored_model = connection.execute(select(model_versions).where(model_versions.c.id == registered_model_id)).mappings().first()
            stored_promotion = connection.execute(select(promotion_decisions).where(promotion_decisions.c.candidate_model_id == registered_model_id)).mappings().first()
            stored_promotion_event = connection.execute(select(app_events.c.event_type).where(app_events.c.event_type == "model_promoted").order_by(app_events.c.id.desc()).limit(1)).scalar_one_or_none()
        assert stored_model is not None
        assert stored_model["is_active"] is True
        assert stored_promotion is not None
        assert stored_promotion_event == "model_promoted"


def test_operational_training_metadata_seeded():
    if not latest_training_result:
        return
    with TestClient(app) as client:
        client.get("/health")
        with engine.connect() as connection:
            stored_run_id = connection.execute(
                select(training_runs.c.id).where(training_runs.c.id == latest_training_result["runId"])
            ).scalar_one_or_none()
            model_count = len(connection.execute(select(model_versions.c.id)).fetchall())
    assert stored_run_id == latest_training_result["runId"]
    assert model_count >= 1


def test_sentence_transformers_artifact_loader(monkeypatch):
    artifact = {
        "type": "sentence_transformers_text_classifier",
        "format": "pickle_base64",
        "modelBase64": base64.b64encode(pickle.dumps(FakeEmbeddingEstimator())).decode("ascii"),
        "embeddingModel": "fake-bert",
        "normalizeEmbeddings": True,
        "classes": ["classe_a", "classe_b"],
    }
    monkeypatch.setattr(runtime_module, "load_sentence_transformer_model", lambda _name: FakeSentenceTransformer())
    result = runtime_module.predict_from_artifact(
        artifact,
        {"text": "classe_a boleto"},
        project["problem"],
        [],
        {"id": "embedding_model"},
    )
    assert result is not None
    assert result["prediction"] == "classe_a"
    assert result["confidence"] == 0.91
    assert result["inference_source"] == "artifact"
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

function pythonDependencies(project: MLOpsProject, pipeline: PipelineFlow): string[] {
  const dependencies = new Set([
    "fastapi>=0.115,<1",
    "uvicorn[standard]>=0.30,<1",
    "pydantic>=2,<3",
    "sqlalchemy>=2,<3",
    "psycopg[binary]>=3,<4",
    "python-dotenv>=1,<2",
    "pytest>=8,<9",
    "httpx>=0.27,<1",
  ]);
  for (const dependency of project.dependencies) {
    dependencies.add(dependency);
  }
  for (const node of pipeline.nodes) {
    if (isDisabledNode(node)) {
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
