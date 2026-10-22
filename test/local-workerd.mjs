/**
 * Runs the real Worker in Cloudflare's local runtime (wrangler dev / workerd) against the fake
 * FTP server, so ftp.js and cloudflare:sockets are exercised, not just the pure core.
 * Nothing leaves this machine: local D1, a local FTP on 127.0.0.1, no Cloudflare account.
 *
 *   node test/local-workerd.mjs [path-to-wrangler]
 */
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { startFakeFtp } from "./fake-ftp.js";

const WRANGLER = process.argv[2] || "wrangler";
const ROOT = "/Zomboid/Lua/ZTales";
const PORT = 8799;
const here = new URL("..", import.meta.url);
const cwd = decodeURIComponent(here.pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const files = {
  [`${ROOT}/outbox/seq.json`]: JSON.stringify({ seq: 3, players_online: 1 }),
  [`${ROOT}/outbox/events-1-00001.json`]: JSON.stringify({ events: [
    { type: "reaction_fired", id: "r_1", stage: "n1", player: "ana", reveals: ["f_1"] }] }),
  [`${ROOT}/catalog/index.json`]: JSON.stringify({ version: "v1" }),
};
const srv = await startFakeFtp({ files });
// a clean local D1 every run: state left by the previous run would make this one a no-op
rmSync(new URL(".wrangler/state", here), { recursive: true, force: true });
const fail = (m) => { console.log(`FAIL ${m}`); process.exitCode = 1; };

writeFileSync(new URL(".dev.vars", here),
  `FTP_HOST=127.0.0.1\nFTP_PORT=${srv.port}\nFTP_USER=u\nFTP_PASS=p\nTOKEN=localtest\n`);
const shell = process.platform === "win32";
// through cmd.exe a path with spaces ("1 - Projetos") must be quoted
const bin = shell && WRANGLER.includes(" ") ? `"${WRANGLER}"` : WRANGLER;
execFileSync(bin, ["d1", "execute", "ztales", "--local", "--file=schema.sql"], { cwd, stdio: "ignore", shell });

const dev = spawn(bin, ["dev", "--local", "--port", String(PORT), "--test-scheduled"], { cwd, shell });
let out = "";
dev.stdout.on("data", (c) => { out += c; });
dev.stderr.on("data", (c) => { out += c; });

try {
  const base = `http://127.0.0.1:${PORT}`;
  const auth = { headers: { authorization: "Bearer localtest" } };
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    up = await fetch(`${base}/status`, auth).then((r) => r.status === 200, () => false);
  }
  if (!up) throw new Error(`wrangler dev did not come up:\n${out.slice(-2000)}`);

  const unauth = await fetch(`${base}/status`);
  if (unauth.status !== 401) fail("/status without the token must be refused");

  const probe = await (await fetch(`${base}/probe`, auth)).json();
  console.log("probe:", JSON.stringify(probe));
  if (!probe.ok || probe.files.outbox !== 2 || !probe.files.seq_json) fail("probe did not see the outbox");

  const ticked = await (await fetch(`${base}/tick-now`, { method: "POST", ...auth })).json();
  console.log("tick-now:", JSON.stringify(ticked));
  if (!ticked.ok || !/pulled=1/.test(ticked.summary)) fail("tick did not pull the events file");
  if (srv.tree.has(`${ROOT}/outbox/events-1-00001.json`)) fail("events file not deleted");
  if (!srv.tree.has(`${ROOT}/inbox/bridge-heartbeat.json`)) fail("no bridge heartbeat written");

  const status = await (await fetch(`${base}/status`, auth)).json();
  console.log("status:", JSON.stringify(status));
  if (status.facts_known !== 1 || status.last_seq !== 3) fail("D1 did not keep the state");

  // the cron path: wrangler's test hook fires scheduled()
  await fetch(`${base}/__scheduled?cron=*+*+*+*+*`);
  console.log(process.exitCode ? "LOCAL WORKERD TEST FAILED" : "LOCAL WORKERD TEST PASSED");
} finally {
  if (shell) { try { execFileSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
  else dev.kill();
  await srv.close();
  rmSync(new URL(".dev.vars", here), { force: true });
}
