import { test } from "node:test";
import assert from "node:assert/strict";
import { tick, shouldConnect, IDLE_POLL_SEC } from "../src/tick.js";
import { MemoryTransport, FtpTransport } from "../src/transport.js";
import { MemoryStore, D1Store } from "../src/store.js";
import { withFtp } from "../src/ftp-core.js";
import { nodeOpen } from "./net-socket.js";
import { startFakeFtp } from "./fake-ftp.js";
import { fakeD1 } from "./fake-d1.js";

const T0 = 1_800_000_000;

function serverFiles(extra = {}) {
  return {
    "outbox/seq.json": JSON.stringify({ seq: 7, players_online: 2 }),
    "outbox/heartbeat.json": "{}",
    "outbox/boot.json": "{}",
    "outbox/events-1-00001.json": JSON.stringify({ events: [
      { type: "item_picked", story_id: "n2_key", player: "ana" },
      { type: "reaction_fired", id: "r_1", stage: "n2", player: "ana", reveals: ["f_1", "f_2"] },
    ] }),
    "outbox/journal-1-00002.json": JSON.stringify({ entries: [{ entry: "j_0001", kind: "backstory", text: "I was a nurse" }] }),
    "outbox/inbox-ack.json": JSON.stringify({ consumed: ["directives-1-00001.json"] }),
    "inbox/directives-1-00001.json": "{}",
    "catalog/index.json": JSON.stringify({ version: "v1", cell_count: 2 }),
    ...extra,
  };
}

for (const [label, makeStore] of [["memory store", () => new MemoryStore()], ["D1 store (sqlite)", () => new D1Store(fakeD1())]]) {
  test(`${label}: pulls, deletes, acks, learns facts, writes a heartbeat`, async () => {
    const t = new MemoryTransport(serverFiles());
    const store = makeStore();
    const r = await tick({ t, store, nowSec: T0 });
    assert.equal(r.status, "ok");
    assert.equal(r.pulled, 2);
    assert.equal(r.deleted, 2);
    assert.equal(r.acked, 1);
    assert.ok(!t.files.has("outbox/events-1-00001.json") && !t.files.has("inbox/directives-1-00001.json"));
    assert.ok(t.files.has("outbox/boot.json") && t.files.has("outbox/heartbeat.json"), "fixed-name files stay");
    assert.ok(t.files.has("inbox/bridge-heartbeat.json"));
    assert.deepEqual((await store.facts()).map((f) => f.fact).sort(), ["f_1", "f_2"]);
    const journal = await store.recentEvents(10, "journal");
    assert.equal(journal[0].text, "I was a nurse");
    const s = await store.getState();
    assert.equal(s.last_seq, 7);
    assert.equal(s.last_online, 2);
    assert.equal(s.catalog_version, "v1");
  });

  test(`${label}: an unchanged seq reads one file and lists nothing`, async () => {
    const t = new MemoryTransport(serverFiles());
    const store = makeStore();
    await tick({ t, store, nowSec: T0 });
    t.ops = [];
    t.files.set("outbox/events-2-00003.json", JSON.stringify({ events: [] }));
    await tick({ t, store, nowSec: T0 + 60 });
    assert.deepEqual(t.ops, ["get outbox/seq.json"]);
  });

  test(`${label}: a file whose delete failed is never read twice`, async () => {
    const t = new MemoryTransport(serverFiles());
    const store = makeStore();
    const del = t.del.bind(t);
    t.del = async () => false;
    await tick({ t, store, nowSec: T0 });
    t.del = del;
    t.files.set("outbox/seq.json", JSON.stringify({ seq: 8, players_online: 2 }));
    const r = await tick({ t, store, nowSec: T0 + 60 });
    assert.equal(r.pulled, 0);
    assert.equal(r.deleted, 2);
    assert.equal((await store.recentEvents(50, "item_picked")).length, 1);
  });

  test(`${label}: queued directives pass the gates and land in the inbox once`, async () => {
    const t = new MemoryTransport(serverFiles());
    const store = makeStore();
    await store.enqueue([
      { id: "d_1", type: "chat", scope: "server", text: "Static on 88.6." },
      { id: "d_bad", type: "teleport_player" },
    ]);
    const r = await tick({ t, store, nowSec: T0 });
    assert.equal(r.pushed, 1);
    assert.equal(r.rejected[0].id, "d_bad");
    const name = [...t.files.keys()].find((k) => /^inbox\/directives-\d+-\d+\.json$/.test(k));
    assert.ok(name);
    assert.equal(JSON.parse(t.files.get(name)).directives[0].id, "d_1");
    assert.deepEqual(JSON.parse(t.files.get("inbox/index.json")).files, [name.slice(6)]);
    await store.enqueue([{ id: "d_1", type: "chat", scope: "server", text: "again" }]);
    const r2 = await tick({ t, store, nowSec: T0 + 60 });
    assert.equal(r2.pushed, 0, "an id already sent is never sent again");
  });
}

test("no seq.json: the mod is not there (or the path is wrong)", async () => {
  const r = await tick({ t: new MemoryTransport({}), store: new MemoryStore(), nowSec: T0 });
  assert.equal(r.status, "no_mod");
});

test("polling pace: every minute with players, every 10 minutes without, at once with work queued", () => {
  assert.equal(shouldConnect({}, T0), true);
  assert.equal(shouldConnect({ last_poll: T0, last_online: 3 }, T0 + 55), true);
  assert.equal(shouldConnect({ last_poll: T0, last_online: 0 }, T0 + 120), false);
  assert.equal(shouldConnect({ last_poll: T0, last_online: 0 }, T0 + IDLE_POLL_SEC), true);
  assert.equal(shouldConnect({ last_poll: T0, last_online: 0 }, T0 + 60, true), true);
});

test("end to end over FTP: the same tick against a real FTP conversation", async () => {
  const root = "/Zomboid/Lua/ZTales";
  const files = Object.fromEntries(Object.entries(serverFiles()).map(([k, v]) => [`${root}/${k}`, v]));
  const srv = await startFakeFtp({ files });
  try {
    const store = new MemoryStore();
    await store.enqueue([{ id: "d_1", type: "chat", scope: "server", text: "Static." }]);
    const r = await withFtp(nodeOpen, { host: "127.0.0.1", port: srv.port, user: "u", pass: "p", timeout: 3000 },
      (s) => tick({ t: new FtpTransport(s, root), store, nowSec: T0 }));
    assert.equal(r.pulled, 2);
    assert.equal(r.pushed, 1);
    assert.ok(!srv.tree.has(`${root}/outbox/events-1-00001.json`));
    assert.ok([...srv.tree.keys()].some((k) => k.startsWith(`${root}/inbox/directives-`)));
    assert.ok(srv.tree.has(`${root}/inbox/bridge-heartbeat.json`));
  } finally {
    await srv.close();
  }
});

test("a refusing host is left alone: 1, 2, 4... minutes, at most 30", async () => {
  const { backoffSec } = await import("../src/tick.js");
  assert.deepEqual([1, 2, 3, 4, 10].map(backoffSec), [60, 120, 240, 480, 1800]);
  assert.equal(shouldConnect({ ftp_backoff_until: T0 + 100, last_online: 5 }, T0 + 50, true), false, "not even with work queued");
  assert.equal(shouldConnect({ ftp_backoff_until: T0 + 100 }, T0 + 100), true);
});

test("uploads land whole: written as .part, renamed into place over the old file", async () => {
  const root = "/Zomboid/Lua/ZTales";
  const srv = await startFakeFtp({ files: { [`${root}/inbox/hints.json`]: "old" } });
  try {
    await withFtp(nodeOpen, { host: "127.0.0.1", port: srv.port, user: "u", pass: "p", timeout: 3000 }, async (s) => {
      const t = new FtpTransport(s, root);
      await t.put("inbox/hints.json", "new");
      await t.put("inbox/directives-1-00001.json", "{}");
    });
    assert.equal(srv.tree.get(`${root}/inbox/hints.json`), "new");
    assert.ok(srv.tree.has(`${root}/inbox/directives-1-00001.json`));
    assert.ok(![...srv.tree.keys()].some((k) => k.endsWith(".part")), "no .part left behind");
    assert.ok(srv.log.some((l) => l.startsWith("RNFR")), "renamed, not written in place");
  } finally {
    await srv.close();
  }
});
