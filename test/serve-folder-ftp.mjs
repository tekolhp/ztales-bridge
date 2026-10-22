/**
 * Serves a real folder (a test server's Zomboid/Lua/ZTales) over FTP on 127.0.0.1, so the
 * Worker in `wrangler dev` talks to the game exactly as it will talk to the host.
 *
 *   node test/serve-folder-ftp.mjs <folder> [port=2121] [mount=/Zomboid/Lua/ZTales]
 *
 * Login u / p. Local only; never expose it.
 */
import { readFileSync, writeFileSync, rmSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { startFakeFtp } from "./fake-ftp.js";

export class FolderTree {
  constructor(folder, mount) { this.folder = folder; this.mount = mount.replace(/\/+$/, ""); }
  local(p) {
    if (!p.startsWith(`${this.mount}/`)) return null;
    const rel = p.slice(this.mount.length + 1);
    if (rel.split("/").includes("..")) return null;
    return join(this.folder, rel);
  }
  has(p) { const f = this.local(p); return !!f && existsSync(f) && statSync(f).isFile(); }
  get(p) { return readFileSync(this.local(p), "utf8"); }
  set(p, text) { const f = this.local(p); if (!f) return; mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
  delete(p) { if (!this.has(p)) return false; rmSync(this.local(p)); return true; }
  *keys() {
    const walk = function* (dir, prefix) {
      for (const n of readdirSync(dir)) {
        const f = join(dir, n);
        if (statSync(f).isDirectory()) yield* walk(f, `${prefix}/${n}`);
        else yield `${prefix}/${n}`;
      }
    };
    if (existsSync(this.folder)) yield* walk(this.folder, this.mount);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [folder, port = "2121", mount = "/Zomboid/Lua/ZTales"] = process.argv.slice(2);
  if (!folder) { console.log("usage: node test/serve-folder-ftp.mjs <folder> [port] [mount]"); process.exit(1); }
  const srv = await startFakeFtp({ tree: new FolderTree(folder, mount), port: Number(port) });
  console.log(`FTP on 127.0.0.1:${srv.port} (u / p) serving ${folder} as ${mount}`);
}
