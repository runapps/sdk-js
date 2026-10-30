// reasoningEffort reads a model's thinking levels from its options.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reasoningEffort, hasCapabilityTag } from "../dist/index.js";

const deepseek = {
  id: "DeepSeek", capability: "text",
  capability_tags: [{ id: "chat", label: "Chat" }, { id: "reasoning", label: "Reasoning" }],
  options: { inputs: { reasoning_effort: { type: "string", enum: ["none", "low", "high", "max"], default: "low" } } },
};

test("reasoningEffort: levels and default", () => {
  assert.deepEqual(reasoningEffort(deepseek), { levels: ["none", "low", "high", "max"], default: "low" });
  assert.equal(hasCapabilityTag(deepseek, "reasoning"), true);
});

test("reasoningEffort: no default means the upstream's own", () => {
  const kimi = { id: "Kimi K3", options: { inputs: { reasoning_effort: { enum: ["none", "low", "medium", "high"] } } } };
  assert.deepEqual(reasoningEffort(kimi), { levels: ["none", "low", "medium", "high"] });
});

test("reasoningEffort: null for a model that can't think", () => {
  assert.equal(reasoningEffort({ id: "GPT-VISION", options: { inputs: { max_tokens: {} } } }), null);
  assert.equal(reasoningEffort({ id: "x" }), null);
});
