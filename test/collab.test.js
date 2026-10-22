import { test } from "node:test";
import assert from "node:assert/strict";
import { updateCollab, collabScore, extraCount, extraDirectives, familyOf, EXTRA_MAX } from "../src/collab.js";
import { sharedSpots } from "../src/gates.js";
import { drawBonus, URN_BONUS_MAX, FINAL_BONUS_MAX } from "../src/reward.js";
import { finalTaleDirectives } from "../src/finaltale.js";
import { CLUE_FAMILIES } from "../src/story.js";

const NODES = [{ node: "n1", ids: ["n1_photo", "n1_note"] }, { node: "n2", ids: ["n2_key", "n2_tape"] }];
const ctx = { season: "s1", node: "n1", piecesByNode: NODES };

function seeded(seed = 7) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

test("collaboration: a careful player alone earns one extra piece, a group that splits up earns three", () => {
  const solo = updateCollab(null, [
    { type: "item_picked", story_id: "n1_photo", player: "ana" },
    { type: "item_picked", story_id: "n1_note", player: "ana" },
    { type: "item_picked", story_id: "n1_note", player: "ana" },
    { type: "note_read", story_id: "n1_note", player: "ana" },
    { type: "note_read", story_id: "n1_note", player: "ana" },
    { type: "journal", kind: "chapter", chapter: "n1", player: "ana", text: "I found it." },
  ], ctx);
  const s = collabScore(solo.chapters.n1);
  // pieces 1x2 + page 1x2 + reader 1 = 5
  assert.equal(s.score, 5, JSON.stringify(s.parts));
  assert.equal(extraCount(s.score), 1);

  const ev = [];
  for (const p of ["ana", "bob", "cid", "dee"]) {
    ev.push({ type: "item_picked", story_id: p === "ana" ? "n1_photo" : "n1_note", player: p });
    ev.push({ type: "note_read", story_id: "n1_note", player: p });
    ev.push({ type: "journal_entry", kind: "chapter", chapter: "n1", player: p });
    ev.push({ type: "zone_entered", story_id: "s1_prox_n1_far", player: p });
  }
  const group = updateCollab(null, ev, ctx);
  const g = collabScore(group.chapters.n1);
  assert.equal(extraCount(g.score), EXTRA_MAX, JSON.stringify(g));
  assert.ok(g.parts.helpers === 6 && g.parts.readers === 3 && g.parts.rings === 3, "each term capped at three");
  assert.equal(extraCount(0), 0);
  assert.equal(extraCount(1000), EXTRA_MAX, "never more than three a chapter");
});

test("collaboration: events after a node change count for the new chapter; another story starts over", () => {
  const c = updateCollab(null, [
    { type: "item_picked", story_id: "n1_photo", player: "ana" },
    { type: "node_changed", from: "n1", to: "n2" },
    { type: "item_picked", story_id: "n2_key", player: "bob" },
    { type: "zone_entered", story_id: "s1_prox_n1_near", player: "bob" },
  ], ctx);
  assert.equal(c.node, "n2");
  assert.deepEqual(c.chapters.n1.players, ["ana"]);
  assert.deepEqual(c.chapters.n2.pieces, ["n2_key"]);
  assert.deepEqual(c.chapters.n2.rings, [], "the old node's ring is not this chapter's");
  const next = updateCollab(c, [], { ...ctx, season: "s2" });
  assert.deepEqual(next.chapters, {}, "a new story starts its own tally");
  const kept = updateCollab(c, [], ctx);
  assert.equal(kept.node, "n2", "the same story keeps its node and tally");
});

test("extra pieces: the chapter's own families, yellow, every language, never in a building of the node", () => {
  const places = [
    { id: "b_100_100", rooms: ["kitchen"] }, { id: "b_120_100", rooms: ["bedroom"] },
    { id: "b_140_100", rooms: ["office"] }, { id: "b_160_100", rooms: ["garage"] }, { id: "b_5000_5000", rooms: ["far"] },
  ];
  const { directives, notes } = extraDirectives({ node: "n2", count: 3, prefix: "s1_",
    pieces: [{ story_id: "n2_key", item: "ZTales.KeyGreen" }, { story_id: "n2_vhs", item: "ZTales.VHSRed" }],
    places, taken: ["b_100_100"], center: [104, 104], languages: ["en", "pt-br"], families: CLUE_FAMILIES });
  assert.deepEqual(notes, []);
  assert.deepEqual(directives.map((d) => d.id), ["s1_n2_extra1", "s1_n2_extra2", "s1_n2_extra3"]);
  assert.deepEqual(directives.map((d) => d.item), ["ZTales.KeyYellow", "ZTales.VHSYellow", "ZTales.KeyYellow"]);
  for (const d of directives) {
    assert.equal(d.story_id, d.id);
    assert.ok(d.title.en && d.title["pt-br"], "titled in every language");
    assert.notEqual(d.target.building, "b_100_100", "never where a piece of the node is");
    assert.notEqual(d.target.building, "b_5000_5000", "near the node");
  }
  assert.equal(new Set(directives.map((d) => d.target.building)).size, 3, "one building each");
  const again = extraDirectives({ node: "n2", count: 3, prefix: "s1_", pieces: [], places, taken: ["b_100_100"], center: [104, 104], families: CLUE_FAMILIES });
  assert.deepEqual(again.directives.map((d) => d.target.building), directives.map((d) => d.target.building), "a retried stage draws the same places");
  const none = extraDirectives({ node: "n2", count: 2, places: [{ id: "b_100_100" }], taken: ["b_100_100"], center: [0, 0], families: CLUE_FAMILIES });
  assert.equal(none.directives.length, 0);
  assert.match(none.notes[0], /no free building/);
  assert.equal(familyOf("ZTales.PartBGreen", CLUE_FAMILIES), "PartB");
  assert.equal(familyOf("Base.Katana", CLUE_FAMILIES), null);
});

test("gate: two pieces of one node never share a square or a container", () => {
  const pieceNode = new Map([["n1_vhs", "n1"], ["n1_walkie", "n1"], ["n2_key", "n2"]]);
  const at = (id, sid, target) => ({ id, type: "place_item", story_id: sid, item: "ZTales.VHSYellow", target });
  // Teko's VHS and walkie: same building, no room
  let r = sharedSpots([at("a", "n1_vhs", { building: "b_1_1" }), at("b", "n1_walkie", { building: "b_1_1" })], pieceNode);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "b");
  assert.match(r[0].reason, /n1_walkie shares building b_1_1 with piece n1_vhs of node n1/);
  assert.match(r[0].reason, /another building/);
  // one with a room, the other without: still the same container may be picked
  r = sharedSpots([at("a", "n1_vhs", { building: "b_1_1", room: "kitchen" }), at("b", "n1_walkie", { building: "b_1_1" })], pieceNode);
  assert.equal(r.length, 1);
  // different rooms, other buildings, other nodes: fine
  assert.deepEqual(sharedSpots([at("a", "n1_vhs", { building: "b_1_1", room: "kitchen" }), at("b", "n1_walkie", { building: "b_1_1", room: "bedroom" })], pieceNode), []);
  assert.deepEqual(sharedSpots([at("a", "n1_vhs", { building: "b_1_1" }), at("b", "n2_key", { building: "b_1_1" })], pieceNode), []);
  // the same square
  r = sharedSpots([at("a", "n1_vhs", { x: 5, y: 6 }), at("b", "n1_walkie", { x: 5, y: 6 })], pieceNode);
  assert.equal(r.length, 1);
  // inside a reaction, against a piece already in the world
  const react = { id: "r1", type: "reaction", when: { event: "item_picked", story_id: "n1_vhs" }, then: [at("r1.1", "n1_walkie", { building: "b_9_9" })] };
  r = sharedSpots([react], pieceNode, [{ story_id: "n1_vhs", target: { building: "b_9_9" } }]);
  assert.deepEqual(r.map((x) => x.id), ["r1"]);
});

const ROWS = { food: [["Base.Beans", "Beans", "Food", 0.5, [], 0, 1], ["Base.Soup", "Soup", "Food", 0.6, [], 0, 1], ["Base.Pasta", "Pasta", "Food", 0.4, [], 0, 1]],
  meds: [["Base.Pills", "Pills", "Drainable", 0.1, [], 0, 1]], clothes: [["Base.Shirt", "Shirt", "Clothing", 0.4, [], 0, 1]] };

test("bonus lists: one smaller draw of the same focus each, capped", () => {
  const b = drawBonus(ROWS, { focus: "food", n: 3, rand: seeded() });
  assert.equal(b.length, 3);
  for (const list of b) {
    assert.ok(list.length >= 1);
    assert.ok(list.every((x) => /Beans|Soup|Pasta/.test(x.item)), `the focus only: ${JSON.stringify(list)}`);
  }
  assert.equal(drawBonus(ROWS, { focus: "food", n: 50, rand: seeded() }).length, URN_BONUS_MAX);
  assert.equal(drawBonus(ROWS, { focus: "food", n: 0 }).length, 0);
});

test("the Final Tale grows with the season's extra pieces, up to a cap", () => {
  const place = { id: "b_1_1", x: 5, y: 5, name: "X" };
  const rewardOf = (extras) => finalTaleDirectives({ place, packer: "ana", rowsBy: ROWS, rand: seeded(3), extras })
    .find((d) => d.id === "final_filled").then[0].steps.flatMap((s) => s.then).find((d) => d.type === "open_urn" && d.reward).reward;
  const count = (r) => r.reduce((a, x) => a + x.count, 0);
  const none = rewardOf(0), some = rewardOf(3), many = rewardOf(FINAL_BONUS_MAX), lots = rewardOf(500);
  assert.ok(count(some) > count(none), `${count(some)} > ${count(none)}`);
  assert.ok(count(many) > count(some));
  assert.equal(lots.length, many.length, "capped: past the cap no more is added");
  assert.ok(lots.some((x) => x.item === "ZTales.Ashes"), "the Ashes always");
});
