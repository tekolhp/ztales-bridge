import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ask, parseAnswer, systemPrompt, buildContext, BrainError } from "../src/brain.js";

const KEY = "sk-or-v1-test-not-a-real-key";

function fakeFetch(status, body, seen) {
  return async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test("the system prompt is docs/04 after its --- line, and says what the AI must never do", () => {
  const md = readFileSync(new URL("../docs/04-brain-handoff.md", import.meta.url), "utf8");
  const sys = systemPrompt(md);
  assert.ok(!sys.startsWith("# 04"), "the file's own header is not part of the prompt");
  assert.match(sys, /never/i);
  assert.match(sys, /Writing ahead, without holes/);
});

test("OpenRouter: key only in the header, prompt cached, JSON mode, fallback models", async () => {
  const seen = [];
  const answer = { directives: [{ id: "d_1", type: "chat", scope: "server", text: "x" }] };
  const r = await ask({ provider: "openrouter", key: KEY, model: "vendor/model-a", fallbackModels: ["vendor/model-b"],
    fetch: fakeFetch(200, { model: "vendor/model-a", choices: [{ message: { content: JSON.stringify(answer) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.0123, prompt_tokens_details: { cached_tokens: 900 } } }, seen) },
  "SYSTEM", buildContext({ task: "stage", state_version: 4 }));
  assert.equal(r.doc.directives[0].id, "d_1");
  assert.equal(r.cost, 0.0123);
  assert.equal(r.usage.cached, 900);
  const req = seen[0];
  assert.equal(req.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.ok(!req.url.includes(KEY));
  assert.equal(req.init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(req.body.models, ["vendor/model-a", "vendor/model-b"]);
  assert.equal(req.body.messages[0].content[0].cache_control.type, "ephemeral");
  assert.equal(req.body.response_format.type, "json_object");
  assert.equal(JSON.parse(req.body.messages[1].content).state_version, 4);
});

test("Anthropic direct: x-api-key header and a cached system block", async () => {
  const seen = [];
  const r = await ask({ provider: "anthropic", key: KEY, model: "some-claude",
    fetch: fakeFetch(200, { model: "some-claude", content: [{ type: "text", text: '{"directives":[]}' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8 } }, seen) }, "SYSTEM", "{}");
  assert.deepEqual(r.doc.directives, []);
  assert.equal(seen[0].init.headers["x-api-key"], KEY);
  assert.equal(seen[0].body.system[0].cache_control.type, "ephemeral");
});

test("a provider error is a BrainError that never carries the key", async () => {
  const seen = [];
  await assert.rejects(
    ask({ provider: "openrouter", key: KEY, model: "m", fetch: fakeFetch(402, { error: { message: "Insufficient credits" } }, seen) }, "S", "{}"),
    (e) => e instanceof BrainError && e.status === 402 && /Insufficient credits/.test(e.message) && !e.message.includes(KEY));
});

test("missing key or model fails before any request", async () => {
  const seen = [];
  await assert.rejects(ask({ provider: "openrouter", key: "", model: "m", fetch: fakeFetch(200, {}, seen) }, "S", "{}"), /no AI key/);
  await assert.rejects(ask({ provider: "openrouter", key: KEY, model: "", fetch: fakeFetch(200, {}, seen) }, "S", "{}"), /no AI model/);
  assert.equal(seen.length, 0);
});

test("answers: fenced JSON and prose around it are accepted; non-JSON is not", () => {
  assert.deepEqual(parseAnswer('```json\n{"directives":[]}\n```').directives, []);
  assert.equal(parseAnswer('Here it is: {"a":1} hope it helps').a, 1);
  assert.throws(() => parseAnswer("no json here"), BrainError);
  assert.throws(() => parseAnswer('{"directives":"nope"}'), /not a list/);
  assert.throws(() => parseAnswer(""), /empty/);
});

test("the fixed instructions carry the rules, then the lore digest", async () => {
  const { composeSystem } = await import("../src/brain.js");
  const md = readFileSync(new URL("../docs/04-brain-handoff.md", import.meta.url), "utf8");
  const lore = readFileSync(new URL("../docs/09-lore-digest.md", import.meta.url), "utf8");
  const sys = composeSystem(md, lore);
  assert.ok(sys.indexOf("Knox dread") < sys.indexOf("Lore of this world"), "rules first");
  assert.match(sys, /McGrew/);
  assert.match(sys, /Louisville falls 16 Jul/);
  assert.ok(!/cthulhu|lovecraft/i.test(sys), "no outside mythos is ever named, not even to forbid it");
  // the answer contract and the coherence rules (2026-10-14) grew it; it is prompt-cached, so the
  // cost is small, but it must not keep growing unnoticed
  // 54k: the stage checklist (2026-10-21) is worth its ~400 cached tokens
  // 56k: the watch task and the page score / extra chapter contract (docs/13 items 4-5, 2026-10-22),
  // ~500 cached tokens; the watch call itself sends a slim context, so it stays about $0.01
  // 57.5k: the clue agent's task (2026-10-23), ~300 cached tokens; its call sends one building's facts
  assert.ok(sys.length < 58000, `fixed prompt stays compact (${sys.length} chars)`);
});

test("an answer cut at the token limit says so, with what it cost", async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ model: "m", choices: [{ finish_reason: "length", message: { content: "" } }],
    usage: { prompt_tokens: 40000, completion_tokens: 8000, cost: 0.11 } }) });
  await assert.rejects(ask({ provider: "openrouter", key: "k", model: "m", fetch }, "S", "{}"),
    (e) => e instanceof BrainError && /token limit/.test(e.message) && /8000 tokens out/.test(e.message) && e.cost === 0.11);
  const empty = async () => ({ ok: true, json: async () => ({ model: "m", choices: [{ finish_reason: "stop", message: { content: "" } }], usage: {} }) });
  await assert.rejects(ask({ provider: "openrouter", key: "k", model: "m", fetch: empty }, "S", "{}"), /empty answer \(finish stop/);
});

// ------------------------------------------------ paid answers are never thrown away (Teko, 2026-10-22)

test("repair: stray quotes, raw newlines, trailing and missing commas, a fence, a truncated tail", async () => {
  const { repairJson, readAnswer } = await import("../src/brain.js");
  assert.deepEqual(repairJson('{"a": "he said "no" to me", "b": 1}'), { a: 'he said "no" to me', b: 1 });
  assert.deepEqual(repairJson('{"a": [1, 2, ], "b": {"c": 3,},}'), { a: [1, 2], b: { c: 3 } });
  assert.deepEqual(repairJson('{"a": "x"\n  "b": "y"}'), { a: "x", b: "y" });
  assert.deepEqual(repairJson('{"a": [{"b": 1} {"c": 2}]}'), { a: [{ b: 1 }, { c: 2 }] });
  assert.deepEqual(repairJson('{"a": "line one\nline two", "b": true}'), { a: "line one\nline two", b: true });
  assert.deepEqual(repairJson('{"a": "x", "b": "y",, "c": 3}'), { a: "x", b: "y", c: 3 });
  // cut mid-sentence: back to the last whole item, never half a text kept
  assert.deepEqual(repairJson('{"directives": [{"id": "d1", "text": "whole"}, {"id": "d2", "text": "half a sen'),
    { directives: [{ id: "d1", text: "whole" }, { id: "d2" }] });
  assert.deepEqual(repairJson('{"bible": {"axis": [{"id": "n1"}], "title": '), { bible: { axis: [{ id: "n1" }] } });
  assert.equal(repairJson("not json at all"), null);
  const r = readAnswer('```json\n{"directives": [{"id": "d1", "text": "a "quoted" word"},]}\n```');
  assert.equal(r.repaired, true);
  assert.equal(r.doc.directives[0].text, 'a "quoted" word');
  assert.equal(readAnswer('{"a": 1}').repaired, false, "valid JSON is never touched");
});

test("a broken answer is repaired and used, with its raw text and a note; one that cannot be is kept on the error", async () => {
  const broken = '{"directives": [{"id": "d_1", "type": "chat", "scope": "server", "text": "the radio said "147.36" twice"}]}';
  const reply = (content) => async () => ({ ok: true, json: async () => ({ model: "m", choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 16756, cost: 0.2 } }) });
  const r = await ask({ provider: "openrouter", key: "k", model: "m", fetch: reply(broken) }, "S", "{}");
  assert.equal(r.repaired, true);
  assert.equal(r.doc.directives[0].text, 'the radio said "147.36" twice');
  assert.equal(r.raw, broken);
  assert.match(r.note, /repaired/);
  await assert.rejects(ask({ provider: "openrouter", key: "k", model: "m", fetch: reply("I cannot write that story.") }, "S", "{}"),
    (e) => e instanceof BrainError && e.raw === "I cannot write that story." && e.cost === 0.2 && /16756 tokens out/.test(e.message));
});

test("an answer cut at the cap that still holds whole items is repaired for the gates to judge", async () => {
  const cut = '{"directives": [{"id": "d_1", "type": "chat", "scope": "server", "text": "x"}, {"id": "d_2", "type": "ch';
  const fetch = async () => ({ ok: true, json: async () => ({ model: "m", choices: [{ finish_reason: "length", message: { content: cut } }],
    usage: { completion_tokens: 8000, cost: 0.1 } }) });
  const r = await ask({ provider: "openrouter", key: "k", model: "m", fetch }, "S", "{}");
  assert.equal(r.doc.directives[0].id, "d_1");
  assert.match(r.note, /cut at the token limit, repaired/);
  assert.equal(r.raw, cut);
});

test("Anthropic structured: the answer comes as one tool call's input, priced from the usage", async () => {
  const seen = [];
  const answer = { bible: { title: 'The "Last" Transmission' } };
  const r = await ask({ provider: "anthropic", key: KEY, model: "claude-sonnet-5-5", maxTokens: 12000,
    fetch: fakeFetch(200, { model: "claude-sonnet-5-5", stop_reason: "tool_use",
      content: [{ type: "thinking", thinking: "" }, { type: "tool_use", id: "t1", name: "submit_answer", input: answer }],
      usage: { input_tokens: 2000, output_tokens: 10000, cache_read_input_tokens: 15000, cache_creation_input_tokens: 0 } }, seen) },
  "SYSTEM", "{}");
  assert.deepEqual(r.doc, answer);
  assert.equal(r.repaired, false);
  assert.deepEqual(JSON.parse(r.raw), answer, "the raw text is kept even when the API parsed it");
  // 2000 x $2 + 15000 x $0.20 + 10000 x $10, per million
  assert.equal(r.cost, 0.107);
  const body = seen[0].body;
  assert.equal(body.max_tokens, 12000);
  assert.equal(body.tools[0].name, "submit_answer");
  assert.equal(body.tools[0].input_schema.type, "object");
  // Sonnet 5.5 and Opus 5.5 refuse a forced tool_choice with a 400: asked, at most one call
  assert.deepEqual(body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
  assert.match(body.system[0].text, /submit_answer/);
  assert.equal(body.system[0].cache_control.type, "ephemeral");
});

test("Anthropic structured off (AI_STRUCTURED=0), or a model that wrote text: the text is read as before", async () => {
  const seen = [];
  const r = await ask({ provider: "anthropic", key: KEY, model: "claude-haiku-5-5", structured: false,
    fetch: fakeFetch(200, { model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: '{"directives":[]}' }],
      usage: { input_tokens: 1000000, output_tokens: 0 } }, seen) }, "SYSTEM", "{}");
  assert.equal(seen[0].body.tools, undefined);
  assert.equal(seen[0].body.system[0].text, "SYSTEM");
  assert.deepEqual(r.doc.directives, []);
  assert.equal(r.cost, 0.1);
});

test("output caps per task, overridable; a one-writer seed gets bible and stage", async () => {
  const { maxTokensFor, MAX_TOKENS, tokenCaps } = await import("../src/brain.js");
  assert.ok(MAX_TOKENS.story < 32000);
  assert.equal(maxTokensFor({ role: "story", task: "bible" }), 12000);
  assert.equal(maxTokensFor({ role: "stage", task: "stage" }), 16000);
  assert.equal(maxTokensFor({ role: "dream", task: "echo" }), 1500);
  assert.equal(maxTokensFor({ role: "watch", task: "watch" }), 2000);
  assert.equal(maxTokensFor({ role: "stage", task: "seed" }), 28000);
  assert.equal(maxTokensFor({ role: "story" }, { story: 9000, stage: 0 }), 9000);
  assert.equal(maxTokensFor({ role: "story" }, tokenCaps({})), 12000);
  assert.equal(maxTokensFor({ role: "stage" }, tokenCaps({ AI_MAX_TOKENS_STAGE: "6000" })), 6000);
});

test("D1: an older calls table gets the raw and note columns on the first call", async () => {
  const { D1Store } = await import("../src/store.js");
  const { fakeD1 } = await import("./fake-d1.js");
  const db = fakeD1();
  db.raw.exec("DROP TABLE calls; CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, model TEXT, purpose TEXT, cost_usd REAL, ok INTEGER);");
  const store = new D1Store(db);
  await store.logCall({ model: "m", purpose: "bible#1", cost_usd: 0.2, ok: false, raw: "v1.sealed", note: "not valid JSON" }, 100);
  await store.logCall({ model: "m", purpose: "bible#2", cost_usd: 0.05, ok: true }, 200);
  const rows = db.raw.prepare("SELECT purpose, raw, note FROM calls ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.purpose, r.raw, r.note]), [["bible#1", "v1.sealed", "not valid JSON"], ["bible#2", null, null]]);
  assert.equal(await store.costSince(0), 0.25);
});

test("a provider failure mid-answer is tried once more, same model", async () => {
  const seen = [];
  const fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.model);
    if (seen.length === 1) return { ok: true, json: async () => ({ model: body.model, choices: [{ finish_reason: "error", error: { message: "upstream" }, message: { content: "" } }], usage: {} }) };
    return { ok: true, json: async () => ({ model: body.model, choices: [{ finish_reason: "stop", message: { content: "{\"directives\":[]}" } }], usage: { cost: 0.2 } }) };
  };
  const r = await ask({ provider: "openrouter", key: "k", model: "big", fallbackModels: ["small"], fetch }, "S", "{}");
  assert.deepEqual(seen, ["big", "big"]);
  assert.deepEqual(r.doc.directives, []);
});
