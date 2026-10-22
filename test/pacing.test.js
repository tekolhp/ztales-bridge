import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, notePlayed, onNode, stepsDue, stepOf, cycleOf, pendingSignals, dayKey } from "../src/pacing.js";
import { tick } from "../src/tick.js";
import { MemoryTransport } from "../src/transport.js";
import { MemoryStore } from "../src/store.js";

const DAY = 86400;
const T0 = Date.UTC(2026, 9, 1, 15) / 1000;

function played(n, node = "n1", start = T0) {
  let p = fresh(node);
  for (let i = 0; i < n; i++) p = notePlayed(p, start + i * DAY, 2);
  return p;
}

test("only days with players count, once each", () => {
  let p = fresh("n1");
  p = notePlayed(p, T0, 0);
  p = notePlayed(p, T0, 3);
  p = notePlayed(p, T0 + 3600, 1);
  p = notePlayed(p, T0 + DAY, 1);
  assert.equal(p.days.length, 2);
});

test("time zone decides which day an evening belongs to", () => {
  const lateEvening = Date.UTC(2026, 9, 2, 1) / 1000;   // 22:00 the day before in UTC-3
  assert.equal(dayKey(lateEvening, 0), "2026-10-02");
  assert.equal(dayKey(lateEvening, -3), "2026-10-01");
});

test("HintPace thresholds: automatic 10 then every 4, patient 21/7, more help 5/2", () => {
  assert.equal(stepsDue(played(9)), 0);
  assert.equal(stepsDue(played(10)), 1);
  assert.equal(stepsDue(played(13)), 1);
  assert.equal(stepsDue(played(14)), 2);
  assert.equal(stepsDue(played(20), "patient"), 0);
  assert.equal(stepsDue(played(21), "patient"), 1);
  assert.equal(stepsDue(played(5), "more_help"), 1);
  assert.equal(stepsDue(played(7), "more_help"), 2);
});

test("steps go 1 to 4 and repeat", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(stepOf), [1, 2, 3, 4, 1, 2, 1]);
});

test("each signal is raised once, with an id that names the node and the count", () => {
  const { signals, pacing } = pendingSignals(played(14));
  assert.deepEqual(signals.map((s) => [s.id, s.step]), [["stall_n1_1", 1], ["stall_n1_2", 2]]);
  assert.equal(pendingSignals(pacing).signals.length, 0);
});

test("a node resolving starts the count again", () => {
  const p = onNode(played(14), "n2");
  assert.equal(p.days.length, 0);
  assert.equal(onNode(p, "n2"), p, "the same node changes nothing");
});

test("the tick raises the stall signal on the tenth played day, and only then", async () => {
  const t = new MemoryTransport({ "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1 }) });
  const store = new MemoryStore();
  await store.setState({ pacing: { node: "n1", days: [], sent: 0 } });
  let raised = [];
  for (let d = 0; d < 10; d++) {
    const r = await tick({ t, store, nowSec: T0 + d * DAY });
    raised = raised.concat(r.signals || []);
  }
  assert.deepEqual(raised, ["stall_n1_1"]);
  const pushed = [...t.files.keys()].filter((k) => k.startsWith("inbox/directives-"));
  assert.equal(pushed.length, 1);
  assert.equal(JSON.parse(t.files.get(pushed[0])).directives[0].type, "signal");
});

// docs/13 item 6: the help comes back when the steps go round, for every player
test("stall signals carry their cycle and ask the mod to answer each player", () => {
  assert.deepEqual([1, 4, 5, 8, 9].map(cycleOf), [1, 1, 2, 2, 3]);
  const { signals } = pendingSignals({ node: "n1", days: Array.from({ length: 10 + 4 * 4 }, (_, i) => `d${i}`), sent: 4 });
  assert.deepEqual(signals.map((s) => [s.id, s.step, s.cycle, s.each_player]), [["stall_n1_5", 1, 2, true]]);
});
