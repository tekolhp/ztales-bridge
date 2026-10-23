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
  if (typeof v === "string" && ["text", "title", "far", "mid", "near"].includes(key)) return Object.fromEntries(langs.map((l) => [l, v]));
  if (Array.isArray(v)) return v.map((x) => inAll(x, langs));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "bible" ? x : inAll(x, langs, k)]));
  return v;
}

const GOOD = {
  far: "A ticket for clean shirts nobody came back for.",
  mid: "Not a shop. A house, one that washed its own.",
  near: "That laundry room in the big house, the dryer door open.",
  cites: { mid: [{ fact: "kind:home" }], near: [{ fact: "room:laundry" }] },
};

async function seed({ clue, maxUsdPerDay, languages } = {}) {
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
    if (clue instanceof Error) throw clue;
    return { doc: structuredClone(clue), model: "fake-haiku", cost: 0.002, raw: JSON.stringify(clue) };
  };
  const decide = makeDecide({ ask, askClues, system: "SYSTEM", bibleKey: KEY, ...(maxUsdPerDay ? { maxUsdPerDay } : {}) });
  const r = await tick({ t, store, nowSec: T0, decide });
  const pushed = [...t.files.keys()].find((k) => k.startsWith("inbox/directives-"));
  const sent = pushed ? JSON.parse(t.files.get(pushed)).directives : [];
  return { t, store, r, sent, calls, clueCalls };
}

const ringText = (sent, k) => sent.find((d) => d.id === `s1_prox_n1_${k}_r`)?.then?.[0]?.text;
const pieceOf = (sent) => sent.find((d) => d.id === "s_ticket");

test("clues: a good answer rewrites the three rings and asks the piece into the room the clues name", async () => {
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

test("clues: an answer that fails the gate gives plain rings from the facts (logged, cost counted)", async () => {
  // near cites only the kind of place, which every house has: not distinctive
  const weak = { ...GOOD, near: "A house. It was a house.", cites: { mid: [{ fact: "kind:home" }], near: [{ fact: "kind:home" }] } };
  const { sent, store, r, clueCalls } = await seed({ clue: weak });
  assert.equal(clueCalls.length, 1, "never asked again blindly");
  assert.equal(ringText(sent, "far"), PROX.far, "the story's far ring keeps the mood");
  assert.equal(ringText(sent, "mid"), "Not a shop, I think. Someone's house.");
  assert.match(ringText(sent, "near"), /^A house.*laundry.*It is in there\.$/);
  assert.equal(pieceOf(sent).target.room, "laundry", "the piece goes where the plain words point");
  const log = store.callLog.find((c) => c.purpose === "clues#n1");
  assert.equal(log.cost_usd, 0.002);
  assert.match(log.note, /clue gate.*near: shows nothing only this building has/);
  assert.match(r.notes.join(" "), /clues#n1: refused/);
  assert.equal((await store.getState()).stage_written, "n1", "the chapter went out");
});

test("clues: a cite the text does not show, or a fact never given, is refused", async () => {
  const lie = { ...GOOD, near: "The pool. The deep end.", cites: { mid: [{ fact: "kind:home" }], near: [{ fact: "room:laundry" }, { fact: "room:pool" }] } };
  const { sent, store } = await seed({ clue: lie });
  assert.notEqual(ringText(sent, "near"), PROX.near);
  assert.match(store.callLog.find((c) => c.purpose === "clues#n1").note, /room:pool, a fact it was not given/);
});

test("clues: a failed call gives plain rings and never fails the stage", async () => {
  const { sent, store, r } = await seed({ clue: new BrainError("answer is not valid JSON", 0, 0.003, "{oops") });
  assert.equal(ringText(sent, "mid"), "Not a shop, I think. Someone's house.");
  const log = store.callLog.find((c) => c.purpose === "clues#n1");
  assert.equal(log.ok, false);
  assert.equal(log.cost_usd, 0.003, "a failed call is still paid for");
  const s = await store.getState();
  assert.equal(s.stage_written, "n1");
  assert.equal(s.ai_failures, 0, "no back-off for the chapter");
  assert.match(r.notes.join(" "), /clues#n1: AI call failed/);
});

test("clues: any thrown error, not only the provider's, falls back", async () => {
  const { sent } = await seed({ clue: new TypeError("boom") });
  assert.match(ringText(sent, "near"), /It is in there\.$/);
});

test("clues: the daily budget reached, no call is made", async () => {
  const { sent, clueCalls, r } = await seed({ clue: GOOD, maxUsdPerDay: 0.01 });
  assert.equal(clueCalls.length, 0);
  assert.match(ringText(sent, "near"), /It is in there\.$/, "no credit: plain words, still pointing the way");
  assert.match(r.notes.join(" "), /clues#n1: daily AI budget reached/);
});

test("clues: without a clue agent (rehearsal, tests) nothing changes", async () => {
  const { sent } = await seed();
  assert.equal(ringText(sent, "near"), PROX.near);
});

test("clues: ids unchanged, so a stage written twice adds nothing", async () => {
  const a = await seed({ clue: GOOD });
  const b = await seed();
  assert.deepEqual(a.sent.map((d) => d.id).sort(), b.sent.map((d) => d.id).sort());
  // the rewritten rings sent again are duplicates the gate drops
  const again = withRingTexts(b.sent, "n1", { far: "x", mid: "y", near: "z" }, "s1_").directives.filter((d) => /prox_/.test(d.id));
  const g = gateBatch(again, { pushedIds: new Set(a.sent.map((d) => d.id)) });
  assert.equal(g.accepted.length, 0);
  assert.equal(g.rejected.length, again.length);
});

test("clues: two languages, each line shows its facts in each (a translated room by the cite's words)", async () => {
  const two = {
    far: { en: "A ticket for clean shirts.", "pt-br": "Um tíquete de camisas limpas." },
    mid: { en: "Not a shop. A house.", "pt-br": "Não uma loja. Uma casa." },
    near: { en: "The laundry room, the dryer open.", "pt-br": "A lavanderia da casa, a secadora aberta." },
    cites: { mid: [{ fact: "kind:home", words: { "pt-br": "casa" } }], near: [{ fact: "room:laundry", words: { "pt-br": "lavanderia" } }] },
  };
  const { sent } = await seed({ clue: two, languages: ["en", "pt-br"] });
  assert.deepEqual(ringText(sent, "near"), two.near);
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

test("gate: English must show the fact's own word; 'laundromat' is not the laundry room", () => {
  const g = cluesGate({ ...GOOD, near: "The laundromat, the machines.", cites: { mid: GOOD.cites.mid, near: [{ fact: "room:laundry" }] } },
    { facts, languages: ["en"] });
  assert.equal(g.ok, false);
  assert.ok(g.errors.includes("near: shows nothing only this building has"));
  assert.equal(cluesGate(GOOD, { facts, languages: ["en"] }).ok, true);
});

test("gate: a proper name must appear in every language; a missing language fails", () => {
  const near = { en: "Two floors over the basement.", "pt-br": "Dois andares sobre o porão." };
  const ok = cluesGate({ far: { en: "a", "pt-br": "a" }, mid: { en: "Riverside, a house.", "pt-br": "Riverside, uma casa." }, near,
    cites: { mid: [{ fact: "region:Riverside" }], near: [{ fact: "basement", words: { "pt-br": "porão" } }] } }, { facts, languages: ["en", "pt-br"] });
  assert.equal(ok.ok, true, ok.errors.join("; "));
  const miss = cluesGate({ far: { en: "a" }, mid: { en: "Riverside", "pt-br": "a cidade" }, near,
    cites: { mid: [{ fact: "region:Riverside" }], near: [{ fact: "basement", words: { "pt-br": "porão" } }] } }, { facts, languages: ["en", "pt-br"] });
  assert.equal(miss.ok, false);
  assert.ok(miss.errors.includes("far: no text in pt-br"));
  assert.ok(miss.errors.includes("mid: shows none of the building's facts"), "the name must be in the pt-br line too");
});

test("gate: when the piece was asked into a room, another room may not be named", () => {
  const f = buildingFacts(house, buildings, { room: "kitchen" }).facts;
  assert.equal(f.find((x) => x.id === "room:kitchen").distinctive, true, "the asked room counts as distinctive");
  const g = cluesGate(GOOD, { facts: f, languages: ["en"], room: "kitchen" });
  assert.equal(g.ok, false);
  assert.match(g.errors.join(" "), /names room:laundry but the piece is in the kitchen/);
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
  assert.equal(maxTokensFor({ role: "clues", task: "clues" }), 1500);
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
  assert.equal(r.near.en, "A house with an upper floor, and in it the laundry, east of Riverside Country Club. It is in there.");
  assert.equal(r.near["pt-br"], "Uma casa de dois andares, e dentro dela a lavanderia, a leste de Riverside Country Club. Está lá dentro.");
  assert.equal(r.mid["pt-br"], "Não é loja, acho. A casa de alguém.");
});

test("clues gate: reads the lines itself (live Haiku answer 2026-10-23, no cite on near)", async () => {
  const { cluesGate } = await import("../src/clues.js");
  const facts = [
    { id: "room:laundry", kind: "room", words: ["laundry", "laundry room", "washing machine", "washer"], proper: false, distinctive: true },
    { id: "basement", kind: "basement", words: ["basement", "cellar"], proper: false, distinctive: true },
    { id: "region:Riverside", kind: "region", words: ["Riverside"], proper: true, distinctive: false },
  ];
  const answer = {
    far: { en: "I keep thinking about that laundry, the hot starch still hanging in the air.", "pt-br": "Não paro de pensar naquela lavanderia, a goma quente ainda no ar." },
    mid: { en: "Not a laundromat after all, I think. A house with a laundry room of its own.", "pt-br": "Não era lavanderia de bairro, acho. Uma casa com lavanderia própria." },
    near: { en: "Past the washing, the stairs go down to a basement, and something down there is still waiting.", "pt-br": "Depois da roupa, a escada desce até um porão, e algo lá embaixo ainda espera o dono." },
    cites: { mid: [{ fact: "room:laundry" }] },
  };
  const g = cluesGate(answer, { facts, languages: ["en", "pt-br"] });
  assert.equal(g.ok, true, g.errors.join("; "));
  assert.deepEqual(g.cited.near, ["basement"]);
});
