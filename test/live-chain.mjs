/**
 * The whole chain on this machine: a running test game server writes into its
 * Zomboid/Lua/ZTales folder; that folder is served over FTP on 127.0.0.1; the real Worker runs in
 * Cloudflare's local runtime and ticks against it. Nothing leaves the machine.
 *
 *   node test/live-chain.mjs <server's Lua/ZTales folder> <path-to-wrangler>
 *
 * Start the game server first (tools/boot_test.ps1 -Stay). Prints what the Worker did and what
 * changed in the folder.
 */
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeFtp } from "./fake-ftp.js";
import { FolderTree } from "./serve-folder-ftp.mjs";

const [folder, WRANGLER = "wrangler"] = process.argv.slice(2);
if (!folder || !existsSync(join(folder, "outbox"))) {
  console.log("usage: node test/live-chain.mjs <Lua/ZTales folder with an outbox> <wrangler>");
  process.exit(1);
}
const here = new URL("..", import.meta.url);
const cwd = decodeURIComponent(here.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const shell = process.platform === "win32";
const bin = shell && WRANGLER.includes(" ") ? `"${WRANGLER}"` : WRANGLER;
const PORT = 8798;
const list = (d) => (existsSync(join(folder, d)) ? readdirSync(join(folder, d)).sort() : []);

const srv = await startFakeFtp({ tree: new FolderTree(folder, "/Zomboid/Lua/ZTales") });
rmSync(new URL(".wrangler/state", here), { recursive: true, force: true });
writeFileSync(new URL(".dev.vars", here), `FTP_HOST=127.0.0.1\nFTP_PORT=${srv.port}\nFTP_USER=u\nFTP_PASS=p\nTOKEN=localtest\n`);
execFileSync(bin, ["d1", "execute", "ztales", "--local", "--file=schema.sql"], { cwd, stdio: "ignore", shell });
const dev = spawn(bin, ["dev", "--local", "--port", String(PORT)], { cwd, shell });
let out = "";
dev.stdout.on("data", (c) => { out += c; });
dev.stderr.on("data", (c) => { out += c; });

try {
  console.log("before  outbox:", list("outbox").join(" "));
  console.log("before  inbox: ", list("inbox").join(" ") || "(empty)");
  const base = `http://127.0.0.1:${PORT}`;
  const auth = { headers: { authorization: "Bearer localtest" } };
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    up = await fetch(`${base}/status`, auth).then((r) => r.status === 200, () => false);
  }
  if (!up) throw new Error(`wrangler dev did not come up:\n${out.slice(-1500)}`);
  console.log("probe:  ", JSON.stringify((await (await fetch(`${base}/probe`, auth)).json()).files));
  console.log("tick:   ", (await (await fetch(`${base}/tick-now`, { method: "POST", ...auth })).json()).summary);
  console.log("status: ", JSON.stringify(await (await fetch(`${base}/status`, auth)).json()));
  console.log("after   outbox:", list("outbox").join(" "));
  console.log("after   inbox: ", list("inbox").join(" "));
  const hb = join(folder, "inbox", "bridge-heartbeat.json");
  console.log(existsSync(hb) ? `bridge heartbeat: ${readFileSync(hb, "utf8")}` : "NO bridge heartbeat");
} finally {
  if (shell) { try { execFileSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
  else dev.kill();
  await srv.close();
  rmSync(new URL(".dev.vars", here), { force: true });
}
