import type {
  DatasetSnapshotActionResult,
  DatasetSnapshotStatus,
  DockerRuntimeActionResult,
  DockerRuntimeHistory,
  DockerRuntimeInspect,
  DockerRuntimeLogs,
  DockerRuntimeStatus,
  EmbeddingEnvironmentStatus,
  EvaluationResult,
  ArtifactManifestValidationResult,
  EvaluationRunList,
  BacktestWindowInput,
  GeneratedArtifactFileContent,
  GeneratedArtifactListing,
  GeneratedArtifactZip,
  GpuEnvironmentStatus,
  ImportedRuntimeProject,
  LoadedProject,
  MlflowCatalog,
  MlflowIntegrationStatus,
  MlflowRegistryActionResult,
  MLOpsProject,
  OpenApiContractPreview,
  OpenApiOperationSmokeResult,
  OpenApiSchemaValidationDescriptor,
  PromotionApplyResult,
  PipelineFlow,
  PlaywrightScrapeAuthOptions,
  PlaywrightScrapeImportContractEdits,
  PlaywrightScrapeImportPreview,
  PlaywrightScrapeResult,
  PromotionStatus,
  PythonRunResult,
  ProjectSummary,
  RemoteRuntimeInspection,
  SourcePreviewResult,
  TrainingRunList,
  TrainingResult,
  ValidationResult,
  WorkerDependencyInstallResult,
  WorkerDependencyStatus,
  WorkerJob,
  WorkerJobList,
  WorkerJobQueueStatus,
  RuntimeSmokeResult,
} from "./types.ts";

export const controlApiUrl = import.meta.env.VITE_CONTROL_API_URL ?? "http://127.0.0.1:3334";

export interface TrainBaselineOptions {
  incremental?: boolean;
  previousRunId?: string | null;
  datasetSnapshotMode?: "manifest" | "masked_rows" | "full_rows" | "none" | "masked" | "full";
  allowSensitiveDatasetSnapshot?: boolean;
  datasetSnapshotRetentionDays?: number;
}

export interface RuntimeRetrainingJobOptions {
  requestId?: string | null;
  sourceId?: string | null;
  previousRunId?: string | null;
  requireFeedbackRows?: boolean;
}

export async function listProjects(): Promise<{ projects: ProjectSummary[] }> {
  return request("/projects");
}

export async function createProject(): Promise<LoadedProject> {
  return request("/projects", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function deleteProject(projectId: string): Promise<{ status: string; projectId: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm: true }),
  });
}

export async function importRuntimeProject(sourceDir: string, targetProjectId?: string): Promise<ImportedRuntimeProject> {
  return request("/projects/import-runtime", {
    method: "POST",
    body: JSON.stringify({ sourceDir, targetProjectId: targetProjectId || undefined }),
  });
}

export async function importRuntimeProjectFromZip(sourceZip: string, targetProjectId?: string): Promise<ImportedRuntimeProject> {
  return request("/projects/import-runtime", {
    method: "POST",
    body: JSON.stringify({ sourceZip, targetProjectId: targetProjectId || undefined }),
  });
}

export async function importRuntimeProjectFromGit(sourceGitUrl: string, targetProjectId?: string, sourceGitRef?: string): Promise<ImportedRuntimeProject> {
  return request("/projects/import-runtime", {
    method: "POST",
    body: JSON.stringify({
      sourceGitUrl,
      sourceGitRef: sourceGitRef || undefined,
      targetProjectId: targetProjectId || undefined,
      confirmExternalSource: true,
      confirmBlackBox: true,
    }),
  });
}

export async function importRuntimeProjectFromDockerImage(sourceDockerImage: string, targetProjectId?: string, sourceDockerPort?: number): Promise<ImportedRuntimeProject> {
  return request("/projects/import-runtime", {
    method: "POST",
    body: JSON.stringify({
      sourceDockerImage,
      sourceDockerPort,
      targetProjectId: targetProjectId || undefined,
      confirmExternalSource: true,
    }),
  });
}

export async function importRemoteBlackBoxRuntime(remoteBaseUrl: string, targetProjectId?: string): Promise<ImportedRuntimeProject> {
  return request("/projects/import-runtime", {
    method: "POST",
    body: JSON.stringify({ remoteBaseUrl, targetProjectId: targetProjectId || undefined, confirmBlackBox: true }),
  });
}

export async function importRuntimeProjectFromScrape(
  reportPath: string,
  targetProjectId?: string,
  contractEdits?: PlaywrightScrapeImportContractEdits,
): Promise<ImportedRuntimeProject> {
  return request("/projects/import-scrape", {
    method: "POST",
    body: JSON.stringify({ reportPath, targetProjectId: targetProjectId || undefined, confirmBlackBox: true, contractEdits }),
  });
}

export async function previewRuntimeProjectFromScrape(
  reportPath: string,
  targetProjectId?: string,
  contractEdits?: PlaywrightScrapeImportContractEdits,
): Promise<PlaywrightScrapeImportPreview> {
  return request("/projects/import-scrape/preview", {
    method: "POST",
    body: JSON.stringify({ reportPath, targetProjectId: targetProjectId || undefined, contractEdits }),
  });
}

export async function previewOpenApiContract(url: string): Promise<OpenApiContractPreview> {
  return request("/tools/openapi-contract-preview", {
    method: "POST",
    body: JSON.stringify({ url, confirmExternalNavigation: true, timeoutMs: 30_000 }),
  });
}

export async function smokeOpenApiOperation(
  method: string,
  url: string,
  body?: unknown,
  requestValidation?: OpenApiSchemaValidationDescriptor | null,
  responseValidation?: OpenApiSchemaValidationDescriptor | null,
): Promise<OpenApiOperationSmokeResult> {
  return request("/tools/openapi-operation-smoke", {
    method: "POST",
    body: JSON.stringify({ method, url, body, requestValidation, responseValidation, confirmExternalNavigation: true, confirmOperationCall: true, timeoutMs: 30_000 }),
  });
}

export async function loadProject(projectId: string): Promise<LoadedProject> {
  return request(`/projects/${encodeURIComponent(projectId)}`);
}

export async function saveProject(projectId: string, project: MLOpsProject): Promise<{ status: string; project: MLOpsProject }> {
  return request(`/projects/${encodeURIComponent(projectId)}/project`, {
    method: "PUT",
    body: JSON.stringify(project),
  });
}

export async function savePipeline(projectId: string, pipeline: PipelineFlow): Promise<{ status: string; pipeline: PipelineFlow }> {
  return request(`/projects/${encodeURIComponent(projectId)}/pipeline`, {
    method: "PUT",
    body: JSON.stringify(pipeline),
  });
}

export async function validateProject(projectId: string): Promise<ValidationResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/validate`, { method: "POST" });
}

export async function generateProject(projectId: string, outDir?: string): Promise<{ status: string; projectId: string; outDir: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/generate`, {
    method: "POST",
    body: JSON.stringify(outDir ? { outDir } : {}),
  });
}

export async function previewDataSource(projectId: string, sourceId: string, limit = 10, mode: "safe" | "real" = "safe"): Promise<SourcePreviewResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/data-sources/${encodeURIComponent(sourceId)}/preview`, {
    method: "POST",
    body: JSON.stringify({ limit, mode, allowExternal: mode === "real" }),
  });
}

export async function startSourcePreviewJob(projectId: string, sourceId: string, limit = 10, mode: "safe" | "real" = "safe"): Promise<WorkerJob> {
  return request(`/projects/${encodeURIComponent(projectId)}/data-sources/${encodeURIComponent(sourceId)}/preview/jobs`, {
    method: "POST",
    body: JSON.stringify({ limit, mode, allowExternal: mode === "real", timeoutMs: 600_000 }),
  });
}

export async function runPythonNode(projectId: string, nodeId: string, input: Record<string, unknown>): Promise<PythonRunResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/python-nodes/${encodeURIComponent(nodeId)}/run`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
}

export async function startPythonNodeJob(projectId: string, nodeId: string, input: Record<string, unknown>): Promise<WorkerJob> {
  return request(`/projects/${encodeURIComponent(projectId)}/python-nodes/${encodeURIComponent(nodeId)}/run/jobs`, {
    method: "POST",
    body: JSON.stringify({ input, timeoutMs: 600_000 }),
  });
}

export async function trainBaseline(projectId: string, sourceId?: string, mode: "safe" | "real" = "safe", options: TrainBaselineOptions = {}): Promise<TrainingResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/train-baseline`, {
    method: "POST",
    body: JSON.stringify({
      ...(sourceId ? { sourceId } : {}),
      ...(options.incremental ? { incremental: true } : {}),
      ...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
      ...(options.datasetSnapshotMode ? { datasetSnapshotMode: options.datasetSnapshotMode } : {}),
      ...(options.allowSensitiveDatasetSnapshot ? { allowSensitiveDatasetSnapshot: true } : {}),
      ...(options.datasetSnapshotRetentionDays ? { datasetSnapshotRetentionDays: options.datasetSnapshotRetentionDays } : {}),
      mode,
      allowExternal: mode === "real",
      maxRows: 10_000,
    }),
  });
}

export async function startTrainBaselineJob(projectId: string, sourceId?: string, mode: "safe" | "real" = "safe", options: TrainBaselineOptions = {}): Promise<WorkerJob> {
  return request(`/projects/${encodeURIComponent(projectId)}/train-baseline/jobs`, {
    method: "POST",
    body: JSON.stringify({
      ...(sourceId ? { sourceId } : {}),
      ...(options.incremental ? { incremental: true } : {}),
      ...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
      ...(options.datasetSnapshotMode ? { datasetSnapshotMode: options.datasetSnapshotMode } : {}),
      ...(options.allowSensitiveDatasetSnapshot ? { allowSensitiveDatasetSnapshot: true } : {}),
      ...(options.datasetSnapshotRetentionDays ? { datasetSnapshotRetentionDays: options.datasetSnapshotRetentionDays } : {}),
      mode,
      allowExternal: mode === "real",
      maxRows: 10_000,
      timeoutMs: 600_000,
    }),
  });
}

export async function startRuntimeRetrainingJob(projectId: string, baseUrl: string, options: RuntimeRetrainingJobOptions = {}): Promise<WorkerJob> {
  return request(`/projects/${encodeURIComponent(projectId)}/retraining/from-runtime/jobs`, {
    method: "POST",
    body: JSON.stringify({
      baseUrl,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
      ...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
      requireFeedbackRows: options.requireFeedbackRows === true,
      feedbackRowsLimit: 1000,
      timeoutMs: 600_000,
    }),
  });
}

export async function evaluateModel(projectId: string, runId?: string | null, modelId?: string | null, sourceId?: string, mode: "safe" | "real" = "safe"): Promise<EvaluationResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/evaluate-model`, {
    method: "POST",
    body: JSON.stringify({ ...(sourceId ? { sourceId } : {}), ...(runId ? { runId } : {}), ...(modelId ? { modelId } : {}), mode, allowExternal: mode === "real", maxRows: 10_000 }),
  });
}

export async function startEvaluateModelJob(projectId: string, runId?: string | null, modelId?: string | null, sourceId?: string, mode: "safe" | "real" = "safe"): Promise<WorkerJob> {
  return request(`/projects/${encodeURIComponent(projectId)}/evaluate-model/jobs`, {
    method: "POST",
    body: JSON.stringify({ ...(sourceId ? { sourceId } : {}), ...(runId ? { runId } : {}), ...(modelId ? { modelId } : {}), mode, allowExternal: mode === "real", maxRows: 10_000, timeoutMs: 600_000 }),
  });
}

export async function backtestModels(projectId: string, runId?: string | null, modelIds: string[] = [], baselineModelId?: string | null, sourceId?: string, mode: "safe" | "real" = "safe", neutralBand = 0.001, temporalWindow: BacktestWindowInput = {}): Promise<EvaluationResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/backtest-models`, {
    method: "POST",
    body: JSON.stringify({
      ...(sourceId ? { sourceId } : {}),
      ...(runId ? { runId } : {}),
      ...(modelIds.length ? { modelIds } : {}),
      ...(baselineModelId ? { baselineModelId } : {}),
      ...temporalWindow,
      mode,
      neutralBand,
      allowExternal: mode === "real",
      maxRows: 10_000,
    }),
  });
}

export async function startBacktestModelsJob(projectId: string, runId?: string | null, modelIds: string[] = [], baselineModelId?: string | null, sourceId?: string, mode: "safe" | "real" = "safe", neutralBand = 0.001, temporalWindow: BacktestWindowInput = {}): Promise<WorkerJob> {
  return request(`/projects/${encodeURIComponent(projectId)}/backtest-models/jobs`, {
    method: "POST",
    body: JSON.stringify({
      ...(sourceId ? { sourceId } : {}),
      ...(runId ? { runId } : {}),
      ...(modelIds.length ? { modelIds } : {}),
      ...(baselineModelId ? { baselineModelId } : {}),
      ...temporalWindow,
      mode,
      neutralBand,
      allowExternal: mode === "real",
      maxRows: 10_000,
      timeoutMs: 600_000,
    }),
  });
}

export async function listWorkerJobs(): Promise<WorkerJobList> {
  return request("/worker-jobs");
}

export async function getWorkerJobQueueStatus(): Promise<WorkerJobQueueStatus> {
  return request("/worker-jobs/queue");
}

export async function getWorkerJob(jobId: string): Promise<WorkerJob> {
  return request(`/worker-jobs/${encodeURIComponent(jobId)}`);
}

export async function cancelWorkerJob(jobId: string): Promise<WorkerJob> {
  return request(`/worker-jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export async function recoverWorkerJob(jobId: string): Promise<WorkerJob> {
  return request(`/worker-jobs/${encodeURIComponent(jobId)}/recover`, {
    method: "POST",
  });
}

export async function listTrainingRuns(projectId: string): Promise<TrainingRunList> {
  return request(`/projects/${encodeURIComponent(projectId)}/training-runs`);
}

export async function listEvaluationRuns(projectId: string): Promise<EvaluationRunList> {
  return request(`/projects/${encodeURIComponent(projectId)}/evaluation-runs`);
}

export async function getDatasetSnapshotStatus(projectId: string): Promise<DatasetSnapshotStatus> {
  return request(`/projects/${encodeURIComponent(projectId)}/dataset-snapshots/status`);
}

export async function archiveDatasetSnapshots(projectId: string): Promise<DatasetSnapshotActionResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/dataset-snapshots/archive`, { method: "POST" });
}

export async function restoreDatasetSnapshots(projectId: string): Promise<DatasetSnapshotActionResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/dataset-snapshots/restore`, { method: "POST" });
}

export async function purgeExpiredDatasetSnapshots(projectId: string): Promise<DatasetSnapshotActionResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/dataset-snapshots/purge-expired`, { method: "POST" });
}

export async function getPromotionStatus(projectId: string): Promise<PromotionStatus> {
  return request(`/projects/${encodeURIComponent(projectId)}/promotion/status`);
}

export async function applyPromotion(projectId: string, runId?: string | null, candidateModelId?: string | null): Promise<PromotionApplyResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/promotion/apply`, {
    method: "POST",
    body: JSON.stringify({ runId: runId || undefined, candidateModelId: candidateModelId || undefined, confirm: true, syncMlflow: true }),
  });
}

export async function promoteRuntimeRetrainingJob(projectId: string, jobId: string, candidateModelId?: string | null): Promise<PromotionApplyResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/retraining/from-runtime/jobs/${encodeURIComponent(jobId)}/promotion/apply`, {
    method: "POST",
    body: JSON.stringify({ candidateModelId: candidateModelId || undefined, confirm: true, syncMlflow: true }),
  });
}

export async function getMlflowStatus(projectId: string): Promise<MlflowIntegrationStatus> {
  return request(`/projects/${encodeURIComponent(projectId)}/mlflow/status`);
}

export async function getMlflowCatalog(projectId: string): Promise<MlflowCatalog> {
  return request(`/projects/${encodeURIComponent(projectId)}/mlflow/catalog`);
}

export async function setMlflowRegisteredModelAlias(projectId: string, name: string, version: string, alias: string): Promise<MlflowRegistryActionResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/mlflow/registry/alias`, {
    method: "POST",
    body: JSON.stringify({ name, version, alias, confirm: true }),
  });
}

export async function deleteMlflowRegisteredModelAlias(projectId: string, name: string, alias: string): Promise<MlflowRegistryActionResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/mlflow/registry/alias`, {
    method: "DELETE",
    body: JSON.stringify({ name, alias, confirm: true }),
  });
}

export async function transitionMlflowModelVersionStage(projectId: string, name: string, version: string, stage: "None" | "Staging" | "Production" | "Archived", archiveExistingVersions = false): Promise<MlflowRegistryActionResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/mlflow/registry/stage`, {
    method: "POST",
    body: JSON.stringify({ name, version, stage, archiveExistingVersions, confirm: true }),
  });
}

export async function getWorkerDependencies(): Promise<WorkerDependencyStatus> {
  return request("/environment/worker-dependencies");
}

export async function getGpuEnvironment(): Promise<GpuEnvironmentStatus> {
  return request("/environment/gpu");
}

export async function getEmbeddingEnvironment(options: { model?: string; smoke?: boolean; localFilesOnly?: boolean; timeoutMs?: number } = {}): Promise<EmbeddingEnvironmentStatus> {
  const params = new URLSearchParams();
  if (options.model) {
    params.set("model", options.model);
  }
  if (options.smoke !== undefined) {
    params.set("smoke", String(options.smoke));
  }
  if (options.localFilesOnly !== undefined) {
    params.set("localFilesOnly", String(options.localFilesOnly));
  }
  if (options.timeoutMs !== undefined) {
    params.set("timeoutMs", String(options.timeoutMs));
  }
  const query = params.toString();
  return request(`/environment/embedding${query ? `?${query}` : ""}`);
}

export async function installWorkerDependencies(): Promise<WorkerDependencyInstallResult> {
  return request("/environment/worker-dependencies/install", {
    method: "POST",
    body: JSON.stringify({ confirm: true, timeoutMs: 1_800_000 }),
  });
}

export async function listGeneratedArtifact(outDir: string): Promise<GeneratedArtifactListing> {
  return request(`/artifacts?outDir=${encodeURIComponent(outDir)}`);
}

export async function readGeneratedArtifactFile(outDir: string, path: string): Promise<GeneratedArtifactFileContent> {
  return request(`/artifacts/file?outDir=${encodeURIComponent(outDir)}&path=${encodeURIComponent(path)}`);
}

export async function exportGeneratedArtifactZip(outDir: string): Promise<GeneratedArtifactZip> {
  return request("/artifacts/export-zip", {
    method: "POST",
    body: JSON.stringify({ outDir }),
  });
}

export async function validateGeneratedManifest(outDir: string): Promise<ArtifactManifestValidationResult> {
  return request(`/artifacts/validate-manifest?outDir=${encodeURIComponent(outDir)}`);
}

export async function getDockerRuntimeStatus(outDir: string): Promise<DockerRuntimeStatus> {
  return request(`/runtime/docker/status?outDir=${encodeURIComponent(outDir)}`);
}

export async function dockerRuntimeAction(action: "build" | "up" | "down", outDir: string): Promise<DockerRuntimeActionResult> {
  return request(`/runtime/docker/${action}`, {
    method: "POST",
    body: JSON.stringify({ outDir, confirm: true, timeoutMs: 1_800_000 }),
  });
}

export async function getDockerRuntimeLogs(outDir: string, tail = 200): Promise<DockerRuntimeLogs> {
  return request(`/runtime/docker/logs?outDir=${encodeURIComponent(outDir)}&tail=${encodeURIComponent(String(tail))}`);
}

export async function getDockerRuntimeHistory(outDir: string, limit = 50): Promise<DockerRuntimeHistory> {
  return request(`/runtime/docker/history?outDir=${encodeURIComponent(outDir)}&limit=${encodeURIComponent(String(limit))}`);
}

export async function getDockerRuntimeInspect(outDir: string): Promise<DockerRuntimeInspect> {
  return request(`/runtime/docker/inspect?outDir=${encodeURIComponent(outDir)}`);
}

export async function smokeRuntime(baseUrl: string): Promise<RuntimeSmokeResult> {
  return request("/runtime/docker/smoke", {
    method: "POST",
    body: JSON.stringify({ baseUrl }),
  });
}

export async function inspectRemoteRuntime(baseUrl: string): Promise<RemoteRuntimeInspection> {
  return request("/runtime/remote/inspect", {
    method: "POST",
    body: JSON.stringify({ baseUrl }),
  });
}

export async function runPlaywrightScrape(
  url: string,
  includeScreenshot = true,
  maxDepth = 1,
  maxPages = 5,
  auth?: PlaywrightScrapeAuthOptions | null,
  confirmDeepCrawl = false,
): Promise<PlaywrightScrapeResult> {
  return request("/tools/playwright-scrape", {
    method: "POST",
    body: JSON.stringify({
      url,
      maxLinks: 80,
      maxDepth,
      maxPages,
      auth: auth || undefined,
      includeScreenshot,
      confirmExternalNavigation: true,
      confirmAuthenticatedScrape: !!auth,
      confirmDeepCrawl,
      timeoutMs: 30_000,
    }),
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${controlApiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message ?? `HTTP ${response.status}`);
  }
  return payload as T;
}
