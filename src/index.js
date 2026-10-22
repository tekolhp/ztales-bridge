/**
 * ZTales bridge — Cloudflare Worker entry point.
 *
 * scheduled(): every cron minute, decide (without connecting) whether to poll, then one tick
 * over one FTP connection. fetch(): token-protected routes for the owner:
 *   GET /status    what the bridge knows (never story text, never the server address)
 *   GET /probe     log in over FTP and count the files in the ZTales folder; writes nothing
 *   POST /tick-now one tick right away
 *
 * Settings: vars ZTALES_ROOT, FTP_PORT, FTP_TLS ("1" for explicit TLS);
 * secrets FTP_HOST, FTP_USER, FTP_PASS, TOKEN (typed by the owner, never in the repository).
 */
import { withServerFtp } from "./ftp.js";
import { FtpTransport } from "./transport.js";
import { D1Store } from "./store.js";
import { VERSION, runTick, summary, ftpCfg, root } from "./run.js";

function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !b) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2),
  { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runTick(env).then(
      (r) => { if (r.status !== "idle" && r.status !== "not_configured") console.log(`tick ${summary(r)}`); },
      (e) => console.log(`tick failed: ${e.name}: ${e.message}`),
    ));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
    if (!sameToken(given, env.TOKEN)) return json({ error: "unauthorized" }, 401);

    try {
      if (url.pathname === "/status") {
        const store = new D1Store(env.ZTALES);
        const s = await store.getState();
        const facts = await store.facts();
        const queue = await store.takeQueue();
        return json({
          version: VERSION, last_poll: s.last_poll ?? null, last_seq: s.last_seq ?? null,
          players_online: s.last_online ?? 0, catalog_version: s.catalog_version ?? null,
          facts_known: facts.length, batches_waiting: queue.length,
        });
      }
      if (url.pathname === "/probe") {
        const counts = await withServerFtp(ftpCfg(env), async (s) => {
          const t = new FtpTransport(s, root(env));
          const out = {};
          for (const dir of ["outbox", "inbox", "catalog"]) out[dir] = (await t.list(dir)).length;
          out.seq_json = (await t.get("outbox/seq.json")) != null;
          // the folder above ZTales (Zomboid/Lua): proves the path even before the mod writes there
          const parent = root(env).replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
          const names = await s.list(parent);
          out.parent = { path: parent, entries: names.length, has_ztales: names.includes("ZTales"),
            sample: names.slice(0, 12) };
          return out;
        });
        return json({ ok: true, root: root(env), files: counts });
      }
      if (url.pathname === "/tick-now" && request.method === "POST") {
        const r = await runTick(env, true);
        return json({ ok: true, summary: summary(r), notes: r.notes || [], signals: r.signals || [],
          rejected: (r.rejected || []).map((x) => `${x.id}: ${x.reason}`),
          // the AI's raw answers, for the local test runner only (never set on a deployed bridge)
          ...(env.DEBUG_ANSWERS === "1" && r.debug ? { debug: r.debug } : {}) });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: `${e.name}: ${e.message}` }, 502);
    }
  },
};
