import { test } from "node:test";
import assert from "node:assert/strict";
import { updateBlocks, dueBlocks, blockMaterial, gateWatch, cleanActive, blockHours, hasCoordinates, WATCH_TTL_SEC } from "../src/watch.js";

const H = 3600;

test("a block closes every 12 real hours a player has played; idle or absent players add nothing", () => {
  let w = updateBlocks({}, { ana: 100, bob: 0 }, 1000);
  assert.deepEqual(w.closed, [], "first seen: a block opens at the player's count, no backlog");
  assert.deepEqual(w.blocks.ana, { start: 100, since: 1000 });
  // ana plays 11 hours, bob is away (his count does not move)
  w = updateBlocks(w.blocks, { ana: 100 + 11 * H, bob: 0 }, 5000);
  assert.deepEqual(w.closed, []);
  w = updateBlocks(w.blocks, { ana: 100 + 12 * H, bob: 0 }, 9000);
  assert.deepEqual(w.closed, [{ player: "ana", from: 1000, to: 9000, seconds: 12 * H }]);
  assert.deepEqual(w.blocks.ana, { start: 100 + 12 * H, since: 9000 }, "the next block starts at once");
  // a count that went down (the server's data reset) opens a fresh block
  w = updateBlocks(w.blocks, { ana: 50 }, 9500);
  assert.deepEqual(w.closed, []);
  assert.equal(w.blocks.ana.start, 50);
  // the sandbox's hours, clamped
  assert.equal(updateBlocks({ c: { start: 0, since: 0 } }, { c: 2 * H }, 10, 2).closed.length, 1);
  assert.equal(blockHours(undefined), 12);
  assert.equal(blockHours(500), 72);
  assert.deepEqual(cleanActive({ ana: 5, $all: 3, bob: "x", cid: -1 }), { ana: 5 });
  assert.deepEqual(cleanActive([]), {}, "Lua's empty table may be a list");
});

test("blocks owed an answer wait, once each, and are dropped after two days", () => {
  const due = dueBlocks([{ player: "old", to: 0 }], [{ player: "ana", to: 100 }, { player: "ana", to: 100 }], WATCH_TTL_SEC + 10);
  assert.deepEqual(due.map((b) => b.player), ["ana"]);
});

test("a block's material: that player's journeys, diary and places inside the block only", () => {
  const ts = (sec) => new Date(sec * 1000).toISOString();
  const events = [
    { type: "player_journey", player: "ana", ts: ts(2000), named_places: ["Muldraugh Hospital"], regions: ["Muldraugh"], zombies_killed: 4 },
    { type: "player_journey", player: "ana", ts: ts(100), named_places: ["Old Place"] },
    { type: "player_journey", player: "bob", ts: ts(2000), named_places: ["Bob's"] },
    { type: "journal", player: "ana", ts: ts(2500), kind: "free", text: "The hospital was empty." },
  ];
  const m = blockMaterial(events, { player: "ana", from: 1000, to: 1000 + 12 * H });
  assert.deepEqual(m.places, ["Muldraugh Hospital"]);
  assert.equal(m.journeys.length, 1);
  assert.equal(m.diary[0].text, "The hospital was empty.");
  assert.equal(m.hours, 12);
});

test("the watch gate: only a diary entry for a player asked, one each, every language, no coordinates, nothing forbidden, paced", () => {
  const asked = new Map([["ana", { player: "ana", to: 777 }], ["bob", { player: "bob", to: 778 }]]);
  const both = (x) => ({ en: x, "pt-br": x });
  const answer = { directives: [
    { id: "a", type: "diary_entry", player: "ana", kind: "hint", deliver: "now", text: both("Another hospital, further east, keeps calling me.") },
    { id: "a2", type: "diary_entry", player: "ana", text: both("Again.") },
    { id: "c", type: "diary_entry", player: "cid", text: both("Not asked.") },
    { id: "s", type: "chat", scope: "server", text: both("Hello.") },
    { id: "b", type: "diary_entry", player: "bob", kind: "record", text: both("I went to 10650, 9650.") },
  ] };
  const g = gateWatch(answer, { asked, season: "s1", languages: ["en", "pt-br"], forbidden: ["Dalton Keane"], storyIds: new Set(["n1_photo"]) });
  assert.deepEqual(g.accepted.map((d) => [d.id, d.player, d.kind, d.deliver]), [["s1_watch_ana_777", "ana", "watch_hint", undefined]]);
  const why = JSON.stringify(g.rejections);
  assert.match(why, /one entry per player/);
  assert.match(why, /no block of cid/);
  assert.match(why, /only diary_entry/);
  assert.match(why, /coordinates/);
  const leak = gateWatch({ directives: [{ id: "x", type: "diary_entry", player: "bob", text: both("Dalton Keane knew.") }] }, { asked, languages: ["en", "pt-br"], forbidden: ["Dalton Keane"] });
  assert.match(JSON.stringify(leak.rejections), /before its time/);
  const one = gateWatch({ directives: [{ id: "x", type: "diary_entry", player: "bob", text: { en: "Only English." } }] }, { asked, languages: ["en", "pt-br"] });
  assert.match(JSON.stringify(one.rejections), /lacks pt-br/);
  assert.ok(hasCoordinates("the house at x 10650") && hasCoordinates("b_10700_9700") && !hasCoordinates("radio 88.6 at seven"));
});
