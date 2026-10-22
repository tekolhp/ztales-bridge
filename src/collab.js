/**
 * Collaboration per chapter (Teko, 2026-10-21): "if a chapter's collaboration is enough to
 * create an extra item, do it, and make the number of items variable so the reward in each
 * story's urn grows". Deterministic, no AI.
 *
 * Since docs/13 item 5 (2026-10-22) the AI's score of the finder's chapter page decides a
 * chapter's extras (src/contribution.js); this tally is only the fallback, when the AI could not
 * score a page (none written, or none scored).
 *
 * The bridge tallies, per chapter (node) of the running story, what players did in it, from the
 * events the mod already sends. Each tally is a set of distinct players (or pieces), so the same
 * player reading the same note ten times counts once:
 *
 *   pieces    the node's own pieces picked up beyond the first one        2 points each
 *   pages     players who wrote the chapter's page (journal kind chapter)  2 points each
 *   helpers   players who did anything in the chapter beyond the first    2 points each
 *   readers   players who read a story note                               1 point each
 *   writers   players who wrote any other diary entry                     1 point each
 *   rings     players who walked into one of the node's proximity rings   1 point each
 *
 * Every term counts at most COLLAB_TERM_CAP (3). The score buys extra pieces for the NEXT
 * chapter: one at EXTRA_THRESHOLDS[0] (4) points, two at 8, three at 12. A careful player alone
 * reaches one (two pieces, a note, the page); a group that splits up reaches three.
 */

export const COLLAB_TERM_CAP = 3;
export const COLLAB_WEIGHTS = { pieces: 2, pages: 2, helpers: 2, readers: 1, writers: 1, rings: 1 };
export const EXTRA_THRESHOLDS = [4, 8, 12];
export const EXTRA_MAX = EXTRA_THRESHOLDS.length;
const LIST_MAX = 40;

const emptyChapter = () => ({ players: [], pieces: [], pages: [], readers: [], writers: [], rings: [] });
const add = (list, v) => (v && !list.includes(v) && list.length < LIST_MAX ? [...list, v] : list);

/**
 * The tally after these events. Pure: returns a new object.
 *   collab       the previous tally ({ season, node, chapters: { node: {...} } }) or null
 *   ctx.season   the story running now: a tally of another story starts over
 *   ctx.node     the node the story stands on (used until a node_changed says otherwise)
 *   ctx.piecesByNode [{ node, ids }]: which node a piece belongs to
 */
export function updateCollab(collab, events, { season = "", node = null, piecesByNode = [] } = {}) {
  const fresh = !collab || collab.season !== season;
  const out = { season, node: fresh ? node : (collab.node || node), chapters: {} };
  if (!fresh) for (const [k, v] of Object.entries(collab.chapters || {})) out.chapters[k] = { ...emptyChapter(), ...v };
  const nodeOf = new Map();
  for (const n of piecesByNode || []) for (const id of n.ids || []) nodeOf.set(id, n.node);
  const ch = () => {
    if (!out.node) return null;
    out.chapters[out.node] = out.chapters[out.node] || emptyChapter();
    return out.chapters[out.node];
  };
  for (const e of events || []) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "node_changed" && e.to) { out.node = String(e.to); continue; }
    const c = ch();
    if (!c) continue;
    const who = typeof e.player === "string" && e.player ? e.player : null;
    const act = () => { if (who) c.players = add(c.players, who); };
    if (e.type === "item_picked" && typeof e.story_id === "string") {
      act();
      if (nodeOf.get(e.story_id) === out.node) c.pieces = add(c.pieces, e.story_id);
    } else if (e.type === "note_read" && typeof e.story_id === "string") {
      act(); c.readers = add(c.readers, who);
    } else if (e.type === "journal" || e.type === "journal_entry") {
      act();
      if (e.kind === "chapter") c.pages = add(c.pages, who);
      else c.writers = add(c.writers, who);
    } else if (e.type === "zone_entered" && typeof e.story_id === "string" && e.story_id.includes(`prox_${out.node}_`)) {
      act(); c.rings = add(c.rings, who);
    }
  }
  return out;
}

/** A chapter's score and how it was made: { score, parts }. */
export function collabScore(chapter) {
  const c = { ...emptyChapter(), ...(chapter || {}) };
  const counts = {
    pieces: Math.max(0, c.pieces.length - 1),
    pages: c.pages.length,
    helpers: Math.max(0, c.players.length - 1),
    readers: c.readers.length,
    writers: c.writers.filter((p) => !c.pages.includes(p)).length,
    rings: c.rings.length,
  };
  const parts = {};
  let score = 0;
  for (const [k, w] of Object.entries(COLLAB_WEIGHTS)) {
    parts[k] = Math.min(COLLAB_TERM_CAP, counts[k]) * w;
    score += parts[k];
  }
  return { score, parts };
}

/** How many extra pieces a score buys: 0..EXTRA_MAX. */
export function extraCount(score) {
  return EXTRA_THRESHOLDS.filter((t) => score >= t).length;
}

function hashOf(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}

/** The clue family of an item ("ZTales.PhotoGreen" -> "Photo"), or null for anything else. */
export function familyOf(item, families) {
  const m = /^ZTales\.([A-Za-z]+?)(Green|Yellow|Red)$/.exec(String(item || ""));
  return m && families.includes(m[1]) ? m[1] : null;
}

// what an extra piece is called, per family (the game's own languages; others read English)
const EXTRA_TITLES = {
  Note: ["Another page, in the same hand", "Outra página, com a mesma letra"],
  Map: ["Another map, folded the same way", "Outro mapa, dobrado do mesmo jeito"],
  Key: ["Another key on the same ring", "Outra chave do mesmo chaveiro"],
  Photo: ["Another photo from the same roll", "Outra foto do mesmo filme"],
  Cassette: ["Another tape, the same label", "Outra fita, o mesmo rótulo"],
  VHS: ["Another videotape, the same label", "Outra fita de vídeo, o mesmo rótulo"],
  Walkie: ["Another radio, the same channel", "Outro rádio, o mesmo canal"],
  PartA: ["Another piece of the same thing", "Outro pedaço da mesma coisa"],
  PartB: ["Another piece of the same thing", "Outro pedaço da mesma coisa"],
  PartC: ["Another piece of the same thing", "Outro pedaço da mesma coisa"],
};
export function extraTitle(family, languages) {
  const [en, pt] = EXTRA_TITLES[family] || EXTRA_TITLES.PartA;
  const out = {};
  for (const l of languages && languages.length ? languages : ["en"]) out[l] = l === "pt-br" ? pt : en;
  return out;
}

/** Where a placing directive puts its item, as a key two pieces must never share. */
export function spotOf(target) {
  if (!target || typeof target !== "object") return null;
  if (typeof target.x === "number" && typeof target.y === "number") return { kind: "xy", key: `${target.x},${target.y},${target.z || 0}` };
  if (typeof target.building === "string") return { kind: "building", building: target.building, room: target.room || null };
  return null;
}

/** Do two spots risk the same square or container? Same building with the same room, or
 *  either without a room (the mod may then pick any container of the building). */
export function sameSpot(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "xy") return a.key === b.key;
  return a.building === b.building && (!a.room || !b.room || a.room === b.room);
}

/**
 * The extra pieces for a chapter. Each is a yellow item of a family the chapter's own pieces use,
 * in a building offered near the node that holds no piece of the node (so never the same square
 * or container), one building each. Optional: the urn never requires them.
 *   node, count, prefix ("s1_"), pieces (the node's bible pieces), places (catalog candidates),
 *   taken (building ids holding a piece of the node), center [x, y], languages, families,
 *   start (the first number: extras already placed on this node + 1)
 * Returns { directives, notes }.
 */
export function extraDirectives({ node, count, prefix = "", pieces = [], places = [], taken = [], center = null,
  languages = ["en"], families = [], maxDistance = 200, start = 1 }) {
  const notes = [];
  if (!node || !(count > 0)) return { directives: [], notes };
  let fams = [...new Set(pieces.map((p) => familyOf(p.item, families)).filter(Boolean))];
  if (!fams.length) fams = ["Photo"];
  const busy = new Set(taken);
  const xyOf = (id) => { const m = /^b_(\d+)_(\d+)$/.exec(String(id)); return m ? [Number(m[1]) + 4, Number(m[2]) + 4] : null; };
  const near = (places || []).filter((p) => p && p.id && !busy.has(p.id)).map((p) => {
    const xy = xyOf(p.id);
    const d = center && xy ? Math.hypot(xy[0] - center[0], xy[1] - center[1]) : (p.distance ?? 0);
    return { p, d };
  }).filter((x) => x.d <= maxDistance).sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));
  const directives = [];
  // numbered on from `start`: a node may host the extras of more than one closed chapter
  for (let k = start; k < start + count; k++) {
    if (!near.length) { notes.push(`${node}: no free building near the node for extra piece ${k}`); break; }
    // a few nearest, one drawn by the id (a retried stage draws the same)
    const pool = near.slice(0, 4);
    const pick = pool[hashOf(`${prefix}${node}|${k}`) % pool.length];
    near.splice(near.indexOf(pick), 1);
    const family = fams[(k - start) % fams.length];
    const sid = `${prefix}${node}_extra${k}`;
    const room = (pick.p.rooms || [])[0];
    directives.push({ id: sid, type: "place_item", story_id: sid, item: `ZTales.${family}Yellow`,
      title: extraTitle(family, languages), node, mod_data: { node, extra: true },
      target: { building: pick.p.id, ...(room ? { room } : {}) } });
  }
  return { directives, notes };
}
