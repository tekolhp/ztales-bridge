import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDecide } from "../src/story.js";
import { MemoryStore } from "../src/store.js";
import { MemoryTransport } from "../src/transport.js";
import { tick } from "../src/tick.js";
import { BrainError, maxTokensFor } from "../src/brain.js";
import { modelFor } from "../src/models.js";
import { gateBatch } from "../src/gates.js";
import { buildingFacts, buildingsOf, cluesGate, mentions, roomWords, withRingTexts } from "../src/clues.js";

const KEY = "test-bible-key-0123456789";
const T0 = 1_800_000_000;
const FIELDS = ["x", "y", "w", "h", "floors", "flags", "region", "name", "rooms", "zombie_density"];
// production 2026-10-22: the laundry ticket went into a big house with its own laundry room, the
// rings said "the laundromat"; here the house and the laundromat stand side by side
const ROWS = [
  [10600, 9600, 16, 14, 2, "rb", "Riverside", "", ["kitchen", "bedroom", "bathroom", "laundry", "livingroom"], 0.1],
  [10650, 9600, 10, 8, 1, "r", "Riverside", "", ["kitchen", "bedroom", "bathroom"], 0.1],
  [10680, 9640, 10, 8, 1, "r", "Riverside", "", ["kitchen", "bedroom", "livingroom"], 0.1],
  [10700, 9700, 12, 10, 1, "s", "Riverside", "Riverside Laundromat", ["laundromat"], 0.2],
  [10750, 9700, 12, 10, 1, "s", "Riverside", "", ["pharmacy"], 0.2],
];
const HOUSE = "b_10600_9600";

function catalogFiles(languages = null) {
  return {
    "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1, ...(languages ? { languages } : {}) }),
    "catalog/index.json": JSON.stringify({ version: "v1", cell_size: 300, building_fields: FIELDS, story_max_nodes: 4,
      spawn_regions: [{ name: "Riverside, KY", points: [[10650, 9650]] }], professions: [{ id: "nurse" }], mods: [], outfits: [],
      item_categories: [] }),
    "catalog/cells.json": JSON.stringify({ cells: [{ cell: "35_32", buildings: ROWS.length }] }),
    "catalog/cell-35_32.json": JSON.stringify({ rows: ROWS }),
  };
}

const NEXT = { n1: "n2" };
const stageReactions = (node, pieces) => [
  ...pieces.map((p, i) => ({ id: `${node}_r${i}`, type: "reaction", stage: node, when: { event: "item_picked", story_id: p },
    then: [{ id: `${node}_r${i}.1`, type: "chat", scope: "player", player: "$player", text: "It is still warm." },
      ...(i === 0 && NEXT[node] ? [{ id: `${node}_r${i}.2`, type: "set_node", node: NEXT[node] }] : [])], reveals: [`f_${p}`] })),
  { id: `${node}_close`, type: "reaction", stage: node, when: { event: "node_changed", from: node },
    then: [{ id: `${node}_close.1`, type: "chat", scope: "server", text: "Somewhere a radio goes quiet." }] },
  ...[1, 2, 3, 4].map((s) => ({ id: `${node}_s${s}`, type: "reaction", stage: node, when: { event: "signal", name: "stall", step: s },
    then: [{ id: `${node}_s${s}.1`, type: "chat", scope: "server", text: `Not a shop, ${s}. A house.` }] })),
];

// the story writer's rings, written before the piece had a place
const PROX = { far: "The laundromat at the edge of Riverside.", mid: "The counter. The machines.", near: "The laundromat. It was there." };

const BIBLE = {
  season: "s1", title: "Clean Shirts", premise: "...",
  ending: { text: "The shirts were never collected." },
  forbidden_entities: ["Martha Dell"],
  difficulty: { color: "yellow" },
  axis: [
    { id: "n1", question: "Whose ticket is it?", pieces: [{ story_id: "n1_ticket", item: "ZTales.NoteYellow", shows: "a laundry ticket" }] },
    { id: "n2", question: "Who never came back?", pieces: [{ story_id: "n2_key", item: "ZTales.KeyYellow" }], ending: true },
  ],
  finale: { rooms_wanted: ["pharmacy"], urn: { title: "Clay urn" }, charges: {}, weather: "fog", sounds: [], reward: [] },
};

function seedAnswer(proximity = PROX) {
  return {
    bible: BIBLE,
    directives: [
      { id: "s_ticket", type: "place_item", story_id: "n1_ticket", item: "ZTales.NoteYellow", title: "Laundry ticket",
        text: "If shut, I'm home. The house with its own laundry room.", target: { building: HOUSE } },
      ...stageReactions("n1", ["n1_ticket"]),
    ],
    hints: { n1: { full: { text: "Somebody never picked up their shirts." }, echo: { text: "Clean shirts." } } },
    proximity,
    motifs_used: [],
  };
}

// every text a player reads, in every language (the gate refuses a plain string with two)
function inAll(v, langs, key = null) {
  if (typeof v === "string" && ["text", "title", "wide", "far", "mid", "near"].includes(key)) return Object.fromEntries(langs.map((l) => [l, v]));
  if (Array.isArray(v)) return v.map((x) => inAll(x, langs));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "bible" ? x : inAll(x, langs, k)]));
  return v;
}

// indirect (Teko, 2026-10-23): never the room's or the place's name, only what was done and sensed there
const GOOD = {
  wide: "Clean shirts on my mind all day, folded and waiting for someone.",
  far: "A ticket for clean shirts nobody came back for.",
  mid: "Someone lived there and pressed their own whites by hand.",
  near: "Warm starch and the spin of the drum, the smell of soap on everything.",
  open: "My hands keep smoothing warm cotton that is not there, as if a basket waited for me.",
  cites: { mid: [{ fact: "kind:home" }], near: [{ fact: "room:laundry" }] },
};

// `clue`: one answer for every call, or a list taken in order (the last repeats); an Error is thrown,
// an object { cut: answer } comes back marked as cut at the token limit
async function seed({ clue, maxUsdPerDay, maxCallsPerDay, languages } = {}) {
  const t = new MemoryTransport(catalogFiles(languages));
  const store = new MemoryStore();
  const calls = [];
  const clueCalls = [];
  const ask = async (system, context) => {
    calls.push(JSON.parse(context));
    const a = structuredClone(seedAnswer());
    return { doc: languages && languages.length > 1 ? inAll(a, languages) : a, model: "fake", cost: 0.01 };
  };
  const askClues = clue === undefined ? undefined : async (system, context, opts) => {
    clueCalls.push({ context: JSON.parse(context), opts });
    const c = Array.isArray(clue) ? clue[Math.min(clueCalls.length - 1, clue.length - 1)] : clue;
    if (c instanceof Error) throw c;
    if (c && c.cut) return { doc: structuredClone(c.cut), model: "fake-haiku", cost: 0.002, raw: JSON.stringify(c.cut), repaired: true,
      note: "cut at the token limit, repaired (finish length, 3000 tokens out, $0.002)" };
    return { doc: structuredClone(c), model: "fake-haiku", cost: 0.002, raw: JSON.stringify(c) };
  };
  const decide = makeDecide({ ask, askClues, system: "SYSTEM", bibleKey: KEY, ...(maxUsdPerDay ? { maxUsdPerDay } : {}),
    ...(maxCallsPerDay ? { maxCallsPerDay } : {}) });
  const r = await tick({ t, store, nowSec: T0, decide });
  const pushed = [...t.files.keys()].find((k) => k.startsWith("inbox/directives-"));
  const sent = pushed ? JSON.parse(t.files.get(pushed)).directives : [];
  return { t, store, r, sent, calls, clueCalls };
}

const PLAIN_WIDE = "Somewhere around there, something tugged at me, too faint to follow, like a word I almost remembered.";
const ringText = (sent, k) => sent.find((d) => d.id === `s1_prox_n1_${k}_r`)?.then?.[0]?.text;
const pieceOf = (sent) => sent.find((d) => d.id === "s_ticket");

test("clues: a good answer rewrites the four rings and asks the piece into the room the clues name", async () => {
  const { sent, store, clueCalls, r } = await seed({ clue: GOOD });
  assert.equal(clueCalls.length, 1, "one call, no more");
  assert.equal(clueCalls[0].opts.role, "clues");
  const ctx = clueCalls[0].context;
  assert.equal(ctx.task, "clues");
  assert.equal(ctx.clues_for.building.id, HOUSE);
  assert.ok(ctx.clues_for.facts.some((f) => f.id === "room:laundry" && f.distinctive), "the laundry room is what only this house has");
  assert.equal(ctx.clues_for.neighbour.name, "Riverside Laundromat");
  assert.deepEqual(ctx.clues_for.story_rings, PROX);
  assert.ok(ctx.clues_for.solution.some((x) => /own laundry room/.test(x.text)), "the piece's own text is passed");
  assert.ok(ctx.clues_for.solution.some((x) => /stall 2/.test(x.where)), "and the stall hints");
  assert.ok(!JSON.stringify(ctx).includes("never collected"), "never the ending");
  assert.equal(ringText(sent, "wide"), GOOD.wide, "wide comes from the clue agent");
  assert.equal(ringText(sent, "far"), GOOD.far);
  assert.equal(ringText(sent, "mid"), GOOD.mid);
  assert.equal(ringText(sent, "near"), GOOD.near);
  assert.equal(pieceOf(sent).target.room, "laundry");
  const s = await store.getState();
  assert.equal(s.placed.find((p) => p.story_id === "n1_ticket").target.room, "laundry", "the room is remembered with the piece");
  assert.match(r.notes.join(" "), /clues#n1: rings rewritten from b_10600_9600/);
});

test("clues: the call is logged as clues#<node> and its cost counts against the day", async () => {
  const { store } = await seed({ clue: GOOD });
  const log = store.callLog.find((c) => c.purpose === "clues#n1");
  assert.ok(log, "logged");
  assert.equal(log.ok, true);
  assert.equal(log.cost_usd, 0.002);
  assert.ok(log.raw, "the answer is kept, sealed");
  assert.ok(Math.abs((await store.costSince(T0 - 10)) - 0.012) < 1e-9, "stage + clues");
});

// near cites only the kind of place, which every house has: not distinctive
const WEAK = { ...GOOD, near: "Someone lived there. They cooked there.", cites: { mid: [{ fact: "kind:home" }], near: [{ fact: "kind:home" }] } };
const PLAIN_MID = "Someone lived there, cooked there, kept their own things in order.";
const reasonsOf = (call) => (call.context.rejections || []).map((r) => r.reason).join(" | ");

test("clues: a refused answer is asked again with the gate's errors; the good second answer is used", async () => {
  const { sent, store, r, clueCalls } = await seed({ clue: [WEAK, GOOD] });
  assert.equal(clueCalls.length, 2, "one retry, then good");
  assert.deepEqual(clueCalls[0].context.rejections, [], "the first call has nothing to fix");
  const why = reasonsOf(clueCalls[1]);
  assert.match(why, /refused by the clue gate/);
  assert.match(why, /near: shows nothing only this building has/, "told exactly what was wrong");
  assert.match(clueCalls[1].context.clues_for.rules, /wide and open already passed and are kept; only far, mid and near will be used/);
  assert.equal(ringText(sent, "near"), GOOD.near);
  assert.equal(ringText(sent, "mid"), GOOD.mid);
  assert.equal(ringText(sent, "wide"), GOOD.wide, "the good wide of the first answer is kept");
  assert.equal(pieceOf(sent).target.room, "laundry");
  const first = store.callLog.find((c) => c.purpose === "clues#n1");
  const second = store.callLog.find((c) => c.purpose === "clues#n1.retry1");
  assert.equal(first.cost_usd, 0.002);
  assert.match(first.note, /clue gate.*near: shows nothing only this building has/);
  assert.equal(second.cost_usd, 0.002, "every call logged with its cost");
  assert.equal(second.ok, true);
  assert.match(r.notes.join(" "), /clues#n1: refused/);
  assert.match(r.notes.join(" "), /clues#n1.retry1: rings rewritten from b_10600_9600/);
  assert.equal((await store.getState()).clue_tries.s1_n1.n, 2, "the calls are counted in state");
});

test("clues: an answer cut at the token limit is asked again, told to answer shorter", async () => {
  const { near, ...noNear } = GOOD;
  void near;
  const { sent, clueCalls } = await seed({ clue: [{ cut: noNear }, GOOD] });
  assert.equal(clueCalls.length, 2);
  assert.match(reasonsOf(clueCalls[1]), /your answer was cut at the token limit: answer shorter/);
  assert.match(reasonsOf(clueCalls[1]), /near: no text in en/);
  assert.equal(ringText(sent, "near"), GOOD.near);
  // a cut answer that could not be read at all: the same note
  const thrown = await seed({ clue: [new BrainError("answer cut at the token limit (finish length, 3000 tokens out, $0.004)", null, 0.004, "{\"wi"), GOOD] });
  assert.equal(thrown.clueCalls.length, 2);
  assert.match(reasonsOf(thrown.clueCalls[1]), /your answer was cut at the token limit: answer shorter/);
  assert.equal(ringText(thrown.sent, "near"), GOOD.near);
  assert.equal(thrown.store.callLog.find((c) => c.purpose === "clues#n1").cost_usd, 0.004, "the cut call is paid for and logged");
});

test("clues: an unreadable answer is asked again with the parse error", async () => {
  const { clueCalls, sent } = await seed({ clue: [new BrainError("answer is not valid JSON: Unexpected token (finish stop)", 0, 0.003, "{oops"), GOOD] });
  assert.equal(clueCalls.length, 2);
  assert.match(reasonsOf(clueCalls[1]), /could not be read \(answer is not valid JSON: Unexpected token/);
  assert.equal(ringText(sent, "mid"), GOOD.mid);
});

test("clues: three failures keep the story's own rings, never the plain lines; every call logged", async () => {
  const { sent, store, r, clueCalls } = await seed({ clue: [WEAK, new BrainError("answer is not valid JSON", 0, 0.003, "{oops"), new TypeError("boom")] });
  assert.equal(clueCalls.length, 3, "the first call and two retries, no more");
  assert.equal(ringText(sent, "far"), PROX.far, "the story writer's far");
  assert.equal(ringText(sent, "mid"), PROX.mid);
  assert.equal(ringText(sent, "near"), PROX.near);
  assert.notEqual(ringText(sent, "mid"), PLAIN_MID, "not the plain words");
  assert.equal(ringText(sent, "wide"), GOOD.wide, "the good wide of the first answer is not thrown away");
  assert.deepEqual(store.callLog.filter((c) => c.purpose.startsWith("clues#n1")).map((c) => [c.purpose, c.cost_usd, c.ok]),
    [["clues#n1", 0.002, true], ["clues#n1.retry1", 0.003, false], ["clues#n1.retry2", null, false]]);
  assert.match(r.notes.join(" "), /clues#n1: the story's rings stay/);
  const s = await store.getState();
  assert.equal(s.stage_written, "n1", "the chapter went out");
  assert.equal(s.ai_failures, 0, "no back-off for the chapter");
  assert.equal(s.clue_tries.s1_n1.n, 3);
});

test("clues: an agent that never writes wide: wide takes the story's far, or the agent's far when the story's names the place", async () => {
  const { wide, ...noWide } = GOOD;
  void wide;
  const { sent, store, clueCalls } = await seed({ clue: noWide });
  assert.equal(clueCalls.length, 3, "wide asked for twice more");
  assert.match(clueCalls[1].context.clues_for.rules, /only wide will be used/);
  assert.match(reasonsOf(clueCalls[1]), /wide: no text in en/);
  assert.equal(ringText(sent, "mid"), GOOD.mid, "the good rings are kept, not thrown away");
  assert.equal(ringText(sent, "near"), GOOD.near);
  assert.equal(ringText(sent, "wide"), GOOD.far, "the story's far names the laundromat: the agent's far stands in");
  assert.notEqual(ringText(sent, "wide"), PLAIN_WIDE);
  assert.match(store.callLog.find((c) => c.purpose === "clues#n1").note, /wide: no text in en/);
  const named = cluesGate({ ...GOOD, wide: "Something about that laundromat." }, { facts, languages: ["en"] });
  assert.ok(named.errors.includes('wide: names the place ("laundromat") in en'), named.errors.join("; "));
  const long = cluesGate({ ...GOOD, wide: "x".repeat(401) }, { facts, languages: ["en"] });
  assert.ok(long.errors.includes("wide: longer than 400 characters in en"));
});

test("clues: wide missing at first, written on the retry: only wide is asked, the rest kept", async () => {
  const { wide, ...noWide } = GOOD;
  void wide;
  const { sent, clueCalls } = await seed({ clue: [noWide, { wide: "A pull of clean cloth and someone waiting." }] });
  assert.equal(clueCalls.length, 2);
  assert.equal(ringText(sent, "wide"), "A pull of clean cloth and someone waiting.");
  assert.equal(ringText(sent, "near"), GOOD.near);
});

test("clues: a cite the text does not show, or a fact never given, is refused", async () => {
  const lie = { ...GOOD, near: "The pool. The deep end.", cites: { mid: [{ fact: "kind:home" }], near: [{ fact: "room:laundry" }, { fact: "room:pool" }] } };
  const { sent, store } = await seed({ clue: [lie, GOOD] });
  assert.equal(ringText(sent, "near"), GOOD.near);
  assert.match(store.callLog.find((c) => c.purpose === "clues#n1").note, /room:pool, a fact it was not given/);
});

test("clues: the daily budget reached, no call is made: no credit, the plain words", async () => {
  const { sent, clueCalls, r } = await seed({ clue: GOOD, maxUsdPerDay: 0.01 });
  assert.equal(clueCalls.length, 0);
  assert.equal(ringText(sent, "far"), "Something about that place keeps coming back to me, the way a smell does.", "a far that names the place gives way to the plain one");
  assert.equal(ringText(sent, "wide"), PLAIN_WIDE);
  assert.equal(ringText(sent, "mid"), PLAIN_MID);
  assert.equal(ringText(sent, "near"), "Warm cotton, starch, the drum still turning in my head. Northwest of Riverside Laundromat. It is in there.");
  assert.equal(pieceOf(sent).target.room, "laundry", "the piece goes where the plain words point");
  assert.match(r.notes.join(" "), /clues#n1: daily AI budget reached/);
});

test("clues: the daily call cap reached mid-way is no credit too: plain words for what is missing", async () => {
  // the seed's stage is call 1, the clue agent's first answer call 2: the cap of 2 stops the retry
  const { sent, clueCalls, r } = await seed({ clue: [WEAK, GOOD], maxCallsPerDay: 2 });
  assert.equal(clueCalls.length, 1);
  assert.equal(ringText(sent, "mid"), PLAIN_MID);
  assert.equal(ringText(sent, "wide"), GOOD.wide, "the agent's good wide is kept");
  assert.match(r.notes.join(" "), /clues#n1: daily AI call cap reached: no AI credit/);
});

test("clues: the provider saying the account has no credit gives the plain words at once", async () => {
  const e = new BrainError('anthropic answered 400 "Your credit balance is too low to access the Anthropic API."', 400);
  e.noCredit = true;
  const { sent, clueCalls, store, r } = await seed({ clue: [e, GOOD] });
  assert.equal(clueCalls.length, 1, "never retried: there is no credit");
  assert.equal(ringText(sent, "mid"), PLAIN_MID);
  assert.equal(ringText(sent, "wide"), PLAIN_WIDE);
  assert.equal(store.callLog.find((c) => c.purpose === "clues#n1").ok, false, "the call is logged");
  assert.match(r.notes.join(" "), /the provider says the account has no credit/);
});

test("clues: a failed or refused answer never gives plain words (only no credit does)", async () => {
  const { sent } = await seed({ clue: new TypeError("boom") });
  assert.equal(ringText(sent, "near"), PROX.near);
  assert.ok(!/It is in there/.test(ringText(sent, "near")));
});

test("clues: without a clue agent (rehearsal, tests) nothing changes; the story's far stands in for wide", async () => {
  const { sent } = await seed();
  assert.equal(ringText(sent, "near"), PROX.near);
  assert.equal(ringText(sent, "wide"), PROX.far);
});

test("rings: no wide text given, wide takes the far given (the last resort)", async () => {
  // a far written before the clue agent existed, with no wide anywhere: withRingTexts leaves it
  const dirs = [{ id: "s1_prox_n1_wide_r", type: "reaction", then: [{ type: "diary_entry", text: "old" }] }];
  const out = withRingTexts(dirs, "n1", { far: "the story's far", mid: "m", near: "n" }, "s1_").directives;
  assert.equal(out[0].then[0].text, "the story's far");
});

test("clues: ids unchanged, so a stage written twice adds nothing", async () => {
  const a = await seed({ clue: GOOD });
  const b = await seed();
  assert.deepEqual(a.sent.map((d) => d.id).sort(), b.sent.map((d) => d.id).sort());
  // the rewritten rings sent again are duplicates the gate drops
  const again = withRingTexts(b.sent, "n1", { wide: "w", far: "x", mid: "y", near: "z" }, "s1_").directives.filter((d) => /prox_/.test(d.id));
  assert.equal(again.filter((d) => d.type === "define_zone").length, 4, "four rings");
  const g = gateBatch(again, { pushedIds: new Set(a.sent.map((d) => d.id)) });
  assert.equal(g.accepted.length, 0);
  assert.equal(g.rejected.length, again.length);
});

test("clues: two languages, each line shows its facts in each by what was done there", async () => {
  const two = {
    wide: { en: "Clean shirts on my mind.", "pt-br": "Camisas limpas na cabeça." },
    far: { en: "A ticket for clean shirts.", "pt-br": "Um tíquete de camisas limpas." },
    mid: { en: "Someone lived there and pressed their own whites by hand.", "pt-br": "Alguém morava ali e passava a própria roupa branca à mão." },
    near: { en: "Warm starch, the drum spinning, the smell of soap.", "pt-br": "Goma morna, o tambor girando, o cheiro de sabão." },
    cites: { mid: [{ fact: "kind:home" }], near: [{ fact: "room:laundry" }] },
  };
  const { sent } = await seed({ clue: two, languages: ["en", "pt-br"] });
  assert.deepEqual(ringText(sent, "near"), two.near);
  assert.deepEqual(ringText(sent, "wide"), two.wide);
});

// ---------------------------------------------------------------- the gate itself

const buildings = buildingsOf({ c: ROWS }, FIELDS);
const house = buildings.find((b) => b.id === HOUSE);
const facts = buildingFacts(house, buildings).facts;

test("facts: rare rooms, a basement few have and two floors are distinctive; the kind of place is not", () => {
  const f = Object.fromEntries(facts.map((x) => [x.id, x]));
  assert.equal(f["room:laundry"].distinctive, true);
  assert.equal(f["room:kitchen"].distinctive, false);
  assert.equal(f["kind:home"].distinctive, false);
  assert.equal(f.basement.distinctive, true);
  assert.equal(f["floors:2"].distinctive, true);
  assert.equal(f["region:Riverside"].proper, true);
  assert.equal(f["neighbour:Riverside Laundromat"].kind, "neighbour");
});

test("gate: naming the room or the kind of place is refused in any ring; proper names stay", () => {
  const g = cluesGate({ ...GOOD, near: "The laundromat, the machines, starch." }, { facts, languages: ["en"] });
  assert.equal(g.ok, false);
  assert.ok(g.errors.includes('near: names the place ("laundromat") in en'), g.errors.join("; "));
  const h = cluesGate({ ...GOOD, far: "A house by the river." }, { facts, languages: ["en"] });
  assert.ok(h.errors.includes('far: names the place ("house") in en'));
  const k = cluesGate({ ...GOOD, wide: { en: GOOD.wide, "pt-br": "Camisas." }, mid: { en: GOOD.mid, "pt-br": "Alguém morava naquela casa." }, far: { en: GOOD.far, "pt-br": "Um tíquete." },
    near: { en: GOOD.near, "pt-br": "A goma, o tambor girando." } }, { facts, languages: ["en", "pt-br"] });
  assert.ok(k.errors.includes('mid: names the place ("casa") in pt-br'), k.errors.join("; "));
  // the neighbour's own name holds a place word: a proper name, allowed
  const ok = cluesGate({ ...GOOD, near: "Starch and the spin of the drum, not far from Riverside Laundromat." }, { facts, languages: ["en"] });
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.equal(cluesGate(GOOD, { facts, languages: ["en"] }).ok, true);
  // a bare activity of 4+ letters matches its longer forms
  const st = cluesGate({ ...GOOD, near: "Shirts ironed and folded, still warm." }, { facts, languages: ["en"] });
  assert.equal(st.ok, true, st.errors.join("; "));
});

test("gate: every language shows the fact by its own activity words; a missing language fails", () => {
  const near = { en: "The cold of the steps going down.", "pt-br": "O frio dos degraus descendo." };
  const ok = cluesGate({ wide: { en: "a", "pt-br": "a" }, far: { en: "a", "pt-br": "a" }, mid: { en: "Someone lived there, in Riverside.", "pt-br": "Alguém morava ali, em Riverside." }, near },
    { facts, languages: ["en", "pt-br"] });
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.deepEqual(ok.cited.near, ["basement"]);
  const miss = cluesGate({ wide: { en: "a", "pt-br": "a" }, far: { en: "a" }, mid: { en: "Riverside", "pt-br": "a cidade" }, near }, { facts, languages: ["en", "pt-br"] });
  assert.equal(miss.ok, false);
  assert.ok(miss.errors.includes("far: no text in pt-br"));
  assert.ok(miss.errors.includes("mid: shows none of the building's facts"), "a proper name alone does not turn the reader");
});

test("gate: when the piece was asked into a room, another room may not be named", () => {
  const f = buildingFacts(house, buildings, { room: "kitchen" }).facts;
  assert.equal(f.find((x) => x.id === "room:kitchen").distinctive, true, "the asked room counts as distinctive");
  const g = cluesGate(GOOD, { facts: f, languages: ["en"], room: "kitchen" });
  assert.equal(g.ok, false);
  assert.match(g.errors.join(" "), /near: evokes room:laundry \("starch"\) but the piece is in the kitchen/);
  const k = cluesGate({ ...GOOD, near: "Onions frying, the kettle starting to sing." }, { facts: f, languages: ["en"], room: "kitchen" });
  assert.equal(k.ok, true, k.errors.join("; "));
  assert.equal(k.room, "kitchen");
});

test("words: room ids read as words; whole words only, accents ignored", () => {
  assert.ok(roomWords("livingroom").includes("living room"));
  assert.ok(roomWords("garagestorage").includes("garage"));
  assert.ok(roomWords("toolstorage").includes("tool"));
  assert.ok(mentions("A lavanderia é aqui", "lavanderia"));
  assert.ok(mentions("Não, uma CASA.", "casa"));
  assert.ok(!mentions("laundromat", "laundry"));
});

test("clues: the chapter model, its own token cap", () => {
  assert.equal(maxTokensFor({ role: "clues", task: "clues" }), 3000);
  assert.equal(modelFor("clues", "anthropic", { stage: "claude-haiku-5-5", story: "claude-opus-5-5" }, "x"), "claude-haiku-5-5");
});

test("clues: plain rings, both languages, a compass from the nearest named place", async () => {
  const { plainRings, compass } = await import("../src/clues.js");
  assert.deepEqual(compass(0, 0, 100, 0), ["east", "leste"]);
  assert.deepEqual(compass(0, 0, 0, -100), ["north", "norte"]);
  assert.equal(compass(0, 0, 5, 5), null, "too close to say");
  const facts = {
    building: { id: "b_6760_5408", floors: 2, region: "Riverside", rooms: ["kitchen", "laundry"] },
    facts: [{ id: "kind:home", kind: "kind" }, { id: "room:laundry", kind: "room", distinctive: true }],
    neighbour: { name: "Riverside Country Club", x: 6600, y: 5408 },
  };
  const r = plainRings(facts, { languages: ["en", "pt-br"] });
  assert.equal(r.room, "laundry");
  assert.equal(r.near.en, "Warm cotton, starch, the drum still turning in my head. East of Riverside Country Club. It is in there.");
  assert.equal(r.near["pt-br"], "Algodão morno, goma, o tambor girando na minha cabeça. A leste de Riverside Country Club. Está lá dentro.");
  assert.equal(r.mid.en, "Someone lived there, cooked there, kept their own things in order.");
  assert.equal(r.mid["pt-br"], "Alguém morava ali, cozinhava ali, cuidava das próprias coisas.");
  assert.equal(r.wide.en, PLAIN_WIDE);
  assert.equal(r.wide["pt-br"], "Em algum lugar por ali, alguma coisa me puxou, fraca demais para seguir, como uma palavra que eu quase lembrei.");
  const alone = plainRings({ ...facts, neighbour: null }, { languages: ["en"] });
  assert.equal(alone.near, "Warm cotton, starch, the drum still turning in my head. Somewhere in Riverside. It is in there.");
  // catalog aliases share a room's line: the cold for a butcher, the hum of a projector for a home cinema
  const as = (room) => plainRings({ ...facts, neighbour: null }, { languages: ["en"], room }).near;
  assert.match(as("knoxbutcher"), /^A cleaver in the block, raw meat on hooks, the cold/);
  assert.match(as("homecinema"), /^The hum of a projector/);
  assert.match(as("restaurantkitchen"), /^Onions frying/);
});

test("plain rings: every room's line passes the clue gate itself, in both languages, never naming a place", async () => {
  const { plainRings, PLAIN_ROOMS } = await import("../src/clues.js");
  assert.ok(PLAIN_ROOMS.length >= 30, `${PLAIN_ROOMS.length} rooms`);
  for (const room of PLAIN_ROOMS) {
    // the room asked into, every other room of the table present too (so near may evoke none of them)
    const fs = [
      { id: "kind:home", kind: "kind", words: ["house", "home"], proper: false, distinctive: false },
      ...PLAIN_ROOMS.map((r) => ({ id: `room:${r}`, kind: "room", words: roomWords(r), proper: false, distinctive: r === room })),
      { id: "basement", kind: "basement", words: ["basement"], proper: false, distinctive: false },
      { id: "region:Riverside", kind: "region", words: ["Riverside"], proper: true, distinctive: false },
      { id: "neighbour:Riverside Laundromat", kind: "neighbour", words: ["Riverside Laundromat"], proper: true, distinctive: false },
    ];
    const facts = { building: { id: "b_10600_9600", floors: 1, region: "Riverside" }, facts: fs,
      neighbour: { name: "Riverside Laundromat", x: 10700, y: 9700 } };
    for (const languages of [["en"], ["pt-br"], ["en", "pt-br"]]) {
      const r = plainRings(facts, { languages, room });
      assert.equal(r.room, room);
      const g = cluesGate({ wide: r.wide, far: languages.length > 1 ? { en: "Clean shirts.", "pt-br": "Camisas limpas." } : "Clean shirts.", mid: r.mid, near: r.near },
        { facts: fs, languages, room });
      assert.equal(g.ok, true, `${room} ${languages}: ${g.errors.join("; ")} | ${JSON.stringify(r.near)}`);
      assert.ok(g.cited.near.includes(`room:${room}`), `${room}: near shows its own room`);
      assert.equal(g.room, room);
    }
  }
});

test("plain rings: no distinctive room with a line, a distinctive basement speaks", async () => {
  const { plainRings } = await import("../src/clues.js");
  const fs = [{ id: "kind:home", kind: "kind" }, { id: "room:kitchen", kind: "room", distinctive: false },
    { id: "basement", kind: "basement", distinctive: true }];
  const r = plainRings({ building: { id: "b_1_1", region: "Muldraugh" }, facts: fs }, { languages: ["en"] });
  assert.equal(r.room, null);
  assert.equal(r.near, "The cold of the steps going down, the dark under the floor. Somewhere in Muldraugh. It is in there.");
  const g = cluesGate({ wide: r.wide, far: "x", mid: r.mid, near: r.near }, { facts: fs, languages: ["en"] });
  assert.equal(g.ok, true, g.errors.join("; "));
});

test("clues gate: the live Haiku answer of 2026-10-23 names the place and is refused; an indirect rewrite passes", async () => {
  const facts = [
    { id: "kind:home", kind: "kind", words: ["house", "home"], proper: false, distinctive: false },
    { id: "room:laundry", kind: "room", words: ["laundry", "laundry room", "washing machine", "washer"], proper: false, distinctive: true },
    { id: "basement", kind: "basement", words: ["basement", "cellar"], proper: false, distinctive: true },
    { id: "region:Riverside", kind: "region", words: ["Riverside"], proper: true, distinctive: false },
  ];
  const live = {
    wide: { en: "Clean shirts.", "pt-br": "Camisas limpas." },
    far: { en: "I keep thinking about that laundry, the hot starch still hanging in the air.", "pt-br": "Não paro de pensar naquela lavanderia, a goma quente ainda no ar." },
    mid: { en: "Not a laundromat after all, I think. A house with a laundry room of its own.", "pt-br": "Não era lavanderia de bairro, acho. Uma casa com lavanderia própria." },
    near: { en: "Past the washing, the stairs go down to a basement, and something down there is still waiting.", "pt-br": "Depois da roupa, a escada desce até um porão, e algo lá embaixo ainda espera o dono." },
    cites: { mid: [{ fact: "room:laundry" }] },
  };
  const bad = cluesGate(live, { facts, languages: ["en", "pt-br"] });
  assert.equal(bad.ok, false);
  for (const e of ['far: names the place ("laundry") in en', 'far: names the place ("lavanderia") in pt-br',
    'mid: names the place ("laundry") in en', 'mid: names the place ("lavanderia") in pt-br',
    'near: names the place ("basement") in en', 'near: names the place ("porao") in pt-br']) assert.ok(bad.errors.includes(e), `${e} | ${bad.errors.join("; ")}`);
  const indirect = {
    wide: { en: "Clean shirts, and nobody to wear them.", "pt-br": "Camisas limpas, e ninguém para vesti-las." },
    far: { en: "I keep thinking about the hot starch still hanging in the air.", "pt-br": "Não paro de pensar na goma quente ainda no ar." },
    mid: { en: "Not a place where strangers queued with their bags. Someone pressed their own whites there, by hand.",
      "pt-br": "Não era lugar de estranhos com sacolas. Alguém passava a própria roupa branca ali, à mão." },
    near: { en: "Past the washing, the cold of the steps going down, and something down there still waiting.",
      "pt-br": "Depois da roupa, o frio dos degraus descendo, e algo lá embaixo ainda espera o dono." },
  };
  const g = cluesGate(indirect, { facts, languages: ["en", "pt-br"] });
  assert.equal(g.ok, true, g.errors.join("; "));
  assert.deepEqual(g.cited.mid, ["room:laundry"]);
  assert.deepEqual(g.cited.near, ["basement"]);
});
