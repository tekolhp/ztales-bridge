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
  far: "Something bitter on my tongue that will not wash out.",
  mid: "People came and went all day, a counter, a till that rang.",
  near: "Bitter tablets counted twice, a prescription in a stranger's hand.",
  open: "My hands keep counting things out, a few at a time, onto a counter only I can see.",
  cites: { mid: [{ fact: "kind:shop" }], near: [{ fact: "room:pharmacy" }] },
};

const inbox = (t) => [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).sort()
  .flatMap((k) => JSON.parse(t.files.get(k)).directives);

/** The seed (no clue agent), then chapter two written with `clue` as the clue agent's answer. */
async function stageTwo(clue) {
  const t = new MemoryTransport(catalogFiles());
  const store = new MemoryStore();
  const ask1 = async () => ({ doc: structuredClone(SEED), model: "fake", cost: 0.01 });
  await tick({ t, store, nowSec: T0, decide: makeDecide({ ask: ask1, system: "S", bibleKey: KEY }) });
  const seedSent = inbox(t);
  const clueCalls = [];
  const ask2 = async () => ({ doc: structuredClone(STAGE2), model: "fake", cost: 0.01 });
  const askClues = async (system, context) => {
    clueCalls.push(JSON.parse(context));
    if (clue instanceof Error) throw clue;
    return { doc: structuredClone(clue), model: "fake-haiku", cost: 0.002 };
  };
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n1", to: "n2" }] }));
  const r = await tick({ t, store, nowSec: T0 + 600, decide: makeDecide({ ask: ask2, askClues, system: "S", bibleKey: KEY }) });
  const all = inbox(t);
  return { seedSent, sent: all.filter((d) => !seedSent.some((x) => x.id === d.id)), all, r, clueCalls, store };
}
const openOf = (list, node) => list.find((d) => d.type === "open_chapter" && d.chapter === node);

test("opening: the mod and the bridge know open_chapter; only the bridge writes it; its intuition is read text", () => {
  assert.ok(DIRECTIVE_TYPES.has("open_chapter"));
  assert.ok(BRIDGE_ONLY_TYPES.has("open_chapter"), "an AI answer carrying one is refused");
  assert.ok(TEXT_FIELDS.includes("intuition"), "the languages gate reads it");
  assert.match(CLUES_PROMPT, /open:/);
  assert.match(CLUES_PROMPT, /\{ far, mid, near, open, cites \}/);
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

test("opening: an intuition that names the place is refused; plain words take its place, rings kept", async () => {
  const { sent, r } = await stageTwo({ ...CLUE, open: "Something about that pharmacy, the bitter tablets on the counter." });
  const o = openOf(sent, "n2");
  assert.ok(o && typeof o.intuition === "string");
  assert.match(o.intuition, /^Before I knew why, it was already with me: bitter tablets/);
  assert.ok(!/ of |It is in there/.test(o.intuition.replace("bitter tablets", "")), `no compass, no "it is in there": ${o.intuition}`);
  assert.equal(sent.find((d) => d.id === "s1_prox_n2_near_r")?.then?.[0]?.text, CLUE.near, "the rings stand on their own");
  assert.match(r.notes.join(" "), /intuition in plain words \(open: names the place \("pharmacy"\)/);
});

test("opening: a failed clue call still opens the chapter with a plain intuition", async () => {
  const { sent, r } = await stageTwo(new BrainError("answer is not valid JSON", 0, 0.003, "{oops"));
  const o = openOf(sent, "n2");
  assert.ok(o);
  assert.match(o.intuition, /^Before I knew why, it was already with me: /);
  assert.ok(!/It is in there/.test(o.intuition));
  assert.match(r.notes.join(" "), /clues#n2: AI call failed/);
});

test("opening: no intuition written at all is the plain one too", async () => {
  const { open, ...noOpen } = CLUE;
  void open;
  const { sent } = await stageTwo(noOpen);
  assert.match(openOf(sent, "n2").intuition, /^Before I knew why/);
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
