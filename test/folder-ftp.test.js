import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderTree } from "./serve-folder-ftp.mjs";
import { startFakeFtp } from "./fake-ftp.js";
import { withFtp } from "../src/ftp-core.js";
import { FtpTransport } from "../src/transport.js";
import { MemoryStore } from "../src/store.js";
import { tick } from "../src/tick.js";
import { nodeOpen } from "./net-socket.js";

test("a real folder served over FTP: the tick reads and deletes real files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ztales-ftp-"));
  mkdirSync(join(dir, "outbox"));
  writeFileSync(join(dir, "outbox", "seq.json"), JSON.stringify({ seq: 1, players_online: 1 }));
  writeFileSync(join(dir, "outbox", "events-1-00001.json"), JSON.stringify({ events: [{ type: "player_online", player: "ana" }] }));
  const srv = await startFakeFtp({ tree: new FolderTree(dir, "/Zomboid/Lua/ZTales") });
  try {
    const store = new MemoryStore();
    await store.enqueue([{ id: "d_1", type: "chat", scope: "server", text: "hello" }]);
    const r = await withFtp(nodeOpen, { host: "127.0.0.1", port: srv.port, user: "u", pass: "p", timeout: 3000 },
      (s) => tick({ t: new FtpTransport(s, "/Zomboid/Lua/ZTales"), store, nowSec: 1_800_000_000 }));
    assert.equal(r.pulled, 1);
    assert.ok(!existsSync(join(dir, "outbox", "events-1-00001.json")));
    assert.ok(existsSync(join(dir, "inbox", "bridge-heartbeat.json")));
    assert.ok(readFileSync(join(dir, "inbox", "index.json"), "utf8").includes("directives-"));
  } finally {
    await srv.close();
  }
});

test("paths outside the mount are refused", () => {
  const t = new FolderTree(tmpdir(), "/Zomboid/Lua/ZTales");
  assert.equal(t.local("/etc/passwd"), null);
  assert.equal(t.local("/Zomboid/Lua/ZTales/../../x"), null);
});
