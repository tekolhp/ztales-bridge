/**
 * The finder's chapter page, judged (docs/13 item 5, Teko 2026-10-22). The AI scores the page in
 * the stage call it already makes (no extra call): `contribution: { player, score, why }`, 0
 * shallow to 3 strong (it interprets, suspects, links clues). A score of ExtraChapterScore (3)
 * opens an EXTRA chapter grown from what that player wrote: the AI writes it in the same answer,
 * `extra_chapter: { question, piece, way_back }`; the bridge places its one extra piece (yellow,
 * titled, apart from every other piece). It never blocks the spine, and its piece counts as an
 * extra at the urn and in the season's Final Tale tally.
 *
 * collab.js's mechanical score is only the fallback: a chapter whose page reached the AI without
 * a score, a chapter whose finder never wrote (another chapter closed since), and, on the final
 * stage (no stage call comes after it), every chapter still undecided.
 */
import { missingLanguages } from "./gates.js";
import { familyOf } from "./collab.js";
import { hasCoordinates } from "./watch.js";

export const PAGE_SCORE_MAX = 3;
export const EXTRA_CHAPTER_SCORE = 3;
export const PAGES_MAX = 30;
export const QUESTION_MAX_CHARS = 400;
export const PIECE_TEXT_MAX_CHARS = 1500;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strs = (v) => (typeof v === "string" ? [v] : isObj(v) ? Object.values(v).filter((x) => typeof x === "string") : []);

/** seq.json's `extra_chapter_score`, clamped to 1..3; the default when missing. */
export function scoreMin(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(PAGE_SCORE_MAX, n) : EXTRA_CHAPTER_SCORE;
}

/** Chapter pages written (journal entries of kind "chapter") kept until scored: [{ id, player, chapter, season }]. */
export function notePages(prev, events, season) {
  const out = (Array.isArray(prev) ? prev : []).filter((p) => p && p.season === season);
  for (const e of events || []) {
    if (!e || e.type !== "journal" || e.kind !== "chapter" || typeof e.chapter !== "string" || !e.chapter) continue;
    if (typeof e.player !== "string" || !e.player || typeof e.text !== "string" || !e.text.trim()) continue;
    if (!out.some((p) => p.id === String(e.id))) out.push({ id: String(e.id), player: e.player, chapter: e.chapter, season });
  }
  return out.slice(-PAGES_MAX);
}

/**
 * Chapter pages whose writing window ran out with nothing typed (the mod's `page_faded`,
 * ChapterPageHours): ["season:chapter"], kept a while. A faded page is a page not written: it is
 * never scored and opens nothing; it only tells the next stage it need not wait (story.js).
 */
export function noteFaded(prev, events, season) {
  const out = Array.isArray(prev) ? prev.filter((k) => typeof k === "string") : [];
  for (const e of events || []) {
    if (!e || e.type !== "page_faded" || typeof e.chapter !== "string" || !e.chapter) continue;
    const key = `${season}:${e.chapter}`;
    if (!out.includes(key)) out.push(key);
  }
  return out.slice(-PAGES_MAX);
}

/**
 * The AI's `contribution` (one object, or a list) -> the scores matched to a page waiting:
 * [{ player, chapter, page, score, why }], one per chapter. Anything else is ignored.
 */
export function readContributions(c, pages) {
  const out = [];
  for (const x of Array.isArray(c) ? c : [c]) {
    if (!isObj(x)) continue;
    const score = Number(x.score);
    if (!Number.isInteger(score) || score < 0 || score > PAGE_SCORE_MAX) continue;
    const page = (pages || []).find((p) => p.player === x.player && (!x.chapter || p.chapter === x.chapter)
      && !out.some((o) => o.chapter === p.chapter));
    if (!page) continue;
    out.push({ player: page.player, chapter: page.chapter, page: page.id, score,
      why: typeof x.why === "string" ? x.why.slice(0, 300) : "" });
  }
  return out;
}

/**
 * Which closed chapters have their extras decided now, and how.
 *   closed     the story's closed chapters, in axis order
 *   decided    { chapter: {...} } already decided
 *   pages      the pages that reached the AI in this call
 *   contribs   readContributions(...)
 *   final      the final stage is being written (no stage call after it)
 * Returns [{ chapter, by: "ai", player, score, why } | { chapter, by: "collab" }]; a chapter not
 * listed waits (its page may still come).
 */
export function planExtras({ closed = [], decided = {}, pages = [], contribs = [], final = false }) {
  const latest = closed[closed.length - 1];
  const out = [];
  for (const c of closed) {
    if (decided[c]) continue;
    const ai = contribs.find((x) => x.chapter === c);
    if (ai) out.push({ chapter: c, by: "ai", player: ai.player, score: ai.score, why: ai.why });
    else if (final || c !== latest || pages.some((p) => p.chapter === c)) out.push({ chapter: c, by: "collab" });
  }
  return out;
}

/**
 * The AI's `extra_chapter` -> { ok, errs }. ok: { question, item, title, text, building, room, way_back }
 * with what is unusable left null (the bridge then chooses: its own title, a building near the
 * node). Unusable as a whole (no question in every language, a coordinate, a forbidden name) -> ok null.
 *   ctx: { languages, forbidden, axisIds, freePlaces: Map id -> place, families }
 */
export function checkExtraChapter(ec, { languages = ["en"], forbidden = [], axisIds = [], freePlaces = new Map(), families = [] } = {}) {
  const errs = [];
  if (!isObj(ec)) return { ok: null, errs: ["no extra_chapter"] };
  const bad = (forbidden || []).filter((s) => typeof s === "string" && s.length >= 3).map((s) => s.toLowerCase());
  const clean = (v, max) => {
    const all = strs(v);
    if (!all.length || all.some((x) => !x.trim())) return "empty";
    if (missingLanguages(v, languages).length) return `lacks ${missingLanguages(v, languages).join(", ")}`;
    if (all.some((x) => x.length > max)) return `longer than ${max}`;
    if (all.some(hasCoordinates)) return "gives coordinates";
    if (bad.length && all.some((x) => bad.some((f) => x.toLowerCase().includes(f)))) return "names what must not be named yet";
    return null;
  };
  const qErr = clean(ec.question, QUESTION_MAX_CHARS);
  if (qErr) return { ok: null, errs: [`extra_chapter question ${qErr}`] };
  const piece = isObj(ec.piece) ? ec.piece : {};
  const family = familyOf(piece.item, families) || null;
  if (!family) errs.push("extra_chapter piece item is not a clue item: a Photo will do");
  const titleErr = piece.title === undefined ? "missing" : clean(piece.title, 120);
  if (titleErr) errs.push(`extra_chapter piece title ${titleErr}: the bridge's will do`);
  const textErr = piece.text === undefined ? null : clean(piece.text, PIECE_TEXT_MAX_CHARS);
  if (textErr) errs.push(`extra_chapter piece text ${textErr}: dropped`);
  const target = isObj(piece.target) ? piece.target : {};
  const bid = typeof target.building === "string" ? target.building : typeof piece.building === "string" ? piece.building : null;
  const place = bid ? freePlaces.get(bid) : null;
  if (bid && !place) errs.push(`extra_chapter building ${bid} is not free near the node: the bridge chooses`);
  const room = place && typeof target.room === "string" && (place.rooms || []).includes(target.room) ? target.room : (place?.rooms || [])[0] || null;
  const wayBack = typeof ec.way_back === "string" && axisIds.includes(ec.way_back) ? ec.way_back : null;
  if (ec.way_back !== undefined && !wayBack) errs.push(`extra_chapter way_back ${ec.way_back} is not a chapter of the story`);
  return {
    ok: { question: ec.question, family: family || "Photo", title: titleErr ? null : piece.title, text: textErr || piece.text === undefined ? null : piece.text,
      building: place ? bid : null, room: place ? room : null, way_back: wayBack },
    errs,
  };
}
