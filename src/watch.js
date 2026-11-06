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
import { compass, normalize, signHit } from "./clues.js";
import { repeatErrors } from "./anchors.js";

export const WATCH_BLOCK_HOURS = 12;
export const WATCH_HOURS_MIN = 1;
export const WATCH_HOURS_MAX = 72;
/** A closed block nobody could answer for two days (no story, the AI away) is dropped. */
export const WATCH_TTL_SEC = 2 * 86400;
/** At most this many blocks in one call (the rest wait for the next tick). */
export const WATCH_MAX_PER_CALL = 8;
export const WATCH_MAX_CHARS = 600;
/** Calls per block (Teko, 2026-10-28): the first and at most two retries, each told what was wrong. */
export const WATCH_MAX_CALLS = 3;

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
  let where = null;
  for (const e of events || []) {
    if (!e || e.player !== player || !inBlock(e, from, to)) continue;
    // where the block happened: the player's last event with a position (journeys carry none)
    if (typeof e.x === "number" && typeof e.y === "number" && (e.x || e.y)) where = { x: e.x, y: e.y };
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
    places: [...places].slice(0, 30), regions: [...regions].slice(0, 12), ...(where ? { where } : {}) };
}

const shortName = (n) => String(n || "").split(",")[0].trim();
// the game writes some regions run together ("WestPoint") and players and the AI write them apart
// ("West Point"): both spellings are one place (simulation 2026-11-04: a report naming the player's
// own West Point was refused as "another town")
const squash = (n) => normalize(shortName(n)).replace(/ /g, "");
const sameName = (a, b) => !!a && !!b && squash(a) === squash(b);
const spellings = (n) => [...new Set([n, String(n || "").replace(/([a-z])([A-Z])/g, "$1 $2")])];

/**
 * Where the chapter's piece is, seen from one player's block (Teko, 2026-10-28: the hints of a group
 * living in West Point read as if the mystery were there; the piece was in Riverside).
 * place: { x, y, region } (the piece's building, its centre). material: blockMaterial(...).
 * Returns { direction, distance: "near" | "across town" | "another town" | null, here: bool | null }:
 * the compass word from where the block happened, the rough band, and whether the piece's town is
 * among the towns the player went through.
 */
export function pullFor(place, material) {
  if (!place) return null;
  const regions = material?.regions || [];
  const here = place.region && regions.length ? regions.some((r) => sameName(r, place.region)) : null;
  const w = material?.where;
  let distance = null;
  let direction = null;
  if (w && Number.isFinite(place.x)) {
    const d = Math.hypot(place.x - w.x, place.y - w.y);
    direction = compass(w.x, w.y, place.x, place.y)?.[0] || null;
    distance = d <= 150 ? "near" : d <= 700 && here !== false ? "across town" : "another town";
  } else if (here != null) distance = here ? "across town" : "another town";
  return { direction, distance, here };
}

/**
 * Every town or region name the catalog knows, short forms too ("Muldraugh, KY" -> "Muldraugh"):
 * the spawn regions, the regions of the buildings loaded, and the regions the players went through.
 */
export function townNames(index, buildings = [], extra = []) {
  const out = new Set();
  const add = (n) => { for (const v of [String(n || "").trim(), shortName(n)]) if (normalize(v).trim().length >= 3) out.add(v); };
  for (const r of index?.spawn_regions || []) add(r?.name);
  for (const b of buildings) add(b?.region);
  for (const r of extra) add(r);
  return [...out];
}

// sentences: at . ! ? ; or a new line, never inside an ellipsis ("West Point, the bridge... starch" is one)
const sentencesOf = (text) => String(text || "").split(/(?<!\.)[.!?](?!\.)|[;\n]/).map((x) => x.trim()).filter(Boolean);
const holds = (norm, name) => { const n = normalize(name).trim(); return !!n && norm.includes(` ${n} `); };

/**
 * The place gate on one hint text (kind hint only; a record may name where they were):
 *  1. No town or region name but the chapter's region, the nearest named place, or the player's own
 *     towns of the block (allowed in a report sentence only, rule 2).
 *  2. A sentence that names the player's own area (a town or named place of their block, not the
 *     chapter's) never holds a sign of the chapter's place (src/clues.js factSigns): the report of
 *     the day and the thing sought stay in sentences of their own.
 * place: { region, allowed: [names], towns: [names], signs: [words] }; own: [names]. Returns reasons.
 */
export function hintPlaceErrors(text, place, own = []) {
  if (!place) return [];
  const errors = [];
  const allowed = [place.region, shortName(place.region), ...(place.allowed || [])].filter(Boolean)
    .map((n) => normalize(n).trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const strip = (norm) => { let s = norm; for (const a of allowed) s = s.split(` ${a} `).join(" | "); return s; };
  const mine = own.filter((n) => !sameName(n, place.region)).flatMap(spellings);
  const norm = strip(normalize(text));
  const other = (place.towns || []).filter((n) => holds(norm, n) && !mine.some((m) => sameName(m, n)));
  if (other.length) {
    errors.push(`a hint names "${shortName(other[0])}": the chapter's place is in ${shortName(place.region) || "another town"}; `
      + `name only ${[shortName(place.region), ...(place.allowed || [])].filter(Boolean).join(" or ")}, or no town`);
  }
  for (const s of sentencesOf(text)) {
    const n = strip(normalize(s));
    const area = mine.find((m) => holds(n, m) || holds(n, shortName(m)));
    const sign = area ? signHit(n, place.signs || []) : null;
    if (sign) {
      errors.push(`"${s.slice(0, 80)}" puts "${shortName(area)}" (where they were) and "${sign}" (what is sought) in one sentence: `
        + "report the day in plain past actions, then the pull in a sentence of its own, as a thought or feeling (But it isn't here. I keep thinking...)");
      break;
    }
  }
  return errors;
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
export function gateWatch(answer, { asked, season = "", languages = ["en"], forbidden = [], storyIds = new Set(), pushedIds = new Set(),
  place = null, own = {}, memory = null }) {
  const rejections = [];
  const wanted = [];
  const anchorOf = new Map();   // id -> the anchor it declared (kept by the bridge, never sent)
  const done = new Set();
  for (const d of Array.isArray(answer?.directives) ? answer.directives : []) {
    const id = isObj(d) && typeof d.id === "string" ? d.id : "?";
    if (!isObj(d) || d.type !== "diary_entry") { rejections.push({ id, reason: "only diary_entry in a watch task" }); continue; }
    const block = asked.get(d.player);
    if (!block) { rejections.push({ id, reason: `no block of ${d.player} was asked` }); continue; }
    if (done.has(d.player)) { rejections.push({ id, reason: `one entry per player: ${d.player} already has one` }); continue; }
    const player = d.player;
    const all = textsOf(d.text);
    if (!all.length || all.some((x) => !x.trim())) { rejections.push({ id, player, reason: "diary_entry without text" }); continue; }
    if (all.some((x) => x.length > WATCH_MAX_CHARS)) { rejections.push({ id, player, reason: `longer than ${WATCH_MAX_CHARS} characters` }); continue; }
    if (all.some(hasCoordinates)) { rejections.push({ id, player, reason: "a diary never gives coordinates or a building id" }); continue; }
    if (all.some((x) => [...storyIds].some((s) => s && x.includes(s)))) { rejections.push({ id, player, reason: "names a piece's id" }); continue; }
    const kind = /record/.test(String(d.kind || "")) ? "watch_record" : "watch_hint";
    if (kind === "watch_hint" && place) {
      const bad = all.flatMap((x) => hintPlaceErrors(x, place, own[d.player] || []));
      if (bad.length) { rejections.push({ id, player, reason: bad[0] }); continue; }
    }
    // anchor variety (src/anchors.js): a hint names the detail it hangs on, never the last ones again
    if (kind === "watch_hint" && memory) {
      const again = repeatErrors(d.text, d.anchor, memory, player);
      if (again.length) { rejections.push({ id, player, reason: again.join("; ") }); continue; }
    }
    // only the fields a diary entry needs; no `deliver`: paced, written in a gap of their own play
    wanted.push({ id: `${season ? `${season}_` : ""}watch_${d.player}_${block.to}`, type: "diary_entry", kind, player: d.player,
      text: d.text, ...(block.node ? { node: block.node } : {}) });
    anchorOf.set(wanted[wanted.length - 1].id, d.anchor ?? null);
    done.add(d.player);
  }
  const g = gateBatch(wanted, { pushedIds, languages, forbidden });
  const playerOf = new Map(wanted.map((w) => [w.id, w.player]));
  return { accepted: g.accepted, anchors: anchorOf,
    rejections: [...rejections, ...g.rejected.map((r) => ({ ...r, player: playerOf.get(r.id) }))] };
}
