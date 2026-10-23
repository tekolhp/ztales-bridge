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

// indirect (Teko, 2026-10-23): never the room's or the place's name, only what was done and sensed there
const GOOD = {
  far: "A ticket for clean shirts nobody came back for.",
  mid: "Someone lived there and pressed their own whites by hand.",
  near: "Warm starch and the spin of the drum, the smell of soap on everything.",
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
  const weak = { ...GOOD, near: "Someone lived there. They cooked there.", cites: { mid: [{ fact: "kind:home" }], near: [{ fact: "kind:home" }] } };
  const { sent, store, r, clueCalls } = await seed({ clue: weak });
  assert.equal(clueCalls.length, 1, "never asked again blindly");
  assert.equal(ringText(sent, "far"), "Something about that place keeps coming back to me, the way a smell does.", "a far that names the place gives way to the plain one");
  assert.equal(ringText(sent, "mid"), "Someone lived there, cooked there, kept their own things in order.");
  assert.equal(ringText(sent, "near"), "Warm cotton, starch, the drum still turning in my head. Northwest of Riverside Laundromat. It is in there.");
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
  assert.equal(ringText(sent, "mid"), "Someone lived there, cooked there, kept their own things in order.");
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

test("clues: two languages, each line shows its facts in each by what was done there", async () => {
  const two = {
    far: { en: "A ticket for clean shirts.", "pt-br": "Um tíquete de camisas limpas." },
    mid: { en: "Someone lived there and pressed their own whites by hand.", "pt-br": "Alguém morava ali e passava a própria roupa branca à mão." },
    near: { en: "Warm starch, the drum spinning, the smell of soap.", "pt-br": "Goma morna, o tambor girando, o cheiro de sabão." },
    cites: { mid: [{ fact: "kind:home" }], near: [{ fact: "room:laundry" }] },
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

test("gate: naming the room or the kind of place is refused in any ring; proper names stay", () => {
  const g = cluesGate({ ...GOOD, near: "The laundromat, the machines, starch." }, { facts, languages: ["en"] });
  assert.equal(g.ok, false);
  assert.ok(g.errors.includes('near: names the place ("laundromat") in en'), g.errors.join("; "));
  const h = cluesGate({ ...GOOD, far: "A house by the river." }, { facts, languages: ["en"] });
  assert.ok(h.errors.includes('far: names the place ("house") in en'));
  const k = cluesGate({ ...GOOD, mid: { en: GOOD.mid, "pt-br": "Alguém morava naquela casa." }, far: { en: GOOD.far, "pt-br": "Um tíquete." },
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
  const ok = cluesGate({ far: { en: "a", "pt-br": "a" }, mid: { en: "Someone lived there, in Riverside.", "pt-br": "Alguém morava ali, em Riverside." }, near },
    { facts, languages: ["en", "pt-br"] });
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.deepEqual(ok.cited.near, ["basement"]);
  const miss = cluesGate({ far: { en: "a" }, mid: { en: "Riverside", "pt-br": "a cidade" }, near }, { facts, languages: ["en", "pt-br"] });
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
      const g = cluesGate({ far: languages.length > 1 ? { en: "Clean shirts.", "pt-br": "Camisas limpas." } : "Clean shirts.", mid: r.mid, near: r.near },
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
  const g = cluesGate({ far: "x", mid: r.mid, near: r.near }, { facts: fs, languages: ["en"] });
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
