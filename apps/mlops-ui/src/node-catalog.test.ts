import assert from "node:assert/strict";
import test from "node:test";
import { PipelineNodeTypeSchema } from "@mlops-flow-studio/mlops-spec";
import { ALL_NODE_TYPES, NODE_TYPE_CATALOG } from "./node-catalog.ts";

test("catálogo da UI cobre todos os tipos aceitos pelo contrato", () => {
  assert.deepEqual([...ALL_NODE_TYPES].sort(), [...PipelineNodeTypeSchema.options].sort());
  assert.equal(new Set(ALL_NODE_TYPES).size, PipelineNodeTypeSchema.options.length);
  assert.equal(NODE_TYPE_CATALOG.every((entry) => entry.label.trim().length > 0), true);
});
