import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const CONTRACT_VERSION = "mlops-flow-v1";

export const ProblemTypeSchema = z.enum(["binary_classification", "multiclass_classification", "regression"]);
export type ProblemType = z.infer<typeof ProblemTypeSchema>;

export const ExecutionProfileSchema = z.enum(["cpu", "gpu_cuda", "auto"]);
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

export const DataSourceTypeSchema = z.enum(["csv", "sql", "api"]);
export type DataSourceType = z.infer<typeof DataSourceTypeSchema>;

export const NetworkPolicySchema = z.enum(["none", "allowlist", "open"]);
export const PythonIsolationModeSchema = z.enum(["process", "container"]);
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export const PipelineNodeTypeSchema = z.enum([
  "input",
  "data_source",
  "preprocess",
  "feature_transform",
  "embedding",
  "model",
  "python_function",
  "operator",
  "condition",
  "promotion_rule",
  "evaluation",
  "monitoring",
  "composite",
  "output",
]);
export type PipelineNodeType = z.infer<typeof PipelineNodeTypeSchema>;

export const MetricValueTypeSchema = z.enum(["continuous", "discrete", "boolean", "categorical", "matrix", "report"]);
export const MetricDirectionSchema = z.enum(["maximize", "minimize", "informational"]);
export const RuleSeveritySchema = z.enum(["block", "review", "alert"]);
export const RuleOperatorSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "contains",
  "not_contains",
  "improved_by",
  "worse_by",
  "delta_gte",
  "delta_lte",
]);

export interface MetricCatalogItem {
  id: string;
  label: string;
  problemTypes: ProblemType[];
  valueType: z.infer<typeof MetricValueTypeSchema>;
  direction: z.infer<typeof MetricDirectionSchema>;
  defaultForPromotion: boolean;
  notes: string;
}

export const METRIC_CATALOG: MetricCatalogItem[] = [
  {
    id: "accuracy",
    label: "Accuracy",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: false,
    notes: "Útil, mas insuficiente quando há classes desbalanceadas.",
  },
  {
    id: "f1_macro",
    label: "F1 macro",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: true,
    notes: "Boa métrica primária para multiclasse com classes relevantes.",
  },
  {
    id: "f1_weighted",
    label: "F1 weighted",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: true,
    notes: "Complementa F1 macro quando há desbalanceamento.",
  },
  {
    id: "precision_macro",
    label: "Precision macro",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: false,
    notes: "Indica qualidade média das predições positivas por classe.",
  },
  {
    id: "recall_macro",
    label: "Recall macro",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: false,
    notes: "Indica cobertura média por classe.",
  },
  {
    id: "log_loss",
    label: "Log loss",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Útil quando probabilidades calibradas importam.",
  },
  {
    id: "confusion_matrix",
    label: "Matriz de confusão",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "matrix",
    direction: "informational",
    defaultForPromotion: false,
    notes: "Evidência visual, não deve ser usada sozinha como limiar escalar.",
  },
  {
    id: "rmse",
    label: "RMSE",
    problemTypes: ["regression"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: true,
    notes: "Penaliza erros grandes em regressão.",
  },
  {
    id: "mae",
    label: "MAE",
    problemTypes: ["regression"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: true,
    notes: "Erro médio absoluto, mais legível para negócio.",
  },
  {
    id: "r2",
    label: "R²",
    problemTypes: ["regression"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: false,
    notes: "Explica variância, mas pode enganar em alguns cenários.",
  },
  {
    id: "latency_p95_ms",
    label: "Latência p95",
    problemTypes: ["binary_classification", "multiclass_classification", "regression"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Métrica operacional do runtime.",
  },
  {
    id: "error_rate",
    label: "Taxa de erro",
    problemTypes: ["binary_classification", "multiclass_classification", "regression"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Falhas por predição ou operação.",
  },
  {
    id: "drift_score",
    label: "Drift score",
    problemTypes: ["binary_classification", "multiclass_classification", "regression"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Indicador agregado de mudança de distribuição.",
  },
];

export function metricCatalog(problemType?: ProblemType): MetricCatalogItem[] {
  return METRIC_CATALOG.filter((metric) => !problemType || metric.problemTypes.includes(problemType)).map((metric) => ({
    ...metric,
    problemTypes: [...metric.problemTypes],
  }));
}

export function findMetric(metricId: string): MetricCatalogItem | undefined {
  return METRIC_CATALOG.find((metric) => metric.id === metricId);
}

export const JsonSchemaLikeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonSchemaLikeSchema),
    z.record(JsonSchemaLikeSchema),
  ]),
);

export const NodePositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const SecretRefSchema = z
  .string()
  .regex(/^(env|secret):[A-Za-z_][A-Za-z0-9_:-]*$/, "Segredo deve usar referência env: ou secret:.");

export const DataSourceSchema = z
  .object({
    id: z.string().min(1),
    type: DataSourceTypeSchema,
    label: z.string().min(1),
    description: z.string().optional(),
    sensitive: z.boolean().default(false),
    csv: z
      .object({
        path: z.string().min(1).optional(),
        delimiter: z.string().min(1).max(4).default(","),
        hasHeader: z.boolean().default(true),
        encoding: z.string().default("utf-8"),
      })
      .optional(),
    sql: z
      .object({
        connectionRef: SecretRefSchema,
        query: z.string().min(1),
        previewLimit: z.number().int().positive().max(1000).default(50),
      })
      .optional(),
    api: z
      .object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        url: z.string().min(1),
        headers: z.record(SecretRefSchema).default({}),
        bodyTemplate: z.record(JsonSchemaLikeSchema).optional(),
        mocks: z
          .array(
            z.object({
              id: z.string().min(1),
              description: z.string().optional(),
              request: z.record(JsonSchemaLikeSchema).default({}),
              response: z.record(JsonSchemaLikeSchema).default({}),
            }),
          )
          .default([]),
        pagination: z
          .object({
            mode: z.enum(["none", "page", "cursor"]).default("none"),
            pageParam: z.string().optional(),
            cursorPath: z.string().optional(),
          })
          .optional(),
        timeoutSeconds: z.number().int().positive().max(300).default(30),
      })
      .optional(),
    schema: z.record(JsonSchemaLikeSchema).default({}),
    sensitiveFields: z.array(z.string().min(1)).default([]),
  })
  .superRefine((source, ctx) => {
    if (source.type === "csv" && !source.csv) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["csv"], message: "Fonte CSV precisa de configuração csv." });
    }
    if (source.type === "sql" && !source.sql) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sql"], message: "Fonte SQL precisa de configuração sql." });
    }
    if (source.type === "api" && !source.api) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["api"], message: "Fonte API precisa de configuração api." });
    }
  });
export type DataSource = z.infer<typeof DataSourceSchema>;

export const PythonBlockSchema = z.object({
  codePath: z.string().min(1).optional(),
  codeInline: z.string().min(1).optional(),
  entrypoint: z.string().min(1).default("run"),
  inputSchema: z.record(JsonSchemaLikeSchema).default({}),
  outputSchema: z.record(JsonSchemaLikeSchema).default({}),
  dependencies: z.array(z.string().min(1)).default([]),
  networkPolicy: NetworkPolicySchema.default("none"),
  isolationMode: PythonIsolationModeSchema.default("process"),
  allowedHosts: z.array(z.string().min(1)).default([]),
  mocks: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().optional(),
        request: z.record(JsonSchemaLikeSchema).default({}),
        response: z.record(JsonSchemaLikeSchema).default({}),
      }),
    )
    .default([]),
});

export const PipelineNodeSchema = z
  .object({
    id: z.string().min(1),
    type: PipelineNodeTypeSchema,
    label: z.string().min(1).optional(),
    description: z.string().optional(),
    dataSourceId: z.string().min(1).optional(),
    algorithm: z.string().min(1).optional(),
    framework: z.string().min(1).optional(),
    task: ProblemTypeSchema.optional(),
    modelRole: z.enum(["candidate", "baseline", "active", "shadow"]).optional(),
    inputSchema: z.record(JsonSchemaLikeSchema).default({}),
    outputSchema: z.record(JsonSchemaLikeSchema).default({}),
    config: z.record(JsonSchemaLikeSchema).default({}),
    python: PythonBlockSchema.optional(),
    dependencies: z.array(z.string().min(1)).default([]),
    networkPolicy: NetworkPolicySchema.optional(),
    subgraphId: z.string().min(1).optional(),
    position: NodePositionSchema.optional(),
  })
  .passthrough();
export type PipelineNode = z.infer<typeof PipelineNodeSchema>;

export const PipelineEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.string().min(1).optional(),
  mapping: z.record(z.string()).default({}),
});
export type PipelineEdge = z.infer<typeof PipelineEdgeSchema>;

export const PipelineFlowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    contract: z.literal(CONTRACT_VERSION).default(CONTRACT_VERSION),
    description: z.string().optional(),
    nodes: z.array(PipelineNodeSchema).min(1),
    edges: z.array(PipelineEdgeSchema).default([]),
    subgraphs: z.array(z.unknown()).default([]),
    visual: z
      .object({
        viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() }).optional(),
        selectedNodeId: z.string().optional(),
      })
      .default({}),
  })
  .superRefine((flow, ctx) => {
    const nodeIds = new Set(flow.nodes.map((node) => node.id));
    for (const edge of flow.edges) {
      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges"], message: `Aresta referencia origem inexistente: ${edge.from}.` });
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges"], message: `Aresta referencia destino inexistente: ${edge.to}.` });
      }
    }
  });
export type PipelineFlow = z.infer<typeof PipelineFlowSchema>;

export const RuleMetricRefSchema = z.object({
  metric: z.string().min(1),
  scope: z.enum(["candidate", "active", "baseline", "runtime", "dataset", "custom"]).default("candidate"),
  phase: z.enum(["train", "validation", "test", "backtest", "runtime"]).default("validation"),
});

export const MetricRuleSchema = z.object({
  kind: z.literal("metric"),
  id: z.string().min(1),
  label: z.string().min(1),
  left: RuleMetricRefSchema,
  operator: RuleOperatorSchema,
  value: z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]),
  compareTo: RuleMetricRefSchema.optional(),
  neutralBand: z.number().nonnegative().default(0),
  severity: RuleSeveritySchema.default("block"),
  rationale: z.string().optional(),
});

export const PythonRuleSchema = z.object({
  kind: z.literal("python"),
  id: z.string().min(1),
  label: z.string().min(1),
  python: PythonBlockSchema,
  outputType: MetricValueTypeSchema.default("boolean"),
  expectedValue: z.union([z.number(), z.string(), z.boolean()]).optional(),
  severity: RuleSeveritySchema.default("review"),
  rationale: z.string().optional(),
});

export const PromotionRuleSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    MetricRuleSchema,
    PythonRuleSchema,
    z.object({
      kind: z.literal("group"),
      id: z.string().min(1),
      label: z.string().min(1),
      combinator: z.enum(["all", "any"]),
      rules: z.array(PromotionRuleSchema).min(1),
      severity: RuleSeveritySchema.default("block"),
    }),
  ]),
);

export type PromotionRule = z.infer<typeof PromotionRuleSchema>;

export interface PromotionRuleGroup {
  kind: "group";
  id: string;
  label: string;
  combinator: "all" | "any";
  rules: PromotionRule[];
  severity: z.infer<typeof RuleSeveritySchema>;
}

export const PromotionPolicySchema = z.object({
  id: z.string().min(1).default("default-promotion-policy"),
  mode: z.enum(["recommend_only", "manual_approval", "automatic"]).default("manual_approval"),
  baseline: z.enum(["active_model", "best_previous", "fixed"]).default("active_model"),
  rules: z.array(PromotionRuleSchema).default([]),
});
export type PromotionPolicy = z.infer<typeof PromotionPolicySchema>;

export const RuntimeConfigSchema = z.object({
  apiName: z.string().min(1).default("MLOps Inference API"),
  routePrefix: z.string().default(""),
  persistence: z
    .object({
      primary: z.enum(["postgres", "external_postgres", "sqlite_dev"]).default("postgres"),
      databaseUrlRef: z.string().min(1).default("env:DATABASE_URL"),
    })
    .default({}),
  dashboard: z
    .object({
      enabled: z.boolean().default(true),
      pages: z
        .array(z.enum(["overview", "data", "models", "prediction", "monitoring", "events", "docs"]))
        .default(["overview", "data", "models", "prediction", "monitoring", "events", "docs"]),
      highlightedMetrics: z.array(z.string().min(1)).default(["f1_macro", "accuracy", "latency_p95_ms"]),
    })
    .default({}),
  mlflow: z
    .object({
      enabled: z.boolean().default(false),
      trackingUriRef: z.string().min(1).default("env:MLFLOW_TRACKING_URI"),
      experimentName: z.string().min(1).optional(),
      registryEnabled: z.boolean().default(false),
    })
    .default({}),
});

export const MLOpsProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  contract: z.literal(CONTRACT_VERSION).default(CONTRACT_VERSION),
  description: z.string().optional(),
  problem: z.object({
    type: ProblemTypeSchema,
    target: z.string().min(1),
    classes: z.array(z.string().min(1)).default([]),
    classDependencies: z
      .array(
        z.object({
          child: z.string().min(1),
          parent: z.string().min(1),
          condition: z.string().min(1).optional(),
        }),
      )
      .default([]),
  }),
  execution: z
    .object({
      profile: ExecutionProfileSchema.default("cpu"),
      gpu: z
        .object({
          minVramGb: z.number().positive().optional(),
          cudaRequired: z.boolean().default(false),
          fallback: z.enum(["cpu", "fail"]).default("cpu"),
        })
        .optional(),
    })
    .default({}),
  metrics: z.object({
    primary: z.string().min(1),
    secondary: z.array(z.string().min(1)).default([]),
  }),
  dataSources: z.array(DataSourceSchema).default([]),
  pipelineRef: z.string().min(1).default("pipeline.flow.json"),
  promotionPolicy: PromotionPolicySchema.default({}),
  runtime: RuntimeConfigSchema.default({}),
  modelCard: z
    .object({
      intendedUse: z.string().default("Inferência operacional gerada pelo MLOps Flow Studio."),
      limitations: z.array(z.string()).default([]),
      monitoring: z.array(z.string()).default(["prediction_logs", "runtime_metrics", "drift_basic"]),
      riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
    })
    .default({}),
  sensitiveFields: z.array(z.string().min(1)).default([]),
  dependencies: z.array(z.string().min(1)).default([]),
  owners: z.array(z.string().min(1)).default([]),
});
export type MLOpsProject = z.infer<typeof MLOpsProjectSchema>;

export const RuntimeManifestSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  projectVersion: z.string().min(1),
  generatedKind: z.literal("mlops-runtime"),
  contract: z.literal(CONTRACT_VERSION).default(CONTRACT_VERSION),
  generatedAt: z.string().datetime(),
  projectHash: z.string().min(1),
  pipelineHash: z.string().min(1),
  activeModelId: z.string().min(1),
  executionProfile: ExecutionProfileSchema,
  persistence: z.object({
    primary: z.enum(["postgres", "external_postgres", "sqlite_dev"]),
    databaseUrlRef: z.string().min(1),
  }),
  endpoints: z.array(z.string().min(1)).min(1),
});
export type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>;

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  nodeId?: string;
  edgeIndex?: number;
}

export interface AnalysisSummary {
  nodes: number;
  edges: number;
  dataSources: number;
  modelNodes: number;
  pythonNodes: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface AnalysisResult {
  status: "ok" | "error";
  diagnostics: Diagnostic[];
  summary: AnalysisSummary;
}

export function parseMLOpsProject(value: unknown): MLOpsProject {
  return MLOpsProjectSchema.parse(value);
}

export function parsePipelineFlow(value: unknown): PipelineFlow {
  return PipelineFlowSchema.parse(value);
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  return RuntimeManifestSchema.parse(value);
}

export function analyzeMLOpsProject(project: MLOpsProject, pipeline?: PipelineFlow): AnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const add = (diagnostic: Diagnostic) => diagnostics.push(diagnostic);
  const metricIds = new Set(metricCatalog(project.problem.type).map((metric) => metric.id));

  if (!metricIds.has(project.metrics.primary)) {
    add({
      severity: "warning",
      code: "primary_metric_unusual_for_problem",
      message: `Métrica primária '${project.metrics.primary}' não está no catálogo recomendado para ${project.problem.type}.`,
      path: "metrics.primary",
    });
  }

  for (const metric of project.metrics.secondary) {
    if (!metricIds.has(metric)) {
      add({
        severity: "info",
        code: "secondary_metric_outside_catalog",
        message: `Métrica secundária '${metric}' não está no catálogo do tipo de problema.`,
        path: "metrics.secondary",
      });
    }
  }

  if (project.problem.type === "multiclass_classification" && project.problem.classes.length < 3) {
    add({
      severity: "warning",
      code: "multiclass_without_class_list",
      message: "Classificação multiclasse deve declarar a lista de classes quando possível.",
      path: "problem.classes",
    });
  }

  if (project.execution.profile === "gpu_cuda" && !project.execution.gpu?.cudaRequired) {
    add({
      severity: "info",
      code: "gpu_profile_without_cuda_requirement",
      message: "Perfil gpu_cuda ativo, mas cudaRequired não foi marcado. O runtime deve manter fallback explícito.",
      path: "execution.gpu",
    });
  }

  for (const source of project.dataSources) {
    if (source.type === "sql" && source.sql?.connectionRef && !source.sql.connectionRef.startsWith("env:") && !source.sql.connectionRef.startsWith("secret:")) {
      add({
        severity: "error",
        code: "sql_secret_not_reference",
        message: `Fonte ${source.id} deve usar referência de segredo para conexão SQL.`,
        path: `dataSources.${source.id}.sql.connectionRef`,
      });
    }
  }

  if (!project.promotionPolicy.rules.length) {
    add({
      severity: "warning",
      code: "missing_promotion_rules",
      message: "Projeto ainda não tem regras de promoção. O Studio pode recomendar, mas não deve substituir modelo sem política.",
      path: "promotionPolicy.rules",
    });
  }

  if (pipeline) {
    diagnostics.push(...analyzePipelineFlow(pipeline, project).diagnostics);
  }

  return summarize(project, pipeline, diagnostics);
}

export function analyzePipelineFlow(pipeline: PipelineFlow, project?: MLOpsProject): AnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const add = (diagnostic: Diagnostic) => diagnostics.push(diagnostic);
  const ids = new Set<string>();
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();

  for (const node of pipeline.nodes) {
    if (ids.has(node.id)) {
      add({ severity: "error", code: "duplicate_node_id", message: `Nó duplicado: ${node.id}.`, path: `nodes.${node.id}`, nodeId: node.id });
    }
    ids.add(node.id);

    if (node.type === "model" && !node.algorithm && !node.framework) {
      add({
        severity: "warning",
        code: "model_without_algorithm",
        message: `Nó ${node.id} é modelo, mas não declara algoritmo ou framework.`,
        path: `nodes.${node.id}`,
        nodeId: node.id,
      });
    }
    if (node.type === "python_function" && !node.python?.codePath && !node.python?.codeInline) {
      add({
        severity: "warning",
        code: "python_node_without_code",
        message: `Nó ${node.id} precisa declarar codePath ou codeInline.`,
        path: `nodes.${node.id}.python`,
        nodeId: node.id,
      });
    }
    if (node.python?.networkPolicy === "allowlist" && !node.python.allowedHosts.length) {
      add({
        severity: "warning",
        code: "allowlist_without_hosts",
        message: `Nó ${node.id} usa allowlist sem hosts permitidos.`,
        path: `nodes.${node.id}.python.allowedHosts`,
        nodeId: node.id,
      });
    }
    if (node.type === "composite" && !node.subgraphId) {
      add({
        severity: "warning",
        code: "composite_without_subgraph",
        message: `Bloco composto ${node.id} ainda não aponta para subgrafo.`,
        path: `nodes.${node.id}.subgraphId`,
        nodeId: node.id,
      });
    }
    if (node.type === "data_source" && project && node.dataSourceId && !project.dataSources.some((source) => source.id === node.dataSourceId)) {
      add({
        severity: "error",
        code: "unknown_data_source",
        message: `Nó ${node.id} referencia fonte inexistente: ${node.dataSourceId}.`,
        path: `nodes.${node.id}.dataSourceId`,
        nodeId: node.id,
      });
    }
  }

  const edgeKeys = new Set<string>();
  for (const [index, edge] of pipeline.edges.entries()) {
    if (!ids.has(edge.from)) {
      add({ severity: "error", code: "unknown_edge_source", message: `Aresta ${index} usa origem inexistente: ${edge.from}.`, path: `edges.${index}.from`, edgeIndex: index });
    }
    if (!ids.has(edge.to)) {
      add({ severity: "error", code: "unknown_edge_target", message: `Aresta ${index} usa destino inexistente: ${edge.to}.`, path: `edges.${index}.to`, edgeIndex: index });
    }
    if (edge.from === edge.to) {
      add({ severity: "error", code: "self_loop_edge", message: `Aresta ${index} cria loop no próprio nó ${edge.from}.`, path: `edges.${index}`, edgeIndex: index });
    }
    const edgeKey = `${edge.from}->${edge.to}:${edge.condition ?? ""}`;
    if (edgeKeys.has(edgeKey)) {
      add({ severity: "warning", code: "duplicate_edge", message: `Aresta duplicada: ${edge.from} -> ${edge.to}.`, path: `edges.${index}`, edgeIndex: index });
    }
    edgeKeys.add(edgeKey);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }

  const inputNodes = pipeline.nodes.filter((node) => node.type === "input" || node.type === "data_source");
  const outputNodes = pipeline.nodes.filter((node) => node.type === "output");
  if (!inputNodes.length) {
    add({ severity: "error", code: "missing_input_node", message: "Pipeline precisa de pelo menos um nó input ou data_source.", path: "nodes" });
  }
  if (!outputNodes.length) {
    add({ severity: "error", code: "missing_output_node", message: "Pipeline precisa de pelo menos um nó output.", path: "nodes" });
  }

  const reachable = new Set<string>();
  for (const input of inputNodes) {
    for (const id of traverse(input.id, outgoing)) {
      reachable.add(id);
    }
  }
  const terminalReachable = new Set<string>();
  for (const output of outputNodes) {
    for (const id of reverseTraverse(output.id, incoming)) {
      terminalReachable.add(id);
    }
  }
  for (const node of pipeline.nodes) {
    if (!inputNodes.some((input) => input.id === node.id) && !incoming.has(node.id)) {
      add({ severity: "error", code: "missing_node_input", message: `Nó ${node.id} não tem entrada.`, path: `nodes.${node.id}`, nodeId: node.id });
    }
    if (!outputNodes.some((output) => output.id === node.id) && !outgoing.has(node.id)) {
      add({ severity: "error", code: "missing_node_output", message: `Nó ${node.id} não tem saída.`, path: `nodes.${node.id}`, nodeId: node.id });
    }
    if (!reachable.has(node.id)) {
      add({ severity: "error", code: "unreachable_node", message: `Nó ${node.id} não é alcançável a partir de uma entrada.`, path: `nodes.${node.id}`, nodeId: node.id });
    }
    if (!terminalReachable.has(node.id)) {
      add({ severity: "warning", code: "node_without_output_path", message: `Nó ${node.id} não tem caminho conhecido até uma saída.`, path: `nodes.${node.id}`, nodeId: node.id });
    }
  }

  for (const cycle of detectCycles(pipeline.nodes.map((node) => node.id), outgoing)) {
    add({
      severity: "error",
      code: "cycle_detected",
      message: `Pipeline deve ser DAG; ciclo detectado: ${cycle.join(" -> ")}.`,
      path: "edges",
    });
  }

  return summarize(project, pipeline, diagnostics);
}

export function mlopsProjectJsonSchema() {
  return zodToJsonSchema(MLOpsProjectSchema, "MLOpsProject");
}

export function pipelineFlowJsonSchema() {
  return zodToJsonSchema(PipelineFlowSchema, "PipelineFlow");
}

export function dataSourceJsonSchema() {
  return zodToJsonSchema(DataSourceSchema, "DataSource");
}

export function promotionPolicyJsonSchema() {
  return zodToJsonSchema(PromotionPolicySchema, "PromotionPolicy");
}

export function runtimeManifestJsonSchema() {
  return zodToJsonSchema(RuntimeManifestSchema, "RuntimeManifest");
}

function summarize(project: MLOpsProject | undefined, pipeline: PipelineFlow | undefined, diagnostics: Diagnostic[]): AnalysisResult {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const infos = diagnostics.filter((diagnostic) => diagnostic.severity === "info").length;
  return {
    status: errors ? "error" : "ok",
    diagnostics,
    summary: {
      nodes: pipeline?.nodes.length ?? 0,
      edges: pipeline?.edges.length ?? 0,
      dataSources: project?.dataSources.length ?? 0,
      modelNodes: pipeline?.nodes.filter((node) => node.type === "model").length ?? 0,
      pythonNodes: pipeline?.nodes.filter((node) => node.type === "python_function").length ?? 0,
      errors,
      warnings,
      infos,
    },
  };
}

function traverse(start: string, outgoing: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) {
      stack.push(next);
    }
  }
  return seen;
}

function reverseTraverse(start: string, incoming: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const previous of incoming.get(current) ?? []) {
      stack.push(previous);
    }
  }
  return seen;
}

function detectCycles(nodeIds: string[], outgoing: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      const cycleStart = path.indexOf(nodeId);
      cycles.push([...path.slice(Math.max(cycleStart, 0)), nodeId]);
      return;
    }
    visiting.add(nodeId);
    path.push(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) {
      visit(next);
    }
    path.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const nodeId of nodeIds) {
    visit(nodeId);
  }
  return cycles;
}
