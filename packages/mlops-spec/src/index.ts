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
  "vector_index",
  "retrieval",
  "model",
  "decision",
  "llm",
  "human_review",
  "python_function",
  "operator",
  "condition",
  "promotion_rule",
  "evaluation",
  "monitoring",
  "drift_monitor",
  "retraining_trigger",
  "model_registry",
  "composite",
  "output",
]);
export type PipelineNodeType = z.infer<typeof PipelineNodeTypeSchema>;

export const PipelineCapabilityKindSchema = z.enum([
  "data_ingestion",
  "preprocessing",
  "feature_engineering",
  "embeddings",
  "vector_store",
  "retrieval",
  "model_training",
  "model_inference",
  "decision",
  "rules",
  "llm",
  "human_review",
  "evaluation",
  "drift_monitoring",
  "retraining",
  "model_registry",
  "deployment",
  "orchestration",
  "custom_code",
]);
export type PipelineCapabilityKind = z.infer<typeof PipelineCapabilityKindSchema>;

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
    id: "top_3_accuracy",
    label: "Top-3 accuracy",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: false,
    notes: "Útil para fluxos com revisão humana, em que a classe correta deve aparecer entre os candidatos sugeridos.",
  },
  {
    id: "top_5_accuracy",
    label: "Top-5 accuracy",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: false,
    notes: "Mede cobertura de candidatos quando o workflow mostra uma lista curta ao analista.",
  },
  {
    id: "roc_auc_ovr",
    label: "ROC AUC one-vs-rest",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: false,
    notes: "Complementar para problemas multiclasse; deve ser interpretada com cuidado em classes desbalanceadas.",
  },
  {
    id: "pr_auc_macro",
    label: "PR AUC macro",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: false,
    notes: "Mais informativa que ROC AUC para categorias raras ou críticas.",
  },
  {
    id: "brier_score",
    label: "Brier score",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Avalia calibração probabilística para decisões de baixa confiança.",
  },
  {
    id: "expected_calibration_error",
    label: "Expected calibration error",
    problemTypes: ["binary_classification", "multiclass_classification"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Mede se a confiança informada pelo modelo é compatível com a taxa real de acerto.",
  },
  {
    id: "invalid_workflow_transition_rate",
    label: "Taxa de transição inválida",
    problemTypes: ["binary_classification", "multiclass_classification", "regression"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Guardrail jurídico-operacional: um modelo melhor em ML não pode aumentar transições impossíveis no workflow.",
  },
  {
    id: "low_confidence_rate",
    label: "Taxa de baixa confiança",
    problemTypes: ["binary_classification", "multiclass_classification", "regression"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Ajuda a dimensionar revisão humana e acionamento de LLM.",
  },
  {
    id: "human_review_rate",
    label: "Taxa de revisão humana",
    problemTypes: ["binary_classification", "multiclass_classification", "regression"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Métrica operacional para acompanhar automação real sem esconder casos enviados para revisão.",
  },
  {
    id: "llm_review_rate",
    label: "Taxa de revisão por LLM",
    problemTypes: ["binary_classification", "multiclass_classification", "regression"],
    valueType: "continuous",
    direction: "minimize",
    defaultForPromotion: false,
    notes: "Controla custo e risco da quarta camada de decisão.",
  },
  {
    id: "semantic_recall_at_5",
    label: "Recall semântico@5",
    problemTypes: ["binary_classification", "multiclass_classification", "regression"],
    valueType: "continuous",
    direction: "maximize",
    defaultForPromotion: false,
    notes: "Avalia se a camada vetorial recupera categorias, etapas ou exemplos relevantes entre os cinco mais próximos.",
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

export const ProviderModeSchema = z.enum(["embedded", "container", "external", "managed", "disabled"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const ProviderBindingSchema = z
  .object({
    provider: z.string().min(1),
    mode: ProviderModeSchema.default("external"),
    enabled: z.boolean().default(true),
    required: z.boolean().default(false),
    connectionRef: z.string().min(1).optional(),
    image: z.string().min(1).optional(),
    serviceName: z.string().min(1).optional(),
    environment: z.record(JsonSchemaLikeSchema).default({}),
    config: z.record(JsonSchemaLikeSchema).default({}),
  })
  .passthrough();
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;

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
    capability: PipelineCapabilityKindSchema.optional(),
    requires: z.array(PipelineCapabilityKindSchema).default([]),
    provider: ProviderBindingSchema.optional(),
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
  capabilities: z
    .object({
      mode: z.enum(["auto", "manual"]).default("auto"),
      providers: z.record(ProviderBindingSchema).default({}),
    })
    .default({}),
});

export const LegalCategoryManifestSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  target: z.enum(["documento", "andamento", "processo", "misto"]).default("documento"),
  parentCode: z.string().min(1).optional(),
  critical: z.boolean().default(false),
  requiresHumanReview: z.boolean().default(false),
  workflowStepCodes: z.array(z.string().min(1)).default([]),
});
export type LegalCategoryManifest = z.infer<typeof LegalCategoryManifestSchema>;

export const LegalWorkflowStepManifestSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  rite: z.string().min(1).default("default"),
  order: z.number().int().nonnegative().optional(),
  stepType: z.string().min(1).optional(),
  requiresDocument: z.boolean().default(false),
  requiresHumanReview: z.boolean().default(false),
  slaHours: z.number().int().positive().optional(),
});
export type LegalWorkflowStepManifest = z.infer<typeof LegalWorkflowStepManifestSchema>;

export const LegalWorkflowTransitionManifestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  rite: z.string().min(1).default("default"),
  condition: z.string().optional(),
  severity: RuleSeveritySchema.default("block"),
  active: z.boolean().default(true),
});
export type LegalWorkflowTransitionManifest = z.infer<typeof LegalWorkflowTransitionManifestSchema>;

export const EmbeddingProfileManifestSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  modelName: z.string().min(1),
  modelVersion: z.string().optional(),
  modelDigest: z.string().optional(),
  dimension: z.number().int().positive(),
  normalization: z.string().min(1).optional(),
  pooling: z.string().min(1).optional(),
  preprocessingVersion: z.string().min(1),
  chunkingVersion: z.string().min(1),
  similarityMetric: z.enum(["cosine", "dot", "euclidean"]).default("cosine"),
  vectorCollections: z.record(z.string().min(1)).default({}),
  status: z.enum(["candidate", "active", "deprecated", "archived"]).default("candidate"),
});
export type EmbeddingProfileManifest = z.infer<typeof EmbeddingProfileManifestSchema>;

export const LegalDecisionPolicySchema = z.object({
  version: z.string().min(1).default("legal-decision-policy-v1"),
  lowConfidenceThreshold: z.number().min(0).max(1).default(0.62),
  topMarginThreshold: z.number().min(0).max(1).default(0.08),
  weights: z
    .object({
      classifierProbability: z.number().min(0).max(1).default(0.55),
      semanticSimilarity: z.number().min(0).max(1).default(0.3),
      workflowRules: z.number().min(0).max(1).default(0.15),
      llmReview: z.number().min(0).max(1).default(0),
    })
    .default({}),
});
export type LegalDecisionPolicy = z.infer<typeof LegalDecisionPolicySchema>;

export const LegalLlmPolicySchema = z.object({
  enabled: z.boolean().default(false),
  promptTemplateVersion: z.string().min(1).default("legal-low-confidence-v1"),
  triggerPolicy: z.array(z.enum(["low_confidence", "top_margin_low", "classifier_semantic_conflict", "workflow_blocked", "manual_request"])).default(["low_confidence"]),
  maskSensitiveData: z.boolean().default(true),
  jsonResponseRequired: z.boolean().default(true),
  mustNotAutoApply: z.boolean().default(true),
});
export type LegalLlmPolicy = z.infer<typeof LegalLlmPolicySchema>;

export const LegalClassificationDomainSchema = z.object({
  processIdentifierField: z.string().min(1).default("numero_unico"),
  documentTextField: z.string().min(1).default("texto"),
  categoryTargetField: z.string().min(1).default("categoria_final"),
  workflowContextField: z.string().min(1).default("workflow_step_atual"),
  categories: z.array(LegalCategoryManifestSchema).default([]),
  workflowSteps: z.array(LegalWorkflowStepManifestSchema).default([]),
  workflowTransitions: z.array(LegalWorkflowTransitionManifestSchema).default([]),
  embeddingProfiles: z.array(EmbeddingProfileManifestSchema).default([]),
  decisionPolicy: LegalDecisionPolicySchema.default({}),
  llm: LegalLlmPolicySchema.default({}),
});
export type LegalClassificationDomain = z.infer<typeof LegalClassificationDomainSchema>;

export const DomainConfigSchema = z
  .object({
    kind: z.enum(["generic", "legal_classification"]).default("generic"),
    legal: LegalClassificationDomainSchema.optional(),
  })
  .superRefine((domain, ctx) => {
    if (domain.kind === "legal_classification" && !domain.legal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["legal"],
        message: "Domínio legal_classification precisa declarar a seção legal.",
      });
    }
  });
export type DomainConfig = z.infer<typeof DomainConfigSchema>;

export const MLOpsProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  contract: z.literal(CONTRACT_VERSION).default(CONTRACT_VERSION),
  description: z.string().optional(),
  template: z
    .object({
      id: z.string().min(1),
      category: z.string().min(1).default("custom"),
      validationCase: z.boolean().default(false),
      source: z.string().min(1).optional(),
    })
    .optional(),
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
  domain: DomainConfigSchema.default({}),
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
  capabilities: z
    .array(
      z
        .object({
          kind: PipelineCapabilityKindSchema,
          provider: z.string().min(1).optional(),
          mode: ProviderModeSchema.optional(),
          enabled: z.boolean().default(true),
          required: z.boolean().default(false),
          source: z.string().min(1),
          nodeIds: z.array(z.string().min(1)).default([]),
          notes: z.array(z.string().min(1)).default([]),
        })
        .passthrough(),
    )
    .default([]),
  infrastructure: z
    .object({
      services: z
        .array(
          z.object({
            id: z.string().min(1),
            provider: z.string().min(1),
            mode: ProviderModeSchema,
            required: z.boolean().default(false),
          }),
        )
        .default([]),
      composeFiles: z.array(z.string().min(1)).default([]),
    })
    .default({}),
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

export interface InferredPipelineCapability {
  kind: PipelineCapabilityKind;
  provider?: string;
  mode?: ProviderMode;
  enabled: boolean;
  required: boolean;
  source: string;
  nodeIds: string[];
  notes: string[];
}

export function inferPipelineCapabilities(pipeline: PipelineFlow, project?: MLOpsProject): InferredPipelineCapability[] {
  const capabilities = new Map<string, InferredPipelineCapability>();
  const add = (capability: Omit<InferredPipelineCapability, "nodeIds" | "notes"> & { nodeId?: string; notes?: string[] }) => {
    const key = [capability.kind, capability.provider ?? "", capability.mode ?? "", capability.source].join("|");
    const existing = capabilities.get(key);
    if (existing) {
      if (capability.nodeId && !existing.nodeIds.includes(capability.nodeId)) {
        existing.nodeIds.push(capability.nodeId);
      }
      existing.enabled = existing.enabled || capability.enabled;
      existing.required = existing.required || capability.required;
      existing.notes.push(...(capability.notes ?? []));
      return;
    }
    capabilities.set(key, {
      kind: capability.kind,
      provider: capability.provider,
      mode: capability.mode,
      enabled: capability.enabled,
      required: capability.required,
      source: capability.source,
      nodeIds: capability.nodeId ? [capability.nodeId] : [],
      notes: capability.notes ?? [],
    });
  };

  for (const node of pipeline.nodes) {
    const enabled = isEnabledNode(node);
    const provider = providerNameForNode(node);
    const mode = providerModeForNode(node);
    const required = providerRequiredForNode(node);
    const directKind = node.capability ?? capabilityKindForNodeType(node.type);
    if (directKind) {
      add({ kind: directKind, provider, mode, enabled, required, source: "pipeline_node", nodeId: node.id });
    }
    for (const requiredKind of node.requires) {
      add({ kind: requiredKind, provider, mode, enabled, required: true, source: "pipeline_node_requires", nodeId: node.id });
    }
    for (const inferredKind of inferredExtraCapabilitiesForNode(node)) {
      if (inferredKind === directKind) {
        continue;
      }
      add({ kind: inferredKind, provider, mode, enabled, required, source: "pipeline_node_config", nodeId: node.id });
    }
  }

  if (project?.runtime.mlflow.enabled) {
    add({
      kind: "model_registry",
      provider: "mlflow",
      mode: providerModeFromBinding(project.runtime.capabilities.providers.mlflow) ?? "external",
      enabled: true,
      required: !!project.runtime.mlflow.registryEnabled,
      source: "runtime.mlflow",
      notes: [project.runtime.mlflow.experimentName ? `experiment:${project.runtime.mlflow.experimentName}` : "experiment:default"],
    });
  }

  for (const [kindOrProvider, binding] of Object.entries(project?.runtime.capabilities.providers ?? {})) {
    const kind = parseCapabilityKind(kindOrProvider) ?? capabilityKindForProvider(kindOrProvider);
    if (!kind) {
      continue;
    }
    add({
      kind,
      provider: binding.provider,
      mode: binding.mode,
      enabled: binding.enabled,
      required: binding.required,
      source: "runtime.capabilities.providers",
      notes: [kindOrProvider],
    });
  }

  return [...capabilities.values()].map((capability) => ({
    ...capability,
    nodeIds: [...capability.nodeIds].sort((left, right) => left.localeCompare(right)),
    notes: [...new Set(capability.notes)].sort((left, right) => left.localeCompare(right)),
  })).sort((left, right) => `${left.kind}:${left.provider ?? ""}`.localeCompare(`${right.kind}:${right.provider ?? ""}`));
}

export function inferRuntimeManifestCapabilities(pipeline: PipelineFlow, project?: MLOpsProject): RuntimeManifest["capabilities"] {
  return inferPipelineCapabilities(pipeline, project).map((capability) => ({ ...capability }));
}

export interface RuntimeInfrastructureService {
  id: string;
  provider: string;
  mode: ProviderMode;
  required: boolean;
}

export interface RuntimeInfrastructurePlan {
  services: RuntimeInfrastructureService[];
  composeFiles: string[];
}

export interface RuntimeInfrastructureCapability {
  provider?: string;
  mode?: ProviderMode;
  enabled: boolean;
  required: boolean;
}

export function inferRuntimeInfrastructure(capabilities: RuntimeInfrastructureCapability[]): RuntimeInfrastructurePlan {
  const services = new Map<string, RuntimeInfrastructureService>();
  const addService = (id: string, provider: string, mode: ProviderMode, required: boolean) => {
    const existing = services.get(id);
    if (existing) {
      existing.required = existing.required || required;
      return;
    }
    services.set(id, { id, provider, mode, required });
  };

  for (const capability of capabilities) {
    if (!capability.enabled || capability.mode !== "container") {
      continue;
    }
    const provider = (capability.provider ?? "").toLowerCase();
    if (provider.includes("qdrant")) {
      addService("qdrant", "qdrant", "container", capability.required);
    }
    if (provider.includes("mlflow")) {
      addService("mlflow", "mlflow", "container", capability.required);
    }
    if (provider.includes("celery") || provider.includes("prefect") || provider.includes("worker")) {
      addService("runtime-worker", capability.provider ?? "worker", "container", capability.required);
      addService("runtime-redis", "redis", "container", capability.required);
    }
  }

  const serviceList = [...services.values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    services: serviceList,
    composeFiles: serviceList.length ? ["docker-compose.yml", "docker-compose.capabilities.yml"] : ["docker-compose.yml"],
  };
}

function isEnabledNode(node: PipelineNode): boolean {
  const enabled = node.config.enabled;
  return enabled !== false && node.provider?.mode !== "disabled" && node.provider?.enabled !== false;
}

function providerNameForNode(node: PipelineNode): string | undefined {
  if (node.provider?.provider) {
    return node.provider.provider;
  }
  const configProvider = firstString(node.config.provider, node.config.vectorStore, node.config.registry, node.config.llmProvider);
  return configProvider ?? node.framework ?? node.algorithm;
}

function providerModeForNode(node: PipelineNode): ProviderMode | undefined {
  if (node.provider?.mode) {
    return node.provider.mode;
  }
  const mode = firstString(node.config.providerMode, node.config.mode, node.config.infrastructureMode);
  if (mode && ProviderModeSchema.safeParse(mode).success) {
    return mode as ProviderMode;
  }
  return undefined;
}

function providerRequiredForNode(node: PipelineNode): boolean {
  return node.provider?.required === true || node.config.required === true || node.config.infrastructureRequired === true;
}

function providerModeFromBinding(binding: ProviderBinding | undefined): ProviderMode | undefined {
  return binding?.mode;
}

function capabilityKindForNodeType(type: PipelineNodeType): PipelineCapabilityKind | undefined {
  const mapping: Partial<Record<PipelineNodeType, PipelineCapabilityKind>> = {
    input: "data_ingestion",
    data_source: "data_ingestion",
    preprocess: "preprocessing",
    feature_transform: "feature_engineering",
    embedding: "embeddings",
    vector_index: "vector_store",
    retrieval: "retrieval",
    model: "model_inference",
    decision: "decision",
    operator: "decision",
    condition: "decision",
    llm: "llm",
    human_review: "human_review",
    python_function: "custom_code",
    promotion_rule: "model_registry",
    evaluation: "evaluation",
    monitoring: "drift_monitoring",
    drift_monitor: "drift_monitoring",
    retraining_trigger: "retraining",
    model_registry: "model_registry",
  };
  return mapping[type];
}

function inferredExtraCapabilitiesForNode(node: PipelineNode): PipelineCapabilityKind[] {
  const kinds = new Set<PipelineCapabilityKind>();
  const vectorStore = firstString(node.config.vectorStore, node.config.vector_store);
  if (vectorStore) {
    kinds.add("vector_store");
    kinds.add("retrieval");
  }
  if (node.type === "embedding") {
    kinds.add("embeddings");
  }
  if (node.type === "model") {
    kinds.add("model_training");
    kinds.add("model_inference");
  }
  if (node.type === "python_function" && node.python?.isolationMode === "container") {
    kinds.add("orchestration");
  }
  if (firstString(node.config.promptTemplateVersion, node.config.llmProvider) || node.type === "llm") {
    kinds.add("llm");
  }
  return [...kinds];
}

function capabilityKindForProvider(provider: string): PipelineCapabilityKind | undefined {
  const normalized = provider.toLowerCase();
  if (normalized.includes("qdrant") || normalized.includes("pgvector") || normalized.includes("pinecone")) {
    return "vector_store";
  }
  if (normalized.includes("mlflow")) {
    return "model_registry";
  }
  if (normalized.includes("celery") || normalized.includes("prefect") || normalized.includes("worker")) {
    return "orchestration";
  }
  if (normalized.includes("llm") || normalized.includes("openai") || normalized.includes("anthropic") || normalized.includes("gemini")) {
    return "llm";
  }
  return undefined;
}

function parseCapabilityKind(value: string): PipelineCapabilityKind | undefined {
  const parsed = PipelineCapabilityKindSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  const value = values.find((item) => typeof item === "string" && item.trim().length > 0);
  return typeof value === "string" ? value : undefined;
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

  if (project.domain.kind === "legal_classification" && project.domain.legal) {
    const legal = project.domain.legal;
    if (project.problem.type !== "multiclass_classification") {
      add({
        severity: "warning",
        code: "legal_domain_non_multiclass_problem",
        message: "Domínio jurídico de classificação normalmente deve usar multiclass_classification.",
        path: "problem.type",
      });
    }
    if (legal.categoryTargetField !== project.problem.target) {
      add({
        severity: "warning",
        code: "legal_target_mismatch",
        message: `Campo alvo jurídico '${legal.categoryTargetField}' difere de problem.target '${project.problem.target}'.`,
        path: "domain.legal.categoryTargetField",
      });
    }

    const categoryCodes = new Set<string>();
    for (const [index, category] of legal.categories.entries()) {
      if (categoryCodes.has(category.code)) {
        add({
          severity: "error",
          code: "duplicate_legal_category_code",
          message: `Categoria jurídica duplicada: ${category.code}.`,
          path: `domain.legal.categories.${index}.code`,
        });
      }
      categoryCodes.add(category.code);
    }
    for (const classCode of project.problem.classes) {
      if (legal.categories.length && !categoryCodes.has(classCode)) {
        add({
          severity: "error",
          code: "legal_class_without_category",
          message: `Classe '${classCode}' não tem categoria jurídica correspondente.`,
          path: "domain.legal.categories",
        });
      }
    }
    for (const categoryCode of categoryCodes) {
      if (project.problem.classes.length && !project.problem.classes.includes(categoryCode)) {
        add({
          severity: "warning",
          code: "legal_category_outside_problem_classes",
          message: `Categoria jurídica '${categoryCode}' não aparece em problem.classes.`,
          path: "domain.legal.categories",
        });
      }
    }

    const workflowStepCodes = new Set<string>();
    for (const [index, step] of legal.workflowSteps.entries()) {
      if (workflowStepCodes.has(step.code)) {
        add({
          severity: "error",
          code: "duplicate_legal_workflow_step_code",
          message: `Etapa jurídica duplicada: ${step.code}.`,
          path: `domain.legal.workflowSteps.${index}.code`,
        });
      }
      workflowStepCodes.add(step.code);
    }
    for (const [index, transition] of legal.workflowTransitions.entries()) {
      if (!workflowStepCodes.has(transition.from)) {
        add({
          severity: "error",
          code: "unknown_legal_transition_source",
          message: `Transição jurídica referencia origem inexistente: ${transition.from}.`,
          path: `domain.legal.workflowTransitions.${index}.from`,
        });
      }
      if (!workflowStepCodes.has(transition.to)) {
        add({
          severity: "error",
          code: "unknown_legal_transition_target",
          message: `Transição jurídica referencia destino inexistente: ${transition.to}.`,
          path: `domain.legal.workflowTransitions.${index}.to`,
        });
      }
    }
    for (const [categoryIndex, category] of legal.categories.entries()) {
      for (const stepCode of category.workflowStepCodes) {
        if (!workflowStepCodes.has(stepCode)) {
          add({
            severity: "error",
            code: "unknown_legal_category_workflow_step",
            message: `Categoria '${category.code}' referencia etapa inexistente: ${stepCode}.`,
            path: `domain.legal.categories.${categoryIndex}.workflowStepCodes`,
          });
        }
      }
    }

    const activeEmbeddingProfiles = legal.embeddingProfiles.filter((profile) => profile.status === "active");
    if (legal.embeddingProfiles.length && !activeEmbeddingProfiles.length) {
      add({
        severity: "warning",
        code: "legal_embedding_profiles_without_active",
        message: "Domínio jurídico declara perfis de embedding, mas nenhum está ativo.",
        path: "domain.legal.embeddingProfiles",
      });
    }
    if (activeEmbeddingProfiles.length > 1) {
      add({
        severity: "error",
        code: "multiple_active_legal_embedding_profiles",
        message: "Domínio jurídico não deve ter mais de um perfil de embedding ativo no mesmo escopo.",
        path: "domain.legal.embeddingProfiles",
      });
    }
    if (legal.llm.enabled && !legal.llm.maskSensitiveData) {
      add({
        severity: "warning",
        code: "legal_llm_without_masking",
        message: "LLM jurídico habilitado sem mascaramento de dados sensíveis.",
        path: "domain.legal.llm.maskSensitiveData",
      });
    }
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
