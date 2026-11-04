import { test } from "node:test";
import assert from "node:assert/strict";
import { updateBlocks, dueBlocks, blockMaterial, gateWatch, cleanActive, blockHours, hasCoordinates, pullFor, townNames,
  WATCH_TTL_SEC } from "../src/watch.js";

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

// Teko, 2026-10-28: a group living in West Point read every hint as if the mystery were there;
// the chapter's piece was in Riverside
const RIVERSIDE = { x: 6500, y: 5300, region: "Riverside, KY", allowed: ["Riverside Diner"],
  towns: ["West Point, KY", "West Point", "Riverside, KY", "Riverside", "Muldraugh"],
  signs: ["starch", "iron", "pressed", "fold", "steam", "laundry", "lavanderia", "goma", "vapor"] };
const westBlock = { player: "ana", to: 900 };
const westOwn = { ana: ["West Point", "West Point Laundry Co"] };
const gateOne = (text, kind = "hint") => gateWatch({ directives: [{ type: "diary_entry", player: "ana", kind, text }] },
  { asked: new Map([["ana", westBlock]]), languages: ["en"], place: RIVERSIDE, own: westOwn });

test("the pull: direction and distance band from where the block happened to the piece's building", () => {
  const ts = new Date(1000 * 1000).toISOString();
  const m = blockMaterial([
    { type: "player_journey", player: "ana", ts, regions: ["West Point"] },
    { type: "zombie_killed", player: "ana", ts, x: 11900, y: 6900 },
  ], { player: "ana", from: 900, to: 2000 });
  assert.deepEqual(m.where, { x: 11900, y: 6900 }, "the last position of the block");
  assert.deepEqual(pullFor(RIVERSIDE, m), { direction: "west", distance: "another town", here: false });
  assert.equal(pullFor({ ...RIVERSIDE, x: 11950, y: 6950, region: "West Point" }, m).distance, "near");
  assert.equal(pullFor({ ...RIVERSIDE, x: 12300, y: 6900, region: "West Point" }, m).distance, "across town");
  assert.deepEqual(pullFor(RIVERSIDE, { regions: ["West Point"] }), { direction: null, distance: "another town", here: false },
    "no position: the towns alone say it is elsewhere");
  assert.deepEqual(townNames({ spawn_regions: [{ name: "West Point, KY" }] }, [{ region: "Riverside" }], ["Rosewood"]),
    ["West Point, KY", "West Point", "Riverside", "Rosewood"]);
});

test("the watch place gate: a hint names no other town; the day and the pull never share a sentence; a record is free", () => {
  // the production line of 2026-10-28: West Point and the chapter's starch in one sentence
  let g = gateOne("Day 410. Walked the same roads again: West Point, the bridge... the smell of hot starch... that laundry door.");
  assert.equal(g.accepted.length, 0);
  assert.match(g.rejections[0].reason, /"West Point" \(where they were\) and "(starch|laundry)" \(what is sought\) in one sentence/);
  assert.equal(g.rejections[0].player, "ana", "the reason is the player's, for the retry");
  // a town that is neither the chapter's nor theirs
  g = gateOne("Something waits in Muldraugh.");
  assert.match(g.rejections[0].reason, /names "Muldraugh".*Riverside/);
  // the intended tone (Teko): the day in plain past actions, then the pull as a feeling of its own,
  // turned toward the chapter's town, the kind of place never named
  const tone = "Day 412. Today we cleared two houses in West Point and burned the bodies by the bridge. "
    + "But it isn't here. These streets feel worn out for this, and something keeps pulling me toward Riverside, "
    + "a warm, clean smell of pressed cotton I can't place. I keep telling myself to stay. I don't think I will.";
  g = gateOne(tone);
  assert.deepEqual(g.rejections, []);
  assert.equal(g.accepted[0].kind, "watch_hint");
  const tonePt = "Dia 412. Hoje limpamos duas casas em West Point e queimamos os corpos perto da ponte. "
    + "Mas não é aqui. Algo me puxa para Riverside, um cheiro de goma e vapor que não sei de onde vem. Sinto que vou acabar indo.";
  assert.deepEqual(gateOne(tonePt).rejections, [], "the same in PT-BR");
  assert.deepEqual(gateOne("Something pulls me toward Riverside Diner, and the steam of it.").rejections, [], "the nearest named place is fine");
  assert.deepEqual(gateOne("A feeling I can't shake: it's further than the river.").rejections, [], "naming no place is fine");
  // a record may name where they were, and nothing is sought in it
  assert.deepEqual(gateOne("Day 444. We've been in West Point so long, folding the same laundry.", "record").rejections, []);
  // without a known place (the piece's building unread) the gate is as before
  assert.equal(gateWatch({ directives: [{ type: "diary_entry", player: "ana", text: "Muldraugh, the starch." }] },
    { asked: new Map([["ana", westBlock]]), languages: ["en"] }).accepted.length, 1);
});
