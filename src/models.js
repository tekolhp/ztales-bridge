/**
 * The Claude model the server owner chose per task in the mod's sandbox options (Teko,
 * 2026-10-21). The mod writes them in outbox/seq.json as `models: { story, stage, dream }`;
 * null means "the bridge's own setting" (AI_STORY_MODEL / AI_MODEL).
 *
 * Only the ids below are accepted: a game file never names an arbitrary model.
 *   story -> task "bible" (and any task the story writer does)
 *   stage -> task "stage" (and a one-writer "seed")
 *   dream -> task "echo"
 * A role the mod does not name rides on one it does: "watch" (each player's block of play,
 * docs/13 item 4) is a chapter's job, so it uses the chapter model (stage).
 */
export const MODEL_IDS = {
  "claude-haiku-5-5": { anthropic: "claude-haiku-5-5", openrouter: "anthropic/claude-haiku-5.5" },
  "claude-sonnet-5-5": { anthropic: "claude-sonnet-5-5", openrouter: "anthropic/claude-sonnet-5.5" },
  "claude-opus-5-5": { anthropic: "claude-opus-5-5", openrouter: "anthropic/claude-opus-5.5" },
};

const ROLES = ["story", "stage", "dream"];
const ALIAS = { watch: "stage" };

/** seq.json's `models` -> { story, stage, dream }, each a whitelisted id or null. */
export function cleanModels(doc) {
  const out = { story: null, stage: null, dream: null };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  for (const r of ROLES) {
    const v = doc[r];
    if (typeof v === "string" && Object.prototype.hasOwnProperty.call(MODEL_IDS, v)) out[r] = v;
  }
  return out;
}

/**
 * The model id to send for one role: the game's choice mapped to the provider's id, else the
 * bridge's own (`fallback`). A provider the table does not know keeps the bridge's setting.
 */
export function modelFor(role, provider, models, fallback) {
  const key = ALIAS[role] || role;
  const id = models && typeof models === "object" ? models[key] : null;
  const ids = typeof id === "string" && Object.prototype.hasOwnProperty.call(MODEL_IDS, id) ? MODEL_IDS[id] : null;
  return (ids && ids[provider]) || fallback;
}

/**
 * One call's brain config (src/brain.js): the model the owner chose for opts.role wins over the
 * bridge's own AI_MODEL / AI_STORY_MODEL; fallbackModels stay as configured (minus the chosen one).
 */
export function cfgFor(cfg, opts) {
  if (!opts?.role) return cfg;
  const model = modelFor(opts.role, cfg.provider, opts.models, cfg.model);
  if (model === cfg.model) return cfg;
  return { ...cfg, model, fallbackModels: (cfg.fallbackModels || []).filter((m) => m !== model) };
}
