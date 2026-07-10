import type {
  EvaluationResult,
  PipelineFlow,
  PythonRunResult,
  SourcePreviewResult,
  TrainingResult,
  WorkerJob,
} from "./types.ts";

export type NodeExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";

export interface NodeExecutionState {
  status: NodeExecutionStatus;
  label: string;
  detail?: string;
  source: "job" | "result" | "manual";
  jobId?: string;
  updatedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isTrainingResult(value: unknown): value is TrainingResult {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "training_result"
    && typeof (value as { runId?: unknown }).runId === "string";
}

export function isEvaluationResult(value: unknown): value is EvaluationResult {
  return typeof value === "object"
    && value !== null
    && ((value as { kind?: unknown }).kind === "evaluation_result" || (value as { kind?: unknown }).kind === "backtest_result")
    && typeof (value as { evaluationId?: unknown }).evaluationId === "string";
}

export function isSourcePreviewResult(value: unknown): value is SourcePreviewResult {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "source_preview"
    && typeof (value as { sourceId?: unknown }).sourceId === "string";
}

export function isPythonRunResult(value: unknown): value is PythonRunResult {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "python_block_result"
    && typeof (value as { nodeId?: unknown }).nodeId === "string";
}

export function buildNodeExecutionStates(
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

export function mergeExecutionStateForNodes(states: Map<string, NodeExecutionState>, nodeIds: string[], state: NodeExecutionState): void {
  for (const nodeId of uniqueStrings(nodeIds)) {
    mergeExecutionState(states, nodeId, state);
  }
}

export function mergeExecutionState(states: Map<string, NodeExecutionState>, nodeId: string, next: NodeExecutionState): void {
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

export function executionStatusPriority(status: NodeExecutionStatus): number {
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

export function executionTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function nodeIdsForSource(pipeline: PipelineFlow | null, sourceId: string | undefined): string[] {
  if (!pipeline || !sourceId) {
    return [];
  }
  return pipeline.nodes.filter((node) => node.type === "data_source" && node.dataSourceId === sourceId).map((node) => node.id);
}

export function modelNodeIds(pipeline: PipelineFlow | null): string[] {
  return pipeline?.nodes.filter((node) => node.type === "model").map((node) => node.id) ?? [];
}

export function modelNodeIdsById(pipeline: PipelineFlow | null, modelIds: Array<string | undefined | null>): string[] {
  if (!pipeline) {
    return [];
  }
  const requested = new Set(modelIds.filter((item): item is string => !!item));
  return pipeline.nodes.filter((node) => node.type === "model" && requested.has(node.id)).map((node) => node.id);
}

export function evaluationNodeIds(pipeline: PipelineFlow | null): string[] {
  return pipeline?.nodes.filter((node) => node.type === "evaluation" || node.type === "promotion_rule").map((node) => node.id) ?? [];
}

export function nodeIdsForTrainingResult(pipeline: PipelineFlow | null, result: TrainingResult): string[] {
  const trainedModelIds = result.leaderboard.map((row) => row.modelId);
  const trainedModels = modelNodeIdsById(pipeline, trainedModelIds);
  return [...nodeIdsForSource(pipeline, result.sourceId), ...(trainedModels.length ? trainedModels : modelNodeIds(pipeline))];
}

export function nodeIdsForEvaluationResult(pipeline: PipelineFlow | null, result: EvaluationResult): string[] {
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

export function nodeIdsForWorkerJob(pipeline: PipelineFlow | null, job: WorkerJob): string[] {
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

export function sourcePreviewExecutionStatus(result: SourcePreviewResult): NodeExecutionStatus {
  if (result.status === "ok") {
    return "completed";
  }
  if (result.status === "missing" || result.status === "contract") {
    return "skipped";
  }
  return "failed";
}

export function workerJobNodeStatus(job: WorkerJob): NodeExecutionStatus {
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

export function workerJobCommandLabel(command: WorkerJob["command"]): string {
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

export function latestWorkerEventMessage(job: WorkerJob): string | undefined {
  const latest = job.events[job.events.length - 1];
  return latest?.message;
}

export function edgeExecutionClass(source: NodeExecutionState | undefined, target: NodeExecutionState | undefined): string {
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

export function nodeExecutionStatusLabel(status: NodeExecutionStatus): string {
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

export function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}
