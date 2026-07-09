import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import JSZip from "jszip";
import YAML from "yaml";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { generateInferenceApi } from "@mlops-flow-studio/codegen-inference-api";
import {
  CONTRACT_VERSION,
  analyzeMLOpsProject,
  dataSourceJsonSchema,
  inferRuntimeInfrastructure,
  inferRuntimeManifestCapabilities,
  metricCatalog,
  mlopsProjectJsonSchema,
  parseMLOpsProject,
  parsePipelineFlow,
  parseRuntimeManifest,
  pipelineFlowJsonSchema,
  promotionPolicyJsonSchema,
  runtimeManifestJsonSchema,
  type MLOpsProject,
  type PipelineFlow,
  type RuntimeManifest,
} from "@mlops-flow-studio/mlops-spec";
import { runWorker, WorkerExecutionError, workerPythonExecutable } from "./worker.ts";

export interface BuildAppOptions {
  workspaceRoot?: string;
  logger?: boolean;
  workerJobConcurrency?: number;
  workerJobQueueRoot?: string;
  workerJobWorkerId?: string;
  workerJobClaimTtlMs?: number;
  workerJobDatasetReplay?: "off" | "auto";
  datasetSnapshotStoreBackend?: "filesystem" | "s3";
  datasetSnapshotStoreRoot?: string;
  datasetSnapshotS3Bucket?: string;
  datasetSnapshotS3Prefix?: string;
  datasetSnapshotS3Endpoint?: string;
  datasetSnapshotS3Region?: string;
  datasetSnapshotS3AccessKeyId?: string;
  datasetSnapshotS3SecretAccessKey?: string;
  datasetSnapshotS3SessionToken?: string;
  datasetSnapshotS3ForcePathStyle?: boolean;
  datasetSnapshotEncryptionKey?: string;
  datasetSnapshotEncryptionKeyRef?: string;
}

interface ProjectParams {
  projectId: string;
}

interface ProjectJobParams extends ProjectParams {
  jobId: string;
}

interface CreateProjectBody {
  id?: string;
  name?: string;
  problemType?: "binary_classification" | "multiclass_classification" | "regression";
  target?: string;
  classes?: string[];
}

interface DeleteProjectBody {
  confirm?: boolean;
}

interface GenerateBody {
  outDir?: string;
}

interface ImportRuntimeBody {
  sourceDir?: string;
  sourceZip?: string;
  sourceGitUrl?: string;
  sourceGitRef?: string;
  sourceDockerImage?: string;
  sourceDockerPort?: number;
  remoteBaseUrl?: string;
  targetProjectId?: string;
  overwrite?: boolean;
  confirmExternalSource?: boolean;
  confirmBlackBox?: boolean;
  confirmSandboxExecution?: boolean;
  timeoutMs?: number;
}

interface ExportRuntimeZipBody {
  outDir?: string;
  zipPath?: string;
}

interface PythonNodeParams extends ProjectParams {
  nodeId: string;
}

interface SourceParams extends ProjectParams {
  sourceId: string;
}

interface PythonNodeRunBody {
  input?: unknown;
  context?: unknown;
  isolationMode?: "process" | "container";
  timeoutMs?: number;
}

interface SourcePreviewBody {
  limit?: number;
  mode?: "safe" | "mock" | "real";
  allowExternal?: boolean;
  mockRows?: unknown[];
  timeoutMs?: number;
}

interface TrainBaselineBody {
  sourceId?: string;
  mode?: "safe" | "mock" | "real";
  allowExternal?: boolean;
  maxRows?: number;
  mockRows?: unknown[];
  incremental?: boolean;
  previousRunId?: string;
  datasetSnapshotMode?: "manifest" | "masked_rows" | "full_rows" | "none" | "masked" | "full";
  allowSensitiveDatasetSnapshot?: boolean;
  datasetSnapshotRetentionDays?: number;
  timeoutMs?: number;
}

interface EvaluateModelBody {
  sourceId?: string;
  runId?: string;
  modelId?: string;
  mode?: "safe" | "mock" | "real";
  allowExternal?: boolean;
  maxRows?: number;
  mockRows?: unknown[];
  timeoutMs?: number;
}

interface BacktestModelsBody {
  sourceId?: string;
  runId?: string;
  modelIds?: string[];
  baselineModelId?: string;
  neutralBand?: number;
  timeColumn?: string;
  windowStart?: string;
  windowEnd?: string;
  comparisonWindowStart?: string;
  comparisonWindowEnd?: string;
  windowGranularity?: "none" | "day" | "week" | "month" | "rolling_7d" | "rolling_30d";
  mode?: "safe" | "mock" | "real";
  allowExternal?: boolean;
  maxRows?: number;
  mockRows?: unknown[];
  timeoutMs?: number;
}

type WorkerJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "recoverable";
type WorkerCommand = "run-python-block" | "preview-source" | "train-baseline" | "evaluate-model" | "backtest-models";

interface DatasetSnapshotEncryptionConfig {
  key: Buffer;
  keyRef: string;
  keyFingerprint: string;
}

interface WorkerJobQueueConfig {
  backend: "local" | "filesystem";
  storeRoot: string;
  workerId: string;
  claimTtlMs: number;
}

type WorkerJobDatasetReplayMode = "off" | "auto";

type DatasetSnapshotStoreConfig = DatasetSnapshotFilesystemStoreConfig | DatasetSnapshotS3StoreConfig;

interface DatasetSnapshotFilesystemStoreConfig {
  type: "filesystem";
  root: string;
}

interface DatasetSnapshotS3StoreConfig {
  type: "s3";
  bucket: string;
  prefix: string;
  endpoint?: string;
  region: string;
  forcePathStyle: boolean;
  client: S3Client;
}

interface WorkerJobEvent {
  kind: "worker_event";
  timestamp?: string;
  level?: string;
  type?: string;
  message?: string;
  [key: string]: unknown;
}

interface WorkerJobRecord {
  jobId: string;
  command: WorkerCommand;
  projectId: string;
  projectRoot: string;
  status: WorkerJobStatus;
  sourceId?: string;
  nodeId?: string;
  mode?: string;
  label?: string;
  timeoutMs?: number;
  queuedAt?: string;
  runnerStartedAt?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  events: WorkerJobEvent[];
  stderrEventBuffer: string;
  result?: unknown;
  error?: string;
  retraining?: Record<string, unknown>;
  requestPath?: string;
  runnerPid?: number;
  workerPid?: number;
  runnerWorkerId?: string;
  queueBackend?: "local" | "filesystem";
  claimPath?: string;
  slotPath?: string;
  recoveryAttempts?: number;
  recoveredAt?: string;
  persistPromise?: Promise<void>;
}

interface InstallWorkerDependenciesBody {
  confirm?: boolean;
  timeoutMs?: number;
}

interface TrainingRunParams extends ProjectParams {
  runId: string;
}

interface ArtifactQuery {
  outDir?: string;
  path?: string;
}

interface RuntimeDockerQuery {
  outDir?: string;
  baseUrl?: string;
  tail?: string;
  limit?: string;
}

interface EmbeddingEnvironmentQuery {
  model?: string;
  device?: string;
  smoke?: boolean | string;
  localFilesOnly?: boolean | string;
  timeoutMs?: string;
}

interface RuntimeDockerBody {
  outDir?: string;
  baseUrl?: string;
  payload?: Record<string, unknown>;
  confirm?: boolean;
  timeoutMs?: number;
}

interface RuntimeRemoteInspectBody {
  baseUrl?: string;
  timeoutMs?: number;
}

interface PlaywrightScrapeBody {
  url?: string;
  timeoutMs?: number;
  maxLinks?: number;
  maxDepth?: number;
  maxPages?: number;
  auth?: PlaywrightScrapeAuthBody;
  includeScreenshot?: boolean;
  confirmExternalNavigation?: boolean;
  confirmAuthenticatedScrape?: boolean;
  confirmDeepCrawl?: boolean;
}

interface PlaywrightScrapeAuthBody {
  loginUrl?: string;
  username?: string;
  usernameRef?: string;
  passwordRef?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successSelector?: string;
  waitAfterSubmitMs?: number;
}

interface PlaywrightScrapeAuthConfig {
  loginUrl: URL;
  username: string;
  usernameSource: string;
  password: string;
  passwordRef: string;
  usernameSelector: string | null;
  passwordSelector: string;
  submitSelector: string | null;
  successSelector: string | null;
  waitAfterSubmitMs: number;
}

interface OpenApiContractPreviewBody {
  url?: string;
  timeoutMs?: number;
  confirmExternalNavigation?: boolean;
}

interface OpenApiOperationSmokeBody {
  url?: string;
  method?: string;
  body?: unknown;
  requestValidation?: unknown;
  responseValidation?: unknown;
  timeoutMs?: number;
  confirmExternalNavigation?: boolean;
  confirmOperationCall?: boolean;
}

interface OpenApiSchemaValidationDescriptor {
  type: string | null;
  required: string[];
  properties: Record<string, OpenApiSchemaValidationDescriptor>;
  items: OpenApiSchemaValidationDescriptor | null;
  enumValues: unknown[];
  nullable: boolean;
}

interface OpenApiSchemaValidationResult {
  checked: boolean;
  ok: boolean;
  issues: string[];
}

interface ImportScrapeProjectBody {
  reportPath?: string;
  targetProjectId?: string;
  overwrite?: boolean;
  confirmBlackBox?: boolean;
  contractEdits?: unknown;
}

interface PlaywrightScrapeSourceContractEdit {
  id: string;
  include?: boolean;
  label?: string;
  description?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url?: string;
  timeoutSeconds?: number;
  bodyTemplate?: unknown;
}

interface PlaywrightScrapeContractEdits {
  sources: PlaywrightScrapeSourceContractEdit[];
}

interface RuntimeRetrainingJobBody extends TrainBaselineBody {
  baseUrl?: string;
  requestId?: string;
  preferFeedbackRows?: boolean;
  requireFeedbackRows?: boolean;
  feedbackRowsLimit?: number;
  minFeedbackRows?: number;
}

interface RuntimeDockerHistoryEntry {
  id: string;
  action: "build" | "up" | "down" | "logs" | "inspect";
  outDir: string;
  command: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  ok: boolean;
  stdout: string;
  stderr: string;
}

type RemoteRuntimeMode = "white_box" | "partial_contract" | "black_box_observable" | "unreachable";
type RemoteRuntimeCheckStatus = "ok" | "missing" | "error";

interface RemoteRuntimeCheck {
  name: string;
  status: RemoteRuntimeCheckStatus;
  method: "GET";
  path: string;
  url: string;
  statusCode: number | null;
  latencyMs: number;
  contractEndpoint: boolean;
  body?: unknown;
  message?: string;
}

interface RuntimeManifestDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

interface ApplyPromotionBody {
  runId?: string;
  candidateModelId?: string;
  confirm?: boolean;
  allowReview?: boolean;
  allowReject?: boolean;
  syncMlflow?: boolean;
  mlflowAlias?: string;
  mlflowStage?: string;
  mlflowModelName?: string;
  mlflowModelVersion?: string;
  archiveExistingVersions?: boolean;
}

interface MlflowSetAliasBody {
  name?: string;
  version?: string;
  alias?: string;
  confirm?: boolean;
}

interface MlflowDeleteAliasBody {
  name?: string;
  alias?: string;
  confirm?: boolean;
}

interface MlflowTransitionStageBody {
  name?: string;
  version?: string;
  stage?: string;
  archiveExistingVersions?: boolean;
  confirm?: boolean;
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot ?? process.env.MLOPS_STUDIO_WORKSPACE ?? process.cwd());
  const workerJobConcurrency = resolveWorkerJobConcurrency(options.workerJobConcurrency ?? process.env.MLOPS_STUDIO_WORKER_CONCURRENCY);
  const workerJobQueue = resolveWorkerJobQueue(options, workspaceRoot);
  const workerJobDatasetReplay = resolveWorkerJobDatasetReplayMode(options.workerJobDatasetReplay ?? process.env.MLOPS_STUDIO_WORKER_DATASET_REPLAY);
  const datasetSnapshotStore = resolveDatasetSnapshotStore(options);
  const datasetSnapshotEncryption = resolveDatasetSnapshotEncryption(options.datasetSnapshotEncryptionKey ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_ENCRYPTION_KEY, options.datasetSnapshotEncryptionKeyRef ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_ENCRYPTION_KEY_REF);
  const app = fastify({ logger: options.logger ?? false });
  const workerJobs = new Map<string, WorkerJobRecord>();
  const workerJobsReady = loadPersistedWorkerJobs(workspaceRoot, workerJobQueue, workerJobs);
  let workerJobDispatchPromise = Promise.resolve();
  const dispatchWorkerJobs = () => {
    workerJobDispatchPromise = workerJobDispatchPromise
      .catch(() => undefined)
      .then(async () => {
        await workerJobsReady;
        await refreshPersistedWorkerJobs(workspaceRoot, workerJobQueue, workerJobs);
        await dispatchQueuedWorkerJobs(workerJobs, workspaceRoot, workerJobQueue, workerJobConcurrency);
        await completeFinishedRuntimeRetrainingJobs(workspaceRoot, workerJobQueue, workerJobs);
      });
    return workerJobDispatchPromise;
  };

  void workerJobsReady.then(() => dispatchWorkerJobs()).catch(() => undefined);

  app.addHook("onClose", async () => {
    await workerJobsReady;
    const persistOperations: Array<Promise<void>> = [];
    for (const job of workerJobs.values()) {
      persistOperations.push(queuePersistWorkerJob(workspaceRoot, workerJobQueue, job));
    }
    await Promise.allSettled(persistOperations);
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "content-type");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WorkspaceError) {
      return reply.status(error.statusCode).send({
        error: "workspace_error",
        message: error.message,
        details: serializeErrorDetails(error.details),
      });
    }
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: "request_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    request.log.error(error);
    return reply.status(500).send({ error: "internal_error", message: "Erro interno na Control API." });
  });

  app.get("/health", async () => ({
    status: "ok",
    workspaceRoot,
  }));

  app.get("/schemas/project", async () => mlopsProjectJsonSchema());
  app.get("/schemas/pipeline", async () => pipelineFlowJsonSchema());
  app.get("/schemas/data-source", async () => dataSourceJsonSchema());
  app.get("/schemas/promotion-policy", async () => promotionPolicyJsonSchema());
  app.get("/schemas/runtime-manifest", async () => runtimeManifestJsonSchema());

  app.get("/metrics/catalog", async (request) => {
    const problemType = typeof request.query === "object" && request.query && "problemType" in request.query
      ? String((request.query as { problemType?: string }).problemType ?? "")
      : "";
    return { metrics: metricCatalog(problemType ? (problemType as never) : undefined) };
  });

  app.get("/environment/worker-dependencies", async () => {
    return workerDependencyStatus(workspaceRoot);
  });

  app.get("/environment/gpu", async () => {
    return gpuEnvironmentStatus(workspaceRoot);
  });

  app.get<{ Querystring: EmbeddingEnvironmentQuery }>("/environment/embedding", async (request) => {
    return embeddingEnvironmentStatus(workspaceRoot, request.query);
  });

  app.post<{ Body: PlaywrightScrapeBody }>("/tools/playwright-scrape", async (request) => {
    return playwrightScrape(workspaceRoot, request.body ?? {});
  });

  app.post<{ Body: OpenApiContractPreviewBody }>("/tools/openapi-contract-preview", async (request) => {
    return previewOpenApiContract(request.body ?? {});
  });

  app.post<{ Body: OpenApiOperationSmokeBody }>("/tools/openapi-operation-smoke", async (request) => {
    return smokeOpenApiOperation(request.body ?? {});
  });

  app.post<{ Body: InstallWorkerDependenciesBody }>("/environment/worker-dependencies/install", async (request) => {
    if (request.body?.confirm !== true) {
      throw new WorkspaceError("Instalação exige confirm: true.", 400);
    }
    return installWorkerOptionalDependencies(workspaceRoot, request.body.timeoutMs);
  });

  app.get("/projects", async () => ({
    projects: await listProjects(workspaceRoot),
  }));

  app.post<{ Body: CreateProjectBody }>("/projects", async (request) => {
    return createProject(workspaceRoot, request.body ?? {});
  });

  app.delete<{ Params: ProjectParams; Body: DeleteProjectBody }>("/projects/:projectId", async (request) => {
    return deleteProject(workspaceRoot, request.params.projectId, request.body ?? {});
  });

  app.post<{ Body: ImportRuntimeBody }>("/projects/import-runtime", async (request) => {
    return importRuntimeProject(workspaceRoot, request.body ?? {});
  });

  app.post<{ Body: ImportScrapeProjectBody }>("/projects/import-scrape", async (request) => {
    return importPlaywrightScrapeProject(workspaceRoot, request.body ?? {});
  });

  app.post<{ Body: ImportScrapeProjectBody }>("/projects/import-scrape/preview", async (request) => {
    return previewPlaywrightScrapeProject(workspaceRoot, request.body ?? {});
  });

  app.get<{ Params: ProjectParams }>("/projects/:projectId", async (request) => {
    return loadProjectBundle(workspaceRoot, request.params.projectId);
  });

  app.put<{ Params: ProjectParams; Body: unknown }>("/projects/:projectId/project", async (request) => {
    return saveProject(workspaceRoot, request.params.projectId, request.body);
  });

  app.put<{ Params: ProjectParams; Body: unknown }>("/projects/:projectId/pipeline", async (request) => {
    return savePipeline(workspaceRoot, request.params.projectId, request.body);
  });

  app.post<{ Params: ProjectParams }>("/projects/:projectId/validate", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return {
      projectId: loaded.project.id,
      ...analyzeMLOpsProject(loaded.project, loaded.pipeline),
    };
  });

  app.post<{ Params: PythonNodeParams; Body: PythonNodeRunBody }>("/projects/:projectId/python-nodes/:nodeId/run", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return invokeWorker(workspaceRoot, loaded, "run-python-block", pythonNodePayload(request.params.nodeId, request.body), request.body?.timeoutMs);
  });

  app.post<{ Params: PythonNodeParams; Body: PythonNodeRunBody }>("/projects/:projectId/python-nodes/:nodeId/run/jobs", async (request) => {
    await workerJobsReady;
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const job = await startWorkerJob(workerJobs, workspaceRoot, workerJobQueue, datasetSnapshotStore, datasetSnapshotEncryption, workerJobDatasetReplay, loaded, "run-python-block", pythonNodePayload(request.params.nodeId, request.body), request.body?.timeoutMs ?? 600_000);
    await dispatchWorkerJobs();
    return serializeWorkerJob(currentWorkerJob(workerJobs, job));
  });

  app.post<{ Params: SourceParams; Body: SourcePreviewBody }>("/projects/:projectId/data-sources/:sourceId/preview", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return invokeWorker(workspaceRoot, loaded, "preview-source", sourcePreviewPayload(request.params.sourceId, request.body), request.body?.timeoutMs);
  });

  app.post<{ Params: SourceParams; Body: SourcePreviewBody }>("/projects/:projectId/data-sources/:sourceId/preview/jobs", async (request) => {
    await workerJobsReady;
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const job = await startWorkerJob(workerJobs, workspaceRoot, workerJobQueue, datasetSnapshotStore, datasetSnapshotEncryption, workerJobDatasetReplay, loaded, "preview-source", sourcePreviewPayload(request.params.sourceId, request.body), request.body?.timeoutMs ?? 600_000);
    await dispatchWorkerJobs();
    return serializeWorkerJob(currentWorkerJob(workerJobs, job));
  });

  app.post<{ Params: ProjectParams; Body: TrainBaselineBody }>("/projects/:projectId/train-baseline", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return invokeWorker(workspaceRoot, loaded, "train-baseline", trainBaselinePayload(request.body), request.body?.timeoutMs ?? 60_000);
  });

  app.post<{ Params: ProjectParams; Body: TrainBaselineBody }>("/projects/:projectId/train-baseline/jobs", async (request) => {
    await workerJobsReady;
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const job = await startWorkerJob(workerJobs, workspaceRoot, workerJobQueue, datasetSnapshotStore, datasetSnapshotEncryption, workerJobDatasetReplay, loaded, "train-baseline", trainBaselinePayload(request.body), request.body?.timeoutMs ?? 600_000);
    await dispatchWorkerJobs();
    return serializeWorkerJob(currentWorkerJob(workerJobs, job));
  });

  app.post<{ Params: ProjectParams; Body: RuntimeRetrainingJobBody }>("/projects/:projectId/retraining/from-runtime/jobs", async (request) => {
    await workerJobsReady;
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const payload = await runtimeRetrainingJobPayload(loaded, request.body ?? {});
    const job = await startWorkerJob(workerJobs, workspaceRoot, workerJobQueue, datasetSnapshotStore, datasetSnapshotEncryption, workerJobDatasetReplay, loaded, "train-baseline", payload, request.body?.timeoutMs ?? 600_000);
    await dispatchWorkerJobs();
    return serializeWorkerJob(currentWorkerJob(workerJobs, job));
  });

  app.post<{ Params: ProjectParams; Body: EvaluateModelBody }>("/projects/:projectId/evaluate-model", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return invokeWorker(workspaceRoot, loaded, "evaluate-model", evaluateModelPayload(request.body), request.body?.timeoutMs ?? 120_000);
  });

  app.post<{ Params: ProjectParams; Body: EvaluateModelBody }>("/projects/:projectId/evaluate-model/jobs", async (request) => {
    await workerJobsReady;
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const job = await startWorkerJob(workerJobs, workspaceRoot, workerJobQueue, datasetSnapshotStore, datasetSnapshotEncryption, workerJobDatasetReplay, loaded, "evaluate-model", evaluateModelPayload(request.body), request.body?.timeoutMs ?? 600_000);
    await dispatchWorkerJobs();
    return serializeWorkerJob(currentWorkerJob(workerJobs, job));
  });

  app.post<{ Params: ProjectParams; Body: BacktestModelsBody }>("/projects/:projectId/backtest-models", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return invokeWorker(workspaceRoot, loaded, "backtest-models", backtestModelsPayload(request.body), request.body?.timeoutMs ?? 120_000);
  });

  app.post<{ Params: ProjectParams; Body: BacktestModelsBody }>("/projects/:projectId/backtest-models/jobs", async (request) => {
    await workerJobsReady;
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const job = await startWorkerJob(workerJobs, workspaceRoot, workerJobQueue, datasetSnapshotStore, datasetSnapshotEncryption, workerJobDatasetReplay, loaded, "backtest-models", backtestModelsPayload(request.body), request.body?.timeoutMs ?? 600_000);
    await dispatchWorkerJobs();
    return serializeWorkerJob(currentWorkerJob(workerJobs, job));
  });

  app.get("/worker-jobs", async () => {
    await dispatchWorkerJobs();
    return {
      jobs: serializedWorkerJobs(workerJobs),
    };
  });

  app.get("/worker-jobs/queue", async () => {
    await dispatchWorkerJobs();
    return workerJobQueueStatus(workerJobs, workerJobConcurrency, workerJobQueue);
  });

  app.get<{ Params: { jobId: string } }>("/worker-jobs/:jobId", async (request) => {
    await dispatchWorkerJobs();
    const job = workerJobs.get(request.params.jobId);
    if (!job) {
      throw new WorkspaceError("Job não encontrado.", 404);
    }
    return serializeWorkerJob(job);
  });

  app.post<{ Params: { jobId: string } }>("/worker-jobs/:jobId/recover", async (request) => {
    await workerJobsReady;
    await refreshPersistedWorkerJobs(workspaceRoot, workerJobQueue, workerJobs);
    const job = workerJobs.get(request.params.jobId);
    if (!job) {
      throw new WorkspaceError("Job não encontrado.", 404);
    }
    const recoveredJob = await recoverWorkerJob(workspaceRoot, workerJobQueue, job);
    await dispatchWorkerJobs();
    return serializeWorkerJob(currentWorkerJob(workerJobs, recoveredJob));
  });

  app.delete<{ Params: { jobId: string } }>("/worker-jobs/:jobId", async (request) => {
    await workerJobsReady;
    await refreshPersistedWorkerJobs(workspaceRoot, workerJobQueue, workerJobs);
    const job = workerJobs.get(request.params.jobId);
    if (!job) {
      throw new WorkspaceError("Job não encontrado.", 404);
    }
    if (job.status !== "queued" && job.status !== "running" && job.status !== "recoverable") {
      return serializeWorkerJob(job);
    }
    if (job.status !== "running") {
      await releaseWorkerJobExecutionClaim(workspaceRoot, workerJobQueue, job);
    }
    job.status = "cancelled";
    job.error = "Job cancelado pelo usuário.";
    job.finishedAt = new Date().toISOString();
    await queuePersistWorkerJob(workspaceRoot, workerJobQueue, job);
    return serializeWorkerJob(job);
  });

  app.get<{ Params: ProjectParams }>("/projects/:projectId/training-runs", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const runs = await listTrainingRuns(loaded);
    return {
      projectId: loaded.project.id,
      runs,
      latestRun: runs[0] ?? null,
    };
  });

  app.get<{ Params: TrainingRunParams }>("/projects/:projectId/training-runs/:runId", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return loadTrainingRun(loaded, request.params.runId);
  });

  app.get<{ Params: ProjectParams }>("/projects/:projectId/dataset-snapshots/status", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return datasetSnapshotStatus(loaded, datasetSnapshotStore, datasetSnapshotEncryption);
  });

  app.post<{ Params: ProjectParams }>("/projects/:projectId/dataset-snapshots/purge-expired", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return purgeExpiredDatasetSnapshots(loaded);
  });

  app.post<{ Params: ProjectParams }>("/projects/:projectId/dataset-snapshots/archive", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return archiveDatasetSnapshots(loaded, datasetSnapshotStore, datasetSnapshotEncryption);
  });

  app.post<{ Params: ProjectParams }>("/projects/:projectId/dataset-snapshots/restore", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return restoreDatasetSnapshots(loaded, datasetSnapshotStore, datasetSnapshotEncryption);
  });

  app.get<{ Params: ProjectParams }>("/projects/:projectId/evaluation-runs", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const runs = await listEvaluationRuns(loaded);
    return {
      projectId: loaded.project.id,
      runs,
      latestRun: runs[0] ?? null,
    };
  });

  app.get<{ Params: ProjectParams }>("/projects/:projectId/promotion/status", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const runs = await listTrainingRuns(loaded);
    return promotionStatusFromTrainingRun(loaded, runs[0] ?? null);
  });

  app.post<{ Params: ProjectParams; Body: ApplyPromotionBody }>("/projects/:projectId/promotion/apply", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return applyPromotionDecision(workspaceRoot, loaded, request.body ?? {});
  });

  app.post<{ Params: ProjectJobParams; Body: ApplyPromotionBody }>("/projects/:projectId/retraining/from-runtime/jobs/:jobId/promotion/apply", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    await dispatchWorkerJobs();
    return applyRuntimeRetrainingJobPromotion(workspaceRoot, workerJobQueue, workerJobs, loaded, request.params.jobId, request.body ?? {});
  });

  app.get<{ Params: ProjectParams }>("/projects/:projectId/mlflow/status", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return mlflowIntegrationStatus(workspaceRoot, loaded);
  });

  app.get<{ Params: ProjectParams }>("/projects/:projectId/mlflow/catalog", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return mlflowCatalog(workspaceRoot, loaded);
  });

  app.post<{ Params: ProjectParams; Body: MlflowSetAliasBody }>("/projects/:projectId/mlflow/registry/alias", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return setMlflowRegisteredModelAlias(loaded, request.body ?? {});
  });

  app.delete<{ Params: ProjectParams; Body: MlflowDeleteAliasBody }>("/projects/:projectId/mlflow/registry/alias", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return deleteMlflowRegisteredModelAlias(loaded, request.body ?? {});
  });

  app.post<{ Params: ProjectParams; Body: MlflowTransitionStageBody }>("/projects/:projectId/mlflow/registry/stage", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return transitionMlflowModelVersionStage(loaded, request.body ?? {});
  });

  app.get<{ Params: ProjectParams }>("/projects/:projectId/export", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    return {
      format: "mlops-flow-studio.project-workspace.v1",
      exportedAt: new Date().toISOString(),
      source: { projectId: loaded.project.id, projectPath: loaded.projectPath, pipelinePath: loaded.pipelinePath },
      project: loaded.project,
      pipeline: loaded.pipeline,
    };
  });

  app.post<{ Params: ProjectParams; Body: GenerateBody }>("/projects/:projectId/generate", async (request) => {
    const loaded = await loadProjectBundle(workspaceRoot, request.params.projectId);
    const outDir = request.body?.outDir?.trim() || `generated/${loaded.project.id}-runtime`;
    const absoluteOutDir = safeResolve(workspaceRoot, outDir);
    if (!toWorkspaceRelative(workspaceRoot, absoluteOutDir).startsWith("generated/") && toWorkspaceRelative(workspaceRoot, absoluteOutDir) !== "generated") {
      throw new WorkspaceError("O runtime gerado deve ficar dentro de generated/.", 400);
    }
    await generateInferenceApi({
      project: loaded.project,
      pipeline: loaded.pipeline,
      projectRoot: loaded.projectRoot,
      outDir: absoluteOutDir,
    });
    return {
      status: "ok",
      projectId: loaded.project.id,
      outDir: toWorkspaceRelative(workspaceRoot, absoluteOutDir),
    };
  });

  app.get<{ Querystring: RuntimeDockerQuery }>("/runtime/docker/status", async (request) => {
    return dockerRuntimeStatus(workspaceRoot, requiredQueryString(request.query.outDir, "outDir"));
  });

  app.post<{ Body: RuntimeDockerBody }>("/runtime/docker/build", async (request) => {
    return runDockerRuntimeCommand(workspaceRoot, request.body ?? {}, "build");
  });

  app.post<{ Body: RuntimeDockerBody }>("/runtime/docker/up", async (request) => {
    return runDockerRuntimeCommand(workspaceRoot, request.body ?? {}, "up");
  });

  app.post<{ Body: RuntimeDockerBody }>("/runtime/docker/down", async (request) => {
    return runDockerRuntimeCommand(workspaceRoot, request.body ?? {}, "down");
  });

  app.get<{ Querystring: RuntimeDockerQuery }>("/runtime/docker/logs", async (request) => {
    return dockerRuntimeLogs(workspaceRoot, requiredQueryString(request.query.outDir, "outDir"), optionalQueryInteger(request.query.tail, "tail", 20, 2_000, 200));
  });

  app.get<{ Querystring: RuntimeDockerQuery }>("/runtime/docker/history", async (request) => {
    return dockerRuntimeHistory(workspaceRoot, requiredQueryString(request.query.outDir, "outDir"), optionalQueryInteger(request.query.limit, "limit", 1, 200, 50));
  });

  app.get<{ Querystring: RuntimeDockerQuery }>("/runtime/docker/inspect", async (request) => {
    return dockerRuntimeInspect(workspaceRoot, requiredQueryString(request.query.outDir, "outDir"));
  });

  app.post<{ Body: RuntimeDockerBody }>("/runtime/docker/smoke", async (request) => {
    return smokeRuntime(request.body?.baseUrl, request.body?.payload, request.body?.timeoutMs);
  });

  app.post<{ Body: RuntimeRemoteInspectBody }>("/runtime/remote/inspect", async (request) => {
    return inspectRemoteRuntime(request.body?.baseUrl, request.body?.timeoutMs);
  });

  app.get<{ Querystring: ArtifactQuery }>("/artifacts", async (request) => {
    const outDir = requiredQueryString(request.query.outDir, "outDir");
    return listGeneratedArtifact(workspaceRoot, outDir);
  });

  app.get<{ Querystring: ArtifactQuery }>("/artifacts/file", async (request) => {
    const outDir = requiredQueryString(request.query.outDir, "outDir");
    const filePath = requiredQueryString(request.query.path, "path");
    return readGeneratedArtifactFile(workspaceRoot, outDir, filePath);
  });

  app.get<{ Querystring: ArtifactQuery }>("/artifacts/validate-manifest", async (request) => {
    const outDir = requiredQueryString(request.query.outDir, "outDir");
    return validateRuntimeManifestPackage(workspaceRoot, outDir);
  });

  app.post<{ Body: ExportRuntimeZipBody }>("/artifacts/export-zip", async (request) => {
    return exportGeneratedArtifactZip(workspaceRoot, request.body ?? {});
  });

  return app;
}

export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot);
}

export function safeResolve(workspaceRoot: string, targetPath: string): string {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(root, targetPath);
  const normalizedRoot = root.toLowerCase();
  const normalizedResolved = resolved.toLowerCase();
  if (normalizedResolved !== normalizedRoot && !normalizedResolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new WorkspaceError(`Caminho fora do workspace: ${targetPath}`, 400);
  }
  return resolved;
}

function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(normalizeWorkspaceRoot(workspaceRoot), absolutePath).replaceAll(path.sep, "/");
}

async function listProjects(workspaceRoot: string) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const projectsDir = safeResolve(root, "projects");
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const relativePath = `projects/${entry.name}/project.yaml`;
    try {
      const loaded = await loadProjectByPath(root, relativePath);
      summaries.push({
        id: loaded.project.id,
        name: loaded.project.name,
        version: loaded.project.version,
        problemType: loaded.project.problem.type,
        path: relativePath,
        valid: true,
      });
    } catch (error) {
      summaries.push({
        id: entry.name,
        name: null,
        version: null,
        problemType: null,
        path: relativePath,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summaries.sort((left, right) => left.id.localeCompare(right.id));
}

async function createProject(workspaceRoot: string, body: CreateProjectBody) {
  const input = normalizeCreateProjectInput(body);
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const projectRoot = safeResolve(root, `projects/${input.id}`);
  if (await pathExists(projectRoot)) {
    throw new WorkspaceError(`Projeto já existe: ${input.id}`, 409);
  }
  const project = starterProject(input);
  const pipeline = starterPipeline(project);
  const parsedProject = parseMLOpsProject(project);
  const parsedPipeline = parsePipelineFlow(pipeline);
  const tempDir = safeResolve(root, `projects/.create-${input.id}-${Date.now()}`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  try {
    await writeFile(path.join(tempDir, "project.yaml"), YAML.stringify(parsedProject), "utf-8");
    await writeFile(path.join(tempDir, parsedProject.pipelineRef), `${JSON.stringify(parsedPipeline, null, 2)}\n`, "utf-8");
    await rename(tempDir, projectRoot);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    status: "ok",
    projectPath: `${toWorkspaceRelative(root, projectRoot)}/project.yaml`,
    pipelinePath: `${toWorkspaceRelative(root, projectRoot)}/${parsedProject.pipelineRef}`,
    project: parsedProject,
    pipeline: parsedPipeline,
  };
}

async function deleteProject(workspaceRoot: string, projectId: string, body: DeleteProjectBody) {
  if (body.confirm !== true) {
    throw new WorkspaceError("Exclusão de projeto exige confirm: true.", 400);
  }
  const id = normalizeProjectId(projectId, "projectId");
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const projectRoot = safeResolve(root, `projects/${id}`);
  if (!(await pathExists(projectRoot))) {
    throw new WorkspaceError(`Projeto não encontrado: ${id}`, 404);
  }
  await rm(projectRoot, { recursive: true, force: true });
  return {
    status: "ok",
    projectId: id,
  };
}

async function importRuntimeProject(workspaceRoot: string, body: ImportRuntimeBody) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const sourceDir = optionalBodyString(body.sourceDir, "sourceDir");
  const sourceZip = optionalBodyString(body.sourceZip, "sourceZip");
  const sourceGitUrl = optionalBodyString(body.sourceGitUrl, "sourceGitUrl");
  const sourceDockerImage = optionalBodyString(body.sourceDockerImage, "sourceDockerImage");
  const remoteBaseUrl = optionalBodyString(body.remoteBaseUrl, "remoteBaseUrl");
  const sourceCount = [sourceDir, sourceZip, sourceGitUrl, sourceDockerImage, remoteBaseUrl].filter(Boolean).length;
  if (sourceCount === 0) {
    throw new WorkspaceError("sourceDir, sourceZip, sourceGitUrl, sourceDockerImage ou remoteBaseUrl é obrigatório para reimportar runtime.", 400);
  }
  if (sourceCount > 1) {
    throw new WorkspaceError("Informe apenas uma origem: sourceDir, sourceZip, sourceGitUrl, sourceDockerImage ou remoteBaseUrl.", 400);
  }
  if (remoteBaseUrl) {
    return importRemoteBlackBoxRuntimeProject(root, body, remoteBaseUrl);
  }
  if (sourceDockerImage) {
    return importDockerImageBlackBoxRuntimeProject(root, body, sourceDockerImage);
  }

  const source = sourceGitUrl
    ? await resolveRuntimeGitImportSource(root, body, sourceGitUrl)
    : sourceZip
      ? await extractRuntimeZipToTemp(root, sourceZip)
      : { ...(await resolveGeneratedArtifactRoot(root, sourceDir as string)), cleanupDir: null as string | null, sourceZip: null as string | null, sourceGitUrl: null as string | null, sourceGitRef: null as string | null };
  try {
    let importSource: RuntimeImportSource;
    try {
      importSource = await resolveRuntimeImportSource(source.absoluteOutDir, source.relativeOutDir);
    } catch (error) {
      if (source.sourceGitUrl && error instanceof WorkspaceError) {
        if (await hasStaticGitRuntimeSignal(source.absoluteOutDir)) {
          return importGitStaticBlackBoxRuntimeProject(root, body, source);
        }
        if (optionalBodyBoolean(body.confirmBlackBox, "confirmBlackBox") === true) {
          return importGitStaticBlackBoxRuntimeProject(root, body, source, true);
        }
        throw new WorkspaceError("Repositório Git sem pacote MLOps ou sinais estáticos exige confirmBlackBox: true para criar projeto black-box genérico sem executar código externo.", 409, error);
      }
      throw error;
    }

    let parsedProjectYaml: unknown;
    try {
      parsedProjectYaml = await readRuntimeProjectImportValue(importSource.projectPath);
    } catch (error) {
      throw new WorkspaceError(`${importSource.projectLabel} não é um projeto MLOps válido.`, 422, error);
    }
    let parsedPipelineJson: unknown;
    try {
      parsedPipelineJson = JSON.parse(await readFile(importSource.pipelinePath, "utf-8"));
    } catch (error) {
      throw new WorkspaceError(`${importSource.pipelineLabel} não é JSON válido.`, 422, error);
    }

    const sourceProject = parseMLOpsProject(parsedProjectYaml);
    const targetProjectId = normalizeProjectId(body.targetProjectId?.trim() || sourceProject.id, "targetProjectId");
    const normalizedPipelineRef = normalizeArtifactRelativePath(sourceProject.pipelineRef);
    const project = parseMLOpsProject({ ...sourceProject, id: targetProjectId, pipelineRef: normalizedPipelineRef });
    const pipeline = parsePipelineFlow(parsedPipelineJson);
    const pipelineRelativePath = project.pipelineRef;
    const projectsDir = safeResolve(root, "projects");
    await mkdir(projectsDir, { recursive: true });
    const projectRoot = safeResolve(root, `projects/${targetProjectId}`);
    const exists = await pathExists(projectRoot);
    if (exists && body.overwrite !== true) {
      throw new WorkspaceError(`Projeto já existe: ${targetProjectId}. Informe outro targetProjectId ou overwrite: true.`, 409);
    }

    const tempDir = safeResolve(root, `projects/.import-${targetProjectId}-${Date.now()}`);
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { recursive: true });
    try {
      if (importSource.mlopsDir) {
        await cp(importSource.mlopsDir, path.join(tempDir, ".mlops"), { recursive: true, force: true });
      } else {
        await mkdir(path.join(tempDir, ".mlops"), { recursive: true });
      }
      if (importSource.artifactsDir) {
        await cp(importSource.artifactsDir, path.join(tempDir, "artifacts"), { recursive: true, force: true });
        await cp(importSource.artifactsDir, path.join(tempDir, ".mlops", "artifacts"), { recursive: true, force: true });
      }
      if (importSource.customCodeDir && importSource.sourceKind === "app_metadata") {
        await copyAppMetadataCustomCode(importSource.customCodeDir, tempDir, pipeline);
      } else if (importSource.customCodeDir) {
        await copyDirectoryContents(importSource.customCodeDir, tempDir);
      }
      if (!importSource.mlopsDir) {
        await writeFile(path.join(tempDir, ".mlops", "runtime.manifest.json"), `${JSON.stringify(importedRuntimeManifest(project, pipeline), null, 2)}\n`, "utf-8");
        await writeFile(path.join(tempDir, ".mlops", "generated-meta.json"), `${JSON.stringify(importedRuntimeGeneratedMeta(project, pipeline, importSource.sourceKind), null, 2)}\n`, "utf-8");
        if (importSource.latestTrainingPath) {
          await cp(importSource.latestTrainingPath, path.join(tempDir, ".mlops", "latest-training-result.json"), { force: true });
        }
      }
      await writeFile(path.join(tempDir, "project.yaml"), YAML.stringify(project), "utf-8");
      await mkdir(path.dirname(path.join(tempDir, pipelineRelativePath)), { recursive: true });
      await writeFile(path.join(tempDir, pipelineRelativePath), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
      await writeFile(path.join(tempDir, ".mlops", "project.yaml"), YAML.stringify(project), "utf-8");
      await writeFile(path.join(tempDir, ".mlops", "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
      await rewriteTrainingResultProjectIds(path.join(tempDir, "artifacts", "training_runs"), project.id);
      if (exists) {
        await rm(projectRoot, { recursive: true, force: true });
      }
      await rename(tempDir, projectRoot);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }

    const loaded = await loadProjectBundle(root, project.id);
    return {
      status: "ok",
      sourceDir: sourceDir ? source.relativeOutDir : null,
      sourceZip: source.sourceZip,
      sourceGitUrl: source.sourceGitUrl,
      sourceGitRef: source.sourceGitRef,
      importSource: importSource.sourceKind,
      projectPath: loaded.projectPath,
      pipelinePath: loaded.pipelinePath,
      project: loaded.project,
      pipeline: loaded.pipeline,
      reimportPackagePath: `${toWorkspaceRelative(root, projectRoot)}/.mlops`,
    };
  } finally {
    if (source.cleanupDir) {
      await rm(source.cleanupDir, { recursive: true, force: true });
    }
  }
}

async function importRemoteBlackBoxRuntimeProject(workspaceRoot: string, body: ImportRuntimeBody, remoteBaseUrl: string) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const confirmBlackBox = optionalBodyBoolean(body.confirmBlackBox, "confirmBlackBox") === true;
  if (!confirmBlackBox) {
    throw new WorkspaceError("Importação black-box exige confirmBlackBox: true para registrar que artefatos e pipeline internos não serão recuperados.", 409);
  }
  const timeoutMs = optionalBodyTimeoutMs(body.timeoutMs, "timeoutMs");
  const inspection = await inspectRemoteRuntime(remoteBaseUrl, timeoutMs);
  const mode = remoteRuntimeInspectionMode(inspection);
  if (mode === "unreachable") {
    throw new WorkspaceError("Runtime remoto não tem endpoints observáveis suficientes para importação black-box.", 422, inspection);
  }

  const base = remoteRuntimeBaseUrl(typeof inspection.baseUrl === "string" ? inspection.baseUrl : remoteBaseUrl);
  const identity = isRecord(inspection.identity) ? inspection.identity : {};
  const identityProjectId = typeof identity.projectId === "string" ? identity.projectId : "";
  const identityProjectName = typeof identity.projectName === "string" ? identity.projectName : "";
  const targetProjectId = normalizeProjectId(body.targetProjectId?.trim() || `remote_${slugify(identityProjectId || identityProjectName || base.hostname)}`, "targetProjectId");
  const { project, pipeline } = remoteBlackBoxProjectBundle(targetProjectId, base, inspection);

  const projectsDir = safeResolve(root, "projects");
  await mkdir(projectsDir, { recursive: true });
  const projectRoot = safeResolve(root, `projects/${targetProjectId}`);
  const exists = await pathExists(projectRoot);
  if (exists && body.overwrite !== true) {
    throw new WorkspaceError(`Projeto já existe: ${targetProjectId}. Informe outro targetProjectId ou overwrite: true.`, 409);
  }

  const tempDir = safeResolve(root, `projects/.import-${targetProjectId}-${Date.now()}`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(path.join(tempDir, ".mlops"), { recursive: true });
  try {
    await writeFile(path.join(tempDir, "project.yaml"), YAML.stringify(project), "utf-8");
    await writeFile(path.join(tempDir, "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "project.yaml"), YAML.stringify(project), "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "runtime.manifest.json"), `${JSON.stringify(remoteBlackBoxRuntimeManifest(project, pipeline, inspection), null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "generated-meta.json"), `${JSON.stringify(remoteBlackBoxGeneratedMeta(project, pipeline, base, inspection), null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "remote-inspection.json"), `${JSON.stringify(inspection, null, 2)}\n`, "utf-8");
    if (exists) {
      await rm(projectRoot, { recursive: true, force: true });
    }
    await rename(tempDir, projectRoot);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  const loaded = await loadProjectBundle(root, project.id);
  return {
    status: "ok",
    sourceDir: null,
    sourceZip: null,
    sourceRemoteUrl: base.toString(),
    importSource: "remote_black_box",
    remoteInspection: inspection,
    projectPath: loaded.projectPath,
    pipelinePath: loaded.pipelinePath,
    project: loaded.project,
    pipeline: loaded.pipeline,
    reimportPackagePath: `${toWorkspaceRelative(root, projectRoot)}/.mlops`,
  };
}

async function importPlaywrightScrapeProject(workspaceRoot: string, body: ImportScrapeProjectBody) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const confirmBlackBox = optionalBodyBoolean(body.confirmBlackBox, "confirmBlackBox") === true;
  if (!confirmBlackBox) {
    throw new WorkspaceError("Importação a partir de scrape exige confirmBlackBox: true para registrar que o pipeline interno não foi recuperado.", 409);
  }

  const { report, absoluteReportPath, relativeReportPath } = await readPlaywrightScrapeReport(root, body);
  const base = playwrightScrapeBaseUrl(report);
  const title = scrapeString(report.title) || base.hostname;
  const targetProjectId = normalizeProjectId(body.targetProjectId?.trim() || `scrape_${slugify(title || base.hostname)}`, "targetProjectId");
  const contractEdits = playwrightScrapeContractEdits(body.contractEdits);
  const { project, pipeline, endpoints } = playwrightScrapeProjectBundle(targetProjectId, base, report, contractEdits);

  const projectsDir = safeResolve(root, "projects");
  await mkdir(projectsDir, { recursive: true });
  const projectRoot = safeResolve(root, `projects/${targetProjectId}`);
  const exists = await pathExists(projectRoot);
  if (exists && body.overwrite !== true) {
    throw new WorkspaceError(`Projeto já existe: ${targetProjectId}. Informe outro targetProjectId ou overwrite: true.`, 409);
  }

  const tempDir = safeResolve(root, `projects/.import-${targetProjectId}-${Date.now()}`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(path.join(tempDir, ".mlops"), { recursive: true });
  try {
    await writeFile(path.join(tempDir, "project.yaml"), YAML.stringify(project), "utf-8");
    await writeFile(path.join(tempDir, "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "project.yaml"), YAML.stringify(project), "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "runtime.manifest.json"), `${JSON.stringify(playwrightScrapeRuntimeManifest(project, pipeline, endpoints), null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "generated-meta.json"), `${JSON.stringify(playwrightScrapeGeneratedMeta(project, pipeline, base, relativeReportPath, endpoints, contractEdits), null, 2)}\n`, "utf-8");
    await cp(absoluteReportPath, path.join(tempDir, ".mlops", "playwright-scrape-report.json"), { force: true });
    if (exists) {
      await rm(projectRoot, { recursive: true, force: true });
    }
    await rename(tempDir, projectRoot);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  const loaded = await loadProjectBundle(root, project.id);
  return {
    status: "ok",
    sourceDir: null,
    sourceZip: null,
    sourceScrapeReport: relativeReportPath,
    importSource: "playwright_scrape_black_box",
    projectPath: loaded.projectPath,
    pipelinePath: loaded.pipelinePath,
    project: loaded.project,
    pipeline: loaded.pipeline,
    reimportPackagePath: `${toWorkspaceRelative(root, projectRoot)}/.mlops`,
  };
}

async function previewPlaywrightScrapeProject(workspaceRoot: string, body: ImportScrapeProjectBody) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const { report, relativeReportPath } = await readPlaywrightScrapeReport(root, body);
  const base = playwrightScrapeBaseUrl(report);
  const title = scrapeString(report.title) || base.hostname;
  const targetProjectId = normalizeProjectId(body.targetProjectId?.trim() || `scrape_${slugify(title || base.hostname)}`, "targetProjectId");
  const contractEdits = playwrightScrapeContractEdits(body.contractEdits);
  const { project, pipeline, endpoints } = playwrightScrapeProjectBundle(targetProjectId, base, report, contractEdits);
  const apiCandidateCount = recordArray(report.apiCandidates).length;
  const formCount = recordArray(report.forms).length;
  const linkCount = recordArray(report.links).length;
  return {
    status: "ok",
    kind: "playwright_scrape_import_preview",
    sourceScrapeReport: relativeReportPath,
    targetProjectId,
    baseUrl: base.toString(),
    project,
    pipeline,
    endpoints,
    summary: {
      dataSources: project.dataSources.length,
      nodes: pipeline.nodes.length,
      edges: pipeline.edges.length,
      apiCandidates: apiCandidateCount,
      forms: formCount,
      links: linkCount,
      sourceEdits: contractEdits.sources.length,
    },
    contractEdits: contractEdits.sources.length ? contractEdits : null,
    limitations: [
      "Prévia não grava projeto no workspace.",
      "Candidatos de API e forms são inferidos do HTML e exigem validação manual.",
      "Importação final ainda será black-box e não recupera implementação interna.",
    ],
  };
}

async function previewOpenApiContract(body: OpenApiContractPreviewBody) {
  const rawUrl = requiredBodyString(body.url, "url");
  const url = openApiContractPreviewUrl(rawUrl);
  const confirmedExternal = optionalBodyBoolean(body.confirmExternalNavigation, "confirmExternalNavigation") === true;
  if (!isLocalHttpUrl(url) && !confirmedExternal) {
    throw new WorkspaceError("Validação OpenAPI externa exige confirmExternalNavigation: true.", 409);
  }
  const timeoutMs = optionalBodyTimeoutMs(body.timeoutMs, "timeoutMs") ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url.toString(), { method: "GET", signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new WorkspaceError(`OpenAPI retornou HTTP ${response.status}.`, 422);
    }
    if (text.length > 1_000_000) {
      throw new WorkspaceError("OpenAPI excede o limite de 1 MB para preview controlado.", 422);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new WorkspaceError("OpenAPI precisa ser JSON válido para preview controlado.", 422, error);
    }
    if (!isRecord(parsed) || !isRecord(parsed.paths)) {
      throw new WorkspaceError("OpenAPI precisa conter objeto paths.", 422);
    }
    const info = isRecord(parsed.info) ? parsed.info : {};
    const endpoints = openApiObservedEndpoints(parsed);
    const operations = openApiObservedOperations(parsed);
    return {
      status: "ok",
      kind: "openapi_contract_preview",
      url: url.toString(),
      statusCode: response.status,
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
      title: scrapeString(info.title) || null,
      version: scrapeString(info.version) || null,
      endpointCount: endpoints.length,
      endpoints,
      operationCount: operations.length,
      operations,
      warnings: endpoints.length ? [] : ["OpenAPI válido, mas sem endpoints HTTP reconhecidos em paths."],
    };
  } finally {
    clearTimeout(timer);
  }
}

function openApiContractPreviewUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new WorkspaceError("url de OpenAPI inválida.", 400, error);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new WorkspaceError("url de OpenAPI deve usar http ou https.", 400);
  }
  if (parsed.username || parsed.password) {
    throw new WorkspaceError("url de OpenAPI não pode conter credenciais.", 400);
  }
  return parsed;
}

function isLocalHttpUrl(url: URL): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
}

async function smokeOpenApiOperation(body: OpenApiOperationSmokeBody) {
  if (optionalBodyBoolean(body.confirmOperationCall, "confirmOperationCall") !== true) {
    throw new WorkspaceError("Smoke de operação OpenAPI exige confirmOperationCall: true.", 409);
  }
  const rawUrl = requiredBodyString(body.url, "url");
  const url = openApiOperationSmokeUrl(rawUrl);
  const confirmedExternal = optionalBodyBoolean(body.confirmExternalNavigation, "confirmExternalNavigation") === true;
  if (!isLocalHttpUrl(url) && !confirmedExternal) {
    throw new WorkspaceError("Smoke de operação OpenAPI externa exige confirmExternalNavigation: true.", 409);
  }
  const method = openApiOperationSmokeMethod(body.method);
  const timeoutMs = optionalBodyTimeoutMs(body.timeoutMs, "timeoutMs") ?? 30_000;
  const requestValidation = openApiSchemaValidationDescriptorFromPayload(body.requestValidation, "requestValidation");
  const responseValidation = openApiSchemaValidationDescriptorFromPayload(body.responseValidation, "responseValidation");
  const requestValidationResult = requestValidation
    ? openApiValidateValue(body.body, requestValidation)
    : openApiUncheckedValidationResult();
  if (requestValidation && !requestValidationResult.ok) {
    throw new WorkspaceError(`Payload de request não atende ao schema OpenAPI: ${requestValidationResult.issues.slice(0, 3).join("; ")}`, 422);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const canSendBody = !["GET", "HEAD"].includes(method) && body.body !== undefined && body.body !== null;
    const response = await fetch(url.toString(), {
      method,
      signal: controller.signal,
      headers: canSendBody ? { "content-type": "application/json" } : undefined,
      body: canSendBody ? JSON.stringify(body.body) : undefined,
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const responsePreview = parseOperationSmokeResponsePreview(text, contentType);
    const responseValidationResult = responseValidation
      ? openApiValidateValue(responsePreview, responseValidation)
      : openApiUncheckedValidationResult();
    return {
      status: "ok",
      kind: "openapi_operation_smoke",
      url: url.toString(),
      method,
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
      requestBodySent: canSendBody,
      requestValidation: requestValidationResult,
      responseContentType: contentType || null,
      responseValidation: responseValidationResult,
      responsePreview,
    };
  } finally {
    clearTimeout(timer);
  }
}

function openApiOperationSmokeUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new WorkspaceError("url de smoke OpenAPI inválida.", 400, error);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new WorkspaceError("url de smoke OpenAPI deve usar http ou https.", 400);
  }
  if (parsed.username || parsed.password) {
    throw new WorkspaceError("url de smoke OpenAPI não pode conter credenciais.", 400);
  }
  return parsed;
}

function openApiOperationSmokeMethod(value: string | undefined): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" {
  const method = (value || "GET").toUpperCase();
  if (method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE" || method === "OPTIONS" || method === "HEAD") {
    return method;
  }
  throw new WorkspaceError("method de smoke OpenAPI inválido.", 400);
}

function parseOperationSmokeResponsePreview(text: string, contentType: string): unknown {
  const previewText = text.slice(0, 64_000);
  if (contentType.toLowerCase().includes("json")) {
    try {
      return JSON.parse(previewText);
    } catch {
      return previewText;
    }
  }
  return previewText;
}

async function importDockerImageBlackBoxRuntimeProject(workspaceRoot: string, body: ImportRuntimeBody, sourceDockerImage: string) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const confirmExternalSource = optionalBodyBoolean(body.confirmExternalSource, "confirmExternalSource") === true;
  if (!confirmExternalSource) {
    throw new WorkspaceError("Importação de imagem Docker exige confirmExternalSource: true para registrar o uso de origem externa e eventual inspeção controlada.", 409);
  }

  const imageRef = normalizeDockerImageRef(sourceDockerImage);
  const timeoutMs = optionalBodyTimeoutMs(body.timeoutMs, "timeoutMs") ?? 30_000;
  const dockerImageInspect = await inspectDockerImageForImport(root, imageRef, timeoutMs);
  const sourceDockerPort = optionalDockerPort(body.sourceDockerPort, "sourceDockerPort") ?? dockerImagePrimaryPort(dockerImageInspect) ?? 8080;
  const sandboxOpenApi = await inspectDockerImageOpenApiForImport(root, imageRef, timeoutMs).catch(() => null);
  const runtimeEndpoints = uniqueObservedEndpoints([
    ...dockerImageObservedEndpoints(dockerImageInspect),
    ...(sandboxOpenApi?.endpoints ?? []),
  ]);
  const labels = dockerImageLabels(dockerImageInspect);
  const labelProjectId = labels["io.mlops-flow.project-id"];
  const labelProjectName = labels["io.mlops-flow.project-name"];
  const inferredProjectId = labelProjectId && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(labelProjectId)
    ? labelProjectId
    : `image_${slugify(labelProjectName || dockerImageDisplayName(dockerImageInspect) || imageRef)}`;
  const targetProjectId = normalizeProjectId(body.targetProjectId?.trim() || inferredProjectId, "targetProjectId");
  const { project, pipeline } = dockerImageBlackBoxProjectBundle(targetProjectId, imageRef, sourceDockerPort, dockerImageInspect, runtimeEndpoints, !!sandboxOpenApi);

  const projectsDir = safeResolve(root, "projects");
  await mkdir(projectsDir, { recursive: true });
  const projectRoot = safeResolve(root, `projects/${targetProjectId}`);
  const exists = await pathExists(projectRoot);
  if (exists && body.overwrite !== true) {
    throw new WorkspaceError(`Projeto já existe: ${targetProjectId}. Informe outro targetProjectId ou overwrite: true.`, 409);
  }

  const tempDir = safeResolve(root, `projects/.import-${targetProjectId}-${Date.now()}`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(path.join(tempDir, ".mlops"), { recursive: true });
  try {
    await writeFile(path.join(tempDir, "project.yaml"), YAML.stringify(project), "utf-8");
    await writeFile(path.join(tempDir, "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "project.yaml"), YAML.stringify(project), "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "runtime.manifest.json"), `${JSON.stringify(dockerImageBlackBoxRuntimeManifest(project, pipeline, dockerImageInspect, runtimeEndpoints), null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "generated-meta.json"), `${JSON.stringify(dockerImageBlackBoxGeneratedMeta(project, pipeline, imageRef, sourceDockerPort, dockerImageInspect, runtimeEndpoints, sandboxOpenApi?.path), null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "docker-image-inspect.json"), `${JSON.stringify(dockerImageInspect, null, 2)}\n`, "utf-8");
    if (exists) {
      await rm(projectRoot, { recursive: true, force: true });
    }
    await rename(tempDir, projectRoot);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  const loaded = await loadProjectBundle(root, project.id);
  return {
    status: "ok",
    sourceDir: null,
    sourceZip: null,
    sourceGitUrl: null,
    sourceGitRef: null,
    sourceDockerImage: imageRef,
    sourceDockerPort,
    importSource: "docker_image_black_box",
    dockerImageInspect,
    projectPath: loaded.projectPath,
    pipelinePath: loaded.pipelinePath,
    project: loaded.project,
    pipeline: loaded.pipeline,
    reimportPackagePath: `${toWorkspaceRelative(root, projectRoot)}/.mlops`,
  };
}

async function importGitStaticBlackBoxRuntimeProject(
  workspaceRoot: string,
  body: ImportRuntimeBody,
  source: { absoluteOutDir: string; relativeOutDir: string; sourceGitUrl: string | null; sourceGitRef: string | null },
  allowGenericBlackBox = false,
) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const baseInspection = await inspectStaticGitRuntimeSource(source.absoluteOutDir, source.relativeOutDir, { allowGenericBlackBox });
  const timeoutMs = optionalBodyTimeoutMs(body.timeoutMs, "timeoutMs") ?? 120_000;
  const inspection = await maybeInspectGitDockerfileOpenApiForImport(root, source.absoluteOutDir, baseInspection, body, timeoutMs);
  const defaultId = `git_${slugify(inspection.projectName || path.basename(source.absoluteOutDir))}`;
  const targetProjectId = normalizeProjectId(body.targetProjectId?.trim() || defaultId, "targetProjectId");
  const { project, pipeline } = gitStaticBlackBoxProjectBundle(targetProjectId, source.sourceGitUrl ?? source.relativeOutDir, source.sourceGitRef, inspection);

  const projectsDir = safeResolve(root, "projects");
  await mkdir(projectsDir, { recursive: true });
  const projectRoot = safeResolve(root, `projects/${targetProjectId}`);
  const exists = await pathExists(projectRoot);
  if (exists && body.overwrite !== true) {
    throw new WorkspaceError(`Projeto já existe: ${targetProjectId}. Informe outro targetProjectId ou overwrite: true.`, 409);
  }

  const tempDir = safeResolve(root, `projects/.import-${targetProjectId}-${Date.now()}`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(path.join(tempDir, ".mlops"), { recursive: true });
  try {
    await writeFile(path.join(tempDir, "project.yaml"), YAML.stringify(project), "utf-8");
    await writeFile(path.join(tempDir, "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "project.yaml"), YAML.stringify(project), "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "pipeline.flow.json"), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "runtime.manifest.json"), `${JSON.stringify(gitStaticBlackBoxRuntimeManifest(project, pipeline, inspection), null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "generated-meta.json"), `${JSON.stringify(gitStaticBlackBoxGeneratedMeta(project, pipeline, source.sourceGitUrl ?? source.relativeOutDir, source.sourceGitRef, inspection), null, 2)}\n`, "utf-8");
    await writeFile(path.join(tempDir, ".mlops", "git-static-inspection.json"), `${JSON.stringify(inspection, null, 2)}\n`, "utf-8");
    if (exists) {
      await rm(projectRoot, { recursive: true, force: true });
    }
    await rename(tempDir, projectRoot);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  const loaded = await loadProjectBundle(root, project.id);
  return {
    status: "ok",
    sourceDir: null,
    sourceZip: null,
    sourceGitUrl: source.sourceGitUrl,
    sourceGitRef: source.sourceGitRef,
    importSource: "git_static_black_box",
    projectPath: loaded.projectPath,
    pipelinePath: loaded.pipelinePath,
    project: loaded.project,
    pipeline: loaded.pipeline,
    reimportPackagePath: `${toWorkspaceRelative(root, projectRoot)}/.mlops`,
  };
}

interface GitDockerfileOpenApiSandboxInspection {
  mode: "dockerfile_static_openapi_probe";
  dockerfilePath: string;
  imageTag: string;
  path: string;
  endpoints: string[];
  noEntrypointRun: true;
  buildNetwork: "none";
  pullPolicy: "local_only";
  network: "none";
  readOnlyFilesystem: true;
  capDropAll: true;
  noNewPrivileges: true;
  pidsLimit: 64;
  memory: "256m";
  cleanupImage: true;
}

interface GitStaticRuntimeInspection {
  kind: "git_static_black_box";
  sourceRoot: string;
  projectName: string;
  projectVersion: string;
  executionProfile: "cpu" | "gpu_cuda" | "auto";
  observedEndpoints: string[];
  openapi: { path: string; title: string | null; version: string | null; endpoints: string[] } | null;
  dockerfile: { path: string; labels: Record<string, string>; endpoints: string[] } | null;
  compose: { path: string; labels: Record<string, string>; endpoints: string[]; services: string[] } | null;
  sandboxOpenApi: GitDockerfileOpenApiSandboxInspection | null;
  fastapi: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  flask: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  starlette: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  django: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  express: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  fastify: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  koa: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  hono: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  nestjs: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  nextjs: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  grpc: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  go: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  ruby: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  java: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  dotnet: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  php: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  legacyHttp: { files: Array<{ path: string; endpoints: string[] }>; endpoints: string[] } | null;
  signals: string[];
  limitations: string[];
}

function gitStaticBlackBoxProjectBundle(targetProjectId: string, sourceGitUrl: string, sourceGitRef: string | null, inspection: GitStaticRuntimeInspection): { project: MLOpsProject; pipeline: PipelineFlow } {
  const predictionEndpoint = preferredPredictionEndpoint(inspection.observedEndpoints);
  const predictionPath = predictionEndpoint.split(" ", 2)[1] ?? "/predict";
  const baseUrl = "http://127.0.0.1:8080";
  const usedContainerSandbox = !!inspection.sandboxOpenApi;
  const inspectionModeDescription = usedContainerSandbox
    ? "Análise estática complementada por probe OpenAPI de Dockerfile em container sandboxado, sem rede e sem executar o entrypoint original."
    : "Nenhum código externo, servidor ou container foi executado.";
  const project = parseMLOpsProject({
    id: targetProjectId,
    name: `Git black-box ${inspection.projectName}`,
    version: inspection.projectVersion,
    contract: CONTRACT_VERSION,
    description: `Importação de repositório Git sem contrato MLOps a partir de ${sourceGitUrl}. ${inspectionModeDescription}`,
    problem: {
      type: "multiclass_classification",
      target: "prediction",
      classes: ["unknown"],
      classDependencies: [],
    },
    execution: { profile: inspection.executionProfile },
    metrics: { primary: "latency_p95_ms", secondary: ["prediction_count", "runtime_errors"] },
    dataSources: [
      {
        id: "git_static_api",
        type: "api",
        label: "Runtime Git estático",
        description: usedContainerSandbox
          ? "Fonte sintética criada por análise estática e probe OpenAPI sandboxado do Dockerfile. Suba o runtime manualmente antes de executar chamadas reais."
          : "Fonte sintética criada por análise estática de OpenAPI, Dockerfile, Compose ou rotas de frameworks web conhecidos. Suba o runtime manualmente antes de executar chamadas reais.",
        sensitive: true,
        api: {
          method: predictionEndpoint.startsWith("GET ") ? "GET" : "POST",
          url: `${baseUrl}${predictionPath}`,
          headers: {},
          bodyTemplate: { input: { type: "object", description: "Payload enviado ao runtime importado de Git." } },
          mocks: [
            {
              id: "git_static_black_box_contract",
              description: "Mock mínimo para testes seguros sem chamar o runtime importado.",
              request: { input: { type: "object" } },
              response: { prediction: "unknown", model_version_id: "git_static_model" },
            },
          ],
          pagination: { mode: "none" },
          timeoutSeconds: 30,
        },
        schema: {
          input: { type: "object" },
          prediction: { type: "string" },
          model_version_id: { type: "string" },
        },
        sensitiveFields: [],
      },
    ],
    pipelineRef: "pipeline.flow.json",
    promotionPolicy: { id: "git-static-black-box-policy", mode: "manual_approval", baseline: "active_model", rules: [] },
    runtime: {
      apiName: "Runtime Git black-box",
      routePrefix: "",
      persistence: { primary: "external_postgres", databaseUrlRef: "env:GIT_RUNTIME_DATABASE_URL" },
      dashboard: { enabled: true, pages: ["overview", "models", "prediction", "monitoring", "docs"], highlightedMetrics: ["latency_p95_ms", "prediction_count"] },
      mlflow: { enabled: false, trackingUriRef: "env:MLFLOW_TRACKING_URI", registryEnabled: false },
    },
    modelCard: {
      intendedUse: "Representar no Studio um runtime versionado em Git sem contrato MLOps nativo.",
      limitations: [
        "Importação estática não recupera dados de treino, artefatos, código customizado nem pipeline interno.",
        usedContainerSandbox
          ? "O Dockerfile foi construído e lido apenas para procurar OpenAPI estático com rede desativada, filesystem read-only no probe, sem privilégios novos e sem executar o entrypoint original."
          : "OpenAPI, Dockerfile, Compose e rotas estáticas são analisados sem executar código, servidor ou container.",
        "Chamadas reais dependem de o operador subir o runtime manualmente na URL configurada.",
      ],
      monitoring: ["git_static_inspection", "runtime_metrics", "manual_validation"],
      riskLevel: "high",
    },
    sensitiveFields: [],
    dependencies: [],
    owners: [],
  });

  const pipeline = parsePipelineFlow({
    id: `${targetProjectId}-pipeline`,
    name: "Pipeline Git black-box estático",
    version: "0.1.0",
    contract: CONTRACT_VERSION,
    description: "DAG sintético para observar e testar um runtime importado de Git sem contrato MLOps.",
    nodes: [
      {
        id: "git_static_api",
        type: "data_source",
        label: "Endpoint Git",
        description: "Fonte API derivada da análise estática de OpenAPI, Dockerfile, Compose ou rotas de frameworks web conhecidos.",
        dataSourceId: "git_static_api",
        position: { x: 80, y: 120 },
        inputSchema: {},
        outputSchema: { response: { type: "object" } },
        config: {
          sourceGitUrl,
          sourceGitRef,
          baseUrl,
          readOnlyInspection: true,
          importSource: "git_static_black_box",
          observedEndpoints: inspection.observedEndpoints,
          openapiPath: inspection.openapi?.path ?? null,
          dockerfilePath: inspection.dockerfile?.path ?? null,
          composePath: inspection.compose?.path ?? null,
          sandboxOpenApiPath: inspection.sandboxOpenApi?.path ?? null,
          containerSandboxInspection: inspection.sandboxOpenApi
            ? {
                mode: inspection.sandboxOpenApi.mode,
                dockerfilePath: inspection.sandboxOpenApi.dockerfilePath,
                network: inspection.sandboxOpenApi.network,
                readOnlyFilesystem: inspection.sandboxOpenApi.readOnlyFilesystem,
                capDropAll: inspection.sandboxOpenApi.capDropAll,
                noNewPrivileges: inspection.sandboxOpenApi.noNewPrivileges,
                noEntrypointRun: inspection.sandboxOpenApi.noEntrypointRun,
              }
            : { enabled: false },
          fastapiPaths: inspection.fastapi?.files.map((file) => file.path) ?? [],
          flaskPaths: inspection.flask?.files.map((file) => file.path) ?? [],
          starlettePaths: inspection.starlette?.files.map((file) => file.path) ?? [],
          djangoPaths: inspection.django?.files.map((file) => file.path) ?? [],
          expressPaths: inspection.express?.files.map((file) => file.path) ?? [],
          fastifyPaths: inspection.fastify?.files.map((file) => file.path) ?? [],
          koaPaths: inspection.koa?.files.map((file) => file.path) ?? [],
          honoPaths: inspection.hono?.files.map((file) => file.path) ?? [],
          nestjsPaths: inspection.nestjs?.files.map((file) => file.path) ?? [],
          nextjsPaths: inspection.nextjs?.files.map((file) => file.path) ?? [],
          grpcPaths: inspection.grpc?.files.map((file) => file.path) ?? [],
          goPaths: inspection.go?.files.map((file) => file.path) ?? [],
          rubyPaths: inspection.ruby?.files.map((file) => file.path) ?? [],
          javaPaths: inspection.java?.files.map((file) => file.path) ?? [],
          dotnetPaths: inspection.dotnet?.files.map((file) => file.path) ?? [],
          phpPaths: inspection.php?.files.map((file) => file.path) ?? [],
        },
        dependencies: [],
      },
      {
        id: "git_static_model",
        type: "model",
        label: "Modelo Git externo",
        description: "Representação visual do modelo/runtime inferido por análise estática.",
        algorithm: "git_static_black_box",
        framework: "external_runtime",
        task: project.problem.type,
        modelRole: "active",
        position: { x: 360, y: 120 },
        inputSchema: { input: { type: "object" } },
        outputSchema: { prediction: { type: "string" } },
        config: {
          importMode: "static_git",
          signals: inspection.signals,
          contract: inspection.dockerfile?.labels["io.mlops-flow.contract"] ?? null,
        },
        dependencies: [],
      },
      {
        id: "git_static_output",
        type: "output",
        label: "Saída observada",
        description: "Saída sintética do runtime Git para validação manual.",
        position: { x: 640, y: 120 },
        inputSchema: { prediction: { type: "string" } },
        outputSchema: { prediction: { type: "string" }, model_version_id: { type: "string" } },
        config: { sourceEndpoint: predictionEndpoint, readOnlyInspection: true },
        dependencies: [],
      },
    ],
    edges: [
      { from: "git_static_api", to: "git_static_model", mapping: {} },
      { from: "git_static_model", to: "git_static_output", mapping: {} },
    ],
    subgraphs: [],
    visual: { viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeId: "git_static_api" },
  });

  return { project, pipeline };
}

function gitStaticBlackBoxRuntimeManifest(project: MLOpsProject, pipeline: PipelineFlow, inspection: GitStaticRuntimeInspection): RuntimeManifest {
  return {
    id: `${project.id}-runtime`,
    projectId: project.id,
    projectVersion: project.version,
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    activeModelId: activeModelId(pipeline),
    executionProfile: project.execution.profile,
    persistence: project.runtime.persistence,
    ...runtimeManifestCapabilityFields(project, pipeline),
    endpoints: inspection.observedEndpoints,
  };
}

function gitStaticBlackBoxGeneratedMeta(project: MLOpsProject, pipeline: PipelineFlow, sourceGitUrl: string, sourceGitRef: string | null, inspection: GitStaticRuntimeInspection): Record<string, unknown> {
  const usedContainerSandbox = !!inspection.sandboxOpenApi;
  return {
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    projectId: project.id,
    projectVersion: project.version,
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    reimportPackage: ".mlops",
    generatedAt: new Date().toISOString(),
    sourceFiles: [
      "sourceGitUrl",
      ".mlops/git-static-inspection.json",
      ...(inspection.openapi ? [inspection.openapi.path] : []),
      ...(inspection.dockerfile ? [inspection.dockerfile.path] : []),
      ...(inspection.compose ? [inspection.compose.path] : []),
      ...(inspection.fastapi ? inspection.fastapi.files.map((file) => file.path) : []),
      ...(inspection.flask ? inspection.flask.files.map((file) => file.path) : []),
      ...(inspection.starlette ? inspection.starlette.files.map((file) => file.path) : []),
      ...(inspection.django ? inspection.django.files.map((file) => file.path) : []),
      ...(inspection.express ? inspection.express.files.map((file) => file.path) : []),
      ...(inspection.fastify ? inspection.fastify.files.map((file) => file.path) : []),
      ...(inspection.koa ? inspection.koa.files.map((file) => file.path) : []),
      ...(inspection.hono ? inspection.hono.files.map((file) => file.path) : []),
      ...(inspection.nestjs ? inspection.nestjs.files.map((file) => file.path) : []),
      ...(inspection.nextjs ? inspection.nextjs.files.map((file) => file.path) : []),
      ...(inspection.grpc ? inspection.grpc.files.map((file) => file.path) : []),
      ...(inspection.go ? inspection.go.files.map((file) => file.path) : []),
      ...(inspection.ruby ? inspection.ruby.files.map((file) => file.path) : []),
      ...(inspection.java ? inspection.java.files.map((file) => file.path) : []),
      ...(inspection.dotnet ? inspection.dotnet.files.map((file) => file.path) : []),
      ...(inspection.php ? inspection.php.files.map((file) => file.path) : []),
      ...(inspection.legacyHttp ? inspection.legacyHttp.files.map((file) => file.path) : []),
    ],
    importedFrom: "git_static_black_box",
    readOnly: true,
    noCodeExecution: !usedContainerSandbox,
    noContainerRun: !usedContainerSandbox,
    noApplicationEntrypointRun: true,
    sourceGitUrl,
    sourceGitRef,
    staticInspectionPath: ".mlops/git-static-inspection.json",
    openApiInspectionPath: inspection.sandboxOpenApi?.path ?? null,
    containerSandboxInspection: inspection.sandboxOpenApi
      ? {
          enabled: true,
          mode: inspection.sandboxOpenApi.mode,
          dockerfilePath: inspection.sandboxOpenApi.dockerfilePath,
          buildNetwork: inspection.sandboxOpenApi.buildNetwork,
          pullPolicy: inspection.sandboxOpenApi.pullPolicy,
          network: inspection.sandboxOpenApi.network,
          readOnlyFilesystem: inspection.sandboxOpenApi.readOnlyFilesystem,
          capDropAll: inspection.sandboxOpenApi.capDropAll,
          noNewPrivileges: inspection.sandboxOpenApi.noNewPrivileges,
          pidsLimit: inspection.sandboxOpenApi.pidsLimit,
          memory: inspection.sandboxOpenApi.memory,
          noEntrypointRun: inspection.sandboxOpenApi.noEntrypointRun,
          cleanupImage: inspection.sandboxOpenApi.cleanupImage,
        }
      : { enabled: false },
    limitations: inspection.limitations,
  };
}

async function inspectStaticGitRuntimeSource(sourceRoot: string, relativeSourceRoot: string, options: { allowGenericBlackBox?: boolean } = {}): Promise<GitStaticRuntimeInspection> {
  const openapi = await readStaticOpenApiSummary(sourceRoot).catch(() => null);
  const dockerfile = await readStaticDockerfileSummary(sourceRoot);
  const compose = await readStaticComposeSummary(sourceRoot);
  const fastapi = await readStaticFastApiSummary(sourceRoot);
  const flask = await readStaticFlaskSummary(sourceRoot);
  const starlette = await readStaticStarletteSummary(sourceRoot);
  const django = await readStaticDjangoSummary(sourceRoot);
  const express = await readStaticExpressSummary(sourceRoot);
  const fastify = await readStaticFastifySummary(sourceRoot);
  const koa = await readStaticKoaSummary(sourceRoot);
  const hono = await readStaticHonoSummary(sourceRoot);
  const nestjs = await readStaticNestJsSummary(sourceRoot);
  const nextjs = await readStaticNextJsSummary(sourceRoot);
  const grpc = await readStaticGrpcSummary(sourceRoot);
  const go = await readStaticGoSummary(sourceRoot);
  const ruby = await readStaticRubySummary(sourceRoot);
  const java = await readStaticJavaSummary(sourceRoot);
  const dotnet = await readStaticDotnetSummary(sourceRoot);
  const php = await readStaticPhpSummary(sourceRoot);
  const legacyHttp = await readStaticLegacyHttpSummary(sourceRoot);
  const observedEndpoints = uniqueObservedEndpoints([
    ...(openapi?.endpoints ?? []),
    ...(dockerfile?.endpoints ?? []),
    ...(compose?.endpoints ?? []),
    ...(fastapi?.endpoints ?? []),
    ...(flask?.endpoints ?? []),
    ...(starlette?.endpoints ?? []),
    ...(django?.endpoints ?? []),
    ...(express?.endpoints ?? []),
    ...(fastify?.endpoints ?? []),
    ...(koa?.endpoints ?? []),
    ...(hono?.endpoints ?? []),
    ...(nestjs?.endpoints ?? []),
    ...(nextjs?.endpoints ?? []),
    ...(grpc?.endpoints ?? []),
    ...(go?.endpoints ?? []),
    ...(ruby?.endpoints ?? []),
    ...(java?.endpoints ?? []),
    ...(dotnet?.endpoints ?? []),
    ...(php?.endpoints ?? []),
    ...(legacyHttp?.endpoints ?? []),
  ]);
  const signals = [
    ...(openapi ? ["openapi"] : []),
    ...(dockerfile && Object.keys(dockerfile.labels).length ? ["dockerfile_labels"] : []),
    ...(compose && Object.keys(compose.labels).length ? ["compose_labels"] : []),
    ...(fastapi ? ["fastapi_routes"] : []),
    ...(flask ? ["flask_routes"] : []),
    ...(starlette ? ["starlette_routes"] : []),
    ...(django ? ["django_routes"] : []),
    ...(express ? ["express_routes"] : []),
    ...(fastify ? ["fastify_routes"] : []),
    ...(koa ? ["koa_routes"] : []),
    ...(hono ? ["hono_routes"] : []),
    ...(nestjs ? ["nestjs_routes"] : []),
    ...(nextjs ? ["nextjs_routes"] : []),
    ...(grpc ? ["grpc_routes"] : []),
    ...(go ? ["go_routes"] : []),
    ...(ruby ? ["ruby_routes"] : []),
    ...(java ? ["java_routes"] : []),
    ...(dotnet ? ["dotnet_routes"] : []),
    ...(php ? ["php_routes"] : []),
    ...(legacyHttp ? ["legacy_http_routes"] : []),
  ];
  if ((!observedEndpoints.length || !signals.length) && options.allowGenericBlackBox !== true) {
    throw new WorkspaceError(
      "Repositório Git sem contrato MLOps precisa expor OpenAPI com endpoints, Dockerfile com labels MLOps, Compose com labels MLOps ou rotas FastAPI/Flask/Starlette/Django/Express/Fastify/Koa/Hono/NestJS/Next.js/gRPC/Go/Ruby/Java/ASP.NET Core/PHP/servidor estático legado para importação estática.",
      422,
    );
  }
  const labels = { ...(compose?.labels ?? {}), ...(dockerfile?.labels ?? {}) };
  const packageProjectName = await readStaticGitProjectName(sourceRoot);
  const projectName = labels["io.mlops-flow.project-name"] || openapi?.title || packageProjectName || path.basename(sourceRoot);
  const projectVersion = labels["io.mlops-flow.project-version"] || openapi?.version || "0.1.0";
  return {
    kind: "git_static_black_box",
    sourceRoot: relativeSourceRoot,
    projectName,
    projectVersion,
    executionProfile: remoteBlackBoxExecutionProfile(labels["io.mlops-flow.execution-profile"]),
    observedEndpoints,
    openapi,
    dockerfile,
    compose,
    sandboxOpenApi: null,
    fastapi,
    flask,
    starlette,
    django,
    express,
    fastify,
    koa,
    hono,
    nestjs,
    nextjs,
    grpc,
    go,
    ruby,
    java,
    dotnet,
    php,
    legacyHttp,
    signals: signals.length ? signals : ["generic_git_repository"],
    limitations: [
      "Sem pacote .mlops ou app/metadata no repositório.",
      "Sem execução de código, servidor ou container durante a importação.",
      "Sem reconstrução automática do pipeline interno.",
      ...(!observedEndpoints.length ? ["Sem endpoints observáveis por análise estática; a fonte API criada usa /predict como placeholder editável."] : []),
      ...(!signals.length ? ["Sem sinais estáticos de frameworks conhecidos; a importação preserva apenas um contrato black-box genérico."] : []),
    ],
  };
}

async function maybeInspectGitDockerfileOpenApiForImport(
  workspaceRoot: string,
  sourceRoot: string,
  inspection: GitStaticRuntimeInspection,
  body: ImportRuntimeBody,
  timeoutMs: number,
): Promise<GitStaticRuntimeInspection> {
  const enabled = resolveConfigBoolean(process.env.MLOPS_STUDIO_GIT_DOCKERFILE_OPENAPI_SANDBOX, false);
  const confirmed = optionalBodyBoolean(body.confirmSandboxExecution, "confirmSandboxExecution") === true;
  if (!enabled || !confirmed || !inspection.dockerfile) {
    return inspection;
  }
  const sandboxOpenApi = await inspectGitDockerfileOpenApiForImport(workspaceRoot, sourceRoot, inspection.dockerfile.path, timeoutMs);
  if (!sandboxOpenApi) {
    return inspection;
  }
  const limitations = inspection.limitations.filter((item) => item !== "Sem execução de código, servidor ou container durante a importação.");
  return {
    ...inspection,
    sandboxOpenApi,
    observedEndpoints: uniqueObservedEndpoints([...inspection.observedEndpoints, ...sandboxOpenApi.endpoints]),
    signals: [...new Set([...inspection.signals, "git_dockerfile_openapi_sandbox"])],
    limitations: [
      ...limitations,
      "Dockerfile construído apenas com confirmação explícita para probe OpenAPI sandboxado; o entrypoint original e servidor do runtime não foram executados.",
    ],
  };
}

async function inspectGitDockerfileOpenApiForImport(workspaceRoot: string, sourceRoot: string, dockerfileRelativePath: string, timeoutMs: number): Promise<GitDockerfileOpenApiSandboxInspection | null> {
  const dockerfilePath = path.join(sourceRoot, dockerfileRelativePath);
  if (!(await pathExists(dockerfilePath))) {
    return null;
  }
  const imageTag = `mlops-flow-git-openapi-probe:${dockerSafeImageTagPart(path.basename(sourceRoot))}-${randomUUID().slice(0, 12)}`;
  const buildResult = await runDockerProcess([
    "build",
    "--network",
    "none",
    "--pull=false",
    "-t",
    imageTag,
    "-f",
    dockerfilePath,
    sourceRoot,
  ], workspaceRoot, timeoutMs);
  if (buildResult.timedOut || buildResult.exitCode !== 0) {
    throw new WorkspaceError("Falha ao construir Dockerfile Git para probe OpenAPI sandboxado.", 422, {
      exitCode: buildResult.exitCode,
      timedOut: buildResult.timedOut,
      stdout: trimProcessOutput(buildResult.stdout),
      stderr: trimProcessOutput(buildResult.stderr),
    });
  }
  try {
    const openApi = await probeDockerImageOpenApiForImport(workspaceRoot, imageTag, timeoutMs);
    if (!openApi) {
      return null;
    }
    return {
      mode: "dockerfile_static_openapi_probe",
      dockerfilePath: dockerfileRelativePath,
      imageTag,
      path: openApi.path,
      endpoints: openApi.endpoints,
      noEntrypointRun: true,
      buildNetwork: "none",
      pullPolicy: "local_only",
      network: "none",
      readOnlyFilesystem: true,
      capDropAll: true,
      noNewPrivileges: true,
      pidsLimit: 64,
      memory: "256m",
      cleanupImage: true,
    };
  } finally {
    await runDockerProcess(["image", "rm", "-f", imageTag], workspaceRoot, timeoutMs).catch(() => undefined);
  }
}

async function hasStaticGitRuntimeSignal(sourceRoot: string): Promise<boolean> {
  try {
    await inspectStaticGitRuntimeSource(sourceRoot, toWorkspaceRelative(sourceRoot, sourceRoot));
    return true;
  } catch {
    return false;
  }
}

async function readStaticGitProjectName(sourceRoot: string): Promise<string | null> {
  const packageJson = await readFile(path.join(sourceRoot, "package.json"), "utf-8").catch(() => null);
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as unknown;
      if (isRecord(parsed)) {
        const name = scrapeString(parsed.name);
        if (name) {
          return name;
        }
      }
    } catch {
      // Ignore malformed package metadata; fallback remains path-based.
    }
  }
  const pyproject = await readFile(path.join(sourceRoot, "pyproject.toml"), "utf-8").catch(() => null);
  const pyprojectName = pyproject?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  if (pyprojectName) {
    return pyprojectName;
  }
  return null;
}

async function readStaticOpenApiSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["openapi"]> {
  const candidates = [
    "openapi.json",
    "openapi.yaml",
    "openapi.yml",
    "docs/openapi.json",
    "docs/openapi.yaml",
    "docs/openapi.yml",
    "app/openapi.json",
    "app/openapi.yaml",
    "app/openapi.yml",
  ].map((relativePath) => path.join(sourceRoot, relativePath));
  const openApiPath = await firstExistingPath(candidates);
  if (!openApiPath) {
    return null;
  }
  const raw = await readFile(openApiPath, "utf-8");
  const parsed = path.extname(openApiPath).toLowerCase() === ".json" ? JSON.parse(raw) as unknown : YAML.parse(raw);
  const spec = parseRecord(parsed);
  const info = isRecord(spec.info) ? spec.info : {};
  return {
    path: path.relative(sourceRoot, openApiPath).replaceAll(path.sep, "/"),
    title: typeof info.title === "string" && info.title ? info.title : null,
    version: typeof info.version === "string" && info.version ? info.version : null,
    endpoints: openApiObservedEndpoints(spec),
  };
}

async function readStaticDockerfileSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["dockerfile"]> {
  const dockerfilePath = await firstExistingPath(["Dockerfile", "docker/Dockerfile", "deploy/Dockerfile"].map((relativePath) => path.join(sourceRoot, relativePath)));
  if (!dockerfilePath) {
    return null;
  }
  const labels = parseDockerfileLabels(await readFile(dockerfilePath, "utf-8"));
  const endpoints = mlopsLabelObservedEndpoints(labels);
  return {
    path: path.relative(sourceRoot, dockerfilePath).replaceAll(path.sep, "/"),
    labels,
    endpoints,
  };
}

async function readStaticComposeSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["compose"]> {
  const composePath = await firstExistingPath([
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "docker/docker-compose.yml",
    "docker/docker-compose.yaml",
    "deploy/docker-compose.yml",
    "deploy/docker-compose.yaml",
  ].map((relativePath) => path.join(sourceRoot, relativePath)));
  if (!composePath) {
    return null;
  }
  const compose = parseRecord(YAML.parse(await readFile(composePath, "utf-8")));
  const services = isRecord(compose.services) ? compose.services : {};
  const labels: Record<string, string> = {};
  const serviceNames: string[] = [];
  for (const [serviceName, serviceConfig] of Object.entries(services).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isRecord(serviceConfig)) {
      continue;
    }
    serviceNames.push(serviceName);
    Object.assign(labels, parseComposeLabels(serviceConfig.labels));
  }
  const endpoints = mlopsLabelObservedEndpoints(labels);
  return {
    path: path.relative(sourceRoot, composePath).replaceAll(path.sep, "/"),
    labels,
    endpoints,
    services: serviceNames.slice(0, 100),
  };
}

async function readStaticFastApiSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["fastapi"]> {
  const candidates = await staticPythonCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = fastApiObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticFlaskSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["flask"]> {
  const candidates = await staticPythonCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = flaskObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticStarletteSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["starlette"]> {
  const candidates = await staticPythonCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = starletteObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticDjangoSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["django"]> {
  const candidates = await staticPythonCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = djangoObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticExpressSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["express"]> {
  const candidates = await staticJavaScriptCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = expressObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticFastifySummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["fastify"]> {
  const candidates = await staticJavaScriptCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = fastifyObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticKoaSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["koa"]> {
  const candidates = await staticJavaScriptCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = koaObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticHonoSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["hono"]> {
  const candidates = await staticJavaScriptCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = honoObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticNestJsSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["nestjs"]> {
  const candidates = await staticJavaScriptCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = nestJsObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticNextJsSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["nextjs"]> {
  const candidates = await staticNextJsCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const relativePath = path.relative(sourceRoot, candidate);
    if (!relativePath || relativePath.startsWith("..")) {
      continue;
    }
    const routePath = nextJsRoutePath(relativePath);
    if (!routePath) {
      continue;
    }
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const methods = nextJsObservedEndpoints(raw);
    if (!methods.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints: methods.map((method) => `${method} ${routePath}`),
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticLegacyHttpSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["legacyHttp"]> {
  const pyCandidates = await staticPythonCandidatePaths(sourceRoot);
  const jsCandidates = await staticJavaScriptCandidatePaths(sourceRoot);
  const goCandidates = await staticGoCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  const allCandidates = new Set([...pyCandidates, ...jsCandidates, ...goCandidates]);
  for (const candidate of allCandidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = legacyHttpObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticGrpcSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["grpc"]> {
  const candidates = await staticProtoCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = grpcObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticGoSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["go"]> {
  const candidates = await staticGoCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = goObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticRubySummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["ruby"]> {
  const candidates = await staticRubyCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = rubyObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticJavaSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["java"]> {
  const candidates = await staticJavaCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = javaObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticDotnetSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["dotnet"]> {
  const candidates = await staticDotnetCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = dotnetObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function readStaticPhpSummary(sourceRoot: string): Promise<GitStaticRuntimeInspection["php"]> {
  const candidates = await staticPhpCandidatePaths(sourceRoot);
  const files: Array<{ path: string; endpoints: string[] }> = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) {
      continue;
    }
    const endpoints = phpObservedEndpoints(raw);
    if (!endpoints.length) {
      continue;
    }
    files.push({
      path: path.relative(sourceRoot, candidate).replaceAll(path.sep, "/"),
      endpoints,
    });
  }
  const endpoints = uniqueObservedEndpoints(files.flatMap((file) => file.endpoints));
  return endpoints.length ? { files, endpoints } : null;
}

async function staticPythonCandidatePaths(sourceRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const relativePath of [
    "main.py",
    "server.py",
    "api.py",
    "app.py",
    "urls.py",
    "app/main.py",
    "app/server.py",
    "app/api.py",
    "app/urls.py",
    "src/main.py",
    "src/server.py",
    "src/api.py",
    "src/urls.py",
    "api/main.py",
    "api/server.py",
    "api/api.py",
    "api/urls.py",
    "config/urls.py",
    "core/urls.py",
    "project/urls.py",
  ]) {
    candidates.add(path.join(sourceRoot, relativePath));
  }
  for (const relativeDir of ["app", "src", "api", "config", "core", "project"]) {
    await collectStaticPythonFiles(path.join(sourceRoot, relativeDir), candidates, 2, 80);
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      existing.push(candidate);
    }
    if (existing.length >= 80) {
      break;
    }
  }
  return existing;
}

async function staticJavaScriptCandidatePaths(sourceRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const relativePath of [
    "index.js",
    "index.ts",
    "main.js",
    "main.ts",
    "server.js",
    "server.ts",
    "app.js",
    "app.ts",
    "routes.js",
    "routes.ts",
    "src/index.js",
    "src/index.ts",
    "src/main.js",
    "src/main.ts",
    "src/server.js",
    "src/server.ts",
    "src/app.js",
    "src/app.ts",
    "src/routes.js",
    "src/routes.ts",
    "api/server.js",
    "api/server.ts",
    "api/routes.js",
    "api/routes.ts",
    "app/server.js",
    "app/server.ts",
    "app/routes.js",
    "app/routes.ts",
  ]) {
    candidates.add(path.join(sourceRoot, relativePath));
  }
  for (const relativeDir of ["src", "api", "app", "routes"]) {
    await collectStaticJavaScriptFiles(path.join(sourceRoot, relativeDir), candidates, 2, 80);
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      existing.push(candidate);
    }
    if (existing.length >= 80) {
      break;
    }
  }
  return existing;
}

async function staticNextJsCandidatePaths(sourceRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const candidateBase of [path.join(sourceRoot, "app"), path.join(sourceRoot, "pages")]) {
    await collectStaticJavaScriptFiles(candidateBase, candidates, 8, 80);
  }
  const existing: string[] = [];
  for (const candidate of candidates) {
    const relativePath = path.relative(sourceRoot, candidate).replaceAll(path.sep, "/");
    if (!relativePath.startsWith("..") && isNextJsApiRouteCandidate(relativePath)) {
      const candidateStat = await stat(candidate).catch(() => null);
      if (candidateStat?.isFile()) {
        existing.push(candidate);
      }
      if (existing.length >= 80) {
        break;
      }
    }
  }
  return existing;
}

async function staticProtoCandidatePaths(sourceRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const relativePath of [
    "api/predict.proto",
    "proto/service.proto",
    "proto/predict.proto",
    "proto/api.proto",
    "proto/schema.proto",
    "src/proto/predict.proto",
    "src/api/predict.proto",
    "app/proto/predict.proto",
  ]) {
    candidates.add(path.join(sourceRoot, relativePath));
  }
  for (const relativeDir of ["proto", "api", "src", "app"]) {
    await collectStaticProtoFiles(path.join(sourceRoot, relativeDir), candidates, 4, 80);
  }
  const existing: string[] = [];
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      existing.push(candidate);
    }
    if (existing.length >= 80) {
      break;
    }
  }
  return existing;
}

async function staticGoCandidatePaths(sourceRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const relativePath of [
    "main.go",
    "server.go",
    "app.go",
    "api.go",
    "routes.go",
    "cmd/api/main.go",
    "cmd/server/main.go",
    "cmd/web/main.go",
    "internal/api/routes.go",
    "internal/server/routes.go",
    "pkg/api/routes.go",
    "pkg/server/routes.go",
  ]) {
    candidates.add(path.join(sourceRoot, relativePath));
  }
  for (const relativeDir of ["cmd", "internal", "pkg", "app", "api", "server"]) {
    await collectStaticGoFiles(path.join(sourceRoot, relativeDir), candidates, 3, 80);
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      existing.push(candidate);
    }
    if (existing.length >= 80) {
      break;
    }
  }
  return existing;
}

async function staticRubyCandidatePaths(sourceRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const relativePath of [
    "config/routes.rb",
    "routes.rb",
    "app.rb",
    "server.rb",
    "api.rb",
    "src/app.rb",
    "src/server.rb",
    "src/api.rb",
    "app/app.rb",
    "app/server.rb",
    "app/api.rb",
    "api/app.rb",
    "api/server.rb",
    "api/api.rb",
    "lib/app.rb",
    "lib/server.rb",
    "lib/api.rb",
  ]) {
    candidates.add(path.join(sourceRoot, relativePath));
  }
  for (const relativeDir of ["app", "config", "lib", "src", "api", "routes"]) {
    await collectStaticRubyFiles(path.join(sourceRoot, relativeDir), candidates, 3, 80);
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      existing.push(candidate);
    }
    if (existing.length >= 80) {
      break;
    }
  }
  return existing;
}

async function staticJavaCandidatePaths(sourceRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const relativePath of [
    "src/main/java/Application.java",
    "src/main/java/App.java",
    "src/main/java/Controller.java",
    "src/main/java/ApiController.java",
    "src/main/java/HealthController.java",
    "src/main/java/PredictController.java",
    "app/src/main/java/Application.java",
    "app/src/main/java/App.java",
    "app/src/main/java/Controller.java",
    "server/src/main/java/Application.java",
    "server/src/main/java/App.java",
    "server/src/main/java/Controller.java",
  ]) {
    candidates.add(path.join(sourceRoot, relativePath));
  }
  for (const relativeDir of ["src/main/java", "app/src/main/java", "server/src/main/java", "api/src/main/java", "src", "app", "server", "api"]) {
    await collectStaticJavaFiles(path.join(sourceRoot, relativeDir), candidates, 5, 100);
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      existing.push(candidate);
    }
    if (existing.length >= 100) {
      break;
    }
  }
  return existing;
}

async function staticDotnetCandidatePaths(sourceRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const relativePath of [
    "Program.cs",
    "Startup.cs",
    "Controllers/HealthController.cs",
    "Controllers/PredictController.cs",
    "Controllers/PredictionController.cs",
    "src/Program.cs",
    "src/Startup.cs",
    "src/Controllers/HealthController.cs",
    "src/Controllers/PredictController.cs",
    "app/Program.cs",
    "app/Startup.cs",
    "api/Program.cs",
    "api/Startup.cs",
    "server/Program.cs",
    "server/Startup.cs",
  ]) {
    candidates.add(path.join(sourceRoot, relativePath));
  }
  for (const relativeDir of ["Controllers", "src", "app", "api", "server"]) {
    await collectStaticDotnetFiles(path.join(sourceRoot, relativeDir), candidates, 4, 100);
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      existing.push(candidate);
    }
    if (existing.length >= 100) {
      break;
    }
  }
  return existing;
}

async function staticPhpCandidatePaths(sourceRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const relativePath of [
    "routes/api.php",
    "routes/web.php",
    "routes.php",
    "index.php",
    "public/index.php",
    "app.php",
    "bootstrap/app.php",
    "config/routes.php",
    "src/Controller/HealthController.php",
    "src/Controller/PredictController.php",
    "app/Http/Controllers/HealthController.php",
    "app/Http/Controllers/PredictController.php",
  ]) {
    candidates.add(path.join(sourceRoot, relativePath));
  }
  for (const relativeDir of ["routes", "src", "app", "config"]) {
    await collectStaticPhpFiles(path.join(sourceRoot, relativeDir), candidates, 4, 100);
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      existing.push(candidate);
    }
    if (existing.length >= 100) {
      break;
    }
  }
  return existing;
}

async function collectStaticPythonFiles(directory: string, candidates: Set<string>, depth: number, maxFiles: number): Promise<void> {
  if (depth < 0 || candidates.size >= maxFiles) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.size >= maxFiles) {
      return;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", ".venv", "__pycache__", "build", "dist", "node_modules"].includes(entry.name)) {
        continue;
      }
      await collectStaticPythonFiles(absolutePath, candidates, depth - 1, maxFiles);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".py")) {
      candidates.add(absolutePath);
    }
  }
}

async function collectStaticGoFiles(directory: string, candidates: Set<string>, depth: number, maxFiles: number): Promise<void> {
  if (depth < 0 || candidates.size >= maxFiles) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.size >= maxFiles) {
      return;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "bin", "build", "dist", "node_modules", "vendor"].includes(entry.name)) {
        continue;
      }
      await collectStaticGoFiles(absolutePath, candidates, depth - 1, maxFiles);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".go")) {
      candidates.add(absolutePath);
    }
  }
}

async function collectStaticRubyFiles(directory: string, candidates: Set<string>, depth: number, maxFiles: number): Promise<void> {
  if (depth < 0 || candidates.size >= maxFiles) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.size >= maxFiles) {
      return;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "coverage", "log", "node_modules", "public", "storage", "tmp", "vendor"].includes(entry.name)) {
        continue;
      }
      await collectStaticRubyFiles(absolutePath, candidates, depth - 1, maxFiles);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".rb")) {
      candidates.add(absolutePath);
    }
  }
}

async function collectStaticJavaFiles(directory: string, candidates: Set<string>, depth: number, maxFiles: number): Promise<void> {
  if (depth < 0 || candidates.size >= maxFiles) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.size >= maxFiles) {
      return;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", ".gradle", "build", "dist", "node_modules", "out", "target"].includes(entry.name)) {
        continue;
      }
      await collectStaticJavaFiles(absolutePath, candidates, depth - 1, maxFiles);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".java")) {
      candidates.add(absolutePath);
    }
  }
}

async function collectStaticDotnetFiles(directory: string, candidates: Set<string>, depth: number, maxFiles: number): Promise<void> {
  if (depth < 0 || candidates.size >= maxFiles) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.size >= maxFiles) {
      return;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "bin", "build", "dist", "node_modules", "obj", "packages"].includes(entry.name)) {
        continue;
      }
      await collectStaticDotnetFiles(absolutePath, candidates, depth - 1, maxFiles);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".cs")) {
      candidates.add(absolutePath);
    }
  }
}

async function collectStaticPhpFiles(directory: string, candidates: Set<string>, depth: number, maxFiles: number): Promise<void> {
  if (depth < 0 || candidates.size >= maxFiles) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.size >= maxFiles) {
      return;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "bootstrap/cache", "cache", "node_modules", "public", "storage", "vendor", "var"].includes(entry.name)) {
        continue;
      }
      await collectStaticPhpFiles(absolutePath, candidates, depth - 1, maxFiles);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".php")) {
      candidates.add(absolutePath);
    }
  }
}

async function collectStaticProtoFiles(directory: string, candidates: Set<string>, depth: number, maxFiles: number): Promise<void> {
  if (depth < 0 || candidates.size >= maxFiles) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.size >= maxFiles) {
      return;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "build", "dist", "node_modules", "obj", "packages", "vendor"].includes(entry.name)) {
        continue;
      }
      await collectStaticProtoFiles(absolutePath, candidates, depth - 1, maxFiles);
      continue;
    }
    if (entry.isFile() && path.extname(entry.name) === ".proto") {
      candidates.add(absolutePath);
    }
  }
}

async function collectStaticJavaScriptFiles(directory: string, candidates: Set<string>, depth: number, maxFiles: number): Promise<void> {
  if (depth < 0 || candidates.size >= maxFiles) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.size >= maxFiles) {
      return;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules"].includes(entry.name)) {
        continue;
      }
      await collectStaticJavaScriptFiles(absolutePath, candidates, depth - 1, maxFiles);
      continue;
    }
    if (entry.isFile() && [".js", ".ts", ".mjs", ".cjs"].includes(path.extname(entry.name))) {
      candidates.add(absolutePath);
    }
  }
}

function fastApiObservedEndpoints(source: string): string[] {
  if (!looksLikeFastApiSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const routePattern = /^\s*@[A-Za-z_][\w.]*\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(routePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = match[2] ?? "";
    if (!method || !route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      break;
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeFastApiSource(source: string): boolean {
  return /\bfrom\s+fastapi\s+import\b|\bimport\s+fastapi\b|\bFastAPI\s*\(|\bAPIRouter\s*\(/.test(source);
}

function flaskObservedEndpoints(source: string): string[] {
  if (!looksLikeFlaskSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const methodRoutePattern = /^\s*@[A-Za-z_][\w.]*\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(methodRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = match[2] ?? "";
    if (!method || !route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      break;
    }
  }

  const routePattern = /^\s*@[A-Za-z_][\w.]*\.route\(\s*["']([^"']+)["']([^)]*)\)/gm;
  for (const match of source.matchAll(routePattern)) {
    const route = match[1] ?? "";
    if (!route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    const methods = flaskRouteMethods(match[2] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeFlaskSource(source: string): boolean {
  return /\bfrom\s+flask\s+import\b|\bimport\s+flask\b|\bFlask\s*\(|\bBlueprint\s*\(/.test(source);
}

function flaskRouteMethods(routeArgs: string): string[] {
  const methodsMatch = /\bmethods\s*=\s*\[([^\]]+)\]/.exec(routeArgs) ?? /\bmethods\s*=\s*\(([^)]*)\)/.exec(routeArgs);
  if (!methodsMatch) {
    return ["GET"];
  }
  const methods = [...(methodsMatch[1] ?? "").matchAll(/["']([A-Za-z]+)["']/g)]
    .map((match) => (match[1] ?? "").toUpperCase())
    .filter((method) => ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method));
  return methods.length ? [...new Set(methods)] : ["GET"];
}

function fastifyObservedEndpoints(source: string): string[] {
  if (!looksLikeFastifySource(source)) {
    return [];
  }
  const endpoints: string[] = [];

  const directRoutePattern = /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toLowerCase();
    const route = fastifyRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    if (method === "all") {
      for (const allMethod of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
        endpoints.push(`${allMethod} ${route}`);
      }
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
      continue;
    }
    endpoints.push(`${method.toUpperCase()} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const routeMethodPattern = /\b[A-Za-z_$][\w$]*\.route\s*\(\s*\{([\s\S]{0,260}?)\}\s*\)/g;
  for (const match of source.matchAll(routeMethodPattern)) {
    const routeConfig = match[1] ?? "";
    const route = fastifyRoutePath(routeConfig);
    if (!route) {
      continue;
    }
    const methods = fastifyRouteMethods(routeConfig);
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeFastifySource(source: string): boolean {
  return /\bfrom\s+fastify\s+import\b|\bimport\s+fastify\b|\bFastify\b|\bfastify\s*\(\s*\)/.test(source);
}

function fastifyRoutePath(routeConfig: string): string | null {
  if (routeConfig.startsWith("/") && !/\s/.test(routeConfig) && !routeConfig.includes("${") && !routeConfig.includes("`")) {
    return routeConfig;
  }
  const quotedPathMatch = /\b(?:url|path)\s*:\s*(["'`])([^"'`]+)\1/.exec(routeConfig);
  if (quotedPathMatch) {
    const normalized = quotedPathMatch[2] ?? "";
    if (!normalized || !normalized.startsWith("/") || /\s/.test(normalized) || normalized.includes("${") || normalized.includes("`")) {
      return null;
    }
    return normalized;
  }
  const backtickPathMatch = /\b(?:url|path)\s*:\s*`([^`]+)`/.exec(routeConfig);
  if (backtickPathMatch) {
    return null;
  }
  return null;
}

function fastifyRouteMethods(routeConfig: string): string[] {
  const methodMatch = /\b(?:method)\s*:\s*(\[[^\]]+\]|["'][A-Za-z]+["'])/.exec(routeConfig);
  if (!methodMatch) {
    return ["GET"];
  }
  const raw = methodMatch[1] ?? "";
  const methods = new Set<string>();
  for (const match of raw.matchAll(/["']([A-Za-z]+)["']/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  return methods.size ? [...methods] : ["GET"];
}

function starletteObservedEndpoints(source: string): string[] {
  if (!looksLikeStarletteSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const routePattern = /\bRoute\(\s*["']([^"']+)["']([^)]*)\)/g;
  for (const match of source.matchAll(routePattern)) {
    const route = match[1] ?? "";
    if (!route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    const methods = pythonRouteMethods(match[2] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const addRoutePattern = /\.[A-Za-z_]*(?:add_route|add_api_route)\(\s*["']([^"']+)["']([^)]*)\)/g;
  for (const match of source.matchAll(addRoutePattern)) {
    const route = match[1] ?? "";
    if (!route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    const methods = pythonRouteMethods(match[2] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeStarletteSource(source: string): boolean {
  return /\bfrom\s+starlette\b|\bimport\s+starlette\b|\bStarlette\s*\(|\bfrom\s+fastapi\s+import\b|\bFastAPI\s*\(/.test(source);
}

function djangoObservedEndpoints(source: string): string[] {
  if (!looksLikeDjangoSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const routePattern = /\b(?:path|re_path)\(\s*(?:r|R)?["']([^"']+)["']/g;
  for (const match of source.matchAll(routePattern)) {
    const route = djangoRoutePath(match[1] ?? "");
    if (!route) {
      continue;
    }
    endpoints.push(`${inferredStaticRouteMethod(route)} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeDjangoSource(source: string): boolean {
  return /\bfrom\s+django\.urls\s+import\b|\bimport\s+django\.urls\b|\burlpatterns\s*=|\bfrom\s+rest_framework\b|\bimport\s+rest_framework\b/.test(source);
}

function djangoRoutePath(route: string): string | null {
  let normalized = route.trim();
  if (!normalized || /\s/.test(normalized)) {
    return null;
  }
  normalized = normalized.replace(/^\^/, "").replace(/\$$/, "").replaceAll("\\/", "/");
  if (/[()[\]|?+*]/.test(normalized)) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function expressObservedEndpoints(source: string): string[] {
  if (!looksLikeExpressSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /\b[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = expressRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const routeChainPattern = /\b[A-Za-z_$][\w$]*\s*\.\s*route\s*\(\s*(["'`])([^"'`]+)\1\s*\)((?:\s*\.\s*(?:get|post|put|patch|delete|options|head)\s*\([^;]*)+)/g;
  for (const match of source.matchAll(routeChainPattern)) {
    const route = expressRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    for (const methodMatch of (match[3] ?? "").matchAll(/\.\s*(get|post|put|patch|delete|options|head)\s*\(/g)) {
      endpoints.push(`${(methodMatch[1] ?? "").toUpperCase()} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeExpressSource(source: string): boolean {
  return /\brequire\s*\(\s*["']express["']\s*\)|\bfrom\s+["']express["']|\bimport\s+express\b|\bexpress\s*\.\s*Router\s*\(|\bRouter\s*\(\s*\)/.test(source);
}

function expressRoutePath(route: string): string | null {
  const normalized = route.trim();
  if (!normalized.startsWith("/") || /\s/.test(normalized) || normalized.includes("${")) {
    return null;
  }
  return normalized;
}

function koaObservedEndpoints(source: string): string[] {
  if (!looksLikeKoaSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /\b(?:[A-Za-z_$][\w$]*|app|router)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = expressRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const routeChainPattern = /\b(?:[A-Za-z_$][\w$]*|app|router)\.route\s*\(\s*(["'`])([^"'`]+)\1[^)]*\)\s*((?:\.[a-z]+\s*\([^;]*)+)/g;
  for (const match of source.matchAll(routeChainPattern)) {
    const route = expressRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const chainMethods = koaRouteChainMethods(match[3] ?? "");
    for (const method of chainMethods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeKoaSource(source: string): boolean {
  return /\bfrom\s+["']koa["']|\bimport\s+Koa\b|\bnew\s+Koa\s*\(|\bfrom\s+["']@koa\/router["']|\bnew\s+Router\s*\(|\bkoa-router\b/.test(source);
}

function koaRouteChainMethods(routeChain: string): string[] {
  const methods = new Set<string>();
  for (const methodMatch of routeChain.matchAll(/\.\s*(get|post|put|patch|delete|options|head)\s*\(/g)) {
    methods.add((methodMatch[1] ?? "").toUpperCase());
  }
  return methods.size ? [...methods] : [];
}

function honoObservedEndpoints(source: string): string[] {
  if (!looksLikeHonoSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /\b(?:[A-Za-z_$][\w$]*|app|router)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = expressRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const onRoutePattern = /\b(?:[A-Za-z_$][\w$]*|app|router)\.on\s*\(\s*(\[[^\]]+\]|["'][A-Za-z]+["'])\s*,\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(onRoutePattern)) {
    const methods = honoRouteMethods(match[1] ?? "");
    const route = expressRoutePath(match[3] ?? "");
    if (!route) {
      continue;
    }
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeHonoSource(source: string): boolean {
  return /\bfrom\s+["']hono["']|\bimport\s+\{\s*Hono\s*\}\s+from\s+["']hono["']|\bnew\s+Hono\s*\(/.test(source);
}

function honoRouteMethods(routeMethods: string): string[] {
  const methods = new Set<string>();
  for (const methodMatch of routeMethods.matchAll(/["']([A-Za-z]+)["']/g)) {
    const method = (methodMatch[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  return methods.size ? [...methods] : ["GET"];
}

function nestJsObservedEndpoints(source: string): string[] {
  if (!looksLikeNestJsSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const routeMethodPattern = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:(["']([^"']+)["']|`([^`]+)`)(?:\s*,\s*[^)]*)?)?\s*\)/g;
  const controllerMatch = /@Controller\s*\(\s*(["']([^"']+)["']|`([^`]+)`)?\s*\)/.exec(source);
  const controller = nestJsPathFromMatch(controllerMatch);

  for (const match of source.matchAll(routeMethodPattern)) {
    const fullDecorator = (match[0] ?? "").trim();
    const methodNameMatch = /@(Get|Post|Put|Patch|Delete|Options|Head|All)/.exec(fullDecorator);
    const methodName = (methodNameMatch?.[1] ?? "").toUpperCase();
    const methods = methodName === "ALL" ? ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] : [methodName];
    const normalizedMethodPath = (match[3] ?? match[4] ?? "").trim();
    const route = nestJsRoutePath(normalizedMethodPath);
    if (!route) {
      continue;
    }
    const fullRoute = combineNestJsRoute(controller, route);
    if (!fullRoute) {
      continue;
    }
    for (const method of methods) {
      endpoints.push(`${method} ${fullRoute}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeNestJsSource(source: string): boolean {
  return /\bimport\s+\{[^}]*\b(?:Get|Post|Put|Patch|Delete|Options|Head|All|Controller|Module)\b[^}]*\}\s+from\s+["']@nestjs\/common["']|\b@Controller\b|\b@Get\b|\b@Post\b|\b@Put\b|\b@Patch\b|\b@Delete\b|\b@Options\b|\b@Head\b|\b@All\b/.test(source);
}

function nextJsObservedEndpoints(source: string): string[] {
  if (!looksLikeNextJsSource(source)) {
    return [];
  }
  const methods = new Set<string>();
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (method) {
      methods.add(method);
    }
  }
  return methods.size ? [...methods] : [];
}

function looksLikeNextJsSource(source: string): boolean {
  return /\bfrom\s+["']next\/server["']|\bNextRequest\b|\bNextResponse\b|\bexport\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/.test(source);
}

function isNextJsApiRouteCandidate(relativePath: string): boolean {
  return /^app\/(?:.*\/)?route\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(relativePath) || /^pages\/api\/.*\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(relativePath);
}

function nextJsRoutePath(relativePath: string): string | null {
  const routePath = relativePath.replaceAll(path.sep, "/");
  if (/^app\/(?:.*\/)?route\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(routePath)) {
    const withoutPrefix = routePath.replace(/^app\//, "");
    const segments = withoutPrefix.split("/");
    segments.pop();
    return nextJsSegmentsToRoute(segments);
  }
  if (/^pages\/api\/.*\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(routePath)) {
    const withoutPrefix = routePath
      .replace(/^pages\/api\//, "")
      .replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, "");
    const segments = withoutPrefix.split("/");
    const routeSuffix = nextJsSegmentsToRoute(segments);
    if (!routeSuffix) {
      return null;
    }
    return routeSuffix === "/" ? "/api" : `/api${routeSuffix}`;
  }
  return null;
}

function nextJsSegmentsToRoute(segments: string[]): string | null {
  const filtered = segments.flatMap((segment) => {
    const normalized = nextJsNormalizeSegment(segment);
    if (!normalized) {
      return [];
    }
    return [normalized];
  });
  if (!filtered.length) {
    return "/";
  }
  const route = `/${filtered.join("/")}`;
  return route === "/index" ? "/" : route;
}

function nextJsNormalizeSegment(segment: string): string | null {
  if (!segment || segment === "index" || segment.startsWith(".") || segment === "") {
    return null;
  }
  const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment);
  if (optionalCatchAll) {
    return `{${optionalCatchAll[1]}}`;
  }
  const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
  if (catchAll) {
    return `{${catchAll[1]}}`;
  }
  const dynamic = /^\[([^\]]+)\]$/.exec(segment);
  if (dynamic) {
    return `{${dynamic[1]}}`;
  }
  return segment;
}

function legacyHttpObservedEndpoints(source: string): string[] {
  const endpoints: string[] = [
    ...legacyPythonObservedEndpoints(source),
    ...legacyNodeObservedEndpoints(source),
    ...legacyGoObservedEndpoints(source),
  ];
  return uniqueObservedEndpoints(endpoints);
}

function legacyPythonObservedEndpoints(source: string): string[] {
  if (!looksLikeLegacyPythonHttpSource(source)) {
    return [];
  }
  const endpoints = new Set<string>();
  const baseServerPattern = /\b(?:self|request)\.path(?:\s*===?\s*|\s*==\s*|\s*\.startswith\(\s*)(["'`])(\/[^"'`]+)\1/g;

  let currentHandlerMethod: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const handlerMatch = /\bdef\s+do_(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/i.exec(line);
    if (handlerMatch) {
      currentHandlerMethod = (handlerMatch[1] ?? "").toUpperCase();
    } else if (/^\s*def\s+/.test(line)) {
      currentHandlerMethod = null;
    }
    for (const match of line.matchAll(baseServerPattern)) {
      const route = normalizeLegacyRoutePath(match[2] ?? "");
      if (!route) {
        continue;
      }
      if (currentHandlerMethod) {
        endpoints.add(`${currentHandlerMethod} ${route}`);
        continue;
      }
      endpoints.add(`GET ${route}`);
      endpoints.add(`POST ${route}`);
    }
  }

  return [...endpoints];
}

function legacyNodeObservedEndpoints(source: string): string[] {
  if (!looksLikeLegacyNodeHttpSource(source)) {
    return [];
  }
  const endpoints = new Set<string>();

  for (const match of source.matchAll(/\breq(?:uest)?\.(?:url|path)\s*(?:===|==)\s*(["'`])([\/][^"'`]+)\1/g)) {
    const route = normalizeLegacyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.add(`GET ${route}`);
  }

  for (const match of source.matchAll(/\breq(?:uest)?\.(?:url|path)\.startsWith\(\s*(["'`])([\/][^"'`]+)\1/g)) {
    const route = normalizeLegacyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.add(`GET ${route}`);
  }

  return [...endpoints];
}

function legacyGoObservedEndpoints(source: string): string[] {
  if (!looksLikeLegacyGoHttpSource(source)) {
    return [];
  }
  const endpoints = new Set<string>();
  for (const match of source.matchAll(/HandleFunc\s*\(\s*(["'])(\/[^"']+)\1\s*,/g)) {
    const route = normalizeLegacyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.add(`GET ${route}`);
  }
  for (const match of source.matchAll(/Handle\s*\(\s*(["'])(\/[^"']+)\1\s*,/g)) {
    const route = normalizeLegacyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.add(`GET ${route}`);
  }
  return [...endpoints];
}

function looksLikeLegacyPythonHttpSource(source: string): boolean {
  return /\bfrom\s+http\.server\s+import\b|\bimport\s+http\.server\b|\bfrom\s+wsgiref\.simple_server\s+import\b|\bmake_server\s*\(/.test(source);
}

function looksLikeLegacyNodeHttpSource(source: string): boolean {
  return /\brequire\s*\(\s*["']http["']\s*\)|\bimport\s+http\b|\bfrom\s+["']http["']/.test(source) && /\bcreateServer\s*\(/.test(source);
}

function looksLikeLegacyGoHttpSource(source: string): boolean {
  return /\bpackage\s+main\b/.test(source) && /\bimport[\s\S]*?net\/http\b/.test(source);
}

function normalizeLegacyRoutePath(route: string): string | null {
  const trimmed = route.trim();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed) || trimmed.includes("${")) {
    return null;
  }
  return trimmed === "//" ? "/" : trimmed;
}

function grpcObservedEndpoints(source: string): string[] {
  if (!looksLikeGrpcSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  for (const serviceMatch of grpcServiceBlocks(source)) {
    const serviceName = serviceMatch.serviceName;
    const serviceBody = serviceMatch.body;
    if (!serviceName || !serviceBody) {
      continue;
    }
    for (const rpcMatch of grpcRpcBlocks(serviceBody)) {
      const methodName = rpcMatch.methodName;
      const rpcBody = rpcMatch.body;
      const mappedEndpoints = grpcHttpMappedEndpoints(rpcBody, methodName);
      if (mappedEndpoints.length) {
        for (const endpoint of mappedEndpoints) {
          endpoints.push(endpoint);
          if (endpoints.length >= 100) {
            return uniqueObservedEndpoints(endpoints);
          }
        }
        continue;
      }
      endpoints.push(`POST /grpc/${serviceName}/${methodName}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function grpcRpcBlocks(serviceBody: string): Array<{ methodName: string; body: string }> {
  const blocks: Array<{ methodName: string; body: string }> = [];
  const rpcPattern = /rpc\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*returns\s*\([^)]*\)\s*(\{|;)/g;
  for (const match of serviceBody.matchAll(rpcPattern)) {
    const methodName = (match[1] ?? "").trim();
    const terminator = match[2] ?? "";
    if (!methodName || match.index === undefined) {
      continue;
    }
    if (terminator === ";") {
      blocks.push({ methodName, body: ";" });
      continue;
    }
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let cursor = bodyStart;
    while (cursor < serviceBody.length && depth > 0) {
      const char = serviceBody[cursor];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      cursor += 1;
    }
    if (depth === 0) {
      blocks.push({ methodName, body: serviceBody.slice(bodyStart - 1, cursor) });
    }
  }
  return blocks;
}

function grpcServiceBlocks(source: string): Array<{ serviceName: string; body: string }> {
  const blocks: Array<{ serviceName: string; body: string }> = [];
  const servicePattern = /service\s+([A-Za-z_][\w]*)\s*\{/g;
  for (const match of source.matchAll(servicePattern)) {
    const serviceName = (match[1] ?? "").trim();
    const bodyStart = match.index === undefined ? -1 : match.index + match[0].length;
    if (!serviceName || bodyStart < 0) {
      continue;
    }
    let depth = 1;
    let cursor = bodyStart;
    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      cursor += 1;
    }
    if (depth === 0) {
      blocks.push({ serviceName, body: source.slice(bodyStart, cursor - 1) });
    }
  }
  return blocks;
}

function looksLikeGrpcSource(source: string): boolean {
  return /\bservice\s+[A-Za-z_][\w]*\s*\{/.test(source) && /\brpc\s+[A-Za-z_][\w]*\s*\([^)]+\)\s*returns\s*\([^)]+\)/.test(source);
}

function grpcHttpMappedEndpoints(rpcBody: string, fallbackMethodName: string): string[] {
  if (!rpcBody.includes("google.api.http")) {
    return [];
  }
  const httpBlocks = Array.from(rpcBody.matchAll(/option\s*\(\s*google\.api\.http\s*\)\s*=\s*\{([\s\S]*?)\}\s*;/g));
  if (!httpBlocks.length) {
    return [];
  }

  const endpoints: string[] = [];
  for (const block of httpBlocks) {
    const blockBody = block[1] ?? "";
    const mapped = grpcHttpBlockEndpoints(blockBody);
    for (const endpoint of mapped) {
      endpoints.push(endpoint);
    }
  }
  if (!endpoints.length && /option\s*\(\s*google\.api\.http/.test(rpcBody)) {
    const route = grpcHttpBodyToRoute(rpcBody);
    if (route) {
      const candidate = fallbackMethodName ? `/grpc/${fallbackMethodName}` : "/grpc";
      const normalizedRoute = route === "/" ? candidate : route;
      endpoints.push(`POST ${normalizedRoute}`);
    }
  }
  return endpoints;
}

function grpcHttpBlockEndpoints(blockBody: string): string[] {
  const endpoints: string[] = [];
  const methodMap: Record<string, string[]> = {
    get: ["GET"],
    put: ["PUT"],
    post: ["POST"],
    patch: ["PATCH"],
    delete: ["DELETE"],
    options: ["OPTIONS"],
    head: ["HEAD"],
  };
  for (const [methodName, methods] of Object.entries(methodMap)) {
    const rawPath = grpcHttpBodyMethodPath(blockBody, methodName);
    if (!rawPath) {
      continue;
    }
    const normalizedPath = grpcHttpPath(rawPath);
    if (!normalizedPath) {
      continue;
    }
    for (const method of methods) {
      endpoints.push(`${method} ${normalizedPath}`);
    }
  }
  return endpoints;
}

function grpcHttpBodyMethodPath(blockBody: string, methodName: string): string | null {
  const methodBlock = new RegExp(`\\b${methodName}\\s*:\\s*["']([^"']+)["']`, "i").exec(blockBody);
  if (!methodBlock) {
    return null;
  }
  const raw = (methodBlock[1] ?? "").trim();
  if (!raw || !raw.startsWith("/")) {
    return null;
  }
  return raw;
}

function grpcHttpBodyToRoute(source: string): string | null {
  const anyHttp = /google\.api\.http/.exec(source);
  if (!anyHttp) {
    return null;
  }
  const methodPath = /(?:get|post|put|patch|delete|options|head)\s*:\s*["']([^"']+)["']/i.exec(source);
  return grpcHttpPath(methodPath?.[1] ?? "") ?? null;
}

function grpcHttpPath(rawPath: string): string | null {
  if (!rawPath || /\s/.test(rawPath)) {
    return null;
  }
  const normalized = rawPath
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)=[^}]+\}/g, "{$1}")
    .replace(/\\\//g, "/")
    .replace(/\/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : null;
}

function nestJsPathFromMatch(match: RegExpMatchArray | null): string {
  if (!match) {
    return "";
  }
  const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  if (!raw) {
    return "";
  }
  return nestJsPath(raw, true);
}

function nestJsRoutePath(rawPath: string): string | null {
  if (!rawPath) {
    return "/";
  }
  const normalized = rawPath.trim();
  if (!normalized || /\s/.test(normalized) || normalized.includes("${")) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function combineNestJsRoute(controllerPath: string, routePath: string): string | null {
  const normalizedController = nestJsPath(controllerPath, true);
  const normalizedRoute = nestJsPath(routePath);
  if (!normalizedRoute) {
    return null;
  }
  if (!normalizedController) {
    return normalizedRoute;
  }
  const trimmedRoute = normalizedRoute === "/" ? "" : normalizedRoute;
  return trimmedRoute ? `/${normalizedController}/${trimmedRoute.replace(/^\//, "")}` : `/${normalizedController}`;
}

function nestJsPath(rawPath: string, keepSlashless = false): string {
  const normalized = rawPath.trim().replace(/\/+$/g, "").replace(/^[`'"]|[`'"]$/g, "");
  if (!normalized || normalized.includes("${")) {
    return "";
  }
  if (keepSlashless) {
    return normalized;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function goObservedEndpoints(source: string): string[] {
  if (!looksLikeGoWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*(["`])([^"`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = goRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const muxRoutePattern = /\.\s*HandleFunc\s*\(\s*(["`])([^"`]+)\1[^\n;]*\)\s*\.\s*Methods\s*\(([^)]*)\)/g;
  for (const match of source.matchAll(muxRoutePattern)) {
    const route = goRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const methods = goRouteMethods(match[3] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const handleFuncPattern = /(?:\bhttp\s*\.\s*|\.\s*)HandleFunc\s*\(\s*(["`])([^"`]+)\1/g;
  for (const match of source.matchAll(handleFuncPattern)) {
    const route = goRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.push(`${inferredStaticRouteMethod(route)} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeGoWebSource(source: string): boolean {
  return /["`]net\/http["`]|["`]github\.com\/gin-gonic\/gin["`]|["`]github\.com\/labstack\/echo|["`]github\.com\/gofiber\/fiber|["`]github\.com\/go-chi\/chi|["`]github\.com\/gorilla\/mux/.test(source)
    || /\bgin\s*\.\s*Default\s*\(|\becho\s*\.\s*New\s*\(|\bfiber\s*\.\s*New\s*\(|\bchi\s*\.\s*NewRouter\s*\(|\bmux\s*\.\s*NewRouter\s*\(/.test(source);
}

function goRoutePath(route: string): string | null {
  const normalized = route.trim();
  if (!normalized.startsWith("/") || /\s/.test(normalized)) {
    return null;
  }
  return normalized;
}

function goRouteMethods(routeArgs: string): string[] {
  const methods = [...routeArgs.matchAll(/["`]([A-Za-z]+)["`]/g)]
    .map((match) => (match[1] ?? "").toUpperCase())
    .filter((method) => ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method));
  return methods.length ? [...new Set(methods)] : ["GET"];
}

function rubyObservedEndpoints(source: string): string[] {
  if (!looksLikeRubyWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /^\s*(get|post|put|patch|delete|options|head)\s*(?:\(|\s)\s*(["'])([^"']+)\2/gim;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = rubyRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const matchRoutePattern = /^\s*match\s*(?:\(|\s)\s*(["'])([^"']+)\1([^\n]*)/gim;
  for (const match of source.matchAll(matchRoutePattern)) {
    const route = rubyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const methods = rubyRouteMethods(match[3] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const routeMethodPattern = /^\s*route\s+:?(get|post|put|patch|delete|options|head)\s*,\s*(["'])([^"']+)\2/gim;
  for (const match of source.matchAll(routeMethodPattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = rubyRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeRubyWebSource(source: string): boolean {
  return /\bRails\.application\.routes\.draw\b|\bActionDispatch::Routing\b|\brequire\s+["']sinatra(?:\/base)?["']|\bSinatra::Base\b|<\s*Sinatra::Base\b|\bGrape::API\b/.test(source);
}

function rubyRoutePath(route: string): string | null {
  const normalized = route.trim();
  if (!normalized || /\s/.test(normalized) || normalized.includes("#{")) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function rubyRouteMethods(routeArgs: string): string[] {
  const viaMatch = /\bvia:\s*(\[[^\]]+\]|%i\[[^\]]+\]|:[A-Za-z_]+|["'][A-Za-z]+["'])/.exec(routeArgs);
  if (!viaMatch) {
    return ["GET"];
  }
  const raw = (viaMatch[1] ?? "").trim();
  const methods = new Set<string>();
  const percentSymbolList = /^%i\[([^\]]+)\]$/.exec(raw);
  if (percentSymbolList) {
    for (const token of (percentSymbolList[1] ?? "").split(/\s+/)) {
      const method = token.toUpperCase();
      if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
        methods.add(method);
      }
    }
  }
  for (const match of raw.matchAll(/:([A-Za-z_]+)/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  for (const match of raw.matchAll(/["']([A-Za-z]+)["']/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  return methods.size ? [...methods] : ["GET"];
}

function javaObservedEndpoints(source: string): string[] {
  if (!looksLikeJavaWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const classPrefix = javaClassRoutePrefix(source);

  const directMappingPattern = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*(?:\(\s*([^)]*)\))?/g;
  for (const match of source.matchAll(directMappingPattern)) {
    const method = javaMappingAnnotationMethod(match[1] ?? "");
    const route = javaRoutePath(match[2] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${joinStaticRoutePaths(classPrefix, route)}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const requestMappingPattern = /@RequestMapping\s*\(\s*([^)]*)\)/g;
  for (const match of source.matchAll(requestMappingPattern)) {
    const args = match[1] ?? "";
    const route = javaRoutePath(args);
    if (!route || javaAnnotationLooksClassScoped(source, match.index ?? 0)) {
      continue;
    }
    const methods = javaRouteMethods(args, route);
    for (const method of methods) {
      endpoints.push(`${method} ${joinStaticRoutePaths(classPrefix, route)}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const jaxRsRoutePattern = /@(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b[\s\S]{0,240}?@Path\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(jaxRsRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = javaRoutePath(match[2] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${joinStaticRoutePaths(classPrefix, route)}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeJavaWebSource(source: string): boolean {
  return /\b(import\s+org\.springframework\.web\.bind\.annotation\.|@RestController\b|@Controller\b|@RequestMapping\b|@GetMapping\b|@PostMapping\b)/.test(source)
    || /\b(import\s+javax\.ws\.rs\.|import\s+jakarta\.ws\.rs\.|@Path\b|@GET\b|@POST\b)/.test(source);
}

function javaClassRoutePrefix(source: string): string {
  const springClassMatch = /@RequestMapping\s*\(\s*([^)]*)\)\s*(?:\r?\n\s*@\w+(?:\([^)]*\))?\s*){0,8}\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+\w+/m.exec(source);
  if (springClassMatch) {
    return javaRoutePath(springClassMatch[1] ?? "") ?? "";
  }
  const jaxRsClassMatch = /@Path\s*\(\s*["']([^"']+)["']\s*\)\s*(?:\r?\n\s*@\w+(?:\([^)]*\))?\s*){0,8}\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+\w+/m.exec(source);
  if (jaxRsClassMatch) {
    return javaRoutePath(jaxRsClassMatch[1] ?? "") ?? "";
  }
  return "";
}

function javaAnnotationLooksClassScoped(source: string, annotationIndex: number): boolean {
  const afterAnnotation = source.slice(annotationIndex, Math.min(source.length, annotationIndex + 400));
  return /^\s*@RequestMapping[^\n]*(?:\r?\n\s*@\w+(?:\([^)]*\))?\s*){0,8}\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+\w+/m.test(afterAnnotation);
}

function javaMappingAnnotationMethod(annotation: string): string | null {
  const byAnnotation: Record<string, string> = {
    GetMapping: "GET",
    PostMapping: "POST",
    PutMapping: "PUT",
    PatchMapping: "PATCH",
    DeleteMapping: "DELETE",
  };
  return byAnnotation[annotation] ?? null;
}

function javaRoutePath(routeArgs: string): string | null {
  const routeMatch = /(?:value|path)\s*=\s*["']([^"']+)["']/.exec(routeArgs)
    ?? /["']([^"']+)["']/.exec(routeArgs);
  const normalized = (routeMatch?.[1] ?? routeArgs).trim();
  if (!normalized || /\s/.test(normalized) || normalized.includes("${") || normalized.includes("+")) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function javaRouteMethods(routeArgs: string, route: string): string[] {
  const methods = new Set<string>();
  for (const match of routeArgs.matchAll(/RequestMethod\s*\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)) {
    methods.add((match[1] ?? "").toUpperCase());
  }
  return methods.size ? [...methods] : [inferredStaticRouteMethod(route)];
}

function dotnetObservedEndpoints(source: string): string[] {
  if (!looksLikeDotnetWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];

  const minimalRoutePattern = /\.\s*Map(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*(["'])([^"']+)\2/g;
  for (const match of source.matchAll(minimalRoutePattern)) {
    const method = dotnetMinimalApiMethod(match[1] ?? "");
    const route = dotnetRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const mapMethodsPattern = /\.\s*MapMethods\s*\(\s*(["'])([^"']+)\1\s*,\s*(?:new\s*\[\]\s*)?\{([^}]+)\}/g;
  for (const match of source.matchAll(mapMethodsPattern)) {
    const route = dotnetRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const methods = dotnetHttpMethods(match[3] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const classPrefix = dotnetClassRoutePrefix(source);
  const controllerRoutePattern = /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpOptions|HttpHead|Route)\s*(?:\(\s*([^\]]*?)\s*\))?\]\s*(?:\r?\n\s*\[[^\]]+\]\s*){0,8}\s*(?:public|private|protected|internal)\s+(?:async\s+)?[A-Za-z_][\w<>,\s?.]*(?:\s+|\s*\[\]\s*)[A-Za-z_]\w*\s*\(/g;
  for (const match of source.matchAll(controllerRoutePattern)) {
    const annotation = match[1] ?? "";
    const route = dotnetRoutePathFromAttributeArgs(match[2] ?? "");
    if (route === null) {
      continue;
    }
    const method = dotnetAttributeMethod(annotation, route || classPrefix);
    if (!method) {
      continue;
    }
    endpoints.push(`${method} ${joinStaticRoutePaths(classPrefix, route)}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeDotnetWebSource(source: string): boolean {
  return /\bMicrosoft\.AspNetCore\b|\bWebApplication\.CreateBuilder\s*\(|\bMap(?:Get|Post|Put|Patch|Delete|Methods)\s*\(/.test(source)
    || /\[(?:ApiController|Route|HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpOptions|HttpHead)\b/.test(source);
}

function dotnetMinimalApiMethod(annotation: string): string | null {
  const byMethod: Record<string, string> = {
    Get: "GET",
    Post: "POST",
    Put: "PUT",
    Patch: "PATCH",
    Delete: "DELETE",
    Options: "OPTIONS",
    Head: "HEAD",
  };
  return byMethod[annotation] ?? null;
}

function dotnetAttributeMethod(annotation: string, route: string): string | null {
  const byAnnotation: Record<string, string> = {
    HttpGet: "GET",
    HttpPost: "POST",
    HttpPut: "PUT",
    HttpPatch: "PATCH",
    HttpDelete: "DELETE",
    HttpOptions: "OPTIONS",
    HttpHead: "HEAD",
  };
  return byAnnotation[annotation] ?? (annotation === "Route" ? inferredStaticRouteMethod(route) : null);
}

function dotnetClassRoutePrefix(source: string): string {
  const classRoutePattern = /\[Route\s*\(\s*(["'])([^"']+)\1\s*\)\]\s*(?:\r?\n\s*\[[^\]]+\]\s*){0,8}\s*(?:public\s+)?(?:partial\s+)?class\s+([A-Za-z_]\w*)/m;
  const match = classRoutePattern.exec(source);
  if (!match) {
    return "";
  }
  const controllerName = (match[3] ?? "").replace(/Controller$/, "");
  return dotnetRoutePath(match[2] ?? "", controllerName) ?? "";
}

function dotnetRoutePathFromAttributeArgs(routeArgs: string): string | null {
  const routeMatch = /["']([^"']*)["']/.exec(routeArgs);
  if (!routeMatch && routeArgs.trim()) {
    return null;
  }
  return dotnetRoutePath(routeMatch?.[1] ?? "");
}

function dotnetRoutePath(route: string, controllerName?: string): string | null {
  let normalized = route.trim();
  if (normalized.includes("$") || normalized.includes("+") || /\s/.test(normalized)) {
    return null;
  }
  const controllerSegment = controllerName ? controllerName.replace(/Controller$/, "").toLowerCase() : "controller";
  normalized = normalized
    .replaceAll("[controller]", controllerSegment)
    .replaceAll("[Controller]", controllerSegment)
    .replaceAll("[action]", "action")
    .replaceAll("[Action]", "action");
  return normalized.startsWith("/") || !normalized ? normalized : `/${normalized}`;
}

function dotnetHttpMethods(routeArgs: string): string[] {
  const methods = [...routeArgs.matchAll(/["']([A-Za-z]+)["']/g)]
    .map((match) => (match[1] ?? "").toUpperCase())
    .filter((method) => ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method));
  return methods.length ? [...new Set(methods)] : ["GET"];
}

function phpObservedEndpoints(source: string): string[] {
  if (!looksLikePhpWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];

  const directRoutePattern = /\b(?:Route::|->)(get|post|put|patch|delete|options|head|any)\s*\(\s*(["'])([^"']+)\2/gim;
  for (const match of source.matchAll(directRoutePattern)) {
    const rawMethod = (match[1] ?? "").toLowerCase();
    const route = phpRoutePath(match[3] ?? "");
    if (!route) {
      continue;
    }
    const method = rawMethod === "any" ? inferredStaticRouteMethod(route) : rawMethod.toUpperCase();
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const methodListRoutePattern = /\b(?:Route::|->)(?:match|map)\s*\(\s*(\[[^\]]+\]|array\s*\([^)]*\))\s*,\s*(["'])([^"']+)\2/gim;
  for (const match of source.matchAll(methodListRoutePattern)) {
    const route = phpRoutePath(match[3] ?? "");
    if (!route) {
      continue;
    }
    for (const method of phpRouteMethods(match[1] ?? "")) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const symfonyAttributePattern = /#\[Route\s*\(\s*(?:path\s*:\s*)?(["'])([^"']+)\1([\s\S]{0,240}?)\)\]\s*(?:\r?\n\s*#\[[^\]]+\]\s*){0,8}\s*(?:public|private|protected)?\s*function\b/gm;
  for (const match of source.matchAll(symfonyAttributePattern)) {
    const route = phpRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const methods = phpRouteMethods(match[3] ?? "");
    for (const method of methods.length ? methods : [inferredStaticRouteMethod(route)]) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikePhpWebSource(source: string): boolean {
  return /\bIlluminate\\Support\\Facades\\Route\b|\bRoute::(?:get|post|put|patch|delete|match|any|options|head)\s*\(/.test(source)
    || /->(?:get|post|put|patch|delete|map|any|options|head)\s*\(/.test(source)
    || /\bSlim\\Factory\\AppFactory\b|\bSymfony\\Component\\Routing\\Annotation\\Route\b|#\[Route\s*\(/.test(source);
}

function phpRoutePath(route: string): string | null {
  const normalized = route.trim();
  if (!normalized || /\s/.test(normalized) || normalized.includes("$") || normalized.includes(" . ")) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function phpRouteMethods(routeArgs: string): string[] {
  const methods = new Set<string>();
  for (const match of routeArgs.matchAll(/["']([A-Za-z]+)["']/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  for (const match of routeArgs.matchAll(/\bMETHOD_(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)) {
    methods.add((match[1] ?? "").toUpperCase());
  }
  return [...methods];
}

function joinStaticRoutePaths(prefix: string, route: string): string {
  const cleanPrefix = prefix.trim();
  const cleanRoute = route.trim();
  if (!cleanPrefix || cleanPrefix === "/") {
    return cleanRoute || "/";
  }
  if (!cleanRoute || cleanRoute === "/") {
    return cleanPrefix.startsWith("/") ? cleanPrefix : `/${cleanPrefix}`;
  }
  return `${cleanPrefix.replace(/\/+$/, "")}/${cleanRoute.replace(/^\/+/, "")}`;
}

function inferredStaticRouteMethod(route: string): "GET" | "POST" {
  const lowerRoute = route.toLowerCase();
  if (/\/(?:predict|prediction|infer|inference|classify|score|evaluate|backtest|feedback|retraining)(?:\/|$)/.test(lowerRoute)) {
    return "POST";
  }
  return "GET";
}

function pythonRouteMethods(routeArgs: string): string[] {
  const methodsMatch = /\bmethods\s*=\s*\[([^\]]+)\]/.exec(routeArgs) ?? /\bmethods\s*=\s*\(([^)]*)\)/.exec(routeArgs) ?? /\bmethods\s*=\s*\{([^}]*)\}/.exec(routeArgs);
  if (!methodsMatch) {
    return ["GET"];
  }
  const methods = [...(methodsMatch[1] ?? "").matchAll(/["']([A-Za-z]+)["']/g)]
    .map((match) => (match[1] ?? "").toUpperCase())
    .filter((method) => ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method));
  return methods.length ? [...new Set(methods)] : ["GET"];
}

function uniqueObservedEndpoints(endpoints: string[]): string[] {
  return [...new Set(endpoints.filter((endpoint) => /^[A-Z]+ \/[^\s]*$/.test(endpoint)))].slice(0, 100);
}

function dockerSafeImageTagPart(value: string): string {
  const normalized = slugify(value)
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || "runtime";
}

const openApiHttpMethods = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

function openApiObservedEndpoints(spec: Record<string, unknown>): string[] {
  const paths = isRecord(spec.paths) ? spec.paths : {};
  const endpoints: string[] = [];
  for (const route of Object.keys(paths).sort()) {
    if (!route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    const pathItem = isRecord(paths[route]) ? paths[route] : {};
    for (const method of openApiHttpMethods) {
      if (isRecord(pathItem[method])) {
        endpoints.push(`${method.toUpperCase()} ${route}`);
      }
    }
  }
  return endpoints.slice(0, 100);
}

function openApiObservedOperations(spec: Record<string, unknown>) {
  const paths = isRecord(spec.paths) ? spec.paths : {};
  const operations: Array<{
    method: string;
    path: string;
    operationId: string | null;
    summary: string | null;
    description: string | null;
    requestBodyRequired: boolean;
    requestContentTypes: string[];
    requestSchema: string | null;
    requestExample: unknown;
    requestValidation: OpenApiSchemaValidationDescriptor | null;
    responses: Array<{ status: string; description: string | null; contentTypes: string[]; schema: string | null; example: unknown; validation: OpenApiSchemaValidationDescriptor | null }>;
  }> = [];
  for (const route of Object.keys(paths).sort()) {
    if (!route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    const pathItem = isRecord(paths[route]) ? paths[route] : {};
    for (const method of openApiHttpMethods) {
      const operation = isRecord(pathItem[method]) ? pathItem[method] : null;
      if (!operation) {
        continue;
      }
      const requestBody = isRecord(operation.requestBody) ? operation.requestBody : {};
      const requestContent = openApiContentPreview(requestBody.content);
      operations.push({
        method: method.toUpperCase(),
        path: route,
        operationId: scrapeString(operation.operationId) || null,
        summary: scrapeString(operation.summary) || null,
        description: scrapeString(operation.description) || null,
        requestBodyRequired: requestBody.required === true,
        requestContentTypes: requestContent.contentTypes,
        requestSchema: requestContent.schema,
        requestExample: requestContent.example,
        requestValidation: requestContent.validation,
        responses: openApiResponsePreviews(operation.responses),
      });
    }
  }
  return operations.slice(0, 100);
}

function openApiResponsePreviews(value: unknown): Array<{ status: string; description: string | null; contentTypes: string[]; schema: string | null; example: unknown; validation: OpenApiSchemaValidationDescriptor | null }> {
  const responses = isRecord(value) ? value : {};
  return Object.keys(responses).sort().slice(0, 12).map((status) => {
    const response = isRecord(responses[status]) ? responses[status] : {};
    const content = openApiContentPreview(response.content);
    return {
      status,
      description: scrapeString(response.description) || null,
      contentTypes: content.contentTypes,
      schema: content.schema,
      example: content.example,
      validation: content.validation,
    };
  });
}

function openApiContentPreview(value: unknown): { contentTypes: string[]; schema: string | null; example: unknown; validation: OpenApiSchemaValidationDescriptor | null } {
  const content = isRecord(value) ? value : {};
  const contentTypes = Object.keys(content).sort().slice(0, 8);
  const schema = contentTypes
    .map((contentType) => {
      const mediaType = content[contentType];
      return isRecord(mediaType) ? mediaType.schema : null;
    })
    .find((candidate) => candidate !== null && candidate !== undefined) ?? null;
  return {
    contentTypes,
    schema: openApiSchemaSummary(schema),
    example: openApiSchemaExample(schema),
    validation: openApiSchemaValidationDescriptor(schema),
  };
}

function openApiSchemaValidationDescriptor(value: unknown, depth = 0): OpenApiSchemaValidationDescriptor | null {
  if (!isRecord(value) || depth > 4) {
    return null;
  }
  const schema = value;
  const propertiesRaw = isRecord(schema.properties) ? schema.properties : {};
  const properties: Record<string, OpenApiSchemaValidationDescriptor> = {};
  for (const key of Object.keys(propertiesRaw).sort().slice(0, 50)) {
    const descriptor = openApiSchemaValidationDescriptor(propertiesRaw[key], depth + 1);
    if (descriptor) {
      properties[key] = descriptor;
    }
  }
  const items = openApiSchemaValidationDescriptor(schema.items, depth + 1);
  const type = openApiSchemaValidationType(schema);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string").slice(0, 50)
    : [];
  const enumValues = Array.isArray(schema.enum) ? schema.enum.slice(0, 50) : [];
  if (!type && !required.length && !Object.keys(properties).length && !items && !enumValues.length) {
    return null;
  }
  return {
    type,
    required,
    properties,
    items,
    enumValues,
    nullable: schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes("null")),
  };
}

function openApiSchemaValidationType(schema: Record<string, unknown>): string | null {
  if (typeof schema.type === "string") {
    return schema.type;
  }
  if (Array.isArray(schema.type)) {
    const type = schema.type.find((item) => typeof item === "string" && item !== "null");
    return typeof type === "string" ? type : null;
  }
  if (isRecord(schema.properties)) {
    return "object";
  }
  if (isRecord(schema.items)) {
    return "array";
  }
  return null;
}

function openApiSchemaValidationDescriptorFromPayload(value: unknown, fieldName: string): OpenApiSchemaValidationDescriptor | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new WorkspaceError(`${fieldName} deve ser um descritor de schema OpenAPI.`, 400);
  }
  return openApiSchemaValidationDescriptorPayloadRecord(value, fieldName, 0);
}

function openApiSchemaValidationDescriptorPayloadRecord(value: Record<string, unknown>, fieldName: string, depth: number): OpenApiSchemaValidationDescriptor {
  if (depth > 4) {
    return {
      type: null,
      required: [],
      properties: {},
      items: null,
      enumValues: [],
      nullable: false,
    };
  }
  const type = scrapeString(value.type) || null;
  const required = Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === "string").slice(0, 50) : [];
  const enumValues = Array.isArray(value.enumValues) ? value.enumValues.slice(0, 50) : [];
  const propertiesRaw = isRecord(value.properties) ? value.properties : {};
  const properties: Record<string, OpenApiSchemaValidationDescriptor> = {};
  for (const key of Object.keys(propertiesRaw).sort().slice(0, 50)) {
    if (!isRecord(propertiesRaw[key])) {
      throw new WorkspaceError(`${fieldName}.properties.${key} deve ser objeto.`, 400);
    }
    properties[key] = openApiSchemaValidationDescriptorPayloadRecord(propertiesRaw[key], `${fieldName}.properties.${key}`, depth + 1);
  }
  const items = isRecord(value.items)
    ? openApiSchemaValidationDescriptorPayloadRecord(value.items, `${fieldName}.items`, depth + 1)
    : null;
  return {
    type,
    required,
    properties,
    items,
    enumValues,
    nullable: value.nullable === true,
  };
}

function openApiUncheckedValidationResult(): OpenApiSchemaValidationResult {
  return { checked: false, ok: true, issues: [] };
}

function openApiValidateValue(value: unknown, descriptor: OpenApiSchemaValidationDescriptor): OpenApiSchemaValidationResult {
  const issues: string[] = [];
  openApiValidateValueInto(value, descriptor, "$", issues);
  return {
    checked: true,
    ok: issues.length === 0,
    issues: issues.slice(0, 25),
  };
}

function openApiValidateValueInto(value: unknown, descriptor: OpenApiSchemaValidationDescriptor, pathName: string, issues: string[]): void {
  if (issues.length >= 25) {
    return;
  }
  if (value === null || value === undefined) {
    if (!descriptor.nullable) {
      issues.push(`${pathName} é obrigatório`);
    }
    return;
  }
  if (descriptor.enumValues.length && !descriptor.enumValues.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    issues.push(`${pathName} não está no enum esperado`);
    return;
  }
  if (descriptor.type === "object") {
    if (!isRecord(value)) {
      issues.push(`${pathName} deve ser objeto`);
      return;
    }
    for (const requiredKey of descriptor.required) {
      if (!Object.hasOwn(value, requiredKey)) {
        issues.push(`${pathName}.${requiredKey} é obrigatório`);
      }
    }
    for (const [key, child] of Object.entries(descriptor.properties)) {
      if (Object.hasOwn(value, key)) {
        openApiValidateValueInto(value[key], child, `${pathName}.${key}`, issues);
      }
    }
    return;
  }
  if (descriptor.type === "array") {
    if (!Array.isArray(value)) {
      issues.push(`${pathName} deve ser array`);
      return;
    }
    if (descriptor.items) {
      value.slice(0, 25).forEach((item, index) => openApiValidateValueInto(item, descriptor.items as OpenApiSchemaValidationDescriptor, `${pathName}[${index}]`, issues));
    }
    return;
  }
  if (descriptor.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
    issues.push(`${pathName} deve ser integer`);
    return;
  }
  if (descriptor.type === "number" && typeof value !== "number") {
    issues.push(`${pathName} deve ser number`);
    return;
  }
  if (descriptor.type === "string" && typeof value !== "string") {
    issues.push(`${pathName} deve ser string`);
    return;
  }
  if (descriptor.type === "boolean" && typeof value !== "boolean") {
    issues.push(`${pathName} deve ser boolean`);
  }
}

function openApiSchemaSummary(value: unknown): string | null {
  const schema = isRecord(value) ? value : {};
  const ref = scrapeString(schema.$ref);
  if (ref) {
    return ref;
  }
  const type = scrapeString(schema.type);
  const format = scrapeString(schema.format);
  const items = isRecord(schema.items) ? openApiSchemaSummary(schema.items) : null;
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties).sort().slice(0, 8) : [];
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  const enumValues = Array.isArray(schema.enum) ? schema.enum.slice(0, 8).map((item) => JSON.stringify(item)).join(", ") : "";
  const parts = [
    type ? `type=${type}` : null,
    format ? `format=${format}` : null,
    items ? `items(${items})` : null,
    properties.length ? `properties=${properties.join(", ")}` : null,
    required.length ? `required=${required.join(", ")}` : null,
    enumValues ? `enum=${enumValues}` : null,
  ].filter((item): item is string => !!item);
  return parts.length ? parts.join("; ") : null;
}

function openApiSchemaExample(value: unknown): unknown {
  const schema = isRecord(value) ? value : {};
  if (Object.hasOwn(schema, "example")) {
    return schema.example;
  }
  if (Object.hasOwn(schema, "default")) {
    return schema.default;
  }
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum[0];
  }
  const type = scrapeString(schema.type);
  if (type === "object" || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(properties).sort().slice(0, 8)) {
      result[key] = openApiSchemaExample(properties[key]);
    }
    return result;
  }
  if (type === "array") {
    return [openApiSchemaExample(schema.items)];
  }
  if (type === "integer") {
    return 0;
  }
  if (type === "number") {
    return 0;
  }
  if (type === "boolean") {
    return true;
  }
  if (type === "string") {
    const format = scrapeString(schema.format);
    if (format === "date-time") {
      return "2026-01-01T00:00:00.000Z";
    }
    if (format === "date") {
      return "2026-01-01";
    }
    if (format === "email") {
      return "user@example.com";
    }
    return "string";
  }
  return null;
}

function parseDockerfileLabels(dockerfile: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const normalized = dockerfile.replace(/\\\r?\n\s*/g, " ");
  for (const line of normalized.split(/\r?\n/)) {
    const match = /^\s*LABEL\s+(.+)$/i.exec(line);
    if (!match) {
      continue;
    }
    const body = match[1] ?? "";
    const tokenPattern = /([A-Za-z0-9_.-]+)=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/g;
    for (const token of body.matchAll(tokenPattern)) {
      labels[token[1] as string] = unquoteDockerfileLabelValue(token[2] as string);
    }
  }
  return labels;
}

function unquoteDockerfileLabelValue(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'");
  }
  return value;
}

function parseComposeLabels(value: unknown): Record<string, string> {
  if (isRecord(value)) {
    return sanitizeStringRecord(value);
  }
  if (!Array.isArray(value)) {
    return {};
  }
  const labels: Record<string, string> = {};
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const separator = item.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    labels[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return labels;
}

function mlopsLabelObservedEndpoints(labels: Record<string, string>): string[] {
  const raw = labels["io.mlops-flow.endpoints"];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const endpoints = parsed
          .filter((endpoint): endpoint is string => typeof endpoint === "string" && /^[A-Z]+ \/[^\s]*$/.test(endpoint))
          .slice(0, 100);
        if (endpoints.length) {
          return [...new Set(endpoints)];
        }
      }
    } catch {
      return ["POST /predict"];
    }
  }
  return labels["io.mlops-flow.contract"] ? ["POST /predict"] : [];
}

function preferredPredictionEndpoint(endpoints: string[]): string {
  return endpoints.find((endpoint) => endpoint === "POST /predict")
    ?? endpoints.find((endpoint) => endpoint.startsWith("POST "))
    ?? endpoints[0]
    ?? "POST /predict";
}

function dockerImageBlackBoxProjectBundle(targetProjectId: string, imageRef: string, sourceDockerPort: number, inspect: Record<string, unknown>, runtimeEndpoints?: string[], containerSandboxed = false): { project: MLOpsProject; pipeline: PipelineFlow } {
  const labels = dockerImageLabels(inspect);
  const imageName = labels["io.mlops-flow.project-name"] || dockerImageDisplayName(inspect) || imageRef;
  const activeModelId = labels["io.mlops-flow.active-model-id"] || "modelo_docker";
  const executionProfile = remoteBlackBoxExecutionProfile(labels["io.mlops-flow.execution-profile"]);
  const observedEndpoints = uniqueObservedEndpoints(runtimeEndpoints && runtimeEndpoints.length ? runtimeEndpoints : dockerImageObservedEndpoints(inspect));
  const inspectionModeDescription = containerSandboxed
    ? "A imagem foi inspecionada por docker image inspect e por leitura sandboxada de OpenAPI, sem rede e com filesystem read-only."
    : "A imagem foi inspecionada, mas nenhum container foi executado.";
  const baseUrl = `http://127.0.0.1:${sourceDockerPort}`;
  const project = parseMLOpsProject({
    id: targetProjectId,
    name: `Imagem Docker ${imageName}`,
    version: labels["io.mlops-flow.project-version"] || "0.1.0",
    contract: CONTRACT_VERSION,
    description: `Importação black-box controlada da imagem Docker ${imageRef}. ${inspectionModeDescription}`,
    problem: {
      type: "multiclass_classification",
      target: "prediction",
      classes: ["unknown"],
      classDependencies: [],
    },
    execution: { profile: executionProfile },
    metrics: { primary: "latency_p95_ms", secondary: ["prediction_count", "runtime_errors"] },
    dataSources: [
      {
        id: "docker_image_api",
        type: "api",
        label: "Runtime Docker black-box",
        description: containerSandboxed
          ? "Fonte sintética criada por inspeção read-only e leitura sandboxada de OpenAPI da imagem. Suba a imagem de forma controlada antes de executar chamadas reais."
          : "Fonte sintética criada por inspeção read-only da imagem. Suba a imagem de forma controlada antes de executar chamadas reais.",
        sensitive: true,
        api: {
          method: "POST",
          url: `${baseUrl}/predict`,
          headers: {},
          bodyTemplate: { input: { type: "object", description: "Payload enviado ao runtime Docker." } },
          mocks: [
            {
              id: "docker_image_black_box_contract",
              description: "Mock mínimo para testes seguros sem chamar a imagem Docker.",
              request: { input: { type: "object" } },
              response: { prediction: "unknown", model_version_id: activeModelId },
            },
          ],
          pagination: { mode: "none" },
          timeoutSeconds: 30,
        },
        schema: {
          input: { type: "object" },
          prediction: { type: "string" },
          model_version_id: { type: "string" },
        },
        sensitiveFields: [],
      },
    ],
    pipelineRef: "pipeline.flow.json",
    promotionPolicy: { id: "docker-image-black-box-policy", mode: "manual_approval", baseline: "active_model", rules: [] },
    runtime: {
      apiName: "Runtime Docker black-box",
      routePrefix: "",
      persistence: { primary: "external_postgres", databaseUrlRef: "env:DOCKER_RUNTIME_DATABASE_URL" },
      dashboard: { enabled: true, pages: ["overview", "models", "prediction", "monitoring", "docs"], highlightedMetrics: ["latency_p95_ms", "prediction_count"] },
      mlflow: { enabled: false, trackingUriRef: "env:MLFLOW_TRACKING_URI", registryEnabled: false },
    },
    modelCard: {
      intendedUse: "Representar uma imagem Docker de runtime no Studio sem assumir acesso ao pipeline interno.",
      limitations: [
        "Importação black-box não recupera dados de treino, artefatos, código nem pipeline interno.",
        containerSandboxed
          ? "A importação executou apenas leitura sandboxada de OpenAPI com rede desativada, filesystem read-only, sem privilégios novos e limites de processo/memória."
          : "A importação usa apenas docker image inspect e não executa a imagem.",
        "Chamadas de predição dependem de o operador subir a imagem manualmente na porta configurada.",
      ],
      monitoring: ["docker_image_inspection", "runtime_metrics", "manual_validation"],
      riskLevel: "high",
    },
    sensitiveFields: [],
    dependencies: [],
    owners: [],
  });

  const pipeline = parsePipelineFlow({
    id: `${targetProjectId}-pipeline`,
    name: "Pipeline black-box de imagem Docker",
    version: "0.1.0",
    contract: CONTRACT_VERSION,
    description: "DAG sintético para observar e testar uma imagem Docker sem recuperar sua implementação interna.",
    nodes: [
      {
        id: "docker_image_api",
        type: "data_source",
        label: "Endpoint Docker",
        description: "Fonte API que aponta para uma execução controlada da imagem Docker importada.",
        dataSourceId: "docker_image_api",
        position: { x: 80, y: 120 },
        inputSchema: {},
        outputSchema: { response: { type: "object" } },
        config: { image: imageRef, baseUrl, sourceDockerPort, readOnlyInspection: true, importSource: "docker_image_black_box", observedEndpoints },
        dependencies: [],
      },
      {
        id: "docker_image_model",
        type: "model",
        label: "Modelo ativo Docker",
        description: "Representação visual do modelo ativo reportado por labels ou inferido pela imagem.",
        algorithm: "docker_image_black_box",
        framework: "external_runtime",
        task: project.problem.type,
        modelRole: "active",
        position: { x: 360, y: 120 },
        inputSchema: { input: { type: "object" } },
        outputSchema: { prediction: { type: "string" } },
        config: { dockerImage: imageRef, activeModelId, contract: labels["io.mlops-flow.contract"] || null, labelsPresent: Object.keys(labels).length > 0 },
        dependencies: [],
      },
      {
        id: "docker_image_output",
        type: "output",
        label: "Saída observada",
        description: "Saída sintética do runtime Docker para comparação, logs e validação manual.",
        position: { x: 640, y: 120 },
        inputSchema: { prediction: { type: "string" } },
        outputSchema: { prediction: { type: "string" }, model_version_id: { type: "string" } },
        config: { sourceEndpoint: "POST /predict", readOnlyInspection: true },
        dependencies: [],
      },
    ],
    edges: [
      { from: "docker_image_api", to: "docker_image_model", mapping: {} },
      { from: "docker_image_model", to: "docker_image_output", mapping: {} },
    ],
    subgraphs: [],
    visual: { viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeId: "docker_image_api" },
  });

  return { project, pipeline };
}

function dockerImageBlackBoxRuntimeManifest(project: MLOpsProject, pipeline: PipelineFlow, inspect: Record<string, unknown>, runtimeEndpoints?: string[]): RuntimeManifest {
  return {
    id: `${project.id}-runtime`,
    projectId: project.id,
    projectVersion: project.version,
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    activeModelId: activeModelId(pipeline),
    executionProfile: project.execution.profile,
    persistence: project.runtime.persistence,
    ...runtimeManifestCapabilityFields(project, pipeline),
    endpoints: uniqueObservedEndpoints(runtimeEndpoints && runtimeEndpoints.length ? runtimeEndpoints : dockerImageObservedEndpoints(inspect)),
  };
}

function dockerImageBlackBoxGeneratedMeta(
  project: MLOpsProject,
  pipeline: PipelineFlow,
  imageRef: string,
  sourceDockerPort: number,
  inspect: Record<string, unknown>,
  runtimeEndpoints: string[],
  sandboxOpenApiPath?: string | null,
): Record<string, unknown> {
  const usedContainerSandbox = !!sandboxOpenApiPath;
  return {
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    projectId: project.id,
    projectVersion: project.version,
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    reimportPackage: ".mlops",
    generatedAt: new Date().toISOString(),
    sourceFiles: ["sourceDockerImage", ".mlops/docker-image-inspect.json"],
    importedFrom: "docker_image_black_box",
    readOnly: true,
    noContainerRun: !usedContainerSandbox,
    sourceDockerImage: imageRef,
    dockerImageInspectPath: ".mlops/docker-image-inspect.json",
    labels: dockerImageLabels(inspect),
    exposedPorts: dockerImageExposedPorts(inspect),
    limitations: [
      "Sem artefatos locais do modelo da imagem.",
      "Sem reconstrução automática do pipeline interno.",
      usedContainerSandbox
        ? "Container executado apenas para leitura sandboxada de OpenAPI com rede desativada, filesystem read-only, sem privilégios novos e limites de processo/memória."
        : "Sem execução de container durante a importação.",
      "Variáveis de ambiente da imagem não são persistidas para evitar vazamento de segredos.",
    ],
    sourceDockerPort,
    runtimeEndpoints,
    openApiInspectionPath: sandboxOpenApiPath ?? null,
    containerSandboxInspection: {
      enabled: usedContainerSandbox,
      network: usedContainerSandbox ? "none" : null,
      readOnlyFilesystem: usedContainerSandbox ? true : null,
      capDropAll: usedContainerSandbox ? true : null,
      noNewPrivileges: usedContainerSandbox ? true : null,
    },
  };
}

async function inspectDockerImageForImport(workspaceRoot: string, imageRef: string, timeoutMs: number): Promise<Record<string, unknown>> {
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runDockerProcess(["image", "inspect", imageRef], workspaceRoot, timeoutMs);
  } catch (error) {
    throw new WorkspaceError("Docker não está disponível para inspecionar a imagem.", 422, error);
  }
  if (result.timedOut || result.exitCode !== 0) {
    throw new WorkspaceError("Falha ao inspecionar imagem Docker para importação.", 422, {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: trimProcessOutput(result.stdout),
      stderr: trimProcessOutput(result.stderr),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new WorkspaceError("docker image inspect não retornou JSON válido.", 422, error);
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(first)) {
    throw new WorkspaceError("docker image inspect não retornou objeto de imagem válido.", 422);
  }
  return sanitizeDockerImageInspect(first);
}

async function inspectDockerImageOpenApiForImport(workspaceRoot: string, imageRef: string, timeoutMs: number): Promise<{ path: string; endpoints: string[] } | null> {
  const enabled = resolveConfigBoolean(process.env.MLOPS_STUDIO_DOCKER_IMAGE_OPENAPI_SANDBOX, false);
  if (!enabled) {
    return null;
  }
  return probeDockerImageOpenApiForImport(workspaceRoot, imageRef, timeoutMs);
}

async function probeDockerImageOpenApiForImport(workspaceRoot: string, imageRef: string, timeoutMs: number): Promise<{ path: string; endpoints: string[] } | null> {
  const candidatePaths = [
    "/app/openapi.json",
    "/openapi.json",
    "/openapi.yaml",
    "/openapi.yml",
    "/api/openapi.json",
    "/api/openapi.yaml",
    "/api/openapi.yml",
    "/static/openapi.json",
    "/docs/openapi.json",
    "/docs/openapi.yaml",
    "/docs/openapi.yml",
    "/swagger.json",
    "/swagger/v1/swagger.json",
    "/swagger/v1/swagger.yaml",
    "/swagger/v1/swagger.yml",
  ];
  const probeScript = [
    "#!/bin/sh",
    "for candidate in " + candidatePaths.map((candidate) => JSON.stringify(candidate)).join(" ") + "; do",
    "  if [ -f \"$candidate\" ]; then",
    "    echo __MLOPS_OPENAPI_PATH__=\"$candidate\"",
    "    cat \"$candidate\"",
    "    exit 0",
    "  fi",
    "done",
    "exit 1",
  ].join(" ; ");
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runDockerProcess([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      "256m",
      "--entrypoint",
      "sh",
      imageRef,
      "-lc",
      probeScript,
    ], workspaceRoot, timeoutMs);
  } catch (error) {
    throw new WorkspaceError("Docker não está disponível para varredura OpenAPI da imagem.", 422, error);
  }
  if (result.timedOut || result.exitCode !== 0) {
    throw new WorkspaceError("Falha ao varrer OpenAPI na imagem Docker para importação.", 422, {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: trimProcessOutput(result.stdout),
      stderr: trimProcessOutput(result.stderr),
    });
  }
  const stdout = result.stdout.trim();
  const markerPrefix = "__MLOPS_OPENAPI_PATH__=";
  const markerIndex = stdout.indexOf(markerPrefix);
  if (markerIndex < 0) {
    return null;
  }
  const markerEnd = markerIndex + markerPrefix.length;
  const newlineIndex = stdout.indexOf("\n", markerEnd);
  if (newlineIndex < 0) {
    return null;
  }
  const rawPath = stdout.slice(markerEnd, newlineIndex).trim().replace(/^"/, "").replace(/"$/, "");
  const rawSpec = stdout.slice(newlineIndex + 1).trim();
  if (!rawPath || !rawSpec) {
    return null;
  }
  try {
    const parsed = path.extname(rawPath).toLowerCase() === ".json"
      ? (JSON.parse(rawSpec) as unknown)
      : (YAML.parse(rawSpec) as unknown);
    const spec = parseRecord(parsed);
    const endpoints = openApiObservedEndpoints(spec);
    if (!endpoints.length) {
      return null;
    }
    return { path: rawPath, endpoints: uniqueObservedEndpoints(endpoints) };
  } catch {
    return null;
  }
}

async function runDockerProcess(args: string[], workspaceRoot: string, timeoutMs: number): Promise<Awaited<ReturnType<typeof runProcess>>> {
  const command = process.env.MLOPS_STUDIO_DOCKER_CLI?.trim() || "docker";
  const prefixArgs = dockerCliPrefixArgs();
  return runProcess(command, [...prefixArgs, ...args], workspaceRoot, timeoutMs);
}

function dockerCliPrefixArgs(): string[] {
  const raw = process.env.MLOPS_STUDIO_DOCKER_CLI_ARGS?.trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Validação abaixo gera a mensagem operacional estável.
  }
  throw new WorkspaceError("MLOPS_STUDIO_DOCKER_CLI_ARGS deve ser um array JSON de strings.", 500);
}

function sanitizeDockerImageInspect(raw: Record<string, unknown>): Record<string, unknown> {
  const config = isRecord(raw.Config) ? raw.Config : {};
  return {
    Id: typeof raw.Id === "string" ? raw.Id : null,
    RepoTags: dockerImageStringArray(raw.RepoTags),
    RepoDigests: dockerImageStringArray(raw.RepoDigests),
    Architecture: typeof raw.Architecture === "string" ? raw.Architecture : null,
    Os: typeof raw.Os === "string" ? raw.Os : null,
    Created: typeof raw.Created === "string" ? raw.Created : null,
    Config: {
      Labels: sanitizeStringRecord(config.Labels),
      ExposedPorts: sanitizeDockerExposedPorts(config.ExposedPorts),
      Entrypoint: sanitizeDockerCommand(config.Entrypoint),
      Cmd: sanitizeDockerCommand(config.Cmd),
    },
  };
}

function normalizeDockerImageRef(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || trimmed.startsWith("-") || /[\s\0]/.test(trimmed) || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(trimmed)) {
    throw new WorkspaceError("sourceDockerImage deve ser uma referência Docker simples, sem espaços, credenciais ou argumentos.", 400);
  }
  return trimmed;
}

function optionalDockerPort(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new WorkspaceError(`${name} deve ser inteiro entre 1 e 65535 quando informado.`, 400);
  }
  return value;
}

function dockerImageLabels(inspect: Record<string, unknown>): Record<string, string> {
  const config = isRecord(inspect.Config) ? inspect.Config : {};
  return sanitizeStringRecord(config.Labels);
}

function dockerImageObservedEndpoints(inspect: Record<string, unknown>): string[] {
  const labels = dockerImageLabels(inspect);
  const raw = labels["io.mlops-flow.endpoints"];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const endpoints = parsed
          .filter((endpoint): endpoint is string => typeof endpoint === "string" && /^[A-Z]+ \/[^\s]*$/.test(endpoint))
          .slice(0, 100);
        if (endpoints.length) {
          return [...new Set(endpoints)];
        }
      }
    } catch {
      return ["POST /predict"];
    }
  }
  return ["POST /predict"];
}

function dockerImageExposedPorts(inspect: Record<string, unknown>): string[] {
  const config = isRecord(inspect.Config) ? inspect.Config : {};
  const exposedPorts = isRecord(config.ExposedPorts) ? config.ExposedPorts : {};
  return Object.keys(exposedPorts).sort();
}

function dockerImagePrimaryPort(inspect: Record<string, unknown>): number | undefined {
  const ports = dockerImageExposedPorts(inspect);
  const preferred = ports.find((port) => port.endsWith("/tcp")) ?? ports[0];
  if (!preferred) {
    return undefined;
  }
  const rawPort = preferred.split("/")[0];
  const parsed = Number(rawPort);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : undefined;
}

function dockerImageDisplayName(inspect: Record<string, unknown>): string | undefined {
  const tags = dockerImageStringArray(inspect.RepoTags);
  return tags[0] || undefined;
}

function dockerImageStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
      .slice(0, 200),
  );
}

function sanitizeDockerExposedPorts(value: unknown): Record<string, Record<string, never>> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.keys(value)
      .filter((port) => /^\d+\/(tcp|udp)$/i.test(port))
      .slice(0, 100)
      .map((port) => [port, {}]),
  );
}

function sanitizeDockerCommand(value: unknown): string | string[] | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").slice(0, 32);
  }
  return null;
}

function remoteBlackBoxProjectBundle(targetProjectId: string, base: URL, inspection: Record<string, unknown>): { project: MLOpsProject; pipeline: PipelineFlow } {
  const identity = isRecord(inspection.identity) ? inspection.identity : {};
  const remoteProjectName = typeof identity.projectName === "string" ? identity.projectName : typeof identity.projectId === "string" ? identity.projectId : base.hostname;
  const activeModelId = typeof identity.activeModelId === "string" ? identity.activeModelId : "modelo_remoto";
  const executionProfile = remoteBlackBoxExecutionProfile(identity.executionProfile);
  const observedEndpoints = remoteBlackBoxObservedEndpoints(inspection);
  const project = parseMLOpsProject({
    id: targetProjectId,
    name: `Runtime remoto ${remoteProjectName}`,
    version: "0.1.0",
    contract: CONTRACT_VERSION,
    description: `Importação black-box observável de ${base.toString()}. Artefatos, treino e pipeline internos não foram recuperados.`,
    problem: {
      type: "multiclass_classification",
      target: "prediction",
      classes: ["unknown"],
      classDependencies: [],
    },
    execution: { profile: executionProfile },
    metrics: { primary: "latency_p95_ms", secondary: ["prediction_count", "runtime_errors"] },
    dataSources: [
      {
        id: "remote_runtime_api",
        type: "api",
        label: "Runtime remoto black-box",
        description: "Fonte sintética criada a partir de inspeção read-only. Use mocks ou endpoint remoto controlado antes de executar predições reais.",
        sensitive: true,
        api: {
          method: "POST",
          url: new URL("/predict", base).toString(),
          headers: {},
          bodyTemplate: { input: { type: "object", description: "Payload enviado ao runtime remoto." } },
          mocks: [
            {
              id: "remote_black_box_contract",
              description: "Mock mínimo para testes seguros sem chamar o endpoint remoto.",
              request: { input: { type: "object" } },
              response: { prediction: "unknown", model_version_id: activeModelId },
            },
          ],
          pagination: { mode: "none" },
          timeoutSeconds: 30,
        },
        schema: {
          input: { type: "object" },
          prediction: { type: "string" },
          model_version_id: { type: "string" },
        },
        sensitiveFields: [],
      },
    ],
    pipelineRef: "pipeline.flow.json",
    promotionPolicy: { id: "remote-black-box-policy", mode: "manual_approval", baseline: "active_model", rules: [] },
    runtime: {
      apiName: "Runtime remoto black-box",
      routePrefix: "",
      persistence: { primary: "external_postgres", databaseUrlRef: "env:REMOTE_RUNTIME_DATABASE_URL" },
      dashboard: { enabled: true, pages: ["overview", "models", "prediction", "monitoring", "docs"], highlightedMetrics: ["latency_p95_ms", "prediction_count"] },
      mlflow: { enabled: false, trackingUriRef: "env:MLFLOW_TRACKING_URI", registryEnabled: false },
    },
    modelCard: {
      intendedUse: "Representar um runtime remoto observável no Studio sem assumir acesso ao pipeline interno.",
      limitations: [
        "Importação black-box não recupera dados de treino, artefatos, código nem pipeline interno.",
        "Chamadas de predição devem ser habilitadas e testadas de forma controlada pelo operador.",
      ],
      monitoring: ["remote_runtime_inspection", "runtime_metrics", "manual_validation"],
      riskLevel: "high",
    },
    sensitiveFields: [],
    dependencies: [],
    owners: [],
  });

  const pipeline = parsePipelineFlow({
    id: `${targetProjectId}-pipeline`,
    name: "Pipeline black-box remoto",
    version: "0.1.0",
    contract: CONTRACT_VERSION,
    description: "DAG sintético para observar e testar um runtime remoto sem recuperar sua implementação interna.",
    nodes: [
      {
        id: "remote_runtime_api",
        type: "data_source",
        label: "Endpoint remoto",
        description: "Fonte API que aponta para o runtime remoto observado.",
        dataSourceId: "remote_runtime_api",
        position: { x: 80, y: 120 },
        inputSchema: {},
        outputSchema: { response: { type: "object" } },
        config: { baseUrl: base.toString(), readOnlyInspection: true, importSource: "remote_black_box", observedEndpoints },
        dependencies: [],
      },
      {
        id: "remote_active_model",
        type: "model",
        label: "Modelo ativo remoto",
        description: "Representação visual do modelo ativo reportado ou inferido pela inspeção remota.",
        algorithm: "remote_black_box",
        framework: "external_runtime",
        task: project.problem.type,
        modelRole: "active",
        position: { x: 360, y: 120 },
        inputSchema: { input: { type: "object" } },
        outputSchema: { prediction: { type: "string" } },
        config: { remoteActiveModelId: activeModelId, importMode: remoteRuntimeInspectionMode(inspection), contract: typeof identity.contract === "string" ? identity.contract : null },
        dependencies: [],
      },
      {
        id: "remote_prediction_output",
        type: "output",
        label: "Saída observada",
        description: "Saída sintética do runtime remoto para comparação, logs e validação manual.",
        position: { x: 640, y: 120 },
        inputSchema: { prediction: { type: "string" } },
        outputSchema: { prediction: { type: "string" }, model_version_id: { type: "string" } },
        config: { sourceEndpoint: "POST /predict", readOnlyInspection: true },
        dependencies: [],
      },
    ],
    edges: [
      { from: "remote_runtime_api", to: "remote_active_model", mapping: {} },
      { from: "remote_active_model", to: "remote_prediction_output", mapping: {} },
    ],
    subgraphs: [],
    visual: { viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeId: "remote_runtime_api" },
  });

  return { project, pipeline };
}

function remoteBlackBoxRuntimeManifest(project: MLOpsProject, pipeline: PipelineFlow, inspection: Record<string, unknown>): RuntimeManifest {
  const endpoints = remoteBlackBoxObservedEndpoints(inspection);
  return {
    id: `${project.id}-runtime`,
    projectId: project.id,
    projectVersion: project.version,
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    activeModelId: activeModelId(pipeline),
    executionProfile: project.execution.profile,
    persistence: project.runtime.persistence,
    ...runtimeManifestCapabilityFields(project, pipeline),
    endpoints: endpoints.length ? endpoints : ["GET /health"],
  };
}

function remoteBlackBoxGeneratedMeta(project: MLOpsProject, pipeline: PipelineFlow, base: URL, inspection: Record<string, unknown>): Record<string, unknown> {
  return {
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    projectId: project.id,
    projectVersion: project.version,
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    reimportPackage: ".mlops",
    generatedAt: new Date().toISOString(),
    sourceFiles: ["remoteBaseUrl", ".mlops/remote-inspection.json"],
    importedFrom: "remote_black_box",
    importMode: remoteRuntimeInspectionMode(inspection),
    readOnly: true,
    remoteBaseUrl: base.toString(),
    remoteInspectionPath: ".mlops/remote-inspection.json",
    limitations: [
      "Sem artefatos locais do modelo remoto.",
      "Sem reconstrução automática do pipeline interno.",
      "Sem execução de código ou container remoto durante a importação.",
    ],
  };
}

async function readPlaywrightScrapeReport(root: string, body: ImportScrapeProjectBody): Promise<{ report: Record<string, unknown>; absoluteReportPath: string; relativeReportPath: string }> {
  const reportPath = requiredBodyString(body.reportPath, "reportPath").replaceAll("\\", "/");
  const absoluteReportPath = safeResolve(root, reportPath);
  const scrapesRoot = safeResolve(root, path.join(".mlops-studio", "playwright-scrapes"));
  const normalizedReport = absoluteReportPath.toLowerCase();
  const normalizedScrapesRoot = scrapesRoot.toLowerCase();
  if (normalizedReport !== normalizedScrapesRoot && !normalizedReport.startsWith(`${normalizedScrapesRoot}${path.sep}`)) {
    throw new WorkspaceError("reportPath deve apontar para .mlops-studio/playwright-scrapes/.", 400);
  }
  const raw = await readFile(absoluteReportPath, "utf-8").catch((error) => {
    throw new WorkspaceError(`Relatório de scrape não encontrado: ${reportPath}.`, 404, error);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new WorkspaceError("Relatório de scrape não é JSON válido.", 422, error);
  }
  if (!isRecord(parsed) || parsed.kind !== "playwright_scrape") {
    throw new WorkspaceError("Relatório de scrape precisa ter kind playwright_scrape.", 422);
  }
  return {
    report: parsed,
    absoluteReportPath,
    relativeReportPath: toWorkspaceRelative(root, absoluteReportPath),
  };
}

function playwrightScrapeBaseUrl(report: Record<string, unknown>): URL {
  const url = scrapeString(report.finalUrl) || scrapeString(report.url);
  if (!url) {
    throw new WorkspaceError("Relatório de scrape não informa url/finalUrl.", 422);
  }
  try {
    return new URL(url);
  } catch (error) {
    throw new WorkspaceError("Relatório de scrape possui URL inválida.", 422, error);
  }
}

function playwrightScrapeProjectBundle(
  targetProjectId: string,
  base: URL,
  report: Record<string, unknown>,
  contractEdits: PlaywrightScrapeContractEdits = { sources: [] },
): { project: MLOpsProject; pipeline: PipelineFlow; endpoints: string[] } {
  const title = scrapeString(report.title) || base.hostname;
  const description = scrapeString(report.description) || "Projeto sintético criado a partir de scraping Playwright controlado.";
  const dataSources = playwrightScrapeDataSources(base, report, contractEdits);
  const endpoints = playwrightScrapeObservedEndpoints(base, dataSources);
  const project = parseMLOpsProject({
    id: targetProjectId,
    name: `Scrape black-box ${title}`.slice(0, 120),
    version: "0.1.0",
    contract: CONTRACT_VERSION,
    description: `${description} Artefatos, treino e pipeline internos não foram recuperados.`,
    problem: {
      type: "multiclass_classification",
      target: "response",
      classes: ["unknown"],
      classDependencies: [],
    },
    execution: { profile: "auto" },
    metrics: { primary: "latency_p95_ms", secondary: ["http_status", "link_count", "form_count"] },
    dataSources,
    pipelineRef: "pipeline.flow.json",
    promotionPolicy: { id: "scrape-black-box-policy", mode: "manual_approval", baseline: "active_model", rules: [] },
    runtime: {
      apiName: "Scrape black-box assistido",
      routePrefix: "",
      persistence: { primary: "external_postgres", databaseUrlRef: "env:SCRAPED_RUNTIME_DATABASE_URL" },
      dashboard: { enabled: true, pages: ["overview", "data", "prediction", "docs"], highlightedMetrics: ["latency_p95_ms", "http_status"] },
      mlflow: { enabled: false, trackingUriRef: "env:MLFLOW_TRACKING_URI", registryEnabled: false },
    },
    modelCard: {
      intendedUse: "Representar uma superfície web ou documentação de API observada por Playwright para triagem e importação assistida.",
      limitations: [
        "Scraping não recupera implementação interna, dados de treino, artefatos nem garantias de contrato.",
        "Candidatos de API e forms são sugestões extraídas da página e precisam de validação manual.",
      ],
      monitoring: ["playwright_scrape_report", "manual_contract_validation"],
      riskLevel: "high",
    },
    sensitiveFields: [],
    dependencies: [],
    owners: [],
  });

  const nodes = dataSources.map((source, index) => {
    const sourceId = scrapeString(source.id);
    const sourceApi = isRecord(source.api) ? source.api : {};
    return {
    id: sourceId,
    type: "data_source",
    label: scrapeString(source.label) || sourceId,
    description: scrapeString(source.description),
    dataSourceId: sourceId,
    position: { x: 80, y: 80 + (index * 120) },
    inputSchema: {},
    outputSchema: { response: { type: "object" } },
    config: { importSource: "playwright_scrape_black_box", originalUrl: scrapeString(sourceApi.url) },
    dependencies: [],
    };
  });
  const aggregatorY = Math.max(120, 80 + Math.floor(nodes.length / 2) * 120);
  const pipeline = parsePipelineFlow({
    id: `${targetProjectId}-pipeline`,
    name: "Pipeline black-box a partir de scrape",
    version: "0.1.0",
    contract: CONTRACT_VERSION,
    description: "DAG sintético criado a partir de relatório Playwright, com fontes sugeridas para validação manual.",
    nodes: [
      ...nodes,
      {
        id: "scrape_black_box_runtime",
        type: "model",
        label: "Superfície black-box",
        description: "Representação visual da superfície observada por scraping.",
        algorithm: "playwright_scrape_black_box",
        framework: "external_web_surface",
        task: project.problem.type,
        modelRole: "active",
        position: { x: 440, y: aggregatorY },
        inputSchema: { response: { type: "object" } },
        outputSchema: { response: { type: "object" } },
        config: {
          baseUrl: base.toString(),
          title,
          headingCount: recordArray(report.headings).length,
          linkCount: recordArray(report.links).length,
          formCount: recordArray(report.forms).length,
          apiCandidateCount: recordArray(report.apiCandidates).length,
        },
        dependencies: [],
      },
      {
        id: "scrape_import_review",
        type: "output",
        label: "Revisão de importação",
        description: "Saída para validar manualmente contratos, endpoints e payloads antes de usar como runtime.",
        position: { x: 760, y: aggregatorY },
        inputSchema: { response: { type: "object" } },
        outputSchema: { response: { type: "object" } },
        config: { endpoints, requiresManualValidation: true },
        dependencies: [],
      },
    ],
    edges: [
      ...dataSources.map((source) => ({ from: scrapeString(source.id), to: "scrape_black_box_runtime", mapping: {} })),
      { from: "scrape_black_box_runtime", to: "scrape_import_review", mapping: {} },
    ],
    subgraphs: [],
    visual: { viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeId: scrapeString(dataSources[0]?.id) || "scrape_black_box_runtime" },
  });

  return { project, pipeline, endpoints };
}

function playwrightScrapeDataSources(
  base: URL,
  report: Record<string, unknown>,
  contractEdits: PlaywrightScrapeContractEdits = { sources: [] },
): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];
  candidates.push({
    id: "scraped_page",
    type: "api",
    label: "Página scrapeada",
    description: "Página original inspecionada por Playwright.",
    sensitive: true,
    api: { method: "GET", url: base.toString(), headers: {}, pagination: { mode: "none" }, timeoutSeconds: 30, mocks: [] },
    schema: { html: { type: "string" } },
    sensitiveFields: [],
  });
  recordArray(report.apiCandidates).slice(0, 5).forEach((candidate, index) => {
    const url = scrapeAbsoluteUrl(scrapeString(candidate.href), base);
    if (!url) {
      return;
    }
    candidates.push({
      id: `scrape_api_candidate_${index + 1}`,
      type: "api",
      label: `Candidato API ${index + 1}`,
      description: scrapeString(candidate.text) || "Link candidato a OpenAPI/Swagger/Redoc detectado no scrape.",
      sensitive: true,
      api: { method: "GET", url, headers: {}, pagination: { mode: "none" }, timeoutSeconds: 30, mocks: [] },
      schema: { contract: { type: "object" } },
      sensitiveFields: [],
    });
  });
  recordArray(report.forms).slice(0, 5).forEach((form, index) => {
    const url = scrapeAbsoluteUrl(scrapeString(form.action), base);
    if (!url) {
      return;
    }
    const method = scrapeHttpMethod(scrapeString(form.method));
    const inputs = recordArray(form.inputs).map((input) => scrapeString(input.name) || scrapeString(input.placeholder)).filter(Boolean);
    candidates.push({
      id: `scrape_form_${index + 1}`,
      type: "api",
      label: `Form ${method} ${index + 1}`,
      description: `Formulário detectado no scrape com campos: ${inputs.join(", ") || "sem campos nomeados"}.`,
      sensitive: true,
      api: {
        method,
        url,
        headers: {},
        bodyTemplate: Object.fromEntries(inputs.map((input) => [input, ""])),
        pagination: { mode: "none" },
        timeoutSeconds: 30,
        mocks: [],
      },
      schema: { fields: inputs },
      sensitiveFields: [],
    });
  });
  const editsById = new Map(contractEdits.sources.map((edit) => [edit.id, edit]));
  const edited = candidates.flatMap((source) => {
    const sourceId = scrapeString(source.id);
    const edit = editsById.get(sourceId);
    const updated = applyPlaywrightScrapeSourceContractEdit(base, source, edit);
    return updated ? [updated] : [];
  });
  if (!edited.length) {
    throw new WorkspaceError("A edição do contrato de scrape precisa manter pelo menos uma fonte.", 422);
  }
  return edited;
}

function playwrightScrapeRuntimeManifest(project: MLOpsProject, pipeline: PipelineFlow, endpoints: string[]): RuntimeManifest {
  return {
    id: `${project.id}-runtime`,
    projectId: project.id,
    projectVersion: project.version,
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    activeModelId: activeModelId(pipeline),
    executionProfile: project.execution.profile,
    persistence: project.runtime.persistence,
    ...runtimeManifestCapabilityFields(project, pipeline),
    endpoints: endpoints.length ? endpoints : ["GET /"],
  };
}

function playwrightScrapeGeneratedMeta(
  project: MLOpsProject,
  pipeline: PipelineFlow,
  base: URL,
  reportPath: string,
  endpoints: string[],
  contractEdits: PlaywrightScrapeContractEdits = { sources: [] },
): Record<string, unknown> {
  return {
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    projectId: project.id,
    projectVersion: project.version,
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    reimportPackage: ".mlops",
    generatedAt: new Date().toISOString(),
    sourceFiles: [reportPath, ".mlops/playwright-scrape-report.json"],
    importedFrom: "playwright_scrape_black_box",
    readOnly: true,
    baseUrl: base.toString(),
    scrapeReportPath: ".mlops/playwright-scrape-report.json",
    endpoints,
    contractEdits: contractEdits.sources.length ? contractEdits : null,
    limitations: [
      "Sem artefatos locais do modelo ou runtime.",
      "Sem reconstrução automática do pipeline interno.",
      "Candidatos extraídos do HTML exigem validação manual antes de produção.",
    ],
  };
}

function playwrightScrapeContractEdits(value: unknown): PlaywrightScrapeContractEdits {
  if (!isRecord(value)) {
    return { sources: [] };
  }
  return {
    sources: recordArray(value.sources).flatMap((item) => {
      const id = scrapeString(item.id);
      if (!id) {
        return [];
      }
      const timeoutSeconds = optionalScrapeTimeoutSeconds(item.timeoutSeconds);
      return [{
        id,
        include: typeof item.include === "boolean" ? item.include : undefined,
        label: scrapeString(item.label) || undefined,
        description: scrapeString(item.description) || undefined,
        method: scrapeString(item.method) ? scrapeHttpMethod(scrapeString(item.method)) : undefined,
        url: scrapeString(item.url) || undefined,
        timeoutSeconds,
        bodyTemplate: Object.hasOwn(item, "bodyTemplate") ? item.bodyTemplate : undefined,
      }];
    }),
  };
}

function applyPlaywrightScrapeSourceContractEdit(
  base: URL,
  source: Record<string, unknown>,
  edit?: PlaywrightScrapeSourceContractEdit,
): Record<string, unknown> | null {
  if (!edit) {
    return source;
  }
  if (edit.include === false) {
    return null;
  }

  const api = isRecord(source.api) ? { ...source.api } : {};
  if (edit.method) {
    api.method = edit.method;
  }
  if (edit.url) {
    const resolved = scrapeAbsoluteUrl(edit.url, base);
    if (!resolved) {
      throw new WorkspaceError(`URL inválida na edição da fonte ${edit.id}.`, 422);
    }
    const parsed = new URL(resolved);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new WorkspaceError(`URL da fonte ${edit.id} precisa ser http/https e não pode conter credenciais.`, 422);
    }
    api.url = parsed.toString();
  }
  if (edit.timeoutSeconds !== undefined) {
    api.timeoutSeconds = edit.timeoutSeconds;
  }
  if (edit.bodyTemplate !== undefined) {
    if (!isRecord(edit.bodyTemplate)) {
      throw new WorkspaceError(`bodyTemplate da fonte ${edit.id} precisa ser um objeto JSON.`, 422);
    }
    api.bodyTemplate = edit.bodyTemplate;
  }

  return {
    ...source,
    label: edit.label || source.label,
    description: edit.description || source.description,
    api,
  };
}

function optionalScrapeTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(scrapeString(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 600) {
    throw new WorkspaceError("timeoutSeconds da edição de scrape deve ser um número entre 1 e 600.", 422);
  }
  return Math.round(parsed);
}

function playwrightScrapeObservedEndpoints(base: URL, dataSources: Array<Record<string, unknown>>): string[] {
  return [...new Set(dataSources.map((source) => {
    const api = isRecord(source.api) ? source.api : {};
    const method = scrapeHttpMethod(scrapeString(api.method));
    const url = scrapeAbsoluteUrl(scrapeString(api.url), base);
    if (!url) {
      return "";
    }
    const parsed = new URL(url);
    return `${method} ${parsed.pathname || "/"}`;
  }).filter(Boolean))];
}

function scrapeAbsoluteUrl(value: string, base: URL): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function scrapeHttpMethod(value: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  const normalized = value.toUpperCase();
  return normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE" ? normalized : "GET";
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function scrapeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function remoteBlackBoxObservedEndpoints(inspection: Record<string, unknown>): string[] {
  return [...new Set(remoteBlackBoxInspectionChecks(inspection)
    .filter((check) => check.status === "ok")
    .map((check) => `${check.method} ${check.path}`))];
}

function remoteBlackBoxInspectionChecks(inspection: Record<string, unknown>): RemoteRuntimeCheck[] {
  const checks = Array.isArray(inspection.checks) ? inspection.checks : [];
  return checks.filter((check): check is RemoteRuntimeCheck =>
    isRecord(check)
    && check.method === "GET"
    && typeof check.path === "string"
    && ["ok", "missing", "error"].includes(String(check.status))
    && typeof check.name === "string"
    && typeof check.url === "string"
    && typeof check.contractEndpoint === "boolean"
    && typeof check.latencyMs === "number",
  );
}

function remoteRuntimeInspectionMode(inspection: Record<string, unknown>): RemoteRuntimeMode {
  const mode = inspection.mode;
  if (mode === "white_box" || mode === "partial_contract" || mode === "black_box_observable" || mode === "unreachable") {
    return mode;
  }
  return "unreachable";
}

function remoteBlackBoxExecutionProfile(value: unknown): "cpu" | "gpu_cuda" | "auto" {
  return value === "cpu" || value === "gpu_cuda" || value === "auto" ? value : "auto";
}

interface RuntimeImportSource {
  sourceKind: "mlops_package" | "app_metadata";
  projectPath: string;
  projectLabel: string;
  pipelinePath: string;
  pipelineLabel: string;
  mlopsDir: string | null;
  artifactsDir: string | null;
  customCodeDir: string | null;
  latestTrainingPath: string | null;
}

async function resolveRuntimeImportSource(absoluteOutDir: string, relativeOutDir: string): Promise<RuntimeImportSource> {
  const mlopsDir = path.join(absoluteOutDir, ".mlops");
  const mlopsProjectPath = path.join(mlopsDir, "project.yaml");
  const mlopsPipelinePath = path.join(mlopsDir, "pipeline.flow.json");
  if ((await pathExists(mlopsProjectPath)) && (await pathExists(mlopsPipelinePath))) {
    return {
      sourceKind: "mlops_package",
      projectPath: mlopsProjectPath,
      projectLabel: ".mlops/project.yaml",
      pipelinePath: mlopsPipelinePath,
      pipelineLabel: ".mlops/pipeline.flow.json",
      mlopsDir,
      artifactsDir: (await pathExists(path.join(mlopsDir, "artifacts"))) ? path.join(mlopsDir, "artifacts") : null,
      customCodeDir: (await pathExists(path.join(mlopsDir, "custom_code"))) ? path.join(mlopsDir, "custom_code") : null,
      latestTrainingPath: (await pathExists(path.join(mlopsDir, "latest-training-result.json"))) ? path.join(mlopsDir, "latest-training-result.json") : null,
    };
  }

  const metadataDir = path.join(absoluteOutDir, "app", "metadata");
  const metadataProjectJson = path.join(metadataDir, "project.json");
  const metadataProjectYaml = path.join(metadataDir, "project.yaml");
  const metadataPipelinePath = path.join(metadataDir, "pipeline.flow.json");
  const projectPath = (await pathExists(metadataProjectJson)) ? metadataProjectJson : (await pathExists(metadataProjectYaml)) ? metadataProjectYaml : null;
  if (projectPath && (await pathExists(metadataPipelinePath))) {
    return {
      sourceKind: "app_metadata",
      projectPath,
      projectLabel: `app/metadata/${path.basename(projectPath)}`,
      pipelinePath: metadataPipelinePath,
      pipelineLabel: "app/metadata/pipeline.flow.json",
      mlopsDir: null,
      artifactsDir: (await pathExists(path.join(absoluteOutDir, "artifacts"))) ? path.join(absoluteOutDir, "artifacts") : null,
      customCodeDir: (await pathExists(path.join(absoluteOutDir, "app", "custom_code"))) ? path.join(absoluteOutDir, "app", "custom_code") : null,
      latestTrainingPath: (await pathExists(path.join(metadataDir, "latest-training-result.json"))) ? path.join(metadataDir, "latest-training-result.json") : null,
    };
  }

  throw new WorkspaceError(`Runtime em ${relativeOutDir} precisa conter pacote .mlops ou app/metadata/project.json com pipeline.flow.json.`, 422);
}

async function readRuntimeProjectImportValue(projectPath: string): Promise<unknown> {
  const raw = await readFile(projectPath, "utf-8");
  if (path.extname(projectPath).toLowerCase() === ".json") {
    return JSON.parse(raw);
  }
  return YAML.parse(raw);
}

function importedRuntimeManifest(project: MLOpsProject, pipeline: PipelineFlow): RuntimeManifest {
  return {
    id: `${project.id}-runtime`,
    projectId: project.id,
    projectVersion: project.version,
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    activeModelId: activeModelId(pipeline),
    executionProfile: project.execution.profile,
    persistence: project.runtime.persistence,
    ...runtimeManifestCapabilityFields(project, pipeline),
    endpoints: requiredRuntimeEndpoints(),
  };
}

function importedRuntimeGeneratedMeta(project: MLOpsProject, pipeline: PipelineFlow, sourceKind: RuntimeImportSource["sourceKind"]): Record<string, unknown> {
  return {
    generatedKind: "mlops-runtime",
    contract: CONTRACT_VERSION,
    projectId: project.id,
    projectVersion: project.version,
    projectHash: stableHash(project),
    pipelineHash: stableHash(pipeline),
    reimportPackage: ".mlops",
    generatedAt: new Date().toISOString(),
    sourceFiles: sourceKind === "app_metadata" ? ["app/metadata/project.json", "app/metadata/pipeline.flow.json"] : [".mlops/project.yaml", ".mlops/pipeline.flow.json"],
    importedFrom: sourceKind,
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function runtimeManifestCapabilityFields(project: MLOpsProject, pipeline: PipelineFlow): Pick<RuntimeManifest, "capabilities" | "infrastructure"> {
  const capabilities = inferRuntimeManifestCapabilities(pipeline, project);
  return {
    capabilities,
    infrastructure: inferRuntimeInfrastructure(capabilities),
  };
}

async function copyAppMetadataCustomCode(sourceDir: string, targetProjectRoot: string, pipeline: PipelineFlow): Promise<void> {
  const codePaths = pipeline.nodes
    .map((node) => (isRecord(node.python) && typeof node.python.codePath === "string" ? node.python.codePath : null))
    .filter((value): value is string => Boolean(value));
  if (!codePaths.length) {
    return;
  }
  for (const codePath of codePaths) {
    const normalized = normalizeArtifactRelativePath(codePath);
    const appRelative = normalized.replace(/^code\//, "");
    const candidates = [...new Set([appRelative, normalized])].map((relativePath) => safeResolveArtifactFile(sourceDir, relativePath));
    const sourcePath = await firstExistingPath(candidates);
    if (!sourcePath) {
      continue;
    }
    const item = await stat(sourcePath);
    if (!item.isFile()) {
      continue;
    }
    const projectTarget = safeResolveArtifactFile(targetProjectRoot, normalized);
    const packageTarget = safeResolveArtifactFile(path.join(targetProjectRoot, ".mlops", "custom_code"), normalized);
    await mkdir(path.dirname(projectTarget), { recursive: true });
    await mkdir(path.dirname(packageTarget), { recursive: true });
    await cp(sourcePath, projectTarget, { force: true });
    await cp(sourcePath, packageTarget, { force: true });
  }
}

async function firstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function loadProjectBundle(workspaceRoot: string, projectId: string) {
  const loaded = await loadProjectByPath(workspaceRoot, `projects/${projectId}/project.yaml`);
  const pipelinePath = path.join(path.dirname(loaded.relativePath), loaded.project.pipelineRef).replaceAll(path.sep, "/");
  const rawPipeline = await readFile(safeResolve(workspaceRoot, pipelinePath), "utf-8");
  let parsedPipeline: unknown;
  try {
    parsedPipeline = JSON.parse(rawPipeline);
  } catch (error) {
    throw new WorkspaceError("pipeline.flow.json não é JSON válido.", 422, error);
  }
  const pipeline = parsePipelineFlow(parsedPipeline);
  return {
    project: loaded.project,
    pipeline,
    projectPath: loaded.relativePath,
    pipelinePath,
    projectRoot: loaded.projectRoot,
  };
}

type LoadedProjectBundle = Awaited<ReturnType<typeof loadProjectBundle>>;

async function invokeWorker(
  workspaceRoot: string,
  loaded: LoadedProjectBundle,
  command: WorkerCommand,
  payload: Record<string, unknown>,
  timeoutMs?: number,
) {
  try {
    return await runWorker({
      workspaceRoot,
      projectRoot: loaded.projectRoot,
      command,
      project: loaded.project,
      pipeline: loaded.pipeline,
      payload,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof WorkerExecutionError) {
      throw new WorkspaceError(error.message, error.details.timedOut ? 504 : 500, error.details);
    }
    throw error;
  }
}

function trainBaselinePayload(body: TrainBaselineBody | undefined): Record<string, unknown> {
  return {
    sourceId: optionalBodyString(body?.sourceId, "sourceId"),
    mode: optionalSourcePreviewMode(body?.mode),
    allowExternal: body?.allowExternal === true,
    maxRows: optionalTrainingMaxRows(body?.maxRows),
    mockRows: Array.isArray(body?.mockRows) ? body?.mockRows : undefined,
    incremental: body?.incremental === true,
    previousRunId: optionalBodyString(body?.previousRunId, "previousRunId"),
    datasetSnapshotMode: optionalDatasetSnapshotMode(body?.datasetSnapshotMode),
    allowSensitiveDatasetSnapshot: body?.allowSensitiveDatasetSnapshot === true,
    datasetSnapshotRetentionDays: optionalDatasetSnapshotRetentionDays(body?.datasetSnapshotRetentionDays),
  };
}

async function runtimeRetrainingJobPayload(loaded: LoadedProjectBundle, body: RuntimeRetrainingJobBody): Promise<Record<string, unknown>> {
  const base = remoteRuntimeBaseUrl(body.baseUrl);
  const checkTimeout = Math.max(1_000, Math.min(body.timeoutMs ?? 15_000, 120_000));
  const statusBody = await fetchRuntimeRetrainingStatus(base, checkTimeout);
  const latestRequest = isRecord(statusBody.latest_request) ? statusBody.latest_request : null;
  if (!latestRequest) {
    throw new WorkspaceError("Runtime remoto não possui solicitação de retreino aprovada.", 409, { retrainingStatus: statusBody });
  }
  const latestRequestId = runtimeRetrainingRequestId(latestRequest);
  const requestedRequestId = optionalBodyString(body.requestId, "requestId");
  if (!latestRequestId) {
    throw new WorkspaceError("Solicitação de retreino remota não informou id.", 409, { latestRequest });
  }
  if (requestedRequestId && requestedRequestId !== latestRequestId) {
    throw new WorkspaceError("A inspeção read-only só confirmou a solicitação mais recente do runtime remoto.", 409, { requestedRequestId, latestRequestId });
  }
  const latestStatus = typeof latestRequest.status === "string" ? latestRequest.status : "";
  if (latestStatus !== "approved_pending_runner") {
    throw new WorkspaceError("Solicitação de retreino ainda não está aprovada para execução no Studio.", 409, { requestId: latestRequestId, status: latestStatus });
  }

  const runs = await listTrainingRuns(loaded);
  const previousRunId = optionalBodyString(body.previousRunId, "previousRunId") ?? (typeof runs[0]?.runId === "string" ? runs[0].runId : undefined);
  if (!previousRunId) {
    throw new WorkspaceError("Retreino controlado exige um treino base local antes de iniciar o job incremental.", 409);
  }
  const sourceId = optionalBodyString(body.sourceId, "sourceId") ?? firstTrainableSourceId(loaded.project);
  if (!sourceId) {
    throw new WorkspaceError("Projeto não possui fonte de dados treinável para retreino controlado.", 409);
  }

  const minFeedbackRows = optionalFeedbackRowsMinimum(body.minFeedbackRows) ?? 2;
  const feedbackTrainingSet = await fetchRuntimeRetrainingTrainingSet(base, latestRequestId, body, checkTimeout);
  const feedbackRows = feedbackTrainingSet.rows.length >= minFeedbackRows ? feedbackTrainingSet.rows : [];
  if (body.requireFeedbackRows === true && feedbackRows.length < minFeedbackRows) {
    throw new WorkspaceError("Runtime remoto não retornou linhas de feedback suficientes para retreino.", 409, {
      requestId: latestRequestId,
      minFeedbackRows,
      feedbackTrainingSet: { ...feedbackTrainingSet, rows: undefined },
    });
  }

  const mode = feedbackRows.length ? "mock" : (optionalSourcePreviewMode(body.mode) ?? "safe");
  const payload = trainBaselinePayload({
    ...body,
    sourceId,
    mode,
    allowExternal: mode === "real" || body.allowExternal === true,
    mockRows: feedbackRows.length ? feedbackRows : body.mockRows,
    incremental: true,
    previousRunId,
  });
  const feedback = isRecord(statusBody.feedback) ? statusBody.feedback : {};
  const retraining = {
    runtimeBaseUrl: base.toString(),
    requestId: latestRequestId,
    requestStatus: latestStatus,
    activeModelId: typeof latestRequest.active_model_id === "string" ? latestRequest.active_model_id : typeof feedback.active_model_id === "string" ? feedback.active_model_id : null,
    previousRunId,
    sourceId,
    trainingRowsSource: feedbackRows.length ? "runtime_feedback" : "project_source",
    feedbackRowsUsed: feedbackRows.length > 0,
    feedbackRows: {
      status: feedbackTrainingSet.status,
      endpoint: feedbackTrainingSet.endpoint,
      rowCount: feedbackTrainingSet.rowCount,
      used: feedbackRows.length,
      minRequired: minFeedbackRows,
      message: feedbackTrainingSet.message,
    },
    feedback: {
      count: numberOrNull(feedback.feedback_count),
      accuracy: numberOrNull(feedback.feedback_accuracy),
    },
    requestedAt: typeof latestRequest.created_at === "string" ? latestRequest.created_at : null,
    approvedAt: typeof latestRequest.approved_at === "string" ? latestRequest.approved_at : null,
  };
  return {
    ...payload,
    runtimeRetrainingRequest: retraining,
  };
}

function runtimeRetrainingRequestId(request: Record<string, unknown>): string | undefined {
  return typeof request.id === "string" && request.id.trim()
    ? request.id.trim()
    : typeof request.request_id === "string" && request.request_id.trim()
      ? request.request_id.trim()
      : undefined;
}

async function fetchRuntimeRetrainingStatus(base: URL, timeoutMs: number): Promise<Record<string, unknown>> {
  const url = new URL("/retraining/status", base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await response.text();
    const parsed = parseSmokeResponse(text, response.headers.get("content-type") ?? "");
    if (!response.ok || !isRecord(parsed)) {
      throw new WorkspaceError("Runtime remoto não expôs status de retreino controlado válido.", 409, {
        url: url.toString(),
        statusCode: response.status,
        body: compactSmokeBody(parsed),
      });
    }
    return parsed;
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    throw new WorkspaceError("Falha ao consultar status de retreino no runtime remoto.", 409, { url: url.toString(), message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRuntimeRetrainingTrainingSet(
  base: URL,
  requestId: string,
  body: RuntimeRetrainingJobBody,
  timeoutMs: number,
): Promise<{ status: "ok" | "skipped" | "missing" | "error"; endpoint: string; rowCount: number; rows: unknown[]; message?: string }> {
  if (body.preferFeedbackRows === false) {
    return { status: "skipped", endpoint: "", rowCount: 0, rows: [], message: "Uso de linhas de feedback desativado pela requisição." };
  }
  const limit = optionalFeedbackRowsLimit(body.feedbackRowsLimit) ?? Math.min(optionalTrainingMaxRows(body.maxRows) ?? 1000, 10_000);
  const pathName = `/retraining/requests/${encodeURIComponent(requestId)}/training-set`;
  const url = new URL(pathName, base);
  url.searchParams.set("limit", String(limit));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await response.text();
    const parsed = parseSmokeResponse(text, response.headers.get("content-type") ?? "");
    if (response.status === 404 || response.status === 405) {
      return { status: "missing", endpoint: url.toString(), rowCount: 0, rows: [], message: "Runtime não expõe dataset de feedback para retreino." };
    }
    if (!response.ok || !isRecord(parsed)) {
      return { status: "error", endpoint: url.toString(), rowCount: 0, rows: [], message: `Resposta inválida do training-set remoto: ${response.status}.` };
    }
    const rows = Array.isArray(parsed.rows) ? parsed.rows.filter(isRecord) : [];
    const rowCount = typeof parsed.row_count === "number" ? parsed.row_count : rows.length;
    return { status: "ok", endpoint: url.toString(), rowCount, rows };
  } catch (error) {
    return { status: "error", endpoint: url.toString(), rowCount: 0, rows: [], message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function completeFinishedRuntimeRetrainingJobs(workspaceRoot: string, queue: WorkerJobQueueConfig, workerJobs: Map<string, WorkerJobRecord>): Promise<void> {
  const candidates = Array.from(workerJobs.values()).filter((job) => {
    if (!isRecord(job.retraining) || !["completed", "failed", "cancelled"].includes(job.status)) {
      return false;
    }
    const completion = isRecord(job.retraining.completion) ? job.retraining.completion : {};
    if (completion.status === "ok") {
      return false;
    }
    const attempts = typeof completion.attempts === "number" && Number.isFinite(completion.attempts) ? completion.attempts : 0;
    return attempts < 3;
  });
  await Promise.all(candidates.map((job) => completeFinishedRuntimeRetrainingJob(workspaceRoot, queue, job)));
}

async function completeFinishedRuntimeRetrainingJob(workspaceRoot: string, queue: WorkerJobQueueConfig, job: WorkerJobRecord): Promise<void> {
  if (!isRecord(job.retraining)) {
    return;
  }
  const requestId = typeof job.retraining.requestId === "string" ? job.retraining.requestId : "";
  const runtimeBaseUrl = typeof job.retraining.runtimeBaseUrl === "string" ? job.retraining.runtimeBaseUrl : "";
  if (!requestId || !runtimeBaseUrl) {
    return;
  }
  const existingCompletion = isRecord(job.retraining.completion) ? job.retraining.completion : {};
  const attempts = (typeof existingCompletion.attempts === "number" && Number.isFinite(existingCompletion.attempts) ? existingCompletion.attempts : 0) + 1;
  job.retraining = {
    ...job.retraining,
    completion: {
      status: "running",
      attempts,
      attemptedAt: new Date().toISOString(),
    },
  };
  await queuePersistWorkerJob(workspaceRoot, queue, job);
  try {
    const completion = await completeRuntimeRetrainingRequest(runtimeBaseUrl, requestId, job);
    job.retraining = {
      ...job.retraining,
      requestStatus: typeof completion.status === "string" ? completion.status : job.retraining.requestStatus,
      completedAt: typeof completion.completed_at === "string" ? completion.completed_at : new Date().toISOString(),
      completion: {
        status: "ok",
        attempts,
        completedAt: new Date().toISOString(),
        remoteStatus: typeof completion.status === "string" ? completion.status : undefined,
      },
    };
    appendRuntimeRetrainingJobEvent(job, "info", "runtime_retraining_request_completed", "Solicitação remota de retreino finalizada pelo Studio.", { requestId, remoteStatus: completion.status });
  } catch (error) {
    job.retraining = {
      ...job.retraining,
      completion: {
        status: "error",
        attempts,
        failedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      },
    };
    appendRuntimeRetrainingJobEvent(job, "warning", "runtime_retraining_request_completion_failed", "Não foi possível finalizar a solicitação remota de retreino.", { requestId });
  }
  await queuePersistWorkerJob(workspaceRoot, queue, job);
}

async function completeRuntimeRetrainingRequest(runtimeBaseUrl: string, requestId: string, job: WorkerJobRecord): Promise<Record<string, unknown>> {
  const base = remoteRuntimeBaseUrl(runtimeBaseUrl);
  const url = new URL(`/retraining/requests/${encodeURIComponent(requestId)}/complete`, base);
  const trainingResult = isRecord(job.result) ? job.result : {};
  const primaryMetric = typeof trainingResult.primaryMetric === "string" ? trainingResult.primaryMetric : "";
  const leaderboard = Array.isArray(trainingResult.leaderboard) ? trainingResult.leaderboard.filter(isRecord) : [];
  const firstModel = leaderboard[0] ?? {};
  const firstMetrics = isRecord(firstModel.metrics) ? firstModel.metrics : {};
  const metricValue = primaryMetric
    ? firstMetrics[primaryMetric]
    : undefined;
  const body = {
    confirm: true,
    completed_by: "mlops-flow-studio",
    success: job.status === "completed",
    job_id: job.jobId,
    training_run_id: typeof trainingResult.runId === "string" ? trainingResult.runId : undefined,
    model_id: typeof trainingResult.bestModelId === "string" ? trainingResult.bestModelId : undefined,
    message: job.error ?? undefined,
    metrics: primaryMetric ? { [primaryMetric]: metricValue } : {},
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = parseSmokeResponse(text, response.headers.get("content-type") ?? "");
    if (!response.ok || !isRecord(parsed)) {
      throw new WorkspaceError("Runtime remoto não aceitou conclusão do retreino.", 409, { statusCode: response.status, body: compactSmokeBody(parsed) });
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function appendRuntimeRetrainingJobEvent(job: WorkerJobRecord, level: "info" | "warning" | "error", type: string, message: string, details: Record<string, unknown>): void {
  const event: WorkerJobEvent = {
    kind: "worker_event",
    timestamp: new Date().toISOString(),
    level,
    type,
    message,
    ...details,
  };
  job.events = [...job.events, event].slice(-200);
}

function evaluateModelPayload(body: EvaluateModelBody | undefined): Record<string, unknown> {
  return {
    sourceId: optionalBodyString(body?.sourceId, "sourceId"),
    runId: optionalBodyString(body?.runId, "runId"),
    modelId: optionalBodyString(body?.modelId, "modelId"),
    mode: optionalSourcePreviewMode(body?.mode),
    allowExternal: body?.allowExternal === true,
    maxRows: optionalTrainingMaxRows(body?.maxRows),
    mockRows: Array.isArray(body?.mockRows) ? body?.mockRows : undefined,
  };
}

function backtestModelsPayload(body: BacktestModelsBody | undefined): Record<string, unknown> {
  return {
    sourceId: optionalBodyString(body?.sourceId, "sourceId"),
    runId: optionalBodyString(body?.runId, "runId"),
    modelIds: Array.isArray(body?.modelIds) ? body.modelIds.filter((item) => typeof item === "string" && item.trim()) : undefined,
    baselineModelId: optionalBodyString(body?.baselineModelId, "baselineModelId"),
    neutralBand: optionalNeutralBand(body?.neutralBand),
    timeColumn: optionalBodyString(body?.timeColumn, "timeColumn"),
    windowStart: optionalBodyString(body?.windowStart, "windowStart"),
    windowEnd: optionalBodyString(body?.windowEnd, "windowEnd"),
    comparisonWindowStart: optionalBodyString(body?.comparisonWindowStart, "comparisonWindowStart"),
    comparisonWindowEnd: optionalBodyString(body?.comparisonWindowEnd, "comparisonWindowEnd"),
    windowGranularity: optionalWindowGranularity(body?.windowGranularity),
    mode: optionalSourcePreviewMode(body?.mode),
    allowExternal: body?.allowExternal === true,
    maxRows: optionalTrainingMaxRows(body?.maxRows),
    mockRows: Array.isArray(body?.mockRows) ? body?.mockRows : undefined,
  };
}

function pythonNodePayload(nodeId: string, body: PythonNodeRunBody | undefined): Record<string, unknown> {
  return {
    nodeId,
    input: isRecord(body?.input) ? body?.input : {},
    context: isRecord(body?.context) ? body?.context : {},
    isolationMode: body?.isolationMode === "container" || body?.isolationMode === "process" ? body.isolationMode : undefined,
  };
}

function sourcePreviewPayload(sourceId: string, body: SourcePreviewBody | undefined): Record<string, unknown> {
  return {
    sourceId,
    limit: optionalWorkerLimit(body?.limit),
    mode: optionalSourcePreviewMode(body?.mode),
    allowExternal: body?.allowExternal === true,
    mockRows: Array.isArray(body?.mockRows) ? body?.mockRows : undefined,
  };
}

async function prepareWorkerJobDatasetReplay(
  loaded: LoadedProjectBundle,
  command: WorkerCommand,
  payload: Record<string, unknown>,
  queue: WorkerJobQueueConfig,
  snapshotStore: DatasetSnapshotStoreConfig | undefined,
  snapshotEncryption: DatasetSnapshotEncryptionConfig | undefined,
  replayMode: WorkerJobDatasetReplayMode,
): Promise<{ payload: Record<string, unknown>; event?: WorkerJobEvent }> {
  if (replayMode === "off" || !workerCommandSupportsDatasetReplay(command) || Array.isArray(payload.mockRows)) {
    return { payload };
  }
  const sourceId = typeof payload.sourceId === "string" && payload.sourceId.trim() ? payload.sourceId.trim() : firstTrainableSourceId(loaded.project);
  if (!sourceId) {
    return { payload };
  }
  const source = projectDataSourceById(loaded.project, sourceId);
  if (!source || !sourceNeedsDatasetReplay(source, loaded.projectRoot, payload)) {
    return { payload };
  }
  const replay = await latestDatasetReplayRows(loaded, sourceId, snapshotStore, snapshotEncryption, payload.maxRows);
  if (!replay) {
    return { payload };
  }
  return {
    payload: {
      ...payload,
      sourceId,
      mode: "mock",
      allowExternal: false,
      mockRows: replay.rows,
      datasetReplay: {
        source: "dataset_snapshot",
        datasetVersionId: replay.datasetVersionId,
        sourceId,
        rowCount: replay.rows.length,
        rowArtifactMode: replay.rowArtifactMode,
        restored: replay.restored,
        queueBackend: queue.backend,
      },
    },
    event: {
      kind: "worker_event",
      level: "info",
      type: "dataset_snapshot_replayed",
      message: `Job usará snapshot ${replay.datasetVersionId} como replay de ${sourceId}.`,
      datasetVersionId: replay.datasetVersionId,
      sourceId,
      rowCount: replay.rows.length,
      rowArtifactMode: replay.rowArtifactMode,
      restored: replay.restored,
      queueBackend: queue.backend,
    },
  };
}

function workerCommandSupportsDatasetReplay(command: WorkerCommand): boolean {
  return command === "train-baseline" || command === "evaluate-model" || command === "backtest-models";
}

function firstTrainableSourceId(project: MLOpsProject): string | undefined {
  const sources = Array.isArray(project.dataSources) ? project.dataSources : [];
  for (const preferredType of ["csv", "sql", "api"]) {
    const source = sources.find((item) => item.type === preferredType);
    if (source?.id) {
      return source.id;
    }
  }
  return undefined;
}

function projectDataSourceById(project: MLOpsProject, sourceId: string): MLOpsProject["dataSources"][number] | undefined {
  return (Array.isArray(project.dataSources) ? project.dataSources : []).find((source) => source.id === sourceId);
}

function sourceNeedsDatasetReplay(source: MLOpsProject["dataSources"][number], projectRoot: string, payload: Record<string, unknown>): boolean {
  if (payload.mode === "real" || payload.allowExternal === true) {
    return false;
  }
  if (source.type !== "csv") {
    return true;
  }
  const csvPath = source.csv?.path;
  if (!csvPath) {
    return true;
  }
  try {
    return !pathExistsSync(safeResolve(projectRoot, csvPath));
  } catch {
    return true;
  }
}

function pathExistsSync(targetPath: string): boolean {
  try {
    return statSync(targetPath).isFile() || statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

async function latestDatasetReplayRows(
  loaded: LoadedProjectBundle,
  sourceId: string,
  snapshotStore: DatasetSnapshotStoreConfig | undefined,
  snapshotEncryption: DatasetSnapshotEncryptionConfig | undefined,
  maxRowsValue: unknown,
): Promise<{ datasetVersionId: string; rows: unknown[]; rowArtifactMode?: string; restored: boolean } | undefined> {
  const manifest = await latestDatasetManifestForSource(loaded, sourceId);
  if (!manifest) {
    return undefined;
  }
  const beforeRestorePath = isRecord(manifest.rowArtifact) && typeof manifest.rowArtifact.path === "string" ? manifest.rowArtifact.path : undefined;
  let effectiveManifest = manifest;
  let restored = false;
  if (!datasetManifestHasLocalRows(loaded, effectiveManifest) && snapshotStore) {
    const restoreResult = await restoreDatasetSnapshots(loaded, snapshotStore, snapshotEncryption);
    const restoredArtifacts = Array.isArray(restoreResult.artifacts) ? restoreResult.artifacts : [];
    restored = restoredArtifacts.some((artifact) => isRecord(artifact) && artifact.datasetVersionId === manifest.id);
    effectiveManifest = await readDatasetManifestById(loaded, String(manifest.id)) ?? manifest;
  }
  const rowArtifact = isRecord(effectiveManifest.rowArtifact) ? effectiveManifest.rowArtifact : {};
  const rowPath = typeof rowArtifact.path === "string" ? rowArtifact.path : beforeRestorePath;
  if (!rowPath) {
    return undefined;
  }
  const rowsPath = safeResolve(loaded.projectRoot, rowPath);
  if (!(await pathExists(rowsPath))) {
    return undefined;
  }
  const rowsText = await readFile(rowsPath, "utf-8");
  const digestCheck = verifyDatasetRowsDigestFromText(rowsText, typeof rowArtifact.digest === "string" ? rowArtifact.digest : undefined);
  if (!digestCheck.ok) {
    return undefined;
  }
  const rows = parseJsonlRows(rowsText);
  const maxRows = typeof maxRowsValue === "number" && Number.isFinite(maxRowsValue) ? Math.max(1, Math.floor(maxRowsValue)) : rows.length;
  return {
    datasetVersionId: String(effectiveManifest.id ?? manifest.id),
    rows: rows.slice(0, maxRows),
    rowArtifactMode: typeof rowArtifact.mode === "string" ? rowArtifact.mode : undefined,
    restored,
  };
}

async function latestDatasetManifestForSource(loaded: LoadedProjectBundle, sourceId: string): Promise<Record<string, unknown> | undefined> {
  const versionsRoot = path.join(loaded.projectRoot, "artifacts", "dataset_versions");
  let entries;
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const manifests: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".archive.json")) {
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(path.join(versionsRoot, entry.name), "utf-8")) as unknown;
      if (isRecord(manifest) && manifest.kind === "dataset_version" && manifest.sourceId === sourceId && isRecord(manifest.rowArtifact)) {
        manifests.push(manifest);
      }
    } catch {
      continue;
    }
  }
  return manifests.sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")))[0];
}

async function readDatasetManifestById(loaded: LoadedProjectBundle, datasetVersionId: string): Promise<Record<string, unknown> | undefined> {
  const manifestPath = path.join(loaded.projectRoot, "artifacts", "dataset_versions", `${safeStorageSegment(datasetVersionId)}.json`);
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
    return isRecord(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function datasetManifestHasLocalRows(loaded: LoadedProjectBundle, manifest: Record<string, unknown>): boolean {
  const rowArtifact = isRecord(manifest.rowArtifact) ? manifest.rowArtifact : {};
  if (rowArtifact.available !== true || typeof rowArtifact.path !== "string") {
    return false;
  }
  try {
    return pathExistsSync(safeResolve(loaded.projectRoot, rowArtifact.path));
  } catch {
    return false;
  }
}

async function startWorkerJob(
  workerJobs: Map<string, WorkerJobRecord>,
  workspaceRoot: string,
  queue: WorkerJobQueueConfig,
  snapshotStore: DatasetSnapshotStoreConfig | undefined,
  snapshotEncryption: DatasetSnapshotEncryptionConfig | undefined,
  datasetReplayMode: WorkerJobDatasetReplayMode,
  loaded: LoadedProjectBundle,
  command: WorkerCommand,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<WorkerJobRecord> {
  const replayPreparation = await prepareWorkerJobDatasetReplay(loaded, command, payload, queue, snapshotStore, snapshotEncryption, datasetReplayMode);
  const effectivePayload = replayPreparation.payload;
  const jobId = `job-${Date.now()}-${randomUUID()}`;
  const timeout = Math.max(1000, Math.min(timeoutMs, 1_800_000));
  const storeDir = workerJobStoreDir(workspaceRoot, queue);
  const requestPath = path.join(storeDir, `${safeWorkerJobFileName(jobId)}.request.json`);
  const createdAt = new Date().toISOString();
  const replayEvents = replayPreparation.event ? [{ ...replayPreparation.event, timestamp: createdAt }] : [];
  const job: WorkerJobRecord = {
    jobId,
    command,
    projectId: loaded.project.id,
    projectRoot: loaded.projectRoot,
    status: "queued",
    sourceId: typeof effectivePayload.sourceId === "string" ? effectivePayload.sourceId : undefined,
    nodeId: typeof effectivePayload.nodeId === "string" ? effectivePayload.nodeId : undefined,
    mode: typeof effectivePayload.mode === "string" ? effectivePayload.mode : undefined,
    label: workerJobLabel(command, effectivePayload),
    timeoutMs: timeout,
    queuedAt: createdAt,
    startedAt: createdAt,
    timedOut: false,
    stdout: "",
    stderr: "",
    events: [{
      kind: "worker_event",
      timestamp: createdAt,
      level: "info",
      type: "worker_job_queued",
      message: "Job aguardando vaga de execução.",
    }, ...replayEvents],
    stderrEventBuffer: "",
    retraining: isRecord(effectivePayload.runtimeRetrainingRequest) ? effectivePayload.runtimeRetrainingRequest : undefined,
    queueBackend: queue.backend,
    requestPath: toWorkerJobPathReference(workspaceRoot, queue, requestPath),
  };
  workerJobs.set(jobId, job);

  await mkdir(storeDir, { recursive: true });
  await writeFile(requestPath, `${JSON.stringify({
    command,
    projectRoot: loaded.projectRoot,
    project: loaded.project,
    pipeline: loaded.pipeline,
    emitEvents: true,
    ...effectivePayload,
  })}\n`, "utf-8");
  await queuePersistWorkerJob(workspaceRoot, queue, job);

  return job;
}

async function recoverWorkerJob(workspaceRoot: string, queue: WorkerJobQueueConfig, job: WorkerJobRecord): Promise<WorkerJobRecord> {
  if (job.status === "running") {
    return job;
  }
  if (job.status !== "recoverable") {
    throw new WorkspaceError("Apenas jobs recuperáveis podem ser retomados.", 409);
  }
  if (!job.requestPath) {
    throw new WorkspaceError("Job não possui request persistido para retomada.", 409);
  }
  const requestPath = resolveWorkerJobStoredPath(workspaceRoot, queue, job.requestPath);
  if (!(await pathExists(requestPath))) {
    throw new WorkspaceError("Request persistido do job não foi encontrado.", 409);
  }
  await releaseWorkerJobExecutionClaim(workspaceRoot, queue, job);
  job.status = "queued";
  job.error = undefined;
  job.finishedAt = undefined;
  job.exitCode = undefined;
  job.signal = undefined;
  job.timedOut = false;
  job.runnerPid = undefined;
  job.workerPid = undefined;
  job.runnerWorkerId = undefined;
  job.claimPath = undefined;
  job.slotPath = undefined;
  job.recoveryAttempts = (job.recoveryAttempts ?? 0) + 1;
  job.recoveredAt = new Date().toISOString();
  job.queuedAt = job.recoveredAt;
  job.runnerStartedAt = undefined;
  const recoveryEvent: WorkerJobEvent = {
    kind: "worker_event",
    timestamp: job.recoveredAt,
    level: "warning",
    type: "worker_job_recovered",
    message: "Job retomado a partir do request persistido.",
  };
  job.events = [
    ...job.events,
    recoveryEvent,
    {
      kind: "worker_event",
      timestamp: job.recoveredAt,
      level: "info",
      type: "worker_job_queued",
      message: "Job recuperado aguardando vaga de execução.",
    } satisfies WorkerJobEvent,
  ].slice(-200);
  await queuePersistWorkerJob(workspaceRoot, queue, job);
  return job;
}

async function dispatchQueuedWorkerJobs(workerJobs: Map<string, WorkerJobRecord>, workspaceRoot: string, queue: WorkerJobQueueConfig, concurrency: number): Promise<void> {
  let availableSlots = Math.max(0, concurrency - countRunningWorkerJobs(workerJobs));
  if (availableSlots <= 0) {
    return;
  }
  const queuedJobs = Array.from(workerJobs.values())
    .filter((job) => job.status === "queued")
    .sort((left, right) => (left.queuedAt ?? left.startedAt).localeCompare(right.queuedAt ?? right.startedAt));

  for (const job of queuedJobs) {
    if (availableSlots <= 0) {
      return;
    }
    const executionClaim = await acquireWorkerJobExecutionClaim(workspaceRoot, queue, job, concurrency);
    if (!executionClaim.acquired) {
      if (executionClaim.reason === "no_slot") {
        return;
      }
      continue;
    }
    job.claimPath = executionClaim.claimPath;
    job.slotPath = executionClaim.slotPath;
    const now = new Date().toISOString();
    let requestAvailable = false;
    try {
      requestAvailable = !!job.requestPath && (await pathExists(resolveWorkerJobStoredPath(workspaceRoot, queue, job.requestPath)));
    } catch {
      requestAvailable = false;
    }
    if (!requestAvailable) {
      await releaseWorkerJobExecutionClaim(workspaceRoot, queue, job);
      job.status = "failed";
      job.error = "Request persistido do job não foi encontrado para iniciar execução.";
      job.finishedAt = now;
      job.events = [
        ...job.events,
        {
          kind: "worker_event",
          timestamp: now,
          level: "error",
          type: "worker_job_start_failed",
          message: job.error,
        } satisfies WorkerJobEvent,
      ].slice(-200);
      await queuePersistWorkerJob(workspaceRoot, queue, job);
      continue;
    }
    job.status = "running";
    job.runnerStartedAt = now;
    job.finishedAt = undefined;
    job.exitCode = undefined;
    job.signal = undefined;
    job.error = undefined;
    job.timedOut = false;
    job.runnerWorkerId = queue.workerId;
    job.queueBackend = queue.backend;
    job.claimPath = executionClaim.claimPath;
    job.slotPath = executionClaim.slotPath;
    job.events = [
      ...job.events,
      {
        kind: "worker_event",
        timestamp: now,
        level: "info",
        type: "worker_job_started",
        message: queue.backend === "filesystem" ? "Job iniciado pelo dispatcher com fila filesystem compartilhada." : "Job iniciado pelo dispatcher local.",
      } satisfies WorkerJobEvent,
    ].slice(-200);
    await queuePersistWorkerJob(workspaceRoot, queue, job);
    await launchWorkerJobRunner(workspaceRoot, queue, job, job.timeoutMs ?? 600_000);
    availableSlots -= 1;
  }
}

async function acquireWorkerJobExecutionClaim(
  workspaceRoot: string,
  queue: WorkerJobQueueConfig,
  job: WorkerJobRecord,
  concurrency: number,
): Promise<
  | { acquired: true; claimPath?: string; slotPath?: string }
  | { acquired: false; reason: "claimed" | "no_slot" }
> {
  if (queue.backend === "local") {
    return { acquired: true };
  }
  const slotPath = await acquireWorkerJobSlot(queue, job, concurrency);
  if (!slotPath) {
    return { acquired: false, reason: "no_slot" };
  }
  const claimAbsolutePath = path.join(workerJobClaimsDir(queue), safeWorkerJobFileName(job.jobId));
  const claim = await tryAcquireWorkerJobLock(queue, claimAbsolutePath, "claim", job.jobId);
  if (!claim) {
    await releaseWorkerJobLockPath(queue, slotPath);
    return { acquired: false, reason: "claimed" };
  }
  return {
    acquired: true,
    claimPath: toWorkerJobPathReference(workspaceRoot, queue, claimAbsolutePath),
    slotPath,
  };
}

async function acquireWorkerJobSlot(queue: WorkerJobQueueConfig, job: WorkerJobRecord, concurrency: number): Promise<string | undefined> {
  for (let index = 0; index < Math.max(1, concurrency); index += 1) {
    const slotAbsolutePath = path.join(workerJobSlotsDir(queue), `slot-${index}`);
    const acquired = await tryAcquireWorkerJobLock(queue, slotAbsolutePath, "slot", job.jobId);
    if (acquired) {
      return toWorkerJobPathReference(job.projectRoot, queue, slotAbsolutePath);
    }
  }
  return undefined;
}

async function tryAcquireWorkerJobLock(queue: WorkerJobQueueConfig, lockPath: string, kind: "claim" | "slot", jobId: string): Promise<boolean> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeWorkerJobLockOwner(lockPath, queue, kind, jobId);
      return true;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "EEXIST") {
        throw error;
      }
      if (await workerJobLockIsFresh(lockPath, queue.claimTtlMs)) {
        return false;
      }
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  return false;
}

async function writeWorkerJobLockOwner(lockPath: string, queue: WorkerJobQueueConfig, kind: "claim" | "slot", jobId: string): Promise<void> {
  const now = new Date().toISOString();
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    kind,
    jobId,
    workerId: queue.workerId,
    pid: process.pid,
    acquiredAt: now,
    heartbeatAt: now,
  }, null, 2)}\n`, "utf-8");
}

async function workerJobLockIsFresh(lockPath: string, ttlMs: number): Promise<boolean> {
  const candidatePaths = [
    path.join(lockPath, "heartbeat.json"),
    path.join(lockPath, "owner.json"),
    lockPath,
  ];
  for (const candidatePath of candidatePaths) {
    try {
      const item = await stat(candidatePath);
      return Date.now() - item.mtimeMs <= ttlMs;
    } catch {
      continue;
    }
  }
  return false;
}

async function releaseWorkerJobExecutionClaim(workspaceRoot: string, queue: WorkerJobQueueConfig, job: WorkerJobRecord): Promise<void> {
  if (queue.backend === "local") {
    return;
  }
  await Promise.all([
    job.claimPath ? releaseWorkerJobLockPath(queue, job.claimPath) : Promise.resolve(),
    job.slotPath ? releaseWorkerJobLockPath(queue, job.slotPath) : Promise.resolve(),
  ]);
  job.claimPath = undefined;
  job.slotPath = undefined;
}

async function releaseWorkerJobLockPath(queue: WorkerJobQueueConfig, lockPathReference: string): Promise<void> {
  if (queue.backend === "local") {
    return;
  }
  await rm(resolveWorkerJobQueuePath(queue, lockPathReference), { recursive: true, force: true });
}

function workerJobClaimsDir(queue: WorkerJobQueueConfig): string {
  return path.join(queue.storeRoot, ".claims");
}

function workerJobSlotsDir(queue: WorkerJobQueueConfig): string {
  return path.join(queue.storeRoot, ".slots");
}

function countRunningWorkerJobs(workerJobs: Map<string, WorkerJobRecord>): number {
  return Array.from(workerJobs.values()).filter((job) => job.status === "running").length;
}

function currentWorkerJob(workerJobs: Map<string, WorkerJobRecord>, job: WorkerJobRecord): WorkerJobRecord {
  return workerJobs.get(job.jobId) ?? job;
}

function resolveWorkerJobConcurrency(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 4;
  }
  return Math.max(1, Math.min(32, Math.floor(parsed)));
}

function resolveWorkerJobQueue(options: BuildAppOptions, workspaceRoot: string): WorkerJobQueueConfig {
  const configuredRoot = resolveOptionalWorkerJobQueueRoot(options.workerJobQueueRoot ?? process.env.MLOPS_STUDIO_WORKER_QUEUE_ROOT);
  const workerId = optionalConfigString(options.workerJobWorkerId ?? process.env.MLOPS_STUDIO_WORKER_ID)
    ?? `${optionalConfigString(process.env.COMPUTERNAME) ?? optionalConfigString(process.env.HOSTNAME) ?? "local"}-${process.pid}`;
  return {
    backend: configuredRoot ? "filesystem" : "local",
    storeRoot: configuredRoot ?? workerJobDefaultStoreDir(workspaceRoot),
    workerId: safeWorkerJobWorkerId(workerId),
    claimTtlMs: resolveWorkerJobClaimTtlMs(options.workerJobClaimTtlMs ?? process.env.MLOPS_STUDIO_WORKER_CLAIM_TTL_MS),
  };
}

function resolveOptionalWorkerJobQueueRoot(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return path.resolve(value.trim());
}

function resolveWorkerJobClaimTtlMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30 * 60 * 1000;
  }
  return Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Math.floor(parsed)));
}

function resolveWorkerJobDatasetReplayMode(value: unknown): WorkerJobDatasetReplayMode {
  if (value === undefined || value === null || value === "") {
    return "auto";
  }
  if (typeof value !== "string") {
    throw new WorkspaceError("MLOPS_STUDIO_WORKER_DATASET_REPLAY deve ser auto ou off.", 409);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== "off" && normalized !== "auto") {
    throw new WorkspaceError("MLOPS_STUDIO_WORKER_DATASET_REPLAY deve ser auto ou off.", 409);
  }
  return normalized;
}

function safeWorkerJobWorkerId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 96) || `worker-${process.pid}`;
}

function resolveDatasetSnapshotStore(options: BuildAppOptions): DatasetSnapshotStoreConfig | undefined {
  const rawBackend = options.datasetSnapshotStoreBackend ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_STORE_BACKEND;
  const backend = normalizeDatasetSnapshotStoreBackend(rawBackend);
  const rawRoot = options.datasetSnapshotStoreRoot ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_STORE;
  const rawBucket = options.datasetSnapshotS3Bucket ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_S3_BUCKET;
  const rawEndpoint = options.datasetSnapshotS3Endpoint ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_S3_ENDPOINT;
  const shouldUseS3 = backend === "s3" || (backend === undefined && (hasText(rawBucket) || hasText(rawEndpoint)));

  if (shouldUseS3) {
    const bucket = optionalConfigString(rawBucket);
    if (!bucket) {
      throw new WorkspaceError("Storage S3/MinIO de snapshots exige MLOPS_STUDIO_DATASET_SNAPSHOT_S3_BUCKET.", 409);
    }
    const accessKeyId = optionalConfigString(options.datasetSnapshotS3AccessKeyId ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_S3_ACCESS_KEY_ID);
    const secretAccessKey = optionalConfigString(options.datasetSnapshotS3SecretAccessKey ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_S3_SECRET_ACCESS_KEY);
    const sessionToken = optionalConfigString(options.datasetSnapshotS3SessionToken ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_S3_SESSION_TOKEN);
    if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
      throw new WorkspaceError("Storage S3/MinIO de snapshots exige access key e secret key juntos.", 409);
    }
    const endpoint = optionalConfigString(rawEndpoint);
    const region = optionalConfigString(options.datasetSnapshotS3Region ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_S3_REGION) ?? "us-east-1";
    const forcePathStyle = resolveConfigBoolean(options.datasetSnapshotS3ForcePathStyle ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_S3_FORCE_PATH_STYLE, !!endpoint);
    const credentials = accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey, sessionToken }
      : undefined;
    return {
      type: "s3",
      bucket,
      prefix: normalizeDatasetSnapshotS3Prefix(options.datasetSnapshotS3Prefix ?? process.env.MLOPS_STUDIO_DATASET_SNAPSHOT_S3_PREFIX),
      endpoint,
      region,
      forcePathStyle,
      client: new S3Client({
        endpoint,
        region,
        forcePathStyle,
        credentials,
      }),
    };
  }

  if (backend === "filesystem" || hasText(rawRoot)) {
    const root = resolveOptionalDatasetSnapshotStoreRoot(rawRoot);
    return root ? { type: "filesystem", root } : undefined;
  }

  return undefined;
}

function normalizeDatasetSnapshotStoreBackend(value: unknown): "filesystem" | "s3" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new WorkspaceError("MLOPS_STUDIO_DATASET_SNAPSHOT_STORE_BACKEND deve ser filesystem ou s3.", 409);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== "filesystem" && normalized !== "s3") {
    throw new WorkspaceError("MLOPS_STUDIO_DATASET_SNAPSHOT_STORE_BACKEND deve ser filesystem ou s3.", 409);
  }
  return normalized;
}

function resolveOptionalDatasetSnapshotStoreRoot(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return path.resolve(value.trim());
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalConfigString(value: unknown): string | undefined {
  return hasText(value) ? value.trim() : undefined;
}

function resolveConfigBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "sim", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "nao", "não", "off"].includes(normalized)) {
    return false;
  }
  throw new WorkspaceError("Valor booleano de configuração inválido.", 409);
}

function resolveEmbeddingEnvironmentTimeoutMs(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 120_000;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 5_000 || parsed > 600_000) {
    throw new WorkspaceError("timeoutMs do smoke de embeddings deve ser inteiro entre 5000 e 600000.", 400);
  }
  return parsed;
}

function normalizeDatasetSnapshotS3Prefix(value: unknown): string {
  if (!hasText(value)) {
    return "";
  }
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function resolveDatasetSnapshotEncryption(rawKey: unknown, rawKeyRef: unknown): DatasetSnapshotEncryptionConfig | undefined {
  if (typeof rawKey !== "string" || !rawKey.trim()) {
    return undefined;
  }
  const keySource = rawKey.trim();
  const key = createHash("sha256").update(keySource, "utf-8").digest();
  return {
    key,
    keyRef: typeof rawKeyRef === "string" && rawKeyRef.trim() ? rawKeyRef.trim() : "env:MLOPS_STUDIO_DATASET_SNAPSHOT_ENCRYPTION_KEY",
    keyFingerprint: createHash("sha256").update(key).digest("hex"),
  };
}

function requireDatasetSnapshotStore(store: DatasetSnapshotStoreConfig | undefined): DatasetSnapshotStoreConfig {
  if (!store) {
    throw new WorkspaceError("Storage externo de snapshots não configurado. Defina MLOPS_STUDIO_DATASET_SNAPSHOT_STORE ou MLOPS_STUDIO_DATASET_SNAPSHOT_STORE_BACKEND=s3.", 409);
  }
  return store;
}

function datasetSnapshotArchiveRoot(storeRoot: string, projectId: string): string {
  return path.join(storeRoot, safeStorageSegment(projectId), "dataset_versions");
}

function datasetSnapshotArchiveKeyPrefix(store: DatasetSnapshotStoreConfig, projectId: string): string {
  const projectPrefix = `${safeStorageSegment(projectId)}/dataset_versions`;
  if (store.type === "s3" && store.prefix) {
    return `${store.prefix}/${projectPrefix}`;
  }
  return projectPrefix;
}

function datasetSnapshotArchiveKey(store: DatasetSnapshotStoreConfig, projectId: string, fileName: string): string {
  return `${datasetSnapshotArchiveKeyPrefix(store, projectId)}/${fileName}`;
}

function safeStorageSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function safeResolveStorePath(storeRoot: string, targetPath: string): string {
  const root = path.resolve(storeRoot);
  const resolved = path.resolve(root, targetPath);
  const normalizedRoot = root.toLowerCase();
  const normalizedResolved = resolved.toLowerCase();
  if (normalizedResolved !== normalizedRoot && !normalizedResolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new WorkspaceError(`Caminho fora do storage de snapshots: ${targetPath}`, 400);
  }
  return resolved;
}

function datasetSnapshotStoreLabel(store: DatasetSnapshotStoreConfig): string {
  if (store.type === "filesystem") {
    return store.root;
  }
  return store.prefix ? `s3://${store.bucket}/${store.prefix}` : `s3://${store.bucket}`;
}

function datasetSnapshotStorePath(store: DatasetSnapshotStoreConfig, key: string): string {
  if (store.type === "filesystem") {
    return key;
  }
  return `s3://${store.bucket}/${key}`;
}

function datasetSnapshotStoreRelativeMetadataPath(store: DatasetSnapshotStoreConfig, key: string): string {
  return datasetSnapshotStorePath(store, key);
}

function datasetSnapshotStoreResponse(store: DatasetSnapshotStoreConfig): Record<string, unknown> {
  if (store.type === "filesystem") {
    return { storeType: "filesystem", storeRoot: store.root };
  }
  return {
    storeType: "s3",
    storeUri: datasetSnapshotStoreLabel(store),
    bucket: store.bucket,
    prefix: store.prefix || undefined,
    endpoint: store.endpoint,
    region: store.region,
    forcePathStyle: store.forcePathStyle,
  };
}

async function datasetSnapshotWriteBuffer(store: DatasetSnapshotStoreConfig, key: string, content: Buffer, contentType = "application/octet-stream"): Promise<void> {
  if (store.type === "filesystem") {
    const targetPath = safeResolveStorePath(store.root, key);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
    return;
  }
  await store.client.send(new PutObjectCommand({
    Bucket: store.bucket,
    Key: key,
    Body: content,
    ContentType: contentType,
  }));
}

async function datasetSnapshotWriteJson(store: DatasetSnapshotStoreConfig, key: string, content: unknown): Promise<void> {
  await datasetSnapshotWriteBuffer(store, key, Buffer.from(`${JSON.stringify(content, null, 2)}\n`, "utf-8"), "application/json; charset=utf-8");
}

async function datasetSnapshotReadBuffer(store: DatasetSnapshotStoreConfig, keyOrStorePath: string): Promise<Buffer> {
  if (store.type === "filesystem") {
    return readFile(safeResolveStorePath(store.root, keyOrStorePath));
  }
  const key = datasetSnapshotS3KeyFromStorePath(store, keyOrStorePath);
  const response = await store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: key }));
  return responseBodyToBuffer(response.Body);
}

async function datasetSnapshotObjectExists(store: DatasetSnapshotStoreConfig, keyOrStorePath: string): Promise<boolean> {
  try {
    await datasetSnapshotReadBuffer(store, keyOrStorePath);
    return true;
  } catch {
    return false;
  }
}

async function datasetSnapshotListArchiveMetadata(store: DatasetSnapshotStoreConfig, projectId: string): Promise<string[]> {
  const prefix = datasetSnapshotArchiveKeyPrefix(store, projectId);
  if (store.type === "filesystem") {
    const archiveRoot = datasetSnapshotArchiveRoot(store.root, projectId);
    let entries;
    try {
      entries = await readdir(archiveRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".archive.json"))
      .map((entry) => `${prefix}/${entry.name}`);
  }

  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await store.client.send(new ListObjectsV2Command({
      Bucket: store.bucket,
      Prefix: `${prefix}/`,
      ContinuationToken: continuationToken,
    }));
    for (const item of response.Contents ?? []) {
      if (item.Key?.endsWith(".archive.json")) {
        keys.push(item.Key);
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

function datasetSnapshotS3KeyFromStorePath(store: DatasetSnapshotS3StoreConfig, storePath: string): string {
  if (!storePath.startsWith("s3://")) {
    return storePath.replace(/^\/+/, "");
  }
  const parsed = new URL(storePath);
  if (parsed.hostname !== store.bucket) {
    throw new WorkspaceError(`Snapshot arquivado aponta para bucket inesperado: ${parsed.hostname}`, 400);
  }
  return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
}

async function responseBodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf-8");
  }
  const transformable = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transformable.transformToByteArray === "function") {
    return Buffer.from(await transformable.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function bufferSha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function verifyDatasetRowsDigest(filePath: string, expectedDigest: string | undefined): Promise<{ ok: true } | { ok: false; error: string }> {
  return verifyDatasetRowsDigestFromText(await readFile(filePath, "utf-8"), expectedDigest);
}

function verifyDatasetRowsDigestFromText(content: string, expectedDigest: string | undefined): { ok: true } | { ok: false; error: string } {
  if (!expectedDigest) {
    return { ok: true };
  }
  let rows;
  try {
    rows = parseJsonlRows(content);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const actualDigest = stableHash(rows);
  if (actualDigest !== expectedDigest) {
    return { ok: false, error: "Digest lógico do snapshot diverge do manifesto." };
  }
  return { ok: true };
}

function encryptDatasetSnapshot(content: Buffer, config: DatasetSnapshotEncryptionConfig): { encrypted: Buffer; metadata: Record<string, unknown> } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.key, iv);
  const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted,
    metadata: {
      algorithm: "aes-256-gcm",
      keyRef: config.keyRef,
      keyFingerprint: config.keyFingerprint,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      originalFormat: "jsonl",
    },
  };
}

function decryptDatasetSnapshot(content: Buffer, metadata: Record<string, unknown>, config: DatasetSnapshotEncryptionConfig | undefined): Buffer {
  if (!config) {
    throw new WorkspaceError("Snapshot arquivado está criptografado, mas nenhuma chave foi configurada.", 409);
  }
  if (metadata.algorithm !== "aes-256-gcm") {
    throw new WorkspaceError("Algoritmo de criptografia de snapshot não suportado.", 422);
  }
  if (typeof metadata.keyFingerprint === "string" && metadata.keyFingerprint !== config.keyFingerprint) {
    throw new WorkspaceError("Chave de criptografia configurada não corresponde ao snapshot arquivado.", 409);
  }
  if (typeof metadata.iv !== "string" || typeof metadata.authTag !== "string") {
    throw new WorkspaceError("Metadados de criptografia do snapshot estão incompletos.", 422);
  }
  const decipher = createDecipheriv("aes-256-gcm", config.key, Buffer.from(metadata.iv, "base64"));
  decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));
  return Buffer.concat([decipher.update(content), decipher.final()]);
}

function parseJsonlRows(content: string): unknown[] {
  const rows: unknown[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    rows.push(JSON.parse(line) as unknown);
  }
  return rows;
}

async function launchWorkerJobRunner(workspaceRoot: string, queue: WorkerJobQueueConfig, job: WorkerJobRecord, timeoutMs: number): Promise<void> {
  const timeout = Math.max(1000, Math.min(timeoutMs, 1_800_000));
  const runnerScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "worker-job-runner.ts");
  const runner = spawn(process.execPath, [
    "--import",
    pathToFileURL(tsxLoaderPath()).href,
    runnerScript,
    "--workspaceRoot",
    workspaceRoot,
    "--jobStoreRoot",
    queue.storeRoot,
    "--workerId",
    queue.workerId,
    "--jobId",
    job.jobId,
    "--timeoutMs",
    String(timeout),
  ], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  runner.unref();
  job.runnerPid = runner.pid;
  job.runnerWorkerId = queue.workerId;
  await queuePersistWorkerJob(workspaceRoot, queue, job);
}

function serializeWorkerJob(job: WorkerJobRecord): Record<string, unknown> {
  return {
    jobId: job.jobId,
    command: job.command,
    projectId: job.projectId,
    projectRoot: job.projectRoot,
    status: job.status,
    sourceId: job.sourceId,
    nodeId: job.nodeId,
    mode: job.mode,
    label: job.label,
    timeoutMs: job.timeoutMs,
    queuedAt: job.queuedAt,
    runnerStartedAt: job.runnerStartedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    timedOut: job.timedOut,
    stdout: trimProcessOutput(job.stdout),
    stderr: trimProcessOutput(filterWorkerEventLines(job.stderr)),
    events: job.events,
    result: job.result,
    error: job.error,
    retraining: job.retraining,
    requestPath: job.requestPath,
    runnerPid: job.runnerPid,
    workerPid: job.workerPid,
    runnerWorkerId: job.runnerWorkerId,
    queueBackend: job.queueBackend,
    claimPath: job.claimPath,
    slotPath: job.slotPath,
    recoveryAttempts: job.recoveryAttempts,
    recoveredAt: job.recoveredAt,
  };
}

function serializedWorkerJobs(workerJobs: Map<string, WorkerJobRecord>): Array<Record<string, unknown>> {
  return Array.from(workerJobs.values())
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map(serializeWorkerJob);
}

function workerJobQueueStatus(workerJobs: Map<string, WorkerJobRecord>, concurrency: number, queue: WorkerJobQueueConfig): Record<string, unknown> {
  const jobs = Array.from(workerJobs.values());
  const running = jobs.filter((job) => job.status === "running").length;
  const queued = jobs.filter((job) => job.status === "queued").length;
  return {
    status: "ok",
    backend: queue.backend,
    storeRoot: queue.backend === "filesystem" ? queue.storeRoot : undefined,
    workerId: queue.workerId,
    claimTtlMs: queue.backend === "filesystem" ? queue.claimTtlMs : undefined,
    concurrency,
    running,
    queued,
    recoverable: jobs.filter((job) => job.status === "recoverable").length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    cancelled: jobs.filter((job) => job.status === "cancelled").length,
    availableSlots: Math.max(0, concurrency - running),
    total: jobs.length,
  };
}

async function loadPersistedWorkerJobs(workspaceRoot: string, queue: WorkerJobQueueConfig, workerJobs: Map<string, WorkerJobRecord>): Promise<void> {
  await refreshPersistedWorkerJobs(workspaceRoot, queue, workerJobs);
}

async function refreshPersistedWorkerJobs(workspaceRoot: string, queue: WorkerJobQueueConfig, workerJobs: Map<string, WorkerJobRecord>): Promise<void> {
  const storeDir = workerJobStoreDir(workspaceRoot, queue);
  let entries;
  try {
    entries = await readdir(storeDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".request.json") && !entry.name.startsWith("."))
    .map(async (entry) => {
      try {
        const filePath = path.join(storeDir, entry.name);
        const [content, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
        const raw = JSON.parse(content) as unknown;
        const job = restoreWorkerJobRecord(raw, fileStat.mtimeMs, queue);
        if (job) {
          workerJobs.set(job.jobId, job);
          if (job.status === "recoverable") {
            await releaseWorkerJobExecutionClaim(workspaceRoot, queue, job);
            await queuePersistWorkerJob(workspaceRoot, queue, job);
          }
        }
      } catch {
        return;
      }
    }));
}

function restoreWorkerJobRecord(raw: unknown, snapshotMtimeMs = 0, queue?: WorkerJobQueueConfig): WorkerJobRecord | null {
  if (!isRecord(raw) || typeof raw.jobId !== "string" || !isWorkerCommand(raw.command) || typeof raw.projectId !== "string" || typeof raw.projectRoot !== "string" || typeof raw.startedAt !== "string") {
    return null;
  }
  const status = isWorkerJobStatus(raw.status) ? raw.status : "failed";
  const runnerPid = typeof raw.runnerPid === "number" && Number.isInteger(raw.runnerPid) ? raw.runnerPid : undefined;
  const runnerFreshTtlMs = queue?.backend === "filesystem" ? queue.claimTtlMs : 5_000;
  const runnerRecentlyUpdated = snapshotMtimeMs > 0 && Date.now() - snapshotMtimeMs < runnerFreshTtlMs;
  const runnerWorkerId = typeof raw.runnerWorkerId === "string" ? raw.runnerWorkerId : undefined;
  const runnerMissing = status === "running"
    && (queue?.backend === "filesystem"
      ? !runnerRecentlyUpdated
      : (!runnerPid || (!isProcessAlive(runnerPid) && !runnerRecentlyUpdated)));
  const restoredStatus = runnerMissing ? "recoverable" : status;
  const restoredError = runnerMissing ? "Runner do job não está mais ativo; o job pode ser retomado a partir do request persistido." : typeof raw.error === "string" ? raw.error : undefined;
  const events = Array.isArray(raw.events) ? raw.events.filter(isWorkerJobEvent) : [];
  if (runnerMissing && !events.some((event) => event.type === "worker_job_recoverable")) {
    events.push({
      kind: "worker_event",
      timestamp: new Date().toISOString(),
      level: "warning",
      type: "worker_job_recoverable",
      message: "Runner destacado não está ativo; o job pode ser retomado.",
    });
  }
  return {
    jobId: raw.jobId,
    command: raw.command,
    projectId: raw.projectId,
    projectRoot: raw.projectRoot,
    status: restoredStatus,
    sourceId: typeof raw.sourceId === "string" ? raw.sourceId : undefined,
    nodeId: typeof raw.nodeId === "string" ? raw.nodeId : undefined,
    mode: typeof raw.mode === "string" ? raw.mode : undefined,
    label: typeof raw.label === "string" ? raw.label : undefined,
    timeoutMs: typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : undefined,
    queuedAt: typeof raw.queuedAt === "string" ? raw.queuedAt : undefined,
    runnerStartedAt: typeof raw.runnerStartedAt === "string" && !runnerMissing ? raw.runnerStartedAt : undefined,
    startedAt: raw.startedAt,
    finishedAt: typeof raw.finishedAt === "string" && !runnerMissing ? raw.finishedAt : undefined,
    exitCode: typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : undefined,
    signal: typeof raw.signal === "string" ? raw.signal as NodeJS.Signals : raw.signal === null ? null : undefined,
    timedOut: raw.timedOut === true,
    stdout: typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: typeof raw.stderr === "string" ? raw.stderr : "",
    events: events.slice(-200),
    stderrEventBuffer: "",
    result: raw.result,
    error: restoredError,
    retraining: isRecord(raw.retraining) ? raw.retraining : undefined,
    requestPath: typeof raw.requestPath === "string" ? raw.requestPath : undefined,
    runnerPid,
    workerPid: typeof raw.workerPid === "number" && Number.isInteger(raw.workerPid) ? raw.workerPid : undefined,
    runnerWorkerId,
    queueBackend: raw.queueBackend === "filesystem" || raw.queueBackend === "local" ? raw.queueBackend : queue?.backend,
    claimPath: typeof raw.claimPath === "string" ? raw.claimPath : undefined,
    slotPath: typeof raw.slotPath === "string" ? raw.slotPath : undefined,
    recoveryAttempts: typeof raw.recoveryAttempts === "number" && Number.isFinite(raw.recoveryAttempts) ? raw.recoveryAttempts : undefined,
    recoveredAt: typeof raw.recoveredAt === "string" ? raw.recoveredAt : undefined,
  };
}

function isWorkerCommand(value: unknown): value is WorkerCommand {
  return value === "run-python-block" || value === "preview-source" || value === "train-baseline" || value === "evaluate-model" || value === "backtest-models";
}

function isWorkerJobStatus(value: unknown): value is WorkerJobStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "cancelled" || value === "recoverable";
}

function isWorkerJobEvent(value: unknown): value is WorkerJobEvent {
  return isRecord(value) && value.kind === "worker_event";
}

function queuePersistWorkerJob(workspaceRoot: string, queue: WorkerJobQueueConfig, job: WorkerJobRecord): Promise<void> {
  const operation = (job.persistPromise ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => persistWorkerJob(workspaceRoot, queue, job));
  job.persistPromise = operation;
  return operation;
}

async function persistWorkerJob(workspaceRoot: string, queue: WorkerJobQueueConfig, job: WorkerJobRecord): Promise<void> {
  const storeDir = workerJobStoreDir(workspaceRoot, queue);
  await mkdir(storeDir, { recursive: true });
  const filePath = path.join(storeDir, `${safeWorkerJobFileName(job.jobId)}.json`);
  const tempPath = path.join(storeDir, `.${safeWorkerJobFileName(job.jobId)}.${Date.now()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(serializeWorkerJob(job), null, 2)}\n`, "utf-8");
  await retryRename(tempPath, filePath);
}

function workerJobStoreDir(workspaceRoot: string, queue?: WorkerJobQueueConfig): string {
  if (queue) {
    return queue.storeRoot;
  }
  return workerJobDefaultStoreDir(workspaceRoot);
}

function workerJobDefaultStoreDir(workspaceRoot: string): string {
  return safeResolve(workspaceRoot, ".mlops-studio/worker-jobs");
}

function toWorkerJobPathReference(workspaceRoot: string, queue: WorkerJobQueueConfig, absolutePath: string): string {
  const baseRoot = queue.backend === "filesystem" ? queue.storeRoot : workspaceRoot;
  return path.relative(baseRoot, path.resolve(absolutePath)).replaceAll(path.sep, "/");
}

function resolveWorkerJobStoredPath(workspaceRoot: string, queue: WorkerJobQueueConfig, targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    const resolved = path.resolve(targetPath);
    if (pathIsWithin(resolved, queue.storeRoot) || pathIsWithin(resolved, workspaceRoot)) {
      return resolved;
    }
    throw new WorkspaceError(`Caminho fora do workspace/fila de jobs: ${targetPath}`, 400);
  }
  if (targetPath.startsWith(".mlops-studio/") || targetPath.startsWith(".mlops-studio\\")) {
    return safeResolve(workspaceRoot, targetPath);
  }
  return resolveWorkerJobQueuePath(queue, targetPath);
}

function resolveWorkerJobQueuePath(queue: WorkerJobQueueConfig, targetPath: string): string {
  const resolved = path.resolve(queue.storeRoot, targetPath);
  if (!pathIsWithin(resolved, queue.storeRoot)) {
    throw new WorkspaceError(`Caminho fora da fila de jobs: ${targetPath}`, 400);
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

function safeWorkerJobFileName(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function tsxLoaderPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../node_modules/tsx/dist/loader.mjs");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function appendWorkerEvents(job: WorkerJobRecord, chunk: string): void {
  const lines = `${job.stderrEventBuffer}${chunk}`.split(/\r?\n/);
  job.stderrEventBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const event = parseWorkerEvent(trimmed);
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
    if (!isRecord(parsed) || parsed.kind !== "worker_event") {
      return null;
    }
    return parsed as WorkerJobEvent;
  } catch {
    return null;
  }
}

function filterWorkerEventLines(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !parseWorkerEvent(line.trim()))
    .join("\n");
}

function workerJobLabel(command: WorkerCommand, payload: Record<string, unknown>): string {
  if (command === "run-python-block") {
    return `Python ${String(payload.nodeId ?? "")}`.trim();
  }
  if (command === "preview-source") {
    const mode = typeof payload.mode === "string" ? ` ${payload.mode}` : "";
    return `Preview${mode} ${String(payload.sourceId ?? "")}`.trim();
  }
  if (command === "evaluate-model") {
    const mode = typeof payload.mode === "string" ? ` ${payload.mode}` : "";
    return `Avaliação${mode} ${String(payload.modelId ?? payload.sourceId ?? "")}`.trim();
  }
  if (command === "backtest-models") {
    const mode = typeof payload.mode === "string" ? ` ${payload.mode}` : "";
    return `Backtest${mode} ${String(payload.sourceId ?? "")}`.trim();
  }
  if (command === "train-baseline" && isRecord(payload.runtimeRetrainingRequest)) {
    const requestId = typeof payload.runtimeRetrainingRequest.requestId === "string" ? payload.runtimeRetrainingRequest.requestId : "";
    return `Retreino aprovado ${requestId} ${String(payload.sourceId ?? "")}`.trim();
  }
  if (command === "train-baseline" && payload.incremental === true) {
    const mode = typeof payload.mode === "string" ? ` ${payload.mode}` : "";
    return `Retreino incremental${mode} ${String(payload.sourceId ?? "")}`.trim();
  }
  const mode = typeof payload.mode === "string" ? ` ${payload.mode}` : "";
  return `Treino${mode} ${String(payload.sourceId ?? "")}`.trim();
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

async function workerDependencyStatus(workspaceRoot: string): Promise<Record<string, unknown>> {
  const requirementsPath = workerOptionalRequirementsPath();
  const requirements = await readWorkerOptionalRequirements(requirementsPath);
  const result = await runPythonJson(
    [
      "-c",
      `import importlib.metadata, importlib.util, json, sys
packages = [
  {"name": "scikit-learn", "importName": "sklearn"},
  {"name": "xgboost", "importName": "xgboost"},
  {"name": "sentence-transformers", "importName": "sentence_transformers"},
  {"name": "psycopg", "importName": "psycopg"},
  {"name": "mlflow", "importName": "mlflow"},
]
items = []
for item in packages:
    installed = importlib.util.find_spec(item["importName"]) is not None
    version = None
    if installed:
        try:
            version = importlib.metadata.version(item["name"])
        except importlib.metadata.PackageNotFoundError:
            version = None
    items.append({**item, "installed": installed, "version": version})
print(json.dumps({"python": sys.executable, "pythonVersion": sys.version.split()[0], "packages": items}, ensure_ascii=False))
`,
    ],
    workspaceRoot,
    20_000,
  );
  const packages = Array.isArray(result.parsed?.packages) ? result.parsed.packages : [];
  const withRequirements = packages.map((item) => {
    if (!isRecord(item)) {
      return item;
    }
    const requirement = requirements.find((entry) => entry.name.toLowerCase() === String(item.name ?? "").toLowerCase());
    return { ...item, requirement: requirement?.raw ?? null };
  });
  return {
    status: "ok",
    python: result.parsed?.python ?? workerPythonExecutable(),
    pythonVersion: result.parsed?.pythonVersion ?? null,
    requirementsPath: toWorkspaceRelative(workspaceRoot, requirementsPath),
    packages: withRequirements,
    ready: withRequirements.every((item) => isRecord(item) && item.installed === true),
  };
}

async function installWorkerOptionalDependencies(workspaceRoot: string, timeoutMs?: number): Promise<Record<string, unknown>> {
  const requirementsPath = workerOptionalRequirementsPath();
  const timeout = Math.max(30_000, Math.min(timeoutMs ?? 600_000, 1_800_000));
  const result = await runProcess(workerPythonExecutable(), ["-m", "pip", "install", "-r", requirementsPath], workspaceRoot, timeout);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new WorkspaceError(result.timedOut ? "Instalação de dependências excedeu o timeout." : "Instalação de dependências falhou.", result.timedOut ? 504 : 500, result);
  }
  return {
    status: "ok",
    command: `${workerPythonExecutable()} -m pip install -r ${toWorkspaceRelative(workspaceRoot, requirementsPath)}`,
    stdout: trimProcessOutput(result.stdout),
    stderr: trimProcessOutput(result.stderr),
    dependencies: await workerDependencyStatus(workspaceRoot),
  };
}

async function gpuEnvironmentStatus(workspaceRoot: string): Promise<Record<string, unknown>> {
  const [nvidia, docker, torch] = await Promise.all([
    nvidiaSmiStatus(workspaceRoot),
    dockerGpuRuntimeStatus(workspaceRoot),
    pythonTorchCudaStatus(workspaceRoot),
  ]);
  const nvidiaAvailable = nvidia.available === true;
  const dockerNvidiaAvailable = docker.nvidiaRuntime === true;
  const torchCudaAvailable = torch.cudaAvailable === true;
  const recommendation = torchCudaAvailable
    ? "gpu_cuda_ready"
    : nvidiaAvailable
      ? "gpu_driver_ready_python_cpu_fallback"
      : "cpu_only";
  return {
    status: "ok",
    checkedAt: new Date().toISOString(),
    recommendation,
    fallback: torchCudaAvailable ? "gpu_cuda" : "cpu",
    nvidiaSmi: nvidia,
    docker,
    python: torch,
    summary: {
      gpuDetected: nvidiaAvailable,
      dockerNvidiaRuntime: dockerNvidiaAvailable,
      torchCudaAvailable,
      canUseGpuProfile: nvidiaAvailable && (torchCudaAvailable || dockerNvidiaAvailable),
    },
  };
}

async function embeddingEnvironmentStatus(workspaceRoot: string, query: EmbeddingEnvironmentQuery = {}): Promise<Record<string, unknown>> {
  const modelName = optionalConfigString(query.model) ?? "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
  const device = optionalConfigString(query.device);
  const smoke = resolveConfigBoolean(query.smoke, false);
  const localFilesOnly = resolveConfigBoolean(query.localFilesOnly, true);
  const timeoutMs = resolveEmbeddingEnvironmentTimeoutMs(query.timeoutMs);
  const result = await runPythonJson(
    [
      "-c",
      `import importlib.metadata, importlib.util, json, sys, time
model_name = sys.argv[1]
smoke = sys.argv[2] == "1"
local_files_only = sys.argv[3] == "1"
device = sys.argv[4] or None

def package_status(name, import_name):
    installed = importlib.util.find_spec(import_name) is not None
    version = None
    if installed:
        try:
            version = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            version = None
    return {"name": name, "importName": import_name, "installed": installed, "version": version}

packages = {
    "sentenceTransformers": package_status("sentence-transformers", "sentence_transformers"),
    "transformers": package_status("transformers", "transformers"),
    "torch": package_status("torch", "torch"),
    "scikitLearn": package_status("scikit-learn", "sklearn"),
}
torch_status = {"installed": packages["torch"]["installed"], "cudaAvailable": False, "deviceCount": 0, "devices": []}
if packages["torch"]["installed"]:
    try:
        import torch
        devices = []
        if torch.cuda.is_available():
            for index in range(torch.cuda.device_count()):
                props = torch.cuda.get_device_properties(index)
                devices.append({"index": index, "name": props.name, "memoryTotalMiB": round(props.total_memory / 1024 / 1024)})
        torch_status.update({
            "torchVersion": getattr(torch, "__version__", None),
            "torchCudaVersion": getattr(torch.version, "cuda", None),
            "cudaAvailable": bool(torch.cuda.is_available()),
            "deviceCount": int(torch.cuda.device_count()) if torch.cuda.is_available() else 0,
            "devices": devices,
        })
    except Exception as error:
        torch_status.update({"error": f"{type(error).__name__}: {error}"})

payload = {
    "status": "ok",
    "python": sys.executable,
    "pythonVersion": sys.version.split()[0],
    "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "model": model_name,
    "deviceRequested": device,
    "localFilesOnly": local_files_only,
    "packages": packages,
    "torch": torch_status,
    "smoke": {"attempted": smoke, "ok": False, "sampleCount": 0},
}
if smoke:
    started = time.perf_counter()
    sample_texts = ["pagamento de boleto em atraso", "erro de login no portal"]
    if not packages["sentenceTransformers"]["installed"]:
        payload["smoke"] = {
            "attempted": True,
            "ok": False,
            "sampleCount": 0,
            "message": "Pacote sentence-transformers não está instalado no Python do worker.",
            "durationMs": round((time.perf_counter() - started) * 1000),
        }
    else:
        try:
            from sentence_transformers import SentenceTransformer
            kwargs = {"local_files_only": local_files_only}
            if device:
                kwargs["device"] = device
            try:
                model = SentenceTransformer(model_name, **kwargs)
            except TypeError:
                kwargs.pop("local_files_only", None)
                model = SentenceTransformer(model_name, **kwargs)
            vectors = model.encode(sample_texts, batch_size=2, show_progress_bar=False, convert_to_numpy=True, normalize_embeddings=True)
            shape = list(getattr(vectors, "shape", []))
            dimensions = int(shape[1]) if len(shape) > 1 else len(vectors[0]) if len(vectors) else 0
            payload["smoke"] = {
                "attempted": True,
                "ok": True,
                "sampleCount": len(sample_texts),
                "dimensions": dimensions,
                "shape": shape,
                "deviceUsed": str(getattr(model, "device", device or "")) or None,
                "durationMs": round((time.perf_counter() - started) * 1000),
            }
        except Exception as error:
            payload["smoke"] = {
                "attempted": True,
                "ok": False,
                "sampleCount": len(sample_texts),
                "message": f"{type(error).__name__}: {error}",
                "durationMs": round((time.perf_counter() - started) * 1000),
            }

if not packages["sentenceTransformers"]["installed"]:
    payload["recommendation"] = "package_missing"
elif smoke and payload["smoke"].get("ok"):
    payload["recommendation"] = "embedding_smoke_passed"
elif smoke:
    payload["recommendation"] = "model_unavailable_or_failed"
elif torch_status.get("cudaAvailable"):
    payload["recommendation"] = "package_ready_gpu_cuda"
else:
    payload["recommendation"] = "package_ready_cpu"
print(json.dumps(payload, ensure_ascii=False))
`,
      modelName,
      smoke ? "1" : "0",
      localFilesOnly ? "1" : "0",
      device ?? "",
    ],
    workspaceRoot,
    timeoutMs,
  );
  return result.parsed;
}

async function playwrightScrape(workspaceRoot: string, body: PlaywrightScrapeBody): Promise<Record<string, unknown>> {
  const target = requiredPlaywrightScrapeUrl(body);
  const timeoutMs = optionalBodyTimeoutMs(body.timeoutMs, "timeoutMs") ?? 30_000;
  const confirmDeepCrawl = optionalBodyBoolean(body.confirmDeepCrawl, "confirmDeepCrawl") === true;
  const maxLinks = optionalPlaywrightScrapeMaxLinks(body.maxLinks);
  const maxDepth = optionalPlaywrightScrapeMaxDepth(body.maxDepth, confirmDeepCrawl);
  const maxPages = optionalPlaywrightScrapeMaxPages(body.maxPages, confirmDeepCrawl);
  const auth = optionalPlaywrightScrapeAuth(body.auth, target, body.confirmAuthenticatedScrape);
  const includeScreenshot = optionalBodyBoolean(body.includeScreenshot, "includeScreenshot") ?? false;
  const { chromium } = await import("playwright").catch((error) => {
    throw new WorkspaceError("Playwright não está disponível para scraping controlado.", 503, error);
  });

  const browser = await chromium.launch({ headless: true });
  const startedAt = new Date().toISOString();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.setDefaultTimeout(timeoutMs);
    const authReport = auth ? await authenticatePlaywrightScrape(page, target, auth, timeoutMs) : null;
    const response = await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);

    const rootPage: Record<string, unknown> = {
      url: target.toString(),
      finalUrl: page.url(),
      statusCode: response?.status() ?? null,
      depth: 0,
      ...(await collectPlaywrightScrapePageData(page, maxLinks)),
    };

    const outputDir = safeResolve(workspaceRoot, path.join(".mlops-studio", "playwright-scrapes"));
    await mkdir(outputDir, { recursive: true });
    const stem = playwrightScrapeFileStem(target);
    const screenshotPath = includeScreenshot ? path.join(outputDir, `${stem}.png`) : null;
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
    const crawledPages = [rootPage, ...await crawlInternalPlaywrightScrapePages(page, rootPage, target, timeoutMs, maxLinks, maxDepth, maxPages)];
    const reportPath = path.join(outputDir, `${stem}.json`);
    const report = {
      status: "ok",
      kind: "playwright_scrape",
      url: target.toString(),
      finalUrl: rootPage.finalUrl,
      statusCode: rootPage.statusCode,
      scrapedAt: startedAt,
      timeoutMs,
      maxLinks,
      maxDepth,
      maxPages,
      deepCrawlConfirmed: confirmDeepCrawl,
      auth: authReport,
      crawledPageCount: crawledPages.length,
      screenshotPath: screenshotPath ? relativeWorkspacePath(workspaceRoot, screenshotPath) : null,
      reportPath: relativeWorkspacePath(workspaceRoot, reportPath),
      title: scrapeString(rootPage.title),
      description: scrapeString(rootPage.description),
      canonical: scrapeString(rootPage.canonical),
      headings: aggregatePlaywrightScrapeRecords(crawledPages, "headings", (item) => `${scrapeString(item.level)}:${scrapeString(item.text)}`, 100),
      links: aggregatePlaywrightScrapeRecords(crawledPages, "links", (item) => scrapeString(item.href), maxLinks),
      forms: aggregatePlaywrightScrapeRecords(crawledPages, "forms", (item) => `${scrapeString(item.method).toUpperCase()} ${scrapeString(item.action)}`, 25),
      apiCandidates: aggregatePlaywrightScrapeRecords(crawledPages, "apiCandidates", (item) => scrapeString(item.href), 25),
      crawledPages,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    return report;
  } finally {
    await browser.close();
  }
}

async function collectPlaywrightScrapePageData(page: { evaluate: (script: string) => Promise<unknown> }, maxLinks: number): Promise<Record<string, unknown>> {
  return await page.evaluate(`(() => {
    const limit = ${maxLinks};
    const text = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const attr = (element, name) => text(element.getAttribute(name));
    const description = text(document.querySelector('meta[name="description"]')?.getAttribute("content"));
    const canonical = text(document.querySelector('link[rel="canonical"]')?.getAttribute("href"));
    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .map((item) => ({ level: item.tagName.toLowerCase(), text: text(item.textContent) }))
      .filter((item) => item.text)
      .slice(0, 100);
    const seenLinks = new Set();
    const links = Array.from(document.querySelectorAll("a[href]"))
      .map((item) => {
        const href = attr(item, "href");
        return { text: text(item.textContent), href };
      })
      .filter((item) => item.href && !seenLinks.has(item.href) && seenLinks.add(item.href))
      .slice(0, limit);
    const forms = Array.from(document.querySelectorAll("form"))
      .map((form) => ({
        method: attr(form, "method") || "GET",
        action: attr(form, "action") || location.href,
        inputs: Array.from(form.querySelectorAll("input,textarea,select"))
          .map((field) => ({
            tag: field.tagName.toLowerCase(),
            name: attr(field, "name"),
            type: attr(field, "type") || field.tagName.toLowerCase(),
            placeholder: attr(field, "placeholder"),
            required: field.hasAttribute("required"),
          }))
          .filter((field) => field.name || field.placeholder),
      }))
      .slice(0, 25);
    const apiPattern = new RegExp("openapi|swagger|redoc|api-docs|api/docs|docs/api|\\\\.ya?ml|\\\\.json", "i");
    const apiCandidates = links
      .filter((item) => apiPattern.test(item.href) || apiPattern.test(item.text))
      .slice(0, 25);

    return {
      title: text(document.title),
      description,
      canonical,
      headings,
      links,
      forms,
      apiCandidates,
    };
  })()`) as Record<string, unknown>;
}

async function crawlInternalPlaywrightScrapePages(
  page: {
    evaluate: (script: string) => Promise<unknown>;
    goto: (url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number }) => Promise<{ status: () => number } | null>;
    waitForLoadState: (state?: "load" | "domcontentloaded" | "networkidle", options?: { timeout?: number }) => Promise<unknown>;
    url: () => string;
  },
  rootPage: Record<string, unknown>,
  target: URL,
  timeoutMs: number,
  maxLinks: number,
  maxDepth: number,
  maxPages: number,
): Promise<Array<Record<string, unknown>>> {
  if (maxDepth < 1 || maxPages < 2) {
    return [];
  }
  const visited = new Set([playwrightScrapeVisitKey(scrapeString(rootPage.finalUrl) || target.toString())]);
  const queue = playwrightScrapeInternalLinks(rootPage, target, 1);
  const crawled: Array<Record<string, unknown>> = [];
  while (queue.length && (crawled.length + 1) < maxPages) {
    const next = queue.shift() as { url: string; depth: number };
    const key = playwrightScrapeVisitKey(next.url);
    if (visited.has(key) || next.depth > maxDepth) {
      continue;
    }
    visited.add(key);
    const response = await page.goto(next.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);
    const pageReport = {
      url: next.url,
      finalUrl: page.url(),
      statusCode: response?.status() ?? null,
      depth: next.depth,
      ...(await collectPlaywrightScrapePageData(page, maxLinks)),
    };
    crawled.push(pageReport);
    if (next.depth < maxDepth) {
      for (const candidate of playwrightScrapeInternalLinks(pageReport, target, next.depth + 1)) {
        if (!visited.has(playwrightScrapeVisitKey(candidate.url))) {
          queue.push(candidate);
        }
      }
    }
  }
  return crawled;
}

function playwrightScrapeInternalLinks(pageReport: Record<string, unknown>, target: URL, depth: number): Array<{ url: string; depth: number }> {
  const sourceUrl = scrapeString(pageReport.finalUrl) || target.toString();
  return recordArray(pageReport.links).flatMap((link) => {
    const href = scrapeString(link.href);
    if (!href) {
      return [];
    }
    try {
      const url = new URL(href, sourceUrl);
      if (url.origin !== target.origin || url.hash || url.protocol !== target.protocol) {
        return [];
      }
      return [{ url: url.toString(), depth }];
    } catch {
      return [];
    }
  });
}

function playwrightScrapeVisitKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function aggregatePlaywrightScrapeRecords(pages: Array<Record<string, unknown>>, field: string, keyFor: (item: Record<string, unknown>) => string, limit: number): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const items: Array<Record<string, unknown>> = [];
  for (const page of pages) {
    const sourceUrl = scrapeString(page.finalUrl);
    for (const rawItem of recordArray(page[field])) {
      const key = keyFor(rawItem);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({ ...rawItem, sourceUrl });
      if (items.length >= limit) {
        return items;
      }
    }
  }
  return items;
}

function requiredPlaywrightScrapeUrl(body: PlaywrightScrapeBody): URL {
  const rawUrl = requiredBodyString(body.url, "url");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new WorkspaceError("url inválida para scraping Playwright.", 400, error);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WorkspaceError("Scraping Playwright só aceita URLs http ou https.", 400);
  }
  if (parsed.username || parsed.password) {
    throw new WorkspaceError("url de scraping não deve incluir credenciais.", 400);
  }
  if (!isLocalScrapeHost(parsed.hostname) && body.confirmExternalNavigation !== true) {
    throw new WorkspaceError("Scraping de URL externa exige confirmExternalNavigation: true.", 409);
  }
  return parsed;
}

function isLocalScrapeHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function optionalPlaywrightScrapeMaxLinks(value: unknown): number {
  if (value === undefined) {
    return 80;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 500) {
    throw new WorkspaceError("maxLinks deve ser inteiro entre 1 e 500.", 400);
  }
  return value;
}

function optionalPlaywrightScrapeMaxDepth(value: unknown, confirmDeepCrawl = false): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
    throw new WorkspaceError("maxDepth deve ser inteiro entre 0 e 5.", 400);
  }
  if (value > 2 && !confirmDeepCrawl) {
    throw new WorkspaceError("Crawl profundo exige confirmDeepCrawl: true para maxDepth maior que 2.", 409);
  }
  return value;
}

function optionalPlaywrightScrapeMaxPages(value: unknown, confirmDeepCrawl = false): number {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new WorkspaceError("maxPages deve ser inteiro entre 1 e 50.", 400);
  }
  if (value > 10 && !confirmDeepCrawl) {
    throw new WorkspaceError("Crawl profundo exige confirmDeepCrawl: true para maxPages maior que 10.", 409);
  }
  return value;
}

function optionalPlaywrightScrapeAuth(value: unknown, target: URL, confirmAuthenticatedScrape: unknown): PlaywrightScrapeAuthConfig | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new WorkspaceError("auth de scraping Playwright deve ser objeto.", 400);
  }
  if (optionalBodyBoolean(confirmAuthenticatedScrape, "confirmAuthenticatedScrape") !== true) {
    throw new WorkspaceError("Scraping autenticado exige confirmAuthenticatedScrape: true.", 409);
  }
  const loginUrl = playwrightScrapeAuthLoginUrl(value.loginUrl, target);
  const usernameSelector = optionalPlaywrightScrapeAuthSelector(value.usernameSelector, "auth.usernameSelector");
  const passwordSelector = optionalPlaywrightScrapeAuthSelector(value.passwordSelector, "auth.passwordSelector") ?? "input[type=\"password\"]";
  const submitSelector = optionalPlaywrightScrapeAuthSelector(value.submitSelector, "auth.submitSelector");
  const successSelector = optionalPlaywrightScrapeAuthSelector(value.successSelector, "auth.successSelector");
  const username = optionalPlaywrightScrapeAuthValue(value.username, value.usernameRef, "auth.username", "auth.usernameRef");
  const usernameSource = scrapeString(value.usernameRef) || (username ? "inline:username" : "");
  const passwordRef = scrapeString(value.passwordRef);
  if (!passwordRef) {
    throw new WorkspaceError("Scraping autenticado exige auth.passwordRef por referência env:VAR.", 400);
  }
  const password = playwrightScrapeSecretFromEnvRef(passwordRef, "auth.passwordRef");
  return {
    loginUrl,
    username,
    usernameSource,
    password,
    passwordRef,
    usernameSelector,
    passwordSelector,
    submitSelector,
    successSelector,
    waitAfterSubmitMs: optionalPlaywrightScrapeAuthWaitMs(value.waitAfterSubmitMs),
  };
}

function playwrightScrapeAuthLoginUrl(value: unknown, target: URL): URL {
  const raw = scrapeString(value) || target.toString();
  let loginUrl: URL;
  try {
    loginUrl = new URL(raw, target);
  } catch (error) {
    throw new WorkspaceError("auth.loginUrl inválida para scraping Playwright.", 400, error);
  }
  if (loginUrl.origin !== target.origin || loginUrl.protocol !== target.protocol) {
    throw new WorkspaceError("auth.loginUrl deve usar a mesma origem da URL scrapeada.", 400);
  }
  if (loginUrl.username || loginUrl.password) {
    throw new WorkspaceError("auth.loginUrl não deve incluir credenciais.", 400);
  }
  return loginUrl;
}

function optionalPlaywrightScrapeAuthSelector(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const selector = scrapeString(value);
  if (!selector || selector.length > 200) {
    throw new WorkspaceError(`${fieldName} deve ser um seletor CSS de até 200 caracteres.`, 400);
  }
  return selector;
}

function optionalPlaywrightScrapeAuthValue(value: unknown, ref: unknown, valueField: string, refField: string): string {
  const rawRef = scrapeString(ref);
  if (rawRef) {
    return playwrightScrapeSecretFromEnvRef(rawRef, refField);
  }
  const rawValue = scrapeString(value);
  if (rawValue.length > 200) {
    throw new WorkspaceError(`${valueField} deve ter até 200 caracteres.`, 400);
  }
  return rawValue;
}

function playwrightScrapeSecretFromEnvRef(ref: string, fieldName: string): string {
  if (!ref.startsWith("env:")) {
    throw new WorkspaceError(`${fieldName} deve usar referência env:VAR.`, 400);
  }
  const envName = ref.slice("env:".length);
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(envName)) {
    throw new WorkspaceError(`${fieldName} contém nome de variável inválido.`, 400);
  }
  const value = process.env[envName];
  if (!value) {
    throw new WorkspaceError(`${fieldName} referencia variável de ambiente ausente ou vazia.`, 400);
  }
  return value;
}

function optionalPlaywrightScrapeAuthWaitMs(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5_000) {
    throw new WorkspaceError("auth.waitAfterSubmitMs deve ser inteiro entre 0 e 5000.", 400);
  }
  return value;
}

async function authenticatePlaywrightScrape(
  page: {
    goto: (url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number }) => Promise<{ status: () => number } | null>;
    fill: (selector: string, value: string, options?: { timeout?: number }) => Promise<void>;
    click: (selector: string, options?: { timeout?: number }) => Promise<void>;
    waitForSelector: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
    waitForLoadState: (state?: "load" | "domcontentloaded" | "networkidle", options?: { timeout?: number }) => Promise<unknown>;
    waitForTimeout: (timeout: number) => Promise<void>;
    keyboard: { press: (key: string) => Promise<void> };
    url: () => string;
  },
  target: URL,
  auth: PlaywrightScrapeAuthConfig,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const response = await page.goto(auth.loginUrl.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);
  if (auth.usernameSelector && auth.username) {
    await page.fill(auth.usernameSelector, auth.username, { timeout: timeoutMs });
  }
  await page.fill(auth.passwordSelector, auth.password, { timeout: timeoutMs });
  if (auth.submitSelector) {
    await page.click(auth.submitSelector, { timeout: timeoutMs });
  } else {
    await page.keyboard.press("Enter");
  }
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);
  if (auth.waitAfterSubmitMs > 0) {
    await page.waitForTimeout(auth.waitAfterSubmitMs);
  }
  if (auth.successSelector) {
    await page.waitForSelector(auth.successSelector, { timeout: timeoutMs });
  }
  return {
    mode: "form",
    loginUrl: auth.loginUrl.toString(),
    loginStatusCode: response?.status() ?? null,
    finalLoginUrl: page.url(),
    targetOrigin: target.origin,
    usernameSource: auth.usernameSource || null,
    passwordRef: auth.passwordRef,
    usernameSelector: auth.usernameSelector,
    passwordSelector: auth.passwordSelector,
    submitSelector: auth.submitSelector,
    successSelector: auth.successSelector,
    authenticatedAt: new Date().toISOString(),
  };
}

function playwrightScrapeFileStem(target: URL): string {
  const raw = `${target.hostname}-${target.pathname || "root"}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || `scrape-${Date.now()}`;
}

function relativeWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).replaceAll(path.sep, "/");
}

async function nvidiaSmiStatus(workspaceRoot: string): Promise<Record<string, unknown>> {
  try {
    const query = await runProcess("nvidia-smi", ["--query-gpu=name,driver_version,memory.total,memory.used,memory.free,utilization.gpu", "--format=csv,noheader,nounits"], workspaceRoot, 10_000);
    if (query.exitCode !== 0 || query.timedOut) {
      return { available: false, reason: query.timedOut ? "timeout" : trimProcessOutput(query.stderr || query.stdout) };
    }
    const full = await runProcess("nvidia-smi", [], workspaceRoot, 10_000).catch(() => null);
    const cudaVersion = full ? /CUDA Version:\s*([0-9.]+)/.exec(full.stdout)?.[1] ?? null : null;
    const gpus = query.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, driverVersion, memoryTotalMiB, memoryUsedMiB, memoryFreeMiB, utilizationGpuPercent] = line.split(",").map((item) => item.trim());
        return {
          name,
          driverVersion,
          cudaVersion,
          memoryTotalMiB: Number(memoryTotalMiB),
          memoryUsedMiB: Number(memoryUsedMiB),
          memoryFreeMiB: Number(memoryFreeMiB),
          utilizationGpuPercent: Number(utilizationGpuPercent),
        };
      });
    return { available: gpus.length > 0, gpus, raw: trimProcessOutput(query.stdout) };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function dockerGpuRuntimeStatus(workspaceRoot: string): Promise<Record<string, unknown>> {
  try {
    const version = await runProcess("docker", ["--version"], workspaceRoot, 10_000);
    if (version.exitCode !== 0 || version.timedOut) {
      return { available: false, nvidiaRuntime: false, reason: version.timedOut ? "timeout" : trimProcessOutput(version.stderr || version.stdout) };
    }
    const info = await runProcess("docker", ["info", "--format", "{{json .Runtimes}}"], workspaceRoot, 10_000);
    let runtimes: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(info.stdout.trim() || "{}") as unknown;
      runtimes = isRecord(parsed) ? parsed : {};
    } catch {
      runtimes = {};
    }
    return {
      available: true,
      version: trimProcessOutput(version.stdout || version.stderr).trim(),
      nvidiaRuntime: Object.prototype.hasOwnProperty.call(runtimes, "nvidia"),
      runtimes: Object.keys(runtimes).sort(),
      error: info.exitCode !== 0 || info.timedOut ? trimProcessOutput(info.stderr || info.stdout) : undefined,
    };
  } catch (error) {
    return { available: false, nvidiaRuntime: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function pythonTorchCudaStatus(workspaceRoot: string): Promise<Record<string, unknown>> {
  try {
    const result = await runPythonJson(
      [
        "-c",
        `import importlib.util, json, sys
payload = {"python": sys.executable, "pythonVersion": sys.version.split()[0], "torchInstalled": importlib.util.find_spec("torch") is not None}
if payload["torchInstalled"]:
    import torch
    devices = []
    if torch.cuda.is_available():
        for index in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(index)
            devices.append({"index": index, "name": props.name, "memoryTotalMiB": round(props.total_memory / 1024 / 1024)})
    payload.update({
        "torchVersion": getattr(torch, "__version__", None),
        "torchCudaVersion": getattr(torch.version, "cuda", None),
        "cudaAvailable": bool(torch.cuda.is_available()),
        "deviceCount": int(torch.cuda.device_count()) if torch.cuda.is_available() else 0,
        "devices": devices,
    })
else:
    payload.update({"cudaAvailable": False, "deviceCount": 0, "devices": []})
print(json.dumps(payload, ensure_ascii=False))
`,
      ],
      workspaceRoot,
      20_000,
    );
    return { available: true, ...result.parsed };
  } catch (error) {
    return {
      available: false,
      torchInstalled: false,
      cudaAvailable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function workerOptionalRequirementsPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../worker/requirements-optional.txt");
}

async function readWorkerOptionalRequirements(requirementsPath: string): Promise<Array<{ name: string; raw: string }>> {
  const raw = await readFile(requirementsPath, "utf-8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const packageName = line.split(/[<>=~! ]/, 1)[0].split("[", 1)[0];
      return { name: packageName, raw: line };
    });
}

async function runPythonJson(args: string[], workspaceRoot: string, timeoutMs: number): Promise<{ parsed: Record<string, unknown>; stdout: string; stderr: string }> {
  const result = await runProcess(workerPythonExecutable(), args, workspaceRoot, timeoutMs);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new WorkspaceError(result.timedOut ? "Python excedeu o timeout." : "Python falhou ao checar ambiente.", result.timedOut ? 504 : 500, result);
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("JSON raiz não é objeto.");
    }
    return { parsed, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    throw new WorkspaceError("Python não retornou JSON válido ao checar ambiente.", 500, { ...result, parseError: error instanceof Error ? error.message : String(error) });
  }
}

async function runProcess(command: string, args: string[], workspaceRoot: string, timeoutMs: number): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
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
      reject(new WorkspaceError(`Não foi possível iniciar processo: ${error.message}`, 500, { command, args }));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function trimProcessOutput(value: string): string {
  return value.length > 32_000 ? value.slice(-32_000) : value;
}

async function listTrainingRuns(loaded: LoadedProjectBundle): Promise<Array<Record<string, unknown>>> {
  const runsRoot = path.join(loaded.projectRoot, "artifacts", "training_runs");
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      runs.push(await readTrainingResult(path.join(runsRoot, entry.name), entry.name, loaded.project));
    } catch {
      continue;
    }
  }
  return runs.sort((left, right) => trainingRunTimestamp(right) - trainingRunTimestamp(left));
}

async function loadTrainingRun(loaded: LoadedProjectBundle, runId: string): Promise<Record<string, unknown>> {
  const safeRunId = normalizeTrainingRunId(runId);
  const run = await readTrainingResult(path.join(loaded.projectRoot, "artifacts", "training_runs", safeRunId), safeRunId, loaded.project);
  if (run.projectId && run.projectId !== loaded.project.id) {
    throw new WorkspaceError(`Run ${safeRunId} não pertence ao projeto ${loaded.project.id}.`, 409);
  }
  return run;
}

async function datasetSnapshotStatus(loaded: LoadedProjectBundle, store: DatasetSnapshotStoreConfig | undefined, encryption: DatasetSnapshotEncryptionConfig | undefined): Promise<Record<string, unknown>> {
  const versionsRoot = path.join(loaded.projectRoot, "artifacts", "dataset_versions");
  const now = Date.now();
  const expiringSoonLimit = now + 7 * 24 * 60 * 60 * 1000;
  const artifacts: Array<Record<string, unknown>> = [];
  const local = {
    manifestCount: 0,
    rowArtifactCount: 0,
    availableRows: 0,
    missingRows: 0,
    purgedRows: 0,
    archivedRows: 0,
    expiredRows: 0,
    expiringSoonRows: 0,
    maskedRows: 0,
    fullRows: 0,
    manifestOnlyRows: 0,
    totalRows: 0,
    skipped: 0,
  };
  let entries: Array<{ name: string; isFile(): boolean }> = [];
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true });
  } catch {
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".rows.jsonl")) {
      continue;
    }
    const manifestPath = path.join(versionsRoot, entry.name);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
    } catch {
      local.skipped += 1;
      continue;
    }
    if (!isRecord(manifest)) {
      local.skipped += 1;
      continue;
    }
    local.manifestCount += 1;
    const datasetVersionId = typeof manifest.id === "string" ? manifest.id : path.basename(entry.name, ".json");
    const rowArtifact = isRecord(manifest.rowArtifact) ? manifest.rowArtifact : undefined;
    if (!rowArtifact) {
      continue;
    }
    local.rowArtifactCount += 1;
    const mode = typeof rowArtifact.mode === "string" ? rowArtifact.mode : "manifest";
    if (mode === "masked_rows") {
      local.maskedRows += 1;
    } else if (mode === "full_rows") {
      local.fullRows += 1;
    } else {
      local.manifestOnlyRows += 1;
    }
    const rowCount = typeof rowArtifact.rowCount === "number" && Number.isFinite(rowArtifact.rowCount) ? rowArtifact.rowCount : 0;
    local.totalRows += rowCount;
    const hasLocalPath = typeof rowArtifact.path === "string" && rowArtifact.path.trim().length > 0;
    const localPath = hasLocalPath ? rowArtifact.path as string : undefined;
    const localFileExists = localPath ? await pathExists(safeResolve(loaded.projectRoot, localPath)) : false;
    if (rowArtifact.available === true && localFileExists) {
      local.availableRows += 1;
    } else if (rowArtifact.available === true) {
      local.missingRows += 1;
    } else if (typeof rowArtifact.purgedPath === "string") {
      local.purgedRows += 1;
    }
    const externalArchive = isRecord(rowArtifact.externalArchive) ? rowArtifact.externalArchive : undefined;
    if (externalArchive) {
      local.archivedRows += 1;
    }
    const retention = isRecord(rowArtifact.retention) ? rowArtifact.retention : undefined;
    const expiresAt = typeof retention?.expiresAt === "string" ? Date.parse(retention.expiresAt) : NaN;
    if (Number.isFinite(expiresAt)) {
      if (expiresAt <= now) {
        local.expiredRows += 1;
      } else if (expiresAt <= expiringSoonLimit) {
        local.expiringSoonRows += 1;
      }
    }
    artifacts.push({
      datasetVersionId,
      sourceId: typeof manifest.sourceId === "string" ? manifest.sourceId : undefined,
      mode,
      rowCount: rowCount || undefined,
      available: rowArtifact.available === true && localFileExists,
      localPath,
      purgedPath: typeof rowArtifact.purgedPath === "string" ? rowArtifact.purgedPath : undefined,
      expiresAt: typeof retention?.expiresAt === "string" ? retention.expiresAt : undefined,
      archived: !!externalArchive,
      archiveType: typeof externalArchive?.type === "string" ? externalArchive.type : undefined,
      storePath: typeof externalArchive?.storePath === "string" ? externalArchive.storePath : undefined,
      encrypted: typeof externalArchive?.encrypted === "boolean" ? externalArchive.encrypted : undefined,
    });
  }

  let remote: Record<string, unknown> = { configured: !!store, archiveMetadataCount: 0, metadataPaths: [] };
  if (store) {
    try {
      const archiveMetadataKeys = await datasetSnapshotListArchiveMetadata(store, loaded.project.id);
      remote = {
        configured: true,
        archiveMetadataCount: archiveMetadataKeys.length,
        metadataPaths: archiveMetadataKeys.slice(0, 20).map((key) => datasetSnapshotStoreRelativeMetadataPath(store, key)),
      };
    } catch (error) {
      remote = {
        configured: true,
        archiveMetadataCount: null,
        metadataPaths: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    status: "ok",
    projectId: loaded.project.id,
    local,
    store: store ? { configured: true, ...datasetSnapshotStoreResponse(store) } : { configured: false },
    encryption: encryption ? { enabled: true, keyRef: encryption.keyRef, keyFingerprint: encryption.keyFingerprint } : { enabled: false },
    remote,
    artifacts: artifacts.sort((left, right) => String(right.datasetVersionId ?? "").localeCompare(String(left.datasetVersionId ?? ""))).slice(0, 50),
  };
}

async function purgeExpiredDatasetSnapshots(loaded: LoadedProjectBundle): Promise<Record<string, unknown>> {
  const versionsRoot = path.join(loaded.projectRoot, "artifacts", "dataset_versions");
  const now = Date.now();
  const purged: Array<Record<string, unknown>> = [];
  let skipped = 0;
  let missing = 0;
  let entries;
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true });
  } catch {
    return { status: "ok", projectId: loaded.project.id, purged: 0, skipped: 0, missing: 0, artifacts: [] };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".rows.jsonl")) {
      continue;
    }
    const manifestPath = path.join(versionsRoot, entry.name);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(manifest) || !isRecord(manifest.rowArtifact) || manifest.rowArtifact.available !== true || typeof manifest.rowArtifact.path !== "string") {
      skipped += 1;
      continue;
    }
    const retention = isRecord(manifest.rowArtifact.retention) ? manifest.rowArtifact.retention : {};
    const expiresAt = typeof retention.expiresAt === "string" ? Date.parse(retention.expiresAt) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt > now) {
      skipped += 1;
      continue;
    }
    const rowPath = safeResolve(loaded.projectRoot, manifest.rowArtifact.path);
    const relativePath = toWorkspaceRelative(loaded.projectRoot, rowPath);
    if (await pathExists(rowPath)) {
      await rm(rowPath, { force: true });
    } else {
      missing += 1;
    }
    const purgedAt = new Date().toISOString();
    manifest.rowArtifact = {
      ...manifest.rowArtifact,
      available: false,
      reason: "Snapshot expirado pela política de retenção.",
      purgedAt,
      purgedPath: relativePath,
      path: undefined,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    purged.push({
      datasetVersionId: typeof manifest.id === "string" ? manifest.id : path.basename(entry.name, ".json"),
      purgedPath: relativePath,
      expiresAt: retention.expiresAt,
      purgedAt,
    });
  }
  return { status: "ok", projectId: loaded.project.id, purged: purged.length, skipped, missing, artifacts: purged };
}

async function archiveDatasetSnapshots(loaded: LoadedProjectBundle, store: DatasetSnapshotStoreConfig | undefined, encryption: DatasetSnapshotEncryptionConfig | undefined): Promise<Record<string, unknown>> {
  const resolvedStore = requireDatasetSnapshotStore(store);
  const versionsRoot = path.join(loaded.projectRoot, "artifacts", "dataset_versions");
  const archived: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  let skipped = 0;
  let missing = 0;
  let entries;
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true });
  } catch {
    return { status: "ok", projectId: loaded.project.id, ...datasetSnapshotStoreResponse(resolvedStore), archived: 0, skipped: 0, missing: 0, errors: [], artifacts: [] };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".rows.jsonl")) {
      continue;
    }
    const manifestPath = path.join(versionsRoot, entry.name);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(manifest) || !isRecord(manifest.rowArtifact) || manifest.rowArtifact.available !== true || typeof manifest.rowArtifact.path !== "string") {
      skipped += 1;
      continue;
    }
    const datasetVersionId = typeof manifest.id === "string" ? manifest.id : path.basename(entry.name, ".json");
    const rowPath = safeResolve(loaded.projectRoot, manifest.rowArtifact.path);
    if (!(await pathExists(rowPath))) {
      missing += 1;
      continue;
    }
    const logicalDigest = typeof manifest.rowArtifact.digest === "string" ? manifest.rowArtifact.digest : undefined;
    const digestCheck = await verifyDatasetRowsDigest(rowPath, logicalDigest);
    if (!digestCheck.ok) {
      errors.push({ datasetVersionId, path: manifest.rowArtifact.path, error: digestCheck.error });
      continue;
    }
    const archiveFileBase = safeStorageSegment(datasetVersionId);
    const archivedRowsKey = datasetSnapshotArchiveKey(resolvedStore, loaded.project.id, `${archiveFileBase}.rows.jsonl${encryption ? ".enc" : ""}`);
    const archivedManifestKey = datasetSnapshotArchiveKey(resolvedStore, loaded.project.id, `${archiveFileBase}.json`);
    const archiveMetadataKey = datasetSnapshotArchiveKey(resolvedStore, loaded.project.id, `${archiveFileBase}.archive.json`);
    const rowContent = await readFile(rowPath);
    const plaintextSha256 = bufferSha256(rowContent);
    const encryptedSnapshot = encryption ? encryptDatasetSnapshot(rowContent, encryption) : null;
    const archivedRowsContent = encryptedSnapshot?.encrypted ?? rowContent;
    await datasetSnapshotWriteBuffer(resolvedStore, archivedRowsKey, archivedRowsContent, encryptedSnapshot ? "application/octet-stream" : "application/x-ndjson; charset=utf-8");
    await datasetSnapshotWriteBuffer(resolvedStore, archivedManifestKey, await readFile(manifestPath), "application/json; charset=utf-8");
    const archivedFileSha256 = bufferSha256(archivedRowsContent);
    const archivedAt = new Date().toISOString();
    const storePath = datasetSnapshotStorePath(resolvedStore, archivedRowsKey);
    const originalPath = toWorkspaceRelative(loaded.projectRoot, rowPath);
    const archiveMetadata = {
      kind: "mlops_dataset_snapshot_archive",
      storeType: resolvedStore.type,
      projectId: loaded.project.id,
      datasetVersionId,
      archivedAt,
      originalPath,
      rowArtifact: manifest.rowArtifact,
      logicalDigest,
      fileSha256: archivedFileSha256,
      plaintextSha256,
      storePath,
      objectKey: resolvedStore.type === "s3" ? archivedRowsKey : undefined,
      manifestPath: datasetSnapshotStorePath(resolvedStore, archivedManifestKey),
      manifestObjectKey: resolvedStore.type === "s3" ? archivedManifestKey : undefined,
      encryption: encryptedSnapshot?.metadata,
    };
    await datasetSnapshotWriteJson(resolvedStore, archiveMetadataKey, archiveMetadata);
    manifest.rowArtifact = {
      ...manifest.rowArtifact,
      externalArchive: {
        type: resolvedStore.type,
        archivedAt,
        storePath,
        metadataPath: datasetSnapshotStoreRelativeMetadataPath(resolvedStore, archiveMetadataKey),
        objectKey: resolvedStore.type === "s3" ? archivedRowsKey : undefined,
        metadataObjectKey: resolvedStore.type === "s3" ? archiveMetadataKey : undefined,
        fileSha256: archivedFileSha256,
        plaintextSha256,
        digest: logicalDigest,
        encrypted: !!encryptedSnapshot,
        encryption: encryptedSnapshot ? {
          algorithm: encryptedSnapshot.metadata.algorithm,
          keyRef: encryptedSnapshot.metadata.keyRef,
          keyFingerprint: encryptedSnapshot.metadata.keyFingerprint,
        } : undefined,
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    archived.push({ datasetVersionId, path: originalPath, storePath, fileSha256: archivedFileSha256, plaintextSha256, digest: logicalDigest, encrypted: !!encryptedSnapshot, archivedAt });
  }
  return { status: "ok", projectId: loaded.project.id, ...datasetSnapshotStoreResponse(resolvedStore), archived: archived.length, skipped, missing, errors, artifacts: archived };
}

async function restoreDatasetSnapshots(loaded: LoadedProjectBundle, store: DatasetSnapshotStoreConfig | undefined, encryption: DatasetSnapshotEncryptionConfig | undefined): Promise<Record<string, unknown>> {
  const resolvedStore = requireDatasetSnapshotStore(store);
  const versionsRoot = path.join(loaded.projectRoot, "artifacts", "dataset_versions");
  const restored: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  let skipped = 0;
  let missing = 0;
  const archiveMetadataKeys = await datasetSnapshotListArchiveMetadata(resolvedStore, loaded.project.id);
  if (archiveMetadataKeys.length === 0) {
    return { status: "ok", projectId: loaded.project.id, ...datasetSnapshotStoreResponse(resolvedStore), restored: 0, skipped: 0, missing: 0, errors: [], artifacts: [] };
  }
  await mkdir(versionsRoot, { recursive: true });
  for (const archiveMetadataKey of archiveMetadataKeys) {
    let archiveMetadata: unknown;
    try {
      archiveMetadata = JSON.parse((await datasetSnapshotReadBuffer(resolvedStore, archiveMetadataKey)).toString("utf-8")) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(archiveMetadata) || archiveMetadata.kind !== "mlops_dataset_snapshot_archive" || archiveMetadata.projectId !== loaded.project.id || typeof archiveMetadata.datasetVersionId !== "string" || typeof archiveMetadata.storePath !== "string") {
      skipped += 1;
      continue;
    }
    const datasetVersionId = archiveMetadata.datasetVersionId;
    const archivedRowsReference = typeof archiveMetadata.objectKey === "string" ? archiveMetadata.objectKey : archiveMetadata.storePath;
    if (!(await datasetSnapshotObjectExists(resolvedStore, archivedRowsReference))) {
      missing += 1;
      continue;
    }
    const archivedRowsContent = await datasetSnapshotReadBuffer(resolvedStore, archivedRowsReference);
    const expectedFileSha256 = typeof archiveMetadata.fileSha256 === "string" ? archiveMetadata.fileSha256 : undefined;
    const actualFileSha256 = bufferSha256(archivedRowsContent);
    if (expectedFileSha256 && actualFileSha256 !== expectedFileSha256) {
      errors.push({ datasetVersionId, storePath: archiveMetadata.storePath, error: "SHA-256 físico do snapshot arquivado diverge do metadado." });
      continue;
    }
    let restoredContent: Buffer = archivedRowsContent;
    if (isRecord(archiveMetadata.encryption)) {
      try {
        restoredContent = decryptDatasetSnapshot(restoredContent, archiveMetadata.encryption, encryption);
      } catch (error) {
        errors.push({ datasetVersionId, storePath: archiveMetadata.storePath, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    const expectedPlaintextSha256 = typeof archiveMetadata.plaintextSha256 === "string" ? archiveMetadata.plaintextSha256 : undefined;
    const actualPlaintextSha256 = bufferSha256(restoredContent);
    if (expectedPlaintextSha256 && actualPlaintextSha256 !== expectedPlaintextSha256) {
      errors.push({ datasetVersionId, storePath: archiveMetadata.storePath, error: "SHA-256 do snapshot descriptografado diverge do metadado." });
      continue;
    }
    const logicalDigest = typeof archiveMetadata.logicalDigest === "string" ? archiveMetadata.logicalDigest : undefined;
    const digestCheck = verifyDatasetRowsDigestFromText(restoredContent.toString("utf-8"), logicalDigest);
    if (!digestCheck.ok) {
      errors.push({ datasetVersionId, storePath: archiveMetadata.storePath, error: digestCheck.error });
      continue;
    }
    const localManifestPath = path.join(versionsRoot, `${safeStorageSegment(datasetVersionId)}.json`);
    if (!(await pathExists(localManifestPath)) && typeof archiveMetadata.manifestPath === "string") {
      const archivedManifestReference = typeof archiveMetadata.manifestObjectKey === "string" ? archiveMetadata.manifestObjectKey : archiveMetadata.manifestPath;
      if (await datasetSnapshotObjectExists(resolvedStore, archivedManifestReference)) {
        await writeFile(localManifestPath, await datasetSnapshotReadBuffer(resolvedStore, archivedManifestReference));
      }
    }
    if (!(await pathExists(localManifestPath))) {
      missing += 1;
      continue;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(localManifestPath, "utf-8")) as unknown;
    } catch {
      errors.push({ datasetVersionId, error: "Manifesto local de dataset não é JSON válido." });
      continue;
    }
    if (!isRecord(manifest) || !isRecord(manifest.rowArtifact)) {
      skipped += 1;
      continue;
    }
    const targetRelativePath = typeof manifest.rowArtifact.purgedPath === "string"
      ? manifest.rowArtifact.purgedPath
      : typeof archiveMetadata.originalPath === "string"
        ? archiveMetadata.originalPath
        : `artifacts/dataset_versions/${safeStorageSegment(datasetVersionId)}.rows.jsonl`;
    const targetRowsPath = safeResolve(loaded.projectRoot, targetRelativePath);
    const restoredPath = toWorkspaceRelative(loaded.projectRoot, targetRowsPath);
    await mkdir(path.dirname(targetRowsPath), { recursive: true });
    await writeFile(targetRowsPath, restoredContent);
    const restoredAt = new Date().toISOString();
    manifest.rowArtifact = {
      ...manifest.rowArtifact,
      available: true,
      path: restoredPath,
      reason: undefined,
      purgedAt: undefined,
      purgedPath: undefined,
      restoredAt,
      restoredFrom: {
        type: resolvedStore.type,
        storePath: archiveMetadata.storePath,
        metadataPath: datasetSnapshotStoreRelativeMetadataPath(resolvedStore, archiveMetadataKey),
        objectKey: typeof archiveMetadata.objectKey === "string" ? archiveMetadata.objectKey : undefined,
        metadataObjectKey: resolvedStore.type === "s3" ? archiveMetadataKey : undefined,
        archivedAt: typeof archiveMetadata.archivedAt === "string" ? archiveMetadata.archivedAt : undefined,
        fileSha256: actualFileSha256,
        plaintextSha256: actualPlaintextSha256,
        digest: logicalDigest,
        encrypted: isRecord(archiveMetadata.encryption),
        encryption: isRecord(archiveMetadata.encryption) ? {
          algorithm: archiveMetadata.encryption.algorithm,
          keyRef: archiveMetadata.encryption.keyRef,
          keyFingerprint: archiveMetadata.encryption.keyFingerprint,
        } : undefined,
      },
    };
    await writeFile(localManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    restored.push({ datasetVersionId, path: restoredPath, storePath: archiveMetadata.storePath, fileSha256: actualFileSha256, plaintextSha256: actualPlaintextSha256, digest: logicalDigest, encrypted: isRecord(archiveMetadata.encryption), restoredAt });
  }
  return { status: "ok", projectId: loaded.project.id, ...datasetSnapshotStoreResponse(resolvedStore), restored: restored.length, skipped, missing, errors, artifacts: restored };
}

async function listEvaluationRuns(loaded: LoadedProjectBundle): Promise<Array<Record<string, unknown>>> {
  const runsRoot = path.join(loaded.projectRoot, "artifacts", "evaluation_runs");
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      runs.push(await readEvaluationResult(path.join(runsRoot, entry.name), entry.name, loaded.project));
    } catch {
      continue;
    }
  }
  return runs.sort((left, right) => trainingRunTimestamp(right) - trainingRunTimestamp(left));
}

async function readTrainingResult(runDir: string, fallbackRunId: string, project: MLOpsProject): Promise<Record<string, unknown>> {
  const resultPath = path.join(runDir, "training-result.json");
  let rawText: string;
  let item;
  try {
    rawText = await readFile(resultPath, "utf-8");
    item = await stat(resultPath);
  } catch (error) {
    throw new WorkspaceError(`Run de treino não encontrado: ${fallbackRunId}`, 404, error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw new WorkspaceError(`training-result.json inválido em ${fallbackRunId}.`, 422, error);
  }
  if (!isRecord(raw)) {
    throw new WorkspaceError(`training-result.json precisa ser objeto em ${fallbackRunId}.`, 422);
  }
  const leaderboard = Array.isArray(raw.leaderboard) ? raw.leaderboard : [];
  const primaryMetric = typeof raw.primaryMetric === "string" && raw.primaryMetric ? raw.primaryMetric : project.metrics.primary;
  const bestModelId = typeof raw.bestModelId === "string" ? raw.bestModelId : inferBestModelId(leaderboard, primaryMetric);
  return {
    status: typeof raw.status === "string" ? raw.status : "ok",
    kind: typeof raw.kind === "string" ? raw.kind : "training_result",
    runId: typeof raw.runId === "string" ? raw.runId : fallbackRunId,
    projectId: typeof raw.projectId === "string" ? raw.projectId : project.id,
    sourceId: typeof raw.sourceId === "string" ? raw.sourceId : "",
    sourceType: typeof raw.sourceType === "string" ? raw.sourceType : undefined,
    sourceMode: typeof raw.sourceMode === "string" ? raw.sourceMode : undefined,
    problemType: typeof raw.problemType === "string" ? raw.problemType : project.problem.type,
    rowCount: typeof raw.rowCount === "number" ? raw.rowCount : undefined,
    target: typeof raw.target === "string" ? raw.target : project.problem.target,
    primaryMetric,
    bestModelId,
    leaderboard,
    promotionEvidence: Array.isArray(raw.promotionEvidence) ? raw.promotionEvidence : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    mlflow: isRecord(raw.mlflow) ? raw.mlflow : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : item.mtime.toISOString(),
    updatedAt: item.mtime.toISOString(),
  };
}

async function readEvaluationResult(runDir: string, fallbackEvaluationId: string, project: MLOpsProject): Promise<Record<string, unknown>> {
  const resultPath = path.join(runDir, "evaluation-result.json");
  let rawText: string;
  let item;
  try {
    rawText = await readFile(resultPath, "utf-8");
    item = await stat(resultPath);
  } catch (error) {
    throw new WorkspaceError(`Run de avaliação não encontrado: ${fallbackEvaluationId}`, 404, error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw new WorkspaceError(`evaluation-result.json inválido em ${fallbackEvaluationId}.`, 422, error);
  }
  if (!isRecord(raw)) {
    throw new WorkspaceError(`evaluation-result.json precisa ser objeto em ${fallbackEvaluationId}.`, 422);
  }
  return {
    status: typeof raw.status === "string" ? raw.status : "ok",
    kind: typeof raw.kind === "string" ? raw.kind : "evaluation_result",
    evaluationId: typeof raw.evaluationId === "string" ? raw.evaluationId : fallbackEvaluationId,
    projectId: typeof raw.projectId === "string" ? raw.projectId : project.id,
    runId: typeof raw.runId === "string" ? raw.runId : null,
    modelId: typeof raw.modelId === "string" ? raw.modelId : null,
    sourceId: typeof raw.sourceId === "string" ? raw.sourceId : "",
    sourceType: typeof raw.sourceType === "string" ? raw.sourceType : undefined,
    sourceMode: typeof raw.sourceMode === "string" ? raw.sourceMode : undefined,
    problemType: typeof raw.problemType === "string" ? raw.problemType : project.problem.type,
    rowCount: typeof raw.rowCount === "number" ? raw.rowCount : undefined,
    target: typeof raw.target === "string" ? raw.target : project.problem.target,
    primaryMetric: typeof raw.primaryMetric === "string" && raw.primaryMetric ? raw.primaryMetric : project.metrics.primary,
    metrics: isRecord(raw.metrics) ? raw.metrics : {},
    artifactUri: typeof raw.artifactUri === "string" ? raw.artifactUri : null,
    metricSnapshot: isRecord(raw.metricSnapshot) ? raw.metricSnapshot : null,
    sample: Array.isArray(raw.sample) ? raw.sample : [],
    backtestId: typeof raw.backtestId === "string" ? raw.backtestId : undefined,
    baselineModelId: typeof raw.baselineModelId === "string" ? raw.baselineModelId : undefined,
    candidateModelIds: Array.isArray(raw.candidateModelIds) ? raw.candidateModelIds.filter((item) => typeof item === "string") : undefined,
    recommendedModelId: typeof raw.recommendedModelId === "string" ? raw.recommendedModelId : undefined,
    recommendation: typeof raw.recommendation === "string" ? raw.recommendation : undefined,
    neutralBand: typeof raw.neutralBand === "number" ? raw.neutralBand : undefined,
    direction: typeof raw.direction === "string" ? raw.direction : undefined,
    temporalWindow: isRecord(raw.temporalWindow) ? raw.temporalWindow : undefined,
    windowGranularity: typeof raw.windowGranularity === "string" ? raw.windowGranularity : undefined,
    windowResults: Array.isArray(raw.windowResults) ? raw.windowResults : undefined,
    modelMetrics: isRecord(raw.modelMetrics) ? raw.modelMetrics : undefined,
    modelArtifacts: isRecord(raw.modelArtifacts) ? raw.modelArtifacts : undefined,
    evidence: Array.isArray(raw.evidence) ? raw.evidence : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : item.mtime.toISOString(),
    updatedAt: item.mtime.toISOString(),
  };
}

function promotionStatusFromTrainingRun(loaded: LoadedProjectBundle, run: Record<string, unknown> | null): Record<string, unknown> {
  if (!run) {
    return {
      status: "empty",
      projectId: loaded.project.id,
      mode: loaded.project.promotionPolicy.mode,
      recommendation: "needs_training",
      applied: false,
      activeModelId: activeModelId(loaded.pipeline),
      latestRunId: null,
      evidence: [],
      message: "Nenhum treino persistido para avaliar promoção.",
    };
  }
  const evidence = Array.isArray(run.promotionEvidence) ? run.promotionEvidence : [];
  const failedBlockers = evidence.filter((item) => isRecord(item) && item.status === "fail" && (item.severity ?? "block") === "block");
  const failedReviews = evidence.filter((item) => isRecord(item) && item.status === "fail" && (item.severity ?? "block") !== "block");
  return {
    status: "ok",
    projectId: loaded.project.id,
    mode: loaded.project.promotionPolicy.mode,
    recommendation: failedBlockers.length ? "reject" : failedReviews.length ? "review" : "approve",
    applied: Boolean(run.bestModelId && run.bestModelId === activeModelId(loaded.pipeline)),
    activeModelId: activeModelId(loaded.pipeline),
    candidateModelId: run.bestModelId ?? null,
    latestRunId: run.runId ?? null,
    primaryMetric: typeof run.primaryMetric === "string" && run.primaryMetric ? run.primaryMetric : loaded.project.metrics.primary,
    leaderboard: run.leaderboard,
    evidence,
  };
}

async function applyPromotionDecision(workspaceRoot: string, loaded: LoadedProjectBundle, body: ApplyPromotionBody): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new WorkspaceError("Aplicação de promoção exige confirm: true.", 400);
  }
  validatePromotionMlflowRequest(body);

  const run = body.runId ? await loadTrainingRun(loaded, body.runId) : (await listTrainingRuns(loaded))[0] ?? null;
  if (!run) {
    throw new WorkspaceError("Nenhum treino persistido para aplicar promoção.", 404);
  }
  const promotion = promotionStatusFromTrainingRun(loaded, run);
  const recommendation = typeof promotion.recommendation === "string" ? promotion.recommendation : "reject";
  if (recommendation === "reject" && body.allowReject !== true) {
    throw new WorkspaceError("Promoção rejeitada pelas regras. Use allowReject: true para override explícito.", 409, promotion);
  }
  if (recommendation === "review" && body.allowReview !== true) {
    throw new WorkspaceError("Promoção exige revisão. Use allowReview: true para override explícito.", 409, promotion);
  }

  const candidateModelId = optionalBodyString(body.candidateModelId, "candidateModelId") ?? (typeof run.bestModelId === "string" ? run.bestModelId : "");
  if (!candidateModelId) {
    throw new WorkspaceError("candidateModelId não encontrado no treino.", 422);
  }
  const candidateInLeaderboard = Array.isArray(run.leaderboard) && run.leaderboard.some((model) => isRecord(model) && model.modelId === candidateModelId);
  if (!candidateInLeaderboard) {
    throw new WorkspaceError(`candidateModelId não aparece no leaderboard do run: ${candidateModelId}`, 422);
  }
  const candidateNode = loaded.pipeline.nodes.find((node) => node.type === "model" && node.id === candidateModelId);
  if (!candidateNode) {
    throw new WorkspaceError(`Modelo candidato não existe na pipeline: ${candidateModelId}`, 422);
  }

  const previousActiveModelId = activeModelId(loaded.pipeline);
  const nextPipeline = parsePipelineFlow({
    ...loaded.pipeline,
    nodes: loaded.pipeline.nodes.map((node) => {
      if (node.type !== "model") {
        return node;
      }
      if (node.id === candidateModelId) {
        return { ...node, modelRole: "active" };
      }
      if (node.modelRole === "active") {
        return { ...node, modelRole: "baseline" };
      }
      return node;
    }),
  });
  await writeFile(safeResolve(workspaceRoot, loaded.pipelinePath), `${JSON.stringify(nextPipeline, null, 2)}\n`, "utf-8");

  const mlflowSync = await syncPromotionDecisionToMlflow(loaded, run, candidateModelId, body);
  const decisionId = `promotion-${Date.now()}-${randomUUID()}`;
  const decision = {
    status: "ok",
    kind: "promotion_decision",
    decisionId,
    projectId: loaded.project.id,
    runId: run.runId ?? null,
    recommendation,
    applied: true,
    previousActiveModelId,
    activeModelId: candidateModelId,
    candidateModelId,
    primaryMetric: typeof run.primaryMetric === "string" ? run.primaryMetric : loaded.project.metrics.primary,
    evidence: Array.isArray(run.promotionEvidence) ? run.promotionEvidence : [],
    mlflowSync,
    appliedAt: new Date().toISOString(),
  };
  const decisionsRoot = path.join(loaded.projectRoot, "artifacts", "promotion_decisions");
  await mkdir(decisionsRoot, { recursive: true });
  const decisionPath = path.join(decisionsRoot, `${decisionId}.json`);
  await writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf-8");

  const nextLoaded = { ...loaded, pipeline: nextPipeline };
  return {
    ...decision,
    decisionPath: toWorkspaceRelative(workspaceRoot, decisionPath),
    pipeline: nextPipeline,
    promotionStatus: promotionStatusFromTrainingRun(nextLoaded, run),
  };
}

async function applyRuntimeRetrainingJobPromotion(
  workspaceRoot: string,
  queue: WorkerJobQueueConfig,
  workerJobs: Map<string, WorkerJobRecord>,
  loaded: LoadedProjectBundle,
  jobId: string,
  body: ApplyPromotionBody,
): Promise<Record<string, unknown>> {
  const job = workerJobs.get(jobId);
  if (!job) {
    throw new WorkspaceError("Job de retreino não encontrado.", 404);
  }
  if (job.projectId !== loaded.project.id) {
    throw new WorkspaceError("Job não pertence ao projeto informado.", 409);
  }
  if (!isRecord(job.retraining)) {
    throw new WorkspaceError("Job não está vinculado a retreino de runtime remoto.", 409);
  }
  if (job.status !== "completed") {
    throw new WorkspaceError("Promoção do modelo retreinado exige job concluído com sucesso.", 409, serializeWorkerJob(job));
  }
  const completion = isRecord(job.retraining.completion) ? job.retraining.completion : {};
  if (completion.status !== "ok") {
    throw new WorkspaceError("Promoção do modelo retreinado exige conclusão remota registrada.", 409, serializeWorkerJob(job));
  }
  if (!isRecord(job.result)) {
    throw new WorkspaceError("Resultado de treino não encontrado no job.", 422);
  }
  const runId = typeof job.result.runId === "string" ? job.result.runId : "";
  const candidateModelId = optionalBodyString(body.candidateModelId, "candidateModelId") ?? (typeof job.result.bestModelId === "string" ? job.result.bestModelId : "");
  if (!runId || !candidateModelId) {
    throw new WorkspaceError("Job de retreino não informa run ou modelo candidato para promoção.", 422);
  }
  const decision = await applyPromotionDecision(workspaceRoot, loaded, {
    ...body,
    runId,
    candidateModelId,
  });
  const promotedAt = new Date().toISOString();
  job.retraining = {
    ...job.retraining,
    promotion: {
      status: "ok",
      promotedAt,
      decisionId: decision.decisionId,
      runId,
      candidateModelId,
      activeModelId: decision.activeModelId,
      previousActiveModelId: decision.previousActiveModelId,
    },
  };
  appendRuntimeRetrainingJobEvent(job, "info", "runtime_retraining_model_promoted", "Modelo retreinado promovido no Studio.", {
    requestId: job.retraining.requestId,
    runId,
    candidateModelId,
    activeModelId: decision.activeModelId,
  });
  await queuePersistWorkerJob(workspaceRoot, queue, job);
  return {
    ...decision,
    job: serializeWorkerJob(job),
  };
}

function validatePromotionMlflowRequest(body: ApplyPromotionBody): void {
  optionalBodyString(body.mlflowModelName, "mlflowModelName");
  if (body.mlflowModelVersion !== undefined) {
    requiredMlflowModelVersion(body.mlflowModelVersion);
  }
  if (body.mlflowAlias !== undefined) {
    requiredMlflowAlias(body.mlflowAlias);
  }
  if (body.mlflowStage !== undefined) {
    requiredMlflowStage(body.mlflowStage);
  }
  optionalBodyBoolean(body.archiveExistingVersions, "archiveExistingVersions");
}

async function syncPromotionDecisionToMlflow(loaded: LoadedProjectBundle, run: Record<string, unknown>, candidateModelId: string, body: ApplyPromotionBody): Promise<Record<string, unknown>> {
  if (body.syncMlflow === false) {
    return { status: "skipped", reason: "syncMlflow desabilitado na requisição." };
  }
  const mlflowConfig: Record<string, unknown> = isRecord(loaded.project.runtime.mlflow) ? loaded.project.runtime.mlflow : {};
  const trackingUri = resolveMlflowTrackingUri(mlflowConfig);
  if (!trackingUri) {
    return { status: "skipped", reason: "Tracking URI MLflow não configurada." };
  }
  const target = await resolveMlflowPromotionTarget(trackingUri, run, candidateModelId, body);
  if (!target) {
    return { status: "skipped", reason: "Nenhuma model version do MLflow foi encontrada para o run promovido." };
  }
  const alias = body.mlflowAlias === undefined ? "champion" : requiredMlflowAlias(body.mlflowAlias);
  const stage = body.mlflowStage === undefined ? "Production" : requiredMlflowStage(body.mlflowStage);
  const archiveExistingVersions = optionalBodyBoolean(body.archiveExistingVersions, "archiveExistingVersions") ?? true;
  const aliasResult = await mlflowRestJson(trackingUri, "/api/2.0/mlflow/registered-models/alias", {
    method: "POST",
    body: { name: target.name, version: target.version, alias },
  });
  const stageResult = await mlflowRestJson(trackingUri, "/api/2.0/mlflow/model-versions/transition-stage", {
    method: "POST",
    body: { name: target.name, version: target.version, stage, archive_existing_versions: archiveExistingVersions },
  });
  const ok = aliasResult.ok && stageResult.ok;
  return {
    status: ok ? "synced" : "failed",
    trackingUri: redactUrlCredentials(trackingUri),
    target,
    alias,
    stage,
    archiveExistingVersions,
    aliasResult: summarizeMlflowMutationResult(aliasResult),
    stageResult: summarizeMlflowMutationResult(stageResult),
  };
}

async function resolveMlflowPromotionTarget(trackingUri: string, run: Record<string, unknown>, candidateModelId: string, body: ApplyPromotionBody): Promise<{ name: string; version: string; runId: string | null } | null> {
  const explicitName = optionalBodyString(body.mlflowModelName, "mlflowModelName");
  const explicitVersion = optionalBodyString(body.mlflowModelVersion, "mlflowModelVersion");
  if (explicitName && explicitVersion) {
    return { name: explicitName, version: requiredMlflowModelVersion(explicitVersion), runId: null };
  }
  const mlflow = isRecord(run.mlflow) ? run.mlflow : {};
  const runId = typeof mlflow.runId === "string" && mlflow.runId.trim() ? mlflow.runId.trim() : null;
  if (!runId && !explicitName) {
    return null;
  }
  const versions = await mlflowRestJson(trackingUri, "/api/2.0/mlflow/model-versions/search", {
    searchParams: { max_results: "200" },
  });
  if (!versions.ok) {
    return null;
  }
  const candidates = (Array.isArray(versions.data?.model_versions) ? versions.data.model_versions : []).filter(isRecord);
  const matched = candidates.find((version) => (
    (!explicitName || version.name === explicitName)
    && (!runId || version.run_id === runId)
  )) ?? candidates.find((version) => (
    (!explicitName || version.name === explicitName)
    && typeof version.name === "string"
    && String(version.name).includes(candidateModelId)
  ));
  if (!matched || typeof matched.name !== "string") {
    return null;
  }
  const version = typeof matched.version === "string" ? matched.version : matched.version === undefined || matched.version === null ? "" : String(matched.version);
  if (!/^[0-9]+$/.test(version)) {
    return null;
  }
  return { name: matched.name, version, runId: typeof matched.run_id === "string" ? matched.run_id : null };
}

function summarizeMlflowMutationResult(result: Awaited<ReturnType<typeof mlflowRestJson>>): Record<string, unknown> {
  return {
    ok: result.ok,
    statusCode: result.statusCode ?? null,
    error: result.error ?? null,
    data: result.ok ? result.data ?? {} : null,
  };
}

async function mlflowIntegrationStatus(workspaceRoot: string, loaded: LoadedProjectBundle): Promise<Record<string, unknown>> {
  const mlflowConfig: Record<string, unknown> = isRecord(loaded.project.runtime.mlflow) ? loaded.project.runtime.mlflow : {};
  const trackingUri = resolveMlflowTrackingUri(mlflowConfig);
  const runs = await listTrainingRuns(loaded);
  const latestRun = runs[0] ?? null;
  const composePath = safeResolve(workspaceRoot, "infra/docker-compose.mlflow.yml");
  const workerPackage = await mlflowWorkerPackageStatus(workspaceRoot).catch((error) => ({
    name: "mlflow",
    installed: false,
    version: null,
    error: error instanceof Error ? error.message : String(error),
  }));
  return {
    status: "ok",
    projectId: loaded.project.id,
    enabled: mlflowConfig.enabled === true,
    registryEnabled: mlflowConfig.registryEnabled === true,
    trackingUriRef: typeof mlflowConfig.trackingUriRef === "string" ? mlflowConfig.trackingUriRef : null,
    trackingUri: trackingUri ? redactUrlCredentials(trackingUri) : null,
    configured: Boolean(trackingUri),
    health: trackingUri ? await probeMlflowHealth(trackingUri) : { reachable: false, message: "Tracking URI não configurada." },
    localCompose: {
      path: toWorkspaceRelative(workspaceRoot, composePath),
      exists: await pathExists(composePath),
    },
    workerPackage,
    latestRun: summarizeMlflowTrainingRun(latestRun),
  };
}

async function mlflowCatalog(workspaceRoot: string, loaded: LoadedProjectBundle): Promise<Record<string, unknown>> {
  const mlflowConfig: Record<string, unknown> = isRecord(loaded.project.runtime.mlflow) ? loaded.project.runtime.mlflow : {};
  const trackingUri = resolveMlflowTrackingUri(mlflowConfig);
  if (!trackingUri) {
    return {
      status: "ok",
      projectId: loaded.project.id,
      trackingUri: null,
      configured: false,
      experiments: mlflowCatalogSection([], "Tracking URI não configurada."),
      runs: mlflowCatalogSection([], "Tracking URI não configurada."),
      registeredModels: mlflowCatalogSection([], "Tracking URI não configurada."),
      modelVersions: mlflowCatalogSection([], "Tracking URI não configurada."),
    };
  }

  const experiments = await mlflowRestJson(trackingUri, "/api/2.0/mlflow/experiments/search", {
    method: "POST",
    body: { max_results: 20, order_by: ["last_update_time DESC"] },
  });
  const experimentItems = Array.isArray(experiments.data?.experiments) ? experiments.data.experiments.filter(isRecord) : [];
  const experimentIds = experimentItems.map((experiment) => String(experiment.experiment_id ?? "")).filter(Boolean).slice(0, 20);
  const runs = experimentIds.length
    ? await mlflowRestJson(trackingUri, "/api/2.0/mlflow/runs/search", {
      method: "POST",
      body: { experiment_ids: experimentIds, max_results: 20, order_by: ["attributes.start_time DESC"] },
    })
    : { ok: true, data: { runs: [] } };
  const registeredModels = await mlflowRestJson(trackingUri, "/api/2.0/mlflow/registered-models/search", {
    searchParams: { max_results: "20" },
  });
  const modelVersions = await mlflowRestJson(trackingUri, "/api/2.0/mlflow/model-versions/search", {
    searchParams: { max_results: "20" },
  });

  return {
    status: "ok",
    projectId: loaded.project.id,
    trackingUri: redactUrlCredentials(trackingUri),
    configured: true,
    experiments: mlflowCatalogSection(experimentItems.map((experiment) => summarizeMlflowExperiment(trackingUri, experiment)), experiments.error),
    runs: mlflowCatalogSection((Array.isArray(runs.data?.runs) ? runs.data.runs : []).filter(isRecord).map((run) => summarizeMlflowRun(trackingUri, run)), runs.error),
    registeredModels: mlflowCatalogSection((Array.isArray(registeredModels.data?.registered_models) ? registeredModels.data.registered_models : []).filter(isRecord).map((model) => summarizeMlflowRegisteredModel(trackingUri, model)), registeredModels.error),
    modelVersions: mlflowCatalogSection((Array.isArray(modelVersions.data?.model_versions) ? modelVersions.data.model_versions : []).filter(isRecord).map((version) => summarizeMlflowModelVersion(trackingUri, version)), modelVersions.error),
  };
}

async function setMlflowRegisteredModelAlias(loaded: LoadedProjectBundle, body: MlflowSetAliasBody): Promise<Record<string, unknown>> {
  requireMlflowRegistryConfirmation(body.confirm);
  const trackingUri = requireMlflowTrackingUri(loaded);
  const name = requiredBodyString(body.name, "name");
  const version = requiredMlflowModelVersion(body.version);
  const alias = requiredMlflowAlias(body.alias);
  const result = await mlflowRestJson(trackingUri, "/api/2.0/mlflow/registered-models/alias", {
    method: "POST",
    body: { name, version, alias },
  });
  return mlflowRegistryActionResult(loaded, trackingUri, "set_alias", { name, version, alias }, result);
}

async function deleteMlflowRegisteredModelAlias(loaded: LoadedProjectBundle, body: MlflowDeleteAliasBody): Promise<Record<string, unknown>> {
  requireMlflowRegistryConfirmation(body.confirm);
  const trackingUri = requireMlflowTrackingUri(loaded);
  const name = requiredBodyString(body.name, "name");
  const alias = requiredMlflowAlias(body.alias);
  const result = await mlflowRestJson(trackingUri, "/api/2.0/mlflow/registered-models/alias", {
    method: "DELETE",
    body: { name, alias },
  });
  return mlflowRegistryActionResult(loaded, trackingUri, "delete_alias", { name, alias }, result);
}

async function transitionMlflowModelVersionStage(loaded: LoadedProjectBundle, body: MlflowTransitionStageBody): Promise<Record<string, unknown>> {
  requireMlflowRegistryConfirmation(body.confirm);
  const trackingUri = requireMlflowTrackingUri(loaded);
  const name = requiredBodyString(body.name, "name");
  const version = requiredMlflowModelVersion(body.version);
  const stage = requiredMlflowStage(body.stage);
  const archiveExistingVersions = optionalBodyBoolean(body.archiveExistingVersions, "archiveExistingVersions") ?? false;
  const result = await mlflowRestJson(trackingUri, "/api/2.0/mlflow/model-versions/transition-stage", {
    method: "POST",
    body: { name, version, stage, archive_existing_versions: archiveExistingVersions },
  });
  return mlflowRegistryActionResult(loaded, trackingUri, "transition_stage", { name, version, stage, archiveExistingVersions }, result);
}

function mlflowRegistryActionResult(loaded: LoadedProjectBundle, trackingUri: string, action: string, request: Record<string, unknown>, result: Awaited<ReturnType<typeof mlflowRestJson>>): Record<string, unknown> {
  if (!result.ok) {
    throw new WorkspaceError("MLflow rejeitou a ação de registry.", 502, {
      statusCode: result.statusCode ?? null,
      error: result.error ?? "Erro desconhecido no MLflow.",
      response: result.data ?? null,
    });
  }
  return {
    status: "ok",
    action,
    projectId: loaded.project.id,
    trackingUri: redactUrlCredentials(trackingUri),
    request,
    mlflow: result.data ?? {},
  };
}

function requireMlflowTrackingUri(loaded: LoadedProjectBundle): string {
  const mlflowConfig: Record<string, unknown> = isRecord(loaded.project.runtime.mlflow) ? loaded.project.runtime.mlflow : {};
  const trackingUri = resolveMlflowTrackingUri(mlflowConfig);
  if (!trackingUri) {
    throw new WorkspaceError("Tracking URI MLflow não configurada.", 400);
  }
  return trackingUri;
}

function requireMlflowRegistryConfirmation(confirm: boolean | undefined): void {
  if (confirm !== true) {
    throw new WorkspaceError("Ação de registry MLflow exige confirm: true.", 400);
  }
}

function requiredMlflowAlias(value: string | undefined): string {
  const alias = requiredBodyString(value, "alias");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(alias)) {
    throw new WorkspaceError("alias deve conter 1 a 128 caracteres alfanuméricos, ponto, hífen ou underscore.", 400);
  }
  return alias;
}

function requiredMlflowModelVersion(value: string | undefined): string {
  const version = requiredBodyString(value, "version");
  if (!/^[0-9]+$/.test(version)) {
    throw new WorkspaceError("version deve ser uma versão numérica do model registry.", 400);
  }
  return version;
}

function requiredMlflowStage(value: string | undefined): string {
  const stage = requiredBodyString(value, "stage");
  const allowed = ["None", "Staging", "Production", "Archived"];
  const normalized = allowed.find((candidate) => candidate.toLowerCase() === stage.toLowerCase());
  if (!normalized) {
    throw new WorkspaceError("stage deve ser None, Staging, Production ou Archived.", 400);
  }
  return normalized;
}

function mlflowCatalogSection(items: unknown[], error?: string): Record<string, unknown> {
  return {
    ok: !error,
    count: items.length,
    items,
    error: error ?? null,
  };
}

async function mlflowRestJson(trackingUri: string, endpointPath: string, options: { method?: "GET" | "POST" | "DELETE"; body?: Record<string, unknown>; searchParams?: Record<string, string> } = {}): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string; statusCode?: number }> {
  let url: URL;
  try {
    url = new URL(endpointPath, trackingUri.endsWith("/") ? trackingUri : `${trackingUri}/`);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown = {};
    if (text.trim()) {
      data = JSON.parse(text) as unknown;
    }
    if (!isRecord(data)) {
      return { ok: false, statusCode: response.status, error: "Resposta MLflow não é objeto JSON." };
    }
    if (!response.ok) {
      return { ok: false, statusCode: response.status, data, error: mlflowErrorMessage(data, response.status) };
    }
    return { ok: true, statusCode: response.status, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function mlflowErrorMessage(data: Record<string, unknown>, statusCode: number): string {
  return firstNonEmptyString(data.message, data.error_code, data.error) ?? `MLflow respondeu HTTP ${statusCode}.`;
}

function summarizeMlflowExperiment(trackingUri: string, experiment: Record<string, unknown>): Record<string, unknown> {
  const experimentId = typeof experiment.experiment_id === "string" ? experiment.experiment_id : null;
  return {
    experimentId,
    name: experiment.name ?? null,
    lifecycleStage: experiment.lifecycle_stage ?? null,
    artifactLocation: experiment.artifact_location ?? null,
    creationTime: experiment.creation_time ?? null,
    lastUpdateTime: experiment.last_update_time ?? null,
    uiUrl: experimentId ? mlflowUiUrl(trackingUri, `/#/experiments/${encodeURIComponent(experimentId)}`) : null,
  };
}

function summarizeMlflowRun(trackingUri: string, run: Record<string, unknown>): Record<string, unknown> {
  const info = isRecord(run.info) ? run.info : {};
  const data = isRecord(run.data) ? run.data : {};
  const experimentId = typeof info.experiment_id === "string" ? info.experiment_id : null;
  const runId = typeof info.run_id === "string" ? info.run_id : null;
  return {
    runId,
    runName: info.run_name ?? null,
    experimentId,
    status: info.status ?? null,
    startTime: info.start_time ?? null,
    endTime: info.end_time ?? null,
    artifactUri: info.artifact_uri ?? null,
    metrics: Array.isArray(data.metrics) ? data.metrics.slice(0, 8) : [],
    params: Array.isArray(data.params) ? data.params.slice(0, 8) : [],
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 8) : [],
    uiUrl: experimentId && runId ? mlflowUiUrl(trackingUri, `/#/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(runId)}`) : null,
  };
}

function summarizeMlflowRegisteredModel(trackingUri: string, model: Record<string, unknown>): Record<string, unknown> {
  const name = typeof model.name === "string" ? model.name : null;
  return {
    name,
    creationTimestamp: model.creation_timestamp ?? null,
    lastUpdatedTimestamp: model.last_updated_timestamp ?? null,
    latestVersions: Array.isArray(model.latest_versions) ? model.latest_versions.slice(0, 5).map((version) => isRecord(version) ? summarizeMlflowModelVersion(trackingUri, version) : version) : [],
    uiUrl: name ? mlflowUiUrl(trackingUri, `/#/models/${encodeURIComponent(name)}`) : null,
  };
}

function summarizeMlflowModelVersion(trackingUri: string, version: Record<string, unknown>): Record<string, unknown> {
  const name = typeof version.name === "string" ? version.name : null;
  const modelVersion = typeof version.version === "string" ? version.version : version.version === undefined || version.version === null ? null : String(version.version);
  return {
    name,
    version: modelVersion,
    runId: version.run_id ?? null,
    currentStage: version.current_stage ?? null,
    status: version.status ?? null,
    source: version.source ?? null,
    creationTimestamp: version.creation_timestamp ?? null,
    lastUpdatedTimestamp: version.last_updated_timestamp ?? null,
    uiUrl: name && modelVersion ? mlflowUiUrl(trackingUri, `/#/models/${encodeURIComponent(name)}/versions/${encodeURIComponent(modelVersion)}`) : null,
  };
}

function mlflowUiUrl(trackingUri: string, fragmentPath: string): string {
  try {
    const parsed = new URL(trackingUri);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = normalizeMlflowUiHash(fragmentPath);
    return redactUrlCredentials(parsed.toString());
  } catch {
    return `${trackingUri.replace(/\/+$/, "")}${fragmentPath}`;
  }
}

function normalizeMlflowUiHash(fragmentPath: string): string {
  const normalized = fragmentPath
    .replace(/^\/?#\/?/, "")
    .replace(/^\/+/, "");
  return `#/${normalized}`;
}

function resolveMlflowTrackingUri(config: Record<string, unknown>): string | null {
  const direct = firstNonEmptyString(config.trackingUri, config.trackingURI);
  if (direct) {
    return direct;
  }
  const ref = typeof config.trackingUriRef === "string" ? config.trackingUriRef.trim() : "";
  if (ref.startsWith("env:")) {
    return process.env[ref.slice(4)]?.trim() || null;
  }
  if (ref) {
    return ref;
  }
  return process.env.MLFLOW_TRACKING_URI?.trim() || null;
}

async function probeMlflowHealth(trackingUri: string): Promise<Record<string, unknown>> {
  let healthUrl: string;
  try {
    const parsed = new URL(trackingUri);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { reachable: false, message: "Tracking URI precisa usar http ou https para health check." };
    }
    healthUrl = new URL("/health", parsed).toString();
  } catch (error) {
    return { reachable: false, message: "Tracking URI inválida.", error: error instanceof Error ? error.message : String(error) };
  }
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    return {
      reachable: response.ok,
      url: redactUrlCredentials(healthUrl),
      statusCode: response.status,
      latencyMs: Math.round(performance.now() - started),
      message: response.ok ? "MLflow respondeu ao health check." : `MLflow respondeu HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      reachable: false,
      url: redactUrlCredentials(healthUrl),
      latencyMs: Math.round(performance.now() - started),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mlflowWorkerPackageStatus(workspaceRoot: string): Promise<Record<string, unknown>> {
  const dependencies = await workerDependencyStatus(workspaceRoot);
  const packages = Array.isArray(dependencies.packages) ? dependencies.packages : [];
  const mlflowPackage = packages.find((item) => isRecord(item) && item.name === "mlflow");
  return isRecord(mlflowPackage) ? mlflowPackage : { name: "mlflow", installed: false, version: null, requirement: null };
}

function summarizeMlflowTrainingRun(run: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!run) {
    return null;
  }
  const mlflow = isRecord(run.mlflow) ? run.mlflow : null;
  return {
    runId: run.runId ?? null,
    trainingStatus: run.status ?? null,
    bestModelId: run.bestModelId ?? null,
    mlflowStatus: mlflow?.status ?? "missing",
    mlflowRunId: mlflow?.runId ?? null,
    experimentName: mlflow?.experimentName ?? null,
    runName: mlflow?.runName ?? null,
    artifactUri: mlflow?.artifactUri ?? null,
    trackingUri: typeof mlflow?.trackingUri === "string" ? redactUrlCredentials(mlflow.trackingUri) : null,
    message: mlflow?.reason ?? mlflow?.message ?? null,
  };
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function redactUrlCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) {
      parsed.username = "***";
    }
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function inferBestModelId(leaderboard: unknown[], primaryMetric: unknown): string | null {
  if (!leaderboard.length || typeof primaryMetric !== "string") {
    const first = leaderboard.find(isRecord);
    return typeof first?.modelId === "string" ? first.modelId : null;
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
  const timestamp = typeof run.createdAt === "string" ? Date.parse(run.createdAt) : NaN;
  if (Number.isFinite(timestamp)) {
    return timestamp;
  }
  const updated = typeof run.updatedAt === "string" ? Date.parse(run.updatedAt) : NaN;
  return Number.isFinite(updated) ? updated : 0;
}

function normalizeTrainingRunId(runId: string): string {
  const trimmed = runId.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new WorkspaceError(`runId inválido: ${runId}`, 400);
  }
  return trimmed;
}

function activeModelId(pipeline: PipelineFlow): string {
  const active = pipeline.nodes.find((node) => node.type === "model" && node.modelRole === "active");
  const candidate = pipeline.nodes.find((node) => node.type === "model");
  return active?.id ?? candidate?.id ?? "deterministic_baseline";
}

async function loadProjectByPath(workspaceRoot: string, relativePath: string) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const absolutePath = safeResolve(root, relativePath);
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf-8");
  } catch (error) {
    throw new WorkspaceError(`Projeto não encontrado em ${relativePath}.`, 404, error);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new WorkspaceError("project.yaml não é YAML válido.", 422, error);
  }
  return {
    project: parseMLOpsProject(parsed),
    relativePath: toWorkspaceRelative(root, absolutePath),
    absolutePath,
    projectRoot: path.dirname(absolutePath),
  };
}

async function saveProject(workspaceRoot: string, projectId: string, body: unknown) {
  const loaded = await loadProjectBundle(workspaceRoot, projectId);
  const project = parseMLOpsProject(body);
  if (project.id !== loaded.project.id) {
    throw new WorkspaceError(`O id do projeto enviado (${project.id}) não pode divergir da rota (${loaded.project.id}).`, 409);
  }
  await writeFile(safeResolve(workspaceRoot, loaded.projectPath), YAML.stringify(project), "utf-8");
  return { status: "ok", projectPath: loaded.projectPath, project };
}

async function savePipeline(workspaceRoot: string, projectId: string, body: unknown) {
  const loaded = await loadProjectBundle(workspaceRoot, projectId);
  const pipeline = parsePipelineFlow(body);
  await writeFile(safeResolve(workspaceRoot, loaded.pipelinePath), `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");
  return { status: "ok", pipelinePath: loaded.pipelinePath, pipeline };
}

async function listGeneratedArtifact(workspaceRoot: string, outDir: string) {
  const root = await resolveGeneratedArtifactRoot(workspaceRoot, outDir);
  const files = await collectGeneratedArtifactFiles(root.absoluteOutDir);
  return {
    outDir: root.relativeOutDir,
    files,
    totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

async function readGeneratedArtifactFile(workspaceRoot: string, outDir: string, filePath: string) {
  const root = await resolveGeneratedArtifactRoot(workspaceRoot, outDir);
  const normalized = normalizeArtifactRelativePath(filePath);
  const absolutePath = safeResolveArtifactFile(root.absoluteOutDir, normalized);
  const content = await readFile(absolutePath, "utf-8");
  return {
    outDir: root.relativeOutDir,
    path: normalized,
    content: content.length > 512 * 1024 ? content.slice(0, 512 * 1024) : content,
    sizeBytes: Buffer.byteLength(content),
    truncated: content.length > 512 * 1024,
  };
}

async function validateRuntimeManifestPackage(workspaceRoot: string, outDir: string) {
  const root = await resolveGeneratedArtifactRoot(workspaceRoot, outDir);
  const diagnostics: RuntimeManifestDiagnostic[] = [];
  const add = (diagnostic: RuntimeManifestDiagnostic) => diagnostics.push(diagnostic);
  const mlopsDir = path.join(root.absoluteOutDir, ".mlops");
  const requiredFiles = [
    ".mlops/project.yaml",
    ".mlops/pipeline.flow.json",
    ".mlops/runtime.manifest.json",
    ".mlops/generated-meta.json",
    ...canonicalRuntimeManifestFiles().map((file) => file.path),
    ".mlops/orchestration_manifest.yaml",
  ];

  const projectRaw = await readRequiredManifestText(root.absoluteOutDir, ".mlops/project.yaml", add);
  const pipelineRaw = await readRequiredManifestText(root.absoluteOutDir, ".mlops/pipeline.flow.json", add);
  const manifestRaw = await readRequiredManifestText(root.absoluteOutDir, ".mlops/runtime.manifest.json", add);
  const metaRaw = await readRequiredManifestText(root.absoluteOutDir, ".mlops/generated-meta.json", add);

  const project = projectRaw ? parseManifestValue<MLOpsProject>(".mlops/project.yaml", () => parseMLOpsProject(YAML.parse(projectRaw)), add) : null;
  const pipeline = pipelineRaw ? parseManifestValue<PipelineFlow>(".mlops/pipeline.flow.json", () => parsePipelineFlow(JSON.parse(pipelineRaw) as unknown), add) : null;
  const manifest = manifestRaw ? parseManifestValue<RuntimeManifest>(".mlops/runtime.manifest.json", () => parseRuntimeManifest(JSON.parse(manifestRaw) as unknown), add) : null;
  const generatedMeta = metaRaw ? parseManifestValue<Record<string, unknown>>(".mlops/generated-meta.json", () => parseGeneratedMeta(JSON.parse(metaRaw) as unknown), add) : null;
  for (const canonicalFile of canonicalRuntimeManifestFiles()) {
    const raw = await readRequiredManifestText(root.absoluteOutDir, canonicalFile.path, add);
    if (raw) {
      parseManifestValue<Record<string, unknown>>(canonicalFile.path, () => parseCanonicalRuntimeManifest(YAML.parse(raw), canonicalFile.kind, project?.id ?? null), add);
    }
  }
  const orchestrationRaw = await readRequiredManifestText(root.absoluteOutDir, ".mlops/orchestration_manifest.yaml", add);
  if (orchestrationRaw) {
    parseManifestValue<Record<string, unknown>>(".mlops/orchestration_manifest.yaml", () => parseCanonicalRuntimeManifest(YAML.parse(orchestrationRaw), "orchestration_manifest", project?.id ?? null), add);
  }

  if (project && pipeline) {
    const analysis = analyzeMLOpsProject(project, pipeline);
    for (const diagnostic of analysis.diagnostics) {
      diagnostics.push({
        severity: diagnostic.severity,
        code: `project_${diagnostic.code}`,
        message: diagnostic.message,
        path: diagnostic.path,
      });
    }
  }

  if (project && manifest) {
    compareManifestField(project.id, manifest.projectId, "manifest_project_id", "runtime.manifest.projectId", add);
    compareManifestField(project.version, manifest.projectVersion, "manifest_project_version", "runtime.manifest.projectVersion", add);
    compareManifestField(project.contract, manifest.contract, "manifest_contract", "runtime.manifest.contract", add);
    compareManifestField(project.execution.profile, manifest.executionProfile, "manifest_execution_profile", "runtime.manifest.executionProfile", add);
    compareManifestField(project.runtime.persistence.primary, manifest.persistence.primary, "manifest_persistence_primary", "runtime.manifest.persistence.primary", add);
  }

  if (pipeline && manifest && !pipeline.nodes.some((node) => node.id === manifest.activeModelId)) {
    add({ severity: "error", code: "active_model_missing", message: `Modelo ativo ${manifest.activeModelId} não existe no pipeline.`, path: ".mlops/runtime.manifest.json" });
  }

  if (manifest && generatedMeta) {
    compareManifestField(generatedMeta.projectId, manifest.projectId, "meta_project_id", "generated-meta.projectId", add);
    compareManifestField(generatedMeta.projectVersion, manifest.projectVersion, "meta_project_version", "generated-meta.projectVersion", add);
    compareManifestField(generatedMeta.contract, manifest.contract, "meta_contract", "generated-meta.contract", add);
    compareManifestField(generatedMeta.projectHash, manifest.projectHash, "meta_project_hash", "generated-meta.projectHash", add);
    compareManifestField(generatedMeta.pipelineHash, manifest.pipelineHash, "meta_pipeline_hash", "generated-meta.pipelineHash", add);
  }

  if (manifest) {
    for (const endpoint of requiredRuntimeEndpoints()) {
      if (!manifest.endpoints.includes(endpoint)) {
        add({ severity: "error", code: "missing_runtime_endpoint", message: `Endpoint obrigatório ausente no manifesto: ${endpoint}.`, path: ".mlops/runtime.manifest.json" });
      }
    }
  }

  const appManifestRaw = await readOptionalManifestText(root.absoluteOutDir, "app/metadata/runtime.manifest.json");
  if (!appManifestRaw) {
    add({ severity: "warning", code: "app_manifest_missing", message: "Manifesto do runtime não foi encontrado em app/metadata/runtime.manifest.json.", path: "app/metadata/runtime.manifest.json" });
  } else if (manifestRaw && stableParsedJson(appManifestRaw) !== stableParsedJson(manifestRaw)) {
    add({ severity: "error", code: "app_manifest_mismatch", message: "Manifesto embarcado em app/metadata difere do pacote .mlops.", path: "app/metadata/runtime.manifest.json" });
  }

  if (generatedMeta?.latestTrainingRunId) {
    const latestRaw = await readOptionalManifestText(root.absoluteOutDir, ".mlops/latest-training-result.json");
    if (!latestRaw) {
      add({ severity: "warning", code: "latest_training_missing", message: "generated-meta aponta latestTrainingRunId, mas latest-training-result.json está ausente.", path: ".mlops/latest-training-result.json" });
    } else {
      const latest = parseManifestValue<Record<string, unknown>>(".mlops/latest-training-result.json", () => parseRecord(JSON.parse(latestRaw) as unknown), add);
      if (latest && latest.runId !== generatedMeta.latestTrainingRunId) {
        add({ severity: "error", code: "latest_training_mismatch", message: "latestTrainingRunId diverge de latest-training-result.json.", path: ".mlops/latest-training-result.json" });
      }
    }
  }

  for (const secretPath of await findDisallowedRuntimeFiles(root.absoluteOutDir)) {
    add({ severity: "error", code: "secret_file_exported", message: "Arquivo de ambiente real não pode entrar no runtime gerado.", path: secretPath });
  }

  const artifactFiles = await collectGeneratedArtifactFiles(root.absoluteOutDir);
  const missingRequiredFiles = [];
  for (const required of requiredFiles) {
    if (!(await pathExists(path.join(root.absoluteOutDir, required)))) {
      missingRequiredFiles.push(required);
    }
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const infos = diagnostics.filter((diagnostic) => diagnostic.severity === "info").length;

  return {
    status: errors ? "error" : "ok",
    outDir: root.relativeOutDir,
    packagePath: `${root.relativeOutDir}/.mlops`,
    summary: {
      requiredFiles: requiredFiles.length,
      missingRequiredFiles,
      files: artifactFiles.length,
      totalSizeBytes: artifactFiles.reduce((total, file) => total + file.sizeBytes, 0),
      errors,
      warnings,
      infos,
    },
    diagnostics,
    manifest: manifest ? {
      id: manifest.id,
      projectId: manifest.projectId,
      activeModelId: manifest.activeModelId,
      endpoints: manifest.endpoints,
    } : null,
    generatedMeta: generatedMeta ? {
      projectId: generatedMeta.projectId,
      projectVersion: generatedMeta.projectVersion,
      latestTrainingRunId: generatedMeta.latestTrainingRunId ?? null,
    } : null,
    mlopsDir: toWorkspaceRelative(workspaceRoot, mlopsDir),
  };
}

async function readRequiredManifestText(root: string, relativePath: string, add: (diagnostic: RuntimeManifestDiagnostic) => void): Promise<string | null> {
  const absolutePath = path.join(root, relativePath);
  if (!(await pathExists(absolutePath))) {
    add({ severity: "error", code: "missing_manifest_file", message: `Arquivo obrigatório ausente: ${relativePath}.`, path: relativePath });
    return null;
  }
  return readFile(absolutePath, "utf-8");
}

async function readOptionalManifestText(root: string, relativePath: string): Promise<string | null> {
  const absolutePath = path.join(root, relativePath);
  if (!(await pathExists(absolutePath))) {
    return null;
  }
  return readFile(absolutePath, "utf-8");
}

function parseManifestValue<T>(pathName: string, parse: () => T, add: (diagnostic: RuntimeManifestDiagnostic) => void): T | null {
  try {
    return parse();
  } catch (error) {
    add({ severity: "error", code: "invalid_manifest_file", message: `${pathName} inválido: ${error instanceof Error ? error.message : String(error)}`, path: pathName });
    return null;
  }
}

function parseGeneratedMeta(value: unknown): Record<string, unknown> {
  const record = parseRecord(value);
  if (record.generatedKind !== "mlops-runtime") {
    throw new Error("generatedKind deve ser mlops-runtime.");
  }
  for (const field of ["contract", "projectId", "projectVersion", "projectHash", "pipelineHash", "reimportPackage", "generatedAt"]) {
    if (typeof record[field] !== "string" || !record[field]) {
      throw new Error(`${field} deve ser string não vazia.`);
    }
  }
  if (record.reimportPackage !== ".mlops") {
    throw new Error("reimportPackage deve apontar para .mlops.");
  }
  return record;
}

function canonicalRuntimeManifestFiles(): Array<{ path: string; kind: string }> {
  return [
    { path: ".mlops/data_source.yaml", kind: "data_source" },
    { path: ".mlops/dataset_manifest.yaml", kind: "dataset_manifest" },
    { path: ".mlops/feature_set.yaml", kind: "feature_set" },
    { path: ".mlops/experiment_manifest.yaml", kind: "experiment_manifest" },
    { path: ".mlops/training_manifest.yaml", kind: "training_manifest" },
    { path: ".mlops/promotion_policy.yaml", kind: "promotion_policy" },
    { path: ".mlops/model_card.yaml", kind: "model_card" },
    { path: ".mlops/api_manifest.yaml", kind: "api_manifest" },
    { path: ".mlops/container_manifest.yaml", kind: "container_manifest" },
  ];
}

function parseCanonicalRuntimeManifest(value: unknown, expectedKind: string, expectedProjectId: string | null): Record<string, unknown> {
  const record = parseRecord(value);
  if (record.kind !== expectedKind) {
    throw new Error(`kind deve ser ${expectedKind}.`);
  }
  if (record.contract !== CONTRACT_VERSION) {
    throw new Error(`contract deve ser ${CONTRACT_VERSION}.`);
  }
  if (expectedProjectId && record.projectId !== expectedProjectId) {
    throw new Error(`projectId deve ser ${expectedProjectId}.`);
  }
  if (typeof record.generatedAt !== "string" || !record.generatedAt) {
    throw new Error("generatedAt deve ser string não vazia.");
  }
  return record;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("JSON raiz deve ser objeto.");
  }
  return value;
}

function compareManifestField(left: unknown, right: unknown, code: string, pathName: string, add: (diagnostic: RuntimeManifestDiagnostic) => void): void {
  if (left !== right) {
    add({ severity: "error", code, message: `Valor inconsistente em ${pathName}: ${String(left)} != ${String(right)}.`, path: pathName });
  }
}

function requiredRuntimeEndpoints(): string[] {
  return [
    "GET /health",
    "GET /metadata",
    "GET /environment/gpu",
    "GET /model-card",
    "GET /models",
    "GET /models/active",
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
    "GET /dashboard",
  ];
}

function stableParsedJson(raw: string): string {
  try {
    return stableJson(JSON.parse(raw) as unknown);
  } catch {
    return raw.trim();
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function findDisallowedRuntimeFiles(root: string, currentDir = "", result: string[] = []): Promise<string[]> {
  const entries = await readdir(path.join(root, currentDir), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = currentDir ? `${currentDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (![".git", ".pytest_cache", "__pycache__", ".venv", "venv", "node_modules"].includes(entry.name)) {
        await findDisallowedRuntimeFiles(root, relativePath, result);
      }
      continue;
    }
    if (entry.isFile() && [".env", ".env.local", ".env.production"].includes(entry.name)) {
      result.push(relativePath.replaceAll(path.sep, "/"));
    }
  }
  return result;
}

async function exportGeneratedArtifactZip(workspaceRoot: string, body: ExportRuntimeZipBody) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const outDir = requiredBodyString(body.outDir, "outDir");
  const source = await resolveGeneratedArtifactRoot(root, outDir);
  const zipTarget = resolveGeneratedZipPath(root, optionalBodyString(body.zipPath, "zipPath") ?? `${source.relativeOutDir}.zip`);
  const files = await collectGeneratedArtifactFiles(source.absoluteOutDir);
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, await readFile(safeResolveArtifactFile(source.absoluteOutDir, file.path)));
  }
  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await mkdir(path.dirname(zipTarget.absoluteZipPath), { recursive: true });
  await writeFile(zipTarget.absoluteZipPath, content);
  return {
    status: "ok",
    outDir: source.relativeOutDir,
    zipPath: zipTarget.relativeZipPath,
    fileCount: files.length,
    sizeBytes: content.length,
  };
}

async function copyDirectoryContents(sourceDir: string, targetDir: string, currentDir = ""): Promise<void> {
  const entries = await readdir(path.join(sourceDir, currentDir), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = currentDir ? `${currentDir}/${entry.name}` : entry.name;
    const sourcePath = path.join(sourceDir, relativePath);
    const targetPath = path.join(targetDir, relativePath);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyDirectoryContents(sourceDir, targetDir, relativePath);
      continue;
    }
    if (entry.isFile()) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await cp(sourcePath, targetPath, { force: true });
    }
  }
}

async function rewriteTrainingResultProjectIds(trainingRunsRoot: string, projectId: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(trainingRunsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const resultPath = path.join(trainingRunsRoot, entry.name, "training-result.json");
    try {
      const raw = JSON.parse(await readFile(resultPath, "utf-8")) as unknown;
      if (isRecord(raw)) {
        await writeFile(resultPath, `${JSON.stringify({ ...raw, projectId }, null, 2)}\n`, "utf-8");
      }
    } catch {
      continue;
    }
  }
}

async function dockerRuntimeStatus(workspaceRoot: string, outDir: string): Promise<Record<string, unknown>> {
  const root = await resolveGeneratedRuntimeRoot(workspaceRoot, outDir, false);
  const docker = await dockerAvailability(workspaceRoot);
  let composePs: Record<string, unknown> | null = null;
  if (docker.available && root.exists && root.composeExists) {
    const ps = await runProcess("docker", dockerComposeArgs(root, ["ps", "--format", "json"]), workspaceRoot, 15_000).catch((error) => {
      if (error instanceof WorkspaceError) {
        return { exitCode: null, signal: null, stdout: "", stderr: error.message, timedOut: false };
      }
      throw error;
    });
    composePs = {
      ok: ps.exitCode === 0 && !ps.timedOut,
      stdout: trimProcessOutput(ps.stdout),
      stderr: trimProcessOutput(ps.stderr),
    };
  }
  return {
    status: "ok",
    outDir: root.relativeOutDir,
    exists: root.exists,
    dockerfileExists: root.dockerfileExists,
    composeExists: root.composeExists,
    canManage: docker.available && root.exists && root.composeExists,
    docker,
    composePs,
  };
}

async function runDockerRuntimeCommand(workspaceRoot: string, body: RuntimeDockerBody, action: "build" | "up" | "down"): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new WorkspaceError("Operação Docker exige confirm: true.", 400);
  }
  const outDir = optionalBodyString(body.outDir, "outDir");
  if (!outDir) {
    throw new WorkspaceError("outDir é obrigatório.", 400);
  }
  const root = await resolveGeneratedRuntimeRoot(workspaceRoot, outDir, true);
  const docker = await dockerAvailability(workspaceRoot);
  if (!docker.available) {
    throw new WorkspaceError("Docker não está disponível para gerenciar o runtime.", 503, docker);
  }
  const actionArgs =
    action === "build"
      ? ["build"]
      : action === "up"
        ? ["up", "-d", "--build"]
        : ["down"];
  const timeout = Math.max(30_000, Math.min(body.timeoutMs ?? (action === "build" || action === "up" ? 600_000 : 120_000), 1_800_000));
  const args = dockerComposeArgs(root, actionArgs);
  const startedAt = new Date();
  const started = performance.now();
  const result = await runProcess("docker", args, workspaceRoot, timeout);
  const historyEntry = await appendDockerRuntimeHistory(workspaceRoot, {
    id: randomUUID(),
    action,
    outDir: root.relativeOutDir,
    command: `docker ${args.join(" ")}`,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ok: result.exitCode === 0 && !result.timedOut,
    stdout: trimProcessOutput(result.stdout),
    stderr: trimProcessOutput(result.stderr),
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new WorkspaceError(result.timedOut ? `Docker ${action} excedeu o timeout.` : `Docker ${action} falhou.`, result.timedOut ? 504 : 500, { ...result, historyEntry });
  }
  const history = await readDockerRuntimeHistory(workspaceRoot, root.relativeOutDir, 50);
  return {
    status: "ok",
    action,
    outDir: root.relativeOutDir,
    command: historyEntry.command,
    stdout: historyEntry.stdout,
    stderr: historyEntry.stderr,
    historyEntry,
    history,
    docker: await dockerRuntimeStatus(workspaceRoot, root.relativeOutDir),
  };
}

async function dockerRuntimeLogs(workspaceRoot: string, outDir: string, tail: number): Promise<Record<string, unknown>> {
  const root = await resolveGeneratedRuntimeRoot(workspaceRoot, outDir, true);
  const docker = await dockerAvailability(workspaceRoot);
  if (!docker.available) {
    throw new WorkspaceError("Docker não está disponível para ler logs do runtime.", 503, docker);
  }
  const args = dockerComposeArgs(root, ["logs", "--no-color", "--tail", String(tail)]);
  const startedAt = new Date();
  const started = performance.now();
  const result = await runProcess("docker", args, workspaceRoot, 60_000);
  const historyEntry = await appendDockerRuntimeHistory(workspaceRoot, {
    id: randomUUID(),
    action: "logs",
    outDir: root.relativeOutDir,
    command: `docker ${args.join(" ")}`,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ok: result.exitCode === 0 && !result.timedOut,
    stdout: trimProcessOutput(result.stdout),
    stderr: trimProcessOutput(result.stderr),
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new WorkspaceError(result.timedOut ? "Docker logs excedeu o timeout." : "Docker logs falhou.", result.timedOut ? 504 : 500, { ...result, historyEntry });
  }
  return {
    status: "ok",
    action: "logs",
    outDir: root.relativeOutDir,
    tail,
    command: historyEntry.command,
    stdout: historyEntry.stdout,
    stderr: historyEntry.stderr,
    historyEntry,
    history: await readDockerRuntimeHistory(workspaceRoot, root.relativeOutDir, 50),
  };
}

async function dockerRuntimeHistory(workspaceRoot: string, outDir: string, limit: number): Promise<Record<string, unknown>> {
  const root = await resolveGeneratedRuntimeRoot(workspaceRoot, outDir, false);
  return {
    status: "ok",
    outDir: root.relativeOutDir,
    history: await readDockerRuntimeHistory(workspaceRoot, root.relativeOutDir, limit),
  };
}

async function dockerRuntimeInspect(workspaceRoot: string, outDir: string): Promise<Record<string, unknown>> {
  const root = await resolveGeneratedRuntimeRoot(workspaceRoot, outDir, false);
  const docker = await dockerAvailability(workspaceRoot);
  const startedAt = new Date();
  const started = performance.now();
  const composeFile = await readRuntimeTextFile(root.composePath, root.composeExists);
  const dockerfile = await readRuntimeTextFile(root.dockerfilePath, root.dockerfileExists);
  let composeConfig: Record<string, unknown> | null = null;
  let composeImages: Record<string, unknown> | null = null;

  if (docker.available && root.exists && root.composeExists) {
    const config = await runProcess("docker", dockerComposeArgs(root, ["config"]), workspaceRoot, 60_000).catch((error) => processFailure(error));
    composeConfig = {
      ok: config.exitCode === 0 && !config.timedOut,
      command: `docker ${dockerComposeArgs(root, ["config"]).join(" ")}`,
      stdout: trimProcessOutput(config.stdout),
      stderr: trimProcessOutput(config.stderr),
      timedOut: config.timedOut,
    };
    const images = await runProcess("docker", dockerComposeArgs(root, ["images", "--format", "json"]), workspaceRoot, 60_000).catch((error) => processFailure(error));
    composeImages = {
      ok: images.exitCode === 0 && !images.timedOut,
      command: `docker ${dockerComposeArgs(root, ["images", "--format", "json"]).join(" ")}`,
      stdout: trimProcessOutput(images.stdout),
      stderr: trimProcessOutput(images.stderr),
      timedOut: images.timedOut,
      items: parseJsonLines(images.stdout),
    };
  }

  const summary = {
    filesOk: root.exists && root.composeExists && root.dockerfileExists,
    dockerAvailable: docker.available === true,
    composeConfigOk: composeConfig ? composeConfig.ok === true : null,
    composeImagesOk: composeImages ? composeImages.ok === true : null,
  };
  const historyEntry = await appendDockerRuntimeHistory(workspaceRoot, {
    id: randomUUID(),
    action: "inspect",
    outDir: root.relativeOutDir,
    command: docker.available ? "docker compose config; docker compose images" : "inspect generated runtime files",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    exitCode: summary.filesOk ? 0 : 1,
    timedOut: false,
    ok: summary.filesOk,
    stdout: JSON.stringify(summary),
    stderr: "",
  });

  return {
    status: "ok",
    outDir: root.relativeOutDir,
    exists: root.exists,
    docker,
    summary,
    composeFile,
    dockerfile,
    composeConfig,
    composeImages,
    historyEntry,
    history: await readDockerRuntimeHistory(workspaceRoot, root.relativeOutDir, 50),
  };
}

async function smokeRuntime(baseUrl?: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const base = runtimeBaseUrl(baseUrl);
  const started = performance.now();
  const predictionPayload = payload && Object.keys(payload).length > 0 ? payload : { text: "smoke ticket teste", email: "smoke@example.com" };
  const checkTimeout = Math.max(1_000, Math.min(timeoutMs ?? 60_000, 120_000));
  const checks = [];
  checks.push(await smokeRuntimeCheck(base, "health", "GET", "/health", undefined, checkTimeout, (body) => isRecord(body) && body.status === "ok"));
  checks.push(await smokeRuntimeCheck(base, "metadata", "GET", "/metadata", undefined, checkTimeout, (body) => isRecord(body) && isRecord(body.project) && body.contract === "mlops-flow-v1"));
  const modelsCheck = await smokeRuntimeCheck(base, "models", "GET", "/models", undefined, checkTimeout, (body) => isRecord(body) && Array.isArray(body.models));
  checks.push(modelsCheck);
  checks.push(await smokeRuntimeCheck(base, "active_model", "GET", "/models/active", undefined, checkTimeout, (body) => isRecord(body) && typeof body.id === "string"));
  checks.push(await smokeRuntimeCheck(base, "model_metrics", "GET", "/metrics/model", undefined, checkTimeout, (body) => isRecord(body)));
  checks.push(await smokeRuntimeCheck(base, "runtime_metrics", "GET", "/metrics/runtime", undefined, checkTimeout, (body) => isRecord(body) && typeof body.prediction_count === "number"));
  const predictCheck = await smokeRuntimeCheck(base, "predict", "POST", "/predict", { input: predictionPayload }, checkTimeout, (body) => isRecord(body) && typeof body.run_id === "string" && typeof body.model_version_id === "string");
  checks.push(predictCheck);
  const modelsBody = isRecord(modelsCheck.rawBody) && Array.isArray(modelsCheck.rawBody.models) ? modelsCheck.rawBody.models : [];
  const predictBody = isRecord(predictCheck.body) ? predictCheck.body : {};
  const smokeModel = modelsBody.find((item): item is Record<string, unknown> => isRecord(item) && typeof item.id === "string" && item.id !== predictBody.model_version_id)
    ?? modelsBody.find((item): item is Record<string, unknown> => isRecord(item) && typeof item.id === "string");
  const smokeModelId = String(smokeModel?.id ?? predictBody.model_version_id ?? "");
  checks.push(await smokeRuntimeCheck(base, "deployment_status", "GET", "/deployment/status", undefined, checkTimeout, (body) => isRecord(body) && body.status === "ok"));
  checks.push(await smokeRuntimeCheck(base, "deployment_shadow", "POST", "/deployment/shadow", { confirm: true, model_id: smokeModelId, requested_by: "smoke", reason: "Smoke operacional shadow." }, checkTimeout, (body) => isRecord(body) && isRecord(body.rollout) && body.rollout.kind === "shadow"));
  checks.push(await smokeRuntimeCheck(base, "deployment_shadow_predict", "POST", "/predict", { input: { ...predictionPayload, smoke_deployment: "shadow" } }, checkTimeout, (body) => isRecord(body) && isRecord(body.deployment) && body.deployment.mode === "shadow" && isRecord(body.shadow_prediction)));
  checks.push(await smokeRuntimeCheck(base, "deployment_canary", "POST", "/deployment/canary", { confirm: true, model_id: smokeModelId, traffic_percent: 50, requested_by: "smoke", reason: "Smoke operacional canary." }, checkTimeout, (body) => isRecord(body) && isRecord(body.rollout) && body.rollout.kind === "canary"));
  checks.push(await smokeRuntimeCheck(base, "deployment_canary_predict", "POST", "/predict", { input: { ...predictionPayload, smoke_deployment: "canary" } }, checkTimeout, (body) => isRecord(body) && isRecord(body.deployment) && body.deployment.mode === "canary"));
  checks.push(await smokeRuntimeCheck(base, "deployment_rollback", "POST", "/deployment/rollback", { confirm: true, requested_by: "smoke", reason: "Smoke operacional rollback." }, checkTimeout, (body) => isRecord(body) && isRecord(body.rollout) && body.rollout.kind === "rollback" && isRecord(body.deployment) && body.deployment.mode === "active"));
  const predictedLabel = "prediction" in predictBody ? predictBody.prediction : "smoke";
  checks.push(await smokeRuntimeCheck(base, "feedback", "POST", "/feedback", { run_id: predictBody.run_id, actual_label: predictedLabel, source: "smoke" }, checkTimeout, (body) => isRecord(body) && typeof body.feedback_id === "string" && body.correct === true));
  checks.push(await smokeRuntimeCheck(base, "feedback_summary", "GET", "/feedback/summary", undefined, checkTimeout, (body) => isRecord(body) && typeof body.feedback_count === "number"));
  const retrainingRequestCheck = await smokeRuntimeCheck(base, "retraining_request", "POST", "/retraining/requests", { min_feedback_count: 1, requested_by: "smoke", reason: "Smoke operacional de retreino controlado." }, checkTimeout, (body) => isRecord(body) && typeof body.request_id === "string" && ["pending_review", "blocked"].includes(String(body.status)));
  checks.push(retrainingRequestCheck);
  const retrainingBody = isRecord(retrainingRequestCheck.body) ? retrainingRequestCheck.body : {};
  checks.push(await smokeRuntimeCheck(base, "retraining_approval", "POST", `/retraining/requests/${encodeURIComponent(String(retrainingBody.request_id ?? ""))}/approve`, { confirm: true, approved_by: "smoke" }, checkTimeout, (body) => isRecord(body) && body.status === "approved_pending_runner"));
  checks.push(await smokeRuntimeCheck(base, "retraining_training_set", "GET", `/retraining/requests/${encodeURIComponent(String(retrainingBody.request_id ?? ""))}/training-set`, undefined, checkTimeout, (body) => isRecord(body) && typeof body.row_count === "number" && Array.isArray(body.rows)));
  checks.push(await smokeRuntimeCheck(base, "retraining_completion", "POST", `/retraining/requests/${encodeURIComponent(String(retrainingBody.request_id ?? ""))}/complete`, { confirm: true, completed_by: "smoke", success: true, job_id: "smoke", training_run_id: "smoke", model_id: "smoke" }, checkTimeout, (body) => isRecord(body) && body.status === "completed"));
  checks.push(await smokeRuntimeCheck(base, "retraining_status", "GET", "/retraining/status", undefined, checkTimeout, (body) => isRecord(body) && typeof body.request_count === "number"));
  checks.push(await smokeRuntimeCheck(base, "dashboard", "GET", "/dashboard", undefined, checkTimeout, (body) => typeof body === "string" && body.includes("MLOps Runtime Dashboard")));
  const failed = checks.filter((check) => check.status !== "ok");
  return {
    status: failed.length === 0 ? "ok" : "error",
    baseUrl: base.toString(),
    url: new URL("/health", base).toString(),
    statusCode: checks[0]?.statusCode ?? null,
    latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      predictionLogged: checks.some((check) => check.name === "predict" && check.status === "ok"),
      feedbackLogged: checks.some((check) => check.name === "feedback" && check.status === "ok"),
      retrainingRequested: checks.some((check) => check.name === "retraining_request" && check.status === "ok"),
      retrainingCompleted: checks.some((check) => check.name === "retraining_completion" && check.status === "ok"),
      deploymentObserved: checks.some((check) => check.name === "deployment_status" && check.status === "ok"),
      deploymentRolledBack: checks.some((check) => check.name === "deployment_rollback" && check.status === "ok"),
    },
    checks,
  };
}

async function inspectRemoteRuntime(baseUrl?: string, timeoutMs?: number): Promise<Record<string, unknown>> {
  const base = remoteRuntimeBaseUrl(baseUrl);
  const started = performance.now();
  const checkTimeout = Math.max(1_000, Math.min(timeoutMs ?? 15_000, 120_000));
  const probes: Array<{
    name: string;
    path: string;
    contractEndpoint: boolean;
    validate: (body: unknown) => boolean;
  }> = [
    { name: "health", path: "/health", contractEndpoint: true, validate: (body) => body !== null && body !== undefined },
    { name: "metadata", path: "/metadata", contractEndpoint: true, validate: isRecord },
    { name: "openapi", path: "/openapi.json", contractEndpoint: false, validate: isRecord },
    { name: "model_card", path: "/model-card", contractEndpoint: true, validate: isRecord },
    { name: "models", path: "/models", contractEndpoint: true, validate: (body) => Array.isArray(body) || isRecord(body) },
    { name: "active_model", path: "/models/active", contractEndpoint: true, validate: isRecord },
    { name: "model_metrics", path: "/metrics/model", contractEndpoint: true, validate: isRecord },
    { name: "runtime_metrics", path: "/metrics/runtime", contractEndpoint: true, validate: isRecord },
    { name: "feedback_summary", path: "/feedback/summary", contractEndpoint: true, validate: isRecord },
    { name: "retraining_status", path: "/retraining/status", contractEndpoint: true, validate: isRecord },
    { name: "promotion_status", path: "/promotion/status", contractEndpoint: true, validate: isRecord },
    { name: "deployment_status", path: "/deployment/status", contractEndpoint: true, validate: isRecord },
    { name: "drift_latest", path: "/drift/latest", contractEndpoint: true, validate: isRecord },
    { name: "gpu_environment", path: "/environment/gpu", contractEndpoint: false, validate: isRecord },
    { name: "dashboard", path: "/dashboard", contractEndpoint: false, validate: (body) => typeof body === "string" && body.length > 0 },
  ];
  const checks: RemoteRuntimeCheck[] = [];
  for (const probe of probes) {
    checks.push(await inspectRemoteRuntimeCheck(base, probe.name, probe.path, checkTimeout, probe.contractEndpoint, probe.validate));
  }

  const okCount = checks.filter((check) => check.status === "ok").length;
  const missingCount = checks.filter((check) => check.status === "missing").length;
  const errorCount = checks.filter((check) => check.status === "error").length;
  const metadata = bodyForRemoteCheck(checks, "metadata");
  const activeModel = bodyForRemoteCheck(checks, "active_model");
  const mlopsContract = isRecord(metadata) && metadata.contract === "mlops-flow-v1";
  const contractSignals = ["metadata", "active_model", "model_metrics", "runtime_metrics", "feedback_summary", "retraining_status", "promotion_status", "deployment_status", "drift_latest"]
    .filter((name) => remoteCheckStatus(checks, name) === "ok").length;
  const coreComplete = ["health", "metadata", "active_model", "model_metrics", "runtime_metrics"]
    .every((name) => remoteCheckStatus(checks, name) === "ok");
  const mode: RemoteRuntimeMode = okCount === 0
    ? "unreachable"
    : mlopsContract
      ? "white_box"
      : contractSignals >= 2
        ? "partial_contract"
        : "black_box_observable";
  const status = okCount === 0 ? "error" : mlopsContract && coreComplete && errorCount === 0 ? "ok" : "warning";

  return {
    status,
    mode,
    baseUrl: base.toString(),
    latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
    readOnly: true,
    summary: {
      total: checks.length,
      ok: okCount,
      missing: missingCount,
      errors: errorCount,
      contractEndpointsOk: checks.filter((check) => check.contractEndpoint && check.status === "ok").length,
      contractEndpointsTotal: checks.filter((check) => check.contractEndpoint).length,
    },
    identity: remoteRuntimeIdentity(metadata, activeModel),
    recommendations: remoteRuntimeRecommendations(checks, mode, mlopsContract),
    checks,
  };
}

async function inspectRemoteRuntimeCheck(
  base: URL,
  name: string,
  pathName: string,
  timeoutMs: number,
  contractEndpoint: boolean,
  validate: (body: unknown) => boolean,
): Promise<RemoteRuntimeCheck> {
  const url = new URL(pathName, base).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseSmokeResponse(text, response.headers.get("content-type") ?? "");
    if (response.status === 404 || response.status === 405) {
      return {
        name,
        status: "missing",
        method: "GET",
        path: pathName,
        url,
        statusCode: response.status,
        latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
        contractEndpoint,
        body: compactSmokeBody(body),
        message: "Endpoint não exposto pelo runtime.",
      };
    }
    const ok = response.ok && validate(body);
    return {
      name,
      status: ok ? "ok" : "error",
      method: "GET",
      path: pathName,
      url,
      statusCode: response.status,
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
      contractEndpoint,
      body: compactSmokeBody(body),
      message: ok ? undefined : "Resposta remota não atendeu ao contrato esperado.",
    };
  } catch (error) {
    return {
      name,
      status: "error",
      method: "GET",
      path: pathName,
      url,
      statusCode: null,
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
      contractEndpoint,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function remoteRuntimeIdentity(metadata: unknown, activeModel: unknown): Record<string, unknown> {
  const project = isRecord(metadata) && isRecord(metadata.project) ? metadata.project : {};
  const persistence = isRecord(metadata) && isRecord(metadata.persistence) ? metadata.persistence : {};
  return {
    contract: isRecord(metadata) && typeof metadata.contract === "string" ? metadata.contract : null,
    projectId: typeof project.id === "string" ? project.id : null,
    projectName: typeof project.name === "string" ? project.name : null,
    activeModelId: isRecord(activeModel) && typeof activeModel.id === "string" ? activeModel.id : null,
    persistence: isRecord(persistence) ? persistence : null,
    executionProfile: isRecord(metadata) && typeof metadata.executionProfile === "string" ? metadata.executionProfile : null,
    generatedBy: isRecord(metadata) && typeof metadata.generatedBy === "string" ? metadata.generatedBy : null,
  };
}

function remoteRuntimeRecommendations(checks: RemoteRuntimeCheck[], mode: RemoteRuntimeMode, mlopsContract: boolean): string[] {
  const recommendations = ["remote_inspection_read_only_no_predict"];
  if (mode === "unreachable") {
    recommendations.push("runtime_unreachable_or_blocked");
    return recommendations;
  }
  if (remoteCheckStatus(checks, "health") !== "ok") {
    recommendations.push("expose_get_health");
  }
  if (remoteCheckStatus(checks, "metadata") !== "ok") {
    recommendations.push("expose_get_metadata_for_white_box_reimport");
  } else if (!mlopsContract) {
    recommendations.push("metadata_without_mlops_flow_contract");
  }
  for (const name of ["active_model", "model_metrics", "runtime_metrics", "feedback_summary", "retraining_status", "promotion_status"]) {
    if (remoteCheckStatus(checks, name) !== "ok") {
      recommendations.push(`expose_${name}`);
    }
  }
  if (mode === "black_box_observable") {
    recommendations.push("black_box_observable_only_no_import_contract");
  }
  return recommendations;
}

function bodyForRemoteCheck(checks: RemoteRuntimeCheck[], name: string): unknown {
  return checks.find((check) => check.name === name && check.status === "ok")?.body;
}

function remoteCheckStatus(checks: RemoteRuntimeCheck[], name: string): RemoteRuntimeCheckStatus | "absent" {
  return checks.find((check) => check.name === name)?.status ?? "absent";
}

async function smokeRuntimeCheck(
  base: URL,
  name: string,
  method: "GET" | "POST",
  pathName: string,
  requestBody: Record<string, unknown> | undefined,
  timeoutMs: number,
  validate: (body: unknown) => boolean,
): Promise<Record<string, unknown>> {
  const url = new URL(pathName, base).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: requestBody ? { "content-type": "application/json" } : undefined,
      body: requestBody ? JSON.stringify(requestBody) : undefined,
    });
    const text = await response.text();
    const body = parseSmokeResponse(text, response.headers.get("content-type") ?? "");
    const ok = response.ok && validate(body);
    const result: Record<string, unknown> = {
      name,
      status: ok ? "ok" : "error",
      method,
      url,
      statusCode: response.status,
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
      body: compactSmokeBody(body),
      message: ok ? undefined : "Resposta do runtime não atendeu ao contrato esperado.",
    };
    Object.defineProperty(result, "rawBody", { value: body, enumerable: false });
    return result;
  } catch (error) {
    return {
      name,
      status: "error",
      method,
      url,
      statusCode: null,
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseSmokeResponse(text: string, contentType: string): unknown {
  if (contentType.includes("application/json")) {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }
  return text;
}

function compactSmokeBody(body: unknown): unknown {
  if (typeof body === "string") {
    return body.length > 500 ? `${body.slice(0, 500)}...` : body;
  }
  const serialized = JSON.stringify(body);
  if (serialized.length > 2_000) {
    return { truncated: true, preview: `${serialized.slice(0, 1_500)}...` };
  }
  return body;
}

function runtimeBaseUrl(baseUrl?: string): URL {
  const raw = (baseUrl || "http://127.0.0.1:8080").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new WorkspaceError("baseUrl inválida para smoke do runtime.", 400, error);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new WorkspaceError("baseUrl do smoke deve usar http ou https.", 400);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new WorkspaceError("Smoke do runtime só aceita localhost ou 127.0.0.1.", 400);
  }
  return parsed;
}

function remoteRuntimeBaseUrl(baseUrl?: string): URL {
  const raw = (baseUrl || "").trim();
  if (!raw) {
    throw new WorkspaceError("baseUrl é obrigatória para inspecionar runtime remoto.", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new WorkspaceError("baseUrl inválida para inspeção de runtime remoto.", 400, error);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new WorkspaceError("baseUrl remota deve usar http ou https.", 400);
  }
  if (parsed.username || parsed.password) {
    throw new WorkspaceError("baseUrl remota não deve incluir credenciais.", 400);
  }
  return parsed;
}

async function dockerAvailability(workspaceRoot: string): Promise<Record<string, unknown>> {
  try {
    const result = await runProcess("docker", ["--version"], workspaceRoot, 10_000);
    return {
      available: result.exitCode === 0 && !result.timedOut,
      version: result.exitCode === 0 ? result.stdout.trim() : null,
      stderr: trimProcessOutput(result.stderr),
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readRuntimeTextFile(filePath: string, exists: boolean): Promise<Record<string, unknown>> {
  if (!exists) {
    return { exists: false, content: "" };
  }
  const fileStat = await stat(filePath);
  const raw = await readFile(filePath, "utf-8");
  return {
    exists: true,
    sizeBytes: fileStat.size,
    content: trimProcessOutput(raw),
  };
}

function parseJsonLines(value: string): unknown[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { raw: line };
      }
    });
}

function processFailure(error: unknown): { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean } {
  if (error instanceof WorkspaceError) {
    return { exitCode: null, signal: null, stdout: "", stderr: error.message, timedOut: false };
  }
  return { exitCode: null, signal: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
}

async function resolveGeneratedRuntimeRoot(workspaceRoot: string, outDir: string, requireCompose: boolean) {
  const absoluteOutDir = safeResolve(workspaceRoot, outDir);
  const relativeOutDir = toWorkspaceRelative(workspaceRoot, absoluteOutDir);
  if (relativeOutDir !== "generated" && !relativeOutDir.startsWith("generated/")) {
    throw new WorkspaceError("Runtime Docker só pode ser gerenciado dentro de generated/.", 400);
  }
  const exists = await pathExists(absoluteOutDir);
  if (requireCompose && !exists) {
    throw new WorkspaceError(`Runtime gerado não encontrado: ${relativeOutDir}`, 404);
  }
  if (exists) {
    const item = await stat(absoluteOutDir);
    if (!item.isDirectory()) {
      throw new WorkspaceError(`outDir não é diretório: ${relativeOutDir}`, 400);
    }
  }
  const composePath = path.join(absoluteOutDir, "docker-compose.yml");
  const dockerfilePath = path.join(absoluteOutDir, "Dockerfile");
  const composeExists = await pathExists(composePath);
  const dockerfileExists = await pathExists(dockerfilePath);
  if (requireCompose && !composeExists) {
    throw new WorkspaceError(`docker-compose.yml não encontrado em ${relativeOutDir}.`, 404);
  }
  return { absoluteOutDir, relativeOutDir, exists, composePath, dockerfilePath, composeExists, dockerfileExists };
}

function dockerComposeArgs(root: { composePath: string; absoluteOutDir: string }, args: string[]): string[] {
  return ["compose", "-f", root.composePath, "--project-directory", root.absoluteOutDir, ...args];
}

async function appendDockerRuntimeHistory(workspaceRoot: string, entry: RuntimeDockerHistoryEntry): Promise<RuntimeDockerHistoryEntry> {
  const historyPath = dockerRuntimeHistoryPath(workspaceRoot, entry.outDir);
  await mkdir(path.dirname(historyPath), { recursive: true });
  const existing = await readDockerRuntimeHistoryFile(historyPath);
  const next = [entry, ...existing].slice(0, 200);
  await writeFile(historyPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return entry;
}

async function readDockerRuntimeHistory(workspaceRoot: string, outDir: string, limit: number): Promise<RuntimeDockerHistoryEntry[]> {
  const historyPath = dockerRuntimeHistoryPath(workspaceRoot, outDir);
  const entries = await readDockerRuntimeHistoryFile(historyPath);
  return entries.slice(0, limit);
}

async function readDockerRuntimeHistoryFile(historyPath: string): Promise<RuntimeDockerHistoryEntry[]> {
  try {
    const raw = await readFile(historyPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isDockerRuntimeHistoryEntry);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

function dockerRuntimeHistoryPath(workspaceRoot: string, outDir: string): string {
  const fileName = `${Buffer.from(outDir).toString("base64url")}.json`;
  return safeResolve(workspaceRoot, path.join(".mlops-studio", "docker-runtime-history", fileName));
}

function isDockerRuntimeHistoryEntry(value: unknown): value is RuntimeDockerHistoryEntry {
  return isRecord(value)
    && typeof value.id === "string"
    && ["build", "up", "down", "logs", "inspect"].includes(String(value.action))
    && typeof value.outDir === "string"
    && typeof value.command === "string"
    && typeof value.startedAt === "string"
    && typeof value.completedAt === "string"
    && typeof value.durationMs === "number"
    && (typeof value.exitCode === "number" || value.exitCode === null)
    && typeof value.timedOut === "boolean"
    && typeof value.ok === "boolean"
    && typeof value.stdout === "string"
    && typeof value.stderr === "string";
}

async function resolveGeneratedArtifactRoot(workspaceRoot: string, outDir: string) {
  const absoluteOutDir = safeResolve(workspaceRoot, outDir);
  const relativeOutDir = toWorkspaceRelative(workspaceRoot, absoluteOutDir);
  if (relativeOutDir !== "generated" && !relativeOutDir.startsWith("generated/")) {
    throw new WorkspaceError("Artefatos gerados só podem ser lidos dentro de generated/.", 400);
  }
  if (!(await pathExists(absoluteOutDir))) {
    throw new WorkspaceError(`Artefato gerado não encontrado: ${relativeOutDir}`, 404);
  }
  const item = await stat(absoluteOutDir);
  if (!item.isDirectory()) {
    throw new WorkspaceError(`outDir não é diretório: ${relativeOutDir}`, 400);
  }
  return { absoluteOutDir, relativeOutDir };
}

function resolveGeneratedZipPath(workspaceRoot: string, zipPath: string) {
  const normalized = normalizeArtifactRelativePath(zipPath);
  if (path.extname(normalized).toLowerCase() !== ".zip") {
    throw new WorkspaceError(`Zip deve terminar com .zip: ${zipPath}`, 400);
  }
  const absoluteZipPath = safeResolve(workspaceRoot, normalized);
  const relativeZipPath = toWorkspaceRelative(workspaceRoot, absoluteZipPath);
  if (relativeZipPath !== "generated" && !relativeZipPath.startsWith("generated/")) {
    throw new WorkspaceError("Zips de runtime só podem ficar dentro de generated/.", 400);
  }
  return { absoluteZipPath, relativeZipPath };
}

async function extractRuntimeZipToTemp(workspaceRoot: string, sourceZip: string) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const zipPath = resolveGeneratedZipPath(root, sourceZip);
  if (!(await pathExists(zipPath.absoluteZipPath))) {
    throw new WorkspaceError(`Zip de runtime não encontrado: ${zipPath.relativeZipPath}`, 404);
  }
  const item = await stat(zipPath.absoluteZipPath);
  if (!item.isFile()) {
    throw new WorkspaceError(`sourceZip não é arquivo: ${zipPath.relativeZipPath}`, 400);
  }

  const cleanupDir = safeResolve(root, `generated/.zip-import-${Date.now()}-${randomUUID()}`);
  await rm(cleanupDir, { recursive: true, force: true });
  await mkdir(cleanupDir, { recursive: true });
  try {
    const zip = await JSZip.loadAsync(await readFile(zipPath.absoluteZipPath));
    for (const entry of Object.values(zip.files)) {
      const normalized = normalizeZipEntryPath(entry.name);
      if (!normalized) {
        continue;
      }
      const target = safeResolveArtifactFile(cleanupDir, normalized);
      if (entry.dir) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await entry.async("nodebuffer"));
    }
    const absoluteOutDir = await locateExtractedRuntimeRoot(cleanupDir);
    return {
      absoluteOutDir,
      relativeOutDir: zipPath.relativeZipPath,
      cleanupDir,
      sourceZip: zipPath.relativeZipPath,
      sourceGitUrl: null as string | null,
      sourceGitRef: null as string | null,
    };
  } catch (error) {
    await rm(cleanupDir, { recursive: true, force: true });
    if (error instanceof WorkspaceError) {
      throw error;
    }
    throw new WorkspaceError("Zip de runtime inválido ou ilegível.", 422, error);
  }
}

async function resolveRuntimeGitImportSource(workspaceRoot: string, body: ImportRuntimeBody, sourceGitUrl: string) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const confirmExternalSource = optionalBodyBoolean(body.confirmExternalSource, "confirmExternalSource") === true;
  if (!confirmExternalSource) {
    throw new WorkspaceError("Importação de Git exige confirmExternalSource: true para registrar que a origem externa não será executada.", 409);
  }
  const sourceGitRef = normalizeGitRef(body.sourceGitRef);
  const source = normalizeGitImportSource(root, sourceGitUrl);
  if (source.kind === "local") {
    if (!(await pathExists(path.join(source.path, ".git")))) {
      throw new WorkspaceError("sourceGitUrl local deve apontar para um repositório Git com diretório .git.", 422);
    }
    const absoluteOutDir = await locateGitImportRoot(source.path);
    return {
      absoluteOutDir,
      relativeOutDir: `git:${source.display}`,
      cleanupDir: null as string | null,
      sourceZip: null as string | null,
      sourceGitUrl: source.display,
      sourceGitRef: sourceGitRef ?? null,
    };
  }

  const timeoutMs = optionalBodyTimeoutMs(body.timeoutMs, "timeoutMs") ?? 120_000;
  const cleanupDir = safeResolve(root, `generated/.git-import-${Date.now()}-${randomUUID()}`);
  const cloneDir = path.join(cleanupDir, "repo");
  await rm(cleanupDir, { recursive: true, force: true });
  await mkdir(cleanupDir, { recursive: true });
  const args = ["clone", "--depth", "1", "--no-tags"];
  if (sourceGitRef) {
    args.push("--branch", sourceGitRef);
  }
  args.push("--", source.url, cloneDir);
  try {
    const result = await runProcess("git", args, root, timeoutMs);
    if (result.timedOut || result.exitCode !== 0) {
      throw new WorkspaceError("Falha ao clonar repositório Git para importação.", 422, {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: trimProcessOutput(result.stdout),
        stderr: trimProcessOutput(result.stderr),
      });
    }
    const absoluteOutDir = await locateGitImportRoot(cloneDir);
    return {
      absoluteOutDir,
      relativeOutDir: `git:${source.display}`,
      cleanupDir,
      sourceZip: null as string | null,
      sourceGitUrl: source.display,
      sourceGitRef: sourceGitRef ?? null,
    };
  } catch (error) {
    await rm(cleanupDir, { recursive: true, force: true });
    throw error;
  }
}

function normalizeGitImportSource(workspaceRoot: string, sourceGitUrl: string): { kind: "local"; path: string; display: string } | { kind: "remote"; url: string; display: string } {
  try {
    const parsed = new URL(sourceGitUrl);
    if (parsed.protocol === "file:") {
      const localPath = fileURLToPath(parsed);
      const absolutePath = safeResolve(workspaceRoot, localPath);
      return { kind: "local", path: absolutePath, display: toWorkspaceRelative(workspaceRoot, absolutePath) };
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (parsed.username || parsed.password) {
        throw new WorkspaceError("sourceGitUrl não deve incluir credenciais.", 400);
      }
      return { kind: "remote", url: parsed.toString(), display: parsed.toString() };
    }
    throw new WorkspaceError("sourceGitUrl deve usar http, https, file ou caminho local dentro do workspace.", 400);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    const absolutePath = safeResolve(workspaceRoot, sourceGitUrl);
    return { kind: "local", path: absolutePath, display: toWorkspaceRelative(workspaceRoot, absolutePath) };
  }
}

function normalizeGitRef(value: string | undefined): string | undefined {
  const ref = optionalBodyString(value, "sourceGitRef");
  if (!ref) {
    return undefined;
  }
  if (ref.startsWith("-") || ref.includes("..") || ref.includes("\\") || ref.includes("@{") || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new WorkspaceError("sourceGitRef deve ser uma branch, tag ou ref simples, sem espaços ou segmentos inseguros.", 400);
  }
  return ref;
}

async function locateGitImportRoot(repoRoot: string): Promise<string> {
  try {
    return await locateExtractedRuntimeRoot(repoRoot);
  } catch (error) {
    if (await hasStaticGitRuntimeSignal(repoRoot)) {
      return repoRoot;
    }
    const entries = await readdir(repoRoot, { withFileTypes: true });
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") {
        continue;
      }
      const candidate = path.join(repoRoot, entry.name);
      if (await hasStaticGitRuntimeSignal(candidate)) {
        candidates.push(candidate);
      }
    }
    if (candidates.length === 1) {
      return candidates[0] as string;
    }
    if (candidates.length === 0) {
      return repoRoot;
    }
    throw new WorkspaceError(
      "Repositório Git para importação precisa conter pacote .mlops, app/metadata, OpenAPI com endpoints, Dockerfile com labels MLOps, Compose com labels MLOps ou rotas FastAPI/Flask/Starlette/Django/Express/Fastify/Koa/Hono/NestJS/Next.js/gRPC/Go/Ruby/Java/ASP.NET Core/PHP para importação estática.",
      422,
      error,
    );
  }
}

async function locateExtractedRuntimeRoot(cleanupDir: string): Promise<string> {
  if (await hasImportableRuntimeRoot(cleanupDir)) {
    return cleanupDir;
  }
  const entries = await readdir(cleanupDir, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(cleanupDir, entry.name);
    if (await hasImportableRuntimeRoot(candidate)) {
      candidates.push(candidate);
    }
  }
  if (candidates.length !== 1) {
    throw new WorkspaceError("Zip de runtime deve conter uma pasta com pacote .mlops ou app/metadata importável.", 422);
  }
  return candidates[0] as string;
}

async function hasImportableRuntimeRoot(candidate: string): Promise<boolean> {
  if (await pathExists(path.join(candidate, ".mlops", "project.yaml"))) {
    return true;
  }
  const metadataDir = path.join(candidate, "app", "metadata");
  const hasProject = (await pathExists(path.join(metadataDir, "project.json"))) || (await pathExists(path.join(metadataDir, "project.yaml")));
  return hasProject && (await pathExists(path.join(metadataDir, "pipeline.flow.json")));
}

async function collectGeneratedArtifactFiles(artifactRoot: string, currentDir = "", result: Array<{ path: string; sizeBytes: number }> = []) {
  const entries = (await readdir(path.join(artifactRoot, currentDir), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = currentDir ? `${currentDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (![".git", ".pytest_cache", "__pycache__", ".venv", "venv", "node_modules"].includes(entry.name)) {
        await collectGeneratedArtifactFiles(artifactRoot, relativePath, result);
      }
      continue;
    }
    if (!entry.isFile() || entry.name === ".env" || [".pyc", ".pyo", ".db", ".sqlite", ".sqlite3"].includes(path.extname(entry.name))) {
      continue;
    }
    const item = await stat(path.join(artifactRoot, relativePath));
    result.push({ path: relativePath.replaceAll(path.sep, "/"), sizeBytes: item.size });
  }
  return result;
}

function normalizeArtifactRelativePath(filePath: string): string {
  const normalized = filePath.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.includes("\0") || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new WorkspaceError(`Path de arquivo gerado inválido: ${filePath}`, 400);
  }
  return normalized;
}

function normalizeZipEntryPath(entryPath: string): string | null {
  const normalized = entryPath.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/^\.\/+/, "");
  if (!normalized || normalized === "__MACOSX" || normalized.startsWith("__MACOSX/")) {
    return null;
  }
  if (normalized.includes("\0") || path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new WorkspaceError(`Entrada insegura no zip: ${entryPath}`, 422);
  }
  return normalized;
}

function safeResolveArtifactFile(artifactRoot: string, filePath: string): string {
  const root = path.resolve(artifactRoot);
  const resolved = path.resolve(root, filePath);
  const relativePath = path.relative(root, resolved);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new WorkspaceError(`Arquivo fora do artefato gerado: ${filePath}`, 400);
  }
  return resolved;
}

function normalizeCreateProjectInput(body: CreateProjectBody) {
  const name = body.name?.trim() || "Classificação de Tickets";
  const id = normalizeProjectId(body.id?.trim() || slugify(name), "id");
  return {
    id,
    name,
    problemType: body.problemType ?? "multiclass_classification",
    target: body.target?.trim() || "categoria",
    classes: body.classes?.length ? body.classes : ["billing", "technical", "access", "cancellation"],
  };
}

function normalizeProjectId(value: string, fieldName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new WorkspaceError(`${fieldName} deve usar letras, números, _ ou - e começar com letra ou número.`, 422);
  }
  return value;
}

function starterProject(input: ReturnType<typeof normalizeCreateProjectInput>): MLOpsProject {
  return {
    id: input.id,
    name: input.name,
    version: "0.1.0",
    contract: "mlops-flow-v1",
    description: "Projeto inicial gerado pelo MLOps Flow Studio.",
    problem: {
      type: input.problemType,
      target: input.target,
      classes: input.problemType === "regression" ? [] : input.classes,
      classDependencies: [],
    },
    domain: { kind: "generic" },
    execution: { profile: "cpu" },
    metrics: input.problemType === "regression" ? { primary: "rmse", secondary: ["mae", "r2", "latency_p95_ms"] } : { primary: "f1_macro", secondary: ["accuracy", "f1_weighted", "latency_p95_ms"] },
    dataSources: [
      {
        id: "tickets_csv",
        type: "csv",
        label: "CSV de tickets",
        sensitive: true,
        csv: { path: "data/tickets.csv", delimiter: ",", hasHeader: true, encoding: "utf-8" },
        schema: {},
        sensitiveFields: ["email", "documento", "telefone"],
      },
      {
        id: "warehouse_sql",
        type: "sql",
        label: "Consulta SQL de histórico",
        sensitive: false,
        sql: { connectionRef: "env:WAREHOUSE_DATABASE_URL", query: "SELECT * FROM tickets LIMIT 1000", previewLimit: 50 },
        schema: {},
        sensitiveFields: [],
      },
      {
        id: "support_api",
        type: "api",
        label: "API externa de suporte",
        sensitive: false,
        api: {
          method: "GET",
          url: "https://api.example.local/tickets",
          headers: { Authorization: "env:SUPPORT_API_TOKEN" },
          timeoutSeconds: 30,
          mocks: [
            {
              id: "support_api_contract",
              description: "Resposta sintética para preview e treino seguro sem rede externa.",
              request: { method: "GET", path: "/tickets" },
              response: {
                httpStatus: 200,
                body: [
                  { id: 1, text: "classe_a boleto pagamento", classe_final: "classe_a", email: "mock-a@example.com" },
                  { id: 2, text: "classe_b erro login", classe_final: "classe_b", email: "mock-b@example.com" },
                ],
              },
            },
          ],
        },
        schema: {},
        sensitiveFields: [],
      },
    ],
    pipelineRef: "pipeline.flow.json",
    promotionPolicy: {
      id: "default-promotion-policy",
      mode: "manual_approval",
      baseline: "active_model",
      rules: [
        {
          kind: "metric",
          id: "f1_macro_minimo",
          label: "F1 macro mínimo",
          left: { metric: input.problemType === "regression" ? "rmse" : "f1_macro", scope: "candidate", phase: "validation" },
          operator: input.problemType === "regression" ? "lte" : "gte",
          value: input.problemType === "regression" ? 18 : 0.78,
          neutralBand: input.problemType === "regression" ? 0.2 : 0.01,
          severity: "block",
          rationale: "Evita promover modelo com qualidade inferior ao limiar mínimo.",
        },
        {
          kind: "metric",
          id: "latencia_p95",
          label: "Latência p95 aceitável",
          left: { metric: "latency_p95_ms", scope: "runtime", phase: "runtime" },
          operator: "lte",
          value: 750,
          neutralBand: 25,
          severity: "review",
          rationale: "Mantém o modelo novo dentro de limite operacional aceitável.",
        },
      ],
    },
    runtime: {
      apiName: `${input.name} API`,
      routePrefix: "",
      persistence: { primary: "postgres", databaseUrlRef: "env:DATABASE_URL" },
      dashboard: { enabled: true, pages: ["overview", "data", "models", "prediction", "monitoring", "events", "docs"], highlightedMetrics: input.problemType === "regression" ? ["rmse", "mae", "latency_p95_ms"] : ["f1_macro", "accuracy", "latency_p95_ms"] },
      mlflow: { enabled: false, trackingUriRef: "env:MLFLOW_TRACKING_URI", registryEnabled: false },
      capabilities: { mode: "auto", providers: {} },
    },
    modelCard: {
      intendedUse: "Classificar entradas operacionais e expor evidências de versão, métricas e promoção.",
      limitations: ["Projeto inicial usa modelos candidatos configuráveis e precisa de dados reais antes de produção."],
      monitoring: ["prediction_logs", "runtime_metrics", "drift_basic"],
      riskLevel: "medium",
    },
    sensitiveFields: ["email", "documento", "telefone"],
    dependencies: ["scikit-learn>=1.5,<2"],
    owners: [],
  };
}

function starterPipeline(project: MLOpsProject): unknown {
  return {
    id: `${project.id}-pipeline`,
    name: `${project.name} Pipeline`,
    version: project.version,
    contract: "mlops-flow-v1",
    description: "DAG inicial com fonte, pré-processamento, modelos candidatos, operador e decisão determinística.",
    nodes: [
      { id: "input", type: "input", label: "Entrada", position: { x: 0, y: 160 }, inputSchema: {}, outputSchema: {} },
      { id: "source_csv", type: "data_source", label: "CSV", dataSourceId: "tickets_csv", position: { x: 220, y: 80 }, inputSchema: {}, outputSchema: {} },
      { id: "source_sql", type: "data_source", label: "SQL", dataSourceId: "warehouse_sql", position: { x: 220, y: 240 }, inputSchema: {}, outputSchema: {} },
      { id: "prepare_text", type: "preprocess", label: "Preparar texto", position: { x: 460, y: 160 }, inputSchema: {}, outputSchema: {}, config: { lower: true, strip: true } },
      { id: "bert_embeddings", type: "embedding", label: "Embeddings/BERT opcional", framework: "sentence-transformers", position: { x: 700, y: 80 }, inputSchema: {}, outputSchema: {}, dependencies: ["sentence-transformers>=3,<4"], config: { enabled: false, model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" } },
      { id: "xgboost_candidate", type: "model", label: "XGBoost candidato", algorithm: "xgboost", framework: "xgboost", modelRole: "candidate", task: project.problem.type, position: { x: 940, y: 80 }, inputSchema: {}, outputSchema: {}, dependencies: ["xgboost>=2,<3"] },
      { id: "baseline_candidate", type: "model", label: "Baseline candidato", algorithm: "logistic_regression", framework: "scikit-learn", modelRole: "active", task: project.problem.type, position: { x: 940, y: 240 }, inputSchema: {}, outputSchema: {} },
      { id: "merge_predictions", type: "operator", label: "Operador de saídas", position: { x: 1180, y: 160 }, inputSchema: {}, outputSchema: {}, config: { strategy: "best_metric_then_confidence" } },
      {
        id: "deterministic_decider",
        type: "python_function",
        label: "Decisor determinístico",
        position: { x: 1420, y: 160 },
        inputSchema: {},
        outputSchema: {},
        python: {
          codeInline: "def run(input: dict, context: dict) -> dict:\n    score = input.get('confidence', 0)\n    if score < 0.55:\n        return {'decision': 'manual_review', 'reason': 'score_baixo'}\n    return {'decision': 'approve_prediction', 'reason': 'score_suficiente'}\n",
          entrypoint: "run",
          inputSchema: {},
          outputSchema: {},
          dependencies: [],
          networkPolicy: "none",
          allowedHosts: [],
          mocks: [],
        },
      },
      { id: "output", type: "output", label: "Saída", position: { x: 1660, y: 160 }, inputSchema: {}, outputSchema: {} },
    ],
    edges: [
      { from: "input", to: "source_csv", mapping: {} },
      { from: "input", to: "source_sql", mapping: {} },
      { from: "source_csv", to: "prepare_text", mapping: {} },
      { from: "source_sql", to: "prepare_text", mapping: {} },
      { from: "prepare_text", to: "bert_embeddings", mapping: {} },
      { from: "bert_embeddings", to: "xgboost_candidate", mapping: {} },
      { from: "prepare_text", to: "baseline_candidate", mapping: {} },
      { from: "xgboost_candidate", to: "merge_predictions", mapping: {} },
      { from: "baseline_candidate", to: "merge_predictions", mapping: {} },
      { from: "merge_predictions", to: "deterministic_decider", mapping: {} },
      { from: "deterministic_decider", to: "output", mapping: {} },
    ],
    subgraphs: [],
    visual: {},
  };
}

function requiredQueryString(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceError(`${name} é obrigatório.`, 400);
  }
  return value;
}

function optionalQueryInteger(value: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || !value.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new WorkspaceError(`${name} deve ser inteiro entre ${min} e ${max}.`, 400);
  }
  return parsed;
}

function requiredBodyString(value: string | undefined, name: string): string {
  const trimmed = optionalBodyString(value, name);
  if (!trimmed) {
    throw new WorkspaceError(`${name} é obrigatório.`, 400);
  }
  return trimmed;
}

function optionalBodyString(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new WorkspaceError(`${name} deve ser string quando informado.`, 400);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalBodyBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new WorkspaceError(`${name} deve ser boolean quando informado.`, 400);
  }
  return value;
}

function optionalBodyTimeoutMs(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw new WorkspaceError(`${name} deve ser inteiro entre 1000 e 120000 quando informado.`, 400);
  }
  return value;
}

function optionalWorkerLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new WorkspaceError("limit deve ser inteiro entre 1 e 200.", 400);
  }
  return value;
}

function optionalTrainingMaxRows(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 2 || value > 200_000) {
    throw new WorkspaceError("maxRows deve ser inteiro entre 2 e 200000.", 400);
  }
  return value;
}

function optionalFeedbackRowsLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new WorkspaceError("feedbackRowsLimit deve ser inteiro entre 1 e 10000.", 400);
  }
  return value;
}

function optionalFeedbackRowsMinimum(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new WorkspaceError("minFeedbackRows deve ser inteiro entre 1 e 1000.", 400);
  }
  return value;
}

function optionalNeutralBand(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new WorkspaceError("neutralBand deve ser número finito maior ou igual a 0.", 400);
  }
  return value;
}

function optionalWindowGranularity(value: BacktestModelsBody["windowGranularity"] | undefined): BacktestModelsBody["windowGranularity"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!["none", "day", "week", "month", "rolling_7d", "rolling_30d"].includes(value)) {
    throw new WorkspaceError("windowGranularity deve ser none, day, week, month, rolling_7d ou rolling_30d.", 400);
  }
  return value;
}

function optionalDatasetSnapshotMode(value: TrainBaselineBody["datasetSnapshotMode"] | undefined): TrainBaselineBody["datasetSnapshotMode"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!["manifest", "masked_rows", "full_rows", "none", "masked", "full"].includes(value)) {
    throw new WorkspaceError("datasetSnapshotMode deve ser manifest, masked_rows ou full_rows.", 400);
  }
  return value;
}

function optionalDatasetSnapshotRetentionDays(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new WorkspaceError("datasetSnapshotRetentionDays deve ser inteiro entre 1 e 3650.", 400);
  }
  return value;
}

function optionalSourcePreviewMode(value: SourcePreviewBody["mode"] | undefined): SourcePreviewBody["mode"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!["safe", "mock", "real"].includes(value)) {
    throw new WorkspaceError("mode deve ser safe, mock ou real.", 400);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function serializeErrorDetails(details: unknown): unknown {
  if (details instanceof Error) {
    return details.message;
  }
  return details;
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "mlops-project";
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3334);
  const host = process.env.HOST ?? "127.0.0.1";
  const app = buildApp({ logger: true });
  await app.listen({ port, host });
}
