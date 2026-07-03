import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type OnConnect,
  type OnEdgesDelete,
  type OnNodeDrag,
  type OnNodesDelete,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertCircle,
  BarChart3,
  Boxes,
  CheckCircle2,
  CircleDot,
  Code2,
  Database,
  DownloadCloud,
  FileCode2,
  FileText,
  GitBranch,
  Gauge,
  History,
  Layers,
  Moon,
  Network,
  Play,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings,
  Split,
  Sun,
  Table2,
  Terminal,
  Trash2,
  UploadCloud,
} from "lucide-react";
import {
  applyPromotion,
  archiveDatasetSnapshots,
  backtestModels,
  cancelWorkerJob,
  createProject,
  dockerRuntimeAction,
  evaluateModel,
  exportGeneratedArtifactZip,
  generateProject,
  getDockerRuntimeHistory,
  getDockerRuntimeInspect,
  getDockerRuntimeLogs,
  getDockerRuntimeStatus,
  getDatasetSnapshotStatus,
  getEmbeddingEnvironment,
  getGpuEnvironment,
  getMlflowCatalog,
  getMlflowStatus,
  getPromotionStatus,
  getWorkerDependencies,
  getWorkerJobQueueStatus,
  inspectRemoteRuntime,
  importRemoteBlackBoxRuntime,
  importRuntimeProject,
  importRuntimeProjectFromDockerImage,
  importRuntimeProjectFromGit,
  importRuntimeProjectFromScrape,
  importRuntimeProjectFromZip,
  installWorkerDependencies,
  listEvaluationRuns,
  listGeneratedArtifact,
  listProjects,
  listTrainingRuns,
  listWorkerJobs,
  loadProject,
  previewDataSource,
  previewOpenApiContract,
  previewRuntimeProjectFromScrape,
  purgeExpiredDatasetSnapshots,
  readGeneratedArtifactFile,
  recoverWorkerJob,
  restoreDatasetSnapshots,
  promoteRuntimeRetrainingJob,
  runPlaywrightScrape,
  runPythonNode,
  savePipeline,
  saveProject,
  setMlflowRegisteredModelAlias,
  smokeOpenApiOperation,
  smokeRuntime,
  startBacktestModelsJob,
  startEvaluateModelJob,
  startPythonNodeJob,
  startRuntimeRetrainingJob,
  startSourcePreviewJob,
  startTrainBaselineJob,
  trainBaseline,
  transitionMlflowModelVersionStage,
  validateGeneratedManifest,
  validateProject,
} from "./api.ts";
import type {
  ArtifactManifestValidationResult,
  DatasetSnapshotActionResult,
  DatasetSnapshotStatus,
  DataSource,
  Diagnostic,
  DockerRuntimeHistoryEntry,
  DockerRuntimeInspect,
  DockerRuntimeLogs,
  DockerRuntimeStatus,
  EmbeddingEnvironmentStatus,
  EvaluationResult,
  BacktestWindowGranularity,
  BacktestWindowInput,
  GeneratedArtifactFileContent,
  GeneratedArtifactListing,
  GpuEnvironmentStatus,
  LoadedProject,
  MlflowCatalog,
  MlflowIntegrationStatus,
  MLOpsProject,
  NodeType,
  OpenApiContractPreview,
  OpenApiOperationPreview,
  OpenApiOperationSmokeResult,
  PipelineEdge,
  PipelineFlow,
  PlaywrightScrapeAuthOptions,
  PlaywrightScrapeImportContractEdits,
  PipelineNode,
  PlaywrightScrapeImportPreview,
  PlaywrightScrapeResult,
  PromotionStatus,
  PythonRunResult,
  ProjectSummary,
  RemoteRuntimeInspection,
  SourcePreviewResult,
  TrainingResult,
  ValidationResult,
  WorkerDependencyStatus,
  WorkerJob,
  WorkerJobQueueStatus,
  RuntimeSmokeResult,
} from "./types.ts";

type AppTab = "project" | "pipeline" | "studio" | "artifacts" | "runtime" | "settings";
type StatusKind = "idle" | "busy" | "ok" | "error";
type ThemeMode = "light" | "dark";
type MlflowStage = "None" | "Staging" | "Production" | "Archived";
type NodeExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
type PromotionRuleOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "contains" | "not_contains" | "improved_by" | "worse_by" | "delta_gte" | "delta_lte";
type PromotionRuleSeverity = "block" | "review" | "alert";
type PromotionRuleScope = "candidate" | "active" | "baseline" | "runtime" | "dataset" | "custom";
type PromotionRulePhase = "train" | "validation" | "test" | "backtest" | "runtime";

interface PlaywrightScrapeSourceDraft {
  id: string;
  include: boolean;
  label: string;
  description: string;
  method: string;
  url: string;
  timeoutSeconds: string;
  bodyTemplateJson: string;
}

interface PromotionMetricRule {
  kind: "metric";
  id: string;
  label: string;
  left: {
    metric: string;
    scope?: PromotionRuleScope;
    phase?: PromotionRulePhase;
  };
  operator: PromotionRuleOperator;
  value: number | string | boolean | number[];
  compareTo?: {
    metric: string;
    scope?: PromotionRuleScope;
    phase?: PromotionRulePhase;
  };
  neutralBand?: number;
  severity?: PromotionRuleSeverity;
  rationale?: string;
}

interface StatusState {
  kind: StatusKind;
  message: string;
}

interface NodeExecutionState {
  status: NodeExecutionStatus;
  label: string;
  detail?: string;
  source: "job" | "result" | "manual";
  jobId?: string;
  updatedAt?: string;
}

const nodeTypeOptions: Array<{ type: NodeType; label: string; icon: typeof Play }> = [
  { type: "input", label: "Entrada", icon: Play },
  { type: "data_source", label: "Fonte", icon: Database },
  { type: "preprocess", label: "Preparo", icon: Table2 },
  { type: "feature_transform", label: "Features", icon: Layers },
  { type: "embedding", label: "Embedding", icon: Network },
  { type: "model", label: "Modelo", icon: Gauge },
  { type: "python_function", label: "Python", icon: Code2 },
  { type: "operator", label: "Operador", icon: Split },
  { type: "condition", label: "Condição", icon: GitBranch },
  { type: "promotion_rule", label: "Promoção", icon: CheckCircle2 },
  { type: "evaluation", label: "Avaliação", icon: BarChart3 },
  { type: "monitoring", label: "Monitor", icon: Server },
  { type: "composite", label: "Composto", icon: Boxes },
  { type: "output", label: "Saída", icon: CircleDot },
];

const tabs: Array<{ id: AppTab; label: string; icon: typeof Play }> = [
  { id: "project", label: "Projeto", icon: FileText },
  { id: "pipeline", label: "Pipeline", icon: GitBranch },
  { id: "studio", label: "Studio", icon: Play },
  { id: "artifacts", label: "Artefatos", icon: FileCode2 },
  { id: "runtime", label: "Runtime", icon: Server },
  { id: "settings", label: "Settings", icon: Settings },
];

const themeStorageKey = "mlops-flow-studio.theme";

function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }
  const value = window.localStorage.getItem(themeStorageKey);
  if (value === "dark" || value === "light") {
    return value;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [projectDraft, setProjectDraft] = useState<MLOpsProject | null>(null);
  const [pipelineDraft, setPipelineDraft] = useState<PipelineFlow | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [activeTab, setActiveTab] = useState<AppTab>("pipeline");
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [generatedOutDir, setGeneratedOutDir] = useState("");
  const [runtimeZipPath, setRuntimeZipPath] = useState("");
  const [runtimeGitUrl, setRuntimeGitUrl] = useState("");
  const [runtimeGitRef, setRuntimeGitRef] = useState("");
  const [runtimeDockerImage, setRuntimeDockerImage] = useState("");
  const [runtimeDockerPort, setRuntimeDockerPort] = useState("8080");
  const [importTargetProjectId, setImportTargetProjectId] = useState("");
  const [artifactListing, setArtifactListing] = useState<GeneratedArtifactListing | null>(null);
  const [artifactFile, setArtifactFile] = useState<GeneratedArtifactFileContent | null>(null);
  const [manifestValidation, setManifestValidation] = useState<ArtifactManifestValidationResult | null>(null);
  const [sourcePreview, setSourcePreview] = useState<SourcePreviewResult | null>(null);
  const [pythonRunResult, setPythonRunResult] = useState<PythonRunResult | null>(null);
  const [pythonInputDraft, setPythonInputDraft] = useState('{"confidence": 0.52, "prediction": "classe_01"}');
  const [trainingResult, setTrainingResult] = useState<TrainingResult | null>(null);
  const [trainingRuns, setTrainingRuns] = useState<TrainingResult[]>([]);
  const [evaluationResult, setEvaluationResult] = useState<EvaluationResult | null>(null);
  const [evaluationRuns, setEvaluationRuns] = useState<EvaluationResult[]>([]);
  const [backtestTimeColumn, setBacktestTimeColumn] = useState("");
  const [backtestWindowStart, setBacktestWindowStart] = useState("");
  const [backtestWindowEnd, setBacktestWindowEnd] = useState("");
  const [backtestComparisonStart, setBacktestComparisonStart] = useState("");
  const [backtestComparisonEnd, setBacktestComparisonEnd] = useState("");
  const [backtestWindowGranularity, setBacktestWindowGranularity] = useState<BacktestWindowGranularity>("none");
  const [promotionStatus, setPromotionStatus] = useState<PromotionStatus | null>(null);
  const [workerJobs, setWorkerJobs] = useState<WorkerJob[]>([]);
  const [workerQueueStatus, setWorkerQueueStatus] = useState<WorkerJobQueueStatus | null>(null);
  const [datasetSnapshotStatus, setDatasetSnapshotStatus] = useState<DatasetSnapshotStatus | null>(null);
  const [datasetSnapshotActionResult, setDatasetSnapshotActionResult] = useState<DatasetSnapshotActionResult | null>(null);
  const [workerDependencies, setWorkerDependencies] = useState<WorkerDependencyStatus | null>(null);
  const [gpuEnvironment, setGpuEnvironment] = useState<GpuEnvironmentStatus | null>(null);
  const [embeddingEnvironment, setEmbeddingEnvironment] = useState<EmbeddingEnvironmentStatus | null>(null);
  const [embeddingSmokeModel, setEmbeddingSmokeModel] = useState("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2");
  const [embeddingSmokeLocalOnly, setEmbeddingSmokeLocalOnly] = useState(false);
  const [mlflowStatus, setMlflowStatus] = useState<MlflowIntegrationStatus | null>(null);
  const [mlflowCatalog, setMlflowCatalog] = useState<MlflowCatalog | null>(null);
  const [dockerStatus, setDockerStatus] = useState<DockerRuntimeStatus | null>(null);
  const [dockerLogs, setDockerLogs] = useState<DockerRuntimeLogs | null>(null);
  const [dockerInspect, setDockerInspect] = useState<DockerRuntimeInspect | null>(null);
  const [dockerHistory, setDockerHistory] = useState<DockerRuntimeHistoryEntry[]>([]);
  const [runtimeBaseUrl, setRuntimeBaseUrl] = useState("http://127.0.0.1:8080");
  const [runtimeSmokeResult, setRuntimeSmokeResult] = useState<RuntimeSmokeResult | null>(null);
  const [remoteRuntimeUrl, setRemoteRuntimeUrl] = useState("http://127.0.0.1:8080");
  const [remoteRuntimeInspection, setRemoteRuntimeInspection] = useState<RemoteRuntimeInspection | null>(null);
  const [playwrightScrapeUrl, setPlaywrightScrapeUrl] = useState("http://127.0.0.1:8080/docs");
  const [playwrightMaxDepth, setPlaywrightMaxDepth] = useState("1");
  const [playwrightMaxPages, setPlaywrightMaxPages] = useState("5");
  const [playwrightDeepCrawl, setPlaywrightDeepCrawl] = useState(false);
  const [playwrightAuthEnabled, setPlaywrightAuthEnabled] = useState(false);
  const [playwrightAuthLoginUrl, setPlaywrightAuthLoginUrl] = useState("");
  const [playwrightAuthUsername, setPlaywrightAuthUsername] = useState("");
  const [playwrightAuthUsernameSelector, setPlaywrightAuthUsernameSelector] = useState("#username");
  const [playwrightAuthPasswordSelector, setPlaywrightAuthPasswordSelector] = useState("input[type=\"password\"]");
  const [playwrightAuthPasswordRef, setPlaywrightAuthPasswordRef] = useState("env:MLOPS_SCRAPE_PASSWORD");
  const [playwrightAuthSubmitSelector, setPlaywrightAuthSubmitSelector] = useState("button[type=\"submit\"]");
  const [playwrightAuthSuccessSelector, setPlaywrightAuthSuccessSelector] = useState("");
  const [playwrightScrapeResult, setPlaywrightScrapeResult] = useState<PlaywrightScrapeResult | null>(null);
  const [playwrightScrapePreview, setPlaywrightScrapePreview] = useState<PlaywrightScrapeImportPreview | null>(null);
  const [playwrightOpenApiPreview, setPlaywrightOpenApiPreview] = useState<OpenApiContractPreview | null>(null);
  const [playwrightOpenApiSmoke, setPlaywrightOpenApiSmoke] = useState<OpenApiOperationSmokeResult | null>(null);
  const [playwrightScrapeImportSources, setPlaywrightScrapeImportSources] = useState<PlaywrightScrapeSourceDraft[]>([]);
  const [manualNodeExecutions, setManualNodeExecutions] = useState<Record<string, NodeExecutionState>>({});
  const [projectJsonDraft, setProjectJsonDraft] = useState("");
  const [pipelineJsonDraft, setPipelineJsonDraft] = useState("");
  const [status, setStatus] = useState<StatusState>({ kind: "idle", message: "Control API aguardando." });

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  const selectedNode = useMemo(
    () => pipelineDraft?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [pipelineDraft, selectedNodeId],
  );
  const selectedEdge = useMemo(
    () => edgeFromId(pipelineDraft?.edges ?? [], selectedEdgeId),
    [pipelineDraft?.edges, selectedEdgeId],
  );

  const refreshProjects = useCallback(async (silent = false) => {
    if (!silent) {
      setStatus({ kind: "busy", message: "Atualizando projetos." });
    }
    try {
      const result = await listProjects();
      setProjects(result.projects);
      const firstValid = result.projects.find((project) => project.valid);
      setSelectedProjectId((current) => current || firstValid?.id || result.projects[0]?.id || "");
      if (!silent) {
        setStatus({ kind: "ok", message: `${result.projects.length} projeto(s).` });
      }
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }, []);

  const refreshTrainingState = useCallback(async (projectId: string, silent = false) => {
    if (!silent) {
      setStatus({ kind: "busy", message: "Atualizando histórico de treino." });
    }
    try {
      const [runsResult, promotion, evaluations] = await Promise.all([listTrainingRuns(projectId), getPromotionStatus(projectId), listEvaluationRuns(projectId)]);
      setTrainingRuns(runsResult.runs);
      setTrainingResult((current) => current ?? runsResult.latestRun);
      setEvaluationRuns(evaluations.runs);
      setEvaluationResult((current) => current ?? evaluations.latestRun);
      setPromotionStatus(promotion);
      if (!silent) {
        setStatus({ kind: "ok", message: `${runsResult.runs.length} run(s) de treino.` });
      }
    } catch (error) {
      if (!silent) {
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    }
  }, []);

  const refreshWorkerJobs = useCallback(async (silent = true) => {
    if (!silent) {
      setStatus({ kind: "busy", message: "Atualizando jobs do worker." });
    }
    try {
      const [result, queue] = await Promise.all([listWorkerJobs(), getWorkerJobQueueStatus()]);
      setWorkerJobs(result.jobs);
      setWorkerQueueStatus(queue);
      if (!silent) {
        setStatus({ kind: "ok", message: `${result.jobs.length} job(s) do worker.` });
      }
    } catch (error) {
      if (!silent) {
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    }
  }, []);

  const refreshDatasetSnapshots = useCallback(async (projectId: string, silent = false) => {
    if (!silent) {
      setStatus({ kind: "busy", message: "Atualizando snapshots de dataset." });
    }
    try {
      const result = await getDatasetSnapshotStatus(projectId);
      setDatasetSnapshotStatus(result);
      if (!silent) {
        setStatus({ kind: "ok", message: `${result.local.manifestCount} manifesto(s), ${result.local.archivedRows} snapshot(s) arquivado(s).` });
      }
    } catch (error) {
      if (!silent) {
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    }
  }, []);

  const refreshMlflowStatus = useCallback(async (projectId: string, silent = false) => {
    if (!silent) {
      setStatus({ kind: "busy", message: "Checando MLflow." });
    }
    try {
      const [result, catalog] = await Promise.all([getMlflowStatus(projectId), getMlflowCatalog(projectId)]);
      setMlflowStatus(result);
      setMlflowCatalog(catalog);
      if (!silent) {
        setStatus({ kind: result.health.reachable ? "ok" : "idle", message: result.health.reachable ? "MLflow disponível." : result.health.message });
      }
    } catch (error) {
      if (!silent) {
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    }
  }, []);

  const refreshWorkerDependencies = useCallback(async (silent = false) => {
    if (!silent) {
      setStatus({ kind: "busy", message: "Checando ambiente Python." });
    }
    try {
      const result = await getWorkerDependencies();
      setWorkerDependencies(result);
      if (!silent) {
        setStatus({ kind: result.ready ? "ok" : "idle", message: result.ready ? "Dependências opcionais prontas." : "Dependências opcionais ausentes." });
      }
    } catch (error) {
      if (!silent) {
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    }
  }, []);

  const refreshGpuEnvironment = useCallback(async (silent = false) => {
    if (!silent) {
      setStatus({ kind: "busy", message: "Checando GPU/CUDA." });
    }
    try {
      const result = await getGpuEnvironment();
      setGpuEnvironment(result);
      if (!silent) {
        const workerGpuReady = result.fallback === "gpu_cuda";
        const message = workerGpuReady
          ? "GPU/CUDA pronta para o worker."
          : result.summary.gpuDetected
            ? "GPU detectada; worker em CPU até instalar Torch/CUDA."
            : "GPU/CUDA indisponível; fallback em CPU.";
        setStatus({
          kind: workerGpuReady ? "ok" : "idle",
          message,
        });
      }
    } catch (error) {
      if (!silent) {
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    }
  }, []);

  const refreshEmbeddingEnvironment = useCallback(async (
    smoke = false,
    silent = false,
    model = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    localFilesOnly = false,
  ) => {
    if (!silent) {
      setStatus({ kind: "busy", message: smoke ? "Executando smoke de embeddings." : "Checando embeddings/BERT." });
    }
    try {
      const result = await getEmbeddingEnvironment({
        model,
        smoke,
        localFilesOnly,
        timeoutMs: smoke ? 120_000 : 20_000,
      });
      setEmbeddingEnvironment(result);
      if (!silent) {
        const ready = result.recommendation === "embedding_smoke_passed" || result.recommendation === "package_ready_gpu_cuda" || result.recommendation === "package_ready_cpu";
        const message = smoke
          ? result.smoke.ok
            ? `Smoke de embeddings ok: ${result.smoke.dimensions ?? "-"} dimensões.`
            : result.smoke.message ?? "Smoke de embeddings não passou."
          : result.packages.sentenceTransformers.installed
            ? "Pacote sentence-transformers disponível."
            : "Pacote sentence-transformers ausente.";
        setStatus({ kind: ready ? "ok" : "idle", message });
      }
    } catch (error) {
      if (!silent) {
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    }
  }, []);

  const refreshDockerStatus = useCallback(async (outDir: string, silent = false) => {
    if (!outDir) {
      return;
    }
    if (!silent) {
      setStatus({ kind: "busy", message: "Checando Docker do runtime." });
    }
    try {
      const [result, historyResult] = await Promise.all([
        getDockerRuntimeStatus(outDir),
        getDockerRuntimeHistory(outDir),
      ]);
      setDockerStatus(result);
      setDockerHistory(historyResult.history);
      if (!silent) {
        setStatus({ kind: result.canManage ? "ok" : "idle", message: result.canManage ? "Runtime Docker gerenciável." : "Runtime Docker ainda não está pronto." });
      }
    } catch (error) {
      if (!silent) {
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
    void refreshWorkerDependencies(true);
    void refreshGpuEnvironment(true);
    void refreshEmbeddingEnvironment(false, true);
    void refreshWorkerJobs(true);
  }, [refreshEmbeddingEnvironment, refreshGpuEnvironment, refreshProjects, refreshWorkerDependencies, refreshWorkerJobs]);

  useEffect(() => {
    if (!workerJobs.some((job) => job.status === "queued" || job.status === "running")) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshWorkerJobs(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [refreshWorkerJobs, workerJobs]);

  useEffect(() => {
    if (!projectDraft) {
      return;
    }
    const completedPreview = workerJobs
      .filter((job) => job.projectId === projectDraft.id && job.status === "completed" && isSourcePreviewResult(job.result))
      .map((job) => job.result as SourcePreviewResult)
      .find((result) => result.sourceId !== sourcePreview?.sourceId || result.mode !== sourcePreview?.mode);
    if (completedPreview) {
      setSourcePreview(completedPreview);
    }
    const completedPythonRun = workerJobs
      .filter((job) => job.projectId === projectDraft.id && job.status === "completed" && isPythonRunResult(job.result))
      .map((job) => job.result as PythonRunResult)
      .find((result) => result.nodeId !== pythonRunResult?.nodeId || result.durationMs !== pythonRunResult?.durationMs);
    if (completedPythonRun) {
      setPythonRunResult(completedPythonRun);
    }
    const completedTrainingResult = workerJobs
      .filter((job) => job.projectId === projectDraft.id && job.status === "completed" && isTrainingResult(job.result))
      .map((job) => job.result as TrainingResult)
      .find((result) => !trainingRuns.some((run) => run.runId === result.runId));
    if (completedTrainingResult) {
      setTrainingResult(completedTrainingResult);
      setTrainingRuns((current) => [completedTrainingResult, ...current.filter((run) => run.runId !== completedTrainingResult.runId)]);
      void getPromotionStatus(projectDraft.id).then(setPromotionStatus).catch(() => undefined);
      void refreshMlflowStatus(projectDraft.id, true);
    }
    const completedEvaluationResult = workerJobs
      .filter((job) => job.projectId === projectDraft.id && job.status === "completed" && isEvaluationResult(job.result))
      .map((job) => job.result as EvaluationResult)
      .find((result) => !evaluationRuns.some((run) => run.evaluationId === result.evaluationId));
    if (completedEvaluationResult) {
      setEvaluationResult(completedEvaluationResult);
      setEvaluationRuns((current) => [completedEvaluationResult, ...current.filter((run) => run.evaluationId !== completedEvaluationResult.evaluationId)]);
    }
  }, [evaluationRuns, projectDraft, pythonRunResult, refreshMlflowStatus, sourcePreview, trainingRuns, workerJobs]);

  useEffect(() => {
    if (!selectedProjectId) {
      setLoaded(null);
      setProjectDraft(null);
      setPipelineDraft(null);
      setSelectedNodeId("");
      setSelectedEdgeId("");
      setTrainingRuns([]);
      setTrainingResult(null);
      setEvaluationRuns([]);
      setEvaluationResult(null);
      setPromotionStatus(null);
      setDatasetSnapshotStatus(null);
      setDatasetSnapshotActionResult(null);
      setMlflowStatus(null);
      setMlflowCatalog(null);
      setManifestValidation(null);
      setDockerStatus(null);
      setDockerLogs(null);
      setDockerInspect(null);
      setDockerHistory([]);
      setManualNodeExecutions({});
      return;
    }
    let active = true;
    async function run() {
      setStatus({ kind: "busy", message: `Carregando ${selectedProjectId}.` });
      try {
        const result = await loadProject(selectedProjectId);
        if (!active) {
          return;
        }
        setLoaded(result);
        setProjectDraft(result.project);
        setPipelineDraft(result.pipeline);
        setProjectJsonDraft(JSON.stringify(result.project, null, 2));
        setPipelineJsonDraft(JSON.stringify(result.pipeline, null, 2));
        setSelectedNodeId(result.pipeline.nodes[0]?.id ?? "");
        setSelectedEdgeId("");
        setGeneratedOutDir(`generated/${result.project.id}-runtime`);
        setRuntimeZipPath(`generated/${result.project.id}-runtime.zip`);
        setImportTargetProjectId(`${result.project.id}_reimported`);
        setArtifactListing(null);
        setArtifactFile(null);
        setManifestValidation(null);
        setDockerStatus(null);
        setDockerLogs(null);
        setDockerInspect(null);
        setDockerHistory([]);
        setRuntimeSmokeResult(null);
        setSourcePreview(null);
        setPythonRunResult(null);
        setTrainingResult(null);
        setTrainingRuns([]);
        setEvaluationResult(null);
        setEvaluationRuns([]);
        setPromotionStatus(null);
        setDatasetSnapshotStatus(null);
        setDatasetSnapshotActionResult(null);
        setMlflowStatus(null);
        setMlflowCatalog(null);
        setValidation(null);
        setManualNodeExecutions({});
        void refreshTrainingState(result.project.id, true);
        void refreshDatasetSnapshots(result.project.id, true);
        void refreshDockerStatus(`generated/${result.project.id}-runtime`, true);
        void refreshMlflowStatus(result.project.id, true);
        setStatus({ kind: "ok", message: `${result.project.name} carregado.` });
      } catch (error) {
        if (!active) {
          return;
        }
        setLoaded(null);
        setProjectDraft(null);
        setPipelineDraft(null);
        setTrainingRuns([]);
        setTrainingResult(null);
        setEvaluationRuns([]);
        setEvaluationResult(null);
        setPromotionStatus(null);
        setDatasetSnapshotStatus(null);
        setDatasetSnapshotActionResult(null);
        setMlflowStatus(null);
        setMlflowCatalog(null);
        setManualNodeExecutions({});
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    }
    void run();
    return () => {
      active = false;
    };
  }, [refreshDatasetSnapshots, refreshDockerStatus, refreshMlflowStatus, refreshTrainingState, selectedProjectId]);

  const markManualNodeExecution = useCallback((nodeIds: string[], state: Omit<NodeExecutionState, "source" | "updatedAt">) => {
    if (!nodeIds.length) {
      return;
    }
    const updatedAt = new Date().toISOString();
    setManualNodeExecutions((current) => {
      const next = { ...current };
      for (const nodeId of nodeIds) {
        next[nodeId] = { ...state, source: "manual", updatedAt };
      }
      return next;
    });
  }, []);

  const nodeExecutionStates = useMemo(
    () => buildNodeExecutionStates(pipelineDraft, {
      manualNodeExecutions,
      workerJobs: projectDraft ? workerJobs.filter((job) => job.projectId === projectDraft.id) : [],
      sourcePreview,
      pythonRunResult,
      trainingResult,
      evaluationResult,
    }),
    [evaluationResult, manualNodeExecutions, pipelineDraft, projectDraft, pythonRunResult, sourcePreview, trainingResult, workerJobs],
  );

  const flowNodes = useMemo<Node[]>(() => {
    if (!pipelineDraft) {
      return [];
    }
    const diagnosticByNode = new Map<string, Diagnostic[]>();
    for (const diagnostic of validation?.diagnostics ?? []) {
      if (diagnostic.nodeId) {
        diagnosticByNode.set(diagnostic.nodeId, [...(diagnosticByNode.get(diagnostic.nodeId) ?? []), diagnostic]);
      }
    }
    return pipelineDraft.nodes.map((node, index) => {
      const diagnostics = diagnosticByNode.get(node.id) ?? [];
      const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
      const hasWarning = diagnostics.some((diagnostic) => diagnostic.severity === "warning");
      const executionState = nodeExecutionStates.get(node.id);
      const executionClass = executionState ? `node-run-${executionState.status}` : "";
      return {
        id: node.id,
        position: node.position ?? defaultNodePosition(index),
        data: {
          label: <FlowNodeLabel label={node.label || node.id} sublabel={node.type} state={executionState ?? null} />,
          sublabel: node.type,
        },
        selected: node.id === selectedNodeId,
        className: `flow-node ${node.type} ${executionClass} ${hasError ? "node-error" : hasWarning ? "node-warning" : ""}`.trim(),
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
    });
  }, [nodeExecutionStates, pipelineDraft, selectedNodeId, validation]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!pipelineDraft) {
      return [];
    }
    return pipelineDraft.edges.map((edge, index) => {
      const executionClass = edgeExecutionClass(nodeExecutionStates.get(edge.from), nodeExecutionStates.get(edge.to));
      return {
        id: edgeId(edge, index),
        source: edge.from,
        target: edge.to,
        label: edge.condition,
        selected: selectedEdgeId === edgeId(edge, index),
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: executionClass === "edge-running",
        className: [edge.condition ? "conditional-edge" : "", executionClass].filter(Boolean).join(" "),
      };
    });
  }, [nodeExecutionStates, pipelineDraft, selectedEdgeId]);

  const onConnect = useCallback<OnConnect>(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }
      setPipelineDraft((current) => {
        if (!current) {
          return current;
        }
        const exists = current.edges.some((edge) => edge.from === connection.source && edge.to === connection.target);
        if (exists) {
          return current;
        }
        return {
          ...current,
          edges: [...current.edges, { from: connection.source!, to: connection.target!, mapping: {} }],
        };
      });
    },
    [],
  );

  const onNodeClick = useCallback<NodeMouseHandler>((_event, node) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId("");
  }, []);

  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId("");
  }, []);

  const onNodeDragStop = useCallback<OnNodeDrag>((_event, node) => {
    setPipelineDraft((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        nodes: current.nodes.map((item) => (item.id === node.id ? { ...item, position: node.position } : item)),
      };
    });
  }, []);

  const onNodesDelete = useCallback<OnNodesDelete>((nodes) => {
    const ids = new Set(nodes.map((node) => node.id));
    setPipelineDraft((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        nodes: current.nodes.filter((node) => !ids.has(node.id)),
        edges: current.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)),
      };
    });
    setSelectedNodeId("");
  }, []);

  const onEdgesDelete = useCallback<OnEdgesDelete>((edges) => {
    const ids = new Set(edges.map((edge) => edge.id));
    setPipelineDraft((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        edges: current.edges.filter((edge, index) => !ids.has(edgeId(edge, index))),
      };
    });
    setSelectedEdgeId("");
  }, []);

  async function handleCreateProject() {
    setStatus({ kind: "busy", message: "Criando projeto." });
    try {
      const result = await createProject();
      await refreshProjects(true);
      setSelectedProjectId(result.project.id);
      setStatus({ kind: "ok", message: `${result.project.name} criado.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleSave() {
    if (!projectDraft || !pipelineDraft) {
      return;
    }
    setStatus({ kind: "busy", message: "Salvando arquivos." });
    try {
      await saveProject(projectDraft.id, projectDraft);
      await savePipeline(projectDraft.id, pipelineDraft);
      setProjectJsonDraft(JSON.stringify(projectDraft, null, 2));
      setPipelineJsonDraft(JSON.stringify(pipelineDraft, null, 2));
      setStatus({ kind: "ok", message: "Projeto e pipeline salvos." });
      await refreshProjects(true);
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleValidate() {
    if (!projectDraft) {
      return;
    }
    setStatus({ kind: "busy", message: "Validando contratos." });
    try {
      await handleSave();
      const result = await validateProject(projectDraft.id);
      setValidation(result);
      setStatus({
        kind: result.status === "ok" ? "ok" : "error",
        message: `${result.summary.errors} erro(s), ${result.summary.warnings} aviso(s).`,
      });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleGenerate() {
    if (!projectDraft) {
      return;
    }
    setStatus({ kind: "busy", message: "Gerando runtime FastAPI." });
    try {
      await handleSave();
      const result = await generateProject(projectDraft.id, generatedOutDir);
      setGeneratedOutDir(result.outDir);
      setRuntimeZipPath(`${result.outDir}.zip`);
      setDockerLogs(null);
      setDockerInspect(null);
      setManifestValidation(null);
      const listing = await listGeneratedArtifact(result.outDir);
      setArtifactListing(listing);
      await refreshDockerStatus(result.outDir, true);
      setActiveTab("artifacts");
      setStatus({ kind: "ok", message: `Runtime gerado em ${result.outDir}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleRefreshArtifacts() {
    if (!generatedOutDir) {
      return;
    }
    setStatus({ kind: "busy", message: "Atualizando artefatos." });
    try {
      const listing = await listGeneratedArtifact(generatedOutDir);
      setArtifactListing(listing);
      setStatus({ kind: "ok", message: `${listing.files.length} arquivo(s) em ${listing.outDir}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleValidateGeneratedManifest() {
    if (!generatedOutDir) {
      return;
    }
    setStatus({ kind: "busy", message: "Validando manifestos do runtime." });
    try {
      const result = await validateGeneratedManifest(generatedOutDir);
      setManifestValidation(result);
      setStatus({
        kind: result.status === "ok" ? "ok" : "error",
        message: `Manifestos: ${result.summary.errors} erro(s), ${result.summary.warnings} aviso(s).`,
      });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleImportRuntimeProject() {
    if (!generatedOutDir) {
      return;
    }
    setStatus({ kind: "busy", message: "Reimportando pacote .mlops." });
    try {
      const result = await importRuntimeProject(generatedOutDir, importTargetProjectId);
      await refreshProjects(true);
      setSelectedProjectId(result.project.id);
      setActiveTab("pipeline");
      setStatus({ kind: "ok", message: `Runtime reimportado como ${result.project.id}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleExportRuntimeZip() {
    if (!generatedOutDir) {
      return;
    }
    setStatus({ kind: "busy", message: "Gerando zip do runtime." });
    try {
      const result = await exportGeneratedArtifactZip(generatedOutDir);
      setRuntimeZipPath(result.zipPath);
      setStatus({ kind: "ok", message: `Zip gerado em ${result.zipPath} (${formatBytes(result.sizeBytes)}).` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleImportRuntimeZip() {
    if (!runtimeZipPath) {
      return;
    }
    setStatus({ kind: "busy", message: "Reimportando runtime por zip." });
    try {
      const result = await importRuntimeProjectFromZip(runtimeZipPath, importTargetProjectId);
      await refreshProjects(true);
      setSelectedProjectId(result.project.id);
      setActiveTab("pipeline");
      setStatus({ kind: "ok", message: `Zip reimportado como ${result.project.id}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleImportRuntimeGit() {
    if (!runtimeGitUrl.trim()) {
      setStatus({ kind: "error", message: "Informe a URL ou caminho do repositório Git." });
      return;
    }
    setStatus({ kind: "busy", message: "Importando runtime a partir de Git." });
    try {
      const result = await importRuntimeProjectFromGit(runtimeGitUrl, importTargetProjectId, runtimeGitRef);
      await refreshProjects(true);
      setSelectedProjectId(result.project.id);
      setActiveTab("pipeline");
      setStatus({ kind: "ok", message: `Git importado como ${result.project.id}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleImportRuntimeDockerImage() {
    if (!runtimeDockerImage.trim()) {
      setStatus({ kind: "error", message: "Informe a imagem Docker." });
      return;
    }
    const parsedPort = runtimeDockerPort.trim() ? Number(runtimeDockerPort.trim()) : undefined;
    if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)) {
      setStatus({ kind: "error", message: "A porta Docker deve ser um inteiro entre 1 e 65535." });
      return;
    }
    setStatus({ kind: "busy", message: "Importando imagem Docker por inspeção read-only." });
    try {
      const result = await importRuntimeProjectFromDockerImage(runtimeDockerImage, importTargetProjectId, parsedPort);
      await refreshProjects(true);
      setSelectedProjectId(result.project.id);
      setActiveTab("pipeline");
      setStatus({ kind: "ok", message: `Imagem Docker importada como ${result.project.id}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleReadArtifact(path: string) {
    setStatus({ kind: "busy", message: `Lendo ${path}.` });
    try {
      const file = await readGeneratedArtifactFile(generatedOutDir, path);
      setArtifactFile(file);
      setStatus({ kind: "ok", message: path });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handlePreviewSource(sourceId: string, real = false) {
    if (!projectDraft) {
      return;
    }
    if (real) {
      const confirmed = window.confirm(`Executar preview real de ${sourceId}?`);
      if (!confirmed) {
        return;
      }
    }
    setStatus({ kind: "busy", message: `${real ? "Preview real" : "Pré-visualizando"} ${sourceId}.` });
    try {
      const preview = await previewDataSource(projectDraft.id, sourceId, 10, real ? "real" : "safe");
      setSourcePreview(preview);
      markManualNodeExecution(nodeIdsForSource(pipelineDraft, sourceId), {
        status: sourcePreviewExecutionStatus(preview),
        label: real ? "Preview real" : "Preview",
        detail: preview.message ?? `${preview.rowCount ?? 0} linha(s)`,
      });
      setActiveTab("project");
      setStatus({ kind: preview.status === "ok" ? "ok" : "idle", message: preview.message ?? `${preview.rowCount ?? 0} linha(s) em ${sourceId}.` });
    } catch (error) {
      markManualNodeExecution(nodeIdsForSource(pipelineDraft, sourceId), { status: "failed", label: "Preview", detail: errorMessage(error) });
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleStartSourcePreviewJob(sourceId: string, real = false) {
    if (!projectDraft) {
      return;
    }
    if (real) {
      const confirmed = window.confirm(`Executar preview real em job de ${sourceId}?`);
      if (!confirmed) {
        return;
      }
    }
    setStatus({ kind: "busy", message: `Iniciando job de preview ${sourceId}.` });
    try {
      await handleSave();
      const job = await startSourcePreviewJob(projectDraft.id, sourceId, 10, real ? "real" : "safe");
      setWorkerJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      setActiveTab("studio");
      setStatus({ kind: "ok", message: `Job ${job.jobId} iniciado.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleTrainBaseline(sourceId?: string, real = false, incremental = false) {
    if (!projectDraft) {
      return;
    }
    const baseRunId = trainingResult?.runId;
    if (incremental && !baseRunId) {
      setStatus({ kind: "error", message: "Selecione ou execute um treino base antes do retreino incremental." });
      return;
    }
    if (real) {
      const confirmed = window.confirm(`Treinar usando fonte real ${sourceId ?? "padrão"}?`);
      if (!confirmed) {
        return;
      }
    }
    setStatus({ kind: "busy", message: `${incremental ? "Retreinando incremental" : "Treinando baseline"} ${sourceId ? `com ${sourceId}` : "local"}.` });
    try {
      await handleSave();
      const defaultSource = projectDraft.dataSources.find((source) => source.type === "csv") ?? projectDraft.dataSources[0];
      const selectedSourceId = sourceId ?? defaultSource?.id;
      const result = await trainBaseline(projectDraft.id, selectedSourceId, real ? "real" : "safe", incremental ? { incremental: true, previousRunId: baseRunId } : {});
      setTrainingResult(result);
      markManualNodeExecution(nodeIdsForTrainingResult(pipelineDraft, result), {
        status: result.status === "ok" ? "completed" : "failed",
        label: incremental ? "Retreino incremental" : real ? "Treino real" : "Treino",
        detail: `melhor modelo ${result.bestModelId}`,
      });
      setTrainingRuns((current) => [result, ...current.filter((run) => run.runId !== result.runId)]);
      setPromotionStatus(await getPromotionStatus(projectDraft.id));
      await refreshMlflowStatus(projectDraft.id, true);
      setActiveTab("studio");
      setStatus({ kind: "ok", message: `${incremental ? "Retreino" : "Treino"} ${result.runId}: melhor modelo ${result.bestModelId}.` });
    } catch (error) {
      const defaultSource = projectDraft.dataSources.find((source) => source.type === "csv") ?? projectDraft.dataSources[0];
      const selectedSourceId = sourceId ?? defaultSource?.id;
      markManualNodeExecution([...nodeIdsForSource(pipelineDraft, selectedSourceId), ...modelNodeIds(pipelineDraft)], { status: "failed", label: incremental ? "Retreino incremental" : "Treino", detail: errorMessage(error) });
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleStartTrainBaselineJob(sourceId?: string, real = false, incremental = false) {
    if (!projectDraft) {
      return;
    }
    const baseRunId = trainingResult?.runId;
    if (incremental && !baseRunId) {
      setStatus({ kind: "error", message: "Selecione ou execute um treino base antes do retreino incremental em job." });
      return;
    }
    if (real) {
      const confirmed = window.confirm(`Treinar em job usando fonte real ${sourceId ?? "padrão"}?`);
      if (!confirmed) {
        return;
      }
    }
    setStatus({ kind: "busy", message: `Iniciando job de ${incremental ? "retreino incremental" : "treino"} ${sourceId ? `com ${sourceId}` : "local"}.` });
    try {
      await handleSave();
      const defaultSource = projectDraft.dataSources.find((source) => source.type === "csv") ?? projectDraft.dataSources[0];
      const selectedSourceId = sourceId ?? defaultSource?.id;
      const job = await startTrainBaselineJob(projectDraft.id, selectedSourceId, real ? "real" : "safe", incremental ? { incremental: true, previousRunId: baseRunId } : {});
      setWorkerJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      setActiveTab("studio");
      setStatus({ kind: "ok", message: `Job ${job.jobId} iniciado.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleEvaluateModel(real = false) {
    if (!projectDraft || !trainingResult) {
      return;
    }
    const sourceId = trainingResult.sourceId || projectDraft.dataSources[0]?.id;
    const modelId = promotionStatus?.activeModelId ?? trainingResult.bestModelId;
    if (real) {
      const confirmed = window.confirm(`Avaliar ${modelId} usando fonte real ${sourceId}?`);
      if (!confirmed) {
        return;
      }
    }
    setStatus({ kind: "busy", message: `Avaliando ${modelId}.` });
    try {
      await handleSave();
      const result = await evaluateModel(projectDraft.id, trainingResult.runId, modelId, sourceId, real ? "real" : "safe");
      setEvaluationResult(result);
      markManualNodeExecution(nodeIdsForEvaluationResult(pipelineDraft, result), {
        status: result.status === "ok" ? "completed" : "failed",
        label: real ? "Avaliação real" : "Avaliação",
        detail: `${result.primaryMetric} ${String(result.metrics[result.primaryMetric] ?? "-")}`,
      });
      setEvaluationRuns((current) => [result, ...current.filter((run) => run.evaluationId !== result.evaluationId)]);
      setStatus({ kind: "ok", message: `Avaliação ${result.evaluationId}: ${result.primaryMetric} ${String(result.metrics[result.primaryMetric] ?? "-")}.` });
    } catch (error) {
      markManualNodeExecution([...nodeIdsForSource(pipelineDraft, sourceId), ...modelNodeIdsById(pipelineDraft, [modelId]), ...evaluationNodeIds(pipelineDraft)], { status: "failed", label: "Avaliação", detail: errorMessage(error) });
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleStartEvaluateModelJob(real = false) {
    if (!projectDraft || !trainingResult) {
      return;
    }
    const sourceId = trainingResult.sourceId || projectDraft.dataSources[0]?.id;
    const modelId = promotionStatus?.activeModelId ?? trainingResult.bestModelId;
    if (real) {
      const confirmed = window.confirm(`Iniciar avaliação real em job para ${modelId}?`);
      if (!confirmed) {
        return;
      }
    }
    setStatus({ kind: "busy", message: `Iniciando job de avaliação ${modelId}.` });
    try {
      await handleSave();
      const job = await startEvaluateModelJob(projectDraft.id, trainingResult.runId, modelId, sourceId, real ? "real" : "safe");
      setWorkerJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      setActiveTab("studio");
      setStatus({ kind: "ok", message: `Job ${job.jobId} iniciado.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleBacktestModels(real = false) {
    if (!projectDraft || !trainingResult) {
      return;
    }
    const sourceId = trainingResult.sourceId || projectDraft.dataSources[0]?.id;
    const modelIds = trainingResult.leaderboard.map((row) => row.modelId).filter(Boolean);
    const activeModelId = promotionStatus?.activeModelId && modelIds.includes(promotionStatus.activeModelId) ? promotionStatus.activeModelId : null;
    const baselineModelId = activeModelId ?? trainingResult.bestModelId;
    const temporalWindow = buildBacktestWindow(backtestTimeColumn, backtestWindowStart, backtestWindowEnd, backtestComparisonStart, backtestComparisonEnd, backtestWindowGranularity);
    if (!temporalWindow.ok) {
      setStatus({ kind: "error", message: temporalWindow.message });
      return;
    }
    if (real) {
      const confirmed = window.confirm(`Executar backtest real de ${modelIds.length} modelo(s) usando fonte ${sourceId}?`);
      if (!confirmed) {
        return;
      }
    }
    setStatus({ kind: "busy", message: `Executando backtest de ${modelIds.length} modelo(s).` });
    try {
      await handleSave();
      const result = await backtestModels(projectDraft.id, trainingResult.runId, modelIds, baselineModelId, sourceId, real ? "real" : "safe", 0.001, temporalWindow.value);
      setEvaluationResult(result);
      markManualNodeExecution(nodeIdsForEvaluationResult(pipelineDraft, result), {
        status: result.status === "ok" ? "completed" : "failed",
        label: real ? "Backtest real" : "Backtest",
        detail: result.recommendation ?? "review",
      });
      setEvaluationRuns((current) => [result, ...current.filter((run) => run.evaluationId !== result.evaluationId)]);
      setStatus({ kind: "ok", message: `Backtest ${result.evaluationId}: ${result.recommendation ?? "review"}.` });
    } catch (error) {
      markManualNodeExecution([...nodeIdsForSource(pipelineDraft, sourceId), ...modelNodeIdsById(pipelineDraft, modelIds), ...evaluationNodeIds(pipelineDraft)], { status: "failed", label: "Backtest", detail: errorMessage(error) });
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleStartBacktestModelsJob(real = false) {
    if (!projectDraft || !trainingResult) {
      return;
    }
    const sourceId = trainingResult.sourceId || projectDraft.dataSources[0]?.id;
    const modelIds = trainingResult.leaderboard.map((row) => row.modelId).filter(Boolean);
    const activeModelId = promotionStatus?.activeModelId && modelIds.includes(promotionStatus.activeModelId) ? promotionStatus.activeModelId : null;
    const baselineModelId = activeModelId ?? trainingResult.bestModelId;
    const temporalWindow = buildBacktestWindow(backtestTimeColumn, backtestWindowStart, backtestWindowEnd, backtestComparisonStart, backtestComparisonEnd, backtestWindowGranularity);
    if (!temporalWindow.ok) {
      setStatus({ kind: "error", message: temporalWindow.message });
      return;
    }
    if (real) {
      const confirmed = window.confirm(`Iniciar backtest real em job usando fonte ${sourceId}?`);
      if (!confirmed) {
        return;
      }
    }
    setStatus({ kind: "busy", message: `Iniciando job de backtest com ${modelIds.length} modelo(s).` });
    try {
      await handleSave();
      const job = await startBacktestModelsJob(projectDraft.id, trainingResult.runId, modelIds, baselineModelId, sourceId, real ? "real" : "safe", 0.001, temporalWindow.value);
      setWorkerJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      setActiveTab("studio");
      setStatus({ kind: "ok", message: `Job ${job.jobId} iniciado.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleCancelWorkerJob(jobId: string) {
    setStatus({ kind: "busy", message: `Cancelando job ${jobId}.` });
    try {
      const job = await cancelWorkerJob(jobId);
      setWorkerJobs((current) => current.map((item) => (item.jobId === job.jobId ? job : item)));
      setStatus({ kind: "ok", message: `Job ${job.jobId} ${job.status}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleRecoverWorkerJob(jobId: string) {
    setStatus({ kind: "busy", message: `Retomando job ${jobId}.` });
    try {
      const job = await recoverWorkerJob(jobId);
      setWorkerJobs((current) => current.map((item) => (item.jobId === job.jobId ? job : item)));
      setStatus({ kind: "ok", message: `Job ${job.jobId} retomado.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleDatasetSnapshotAction(action: "archive" | "restore" | "purge") {
    if (!projectDraft) {
      return;
    }
    const actionLabel = action === "archive" ? "arquivar snapshots" : action === "restore" ? "restaurar snapshots" : "expurgar snapshots vencidos";
    const confirmed = window.confirm(`Deseja ${actionLabel} do projeto ${projectDraft.id}?`);
    if (!confirmed) {
      return;
    }
    setStatus({ kind: "busy", message: `Executando ${actionLabel}.` });
    try {
      const result = action === "archive"
        ? await archiveDatasetSnapshots(projectDraft.id)
        : action === "restore"
          ? await restoreDatasetSnapshots(projectDraft.id)
          : await purgeExpiredDatasetSnapshots(projectDraft.id);
      setDatasetSnapshotActionResult(result);
      await refreshDatasetSnapshots(projectDraft.id, true);
      const changed = result.archived ?? result.restored ?? result.purged ?? 0;
      setStatus({ kind: result.errors?.length ? "error" : "ok", message: `${actionLabel}: ${changed} item(ns), ${result.errors?.length ?? 0} erro(s).` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleApplyPromotion() {
    if (!projectDraft || !pipelineDraft || !promotionStatus?.latestRunId || !promotionStatus.candidateModelId) {
      return;
    }
    const confirmed = window.confirm(`Promover ${promotionStatus.candidateModelId} como modelo ativo do projeto?`);
    if (!confirmed) {
      return;
    }
    setStatus({ kind: "busy", message: `Aplicando promoção de ${promotionStatus.candidateModelId}.` });
    try {
      await saveProject(projectDraft.id, projectDraft);
      await savePipeline(projectDraft.id, pipelineDraft);
      setProjectJsonDraft(JSON.stringify(projectDraft, null, 2));
      const result = await applyPromotion(projectDraft.id, promotionStatus.latestRunId, promotionStatus.candidateModelId);
      setPipelineDraft(result.pipeline);
      setPipelineJsonDraft(JSON.stringify(result.pipeline, null, 2));
      setLoaded((current) => current ? { ...current, pipeline: result.pipeline } : current);
      setPromotionStatus(result.promotionStatus);
      await refreshProjects(true);
      await refreshMlflowStatus(projectDraft.id, true);
      setStatus({ kind: "ok", message: `Promoção aplicada: ${result.previousActiveModelId} -> ${result.activeModelId}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handlePromoteRuntimeRetrainingJob(jobId: string) {
    if (!projectDraft || !pipelineDraft) {
      return;
    }
    const job = workerJobs.find((item) => item.jobId === jobId);
    const trainingResult = job && isTrainingResult(job.result) ? job.result : null;
    const candidateModelId = trainingResult?.bestModelId ?? null;
    const confirmed = window.confirm(`Promover ${candidateModelId ?? "o modelo retreinado"} como modelo ativo do projeto?`);
    if (!confirmed) {
      return;
    }
    setStatus({ kind: "busy", message: `Aplicando promoção do retreino ${jobId}.` });
    try {
      await saveProject(projectDraft.id, projectDraft);
      await savePipeline(projectDraft.id, pipelineDraft);
      setProjectJsonDraft(JSON.stringify(projectDraft, null, 2));
      const result = await promoteRuntimeRetrainingJob(projectDraft.id, jobId, candidateModelId);
      setPipelineDraft(result.pipeline);
      setPipelineJsonDraft(JSON.stringify(result.pipeline, null, 2));
      setLoaded((current) => current ? { ...current, pipeline: result.pipeline } : current);
      setPromotionStatus(result.promotionStatus);
      if (result.job) {
        setWorkerJobs((current) => current.map((item) => (item.jobId === result.job?.jobId ? result.job : item)));
      }
      await refreshProjects(true);
      await refreshMlflowStatus(projectDraft.id, true);
      setStatus({ kind: "ok", message: `Modelo retreinado promovido: ${result.previousActiveModelId} -> ${result.activeModelId}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleSetMlflowAlias(name: string, version: string, alias: string) {
    if (!projectDraft) {
      return;
    }
    const confirmed = window.confirm(`Definir alias ${alias} para ${name} v${version} no MLflow?`);
    if (!confirmed) {
      return;
    }
    setStatus({ kind: "busy", message: `Atualizando alias ${alias} no MLflow.` });
    try {
      await setMlflowRegisteredModelAlias(projectDraft.id, name, version, alias);
      await refreshMlflowStatus(projectDraft.id, true);
      setStatus({ kind: "ok", message: `Alias ${alias} aponta para ${name} v${version}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleTransitionMlflowStage(name: string, version: string, stage: MlflowStage) {
    if (!projectDraft) {
      return;
    }
    const archiveExistingVersions = stage === "Production";
    const suffix = archiveExistingVersions ? " e arquivar outras versões em Production" : "";
    const confirmed = window.confirm(`Mover ${name} v${version} para ${stage}${suffix}?`);
    if (!confirmed) {
      return;
    }
    setStatus({ kind: "busy", message: `Atualizando estágio ${stage} no MLflow.` });
    try {
      await transitionMlflowModelVersionStage(projectDraft.id, name, version, stage, archiveExistingVersions);
      await refreshMlflowStatus(projectDraft.id, true);
      setStatus({ kind: "ok", message: `${name} v${version} movido para ${stage}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleRunPythonNodeJob() {
    if (!projectDraft || !selectedNode || selectedNode.type !== "python_function") {
      return;
    }
    setStatus({ kind: "busy", message: `Iniciando job Python ${selectedNode.id}.` });
    try {
      await handleSave();
      const input = JSON.parse(pythonInputDraft) as Record<string, unknown>;
      const job = await startPythonNodeJob(projectDraft.id, selectedNode.id, input);
      setWorkerJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      setActiveTab("studio");
      setStatus({ kind: "ok", message: `Job ${job.jobId} iniciado.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleInstallWorkerDependencies() {
    const confirmed = window.confirm("Instalar dependências opcionais do worker neste Python?");
    if (!confirmed) {
      return;
    }
    setStatus({ kind: "busy", message: "Instalando dependências opcionais." });
    try {
      const result = await installWorkerDependencies();
      setWorkerDependencies(result.dependencies);
      setStatus({ kind: "ok", message: "Dependências opcionais instaladas." });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleDockerAction(action: "build" | "up" | "down") {
    if (!generatedOutDir) {
      return;
    }
    const confirmed = window.confirm(`Executar docker ${action} para ${generatedOutDir}?`);
    if (!confirmed) {
      return;
    }
    setStatus({ kind: "busy", message: `Docker ${action} em andamento.` });
    try {
      const result = await dockerRuntimeAction(action, generatedOutDir);
      setDockerStatus(result.docker);
      setDockerHistory(result.history ?? []);
      setStatus({ kind: "ok", message: `Docker ${action} concluído.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleRefreshDockerLogs() {
    if (!generatedOutDir) {
      return;
    }
    setStatus({ kind: "busy", message: "Lendo logs Docker do runtime." });
    try {
      const result = await getDockerRuntimeLogs(generatedOutDir);
      setDockerLogs(result);
      setDockerHistory(result.history);
      setStatus({ kind: "ok", message: "Logs Docker carregados." });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleInspectDockerRuntime() {
    if (!generatedOutDir) {
      return;
    }
    setStatus({ kind: "busy", message: "Inspecionando Docker do runtime." });
    try {
      const result = await getDockerRuntimeInspect(generatedOutDir);
      setDockerInspect(result);
      setDockerHistory(result.history);
      setStatus({ kind: result.summary.filesOk ? "ok" : "error", message: result.summary.filesOk ? "Inspect Docker concluído." : "Inspect encontrou arquivos ausentes." });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleSmokeRuntime() {
    setStatus({ kind: "busy", message: "Executando smoke do runtime." });
    try {
      const result = await smokeRuntime(runtimeBaseUrl);
      setRuntimeSmokeResult(result);
      const summary = result.summary ? `${result.summary.passed}/${result.summary.total}` : `${result.statusCode ?? "sem resposta"}`;
      setStatus({ kind: result.status === "ok" ? "ok" : "error", message: `Smoke ${result.status}: ${summary}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleInspectRemoteRuntime() {
    setStatus({ kind: "busy", message: "Inspecionando runtime remoto." });
    try {
      const result = await inspectRemoteRuntime(remoteRuntimeUrl);
      setRemoteRuntimeInspection(result);
      const summary = `${result.summary.ok}/${result.summary.total}`;
      setStatus({ kind: result.status === "error" ? "error" : "ok", message: `Runtime remoto ${result.mode}: ${summary} endpoints observáveis.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleRunPlaywrightScrape() {
    if (!playwrightScrapeUrl.trim()) {
      setStatus({ kind: "error", message: "Informe a URL para scraping Playwright." });
      return;
    }
    setStatus({ kind: "busy", message: "Executando scraping/crawl Playwright controlado." });
    try {
      const auth: PlaywrightScrapeAuthOptions | null = playwrightAuthEnabled ? {
        loginUrl: playwrightAuthLoginUrl.trim() || undefined,
        username: playwrightAuthUsername.trim() || undefined,
        usernameSelector: playwrightAuthUsernameSelector.trim() || undefined,
        passwordSelector: playwrightAuthPasswordSelector.trim() || undefined,
        passwordRef: playwrightAuthPasswordRef.trim(),
        submitSelector: playwrightAuthSubmitSelector.trim() || undefined,
        successSelector: playwrightAuthSuccessSelector.trim() || undefined,
      } : null;
      if (playwrightAuthEnabled && !auth?.passwordRef) {
        setStatus({ kind: "error", message: "Informe passwordRef como env:VAR para scraping autenticado." });
        return;
      }
      const maxDepth = Number(playwrightMaxDepth);
      const maxPages = Number(playwrightMaxPages);
      if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 5 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
        setStatus({ kind: "error", message: "Informe maxDepth 0-5 e maxPages 1-50." });
        return;
      }
      const result = await runPlaywrightScrape(playwrightScrapeUrl, true, maxDepth, maxPages, auth, playwrightDeepCrawl);
      setPlaywrightScrapeResult(result);
      setPlaywrightScrapePreview(null);
      setPlaywrightOpenApiPreview(null);
      setPlaywrightOpenApiSmoke(null);
      setPlaywrightScrapeImportSources(playwrightScrapeImportDraftFromResult(result));
      setStatus({ kind: "ok", message: `Scraping concluído: ${result.crawledPageCount ?? 1} página(s), ${result.links.length} link(s), ${result.apiCandidates.length} candidato(s) de API.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  function handleUpdatePlaywrightScrapeImportSource(index: number, patch: Partial<PlaywrightScrapeSourceDraft>) {
    setPlaywrightScrapeImportSources((current) => current.map((source, sourceIndex) => (sourceIndex === index ? { ...source, ...patch } : source)));
    setPlaywrightScrapePreview(null);
    setPlaywrightOpenApiPreview(null);
    setPlaywrightOpenApiSmoke(null);
  }

  async function handlePreviewPlaywrightOpenApiContract() {
    if (!playwrightScrapeResult) {
      setStatus({ kind: "error", message: "Execute o scraping antes de validar OpenAPI." });
      return;
    }
    const source = playwrightScrapeImportSources.find((item) => item.include && item.url.trim() && playwrightScrapeSourceLooksLikeOpenApi(item))
      ?? playwrightScrapeImportSources.find((item) => item.include && item.url.trim());
    if (!source) {
      setStatus({ kind: "error", message: "Nenhuma fonte incluída com URL para validação OpenAPI." });
      return;
    }
    const absoluteUrl = playwrightScrapeAbsoluteUrl(source.url.trim(), playwrightScrapeResult.finalUrl || playwrightScrapeResult.url);
    setPlaywrightOpenApiPreview(null);
    setPlaywrightOpenApiSmoke(null);
    setStatus({ kind: "busy", message: `Validando contrato OpenAPI em ${absoluteUrl}.` });
    try {
      const result = await previewOpenApiContract(absoluteUrl);
      setPlaywrightOpenApiPreview(result);
      setStatus({ kind: "ok", message: `OpenAPI validado: ${result.endpointCount} endpoint(s) HTTP.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  function handleApplyPlaywrightOpenApiOperation(operation: OpenApiOperationPreview) {
    const targetIndex = playwrightScrapeImportSources.findIndex((source) => source.include && source.url.trim() && playwrightScrapeSourceLooksLikeOpenApi(source));
    const fallbackIndex = playwrightScrapeImportSources.findIndex((source) => source.include && source.url.trim());
    const sourceIndex = targetIndex >= 0 ? targetIndex : fallbackIndex;
    if (sourceIndex < 0) {
      setStatus({ kind: "error", message: "Nenhuma fonte incluída disponível para receber a operação OpenAPI." });
      return;
    }
    const bodyTemplateJson = operation.requestExample === null || operation.requestExample === undefined
      ? ""
      : JSON.stringify(operation.requestExample, null, 2);
    setPlaywrightScrapeImportSources((current) => current.map((source, index) => index === sourceIndex
      ? {
          ...source,
          include: true,
          label: operation.summary || operation.operationId || source.label,
          description: operation.description || source.description,
          method: playwrightScrapeUiMethod(operation.method),
          url: operation.path,
          bodyTemplateJson,
        }
      : source));
    setPlaywrightScrapePreview(null);
    setPlaywrightOpenApiSmoke(null);
    setStatus({ kind: "ok", message: `Operação OpenAPI ${operation.method} ${operation.path} aplicada ao wizard.` });
  }

  async function handleSmokePlaywrightOpenApiOperation(operation: OpenApiOperationPreview) {
    if (!playwrightScrapeResult) {
      setStatus({ kind: "error", message: "Execute o scraping antes de testar payload OpenAPI." });
      return;
    }
    const absoluteUrl = playwrightScrapeAbsoluteUrl(operation.path, playwrightScrapeResult.finalUrl || playwrightScrapeResult.url);
    setPlaywrightOpenApiSmoke(null);
    setStatus({ kind: "busy", message: `Testando payload OpenAPI em ${absoluteUrl}.` });
    try {
      const responseValidation = operation.responses.find((response) => response.status.startsWith("2") && response.validation)?.validation
        ?? operation.responses.find((response) => response.validation)?.validation
        ?? null;
      const result = await smokeOpenApiOperation(operation.method, absoluteUrl, operation.requestExample, operation.requestValidation, responseValidation);
      setPlaywrightOpenApiSmoke(result);
      const validationLabel = result.responseValidation.checked ? ` schema ${result.responseValidation.ok ? "ok" : "com divergência"}` : "";
      setStatus({ kind: result.ok && result.responseValidation.ok ? "ok" : "error", message: `Smoke OpenAPI ${operation.method} ${operation.path}: HTTP ${result.statusCode}${validationLabel}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handlePreviewPlaywrightScrapeProject() {
    if (!playwrightScrapeResult?.reportPath) {
      setStatus({ kind: "error", message: "Execute o scraping antes de pré-visualizar a importação." });
      return;
    }
    setStatus({ kind: "busy", message: "Gerando prévia de importação do relatório Playwright." });
    try {
      const contractEdits = playwrightScrapeImportContractEditsFromDrafts(playwrightScrapeImportSources);
      const result = await previewRuntimeProjectFromScrape(playwrightScrapeResult.reportPath, importTargetProjectId, contractEdits);
      setPlaywrightScrapePreview(result);
      setStatus({ kind: "ok", message: `Prévia pronta: ${result.summary.dataSources} fonte(s), ${result.summary.nodes} nó(s), ${result.summary.sourceEdits} edição(ões).` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleImportPlaywrightScrapeProject() {
    if (!playwrightScrapeResult?.reportPath) {
      setStatus({ kind: "error", message: "Execute o scraping antes de importar o relatório." });
      return;
    }
    setStatus({ kind: "busy", message: "Importando relatório Playwright como projeto black-box assistido." });
    try {
      const contractEdits = playwrightScrapeImportContractEditsFromDrafts(playwrightScrapeImportSources);
      const result = await importRuntimeProjectFromScrape(playwrightScrapeResult.reportPath, importTargetProjectId, contractEdits);
      await refreshProjects(true);
      setSelectedProjectId(result.project.id);
      setPlaywrightScrapePreview(null);
      setPlaywrightOpenApiPreview(null);
      setPlaywrightOpenApiSmoke(null);
      setActiveTab("pipeline");
      setStatus({ kind: "ok", message: `Relatório Playwright importado como ${result.project.id}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleImportRemoteBlackBoxRuntime() {
    if (!remoteRuntimeUrl.trim()) {
      setStatus({ kind: "error", message: "Informe a URL do runtime remoto antes de importar." });
      return;
    }
    setStatus({ kind: "busy", message: "Importando runtime remoto como black-box observável." });
    try {
      const result = await importRemoteBlackBoxRuntime(remoteRuntimeUrl, importTargetProjectId);
      await refreshProjects(true);
      setSelectedProjectId(result.project.id);
      setRemoteRuntimeInspection(result.remoteInspection ?? remoteRuntimeInspection);
      setActiveTab("pipeline");
      setStatus({ kind: "ok", message: `Runtime remoto importado como ${result.project.id}.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleStartRuntimeRetrainingJob() {
    if (!projectDraft) {
      return;
    }
    const baseRunId = trainingResult?.runId ?? trainingRuns[0]?.runId;
    if (!baseRunId) {
      setStatus({ kind: "error", message: "Execute ou selecione um treino base antes de rodar retreino aprovado." });
      return;
    }
    const defaultSource = projectDraft.dataSources.find((source) => source.type === "csv") ?? projectDraft.dataSources[0];
    const selectedSourceId = trainingResult?.sourceId || defaultSource?.id;
    const approvedRequest = latestApprovedRuntimeRetrainingRequest(remoteRuntimeInspection);
    setStatus({ kind: "busy", message: "Iniciando job de retreino aprovado pelo runtime." });
    try {
      await handleSave();
      const job = await startRuntimeRetrainingJob(projectDraft.id, remoteRuntimeUrl, {
        requestId: approvedRequest?.requestId ?? null,
        sourceId: selectedSourceId ?? null,
        previousRunId: baseRunId,
        requireFeedbackRows: true,
      });
      setWorkerJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      markManualNodeExecution([...nodeIdsForSource(pipelineDraft, selectedSourceId), ...modelNodeIds(pipelineDraft)], {
        status: "running",
        label: "Retreino aprovado",
        detail: approvedRequest?.requestId ?? job.jobId,
      });
      setActiveTab("studio");
      setStatus({ kind: "ok", message: `Job de retreino aprovado ${job.jobId} iniciado.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  async function handleRunPythonNode() {
    if (!projectDraft || !selectedNode || selectedNode.type !== "python_function") {
      return;
    }
    setStatus({ kind: "busy", message: `Executando ${selectedNode.id}.` });
    try {
      await handleSave();
      const input = JSON.parse(pythonInputDraft) as Record<string, unknown>;
      const result = await runPythonNode(projectDraft.id, selectedNode.id, input);
      setPythonRunResult(result);
      markManualNodeExecution([selectedNode.id], {
        status: result.status === "ok" ? "completed" : "failed",
        label: "Python",
        detail: `${result.durationMs} ms`,
      });
      setStatus({ kind: "ok", message: `${selectedNode.id} executado em ${result.durationMs} ms.` });
    } catch (error) {
      markManualNodeExecution([selectedNode.id], { status: "failed", label: "Python", detail: errorMessage(error) });
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  function addNode(type: NodeType) {
    setPipelineDraft((current) => {
      if (!current) {
        return current;
      }
      const node = createDefaultNode(current, type, projectDraft);
      setSelectedNodeId(node.id);
      setSelectedEdgeId("");
      return { ...current, nodes: [...current.nodes, node] };
    });
  }

  function removeSelected() {
    if (!pipelineDraft) {
      return;
    }
    if (selectedNodeId) {
      setPipelineDraft({
        ...pipelineDraft,
        nodes: pipelineDraft.nodes.filter((node) => node.id !== selectedNodeId),
        edges: pipelineDraft.edges.filter((edge) => edge.from !== selectedNodeId && edge.to !== selectedNodeId),
      });
      setSelectedNodeId("");
      return;
    }
    if (selectedEdgeId) {
      setPipelineDraft({
        ...pipelineDraft,
        edges: pipelineDraft.edges.filter((edge, index) => edgeId(edge, index) !== selectedEdgeId),
      });
      setSelectedEdgeId("");
    }
  }

  function updateNode(patch: Partial<PipelineNode>) {
    if (!selectedNode) {
      return;
    }
    setPipelineDraft((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        nodes: current.nodes.map((node) => (node.id === selectedNode.id ? { ...node, ...patch } : node)),
      };
    });
  }

  function updateProjectFromJson() {
    try {
      const parsed = JSON.parse(projectJsonDraft) as MLOpsProject;
      setProjectDraft(parsed);
      setStatus({ kind: "ok", message: "JSON do projeto aplicado." });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  function updatePipelineFromJson() {
    try {
      const parsed = JSON.parse(pipelineJsonDraft) as PipelineFlow;
      setPipelineDraft(parsed);
      setStatus({ kind: "ok", message: "JSON do pipeline aplicado." });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>MLOps Flow Studio</strong>
            <span>{projectDraft ? `${projectDraft.name} ${projectDraft.version}` : "workspace local"}</span>
          </div>
        </div>
        <div className="project-switcher">
          <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
            <option value="">Sem projeto</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name ?? project.id}
              </option>
            ))}
          </select>
          <button type="button" className="icon-button" onClick={() => void refreshProjects()} title="Atualizar projetos">
            <RefreshCw size={16} />
          </button>
          <button type="button" className="command-button" onClick={() => void handleCreateProject()}>
            <Plus size={16} />
            Novo
          </button>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}
            aria-label={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}
          >
            {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
          </button>
          <button type="button" className="command-button" disabled={!projectDraft} onClick={() => void handleSave()}>
            <Save size={16} />
            Salvar
          </button>
          <button type="button" className="command-button" disabled={!projectDraft} onClick={() => void handleValidate()}>
            <CheckCircle2 size={16} />
            Validar
          </button>
          <button type="button" className="primary-button" disabled={!projectDraft} onClick={() => void handleGenerate()}>
            <UploadCloud size={16} />
            Gerar
          </button>
        </div>
      </header>

      <nav className="tabs">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} type="button" className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </nav>

      <main className="workspace">
        <aside className="palette">
          {nodeTypeOptions.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.type} type="button" onClick={() => addNode(item.type)} disabled={!pipelineDraft}>
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </aside>

        <section className="canvas-panel">
          {activeTab === "pipeline" && pipelineDraft ? (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onNodeDragStop={onNodeDragStop}
              onNodesDelete={onNodesDelete}
              onEdgesDelete={onEdgesDelete}
              fitView
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          ) : (
            <TabPanel
              activeTab={activeTab}
              project={projectDraft}
              pipeline={pipelineDraft}
              onUpdateProject={setProjectDraft}
              validation={validation}
              generatedOutDir={generatedOutDir}
              setGeneratedOutDir={setGeneratedOutDir}
              runtimeZipPath={runtimeZipPath}
              setRuntimeZipPath={setRuntimeZipPath}
              runtimeGitUrl={runtimeGitUrl}
              setRuntimeGitUrl={setRuntimeGitUrl}
              runtimeGitRef={runtimeGitRef}
              setRuntimeGitRef={setRuntimeGitRef}
              runtimeDockerImage={runtimeDockerImage}
              setRuntimeDockerImage={setRuntimeDockerImage}
              runtimeDockerPort={runtimeDockerPort}
              setRuntimeDockerPort={setRuntimeDockerPort}
              importTargetProjectId={importTargetProjectId}
              setImportTargetProjectId={setImportTargetProjectId}
              artifactListing={artifactListing}
              artifactFile={artifactFile}
              manifestValidation={manifestValidation}
              onRefreshArtifacts={() => void handleRefreshArtifacts()}
              onReadArtifact={(path) => void handleReadArtifact(path)}
              onValidateGeneratedManifest={() => void handleValidateGeneratedManifest()}
              onImportRuntimeProject={() => void handleImportRuntimeProject()}
              onExportRuntimeZip={() => void handleExportRuntimeZip()}
              onImportRuntimeZip={() => void handleImportRuntimeZip()}
              onImportRuntimeGit={() => void handleImportRuntimeGit()}
              onImportRuntimeDockerImage={() => void handleImportRuntimeDockerImage()}
              sourcePreview={sourcePreview}
              trainingResult={trainingResult}
              trainingRuns={trainingRuns}
              evaluationResult={evaluationResult}
              evaluationRuns={evaluationRuns}
              backtestTimeColumn={backtestTimeColumn}
              setBacktestTimeColumn={setBacktestTimeColumn}
              backtestWindowStart={backtestWindowStart}
              setBacktestWindowStart={setBacktestWindowStart}
              backtestWindowEnd={backtestWindowEnd}
              setBacktestWindowEnd={setBacktestWindowEnd}
              backtestComparisonStart={backtestComparisonStart}
              setBacktestComparisonStart={setBacktestComparisonStart}
              backtestComparisonEnd={backtestComparisonEnd}
              setBacktestComparisonEnd={setBacktestComparisonEnd}
              backtestWindowGranularity={backtestWindowGranularity}
              setBacktestWindowGranularity={setBacktestWindowGranularity}
              promotionStatus={promotionStatus}
              workerJobs={workerJobs.filter((job) => projectDraft ? job.projectId === projectDraft.id : false)}
              workerQueueStatus={workerQueueStatus}
              datasetSnapshotStatus={datasetSnapshotStatus}
              datasetSnapshotActionResult={datasetSnapshotActionResult}
              mlflowStatus={mlflowStatus}
              mlflowCatalog={mlflowCatalog}
              workerDependencies={workerDependencies}
              gpuEnvironment={gpuEnvironment}
              embeddingEnvironment={embeddingEnvironment}
              embeddingSmokeModel={embeddingSmokeModel}
              setEmbeddingSmokeModel={setEmbeddingSmokeModel}
              embeddingSmokeLocalOnly={embeddingSmokeLocalOnly}
              setEmbeddingSmokeLocalOnly={setEmbeddingSmokeLocalOnly}
              dockerStatus={dockerStatus}
              dockerLogs={dockerLogs}
              dockerInspect={dockerInspect}
              dockerHistory={dockerHistory}
              runtimeBaseUrl={runtimeBaseUrl}
              setRuntimeBaseUrl={setRuntimeBaseUrl}
              runtimeSmokeResult={runtimeSmokeResult}
              remoteRuntimeUrl={remoteRuntimeUrl}
              setRemoteRuntimeUrl={setRemoteRuntimeUrl}
              remoteRuntimeInspection={remoteRuntimeInspection}
              playwrightScrapeUrl={playwrightScrapeUrl}
              setPlaywrightScrapeUrl={setPlaywrightScrapeUrl}
              playwrightMaxDepth={playwrightMaxDepth}
              setPlaywrightMaxDepth={setPlaywrightMaxDepth}
              playwrightMaxPages={playwrightMaxPages}
              setPlaywrightMaxPages={setPlaywrightMaxPages}
              playwrightDeepCrawl={playwrightDeepCrawl}
              setPlaywrightDeepCrawl={setPlaywrightDeepCrawl}
              playwrightAuthEnabled={playwrightAuthEnabled}
              setPlaywrightAuthEnabled={setPlaywrightAuthEnabled}
              playwrightAuthLoginUrl={playwrightAuthLoginUrl}
              setPlaywrightAuthLoginUrl={setPlaywrightAuthLoginUrl}
              playwrightAuthUsername={playwrightAuthUsername}
              setPlaywrightAuthUsername={setPlaywrightAuthUsername}
              playwrightAuthUsernameSelector={playwrightAuthUsernameSelector}
              setPlaywrightAuthUsernameSelector={setPlaywrightAuthUsernameSelector}
              playwrightAuthPasswordSelector={playwrightAuthPasswordSelector}
              setPlaywrightAuthPasswordSelector={setPlaywrightAuthPasswordSelector}
              playwrightAuthPasswordRef={playwrightAuthPasswordRef}
              setPlaywrightAuthPasswordRef={setPlaywrightAuthPasswordRef}
              playwrightAuthSubmitSelector={playwrightAuthSubmitSelector}
              setPlaywrightAuthSubmitSelector={setPlaywrightAuthSubmitSelector}
              playwrightAuthSuccessSelector={playwrightAuthSuccessSelector}
              setPlaywrightAuthSuccessSelector={setPlaywrightAuthSuccessSelector}
              playwrightScrapeResult={playwrightScrapeResult}
              playwrightScrapePreview={playwrightScrapePreview}
              playwrightOpenApiPreview={playwrightOpenApiPreview}
              playwrightOpenApiSmoke={playwrightOpenApiSmoke}
              playwrightScrapeImportSources={playwrightScrapeImportSources}
              onUpdatePlaywrightScrapeImportSource={handleUpdatePlaywrightScrapeImportSource}
              onApplyPlaywrightOpenApiOperation={handleApplyPlaywrightOpenApiOperation}
              onSmokePlaywrightOpenApiOperation={(operation) => void handleSmokePlaywrightOpenApiOperation(operation)}
              onPreviewSource={(sourceId, real) => void handlePreviewSource(sourceId, real)}
              onStartSourcePreviewJob={(sourceId, real) => void handleStartSourcePreviewJob(sourceId, real)}
              onTrainBaseline={(sourceId, real, incremental) => void handleTrainBaseline(sourceId, real, incremental)}
              onStartTrainBaselineJob={(sourceId, real, incremental) => void handleStartTrainBaselineJob(sourceId, real, incremental)}
              onEvaluateModel={(real) => void handleEvaluateModel(real)}
              onStartEvaluateModelJob={(real) => void handleStartEvaluateModelJob(real)}
              onBacktestModels={(real) => void handleBacktestModels(real)}
              onStartBacktestModelsJob={(real) => void handleStartBacktestModelsJob(real)}
              onRefreshTraining={() => void (projectDraft ? refreshTrainingState(projectDraft.id) : undefined)}
              onSelectEvaluationRun={setEvaluationResult}
              onApplyPromotion={() => void handleApplyPromotion()}
              onSelectTrainingRun={setTrainingResult}
              onRefreshWorkerJobs={() => void refreshWorkerJobs(false)}
              onCancelWorkerJob={(jobId) => void handleCancelWorkerJob(jobId)}
              onRecoverWorkerJob={(jobId) => void handleRecoverWorkerJob(jobId)}
              onPromoteRuntimeRetrainingJob={(jobId) => void handlePromoteRuntimeRetrainingJob(jobId)}
              onRefreshDatasetSnapshots={() => void (projectDraft ? refreshDatasetSnapshots(projectDraft.id) : undefined)}
              onArchiveDatasetSnapshots={() => void handleDatasetSnapshotAction("archive")}
              onRestoreDatasetSnapshots={() => void handleDatasetSnapshotAction("restore")}
              onPurgeExpiredDatasetSnapshots={() => void handleDatasetSnapshotAction("purge")}
              onRefreshMlflowStatus={() => void (projectDraft ? refreshMlflowStatus(projectDraft.id) : undefined)}
              onSetMlflowAlias={(name, version, alias) => void handleSetMlflowAlias(name, version, alias)}
              onTransitionMlflowStage={(name, version, stage) => void handleTransitionMlflowStage(name, version, stage)}
              onRefreshWorkerDependencies={() => void refreshWorkerDependencies()}
              onRefreshGpuEnvironment={() => void refreshGpuEnvironment()}
              onRefreshEmbeddingEnvironment={() => void refreshEmbeddingEnvironment(false, false, embeddingSmokeModel, embeddingSmokeLocalOnly)}
              onSmokeEmbeddingEnvironment={() => void refreshEmbeddingEnvironment(true, false, embeddingSmokeModel, embeddingSmokeLocalOnly)}
              onInstallWorkerDependencies={() => void handleInstallWorkerDependencies()}
              onRefreshDockerStatus={() => void refreshDockerStatus(generatedOutDir)}
              onDockerAction={(action) => void handleDockerAction(action)}
              onRefreshDockerLogs={() => void handleRefreshDockerLogs()}
              onInspectDockerRuntime={() => void handleInspectDockerRuntime()}
              onSmokeRuntime={() => void handleSmokeRuntime()}
              onInspectRemoteRuntime={() => void handleInspectRemoteRuntime()}
              onImportRemoteBlackBoxRuntime={() => void handleImportRemoteBlackBoxRuntime()}
              onStartRuntimeRetrainingJob={() => void handleStartRuntimeRetrainingJob()}
              onRunPlaywrightScrape={() => void handleRunPlaywrightScrape()}
              onPreviewPlaywrightOpenApiContract={() => void handlePreviewPlaywrightOpenApiContract()}
              onPreviewPlaywrightScrapeProject={() => void handlePreviewPlaywrightScrapeProject()}
              onImportPlaywrightScrapeProject={() => void handleImportPlaywrightScrapeProject()}
              projectJsonDraft={projectJsonDraft}
              setProjectJsonDraft={setProjectJsonDraft}
              applyProjectJson={updateProjectFromJson}
              pipelineJsonDraft={pipelineJsonDraft}
              setPipelineJsonDraft={setPipelineJsonDraft}
              applyPipelineJson={updatePipelineFromJson}
            />
          )}
        </section>

        <aside className="inspector">
          <div className="inspector-header">
            <strong>{selectedNode ? selectedNode.label || selectedNode.id : selectedEdge ? "Aresta" : "Inspector"}</strong>
            <button type="button" className="icon-button danger" onClick={removeSelected} disabled={!selectedNode && !selectedEdge} title="Remover seleção">
              <Trash2 size={16} />
            </button>
          </div>
          {selectedNode ? (
            <NodeInspector
              node={selectedNode}
              project={projectDraft}
              onChange={updateNode}
              diagnostics={validation?.diagnostics.filter((item) => item.nodeId === selectedNode.id) ?? []}
              executionState={nodeExecutionStates.get(selectedNode.id) ?? null}
              pythonInputDraft={pythonInputDraft}
              setPythonInputDraft={setPythonInputDraft}
              pythonRunResult={pythonRunResult?.nodeId === selectedNode.id ? pythonRunResult : null}
              onRunPython={() => void handleRunPythonNode()}
              onRunPythonJob={() => void handleRunPythonNodeJob()}
            />
          ) : selectedEdge ? (
            <EdgeInspector edge={selectedEdge} onChange={(next) => updateEdge(pipelineDraft, selectedEdgeId, next, setPipelineDraft)} />
          ) : (
            <div className="empty-state">
              <Terminal size={18} />
              <span>{projectDraft ? "Selecione um nó ou aresta." : "Crie ou carregue um projeto."}</span>
            </div>
          )}
        </aside>
      </main>

      <footer className={`statusbar ${status.kind}`}>
        <span>{status.message}</span>
        {validation ? (
          <span>
            {validation.summary.nodes} nós, {validation.summary.edges} arestas, {validation.summary.errors} erros
          </span>
        ) : null}
      </footer>
    </div>
  );
}

function TabPanel(props: {
  activeTab: AppTab;
  project: MLOpsProject | null;
  pipeline: PipelineFlow | null;
  onUpdateProject: React.Dispatch<React.SetStateAction<MLOpsProject | null>>;
  validation: ValidationResult | null;
  generatedOutDir: string;
  setGeneratedOutDir: (value: string) => void;
  runtimeZipPath: string;
  setRuntimeZipPath: (value: string) => void;
  runtimeGitUrl: string;
  setRuntimeGitUrl: (value: string) => void;
  runtimeGitRef: string;
  setRuntimeGitRef: (value: string) => void;
  runtimeDockerImage: string;
  setRuntimeDockerImage: (value: string) => void;
  runtimeDockerPort: string;
  setRuntimeDockerPort: (value: string) => void;
  importTargetProjectId: string;
  setImportTargetProjectId: (value: string) => void;
  artifactListing: GeneratedArtifactListing | null;
  artifactFile: GeneratedArtifactFileContent | null;
  manifestValidation: ArtifactManifestValidationResult | null;
  onRefreshArtifacts: () => void;
  onReadArtifact: (path: string) => void;
  onValidateGeneratedManifest: () => void;
  onImportRuntimeProject: () => void;
  onExportRuntimeZip: () => void;
  onImportRuntimeZip: () => void;
  onImportRuntimeGit: () => void;
  onImportRuntimeDockerImage: () => void;
  sourcePreview: SourcePreviewResult | null;
  trainingResult: TrainingResult | null;
  trainingRuns: TrainingResult[];
  evaluationResult: EvaluationResult | null;
  evaluationRuns: EvaluationResult[];
  backtestTimeColumn: string;
  setBacktestTimeColumn: (value: string) => void;
  backtestWindowStart: string;
  setBacktestWindowStart: (value: string) => void;
  backtestWindowEnd: string;
  setBacktestWindowEnd: (value: string) => void;
  backtestComparisonStart: string;
  setBacktestComparisonStart: (value: string) => void;
  backtestComparisonEnd: string;
  setBacktestComparisonEnd: (value: string) => void;
  backtestWindowGranularity: BacktestWindowGranularity;
  setBacktestWindowGranularity: (value: BacktestWindowGranularity) => void;
  promotionStatus: PromotionStatus | null;
  workerJobs: WorkerJob[];
  workerQueueStatus: WorkerJobQueueStatus | null;
  datasetSnapshotStatus: DatasetSnapshotStatus | null;
  datasetSnapshotActionResult: DatasetSnapshotActionResult | null;
  mlflowStatus: MlflowIntegrationStatus | null;
  mlflowCatalog: MlflowCatalog | null;
  workerDependencies: WorkerDependencyStatus | null;
  gpuEnvironment: GpuEnvironmentStatus | null;
  embeddingEnvironment: EmbeddingEnvironmentStatus | null;
  embeddingSmokeModel: string;
  setEmbeddingSmokeModel: (value: string) => void;
  embeddingSmokeLocalOnly: boolean;
  setEmbeddingSmokeLocalOnly: (value: boolean) => void;
  dockerStatus: DockerRuntimeStatus | null;
  dockerLogs: DockerRuntimeLogs | null;
  dockerInspect: DockerRuntimeInspect | null;
  dockerHistory: DockerRuntimeHistoryEntry[];
  runtimeBaseUrl: string;
  setRuntimeBaseUrl: (value: string) => void;
  runtimeSmokeResult: RuntimeSmokeResult | null;
  remoteRuntimeUrl: string;
  setRemoteRuntimeUrl: (value: string) => void;
  remoteRuntimeInspection: RemoteRuntimeInspection | null;
  playwrightScrapeUrl: string;
  setPlaywrightScrapeUrl: (value: string) => void;
  playwrightMaxDepth: string;
  setPlaywrightMaxDepth: (value: string) => void;
  playwrightMaxPages: string;
  setPlaywrightMaxPages: (value: string) => void;
  playwrightDeepCrawl: boolean;
  setPlaywrightDeepCrawl: (value: boolean) => void;
  playwrightAuthEnabled: boolean;
  setPlaywrightAuthEnabled: (value: boolean) => void;
  playwrightAuthLoginUrl: string;
  setPlaywrightAuthLoginUrl: (value: string) => void;
  playwrightAuthUsername: string;
  setPlaywrightAuthUsername: (value: string) => void;
  playwrightAuthUsernameSelector: string;
  setPlaywrightAuthUsernameSelector: (value: string) => void;
  playwrightAuthPasswordSelector: string;
  setPlaywrightAuthPasswordSelector: (value: string) => void;
  playwrightAuthPasswordRef: string;
  setPlaywrightAuthPasswordRef: (value: string) => void;
  playwrightAuthSubmitSelector: string;
  setPlaywrightAuthSubmitSelector: (value: string) => void;
  playwrightAuthSuccessSelector: string;
  setPlaywrightAuthSuccessSelector: (value: string) => void;
  playwrightScrapeResult: PlaywrightScrapeResult | null;
  playwrightScrapePreview: PlaywrightScrapeImportPreview | null;
  playwrightOpenApiPreview: OpenApiContractPreview | null;
  playwrightOpenApiSmoke: OpenApiOperationSmokeResult | null;
  playwrightScrapeImportSources: PlaywrightScrapeSourceDraft[];
  onUpdatePlaywrightScrapeImportSource: (index: number, patch: Partial<PlaywrightScrapeSourceDraft>) => void;
  onApplyPlaywrightOpenApiOperation: (operation: OpenApiOperationPreview) => void;
  onSmokePlaywrightOpenApiOperation: (operation: OpenApiOperationPreview) => void;
  onPreviewSource: (sourceId: string, real?: boolean) => void;
  onStartSourcePreviewJob: (sourceId: string, real?: boolean) => void;
  onTrainBaseline: (sourceId?: string, real?: boolean, incremental?: boolean) => void;
  onStartTrainBaselineJob: (sourceId?: string, real?: boolean, incremental?: boolean) => void;
  onEvaluateModel: (real?: boolean) => void;
  onStartEvaluateModelJob: (real?: boolean) => void;
  onBacktestModels: (real?: boolean) => void;
  onStartBacktestModelsJob: (real?: boolean) => void;
  onRefreshTraining: () => void;
  onApplyPromotion: () => void;
  onSelectTrainingRun: (run: TrainingResult) => void;
  onSelectEvaluationRun: (run: EvaluationResult) => void;
  onRefreshWorkerJobs: () => void;
  onCancelWorkerJob: (jobId: string) => void;
  onRecoverWorkerJob: (jobId: string) => void;
  onPromoteRuntimeRetrainingJob: (jobId: string) => void;
  onRefreshDatasetSnapshots: () => void;
  onArchiveDatasetSnapshots: () => void;
  onRestoreDatasetSnapshots: () => void;
  onPurgeExpiredDatasetSnapshots: () => void;
  onRefreshMlflowStatus: () => void;
  onSetMlflowAlias: (name: string, version: string, alias: string) => void;
  onTransitionMlflowStage: (name: string, version: string, stage: MlflowStage) => void;
  onRefreshWorkerDependencies: () => void;
  onRefreshGpuEnvironment: () => void;
  onRefreshEmbeddingEnvironment: () => void;
  onSmokeEmbeddingEnvironment: () => void;
  onInstallWorkerDependencies: () => void;
  onRefreshDockerStatus: () => void;
  onDockerAction: (action: "build" | "up" | "down") => void;
  onRefreshDockerLogs: () => void;
  onInspectDockerRuntime: () => void;
  onSmokeRuntime: () => void;
  onInspectRemoteRuntime: () => void;
  onImportRemoteBlackBoxRuntime: () => void;
  onStartRuntimeRetrainingJob: () => void;
  onRunPlaywrightScrape: () => void;
  onPreviewPlaywrightOpenApiContract: () => void;
  onPreviewPlaywrightScrapeProject: () => void;
  onImportPlaywrightScrapeProject: () => void;
  projectJsonDraft: string;
  setProjectJsonDraft: (value: string) => void;
  applyProjectJson: () => void;
  pipelineJsonDraft: string;
  setPipelineJsonDraft: (value: string) => void;
  applyPipelineJson: () => void;
}) {
  if (!props.project || !props.pipeline) {
    return (
      <div className="panel-fill">
        <div className="empty-state">
          <AlertCircle size={20} />
          <span>Nenhum projeto carregado.</span>
        </div>
      </div>
    );
  }

  if (props.activeTab === "project") {
    return (
      <div className="panel-grid">
        <section>
          <h2>Projeto</h2>
          <dl className="kv">
            <dt>ID</dt>
            <dd>{props.project.id}</dd>
            <dt>Tipo</dt>
            <dd>{props.project.problem.type}</dd>
            <dt>Target</dt>
            <dd>{props.project.problem.target}</dd>
            <dt>Métrica primária</dt>
            <dd>{props.project.metrics.primary}</dd>
            <dt>Persistência</dt>
            <dd>{props.project.runtime.persistence.primary}</dd>
          </dl>
        </section>
        <section>
          <h2>Fontes</h2>
          <div className="item-list">
            {props.project.dataSources.map((source) => (
              <div key={source.id} className="list-row">
                <Database size={16} />
                <span>{source.label}</span>
                <code>{source.type}</code>
                {source.type === "api" && source.api?.mocks?.length ? <code>{source.api.mocks.length} mock(s)</code> : null}
                <button type="button" className="mini-button" onClick={() => props.onPreviewSource(source.id)}>
                  Preview
                </button>
                {source.type === "sql" || source.type === "api" ? (
                  <button type="button" className="mini-button" onClick={() => props.onPreviewSource(source.id, true)}>
                    Real
                  </button>
                ) : null}
                <button type="button" className="mini-button" onClick={() => props.onStartSourcePreviewJob(source.id, source.type !== "csv")}>
                  Preview job
                </button>
                <button type="button" className="mini-button" onClick={() => props.onTrainBaseline(source.id, source.type !== "csv")}>
                  {source.type === "csv" ? "Treinar" : "Treinar real"}
                </button>
                <button type="button" className="mini-button" onClick={() => props.onStartTrainBaselineJob(source.id, source.type !== "csv")}>
                  {source.type === "csv" ? "Job" : "Job real"}
                </button>
              </div>
            ))}
          </div>
        </section>
        {props.project.dataSources.some((source) => source.type === "api") ? (
          <section className="wide-section">
            <h2>Contratos de API</h2>
            <ApiContractsEditor project={props.project} onUpdateProject={props.onUpdateProject} />
          </section>
        ) : null}
        {props.sourcePreview ? (
          <section className="wide-section">
            <h2>Preview de Fonte</h2>
            <SourcePreviewView preview={props.sourcePreview} />
          </section>
        ) : null}
        <section>
          <h2>Classes</h2>
          <div className="chips">
            {props.project.problem.classes.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </section>
      </div>
    );
  }

  if (props.activeTab === "studio") {
    const promotionRules = props.project.promotionPolicy.rules.length;
    return (
      <div className="panel-grid">
        <section>
          <div className="section-title">
            <h2>Resumo do DAG</h2>
            <div className="inline-actions">
              <button type="button" className="command-button" onClick={() => props.onTrainBaseline()}>
                <Play size={16} />
                Treinar baseline
              </button>
              <button type="button" className="command-button" onClick={() => props.onTrainBaseline(undefined, false, true)} disabled={!props.trainingResult}>
                <RefreshCw size={16} />
                Retreinar incremental
              </button>
              <button type="button" className="command-button" onClick={() => props.onStartTrainBaselineJob()}>
                <Terminal size={16} />
                Treinar job
              </button>
              <button type="button" className="command-button" onClick={() => props.onStartTrainBaselineJob(undefined, false, true)} disabled={!props.trainingResult}>
                <Terminal size={16} />
                Retreino job
              </button>
            </div>
          </div>
          <div className="metric-grid">
            <Metric label="Nós" value={props.pipeline.nodes.length} />
            <Metric label="Arestas" value={props.pipeline.edges.length} />
            <Metric label="Modelos" value={props.pipeline.nodes.filter((node) => node.type === "model").length} />
            <Metric label="Python" value={props.pipeline.nodes.filter((node) => node.type === "python_function").length} />
          </div>
        </section>
        <section>
          <div className="section-title">
            <h2>Promoção</h2>
            <div className="inline-actions">
              <button type="button" className="command-button" onClick={props.onRefreshTraining}>
                <RefreshCw size={16} />
                Atualizar
              </button>
              <button
                type="button"
                className="command-button"
                onClick={props.onApplyPromotion}
                disabled={!props.promotionStatus?.candidateModelId || props.promotionStatus.recommendation !== "approve" || props.promotionStatus.applied}
              >
                <CheckCircle2 size={16} />
                Aplicar
              </button>
            </div>
          </div>
          <div className="metric-grid">
            <Metric label="Modo" value={props.project.promotionPolicy.mode} />
            <Metric label="Baseline" value={props.project.promotionPolicy.baseline} />
            <Metric label="Regras" value={promotionRules} />
            <Metric label="Recomendação" value={props.promotionStatus?.recommendation ?? "sem treino"} />
            <Metric label="Aplicada" value={props.promotionStatus?.applied ? "sim" : "não"} />
            <Metric label="Último run" value={props.promotionStatus?.latestRunId ?? "-"} />
            <Metric label="Candidato" value={props.promotionStatus?.candidateModelId ?? "-"} />
          </div>
          {props.promotionStatus?.message ? <p className="muted">{props.promotionStatus.message}</p> : null}
          {props.promotionStatus?.evidence.length ? <EvidenceList evidence={props.promotionStatus.evidence} /> : null}
          <PromotionPolicyEditor project={props.project} promotionStatus={props.promotionStatus} onUpdateProject={props.onUpdateProject} />
        </section>
        <section>
          <div className="section-title">
            <h2>Avaliação</h2>
            <div className="inline-actions">
              <button type="button" className="command-button" onClick={() => props.onEvaluateModel()} disabled={!props.trainingResult}>
                <BarChart3 size={16} />
                Avaliar
              </button>
              <button type="button" className="command-button" onClick={() => props.onStartEvaluateModelJob()} disabled={!props.trainingResult}>
                <Terminal size={16} />
                Job
              </button>
              <button type="button" className="command-button" onClick={() => props.onBacktestModels()} disabled={!props.trainingResult}>
                <GitBranch size={16} />
                Backtest
              </button>
              <button type="button" className="command-button" onClick={() => props.onStartBacktestModelsJob()} disabled={!props.trainingResult}>
                <Terminal size={16} />
                Job backtest
              </button>
            </div>
          </div>
          <div className="backtest-window-controls">
            <label>
              Coluna temporal
              <input value={props.backtestTimeColumn} onChange={(event) => props.setBacktestTimeColumn(event.target.value)} placeholder="created_at" />
            </label>
            <label>
              Início
              <input type="date" value={props.backtestWindowStart} onChange={(event) => props.setBacktestWindowStart(event.target.value)} />
            </label>
            <label>
              Fim
              <input type="date" value={props.backtestWindowEnd} onChange={(event) => props.setBacktestWindowEnd(event.target.value)} />
            </label>
            <label>
              Comparar início
              <input type="date" value={props.backtestComparisonStart} onChange={(event) => props.setBacktestComparisonStart(event.target.value)} />
            </label>
            <label>
              Comparar fim
              <input type="date" value={props.backtestComparisonEnd} onChange={(event) => props.setBacktestComparisonEnd(event.target.value)} />
            </label>
            <label>
              Agregação
              <select value={props.backtestWindowGranularity} onChange={(event) => props.setBacktestWindowGranularity(event.target.value as BacktestWindowGranularity)}>
                <option value="none">Sem agregação</option>
                <option value="day">Diária</option>
                <option value="week">Semanal</option>
                <option value="month">Mensal</option>
                <option value="rolling_7d">Móvel 7 dias</option>
                <option value="rolling_30d">Móvel 30 dias</option>
              </select>
            </label>
          </div>
          {props.evaluationResult ? (
            <EvaluationResultView result={props.evaluationResult} />
          ) : (
            <div className="empty-state">
              <BarChart3 size={18} />
              <span>Nenhuma avaliação executada.</span>
            </div>
          )}
        </section>
        {props.trainingResult ? (
          <section className="wide-section">
            <h2>Treino Selecionado</h2>
            <TrainingResultView result={props.trainingResult} />
          </section>
        ) : null}
        <section className="wide-section">
          <div className="section-title">
            <h2>Fila do Worker</h2>
            <button type="button" className="command-button" onClick={props.onRefreshWorkerJobs}>
              <RefreshCw size={16} />
              Atualizar
            </button>
          </div>
          {props.workerQueueStatus ? (
            <WorkerQueueStatusView status={props.workerQueueStatus} />
          ) : (
            <div className="empty-state">
              <Terminal size={18} />
              <span>Status da fila ainda não carregado.</span>
            </div>
          )}
        </section>
        <section className="wide-section">
          <div className="section-title">
            <h2>Snapshots de Dataset</h2>
            <div className="inline-actions">
              <button type="button" className="command-button" onClick={props.onRefreshDatasetSnapshots}>
                <RefreshCw size={16} />
                Atualizar
              </button>
              <button type="button" className="command-button" onClick={props.onArchiveDatasetSnapshots}>
                <UploadCloud size={16} />
                Arquivar
              </button>
              <button type="button" className="command-button" onClick={props.onRestoreDatasetSnapshots}>
                <DownloadCloud size={16} />
                Restaurar
              </button>
              <button type="button" className="command-button" onClick={props.onPurgeExpiredDatasetSnapshots}>
                <Trash2 size={16} />
                Expurgar vencidos
              </button>
            </div>
          </div>
          {props.datasetSnapshotStatus ? (
            <DatasetSnapshotStatusView status={props.datasetSnapshotStatus} actionResult={props.datasetSnapshotActionResult} />
          ) : (
            <div className="empty-state">
              <Database size={18} />
              <span>Status de snapshots ainda não carregado.</span>
            </div>
          )}
        </section>
        <section className="wide-section">
          <div className="section-title">
            <h2>Jobs do Worker</h2>
            <button type="button" className="command-button" onClick={props.onRefreshWorkerJobs}>
              <RefreshCw size={16} />
              Atualizar
            </button>
          </div>
          <WorkerJobsView jobs={props.workerJobs} onCancel={props.onCancelWorkerJob} onRecover={props.onRecoverWorkerJob} onPromoteRetrainingJob={props.onPromoteRuntimeRetrainingJob} />
        </section>
        {props.trainingRuns.length ? (
          <section className="wide-section">
            <div className="section-title">
              <h2>Histórico de Treinos</h2>
              <span className="muted">{props.trainingRuns.length} run(s)</span>
            </div>
            <TrainingHistoryView runs={props.trainingRuns} selectedRunId={props.trainingResult?.runId ?? ""} onSelect={props.onSelectTrainingRun} />
          </section>
        ) : null}
        {props.evaluationRuns.length ? (
          <section className="wide-section">
            <div className="section-title">
              <h2>Histórico de Avaliações</h2>
              <span className="muted">{props.evaluationRuns.length} run(s)</span>
            </div>
            <EvaluationHistoryView runs={props.evaluationRuns} selectedEvaluationId={props.evaluationResult?.evaluationId ?? ""} onSelect={props.onSelectEvaluationRun} />
          </section>
        ) : null}
        <section>
          <h2>Validação</h2>
          {props.validation ? <Diagnostics diagnostics={props.validation.diagnostics} /> : <div className="empty-state"><CheckCircle2 size={18} /><span>Sem resultado carregado.</span></div>}
        </section>
      </div>
    );
  }

  if (props.activeTab === "artifacts") {
    return (
      <div className="artifact-view">
        <section className="artifact-list">
          <div className="section-title">
            <h2>Artefatos</h2>
            <button type="button" className="command-button" onClick={props.onRefreshArtifacts}>
              <RefreshCw size={16} />
              Atualizar
            </button>
          </div>
          <input value={props.generatedOutDir} onChange={(event) => props.setGeneratedOutDir(event.target.value)} />
          <div className="item-list">
            {(props.artifactListing?.files ?? []).map((file) => (
              <button key={file.path} type="button" className="file-row" onClick={() => props.onReadArtifact(file.path)}>
                <FileCode2 size={15} />
                <span>{file.path}</span>
                <code>{formatBytes(file.sizeBytes)}</code>
              </button>
            ))}
          </div>
        </section>
        <section className="artifact-list">
          <h2>Reimportação</h2>
          <dl className="kv">
            <dt>Origem</dt>
            <dd>{props.generatedOutDir}</dd>
            <dt>Destino</dt>
            <dd>
              <input value={props.importTargetProjectId} onChange={(event) => props.setImportTargetProjectId(event.target.value)} />
            </dd>
            <dt>Zip</dt>
            <dd>
              <input value={props.runtimeZipPath} onChange={(event) => props.setRuntimeZipPath(event.target.value)} />
            </dd>
            <dt>Git</dt>
            <dd>
              <input value={props.runtimeGitUrl} onChange={(event) => props.setRuntimeGitUrl(event.target.value)} />
            </dd>
            <dt>Ref</dt>
            <dd>
              <input value={props.runtimeGitRef} onChange={(event) => props.setRuntimeGitRef(event.target.value)} />
            </dd>
            <dt>Imagem Docker</dt>
            <dd>
              <input value={props.runtimeDockerImage} onChange={(event) => props.setRuntimeDockerImage(event.target.value)} placeholder="mlops/demo-runtime:latest" />
            </dd>
            <dt>Porta</dt>
            <dd>
              <input value={props.runtimeDockerPort} onChange={(event) => props.setRuntimeDockerPort(event.target.value)} inputMode="numeric" />
            </dd>
          </dl>
          <button type="button" className="command-button full-width" onClick={props.onExportRuntimeZip}>
            <FileCode2 size={16} />
            Gerar zip
          </button>
          <button type="button" className="command-button full-width" onClick={props.onValidateGeneratedManifest}>
            <CheckCircle2 size={16} />
            Validar manifestos
          </button>
          {props.manifestValidation ? <ManifestValidationView result={props.manifestValidation} /> : null}
          <button type="button" className="primary-button full-width" onClick={props.onImportRuntimeProject}>
            <UploadCloud size={16} />
            Reimportar .mlops
          </button>
          <button type="button" className="command-button full-width" onClick={props.onImportRuntimeZip}>
            <UploadCloud size={16} />
            Reimportar zip
          </button>
          <button type="button" className="command-button full-width" onClick={props.onImportRuntimeGit} disabled={!props.runtimeGitUrl.trim()}>
            <GitBranch size={16} />
            Reimportar Git
          </button>
          <button type="button" className="command-button full-width" onClick={props.onImportRuntimeDockerImage} disabled={!props.runtimeDockerImage.trim()}>
            <Boxes size={16} />
            Reimportar imagem
          </button>
        </section>
        <section className="artifact-content">
          <h2>{props.artifactFile?.path ?? "Arquivo"}</h2>
          <pre>{props.artifactFile?.content ?? ""}</pre>
        </section>
      </div>
    );
  }

  if (props.activeTab === "runtime") {
    const approvedRetraining = latestApprovedRuntimeRetrainingRequest(props.remoteRuntimeInspection);
    const canStartApprovedRetraining = !!approvedRetraining && !!props.trainingResult;
    return (
      <div className="panel-grid">
        <section>
          <h2>Runtime</h2>
          <dl className="kv">
            <dt>Saída</dt>
            <dd>{props.generatedOutDir}</dd>
            <dt>API</dt>
            <dd>{props.project.runtime.apiName}</dd>
            <dt>Perfil</dt>
            <dd>{props.project.execution.profile}</dd>
            <dt>MLflow</dt>
            <dd>{props.project.runtime.mlflow.enabled ? "habilitado" : "opcional"}</dd>
          </dl>
        </section>
        <section>
          <h2>Endpoints</h2>
          <div className="item-list">
            {["/health", "/metadata", "/environment/gpu", "/model-card", "/models", "/models/active", "/metrics/model", "/metrics/runtime", "/predict", "/feedback", "/feedback/summary", "/retraining/requests", "/retraining/requests/{request_id}/approve", "/retraining/requests/{request_id}/training-set", "/retraining/requests/{request_id}/complete", "/retraining/status", "/evaluate", "/backtest", "/drift", "/drift/latest", "/promotion/status", "/deployment/status", "/deployment/shadow", "/deployment/canary", "/deployment/rollback", "/dashboard"].map((endpoint) => (
              <div key={endpoint} className="list-row">
                <Server size={15} />
                <code>{endpoint}</code>
              </div>
            ))}
          </div>
        </section>
        <section className="wide-section">
          <div className="section-title">
            <h2>MLflow</h2>
            <button type="button" className="command-button" onClick={props.onRefreshMlflowStatus}>
              <RefreshCw size={16} />
              Atualizar
            </button>
          </div>
          {props.mlflowStatus ? (
            <MlflowIntegrationView
              status={props.mlflowStatus}
              catalog={props.mlflowCatalog}
              onSetAlias={props.onSetMlflowAlias}
              onTransitionStage={props.onTransitionMlflowStage}
            />
          ) : <div className="empty-state"><Server size={18} /><span>Status MLflow não carregado.</span></div>}
        </section>
        <section className="wide-section">
          <div className="section-title">
            <h2>Docker</h2>
            <div className="inline-actions">
              <button type="button" className="command-button" onClick={props.onRefreshDockerStatus}>
                <RefreshCw size={16} />
                Atualizar
              </button>
              <button type="button" className="command-button" onClick={() => props.onDockerAction("build")} disabled={!props.dockerStatus?.composeExists}>
                Build
              </button>
              <button type="button" className="command-button" onClick={() => props.onDockerAction("up")} disabled={!props.dockerStatus?.composeExists}>
                Up
              </button>
              <button type="button" className="command-button" onClick={() => props.onDockerAction("down")} disabled={!props.dockerStatus?.composeExists}>
                Down
              </button>
              <button type="button" className="command-button" onClick={props.onRefreshDockerLogs} disabled={!props.dockerStatus?.composeExists}>
                Logs
              </button>
              <button type="button" className="command-button" onClick={props.onInspectDockerRuntime} disabled={!props.dockerStatus?.composeExists}>
                Inspect
              </button>
            </div>
          </div>
          {props.dockerStatus ? <DockerRuntimeView status={props.dockerStatus} /> : <div className="empty-state"><Server size={18} /><span>Status Docker não carregado.</span></div>}
          <DockerRuntimeHistoryView history={props.dockerHistory} />
          {props.dockerInspect ? <DockerRuntimeInspectView inspect={props.dockerInspect} /> : null}
          {props.dockerLogs ? <DockerRuntimeLogsView logs={props.dockerLogs} /> : null}
          <div className="smoke-row">
            <input value={props.runtimeBaseUrl} onChange={(event) => props.setRuntimeBaseUrl(event.target.value)} />
            <button type="button" className="primary-button" onClick={props.onSmokeRuntime}>
              <Play size={16} />
              Smoke
            </button>
          </div>
          {props.runtimeSmokeResult ? <RuntimeSmokeView result={props.runtimeSmokeResult} /> : null}
        </section>
        <section className="wide-section">
          <div className="section-title">
            <h2>Runtime remoto</h2>
            <div className="inline-actions">
              <button type="button" className="command-button" onClick={props.onInspectRemoteRuntime}>
                <Network size={16} />
                Inspecionar
              </button>
              <button type="button" className="command-button" onClick={props.onImportRemoteBlackBoxRuntime} disabled={!props.remoteRuntimeUrl.trim()}>
                <UploadCloud size={16} />
                Importar black-box
              </button>
              <button type="button" className="command-button" onClick={props.onStartRuntimeRetrainingJob} disabled={!canStartApprovedRetraining}>
                <RefreshCw size={16} />
                Rodar retreino aprovado
              </button>
            </div>
          </div>
          <div className="smoke-row">
            <input value={props.remoteRuntimeUrl} onChange={(event) => props.setRemoteRuntimeUrl(event.target.value)} />
            <button type="button" className="primary-button" onClick={props.onInspectRemoteRuntime}>
              <RefreshCw size={16} />
              Checar
            </button>
          </div>
          {props.remoteRuntimeInspection ? (
            <RemoteRuntimeInspectionView result={props.remoteRuntimeInspection} />
          ) : (
            <div className="empty-state"><Network size={18} /><span>Runtime remoto não inspecionado.</span></div>
          )}
          {approvedRetraining ? (
            <div className="node-execution-meta">
              <code>retreino aprovado: {approvedRetraining.requestId}</code>
              <code>base local: {props.trainingResult?.runId ?? "selecione um treino"}</code>
            </div>
          ) : null}
        </section>
        <section className="wide-section">
          <div className="section-title">
            <h2>Scraping Playwright</h2>
            <div className="inline-actions">
              <button type="button" className="command-button" onClick={props.onRunPlaywrightScrape} disabled={!props.playwrightScrapeUrl.trim()}>
                <Network size={16} />
                Scrapear/crawlear
              </button>
              <button type="button" className="command-button" onClick={props.onPreviewPlaywrightScrapeProject} disabled={!props.playwrightScrapeResult?.reportPath}>
                <FileText size={16} />
                Pré-visualizar importação
              </button>
              <button type="button" className="command-button" onClick={props.onPreviewPlaywrightOpenApiContract} disabled={!props.playwrightScrapeImportSources.some((source) => source.include && source.url.trim())}>
                <FileText size={16} />
                Validar OpenAPI
              </button>
              <button type="button" className="command-button" onClick={props.onImportPlaywrightScrapeProject} disabled={!props.playwrightScrapeResult?.reportPath}>
                <UploadCloud size={16} />
                Importar scrape
              </button>
            </div>
          </div>
          <p className="muted">Inspeciona uma página e links internos limitados, grava relatório auditável e destaca candidatos OpenAPI/Swagger/Redoc.</p>
          <div className="smoke-row">
            <input value={props.playwrightScrapeUrl} onChange={(event) => props.setPlaywrightScrapeUrl(event.target.value)} placeholder="https://exemplo.local/docs" />
            <button type="button" className="primary-button" onClick={props.onRunPlaywrightScrape} disabled={!props.playwrightScrapeUrl.trim()}>
              <RefreshCw size={16} />
              Executar
            </button>
          </div>
          <div className="config-grid">
            <label>Profundidade<input type="number" min="0" max="5" value={props.playwrightMaxDepth} onChange={(event) => props.setPlaywrightMaxDepth(event.target.value)} /></label>
            <label>Páginas<input type="number" min="1" max="50" value={props.playwrightMaxPages} onChange={(event) => props.setPlaywrightMaxPages(event.target.value)} /></label>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={props.playwrightDeepCrawl} onChange={(event) => props.setPlaywrightDeepCrawl(event.target.checked)} />
            Confirmar crawl profundo acima de 2 níveis ou 10 páginas
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={props.playwrightAuthEnabled} onChange={(event) => props.setPlaywrightAuthEnabled(event.target.checked)} />
            Usar login controlado por formulário
          </label>
          {props.playwrightAuthEnabled ? (
            <div className="config-grid">
              <label>Login URL<input value={props.playwrightAuthLoginUrl} onChange={(event) => props.setPlaywrightAuthLoginUrl(event.target.value)} placeholder="vazio = URL alvo" /></label>
              <label>Usuário<input value={props.playwrightAuthUsername} onChange={(event) => props.setPlaywrightAuthUsername(event.target.value)} placeholder="usuario ou email" /></label>
              <label>Seletor usuário<input value={props.playwrightAuthUsernameSelector} onChange={(event) => props.setPlaywrightAuthUsernameSelector(event.target.value)} placeholder="#username" /></label>
              <label>Seletor senha<input value={props.playwrightAuthPasswordSelector} onChange={(event) => props.setPlaywrightAuthPasswordSelector(event.target.value)} placeholder={'input[type="password"]'} /></label>
              <label>Password ref<input value={props.playwrightAuthPasswordRef} onChange={(event) => props.setPlaywrightAuthPasswordRef(event.target.value)} placeholder="env:MLOPS_SCRAPE_PASSWORD" /></label>
              <label>Seletor submit<input value={props.playwrightAuthSubmitSelector} onChange={(event) => props.setPlaywrightAuthSubmitSelector(event.target.value)} placeholder={'button[type="submit"]'} /></label>
              <label>Seletor sucesso<input value={props.playwrightAuthSuccessSelector} onChange={(event) => props.setPlaywrightAuthSuccessSelector(event.target.value)} placeholder="#app, .dashboard, h1" /></label>
            </div>
          ) : null}
          {props.playwrightScrapeResult ? (
            <PlaywrightScrapeView result={props.playwrightScrapeResult} />
          ) : (
            <div className="empty-state"><Network size={18} /><span>Nenhuma página scrapeada nesta sessão.</span></div>
          )}
          <PlaywrightScrapeImportEditor sources={props.playwrightScrapeImportSources} onChange={props.onUpdatePlaywrightScrapeImportSource} />
          {props.playwrightOpenApiPreview ? (
            <OpenApiContractPreviewView
              preview={props.playwrightOpenApiPreview}
              onApplyOperation={props.onApplyPlaywrightOpenApiOperation}
              onSmokeOperation={props.onSmokePlaywrightOpenApiOperation}
            />
          ) : null}
          {props.playwrightOpenApiSmoke ? <OpenApiOperationSmokeView result={props.playwrightOpenApiSmoke} /> : null}
          {props.playwrightScrapePreview ? <PlaywrightScrapeImportPreviewView preview={props.playwrightScrapePreview} /> : null}
        </section>
        <section className="wide-section">
          <div className="section-title">
            <h2>GPU/CUDA</h2>
            <button type="button" className="command-button" onClick={props.onRefreshGpuEnvironment}>
              <RefreshCw size={16} />
              Atualizar
            </button>
          </div>
          {props.gpuEnvironment ? <GpuEnvironmentView status={props.gpuEnvironment} /> : <div className="empty-state"><Gauge size={18} /><span>Ambiente GPU/CUDA não carregado.</span></div>}
        </section>
        <section className="wide-section">
          <div className="section-title">
            <h2>Embeddings/BERT</h2>
            <div className="inline-actions">
              <button type="button" className="command-button" onClick={props.onRefreshEmbeddingEnvironment}>
                <RefreshCw size={16} />
                Checar
              </button>
              <button type="button" className="command-button" onClick={props.onSmokeEmbeddingEnvironment}>
                <Play size={16} />
                Smoke
              </button>
            </div>
          </div>
          <div className="embedding-smoke-controls">
            <label>
              Modelo
              <input value={props.embeddingSmokeModel} onChange={(event) => props.setEmbeddingSmokeModel(event.target.value)} />
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={props.embeddingSmokeLocalOnly} onChange={(event) => props.setEmbeddingSmokeLocalOnly(event.target.checked)} />
              Usar somente cache local
            </label>
          </div>
          {props.embeddingEnvironment ? <EmbeddingEnvironmentView status={props.embeddingEnvironment} /> : <div className="empty-state"><Network size={18} /><span>Ambiente de embeddings não carregado.</span></div>}
        </section>
        <section className="wide-section">
          <div className="section-title">
            <h2>Ambiente Python</h2>
            <div className="inline-actions">
              <button type="button" className="command-button" onClick={props.onRefreshWorkerDependencies}>
                <RefreshCw size={16} />
                Atualizar
              </button>
              <button type="button" className="command-button" onClick={props.onInstallWorkerDependencies}>
                <UploadCloud size={16} />
                Instalar opcionais
              </button>
            </div>
          </div>
          {props.workerDependencies ? <WorkerDependenciesView dependencies={props.workerDependencies} /> : <div className="empty-state"><Terminal size={18} /><span>Ambiente não carregado.</span></div>}
        </section>
      </div>
    );
  }

  return (
    <div className="settings-grid">
      <section>
        <div className="section-title">
          <h2>project.yaml</h2>
          <button type="button" className="command-button" onClick={props.applyProjectJson}>
            Aplicar
          </button>
        </div>
        <textarea value={props.projectJsonDraft} onChange={(event) => props.setProjectJsonDraft(event.target.value)} spellCheck={false} />
      </section>
      <section>
        <div className="section-title">
          <h2>pipeline.flow.json</h2>
          <button type="button" className="command-button" onClick={props.applyPipelineJson}>
            Aplicar
          </button>
        </div>
        <textarea value={props.pipelineJsonDraft} onChange={(event) => props.setPipelineJsonDraft(event.target.value)} spellCheck={false} />
      </section>
    </div>
  );
}

function ManifestValidationView({ result }: { result: ArtifactManifestValidationResult }) {
  return (
    <div className={`diagnostic ${result.status === "ok" ? "info" : "error"}`}>
      <strong>{result.status === "ok" ? "manifestos_ok" : "manifestos_error"}</strong>
      <span>
        {result.packagePath} · {result.summary.files} arquivos · {formatBytes(result.summary.totalSizeBytes)}
      </span>
      <small>
        {result.summary.errors} erro(s), {result.summary.warnings} aviso(s), {result.summary.infos} info(s)
      </small>
      {result.manifest ? (
        <small>
          Projeto {result.manifest.projectId}; modelo ativo {result.manifest.activeModelId}; {result.manifest.endpoints.length} endpoint(s)
        </small>
      ) : null}
      {result.summary.missingRequiredFiles.length ? (
        <div className="manifest-diagnostic-list">
          {result.summary.missingRequiredFiles.map((file) => (
            <code key={file}>{file}</code>
          ))}
        </div>
      ) : null}
      {result.diagnostics.length ? (
        <div className="manifest-diagnostic-list">
          {result.diagnostics.slice(0, 8).map((diagnostic, index) => (
            <div key={`${diagnostic.code}-${index}`} className={`dependency-row ${diagnostic.severity === "error" ? "missing" : "installed"}`}>
              <AlertCircle size={15} />
              <div>
                <strong>{diagnostic.code}</strong>
                <span>{diagnostic.message}</span>
                {diagnostic.path ? <small>{diagnostic.path}</small> : null}
              </div>
              <code>{diagnostic.severity}</code>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FlowNodeLabel({ label, sublabel, state }: { label: string; sublabel: string; state: NodeExecutionState | null }) {
  return (
    <div className="flow-node-label">
      <div className="flow-node-title-row">
        <span className={`node-status-dot ${state?.status ?? "idle"}`} />
        <strong>{label}</strong>
      </div>
      <div className="flow-node-meta">
        <span>{sublabel}</span>
        {state ? <span className="node-state-text">{nodeExecutionStatusLabel(state.status)}</span> : null}
      </div>
    </div>
  );
}

function NodeExecutionSummary({ state }: { state: NodeExecutionState }) {
  return (
    <div className={`node-execution-summary ${state.status}`}>
      <div>
        <strong>{state.label}</strong>
        <span>{nodeExecutionStatusLabel(state.status)}</span>
      </div>
      {state.detail ? <p>{state.detail}</p> : null}
      <div className="node-execution-meta">
        <code>{state.source}</code>
        {state.jobId ? <code>{state.jobId}</code> : null}
        {state.updatedAt ? <code>{formatDateTime(state.updatedAt)}</code> : null}
      </div>
    </div>
  );
}

function NodeInspector(props: {
  node: PipelineNode;
  project: MLOpsProject | null;
  onChange: (patch: Partial<PipelineNode>) => void;
  diagnostics: Diagnostic[];
  executionState: NodeExecutionState | null;
  pythonInputDraft: string;
  setPythonInputDraft: (value: string) => void;
  pythonRunResult: PythonRunResult | null;
  onRunPython: () => void;
  onRunPythonJob: () => void;
}) {
  const configText = JSON.stringify(props.node.config ?? {}, null, 2);
  return (
    <div className="inspector-body">
      {props.executionState ? <NodeExecutionSummary state={props.executionState} /> : null}
      <label>
        ID
        <input value={props.node.id} onChange={(event) => props.onChange({ id: event.target.value })} />
      </label>
      <label>
        Tipo
        <select value={props.node.type} onChange={(event) => props.onChange({ type: event.target.value as NodeType })}>
          {nodeTypeOptions.map((item) => (
            <option key={item.type} value={item.type}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Rótulo
        <input value={props.node.label ?? ""} onChange={(event) => props.onChange({ label: event.target.value })} />
      </label>
      {props.node.type === "data_source" ? (
        <label>
          Fonte
          <select value={props.node.dataSourceId ?? ""} onChange={(event) => props.onChange({ dataSourceId: event.target.value })}>
            <option value="">Sem fonte</option>
            {(props.project?.dataSources ?? []).map((source) => (
              <option key={source.id} value={source.id}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {props.node.type === "model" || props.node.type === "embedding" ? (
        <>
          <label>
            Algoritmo
            <input value={props.node.algorithm ?? ""} onChange={(event) => props.onChange({ algorithm: event.target.value })} />
          </label>
          <label>
            Framework
            <input value={props.node.framework ?? ""} onChange={(event) => props.onChange({ framework: event.target.value })} />
          </label>
          <label>
            Papel
            <select value={props.node.modelRole ?? "candidate"} onChange={(event) => props.onChange({ modelRole: event.target.value as PipelineNode["modelRole"] })}>
              <option value="candidate">candidate</option>
              <option value="active">active</option>
              <option value="baseline">baseline</option>
              <option value="shadow">shadow</option>
            </select>
          </label>
        </>
      ) : null}
      {props.node.type === "python_function" ? (
        <>
          <label>
            Entry point
            <input value={props.node.python?.entrypoint ?? "run"} onChange={(event) => props.onChange({ python: { ...defaultPython(props.node), entrypoint: event.target.value } })} />
          </label>
          <label>
            Política de rede
            <select value={props.node.python?.networkPolicy ?? "none"} onChange={(event) => props.onChange({ python: { ...defaultPython(props.node), networkPolicy: event.target.value as "none" | "allowlist" | "open" } })}>
              <option value="none">none</option>
              <option value="allowlist">allowlist</option>
              <option value="open">open</option>
            </select>
          </label>
          <label>
            Isolamento
            <select value={props.node.python?.isolationMode ?? "process"} onChange={(event) => props.onChange({ python: { ...defaultPython(props.node), isolationMode: event.target.value as "process" | "container" } })}>
              <option value="process">processo</option>
              <option value="container">container</option>
            </select>
          </label>
          <label>
            Hosts permitidos
            <textarea className="short-textarea" value={(props.node.python?.allowedHosts ?? []).join("\n")} onChange={(event) => props.onChange({ python: { ...defaultPython(props.node), allowedHosts: splitList(event.target.value) } })} spellCheck={false} />
          </label>
          <label>
            Mocks HTTP
            <textarea key={`${props.node.id}-http-mocks`} className="short-textarea" defaultValue={formatJson(props.node.python?.mocks ?? [])} onBlur={(event) => updateJsonArrayField(event, (mocks) => props.onChange({ python: { ...defaultPython(props.node), mocks } }))} spellCheck={false} />
          </label>
          <label>
            Código
            <textarea value={props.node.python?.codeInline ?? ""} onChange={(event) => props.onChange({ python: { ...defaultPython(props.node), codeInline: event.target.value } })} spellCheck={false} />
          </label>
          <label>
            Input de teste
            <textarea className="short-textarea" value={props.pythonInputDraft} onChange={(event) => props.setPythonInputDraft(event.target.value)} spellCheck={false} />
          </label>
          <div className="inline-actions">
            <button type="button" className="primary-button" onClick={props.onRunPython}>
              <Play size={16} />
              Executar
            </button>
            <button type="button" className="command-button" onClick={props.onRunPythonJob}>
              <Terminal size={16} />
              Job
            </button>
          </div>
          {props.pythonRunResult ? (
            <div className="result-box">
              <strong>Saída</strong>
              <span>isolamento: {props.pythonRunResult.isolation ?? "processo"}</span>
              <pre>{formatJson(props.pythonRunResult.output)}</pre>
              {props.pythonRunResult.stdout.length ? <pre>{props.pythonRunResult.stdout.join("\n")}</pre> : null}
              {props.pythonRunResult.networkCalls?.length ? <pre>{formatJson(props.pythonRunResult.networkCalls)}</pre> : null}
            </div>
          ) : null}
        </>
      ) : null}
      <label>
        Config
        <textarea value={configText} onChange={(event) => updateJsonField(event, (config) => props.onChange({ config }))} spellCheck={false} />
      </label>
      <label>
        Dependências
        <input value={(props.node.dependencies ?? []).join(", ")} onChange={(event) => props.onChange({ dependencies: splitList(event.target.value) })} />
      </label>
      {props.diagnostics.length ? <Diagnostics diagnostics={props.diagnostics} /> : null}
    </div>
  );
}

function EdgeInspector(props: { edge: PipelineEdge; onChange: (edge: PipelineEdge) => void }) {
  return (
    <div className="inspector-body">
      <label>
        Origem
        <input value={props.edge.from} onChange={(event) => props.onChange({ ...props.edge, from: event.target.value })} />
      </label>
      <label>
        Destino
        <input value={props.edge.to} onChange={(event) => props.onChange({ ...props.edge, to: event.target.value })} />
      </label>
      <label>
        Condição
        <input value={props.edge.condition ?? ""} onChange={(event) => props.onChange({ ...props.edge, condition: event.target.value || undefined })} />
      </label>
    </div>
  );
}

function Diagnostics({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return (
    <div className="diagnostics">
      {diagnostics.length ? (
        diagnostics.map((diagnostic, index) => (
          <div key={`${diagnostic.code}-${index}`} className={`diagnostic ${diagnostic.severity}`}>
            <strong>{diagnostic.code}</strong>
            <span>{diagnostic.message}</span>
          </div>
        ))
      ) : (
        <div className="diagnostic info">
          <strong>ok</strong>
          <span>Sem diagnósticos.</span>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ApiContractsEditor(props: { project: MLOpsProject; onUpdateProject: React.Dispatch<React.SetStateAction<MLOpsProject | null>> }) {
  const apiSources = props.project.dataSources.filter((source) => source.type === "api");
  return (
    <div className="api-mocks-editor">
      {apiSources.map((source) => {
        const mocks = normalizeApiMocks(source.api?.mocks);
        const pagination = isRecord(source.api?.pagination) ? source.api.pagination : { mode: "none" };
        return (
          <div key={source.id} className="mock-source">
            <div className="mock-source-header">
              <div>
                <strong>{source.label}</strong>
                <code>{source.id}</code>
              </div>
              <button type="button" className="mini-button" onClick={() => props.onUpdateProject((project) => addApiMock(project, source.id))}>
                Adicionar mock
              </button>
            </div>
            <div className="api-contract-grid">
              <label>
                Método
                <select value={source.api?.method ?? "GET"} onChange={(event) => props.onUpdateProject((project) => updateApiSourceContract(project, source.id, { method: event.target.value }))}>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                  <option value="DELETE">DELETE</option>
                </select>
              </label>
              <label>
                URL
                <input value={source.api?.url ?? ""} onChange={(event) => props.onUpdateProject((project) => updateApiSourceContract(project, source.id, { url: event.target.value }))} placeholder="https://api.example.local/tickets" />
              </label>
              <label>
                Timeout
                <input type="number" min={1} max={300} value={source.api?.timeoutSeconds ?? 30} onChange={(event) => props.onUpdateProject((project) => updateApiSourceContract(project, source.id, { timeoutSeconds: Math.max(1, Math.min(Number(event.target.value) || 30, 300)) }))} />
              </label>
              <label>
                Paginação
                <select value={String(pagination.mode ?? "none")} onChange={(event) => props.onUpdateProject((project) => updateApiSourcePagination(project, source.id, { mode: event.target.value }))}>
                  <option value="none">none</option>
                  <option value="page">page</option>
                  <option value="cursor">cursor</option>
                </select>
              </label>
              <label>
                Page param
                <input value={String(pagination.pageParam ?? "")} onChange={(event) => props.onUpdateProject((project) => updateApiSourcePagination(project, source.id, { pageParam: event.target.value || undefined }))} placeholder="page" />
              </label>
              <label>
                Cursor path
                <input value={String(pagination.cursorPath ?? "")} onChange={(event) => props.onUpdateProject((project) => updateApiSourcePagination(project, source.id, { cursorPath: event.target.value || undefined }))} placeholder="meta.next_cursor" />
              </label>
            </div>
            <div className="api-contract-json-grid">
              <label>
                Headers por referência
                <textarea
                  key={`${source.id}-headers`}
                  className="short-textarea"
                  defaultValue={formatJson(source.api?.headers ?? {})}
                  onBlur={(event) => props.onUpdateProject((project) => updateApiSourceJsonContract(project, source.id, "headers", event.target.value))}
                  spellCheck={false}
                />
              </label>
              <label>
                Body template
                <textarea
                  key={`${source.id}-body-template`}
                  className="short-textarea"
                  defaultValue={formatJson(source.api?.bodyTemplate ?? {})}
                  onBlur={(event) => props.onUpdateProject((project) => updateApiSourceJsonContract(project, source.id, "bodyTemplate", event.target.value))}
                  spellCheck={false}
                />
              </label>
            </div>
            {mocks.length ? (
              <div className="mock-list">
                {mocks.map((mock, index) => {
                  const request = isRecord(mock.request) ? mock.request : {};
                  const response = isRecord(mock.response) ? mock.response : {};
                  return (
                    <div key={`${source.id}-${index}`} className="mock-card">
                      <div className="mock-grid">
                        <label>
                          ID
                          <input value={String(mock.id ?? "")} onChange={(event) => props.onUpdateProject((project) => updateApiMock(project, source.id, index, { id: event.target.value }))} />
                        </label>
                        <label>
                          Método
                          <select value={String(request.method ?? source.api?.method ?? "GET")} onChange={(event) => props.onUpdateProject((project) => updateApiMockRequest(project, source.id, index, { method: event.target.value }))}>
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                            <option value="PUT">PUT</option>
                            <option value="PATCH">PATCH</option>
                            <option value="DELETE">DELETE</option>
                          </select>
                        </label>
                        <label>
                          Path
                          <input value={String(request.path ?? "/")} onChange={(event) => props.onUpdateProject((project) => updateApiMockRequest(project, source.id, index, { path: event.target.value }))} />
                        </label>
                        <label>
                          Status
                          <input type="number" value={Number(response.httpStatus ?? response.statusCode ?? 200)} onChange={(event) => props.onUpdateProject((project) => updateApiMockResponse(project, source.id, index, { httpStatus: Number(event.target.value) || 200 }))} />
                        </label>
                      </div>
                      <label>
                        Descrição
                        <input value={String(mock.description ?? "")} onChange={(event) => props.onUpdateProject((project) => updateApiMock(project, source.id, index, { description: event.target.value || undefined }))} />
                      </label>
                      <label>
                        Corpo da resposta
                        <textarea
                          key={`${source.id}-${index}-body`}
                          className="short-textarea"
                          defaultValue={formatJson(response.body ?? {})}
                          onBlur={(event) => props.onUpdateProject((project) => updateApiMockResponseBody(project, source.id, index, event.target.value))}
                          spellCheck={false}
                        />
                      </label>
                      <div className="inline-actions">
                        <button type="button" className="mini-button danger" onClick={() => props.onUpdateProject((project) => removeApiMock(project, source.id, index))}>
                          Remover
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted">Nenhum mock persistido nesta fonte.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SourcePreviewView({ preview }: { preview: SourcePreviewResult }) {
  return (
    <div className="preview-view">
      <div className="metric-grid">
        <Metric label="Fonte" value={preview.sourceId} />
        <Metric label="Status" value={preview.status} />
        <Metric label="Linhas" value={preview.rowCount ?? "-"} />
        <Metric label="Modo" value={preview.mode ?? preview.sourceType} />
        {preview.httpStatus ? <Metric label="HTTP" value={preview.httpStatus} /> : null}
      </div>
      {preview.message ? <p className="muted">{preview.message}</p> : null}
      {preview.columns?.length ? (
        <div className="chips">
          {preview.columns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
      ) : null}
      {preview.sample?.length ? <pre>{formatJson(preview.sample)}</pre> : null}
    </div>
  );
}

function TrainingResultView({ result }: { result: TrainingResult }) {
  return (
    <div className="training-view">
      <div className="metric-grid">
        <Metric label="Run" value={result.runId} />
        <Metric label="Fonte" value={result.sourceId} />
        <Metric label="Modo" value={result.sourceMode ?? result.sourceType ?? "-"} />
        <Metric label="Linhas" value={result.rowCount} />
        <Metric label="Target" value={result.target} />
        <Metric label="Melhor modelo" value={result.bestModelId} />
        <Metric label="Modo de treino" value={result.trainingMode === "incremental" ? "incremental" : "completo"} />
        {result.baseRunId ? <Metric label="Run base" value={result.baseRunId} /> : null}
      </div>
      {result.incremental ? (
        <p className="node-execution-meta">
          Retreino incremental: {result.incremental.appliedModels?.length ?? 0} modelo(s) atualizados por incremento; {result.incremental.fallbackModels?.length ?? 0} com retreino completo.
        </p>
      ) : null}
      <div className="leaderboard">
        {result.leaderboard.map((model) => (
          <div key={model.modelId} className="leaderboard-row">
            <div>
              <strong>{model.label}</strong>
              <span>{model.trainingBackend ? `${model.trainingBackend} · ${model.trainedAlgorithm ?? model.algorithm}` : model.algorithm}</span>
              {model.incremental ? <span>{model.incremental.applied === true ? "incremental aplicado" : "fallback completo"}</span> : null}
            </div>
            <code>{result.primaryMetric}: {String(model.metrics[result.primaryMetric] ?? "-")}</code>
            <code>validação: {model.validationRows}</code>
          </div>
        ))}
      </div>
      {result.mlflow ? <MlflowRunView mlflow={result.mlflow} /> : null}
      <EvidenceList evidence={result.promotionEvidence} />
    </div>
  );
}

function EvaluationResultView({ result }: { result: EvaluationResult }) {
  const isBacktest = result.kind === "backtest_result";
  return (
    <div className="training-view">
      <div className="metric-grid">
        <Metric label={isBacktest ? "Backtest" : "Avaliação"} value={result.evaluationId} />
        <Metric label={isBacktest ? "Baseline" : "Modelo"} value={result.baselineModelId ?? result.modelId ?? "-"} />
        {isBacktest ? <Metric label="Recomendado" value={result.recommendedModelId ?? "-"} /> : null}
        {isBacktest ? <Metric label="Decisão" value={result.recommendation ?? "review"} /> : null}
        <Metric label="Run" value={result.runId ?? "-"} />
        <Metric label="Fonte" value={result.sourceId} />
        <Metric label="Linhas" value={result.rowCount} />
        <Metric label={result.primaryMetric} value={String(result.metrics[result.primaryMetric] ?? "-")} />
      </div>
      {isBacktest && result.modelMetrics ? (
        <div className="leaderboard">
          {Object.entries(result.modelMetrics).map(([modelId, metrics]) => (
            <div key={modelId} className="leaderboard-row">
              <div>
                <strong>{modelId}</strong>
                <span>{modelId === result.baselineModelId ? "baseline" : modelId === result.recommendedModelId ? "recomendado" : "candidato"}</span>
              </div>
              <code>{result.primaryMetric}</code>
              <code>{String(metrics[result.primaryMetric] ?? "-")}</code>
            </div>
          ))}
        </div>
      ) : null}
      {isBacktest && result.temporalWindow ? (
        <div className="metric-grid">
          <Metric label="Coluna temporal" value={result.temporalWindow.timeColumn ?? "-"} />
          <Metric label="Início" value={result.temporalWindow.start ?? "-"} />
          <Metric label="Fim" value={result.temporalWindow.end ?? "-"} />
          <Metric label="Linhas na janela" value={result.temporalWindow.matchedRows ?? "-"} />
          <Metric label="Linhas totais" value={result.temporalWindow.totalRows ?? "-"} />
          <Metric label="Ignoradas" value={result.temporalWindow.excludedRows ?? "-"} />
        </div>
      ) : null}
      {isBacktest && result.windowResults?.length ? (
        <div className="leaderboard">
          {result.windowResults.map((windowResult) => (
            <div key={windowResult.id} className="leaderboard-row">
              <div>
                <strong>{windowResult.label ?? windowResult.id}</strong>
                <span>{windowResult.start ?? "-"} a {windowResult.end ?? "-"} · {windowResult.rowCount} linha(s)</span>
              </div>
              <code>{windowResult.recommendation ?? "review"}</code>
              <code>{windowResult.recommendedModelId ?? "-"}</code>
            </div>
          ))}
        </div>
      ) : null}
      {isBacktest && result.periodComparison ? (
        <>
          <div className="metric-grid">
            <Metric label="Comparação início" value={result.periodComparison.comparisonWindow?.start ?? "-"} />
            <Metric label="Comparação fim" value={result.periodComparison.comparisonWindow?.end ?? "-"} />
            <Metric label="Linhas referência" value={result.periodComparison.rowCount} />
            <Metric label="Modelo referência" value={result.periodComparison.recommendedModelId ?? "-"} />
          </div>
          {result.periodComparison.deltas?.length ? (
            <div className="leaderboard">
              {result.periodComparison.deltas.map((delta) => (
                <div key={delta.modelId} className="leaderboard-row">
                  <div>
                    <strong>{delta.modelId}</strong>
                    <span>{delta.reason ?? "Comparação entre período analisado e referência"}</span>
                  </div>
                  <code>{delta.metric ?? result.primaryMetric}</code>
                  <code>{delta.delta === null || delta.delta === undefined ? "-" : String(delta.delta)}</code>
                </div>
              ))}
            </div>
          ) : null}
          {result.periodComparison.evidence?.length ? <EvidenceList evidence={result.periodComparison.evidence} /> : null}
        </>
      ) : null}
      {isBacktest && result.evidence?.length ? <EvidenceList evidence={result.evidence} /> : null}
      <div className="leaderboard">
        {Object.entries(result.metrics)
          .filter(([, value]) => typeof value === "number")
          .slice(0, 8)
          .map(([key, value]) => (
            <div key={key} className="leaderboard-row">
              <div>
                <strong>{key}</strong>
                <span>snapshot de avaliação</span>
              </div>
              <code>{String(value)}</code>
            </div>
          ))}
      </div>
      {result.sample.length ? <pre>{formatJson(result.sample)}</pre> : null}
    </div>
  );
}

function MlflowRunView({ mlflow }: { mlflow: NonNullable<TrainingResult["mlflow"]> }) {
  const className = mlflow.status === "logged" ? "info" : mlflow.status === "disabled" ? "warning" : "error";
  return (
    <div className={`diagnostic ${className}`}>
      <strong>mlflow_{mlflow.status}</strong>
      <span>{mlflow.experimentName ?? mlflow.reason ?? mlflow.message ?? "Integração MLflow não registrou este treino."}</span>
      {mlflow.runId ? <code>{mlflow.runId}</code> : null}
    </div>
  );
}

function MlflowIntegrationView(props: {
  status: MlflowIntegrationStatus;
  catalog: MlflowCatalog | null;
  onSetAlias: (name: string, version: string, alias: string) => void;
  onTransitionStage: (name: string, version: string, stage: MlflowStage) => void;
}) {
  const { status, catalog } = props;
  return (
    <div className="dependency-view">
      <div className="metric-grid">
        <Metric label="Configuração" value={status.enabled ? "habilitado" : "opcional"} />
        <Metric label="Tracking URI" value={status.trackingUri ?? status.trackingUriRef ?? "-"} />
        <Metric label="Health" value={status.health.reachable ? "online" : "offline"} />
        <Metric label="Registry" value={status.registryEnabled ? "habilitado" : "desligado"} />
      </div>
      <div className="dependency-list">
        <div className={`dependency-row ${status.health.reachable ? "installed" : "missing"}`}>
          <Server size={15} />
          <div>
            <strong>{status.health.url ?? "MLflow tracking"}</strong>
            <span>{status.health.message}</span>
          </div>
          <code>{status.health.statusCode ?? "-"}</code>
        </div>
        <div className={`dependency-row ${status.workerPackage.installed ? "installed" : "missing"}`}>
          <Terminal size={15} />
          <div>
            <strong>pacote mlflow</strong>
            <span>{status.workerPackage.requirement ?? status.workerPackage.error ?? "worker Python"}</span>
          </div>
          <code>{status.workerPackage.installed ? status.workerPackage.version ?? "instalado" : "ausente"}</code>
        </div>
        <div className={`dependency-row ${status.localCompose.exists ? "installed" : "missing"}`}>
          <FileCode2 size={15} />
          <div>
            <strong>compose local</strong>
            <span>{status.localCompose.path}</span>
          </div>
          <code>{status.localCompose.exists ? "ok" : "ausente"}</code>
        </div>
        {status.latestRun ? (
          <div className={`dependency-row ${status.latestRun.mlflowStatus === "logged" ? "installed" : "missing"}`}>
            <History size={15} />
            <div>
              <strong>{status.latestRun.runId ?? "último treino"}</strong>
              <span>{status.latestRun.experimentName ?? status.latestRun.message ?? "sem run externo registrado"}</span>
            </div>
            <code>{status.latestRun.mlflowStatus}</code>
          </div>
        ) : null}
      </div>
      {catalog ? <MlflowCatalogView catalog={catalog} onSetAlias={props.onSetAlias} onTransitionStage={props.onTransitionStage} /> : null}
    </div>
  );
}

function MlflowCatalogView(props: {
  catalog: MlflowCatalog;
  onSetAlias: (name: string, version: string, alias: string) => void;
  onTransitionStage: (name: string, version: string, stage: MlflowStage) => void;
}) {
  const { catalog } = props;
  return (
    <div className="mlflow-catalog">
      <MlflowCatalogSectionView
        title="Experimentos"
        error={catalog.experiments.error}
        empty="Nenhum experimento retornado."
        items={catalog.experiments.items.map((experiment) => ({
          key: experiment.experimentId ?? experiment.name ?? "experiment",
          title: experiment.name ?? experiment.experimentId ?? "Experimento",
          detail: experiment.artifactLocation ?? experiment.lifecycleStage ?? "-",
          status: experiment.lifecycleStage ?? "-",
          uiUrl: experiment.uiUrl,
        }))}
      />
      <MlflowCatalogSectionView
        title="Runs"
        error={catalog.runs.error}
        empty="Nenhum run retornado."
        items={catalog.runs.items.map((run) => ({
          key: run.runId ?? run.runName ?? "run",
          title: run.runName ?? run.runId ?? "Run",
          detail: runMetricSummary(run.metrics) || run.artifactUri || "-",
          status: run.status ?? "-",
          uiUrl: run.uiUrl,
        }))}
      />
      <MlflowCatalogSectionView
        title="Modelos"
        error={catalog.registeredModels.error}
        empty="Nenhum modelo registrado retornado."
        items={catalog.registeredModels.items.map((model) => ({
          key: model.name ?? "model",
          title: model.name ?? "Modelo",
          detail: `${model.latestVersions.length} versão(ões) recentes`,
          status: "registry",
          uiUrl: model.uiUrl,
        }))}
      />
      <MlflowCatalogSectionView
        title="Versões"
        error={catalog.modelVersions.error}
        empty="Nenhuma versão retornada."
        items={catalog.modelVersions.items.map((version) => {
          const modelName = version.name;
          const modelVersion = version.version;
          return {
            key: `${modelName ?? "model"}-${modelVersion ?? "version"}`,
            title: `${modelName ?? "Modelo"} v${modelVersion ?? "-"}`,
            detail: version.runId ?? version.source ?? "-",
            status: version.status ?? version.currentStage ?? "-",
            uiUrl: version.uiUrl,
            actions: modelName && modelVersion ? [
              { label: "Champion", onClick: () => props.onSetAlias(modelName, modelVersion, "champion") },
              { label: "Challenger", onClick: () => props.onSetAlias(modelName, modelVersion, "challenger") },
              { label: "Production", onClick: () => props.onTransitionStage(modelName, modelVersion, "Production") },
              { label: "Archive", onClick: () => props.onTransitionStage(modelName, modelVersion, "Archived"), danger: true },
            ] : [],
          };
        })}
      />
    </div>
  );
}

function MlflowCatalogSectionView(props: {
  title: string;
  error: string | null;
  empty: string;
  items: Array<{
    key: string;
    title: string;
    detail: string;
    status: string;
    uiUrl?: string | null;
    actions?: Array<{ label: string; onClick: () => void; danger?: boolean }>;
  }>;
}) {
  return (
    <div className="mlflow-section">
      <div className="section-title">
        <h3>{props.title}</h3>
        <span className="muted">{props.items.length}</span>
      </div>
      {props.error ? (
        <div className="diagnostic warning">
          <strong>mlflow_catalog_error</strong>
          <span>{props.error}</span>
        </div>
      ) : props.items.length ? (
        <div className="dependency-list">
          {props.items.slice(0, 5).map((item) => (
            <div key={item.key} className="dependency-row">
              <History size={15} />
              <div>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </div>
              <div className="inline-actions catalog-actions">
                <code>{item.status}</code>
                {item.uiUrl ? (
                  <a className="mini-link" href={item.uiUrl} target="_blank" rel="noreferrer">
                    Abrir
                  </a>
                ) : null}
                {(item.actions ?? []).map((action) => (
                  <button key={`${item.key}-${action.label}`} type="button" className={`mini-button ${action.danger ? "danger" : ""}`} onClick={action.onClick}>
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">{props.empty}</p>
      )}
    </div>
  );
}

function runMetricSummary(metrics: MlflowCatalog["runs"]["items"][number]["metrics"]): string {
  return metrics
    .filter((metric) => typeof metric.key === "string")
    .slice(0, 3)
    .map((metric) => `${metric.key}: ${String(metric.value ?? "-")}`)
    .join(" · ");
}

function PromotionPolicyEditor(props: { project: MLOpsProject; promotionStatus: PromotionStatus | null; onUpdateProject: React.Dispatch<React.SetStateAction<MLOpsProject | null>> }) {
  const rules = props.project.promotionPolicy.rules;
  const metricOptions = promotionMetricOptions(props.project, props.promotionStatus);

  function updatePolicy(patch: Partial<MLOpsProject["promotionPolicy"]>) {
    props.onUpdateProject((current) => current ? { ...current, promotionPolicy: { ...current.promotionPolicy, ...patch } } : current);
  }

  function updateRules(nextRules: unknown[]) {
    updatePolicy({ rules: nextRules });
  }

  function updateRule(index: number, nextRule: unknown) {
    updateRules(rules.map((rule, ruleIndex) => ruleIndex === index ? nextRule : rule));
  }

  function updateMetricRule(index: number, patch: Partial<PromotionMetricRule>) {
    const currentRule = normalizePromotionMetricRule(rules[index], props.project);
    updateRule(index, { ...currentRule, ...patch });
  }

  function addMetricRule() {
    updateRules([...rules, createDefaultPromotionMetricRule(props.project, rules)]);
  }

  function removeRule(index: number) {
    updateRules(rules.filter((_rule, ruleIndex) => ruleIndex !== index));
  }

  return (
    <div className="rule-builder">
      <div className="section-title">
        <h3>Rule builder</h3>
        <button type="button" className="mini-button" onClick={addMetricRule}>
          Adicionar regra
        </button>
      </div>
      <div className="rule-builder-policy-grid">
        <label>
          Modo
          <select value={props.project.promotionPolicy.mode} onChange={(event) => updatePolicy({ mode: event.target.value })}>
            <option value="recommend_only">recomendar somente</option>
            <option value="manual_approval">aprovação manual</option>
            <option value="automatic">automático</option>
          </select>
        </label>
        <label>
          Baseline
          <select value={props.project.promotionPolicy.baseline} onChange={(event) => updatePolicy({ baseline: event.target.value })}>
            <option value="active_model">modelo ativo</option>
            <option value="best_previous">melhor anterior</option>
            <option value="fixed">fixo</option>
          </select>
        </label>
      </div>
      <div className="rule-builder-list">
        {rules.length ? rules.map((rule, index) => {
          if (!isPromotionMetricRule(rule)) {
            const label = isRecord(rule) && typeof rule.label === "string" ? rule.label : `Regra ${index + 1}`;
            const kind = isRecord(rule) && typeof rule.kind === "string" ? rule.kind : "avançada";
            return (
              <div key={`${kind}-${index}`} className="rule-card readonly">
                <div className="rule-card-header">
                  <div>
                    <strong>{label}</strong>
                    <span>Regra {kind} preservada no JSON.</span>
                  </div>
                  <button type="button" className="mini-button danger" onClick={() => removeRule(index)}>
                    Remover
                  </button>
                </div>
              </div>
            );
          }

          const metricRule = normalizePromotionMetricRule(rule, props.project);
          const metricOptionValues = new Set(metricOptions);
          const compareToValue = promotionMetricRefOptionValue(metricRule.compareTo);
          return (
            <div key={metricRule.id || index} className="rule-card">
              <div className="rule-card-header">
                <div>
                  <strong>{metricRule.label || metricRule.id}</strong>
                  <span>{metricRule.id}</span>
                </div>
                <button type="button" className="mini-button danger" onClick={() => removeRule(index)}>
                  Remover
                </button>
              </div>
              <div className="rule-builder-grid">
                <label>
                  ID
                  <input value={metricRule.id} onChange={(event) => updateMetricRule(index, { id: event.target.value })} />
                </label>
                <label>
                  Rótulo
                  <input value={metricRule.label} onChange={(event) => updateMetricRule(index, { label: event.target.value })} />
                </label>
                <label>
                  Métrica
                  <select value={metricRule.left.metric} onChange={(event) => updateMetricRule(index, { left: { ...metricRule.left, metric: event.target.value } })}>
                    {!metricOptionValues.has(metricRule.left.metric) ? <option value={metricRule.left.metric}>{metricRule.left.metric}</option> : null}
                    {metricOptions.map((metric) => (
                      <option key={metric} value={metric}>
                        {metric}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Escopo
                  <select value={metricRule.left.scope ?? "candidate"} onChange={(event) => updateMetricRule(index, { left: { ...metricRule.left, scope: event.target.value as PromotionRuleScope } })}>
                    {promotionRuleScopeOptions.map((scope) => (
                      <option key={scope.value} value={scope.value}>
                        {scope.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Fase
                  <select value={metricRule.left.phase ?? "validation"} onChange={(event) => updateMetricRule(index, { left: { ...metricRule.left, phase: event.target.value as PromotionRulePhase } })}>
                    {promotionRulePhaseOptions.map((phase) => (
                      <option key={phase.value} value={phase.value}>
                        {phase.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Operador
                  <select
                    value={metricRule.operator}
                    onChange={(event) => {
                      const operator = event.target.value as PromotionRuleOperator;
                      updateMetricRule(index, {
                        operator,
                        value: operator === "between" && !Array.isArray(metricRule.value) ? [numericPromotionValue(metricRule.value), numericPromotionValue(metricRule.value)] : metricRule.value,
                      });
                    }}
                  >
                    {promotionOperatorOptions.map((operator) => (
                      <option key={operator.value} value={operator.value}>
                        {operator.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Valor esperado
                  <input value={formatPromotionRuleValue(metricRule.value)} onChange={(event) => updateMetricRule(index, { value: parsePromotionRuleValue(event.target.value, metricRule.operator) })} />
                </label>
                <label>
                  Comparar com
                  <select value={compareToValue} onChange={(event) => updateMetricRule(index, { compareTo: parsePromotionMetricRefOption(event.target.value, metricRule.left.metric) })}>
                    <option value="">valor absoluto</option>
                    {promotionCompareScopeOptions.flatMap((scope) => metricOptions.map((metric) => (
                      <option key={`${scope.value}:${metric}`} value={`${scope.value}:${metric}`}>
                        {scope.label}: {metric}
                      </option>
                    )))}
                    {compareToValue && !promotionCompareScopeOptions.some((scope) => compareToValue.startsWith(`${scope.value}:`)) ? <option value={compareToValue}>{compareToValue}</option> : null}
                  </select>
                </label>
                <label>
                  Neutral band
                  <input type="number" min="0" step="0.001" value={metricRule.neutralBand ?? 0} onChange={(event) => updateMetricRule(index, { neutralBand: Math.max(0, Number(event.target.value || 0)) })} />
                </label>
                <label>
                  Severidade
                  <select value={metricRule.severity ?? "block"} onChange={(event) => updateMetricRule(index, { severity: event.target.value as PromotionRuleSeverity })}>
                    {promotionSeverityOptions.map((severity) => (
                      <option key={severity.value} value={severity.value}>
                        {severity.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Racional
                <textarea className="short-textarea" value={metricRule.rationale ?? ""} onChange={(event) => updateMetricRule(index, { rationale: event.target.value })} />
              </label>
            </div>
          );
        }) : (
          <p className="muted">Nenhuma regra configurada. Adicione uma regra métrica para avaliar promoção.</p>
        )}
      </div>
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: PromotionStatus["evidence"] }) {
  return (
    <div className="evidence-list">
      {evidence.map((item, index) => (
        <div key={`${item.ruleId}-${index}`} className={`evidence ${item.color}`}>
          <strong>{item.label ?? item.ruleId}</strong>
          <span>{item.reason}</span>
          <code>{item.metric ?? "regra"} {item.operator ?? ""} {String(item.expected ?? "")} valor {String(item.value ?? "-")}</code>
        </div>
      ))}
    </div>
  );
}

const promotionOperatorOptions: Array<{ value: PromotionRuleOperator; label: string }> = [
  { value: "gte", label: "maior ou igual" },
  { value: "gt", label: "maior que" },
  { value: "lte", label: "menor ou igual" },
  { value: "lt", label: "menor que" },
  { value: "eq", label: "igual" },
  { value: "neq", label: "diferente" },
  { value: "between", label: "entre" },
  { value: "improved_by", label: "melhorou em" },
  { value: "worse_by", label: "piorou em" },
  { value: "delta_gte", label: "delta maior/igual" },
  { value: "delta_lte", label: "delta menor/igual" },
  { value: "contains", label: "contém" },
  { value: "not_contains", label: "não contém" },
];

const promotionSeverityOptions: Array<{ value: PromotionRuleSeverity; label: string }> = [
  { value: "block", label: "bloqueia" },
  { value: "review", label: "exige revisão" },
  { value: "alert", label: "alerta" },
];

const promotionRuleScopeOptions: Array<{ value: PromotionRuleScope; label: string }> = [
  { value: "candidate", label: "candidato" },
  { value: "active", label: "ativo" },
  { value: "baseline", label: "baseline" },
  { value: "runtime", label: "runtime" },
  { value: "dataset", label: "dataset" },
  { value: "custom", label: "custom" },
];

const promotionCompareScopeOptions: Array<{ value: PromotionRuleScope; label: string }> = [
  { value: "active", label: "modelo ativo" },
  { value: "baseline", label: "baseline" },
  { value: "runtime", label: "runtime" },
];

const promotionRulePhaseOptions: Array<{ value: PromotionRulePhase; label: string }> = [
  { value: "train", label: "treino" },
  { value: "validation", label: "validação" },
  { value: "test", label: "teste" },
  { value: "backtest", label: "backtest" },
  { value: "runtime", label: "runtime" },
];

function isPromotionMetricRule(rule: unknown): rule is PromotionMetricRule {
  return isRecord(rule) && rule.kind === "metric";
}

function normalizePromotionMetricRule(rule: unknown, project: MLOpsProject): PromotionMetricRule {
  const record = isRecord(rule) ? rule : {};
  const left = isRecord(record.left) ? record.left : {};
  const compareTo = isRecord(record.compareTo) ? record.compareTo : null;
  const metric = typeof left.metric === "string" && left.metric ? left.metric : project.metrics.primary || "f1_macro";
  const operator = isPromotionRuleOperator(record.operator) ? record.operator : defaultPromotionOperator(metric, project.problem.type);
  return {
    kind: "metric",
    id: typeof record.id === "string" ? record.id : "promotion_rule",
    label: typeof record.label === "string" ? record.label : "Regra de promoção",
    left: {
      metric,
      scope: isPromotionRuleScope(left.scope) ? left.scope : "candidate",
      phase: isPromotionRulePhase(left.phase) ? left.phase : "validation",
    },
    operator,
    value: normalizePromotionRuleValue(record.value, operator),
    compareTo: compareTo && typeof compareTo.metric === "string" ? {
      metric: compareTo.metric,
      scope: isPromotionRuleScope(compareTo.scope) ? compareTo.scope : "baseline",
      phase: isPromotionRulePhase(compareTo.phase) ? compareTo.phase : "validation",
    } : undefined,
    neutralBand: typeof record.neutralBand === "number" && Number.isFinite(record.neutralBand) ? Math.max(0, record.neutralBand) : 0,
    severity: isPromotionRuleSeverity(record.severity) ? record.severity : "block",
    rationale: typeof record.rationale === "string" ? record.rationale : "",
  };
}

function createDefaultPromotionMetricRule(project: MLOpsProject, currentRules: unknown[]): PromotionMetricRule {
  const metric = project.metrics.primary || "f1_macro";
  return {
    kind: "metric",
    id: nextPromotionRuleId(currentRules),
    label: `Critério ${metric}`,
    left: { metric, scope: "candidate", phase: "validation" },
    operator: defaultPromotionOperator(metric, project.problem.type),
    value: defaultPromotionRuleValue(metric, project.problem.type),
    neutralBand: metric === "latency_p95_ms" ? 25 : 0.01,
    severity: "block",
    rationale: "Critério editável pelo rule builder visual.",
  };
}

function nextPromotionRuleId(currentRules: unknown[]): string {
  const existing = new Set(currentRules.map((rule) => isRecord(rule) && typeof rule.id === "string" ? rule.id : "").filter(Boolean));
  let index = currentRules.length + 1;
  while (existing.has(`regra_promocao_${index}`)) {
    index += 1;
  }
  return `regra_promocao_${index}`;
}

function promotionMetricOptions(project: MLOpsProject, promotionStatus: PromotionStatus | null): string[] {
  const values = [
    project.metrics.primary,
    ...project.metrics.secondary,
    "accuracy",
    "f1_macro",
    "f1_weighted",
    "precision_macro",
    "recall_macro",
    "rmse",
    "mae",
    "r2",
    "latency_p95_ms",
    ...(promotionStatus?.evidence.map((item) => item.metric).filter((item): item is string => !!item) ?? []),
    ...(promotionStatus?.leaderboard?.flatMap((model) => Object.keys(model.metrics ?? {})) ?? []),
  ];
  return uniqueStrings(values).sort((left, right) => left.localeCompare(right));
}

function defaultPromotionOperator(metric: string, problemType: string): PromotionRuleOperator {
  return isMetricMinimized(metric, problemType) ? "lte" : "gte";
}

function defaultPromotionRuleValue(metric: string, problemType: string): number {
  if (isMetricMinimized(metric, problemType)) {
    return metric === "latency_p95_ms" ? 750 : 1;
  }
  if (metric === "r2") {
    return 0.5;
  }
  return 0.8;
}

function isMetricMinimized(metric: string, problemType: string): boolean {
  return metric === "rmse" || metric === "mae" || metric === "log_loss" || metric === "latency_p95_ms" || metric === "error_rate" || metric === "drift_score" || problemType === "regression" && metric !== "r2";
}

function isPromotionRuleOperator(value: unknown): value is PromotionRuleOperator {
  return typeof value === "string" && promotionOperatorOptions.some((item) => item.value === value);
}

function isPromotionRuleSeverity(value: unknown): value is PromotionRuleSeverity {
  return typeof value === "string" && promotionSeverityOptions.some((item) => item.value === value);
}

function isPromotionRuleScope(value: unknown): value is PromotionRuleScope {
  return typeof value === "string" && promotionRuleScopeOptions.some((item) => item.value === value);
}

function isPromotionRulePhase(value: unknown): value is PromotionRulePhase {
  return typeof value === "string" && promotionRulePhaseOptions.some((item) => item.value === value);
}

function normalizePromotionRuleValue(value: unknown, operator: PromotionRuleOperator): PromotionMetricRule["value"] {
  if (operator === "between") {
    if (Array.isArray(value)) {
      const numbers = value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
      return numbers.length >= 2 ? numbers.slice(0, 2) : [0, 1];
    }
    const numeric = numericPromotionValue(value);
    return [numeric, numeric];
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return 0;
}

function formatPromotionRuleValue(value: PromotionMetricRule["value"]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function parsePromotionRuleValue(value: string, operator: PromotionRuleOperator): PromotionMetricRule["value"] {
  const trimmed = value.trim();
  if (operator === "between") {
    const numbers = trimmed.split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item));
    return numbers.length >= 2 ? numbers.slice(0, 2) : [];
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  const numeric = Number(trimmed);
  return trimmed !== "" && Number.isFinite(numeric) ? numeric : value;
}

function numericPromotionValue(value: unknown): number {
  if (Array.isArray(value)) {
    return numericPromotionValue(value[0]);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function promotionMetricRefOptionValue(ref: PromotionMetricRule["compareTo"]): string {
  return ref?.scope && ref.metric ? `${ref.scope}:${ref.metric}` : "";
}

function parsePromotionMetricRefOption(value: string, fallbackMetric: string): PromotionMetricRule["compareTo"] {
  if (!value) {
    return undefined;
  }
  const [scope, ...metricParts] = value.split(":");
  const metric = metricParts.join(":") || fallbackMetric;
  return {
    metric,
    scope: isPromotionRuleScope(scope) ? scope : "baseline",
    phase: "validation",
  };
}

function TrainingHistoryView(props: { runs: TrainingResult[]; selectedRunId: string; onSelect: (run: TrainingResult) => void }) {
  return (
    <div className="history-list">
      {props.runs.map((run) => (
        <button key={run.runId} type="button" className={`history-row ${run.runId === props.selectedRunId ? "active" : ""}`} onClick={() => props.onSelect(run)}>
          <History size={16} />
          <div>
            <strong>{run.runId}</strong>
            <span>{formatDateTime(run.createdAt ?? run.updatedAt)}</span>
          </div>
          <code>{run.primaryMetric}: {String(run.leaderboard[0]?.metrics?.[run.primaryMetric] ?? "-")}</code>
          <code>{run.bestModelId}</code>
        </button>
      ))}
    </div>
  );
}

function EvaluationHistoryView(props: { runs: EvaluationResult[]; selectedEvaluationId: string; onSelect: (run: EvaluationResult) => void }) {
  return (
    <div className="history-list">
      {props.runs.map((run) => (
        <button key={run.evaluationId} type="button" className={`history-row ${run.evaluationId === props.selectedEvaluationId ? "active" : ""}`} onClick={() => props.onSelect(run)}>
          {run.kind === "backtest_result" ? <GitBranch size={16} /> : <BarChart3 size={16} />}
          <div>
            <strong>{run.evaluationId}</strong>
            <span>{formatDateTime(run.createdAt ?? run.updatedAt)}</span>
          </div>
          <code>{run.kind === "backtest_result" ? run.recommendation ?? "review" : `${run.primaryMetric}: ${String(run.metrics[run.primaryMetric] ?? "-")}`}</code>
          <code>{run.kind === "backtest_result" ? run.recommendedModelId ?? "-" : run.modelId ?? "-"}</code>
        </button>
      ))}
    </div>
  );
}

function WorkerQueueStatusView({ status }: { status: WorkerJobQueueStatus }) {
  return (
    <div className="operational-view">
      <div className="metric-grid">
        <Metric label="Backend" value={status.backend === "filesystem" ? "filesystem" : "local"} />
        <Metric label="Worker" value={status.workerId} />
        <Metric label="Concorrência" value={status.concurrency} />
        <Metric label="Slots livres" value={status.availableSlots} />
        <Metric label="Rodando" value={status.running} />
        <Metric label="Na fila" value={status.queued} />
        <Metric label="Recuperáveis" value={status.recoverable} />
        <Metric label="Total" value={status.total} />
      </div>
      <dl className="kv">
        <dt>Raiz da fila</dt>
        <dd>{status.storeRoot ?? "workspace local"}</dd>
        <dt>TTL de claim</dt>
        <dd>{status.claimTtlMs ? `${status.claimTtlMs} ms` : "local"}</dd>
        <dt>Concluídos</dt>
        <dd>{status.completed}</dd>
        <dt>Falhas/cancelados</dt>
        <dd>{status.failed}/{status.cancelled}</dd>
      </dl>
    </div>
  );
}

function DatasetSnapshotStatusView({ status, actionResult }: { status: DatasetSnapshotStatus; actionResult: DatasetSnapshotActionResult | null }) {
  const storeLabel = status.store.configured
    ? status.store.storeType === "s3"
      ? status.store.storeUri ?? `s3://${status.store.bucket ?? "-"}`
      : status.store.storeRoot ?? "filesystem"
    : "não configurado";
  return (
    <div className="operational-view">
      <div className="metric-grid">
        <Metric label="Storage" value={storeLabel} />
        <Metric label="Criptografia" value={status.encryption.enabled ? status.encryption.keyRef ?? "habilitada" : "desligada"} />
        <Metric label="Manifestos" value={status.local.manifestCount} />
        <Metric label="Snapshots locais" value={status.local.availableRows} />
        <Metric label="Ausentes" value={status.local.missingRows} />
        <Metric label="Arquivados" value={status.local.archivedRows} />
        <Metric label="Metadados remotos" value={status.remote.archiveMetadataCount ?? "erro"} />
        <Metric label="Vencidos" value={status.local.expiredRows} />
      </div>
      {!status.store.configured ? (
        <div className="diagnostic warning">
          <strong>dataset_snapshot_store_unconfigured</strong>
          <span>Defina `MLOPS_STUDIO_DATASET_SNAPSHOT_STORE` ou `MLOPS_STUDIO_DATASET_SNAPSHOT_STORE_BACKEND=s3` para arquivar snapshots fora do projeto.</span>
        </div>
      ) : null}
      {status.remote.error ? (
        <div className="diagnostic error">
          <strong>dataset_snapshot_remote_error</strong>
          <span>{status.remote.error}</span>
        </div>
      ) : null}
      <dl className="kv">
        <dt>Mascarados/completos</dt>
        <dd>{status.local.maskedRows}/{status.local.fullRows}</dd>
        <dt>Somente manifesto</dt>
        <dd>{status.local.manifestOnlyRows}</dd>
        <dt>Expiram em 7 dias</dt>
        <dd>{status.local.expiringSoonRows}</dd>
        <dt>Linhas rastreadas</dt>
        <dd>{status.local.totalRows}</dd>
      </dl>
      {actionResult ? (
        <div className="snapshot-action-result">
          <strong>Última ação</strong>
          <span>
            arquivados {actionResult.archived ?? 0}, restaurados {actionResult.restored ?? 0}, expurgados {actionResult.purged ?? 0}, erros {actionResult.errors?.length ?? 0}
          </span>
        </div>
      ) : null}
      {status.artifacts.length ? (
        <div className="snapshot-artifact-list">
          {status.artifacts.slice(0, 8).map((artifact) => (
            <div key={artifact.datasetVersionId} className={`snapshot-artifact-row ${artifact.available ? "available" : "missing"}`}>
              <Database size={15} />
              <div>
                <strong>{artifact.datasetVersionId}</strong>
                <span>{artifact.sourceId ?? "-"} · {artifact.mode ?? "manifest"} · {artifact.rowCount ?? 0} linha(s)</span>
              </div>
              <code>{artifact.archived ? artifact.archiveType ?? "archive" : artifact.available ? "local" : "ausente"}</code>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Database size={18} />
          <span>Nenhum snapshot versionado encontrado.</span>
        </div>
      )}
    </div>
  );
}

function WorkerJobsView(props: { jobs: WorkerJob[]; onCancel: (jobId: string) => void; onRecover: (jobId: string) => void; onPromoteRetrainingJob: (jobId: string) => void }) {
  if (!props.jobs.length) {
    return (
      <div className="empty-state">
        <Terminal size={18} />
        <span>Nenhum job iniciado nesta sessão.</span>
      </div>
    );
  }
  return (
    <div className="job-list">
      {props.jobs.map((job) => {
        const trainingResult = isTrainingResult(job.result) ? job.result : null;
        const evaluationResult = isEvaluationResult(job.result) ? job.result : null;
        const previewResult = isSourcePreviewResult(job.result) ? job.result : null;
        const pythonResult = isPythonRunResult(job.result) ? job.result : null;
        const retraining = isRecord(job.retraining) ? job.retraining : null;
        const retrainingCompletion = retraining && isRecord(retraining.completion) ? retraining.completion : null;
        const retrainingPromotion = retraining && isRecord(retraining.promotion) ? retraining.promotion : null;
        const canPromoteRetraining = !!trainingResult && !!retraining && retrainingCompletion?.status === "ok" && retrainingPromotion?.status !== "ok" && job.status === "completed";
        return (
          <div key={job.jobId} className={`job-row ${job.status}`}>
            <div className="job-row-header">
              <Terminal size={16} />
              <div>
                <strong>{job.label ?? job.command}</strong>
                <span>{job.jobId}</span>
              </div>
              <code>{job.status}</code>
              {job.status === "queued" || job.status === "running" ? (
                <button type="button" className="mini-button" onClick={() => props.onCancel(job.jobId)}>
                  Cancelar
                </button>
              ) : null}
              {job.status === "recoverable" ? (
                <button type="button" className="mini-button" onClick={() => props.onRecover(job.jobId)}>
                  Retomar
                </button>
              ) : null}
              {canPromoteRetraining ? (
                <button type="button" className="mini-button" onClick={() => props.onPromoteRetrainingJob(job.jobId)}>
                  Promover retreino
                </button>
              ) : null}
            </div>
            <div className="metric-grid">
              <Metric label="Fonte" value={job.sourceId ?? "-"} />
              <Metric label="Nó" value={job.nodeId ?? "-"} />
              <Metric label="Modo" value={job.mode ?? "-"} />
              <Metric label="Fila" value={formatDateTime(job.queuedAt)} />
              <Metric label="Runner" value={formatDateTime(job.runnerStartedAt)} />
              <Metric label="Worker" value={job.runnerWorkerId ?? job.queueBackend ?? "-"} />
              <Metric label="Backend" value={job.queueBackend ?? "local"} />
              <Metric label="Claim" value={job.claimPath ?? "-"} />
              <Metric label="Slot" value={job.slotPath ?? "-"} />
              <Metric label="Início" value={formatDateTime(job.startedAt)} />
              <Metric label="Fim" value={formatDateTime(job.finishedAt)} />
            </div>
            {trainingResult ? (
              <div className="metric-grid">
                <Metric label="Run" value={trainingResult.runId} />
                <Metric label="Melhor modelo" value={trainingResult.bestModelId} />
                <Metric label={trainingResult.primaryMetric} value={String(trainingResult.leaderboard[0]?.metrics?.[trainingResult.primaryMetric] ?? "-")} />
              </div>
            ) : null}
            {retraining ? (
              <div className="metric-grid">
                <Metric label="Retreino" value={String(retraining.requestId ?? "-")} />
                <Metric label="Origem" value={String(retraining.trainingRowsSource ?? "-")} />
                <Metric label="Feedback usado" value={String(isRecord(retraining.feedbackRows) ? retraining.feedbackRows.used ?? "-" : "-")} />
                <Metric label="Base" value={String(retraining.previousRunId ?? "-")} />
                <Metric label="Conclusão" value={retrainingCompletion ? String(retrainingCompletion.status ?? "-") : "-"} />
                <Metric label="Status remoto" value={String(retraining.requestStatus ?? retrainingCompletion?.remoteStatus ?? "-")} />
                <Metric label="Tentativas" value={retrainingCompletion ? String(retrainingCompletion.attempts ?? "-") : "-"} />
                <Metric label="Promoção" value={retrainingPromotion ? String(retrainingPromotion.status ?? "-") : "-"} />
                <Metric label="Modelo promovido" value={retrainingPromotion ? String(retrainingPromotion.activeModelId ?? retrainingPromotion.candidateModelId ?? "-") : "-"} />
              </div>
            ) : null}
            {evaluationResult ? (
              <div className="metric-grid">
                <Metric label={evaluationResult.kind === "backtest_result" ? "Backtest" : "Avaliação"} value={evaluationResult.evaluationId} />
                <Metric label={evaluationResult.kind === "backtest_result" ? "Baseline" : "Modelo"} value={evaluationResult.baselineModelId ?? evaluationResult.modelId ?? "-"} />
                {evaluationResult.kind === "backtest_result" ? <Metric label="Recomendado" value={evaluationResult.recommendedModelId ?? "-"} /> : null}
                {evaluationResult.kind === "backtest_result" ? <Metric label="Decisão" value={evaluationResult.recommendation ?? "review"} /> : null}
                <Metric label={evaluationResult.primaryMetric} value={String(evaluationResult.metrics[evaluationResult.primaryMetric] ?? "-")} />
              </div>
            ) : null}
            {previewResult ? (
              <div className="metric-grid">
                <Metric label="Preview" value={previewResult.status} />
                <Metric label="Linhas" value={previewResult.rowCount ?? "-"} />
                <Metric label="Colunas" value={previewResult.columns?.length ?? "-"} />
              </div>
            ) : null}
            {pythonResult ? (
              <div className="result-box">
                <strong>Saída Python</strong>
                <pre>{formatJson(pythonResult.output)}</pre>
                {pythonResult.stdout.length ? <pre>{pythonResult.stdout.join("\n")}</pre> : null}
                {pythonResult.stderr.length ? <pre>{pythonResult.stderr.join("\n")}</pre> : null}
              </div>
            ) : null}
            {job.events.length ? <WorkerJobEventsView events={job.events} /> : null}
            {job.error ? (
              <div className="diagnostic error">
                <strong>worker_job_error</strong>
                <span>{job.error}</span>
              </div>
            ) : null}
            {job.stderr ? (
              <pre className="job-log">{job.stderr}</pre>
            ) : null}
            {job.stdout && job.status !== "completed" ? (
              <pre className="job-log">{job.stdout}</pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function WorkerJobEventsView({ events }: { events: WorkerJob["events"] }) {
  return (
    <div className="job-event-list">
      {events.map((event, index) => {
        const detail = workerEventDetail(event);
        return (
          <div key={`${event.timestamp ?? "event"}-${event.type ?? "worker"}-${index}`} className={`job-event ${event.level === "error" ? "error" : event.level === "warning" ? "warning" : "info"}`}>
            <div>
              <strong>{event.type ?? "worker_event"}</strong>
              <span>{event.message ?? "-"}</span>
            </div>
            <code>{formatDateTime(event.timestamp)}</code>
            {detail ? <code>{detail}</code> : null}
          </div>
        );
      })}
    </div>
  );
}

function WorkerDependenciesView({ dependencies }: { dependencies: WorkerDependencyStatus }) {
  return (
    <div className="dependency-view">
      <div className="metric-grid">
        <Metric label="Python" value={dependencies.pythonVersion ?? "-"} />
        <Metric label="Status" value={dependencies.ready ? "pronto" : "parcial"} />
        <Metric label="Requirements" value={dependencies.requirementsPath} />
      </div>
      <div className="dependency-list">
        {dependencies.packages.map((item) => (
          <div key={item.name} className={`dependency-row ${item.installed ? "installed" : "missing"}`}>
            <Terminal size={15} />
            <div>
              <strong>{item.name}</strong>
              <span>{item.requirement ?? item.importName}</span>
            </div>
            <code>{item.installed ? item.version ?? "instalado" : "ausente"}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function GpuEnvironmentView({ status }: { status: GpuEnvironmentStatus }) {
  const gpus = status.nvidiaSmi.gpus ?? [];
  const firstGpu = gpus[0];
  const dockerRuntimeLabel = status.summary.dockerNvidiaRuntime ? "disponível" : "ausente";
  const torchCudaLabel = status.summary.torchCudaAvailable ? "pronto" : status.python.torchInstalled ? "CPU" : "ausente";
  const fallbackLabel = status.fallback === "gpu_cuda" ? "GPU/CUDA" : "CPU";
  const workerGpuReady = status.fallback === "gpu_cuda";
  const diagnosticMessage = workerGpuReady
    ? "O worker local já consegue executar etapas compatíveis em GPU/CUDA."
    : status.summary.canUseGpuProfile
      ? "GPU e Docker NVIDIA foram detectados, mas o Python do worker ainda cai para CPU porque Torch/CUDA não está disponível."
      : "O Studio pode continuar em CPU; habilite driver NVIDIA, runtime Docker NVIDIA e Torch com CUDA para execução GPU.";

  return (
    <div className="dependency-view">
      <div className="metric-grid">
        <Metric label="GPU" value={status.summary.gpuDetected ? `${gpus.length} detectada(s)` : "não detectada"} />
        <Metric label="Torch CUDA" value={torchCudaLabel} />
        <Metric label="Docker NVIDIA" value={dockerRuntimeLabel} />
        <Metric label="Execução" value={fallbackLabel} />
      </div>
      <div className="dependency-list">
        <div className={`dependency-row ${status.summary.gpuDetected ? "installed" : "missing"}`}>
          <Gauge size={15} />
          <div>
            <strong>{firstGpu?.name ?? "nvidia-smi"}</strong>
            <span>
              {firstGpu
                ? `${formatMiB(firstGpu.memoryFreeMiB)} livres de ${formatMiB(firstGpu.memoryTotalMiB)}; driver ${firstGpu.driverVersion ?? "-"}; CUDA ${firstGpu.cudaVersion ?? "-"}`
                : status.nvidiaSmi.reason ?? "GPU NVIDIA não detectada"}
            </span>
          </div>
          <code>{status.summary.gpuDetected ? "detectada" : "CPU"}</code>
        </div>
        <div className={`dependency-row ${status.summary.torchCudaAvailable ? "installed" : "missing"}`}>
          <Terminal size={15} />
          <div>
            <strong>{status.python.torchInstalled ? `torch ${status.python.torchVersion ?? ""}`.trim() : "torch"}</strong>
            <span>
              {status.python.available
                ? `Python ${status.python.pythonVersion ?? "-"}; torch CUDA ${status.python.torchCudaVersion ?? "-"}; ${status.python.deviceCount ?? 0} dispositivo(s)`
                : status.python.reason ?? "Python indisponível"}
            </span>
          </div>
          <code>{status.summary.torchCudaAvailable ? "CUDA" : status.python.torchInstalled ? "CPU" : "ausente"}</code>
        </div>
        <div className={`dependency-row ${status.summary.dockerNvidiaRuntime ? "installed" : "missing"}`}>
          <Server size={15} />
          <div>
            <strong>{status.docker.version ?? "Docker"}</strong>
            <span>{status.docker.available ? `Runtimes: ${(status.docker.runtimes ?? []).join(", ") || "-"}` : status.docker.reason ?? "Docker indisponível"}</span>
          </div>
          <code>{dockerRuntimeLabel}</code>
        </div>
      </div>
      <div className={`diagnostic ${workerGpuReady ? "info" : "warning"}`}>
        <strong>{status.recommendation}</strong>
        <span>{diagnosticMessage}</span>
      </div>
    </div>
  );
}

function EmbeddingEnvironmentView({ status }: { status: EmbeddingEnvironmentStatus }) {
  const sentenceTransformersReady = status.packages.sentenceTransformers.installed;
  const smokeMessage = status.smoke.attempted
    ? status.smoke.ok
      ? `${status.smoke.dimensions ?? "-"} dimensões em ${status.smoke.durationMs ?? "-"} ms`
      : status.smoke.message ?? "Smoke não passou."
    : "Smoke ainda não executado.";
  return (
    <div className="dependency-view">
      <div className="metric-grid">
        <Metric label="SentenceTransformers" value={sentenceTransformersReady ? status.packages.sentenceTransformers.version ?? "instalado" : "ausente"} />
        <Metric label="Torch CUDA" value={status.torch.cudaAvailable ? "pronto" : status.torch.installed ? "CPU" : "ausente"} />
        <Metric label="Modelo" value={status.model} />
        <Metric label="Smoke" value={status.smoke.attempted ? status.smoke.ok ? "ok" : "falhou" : "não executado"} />
      </div>
      <div className="dependency-list">
        <div className={`dependency-row ${sentenceTransformersReady ? "installed" : "missing"}`}>
          <Network size={15} />
          <div>
            <strong>sentence-transformers</strong>
            <span>{status.packages.sentenceTransformers.version ?? status.packages.sentenceTransformers.importName}</span>
          </div>
          <code>{sentenceTransformersReady ? "pronto" : "ausente"}</code>
        </div>
        <div className={`dependency-row ${status.packages.transformers.installed ? "installed" : "missing"}`}>
          <Boxes size={15} />
          <div>
            <strong>transformers</strong>
            <span>{status.packages.transformers.version ?? status.packages.transformers.importName}</span>
          </div>
          <code>{status.packages.transformers.installed ? "instalado" : "ausente"}</code>
        </div>
        <div className={`dependency-row ${status.torch.cudaAvailable ? "installed" : status.torch.installed ? "installed" : "missing"}`}>
          <Gauge size={15} />
          <div>
            <strong>{status.torch.torchVersion ? `torch ${status.torch.torchVersion}` : "torch"}</strong>
            <span>
              CUDA {status.torch.torchCudaVersion ?? "-"}; {status.torch.deviceCount} dispositivo(s)
              {status.torch.error ? `; ${status.torch.error}` : ""}
            </span>
          </div>
          <code>{status.torch.cudaAvailable ? "CUDA" : status.torch.installed ? "CPU" : "ausente"}</code>
        </div>
      </div>
      <div className={`diagnostic ${status.smoke.attempted && !status.smoke.ok ? "warning" : "info"}`}>
        <strong>{status.recommendation}</strong>
        <span>{smokeMessage}</span>
        <small>
          Python {status.pythonVersion ?? "-"}; cache local {status.localFilesOnly ? "sim" : "não"}; device {status.smoke.deviceUsed ?? status.deviceRequested ?? "-"}
        </small>
      </div>
    </div>
  );
}

function formatMiB(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} MiB` : "-";
}

function DockerRuntimeView({ status }: { status: DockerRuntimeStatus }) {
  return (
    <div className="dependency-view">
      <div className="metric-grid">
        <Metric label="Docker" value={status.docker.available ? "disponível" : "indisponível"} />
        <Metric label="Compose" value={status.composeExists ? "ok" : "ausente"} />
        <Metric label="Dockerfile" value={status.dockerfileExists ? "ok" : "ausente"} />
        <Metric label="Gerenciável" value={status.canManage ? "sim" : "não"} />
      </div>
      <div className="dependency-list">
        <div className={`dependency-row ${status.docker.available ? "installed" : "missing"}`}>
          <Server size={15} />
          <div>
            <strong>{status.docker.version ?? "Docker"}</strong>
            <span>{status.outDir}</span>
          </div>
          <code>{status.exists ? "gerado" : "não gerado"}</code>
        </div>
        {status.composePs ? (
          <div className={`dependency-row ${status.composePs.ok ? "installed" : "missing"}`}>
            <Terminal size={15} />
            <div>
              <strong>docker compose ps</strong>
              <span>{status.composePs.stderr || status.composePs.stdout || "sem containers ativos"}</span>
            </div>
            <code>{status.composePs.ok ? "ok" : "erro"}</code>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DockerRuntimeHistoryView({ history }: { history: DockerRuntimeHistoryEntry[] }) {
  if (!history.length) {
    return (
      <div className="diagnostic info">
        <strong>docker_history_empty</strong>
        <span>Nenhum comando Docker registrado para este runtime.</span>
      </div>
    );
  }
  return (
    <div className="docker-history-list">
      {history.slice(0, 6).map((entry) => (
        <div key={entry.id} className={`dependency-row ${entry.ok ? "installed" : "missing"}`}>
          <History size={15} />
          <div>
            <strong>{entry.action}</strong>
            <span>{entry.command}</span>
            <small>{formatDateTime(entry.completedAt)} · {entry.durationMs} ms</small>
          </div>
          <code>{entry.ok ? "ok" : entry.timedOut ? "timeout" : `exit ${entry.exitCode ?? "-"}`}</code>
        </div>
      ))}
    </div>
  );
}

function DockerRuntimeInspectView({ inspect }: { inspect: DockerRuntimeInspect }) {
  const composePreview = inspect.composeConfig?.stdout || inspect.composeFile.content || "docker-compose.yml indisponível.";
  const imagesPreview = inspect.composeImages?.items.length
    ? JSON.stringify(inspect.composeImages.items, null, 2)
    : inspect.composeImages?.stderr || "sem imagens criadas para este runtime.";
  return (
    <div className="docker-inspect">
      <div className="metric-grid">
        <Metric label="Arquivos" value={inspect.summary.filesOk ? "ok" : "ausentes"} />
        <Metric label="Docker" value={inspect.summary.dockerAvailable ? "disponível" : "indisponível"} />
        <Metric label="Config" value={inspect.summary.composeConfigOk === null ? "sem docker" : inspect.summary.composeConfigOk ? "ok" : "erro"} />
        <Metric label="Images" value={inspect.summary.composeImagesOk === null ? "sem docker" : inspect.summary.composeImagesOk ? "ok" : "erro"} />
      </div>
      <div className="dependency-list">
        <div className={`dependency-row ${inspect.composeFile.exists ? "installed" : "missing"}`}>
          <FileText size={15} />
          <div>
            <strong>docker-compose.yml</strong>
            <span>{inspect.composeFile.sizeBytes ?? 0} bytes</span>
          </div>
          <code>{inspect.composeFile.exists ? "ok" : "ausente"}</code>
        </div>
        <div className={`dependency-row ${inspect.dockerfile.exists ? "installed" : "missing"}`}>
          <FileCode2 size={15} />
          <div>
            <strong>Dockerfile</strong>
            <span>{inspect.dockerfile.sizeBytes ?? 0} bytes</span>
          </div>
          <code>{inspect.dockerfile.exists ? "ok" : "ausente"}</code>
        </div>
      </div>
      <div className="docker-inspect-grid">
        <div>
          <strong>Compose config</strong>
          <pre>{composePreview}</pre>
        </div>
        <div>
          <strong>Images</strong>
          <pre>{imagesPreview}</pre>
        </div>
      </div>
    </div>
  );
}

function DockerRuntimeLogsView({ logs }: { logs: DockerRuntimeLogs }) {
  const output = logs.stdout || logs.stderr || "sem logs recentes.";
  return (
    <div className="docker-logs">
      <div className={`diagnostic ${logs.stderr && !logs.stdout ? "warning" : "info"}`}>
        <strong>docker_logs</strong>
        <span>{logs.command}</span>
        <small>{logs.tail} linhas · {logs.historyEntry.durationMs} ms</small>
      </div>
      <pre>{output}</pre>
    </div>
  );
}

function RuntimeSmokeView({ result }: { result: RuntimeSmokeResult }) {
  return (
    <div className={`diagnostic ${result.status === "ok" ? "info" : "error"}`}>
      <strong>{result.status === "ok" ? "smoke_ok" : "smoke_error"}</strong>
      <span>
        {result.baseUrl ?? result.url} · {result.summary ? `${result.summary.passed}/${result.summary.total} checks` : (result.statusCode ?? "sem status")} · {result.latencyMs} ms
      </span>
      {result.summary ? (
        <small>
          `/predict` registrado: {result.summary.predictionLogged ? "sim" : "não"} · feedback: {result.summary.feedbackLogged ? "sim" : "não"} · retreino: {result.summary.retrainingRequested ? "sim" : "não"} · conclusão: {result.summary.retrainingCompleted ? "sim" : "não"} · deployment: {result.summary.deploymentObserved ? "sim" : "não"} · rollback: {result.summary.deploymentRolledBack ? "sim" : "não"}
        </small>
      ) : null}
      {result.checks?.length ? (
        <div className="runtime-smoke-checks">
          {result.checks.map((check) => (
            <div key={check.name} className={`dependency-row ${check.status === "ok" ? "installed" : "missing"}`}>
              <Terminal size={15} />
              <div>
                <strong>{check.name}</strong>
                <span>
                  {check.method} {check.url} · {check.statusCode ?? "sem status"} · {check.latencyMs} ms
                </span>
                {check.message ? <small>{check.message}</small> : null}
              </div>
              <code>{check.status}</code>
            </div>
          ))}
        </div>
      ) : (
        <code>{formatJson(result.body ?? result.message ?? "")}</code>
      )}
    </div>
  );
}

function RemoteRuntimeInspectionView({ result }: { result: RemoteRuntimeInspection }) {
  const identity = result.identity;
  return (
    <div className={`diagnostic ${result.status === "error" ? "error" : result.status === "warning" ? "warning" : "info"}`}>
      <strong>{result.mode}</strong>
      <span>
        {result.baseUrl} · {result.summary.ok}/{result.summary.total} endpoints · {result.latencyMs} ms
      </span>
      <small>
        read-only: {result.readOnly ? "sim" : "não"} · contrato: {identity.contract ?? "não identificado"} · projeto: {identity.projectId ?? "não identificado"}
      </small>
      <div className="remote-runtime-meta">
        <Metric label="Projeto" value={identity.projectName ?? identity.projectId ?? "n/d"} />
        <Metric label="Modelo ativo" value={identity.activeModelId ?? "n/d"} />
        <Metric label="Contrato" value={`${result.summary.contractEndpointsOk}/${result.summary.contractEndpointsTotal}`} />
        <Metric label="Ausentes" value={result.summary.missing} />
      </div>
      {result.recommendations.length ? (
        <div className="node-execution-meta">
          {result.recommendations.slice(0, 6).map((item) => <code key={item}>{item}</code>)}
        </div>
      ) : null}
      <div className="runtime-smoke-checks">
        {result.checks.map((check) => (
          <div key={check.name} className={`dependency-row ${check.status === "ok" ? "installed" : check.status === "missing" ? "missing" : "error"}`}>
            <Terminal size={15} />
            <div>
              <strong>{check.name}</strong>
              <span>
                {check.method} {check.url} · {check.statusCode ?? "sem status"} · {check.latencyMs} ms
              </span>
              {check.message ? <small>{check.message}</small> : null}
            </div>
            <code>{check.status}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaywrightScrapeView({ result }: { result: PlaywrightScrapeResult }) {
  const topHeadings = result.headings.slice(0, 6);
  const apiCandidates = result.apiCandidates.slice(0, 8);
  const forms = result.forms.slice(0, 4);
  const links = result.links.slice(0, 8);
  const crawledPageCount = result.crawledPageCount ?? 1;
  return (
    <div className="diagnostic info">
      <strong>{result.title || "Página sem título"}</strong>
      <span>{result.finalUrl} · HTTP {result.statusCode ?? "n/d"} · {crawledPageCount} página(s) · {result.links.length} link(s)</span>
      <small>
        relatório: {result.reportPath} · screenshot: {result.screenshotPath ?? "não capturado"} · profundidade: {result.maxDepth ?? 0} · limite: {result.maxPages ?? 1} página(s) · crawl profundo: {result.deepCrawlConfirmed ? "confirmado" : "não"} · scraping: {result.scrapedAt}
      </small>
      {result.auth ? (
        <small>auth: {result.auth.mode} · login {result.auth.loginStatusCode ?? "n/d"} · senha via {result.auth.passwordRef} · {result.auth.authenticatedAt}</small>
      ) : null}
      {result.description ? <p className="muted">{result.description}</p> : null}
      <div className="remote-runtime-meta">
        <Metric label="Páginas" value={crawledPageCount} />
        <Metric label="Headings" value={result.headings.length} />
        <Metric label="Links" value={result.links.length} />
        <Metric label="Forms" value={result.forms.length} />
        <Metric label="APIs" value={result.apiCandidates.length} />
      </div>
      {apiCandidates.length ? (
        <div className="runtime-smoke-checks">
          {apiCandidates.map((item, index) => (
            <div key={`${item.href}-${index}`} className="dependency-row installed">
              <Network size={15} />
              <div>
                <strong>{item.text || "candidato de API"}</strong>
                <span>{item.href}</span>
              </div>
              <code>api</code>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state"><Network size={18} /><span>Nenhum candidato OpenAPI/Swagger/Redoc detectado.</span></div>
      )}
      {topHeadings.length ? (
        <div className="node-execution-meta">
          {topHeadings.map((item, index) => <code key={`${item.level}-${index}`}>{item.level}: {item.text}</code>)}
        </div>
      ) : null}
      {forms.length ? (
        <div className="runtime-smoke-checks">
          {forms.map((form, index) => (
            <div key={`${form.action}-${index}`} className="dependency-row">
              <Terminal size={15} />
              <div>
                <strong>{form.method.toUpperCase()} {form.action}</strong>
                <span>{form.inputs.map((input) => `${input.name || input.placeholder || input.tag}${input.required ? "*" : ""}`).join(", ") || "sem campos nomeados"}</span>
              </div>
              <code>form</code>
            </div>
          ))}
        </div>
      ) : null}
      {links.length ? (
        <div className="node-execution-meta">
          {links.map((item, index) => <code key={`${item.href}-${index}`}>{item.text || "link"}{" -> "}{item.href}</code>)}
        </div>
      ) : null}
    </div>
  );
}

function PlaywrightScrapeImportPreviewView({ preview }: { preview: PlaywrightScrapeImportPreview }) {
  const sources = preview.project.dataSources.slice(0, 8);
  return (
    <div className="diagnostic info">
      <strong>Prévia de importação: {preview.targetProjectId}</strong>
      <span>{preview.baseUrl} · {preview.summary.dataSources} fonte(s) · {preview.summary.nodes} nó(s) · {preview.summary.edges} aresta(s)</span>
      <small>relatório: {preview.sourceScrapeReport}</small>
      <div className="remote-runtime-meta">
        <Metric label="APIs" value={preview.summary.apiCandidates} />
        <Metric label="Forms" value={preview.summary.forms} />
        <Metric label="Links" value={preview.summary.links} />
        <Metric label="Endpoints" value={preview.endpoints.length} />
        <Metric label="Edições" value={preview.summary.sourceEdits} />
      </div>
      <div className="runtime-smoke-checks">
        {sources.map((source) => (
          <div key={source.id} className="dependency-row installed">
            <Database size={15} />
            <div>
              <strong>{source.label}</strong>
              <span>{source.type} · {source.api?.method ?? "GET"} {source.api?.url ?? "-"}</span>
              {source.description ? <small>{source.description}</small> : null}
            </div>
            <code>{source.id}</code>
          </div>
        ))}
      </div>
      {preview.endpoints.length ? (
        <div className="node-execution-meta">
          {preview.endpoints.slice(0, 12).map((endpoint) => <code key={endpoint}>{endpoint}</code>)}
        </div>
      ) : null}
      {preview.limitations.length ? (
        <div className="node-execution-meta">
          {preview.limitations.map((item) => <code key={item}>{item}</code>)}
        </div>
      ) : null}
    </div>
  );
}

function OpenApiContractPreviewView({
  preview,
  onApplyOperation,
  onSmokeOperation,
}: {
  preview: OpenApiContractPreview;
  onApplyOperation: (operation: OpenApiOperationPreview) => void;
  onSmokeOperation: (operation: OpenApiOperationPreview) => void;
}) {
  const endpoints = preview.endpoints.slice(0, 16);
  const operations = preview.operations.slice(0, 8);
  return (
    <div className="diagnostic info">
      <strong>OpenAPI validado: {preview.title || "sem título"}</strong>
      <span>{preview.url} · {preview.endpointCount} endpoint(s) · {preview.operationCount} operação(ões) · HTTP {preview.statusCode} · {preview.latencyMs} ms</span>
      {preview.version ? <small>versão: {preview.version}</small> : null}
      {endpoints.length ? (
        <div className="node-execution-meta">
          {endpoints.map((endpoint) => (
            <code key={endpoint}>{endpoint}</code>
          ))}
        </div>
      ) : null}
      {operations.length ? (
        <div className="runtime-smoke-checks">
          {operations.map((operation) => (
            <OpenApiOperationPreviewRow key={`${operation.method} ${operation.path}`} operation={operation} onApply={onApplyOperation} onSmoke={onSmokeOperation} />
          ))}
        </div>
      ) : null}
      {preview.warnings.length ? (
        <ul className="limitations-list">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function OpenApiOperationPreviewRow({
  operation,
  onApply,
  onSmoke,
}: {
  operation: OpenApiOperationPreview;
  onApply: (operation: OpenApiOperationPreview) => void;
  onSmoke: (operation: OpenApiOperationPreview) => void;
}) {
  const requestExample = openApiExampleJson(operation.requestExample);
  const responseExample = openApiExampleJson(operation.responses.find((response) => response.example !== null && response.example !== undefined)?.example);
  return (
    <div className="dependency-row installed">
      <FileText size={15} />
      <div>
        <strong>{operation.method} {operation.path}</strong>
        <span>{operation.summary || operation.operationId || "Operação OpenAPI"}{operation.requestBodyRequired ? " · body obrigatório" : ""}</span>
        <small>
          request: {operation.requestContentTypes.join(", ") || "-"} {operation.requestSchema ? `· ${operation.requestSchema}` : ""}
        </small>
        <small>
          responses: {operation.responses.map((response) => `${response.status}${response.schema ? ` ${response.schema}` : ""}`).join(" | ") || "-"}
        </small>
        {requestExample ? <small>request exemplo: {requestExample}</small> : null}
        {responseExample ? <small>response exemplo: {responseExample}</small> : null}
      </div>
      <button type="button" className="command-button" onClick={() => onApply(operation)}>
        Usar no contrato
      </button>
      <button type="button" className="command-button" onClick={() => onSmoke(operation)}>
        Testar payload
      </button>
      <code>{operation.operationId || "schema"}</code>
    </div>
  );
}

function OpenApiOperationSmokeView({ result }: { result: OpenApiOperationSmokeResult }) {
  const preview = openApiExampleJson(result.responsePreview);
  return (
    <div className={result.ok ? "diagnostic success" : "diagnostic warning"}>
      <strong>Smoke OpenAPI: HTTP {result.statusCode}</strong>
      <span>{result.method} {result.url} · {result.latencyMs} ms · body {result.requestBodySent ? "enviado" : "não enviado"}</span>
      {result.requestValidation.checked ? <small>request schema: {result.requestValidation.ok ? "ok" : result.requestValidation.issues.join("; ")}</small> : null}
      {result.responseValidation.checked ? <small>response schema: {result.responseValidation.ok ? "ok" : result.responseValidation.issues.join("; ")}</small> : null}
      {result.responseContentType ? <small>{result.responseContentType}</small> : null}
      {preview ? <small>resposta: {preview}</small> : null}
    </div>
  );
}

function PlaywrightScrapeImportEditor({
  sources,
  onChange,
}: {
  sources: PlaywrightScrapeSourceDraft[];
  onChange: (index: number, patch: Partial<PlaywrightScrapeSourceDraft>) => void;
}) {
  if (!sources.length) {
    return (
      <div className="diagnostic info">
        <strong>Wizard de contrato antes da importação</strong>
        <span>Execute o scraping para carregar fontes candidatas e editar o contrato antes de pré-visualizar ou gravar.</span>
      </div>
    );
  }
  return (
    <div className="diagnostic info">
      <strong>Wizard de contrato antes da importação</strong>
      <span>Revise quais fontes entram no projeto black-box e ajuste método, URL, timeout e payload antes de pré-visualizar ou gravar.</span>
      <div className="runtime-smoke-checks">
        {sources.map((source, index) => (
          <div key={source.id} className={source.include ? "dependency-row installed" : "dependency-row missing"}>
            <input
              type="checkbox"
              checked={source.include}
              onChange={(event) => onChange(index, { include: event.target.checked })}
              aria-label={`Incluir ${source.id}`}
            />
            <div className="api-contract-grid">
              <label>
                Label
                <input value={source.label} onChange={(event) => onChange(index, { label: event.target.value })} />
              </label>
              <label>
                Método
                <select value={source.method} onChange={(event) => onChange(index, { method: event.target.value })}>
                  {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method} value={method}>{method}</option>)}
                </select>
              </label>
              <label>
                URL
                <input value={source.url} onChange={(event) => onChange(index, { url: event.target.value })} />
              </label>
              <label>
                Timeout
                <input value={source.timeoutSeconds} onChange={(event) => onChange(index, { timeoutSeconds: event.target.value })} />
              </label>
              <label>
                Descrição
                <input value={source.description} onChange={(event) => onChange(index, { description: event.target.value })} />
              </label>
              <label>
                Body template JSON
                <textarea value={source.bodyTemplateJson} onChange={(event) => onChange(index, { bodyTemplateJson: event.target.value })} placeholder='{"text": ""}' />
              </label>
            </div>
            <code>{source.id}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function playwrightScrapeImportDraftFromResult(result: PlaywrightScrapeResult): PlaywrightScrapeSourceDraft[] {
  return [
    {
      id: "scraped_page",
      include: true,
      label: "Página scrapeada",
      description: "Página raiz e links internos limitados inspecionados por Playwright.",
      method: "GET",
      url: result.finalUrl || result.url,
      timeoutSeconds: "30",
      bodyTemplateJson: "",
    },
    ...result.apiCandidates.slice(0, 5).map((candidate, index) => ({
      id: `scrape_api_candidate_${index + 1}`,
      include: true,
      label: `Candidato API ${index + 1}`,
      description: candidate.text || "Link candidato a OpenAPI/Swagger/Redoc detectado no scrape.",
      method: "GET",
      url: candidate.href,
      timeoutSeconds: "30",
      bodyTemplateJson: "",
    })),
    ...result.forms.slice(0, 5).map((form, index) => {
      const method = playwrightScrapeUiMethod(form.method);
      const inputNames = form.inputs.map((input) => input.name || input.placeholder).filter(Boolean);
      return {
        id: `scrape_form_${index + 1}`,
        include: true,
        label: `Form ${method} ${index + 1}`,
        description: `Formulário detectado no scrape com campos: ${inputNames.join(", ") || "sem campos nomeados"}.`,
        method,
        url: form.action,
        timeoutSeconds: "30",
        bodyTemplateJson: inputNames.length ? JSON.stringify(Object.fromEntries(inputNames.map((input) => [input, ""])), null, 2) : "",
      };
    }),
  ];
}

function playwrightScrapeImportContractEditsFromDrafts(sources: PlaywrightScrapeSourceDraft[]): PlaywrightScrapeImportContractEdits {
  return {
    sources: sources.map((source) => {
      if (!source.include) {
        return { id: source.id, include: false };
      }
      const timeoutSeconds = source.timeoutSeconds.trim() ? Number(source.timeoutSeconds.trim()) : undefined;
      if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)) {
        throw new Error(`Timeout inválido em ${source.id}. Use um número entre 1 e 600.`);
      }
      const bodyTemplateText = source.bodyTemplateJson.trim();
      const bodyTemplate = bodyTemplateText ? JSON.parse(bodyTemplateText) as unknown : undefined;
      return {
        id: source.id,
        include: true,
        label: source.label.trim() || undefined,
        description: source.description.trim() || undefined,
        method: playwrightScrapeUiMethod(source.method),
        url: source.url.trim() || undefined,
        timeoutSeconds,
        bodyTemplate,
      };
    }),
  };
}

function playwrightScrapeSourceLooksLikeOpenApi(source: PlaywrightScrapeSourceDraft): boolean {
  const text = `${source.id} ${source.label} ${source.description} ${source.url}`.toLowerCase();
  return text.includes("openapi") || text.includes("swagger") || text.includes("redoc");
}

function playwrightScrapeAbsoluteUrl(value: string, base: string): string {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function openApiExampleJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function playwrightScrapeUiMethod(value: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  const normalized = value.toUpperCase();
  return normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE" ? normalized : "GET";
}

function createDefaultNode(flow: PipelineFlow, type: NodeType, project: MLOpsProject | null): PipelineNode {
  const id = uniqueNodeId(flow, type);
  const node: PipelineNode = {
    id,
    type,
    label: nodeTypeOptions.find((item) => item.type === type)?.label ?? type,
    position: defaultNodePosition(flow.nodes.length + 1),
    config: {},
    dependencies: [],
  };
  if (type === "data_source") {
    node.dataSourceId = project?.dataSources[0]?.id;
  }
  if (type === "model") {
    node.algorithm = "xgboost";
    node.framework = "xgboost";
    node.modelRole = "candidate";
    node.task = project?.problem.type;
    node.dependencies = ["xgboost>=2,<3"];
  }
  if (type === "embedding") {
    node.framework = "sentence-transformers";
    node.dependencies = ["sentence-transformers>=3,<4"];
    node.config = { enabled: false, model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" };
  }
  if (type === "python_function") {
    node.python = {
      codeInline: "def run(input: dict, context: dict) -> dict:\n    return {\"result\": input}\n",
      entrypoint: "run",
      dependencies: [],
      networkPolicy: "none",
      isolationMode: "process",
      allowedHosts: [],
      mocks: [],
    };
  }
  return node;
}

function updateEdge(
  pipeline: PipelineFlow | null,
  selectedEdgeId: string,
  next: PipelineEdge,
  setPipelineDraft: React.Dispatch<React.SetStateAction<PipelineFlow | null>>,
) {
  if (!pipeline) {
    return;
  }
  setPipelineDraft({
    ...pipeline,
    edges: pipeline.edges.map((edge, index) => (edgeId(edge, index) === selectedEdgeId ? next : edge)),
  });
}

function defaultPython(node: PipelineNode): NonNullable<PipelineNode["python"]> {
  return {
    codeInline: node.python?.codeInline ?? "",
    codePath: node.python?.codePath,
    entrypoint: node.python?.entrypoint ?? "run",
    dependencies: node.python?.dependencies ?? [],
    networkPolicy: node.python?.networkPolicy ?? "none",
    isolationMode: node.python?.isolationMode ?? "process",
    allowedHosts: node.python?.allowedHosts ?? [],
    mocks: node.python?.mocks ?? [],
  };
}

type ApiMockRecord = {
  id?: string;
  description?: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
};

function normalizeApiMocks(value: unknown[] | undefined): ApiMockRecord[] {
  return Array.isArray(value) ? value.map((item) => (isRecord(item) ? item as ApiMockRecord : { id: "mock", request: {}, response: {} })) : [];
}

function defaultApiSource(source: DataSource): NonNullable<DataSource["api"]> {
  return {
    method: source.api?.method ?? "GET",
    url: source.api?.url ?? "https://api.example.local",
    headers: source.api?.headers ?? {},
    bodyTemplate: source.api?.bodyTemplate,
    pagination: source.api?.pagination ?? { mode: "none" },
    timeoutSeconds: source.api?.timeoutSeconds ?? 30,
    mocks: source.api?.mocks ?? [],
  };
}

function updateApiSourceContract(project: MLOpsProject | null, sourceId: string, patch: Record<string, unknown>): MLOpsProject | null {
  return updateApiSource(project, sourceId, (source) => ({ ...defaultApiSource(source), ...patch }));
}

function updateApiSourcePagination(project: MLOpsProject | null, sourceId: string, patch: Record<string, unknown>): MLOpsProject | null {
  return updateApiSource(project, sourceId, (source) => {
    const current = isRecord(source.api?.pagination) ? source.api.pagination : { mode: "none" };
    return { ...defaultApiSource(source), pagination: { ...current, ...patch } };
  });
}

function updateApiSourceJsonContract(project: MLOpsProject | null, sourceId: string, field: "headers" | "bodyTemplate", text: string): MLOpsProject | null {
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) {
      return project;
    }
    return updateApiSourceContract(project, sourceId, { [field]: parsed });
  } catch {
    return project;
  }
}

function addApiMock(project: MLOpsProject | null, sourceId: string): MLOpsProject | null {
  return updateApiSourceMocks(project, sourceId, (mocks, currentProject) => {
    const index = mocks.length + 1;
    const target = currentProject.problem.target;
    const label = currentProject.problem.classes[0] ?? "classe_a";
    return [
      ...mocks,
      {
        id: `mock_${index}`,
        description: "Resposta sintética para preview e treino seguro.",
        request: { method: "GET", path: "/tickets" },
        response: {
          httpStatus: 200,
          body: [{ id: index, text: `${label} exemplo`, [target]: label }],
        },
      },
    ];
  });
}

function updateApiMock(project: MLOpsProject | null, sourceId: string, mockIndex: number, patch: Partial<ApiMockRecord>): MLOpsProject | null {
  return updateApiSourceMocks(project, sourceId, (mocks) => mocks.map((mock, index) => (index === mockIndex ? { ...mock, ...patch } : mock)));
}

function updateApiMockRequest(project: MLOpsProject | null, sourceId: string, mockIndex: number, patch: Record<string, unknown>): MLOpsProject | null {
  return updateApiSourceMocks(project, sourceId, (mocks) => mocks.map((mock, index) => (index === mockIndex ? { ...mock, request: { ...(isRecord(mock.request) ? mock.request : {}), ...patch } } : mock)));
}

function updateApiMockResponse(project: MLOpsProject | null, sourceId: string, mockIndex: number, patch: Record<string, unknown>): MLOpsProject | null {
  return updateApiSourceMocks(project, sourceId, (mocks) => mocks.map((mock, index) => (index === mockIndex ? { ...mock, response: { ...(isRecord(mock.response) ? mock.response : {}), ...patch } } : mock)));
}

function updateApiMockResponseBody(project: MLOpsProject | null, sourceId: string, mockIndex: number, bodyText: string): MLOpsProject | null {
  try {
    const body = JSON.parse(bodyText);
    return updateApiMockResponse(project, sourceId, mockIndex, { body });
  } catch {
    return project;
  }
}

function removeApiMock(project: MLOpsProject | null, sourceId: string, mockIndex: number): MLOpsProject | null {
  return updateApiSourceMocks(project, sourceId, (mocks) => mocks.filter((_mock, index) => index !== mockIndex));
}

function updateApiSource(project: MLOpsProject | null, sourceId: string, updater: (source: DataSource) => NonNullable<DataSource["api"]>): MLOpsProject | null {
  if (!project) {
    return project;
  }
  return {
    ...project,
    dataSources: project.dataSources.map((source) => {
      if (source.id !== sourceId || source.type !== "api") {
        return source;
      }
      return {
        ...source,
        api: updater(source),
      };
    }),
  };
}

function updateApiSourceMocks(project: MLOpsProject | null, sourceId: string, updater: (mocks: ApiMockRecord[], project: MLOpsProject) => ApiMockRecord[]): MLOpsProject | null {
  if (!project) {
    return project;
  }
  return updateApiSource(project, sourceId, (source) => ({
    ...defaultApiSource(source),
    mocks: updater(normalizeApiMocks(source.api?.mocks), project),
  }));
}

function updateJsonField(event: ChangeEvent<HTMLTextAreaElement>, onValid: (value: Record<string, unknown>) => void) {
  try {
    onValid(JSON.parse(event.target.value));
  } catch {
    return;
  }
}

function updateJsonArrayField(event: ChangeEvent<HTMLTextAreaElement>, onValid: (value: unknown[]) => void) {
  try {
    const parsed = JSON.parse(event.target.value);
    if (Array.isArray(parsed)) {
      onValid(parsed);
    }
  } catch {
    return;
  }
}

function splitList(value: string): string[] {
  return value
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueNodeId(flow: PipelineFlow, type: string): string {
  const used = new Set(flow.nodes.map((node) => node.id));
  const base = type.replace(/[^a-zA-Z0-9_-]/g, "_") || "node";
  let index = flow.nodes.length + 1;
  let candidate = `${base}_${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  return candidate;
}

function defaultNodePosition(index: number) {
  return {
    x: 120 + (index % 5) * 220,
    y: 120 + Math.floor(index / 5) * 150,
  };
}

function edgeId(edge: Pick<PipelineEdge, "from" | "to">, index: number): string {
  return `edge-${index}-${edge.from}-${edge.to}`;
}

function edgeFromId(edges: PipelineEdge[], id: string): PipelineEdge | null {
  if (!id) {
    return null;
  }
  const match = /^edge-(\d+)-/.exec(id);
  if (!match) {
    return null;
  }
  return edges[Number(match[1])] ?? null;
}

function buildBacktestWindow(timeColumn: string, windowStart: string, windowEnd: string, comparisonWindowStart: string, comparisonWindowEnd: string, windowGranularity: BacktestWindowGranularity): { ok: true; value: BacktestWindowInput } | { ok: false; message: string } {
  const column = timeColumn.trim();
  const start = windowStart.trim();
  const end = windowEnd.trim();
  const comparisonStart = comparisonWindowStart.trim();
  const comparisonEnd = comparisonWindowEnd.trim();
  if (!column && (start || end)) {
    return { ok: false, message: "Informe a coluna temporal para usar início ou fim da janela." };
  }
  if (!column && (comparisonStart || comparisonEnd)) {
    return { ok: false, message: "Informe a coluna temporal para comparar períodos do backtest." };
  }
  if (!column && windowGranularity !== "none") {
    return { ok: false, message: "Informe a coluna temporal para agregar o backtest por janelas." };
  }
  return {
    ok: true,
    value: {
      ...(column ? { timeColumn: column } : {}),
      ...(start ? { windowStart: start } : {}),
      ...(end ? { windowEnd: end } : {}),
      ...(comparisonStart ? { comparisonWindowStart: comparisonStart } : {}),
      ...(comparisonEnd ? { comparisonWindowEnd: comparisonEnd } : {}),
      ...(windowGranularity !== "none" ? { windowGranularity } : {}),
    },
  };
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function latestApprovedRuntimeRetrainingRequest(result: RemoteRuntimeInspection | null): { requestId: string; status: string } | null {
  const body = result?.checks.find((check) => check.name === "retraining_status" && check.status === "ok")?.body;
  const latest = isRecord(body) && isRecord(body.latest_request) ? body.latest_request : null;
  const requestId = latest && typeof latest.id === "string" ? latest.id : latest && typeof latest.request_id === "string" ? latest.request_id : "";
  const status = latest && typeof latest.status === "string" ? latest.status : "";
  return requestId && status === "approved_pending_runner" ? { requestId, status } : null;
}

function workerEventDetail(event: WorkerJob["events"][number]): string {
  const ignored = new Set(["kind", "timestamp", "level", "type", "message"]);
  return Object.entries(event)
    .filter(([key, value]) => !ignored.has(key) && value !== undefined && value !== null && typeof value !== "object")
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}

function isTrainingResult(value: unknown): value is TrainingResult {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "training_result"
    && typeof (value as { runId?: unknown }).runId === "string";
}

function isEvaluationResult(value: unknown): value is EvaluationResult {
  return typeof value === "object"
    && value !== null
    && ((value as { kind?: unknown }).kind === "evaluation_result" || (value as { kind?: unknown }).kind === "backtest_result")
    && typeof (value as { evaluationId?: unknown }).evaluationId === "string";
}

function isSourcePreviewResult(value: unknown): value is SourcePreviewResult {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "source_preview"
    && typeof (value as { sourceId?: unknown }).sourceId === "string";
}

function isPythonRunResult(value: unknown): value is PythonRunResult {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "python_block_result"
    && typeof (value as { nodeId?: unknown }).nodeId === "string";
}

function buildNodeExecutionStates(
  pipeline: PipelineFlow | null,
  input: {
    manualNodeExecutions: Record<string, NodeExecutionState>;
    workerJobs: WorkerJob[];
    sourcePreview: SourcePreviewResult | null;
    pythonRunResult: PythonRunResult | null;
    trainingResult: TrainingResult | null;
    evaluationResult: EvaluationResult | null;
  },
): Map<string, NodeExecutionState> {
  const states = new Map<string, NodeExecutionState>();
  if (!pipeline) {
    return states;
  }

  if (input.sourcePreview) {
    mergeExecutionStateForNodes(states, nodeIdsForSource(pipeline, input.sourcePreview.sourceId), {
      status: sourcePreviewExecutionStatus(input.sourcePreview),
      label: "Preview",
      detail: input.sourcePreview.message ?? `${input.sourcePreview.rowCount ?? 0} linha(s)`,
      source: "result",
    });
  }
  if (input.pythonRunResult) {
    mergeExecutionStateForNodes(states, [input.pythonRunResult.nodeId], {
      status: input.pythonRunResult.status === "ok" ? "completed" : "failed",
      label: "Python",
      detail: `${input.pythonRunResult.durationMs} ms`,
      source: "result",
    });
  }
  if (input.trainingResult) {
    mergeExecutionStateForNodes(states, nodeIdsForTrainingResult(pipeline, input.trainingResult), {
      status: input.trainingResult.status === "ok" ? "completed" : "failed",
      label: "Treino",
      detail: `melhor modelo ${input.trainingResult.bestModelId}`,
      source: "result",
      updatedAt: input.trainingResult.updatedAt ?? input.trainingResult.createdAt,
    });
  }
  if (input.evaluationResult) {
    mergeExecutionStateForNodes(states, nodeIdsForEvaluationResult(pipeline, input.evaluationResult), {
      status: input.evaluationResult.status === "ok" ? "completed" : "failed",
      label: input.evaluationResult.kind === "backtest_result" ? "Backtest" : "Avaliação",
      detail: input.evaluationResult.recommendation ?? `${input.evaluationResult.primaryMetric} ${String(input.evaluationResult.metrics[input.evaluationResult.primaryMetric] ?? "-")}`,
      source: "result",
      updatedAt: input.evaluationResult.updatedAt ?? input.evaluationResult.createdAt,
    });
  }

  for (const [nodeId, state] of Object.entries(input.manualNodeExecutions)) {
    mergeExecutionState(states, nodeId, state);
  }

  const sortedJobs = [...input.workerJobs].sort((left, right) => executionTimestamp(left.startedAt) - executionTimestamp(right.startedAt));
  for (const job of sortedJobs) {
    mergeExecutionStateForNodes(states, nodeIdsForWorkerJob(pipeline, job), {
      status: workerJobNodeStatus(job),
      label: job.label ?? workerJobCommandLabel(job.command),
      detail: job.error ?? latestWorkerEventMessage(job) ?? job.label,
      source: "job",
      jobId: job.jobId,
      updatedAt: job.finishedAt ?? job.runnerStartedAt ?? job.queuedAt ?? job.startedAt,
    });
  }

  return states;
}

function mergeExecutionStateForNodes(states: Map<string, NodeExecutionState>, nodeIds: string[], state: NodeExecutionState): void {
  for (const nodeId of uniqueStrings(nodeIds)) {
    mergeExecutionState(states, nodeId, state);
  }
}

function mergeExecutionState(states: Map<string, NodeExecutionState>, nodeId: string, next: NodeExecutionState): void {
  if (!nodeId) {
    return;
  }
  const current = states.get(nodeId);
  if (!current) {
    states.set(nodeId, next);
    return;
  }
  if (next.status === "running" && current.status !== "running") {
    states.set(nodeId, next);
    return;
  }
  if (current.status === "running" && next.status !== "running" && executionTimestamp(next.updatedAt) < executionTimestamp(current.updatedAt)) {
    return;
  }
  const currentTime = executionTimestamp(current.updatedAt);
  const nextTime = executionTimestamp(next.updatedAt);
  if (nextTime > currentTime || (nextTime === currentTime && executionStatusPriority(next.status) >= executionStatusPriority(current.status))) {
    states.set(nodeId, next);
  }
}

function executionStatusPriority(status: NodeExecutionStatus): number {
  if (status === "running") {
    return 6;
  }
  if (status === "failed") {
    return 5;
  }
  if (status === "queued") {
    return 4;
  }
  if (status === "cancelled") {
    return 3;
  }
  if (status === "completed") {
    return 2;
  }
  return 1;
}

function executionTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function nodeIdsForSource(pipeline: PipelineFlow | null, sourceId: string | undefined): string[] {
  if (!pipeline || !sourceId) {
    return [];
  }
  return pipeline.nodes.filter((node) => node.type === "data_source" && node.dataSourceId === sourceId).map((node) => node.id);
}

function modelNodeIds(pipeline: PipelineFlow | null): string[] {
  return pipeline?.nodes.filter((node) => node.type === "model").map((node) => node.id) ?? [];
}

function modelNodeIdsById(pipeline: PipelineFlow | null, modelIds: Array<string | undefined | null>): string[] {
  if (!pipeline) {
    return [];
  }
  const requested = new Set(modelIds.filter((item): item is string => !!item));
  return pipeline.nodes.filter((node) => node.type === "model" && requested.has(node.id)).map((node) => node.id);
}

function evaluationNodeIds(pipeline: PipelineFlow | null): string[] {
  return pipeline?.nodes.filter((node) => node.type === "evaluation" || node.type === "promotion_rule").map((node) => node.id) ?? [];
}

function nodeIdsForTrainingResult(pipeline: PipelineFlow | null, result: TrainingResult): string[] {
  const trainedModelIds = result.leaderboard.map((row) => row.modelId);
  const trainedModels = modelNodeIdsById(pipeline, trainedModelIds);
  return [...nodeIdsForSource(pipeline, result.sourceId), ...(trainedModels.length ? trainedModels : modelNodeIds(pipeline))];
}

function nodeIdsForEvaluationResult(pipeline: PipelineFlow | null, result: EvaluationResult): string[] {
  const modelIds = uniqueStrings([
    result.modelId ?? undefined,
    result.baselineModelId,
    result.recommendedModelId,
    ...(result.candidateModelIds ?? []),
    ...Object.keys(result.modelMetrics ?? {}),
  ]);
  const models = modelNodeIdsById(pipeline, modelIds);
  return [...nodeIdsForSource(pipeline, result.sourceId), ...(models.length ? models : modelNodeIds(pipeline)), ...evaluationNodeIds(pipeline)];
}

function nodeIdsForWorkerJob(pipeline: PipelineFlow | null, job: WorkerJob): string[] {
  if (!pipeline) {
    return [];
  }
  if (job.command === "run-python-block" && job.nodeId) {
    return [job.nodeId];
  }
  if (job.command === "preview-source") {
    return nodeIdsForSource(pipeline, job.sourceId);
  }
  if (job.command === "train-baseline") {
    return [...nodeIdsForSource(pipeline, job.sourceId), ...modelNodeIds(pipeline)];
  }
  if (job.command === "evaluate-model" || job.command === "backtest-models") {
    return [...nodeIdsForSource(pipeline, job.sourceId), ...modelNodeIds(pipeline), ...evaluationNodeIds(pipeline)];
  }
  return [];
}

function sourcePreviewExecutionStatus(result: SourcePreviewResult): NodeExecutionStatus {
  if (result.status === "ok") {
    return "completed";
  }
  if (result.status === "missing" || result.status === "contract") {
    return "skipped";
  }
  return "failed";
}

function workerJobNodeStatus(job: WorkerJob): NodeExecutionStatus {
  if (job.status === "completed") {
    if (isSourcePreviewResult(job.result)) {
      return sourcePreviewExecutionStatus(job.result);
    }
    if (isRecord(job.result) && job.result.status === "error") {
      return "failed";
    }
    return "completed";
  }
  if (job.status === "queued" || job.status === "running" || job.status === "failed" || job.status === "cancelled") {
    return job.status;
  }
  return "skipped";
}

function workerJobCommandLabel(command: WorkerJob["command"]): string {
  if (command === "run-python-block") {
    return "Python";
  }
  if (command === "preview-source") {
    return "Preview";
  }
  if (command === "train-baseline") {
    return "Treino";
  }
  if (command === "evaluate-model") {
    return "Avaliação";
  }
  return "Backtest";
}

function latestWorkerEventMessage(job: WorkerJob): string | undefined {
  const latest = job.events[job.events.length - 1];
  return latest?.message;
}

function edgeExecutionClass(source: NodeExecutionState | undefined, target: NodeExecutionState | undefined): string {
  if (source?.status === "running" || target?.status === "running") {
    return "edge-running";
  }
  if (
    target?.status === "failed"
    || source?.status === "failed"
    || target?.status === "cancelled"
    || source?.status === "cancelled"
  ) {
    return "edge-failed";
  }
  if (source?.status === "skipped" || target?.status === "skipped") {
    return "edge-skipped";
  }
  if (source?.status === "completed" && target?.status === "completed") {
    return "edge-executed";
  }
  return "";
}

function nodeExecutionStatusLabel(status: NodeExecutionStatus): string {
  if (status === "queued") {
    return "na fila";
  }
  if (status === "running") {
    return "rodando";
  }
  if (status === "completed") {
    return "concluído";
  }
  if (status === "failed") {
    return "erro";
  }
  if (status === "cancelled") {
    return "cancelado";
  }
  return "pulado";
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "sem data";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("pt-BR");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
