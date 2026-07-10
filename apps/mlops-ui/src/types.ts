import type { PipelineNodeType } from "@mlops-flow-studio/mlops-spec";

export type ProblemType = "binary_classification" | "multiclass_classification" | "regression";
export type BacktestWindowGranularity = "none" | "day" | "week" | "month" | "rolling_7d" | "rolling_30d";
export type NodeType = PipelineNodeType;

export interface ProjectSummary {
  id: string;
  name: string | null;
  version: string | null;
  problemType: ProblemType | null;
  path: string;
  valid: boolean;
  error?: string;
}

export interface DataSource {
  id: string;
  type: "csv" | "sql" | "api";
  label: string;
  description?: string;
  sensitive?: boolean;
  sensitiveFields?: string[];
  schema?: Record<string, unknown>;
  csv?: Record<string, unknown>;
  sql?: Record<string, unknown>;
  api?: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url?: string;
    headers?: Record<string, string>;
    bodyTemplate?: Record<string, unknown>;
    pagination?: Record<string, unknown>;
    timeoutSeconds?: number;
    mocks?: unknown[];
  };
}

export interface MLOpsProject {
  id: string;
  name: string;
  version: string;
  contract: string;
  problem: {
    type: ProblemType;
    target: string;
    classes: string[];
  };
  metrics: {
    primary: string;
    secondary: string[];
  };
  dataSources: DataSource[];
  pipelineRef: string;
  promotionPolicy: {
    id: string;
    mode: string;
    baseline: string;
    rules: unknown[];
  };
  runtime: {
    apiName: string;
    persistence: { primary: string; databaseUrlRef: string };
    dashboard: { enabled: boolean; pages: string[]; highlightedMetrics: string[] };
    mlflow: { enabled: boolean; trackingUriRef: string; registryEnabled: boolean };
  };
  execution: {
    profile: "cpu" | "gpu_cuda" | "auto";
  };
  sensitiveFields: string[];
  dependencies: string[];
}

export interface PipelineNode {
  id: string;
  type: NodeType;
  label?: string;
  description?: string;
  dataSourceId?: string;
  algorithm?: string;
  framework?: string;
  modelRole?: "candidate" | "baseline" | "active" | "shadow";
  task?: ProblemType;
  config?: Record<string, unknown>;
  dependencies?: string[];
  position?: { x: number; y: number };
  python?: {
    codeInline?: string;
    codePath?: string;
    entrypoint: string;
    dependencies: string[];
    networkPolicy: "none" | "allowlist" | "open";
    isolationMode?: "process" | "container";
    allowedHosts: string[];
    mocks: unknown[];
  };
}

export interface PipelineEdge {
  from: string;
  to: string;
  condition?: string;
  mapping: Record<string, string>;
}

export interface PipelineFlow {
  id: string;
  name: string;
  version: string;
  contract: string;
  description?: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  subgraphs: PipelineFlow[];
  visual: Record<string, unknown>;
}

export interface LoadedProject {
  project: MLOpsProject;
  pipeline: PipelineFlow;
  projectPath: string;
  pipelinePath: string;
}

export interface ImportedRuntimeProject extends LoadedProject {
  status: "ok";
  sourceDir: string | null;
  sourceZip?: string | null;
  sourceGitUrl?: string | null;
  sourceGitRef?: string | null;
  sourceDockerImage?: string | null;
  sourceDockerPort?: number | null;
  sourceRemoteUrl?: string | null;
  sourceScrapeReport?: string | null;
  importSource?: "mlops_package" | "app_metadata" | "git_static_black_box" | "remote_black_box" | "docker_image_black_box" | "playwright_scrape_black_box";
  remoteInspection?: RemoteRuntimeInspection;
  dockerImageInspect?: unknown;
  reimportPackagePath: string;
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
  nodeId?: string;
  edgeIndex?: number;
}

export interface ValidationResult {
  status: "ok" | "error";
  projectId: string;
  diagnostics: Diagnostic[];
  summary: {
    nodes: number;
    edges: number;
    dataSources: number;
    modelNodes: number;
    pythonNodes: number;
    errors: number;
    warnings: number;
    infos: number;
  };
}

export interface GeneratedArtifactListing {
  outDir: string;
  files: Array<{ path: string; sizeBytes: number }>;
  totalSizeBytes: number;
}

export interface GeneratedArtifactFileContent {
  outDir: string;
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

export interface GeneratedArtifactZip {
  status: "ok";
  outDir: string;
  zipPath: string;
  fileCount: number;
  sizeBytes: number;
}

export interface ArtifactManifestValidationResult {
  status: "ok" | "error";
  outDir: string;
  packagePath: string;
  summary: {
    requiredFiles: number;
    missingRequiredFiles: string[];
    files: number;
    totalSizeBytes: number;
    errors: number;
    warnings: number;
    infos: number;
  };
  diagnostics: Diagnostic[];
  manifest: {
    id: string;
    projectId: string;
    activeModelId: string;
    endpoints: string[];
  } | null;
  generatedMeta: {
    projectId?: unknown;
    projectVersion?: unknown;
    latestTrainingRunId?: unknown;
  } | null;
  mlopsDir: string;
}

export interface SourcePreviewResult {
  status: "ok" | "missing" | "contract" | "error";
  kind: "source_preview";
  sourceId: string;
  sourceType: string;
  mode?: string;
  rowCount?: number;
  columns?: string[];
  sensitiveFields?: string[];
  sample?: Array<Record<string, unknown>>;
  httpStatus?: number;
  responseKind?: string;
  message?: string;
}

export interface PythonRunResult {
  status: "ok" | "error";
  kind: "python_block_result";
  projectId: string;
  nodeId: string;
  entrypoint: string;
  networkPolicy: string;
  isolation?: "process" | "container" | "in_process" | string;
  inputPreview: Record<string, unknown>;
  output: Record<string, unknown>;
  stdout: string[];
  stderr: string[];
  networkCalls?: Array<Record<string, unknown>>;
  durationMs: number;
}

export interface GpuEnvironmentStatus {
  status: "ok";
  checkedAt: string;
  recommendation: "gpu_cuda_ready" | "gpu_driver_ready_python_cpu_fallback" | "cpu_only" | string;
  fallback: "gpu_cuda" | "cpu" | string;
  summary: {
    gpuDetected: boolean;
    dockerNvidiaRuntime: boolean;
    torchCudaAvailable: boolean;
    canUseGpuProfile: boolean;
  };
  nvidiaSmi: {
    available: boolean;
    reason?: string;
    gpus?: Array<{
      name?: string;
      driverVersion?: string;
      cudaVersion?: string | null;
      memoryTotalMiB?: number;
      memoryUsedMiB?: number;
      memoryFreeMiB?: number;
      utilizationGpuPercent?: number;
    }>;
  };
  docker: {
    available: boolean;
    version?: string;
    nvidiaRuntime?: boolean;
    runtimes?: string[];
    reason?: string;
    error?: string;
  };
  python: {
    available: boolean;
    python?: string;
    pythonVersion?: string;
    torchInstalled?: boolean;
    torchVersion?: string;
    torchCudaVersion?: string | null;
    cudaAvailable?: boolean;
    deviceCount?: number;
    devices?: Array<{ index: number; name?: string; memoryTotalMiB?: number }>;
    reason?: string;
  };
}

export interface EmbeddingEnvironmentStatus {
  status: "ok";
  python: string;
  pythonVersion: string | null;
  checkedAt: string;
  model: string;
  deviceRequested?: string | null;
  localFilesOnly: boolean;
  recommendation: "package_missing" | "embedding_smoke_passed" | "model_unavailable_or_failed" | "package_ready_gpu_cuda" | "package_ready_cpu" | string;
  packages: {
    sentenceTransformers: WorkerDependencyPackage;
    transformers: WorkerDependencyPackage;
    torch: WorkerDependencyPackage;
    scikitLearn: WorkerDependencyPackage;
  };
  torch: {
    installed: boolean;
    torchVersion?: string | null;
    torchCudaVersion?: string | null;
    cudaAvailable: boolean;
    deviceCount: number;
    devices: Array<{ index: number; name?: string; memoryTotalMiB?: number }>;
    error?: string;
  };
  smoke: {
    attempted: boolean;
    ok: boolean;
    sampleCount: number;
    dimensions?: number;
    shape?: number[];
    deviceUsed?: string | null;
    durationMs?: number;
    message?: string;
  };
}

export interface PromotionEvidence {
  ruleId: string;
  label?: string;
  metric?: string;
  value?: unknown;
  operator?: string;
  expected?: unknown;
  status: "pass" | "fail" | "neutral";
  color: "green" | "red" | "neutral";
  severity?: string;
  reason: string;
}

export interface TemporalWindowSummary {
  timeColumn?: string;
  start?: string | null;
  end?: string | null;
  totalRows?: number;
  matchedRows?: number;
  excludedRows?: number;
  invalidRows?: number;
}

export interface DatasetRowArtifact {
  available: boolean;
  mode: "manifest" | "masked_rows" | "full_rows" | string;
  format: "jsonl" | string;
  path?: string;
  rowCount?: number;
  digest?: string;
  sensitiveFieldsRetained?: boolean;
  reason?: string;
  retention?: {
    policy?: "manual" | "delete_after_days" | string;
    days?: number;
    expiresAt?: string;
  };
  purgedAt?: string;
  purgedPath?: string;
}

export interface TrainingArtifact {
  kind: string;
  path: string;
  modelId?: string;
  datasetVersionId?: string;
  rowCount?: number;
  schemaHash?: string;
  rowDigest?: string;
  sourceMode?: string;
  rowArtifact?: DatasetRowArtifact;
}

export interface TrainingResult {
  status: "ok" | "error";
  kind: "training_result";
  runId: string;
  projectId: string;
  sourceId: string;
  sourceType?: string;
  sourceMode?: string;
  problemType: ProblemType;
  rowCount: number;
  target: string;
  primaryMetric: string;
  bestModelId: string;
  trainingMode?: "full" | "incremental" | string;
  baseRunId?: string;
  incremental?: {
    requested?: boolean;
    baseRunId?: string;
    updateRows?: number;
    appliedModels?: Array<Record<string, unknown>>;
    fallbackModels?: Array<Record<string, unknown>>;
  };
  leaderboard: Array<{
    modelId: string;
    label: string;
    algorithm: string;
    role: string;
    trainingBackend?: string;
    trainedAlgorithm?: string;
    metrics: Record<string, unknown>;
    trainingRows: number;
    validationRows: number;
    artifactUri: string;
    incremental?: Record<string, unknown>;
  }>;
  promotionEvidence: PromotionEvidence[];
  artifacts: TrainingArtifact[];
  datasetVersion?: TrainingArtifact;
  mlflow?: {
    enabled: boolean;
    status: "disabled" | "unavailable" | "logged" | "error";
    reason?: string;
    trackingUri?: string;
    experimentName?: string;
    runId?: string;
    runName?: string;
    artifactUri?: string;
    message?: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface TrainingRunList {
  projectId: string;
  runs: TrainingResult[];
  latestRun: TrainingResult | null;
}

export interface EvaluationResult {
  status: "ok" | "error";
  kind: "evaluation_result" | "backtest_result";
  evaluationId: string;
  backtestId?: string;
  projectId: string;
  runId: string | null;
  modelId: string | null;
  sourceId: string;
  sourceType?: string;
  sourceMode?: string;
  problemType: ProblemType;
  rowCount: number;
  target: string;
  primaryMetric: string;
  metrics: Record<string, unknown>;
  artifactUri: string | null;
  metricSnapshot: Record<string, unknown> | null;
  sample: Array<{ actual?: unknown; prediction?: unknown; input?: Record<string, unknown> }>;
  baselineModelId?: string;
  candidateModelIds?: string[];
  recommendedModelId?: string;
  recommendation?: "promote" | "reject" | "review" | string;
  neutralBand?: number;
  direction?: string;
  temporalWindow?: TemporalWindowSummary;
  windowGranularity?: BacktestWindowGranularity | string;
  windowResults?: Array<{
    id: string;
    label?: string;
    start?: string;
    end?: string;
    timeColumn?: string;
    granularity?: BacktestWindowGranularity | string;
    rowCount: number;
    modelMetrics: Record<string, Record<string, unknown>>;
    metrics: Record<string, unknown>;
    baselineModelId?: string;
    recommendedModelId?: string;
    recommendation?: string;
    evidence?: PromotionEvidence[];
  }>;
  periodComparison?: {
    currentWindow?: TemporalWindowSummary;
    comparisonWindow?: TemporalWindowSummary;
    rowCount: number;
    modelMetrics: Record<string, Record<string, unknown>>;
    metrics: Record<string, unknown>;
    baselineModelId?: string;
    recommendedModelId?: string;
    deltas?: Array<{
      modelId: string;
      metric?: string | null;
      currentValue?: number | null;
      comparisonValue?: number | null;
      rawDelta?: number | null;
      delta?: number | null;
      direction?: string;
      status?: "pass" | "fail" | "neutral" | string;
      color?: "green" | "red" | "neutral" | string;
      reason?: string;
    }>;
    evidence?: PromotionEvidence[];
  };
  modelMetrics?: Record<string, Record<string, unknown>>;
  modelArtifacts?: Record<string, string>;
  evidence?: PromotionEvidence[];
  createdAt?: string;
  updatedAt?: string;
}

export interface BacktestWindowInput {
  timeColumn?: string;
  windowStart?: string;
  windowEnd?: string;
  comparisonWindowStart?: string;
  comparisonWindowEnd?: string;
  windowGranularity?: BacktestWindowGranularity;
}

export interface EvaluationRunList {
  projectId: string;
  runs: EvaluationResult[];
  latestRun: EvaluationResult | null;
}

export interface WorkerJob {
  jobId: string;
  command: "run-python-block" | "preview-source" | "train-baseline" | "evaluate-model" | "backtest-models";
  projectId: string;
  projectRoot: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "recoverable";
  sourceId?: string;
  nodeId?: string;
  mode?: string;
  label?: string;
  queuedAt?: string;
  runnerStartedAt?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  events: WorkerJobEvent[];
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
  timeoutMs?: number;
  recoveryAttempts?: number;
  recoveredAt?: string;
}

export interface WorkerJobEvent {
  kind: "worker_event";
  timestamp?: string;
  level?: "info" | "warning" | "error" | string;
  type?: string;
  message?: string;
  [key: string]: unknown;
}

export interface WorkerJobList {
  jobs: WorkerJob[];
}

export interface WorkerJobQueueStatus {
  status: "ok";
  backend: "local" | "filesystem";
  storeRoot?: string;
  workerId: string;
  claimTtlMs?: number;
  concurrency: number;
  running: number;
  queued: number;
  recoverable: number;
  completed: number;
  failed: number;
  cancelled: number;
  availableSlots: number;
  total: number;
}

export interface DatasetSnapshotStatus {
  status: "ok";
  projectId: string;
  local: {
    manifestCount: number;
    rowArtifactCount: number;
    availableRows: number;
    missingRows: number;
    purgedRows: number;
    archivedRows: number;
    expiredRows: number;
    expiringSoonRows: number;
    maskedRows: number;
    fullRows: number;
    manifestOnlyRows: number;
    totalRows: number;
    skipped: number;
  };
  store: {
    configured: boolean;
    storeType?: "filesystem" | "s3";
    storeRoot?: string;
    storeUri?: string;
    bucket?: string;
    prefix?: string;
    endpoint?: string;
    region?: string;
    forcePathStyle?: boolean;
  };
  encryption: {
    enabled: boolean;
    keyRef?: string;
    keyFingerprint?: string;
  };
  remote: {
    configured: boolean;
    archiveMetadataCount: number | null;
    metadataPaths: string[];
    error?: string;
  };
  artifacts: Array<{
    datasetVersionId: string;
    sourceId?: string;
    mode?: string;
    rowCount?: number;
    available: boolean;
    localPath?: string;
    purgedPath?: string;
    expiresAt?: string;
    archived: boolean;
    archiveType?: string;
    storePath?: string;
    encrypted?: boolean;
  }>;
}

export interface DatasetSnapshotActionResult {
  status: "ok";
  projectId: string;
  storeType?: "filesystem" | "s3";
  storeRoot?: string;
  storeUri?: string;
  archived?: number;
  restored?: number;
  purged?: number;
  skipped: number;
  missing: number;
  errors?: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
}

export interface PromotionStatus {
  status: "ok" | "empty";
  projectId: string;
  mode: string;
  recommendation: "approve" | "reject" | "review" | "needs_training";
  applied: boolean;
  activeModelId?: string;
  candidateModelId?: string | null;
  latestRunId?: string | null;
  primaryMetric?: string;
  leaderboard?: TrainingResult["leaderboard"];
  evidence: PromotionEvidence[];
  message?: string;
}

export interface PromotionApplyResult {
  status: "ok";
  kind: "promotion_decision";
  decisionId: string;
  projectId: string;
  runId: string | null;
  recommendation: "approve" | "reject" | "review" | "needs_training";
  applied: boolean;
  previousActiveModelId: string;
  activeModelId: string;
  candidateModelId: string;
  primaryMetric: string;
  evidence: PromotionEvidence[];
  mlflowSync: {
    status: "synced" | "failed" | "skipped" | string;
    reason?: string;
    [key: string]: unknown;
  };
  appliedAt: string;
  decisionPath: string;
  pipeline: PipelineFlow;
  promotionStatus: PromotionStatus;
  job?: WorkerJob;
}

export interface WorkerDependencyPackage {
  name: string;
  importName: string;
  installed: boolean;
  version: string | null;
  requirement: string | null;
}

export interface WorkerDependencyStatus {
  status: "ok";
  python: string;
  pythonVersion: string | null;
  requirementsPath: string;
  packages: WorkerDependencyPackage[];
  ready: boolean;
}

export interface WorkerDependencyInstallResult {
  status: "ok";
  command: string;
  stdout: string;
  stderr: string;
  dependencies: WorkerDependencyStatus;
}

export interface MlflowIntegrationStatus {
  status: "ok";
  projectId: string;
  enabled: boolean;
  registryEnabled: boolean;
  trackingUriRef: string | null;
  trackingUri: string | null;
  configured: boolean;
  health: {
    reachable: boolean;
    url?: string;
    statusCode?: number;
    latencyMs?: number;
    message: string;
  };
  localCompose: {
    path: string;
    exists: boolean;
  };
  workerPackage: {
    name: string;
    importName?: string;
    installed: boolean;
    version: string | null;
    requirement?: string | null;
    error?: string;
  };
  latestRun: {
    runId: string | null;
    trainingStatus: unknown;
    bestModelId: unknown;
    mlflowStatus: string;
    mlflowRunId: string | null;
    experimentName: string | null;
    runName: string | null;
    artifactUri: string | null;
    trackingUri: string | null;
    message: string | null;
  } | null;
}

export interface MlflowCatalogSection<T> {
  ok: boolean;
  count: number;
  items: T[];
  error: string | null;
}

export interface MlflowExperimentSummary {
  experimentId: string | null;
  name: string | null;
  lifecycleStage: string | null;
  artifactLocation: string | null;
  creationTime: number | null;
  lastUpdateTime: number | null;
  uiUrl: string | null;
}

export interface MlflowRunSummary {
  runId: string | null;
  runName: string | null;
  experimentId: string | null;
  status: string | null;
  startTime: number | null;
  endTime: number | null;
  artifactUri: string | null;
  metrics: Array<{ key?: string; value?: unknown }>;
  params: Array<{ key?: string; value?: unknown }>;
  tags: Array<{ key?: string; value?: unknown }>;
  uiUrl: string | null;
}

export interface MlflowRegisteredModelSummary {
  name: string | null;
  creationTimestamp: number | null;
  lastUpdatedTimestamp: number | null;
  latestVersions: MlflowModelVersionSummary[];
  uiUrl: string | null;
}

export interface MlflowModelVersionSummary {
  name: string | null;
  version: string | null;
  runId: string | null;
  currentStage: string | null;
  status: string | null;
  source: string | null;
  creationTimestamp: number | null;
  lastUpdatedTimestamp: number | null;
  uiUrl: string | null;
}

export interface MlflowCatalog {
  status: "ok";
  projectId: string;
  trackingUri: string | null;
  configured: boolean;
  experiments: MlflowCatalogSection<MlflowExperimentSummary>;
  runs: MlflowCatalogSection<MlflowRunSummary>;
  registeredModels: MlflowCatalogSection<MlflowRegisteredModelSummary>;
  modelVersions: MlflowCatalogSection<MlflowModelVersionSummary>;
}

export interface MlflowRegistryActionResult {
  status: "ok";
  action: "set_alias" | "delete_alias" | "transition_stage";
  projectId: string;
  trackingUri: string;
  request: Record<string, unknown>;
  mlflow: Record<string, unknown>;
}

export interface DockerRuntimeStatus {
  status: "ok";
  outDir: string;
  exists: boolean;
  dockerfileExists: boolean;
  composeExists: boolean;
  canManage: boolean;
  docker: {
    available: boolean;
    version: string | null;
    stderr?: string;
  };
  composePs: {
    ok: boolean;
    stdout: string;
    stderr: string;
  } | null;
}

export interface DockerRuntimeHistoryEntry {
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

export interface DockerRuntimeHistory {
  status: "ok";
  outDir: string;
  history: DockerRuntimeHistoryEntry[];
}

export interface DockerRuntimeLogs {
  status: "ok";
  action: "logs";
  outDir: string;
  tail: number;
  command: string;
  stdout: string;
  stderr: string;
  historyEntry: DockerRuntimeHistoryEntry;
  history: DockerRuntimeHistoryEntry[];
}

export interface DockerRuntimeInspect {
  status: "ok";
  outDir: string;
  exists: boolean;
  docker: {
    available: boolean;
    version: string | null;
    stderr?: string;
  };
  summary: {
    filesOk: boolean;
    dockerAvailable: boolean;
    composeConfigOk: boolean | null;
    composeImagesOk: boolean | null;
  };
  composeFile: {
    exists: boolean;
    sizeBytes?: number;
    content: string;
  };
  dockerfile: {
    exists: boolean;
    sizeBytes?: number;
    content: string;
  };
  composeConfig: {
    ok: boolean;
    command: string;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  } | null;
  composeImages: {
    ok: boolean;
    command: string;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    items: unknown[];
  } | null;
  historyEntry: DockerRuntimeHistoryEntry;
  history: DockerRuntimeHistoryEntry[];
}

export interface DockerRuntimeActionResult {
  status: "ok";
  action: "build" | "up" | "down";
  outDir: string;
  command: string;
  stdout: string;
  stderr: string;
  historyEntry?: DockerRuntimeHistoryEntry;
  history?: DockerRuntimeHistoryEntry[];
  docker: DockerRuntimeStatus;
}

export interface RuntimeSmokeResult {
  status: "ok" | "error";
  baseUrl?: string;
  url: string;
  statusCode: number | null;
  latencyMs: number;
  summary?: {
    total: number;
    passed: number;
    failed: number;
    predictionLogged: boolean;
    feedbackLogged?: boolean;
    retrainingRequested?: boolean;
    retrainingCompleted?: boolean;
    deploymentObserved?: boolean;
    deploymentRolledBack?: boolean;
  };
  checks?: Array<{
    name: string;
    status: "ok" | "error";
    method: "GET" | "POST";
    url: string;
    statusCode: number | null;
    latencyMs: number;
    body?: unknown;
    message?: string;
  }>;
  body?: unknown;
  message?: string;
}

export interface RemoteRuntimeInspection {
  status: "ok" | "warning" | "error";
  mode: "white_box" | "partial_contract" | "black_box_observable" | "unreachable";
  baseUrl: string;
  latencyMs: number;
  readOnly: boolean;
  summary: {
    total: number;
    ok: number;
    missing: number;
    errors: number;
    contractEndpointsOk: number;
    contractEndpointsTotal: number;
  };
  identity: {
    contract: string | null;
    projectId: string | null;
    projectName: string | null;
    activeModelId: string | null;
    persistence: unknown;
    executionProfile: string | null;
    generatedBy: string | null;
  };
  recommendations: string[];
  checks: Array<{
    name: string;
    status: "ok" | "missing" | "error";
    method: "GET";
    path: string;
    url: string;
    statusCode: number | null;
    latencyMs: number;
    contractEndpoint: boolean;
    body?: unknown;
    message?: string;
  }>;
}

export interface PlaywrightScrapeResult {
  status: "ok";
  kind: "playwright_scrape";
  url: string;
  finalUrl: string;
  statusCode: number | null;
  scrapedAt: string;
  timeoutMs: number;
  maxLinks: number;
  maxDepth: number;
  maxPages: number;
  deepCrawlConfirmed: boolean;
  auth: PlaywrightScrapeAuthReport | null;
  crawledPageCount: number;
  reportPath: string;
  screenshotPath: string | null;
  title: string;
  description: string;
  canonical: string;
  headings: Array<{ level: string; text: string; sourceUrl?: string }>;
  links: Array<{ text: string; href: string; sourceUrl?: string }>;
  forms: Array<{
    method: string;
    action: string;
    sourceUrl?: string;
    inputs: Array<{ tag: string; name: string; type: string; placeholder: string; required: boolean }>;
  }>;
  apiCandidates: Array<{ text: string; href: string; sourceUrl?: string }>;
  crawledPages: Array<{
    url: string;
    finalUrl: string;
    statusCode: number | null;
    depth: number;
    title: string;
    description: string;
    canonical: string;
    headings: Array<{ level: string; text: string }>;
    links: Array<{ text: string; href: string }>;
    forms: Array<{
      method: string;
      action: string;
      inputs: Array<{ tag: string; name: string; type: string; placeholder: string; required: boolean }>;
    }>;
    apiCandidates: Array<{ text: string; href: string }>;
  }>;
}

export interface PlaywrightScrapeAuthOptions {
  loginUrl?: string;
  username?: string;
  usernameRef?: string;
  passwordRef: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successSelector?: string;
  waitAfterSubmitMs?: number;
}

export interface PlaywrightScrapeAuthReport {
  mode: "form";
  loginUrl: string;
  loginStatusCode: number | null;
  finalLoginUrl: string;
  targetOrigin: string;
  usernameSource: string | null;
  passwordRef: string;
  usernameSelector: string | null;
  passwordSelector: string;
  submitSelector: string | null;
  successSelector: string | null;
  authenticatedAt: string;
}

export interface PlaywrightScrapeImportSourceEdit {
  id: string;
  include?: boolean;
  label?: string;
  description?: string;
  method?: string;
  url?: string;
  timeoutSeconds?: number;
  bodyTemplate?: unknown;
}

export interface PlaywrightScrapeImportContractEdits {
  sources: PlaywrightScrapeImportSourceEdit[];
}

export interface PlaywrightScrapeImportPreview {
  status: "ok";
  kind: "playwright_scrape_import_preview";
  sourceScrapeReport: string;
  targetProjectId: string;
  baseUrl: string;
  project: MLOpsProject;
  pipeline: PipelineFlow;
  endpoints: string[];
  summary: {
    dataSources: number;
    nodes: number;
    edges: number;
    apiCandidates: number;
    forms: number;
    links: number;
    sourceEdits: number;
  };
  contractEdits: PlaywrightScrapeImportContractEdits | null;
  limitations: string[];
}

export interface OpenApiOperationResponsePreview {
  status: string;
  description: string | null;
  contentTypes: string[];
  schema: string | null;
  example: unknown;
  validation: OpenApiSchemaValidationDescriptor | null;
}

export interface OpenApiSchemaValidationDescriptor {
  type: string | null;
  required: string[];
  properties: Record<string, OpenApiSchemaValidationDescriptor>;
  items: OpenApiSchemaValidationDescriptor | null;
  enumValues: unknown[];
  nullable: boolean;
}

export interface OpenApiSchemaValidationResult {
  checked: boolean;
  ok: boolean;
  issues: string[];
}

export interface OpenApiOperationPreview {
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
  responses: OpenApiOperationResponsePreview[];
}

export interface OpenApiContractPreview {
  status: "ok";
  kind: "openapi_contract_preview";
  url: string;
  statusCode: number;
  latencyMs: number;
  title: string | null;
  version: string | null;
  endpointCount: number;
  endpoints: string[];
  operationCount: number;
  operations: OpenApiOperationPreview[];
  warnings: string[];
}

export interface OpenApiOperationSmokeResult {
  status: "ok";
  kind: "openapi_operation_smoke";
  url: string;
  method: string;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  requestBodySent: boolean;
  requestValidation: OpenApiSchemaValidationResult;
  responseContentType: string | null;
  responseValidation: OpenApiSchemaValidationResult;
  responsePreview: unknown;
}
