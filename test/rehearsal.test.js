import { test } from "node:test";
import assert from "node:assert/strict";
import { rehearsalAnswer } from "../src/rehearsal.js";
import { makeDecide } from "../src/story.js";
import { MemoryStore } from "../src/store.js";
import { MemoryTransport } from "../src/transport.js";
import { tick } from "../src/tick.js";

const FIELDS = ["x", "y", "w", "h", "floors", "flags", "region", "name", "rooms", "zombie_density"];
const files = () => ({
  "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1, languages: ["en", "pt-br"] }),
  "catalog/index.json": JSON.stringify({ version: "v1", cell_size: 300, building_fields: FIELDS, story_max_nodes: 4,
    spawn_regions: [{ name: "Muldraugh, KY", points: [[10650, 9650]] }], professions: [], mods: [], outfits: [], item_categories: [] }),
  "catalog/cells.json": JSON.stringify({ cells: [{ cell: "35_32" }, { cell: "39_32" }] }),
  "catalog/cell-39_32.json": JSON.stringify({ rows: [
    [11800, 9700, 14, 12, 1, "u", "", "", ["church"], 0.4],
    [11850, 9800, 8, 8, 1, "ru", "", "", ["kitchen"], 0.1],
  ] }),
  "catalog/cell-35_32.json": JSON.stringify({ rows: [
    [10600, 9600, 10, 8, 1, "r", "Muldraugh", "", ["kitchen", "bedroom"], 0.1],
    [10700, 9700, 12, 10, 1, "s", "Muldraugh", "", ["laundry"], 0.2],
    [10800, 9650, 20, 15, 2, "", "Muldraugh", "", ["church"], 0.3],
    [10650, 9750, 8, 8, 1, "r", "Muldraugh", "", ["kitchen"], 0.1],
  ] }),
});

test("rehearsal story: the seed clears every gate in one round, in both languages", async () => {
  const t = new MemoryTransport(files());
  const store = new MemoryStore();
  let calls = 0;
  const decide = makeDecide({ ask: async (s, c) => { calls++; return rehearsalAnswer(c); }, system: "", bibleKey: "rehearsal-key-0123456789" });
  const r = await tick({ t, store, nowSec: 1_800_000_000, decide });
  assert.equal(calls, 1, `one round: ${JSON.stringify(r.rejected)}`);
  assert.deepEqual(r.rejected, []);
  const sent = JSON.parse(t.files.get([...t.files.keys()].find((k) => k.startsWith("inbox/directives-")))).directives;
  const photo = sent.find((d) => d.id === "rh_n1_photo");
  assert.equal(photo.target.building, "b_10700_9700", "the laundry");
  assert.equal(photo.text["pt-br"].slice(0, 9), "No verso:");
  assert.ok(sent.some((d) => d.id === "s1_prox_n1_near"), "rings drawn around the laundry");
  assert.equal(JSON.parse(t.files.get("inbox/hints.json")).node, "n1");

  // the mod confirms the season opened on n1: that is the stage just written, no new AI call
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1, languages: ["en", "pt-br"] }));
  t.files.set("outbox/events-1-00009.json", JSON.stringify({ events: [{ type: "node_changed", from: "", to: "n1" }] }));
  const r1 = await tick({ t, store, nowSec: 1_800_000_300, decide });
  // and chapter two is not written ahead (Teko, 2026-10-22: it waits for chapter one to close)
  assert.equal(calls, 1, "opening on n1 does not rewrite n1, nor write chapter two ahead");
  assert.deepEqual(r1.rejected, []);
  assert.equal((await store.getState()).ahead ?? null, null);

  // a player picks the photo: the mod moves to n2; the bridge writes chapter two
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1, languages: ["en", "pt-br"] }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [
    { type: "reaction_fired", id: "rh_n1_pick_photo", stage: "n1", player: "ana", reveals: ["f_rh_888"] },
    { type: "node_changed", from: "n1", to: "n2" }] }));
  const r2 = await tick({ t, store, nowSec: 1_800_000_600, decide });
  assert.deepEqual(r2.rejected, []);
  assert.equal(calls, 2, "chapter two is written now, in one round");
  const all = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  assert.equal(all.find((d) => d.id === "rh_n2_radio").target.building, "b_11800_9700",
    "the final chapter goes to the church OUTSIDE the spawn town, not the one in Muldraugh");
  assert.ok(all.some((d) => d.id === "s1_prox_n2_far"));
  assert.equal((await store.facts())[0].fact, "f_rh_888");
});

test("rehearsal: a dream for each new life passes the gates in every language", async () => {
  const { rehearsalAnswer } = await import("../src/rehearsal.js");
  const { gateBatch } = await import("../src/gates.js");
  const ctx = { task: "echo", state: { languages: ["en", "pt-br"] }, echo_for: [{ player: "ana", life: 2 }, { player: "bo", life: 3 }],
    journeys: { ana: [{ life: 1, named_places: ["Muldraugh"] }] } };
  const { doc } = rehearsalAnswer(JSON.stringify(ctx));
  const g = gateBatch(doc.directives, { languages: ["en", "pt-br"] });
  assert.equal(g.accepted.length, 2, JSON.stringify(g.rejected));
  assert.ok(doc.directives[0].text["pt-br"].includes("Muldraugh"));
});

test("rehearsal, two writers: the bible, then node one with its one piece placed", async () => {
  const t = new MemoryTransport(files());
  const store = new MemoryStore();
  const tasks = [];
  const scripted = async (s, c) => { tasks.push(JSON.parse(c).task); return rehearsalAnswer(c); };
  const decide = makeDecide({ ask: scripted, askStory: scripted, system: "", bibleKey: "rehearsal-key-0123456789" });
  const r = await tick({ t, store, nowSec: 1_800_000_000, decide });
  assert.deepEqual(tasks, ["bible", "stage"]);
  assert.deepEqual(r.rejected, []);
  const sent = JSON.parse(t.files.get([...t.files.keys()].find((k) => k.startsWith("inbox/directives-")))).directives;
  assert.ok(sent.some((d) => d.id === "rh_n1_photo") && !sent.some((d) => d.id === "rh_n1_note"), "one piece per chapter");
  assert.ok(sent.some((d) => d.type === "reaction" && d.then.some((x) => x.type === "set_node" && x.node === "n2")));
});
