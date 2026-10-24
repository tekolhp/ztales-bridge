/**
 * Deterministic gates. Everything the AI writes passes through here before it reaches the server;
 * a rule enforced here cannot be talked around in a prompt. Pure functions, no I/O.
 *
 * gateBatch(directives, ctx) -> { accepted: [...], rejected: [{ id, reason }], notes: [...] }
 *   ctx.pushedIds        Set of ids already sent (never resend one: the mod would ignore it anyway)
 *   ctx.knownStoryIds    Set of story ids that exist (bible pieces, placed items)
 *   ctx.forbidden        strings the players must not read yet (bible names of later nodes)
 *   ctx.facts            ledger: [{ fact, text }] (reveals must point at known facts or new ones)
 *   ctx.allowedBuildings Set of building ids the AI was offered or already used (catalog.js)
 *   ctx.allowItem        (fullType) -> true | reason (loot.js: the loot gate)
 *   ctx.languages        languages players use (seq.json); with more than one, every text a
 *                        player reads must be { lang: text } holding all of them
 *   ctx.placeRule        (target) -> reason | null; the final node's rule (catalog.finalPlaceRule)
 */
import { DIRECTIVE_TYPES, REACTION_EVENTS, FOCAL_TYPES, FOCAL_MAX_RADIUS, CHAT_MAX_CHARS, ECHO_MAX_CHARS, TEXT_FIELDS, DELAY_MAX_SEC } from "./protocol.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Every string inside a directive, for the leak and content checks. */
function texts(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => texts(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => texts(x, out));
  return out;
}

// what players read, for the leak check: never ids, types, events or targets (a bible that
// forbade the word "stall" rejected every stall reaction by its own event name, 2026-10-22)
const NOT_READ = new Set(["id", "type", "when", "story_id", "item", "target", "stage", "once", "player", "node",
  "chapter", "next", "sound", "building", "room", "container_pref", "family", "keep", "reaction", "slot", "sprite"]);
function readTexts(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => readTexts(x, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) if (!NOT_READ.has(k)) readTexts(x, out);
  return out;
}

const URL_RE = /\b(https?:\/\/|www\.)/i;

/** The languages a text field lacks; [] when complete. A plain string covers one language only. */
export function missingLanguages(value, languages) {
  if (!Array.isArray(languages) || languages.length <= 1) return [];
  if (!isObj(value)) return [...languages];
  return languages.filter((l) => typeof value[l] !== "string" || !value[l].trim());
}

/** The shown text of a field, for length checks: its longest version. */
function longest(value) {
  if (typeof value === "string") return value;
  if (isObj(value)) return Object.values(value).filter((v) => typeof v === "string").sort((a, b) => b.length - a.length)[0] || "";
  return "";
}

/** Items a directive would put in the world: its own, and what a zombie or corpse carries. */
function itemsOf(d) {
  const out = [];
  if (typeof d.item === "string") out.push(d.item);
  for (const it of Array.isArray(d.inventory) ? d.inventory : []) if (it && typeof it.item === "string") out.push(it.item);
  return out;
}

/** Item names start with a capital, like the game's own ("Photo of a woman at a radio"). */
const capFirst = (s) => (typeof s === "string" && s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);
function capitalizeTitle(d) {
  if (typeof d.title === "string") d.title = capFirst(d.title);
  else if (isObj(d.title)) for (const k of Object.keys(d.title)) d.title[k] = capFirst(d.title[k]);
}

/** Problems with one plain (non-reaction) directive; [] when fine. May clamp in place (notes). */
function checkPlain(d, notes, ctx = {}) {
  const errs = [];
  if (!isObj(d)) return ["not an object"];
  if (d.type === "place_item" || d.type === "write_note" || d.type === "write_map") capitalizeTitle(d);
  // the chapter a page or a closing belongs to: the AI names the node, rarely the chapter (live
  // run 2026-10-21, both rejected in game); the node is the chapter (one chapter per node)
  if ((d.type === "close_chapter" || d.type === "grant_page") && isObj(d) && !(typeof d.chapter === "string" && d.chapter)) {
    const node = typeof d.node === "string" && d.node ? d.node : ctx.node;
    if (node) { d.chapter = node; notes?.push?.(`${d.id}: chapter set to ${node}`); } else errs.push(`${d.type} without chapter`);
  }
  if (typeof d.id !== "string" || !d.id) errs.push("missing id");
  if (!DIRECTIVE_TYPES.has(d.type)) errs.push(`unknown type ${d.type}`);
  if (d.type === "chat") {
    const t = longest(d.text);
    if (!t.trim()) errs.push("chat without text");
    else if (t.length > CHAT_MAX_CHARS) errs.push(`chat longer than ${CHAT_MAX_CHARS}`);
  }
  if (d.type === "diary_echo") {
    if (typeof d.player !== "string" || !d.player) errs.push("diary_echo without player");
    if (!Number.isInteger(d.life) || d.life < 2) errs.push("diary_echo needs the life it is for (2 or more)");
    const t = longest(d.text);
    if (!t.trim()) errs.push("diary_echo without text");
    else if (t.length > ECHO_MAX_CHARS) errs.push(`diary_echo longer than ${ECHO_MAX_CHARS}`);
  }
  for (const f of TEXT_FIELDS) {
    if (d[f] === undefined || d[f] === null || d[f] === "") continue;
    if (typeof d[f] === "string" && /^\$[a-z_]+(:\d+)?$/.test(d[f])) continue;   // a mod token ("$reveal"): its own translated line
    const miss = missingLanguages(d[f], ctx.languages);
    if (miss.length) errs.push(`${f} lacks ${miss.join(", ")}`);
  }
  if (d.delay !== undefined) {
    const v = Number(d.delay);
    if (!Number.isFinite(v)) { notes.push(`${d.id}: delay dropped (not a number)`); delete d.delay; }
    else if (v < 0 || v > DELAY_MAX_SEC) { notes.push(`${d.id}: delay clamped to 0..${DELAY_MAX_SEC}`); d.delay = Math.max(0, Math.min(DELAY_MAX_SEC, v)); }
  }
  if (FOCAL_TYPES.has(d.type) && isObj(d.target) && typeof d.target.radius === "number" && d.target.radius > FOCAL_MAX_RADIUS) {
    notes.push(`${d.id}: radius ${d.target.radius} clamped to ${FOCAL_MAX_RADIUS} (focal action)`);
    d.target.radius = FOCAL_MAX_RADIUS;
  }
  for (const s of texts(d)) {
    if (URL_RE.test(s)) { errs.push("contains a link"); break; }
  }
  // a lost piece placed again (docs/10 2.6) goes back where its own node was, spawn town or not
  if (ctx.placeRule && isObj(d.target) && d.type !== "define_zone" && !d.relost) {
    const why = ctx.placeRule(d.target);
    if (why) errs.push(why);
  }
  const b = isObj(d.target) ? d.target.building : undefined;
  if (b !== undefined && ctx.allowedBuildings && !ctx.allowedBuildings.has(b)) errs.push(`building ${b} was not offered`);
  if (ctx.allowItem) {
    for (const it of itemsOf(d)) {
      const ok = ctx.allowItem(it);
      if (ok !== true) errs.push(typeof ok === "string" ? ok : `item ${it} not allowed`);
    }
  }
  return errs;
}

function checkReaction(r, ctx, notes) {
  const errs = [];
  if (!isObj(r.when) || typeof r.when.event !== "string") return ["reaction without when.event"];
  if (!REACTION_EVENTS.has(r.when.event)) errs.push(`reaction waits for unknown event ${r.when.event}`);
  if (!Array.isArray(r.then) || r.then.length === 0) return [...errs, "reaction without then"];
  const once = r.once;
  if (once !== undefined && once !== "server" && once !== "player" && !(Number.isInteger(once) && once >= 1)) {
    errs.push(`bad once ${once}`);
  }
  if (r.stage !== undefined && typeof r.stage !== "string") errs.push("bad stage");
  if (typeof r.when.story_id === "string" && ctx.knownStoryIds && !ctx.knownStoryIds.has(r.when.story_id)) {
    errs.push(`waits for story id ${r.when.story_id}, which no piece has`);
  }
  r.then.forEach((t, i) => {
    if (isObj(t) && t.type === "reaction") { errs.push(`then[${i}] is a reaction`); return; }
    // a reaction's closing belongs to the node it is staged on
    for (const e of checkPlain(t, notes, typeof r.stage === "string" ? { ...ctx, node: r.stage } : ctx)) errs.push(`then[${i}]: ${e}`);
  });
  return errs;
}

export function gateBatch(directives, ctx = {}) {
  const accepted = [];
  const rejected = [];
  const notes = [];
  const seen = new Set();
  const pushed = ctx.pushedIds || new Set();
  const forbidden = (ctx.forbidden || []).filter((s) => typeof s === "string" && s.length >= 3).map((s) => s.toLowerCase());

  for (const d of Array.isArray(directives) ? directives : []) {
    const id = isObj(d) && typeof d.id === "string" ? d.id : "?";
    let errs;
    if (isObj(d) && d.type === "reaction") {
      errs = typeof d.id === "string" && d.id ? [] : ["missing id"];
      errs.push(...checkReaction(d, ctx, notes));
    } else {
      errs = checkPlain(d, notes, ctx);
    }
    // ids inside a reaction's `then` must be unique too
    const ids = [id, ...(d && d.type === "reaction" && Array.isArray(d.then) ? d.then.map((t) => t && t.id) : [])];
    for (const x of ids) {
      if (typeof x !== "string") continue;
      if (seen.has(x)) errs.push(`duplicate id ${x}`);
      if (pushed.has(x)) errs.push(`id ${x} was already sent`);
      seen.add(x);
    }
    if (forbidden.length) {
      const all = readTexts(d).join(" \u0000 ").toLowerCase();
      const leak = forbidden.find((f) => all.includes(f));
      if (leak) errs.push(`names "${leak}" before its time`);
    }
    errs = [...new Set(errs)];
    if (errs.length) rejected.push({ id, reason: errs.join("; ") });
    else accepted.push(d);
  }
  return { accepted, rejected, notes };
}

/**
 * Does a stage have every reaction it needs before the AI is allowed to stop writing it?
 * stage: { id, pieces: [{ story_id }], stall_steps: 4 }
 * Returns the list of what is missing ([] = covered).
 */
/** Story ids and item types that directives put into the world, top level or inside a reaction's then. */
export function placedIn(directives) {
  const ids = new Set();
  const items = [];
  const walk = (d) => {
    if (!isObj(d)) return;
    if (d.type === "place_item" || d.type === "write_note" || d.type === "write_map") {
      if (typeof d.story_id === "string") ids.add(d.story_id);
      if (typeof d.item === "string") items.push({ item: d.item, count: Number(d.count) || 1, story_id: d.story_id });
    }
    if (d.type === "spawn_zombie" || d.type === "spawn_corpse") {
      for (const it of Array.isArray(d.inventory) ? d.inventory : []) {
        if (isObj(it) && typeof it.story_id === "string") ids.add(it.story_id);
        if (isObj(it) && typeof it.item === "string") items.push({ item: it.item, count: 1, story_id: it.story_id });
      }
    }
    if (Array.isArray(d.then)) d.then.forEach(walk);
  };
  (directives || []).forEach(walk);
  return { ids, items };
}

export function missingCoverage(stage, reactions) {
  const live = reactions.filter((r) => r && r.type === "reaction" && (r.stage === stage.id || r.stage === undefined));
  const missing = [];
  // rule 2 (docs/10): every piece is placed as a thing in the world, and so is every supply
  const placed = placedIn(reactions);
  for (const p of stage.pieces || []) {
    if (!placed.ids.has(p.story_id)) missing.push(`piece ${p.story_id} has no item placed in the world`);
  }
  for (const s of stage.supplies || []) {
    const n = placed.items.filter((x) => x.item === s.item && !x.story_id).reduce((a, x) => a + x.count, 0);
    if (n < (s.count || 1)) missing.push(`supply ${s.item} x${s.count || 1} (placed ${n})`);
  }
  // the stage must lead somewhere: a reaction that moves the story on (set_node to the next
  // node), or ends it on the last one. The first real story had none and stopped dead (2026-10-14)
  if (stage.next || stage.final) {
    // the finale's end sits inside a sequence's last step (docs/10): look through it
    const deep = (list, out = []) => {
      for (const t of list || []) {
        if (!t) continue;
        out.push(t);
        if (t.type === "sequence") for (const s of t.steps || []) deep(s.then, out);
      }
      return out;
    };
    const moves = live.some((r) => deep(r.then).some((t) => stage.final
      ? t.type === "season_complete"
      : t.type === "set_node" && t.node === stage.next));
    if (!moves) missing.push(stage.final ? `a reaction that ends the story (season_complete) at ${stage.id}`
      : `a reaction that moves the story on (set_node to ${stage.next}) when ${stage.id} is solved`);
    // the chapter closes when its piece is picked up, always (docs/13): never on reading alone,
    // never on something else only
    const ids = new Set((stage.pieces || []).map((p) => p.story_id));
    if (moves && !stage.final && ids.size && !live.some((r) => r.when && r.when.event === "item_picked" && ids.has(r.when.story_id)
      && deep(r.then).some((t) => t.type === "set_node" && t.node === stage.next))) {
      missing.push(`the move on (set_node to ${stage.next}) in the reaction to picking up ${[...ids].join(" or ")} (item_picked)`);
    }
  }
  for (const p of stage.pieces || []) {
    if (!live.some((r) => r.when && r.when.story_id === p.story_id)) missing.push(`piece ${p.story_id}`);
  }
  // the last chapter never changes node (the urn ends the story): it has no closing reaction
  if (!stage.final && !live.some((r) => r.when && r.when.event === "node_changed" && r.when.from === stage.id)) {
    missing.push(`closing reaction for ${stage.id}`);
  }
  for (let step = 1; step <= (stage.stall_steps ?? 4); step++) {
    if (!live.some((r) => r.when && r.when.event === "signal" && r.when.name === "stall" && Number(r.when.step) === step)) {
      missing.push(`stall step ${step}`);
    }
  }
  return missing;
}

/**
 * Every chapter ends with its closing and a page (docs/04): the AI forgets one or the other, or
 * the title (live AI run 2026-10-21: chapter 2 closed without a page, chapter 3's page had no
 * title). For each reaction that moves the story off `node` (a set_node elsewhere, or a
 * close_chapter), the bridge makes sure both are there, named and titled from the bible.
 * Mutates the reactions in place; returns the notes.
 */
export function ensureChapterEnds(directives, node) {
  const notes = [];
  if (!node || typeof node.id !== "string") return notes;
  // the bible names it chapter_title (the AI's own word); title in older bibles
  const title = node.chapter_title || node.title || null;
  for (const r of directives || []) {
    if (!isObj(r) || r.type !== "reaction" || !Array.isArray(r.then)) continue;
    if (r.stage !== undefined && r.stage !== node.id) continue;
    const moves = r.then.some((t) => isObj(t) && t.type === "set_node" && t.node && t.node !== node.id);
    const closes = r.then.some((t) => isObj(t) && t.type === "close_chapter");
    if (!moves && !closes) continue;
    let close = r.then.find((t) => isObj(t) && t.type === "close_chapter");
    if (!close) {
      close = { id: `${r.id}.close`, type: "close_chapter" };
      r.then.push(close);
      notes.push(`${r.id}: chapter closing added`);
    }
    close.chapter = close.chapter || node.id;
    if (!close.title && title) close.title = title;
    if (!r.then.some((t) => isObj(t) && t.type === "grant_page")) {
      r.then.push({ id: `${r.id}.page`, type: "grant_page", player: "$player", chapter: node.id, ...(title ? { title } : {}) });
      notes.push(`${r.id}: chapter page added`);
    }
    // the page shows the chapter's title: from the bible, else from the closing it came with
    for (const t of r.then) {
      if (isObj(t) && t.type === "grant_page") { t.chapter = t.chapter || node.id; if (!t.title) t.title = title || close.title; }
    }
  }
  return notes;
}

/**
 * Every chapter opens in every diary (docs/13, Teko 2026-10-23): the heading, the title smudged
 * until the chapter closes, and an intuition of the new place. The bridge adds one open_chapter to
 * every stage it accepts (seed and stage, written ahead or not), titled from the bible like
 * ensureChapterEnds. It is a plain directive, not a reaction on node_changed: a stage's batch is
 * pushed only once the story already stands on its node, so a reaction armed in it would wait for
 * an event that is past; applied with the batch, it fires as the chapter is entered. The id is the
 * chapter's own (`<prefix>chopen_<node>`), so a stage written twice adds nothing. `intuition` is
 * left out for the first chapter (the day-zero page carries its hint). Mutates `directives`.
 */
export function ensureChapterOpen(directives, node, { prefix = "", intuition = null, first = false } = {}) {
  if (!Array.isArray(directives) || !node || typeof node.id !== "string") return [];
  const id = `${prefix}chopen_${node.id}`;
  if (directives.some((d) => isObj(d) && d.id === id)) return [];
  const title = node.chapter_title || node.title || null;
  const withIntuition = !first && intuition !== null && intuition !== undefined && intuition !== "";
  directives.push({ id, type: "open_chapter", chapter: node.id, ...(title ? { title } : {}), ...(withIntuition ? { intuition } : {}) });
  return [`${id}: the chapter's opening added${withIntuition ? " with its intuition" : ""}`];
}

/**
 * Can a player read this item? The mod reports note_read only from the game's read window,
 * which opens on our Note and Photo clues; a walkie, a key, a map or a tape is never read.
 * true / false, or null when the item is not ours (left alone).
 */
export function readableItem(fullType) {
  const m = typeof fullType === "string" ? /^ZTales\.([A-Za-z]+?)(Green|Yellow|Red)?$/.exec(fullType) : null;
  if (!m) return null;
  return m[1] === "Note" || m[1] === "Photo";
}

/** story_id -> item full type, for what directives put in the world (write_note / write_map default to ours). */
export function storyItems(directives, into = new Map()) {
  const walk = (d) => {
    if (!isObj(d)) return;
    if (typeof d.story_id === "string" && (d.type === "place_item" || d.type === "write_note" || d.type === "write_map")) {
      into.set(d.story_id, typeof d.item === "string" ? d.item : d.type === "write_note" ? "ZTales.Note" : d.type === "write_map" ? "ZTales.Map" : null);
    }
    if (d.type === "spawn_zombie" || d.type === "spawn_corpse") {
      for (const it of Array.isArray(d.inventory) ? d.inventory : []) {
        if (isObj(it) && typeof it.story_id === "string" && typeof it.item === "string") into.set(it.story_id, it.item);
      }
    }
    if (Array.isArray(d.then)) d.then.forEach(walk);
  };
  (directives || []).forEach(walk);
  return into;
}

/**
 * A reaction waiting for note_read on a piece nobody can read waits forever (live AI run
 * 2026-10-22: chapter 2's closing waited for the walkie to be read, only its chat on item_picked
 * fired, and the story stood still). Such a reaction waits for item_picked instead: picking the
 * piece up is the only thing a player does with it. Mutates in place; returns the notes.
 *   itemOf   Map story_id -> item full type (storyItems)
 */
export function fixUnreadable(directives, itemOf) {
  const notes = [];
  for (const r of directives || []) {
    if (!isObj(r) || r.type !== "reaction" || !isObj(r.when) || r.when.event !== "note_read") continue;
    const item = itemOf?.get?.(r.when.story_id);
    if (readableItem(item) === false) {
      r.when.event = "item_picked";
      notes.push(`${r.id}: waits for item_picked (${r.when.story_id} is a ${item}, which is never read)`);
    } else if (movesOn(r)) {
      // picking the piece up closes the chapter, read or not (docs/13: a player who did not
      // read a sheet stood still, 2026-10-22); a note_read reaction may stay as an extra only
      r.when.event = "item_picked";
      notes.push(`${r.id}: closes the chapter on item_picked (picking ${r.when.story_id} up is enough; reading is never required)`);
    }
  }
  return notes;
}

/** Does a reaction move the story off its node (a set_node or a chapter closing in its then)? */
export function movesOn(r) {
  return isObj(r) && Array.isArray(r.then) && r.then.some((t) => isObj(t) && (t.type === "set_node" || t.type === "close_chapter"));
}

/**
 * The story moves only along the bible's axis (live AI run 2026-10-22: the last chapter's reaction
 * sent set_node "urn"; the node left the last chapter, the urn's own reactions expired with it and
 * a stage call was spent on a node nobody wrote). A set_node to a node outside the axis is
 * rewritten to the stage's next node, or dropped on the last chapter (the urn ends the story).
 * Looks inside reactions and sequences. Mutates in place; returns the notes.
 *   axis   Set of the bible's node ids; stage { id, next, final }
 */
export function fixSetNodes(directives, axis, stage) {
  const notes = [];
  if (!axis || !axis.size) return notes;
  const fix = (list) => {
    if (!Array.isArray(list)) return list;
    const out = [];
    for (const t of list) {
      if (isObj(t) && t.type === "set_node" && typeof t.node === "string" && !axis.has(t.node)) {
        if (stage?.next) { notes.push(`${t.id}: set_node ${t.node} is not a chapter of the story: set to ${stage.next}`); t.node = stage.next; }
        else { notes.push(`${t.id}: set_node ${t.node} dropped (the last chapter ends at the urn)`); continue; }
      }
      if (isObj(t) && Array.isArray(t.then)) t.then = fix(t.then);
      if (isObj(t) && t.type === "sequence") for (const s of t.steps || []) if (isObj(s)) s.then = fix(s.then);
      out.push(t);
    }
    return out;
  };
  const top = fix(directives || []);
  // a top-level set_node dropped: take it out of the caller's list too
  if (Array.isArray(directives)) directives.splice(0, directives.length, ...top);
  return notes;
}

/**
 * One piece per chapter, never two copies of it (docs/13): a directive that puts a bible piece in
 * the world again (an earlier one in this batch, or one already placed) is refused. The bridge's
 * own put-back of a lost piece (`relost`) is the only second copy.
 *   pieceIds   Set of the bible's piece story ids; placed [{ story_id }] already in the world
 * Returns [{ id (the top-level directive), reason }].
 */
export function duplicatePieces(directives, pieceIds, placed = []) {
  const seen = new Set((placed || []).map((p) => p?.story_id).filter((s) => pieceIds.has(s)));
  const out = [];
  const PLACING = new Set(["place_item", "write_note", "write_map"]);
  for (const d of Array.isArray(directives) ? directives : []) {
    if (!isObj(d)) continue;
    let bad = null;
    for (const x of [d, ...(Array.isArray(d.then) ? d.then : [])]) {
      if (!isObj(x) || x.relost) continue;
      const sids = PLACING.has(x.type) ? [x.story_id]
        : (x.type === "spawn_zombie" || x.type === "spawn_corpse") ? (Array.isArray(x.inventory) ? x.inventory : []).map((it) => it?.story_id) : [];
      for (const sid of sids) {
        if (typeof sid !== "string" || !pieceIds.has(sid)) continue;
        if (seen.has(sid) && !bad) bad = `piece ${sid} is already in the world: a chapter has one piece, never a copy of it (stall help is a clue without the piece's story_id)`;
        seen.add(sid);
      }
    }
    if (bad) out.push({ id: d.id || "?", reason: bad });
  }
  return out;
}

/** How many cycles of the stall ladder a step answers (docs/13: help repeats after step 4). */
export const STALL_REPEATS = 6;

const personal = (t) => isObj(t) && JSON.stringify(t).includes('"$player"');
const WORLD = new Set(["place_item", "write_note", "write_map", "spawn_zombie", "spawn_corpse", "lock_door", "unlock_door",
  "smash_window", "barricade", "define_zone"]);

/**
 * Stall help repeats and reaches each player (docs/13 item 6). The bridge raises every stall step
 * once per cycle (pacing.js) and the mod emits it once for the server (`per: "server"`) and once
 * per player online (`per: "player"`, with `player` and `cycle`). Each stall reaction the AI wrote
 * is split here:
 *   <id>     what changes the world (a clue placed, a door), once: the first cycle only, never a copy
 *   <id>~r   what everyone hears (a server chat, a sound), once per cycle (once = STALL_REPEATS)
 *   <id>~p   what a player is told ($player: their diary, their chat), once per player per cycle
 * Mutates the list in place (split parts follow the original); returns the notes.
 */
export function splitStall(directives) {
  const notes = [];
  if (!Array.isArray(directives)) return notes;
  const out = [];
  for (const r of directives) {
    const stall = isObj(r) && r.type === "reaction" && isObj(r.when) && r.when.event === "signal" && r.when.name === "stall"
      && Array.isArray(r.then) && r.when.per === undefined;
    if (!stall) { out.push(r); continue; }
    const world = r.then.filter((t) => isObj(t) && WORLD.has(t.type) && !personal(t));
    const mine = r.then.filter((t) => personal(t));
    const heard = r.then.filter((t) => !world.includes(t) && !mine.includes(t));
    const { then: _t, once: _o, ...base } = r;
    const parts = [];
    if (world.length) parts.push({ ...base, when: { ...r.when, per: "server" }, once: "server", then: world });
    if (heard.length) parts.push({ ...base, when: { ...r.when, per: "server" }, once: STALL_REPEATS, then: heard });
    if (mine.length) parts.push({ ...base, when: { ...r.when, per: "player" }, once: "player", then: mine });
    // the first part keeps the AI's id; the others are named after it
    const sfx = (p) => (p.once === "player" ? "~p" : p.once === "server" ? "" : "~r");
    parts.forEach((p, i) => { if (i > 0) p.id = `${r.id}${sfx(p) || "~w"}`; });
    out.push(...parts);
    if (parts.length > 1 || parts[0]?.once !== "server") notes.push(`${r.id}: stall help ${parts.map((p) => `${p.id} (${p.once === "player" ? "each player, each cycle" : p.once === "server" ? "once" : "each cycle"})`).join(", ")}`);
  }
  directives.splice(0, directives.length, ...out);
  return notes;
}

/**
 * Two pieces of one node never share a square or a container (Teko saw a VHS and a walkie
 * together in one box: two ways in became one). A spot is the same when both name the same
 * x,y,z, or the same building with the same room or either without a room (the mod may then
 * pick any container of that building).
 *   directives   the batch (top level; pieces placed inside a reaction count too)
 *   pieceNode    Map story_id -> node, for every piece of the story (extras included)
 *   placed       [{ story_id, target }] already in the world: they stay, the newcomer moves
 * Returns [{ id (the top-level directive), reason }].
 */
export function sharedSpots(directives, pieceNode, placed = []) {
  const spot = (t) => {
    if (!isObj(t)) return null;
    if (typeof t.x === "number" && typeof t.y === "number") return { xy: `${t.x},${t.y},${t.z || 0}` };
    if (typeof t.building === "string") return { building: t.building, room: t.room || null };
    return null;
  };
  const same = (a, b) => (a.xy || b.xy ? a.xy === b.xy : a.building === b.building && (!a.room || !b.room || a.room === b.room));
  const words = (s) => (s.xy ? `square ${s.xy}` : `building ${s.building}${s.room ? ` room ${s.room}` : ""}`);
  const seen = [];   // { sid, node, spot }
  for (const p of placed || []) {
    const node = pieceNode.get(p?.story_id);
    const s = spot(p?.target);
    if (node && s) seen.push({ sid: p.story_id, node, spot: s });
  }
  const out = [];
  const PLACING = new Set(["place_item", "write_note", "write_map"]);
  for (const d of Array.isArray(directives) ? directives : []) {
    if (!isObj(d)) continue;
    let bad = null;
    for (const x of [d, ...(Array.isArray(d.then) ? d.then : [])]) {
      if (!isObj(x) || !PLACING.has(x.type) || typeof x.story_id !== "string" || x.relost) continue;
      const node = pieceNode.get(x.story_id);
      const s = spot(x.target);
      if (!node || !s) continue;
      const other = seen.find((o) => o.node === node && o.sid !== x.story_id && same(o.spot, s));
      if (other && !bad) {
        bad = `piece ${x.story_id} shares ${words(s)} with piece ${other.sid} of node ${node}: `
          + "two pieces of one node never share a square or a container; put it in another building, or both in named different rooms";
      } else if (!other) seen.push({ sid: x.story_id, node, spot: s });
    }
    if (bad) out.push({ id: d.id || "?", reason: bad });
  }
  return out;
}

/** Events that carry no player: a "$player" in what they fire has nobody to stand for. */
export const PLAYERLESS_EVENTS = new Set(["node_changed"]);

/**
 * A chapter's closing reaction waits for node_changed, which has no player: its diary_entry to
 * "$player" (or to nobody) was rejected in the mod (live run 2026-10-22, r_n3_close.1). It goes to
 * every player instead ("$all", the way the chapter's end mark does). Mutates in place; notes.
 */
export function fillClosingPlayers(directives) {
  const notes = [];
  for (const r of directives || []) {
    if (!isObj(r) || r.type !== "reaction" || !isObj(r.when) || !PLAYERLESS_EVENTS.has(r.when.event) || !Array.isArray(r.then)) continue;
    for (const t of r.then) {
      if (!isObj(t) || t.type !== "diary_entry") continue;
      if (t.player === undefined || t.player === null || t.player === "" || t.player === "$player") {
        t.player = "$all";
        notes.push(`${t.id}: diary_entry on ${r.when.event} (no player) goes to everyone ($all)`);
      }
    }
  }
  return notes;
}

/** A clue written on paper is an ordinary game sheet (B42 Base.SheetPaper2: writable, one page). */
export const PLAIN_NOTE = "Base.SheetPaper2";

/**
 * Only the chapter's piece is a ZTales item (Teko, 2026-10-22): a second yellow item with a
 * story_id (n2_feedbook beside chapter 2's piece) looked like a second piece. Clues are ordinary
 * game items and notes. A note the AI wrote as a ZTales item that is no piece becomes a plain
 * sheet without story_id; any other ZTales item that is no piece is refused with the reason.
 *   isPiece   (story_id) -> true for the story's pieces (the bible's, the bridge's extras)
 * Looks inside reactions. Mutates in place (the refused directives leave the list); returns
 * { notes, rejected: [{ id, reason }] }.
 */
export function fixClueItems(directives, isPiece) {
  const notes = [];
  const rejected = [];
  if (!Array.isArray(directives)) return { notes, rejected };
  const ours = (item) => typeof item === "string" && /^ZTales\./.test(item);
  const pieceOf = (sid) => typeof sid === "string" && !!isPiece(sid);
  const keep = [];
  for (const d of directives) {
    let bad = null;
    for (const x of [d, ...(isObj(d) && Array.isArray(d.then) ? d.then : [])]) {
      if (!isObj(x) || x.relost) continue;
      const piece = pieceOf(x.story_id);
      if (x.type === "write_note" && !piece && (x.item === undefined || ours(x.item))) {
        notes.push(`${x.id}: a clue, not the chapter's piece: written on a plain sheet (${PLAIN_NOTE})${x.story_id ? `, story_id ${x.story_id} dropped` : ""}`);
        x.item = PLAIN_NOTE;
        delete x.story_id;
      } else if ((x.type === "place_item" || x.type === "write_map") && !piece && (ours(x.item) || (x.type === "write_map" && x.item === undefined))) {
        bad = bad || `${x.id} puts ${x.item || "a ZTales map"} in the world and it is not the chapter's piece: only the piece is a ZTales item; a clue is an ordinary game item (catalog.rewards) or a write_note on plain paper, without story_id`;
      } else if (x.type === "spawn_zombie" || x.type === "spawn_corpse") {
        for (const it of Array.isArray(x.inventory) ? x.inventory : []) {
          if (isObj(it) && ours(it.item) && !pieceOf(it.story_id)) {
            bad = bad || `${x.id} carries ${it.item}, which is not the chapter's piece: only the piece is a ZTales item; a clue is an ordinary game item (catalog.rewards), without story_id`;
          }
        }
      }
    }
    if (bad) rejected.push({ id: (isObj(d) && d.id) || "?", reason: bad });
    else keep.push(d);
  }
  directives.splice(0, directives.length, ...keep);
  return { notes, rejected };
}
