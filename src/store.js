/**
 * Where the bridge remembers things between ticks. Two implementations with one interface:
 * MemoryStore for the tests, D1Store for the Worker (schema.sql).
 *
 *   getState() -> object          setState(patch)
 *   hasFile(name)                 addFile(name, kind, events[])  (records the file and its events)
 *   recentEvents(limit, type?)    addFacts([{ fact, text, stage, revealed_by, first_seen }])
 *   facts()                       enqueue(directives[])   takeQueue() -> [{ qid, directives }]
 *   markPushed(qid, ids[])        sentIds() -> Set
 *   getBible() / setBible(season, sealed)
 *   addMotifs([{ id, player, kind, text }])  unusedMotifs()  markMotifsUsed(ids[])
 *   logCall({ model, purpose, cost_usd, ok, raw?, note? }, atSec)  callsSince(sec) -> count  costSince(sec) -> USD
 *   (raw: the answer's text, already sealed by the caller; kept up to RAW_MAX characters)
 */

/** An answer's text kept in the calls table: a whole bible fits (~70 KB sealed), a runaway does not. */
export const RAW_MAX = 400000;
const clip = (s) => (typeof s === "string" ? (s.length > RAW_MAX ? `${s.slice(0, RAW_MAX)}…[cut]` : s) : null);

export class MemoryStore {
  constructor() {
    this.state = {};
    this.files = new Map();
    this.events = [];
    this.factMap = new Map();
    this.queue = [];
    this.sent = new Set();
    this.nextQ = 1;
    this.bibleRow = null;
    this.motifMap = new Map();
    this.callLog = [];
  }

  async getBible() { return this.bibleRow ? this.bibleRow.sealed : null; }
  async setBible(season, sealed) { this.bibleRow = { season, sealed }; }

  async addMotifs(list) {
    for (const m of list) if (!this.motifMap.has(m.id)) this.motifMap.set(m.id, { ...m, used: false });
  }

  async unusedMotifs() { return [...this.motifMap.values()].filter((m) => !m.used).map(({ used, ...m }) => m); }
  async markMotifsUsed(ids) { for (const i of ids) { const m = this.motifMap.get(i); if (m) m.used = true; } }
  async logCall(c, atSec) { this.callLog.push({ ...c, at: atSec }); }
  async callsSince(sec) { return this.callLog.filter((c) => c.at >= sec).length; }
  async costSince(sec) { return this.callLog.filter((c) => c.at >= sec).reduce((a, c) => a + (Number(c.cost_usd) || 0), 0); }

  async getState() { return { ...this.state }; }
  async setState(patch) { Object.assign(this.state, patch); }
  async hasFile(name) { return this.files.has(name); }

  async addFile(name, kind, events) {
    if (this.files.has(name)) return false;
    this.files.set(name, kind);
    for (const ev of events) this.events.push({ file: name, type: String(ev.type || kind), body: ev });
    return true;
  }

  async recentEvents(limit = 200, type) {
    const list = type ? this.events.filter((e) => e.type === type) : this.events;
    return list.slice(-limit).map((e) => e.body);
  }

  async addFacts(facts) {
    for (const f of facts) if (!this.factMap.has(f.fact)) this.factMap.set(f.fact, f);
  }

  async facts() { return [...this.factMap.values()]; }

  async enqueue(directives) {
    this.queue.push({ qid: this.nextQ++, directives });
  }

  async takeQueue() { return this.queue.filter((q) => !q.pushed); }

  async markPushed(qid, ids) {
    const q = this.queue.find((x) => x.qid === qid);
    if (q) q.pushed = true;
    ids.forEach((i) => this.sent.add(i));
  }

  async sentIds() { return new Set(this.sent); }
}

export class D1Store {
  constructor(db) { this.db = db; }

  async getState() {
    const { results } = await this.db.prepare("SELECT key, value FROM state").all();
    const out = {};
    for (const r of results) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  }

  async setState(patch) {
    const stmt = this.db.prepare("INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2");
    await this.db.batch(Object.entries(patch).map(([k, v]) => stmt.bind(k, JSON.stringify(v))));
  }

  async hasFile(name) {
    return !!(await this.db.prepare("SELECT 1 FROM files WHERE name = ?1").bind(name).first());
  }

  async addFile(name, kind, events) {
    const now = Date.now();
    const ins = this.db.prepare("INSERT OR IGNORE INTO files (name, kind, at) VALUES (?1, ?2, ?3)").bind(name, kind, now);
    const res = await ins.run();
    if (!res.meta || res.meta.changes === 0) return false;
    if (events.length) {
      const ev = this.db.prepare("INSERT INTO events (file, type, body, at) VALUES (?1, ?2, ?3, ?4)");
      await this.db.batch(events.map((e) => ev.bind(name, String(e.type || kind), JSON.stringify(e), now)));
    }
    return true;
  }

  async recentEvents(limit = 200, type) {
    const q = type
      ? this.db.prepare("SELECT body FROM events WHERE type = ?2 ORDER BY id DESC LIMIT ?1").bind(limit, type)
      : this.db.prepare("SELECT body FROM events ORDER BY id DESC LIMIT ?1").bind(limit);
    const { results } = await q.all();
    return results.reverse().map((r) => JSON.parse(r.body));
  }

  async addFacts(facts) {
    if (!facts.length) return;
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO facts (fact, text, stage, revealed_by, first_seen, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)");
    const now = Date.now();
    await this.db.batch(facts.map((f) => stmt.bind(f.fact, f.text ?? null, f.stage ?? null, f.revealed_by ?? null,
      f.first_seen ? JSON.stringify(f.first_seen) : null, now)));
  }

  async facts() {
    const { results } = await this.db.prepare("SELECT fact, text, stage, revealed_by, first_seen FROM facts ORDER BY at").all();
    return results;
  }

  async enqueue(directives) {
    await this.db.prepare("INSERT INTO outgoing (body) VALUES (?1)").bind(JSON.stringify(directives)).run();
  }

  async takeQueue() {
    const { results } = await this.db.prepare("SELECT id, body FROM outgoing WHERE pushed IS NULL ORDER BY id").all();
    return results.map((r) => ({ qid: r.id, directives: JSON.parse(r.body) }));
  }

  async markPushed(qid, ids) {
    const stmts = [this.db.prepare("UPDATE outgoing SET pushed = ?2 WHERE id = ?1").bind(qid, Date.now())];
    const ins = this.db.prepare("INSERT OR IGNORE INTO sent_ids (id) VALUES (?1)");
    for (const i of ids) stmts.push(ins.bind(i));
    await this.db.batch(stmts);
  }

  async sentIds() {
    const { results } = await this.db.prepare("SELECT id FROM sent_ids").all();
    return new Set(results.map((r) => r.id));
  }

  async getBible() {
    const r = await this.db.prepare("SELECT sealed FROM bible ORDER BY at DESC LIMIT 1").first();
    return r ? r.sealed : null;
  }

  async setBible(season, sealed) {
    await this.db.prepare("INSERT INTO bible (season, sealed, at) VALUES (?1, ?2, ?3) ON CONFLICT(season) DO UPDATE SET sealed = ?2, at = ?3")
      .bind(season, sealed, Date.now()).run();
  }

  async addMotifs(list) {
    if (!list.length) return;
    const stmt = this.db.prepare("INSERT OR IGNORE INTO motifs (id, player, kind, text, at) VALUES (?1, ?2, ?3, ?4, ?5)");
    const now = Date.now();
    await this.db.batch(list.map((m) => stmt.bind(m.id, m.player ?? null, m.kind ?? null, m.text, now)));
  }

  async unusedMotifs() {
    const { results } = await this.db.prepare("SELECT id, player, kind, text FROM motifs WHERE used = 0 ORDER BY at").all();
    return results;
  }

  async markMotifsUsed(ids) {
    if (!ids.length) return;
    const stmt = this.db.prepare("UPDATE motifs SET used = 1 WHERE id = ?1");
    await this.db.batch(ids.map((i) => stmt.bind(i)));
  }

  async logCall(c, atSec) {
    const insert = () => this.db.prepare("INSERT INTO calls (at, model, purpose, cost_usd, ok, raw, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(atSec, c.model ?? null, c.purpose ?? null, c.cost_usd ?? null, c.ok ? 1 : 0, clip(c.raw), c.note ?? null).run();
    try {
      await insert();
    } catch (e) {
      if (!/raw|note|column/i.test(String(e?.message))) throw e;
      // a database made before the answer's text was kept: add the columns once, then insert
      for (const col of ["raw", "note"]) {
        try { await this.db.prepare(`ALTER TABLE calls ADD COLUMN ${col} TEXT`).run(); } catch { /* already there */ }
      }
      await insert();
    }
  }

  async callsSince(sec) {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE at >= ?1").bind(sec).first();
    return r ? Number(r.n) : 0;
  }

  async costSince(sec) {
    const r = await this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM calls WHERE at >= ?1").bind(sec).first();
    return r ? Number(r.usd) || 0 : 0;
  }
}
