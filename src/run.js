/**
 * The Worker's moving parts, kept out of index.js: a Worker's main module may export only its
 * handlers (workerd refuses any other named export).
 */
import { withServerFtp } from "./ftp.js";
import { FtpTransport } from "./transport.js";
import { D1Store } from "./store.js";
import { tick, shouldConnect, backoffSec } from "./tick.js";
import { ask, composeSystem, maxTokensFor, tokenCaps } from "./brain.js";
import { makeDecide, NEXT_STORY_GAME_DAYS } from "./story.js";
import { cfgFor } from "./models.js";
import { rehearsalAnswer } from "./rehearsal.js";
// docs/04 is the AI's system prompt, bundled as text (wrangler.toml [[rules]])
import BRAIN_MD from "../docs/04-brain-handoff.md";
import LORE_MD from "../docs/09-lore-digest.md";

export const VERSION = "0.1.0";

export function ftpCfg(env) {
  return {
    host: env.FTP_HOST, port: Number(env.FTP_PORT || 21), user: env.FTP_USER, pass: env.FTP_PASS,
    tls: env.FTP_TLS === "1",
  };
}

export const root = (env) => env.ZTALES_ROOT || "/Zomboid/Lua/ZTales";

export async function runTick(env, force = false) {
  // deployed before the owner typed the FTP secrets: wait quietly instead of failing every minute
  if (!env.FTP_HOST || !env.FTP_USER || !env.FTP_PASS) return { status: "not_configured" };
  const store = new D1Store(env.ZTALES);
  const nowSec = Math.floor(Date.now() / 1000);
  const state = await store.getState();
  const queued = (await store.takeQueue()).length > 0;
  if (!force && !shouldConnect(state, nowSec, queued)) return { status: "idle" };
  const decide = aiDecide(env);
  try {
    const r = await withServerFtp(ftpCfg(env), (s) =>
    tick({ t: new FtpTransport(s, root(env)), store, nowSec, version: VERSION, decide,
      tzOffsetHours: Number(env.TZ_OFFSET_HOURS || 0) }));
    if (state.ftp_failures) await store.setState({ ftp_failures: 0, ftp_backoff_until: 0 });
    return r;
  } catch (e) {
    // connection refused, login refused, timeouts: back off instead of hammering the host
    const n = (state.ftp_failures || 0) + 1;
    await store.setState({ ftp_failures: n, ftp_backoff_until: nowSec + backoffSec(n) });
    throw e;
  }
}

/** Counts only: what /probe and the logs may show. */
export function summary(r) {
  return `status=${r.status} seq=${r.seq ?? "-"} pulled=${r.pulled ?? 0} deleted=${r.deleted ?? 0} ` +
    `acked=${r.acked ?? 0} pushed=${r.pushed ?? 0} rejected=${(r.rejected || []).length}`;
}


/**
 * The story AI, only when the owner set it up: secrets AI_KEY and BIBLE_KEY, var AI_MODEL.
 * Without them the bridge still moves files, counts played days and raises stall signals.
 */
export function aiDecide(env) {
  // rehearsal: a scripted story (src/rehearsal.js) through the same gates, no key, no cost
  if (env.AI_PROVIDER === "rehearsal" && env.BIBLE_KEY) {
    const scripted = async (_system, context) => rehearsalAnswer(context);
    return makeDecide({ ask: scripted, askStory: scripted, system: "",
      bibleKey: env.BIBLE_KEY, maxCallsPerDay: Number(env.MAX_CALLS_PER_DAY || 48),
      nextStoryGameDays: Number(env.NEXT_STORY_GAME_DAYS || NEXT_STORY_GAME_DAYS) });
  }
  if (!env.AI_KEY || !env.BIBLE_KEY || !env.AI_MODEL) return null;
  const cfg = {
    provider: env.AI_PROVIDER || "openrouter", key: env.AI_KEY, model: env.AI_MODEL,
    fallbackModels: (env.AI_FALLBACK_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean),
    // anthropic: the answer through one tool call, parsed by the API (AI_STRUCTURED "0" turns it off)
    structured: env.AI_STRUCTURED !== "0",
  };
  const caps = tokenCaps(env);
  // two writers (Teko, 2026-10-14): the stronger model designs and closes the story, the
  // cheaper one fills each stage; AI_STORY_MODEL unset means one model does all
  const storyCfg = { ...cfg, model: env.AI_STORY_MODEL || env.AI_MODEL };
  // AI_MODELS_LOCKED (local tests): the bridge's own models win over the game's choice, so a
  // test runs on Sonnet + Haiku whatever the sandbox says (Teko, 2026-10-22)
  const pick = (c, opts) => ({ ...(env.AI_MODELS_LOCKED ? c : cfgFor(c, opts)), maxTokens: maxTokensFor(opts, caps) });
  return makeDecide({
    ask: (system, context, opts) => ask(pick(cfg, opts), system, context),
    askStory: (system, context, opts) => ask(pick(storyCfg, opts), system, context),
    // the clue agent (src/clues.js): the chapter model (models.js alias), its own token cap (role "clues")
    askClues: (system, context, opts) => ask(pick(cfg, opts), system, context),
    system: composeSystem(BRAIN_MD, LORE_MD), bibleKey: env.BIBLE_KEY,
    maxCallsPerDay: Number(env.MAX_CALLS_PER_DAY || 48),
    maxUsdPerDay: Number(env.MAX_USD_PER_DAY || 1),
    nextStoryGameDays: Number(env.NEXT_STORY_GAME_DAYS || NEXT_STORY_GAME_DAYS),
  });
}
