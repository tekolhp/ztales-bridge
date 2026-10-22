import { test } from "node:test";
import assert from "node:assert/strict";
import { withFtp, parseEpsv, parsePasv, FtpError } from "../src/ftp-core.js";
import { nodeOpen } from "./net-socket.js";
import { startFakeFtp } from "./fake-ftp.js";

const cfgFor = (srv, extra = {}) => ({ host: "127.0.0.1", port: srv.port, user: "u", pass: "p", timeout: 3000, ...extra });

test("parses passive replies", () => {
  assert.equal(parseEpsv("229 Entering Extended Passive Mode (|||6446|)"), 6446);
  assert.deepEqual(parsePasv("227 Entering Passive Mode (203,0,113,7,25,46)"), { host: "203.0.113.7", port: 25 * 256 + 46 });
  assert.equal(parseEpsv("229 nonsense"), null);
});

test("list, get, put, delete over EPSV", async () => {
  const srv = await startFakeFtp({ files: {
    "/Lua/ZTales/outbox/seq.json": '{"seq":3}',
    "/Lua/ZTales/outbox/events-1-00001.json": '{"events":[]}',
  } });
  try {
    await withFtp(nodeOpen, cfgFor(srv), async (s) => {
      assert.deepEqual((await s.list("/Lua/ZTales/outbox")).sort(), ["events-1-00001.json", "seq.json"]);
      assert.equal(await s.get("/Lua/ZTales/outbox/seq.json"), '{"seq":3}');
      assert.equal(await s.get("/Lua/ZTales/outbox/missing.json"), null);
      await s.put("/Lua/ZTales/inbox/directives-9.json", '{"directives":[]}');
      assert.equal(await s.del("/Lua/ZTales/outbox/events-1-00001.json"), true);
      assert.equal(await s.del("/Lua/ZTales/outbox/events-1-00001.json"), false);
      assert.deepEqual(await s.list("/Lua/ZTales/nothing"), []);
    });
    assert.equal(srv.tree.get("/Lua/ZTales/inbox/directives-9.json"), '{"directives":[]}');
    assert.ok(srv.log.includes("QUIT"), "the session always ends with QUIT");
    assert.ok(!srv.log.some((l) => l.includes(" p")), "the password never reaches the server log");
  } finally {
    await srv.close();
  }
});

test("falls back to PASV, and replaces a private PASV address with the control host", async () => {
  const srv = await startFakeFtp({ epsv: false, pasvIp: "10,0,0,5", files: { "/a/b.json": "x" } });
  try {
    await withFtp(nodeOpen, cfgFor(srv), async (s) => {
      assert.equal(await s.get("/a/b.json"), "x");
    });
  } finally {
    await srv.close();
  }
});

test("UTF-8 survives the round trip", async () => {
  const srv = await startFakeFtp();
  try {
    await withFtp(nodeOpen, cfgFor(srv), async (s) => {
      await s.put("/t.json", '{"t":"Dalva — São Paulo"}');
      assert.equal(await s.get("/t.json"), '{"t":"Dalva — São Paulo"}');
    });
  } finally {
    await srv.close();
  }
});

test("a refused login is an FtpError without the reply text", async () => {
  const srv = await startFakeFtp();
  try {
    await assert.rejects(withFtp(nodeOpen, cfgFor(srv, { pass: "wrong" }), async () => {}),
      (e) => e instanceof FtpError && e.code === 530 && !e.message.includes("incorrect"));
  } finally {
    await srv.close();
  }
});

test("missing settings fail before connecting", async () => {
  await assert.rejects(withFtp(nodeOpen, { host: "", user: "u", pass: "p" }, async () => {}), FtpError);
});

test("a silent server times out instead of hanging", async () => {
  const net = await import("node:net");
  const held = new Set();
  const mute = net.createServer((c) => { held.add(c); c.on("error", () => {}); });
  await new Promise((r) => mute.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(withFtp(nodeOpen, { host: "127.0.0.1", port: mute.address().port, user: "u", pass: "p", timeout: 300 }, async () => {}),
      /timeout/);
  } finally {
    for (const c of held) c.destroy();
    await new Promise((r) => mute.close(r));
  }
});
