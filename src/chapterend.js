/**
 * The end of a chapter, for everyone (docs/13, Teko 2026-10-22). The player who picks the piece
 * up closes the chapter for the whole server:
 *
 *   finder        the chapter page (grant_page, written ahead in the closing reaction)
 *   near          players who took part in the chapter (src/collab.js: rings entered, notes
 *                 read, diary written, pieces picked): a short record in their diary
 *   far           every other player seen in this story: an echo of the discovery
 *   everyone      a "chapter ended" mark in the diary (player "$all": the mod writes it for
 *                 every player online and every account that has a diary)
 *
 * No AI call: the texts are the stage answer's `chapter_end` (docs/04), kept when the stage was
 * written, else the bridge's own lines. Diary entries are queued, written in a gap of each
 * player's own play (ZTales_DiaryPace), never the moment it happens.
 */
import { missingLanguages } from "./gates.js";

export const CHAPTER_END_MAX_CHARS = 400;
const URL_RE = /\b(https?:\/\/|www\.)/i;

// the bridge's lines when the AI wrote none (the game's own languages; others read English)
const FALLBACK = {
  record: {
    en: "I was close when it was found. One part of this is over now, and I was there for it. I keep thinking of what comes next.",
    "pt-br": "Eu estava perto quando acharam. Uma parte disto acabou, e eu estava lá. Não paro de pensar no que vem depois.",
  },
  echo: {
    en: "Word reached me: somebody found what that part of the story was hiding. It goes on without me, for now.",
    "pt-br": "Chegou até mim: alguém achou o que aquela parte da história escondia. Ela segue sem mim, por enquanto.",
  },
};

const per = (languages, fn) => {
  const out = {};
  for (const l of languages && languages.length ? languages : ["en"]) out[l] = fn(l);
  return out;
};

/** The bridge's line of a kind ("record" or "echo"), every language. */
export function fallbackText(kind, languages) {
  const f = FALLBACK[kind] || FALLBACK.echo;
  return per(languages, (l) => f[l] || f.en);
}

/** The diary mark everyone gets: the chapter's title when the bible has one. */
export function markText(title, languages) {
  return per(languages, (l) => {
    const t = title && typeof title === "object" ? (title[l] || title.en || Object.values(title)[0] || "") : (title || "");
    if (l === "pt-br") return t ? `Fim do capítulo "${t}". A história continua.` : "Um capítulo da história terminou. Ela continua.";
    return t ? `The chapter "${t}" has ended. The story goes on.` : "A chapter of the story has ended. It goes on.";
  });
}

/**
 * The AI's `chapter_end` ({ record, echo }, each { lang: text }) kept only where it is usable:
 * every language, at most CHAPTER_END_MAX_CHARS, no link, no name kept for later. Returns
 * { record, echo }, each the text or null (null: the bridge's line will do).
 */
export function chapterEndTexts(ce, languages, forbidden = []) {
  const bad = (forbidden || []).filter((s) => typeof s === "string" && s.length >= 3).map((s) => s.toLowerCase());
  const ok = (v) => {
    if (!v || (typeof v !== "object" && typeof v !== "string")) return null;
    const value = typeof v === "string" ? { [(languages && languages[0]) || "en"]: v } : v;
    if (missingLanguages(value, languages).length) return null;
    const all = Object.values(value).filter((x) => typeof x === "string");
    if (!all.length || all.some((x) => !x.trim() || x.length > CHAPTER_END_MAX_CHARS || URL_RE.test(x))) return null;
    if (bad.length && all.some((x) => bad.some((f) => x.toLowerCase().includes(f)))) return null;
    return value;
  };
  return { record: ok(ce?.record), echo: ok(ce?.echo) };
}

/** Players who appear in these events (a story's tally of who was around). */
export function playersIn(events, into = []) {
  const out = [...into];
  for (const e of events || []) {
    const p = e && typeof e.player === "string" ? e.player : null;
    if (p && p !== "$player" && !out.includes(p)) out.push(p);
  }
  return out.slice(-300);
}

/**
 * The directives of one chapter's end.
 *   season, node      the chapter that closed
 *   finder            who picked its piece up (null when unknown: everyone else is near or far)
 *   near              players who took part in the chapter
 *   seen              every player seen in the story
 *   texts             { record, echo, title } kept from the stage (chapterEndTexts + the bible's title)
 */
export function chapterEndDirectives({ season = "", node, finder = null, near = [], seen = [], texts = {}, languages = ["en"] }) {
  if (!node) return [];
  const P = `${season ? `${season}_` : ""}end_${node}`;
  const record = texts?.record || fallbackText("record", languages);
  const echo = texts?.echo || fallbackText("echo", languages);
  const out = [];
  const nearSet = new Set((near || []).filter((p) => p && p !== finder));
  for (const p of nearSet) {
    out.push({ id: `${P}_rec_${p}`, type: "diary_entry", player: p, kind: "chapter_record", node, text: record });
  }
  for (const p of seen || []) {
    if (!p || p === finder || nearSet.has(p)) continue;
    out.push({ id: `${P}_echo_${p}`, type: "diary_entry", player: p, kind: "chapter_echo", node, text: echo });
  }
  out.push({ id: `${P}_mark`, type: "diary_entry", player: "$all", kind: "chapter_end", node, text: markText(texts?.title, languages) });
  return out;
}

/**
 * The chapters these events closed: a node_changed off a chapter of the axis (the last one ends
 * at the urn, never here), each once per story. Returns [{ node, finder }].
 *   piecesByNode   [{ node, ids }] (state.pieces_by_node); done: ["<season>:<node>"]
 *   register       the pieces register (src/pieces.js, { story_id: { holder } }), after these
 *                  events: who holds the piece when the pick-up came in an earlier tick (the mod
 *                  writes its events in batches; live run 2026-10-22, a new life picked chapter
 *                  2's piece one tick before the node moved and the end said "finder unknown")
 */
export function closedChapters(events, piecesByNode, season, done = [], register = {}) {
  const nodes = (piecesByNode || []).map((n) => n.node);
  const last = nodes[nodes.length - 1];
  const ids = new Map((piecesByNode || []).map((n) => [n.node, new Set(n.ids || [])]));
  const seenDone = new Set(done || []);
  const out = [];
  const pickedBy = new Map();   // story_id -> who picked it up last
  const firedBy = new Map();
  for (const e of events || []) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "item_picked" && typeof e.story_id === "string" && e.player) pickedBy.set(e.story_id, e.player);
    if (e.type === "reaction_fired" && e.stage && e.player && e.by_event === "item_picked") firedBy.set(e.stage, e.player);
    if (e.type !== "node_changed" || !e.from || e.from === e.to) continue;
    const from = String(e.from);
    if (!ids.has(from) || from === last || seenDone.has(`${season}:${from}`)) continue;
    // the finder: who picked this chapter's piece up (in this tick, else as the register has it),
    // else whose pick fired its reaction
    const piece = [...ids.get(from)].find((sid) => pickedBy.has(sid));
    const held = [...ids.get(from)].map((sid) => register?.[sid]).find((p) => p && p.holder && (p.status === "held" || p.status === undefined));
    const finder = piece ? pickedBy.get(piece) : firedBy.get(from) || held?.holder || null;
    seenDone.add(`${season}:${from}`);
    out.push({ node: from, finder });
  }
  return out;
}
