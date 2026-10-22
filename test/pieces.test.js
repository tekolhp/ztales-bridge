import { test } from "node:test";
import assert from "node:assert/strict";
import { updatePieces, lostNodes, lostSignals, LOST_AFTER_SEC } from "../src/pieces.js";
import { MemoryTransport } from "../src/transport.js";
import { MemoryStore } from "../src/store.js";
import { tick } from "../src/tick.js";

const T0 = 1_800_000_000;
const NODES = [{ node: "n1", ids: ["n1_photo", "n1_note"] }, { node: "n2", ids: ["n2_key", "n2_tape"] }];

test("the register follows each piece: placed, held, dropped, on a corpse, in the urn", () => {
  let reg = updatePieces({}, [
    { type: "directive_applied", directive_type: "place_item", story_id: "n1_photo" },
    { type: "item_picked", story_id: "n1_photo", player: "ana" },
    { type: "pieces_held", player: "ana", ids: ["n1_photo", "n1_note"] },
  ], T0);
  assert.equal(reg.n1_photo.status, "held");
  assert.equal(reg.n1_note.holder, "ana");
  reg = updatePieces(reg, [{ type: "pieces_held", player: "ana", ids: ["n1_note"] }], T0 + 10);
  assert.equal(reg.n1_photo.status, "loose", "dropped somewhere");
  reg = updatePieces(reg, [{ type: "player_died", player: "ana", carrying: ["n1_note"], x: 5, y: 6 }], T0 + 20);
  assert.equal(reg.n1_note.status, "on_corpse");
  reg = updatePieces(reg, [{ type: "urn_piece", piece: "n2_key" }], T0 + 30);
  assert.equal(reg.n2_key.status, "in_urn");
});

test("a node is dark only when every piece is lost for three real days; signalled once", () => {
  let reg = updatePieces({}, [
    { type: "pieces_held", player: "ana", ids: ["n1_photo", "n1_note"] },
    { type: "pieces_held", player: "ana", ids: [] },
  ], T0);
  assert.deepEqual(lostNodes(reg, NODES, T0 + 3600), [], "not yet");
  assert.deepEqual(lostNodes(reg, NODES, T0 + LOST_AFTER_SEC), ["n1"]);
  const sig = lostSignals(reg, NODES, [], T0 + LOST_AFTER_SEC);
  assert.equal(sig.length, 1);
  assert.equal(sig[0].type, "signal");
  assert.equal(sig[0].node, "n1");
  assert.deepEqual(lostSignals(reg, NODES, ["n1"], T0 + LOST_AFTER_SEC), [], "once per node");
  // one piece back in the world: the node is lit again
  reg = updatePieces(reg, [{ type: "directive_applied", directive_type: "place_item", story_id: "n1_photo" }], T0 + LOST_AFTER_SEC);
  assert.deepEqual(lostNodes(reg, NODES, T0 + 2 * LOST_AFTER_SEC), []);
});

test("the tick pushes the piece_lost signal to the inbox, without the AI", async () => {
  const t = new MemoryTransport({
    "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1 }),
    "outbox/events-1-00001.json": JSON.stringify({ events: [{ type: "pieces_held", player: "ana", ids: ["n1_photo", "n1_note"] },
      { type: "pieces_held", player: "ana", ids: [] }] }),
  });
  const store = new MemoryStore();
  await store.setState({ pieces_by_node: NODES });
  await tick({ t, store, nowSec: T0 });
  assert.equal([...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).length, 0, "nothing yet");
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 2, players_online: 1 }));
  const r = await tick({ t, store, nowSec: T0 + LOST_AFTER_SEC });
  const sent = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives);
  assert.ok(sent.some((d) => d.type === "signal" && d.name === "piece_lost" && d.node === "n1"), JSON.stringify(sent));
  assert.ok(r.signals.some((id) => id.startsWith("lost_n1_")));
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 3, players_online: 1 }));
  await tick({ t, store, nowSec: T0 + LOST_AFTER_SEC + 60 });
  assert.equal(sent.length, [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-")).flatMap((k) => JSON.parse(t.files.get(k)).directives).length, "never twice");
});

test("a piece on a dead carrier: the story waits on the body, rising or not; put back only when the body is gone", () => {
  let reg = updatePieces({}, [
    { type: "pieces_held", player: "ana", ids: ["n1_photo"] },
    { type: "player_died", player: "ana", life: 1, carrying: ["n1_photo"], rises: true, x: 5, y: 6 },
  ], T0);
  assert.equal(reg.n1_photo.status, "on_corpse");
  assert.equal(reg.n1_photo.rises, true);
  const ONE = [{ node: "n1", ids: ["n1_photo"] }];
  assert.deepEqual(lostNodes(reg, ONE, T0 + 30 * 86400), [], "a body is never lost by time");
  reg = updatePieces(reg, [{ type: "carrier_rose", story_ids: ["n1_photo"] }], T0 + 60);
  assert.equal(reg.n1_photo.status, "risen");
  assert.deepEqual(lostNodes(reg, ONE, T0 + 30 * 86400), [], "no put-back while that zombie walks");
  reg = updatePieces(reg, [{ type: "former_self_killed", story_ids: ["n1_photo"], by: "ana", x: 9, y: 9 }], T0 + 120);
  assert.equal(reg.n1_photo.status, "on_corpse");
  assert.deepEqual(reg.n1_photo.at, [9, 9], "it lies where the former self was put down");
  reg = updatePieces(reg, [{ type: "carrier_body_gone", story_ids: ["n1_photo"] }], T0 + 180);
  assert.equal(reg.n1_photo.status, "gone");
  assert.deepEqual(lostNodes(reg, ONE, T0 + 181), ["n1"], "the body truly gone: the bridge puts the piece back");
  const back = updatePieces(updatePieces({}, [{ type: "player_died", player: "ana", carrying: ["n1_photo"] }], T0),
    [{ type: "pieces_held", player: "ana", ids: ["n1_photo"] }], T0 + 60);
  assert.equal(back.n1_photo.status, "held", "the new life took it back off the body");
});
