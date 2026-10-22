import { test } from "node:test";
import assert from "node:assert/strict";
import { updateCarriers, isStoryPiece, bodyPlace, carrierEntry, placeKind } from "../src/carrier.js";
import { closedChapters } from "../src/chapterend.js";
import { fixClueItems, fillClosingPlayers, PLAIN_NOTE } from "../src/gates.js";
import { MemoryTransport } from "../src/transport.js";
import { MemoryStore } from "../src/store.js";
import { tick } from "../src/tick.js";

const T0 = 1_800_000_000;
const FIELDS = ["x", "y", "w", "h", "floors", "flags", "region", "name", "rooms", "zombie_density"];
const isPiece = isStoryPiece(new Set(["n1_fieldsheet", "n2_stalls"]));

test("a carrier's record: kept while the body lies or walks, moved where the former self falls, closed when the piece is taken", () => {
  let c = updateCarriers([], [
    { type: "player_died", player: "admin", life: 1, carrying: ["n1_fieldsheet", "n2_feedbook"], rises: true, x: 6050, y: 5473 },
  ], isPiece, T0);
  assert.deepEqual(c.map((r) => [r.player, r.life, r.ids, r.rises, r.state]), [["admin", 1, ["n1_fieldsheet"], true, "body"]],
    "only story pieces count (a clue on the body is no piece)");
  c = updateCarriers(c, [{ type: "carrier_rose", story_ids: ["n1_fieldsheet"] }], isPiece, T0 + 60);
  assert.equal(c[0].state, "risen");
  c = updateCarriers(c, [{ type: "former_self_killed", story_ids: ["n1_fieldsheet"], by: "admin", x: 6100, y: 5500 }], isPiece, T0 + 120);
  assert.deepEqual([c[0].state, c[0].x, c[0].y, c[0].rises], ["killed", 6100, 5500, false]);
  c = updateCarriers(c, [{ type: "pieces_held", player: "admin", ids: ["n1_fieldsheet"] }], isPiece, T0 + 180);
  assert.deepEqual(c, [], "taken back: nothing waits on that body any more");
  const none = updateCarriers([], [{ type: "player_died", player: "bob", life: 2, carrying: [] }], isPiece, T0);
  assert.deepEqual(none, [], "a death without a piece is no carrier");
});

test("where the body lies, by the place's function and its town, never a coordinate", () => {
  const cells = { "20_18": [[6040, 5460, 20, 20, 1, "", "Riverside", "", ["barn", "farmstorage"], 0]] };
  const inside = bodyPlace(cells, FIELDS, 6050, 5473);
  assert.deepEqual([inside.inside, inside.region], [true, "Riverside"]);
  assert.equal(placeKind(inside), "a barn");
  assert.equal(placeKind(inside, "pt-br"), "um celeiro");
  const outside = bodyPlace(cells, FIELDS, 6070, 5473);
  assert.equal(outside.inside, false);
  assert.equal(bodyPlace(cells, FIELDS, 7000, 7000), null, "nothing near");
  const rec = { player: "admin", life: 1, ids: ["n1_fieldsheet"], rises: false };
  const e = carrierEntry(rec, outside, ["en", "pt-br"], "s1_");
  assert.equal(e.id, "s1_carrier_admin_1");
  assert.equal(e.life, 2);
  assert.match(e.text.en, /outside a barn in Riverside/);
  assert.match(e.text["pt-br"], /do lado de fora de um celeiro em Riverside/);
  assert.ok(!/put it down/.test(e.text.en), "a body that does not rise is not said to walk");
  assert.ok(!/\d/.test(e.text.en + e.text["pt-br"]), "no coordinates");
  assert.match(carrierEntry(rec, null, ["en"]).text.en, /out in the open/);
});

test("the finder of a chapter whose piece was picked a tick before the node moved is the register's holder", async () => {
  const pbn = [{ node: "n1", ids: ["n1_fieldsheet"] }, { node: "n2", ids: ["n2_stalls"] }, { node: "n3", ids: ["n3_carbon"] }];
  assert.deepEqual(closedChapters([{ type: "node_changed", from: "n2", to: "n3" }], pbn, "s1", [], { n2_stalls: { status: "held", holder: "admin" } }),
    [{ node: "n2", finder: "admin" }]);
  // the tick: the pick-up in one file, the node a minute later in the next (live run 2026-10-22)
  const t = new MemoryTransport({
    "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1 }),
    "outbox/events-1-00001.json": JSON.stringify({ events: [{ type: "item_picked", story_id: "n2_stalls", player: "admin" }] }),
  });
  const store = new MemoryStore();
  await store.setState({ pieces_by_node: pbn, season: "s1", node: "n2" });
  await tick({ t, store, nowSec: T0 });
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  t.files.set("outbox/events-2-00001.json", JSON.stringify({ events: [{ type: "node_changed", from: "n2", to: "n3" }] }));
  const r = await tick({ t, store, nowSec: T0 + 90 });
  assert.ok(r.notes.some((n) => /chapter n2 ended \(finder admin\)/.test(n)), r.notes.join("; "));
});

test("the tick keeps the carrier marker and the piece waits on the body", async () => {
  const t = new MemoryTransport({
    "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1 }),
    "outbox/events-1-00001.json": JSON.stringify({ events: [
      { type: "player_died", player: "admin", life: 1, carrying: ["n1_fieldsheet"], rises: true, x: 6050, y: 5473 }] }),
  });
  const store = new MemoryStore();
  await store.setState({ pieces_by_node: [{ node: "n1", ids: ["n1_fieldsheet"] }], season: "s1" });
  const r = await tick({ t, store, nowSec: T0 });
  assert.ok(r.notes.some((n) => /carrier admin \(life 1\) died with n1_fieldsheet: the story waits on the body \(it will rise\)/.test(n)));
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  const later = await tick({ t, store, nowSec: T0 + 10 * 86400 });
  assert.ok(!(later.signals || []).some((s) => s.startsWith("lost_")), "ten days on, still no put-back");
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1 }));
  t.files.set("outbox/events-3-00001.json", JSON.stringify({ events: [{ type: "carrier_body_gone", story_ids: ["n1_fieldsheet"] }] }));
  const gone = await tick({ t, store, nowSec: T0 + 10 * 86400 + 60 });
  assert.ok((gone.signals || []).some((s) => s.startsWith("lost_n1_")), "the body is gone: the piece goes back");
  assert.deepEqual((await store.getState()).carriers, []);
});

test("rings written before their piece had a place are drawn around where the mod put it", async () => {
  const t = new MemoryTransport({
    "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1 }),
    "outbox/events-1-00001.json": JSON.stringify({ events: [
      { type: "directive_applied", directive_type: "spawn_zombie", id: "s2_tobias", x: 6051, y: 5471, z: 0 }] }),
  });
  const store = new MemoryStore();
  await store.setState({ season: "s1", rings_pending: { n2: { node: "n2", prefix: "s1_", ids: ["s2_tobias"],
    texts: { far: "Horses.", mid: "Hay.", near: "Here." } } } });
  const r = await tick({ t, store, nowSec: T0 });
  const sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  const near = sent.find((d) => d.id === "s1_prox_n2_near");
  assert.deepEqual([near.x, near.y], [6051 - 12, 5471 - 12]);
  assert.ok(sent.some((d) => d.id === "s1_prox_n2_far_r" && d.stage === "n2"));
  assert.ok(r.notes.some((n) => /rings of n2 drawn/.test(n)));
  assert.deepEqual((await store.getState()).rings_pending, {});
});

test("clue items: a ZTales note that is no piece is a plain sheet; a ZTales thing elsewhere goes back; the piece and the put-back stay", () => {
  const dirs = [
    { id: "a", type: "write_note", story_id: "n2_feedbook", item: "ZTales.NoteYellow", text: "x", target: { building: "b_1_1" } },
    { id: "b", type: "write_note", text: "no item given", target: { building: "b_1_1" } },
    { id: "c", type: "write_note", story_id: "n2_stalls", item: "ZTales.NoteYellow", text: "the piece", target: { building: "b_1_1" } },
    { id: "d", type: "spawn_zombie", target: { building: "b_1_1" }, inventory: [{ item: "ZTales.KeyYellow" }] },
    { id: "e", type: "reaction", when: { event: "signal", name: "stall", step: 1 },
      then: [{ id: "e.1", type: "place_item", item: "ZTales.PhotoYellow", target: { building: "b_1_1" } }] },
    { id: "f", type: "place_item", item: "Base.Tortilla", target: { building: "b_1_1" } },
    { id: "g", type: "write_note", story_id: "n1_fieldsheet", relost: true, item: "ZTales.NoteYellow", text: "back", target: { x: 1, y: 1 } },
  ];
  const r = fixClueItems(dirs, isPiece);
  assert.deepEqual(dirs.map((d) => d.id), ["a", "b", "c", "f", "g"]);
  assert.deepEqual([dirs[0].item, dirs[0].story_id, dirs[1].item], [PLAIN_NOTE, undefined, PLAIN_NOTE]);
  assert.equal(dirs[2].item, "ZTales.NoteYellow");
  assert.deepEqual(r.rejected.map((x) => x.id), ["d", "e"]);
  assert.match(r.rejected[1].reason, /only the piece is a ZTales item/);
});

test("a closing reaction (node_changed has no player) writes its diary line to everyone", () => {
  const dirs = [
    { id: "r_close", type: "reaction", when: { event: "node_changed", from: "n3" }, then: [
      { id: "r_close.1", type: "diary_entry", player: "$player", text: "x" },
      { id: "r_close.2", type: "diary_entry", text: "y" },
      { id: "r_close.3", type: "diary_entry", player: "ana", text: "z" }] },
    { id: "r_pick", type: "reaction", when: { event: "item_picked", story_id: "n3" }, then: [{ id: "r_pick.1", type: "diary_entry", player: "$player", text: "x" }] },
  ];
  const notes = fillClosingPlayers(dirs);
  assert.deepEqual(dirs[0].then.map((x) => x.player), ["$all", "$all", "ana"]);
  assert.equal(dirs[1].then[0].player, "$player", "an event with a player keeps it");
  assert.equal(notes.length, 2);
});
