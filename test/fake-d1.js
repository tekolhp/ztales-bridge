/** A D1-shaped wrapper over node:sqlite, so D1Store and schema.sql are tested for real SQL. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }

  // D1 numbers its parameters (?1, ?2, and may reuse one); node:sqlite does not accept that,
  // so each ?N becomes a plain ? with its value repeated in order of appearance
  plain() {
    const values = [];
    const sql = this.sql.replace(/\?(\d+)/g, (_, n) => { values.push(this.args[Number(n) - 1]); return "?"; });
    return { stmt: this.db.prepare(sql), values };
  }
  async all() { const { stmt, values } = this.plain(); return { results: stmt.all(...values) }; }
  async first() { const { stmt, values } = this.plain(); return stmt.get(...values) ?? null; }
  async run() {
    const { stmt, values } = this.plain();
    const r = stmt.run(...values);
    return { meta: { changes: Number(r.changes) } };
  }
}

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return {
    prepare: (sql) => new Stmt(db, sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    raw: db,
  };
}
