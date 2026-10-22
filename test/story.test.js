import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDecide, checkBible, hintsFor } from "../src/story.js";
import { MemoryStore } from "../src/store.js";
import { MemoryTransport } from "../src/transport.js";
import { tick } from "../src/tick.js";
import { open, seal } from "../src/crypto.js";

const KEY = "test-bible-key-0123456789";
const T0 = 1_800_000_000;
const FIELDS = ["x", "y", "w", "h", "floors", "flags", "region", "name", "rooms", "zombie_density"];

function catalogFiles() {
  return {
    "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1 }),
    "catalog/index.json": JSON.stringify({ version: "v1", cell_size: 300, building_fields: FIELDS, story_max_nodes: 4,
      spawn_regions: [{ name: "Muldraugh, KY", points: [[10650, 9650]] }], professions: [{ id: "nurse" }], mods: [], outfits: ["Police"],
      item_categories: [] }),
    "catalog/cells.json": JSON.stringify({ cells: [{ cell: "35_32", buildings: 3 }, { cell: "39_32", buildings: 2 }] }),
    // outside the spawn town (Muldraugh at 10650,9650): where a final node and the urn may go
    "catalog/cell-39_32.json": JSON.stringify({ rows: [
      [11800, 9700, 14, 12, 1, "u", "", "", ["policestorage"], 0.4],
      [11850, 9800, 8, 8, 1, "ru", "", "", ["church"], 0.1],
    ] }),
    "catalog/cell-35_32.json": JSON.stringify({ rows: [
      [10600, 9600, 10, 8, 1, "r", "Muldraugh", "", ["kitchen", "bedroom"], 0.1],
      [10700, 9700, 12, 10, 1, "s", "Muldraugh", "", ["pharmacy"], 0.2],
      [10800, 9650, 20, 15, 2, "", "Muldraugh", "", ["policestorage"], 0.3],
    ] }),
  };
}

// every stage leads on: the first piece's reaction moves to the next node, or ends the story on the last
const NEXT = { n1: "n2" };
const stageReactions = (node, pieces) => [
  ...pieces.map((p, i) => ({ id: `${node}_r${i}`, type: "reaction", stage: node, when: { event: "item_picked", story_id: p },
    then: [{ id: `${node}_r${i}.1`, type: "chat", scope: "player", player: "$player", text: "It is still warm." },
      ...(i === 0 && NEXT[node] ? [{ id: `${node}_r${i}.2`, type: "set_node", node: NEXT[node] }] : [])], reveals: [`f_${p}`] })),
  { id: `${node}_close`, type: "reaction", stage: node, when: { event: "node_changed", from: node },
    then: [{ id: `${node}_close.1`, type: "chat", scope: "server", text: "Somewhere a radio goes quiet." }] },
  ...[1, 2, 3, 4].map((s) => ({ id: `${node}_s${s}`, type: "reaction", stage: node, when: { event: "signal", name: "stall", step: s },
    then: [{ id: `${node}_s${s}.1`, type: "chat", scope: "server", text: `Static, ${s}.` }] })),
];

const PROX = { far: "Something about this side of town.", mid: "It is close. I keep slowing down here.", near: "Here. It was here." };
// the AI's part of the final stage (docs/10): the nightmare that names the place, the lines, the Tale
const FINALE = (place = "the church") => ({
  where: `I dreamt I carried it all to ${place} and put it in the urn.`, where_line: `What was found goes into the urn at ${place}.`,
  lines: { hush: "Hush.", scream: "A scream.", last_wave: "The last of them.", silence: "Silence." }, epilogue: "It is quiet now.",
  tale: "Dalton read the numbers every night. Then he stopped.",
});

const BIBLE = {
  season: "s1", title: "The Last Transmission", premise: "...",
  ending: { text: "The recorder plays the last broadcast on the roof." },
  forbidden_entities: ["Dalton Keane", "the roof"],
  difficulty: { color: "yellow" },
  axis: [
    { id: "n1", question: "What is 88.6?", pieces: [{ story_id: "n1_photo", item: "ZTales.PhotoYellow" }] },
    { id: "n2", question: "Who kept the key?", pieces: [{ story_id: "n2_key", item: "ZTales.KeyYellow" }], ending: true },
  ],
  finale: { rooms_wanted: ["policestorage"], urn: { title: "Clay urn" }, charges: { n2_key: [{ stat: "panic", level: 3 }] },
    weather: "fog", sounds: ["MetaScream"], reward: [{ item: "Base.Katana", count: 1 }] },
};

function seedAnswer(overrides = {}) {
  return {
    bible: BIBLE,
    directives: [
      { id: "s_photo", type: "place_item", story_id: "n1_photo", item: "ZTales.PhotoYellow", target: { building: "b_10700_9700" } },
      ...stageReactions("n1", ["n1_photo"]),
    ],
    hints: { n1: { full: { text: "The pharmacy counter." }, echo: { text: "88.6" } }, openers: { nurse: ["I counted the pills twice"] } },
    proximity: PROX,
    motifs_used: [],
    ...overrides,
  };
}

function fakeAsk(answers) {
  const calls = [];
  const ask = async (system, context) => {
    calls.push(JSON.parse(context));
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { doc: structuredClone(a), model: "fake", cost: 0.01 };
  };
  return { ask, calls };
}

async function seedSetup(answers) {
  const t = new MemoryTransport(catalogFiles());
  const store = new MemoryStore();
  const ai = fakeAsk(answers);
  const decide = makeDecide({ ask: ai.ask, system: "SYSTEM", bibleKey: KEY });
  const r = await tick({ t, store, nowSec: T0, decide });
  return { t, store, ai, decide, r };
}

test("seed: bible sealed, first stage armed, hints written, the season opens on n1", async () => {
  const { t, store, ai, r } = await seedSetup([seedAnswer()]);
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].task, "seed");
  assert.ok(ai.calls[0].catalog.places.some((p) => p.id === "b_10700_9700"), "the AI sees real buildings");
  assert.ok(ai.calls[0].catalog.clue_items.includes("ZTales.NoteYellow"));
  const sealed = await store.getBible();
  assert.ok(!sealed.includes("recorder"), "the ending is not readable in the database");
  assert.equal((await open(KEY, sealed)).title, "The Last Transmission");
  const pushed = [...t.files.keys()].find((k) => k.startsWith("inbox/directives-"));
  const sent = JSON.parse(t.files.get(pushed)).directives;
  assert.equal(sent[0].type, "set_node");
  assert.equal(sent[0].node, "n1");
  assert.equal(sent.filter((d) => d.type === "reaction").length, 9, "6 from the story (one piece, the closing, four stall steps), 3 for the proximity rings");
  const hints = JSON.parse(t.files.get("inbox/hints.json"));
  assert.equal(hints.node, "n1");
  assert.equal(hints.full.text, "The pharmacy counter.");
  assert.deepEqual(hints.openers.nurse, ["I counted the pills twice"]);
  assert.equal(r.pushed, sent.length);
  const s = await store.getState();
  assert.equal(s.stage_written, "n1");
  assert.equal(s.ai_lock_until, 0);
});

test("seed: an invented building is rejected and the AI gets a second round with the reason", async () => {
  const bad = seedAnswer();
  bad.directives[0].target.building = "b_1_1";
  const { ai, store } = await seedSetup([bad, seedAnswer()]);
  assert.equal(ai.calls.length, 2);
  assert.match(JSON.stringify(ai.calls[1].rejections), /b_1_1 was not offered/);
  assert.ok(await store.getBible());
});

test("seed: a bible longer than the server allows is refused", async () => {
  const long = seedAnswer({ bible: { ...BIBLE, axis: [1, 2, 3, 4, 5].map((i) => ({ id: `n${i}`, pieces: [{ story_id: `a${i}` }] })) } });
  const { ai, store, r } = await seedSetup([long, long]);
  assert.equal(ai.calls.length, 2);
  assert.equal(await store.getBible(), null);
  assert.ok(r.notes.includes("seed rejected"));
  assert.equal(r.pushed, 0);
});

test("a stage without every reaction it needs is sent back once", async () => {
  const thin = seedAnswer();
  thin.directives = thin.directives.filter((d) => d.id !== "n1_s4");
  const { ai } = await seedSetup([thin, seedAnswer()]);
  assert.equal(ai.calls.length, 2);
  assert.match(JSON.stringify(ai.calls[1].rejections), /missing stall step 4/);
});

test("stage: on node_changed the AI writes the next stage; on the last node the forbidden names may finally be said", async () => {
  const { t, store, decide } = await seedSetup([seedAnswer()]);
  const stage2 = {
    directives: [
      { id: "n2_k", type: "place_item", story_id: "n2_key", item: "ZTales.KeyYellow", target: { building: "b_11800_9700" } },
      { id: "n2_leak", type: "chat", scope: "server", text: "Dalton Keane was here." },
      ...stageReactions("n2", ["n2_key"]),
    ],
    hints: { n2: { full: { text: "The police storage." }, echo: { text: "seven" } } },
    proximity: PROX, finale: FINALE(),
  };
  const ai = fakeAsk([stage2]);
  const d2 = makeDecide({ ask: ai.ask, system: "SYSTEM", bibleKey: KEY });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  const r = await tick({ t, store, nowSec: T0 + 600, decide: d2 });
  assert.equal(ai.calls[0].task, "stage");
  assert.equal(ai.calls[0].stage.id, "n2");
  assert.ok(!r.rejected.some((x) => x.id === "n2_leak"), "the final node lifts the forbidden names");
  assert.equal(JSON.parse(t.files.get("inbox/hints.json")).node, "n2");
  assert.equal((await store.getState()).stage_written, "n2");
  void decide;
});

test("what players write waits as a motif for the next milestone, then is marked used", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  // the next milestone is chapter two, written when chapter one closes: the motif waits for it
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/journal-2-00001.json", JSON.stringify({ entries: [{ id: "j_0001", player: "ana", kind: "backstory", text: "My grandmother fished every morning." }] }));
  const ai = fakeAsk([{ directives: [
    { id: "n2_k", type: "place_item", story_id: "n2_key", item: "ZTales.KeyYellow", target: { building: "b_11800_9700" } },
    ...stageReactions("n2", ["n2_key"])], proximity: PROX, finale: FINALE(), motifs_used: ["j_0001"] }]);
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  await tick({ t, store, nowSec: T0 + 60, decide });
  assert.equal(ai.calls.length, 0, "nothing is written ahead");
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1 }));
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  await tick({ t, store, nowSec: T0 + 90, decide });
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].stage.id, "n2", "written when the story reaches it");
  assert.equal(ai.calls[0].motifs[0].text, "My grandmother fished every morning.");
  assert.equal((await store.unusedMotifs()).length, 0);
  // the journal entry alone, with chapter two already written, calls nothing
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 4, players_online: 1 }));
  t.files.set("outbox/journal-4-00001.json", JSON.stringify({ entries: [{ id: "j_0002", player: "ana", kind: "free", text: "The river again." }] }));
  await tick({ t, store, nowSec: T0 + 120, decide });
  assert.equal(ai.calls.length, 1, "a journal entry alone does not call the AI");
  assert.equal((await store.unusedMotifs())[0].id, "j_0002");
});

test("the daily cap stops calls; a failing provider is reported, not thrown", async () => {
  const store = new MemoryStore();
  for (let i = 0; i < 3; i++) await store.logCall({ ok: true }, T0 - 10);
  const t = new MemoryTransport(catalogFiles());
  const ai = fakeAsk([seedAnswer()]);
  const r = await tick({ t, store, nowSec: T0, decide: makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY, maxCallsPerDay: 3 }) });
  assert.equal(ai.calls.length, 0);
  assert.ok(r.notes.includes("daily AI call cap reached"));

  const { BrainError } = await import("../src/brain.js");
  const down = fakeAsk([new BrainError("openrouter answered 503")]);
  const t2 = new MemoryTransport(catalogFiles());
  const r2 = await tick({ t: t2, store: new MemoryStore(), nowSec: T0, decide: makeDecide({ ask: down.ask, system: "S", bibleKey: KEY }) });
  assert.ok(r2.notes.some((n) => /AI call failed/.test(n)));
});

test("a call already running (lock) is not started twice", async () => {
  const t = new MemoryTransport(catalogFiles());
  const store = new MemoryStore();
  await store.setState({ ai_lock_until: T0 + 100 });
  const ai = fakeAsk([seedAnswer()]);
  await tick({ t, store, nowSec: T0, decide: makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY }) });
  assert.equal(ai.calls.length, 0);
});

test("bible checks and hint flattening", () => {
  assert.deepEqual(checkBible(BIBLE), []);
  // one piece per chapter (docs/13): never two, never none, never one id twice
  assert.match(checkBible({ ...BIBLE, axis: [{ id: "n1", pieces: [{ story_id: "a", item: "ZTales.NoteYellow" }, { story_id: "b", item: "ZTales.NoteYellow" }] }] }).join(";"), /n1 has 2 pieces: a chapter has exactly one piece/);
  assert.match(checkBible({ ...BIBLE, axis: [{ id: "n1", pieces: [] }] }).join(";"), /n1 has 0 pieces/);
  assert.match(checkBible({ ...BIBLE, axis: [BIBLE.axis[0], { ...BIBLE.axis[1], pieces: BIBLE.axis[0].pieces }] }).join(";"), /n1_photo is used twice/);
  assert.equal(hintsFor({ n2: { full: { text: "x" } } }, "n2", "red").color, "red");
  assert.equal(hintsFor({ n2: {} }, "n3", "red"), null);
});

test("sealing round-trips and refuses a short key", async () => {
  const s = await seal(KEY, { a: "é" });
  assert.deepEqual(await open(KEY, s), { a: "é" });
  await assert.rejects(seal("short", {}), /16 characters/);
  await assert.rejects(open("another-key-0123456789", s));
});

test("near the node: three nested rings around the anchor's real building, one diary reflection each", async () => {
  const { t } = await seedSetup([seedAnswer()]);
  const name = [...t.files.keys()].find((k) => k.startsWith("inbox/directives-"));
  const sent = JSON.parse(t.files.get(name)).directives;
  const zones = sent.filter((d) => d.type === "define_zone" && d.id.startsWith("s1_prox_n1_"));
  assert.deepEqual(zones.map((z) => z.id), ["s1_prox_n1_far", "s1_prox_n1_mid", "s1_prox_n1_near"]);
  // the anchor n1_photo went into b_10700_9700: every ring is centred there
  for (const z of zones) assert.equal(z.x + z.w / 2, 10704);
  assert.ok(zones[0].w > zones[1].w && zones[1].w > zones[2].w, "nested, widest first");
  const near = sent.find((d) => d.id === "s1_prox_n1_near_r");
  assert.equal(near.once, "player");
  assert.equal(near.then[0].type, "diary_entry");
  assert.equal(near.then[0].player, "$player");
  assert.equal(near.then[0].text, "Here. It was here.");
});

test("a stage without its three reflections is sent back", async () => {
  const thin = seedAnswer({ proximity: { far: "x" } });
  const { ai } = await seedSetup([thin, seedAnswer()]);
  assert.equal(ai.calls.length, 2);
  assert.match(JSON.stringify(ai.calls[1].rejections), /proximity reflections \(mid, near\)/);
});

test("each player's longer history reaches the AI, grouped by player", async () => {
  const { journeysByPlayer } = await import("../src/story.js");
  const ev = [];
  for (let i = 0; i < 15; i++) ev.push({ type: "player_journey", player: "ana", regions: [`r${i}`], zombies_killed: i, ts: "x" });
  ev.push({ type: "player_journey", player: "bob", regions: ["Rosewood"] }, { type: "item_picked", player: "ana" });
  const j = journeysByPlayer(ev);
  assert.equal(j.ana.length, 12, "the last 12 journeys");
  assert.deepEqual(j.ana[11].regions, ["r14"]);
  assert.equal(j.bob[0].regions[0], "Rosewood");
  assert.equal(j.ana[0].ts, undefined, "only what a diary would use");
});

test("the stage covers every spawn town plus where players were, not only the players", async () => {
  const { stagePoints, stageCells } = await import("../src/catalog.js");
  const index = { spawn_regions: [{ points: [[10650, 9650]] }, { points: [[8100, 11600]] }, { points: [[6500, 5300]] }] };
  const pts = stagePoints([{ type: "player_online", x: 12000, y: 7000 }], index);
  assert.equal(pts.towns.length, 3);
  assert.deepEqual(pts.near, [[12000, 7000]]);
  const cells = stageCells(pts);
  assert.equal(cells.length, 9 + 3, "3x3 around the player, one cell per town");
  assert.ok(cells.includes("27_38") && cells.includes("21_17"));
});

test("the final node never lands in a spawn town; Louisville is allowed; intermediate nodes may", async () => {
  const { finalPlaceRule, finalStageCells } = await import("../src/catalog.js");
  const { gateBatch } = await import("../src/gates.js");
  const index = { cell_size: 300, spawn_regions: [{ name: "Muldraugh", points: [[10650, 9650]] }] };
  const rule = finalPlaceRule(index, { b_12900_1500: { region: "Louisville" } });
  const g = gateBatch([
    { id: "in_town", type: "place_item", item: "ZTales.KeyRed", target: { building: "b_10700_9700" } },
    { id: "far_out", type: "place_item", item: "ZTales.KeyRed", target: { building: "b_12000_9000" } },
    { id: "louisville", type: "place_item", item: "ZTales.KeyRed", target: { building: "b_12900_1500" } },
  ], { placeRule: rule });
  assert.deepEqual(g.accepted.map((d) => d.id), ["far_out", "louisville"]);
  assert.match(g.rejected[0].reason, /cannot be inside a spawn town/);
  assert.equal(gateBatch([{ id: "mid", type: "place_item", item: "ZTales.KeyRed", target: { building: "b_10700_9700" } }]).accepted.length, 1,
    "without the final rule (intermediate nodes) a spawn town is fine");
  const cells = finalStageCells(index, ["35_32", "36_32", "40_30", "33_35"], [[10650, 9650]]);
  assert.ok(!cells.includes("35_32"), "the spawn town's own cell is never offered for the final node");
  assert.ok(cells.includes("40_30"));
});

const echoAnswer = (text = "I dreamt of a pharmacy with the lights humming, and someone counting.") => ({
  directives: [{ id: "e_ana_2", type: "diary_echo", player: "ana", life: 2, text: { en: text } }],
});

async function deathTick(t, store, decide, nowSec) {
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-1-00009.json", JSON.stringify({ events: [
    { type: "player_journey", player: "ana", char: "Ana Silva", life: 1, named_places: ["Muldraugh pharmacy"], died: true },
    { type: "player_journey", player: "ana", char: "Ana Old", life: 0, named_places: ["nowhere"] },
    { type: "player_died", player: "ana", life: 1, carrying: [] },
  ] }));
  return tick({ t, store, nowSec, decide });
}

test("a death: one small call writes the dream the account's next character finds", async () => {
  const { t, store, ai, decide } = await seedSetup([seedAnswer(), echoAnswer()]);
  const r = await deathTick(t, store, decide, T0 + 120);
  assert.equal(ai.calls.length, 2);
  const c = ai.calls[1];
  assert.equal(c.task, "echo");
  assert.deepEqual(c.echo_for, [{ player: "ana", life: 2 }]);
  assert.deepEqual(c.journeys.ana.map((j) => j.char), ["Ana Silva"], "only the life that ended");
  assert.deepEqual(c.catalog, {}, "no world slice: a dream needs no buildings");
  const sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  const echo = sent.find((d) => d.type === "diary_echo");
  assert.equal(echo.life, 2);
  assert.ok(r.pushed >= 1);
  assert.deepEqual((await store.getState()).echo_due, []);
});

test("a dream that names the mystery, or a life nobody asked for, goes back once; then the stage echo does", async () => {
  const leaky = echoAnswer("Dalton Keane waits on the roof.");
  const wrongLife = { directives: [{ ...echoAnswer().directives[0], life: 3 }] };
  const { t, store, ai, decide } = await seedSetup([seedAnswer(), leaky, wrongLife]);
  const r = await deathTick(t, store, decide, T0 + 120);
  assert.equal(ai.calls.length, 3);
  assert.match(JSON.stringify(ai.calls[2].rejections), /before its time/);
  assert.ok(r.notes.some((n) => /no dream for ana: the stage's echo will do \(sent for ana\)/.test(n)));
  // the stage's echo fills page one now, so the new diary never waits on nothing
  const echoes = sentAll(t).filter((d) => d.type === "diary_echo");
  assert.deepEqual(echoes.map((d) => [d.player, d.life, d.text]), [["ana", 2, "88.6"]]);
  assert.ok(!JSON.stringify(echoes).includes("Dalton"), "never the refused dream");
  assert.deepEqual((await store.getState()).echo_due, [], "asked once, never again");
});

test("a failed AI call is not retried every minute: 15 min, then doubling", async () => {
  const { BrainError } = await import("../src/brain.js");
  const { aiBackoffSec } = await import("../src/story.js");
  const { t, store, ai, decide } = await seedSetup([new BrainError("empty answer", 0, 0.11), seedAnswer()]);
  assert.equal(ai.calls.length, 1);
  let s = await store.getState();
  assert.equal(s.ai_failures, 1);
  assert.equal(s.ai_fail_until, T0 + 900);
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  await tick({ t, store, nowSec: T0 + 120, decide });
  assert.equal(ai.calls.length, 1, "still waiting");
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1 }));
  await tick({ t, store, nowSec: T0 + 901, decide });
  assert.equal(ai.calls.length, 2, "tried again after the wait");
  s = await store.getState();
  assert.equal(s.ai_failures, 0);
  assert.equal(aiBackoffSec(2), 1800);
  assert.equal(aiBackoffSec(20), 6 * 3600);
});

test("no seed on an empty server, even with leftover player events", async () => {
  const files = catalogFiles();
  files["outbox/seq.json"] = JSON.stringify({ seq: 1, players_online: 0 });
  files["outbox/events-1-00001.json"] = JSON.stringify({ events: [{ type: "player_online", player: "ghost" }] });
  const t = new MemoryTransport(files);
  const store = new MemoryStore();
  const ai = fakeAsk([seedAnswer()]);
  const decide = makeDecide({ ask: ai.ask, system: "SYSTEM", bibleKey: KEY });
  await tick({ t, store, nowSec: T0, decide });
  assert.equal(ai.calls.length, 0);
});

test("the AI is told which professions players really have (openers only for those)", async () => {
  const files = catalogFiles();
  files["outbox/events-1-00001.json"] = JSON.stringify({ events: [{ type: "player_spawned", player: "ana", profession: "nurse" }] });
  const t = new MemoryTransport(files);
  const store = new MemoryStore();
  const ai = fakeAsk([seedAnswer()]);
  const decide = makeDecide({ ask: ai.ask, system: "SYSTEM", bibleKey: KEY });
  await tick({ t, store, nowSec: T0, decide });
  assert.deepEqual(ai.calls[0].state.professions_present, ["nurse"]);
});

test("the daily budget in dollars stops the AI, failed calls included", async () => {
  const files = catalogFiles();
  const t = new MemoryTransport(files);
  const store = new MemoryStore();
  await store.logCall({ model: "m", purpose: "seed#1", cost_usd: 0.6, ok: false }, T0 - 100);
  await store.logCall({ model: "m", purpose: "seed#2", cost_usd: 0.5, ok: false }, T0 - 50);
  const ai = fakeAsk([seedAnswer()]);
  const decide = makeDecide({ ask: ai.ask, system: "SYSTEM", bibleKey: KEY, maxUsdPerDay: 1 });
  const r = await tick({ t, store, nowSec: T0, decide });
  assert.equal(ai.calls.length, 0);
  assert.ok(r.notes.some((n) => /daily AI budget reached \(\$1\.10 of \$1\)/.test(n)), JSON.stringify(r.notes));
});

test("two writers: the story model designs the bible, the stage model fills node one", async () => {
  const t = new MemoryTransport(catalogFiles());
  const store = new MemoryStore();
  const storyAi = fakeAsk([{ bible: BIBLE }]);
  const stageAi = fakeAsk([{ ...seedAnswer(), bible: undefined }]);
  const decide = makeDecide({ ask: stageAi.ask, askStory: storyAi.ask, system: "S", bibleKey: KEY });
  const r = await tick({ t, store, nowSec: T0, decide });
  assert.equal(storyAi.calls.length, 1);
  assert.equal(storyAi.calls[0].task, "bible");
  assert.equal(stageAi.calls.length, 1);
  assert.equal(stageAi.calls[0].task, "stage");
  assert.equal(stageAi.calls[0].bible.title, "The Last Transmission", "the stage writer works from the bible");
  assert.equal(stageAi.calls[0].stage.id, "n1", "and is told which node it fills");
  assert.equal(stageAi.calls[0].state.node, "n1");
  assert.ok(await store.getBible());
  assert.ok(r.pushed > 0);
});

test("a stage that does not hold together is not kept: no bible sealed, nothing pushed, back off", async () => {
  const t = new MemoryTransport(catalogFiles());
  const store = new MemoryStore();
  const decide = makeDecide({ ask: fakeAsk([{ directives: [] }]).ask, askStory: fakeAsk([{ bible: BIBLE }]).ask, system: "S", bibleKey: KEY });
  const r = await tick({ t, store, nowSec: T0, decide });
  assert.equal(await store.getBible(), null);
  assert.equal(r.pushed, 0);
  assert.ok(r.notes.some((n) => /seed rejected: missing/.test(n)), JSON.stringify(r.notes));
  assert.ok((await store.getState()).ai_fail_until > T0);
});

test("rule 2: every piece is a physical item; supplies are bounded and loot-gated", () => {
  const ok = checkBible(BIBLE, 4, new Set(["ZTales.PhotoYellow", "ZTales.NoteYellow", "ZTales.KeyYellow", "ZTales.CassetteYellow", "Base.CannedBeans"]));
  assert.deepEqual(ok, []);
  const textOnly = { ...BIBLE, axis: [{ ...BIBLE.axis[0], pieces: [{ story_id: "n1_photo", item: "ZTales.PhotoYellow" }, { story_id: "n1_note" }] }, BIBLE.axis[1]] };
  assert.match(checkBible(textOnly, 4).join(";"), /piece n1_note has no item/);
  const katana = { ...BIBLE, axis: [{ ...BIBLE.axis[0], pieces: [{ story_id: "n1_photo", item: "ZTales.PhotoYellow" }, { story_id: "n1_note", item: "Base.Katana" }] }, BIBLE.axis[1]] };
  assert.match(checkBible(katana, 4, new Set(["ZTales.PhotoYellow"])).join(";"), /Base.Katana is not a clue item nor an allowed reward/);
  const supplies = { ...BIBLE, axis: [{ ...BIBLE.axis[0], supplies: [{ item: "Base.CannedBeans", count: 4 }, { item: "Base.Hammer" }, { item: "Base.Axe" }, { item: "Base.Bandage" }] }, BIBLE.axis[1]] };
  assert.match(checkBible(supplies, 4).join(";"), /4 supplies, at most 3/);
  const tooMany = { ...BIBLE, axis: [{ ...BIBLE.axis[0], supplies: [{ item: "Base.CannedBeans", count: 40 }] }, BIBLE.axis[1]] };
  assert.match(checkBible(tooMany, 4).join(";"), /count must be 1-8/);
});

// the final stage's answer from the AI, pieces placed in the offered police storage and church
// (never two pieces of one node in one building without different rooms: sharedSpots)
const finalStageAnswer = (overrides = {}) => ({
  directives: [
    { id: "n2_k", type: "place_item", story_id: "n2_key", item: "ZTales.KeyYellow", target: { building: "b_11800_9700" } },
    ...stageReactions("n2", ["n2_key"]),
  ],
  hints: { n2: { full: { text: "The police storage." }, echo: { text: "seven" } } },
  proximity: PROX, finale: FINALE(), ...overrides,
});

async function toFinalStage(answers, extraFiles = {}) {
  const { t, store } = await seedSetup([seedAnswer()]);
  const ai = fakeAsk(answers);
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  for (const [k, v] of Object.entries(extraFiles)) t.files.set(k, v);
  const r = await tick({ t, store, nowSec: T0 + 600, decide });
  const sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  return { t, store, ai, r, sent };
}

test("the finale: the bridge builds the urn, the charge, the reveal and the script around the AI's texts", async () => {
  const { ai, r, sent, store } = await toFinalStage([finalStageAnswer()]);
  assert.equal(ai.calls.length, 1, JSON.stringify(r.rejected));
  assert.ok(ai.calls[0].stage.urn && ai.calls[0].stage.urn.id, "the AI is told where the urn is");
  // the urn rises with the reveal, inside each last-piece reaction (Teko: never before)
  const urn = sent.flatMap((d) => [d, ...(d.then || [])]).find((d) => d.type === "spawn_urn");
  assert.ok(urn, "an urn");
  assert.ok(!sent.some((d) => d.type === "spawn_urn"), "no urn before the last chapter's piece is found");
  assert.deepEqual(urn.requires_groups, [["n1_photo"], ["n2_key"]], "one piece per chapter");
  assert.ok(!/^b_1065|^b_10600|^b_10700/.test(urn.target.building), `outside the spawn town: ${urn.target.building}`);
  const charge = sent.find((d) => d.id === "s1_fin_charge");
  const { RELIC_MOODS } = await import("../src/finale.js");
  for (const sid of ["n1_photo", "n2_key"]) {
    assert.equal(charge.pieces[sid].length, 1);
    assert.ok(RELIC_MOODS.includes(charge.pieces[sid][0].stat), `${sid} draws one of the moods`);
  }
  assert.equal(charge.pieces.n1_photo[0].level, 1, "the first chapter weighs least");
  assert.equal(charge.pieces.n2_key[0].level, 3, "the last chapter weighs most");
  assert.ok(charge.aura && charge.aura.x > 0, "the aura on the urn");
  const reveal = sent.find((d) => d.id === "s1_fin_reveal_n2_key");
  assert.equal(reveal.then[0].type, "spawn_urn", "the urn rises with the reveal");
  assert.equal(reveal.then[1].deliver, "now");
  assert.equal(reveal.then[1].kind, "nightmare");
  assert.equal(reveal.then[2].text, "$reveal", "the chat only points to the diary");
  assert.ok(!sent.some((d) => /fin_where_/.test(d.id)), "nobody is told the place in chat");
  const filled = sent.find((d) => d.id === "s1_fin_filled");
  assert.equal(filled.when.event, "urn_filled");
  // the bridge's finale reactions outlive any node change (live run 2026-10-22: fin_filled expired)
  for (const d of sent.filter((x) => x.type === "reaction" && /^s1_fin_/.test(x.id))) {
    assert.equal(d.stage, undefined, `${d.id} is stage-less`);
    assert.equal(d.keep, true, `${d.id} is kept`);
  }
  const seq = filled.then[0];
  assert.equal(seq.type, "sequence");
  const last = seq.steps[seq.steps.length - 1].then;
  const open = last.find((d) => d.type === "open_urn");
  assert.equal(open.consume, "all");
  assert.equal(open.reward[0].item, "ZTales.Tale1", "the first story's volume");
  assert.match(open.reward[0].title.en, /^Mystery Tale of Knox I - /);
  assert.equal(open.reward[0].charge.length, 1, "the Tale weighs too");
  assert.equal(open.reward[0].charge[0].level, 1, "the first Tale the least");
  const end = last.find((d) => d.type === "season_complete");
  assert.equal(end.epilogue, "It is quiet now.", "the diary's last page is the AI's epilogue, never the bible's private ending");
  assert.ok(end, "the season ends in the last step");
  assert.equal(end.server_line, undefined, "the mod picks one of its own ending lines");
  const waves = seq.steps.flatMap((s) => s.then).filter((d) => d.type === "spawn_wave");
  assert.equal(waves.length, 2, "one wave per node");
  assert.equal(seq.steps.flatMap((s) => s.then).filter((d) => d.type === "open_urn" && d.consume === 1).length, 2, "one piece taken per wave");
  const strikes = seq.steps.flatMap((s) => s.then).filter((d) => d.type === "lightning");
  assert.equal(strikes.length, 0, "a foggy finale has no lightning");
  const { finaleSequence } = await import("../src/finale.js");
  const stormy = finaleSequence({ bible: {}, fin: { ...FINALE(), weather: "storm" }, urnCenter: [10, 20], urnBuilding: "b_1_2",
    nodes: [{ node: "n1", ids: ["a"] }, { node: "n2", ids: ["b"] }], reward: [], epilogue: { en: "x" }, serverLine: null });
  assert.deepEqual(stormy.steps.flatMap((st) => st.then).filter((d) => d.type === "lightning").map((d) => d.count), [1, 2],
    "a storm strikes in every wave, twice in the last");
  assert.ok(sent.some((d) => d.id === "s1_fin_lost_n1" && d.then[0].story_id === "n1_photo"), "a lost-piece copy per node");
  const s = await store.getState();
  assert.deepEqual(s.urn_history, [urn.target.building]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
});

test("the finale: the AI's own end and script are refused; a vague place is sent back once", async () => {
  const endsItself = finalStageAnswer();
  endsItself.directives.push({ id: "ai_end", type: "reaction", stage: "n2", when: { event: "item_picked", story_id: "n2_key" },
    then: [{ id: "ai_end.1", type: "season_complete", epilogue: "x" }] });
  endsItself.directives.push({ id: "ai_wave", type: "spawn_wave", target: { x: 1, y: 1 } });
  const { ai, r } = await toFinalStage([endsItself, finalStageAnswer()]);
  assert.ok(ai.calls[1].rejections.some((x) => x.id === "ai_end" && /the bridge writes the finale/.test(x.reason)), JSON.stringify(ai.calls[1].rejections));
  assert.ok(ai.calls[1].rejections.some((x) => x.id === "ai_wave"));
  assert.equal(r.pushed > 0, true);
});

test("the finale: the place must be named when the urn's building has a name; the Tale and the lines in every language", async () => {
  const { ai, r, sent } = await toFinalStage(
    [finalStageAnswer({ finale: { ...FINALE("somewhere"), tale: { en: "x" } } }), finalStageAnswer({ finale: FINALE("Knox Bank") })],
    { "outbox/seq.json": JSON.stringify({ seq: 2, players_online: 1, languages: ["en", "pt-br"] }),
      "catalog/cell-39_32.json": JSON.stringify({ rows: [
        [11800, 9700, 14, 12, 1, "u", "", "Knox Bank", ["policestorage"], 0.4],
        [11850, 9800, 8, 8, 1, "ru", "", "", ["church"], 0.1],
      ] }) });
  const rej = ai.calls[1].rejections.map((x) => x.reason).join(";");
  assert.match(rej, /finale.where must name the place: "Knox Bank"/);
  assert.match(rej, /finale.tale lacks pt-br/);
  assert.match(rej, /finale.lines.hush lacks .*pt-br/);
  void r; void sent;
});

test("the next story: once the in-game day turned after the end, a new one is written with the past in its context", async () => {
  const { t, store, sent: first } = await toFinalStage([finalStageAnswer()]);
  assert.ok(first.flatMap((d) => [d, ...(d.then || [])]).some((d) => d.story_id === "s1_fin_urn"));
  // the urn opened and the season ended, with players around
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1 }));
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [{ type: "season_completed", finisher: "ana", game_time: { day: 10, hour: 21 } }, { type: "player_online", player: "ana", game_time: { day: 10, hour: 21 } }] }));
  const second = { bible: { ...BIBLE, title: "The Quiet Line", axis: [
      { id: "n1", question: "Who?", pieces: [{ story_id: "q1_a", item: "ZTales.PhotoYellow" }] },
      { id: "n2", question: "Where?", pieces: [{ story_id: "q2_a", item: "ZTales.KeyYellow" }], ending: true } ] },
    directives: [
      { id: "q_photo", type: "place_item", story_id: "q1_a", item: "ZTales.PhotoYellow", target: { building: "b_10700_9700" } },
      // a real AI gets "id already sent" for ids of the past story and re-ids; the fixture does it up front
      ...stageReactions("n1", ["q1_a"]).map((d) => ({ ...d, id: `q_${d.id}`, then: d.then.map((x) => ({ ...x, id: `q_${x.id}` })) })) ],
    hints: { n1: { full: { text: "The pharmacy again, but look lower." }, echo: { text: "nine" } } }, proximity: PROX, motifs_used: [] };
  const reused = { ...second, bible: { ...second.bible, title: "The Last Transmission", axis: [
    { id: "n1", question: "Who?", pieces: [{ story_id: "n1_photo", item: "ZTales.PhotoYellow" }] }, second.bible.axis[1] ] } };
  const ai = fakeAsk([reused, second]);
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  const day = 86400;
  const ev = (seq, d, h) => t.files.set(`outbox/events-${seq}-00001.json`, JSON.stringify({ events: [{ type: "counters", game_time: { day: d, hour: h } }] }));
  let r = await tick({ t, store, nowSec: T0 + 1000, decide });
  assert.equal(ai.calls.length, 0, "the game day the story ended: quiet");
  assert.equal((await store.getState()).story_closed_game_day, 10);
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 4, players_online: 1 }));
  ev(4, 10, 23);
  r = await tick({ t, store, nowSec: T0 + 1000 + 2 * day, decide });
  assert.equal(ai.calls.length, 0, "two real days later, still the same game day: still quiet");
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 5, players_online: 1 }));
  ev(5, 11, 0);
  r = await tick({ t, store, nowSec: T0 + 1000 + 2 * day + 600, decide });
  assert.equal(ai.calls.length, 2, "the game day turned: the next story is written (one round sent back)");
  assert.equal(ai.calls[0].task, "seed");
  assert.equal(ai.calls[0].state.story_number, 2);
  assert.equal(ai.calls[0].state.previous_stories[0].title, "The Last Transmission");
  assert.ok(ai.calls[0].state.used_story_ids.includes("n1_photo"));
  const rej = ai.calls[1].rejections.map((x) => x.reason).join(";");
  assert.match(rej, /piece id n1_photo belongs to a past story/);
  assert.match(rej, /a past story had this title/);
  const sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  const opened = sent.find((d) => d.type === "season_open");
  assert.equal(opened.season, "s2");
  assert.ok(sent.some((d) => d.id === "s2_opening_ana" && d.deliver === "now" && /pharmacy again/.test(d.text)), "the diary of a known player gets the new first hint on the spot");
  assert.ok(sent.some((d) => d.id === "s2_prox_n1_near"), "this story's ids carry its season");
  const s = await store.getState();
  assert.equal(s.story_closed, false);
  assert.equal(s.stories_done.length, 1);
  assert.deepEqual(s.placed.map((p) => p.story_id).sort(), ["q1_a"], "the register starts clean");
  assert.equal(JSON.parse(t.files.get("inbox/hints.json")).node, "n1");
  void r;
});

test("the pause between stories counts in-game days: the end's day excluded, NEXT_STORY_GAME_DAYS turns, a story closed before keeps waiting", async () => {
  const { nextStoryWait, latestGameDay } = await import("../src/story.js");
  const at = (day, hour = 0) => ({ type: "counters", game_time: { day, hour } });
  assert.equal(latestGameDay([{ type: "x" }, at(4, 23), at(3)]), 4);
  assert.equal(latestGameDay([{ type: "x" }]), null, "no game_time, no day");
  const closed = { story_closed: true, story_closed_game_day: 7, game_day_last: 7 };
  assert.equal(nextStoryWait(closed, [at(7, 23)]).over, false, "same game day");
  assert.equal(nextStoryWait(closed, []).over, false, "nothing seen");
  assert.equal(nextStoryWait(closed, [at(8, 0)]).over, true, "the next dawn of the calendar: midnight turned");
  assert.equal(nextStoryWait(closed, [at(8, 6)], 2).over, false, "two days asked");
  assert.equal(nextStoryWait({ ...closed, game_day_last: 8 }, [at(9, 1)], 2).over, true);
  assert.equal(nextStoryWait({ ...closed, game_day_last: 9 }, [], 2).over, true, "the latest day seen is kept between ticks");
  assert.equal(nextStoryWait(closed, [at(9)], "x").over, true, "a broken var falls back to one day");
  // a story an older bridge closed (no game day): it starts counting from the first day seen
  const legacy = nextStoryWait({ story_closed: true }, [at(20, 5)]);
  assert.deepEqual(legacy, { closedDay: 20, lastDay: 20, over: false });
  assert.equal(nextStoryWait({ story_closed: true, story_closed_game_day: 20, game_day_last: 20 }, [at(21)]).over, true);
});

test("each piece draws its mood by its id: repeatable, varied, heavier toward the end", async () => {
  const { pieceCharge, RELIC_MOODS } = await import("../src/finale.js");
  assert.deepEqual(pieceCharge("a", 0, 4, "s1"), pieceCharge("a", 0, 4, "s1"), "the same piece always draws the same");
  const moods = new Set(Array.from({ length: 40 }, (_, i) => pieceCharge(`p${i}`, 0, 4, "s1")[0].stat));
  assert.ok(moods.size >= 3 && [...moods].every((m) => RELIC_MOODS.includes(m)), [...moods].join(","));
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => pieceCharge("x", i, 5)[0].level), [1, 1.5, 2, 2.5, 3], "a step up every chapter");
});

test("the Final Tale: five Tales boxed bring a great urn on a landmark, the call in the diary, the colossal end armed", async () => {
  const { t, store } = await toFinalStage([finalStageAnswer()]);
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1 }));
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [{ type: "tales_boxed", player: "ana", item_id: 77 }] }));
  const crow = (ft, tags = [], dmg = 0, round) => [ft, ft, "x", 1, tags, dmg, 0.002, ...(round ? [round] : [])];
  t.files.set("catalog/items-WepFire.json", JSON.stringify({ rows: [crow("Base.Shotgun", ["base:firearm"], 2.2, "Base.ShotgunShells")] }));
  t.files.set("catalog/items-WepAmmo.json", JSON.stringify({ rows: [crow("Base.ShotgunShellsBox")] }));
  t.files.set("catalog/items-WepMBladeL.json", JSON.stringify({ rows: [crow("Base.Katana", [], 8)] }));
  t.files.set("catalog/items-FoodN.json", JSON.stringify({ rows: ["A", "B", "C", "D", "E", "F", "G"].map((x) => crow(`Base.Can${x}`)) }));
  t.files.set("catalog/items-MedM.json", JSON.stringify({ rows: [crow("Base.Pills"), crow("Base.Antibiotics")] }));
  t.files.set("catalog/items-MedT.json", JSON.stringify({ rows: [crow("Base.Bandage"), crow("Base.Splint")] }));
  t.files.set("catalog/items-ClothBack.json", JSON.stringify({ rows: [crow("Base.Bag_ALICEpack")] }));
  t.files.set("catalog/items-ToolC.json", JSON.stringify({ rows: [crow("Base.Hammer"), crow("Base.Saw"), crow("Base.Wrench"), crow("Base.Axe")] }));
  const ai = fakeAsk([]);
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  const r = await tick({ t, store, nowSec: T0 + 500, decide });
  assert.equal(ai.calls.length, 0, "no AI call");
  const sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  const urn = sent.find((d) => d.id === "final_urn");
  assert.ok(urn, JSON.stringify(r.notes));
  assert.equal(urn.slot, "final");
  assert.equal(urn.item, "ZTales.UrnGreat");
  assert.deepEqual(urn.requires_groups, [["final_box"]]);
  const s = await store.getState();
  assert.ok(!s.urn_history.slice(0, -1).includes(urn.target.building), "never a building an urn already used");
  const call = sent.find((d) => d.id === "final_call@ana");
  assert.equal(call.deliver, "now");
  const filled = sent.find((d) => d.id === "final_filled");
  const steps = filled.then[0].steps;
  assert.equal(steps.flatMap((x) => x.then).filter((d) => d.type === "spawn_wave").length, 5, "one wave per story");
  const open = steps[steps.length - 1].then.find((d) => d.type === "open_urn");
  assert.equal(open.slot, "final");
  assert.ok(open.reward.length >= 14, `a colossal reward (${open.reward.length})`);
  assert.ok(open.reward.some((x) => x.item === "ZTales.Ashes"), "the Ashes among it");
  // twice boxed: once only
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 4, players_online: 1 }));
  t.files.set("outbox/events-4-00001.json", JSON.stringify({ events: [{ type: "tales_boxed", player: "bia", item_id: 78 }] }));
  await tick({ t, store, nowSec: T0 + 600, decide });
  const again = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  assert.ok(!again.some((d) => d.id === "final_call@bia"), "the Final Tale happens once");
});

test("the scripts stay inside the mod's limits: at most 12 steps, waves a wave apart, a scream in each", async () => {
  const { finaleSequence } = await import("../src/finale.js");
  const { finalTaleDirectives } = await import("../src/finaltale.js");
  const nodes = [1, 2, 3, 4].map((i) => ({ node: `n${i}`, ids: [`p${i}`] }));
  const seq = finaleSequence({ bible: {}, fin: { ...FINALE(), weather: "storm" }, urnCenter: [1, 2], urnBuilding: "b_1_2", nodes, reward: [], epilogue: { en: "x" }, serverLine: null });
  assert.ok(seq.steps.length <= 12, `${seq.steps.length} steps`);
  const ex = finalTaleDirectives({ place: { id: "b_5_5", x: 9, y: 9, name: "The Club" }, packer: "ana" }).find((d) => d.id === "final_filled").then[0];
  assert.ok(ex.steps.length <= 12, `${ex.steps.length} steps`);
  const waves = ex.steps.filter((st) => st.then.some((d) => d.type === "spawn_wave"));
  assert.equal(waves.length, 5);
  assert.ok(waves.every((st) => st.then.some((d) => d.type === "play_sound")), "a scream in every wave");
  assert.ok(waves.every((st) => st.then.find((d) => d.type === "spawn_wave").at_urn), "the ring is around the urn itself");
  const opening = ex.steps[0].then.filter((d) => d.type === "play_sound");
  const humans = ["MetaScream", "VoiceFemaleWhisperPsst", "VoiceMaleWhisperHey", "VoiceFemaleDeathAlone", "VoiceMaleDeathEaten"];
  assert.ok(opening.length >= 5 && opening.some((d) => d.sound === "RumbleThunder") && !opening.some((d) => d.sound === "VehicleSirenWall")
    && opening.some((d) => humans.includes(d.sound)), "the urn's opening (docs/12): a rumble, a human voice, the pools' fill, no siren");
  assert.ok(opening.every((d) => !d.delay || d.delay <= 18), "the opening fits before the first wave");
  // the story's script: its gaps do not sound alike, the same urn always sounds the same
  const story = (seed) => finaleSequence({ bible: { season: "s1" }, fin: { ...FINALE(), weather: "storm" }, urnCenter: [1, 2], urnBuilding: "b_1_2",
    nodes, reward: [], epilogue: { en: "x" }, serverLine: null, seed });
  const mids = (sq) => sq.steps.filter((st) => st.then.some((d) => /\.m2$/.test(d.id))).map((st) => st.then.filter((d) => d.type === "play_sound").map((d) => d.sound).join());
  assert.deepEqual(story("a|1|b_1_2"), story("a|1|b_1_2"), "seeded: stable across builds");
  assert.notDeepEqual(story("a|1|b_1_2").steps[0], story("z|2|b_9_9").steps[0], "two urns open differently");
  assert.ok(seq.steps.at(-1).then.at(-1).type === "season_complete", "the last step still ends the season");
  assert.ok(mids(seq).length === 3);
});

test("the Final Tale's place: a church or a cemetery at random, the nearest, never one used", async () => {
  const { chooseFinalTalePlace, finalTaleDirectives } = await import("../src/finaltale.js");
  const places = [{ id: "b_10600_9600", rooms: ["church"], region: "Muldraugh" }, { id: "b_10700_9700", rooms: ["kitchen"], region: "Muldraugh" }];
  const church = chooseFinalTalePlace({ places, points: [[10650, 9650]], rand: () => 0.9 });
  assert.equal(church.kind, "church");
  assert.equal(church.id, "b_10600_9600");
  const cem = chooseFinalTalePlace({ places, points: [[10650, 9650]], rand: () => 0.1 });
  assert.equal(cem.kind, "cemetery");
  assert.ok(cem.cell.length === 2 && cem.region === "Muldraugh");
  const other = chooseFinalTalePlace({ places, points: [[10650, 9650]], history: ["b_10600_9600"], rand: () => 0.9 });
  assert.equal(other.kind, "cemetery", "no church left: a cemetery");
  const urn = finalTaleDirectives({ place: cem, packer: "ana" }).find((d) => d.id === "final_urn");
  assert.equal(urn.target.near_sprite, "location_community_cemetary_01");
  assert.deepEqual([urn.target.cell_x, urn.target.cell_y], cem.cell);
  const call = finalTaleDirectives({ place: cem, packer: "ana" }).find((d) => d.type === "diary_entry");
  assert.match(call.text["pt-br"], /o cemitério perto de Muldraugh/);
});

test("the Final Tale's reward is drawn from the server's own catalog: loot only, a gun with its box, strong things may repeat", async () => {
  const { finalTaleDirectives } = await import("../src/finaltale.js");
  const { drawReward } = await import("../src/reward.js");
  const drawFinalTaleReward = (rows, rand) => drawReward(rows, { grand: true, rand, focus: "weapons" }).items;
  const row = (ft, tags = [], dmg = 0, p = 0.001, round) => [ft, ft, "x", 1, tags, dmg, p, ...(round ? [round] : [])];
  const rowsBy = {
    guns: [row("Base.Shotgun", ["base:firearm"], 2.2, 0.005, "Base.ShotgunShells"), row("ModX.Blaster", ["base:firearm"], 3, 0.001, "ModX.Cells"),
      row("Base.Rifle_CapGun", ["base:fakeweapon", "base:firearm"], 0, 0.01, "Base.Caps"), row("Base.Prototype", ["base:firearm"], 5, 0)],
    ammo: [row("Base.ShotgunShellsBox"), row("ModX.CellsBox"), row("Base.ShotgunShells")],
    melee: [row("Base.Katana", [], 8), row("Base.Spoon", [], 0.3)],
    food: ["A", "B", "C", "D", "E", "F", "G", "H"].map((x) => row(`Base.Can${x}`)),
    meds: [row("Base.Bandage"), row("Base.FirstAidKit"), row("Base.Pills")],
    bags: [row("Base.Bag_ALICEpack")], tools: [row("Base.Hammer"), row("Base.Saw"), row("Base.Wrench")],
  };
  let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const r = drawFinalTaleReward(rowsBy, rand);
  const items = r.map((x) => x.item);
  assert.ok(!items.includes("Base.Rifle_CapGun") && !items.includes("Base.Prototype") && !items.includes("Base.FirstAidKit"),
    "no toy, nothing the world never drops, no kit");
  for (const g of ["Base.Shotgun", "ModX.Blaster"]) {
    if (items.includes(g)) assert.ok(items.includes(g === "Base.Shotgun" ? "Base.ShotgunShellsBox" : "ModX.CellsBox"), `${g} comes with its box (mods too)`);
  }
  assert.ok(items.includes("Base.Bag_ALICEpack"), "a backpack");
  assert.notEqual(items.join(), drawFinalTaleReward(rowsBy, rand).map((x) => x.item).join(), "two draws differ");
  const open = finalTaleDirectives({ place: { id: "b_1_1", x: 5, y: 5, name: "X" }, packer: "ana", rowsBy, rand })
    .find((d) => d.id === "final_filled").then[0].steps.at(-1).then.find((d) => d.type === "open_urn").reward;
  assert.ok(open.some((x) => x.item === "ZTales.Ashes"), "the Ashes always");
  assert.ok(!open.some((x) => x.item === "Base.Nails"), "no loose nail");
  const lastStep = finalTaleDirectives({ place: { id: "b_1_1", x: 5, y: 5, name: "X" }, packer: "ana", rowsBy, rand })
    .find((d) => d.id === "final_filled").then[0].steps.at(-1).then;
  assert.ok(lastStep.some((d) => d.type === "chat" && /^\$urn_focus_(weapons|food|medicine|survival)$/.test(d.text)), "the focus is said when it opens");
});

test("an urn's reward has a focus: plenty of it, a touch of clothing, nothing broken or tiny; the Final Tale's is the larger", async () => {
  const { drawReward, FOCI } = await import("../src/reward.js");
  const row = (ft, w = 1, dmg = 0, tags = [], round) => [ft, ft, "x", w, tags, dmg, 0.01, ...(round ? [round] : [])];
  const rowsBy = {
    guns: [row("Base.Pistol", 1, 2, ["base:firearm"], "Base.Bullets9mm")], ammo: [row("Base.Bullets9mmBox")],
    melee: [row("Base.Katana", 2, 8), row("Base.Katana_Broken", 2, 8), row("Base.Axe", 3, 3)],
    food: [row("Base.JellyBeans", 0.1), ...["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"].map((x) => row(`Base.Can${x}`, 0.6))],
    meds: ["A", "B", "C", "D", "E", "F", "G", "H", "I"].map((x) => row(`Base.Med${x}`, 0.1)),
    tools: ["A", "B", "C", "D", "E", "F"].map((x) => row(`Base.Tool${x}`, 1.5)), survival: ["A", "B", "C", "D", "E", "F"].map((x) => row(`Base.Sur${x}`, 0.5)),
    bags: [row("Base.Bag_ALICEpack")], clothes: [row("Base.Jacket", 1), row("Base.Hat", 0.4), row("Base.Sock", 0.1)],
  };
  let seed = 11; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sum = (r, re) => r.items.filter((x) => re.test(x.item)).reduce((a, x) => a + x.count, 0);
  for (const focus of FOCI) {
    const r = drawReward(rowsBy, { focus, rand });
    assert.equal(r.focus, focus);
    const names = r.items.map((x) => x.item);
    const core = r.items.filter((x) => !r.collateral.includes(x.item)).map((x) => x.item);
    assert.ok(!core.some((n) => /Broken|JellyBeans|Sock/.test(n)), `${focus}: the core holds nothing broken, no jelly bean, no sock`);
    assert.ok(r.collateral.length >= 1 && r.collateral.length * 5 <= names.length, `${focus}: some collateral, a fifth at most`);
    const clothes = core.filter((n) => /Jacket|Hat/.test(n)).length;
    assert.ok(clothes >= 1 && clothes <= 2, `${focus}: one or two pieces of clothing`);
    if (names.includes("Base.Pistol")) assert.ok(names.includes("Base.Bullets9mmBox"), "a gun comes with its box");
  }
  assert.ok(sum(drawReward(rowsBy, { focus: "food", rand }), /Can/) > sum(drawReward(rowsBy, { focus: "medicine", rand }), /Can/), "the focus comes in plenty");
  assert.ok(sum(drawReward(rowsBy, { focus: "food", grand: true, rand }), /Can/) > sum(drawReward(rowsBy, { focus: "food", rand }), /Can/), "the Final Tale gives more");
  assert.ok(FOCI.includes(drawReward(rowsBy, { focus: "nonsense", rand }).focus), "an unknown focus is drawn");
});

test("collaboration in a chapter places extra pieces in the next, and the story's urn holds a bonus for them", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  // three players share chapter one: pieces, notes, the chapter page, the rings
  const ev = [];
  for (const p of ["ana", "bob", "cid"]) {
    ev.push({ type: "item_picked", story_id: p === "ana" ? "n1_photo" : "n1_note", player: p });
    ev.push({ type: "note_read", story_id: "n1_note", player: p });
    ev.push({ type: "journal_entry", kind: "chapter", chapter: "n1", player: p });
    ev.push({ type: "zone_entered", story_id: "s1_prox_n1_mid", player: p });
  }
  // the finder's page is in: chapter two is written at once (it waits for that page otherwise)
  ev.push({ type: "journal", id: "j_p1", kind: "chapter", chapter: "n1", player: "ana", text: "The photo and the note say the same hour." });
  ev.push({ type: "node_changed", from: "n1", to: "n2" });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 3 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: ev }));
  // free buildings beside the final node, and food in the catalog for the bonus
  t.files.set("catalog/cell-39_32.json", JSON.stringify({ rows: [
    [11800, 9700, 14, 12, 1, "u", "", "", ["policestorage"], 0.4],
    [11850, 9800, 8, 8, 1, "ru", "", "", ["church"], 0.1],
    [11900, 9700, 8, 8, 1, "r", "", "", ["kitchen"], 0.1],
    [11900, 9800, 8, 8, 1, "r", "", "", ["bedroom"], 0.1],
    [11800, 9850, 8, 8, 1, "r", "", "", ["office"], 0.1],
  ] }));
  t.files.set("catalog/items-FoodN.json", JSON.stringify({ rows: [["Base.Beans", "Beans", "Food", 0.5, [], 0, 1], ["Base.Soup", "Soup", "Food", 0.6, [], 0, 1]] }));
  const both = (x) => ({ en: x, "pt-br": x });
  const answer = finalStageAnswer({ finale: { where: both("The church, the urn."), lines: { hush: both("Hush."), scream: both("A scream."),
    last_wave: both("Last."), silence: both("Silence.") }, epilogue: both("Quiet."), tale: both("A tale."), reward_focus: "food" },
  proximity: { far: both("far"), mid: both("mid"), near: both("near") } });
  for (const d of answer.directives) for (const x of [d, ...(d.then || [])]) if (typeof x.text === "string") x.text = both(x.text);
  const ai = fakeAsk([answer]);
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  const r = await tick({ t, store, nowSec: T0 + 600, decide });
  assert.equal(ai.calls.length, 1, JSON.stringify(r.rejected));
  const sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  const extras = sent.filter((d) => /_extra\d$/.test(d.id || ""));
  assert.deepEqual(extras.map((d) => d.story_id), ["s1_n2_extra1", "s1_n2_extra2", "s1_n2_extra3"], r.notes.join(" | "));
  for (const x of extras) {
    assert.ok(["ZTales.KeyYellow", "ZTales.CassetteYellow"].includes(x.item), "the chapter's own families, yellow");
    assert.ok(x.title.en, "titled in every language (both: collab.test.js)");
    assert.ok(x.target.building !== "b_11800_9700", "never with the piece of the node");
  }
  assert.equal(new Set(extras.map((x) => x.target.building)).size, 3, "one building each");
  assert.match(r.notes.join(" "), /collaboration in n1: \d+ .* -> 3 extra/);
  const urn = sent.flatMap((d) => [d, ...(d.then || [])]).find((d) => d.type === "spawn_urn");
  assert.ok(!JSON.stringify(urn.requires_groups).includes("_extra"), "the urn never requires an extra piece");
  const seq = sent.find((d) => d.id === "s1_fin_filled").then[0];
  const open = seq.steps[seq.steps.length - 1].then.find((d) => d.type === "open_urn");
  // three extras (one piece per chapter: no spare pieces any more), at most six
  assert.equal(open.bonus.length, 3);
  assert.ok(open.bonus.every((l) => l.every((x) => /Beans|Soup/.test(x.item))), "the same focus");
  let s = await store.getState();
  assert.deepEqual(s.extras_by_node, { n2: 3 });
  assert.equal(s.extras_total, 3);
  // an extra carried to the urn counts again for the season (the Final Tale)
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1 }));
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [{ type: "urn_piece", story_id: "s1_fin_urn", piece: "s1_n2_extra2" },
    { type: "urn_piece", story_id: "s1_fin_urn", piece: "n2_key" }] }));
  await tick({ t, store, nowSec: T0 + 700, decide });
  s = await store.getState();
  assert.equal(s.extras_deposited, 1);
  assert.equal(s.extras_total, 3, "kept across ticks");
});

test("nobody did anything in a chapter: no extra piece", async () => {
  const { r, sent } = await toFinalStage([finalStageAnswer()]);
  assert.ok(!sent.some((d) => /_extra\d$/.test(d.id || "")));
  assert.match(r.notes.join(" "), /collaboration in n1: 0 \(nothing\) -> 0 extra/);
});

test("a stage that puts its chapter's piece in the world twice is sent back with the reason (one piece, never a copy)", async () => {
  const { ai } = await toFinalStage([finalStageAnswer({ directives: [
    { id: "n2_k", type: "place_item", story_id: "n2_key", item: "ZTales.KeyYellow", target: { building: "b_11800_9700" } },
    { id: "n2_k2", type: "place_item", story_id: "n2_key", item: "ZTales.KeyYellow", target: { building: "b_11850_9800" } },
    ...stageReactions("n2", ["n2_key"]) ] }), finalStageAnswer()]);
  assert.equal(ai.calls.length, 2);
  assert.match(JSON.stringify(ai.calls[1].rejections), /n2_k2.*piece n2_key is already in the world: a chapter has one piece/);
});

test("a stage reaction waiting to read a piece that cannot be read is sent waiting for its pickup (live run 2026-10-22)", async () => {
  const answer = finalStageAnswer();
  const r0 = answer.directives.find((d) => d.id === "n2_r0");
  r0.when.event = "note_read";   // n2_key is a key: never read
  const { ai, r, sent } = await toFinalStage([answer]);
  assert.equal(ai.calls.length, 1, JSON.stringify(r.rejected));
  const out = sent.find((d) => d.id === "n2_r0");
  assert.ok(out, "the reaction is sent");
  assert.equal(out.when.event, "item_picked");
  assert.match(r.notes.join(" "), /n2_r0: waits for item_picked/);
});

// docs/13: picking the piece up closes the chapter, even a readable one (reading is never required)
test("a chapter's way on waiting to read its note waits for its pickup; reading stays only as an extra", async () => {
  const answer = seedAnswer();
  const pick = answer.directives.find((d) => d.id === "n1_r0");
  pick.when.event = "note_read";   // n1_photo is a photo: readable, yet the way on waits for the pickup
  answer.directives.push({ id: "n1_read", type: "reaction", stage: "n1", when: { event: "note_read", story_id: "n1_photo" },
    then: [{ id: "n1_read.1", type: "chat", scope: "player", player: "$player", text: "The back is written on." }] });
  const { ai, r, t } = await seedSetup([answer]);
  assert.equal(ai.calls.length, 1, JSON.stringify(r.rejected));
  const sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  assert.equal(sent.find((d) => d.id === "n1_r0").when.event, "item_picked");
  assert.equal(sent.find((d) => d.id === "n1_read").when.event, "note_read", "a reaction that does not move the story may wait to be read");
  assert.match(r.notes.join(" "), /n1_r0: closes the chapter on item_picked/);
  // a way on that waits for something else only (a ring) is sent back: the pickup must move it
  const ring = seedAnswer();
  const r0 = ring.directives.find((d) => d.id === "n1_r0");
  r0.then = r0.then.filter((x) => x.type !== "set_node");
  ring.directives.push({ id: "n1_zone", type: "reaction", stage: "n1", when: { event: "zone_entered", story_id: "s1_prox_n1_near" },
    then: [{ id: "n1_zone.1", type: "set_node", node: "n2" }] });
  const again = await seedSetup([ring, seedAnswer()]);
  assert.equal(again.ai.calls.length, 2);
  assert.match(JSON.stringify(again.ai.calls[1].rejections), /the move on \(set_node to n2\) in the reaction to picking up n1_photo/);
});

// live run 2026-10-22: the last chapter's reaction sent set_node "urn"
test("a set_node outside the axis is set to the next chapter, dropped on the last; a node outside the axis never costs a call", async () => {
  const answer = seedAnswer();
  answer.directives.find((d) => d.id === "n1_r0").then.find((x) => x.type === "set_node").node = "urn";
  const { ai, r, t, store } = await seedSetup([answer]);
  assert.equal(ai.calls.length, 1, JSON.stringify(r.rejected));
  let sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  assert.equal(sent.find((d) => d.id === "n1_r0").then.find((x) => x.type === "set_node").node, "n2");
  assert.match(r.notes.join(" "), /set_node urn is not a chapter of the story: set to n2/);
  // on the last chapter: dropped (the urn ends the story)
  const fin = finalStageAnswer();
  fin.directives.find((d) => d.id === "n2_r0").then.push({ id: "n2_r0.9", type: "set_node", node: "urn" });
  const f = await toFinalStage([fin]);
  assert.equal(f.ai.calls.length, 1, JSON.stringify(f.r.rejected));
  const r0 = f.sent.find((d) => d.id === "n2_r0");
  assert.ok(!r0.then.some((x) => x.type === "set_node"), "no node after the last chapter");
  assert.match(f.r.notes.join(" "), /n2_r0.9: set_node urn dropped/);
  // a node_changed to a node the bible does not have: no stage call
  const quiet = fakeAsk([finalStageAnswer()]);
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "urn" }] }));
  await tick({ t, store, nowSec: T0 + 600, decide: makeDecide({ ask: quiet.ask, system: "S", bibleKey: KEY }) });
  assert.deepEqual(quiet.calls.map((c) => c.stage?.id), [], "no call for a node outside the axis (and nothing written ahead)");
  sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  void sent;
});

// docs/13 item 2: the chapter's end reaches everyone, with no AI call
test("a chapter's end: the finder's page, a record for those who took part, an echo for the rest, the mark for all", async () => {
  const both = (x) => ({ en: x, "pt-br": x });
  const answer = seedAnswer({ chapter_end: { record: both("I was there when it was found."), echo: both("They say it was found.") } });
  const { t, store } = await seedSetup([answer]);
  assert.deepEqual((await store.getState()).chapter_end_texts.n1.record, both("I was there when it was found."), "kept with the stage");
  const quiet = fakeAsk([finalStageAnswer()]);
  const decide = makeDecide({ ask: quiet.ask, system: "S", bibleKey: KEY });
  // dan was seen earlier in the story, doing nothing in this chapter
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 3, languages: ["en", "pt-br"] }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "player_spawned", player: "dan" }] }));
  await tick({ t, store, nowSec: T0 + 60 });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 3, languages: ["en", "pt-br"] }));
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [
    { type: "zone_entered", story_id: "s1_prox_n1_near", player: "bob" },
    { type: "item_picked", story_id: "n1_photo", player: "ana" },
    { type: "reaction_fired", id: "n1_r0", stage: "n1", by_event: "item_picked", player: "ana" },
    { type: "node_changed", from: "n1", to: "n2" },
  ] }));
  const r = await tick({ t, store, nowSec: T0 + 120, decide });
  const sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  const ends = sent.filter((d) => /^s1_end_n1_/.test(d.id));
  assert.deepEqual(ends.map((d) => [d.id, d.player, d.kind]), [
    ["s1_end_n1_rec_bob", "bob", "chapter_record"],
    ["s1_end_n1_echo_dan", "dan", "chapter_echo"],
    ["s1_end_n1_mark", "$all", "chapter_end"],
  ], "ana found it: her page comes with the closing reaction, nothing here");
  assert.equal(ends[0].text.en, "I was there when it was found.");
  assert.equal(ends[1].text.en, "They say it was found.");
  assert.ok(ends[2].text.en && ends[2].text["pt-br"], "the mark in every language");
  assert.match(r.notes.join(" "), /chapter n1 ended \(finder ana\)/);
  // once per chapter: the same node_changed again writes nothing more
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 4, players_online: 3 }));
  t.files.set("outbox/events-4-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  const r2 = await tick({ t, store, nowSec: T0 + 180, decide });
  assert.ok(!r2.notes.some((n) => /chapter n1 ended/.test(n)));
});

test("a paid answer that failed is kept (sealed) and counted; the retry waits the back-off and says what failed", async () => {
  const { BrainError } = await import("../src/brain.js");
  const t = new MemoryTransport(catalogFiles());
  const store = new MemoryStore();
  const RAW = '{"bible": {"title": "The Last "Transmission"", ... 16756 tokens of it';
  const storyAi = fakeAsk([new BrainError("answer is not valid JSON: Expected ',' or '}' (finish end_turn, 16756 tokens out, $0.2)", null, 0.2, RAW),
    { bible: BIBLE }]);
  const stageAi = fakeAsk([{ ...seedAnswer(), bible: undefined }]);
  const decide = makeDecide({ ask: stageAi.ask, askStory: storyAi.ask, system: "S", bibleKey: KEY });
  const r = await tick({ t, store, nowSec: T0, decide });
  assert.equal(storyAi.calls.length, 1, "never asked again in the same tick");
  const failed = store.callLog[0];
  assert.equal(failed.ok, false);
  assert.equal(failed.cost_usd, 0.2);
  assert.match(failed.note, /not valid JSON/);
  assert.ok(!failed.raw.includes("Transmission"), "the text holds the story: sealed like the bible");
  assert.equal(await open(KEY, failed.raw), RAW);
  assert.equal(r.debug?.[0]?.raw, RAW, "the local debug record has the raw text too");
  assert.equal((await store.getState()).ai_last_failure.task, "bible");
  assert.equal(await store.costSince(T0 - 10), 0.2, "the failed call is in the daily budget");

  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  await tick({ t, store, nowSec: T0 + 120, decide });
  assert.equal(storyAi.calls.length, 1, "the back-off holds");
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1 }));
  await tick({ t, store, nowSec: T0 + 901, decide });
  assert.equal(storyAi.calls.length, 2);
  const note = storyAi.calls[1].rejections.find((x) => x.id === "previous_answer");
  assert.ok(note && /not valid JSON/.test(note.reason) && /more compactly/.test(note.reason), JSON.stringify(storyAi.calls[1].rejections));
  assert.equal((await store.getState()).ai_last_failure, null, "answered: the note is spent");
  assert.ok(await store.getBible());
  assert.equal(store.callLog.length, 3);
  assert.ok(Math.abs((await store.costSince(T0 - 10)) - 0.22) < 1e-9, "both bible calls and the stage, counted honestly");
});

test("a repaired answer is noted in the calls table and the tick's notes", async () => {
  const t = new MemoryTransport(catalogFiles());
  const store = new MemoryStore();
  const storyAsk = async () => ({ doc: { bible: structuredClone(BIBLE) }, model: "fake", cost: 0.05, raw: "{bible...", repaired: true,
    note: "invalid JSON, repaired (finish stop, 9000 tokens out, $0.05)" });
  const stageAi = fakeAsk([{ ...seedAnswer(), bible: undefined }]);
  const decide = makeDecide({ ask: stageAi.ask, askStory: storyAsk, system: "S", bibleKey: KEY });
  const r = await tick({ t, store, nowSec: T0, decide });
  assert.match(store.callLog[0].note, /repaired/);
  assert.equal(await open(KEY, store.callLog[0].raw), "{bible...");
  assert.ok(r.notes.some((n) => /bible#1: invalid JSON, repaired/.test(n)), JSON.stringify(r.notes));
});

test("the model chosen per task in the sandbox reaches each call: story for the bible, stage, dream", async () => {
  const MODELS = { story: "claude-opus-5-5", stage: "claude-haiku-5-5", dream: "claude-sonnet-5-5" };
  const files = catalogFiles();
  files["outbox/seq.json"] = JSON.stringify({ seq: 1, players_online: 1, models: { ...MODELS, extra: "x" } });
  const t = new MemoryTransport(files);
  const store = new MemoryStore();
  const seen = [];
  const capture = (ai) => async (system, context, opts) => { seen.push({ task: JSON.parse(context).task, ...opts }); return ai(system, context); };
  const storyAi = fakeAsk([{ bible: BIBLE }]);
  const stageAi = fakeAsk([{ ...seedAnswer(), bible: undefined }, echoAnswer()]);
  const decide = makeDecide({ ask: capture(stageAi.ask), askStory: capture(storyAi.ask), system: "S", bibleKey: KEY });
  await tick({ t, store, nowSec: T0, decide });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1, models: { ...MODELS, stage: "gpt-9" } }));
  t.files.set("outbox/events-1-00009.json", JSON.stringify({ events: [
    { type: "player_journey", player: "ana", char: "Ana Silva", life: 1, named_places: ["Muldraugh pharmacy"], died: true },
    { type: "player_died", player: "ana", life: 1, carrying: [] },
  ] }));
  await tick({ t, store, nowSec: T0 + 120, decide });
  assert.deepEqual(seen.map((s) => [s.task, s.role]), [["bible", "story"], ["stage", "stage"], ["echo", "dream"]]);
  assert.deepEqual(seen[0].models, MODELS, "only the three roles are kept");
  assert.equal(seen[2].models.stage, null, "a model outside the whitelist is dropped");
  assert.equal(seen[2].models.dream, "claude-sonnet-5-5");
});

// ---------------------------------------------------------------- docs/13 items 4, 5 and 7

const sentAll = (t) => [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
// an ask that answers by task: the tests below do not depend on the order of the calls
function askByTask(byTask) {
  const calls = [];
  const ask = async (system, context, opts) => {
    const c = JSON.parse(context);
    calls.push({ ...c, role: opts?.role });
    const key = c.task === "stage" ? `stage:${c.stage?.id}` : c.task;
    const a = byTask[key];
    if (a instanceof Error) throw a;
    if (!a) throw new Error(`no answer for ${key}`);
    return { doc: structuredClone(typeof a === "function" ? a(c) : a), model: "fake", cost: 0.01 };
  };
  return { ask, calls };
}
const MORE_PLACES = JSON.stringify({ rows: [
  [11800, 9700, 14, 12, 1, "u", "", "", ["policestorage"], 0.4],
  [11850, 9800, 8, 8, 1, "ru", "", "", ["church"], 0.1],
  [11900, 9700, 8, 8, 1, "r", "", "", ["kitchen"], 0.1],
  [11900, 9800, 8, 8, 1, "r", "", "", ["bedroom"], 0.1],
  [11800, 9850, 8, 8, 1, "r", "", "", ["office"], 0.1],
] });

test("the finder's page first: nothing is written ahead; a closed chapter's next stage waits for its finder's page, then is written with it", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  const ai = askByTask({ "stage:n2": finalStageAnswer() });
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1, page_window_sec: 450 }));
  await tick({ t, store, nowSec: T0 + 60, decide });
  assert.equal(ai.calls.length, 0, "chapter two is not written ahead");
  let s = await store.getState();
  assert.equal(s.ahead ?? null, null);
  assert.equal(s.page_window_sec, 450, "the mod's page window, in real seconds");
  // ana picks chapter one's piece: the chapter closes, her page is granted; chapter two waits for it
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1, page_window_sec: 450 }));
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [{ type: "item_picked", story_id: "n1_photo", player: "ana" },
    { type: "node_changed", from: "n1", to: "n2" }] }));
  const r = await tick({ t, store, nowSec: T0 + 180, decide });
  assert.equal(ai.calls.length, 0, "the stage waits for the page it will judge");
  assert.match(r.notes.join(" "), /stage n2 waits for the finder's page of n1/);
  s = await store.getState();
  assert.equal(s.stage_wanted, "n2");
  assert.deepEqual(s.chapter_finders, { "s1:n1": "ana" });
  await tick({ t, store, nowSec: T0 + 600, decide });
  assert.equal(ai.calls.length, 0, "still waiting, within the window");
  // the page arrives: chapter two is written at once, the page in its context to be scored
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 4, players_online: 1, page_window_sec: 450 }));
  t.files.set("outbox/journal-4-00001.json", JSON.stringify({ entries: [{ id: "j_page", player: "ana", kind: "chapter", chapter: "n1",
    text: "The number is a time. Seven. Whoever counts is counting down to something." }] }));
  await tick({ t, store, nowSec: T0 + 660, decide });
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].stage.id, "n2");
  assert.deepEqual(ai.calls[0].state.pages_to_score, [{ motif: "j_page", player: "ana", chapter: "n1" }]);
  assert.ok(sentAll(t).some((d) => d.id === "n2_k"), "sent at once, never kept");
  s = await store.getState();
  assert.equal(s.stage_written, "n2");
  assert.equal(s.stage_wanted ?? null, null);
  assert.equal(s.ahead ?? null, null);
});

test("a faded page (its window ran out unwritten) ends the wait: the next stage is written without a page to judge", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  const ai = askByTask({ "stage:n2": finalStageAnswer() });
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1, page_window_sec: 450 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "item_picked", story_id: "n1_photo", player: "ana" },
    { type: "node_changed", from: "n1", to: "n2" }] }));
  await tick({ t, store, nowSec: T0 + 60, decide });
  assert.equal(ai.calls.length, 0);
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1, page_window_sec: 450 }));
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [{ type: "page_faded", chapter: "n1", life: 1, player: "ana" }] }));
  await tick({ t, store, nowSec: T0 + 520, decide });
  assert.equal(ai.calls.length, 1, "the fade ends the wait");
  assert.equal(ai.calls[0].stage.id, "n2");
  assert.equal(ai.calls[0].state.pages_to_score, undefined, "a faded page is a page not written: nothing to score");
  const s = await store.getState();
  assert.deepEqual(s.pages_faded, ["s1:n1"]);
  assert.equal(s.extras_decided.n1.by, "collab", "nothing scored from it: the tally decides");
  assert.equal(s.stage_written, "n2");
});

test("a chapter closed with no known finder granted no page: its next stage is written at once", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  const ai = askByTask({ "stage:n2": finalStageAnswer() });
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  await tick({ t, store, nowSec: T0 + 60, decide });
  assert.equal(ai.calls.length, 1);
  assert.equal((await store.getState()).stage_written, "n2");
});

test("the page-wait has a limit: the page's window plus 30 real minutes, else two hours when the mod does not say its window", async () => {
  const { pageWaitSec, PAGE_WAIT_GRACE_SEC, PAGE_WAIT_DEFAULT_SEC } = await import("../src/story.js");
  assert.equal(PAGE_WAIT_GRACE_SEC, 1800);
  assert.equal(pageWaitSec(450), 2250);
  assert.equal(pageWaitSec(null), PAGE_WAIT_DEFAULT_SEC);
  assert.equal(pageWaitSec(-5), PAGE_WAIT_DEFAULT_SEC);
  for (const win of [450, null]) {
    const { t, store } = await seedSetup([seedAnswer()]);
    const ai = askByTask({ "stage:n2": finalStageAnswer() });
    const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
    const seq = (n) => t.files.set("outbox/seq.json", JSON.stringify({ seq: n, players_online: 1, ...(win ? { page_window_sec: win } : {}) }));
    seq(2);
    t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "item_picked", story_id: "n1_photo", player: "ana" },
      { type: "node_changed", from: "n1", to: "n2" }] }));
    await tick({ t, store, nowSec: T0 + 60, decide });
    const limit = pageWaitSec(win);
    await tick({ t, store, nowSec: T0 + 60 + limit - 1, decide });
    assert.equal(ai.calls.length, 0, `still waiting just before ${limit} s`);
    await tick({ t, store, nowSec: T0 + 60 + limit, decide });
    assert.equal(ai.calls.length, 1, `written without the page after ${limit} s`);
    assert.equal(ai.calls[0].stage.id, "n2");
    assert.equal(ai.calls[0].state.pages_to_score, undefined);
  }
});

// a story of three chapters: the page of chapter two is scored in the call that writes chapter three
const BIBLE3 = { ...BIBLE, axis: [
  { id: "n1", question: "What is 88.6?", pieces: [{ story_id: "n1_photo", item: "ZTales.PhotoYellow" }] },
  { id: "n2", question: "Who kept the key?", pieces: [{ story_id: "n2_key", item: "ZTales.KeyYellow" }] },
  { id: "n3", question: "Where does it end?", pieces: [{ story_id: "n3_tape", item: "ZTales.CassetteYellow" }], ending: true },
], finale: { ...BIBLE.finale, charges: { n3_tape: [{ stat: "panic", level: 3 }] } } };
const stage2of3 = () => ({ directives: [
  { id: "n2_k", type: "place_item", story_id: "n2_key", item: "ZTales.KeyYellow", target: { building: "b_10800_9650" } },
  ...stageReactions("n2", ["n2_key"])], proximity: PROX, hints: { n2: { full: { text: "The station." }, echo: { text: "seven" } } } });
const stage3of3 = (extra = {}) => ({ directives: [
  { id: "n3_t", type: "place_item", story_id: "n3_tape", item: "ZTales.CassetteYellow", target: { building: "b_11800_9700" } },
  ...stageReactions("n3", ["n3_tape"])], proximity: PROX, finale: FINALE(), ...extra });

// chapter one closes with no known finder (chapter two is written at once); then ana picks
// chapter two's piece: chapter three waits for her page
async function threeChapters(byTask) {
  NEXT.n2 = "n3";
  const files = catalogFiles();
  files["catalog/cell-39_32.json"] = MORE_PLACES;
  const t = new MemoryTransport(files);
  const store = new MemoryStore();
  const ai = askByTask({ seed: seedAnswer({ bible: BIBLE3 }), "stage:n2": stage2of3(), ...byTask });
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  await tick({ t, store, nowSec: T0, decide });                  // seed: n1
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 2 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  await tick({ t, store, nowSec: T0 + 60, decide });             // n2 written now
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 2 }));
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [
    { type: "zone_entered", story_id: "s1_prox_n2_near", player: "bob" },
    { type: "item_picked", story_id: "n2_key", player: "ana" }, { type: "node_changed", from: "n2", to: "n3" }] }));
  await tick({ t, store, nowSec: T0 + 120, decide });            // n3 waits for ana's page
  return { t, store, ai, decide };
}

test("the finder's page is scored in the stage call it waited for: a 3 opens an extra chapter grown from it", async () => {
  const extra = { contribution: { player: "ana", score: 3, why: "she linked the number to the hour" },
    extra_chapter: { question: "Why did the woman count only at seven?", way_back: "n3",
      piece: { item: "ZTales.NoteRed", title: "A page torn from a log", text: "Seven. Seven. Seven.", target: { building: "b_11900_9700" } } } };
  try {
    const { t, store, ai, decide } = await threeChapters({ "stage:n3": stage3of3(extra) });
    assert.deepEqual(ai.calls.map((c) => c.task === "stage" ? c.stage.id : c.task), ["seed", "n2"]);
    // chapter two closed, its finder has not written yet: chapter three waits for the page
    await tick({ t, store, nowSec: T0 + 180, decide });
    assert.equal(ai.calls.length, 2, "the call waits for the page it will score");
    t.files.set("outbox/seq.json", JSON.stringify({ seq: 4, players_online: 2 }));
    t.files.set("outbox/journal-4-00001.json", JSON.stringify({ entries: [{ id: "j_page", player: "ana", kind: "chapter", chapter: "n2",
      text: "The number is a time. Seven. Whoever counts is counting down to something in the church." }] }));
    const r = await tick({ t, store, nowSec: T0 + 240, decide });
    const call = ai.calls[2];
    assert.equal(call.stage.id, "n3");
    assert.deepEqual(call.state.pages_to_score, [{ motif: "j_page", player: "ana", chapter: "n2" }]);
    assert.equal(call.state.extra_chapter_score, 3);
    assert.ok(call.motifs.some((m) => m.id === "j_page"), "the page reaches it as a motif");
    const sent = sentAll(t);
    const piece = sent.find((d) => d.id === "s1_n3_extra1");
    assert.ok(piece, r.notes.join(" | "));
    assert.equal(piece.item, "ZTales.NoteYellow", "a clue item of the AI's family, always yellow");
    assert.equal(piece.title, "A page torn from a log");
    assert.equal(piece.text, "Seven. Seven. Seven.");
    assert.equal(piece.target.building, "b_11900_9700");
    assert.equal(piece.mod_data.extra_chapter, "n2");
    const q = sent.find((d) => d.id === "s1_xch_n2_ana");
    assert.equal(q.player, "ana");
    assert.equal(q.kind, "extra_chapter");
    assert.ok(sent.some((d) => d.id === "n3_t"), "chapter three goes out with it, never kept");
    assert.match(r.notes.join(" "), /page of n2 by ana: 3 .* -> an extra chapter/);
    const s = await store.getState();
    assert.equal(s.ahead ?? null, null);
    assert.equal(s.stage_written, "n3");
    assert.deepEqual(s.extras_decided.n2, { by: "ai", player: "ana", score: 3, count: 1, host: "n3" });
    assert.deepEqual(s.extras_by_node, { n3: 1 }, "by the chapter it was written with");
    assert.equal(s.extras_total, 1, "the season's tally (the Final Tale) counts it");
    assert.equal(s.extra_chapters[0].way_back, "n3");
    assert.deepEqual(s.pages, [], "scored: off the list");
    assert.ok(sent.some((d) => d.id === "s1_fin_filled"), "the final stage carries the urn");
  } finally { delete NEXT.n2; }
});

test("a shallow page opens nothing, whatever the mechanical tally says; no score at all falls back to the tally", async () => {
  const page = { id: "j_page", player: "ana", kind: "chapter", chapter: "n2", text: "Found a key." };
  try {
    for (const [answer, expect] of [[{ contribution: { player: "ana", score: 1, why: "only what she saw" } }, 0], [{}, "collab"]]) {
      const { t, store, ai, decide } = await threeChapters({ "stage:n3": stage3of3(answer) });
      t.files.set("outbox/seq.json", JSON.stringify({ seq: 4, players_online: 2 }));
      t.files.set("outbox/journal-4-00001.json", JSON.stringify({ entries: [page] }));
      const r = await tick({ t, store, nowSec: T0 + 240, decide });
      assert.equal(ai.calls.length, 3);
      const s = await store.getState();
      if (expect === 0) {
        assert.ok(!sentAll(t).some((d) => /_extra\d$/.test(d.id || "")), "no extra piece");
        assert.deepEqual(s.extras_decided.n2, { by: "ai", player: "ana", score: 1, count: 0, host: "n3" });
        assert.match(r.notes.join(" "), /page of n2 by ana: 1 .* -> no extra/);
      } else {
        assert.equal(s.extras_decided.n2.by, "collab", "the page reached the AI without a score: the tally decides");
        assert.match(r.notes.join(" "), /collaboration in n2: \d+/);
      }
    }
  } finally { delete NEXT.n2; }
});

test("watching: a player's block of 12 real hours played is read once, for that player only; blocks closing together go in one call", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  const both = (x) => ({ en: x, "pt-br": x });
  const ai = askByTask({ "stage:n2": finalStageAnswer(), watch: { directives: [
    { id: "w1", type: "diary_entry", player: "ana", kind: "hint", deliver: "now", text: both("Not this hospital. Another one, further from the river.") },
    { id: "w2", type: "diary_entry", player: "dee", text: both("Nobody asked for me.") },
  ] } });
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  const seq = (n, active) => t.files.set("outbox/seq.json", JSON.stringify({ seq: n, players_online: 2, active,
    watch_block_hours: 12, models: { stage: "claude-haiku-5-5" } }));
  seq(2, { ana: 1000, bob: 50, cid: 0 });
  await tick({ t, store, nowSec: T0 + 60, decide });            // blocks open; nothing written ahead
  assert.equal(ai.calls.length, 0);
  const ts = new Date((T0 + 3000) * 1000).toISOString();
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [
    { type: "player_journey", player: "ana", ts, named_places: ["Muldraugh Hospital"], regions: ["Muldraugh"], zombies_killed: 9 },
    { type: "player_journey", player: "bob", ts, named_places: ["Gas station"] },
  ] }));
  // cid stood idle: his count never moved
  seq(3, { ana: 1000 + 11 * 3600, bob: 50 + 11 * 3600, cid: 0 });
  await tick({ t, store, nowSec: T0 + 40000, decide });
  assert.equal(ai.calls.length, 0, "eleven hours: nothing yet");
  seq(4, { ana: 1000 + 12 * 3600, bob: 50 + 12 * 3600 + 5, cid: 0 });
  const r = await tick({ t, store, nowSec: T0 + 50000, decide });
  assert.equal(ai.calls.length, 1, "one call for both blocks");
  const c = ai.calls[0];
  assert.equal(c.task, "watch");
  assert.equal(c.role, "watch");
  assert.deepEqual(c.watch_for.map((w) => w.player).sort(), ["ana", "bob"]);
  assert.deepEqual(c.watch_for.find((w) => w.player === "ana").places, ["Muldraugh Hospital"]);
  assert.equal(c.bible.chapter.id, "n1");
  assert.equal(c.bible.ending, undefined, "never the ending");
  assert.equal(c.bible.axis, undefined, "never the whole axis");
  assert.deepEqual(c.stall, { step: 0, cycle: 0, played_days: 1 });
  const sent = sentAll(t).filter((d) => /_watch_/.test(d.id));
  assert.deepEqual(sent.map((d) => [d.id, d.player, d.kind, d.deliver]), [[`s1_watch_ana_${T0 + 50000}`, "ana", "watch_hint", undefined]]);
  assert.match(JSON.stringify(r.rejected), /no block of dee/);
  assert.match(r.notes.join(" "), /nothing for bob/);
  assert.deepEqual((await store.getState()).watch_due, [], "each block is looked at once");
  await tick({ t, store, nowSec: T0 + 50060, decide });
  assert.equal(ai.calls.length, 1);
});

test("watching respects the daily caps", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  const ai = askByTask({ "stage:n2": finalStageAnswer(), watch: { directives: [] } });
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY, maxCallsPerDay: 1 });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1, active: { ana: 0 } }));
  await tick({ t, store, nowSec: T0 + 60, decide });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1, active: { ana: 12 * 3600 } }));
  const r = await tick({ t, store, nowSec: T0 + 120, decide });
  assert.equal(ai.calls.length, 0, "the seed already spent the day");
  assert.ok(r.notes.includes("daily AI call cap reached"));
  assert.equal((await store.getState()).watch_due.length, 1, "the block waits");
});

test("a stage that fails after the page arrived is retried as any failed call, once the back-off is over", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  const { BrainError } = await import("../src/brain.js");
  let down = true;
  const ai = askByTask({ "stage:n2": () => { if (down) throw new BrainError("openrouter answered 503"); return finalStageAnswer(); } });
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "item_picked", story_id: "n1_photo", player: "ana" },
    { type: "node_changed", from: "n1", to: "n2" }] }));
  t.files.set("outbox/journal-2-00001.json", JSON.stringify({ entries: [{ id: "j_page", player: "ana", kind: "chapter", chapter: "n1", text: "Seven." }] }));
  await tick({ t, store, nowSec: T0 + 60, decide });
  let s = await store.getState();
  assert.equal(ai.calls.length, 1, "the page came with the close: no wait");
  assert.equal(s.stage_wanted, "n2", "kept for the retry");
  assert.ok(s.ai_fail_until > T0 + 60, "backs off like any failed call");
  down = false;
  await tick({ t, store, nowSec: T0 + 60 + 3600, decide });
  s = await store.getState();
  assert.equal(ai.calls.length, 2);
  assert.equal(s.stage_written, "n2");
  assert.ok(sentAll(t).some((d) => d.id === "n2_k"));
});

// a death in the pharmacy carrying chapter one's piece, the node moving in the same batch
async function deathWithPiece(t, store, decide, nowSec, { rises = true, node = true } = {}) {
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 5, players_online: 1 }));
  t.files.set("outbox/events-5-00001.json", JSON.stringify({ events: [
    { type: "player_journey", player: "ana", char: "Ana Silva", life: 1, died: true },
    { type: "player_died", player: "ana", life: 1, carrying: ["n1_photo"], rises, x: 10705, y: 9705, z: 0 },
    ...(node ? [{ type: "node_changed", from: "n1", to: "n2" }] : []),
  ] }));
  return tick({ t, store, nowSec, decide });
}

test("a pending dream runs first: before the stage the node just asked for, and the stage follows next tick", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  const ai = askByTask({ echo: echoAnswer(), "stage:n2": finalStageAnswer() });
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  const r = await deathWithPiece(t, store, decide, T0 + 60);
  assert.equal(ai.calls[0].task, "echo", "the dream is not queued behind the stage");
  // the story waits on the body: the dream knows where it lies, by function, and that it rises
  assert.deepEqual(ai.calls[0].bodies.ana, { pieces: 1, place: { kind: "a pharmacy", inside: true, town: "Muldraugh", name: null }, rises: true });
  assert.match(r.notes.join(" "), /carrier ana \(life 1\) died with n1_photo: the story waits on the body \(it will rise\)/);
  const line = sentAll(t).find((d) => d.kind === "carrier_body");
  assert.equal(line.player, "ana");
  assert.equal(line.life, 2, "for the new life, never the dead one's diary");
  assert.match(line.text.en, /inside a pharmacy in Muldraugh/);
  assert.match(line.text.en, /put it down myself/);
  assert.ok(!/\d/.test(line.text.en), "no coordinates");
  assert.ok(sentAll(t).some((d) => d.type === "diary_echo"));
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 6, players_online: 1 }));
  await tick({ t, store, nowSec: T0 + 120, decide });
  assert.equal(ai.calls[1].task, "stage");
  assert.equal(ai.calls[1].stage.id, "n2");
});

test("a pending dream runs during a stage's back-off, and neither one's result touches the other's", async () => {
  const { t, store } = await seedSetup([seedAnswer()]);
  const { BrainError } = await import("../src/brain.js");
  await store.setState({ ai_fail_until: T0 + 3600, ai_failures: 2 });
  let echoDown = true;
  const ai = askByTask({ echo: () => { if (echoDown) throw new BrainError("openrouter answered 503"); return echoAnswer(); } });
  const decide = makeDecide({ ask: ai.ask, system: "S", bibleKey: KEY });
  await deathWithPiece(t, store, decide, T0 + 60, { node: false });
  let s = await store.getState();
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].task, "echo");
  assert.equal(s.echo_fail_until, T0 + 60 + 900, "a failed dream backs off dreams");
  assert.equal(s.ai_failures, 2, "the stage's count is untouched");
  assert.equal(s.ai_fail_until, T0 + 3600);
  echoDown = false;
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 7, players_online: 1 }));
  await tick({ t, store, nowSec: T0 + 120, decide });
  assert.equal(ai.calls.length, 1, "still the dream's own back-off");
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 8, players_online: 1 }));
  await tick({ t, store, nowSec: T0 + 60 + 901, decide });
  assert.equal(ai.calls.length, 2);
  s = await store.getState();
  assert.deepEqual(s.echo_due, []);
  assert.equal(s.ai_fail_until, T0 + 3600, "a dream that worked never lifts the stage's back-off");
  assert.ok(sentAll(t).some((d) => d.type === "diary_echo"));
});

test("only the chapter's piece is a ZTales item: a ZTales clue note becomes a plain sheet, other ZTales clues go back; a closing's diary line goes to everyone", async () => {
  const answer = finalStageAnswer();
  answer.directives.push(
    { id: "n2_feed", type: "write_note", story_id: "n2_feedbook", item: "ZTales.NoteYellow", target: { building: "b_11800_9700" },
      title: "Feed book", text: "Oats at 4:10." },
    { id: "n2_photo2", type: "place_item", story_id: "n2_photo2", item: "ZTales.PhotoYellow", target: { building: "b_11850_9800" } },
    { id: "n2_closing", type: "reaction", stage: "n2", when: { event: "node_changed", from: "n2" },
      then: [{ id: "n2_closing.1", type: "diary_entry", player: "$player", text: "The locker room still smells of chlorine." }] },
  );
  const { r, sent } = await toFinalStage([answer, answer]);
  const feed = sent.find((d) => d.id === "n2_feed");
  assert.equal(feed.item, "Base.SheetPaper2", "an ordinary sheet of paper");
  assert.equal(feed.story_id, undefined, "never a story id: it is no piece");
  assert.ok(!sent.some((d) => d.id === "n2_photo2"));
  assert.match(JSON.stringify(r.rejected), /n2_photo2 puts ZTales.PhotoYellow in the world and it is not the chapter's piece/);
  assert.equal(sent.find((d) => d.id === "n2_closing").then[0].player, "$all");
  assert.ok(sent.some((d) => d.id === "n2_k" && d.item === "ZTales.KeyYellow"), "the piece stays ours");
});

test("a piece carried by a story zombie has its rings around that zombie's building (live run 2026-10-22)", async () => {
  const answer = finalStageAnswer();
  answer.directives[0] = { id: "n2_z", type: "spawn_zombie", outfit: "Farmer", target: { building: "b_11800_9700", radius: 2 },
    inventory: [{ item: "ZTales.KeyYellow", story_id: "n2_key", title: "A key" }] };
  const { r, sent } = await toFinalStage([answer]);
  assert.ok(!/proximity rings skipped/.test(r.notes.join(" ")), r.notes.join(" "));
  const far = sent.find((d) => d.id === "s1_prox_n2_far");
  assert.ok(far, "the rings are drawn");
  assert.equal(far.x, 11804 - 120);
});
