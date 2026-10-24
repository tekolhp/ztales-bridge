// A chapter opens in every diary (docs/13, Teko 2026-10-23): the bridge adds one open_chapter to
// every stage it accepts, its intuition from the clue agent (gated like the rings) or plain words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDecide } from "../src/story.js";
import { MemoryStore } from "../src/store.js";
import { MemoryTransport } from "../src/transport.js";
import { tick } from "../src/tick.js";
import { BrainError } from "../src/brain.js";
import { ensureChapterOpen } from "../src/gates.js";
import { CLUES_PROMPT, openGate, plainOpen, PLAIN_ROOMS, roomWords } from "../src/clues.js";
import { BRIDGE_ONLY_TYPES, DIRECTIVE_TYPES, TEXT_FIELDS } from "../src/protocol.js";

const KEY = "test-bible-key-0123456789";
const T0 = 1_800_000_000;
const FIELDS = ["x", "y", "w", "h", "floors", "flags", "region", "name", "rooms", "zombie_density"];
const ROWS = [
  [10600, 9600, 16, 14, 2, "rb", "Riverside", "", ["kitchen", "bedroom", "bathroom", "laundry", "livingroom"], 0.1],
  [10650, 9600, 10, 8, 1, "r", "Riverside", "", ["kitchen", "bedroom", "bathroom"], 0.1],
  [10680, 9640, 10, 8, 1, "r", "Riverside", "", ["kitchen", "bedroom", "livingroom"], 0.1],
  [10700, 9700, 12, 10, 1, "s", "Riverside", "Riverside Laundromat", ["laundromat"], 0.2],
  [10750, 9700, 12, 10, 1, "s", "Riverside", "", ["pharmacy"], 0.2],
];
const HOUSE = "b_10600_9600";
const PHARMACY = "b_10750_9700";

function catalogFiles() {
  return {
    "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1 }),
    "catalog/index.json": JSON.stringify({ version: "v1", cell_size: 300, building_fields: FIELDS, story_max_nodes: 4,
      spawn_regions: [{ name: "Riverside, KY", points: [[10650, 9650]] }], professions: [{ id: "nurse" }], mods: [], outfits: [],
      item_categories: [] }),
    "catalog/cells.json": JSON.stringify({ cells: [{ cell: "35_32", buildings: ROWS.length }] }),
    "catalog/cell-35_32.json": JSON.stringify({ rows: ROWS }),
  };
}

const NEXT = { n1: "n2", n2: "n3" };
const reactions = (node, piece) => [
  { id: `${node}_r0`, type: "reaction", stage: node, when: { event: "item_picked", story_id: piece },
    then: [{ id: `${node}_r0.1`, type: "chat", scope: "player", player: "$player", text: "It is still warm." },
      { id: `${node}_r0.2`, type: "set_node", node: NEXT[node] }] },
  { id: `${node}_close`, type: "reaction", stage: node, when: { event: "node_changed", from: node },
    then: [{ id: `${node}_close.1`, type: "chat", scope: "server", text: "Somewhere a radio goes quiet." }] },
  ...[1, 2, 3, 4].map((s) => ({ id: `${node}_s${s}`, type: "reaction", stage: node, when: { event: "signal", name: "stall", step: s },
    then: [{ id: `${node}_s${s}.1`, type: "chat", scope: "server", text: `Static, ${s}.` }] })),
];
const PROX = { far: "Something about that side of town.", mid: "Bottles and a counter.", near: "The smell of it. It was there." };

const BIBLE = {
  season: "s1", title: "Clean Shirts", premise: "...",
  ending: { text: "The shirts were never collected." },
  forbidden_entities: ["Martha Dell"],
  difficulty: { color: "yellow" },
  axis: [
    { id: "n1", chapter_title: "The Ticket", question: "Whose ticket is it?", pieces: [{ story_id: "n1_ticket", item: "ZTales.NoteYellow" }] },
    { id: "n2", chapter_title: "The Bitter Counter", question: "Who took the pills?", pieces: [{ story_id: "n2_key", item: "ZTales.KeyYellow" }] },
    { id: "n3", question: "Who never came back?", pieces: [{ story_id: "n3_photo", item: "ZTales.PhotoYellow" }], ending: true },
  ],
  finale: { rooms_wanted: ["pharmacy"], urn: { title: "Clay urn" }, charges: {}, weather: "fog", sounds: [], reward: [] },
};

const SEED = {
  bible: BIBLE,
  directives: [
    { id: "s_ticket", type: "place_item", story_id: "n1_ticket", item: "ZTales.NoteYellow", title: "Laundry ticket",
      text: "If shut, I'm home.", target: { building: HOUSE } },
    ...reactions("n1", "n1_ticket"),
  ],
  hints: { n1: { full: { text: "Somebody never picked up their shirts." }, echo: { text: "Clean shirts." } } },
  proximity: PROX, motifs_used: [],
};
const STAGE2 = {
  directives: [
    { id: "s_key", type: "place_item", story_id: "n2_key", item: "ZTales.KeyYellow", title: "Small key", target: { building: PHARMACY } },
    ...reactions("n2", "n2_key"),
  ],
  hints: { n2: { full: { text: "A counter with bitter dust." } } },
  proximity: PROX, motifs_used: [],
};

// a good clue answer for the pharmacy: rings and the opening intuition, all indirect
const CLUE = {
  wide: "A bitterness I could not place, and the feeling of being counted.",
  far: "Something bitter on my tongue that will not wash out.",
  mid: "People came and went all day, a counter, a till that rang.",
  near: "Bitter tablets counted twice, a prescription in a stranger's hand.",
  open: "My hands keep counting things out, a few at a time, onto a counter only I can see.",
  cites: { mid: [{ fact: "kind:shop" }], near: [{ fact: "room:pharmacy" }] },
};

const inbox = (t) => [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).sort()
  .flatMap((k) => JSON.parse(t.files.get(k)).directives);

/** The seed (no clue agent), then chapter two written with `clue` as the clue agent's answer. */
async function stageTwo(clue, limits = {}) {
  const t = new MemoryTransport(catalogFiles());
  const store = new MemoryStore();
  const ask1 = async () => ({ doc: structuredClone(SEED), model: "fake", cost: 0.01 });
  await tick({ t, store, nowSec: T0, decide: makeDecide({ ask: ask1, system: "S", bibleKey: KEY }) });
  const seedSent = inbox(t);
  const clueCalls = [];
  const ask2 = async () => ({ doc: structuredClone(STAGE2), model: "fake", cost: 0.01 });
  const askClues = async (system, context) => {
    clueCalls.push(JSON.parse(context));
    const c = Array.isArray(clue) ? clue[Math.min(clueCalls.length - 1, clue.length - 1)] : clue;
    if (c instanceof Error) throw c;
    return { doc: structuredClone(c), model: "fake-haiku", cost: 0.002 };
  };
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  const r = await tick({ t, store, nowSec: T0 + 600, decide: makeDecide({ ask: ask2, askClues, system: "S", bibleKey: KEY, ...limits }) });
  const all = inbox(t);
  return { seedSent, sent: all.filter((d) => !seedSent.some((x) => x.id === d.id)), all, r, clueCalls, store };
}
const openOf = (list, node) => list.find((d) => d.type === "open_chapter" && d.chapter === node);

test("opening: the mod and the bridge know open_chapter; only the bridge writes it; its intuition is read text", () => {
  assert.ok(DIRECTIVE_TYPES.has("open_chapter"));
  assert.ok(BRIDGE_ONLY_TYPES.has("open_chapter"), "an AI answer carrying one is refused");
  assert.ok(TEXT_FIELDS.includes("intuition"), "the languages gate reads it");
  assert.match(CLUES_PROMPT, /open:/);
  assert.match(CLUES_PROMPT, /\{ wide, far, mid, near, open, cites \}/);
  assert.match(CLUES_PROMPT, /wide: the faintest pull/);
  assert.match(CLUES_PROMPT, /under 3000 characters/);
});

test("opening: the seed opens chapter one after entering it, titled from the bible, with no intuition", async () => {
  const { seedSent } = await stageTwo(CLUE);
  const o = openOf(seedSent, "n1");
  assert.ok(o, "chapter one opens");
  assert.equal(o.id, "s1_chopen_n1");
  assert.equal(o.title, "The Ticket");
  assert.equal(o.intuition, undefined, "the day-zero page carries chapter one's hint");
  const iOpen = seedSent.indexOf(o);
  const iNode = seedSent.findIndex((d) => d.type === "set_node" && d.node === "n1");
  assert.ok(iNode >= 0 && iNode < iOpen, "after the set_node that enters it (the mod numbers it by that)");
});

test("opening: a stage opens its chapter with the clue agent's intuition when it passes the gate", async () => {
  const { sent, clueCalls, r } = await stageTwo(CLUE);
  assert.equal(clueCalls.length, 1, "the same call as the rings, no new one");
  const o = openOf(sent, "n2");
  assert.ok(o, `chapter two opens (${sent.map((d) => d.id).join(", ")})`);
  assert.equal(o.id, "s1_chopen_n2");
  assert.equal(o.title, "The Bitter Counter");
  assert.equal(o.intuition, CLUE.open);
  assert.match(r.notes.join(" "), /the opening intuition written from b_10750_9700/);
});

test("opening: good rings and a bad intuition: the rings are kept and only the opening is asked again", async () => {
  const bad = { ...CLUE, open: "Something about that pharmacy, the bitter tablets on the counter." };
  const { sent, r, clueCalls, store } = await stageTwo([bad, { open: CLUE.open }]);
  assert.equal(clueCalls.length, 2);
  assert.match(clueCalls[1].clues_for.rules, /far, mid and near and wide already passed and are kept; only open will be used/);
  assert.ok(clueCalls[1].rejections.some((x) => /open: names the place \("pharmacy"\)/.test(x.reason)), "told what was wrong");
  assert.equal(openOf(sent, "n2").intuition, CLUE.open);
  assert.equal(sent.find((d) => d.id === "s1_prox_n2_near_r")?.then?.[0]?.text, CLUE.near, "the rings of the first answer stand");
  assert.equal(sent.find((d) => d.id === "s1_prox_n2_wide_r")?.then?.[0]?.text, CLUE.wide);
  assert.match(r.notes.join(" "), /clues#n2.retry1: the opening intuition written from b_10750_9700/);
  assert.ok(store.callLog.some((c) => c.purpose === "clues#n2.retry1" && c.cost_usd === 0.002));
});

test("opening: an intuition refused three times: the opening goes without one, never the plain words", async () => {
  const bad = { ...CLUE, open: "Something about that pharmacy, the bitter tablets on the counter." };
  const { sent, r, clueCalls } = await stageTwo(bad);
  assert.equal(clueCalls.length, 3);
  const o = openOf(sent, "n2");
  assert.ok(o, "the chapter still opens: heading and smudge");
  assert.equal(o.intuition, undefined, "no intuition, not the plain one");
  assert.equal(sent.find((d) => d.id === "s1_prox_n2_near_r")?.then?.[0]?.text, CLUE.near, "the rings stand on their own");
  assert.match(r.notes.join(" "), /clues#n2: the opening goes without an intuition/);
});

test("opening: a failed clue call is asked again; failing every time, no intuition and the story's rings", async () => {
  const { sent, r, clueCalls } = await stageTwo(new BrainError("answer is not valid JSON", 0, 0.003, "{oops"));
  assert.equal(clueCalls.length, 3);
  const o = openOf(sent, "n2");
  assert.ok(o);
  assert.equal(o.intuition, undefined);
  assert.equal(sent.find((d) => d.id === "s1_prox_n2_mid_r")?.then?.[0]?.text, PROX.mid, "the story writer's rings");
  assert.match(r.notes.join(" "), /clues#n2: AI call failed/);
  const again = await stageTwo([new BrainError("answer is not valid JSON", 0, 0.003, "{oops"), CLUE]);
  assert.equal(again.clueCalls.length, 2);
  assert.equal(openOf(again.sent, "n2").intuition, CLUE.open);
});

test("opening: no AI credit (the day's budget spent): the plain intuition", async () => {
  // the seed and the stage cost $0.02: a $0.015 budget leaves nothing for the clue agent
  const { sent, clueCalls, r } = await stageTwo(CLUE, { maxUsdPerDay: 0.015 });
  assert.equal(clueCalls.length, 0);
  const o = openOf(sent, "n2");
  assert.match(o.intuition, /^Before I knew why, it was already with me: /);
  assert.ok(!/It is in there/.test(o.intuition));
  assert.match(r.notes.join(" "), /intuition in plain words \(no AI credit\)/);
});

test("opening: ids are the chapter's own, so a stage written twice adds nothing", async () => {
  const a = await stageTwo(CLUE);
  const b = await stageTwo(new TypeError("boom"));
  assert.equal(openOf(a.sent, "n2").id, openOf(b.sent, "n2").id);
  const list = [];
  const n1 = ensureChapterOpen(list, BIBLE.axis[1], { prefix: "s1_", intuition: "x" });
  const n2 = ensureChapterOpen(list, BIBLE.axis[1], { prefix: "s1_", intuition: "y" });
  assert.equal(list.length, 1);
  assert.equal(n1.length, 1);
  assert.equal(n2.length, 0, "already there: nothing added");
  assert.deepEqual(list[0], { id: "s1_chopen_n2", type: "open_chapter", chapter: "n2", title: "The Bitter Counter", intuition: "x" });
  const first = [];
  ensureChapterOpen(first, BIBLE.axis[0], { prefix: "s1_", intuition: "x", first: true });
  assert.equal(first[0].intuition, undefined, "the first chapter never carries one");
  const plainTitle = [];
  ensureChapterOpen(plainTitle, { id: "n9", title: { en: "Old", "pt-br": "Velho" } }, { prefix: "s2_" });
  assert.deepEqual(plainTitle[0], { id: "s2_chopen_n9", type: "open_chapter", chapter: "n9", title: { en: "Old", "pt-br": "Velho" } });
});

const F = [
  { id: "kind:shop", kind: "kind", words: ["shop", "store"], proper: false, distinctive: false },
  { id: "room:pharmacy", kind: "room", words: roomWords("pharmacy"), proper: false, distinctive: true },
  { id: "region:Riverside", kind: "region", words: ["Riverside"], proper: true, distinctive: false },
];

test("open gate: names refused in any language, a fact shown by activity words required, proper names allowed", () => {
  assert.equal(openGate("Bitter tablets counted on the counter, somewhere in Riverside.", { facts: F }).ok, true);
  const named = openGate("The pharmacy again, in my head.", { facts: F });
  assert.equal(named.ok, false);
  assert.ok(named.errors.includes('open: names the place ("pharmacy") in en'), named.errors.join("; "));
  const shop = openGate({ en: "Pills on a shelf.", "pt-br": "Uma loja de remédios." }, { facts: F, languages: ["en", "pt-br"] });
  assert.ok(shop.errors.some((e) => /names the place \("loja"\) in pt-br/.test(e)), shop.errors.join("; "));
  const vague = openGate("Something calls me back, I do not know where.", { facts: F });
  assert.deepEqual(vague.errors, ["open: shows none of the building's facts"]);
  assert.ok(openGate({ en: "Bitter tablets." }, { facts: F, languages: ["en", "pt-br"] }).errors.includes("open: no text in pt-br"));
  assert.ok(openGate("x".repeat(401) + " tablets", { facts: F }).errors.some((e) => /longer than 400/.test(e)));
});

test("plain intuition: every room's line passes the open gate, both languages; no compass, no 'it is in there'", () => {
  for (const room of PLAIN_ROOMS) {
    const fs = [
      { id: "kind:home", kind: "kind", words: ["house", "home"], proper: false, distinctive: false },
      ...PLAIN_ROOMS.map((r) => ({ id: `room:${r}`, kind: "room", words: roomWords(r), proper: false, distinctive: r === room })),
      { id: "neighbour:Riverside Laundromat", kind: "neighbour", words: ["Riverside Laundromat"], proper: true, distinctive: false },
    ];
    const facts = { building: { id: "b_10600_9600", floors: 1, region: "Riverside" }, facts: fs,
      neighbour: { name: "Riverside Laundromat", x: 10700, y: 9700 } };
    for (const languages of [["en"], ["pt-br"], ["en", "pt-br"]]) {
      const text = plainOpen(facts, { languages, room });
      const g = openGate(text, { facts: fs, languages });
      assert.equal(g.ok, true, `${room} ${languages}: ${g.errors.join("; ")} | ${JSON.stringify(text)}`);
      const all = typeof text === "string" ? [text] : Object.values(text);
      for (const s of all) assert.ok(!/Laundromat|It is in there|Está lá dentro|north|south|east|west|norte|sul|leste|oeste/.test(s), s);
    }
  }
  // no room with a line: the kind of place speaks; nothing at all: no intuition
  const home = plainOpen({ building: { id: "b_1_1" }, facts: [{ id: "kind:home", kind: "kind" }] }, { languages: ["en"] });
  assert.equal(home, "Before I knew why, it was already with me: someone lived there, cooked there, kept their own things in order.");
  assert.equal(plainOpen({ building: { id: "b_1_1" }, facts: [] }), null);
  assert.equal(plainOpen(null), null);
});

test("opening: a chapter opened before openings existed gets its opening once, with no AI (production 2026-10-24)", async () => {
  // the situation by hand: the seed, then chapter two written
  const t2 = new MemoryTransport(catalogFiles());
  const s2 = new MemoryStore();
  const ask1 = async () => ({ doc: structuredClone(SEED), model: "fake", cost: 0.01 });
  await tick({ t: t2, store: s2, nowSec: T0, decide: makeDecide({ ask: ask1, system: "S", bibleKey: KEY }) });
  const ask2 = async () => ({ doc: structuredClone(STAGE2), model: "fake", cost: 0.01 });
  t2.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t2.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  await tick({ t: t2, store: s2, nowSec: T0 + 600, decide: makeDecide({ ask: ask2, system: "S", bibleKey: KEY }) });
  // as a bridge before 0.2.2 left it: chapter 2 open, its opening never sent
  const st = await s2.getState();
  await s2.setState({ openings_sent: (st.openings_sent || []).filter((k) => k !== "s1_n2") });
  const before = inbox(t2).filter((d) => d.type === "open_chapter" && d.chapter === "n2").length;
  const never = async () => { throw new Error("no AI call for an opening"); };
  t2.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1, mod_version: "0.2.2" }));
  const rb = await tick({ t: t2, store: s2, nowSec: T0 + 1200, decide: makeDecide({ ask: never, askClues: never, system: "S", bibleKey: KEY }) });
  assert.ok(rb.notes.some((n) => /s1_chopen_n2: the open chapter's missing opening sent/.test(n)), "sent, with no AI");
  // here the stage had sent it already, so the outbox refuses the copy by id: the mod never gets two
  assert.ok(rb.rejected.some((r) => r.id === "s1_chopen_n2"));
  assert.equal(inbox(t2).filter((d) => d.type === "open_chapter" && d.chapter === "n2").length, before);
  t2.files.set("outbox/seq.json", JSON.stringify({ seq: 4, players_online: 1, mod_version: "0.2.2" }));
  const r2 = await tick({ t: t2, store: s2, nowSec: T0 + 1800, decide: makeDecide({ ask: never, askClues: never, system: "S", bibleKey: KEY }) });
  assert.ok(!r2.notes.some((n) => /missing opening/.test(n)), "never again");
});

test("opening: an open chapter whose opening had no AI intuition gets one from the clue agent, once (Teko, 2026-10-24)", async () => {
  const t2 = new MemoryTransport(catalogFiles());
  const s2 = new MemoryStore();
  const ask1 = async () => ({ doc: structuredClone(SEED), model: "fake", cost: 0.01 });
  await tick({ t: t2, store: s2, nowSec: T0, decide: makeDecide({ ask: ask1, system: "S", bibleKey: KEY }) });
  // chapter two written by a bridge with no clue agent: its opening carries plain words, not the AI's
  const ask2 = async () => ({ doc: structuredClone(STAGE2), model: "fake", cost: 0.01 });
  t2.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t2.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  await tick({ t: t2, store: s2, nowSec: T0 + 600, decide: makeDecide({ ask: ask2, system: "S", bibleKey: KEY }) });
  const calls = [];
  const askClues = async (system, context) => { calls.push(JSON.parse(context)); return { doc: structuredClone(CLUE), model: "fake-haiku", cost: 0.003 }; };
  const never = async () => { throw new Error("no story call"); };
  t2.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1, mod_version: "0.2.2" }));
  const r = await tick({ t: t2, store: s2, nowSec: T0 + 1200, decide: makeDecide({ ask: never, askClues, system: "S", bibleKey: KEY }) });
  assert.equal(calls.length, 1, "one clue call");
  assert.match(calls[0].clues_for.rules, /which way to turn/);
  const line = inbox(t2).find((d) => d.id === "s1_chopen_n2_ai");
  assert.ok(line, r.notes.join(" | "));
  assert.equal(line.type, "diary_entry");
  assert.equal(line.player, "$all");
  assert.equal(line.text, CLUE.open);
  assert.ok(s2.callLog.some((c) => c.purpose === "open#n2" && c.cost_usd === 0.003));
  t2.files.set("outbox/seq.json", JSON.stringify({ seq: 4, players_online: 1, mod_version: "0.2.2" }));
  await tick({ t: t2, store: s2, nowSec: T0 + 1800, decide: makeDecide({ ask: never, askClues, system: "S", bibleKey: KEY }) });
  assert.equal(calls.length, 1, "never asked again");
});

test("opening: a chapter whose opening the AI already wrote is never asked again", async () => {
  const { store } = await stageTwo(CLUE);
  const st = await store.getState();
  assert.ok((st.openings_ai || []).includes("s1_n2"));
});

/** The seed, then chapter two written by a bridge with no clue agent (its opening has no AI intuition). */
async function chapterTwoNoAgent() {
  const t = new MemoryTransport(catalogFiles());
  const store = new MemoryStore();
  const ask1 = async () => ({ doc: structuredClone(SEED), model: "fake", cost: 0.01 });
  await tick({ t, store, nowSec: T0, decide: makeDecide({ ask: ask1, system: "S", bibleKey: KEY }) });
  const ask2 = async () => ({ doc: structuredClone(STAGE2), model: "fake", cost: 0.01 });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  await tick({ t, store, nowSec: T0 + 600, decide: makeDecide({ ask: ask2, system: "S", bibleKey: KEY }) });
  let seq = 3;
  const upgrade = async (answers, limits = {}) => {
    const calls = [];
    const askClues = async (system, context) => {
      calls.push(JSON.parse(context));
      const c = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (c instanceof Error) throw c;
      return { doc: structuredClone(c), model: "fake-haiku", cost: 0.003 };
    };
    const never = async () => { throw new Error("no story call"); };
    t.files.set("outbox/seq.json", JSON.stringify({ seq, players_online: 1, mod_version: "0.2.2" }));
    const r = await tick({ t, store, nowSec: T0 + 600 * seq, decide: makeDecide({ ask: never, askClues, system: "S", bibleKey: KEY, ...limits }) });
    seq++;
    return { r, calls };
  };
  return { t, store, upgrade };
}
const BAD_OPEN = { open: "Something about that pharmacy, the bitter tablets on the counter." };

test("opening upgrade: a refused intuition is asked again with the reason; the good one goes out", async () => {
  const { t, store, upgrade } = await chapterTwoNoAgent();
  const { calls } = await upgrade([BAD_OPEN, { open: CLUE.open }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].rejections, []);
  assert.ok(calls[1].rejections.some((x) => /open: names the place \("pharmacy"\)/.test(x.reason)), JSON.stringify(calls[1].rejections));
  assert.equal(inbox(t).find((d) => d.id === "s1_chopen_n2_ai")?.text, CLUE.open);
  assert.deepEqual(store.callLog.filter((c) => c.purpose.startsWith("open#n2")).map((c) => [c.purpose, c.cost_usd]),
    [["open#n2", 0.003], ["open#n2.retry1", 0.003]]);
});

test("opening upgrade: refused three times, nothing is sent and it is never asked again", async () => {
  const { t, upgrade } = await chapterTwoNoAgent();
  const a = await upgrade([BAD_OPEN]);
  assert.equal(a.calls.length, 3);
  assert.ok(!inbox(t).some((d) => /^s1_chopen_n2_/.test(d.id)), "no line, not the plain one");
  const b = await upgrade([{ open: CLUE.open }]);
  assert.equal(b.calls.length, 0, "never asked again");
});

test("opening upgrade: the chapter's three calls are shared and persisted: a restart resumes, told what was wrong", async () => {
  const { t, store, upgrade } = await chapterTwoNoAgent();
  // two calls already spent on this chapter before a restart, with what the last one got wrong
  const why = [{ id: "clue_gate", reason: "open: shows none of the building's facts" }];
  await store.setState({ clue_tries: { s1_n2: { n: 2, why } } });
  const a = await upgrade([BAD_OPEN]);
  assert.equal(a.calls.length, 1, "only the third call is left");
  assert.deepEqual(a.calls[0].rejections, why, "the restart still tells the agent what was wrong");
  assert.equal(store.callLog.filter((c) => c.purpose.startsWith("open#n2")).map((c) => c.purpose).join(), "open#n2.retry2");
  const b = await upgrade([{ open: CLUE.open }]);
  assert.equal(b.calls.length, 0);
  assert.ok(!inbox(t).some((d) => d.id === "s1_chopen_n2_ai"));
});

test("opening upgrade: a stage whose clue agent spent the chapter's calls is never upgraded", async () => {
  const { store, clueCalls } = await stageTwo({ ...CLUE, ...BAD_OPEN });
  assert.equal(clueCalls.length, 3);
  const st = await store.getState();
  assert.equal(st.clue_tries.s1_n2.n, 3, "persisted");
  assert.ok(!(st.openings_ai || []).includes("s1_n2"));
});

test("opening upgrade: no AI credit gives the plain intuition once; the provider's no-credit error too", async () => {
  const { t, upgrade } = await chapterTwoNoAgent();
  // seed and stage cost $0.02
  const a = await upgrade([{ open: CLUE.open }], { maxUsdPerDay: 0.02 });
  assert.equal(a.calls.length, 0);
  const line = inbox(t).find((d) => d.id === "s1_chopen_n2_plain");
  assert.ok(line, a.r.notes.join(" | "));
  assert.match(line.text, /^Before I knew why, it was already with me: /);
  assert.equal(line.player, "$all");
  const b = await upgrade([{ open: CLUE.open }]);
  assert.equal(b.calls.length, 0, "once");

  const two = await chapterTwoNoAgent();
  const e = new BrainError('openrouter answered 402 "Insufficient credits"', 402);
  e.noCredit = true;
  const c = await two.upgrade([e, { open: CLUE.open }]);
  assert.equal(c.calls.length, 1, "no retry when there is no credit");
  assert.ok(inbox(two.t).some((d) => d.id === "s1_chopen_n2_plain"));
  assert.ok(two.store.callLog.some((x) => x.purpose === "open#n2" && x.ok === false), "the failed call is logged");
});

test("opening backfill: with AI credit the missing opening carries no plain words; the agent writes its intuition next", async () => {
  const { store, upgrade } = await chapterTwoNoAgent();
  const st = await store.getState();
  await store.setState({ openings_sent: (st.openings_sent || []).filter((k) => k !== "s1_n2") });
  const a = await upgrade([{ open: CLUE.open }]);
  assert.equal(a.calls.length, 0, "the backfill makes no call");
  assert.ok(a.r.notes.some((n) => /s1_chopen_n2: the open chapter's missing opening sent/.test(n)), a.r.notes.join(" | "));
  const b = await upgrade([{ open: CLUE.open }]);
  assert.equal(b.calls.length, 1, "then the agent writes the intuition");
  assert.ok(!((await store.getState()).openings_plain || []).includes("s1_n2"), "no plain words were used");
});
