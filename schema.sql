-- ZTales bridge storage (Cloudflare D1). Apply with:
--   npx wrangler d1 execute ztales --remote --file=schema.sql
-- Every statement is idempotent, so running it again is safe.

-- one row per key: last seq seen, last poll, players online, catalog version, state version...
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- outbox files already consumed, so a file the bridge failed to delete is never read twice
CREATE TABLE IF NOT EXISTS files (
  name  TEXT PRIMARY KEY,
  kind  TEXT NOT NULL,
  at    INTEGER NOT NULL
);

-- every event and journal entry the mod reported, in arrival order
CREATE TABLE IF NOT EXISTS events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  file  TEXT NOT NULL,
  type  TEXT NOT NULL,
  body  TEXT NOT NULL,
  at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type ON events(type);

-- the ledger: what players already know (docs/03)
CREATE TABLE IF NOT EXISTS facts (
  fact        TEXT PRIMARY KEY,
  text        TEXT,
  stage       TEXT,
  revealed_by TEXT,
  first_seen  TEXT,
  at          INTEGER NOT NULL
);

-- directive batches waiting to be pushed, and every id ever sent
CREATE TABLE IF NOT EXISTS outgoing (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  body   TEXT NOT NULL,
  pushed INTEGER
);
CREATE TABLE IF NOT EXISTS sent_ids (
  id TEXT PRIMARY KEY
);

-- AI calls: cost and outcome, for /status and the daily cap
CREATE TABLE IF NOT EXISTS calls (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  model    TEXT,
  purpose  TEXT,
  cost_usd REAL,
  ok       INTEGER,
  -- the answer's text, ok or not, sealed with BIBLE_KEY (it holds the story); at most RAW_MAX chars.
  -- A database made before 2026-10-22 gets these two columns on the first call (src/store.js).
  raw      TEXT,
  note     TEXT
);

-- the season's bible, sealed with BIBLE_KEY (src/crypto.js); one row per season
CREATE TABLE IF NOT EXISTS bible (
  season TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  at     INTEGER NOT NULL
);

-- what players wrote (backstories, chapter pages), raw, until the story uses it (docs/04 rule 5)
CREATE TABLE IF NOT EXISTS motifs (
  id     TEXT PRIMARY KEY,
  player TEXT,
  kind   TEXT,
  text   TEXT NOT NULL,
  used   INTEGER NOT NULL DEFAULT 0,
  at     INTEGER NOT NULL
);
