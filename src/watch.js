/**
 * Watching each player (docs/13 item 4, Teko 2026-10-22). Every player's play is cut into blocks
 * of WatchBlockHours (12) REAL hours played: the mod counts, per player, the real seconds online
 * and active (outbox/seq.json `active`, src ZTales_Journey.lua); an idle or absent player adds
 * nothing. Never a wall-clock timer.
 *
 * When a block closes, the bridge asks the chapter model once (task "watch"; blocks closing in
 * the same tick go in one call) for that player only: a hint fitted to what they did, plainer the
 * longer the chapter has stood, a short record of their stretch, or nothing. Gated here: only a
 * diary_entry for the players asked, every language, no coordinates, no forbidden name, paced
 * (never delivered on the spot).
 */
import { gateBatch } from "./gates.js";

export const WATCH_BLOCK_HOURS = 12;
export const WATCH_HOURS_MIN = 1;
export const WATCH_HOURS_MAX = 72;
/** A closed block nobody could answer for two days (no story, the AI away) is dropped. */
export const WATCH_TTL_SEC = 2 * 86400;
/** At most this many blocks in one call (the rest wait for the next tick). */
export const WATCH_MAX_PER_CALL = 8;
export const WATCH_MAX_CHARS = 600;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** seq.json's `watch_block_hours`, clamped; the default when missing. */
export function blockHours(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return WATCH_BLOCK_HOURS;
  return Math.min(WATCH_HOURS_MAX, Math.max(WATCH_HOURS_MIN, n));
}

/** seq.json's `active` -> { player: seconds }; anything else is dropped. */
export function cleanActive(doc) {
  const out = {};
  if (!isObj(doc)) return out;
  for (const [k, v] of Object.entries(doc)) {
    const n = Number(v);
    if (typeof k === "string" && k && !k.startsWith("$") && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

/**
 * Blocks after this tick. prev: { player: { start, since } } (start: the player's active seconds
 * when the block opened; since: the bridge's epoch then). A player seen for the first time opens
 * a block at their current count (a bridge installed late never closes a backlog at once). A
 * count that went down (the server's data reset) opens a fresh block. At most one block closes
 * per player per tick. Returns { blocks, closed: [{ player, from, to, seconds }] }.
 */
export function updateBlocks(prev, active, nowSec, hours = WATCH_BLOCK_HOURS) {
  const need = blockHours(hours) * 3600;
  const blocks = { ...(isObj(prev) ? prev : {}) };
  const closed = [];
  for (const [player, sec] of Object.entries(active || {})) {
    const b = blocks[player];
    if (!b || !(sec >= b.start)) { blocks[player] = { start: sec, since: nowSec }; continue; }
    if (sec - b.start >= need) {
      closed.push({ player, from: b.since, to: nowSec, seconds: sec - b.start });
      blocks[player] = { start: sec, since: nowSec };
    }
  }
  return { blocks, closed };
}

/** The blocks still owed an answer: the earlier ones (expired dropped) plus the new ones. */
export function dueBlocks(prev, closed, nowSec) {
  const out = (Array.isArray(prev) ? prev : []).filter((b) => b && nowSec - (b.to || 0) < WATCH_TTL_SEC);
  for (const c of closed || []) if (!out.some((b) => b.player === c.player && b.to === c.to)) out.push(c);
  return out;
}

const epochOf = (e) => {
  const t = e && typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
/** An event inside [from, to] (a few minutes of slack: the mod's clock and ours). An event without
 *  a time counts: it reached the bridge, so it happened before `to`. */
const inBlock = (e, from, to) => {
  const t = epochOf(e);
  return t == null || (t >= from - 600 && t <= to + 600);
};

/**
 * What one player did in one block, for the AI: their journeys (where they went, what they
 * fought, with whom, how they felt), what they wrote in their diary, and the places visited.
 */
export function blockMaterial(events, { player, from, to }) {
  const journeys = [];
  const diary = [];
  const places = new Set();
  const regions = new Set();
  for (const e of events || []) {
    if (!e || e.player !== player || !inBlock(e, from, to)) continue;
    if (e.type === "player_journey") {
      journeys.push({ from: e.from, to: e.to, online_minutes: e.online_minutes, regions: e.regions, named_places: e.named_places,
        walked_tiles: e.walked_tiles, driven_tiles: e.driven_tiles, zombies_killed: e.zombies_killed, companions: e.companions,
        died: e.died, moods: e.moods, moods_end: e.moods_end, profession: e.profession, char: e.char });
      for (const p of Array.isArray(e.named_places) ? e.named_places : []) places.add(String(p));
      for (const r of Array.isArray(e.regions) ? e.regions : []) regions.add(String(r));
    } else if (e.type === "journal" && typeof e.text === "string" && e.text.trim()) {
      diary.push({ kind: e.kind ?? null, chapter: e.chapter ?? null, text: e.text.slice(0, 1200) });
    }
  }
  return { player, hours: Math.round(((to - from) / 3600) * 10) / 10, journeys: journeys.slice(-12), diary: diary.slice(-6),
    places: [...places].slice(0, 30), regions: [...regions].slice(0, 12) };
}

// a map coordinate written out ("10650, 9650", "x 10650", "at 10650/9650") or a building id
const COORDS_RE = /\b\d{4,5}\s*[,;/x×]\s*\d{4,5}\b|\b[xy]\s*[:=]?\s*\d{4,5}\b|\bb_\d+_\d+\b/i;
export function hasCoordinates(text) {
  return COORDS_RE.test(String(text || ""));
}

const textsOf = (v) => (typeof v === "string" ? [v] : isObj(v) ? Object.values(v).filter((x) => typeof x === "string") : []);

/**
 * The AI's watch answer -> { accepted, rejections }. Only `diary_entry` for a player asked, one
 * each; ids are the bridge's (`<season>_watch_<player>_<to>`), delivered paced (the diary's own
 * gap, never "now"); kind "watch_hint" or "watch_record".
 *   asked: Map player -> block; storyIds: Set of piece ids (never written in a diary line)
 */
export function gateWatch(answer, { asked, season = "", languages = ["en"], forbidden = [], storyIds = new Set(), pushedIds = new Set() }) {
  const rejections = [];
  const wanted = [];
  const done = new Set();
  for (const d of Array.isArray(answer?.directives) ? answer.directives : []) {
    const id = isObj(d) && typeof d.id === "string" ? d.id : "?";
    if (!isObj(d) || d.type !== "diary_entry") { rejections.push({ id, reason: "only diary_entry in a watch task" }); continue; }
    const block = asked.get(d.player);
    if (!block) { rejections.push({ id, reason: `no block of ${d.player} was asked` }); continue; }
    if (done.has(d.player)) { rejections.push({ id, reason: `one entry per player: ${d.player} already has one` }); continue; }
    const all = textsOf(d.text);
    if (!all.length || all.some((x) => !x.trim())) { rejections.push({ id, reason: "diary_entry without text" }); continue; }
    if (all.some((x) => x.length > WATCH_MAX_CHARS)) { rejections.push({ id, reason: `longer than ${WATCH_MAX_CHARS} characters` }); continue; }
    if (all.some(hasCoordinates)) { rejections.push({ id, reason: "a diary never gives coordinates or a building id" }); continue; }
    if (all.some((x) => [...storyIds].some((s) => s && x.includes(s)))) { rejections.push({ id, reason: "names a piece's id" }); continue; }
    const kind = /record/.test(String(d.kind || "")) ? "watch_record" : "watch_hint";
    // only the fields a diary entry needs; no `deliver`: paced, written in a gap of their own play
    wanted.push({ id: `${season ? `${season}_` : ""}watch_${d.player}_${block.to}`, type: "diary_entry", kind, player: d.player,
      text: d.text, ...(block.node ? { node: block.node } : {}) });
    done.add(d.player);
  }
  const g = gateBatch(wanted, { pushedIds, languages, forbidden });
  return { accepted: g.accepted, rejections: [...rejections, ...g.rejected] };
}
