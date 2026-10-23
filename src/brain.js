/**
 * The story AI: one request, JSON in, JSON out. OpenRouter first (Teko's key), Anthropic direct
 * second. The system prompt is docs/04-brain-handoff.md (bundled by the Worker; read from disk in
 * the tests) and is marked for prompt caching: it is the same on every call, so it is billed once
 * per cache window instead of every time.
 *
 * The key travels only in a request header. Errors never include it, nor the prompt or the answer.
 */

export class BrainError extends Error {
  constructor(message, status = 0, cost = null, raw = null) {
    super(message);
    this.name = "BrainError";
    this.status = status;
    this.cost = cost;   // a call that answered but was unusable is still billed
    this.raw = raw;     // ...and its text is kept: a paid answer is never thrown away unread (Teko, 2026-10-22)
  }
}

/**
 * Output tokens each task may spend (Teko, 2026-10-22: a 16,756-token bible broke its JSON and
 * cost $0.20 for nothing). The answer budget in docs/04 aims well under these; the cap only stops
 * a runaway. Overridable per role by the Worker's vars (src/run.js).
 */
// stage 16000: a first chapter with its pieces, rings and stall steps was cut at 8000 (production
// 2026-10-22); the cap is a guard, not a target
// clues 1500: the clue agent's three ring lines and their cites (src/clues.js, 2026-10-23)
export const MAX_TOKENS = { story: 12000, stage: 16000, dream: 1500, watch: 2000, clues: 3000 };

/** The owner's caps, from the Worker vars AI_MAX_TOKENS_BIBLE / _STAGE / _ECHO / _WATCH / _CLUES (0: the default). */
export function tokenCaps(env = {}) {
  return { story: Number(env.AI_MAX_TOKENS_BIBLE) || 0, stage: Number(env.AI_MAX_TOKENS_STAGE) || 0,
    dream: Number(env.AI_MAX_TOKENS_ECHO) || 0, watch: Number(env.AI_MAX_TOKENS_WATCH) || 0,
    clues: Number(env.AI_MAX_TOKENS_CLUES) || 0 };
}

/** The cap for one call (opts: { role, task }): a one-writer seed (bible and node one) gets both. */
export function maxTokensFor(opts = {}, caps = {}) {
  const c = { ...MAX_TOKENS };
  for (const [k, v] of Object.entries(caps || {})) if (Number(v) > 0) c[k] = Number(v);
  if (opts?.task === "seed") return c.story + c.stage;
  return c[opts?.role] || c.stage;
}

/**
 * Anthropic's list prices, US dollars per million tokens: { in, out, read } (a cache write is
 * 1.25x `in`). The Messages API reports tokens, never dollars: without this, calls on a direct
 * Anthropic key counted $0 against the daily budget. An unknown model has no estimate (null).
 */
export const ANTHROPIC_PRICES = {
  "claude-haiku-5-5": { in: 0.10, out: 0.50, read: 0.01 },
  "claude-sonnet-5-5": { in: 2, out: 10, read: 0.20 },
  "claude-opus-5-5": { in: 4, out: 20, read: 0.20 },
};

export function estimateCost(model, usage) {
  const p = ANTHROPIC_PRICES[String(model || "").replace(/-\d{8}$/, "")];
  if (!p || !usage) return null;
  const usd = ((usage.input || 0) * p.in + (usage.written || 0) * p.in * 1.25 + (usage.cached || 0) * p.read
    + (usage.output || 0) * p.out) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

/** The part of docs/04 after the first "---" line is the prompt (the file says so itself). */
export function systemPrompt(markdown) {
  const i = markdown.indexOf("\n---");
  return (i >= 0 ? markdown.slice(markdown.indexOf("\n", i + 1) + 1) : markdown).trim();
}

/**
 * The AI's fixed instructions: docs/04 (the rules) followed by docs/09 (the game's lore digest),
 * so every story knows the canon it must not contradict. Both are cached with the prompt.
 */
export function composeSystem(brainMarkdown, loreMarkdown = "") {
  const lore = String(loreMarkdown || "").trim();
  return lore ? `${systemPrompt(brainMarkdown)}

---

# Lore of this world (digest)

${lore}` : systemPrompt(brainMarkdown);
}

/**
 * The dynamic part of every call, as one JSON document. `state_version` lets the bridge drop an
 * answer the players have already overtaken (docs/04, "You answer a snapshot").
 */
export function buildContext({ task, state_version, bible = null, state = {}, ledger = [], events = [],
  journeys = {}, motifs = [], catalog = {}, rejections = [], stage = null, stall = null, echo_for = null, watch_for = null, bodies = null, clues_for = null }) {
  const ctx = { task, state_version, bible, state, ledger, events, journeys, motifs, catalog, rejections, stage, stall };
  if (echo_for) ctx.echo_for = echo_for;   // task "echo" only: whose next life finds a dream
  if (bodies) ctx.bodies = bodies;   // task "echo" only: where a life that carried a piece lies
  if (watch_for) ctx.watch_for = watch_for;   // task "watch" only: each player's block of play
  if (clues_for) ctx.clues_for = clues_for;   // task "clues" only: the piece's real building (src/clues.js)
  return JSON.stringify(ctx);
}

/** The model's text -> object. Tolerates a ```json fence and prose around the object. */
export function parseAnswer(text) {
  return readAnswer(text).doc;
}

/**
 * The model's text -> { doc, repaired }. Strict JSON first; when that fails, repairJson before
 * anything is thrown away: the answer is paid for. A repaired answer still goes through every
 * gate, like any other.
 */
export function readAnswer(text) {
  if (typeof text !== "string" || !text.trim()) throw new BrainError("empty answer");
  const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = s.indexOf("{");
  if (a < 0) throw new BrainError("answer has no JSON object");
  const b = s.lastIndexOf("}");
  let doc;
  let repaired = false;
  try {
    if (b <= a) throw new SyntaxError("no closing brace");
    doc = JSON.parse(s.slice(a, b + 1));
  } catch (e) {
    doc = repairJson(s.slice(a));
    if (doc === null) throw new BrainError(`answer is not valid JSON: ${e.message}`);
    repaired = true;
  }
  return { doc: checkDoc(doc), repaired };
}

function checkDoc(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new BrainError("answer is not an object");
  if (doc.directives !== undefined && !Array.isArray(doc.directives)) throw new BrainError("directives is not a list");
  return doc;
}

const isWs = (c) => c === " " || c === "\n" || c === "\r" || c === "\t";

/** A quote met inside a string: does what follows say the string really ended there? */
function quoteCloses(s, i, isKey) {
  let j = i + 1;
  let newline = false;
  while (j < s.length && isWs(s[j])) { if (s[j] === "\n") newline = true; j++; }
  if (j >= s.length) return true;
  const c = s[j];
  if (isKey) return c === ":";
  if (c === "}" || c === "]") return true;
  if (c === ",") {
    let k = j + 1;
    while (k < s.length && isWs(s[k])) k++;
    if (k >= s.length) return true;
    const d = s[k];
    return d === "\"" || d === "{" || d === "[" || d === "}" || d === "]" || d === "," || /[-0-9]/.test(d)
      || s.startsWith("true", k) || s.startsWith("false", k) || s.startsWith("null", k);
  }
  // a missing comma between two items: the next one starts on a new line
  return c === "\"" && newline;
}

/**
 * A tolerant pass over broken JSON, no dependency (Teko, 2026-10-22: a paid bible was lost to one
 * bad character). It escapes raw newlines and stray quotes inside strings, drops trailing commas,
 * puts back a missing comma between items, and closes a truncated tail by cutting back to the
 * last complete item and balancing the brackets. Returns the parsed object, or null.
 */
export function repairJson(text) {
  const s = String(text);
  let out = "";
  const stack = [];   // frames: { close: "}" | "]", expect: "key" | "colon" | "value" | "comma" }
  const cuts = [];    // [length of out, closers] after each complete value: where a cut tail can end
  const top = () => stack[stack.length - 1];
  const valueDone = () => {
    const f = top();
    if (f) f.expect = "comma";
    cuts.push([out.length, stack.map((x) => x.close)]);
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (isWs(c)) { out += c; continue; }
    const f = top();
    if (c === "}" || c === "]") {
      out = out.replace(/,(\s*)$/, "$1");   // a trailing comma
      if (f && f.close === c) {
        if (f.expect === "colon") out += ": null";
        stack.pop();
        out += c;
        if (!stack.length) { cuts.push([out.length, []]); break; }   // the object is whole: prose after it is not ours
        valueDone();
      }
      continue;   // a closer that closes nothing is dropped
    }
    if (c === ",") {
      if (f && f.expect === "comma") { out += c; f.expect = f.close === "}" ? "key" : "value"; }
      continue;   // a doubled or misplaced comma is dropped
    }
    if (c === ":") {
      if (f && f.expect === "colon") { out += c; f.expect = "value"; }
      continue;
    }
    // a value (or a key) starts where a comma was due: put the comma back
    if (f && f.expect === "comma") { out += ","; f.expect = f.close === "}" ? "key" : "value"; }
    if (c === "\"") {
      const isKey = !!f && f.expect === "key";
      let j = i + 1;
      let str = "\"";
      let closed = false;
      for (; j < s.length; j++) {
        const d = s[j];
        if (d === "\\") {
          const e = s[j + 1];
          if (e === undefined) break;
          // a bad escape (\x, \') loses its backslash
          str += /["\\/bfnrtu]/.test(e) ? d + e : e;
          j++;
          continue;
        }
        if (d === "\"") {
          if (quoteCloses(s, j, isKey)) { closed = true; break; }
          str += "\\\"";
          continue;
        }
        str += d === "\n" ? "\\n" : d === "\r" ? "\\r" : d === "\t" ? "\\t" : d < " " ? " " : d;
      }
      out += str + "\"";
      i = j;
      if (!closed) break;   // the text ended inside this string: closed as far as it got
      if (isKey) f.expect = "colon";
      else valueDone();
      continue;
    }
    if (c === "{" || c === "[") {
      if (f && f.expect === "key") continue;   // a key cannot be an object
      out += c;
      stack.push({ close: c === "{" ? "}" : "]", expect: c === "{" ? "key" : "value" });
      continue;
    }
    // a bare scalar: a number, true, false, null
    let j = i;
    while (j < s.length && !isWs(s[j]) && !",:}]".includes(s[j])) j++;
    if (f && f.expect === "value") { out += s.slice(i, j); valueDone(); }
    i = j - 1;
  }
  const closeWith = (head, closers) => {
    let t = head.replace(/,\s*$/, "").replace(/:\s*$/, ": null");
    for (let k = closers.length - 1; k >= 0; k--) t = t.replace(/,\s*$/, "") + closers[k];
    return t;
  };
  const attempts = [];
  if (!stack.length) attempts.push(out);
  // a truncated tail: cut back item by item to the last whole one (never half a sentence kept;
  // a key left without its value, half a number), then close the brackets still open
  for (let k = cuts.length - 1, n = 0; stack.length && k >= 0 && n < 60; k--, n++) attempts.push(closeWith(out.slice(0, cuts[k][0]), cuts[k][1]));
  for (const a of attempts) {
    try {
      const doc = JSON.parse(a);
      if (doc && typeof doc === "object" && !Array.isArray(doc)) return doc;
    } catch { /* the next cut */ }
  }
  return null;
}

/** The one tool an Anthropic answer is given through (structured answers). */
export const ANSWER_TOOL = {
  name: "submit_answer",
  description: "Submit your whole answer: the JSON object the rules ask for, as this tool's input.",
  input_schema: { type: "object", additionalProperties: true },
};
const ANSWER_TOOL_RULE = "Give your answer by calling the tool submit_answer once, with the whole JSON object as its input. Write nothing else.";

/**
 * The tool is asked for, not forced: Claude Opus 5.5 and Sonnet 5.5 (the models this bridge runs)
 * refuse a forced tool_choice ("any"/"tool") with a 400, and a forced call does not mix with the
 * thinking the 5.x models do by default. The system prompt asks for the call; a model that writes
 * text instead is still read, and repaired if it must be. At most one call.
 */
export const ANSWER_TOOL_CHOICE = { type: "auto", disable_parallel_tool_use: true };

const PROVIDERS = {
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    request(cfg, system, context) {
      const models = [cfg.model, ...(cfg.fallbackModels || [])].filter(Boolean);
      return {
        headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json", "x-title": "ZTales" },
        body: {
          model: models[0],
          ...(models.length > 1 ? { models } : {}),
          max_tokens: cfg.maxTokens,
          temperature: cfg.temperature,
          response_format: { type: "json_object" },
          usage: { include: true },
          messages: [
            { role: "system", content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] },
            { role: "user", content: context },
          ],
        },
      };
    },
    read(json) {
      const text = json?.choices?.[0]?.message?.content;
      const finish = json?.choices?.[0]?.finish_reason ?? null;
      const providerError = json?.choices?.[0]?.error?.message ?? json?.error?.message ?? null;
      const u = json?.usage || {};
      return { text, finish, providerError, model: json?.model, usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0,
        cached: u.prompt_tokens_details?.cached_tokens ?? 0 }, cost: typeof u.cost === "number" ? u.cost : null };
    },
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    request(cfg, system, context) {
      // structured (default on): the answer comes back as the input of one tool call, which the
      // API hands over already parsed, so a stray quote in a long bible cannot break it
      // (Teko, 2026-10-22). The schema is permissive: the gates, not the schema, judge the content.
      const structured = cfg.structured !== false;
      return {
        headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: {
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          // the 5.x models refuse temperature ("deprecated for this model", live run 2026-10-22)
          ...(/-[5-9]-/.test(cfg.model || "") ? {} : { temperature: cfg.temperature }),
          system: [{ type: "text", text: structured ? `${system}\n\n${ANSWER_TOOL_RULE}` : system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: context }],
          ...(structured ? { tools: [ANSWER_TOOL], tool_choice: ANSWER_TOOL_CHOICE } : {}),
        },
      };
    },
    read(json) {
      const blocks = json?.content || [];
      const call = blocks.find((c) => c.type === "tool_use" && c.name === ANSWER_TOOL.name);
      // the tool's input is the answer; a model that wrote text instead is still read (and repaired)
      const doc = call && call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input : null;
      const text = doc ? JSON.stringify(doc)
        : call && typeof call.input === "string" ? call.input
        : blocks.filter((c) => c.type === "text").map((c) => c.text).join("");
      const stop = json?.stop_reason;
      const finish = stop === "max_tokens" ? "length" : stop === "tool_use" ? "stop" : (stop ?? null);
      const u = json?.usage || {};
      const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: u.cache_read_input_tokens ?? 0,
        written: u.cache_creation_input_tokens ?? 0 };
      return { text, doc, finish, model: json?.model, usage, cost: estimateCost(json?.model, usage) };
    },
  },
};

/**
 * cfg: { provider: "openrouter" | "anthropic", key, model, fallbackModels?, maxTokens?, temperature?,
 *        timeoutMs?, structured? (anthropic: answer through one tool call; default on), fetch? }
 * Returns { doc, model, usage, cost, raw, repaired, note? }. A BrainError after an answer came
 * carries .raw (the text) and .cost: nothing paid for is ever dropped unseen.
 */
export async function ask(cfg, system, context) {
  // the provider failing mid-answer (finish "error") is not billed and is usually transient:
  // one more try right away, same model (the story is written by the model the owner chose)
  try {
    return await askOnce(cfg, system, context);
  } catch (e) {
    if (!(e instanceof BrainError) || !e.transient) throw e;
    return askOnce(cfg, system, context);
  }
}

async function askOnce(cfg, system, context) {
  const p = PROVIDERS[cfg.provider];
  if (!p) throw new BrainError(`unknown provider ${cfg.provider}`);
  if (!cfg.key) throw new BrainError("no AI key set");
  if (!cfg.model) throw new BrainError("no AI model set");
  // the cap comes per task from src/run.js (MAX_TOKENS); a caller that names none gets a stage's
  const full = { maxTokens: MAX_TOKENS.stage, temperature: 0.8, timeoutMs: 300000, ...cfg };
  const { headers, body } = p.request(full, system, context);
  const doFetch = cfg.fetch || fetch;
  let res;
  try {
    res = await doFetch(p.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(full.timeoutMs) });
  } catch (e) {
    throw new BrainError(`${cfg.provider} unreachable: ${e.name}`);
  }
  if (!res.ok) {
    // the provider's own error message, trimmed; it never contains the key we sent
    let detail = "";
    try { detail = JSON.stringify((await res.json())?.error?.message ?? "").slice(0, 200); } catch { /* not JSON */ }
    throw new BrainError(`${cfg.provider} answered ${res.status} ${detail}`, res.status);
  }
  const out = p.read(await res.json());
  const raw = typeof out.text === "string" ? out.text : null;
  // say why, and what it cost: a failed call is still paid for, and its text is kept
  const why = `finish ${out.finish ?? "?"}, ${out.usage.output} tokens out, $${out.cost ?? "?"}`;
  if (out.finish === "error") {
    const err = new BrainError(`the provider failed mid-answer: ${out.providerError ?? "no detail"} (${why})`, null, out.cost, raw);
    err.transient = true;
    throw err;
  }
  try {
    if (out.finish === "length") {
      // cut at the cap: what came is repaired (cut back to its last whole item) and, if that
      // parses, the gates decide whether it is enough; otherwise it fails as before
      let got;
      try { got = readAnswer(raw); } catch { throw new BrainError("answer cut at the token limit"); }
      return { doc: got.doc, model: out.model, usage: out.usage, cost: out.cost, raw, repaired: true, note: `cut at the token limit, repaired (${why})` };
    }
    const got = out.doc ? { doc: checkDoc(out.doc), repaired: false } : readAnswer(raw);
    return { doc: got.doc, model: out.model, usage: out.usage, cost: out.cost, raw, repaired: got.repaired,
      ...(got.repaired ? { note: `invalid JSON, repaired (${why})` } : {}) };
  } catch (e) {
    if (e instanceof BrainError) throw new BrainError(`${e.message} (${why})`, null, out.cost, raw);
    throw e;
  }
}
