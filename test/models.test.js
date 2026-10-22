import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanModels, modelFor, cfgFor, MODEL_IDS } from "../src/models.js";

test("seq.json models: only the three whitelisted ids survive; anything else is null", () => {
  assert.deepEqual(cleanModels(undefined), { story: null, stage: null, dream: null });
  assert.deepEqual(cleanModels([1, 2]), { story: null, stage: null, dream: null });
  assert.deepEqual(cleanModels({ story: "claude-opus-5-5", stage: "anthropic/claude-opus-5.5", dream: { a: 1 }, extra: "claude-haiku-5-5" }),
    { story: "claude-opus-5-5", stage: null, dream: null });
  assert.deepEqual(cleanModels({ story: "toString" }).story, null, "no prototype keys");
  assert.deepEqual(Object.keys(MODEL_IDS).sort(), ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("each provider gets its own id; no choice, an unknown provider or a bad id keep the bridge's setting", () => {
  const models = { story: "claude-sonnet-5-5", stage: null, dream: "claude-haiku-5-5" };
  assert.equal(modelFor("story", "anthropic", models, "env"), "claude-sonnet-5-5");
  assert.equal(modelFor("story", "openrouter", models, "env"), "anthropic/claude-sonnet-5.5");
  assert.equal(modelFor("dream", "openrouter", models, "env"), "anthropic/claude-haiku-5.5");
  assert.equal(modelFor("stage", "openrouter", models, "env"), "env");
  assert.equal(modelFor("story", "rehearsal", models, "env"), "env");
  assert.equal(modelFor("story", "anthropic", { story: "toString" }, "env"), "env");
  assert.equal(modelFor("story", "anthropic", null, "env"), "env");
});

test("cfgFor: the chosen model replaces cfg.model, fallbacks kept (without the chosen one)", () => {
  const cfg = { provider: "openrouter", key: "k", model: "anthropic/claude-sonnet-5.5",
    fallbackModels: ["anthropic/claude-haiku-5.5", "anthropic/claude-opus-5.5"] };
  assert.equal(cfgFor(cfg, undefined), cfg);
  assert.equal(cfgFor(cfg, { role: "stage", models: { stage: null } }), cfg);
  const c = cfgFor(cfg, { role: "stage", models: { stage: "claude-haiku-5-5" } });
  assert.equal(c.model, "anthropic/claude-haiku-5.5");
  assert.deepEqual(c.fallbackModels, ["anthropic/claude-opus-5.5"]);
  assert.equal(c.key, "k");
  assert.equal(cfg.model, "anthropic/claude-sonnet-5.5", "the bridge's own config is not changed");
});
