import type { PipelineNodeType } from "@mlops-flow-studio/mlops-spec";

export type NodeIconKey =
  | "play"
  | "database"
  | "table"
  | "layers"
  | "network"
  | "gauge"
  | "code"
  | "split"
  | "branch"
  | "check"
  | "chart"
  | "server"
  | "boxes"
  | "circle"
  | "refresh";

export interface NodeCatalogEntry {
  type: PipelineNodeType;
  label: string;
  icon: NodeIconKey;
}

export const NODE_TYPE_CATALOG = [
  { type: "input", label: "Entrada", icon: "play" },
  { type: "data_source", label: "Fonte", icon: "database" },
  { type: "preprocess", label: "Preparo", icon: "table" },
  { type: "feature_transform", label: "Features", icon: "layers" },
  { type: "embedding", label: "Embedding", icon: "network" },
  { type: "vector_index", label: "Índice vetorial", icon: "database" },
  { type: "retrieval", label: "Recuperação", icon: "network" },
  { type: "model", label: "Modelo", icon: "gauge" },
  { type: "decision", label: "Decisão", icon: "branch" },
  { type: "llm", label: "LLM", icon: "code" },
  { type: "human_review", label: "Revisão humana", icon: "check" },
  { type: "python_function", label: "Python", icon: "code" },
  { type: "operator", label: "Operador", icon: "split" },
  { type: "condition", label: "Condição", icon: "branch" },
  { type: "promotion_rule", label: "Promoção", icon: "check" },
  { type: "evaluation", label: "Avaliação", icon: "chart" },
  { type: "monitoring", label: "Monitor", icon: "server" },
  { type: "drift_monitor", label: "Drift", icon: "chart" },
  { type: "retraining_trigger", label: "Retreino", icon: "refresh" },
  { type: "model_registry", label: "Registry", icon: "boxes" },
  { type: "composite", label: "Composto", icon: "boxes" },
  { type: "output", label: "Saída", icon: "circle" },
] as const satisfies readonly NodeCatalogEntry[];

export const ALL_NODE_TYPES: readonly PipelineNodeType[] = NODE_TYPE_CATALOG.map((entry) => entry.type);
