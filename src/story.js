/**
 * When to call the AI, with what, and what to keep of the answer (docs/02 "Cycle", docs/04).
 *
 * makeDecide(...) returns the `decide` hook tick() calls once per tick. It calls the AI only at
 * milestones:
 *   seed   no bible yet, the catalog is in, and players are around: write the season
 *   stage  the node moved (node_changed), or the stage was never written: write the current
 *          stage whole (reactions, diary entries, hints). After a chapter closes, it waits
 *          for the finder's page (written or faded) first, so the page is judged in it
 *          (pageWaitSec); nothing is written ahead any more (Teko, 2026-10-22)
 *   echo   a character died: write the dream the account's next character finds on page one
 *          of its diary, from the life that ended (one small call for every death waiting)
 * Everything players wrote (backstories, chapter pages) waits as a motif for the next milestone;
 * it never patches the stage already armed (docs/04 rule 5).
 *
 * Returns { directives, hints } for tick() to gate and push.
 */
import { buildContext, BrainError, readAnswer } from "./brain.js";
import { seal, open } from "./crypto.js";
import { ensureChapterEnds, ensureChapterOpen, fixUnreadable, fixSetNodes, duplicatePieces, splitStall, gateBatch, missingCoverage,
  sharedSpots, storyItems, fixClueItems, fillClosingPlayers, PLAIN_NOTE } from "./gates.js";
import { candidates, stagePoints, stageCells, worldSlice, finalStageCells, finalPlaceRule, inSpawnTown,
  spawnPoints, isLouisville, SPAWN_EXCLUSION, cellsAround } from "./catalog.js";
import { kFor, nextCreativity, makeAllowItem, rewardCandidates, lootFactor, scaleLoot } from "./loot.js";
import { nodeCenter, missingProximity, proximityDirectives, STORY_RINGS } from "./proximity.js";
import { chooseUrnPlace, urnWords, chargeDirective, checkFinaleAnswer, finaleDirectives, piecesByNode } from "./finale.js";
import { finalTaleDirectives, chooseFinalTalePlace } from "./finaltale.js";
import { loadRewardRows, URN_BONUS_MAX } from "./reward.js";
import { collabScore, extraCount, extraDirectives, extraTitle, EXTRA_MAX } from "./collab.js";
import { TOOLKIT_PROMPT, versionAtLeast } from "./toolkit.js";
import { tier } from "./difficulty.js";
import { BRIDGE_ONLY_TYPES } from "./protocol.js";
import { stepsDue, stepOf, cycleOf } from "./pacing.js";
import { chapterEndTexts } from "./chapterend.js";
import { notePages, noteFaded, readContributions, planExtras, checkExtraChapter, scoreMin } from "./contribution.js";
import { blockMaterial, gateWatch, WATCH_MAX_PER_CALL } from "./watch.js";
import { CLUES_PROMPT, buildingsOf, buildingOfTarget, pieceDirective, buildingFacts, plainRings, cluesGate, withRingTexts,
  withPieceRoom, ringsIn, stageTexts, openGate, plainOpen } from "./clues.js";
import { bodyPlace, bodyCells, bodyForDream, carrierEntry } from "./carrier.js";

export const CLUE_FAMILIES = ["Note", "Map", "Key", "Photo", "Cassette", "VHS", "Walkie", "PartA", "PartB", "PartC"];
export const COLORS = { green: "Green", yellow: "Yellow", red: "Red" };
export const MAX_ROUNDS = 2;
export const LOCK_SEC = 300;
/**
 * Between stories (Teko, 2026-10-22; replaces two real played days): the next story is written
 * once the in-game day turned at least this many times since the end (events carry
 * game_time.day), with someone online. Var NEXT_STORY_GAME_DAYS overrides it.
 */
export const NEXT_STORY_GAME_DAYS = 1;
/** The latest in-game day among events (game_time.day), or null when none carries one. */
export function latestGameDay(events) {
  let day = null;
  for (const e of events || []) {
    const d = Number(e?.game_time?.day);
    if (Number.isFinite(d) && (day === null || d > day)) day = d;
  }
  return day;
}
/**
 * The pause between stories, from the state and this tick's events: { closedDay, lastDay, over }.
 * The end's day is the season_completed event's own (else the latest day this tick, else the
 * latest seen before); a story closed by an older bridge takes the first day seen after.
 */
export function nextStoryWait(state, fresh, gameDays = NEXT_STORY_GAME_DAYS) {
  const seen = latestGameDay(fresh);
  let lastDay = Math.max(...[state.game_day_last, seen].filter((d) => Number.isFinite(d)), -Infinity);
  if (!Number.isFinite(lastDay)) lastDay = null;
  let closedDay = Number.isFinite(state.story_closed_game_day) ? state.story_closed_game_day : null;
  if (closedDay === null) closedDay = lastDay;
  const need = Math.max(1, Math.floor(Number(gameDays)) || NEXT_STORY_GAME_DAYS);
  const over = closedDay !== null && lastDay !== null && lastDay - closedDay >= need;
  return { closedDay, lastDay, over };
}
/** After a failed AI call, wait before the next: 15 min, doubling, at most 6 h. Failures cost money. */
export function aiBackoffSec(failures) {
  return Math.min(6 * 3600, 900 * 2 ** Math.max(0, failures - 1));
}
/** A death's dream is written within a day or not at all (the mod then falls back to the stage's echo). */
export const ECHO_TTL_SEC = 86400;
/**
 * The finder's page first (Teko, 2026-10-22; replaces writing ahead, docs/13 item 7): when a
 * chapter closes, the next chapter's stage is written only once its finder's page is written
 * (scored in that same call, docs/13 item 5) or faded (the mod's `page_faded`, its night ran
 * out: the first dawn at least ChapterPageHours after the grant). Safety: never longer than the page's window in real seconds (seq.json
 * `page_window_sec`) plus PAGE_WAIT_GRACE_SEC; a mod that does not say its window gets
 * PAGE_WAIT_DEFAULT_SEC in all.
 */
export const PAGE_WAIT_GRACE_SEC = 1800;
export const PAGE_WAIT_DEFAULT_SEC = 2 * 3600;
export function pageWaitSec(windowSec) {
  const w = Number(windowSec);
  return Number.isFinite(w) && w > 0 ? Math.round(w) + PAGE_WAIT_GRACE_SEC : PAGE_WAIT_DEFAULT_SEC;
}

/** Deaths still owed a dream: [{ player, life (the next one), since }], deduplicated, expired dropped. */
export function echoesDue(prev, fresh, nowSec) {
  const due = (prev || []).filter((x) => x && nowSec - (x.since || 0) < ECHO_TTL_SEC);
  for (const e of fresh) {
    if (e.type !== "player_died" || !e.player || !(Number(e.life) >= 1)) continue;
    const life = Number(e.life) + 1;
    if (!due.some((x) => x.player === e.player && x.life === life)) due.push({ player: e.player, life, since: nowSec });
  }
  return due;
}


export function clueItems(color) {
  const c = COLORS[color] || "Yellow";
  return CLUE_FAMILIES.map((f) => `ZTales.${f}${c}`);
}

/** Journal entries -> motifs (raw text, kept until a milestone uses them). */
export function motifsFrom(events) {
  return events.filter((e) => e.type === "journal" && typeof e.text === "string" && e.text.trim())
    .map((e) => ({ id: String(e.id), player: e.player ?? null, kind: e.kind ?? null, text: e.text }));
}

/** Problems with a seed answer's bible; [] when usable. */
export const SUPPLIES_PER_NODE = 3;
export const SUPPLY_COUNT_MAX = 8;

/** allowedItems: Set of item types a piece or a supply may be (clue items and loot-gated rewards); null = unchecked. */
export function checkBible(bible, maxNodes = 4, allowedItems = null, previous = null) {
  const errs = [];
  if (!bible || typeof bible !== "object") return ["no bible"];
  // the next story (docs/11): never a piece id or a title a past story used
  if (previous) {
    const usedIds = new Set(previous.used_story_ids || []);
    // a title may be one string or one per language: every version counts
    const versions = (t) => (t && typeof t === "object" ? Object.values(t) : [t]).map((v) => String(v || "").toLowerCase()).filter(Boolean);
    const titles = new Set((previous.stories || []).flatMap((p) => versions(p.title)));
    for (const n of Array.isArray(bible.axis) ? bible.axis : []) {
      for (const p of n?.pieces || []) if (p?.story_id && usedIds.has(p.story_id)) errs.push(`piece id ${p.story_id} belongs to a past story: use another`);
    }
    if (versions(bible.title).some((v) => titles.has(v))) errs.push("a past story had this title");
  }
  const axis = Array.isArray(bible.axis) ? bible.axis : [];
  if (axis.length < 1) errs.push("axis is empty");
  if (axis.length > maxNodes) errs.push(`axis has ${axis.length} nodes, the server allows ${maxNodes}`);
  if (!bible.ending || typeof bible.ending.text !== "string") errs.push("no ending");
  if (!Array.isArray(bible.forbidden_entities) || bible.forbidden_entities.length === 0) errs.push("no forbidden_entities");
  const seenIds = new Set();
  axis.forEach((n) => {
    if (!n || typeof n.id !== "string") { errs.push("a node without id"); return; }
    const pieces = Array.isArray(n.pieces) ? n.pieces.filter((p) => p && typeof p.story_id === "string") : [];
    // one piece per chapter (docs/13, Teko 2026-10-22): two versions of one clue confused players
    if (pieces.length !== 1) errs.push(`node ${n.id} has ${pieces.length} pieces: a chapter has exactly one piece, one unique item, written { "story_id": "...", "item": "ZTales...." }`);
    for (const p of pieces) {
      if (seenIds.has(p.story_id)) errs.push(`piece id ${p.story_id} is used twice: every piece is unique`);
      seenIds.add(p.story_id);
    }
    // rule 2 (docs/10): every piece of the puzzle is a physical item players pick up and carry
    for (const p of pieces) {
      if (typeof p.item !== "string" || !p.item) errs.push(`piece ${p.story_id} has no item: every piece is a thing to pick up (clue_items)`);
      else if (allowedItems && !allowedItems.has(p.item)) errs.push(`piece ${p.story_id}: item ${p.item} is not a clue item nor an allowed reward`);
    }
    const supplies = Array.isArray(n.supplies) ? n.supplies : [];
    if (supplies.length > SUPPLIES_PER_NODE) errs.push(`node ${n.id} has ${supplies.length} supplies, at most ${SUPPLIES_PER_NODE}`);
    for (const s of supplies) {
      if (!s || typeof s.item !== "string") { errs.push(`node ${n.id}: a supply without item`); continue; }
      if (allowedItems && !allowedItems.has(s.item)) errs.push(`node ${n.id}: supply ${s.item} is not an allowed reward on this server`);
      if (s.count !== undefined && !(Number.isInteger(s.count) && s.count >= 1 && s.count <= SUPPLY_COUNT_MAX)) errs.push(`node ${n.id}: supply ${s.item} count must be 1-${SUPPLY_COUNT_MAX}`);
    }
  });
  return errs;
}

function storyIdsIn(list, out = new Set()) {
  for (const d of list || []) {
    if (!d || typeof d !== "object") continue;
    if (typeof d.story_id === "string") out.add(d.story_id);
    for (const it of Array.isArray(d.inventory) ? d.inventory : []) if (it && typeof it.story_id === "string") out.add(it.story_id);
    if (Array.isArray(d.then)) storyIdsIn(d.then, out);
  }
  return out;
}

/** The AI writes hints per node ({ n3: { full, echo } }); the mod reads one flat hints.json. */
export function hintsFor(h, node, color) {
  if (!h || typeof h !== "object" || !node) return null;
  const cur = h[node] || (h.full ? h : null);
  if (!cur) return null;
  return { node, color, full: cur.full, echo: cur.echo, openers: h.openers || cur.openers };
}

function parse(text) {
  if (text == null) return null;
  try { return JSON.parse(text.replace(/^﻿/, "")); } catch { return null; }
}

/** Rows of the cells that exist (state.catalog_cells), fetched one small file each. */
async function loadCells(t, keys, existing) {
  const have = new Set(existing || []);
  const out = {};
  for (const k of keys) {
    if (existing && !have.has(k)) continue;
    const doc = parse(await t.get(`catalog/cell-${k}.json`));
    if (doc && Array.isArray(doc.rows)) out[k] = doc.rows;
  }
  return out;
}

/**
 * Each player's longer history, for diary entries that cover a stretch of play in one compact
 * text (Teko, 2026-10-13: three days played is one entry, "I haven't written in days...", not
 * three). Per player: their last `max` journeys, oldest first, the fields a diary would use.
 */
export function journeysByPlayer(events, max = 12) {
  const out = {};
  for (const e of events) {
    if (e.type !== "player_journey" || !e.player) continue;
    (out[e.player] = out[e.player] || []).push({
      char: e.char, life: e.life, profession: e.profession, from: e.from, to: e.to,
      online_minutes: e.online_minutes, regions: e.regions, named_places: e.named_places,
      walked_tiles: e.walked_tiles, driven_tiles: e.driven_tiles, zombies_killed: e.zombies_killed,
      died: e.died, companions: e.companions, story: e.story,
      moods: e.moods, moods_end: e.moods_end,
    });
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice(-max);
  return out;
}

/** The most of an answer's text kept with its call (before sealing): a whole bible and more. */
export const RAW_PLAIN_MAX = 200000;

/**
 * One AI call in the calls table, ok or not, with its answer's text (Teko, 2026-10-22: "you can't
 * throw paid answers away"). The text is sealed with BIBLE_KEY like the bible: it holds the story.
 */
async function logAnswer(store, bibleKey, purpose, nowSec, res, err = null) {
  const text = err ? err.raw : res?.raw;
  let raw = null;
  if (typeof text === "string" && text && bibleKey) {
    try { raw = await seal(bibleKey, text.length > RAW_PLAIN_MAX ? `${text.slice(0, RAW_PLAIN_MAX)}…[cut]` : text); } catch { raw = null; }
  }
  const note = err ? String(err.message || "").slice(0, 300) : (res?.note ?? (res?.repaired ? "repaired" : null));
  await store.logCall({ model: err ? null : res?.model ?? null, purpose, cost_usd: err ? err.cost ?? null : res?.cost ?? null,
    ok: !err, raw, note }, nowSec);
}

/**
 * Never the same question blindly (Teko, 2026-10-22): after an answer that failed, the next ask
 * of that task (after the back-off) says what went wrong, so the AI answers more compactly.
 */
function failureNote(state, key) {
  const f = state.ai_last_failure;
  if (!f || f.task !== key) return [];
  return [{ id: "previous_answer", reason: `your previous answer to this task was discarded: ${f.reason}. `
    + "Answer again, more compactly: stay inside the answer budget in the rules, short texts, nothing repeated, only the JSON." }];
}

/**
 * The clue agent's calls per chapter (Teko, 2026-10-24): the first and at most two retries, each
 * told exactly what was wrong. Counted in state per chapter (`clue_tries`), so a restart or the
 * next tick never starts over; the opening upgrade (open#<node>) counts against the same three.
 */
export const CLUES_MAX_CALLS = 3;

const CUT_NOTE = { id: "previous_answer", reason: "your answer was cut at the token limit: answer shorter "
  + "(the whole answer under 3000 characters, each line short, nothing said twice, only the JSON)" };

/** What the clue agent is told about its last answer: never the same question blindly. */
export function clueReasons({ err = null, errors = [], cut = false } = {}) {
  const out = [];
  if (err) {
    const m = String(err?.message || err).slice(0, 200);
    if (/cut at the token limit/.test(m)) out.push(CUT_NOTE);
    else if (/JSON|not an object|empty answer|not a list/.test(m)) {
      out.push({ id: "previous_answer", reason: `your previous answer could not be read (${m}): answer only the JSON object the rules ask for` });
    } else out.push({ id: "previous_answer", reason: `your previous call failed (${m}): answer again, only the JSON object, short` });
  }
  if (cut) out.push(CUT_NOTE);
  if (errors.length) {
    out.push({ id: "previous_answer", reason: "your previous answer was refused by the clue gate for the reasons listed next: fix exactly these and answer again" },
      ...errors.slice(0, 12).map((e) => ({ id: "clue_gate", reason: String(e).slice(0, 200) })));
  }
  return out;
}

/** What to remember of a failed call for failureNote (only failures that had an answer). */
function failureRecord(key, e, nowSec) {
  return { ai_last_failure: { task: key, reason: String(e?.message || "error").slice(0, 200), at: nowSec } };
}

const compactEvent = (e) => {
  const { ts, game_time, schema, ...rest } = e;
  return { ...rest, day: game_time?.day };
};

/**
 * deps: { ask(system, context) -> { doc, model, cost }, askStory?, system, bibleKey, maxCallsPerDay }
 * Two writers (Teko, 2026-10-14): `askStory`, the stronger model, designs the story (task
 * "bible") and tells it at the end (task "recap"); `ask`, the cheaper one, fills each stage from
 * that bible (task "stage") and writes the dreams of new lives. Without askStory one model does all.
 * Every call gets a third argument { role: "story" | "stage" | "dream", models: state.models }:
 * the model the owner chose per task in the sandbox (src/models.js), which the asker may honor.
 */
export function makeDecide(deps) {
  const maxCalls = deps.maxCallsPerDay ?? 48;
  // money, not calls, is what the owner pays: every call counts, failed ones too
  const maxUsd = deps.maxUsdPerDay ?? 1;
  const split = typeof deps.askStory === "function";
  const askStory = split ? deps.askStory : deps.ask;

  return async function decide({ state, fresh, store, nowSec, t }) {
    // a task answered again: the note about its last failure has done its job
    const clearFailure = async (key) => {
      if (state.ai_last_failure?.task !== key) return;
      state.ai_last_failure = null;
      await store.setState({ ai_last_failure: null });
    };
    // The clue agent's tries for one chapter (`key`: season prefix + node), persisted: { n, why }.
    // `why` is what the next call is told about the last answer (clueReasons).
    const clueTry = (key) => (state.clue_tries || {})[key] || { n: 0, why: [] };
    const saveClueTry = async (key, patch) => {
      const prefix = key.slice(0, key.indexOf("_") + 1);
      // only this season's chapters are kept: the record never grows past one story
      const kept = Object.fromEntries(Object.entries(state.clue_tries || {}).filter(([k]) => k.startsWith(prefix)));
      state.clue_tries = { ...kept, [key]: { ...clueTry(key), ...patch } };
      await store.setState({ clue_tries: state.clue_tries });
    };
    /**
     * One clue-agent call for a chapter, within the owner's caps: { res, purpose } for an answer,
     * { err, purpose } for a failed call (logged with its cost), { noCredit: why } when the daily
     * cap or budget is reached or the provider says the account has no credit, { exhausted } when
     * the chapter's CLUES_MAX_CALLS are spent. The count is saved before the call is made.
     */
    const clueAsk = async (key, base, context) => {
      const tried = clueTry(key);
      if (tried.n >= CLUES_MAX_CALLS) return { exhausted: true };
      if ((await store.callsSince(nowSec - 86400)) >= maxCalls) return { noCredit: "daily AI call cap reached" };
      const spent = await store.costSince(nowSec - 86400);
      if (spent >= maxUsd) return { noCredit: `daily AI budget reached ($${spent.toFixed(2)} of $${maxUsd})` };
      await saveClueTry(key, { n: tried.n + 1 });
      const purpose = tried.n ? `${base}.retry${tried.n}` : base;
      try {
        return { res: await deps.askClues(deps.system, context(tried.why || []), { role: "clues", task: "clues", models: state.models }), purpose };
      } catch (e) {
        // a failed call is logged (and its cost counted) like any other
        await logAnswer(store, deps.bibleKey, purpose, nowSec, null, e);
        if (e?.noCredit) return { noCredit: `the provider says the account has no credit (${String(e.message).slice(0, 120)})`, purpose, err: e };
        await saveClueTry(key, { why: clueReasons({ err: e }) });
        return { err: e, purpose };
      }
    };
    const motifs = motifsFrom(fresh);
    if (motifs.length) await store.addMotifs(motifs);
    // chapter pages written, kept until the AI scores them (src/contribution.js)
    const pages = notePages(state.pages, fresh, state.season || "");
    if (JSON.stringify(pages) !== JSON.stringify(state.pages || [])) {
      state.pages = pages;
      await store.setState({ pages });
    }
    // chapter pages that faded unwritten (the mod's page_faded): the next stage stops waiting
    const faded = noteFaded(state.pages_faded, fresh, state.season || "");
    if (JSON.stringify(faded) !== JSON.stringify(state.pages_faded || [])) {
      state.pages_faded = faded;
      await store.setState({ pages_faded: faded });
    }

    const index = state.catalog_index;
    if (!index) return null;

    // the season's tally of extra pieces (src/collab.js): every one created by a chapter's
    // collaboration counts, and once more when it reaches a story's urn; the Final Tale grows with it
    const deposits = fresh.filter((e) => e.type === "urn_piece" && typeof e.piece === "string" && e.piece.includes("_extra")).length;
    if (deposits) {
      state.extras_deposited = (state.extras_deposited || 0) + deposits;
      await store.setState({ extras_deposited: state.extras_deposited });
    }
    // the Ashes scattered (docs/11): where they fell is kept for the story that comes next
    const ashes = fresh.filter((e) => e.type === "ashes_scattered").pop();
    if (ashes) {
      state.ashes = { x: ashes.x, y: ashes.y, z: ashes.z || 0, player: ashes.player || null, at: nowSec, used: false };
      await store.setState({ ashes: state.ashes });
    }
    // five Tales boxed (docs/11): the Final Tale, once, written by the bridge alone (no AI)
    const boxed = fresh.find((e) => e.type === "tales_boxed");
    if (boxed && !state.final_tale && boxed.player) {
      const events = (await store.recentEvents(80)).map(compactEvent);
      const stagePts = stagePoints(events, index);
      const keys = finalStageCells(index, state.catalog_cells, stagePts.near);
      const points = stagePts.near.length ? stagePts.near : stagePts.towns;
      const spawns = spawnPoints(index);
      const places = candidates(await loadCells(t, keys, state.catalog_cells), index.building_fields || [], points, 80)
        .filter((p) => isLouisville(p) || !inSpawnTown(p.id.split("_").slice(1).map(Number), spawns, SPAWN_EXCLUSION));
      const place = chooseFinalTalePlace({ places, history: state.urn_history || [], points })
        || urnWords(chooseUrnPlace(places, state.urn_history || [], [], index));
      if (!place) return { note: "Final Tale: no landmark found yet; it waits" };
      // the reward is drawn from this server's own item catalog, read now, a few files only
      const rowsBy = await loadRewardRows(t, parse);
      const extras = (state.extras_total || 0) + (state.extras_deposited || 0);
      const directives = finalTaleDirectives({ place, packer: boxed.player, rowsBy, extras, modVersion: state.mod_version || "0" });
      state.final_tale = { place: place.id, packer: boxed.player, at: nowSec, extras };
      // the tally is spent on this great urn: the next season counts from zero
      await store.setState({ final_tale: state.final_tale, urn_history: [...(state.urn_history || []), place.id],
        extras_total: 0, extras_deposited: 0 });
      return { directives, note: `Final Tale: the great urn at ${place.id}${extras ? ` (${extras} extra pieces in the season)` : ""}` };
    }
    const due = echoesDue(state.echo_due, fresh, nowSec);
    if (JSON.stringify(due) !== JSON.stringify(state.echo_due || [])) await store.setState({ echo_due: due });
    if (state.ai_lock_until && state.ai_lock_until > nowSec) return null;
    // a failed stage call backs off every call but a pending dream (cheap, and the new diary is
    // waiting on it): a dream has its own back-off (live run 2026-10-22)
    const failWait = !!(state.ai_fail_until && state.ai_fail_until > nowSec);
    const echoWait = !!(state.echo_fail_until && state.echo_fail_until > nowSec);
    if (failWait && (echoWait || !due.length)) return null;

    // a story ended: the next one is written once the in-game day turned (NEXT_STORY_GAME_DAYS)
    const ended = fresh.find((e) => e.type === "season_completed");
    if (ended && !state.story_closed) {
      const sealedNow = await store.getBible();
      const done = sealedNow ? await open(deps.bibleKey, sealedNow) : null;
      const record = done ? { season: done.season, title: done.title, premise: done.premise,
        pieces: (done.axis || []).flatMap((n) => (n.pieces || []).map((p) => p.story_id)),
        urn: (state.urn_history || []).slice(-1)[0] || null, closed_at: nowSec } : { season: state.season, closed_at: nowSec };
      const endDay = latestGameDay([ended]) ?? latestGameDay(fresh) ?? (Number.isFinite(state.game_day_last) ? state.game_day_last : null);
      const patch = { story_closed: true, story_closed_at: nowSec, story_closed_game_day: endDay, game_day_last: endDay,
        stories_done: [...(state.stories_done || []), record] };
      await store.setState(patch);
      Object.assign(state, patch);
    }
    // the in-game days seen since the end: the day the story ended does not count
    const wait = state.story_closed ? nextStoryWait(state, fresh, deps.nextStoryGameDays) : null;
    if (wait && (wait.lastDay !== (state.game_day_last ?? null) || wait.closedDay !== (state.story_closed_game_day ?? null))) {
      state.game_day_last = wait.lastDay; state.story_closed_game_day = wait.closedDay;
      await store.setState({ game_day_last: wait.lastDay, story_closed_game_day: wait.closedDay });
    }
    const quietOver = !!wait?.over;
    const sealed = state.story_closed ? null : await store.getBible();
    if (state.story_closed && !quietOver) return null;
    // no AI credit right now: the day's call cap or dollar budget reached
    const noCreditNow = async () => {
      if ((await store.callsSince(nowSec - 86400)) >= maxCalls) return "daily AI call cap reached";
      const spent = await store.costSince(nowSec - 86400);
      return spent >= maxUsd ? `daily AI budget reached ($${spent.toFixed(2)} of $${maxUsd})` : null;
    };
    // the open chapter has no opening in the diaries (it opened before mod 0.2.2, or a stage
    // was accepted before openings existed): send it once, with no AI, from the bible's title
    // (Teko, 2026-10-24: production's chapter 2 opened with nothing). Its intuition is the clue
    // agent's, asked next (the upgrade below); plain words only when there is no AI credit
    if (sealed && state.node && !state.story_closed && versionAtLeast(state.mod_version, "0.2.2")) {
      const done = state.openings_sent || [];
      const bibleNow = await open(deps.bibleKey, sealed);
      const key = `${bibleNow?.season || state.season || "s1"}_${state.node}`;
      if (!done.includes(key)) {
        const axisNode = bibleNow?.axis?.find((n) => n.id === state.node);
        const isFirst = bibleNow?.axis?.[0]?.id === state.node;
        if (axisNode) {
          const prefix = `${bibleNow?.season || state.season || "s1"}_`;
          const piece = pieceDirective(Object.values(state.piece_dirs || {}), axisNode);
          let intuition = null;
          const xy = piece && /^b_(\d+)_(\d+)$/.exec(String(piece.target?.building || ""));
          if (xy && !isFirst && typeof deps.askClues === "function" && await noCreditNow()) {
            const cellRows = await loadCells(t, cellsAround(Number(xy[1]), Number(xy[2]), index.cell_size || 300), state.catalog_cells);
            const buildings = buildingsOf(cellRows, index.building_fields || []);
            const b = buildingOfTarget(piece.target, buildings);
            const room = b && typeof piece.target?.room === "string" && (b.rooms || []).includes(piece.target.room) ? piece.target.room : null;
            if (b) intuition = plainOpen(buildingFacts(b, buildings, { room }), { languages: state.languages || ["en"], room });
            if (intuition) {
              state.openings_plain = [...(state.openings_plain || []), key];
              await store.setState({ openings_plain: state.openings_plain });
            }
          }
          const directives = [];
          ensureChapterOpen(directives, axisNode, { prefix, intuition, first: isFirst });
          state.openings_sent = [...done, key];
          await store.setState({ openings_sent: state.openings_sent });
          if (directives.length) return { directives, note: `${directives[0].id}: the open chapter's missing opening sent` };
        }
      }
    }
    // an open chapter whose opening carried no AI intuition: the clue agent writes one, sent to
    // every diary as a line under the opening (Teko, 2026-10-24: the plain line of chapter 2 gave
    // no direction; the AI is the default). Refused, cut or failed: asked again with what was wrong,
    // within the chapter's CLUES_MAX_CALLS (shared with the stage's clue call, persisted). Still
    // nothing after that: nothing is sent, and it is never asked again. Plain words only when there
    // is no AI credit, and only if the opening did not carry them already
    if (sealed && state.node && !state.story_closed && typeof deps.askClues === "function" && versionAtLeast(state.mod_version, "0.2.2")) {
      const bibleNow = await open(deps.bibleKey, sealed);
      const prefix = `${bibleNow?.season || state.season || "s1"}_`;
      const key = `${prefix}${state.node}`;
      const axisNode = bibleNow?.axis?.find((n) => n.id === state.node);
      const isFirst = bibleNow?.axis?.[0]?.id === state.node;
      if (axisNode && !isFirst && (state.openings_sent || []).includes(key) && !(state.openings_ai || []).includes(key)
          && !(state.openings_upgraded || []).includes(key)) {
        const markDone = async () => {
          state.openings_upgraded = [...(state.openings_upgraded || []), key];
          await store.setState({ openings_upgraded: state.openings_upgraded });
        };
        const purpose = `open#${state.node}`;
        const piece = pieceDirective(Object.values(state.piece_dirs || {}), axisNode);
        const xy = piece && /^b_(\d+)_(\d+)$/.exec(String(piece.target?.building || ""));
        const cellRows = xy ? await loadCells(t, cellsAround(Number(xy[1]), Number(xy[2]), index.cell_size || 300), state.catalog_cells) : [];
        const buildings = buildingsOf(cellRows, index.building_fields || []);
        const b = xy ? buildingOfTarget(piece.target, buildings) : null;
        if (!b) await markDone();
        else {
          const room = typeof piece.target?.room === "string" && (b.rooms || []).includes(piece.target.room) ? piece.target.room : null;
          const facts = buildingFacts(b, buildings, { room });
          const languages = state.languages || ["en"];
          const forbidden = bibleNow?.forbidden_entities || [];
          const lineOf = (text, tag) => ({ id: `${prefix}chopen_${state.node}_${tag}`, type: "diary_entry", player: "$all", node: state.node, text });
          for (;;) {
            const a = await clueAsk(key, purpose, (why) => buildContext({
              task: "clues", state_version: state.state_version || 0,
              bible: { title: bibleNow?.title ?? null, forbidden_entities: forbidden,
                chapter: { id: state.node, title: axisNode.chapter_title || axisNode.title || null, question: axisNode.question ?? null,
                  place: axisNode.place ?? axisNode.location_fn ?? null, what_happened: axisNode.what_happened ?? null,
                  piece: (axisNode.pieces || []).map((p) => ({ item: p.item, title: p.title ?? null, shows: p.shows ?? null }))[0] || null } },
              state: { node: state.node, languages },
              rejections: why,
              clues_for: {
                rules: `${CLUES_PROMPT} This call: only open is used, so you may answer only { open }; the chapter is already under way, so let it also say which way to turn: the town or the nearest named place.`,
                piece: { item: piece.item ?? null, title: piece.title ?? null, text: piece.text ?? null,
                  container: { room: piece.target?.room ?? null, container_pref: piece.target?.container_pref ?? null, on_floor: !!piece.target?.on_floor } },
                solution: stageTexts([piece], null),
                story_rings: null,
                building: facts.building, facts: facts.facts.map(({ id, about, distinctive }) => ({ id, about, distinctive })),
                neighbour: facts.neighbour,
              },
            }));
            if (a.exhausted) { await markDone(); break; }
            if (a.noCredit) {
              await markDone();
              const text = (state.openings_plain || []).includes(key) ? null : plainOpen(facts, { languages, room });
              const line = text ? lineOf(text, "plain") : null;
              if (line && !gateBatch([line], { languages: state.languages, forbidden }).rejected.length) {
                state.openings_plain = [...(state.openings_plain || []), key];
                await store.setState({ openings_plain: state.openings_plain });
                return { directives: [line], note: `${line.id}: no AI credit (${a.noCredit}): the open chapter's intuition in plain words` };
              }
              break;
            }
            if (a.err) continue;
            const res = a.res;
            const og = openGate(res.doc?.open, { facts: facts.facts, languages });
            const line = lineOf(og.text, "ai");
            const errors = [...og.errors];
            if (og.ok) errors.push(...gateBatch([line], { languages: state.languages, forbidden }).rejected.map((r) => `open: ${r.reason}`));
            await logAnswer(store, deps.bibleKey, a.purpose, nowSec,
              { ...res, note: [res.note, errors.length ? `refused: ${errors.join("; ")}`.slice(0, 250) : null].filter(Boolean).join("; ") || null });
            if (!errors.length) {
              await markDone();
              state.openings_ai = [...(state.openings_ai || []), key];
              await store.setState({ openings_ai: state.openings_ai });
              return { directives: [line], note: `${line.id}: the AI's intuition for the open chapter, for every diary` };
            }
            await saveClueTry(key, { why: clueReasons({ errors, cut: /cut at the token limit/.test(res.note || "") }) });
          }
        }
      }
    }
    // a node change toward the stage already written (the season opening on n1, a restart) is
    // not a milestone: only a node nobody wrote yet calls the AI
    // only a chapter of the story is a stage: a node outside the axis (the AI once sent "urn")
    // never costs a call (live run 2026-10-22)
    const axisIds = new Set((state.pieces_by_node || []).map((n) => n.node));
    const inAxis = (n) => !axisIds.size || axisIds.has(n);
    const moved = fresh.filter((e) => e.type === "node_changed" && e.to && e.to !== state.stage_written && inAxis(e.to)).pop();
    // a stage a bridge before 2026-10-22 wrote ahead (docs/13 item 7, retired): still pushed when
    // the story reaches it; nothing new is written ahead any more
    const ahead = state.ahead && state.ahead.season === (state.season || "") && state.ahead.node ? state.ahead : null;
    const reached = moved?.to || (state.node && state.stage_written !== state.node && inAxis(state.node) ? state.node : null);
    const order = (state.pieces_by_node || []).map((n) => n.node);
    // the node the story reached is kept as the stage wanted: a tick spent on a dream, or a wait
    // for the finder's page, never loses it (nothing is written ahead to cover it any more)
    if (moved && state.stage_wanted !== moved.to) {
      state.stage_wanted = moved.to;
      await store.setState({ stage_wanted: moved.to });
    }
    // The finder's page first (Teko, 2026-10-22): the stage of `target` waits while the chapter
    // before it has just closed and its finder's page is neither written nor faded, up to the
    // page's window plus a grace (pageWaitSec). Returns the chapter it waits on, or null.
    const pageWaitFor = (target) => {
      const i = target ? order.indexOf(target) : -1;
      const prev = i > 0 ? order[i - 1] : null;
      if (!prev) return null;
      const season = state.season || "";
      if (!(state.chapter_ends || []).includes(`${season}:${prev}`)) return null;
      // no known finder, no page was granted: nothing to wait for
      if (!(state.chapter_finders || {})[`${season}:${prev}`]) return null;
      if ((state.extras_decided || {})[prev] || pages.some((p) => p.chapter === prev)) return null;
      if ((state.pages_faded || []).includes(`${season}:${prev}`)) return null;
      const since = state.page_wait?.node === target && state.page_wait?.season === season ? state.page_wait.since : nowSec;
      if (nowSec - since >= pageWaitSec(state.page_window_sec)) return null;
      return prev;
    };
    // each player's block of play closed (src/watch.js): looked at only while a chapter stands
    const watchList = () => (state.node && state.stage_written === state.node ? (state.watch_due || []).slice(0, WATCH_MAX_PER_CALL) : []);
    let task = null;
    if (!sealed) {
      // someone online right now (the mod's seq.json), never leftover events from an earlier
      // session: the first real-AI run seeded four times on an empty server (2026-10-14)
      const someone = (state.last_online || 0) > 0;
      if (someone && !failWait) task = "seed";
    } else if (ahead && reached && ahead.node === reached) {
      task = "push";
    } else if (due.length && !echoWait) {
      // the dream first: one small call, and the new life's diary waits on it (a stage, a look
      // ahead or a watch can wait a minute; before, a dream waited behind all of them)
      task = "echo";
    } else if (failWait) {
      return null;
    } else if (moved || (state.node && state.stage_written !== state.node && inAxis(state.node))
      // a stage that was rejected is retried once the back-off is over (live AI run 2026-10-21:
      // the node_changed was spent on the rejected call and the story stood still)
      || (state.stage_wanted && state.stage_wanted !== state.stage_written && inAxis(state.stage_wanted))) {
      task = "stage";
      const target = moved?.to || state.stage_wanted || state.node || null;
      const waitOn = pageWaitFor(target);
      if (waitOn) {
        // kept as the stage wanted, so the next ticks come back to it once the page is in
        const first = !(state.page_wait?.node === target && state.page_wait?.season === (state.season || ""));
        if (first || state.stage_wanted !== target) {
          await store.setState({ stage_wanted: target,
            ...(first ? { page_wait: { node: target, chapter: waitOn, season: state.season || "", since: nowSec } } : {}) });
        }
        return first ? { note: `stage ${target} waits for the finder's page of ${waitOn}` } : null;
      }
    } else if (watchList().length) {
      task = "watch";
    }
    if (!task) return null;
    // the stage written ahead goes out at once: no AI call, nothing can fail here
    if (task === "push") {
      await store.setState({ ahead: null, stage_written: ahead.node, node: ahead.node, node_at: nowSec, stage_wanted: null,
        state_version: (state.state_version || 0) + 1 });
      return { directives: ahead.directives || [], hints: ahead.hints || undefined, season: state.season || "",
        note: `stage ${ahead.node} was written ahead: pushed at once` };
    }
    if ((await store.callsSince(nowSec - 86400)) >= maxCalls) return { note: "daily AI call cap reached" };
    const spent = await store.costSince(nowSec - 86400);
    if (spent >= maxUsd) return { note: `daily AI budget reached ($${spent.toFixed(2)} of $${maxUsd})` };

    await store.setState({ ai_lock_until: nowSec + LOCK_SEC });
    let failed = false;
    try {
      const out = task === "echo" ? await runEcho(due)
        : task === "watch" ? await runWatch(watchList())
        : await run(task, moved);
      failed = !!out?.aiFailed;
      return out;
    } finally {
      if (task === "echo") {
        // a dream's failure backs off dreams only; its success never lifts a stage's back-off
        const n = failed ? (state.echo_failures || 0) + 1 : 0;
        await store.setState({ ai_lock_until: 0, echo_failures: n, echo_fail_until: failed ? nowSec + aiBackoffSec(n) : 0 });
      } else {
        const n = failed ? (state.ai_failures || 0) + 1 : 0;
        await store.setState({ ai_lock_until: 0, ai_failures: n,
          ai_fail_until: failed ? nowSec + aiBackoffSec(n) : 0 });
      }
    }

    // The dream a new life finds: built from the life that ended, never a plain clue (docs/04)
    async function runEcho(list) {
      const bible = await open(deps.bibleKey, sealed);
      const all = journeysByPlayer(await store.recentEvents(400, "player_journey"), 24);
      const journeys = {};
      for (const x of list) journeys[x.player] = (all[x.player] || []).filter((j) => j.life == null || j.life === x.life - 1);
      const asked = new Map(list.map((x) => [x.player, x.life]));
      // a life that died carrying a piece (src/carrier.js): the dream and a diary line say where
      // the body lies, by the place's function and its town, never a coordinate
      const bodies = {};
      const carrierLines = [];
      for (const x of list) {
        const rec = (state.carriers || []).find((c) => c.player === x.player && Number(c.life) === x.life - 1);
        if (!rec) continue;
        const cells = await loadCells(t, bodyCells(rec.x, rec.y, index.cell_size || 300), state.catalog_cells);
        const place = bodyPlace(cells, index.building_fields || [], rec.x, rec.y);
        bodies[x.player] = bodyForDream(rec, place);
        const line = carrierEntry(rec, place, state.languages || ["en"], `${state.season || ""}_`);
        if (line) carrierLines.push(line);
      }
      let rejections = [];
      let accepted = [];
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const context = buildContext({
          task: "echo", state_version: state.state_version || 0, bible,
          state: { node: state.node || null, languages: state.languages || ["en"] },
          journeys, rejections: round === 1 ? [...failureNote(state, "echo"), ...rejections] : rejections,
          echo_for: list.map((x) => ({ player: x.player, life: x.life })),
          bodies: Object.keys(bodies).length ? bodies : null,
        });
        let res;
        try {
          res = await deps.ask(deps.system, context, { role: "dream", task: "echo", models: state.models });
          await logAnswer(store, deps.bibleKey, `echo#${round}`, nowSec, res);
          await clearFailure("echo");
        } catch (e) {
          await logAnswer(store, deps.bibleKey, `echo#${round}`, nowSec, null, e);
          if (e instanceof BrainError) {
            if (e.raw != null) await store.setState(failureRecord("echo", e, nowSec));
            return { note: `AI call failed: ${e.message}`, aiFailed: true };
          }
          throw e;
        }
        const wanted = [];
        rejections = [];
        for (const d of res.doc?.directives || []) {
          if (d?.type !== "diary_echo") rejections.push({ id: d?.id || "?", reason: "only diary_echo in an echo task" });
          else if (asked.get(d.player) !== d.life) rejections.push({ id: d.id || "?", reason: `no dream was asked for ${d.player} life ${d.life}` });
          else wanted.push(d);
        }
        const g = gateBatch(wanted, { pushedIds: await store.sentIds(), languages: state.languages,
          forbidden: bible?.forbidden_entities || [] });
        accepted = [...accepted, ...g.accepted];
        for (const d of g.accepted) asked.delete(d.player);
        rejections.push(...g.rejected);
        if (asked.size === 0) break;
      }
      // served or not, a death is asked once: the mod falls back to the stage's echo
      await store.setState({ echo_due: [] });
      const missed = [...asked.keys()];
      // no usable dream: the stage's own echo fills page one now, so the new diary never waits
      // days on the mod's own fallback (EchoQuietDays) with nothing written
      const stageEcho = parse(await t.get("inbox/hints.json"))?.echo?.text;
      const fallback = stageEcho ? missed.map((p) => ({ id: `${state.season || ""}_echo_${p}_${asked.get(p)}_stage`, type: "diary_echo",
        player: p, life: asked.get(p), text: stageEcho })) : [];
      // the body's place goes out whatever the dream did: the story waits on that body
      const lines = gateBatch([...fallback, ...carrierLines], { pushedIds: await store.sentIds(), languages: state.languages }).accepted;
      const sentFallback = lines.filter((d) => d.type === "diary_echo").map((d) => d.player);
      const notes = [missed.length ? `no dream for ${missed.join(", ")}: the stage's echo will do${sentFallback.length ? ` (sent for ${sentFallback.join(", ")})` : ""}` : null,
        ...lines.filter((d) => d.kind === "carrier_body").map((d) => `${d.player}'s new life is told where the body lies`)].filter(Boolean);
      return { directives: [...accepted, ...lines], rejections, note: notes.length ? notes.join("; ") : undefined };
    }

    // Each player's block of play, looked at once (docs/13 item 4): for that player only, a hint
    // fitted to what they did (plainer the longer the chapter stands), a record of the stretch,
    // or nothing. One call for every block due; one round (nothing is a fine answer).
    async function runWatch(list) {
      const bible = await open(deps.bibleKey, sealed);
      const season = state.season || bible?.season || "";
      const axisNode = (bible?.axis || []).find((n) => n.id === state.node);
      const left = (state.watch_due || []).filter((b) => !list.includes(b));
      if (!axisNode) {
        await store.setState({ watch_due: left });
        return { note: `blocks of ${list.map((b) => b.player).join(", ")}: no chapter to watch` };
      }
      const events = await store.recentEvents(1500);
      const blocks = list.map((b) => ({ ...b, node: axisNode.id }));
      const pacing = state.pacing || { days: [], sent: 0 };
      const steps = stepsDue(pacing, (state.catalog_index || {}).hint_pace || "auto");
      const forbidden = bible?.forbidden_entities || [];
      const context = buildContext({
        task: "watch", state_version: state.state_version || 0,
        // what the look needs of the story: never the whole bible, never the ending
        bible: { title: bible?.title ?? null, premise: bible?.premise ?? null, forbidden_entities: forbidden,
          chapter: { id: axisNode.id, title: axisNode.chapter_title || axisNode.title || null, question: axisNode.question ?? null,
            place: axisNode.place ?? axisNode.location_fn ?? null, what_happened: axisNode.what_happened ?? null,
            piece: (axisNode.pieces || []).map((p) => ({ item: p.item, shows: p.shows ?? null }))[0] || null } },
        state: { node: axisNode.id, languages: state.languages || ["en"] },
        stall: { step: steps ? stepOf(steps) : 0, cycle: steps ? cycleOf(steps) : 0, played_days: (pacing.days || []).length },
        watch_for: blocks.map((b) => blockMaterial(events, b)),
        rejections: failureNote(state, "watch"),
      });
      let res;
      try {
        res = await deps.ask(deps.system, context, { role: "watch", task: "watch", models: state.models });
        await logAnswer(store, deps.bibleKey, "watch", nowSec, res);
        await clearFailure("watch");
      } catch (e) {
        await logAnswer(store, deps.bibleKey, "watch", nowSec, null, e);
        if (e instanceof BrainError) {
          if (e.raw != null) await store.setState(failureRecord("watch", e, nowSec));
          return { note: `AI call failed: ${e.message}`, aiFailed: true };
        }
        throw e;
      }
      const pieceIds = new Set((bible?.axis || []).flatMap((n) => (n.pieces || []).map((p) => p.story_id)));
      const g = gateWatch(res.doc, { asked: new Map(blocks.map((b) => [b.player, b])), season, languages: state.languages || ["en"],
        forbidden, storyIds: pieceIds, pushedIds: await store.sentIds() });
      // answered or not, a block is looked at once
      await store.setState({ watch_due: left });
      const quiet = blocks.filter((b) => !g.accepted.some((d) => d.player === b.player)).map((b) => b.player);
      return { directives: g.accepted, rejections: g.rejections,
        note: `watch: ${g.accepted.map((d) => `${d.kind} for ${d.player}`).join(", ") || "nothing written"}${quiet.length ? ` (nothing for ${quiet.join(", ")})` : ""}` };
    }

    // The clue agent (src/clues.js): the chapter model rewrites the rings from the building the
    // piece is really in, and writes the chapter's opening intuition. Returns { notes, directives?, open }.
    // Three parts, judged apart and kept apart (Teko, 2026-10-24): the rings (far, mid, near), wide,
    // and the opening. A part refused, cut or unread is asked again, the agent told exactly what was
    // wrong, at most CLUES_MAX_CALLS calls per chapter (persisted). Still missing after that: the
    // story's own rings stay (wide: the story's far) and the opening has no intuition. The bridge's
    // plain words (plainRings, plainOpen) stand in ONLY when there is no AI credit: the day's cap or
    // budget reached, or the provider saying the account has no credit.
    async function runClues({ axisNode, prefix, answer, accepted, bible, buildings, debug }) {
      const node = axisNode.id;
      const purpose = `clues#${node}`;
      const key = `${prefix}${node}`;
      const inBatch = pieceDirective(accepted, axisNode);
      const piece = inBatch || pieceDirective(Object.values(state.piece_dirs || {}), axisNode);
      const b = piece ? buildingOfTarget(piece.target, buildings) : null;
      if (!b) return { notes: [`${purpose}: the piece's building is not in the catalog read: the story's rings stay`] };
      const askedRoom = typeof piece.target?.room === "string" && (b.rooms || []).includes(piece.target.room) ? piece.target.room : null;
      const facts = buildingFacts(b, buildings, { room: askedRoom });
      const languages = state.languages || ["en"];
      const forbidden = axisNode.ending ? [] : bible?.forbidden_entities || [];
      const ringId = (k) => `${prefix}prox_${node}_${k}_r`;
      const storyFar = (accepted.find((d) => d.id === ringId("far"))?.then || []).find((x) => x?.type === "diary_entry")?.text;
      // the story's far names the place it guessed (the laundromat of 2026-10-22): not good enough for wide
      const storyFarNames = storyFar !== undefined
        && cluesGate({ far: storyFar }, { facts: facts.facts, languages }).errors.some((e) => e.startsWith("far: names"));
      const ringsGate = (texts, keys) => {
        const ids = new Set(keys.map(ringId));
        return gateBatch(withRingTexts(accepted, node, texts, prefix).directives.filter((d) => ids.has(d.id)),
          { languages: state.languages, forbidden }).rejected.map((r) => `${r.id}: ${r.reason}`);
      };
      const PART_NAMES = { core: "far, mid and near", wide: "wide", open: "open" };
      let core = null;   // { texts: { far, mid, near }, cited, room }
      let wide = null;
      let open = null;
      let noCredit = null;
      const notes = [];
      while (!(core && wide && open)) {
        const missing = ["core", "wide", "open"].filter((p) => !{ core, wide, open }[p]).map((p) => PART_NAMES[p]);
        const kept = ["core", "wide", "open"].filter((p) => ({ core, wide, open }[p])).map((p) => PART_NAMES[p]);
        const only = kept.length ? ` This call: ${kept.join(" and ")} already passed and are kept; only ${missing.join(" and ")} will be used, so you may answer only ${missing.length > 1 ? "those" : "that"} (and cites).` : "";
        const a = await clueAsk(key, purpose, (why) => buildContext({
          task: "clues", state_version: state.state_version || 0,
          // what the rings need of the story: the chapter and its piece, never the ending
          bible: { title: bible?.title ?? null, forbidden_entities: forbidden,
            chapter: { id: node, title: axisNode.chapter_title || axisNode.title || null, question: axisNode.question ?? null,
              place: axisNode.place ?? axisNode.location_fn ?? null, what_happened: axisNode.what_happened ?? null,
              piece: (axisNode.pieces || []).map((p) => ({ item: p.item, title: p.title ?? null, shows: p.shows ?? null }))[0] || null } },
          state: { node, languages },
          rejections: why,
          clues_for: {
            rules: `${CLUES_PROMPT}${only}`,
            piece: { item: piece.item ?? null, title: piece.title ?? null, text: piece.text ?? null,
              container: { room: piece.target?.room ?? null, container_pref: piece.target?.container_pref ?? null, on_floor: !!piece.target?.on_floor } },
            solution: stageTexts(accepted, answer?.hints?.[node] || null),
            story_rings: answer?.proximity ?? null,
            building: facts.building, facts: facts.facts.map(({ id, about, distinctive }) => ({ id, about, distinctive })),
            neighbour: facts.neighbour,
          },
        }));
        if (a.exhausted) { notes.push(`${purpose}: ${CLUES_MAX_CALLS} calls spent on this chapter`); break; }
        if (a.noCredit) {
          noCredit = a.noCredit;
          if (a.err) debug.push({ kind: "clues", error: a.err.message, cost: a.err.cost ?? null, raw: a.err.raw ?? null });
          break;
        }
        if (a.err) {
          notes.push(`${a.purpose}: AI call failed (${String(a.err?.message || a.err).slice(0, 120)})`);
          debug.push({ kind: "clues", error: a.err?.message, cost: a.err?.cost ?? null, raw: a.err?.raw ?? null });
          continue;
        }
        const res = a.res;
        const errors = [];
        const g = cluesGate(res.doc, { facts: facts.facts, languages, room: askedRoom });
        if (!core) {
          const own = g.errors.filter((e) => !e.startsWith("wide:"));
          if (!own.length) own.push(...ringsGate({ far: g.texts.far, mid: g.texts.mid, near: g.texts.near }, STORY_RINGS));
          if (own.length) errors.push(...own);
          else {
            core = { texts: { far: g.texts.far, mid: g.texts.mid, near: g.texts.near }, cited: g.cited, room: g.room };
            notes.push(`${a.purpose}: rings rewritten from ${b.id} (mid ${g.cited.mid.join(", ")}; near ${g.cited.near.join(", ")})`);
          }
        }
        if (!wide) {
          const own = g.errors.filter((e) => e.startsWith("wide:"));
          if (!own.length) own.push(...ringsGate({ wide: g.texts.wide }, ["wide"]));
          if (own.length) errors.push(...own);
          else wide = g.texts.wide;
        }
        if (!open) {
          // the opening intuition, judged apart: a bad one costs only itself
          const og = openGate(res.doc?.open, { facts: facts.facts, languages });
          if (og.ok) {
            const tg = gateBatch([{ id: `${prefix}chopen_${node}`, type: "open_chapter", chapter: node, intuition: og.text }],
              { languages: state.languages, forbidden });
            og.errors.push(...tg.rejected.map((r) => `open: ${r.reason}`));
          }
          if (og.errors.length) errors.push(...og.errors);
          else {
            open = og.text;
            notes.push(`${a.purpose}: the opening intuition written from ${b.id}`);
            if (!(state.openings_ai || []).includes(key)) {
              state.openings_ai = [...(state.openings_ai || []), key];
              await store.setState({ openings_ai: state.openings_ai });
            }
          }
        }
        const cut = /cut at the token limit/.test(res.note || "");
        await logAnswer(store, deps.bibleKey, a.purpose, nowSec,
          { ...res, note: [res.note, errors.length ? `refused by the clue gate: ${errors.join("; ")}`.slice(0, 250) : null].filter(Boolean).join("; ") || null });
        debug.push({ kind: "clues", model: res.model, cost: res.cost, answer: res.doc, raw: res.raw ?? null, rejections: errors });
        if (errors.length) {
          notes.push(`${a.purpose}: refused (${errors.slice(0, 3).join("; ")})`);
          await saveClueTry(key, { why: clueReasons({ errors, cut: cut && (!core || !wide || !open) }) });
        }
      }
      // no AI credit: the bridge's plain words for what the agent did not write
      const pr = noCredit ? plainRings(facts, { languages, room: askedRoom }) : null;
      if (noCredit) notes.push(`${purpose}: ${noCredit}: no AI credit`);
      let out = accepted;
      let room = null;
      if (core) {
        out = withRingTexts(accepted, node, { ...core.texts,
          wide: wide || (noCredit && pr?.wide) || (storyFar !== undefined && !storyFarNames ? storyFar : core.texts.far) }, prefix).directives;
        room = core.room;
        if (!wide) notes.push(`${purpose}: wide ${noCredit && pr?.wide ? "in plain words" : storyFarNames || storyFar === undefined ? "takes the agent's far" : "takes the story's far"}`);
      } else if (noCredit && pr && storyFar !== undefined) {
        // the story's far stays unless it names the place; then the plain one
        out = withRingTexts(accepted, node, { wide: wide || pr.wide || storyFar, far: storyFarNames ? pr.far : storyFar, mid: pr.mid, near: pr.near }, prefix).directives;
        room = pr.room;
        notes.push(`${purpose}: wide, mid and near in plain words from ${b.id}`);
      } else {
        // the agent failed (not for credit): the story writer's own rings stay; a good wide is kept
        if (wide) out = withRingTexts(accepted, node, { wide }, prefix).directives;
        notes.push(`${purpose}: the story's rings stay${wide ? " (wide from the agent)" : ""}`);
      }
      // the piece goes where the rings point: the room the near line evokes, when none was asked
      if (room && !askedRoom && inBatch && piece.id && typeof piece.target?.building === "string" && typeof piece.target?.x !== "number") {
        out = withPieceRoom(out, piece.id, room);
        notes.push(`${purpose}: ${piece.id} asked into the ${room}, as the ${core ? "clues" : "plain words"} say`);
      }
      if (!open && noCredit) {
        open = plainOpen(facts, { languages, room: askedRoom });
        if (open) {
          notes.push(`${purpose}: the opening intuition in plain words (no AI credit)`);
          if (!(state.openings_plain || []).includes(key)) {
            state.openings_plain = [...(state.openings_plain || []), key];
            await store.setState({ openings_plain: state.openings_plain });
          }
        }
      } else if (!open) notes.push(`${purpose}: the opening goes without an intuition`);
      return { notes, directives: out === accepted ? undefined : out, open };
    }

    async function run(kind, movedEv, aheadNode = null) {
      const debug = [];   // every answer and what the gates said about it (DEBUG_ANSWERS, local runs only)
      let bible = sealed ? await open(deps.bibleKey, sealed) : null;
      const node = aheadNode || movedEv?.to || state.stage_wanted || state.node || null;
      const events = (await store.recentEvents(80)).map(compactEvent);
      const journeys = journeysByPlayer(await store.recentEvents(400, "player_journey"));
      // the professions players here really have: openers and profession hints are written for
      // these only (with mods the server offers dozens; all of them made the seed too long)
      const professionsPresent = [...new Set([...(await store.recentEvents(400, "player_spawned")), ...(await store.recentEvents(400, "player_journey"))]
        .map((e) => e.profession).filter((p) => typeof p === "string" && p))].slice(0, 12);
      // which node is being written, and is it the final one (docs/01 rule 20)
      const writing = kind === "seed" ? bible?.axis?.[0] : bible?.axis?.find((n) => n.id === node);
      const writingFinal = !!writing?.ending || (kind === "seed" && (bible?.axis?.length || 0) === 1);
      // intermediate nodes: every spawn town plus where players were (random spawns widen the stage);
      // the final node: only outside the spawn towns, nearest to where players were
      const stagePts = stagePoints(events, index);
      const keys = writingFinal
        ? finalStageCells(index, state.catalog_cells, stagePts.near)
        : stageCells(stagePts, index.cell_size || 300);
      const points = writingFinal ? (stagePts.near.length ? stagePts.near : stagePts.towns) : [...stagePts.near, ...stagePts.towns];
      const cellRows = await loadCells(t, keys, state.catalog_cells);
      let places = candidates(cellRows, index.building_fields || [], points, 80);
      const spawns = spawnPoints(index);
      if (writingFinal) {
        places = places.filter((p) => isLouisville(p) || !inSpawnTown(p.id.split("_").slice(1).map(Number), spawns, SPAWN_EXCLUSION));
      }
      const placeRule = writingFinal ? finalPlaceRule(index, Object.fromEntries(places.map((p) => [p.id, p]))) : null;
      const allowedBuildings = new Set([...places.map((p) => p.id), ...(state.used_buildings || [])]);
      const color = bible?.difficulty?.color || state.color || "yellow";
      const ledger = await store.facts();
      const unused = await store.unusedMotifs();
      const axisNode = bible?.axis?.find((n) => n.id === node) || null;
      const stageOf = (n) => {
        if (!n) return null;
        const i = (bible?.axis || []).findIndex((x) => x.id === n.id);
        const next = bible?.axis?.[i + 1]?.id || null;
        return { id: n.id, pieces: n.pieces || [], supplies: n.supplies || [], stall_steps: 4, next, final: !!n.ending || !next };
      };
      const stage = stageOf(axisNode);
      const finalNode = !!axisNode?.ending;
      // a node the bible does not have is no stage: never an AI call for it
      if (kind === "stage" && bible && !axisNode) {
        await store.setState({ stage_wanted: null });
        return { note: `node ${node} is not a chapter of the story: no stage written`, debug };
      }
      const opened = state.containers_opened || 0;
      const k = kFor(state.creativity);
      const loot = scaleLoot(state.loot || {}, lootFactor(index.loot_settings));
      const allowItem = makeAllowItem(loot, opened, k);
      const rewards = rewardCandidates(loot, opened, k);
      // what a piece or a supply may be: the story's clue items and the rewards the loot gate allows now
      const pieceItems = new Set([...clueItems(color), ...rewards.map((r) => r.item)]);
      // the next story (docs/11): what the past ones used, so nothing repeats by accident
      const previous = kind === "seed" && (state.stories_done || []).length
        ? { stories: state.stories_done, used_story_ids: state.story_ids || [] } : null;
      const storyNumber = (state.stories_done || []).length + 1;
      const newSeason = `s${storyNumber}`;

      let rejections = state.last_rejections || [];
      const notes = [];
      let missing = [];
      let accepted = [];
      let answer = null;
      let ringsLater = null;   // { node, texts, prefix, ids }: rings drawn when the piece is placed
      // two writers: the story model designs the bible first, then the stage model fills node one
      // a bible already paid for and checked, whose first chapter was refused: reuse it, never
      // ask the story model again (production 2026-10-22: an Opus bible thrown away with its stage)
      // no kept bible but one was answered and paid for in the last hours (an older bridge threw it
      // away with its refused stage): read it back from the calls log
      if (kind === "seed" && split && !state.pending_bible && typeof store.lastRaw === "function") {
        try {
          const sealedRaw = await store.lastRaw("bible#", nowSec - 6 * 3600);
          const text = sealedRaw ? await open(deps.bibleKey, sealedRaw) : null;
          const doc = text ? readAnswer(String(text)).doc : null;
          const found = doc && (doc.bible || doc);
          if (found && found.axis && !checkBible(found, index.story_max_nodes || 4).length) {
            bible = found;
            notes.push("bible recovered from the calls log (already paid for)");
          }
        } catch (_) { /* nothing to recover */ }
      }
      if (kind === "seed" && split && !bible && state.pending_bible) {
        try {
          const kept = await open(deps.bibleKey, state.pending_bible);
          if (kept && !checkBible(kept, index.story_max_nodes || 4).length) {
            bible = kept;
            notes.push("bible reused (paid for in an earlier tick)");
          }
        } catch (_) { /* unreadable: write a new one */ }
      }
      if (kind === "seed" && split) {
        rejections = failureNote(state, "bible");
        for (let round = 1; round <= MAX_ROUNDS && !bible; round++) {
          const context = buildContext({
            task: "bible", state_version: state.state_version || 0, bible: null,
            state: { players_online: state.last_online || 0, color, languages: state.languages || ["en"], professions_present: professionsPresent,
              story_number: storyNumber, previous_stories: previous?.stories || [], used_story_ids: previous?.used_story_ids || [],
              // where the Ashes of a Mysterious Past were scattered: the next story may begin there
              ...(state.ashes && !state.ashes.used ? { ashes_scattered_at: state.ashes } : {}) },
            ledger, events: events.filter((e) => e.type !== "player_journey").slice(-40), journeys, motifs: unused,
            catalog: { ...worldSlice(index), places, clue_items: clueItems(color), rewards, containers_opened: opened },
            rejections, stage: null, stall: null,
          });
          let res;
          try {
            res = await askStory(deps.system, context, { role: "story", task: "bible", models: state.models });
            await logAnswer(store, deps.bibleKey, `bible#${round}`, nowSec, res);
            await clearFailure("bible");
          } catch (e) {
            await logAnswer(store, deps.bibleKey, `bible#${round}`, nowSec, null, e);
            if (e instanceof BrainError) {
              await store.setState({ ai_last_error: `bible#${round}: ${e.message}`, ...(e.raw != null ? failureRecord("bible", e, nowSec) : {}) });
              debug.push({ kind: "bible", round, error: e.message, cost: e.cost ?? null, raw: e.raw ?? null });
              return { note: `AI call failed: ${e.message}`, aiFailed: true, debug };
            }
            throw e;
          }
          if (res.note) notes.push(`bible#${round}: ${res.note}`);
          const bad = checkBible(res.doc?.bible, index.story_max_nodes || 4, pieceItems, previous);
          debug.push({ kind: "bible", round, model: res.model, cost: res.cost, repaired: !!res.repaired, answer: res.doc, raw: res.raw ?? null, rejections: bad });
          if (bad.length) { rejections = bad.map((r) => ({ id: "bible", reason: r })); continue; }
          bible = { ...res.doc.bible, season: newSeason };
        }
        if (!bible) {
          await store.setState({ last_rejections: rejections });
          return { note: "bible rejected", rejections, debug };
        }
        rejections = [];
      }
      // in a seed the node being written is the bible's first, known only now
      const writeNode = kind === "seed" ? bible?.axis?.[0]?.id ?? null : node;
      const writeStage = kind === "seed" ? stageOf(bible?.axis?.[0]) : stage;
      // the extras of every closed chapter (docs/13 item 5): the AI scores the finder's page in
      // this call; collab.js's tally is the fallback (src/contribution.js).
      const axisList = bible?.axis || [];
      const seasonNow = bible?.season || state.season || "";
      const closedList = kind === "seed" ? [] : axisList.map((n) => n.id).filter((id) => (state.chapter_ends || []).includes(`${seasonNow}:${id}`));
      const decided = kind === "seed" ? {} : { ...(state.extras_decided || {}) };
      const undecided = closedList.filter((c) => !decided[c]);
      const pagesOpen = (state.pages || []).filter((p) => p.season === seasonNow && undecided.includes(p.chapter));
      const minScore = scoreMin(state.extra_chapter_score);
      // the node the extras stand by: the one being written, whose places this call has loaded
      const host = kind === "seed" ? null : writeNode;
      const hostIdx = axisList.findIndex((n) => n.id === host);
      const extrasBy = kind === "seed" ? {} : { ...(state.extras_by_node || {}) };
      // which node each piece belongs to, the extras of earlier chapters included
      const pieceNode = new Map();
      for (const n of axisList) for (const p of n.pieces || []) if (p?.story_id) pieceNode.set(p.story_id, n.id);
      const extraPrefix = `${bible?.season || state.season || "s1"}_`;
      for (const [n, c] of Object.entries(extrasBy)) for (let k = 1; k <= c; k++) pieceNode.set(`${extraPrefix}${n}_extra${k}`, n);
      // the final stage: the bridge chooses the urn's building first, the AI is told where (docs/10)
      let urn = null;
      if (writeStage?.final) {
        urn = urnWords(chooseUrnPlace(places, state.urn_history || [], bible?.finale?.rooms_wanted, index));
        if (!urn) {
          await store.setState({ last_rejections: [{ id: "finale", reason: "no building for the urn" }] });
          return { note: "no building for the urn: the final stage waits", aiFailed: true, debug };
        }
        writeStage.urn = urn;
        // the effects the AI may score the event with (docs/12), and the gap they fill
        writeStage.toolkit = TOOLKIT_PROMPT;
        writeStage.wave_seconds = tier(bible?.difficulty?.color || color).wave_seconds;
      }
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const context = buildContext({
          task: kind === "seed" && split ? "stage" : kind, state_version: state.state_version || 0, bible,
          state: { node: writeNode, players_online: state.last_online || 0, color, languages: state.languages || ["en"],
            professions_present: professionsPresent, story_number: storyNumber,
            previous_stories: previous?.stories || [], used_story_ids: previous?.used_story_ids || [],
            ...(state.ashes && !state.ashes.used ? { ashes_scattered_at: state.ashes } : {}),
            // the finders' chapter pages to score (their text is in motifs), docs/13 item 5
            ...(pagesOpen.length ? { pages_to_score: pagesOpen.map((p) => ({ motif: p.id, player: p.player, chapter: p.chapter })),
              extra_chapter_score: minScore, extra_chapter_host: host } : {}) },
          ledger, events: events.filter((e) => e.type !== "player_journey").slice(-40), journeys, motifs: unused,
          catalog: { ...worldSlice(index), places, clue_items: clueItems(color), rewards, containers_opened: opened },
          rejections: round === 1 ? [...failureNote(state, kind), ...rejections] : rejections, stage: writeStage, stall: null,
        });
        let res;
        try {
          res = await deps.ask(deps.system, context, { role: "stage", task: kind === "seed" && split ? "stage" : kind, models: state.models });
          await logAnswer(store, deps.bibleKey, `${kind}#${round}`, nowSec, res);
          await clearFailure(kind);
        } catch (e) {
          await logAnswer(store, deps.bibleKey, `${kind}#${round}`, nowSec, null, e);
          if (e instanceof BrainError) {
            await store.setState({ ai_last_error: `${kind}#${round}: ${e.message}`, last_rejections: rejections,
              ...(e.raw != null ? failureRecord(kind, e, nowSec) : {}) });
            debug.push({ kind, round, error: e.message, cost: e.cost ?? null, raw: e.raw ?? null });
            return { note: `AI call failed: ${e.message}`, aiFailed: true, debug };
          }
          throw e;
        }
        if (res.note) notes.push(`${kind}#${round}: ${res.note}`);
        answer = res.doc;
        debug.push({ kind, round, model: res.model, cost: res.cost, repaired: !!res.repaired, answer: res.doc, raw: res.raw ?? null });
        if (kind === "seed" && !split) {
          const bad = checkBible(answer.bible, index.story_max_nodes || 4, pieceItems, previous);
          if (bad.length) { rejections = bad.map((r) => ({ id: "bible", reason: r })); continue; }
          bible = { ...answer.bible, season: newSeason };
        }
        // near the node, the diary feels it: rings from where the anchor piece really is
        const axisNow = kind === "seed" ? bible.axis[0] : axisNode;
        // what only the bridge writes (the finale script) and, on the last node, the story's end
        // (the urn ends it) are refused from the AI by name
        const bridgeOnly = [];
        const aiDirs = (answer.directives || []).filter((d) => {
          const types = [d?.type, ...(Array.isArray(d?.then) ? d.then.map((t) => t?.type) : [])];
          const bad = types.find((t) => BRIDGE_ONLY_TYPES.has(t) || (writeStage?.final && t === "season_complete"));
          if (bad) bridgeOnly.push({ id: d?.id || "?", reason: `the bridge writes the finale: ${bad} is not yours to send` });
          return !bad;
        });
        // only the chapter's piece is a ZTales item: a clue is an ordinary item or a plain sheet
        // (Teko, 2026-10-22); a closing's diary line on node_changed (no player) goes to everyone
        const pieceSet = new Set((bible?.axis || []).flatMap((n) => (n.pieces || []).map((p) => p.story_id)));
        const clue = fixClueItems(aiDirs, (sid) => pieceSet.has(sid) || /_extra\d+$/.test(sid));
        notes.push(...clue.notes, ...fillClosingPlayers(aiDirs));
        bridgeOnly.push(...clue.rejected);
        ringsLater = null;
        const center = nodeCenter([...aiDirs, ...(state.placed || [])], axisNow);
        const proxMissing = axisNow ? missingProximity(answer.proximity) : [];
        const prefix = `${bible?.season || state.season || "s1"}_`;
        const prox = center && proxMissing.length === 0 ? proximityDirectives(axisNow.id, center, answer.proximity, prefix) : [];
        // every piece weighs from the first chapter: this stage's pieces are charged now
        const extra = [];
        const scoreCtx = { waveSeconds: writeStage?.wave_seconds, placeKind: "building", modVersion: state.mod_version || "0" };
        const finRej = writeStage?.final ? checkFinaleAnswer(answer.finale, urn, state.languages || ["en"], notes, scoreCtx) : [];
        if (writeStage?.final) {
          if (finRej.length === 0) {
            const pieceDirs = { ...(state.piece_dirs || {}) };
            for (const d of aiDirs) if (d?.story_id && ["place_item", "write_note", "write_map"].includes(d.type)) pieceDirs[d.story_id] = d;
            const rewardRows = await loadRewardRows(t, parse);
            // one bonus list per extra piece the urn might hold: the extras of every chapter
            // (this one's too) and every node's spare pieces (more than one carried in)
            const spare = piecesByNode(bible).reduce((a, n) => a + Math.max(0, n.ids.length - 1), 0);
            // each chapter still undecided may still bring up to EXTRA_MAX (a list unused costs nothing)
            const madeBefore = Object.values(extrasBy).reduce((a, c) => a + c, 0);
            const bonusCount = Math.min(URN_BONUS_MAX, madeBefore + undecided.length * EXTRA_MAX + spare);
            extra.push(...finaleDirectives({ bible, fin: answer.finale, urn, languages: state.languages || ["en"], allowItem, pieceDirs, prefix, storyNumber, rewardRows,
              bonusCount, modVersion: state.mod_version || "0" }));
          }
        } else if (axisNow) {
          const charge = chargeDirective(`${prefix}charge_${axisNow.id}`, bible, [axisNow.id]);
          if (charge) extra.push(charge);
        }
        const knownStoryIds = new Set([...(state.story_ids || []), ...storyIdsIn(aiDirs), ...storyIdsIn(prox), `${prefix}fin_urn`,
          ...(bible?.axis || []).flatMap((n) => (n.pieces || []).map((p) => p.story_id))]);
        const g = gateBatch([...aiDirs, ...prox, ...extra], {
          pushedIds: await store.sentIds(), knownStoryIds, allowedBuildings, languages: state.languages, placeRule,
          allowItem: (it) => it === PLAIN_NOTE || allowItem(it),
          forbidden: finalNode ? [] : bible?.forbidden_entities || [],
        });
        // two pieces of one node never share a square or a container (Teko, in game)
        const shared = sharedSpots(g.accepted, pieceNode, state.placed || []);
        const sharedIds = new Set(shared.map((x) => x.id));
        // one piece per chapter, never a copy of it (docs/13)
        const pieceIds = new Set((bible?.axis || []).flatMap((n) => (n.pieces || []).map((p) => p.story_id)));
        const dup = duplicatePieces(g.accepted.filter((d) => !sharedIds.has(d.id)), pieceIds, state.placed || []);
        const dupIds = new Set(dup.map((x) => x.id));
        accepted = g.accepted.filter((d) => !sharedIds.has(d.id) && !dupIds.has(d.id));
        g.rejected.push(...shared, ...dup);
        // the story moves along the axis only: a set_node elsewhere is set to the next chapter,
        // or dropped on the last one (the urn ends it)
        const stageNow = kind === "seed" ? stageOf(bible.axis[0]) : stage;
        notes.push(...fixSetNodes(accepted, new Set((bible?.axis || []).map((n) => n.id)), stageNow));
        // a reaction on reading a piece nobody can read would never fire (live run 2026-10-22)
        notes.push(...fixUnreadable(accepted, storyItems(accepted, storyItems(Object.values(state.piece_dirs || {})))));
        const curStage = kind === "seed" ? stageOf(bible.axis[0]) : stage;
        if (curStage) notes.push(...ensureChapterEnds(accepted, (bible?.axis || []).find((n) => n.id === curStage.id)));
        missing = curStage ? missingCoverage(curStage, accepted) : [];
        // a supply the AI listed but did not place is a gift lost, not a broken story: noted,
        // never a reason to throw the stage away (live AI run 2026-10-21: two stages lost to it)
        for (const m of missing.filter((x) => x.startsWith("supply "))) notes.push(`${m}: not placed, dropped`);
        missing = missing.filter((x) => !x.startsWith("supply "));
        if (proxMissing.length) missing.push(`proximity reflections (${proxMissing.join(", ")})`);
        else if (axisNow && !center) {
          // no place known yet for the piece: the rings are drawn once the mod reports where it
          // went (src/tick.js, ringsOnceKnown), so a stage written ahead never goes without them
          const ids = new Set((axisNow.pieces || []).map((p) => p.story_id));
          const holders = accepted.flatMap((d) => [d, ...(Array.isArray(d.then) ? d.then : [])])
            .filter((x) => x && (ids.has(x.story_id) || (Array.isArray(x.inventory) && x.inventory.some((it) => ids.has(it?.story_id)))))
            .map((x) => x.id).filter(Boolean);
          ringsLater = holders.length ? { node: axisNow.id, texts: answer.proximity, prefix, ids: holders } : null;
          notes.push(ringsLater ? `no place known yet for ${axisNow.id}: proximity rings drawn once its piece is placed`
            : `no place found for ${axisNow.id}: proximity rings skipped`);
        }
        rejections = [...bridgeOnly, ...finRej.map((r) => ({ id: "finale", reason: r })), ...g.rejected,
          ...missing.map((m) => ({ id: "coverage", reason: `missing ${m}` }))];
        debug[debug.length - 1].rejections = rejections;
        // what each round got wrong, readable afterwards (the AI's second round sees it too)
        await store.setState({ [`round_${round}_rejections`]: rejections.slice(0, 60) });
        if (rejections.length === 0) break;
      }

      if (kind === "seed" && (!bible || checkBible(bible, index.story_max_nodes || 4).length)) {
        await store.setState({ last_rejections: rejections });
        return { note: "seed rejected", rejections, debug };
      }
      // a stage missing its pieces, its way on or its stall steps would leave the story stuck in
      // the world (the first two-writer rehearsal sealed a bible with nothing placed, 2026-10-14):
      // keep nothing, back off, try again later
      if (missing.length) {
        // a stage written ahead is simply asked again later (never the current chapter's retry);
        // a seed whose bible is good keeps the bible for the retry, so only the stage is paid again
        const keepBible = kind === "seed" && bible && !checkBible(bible, index.story_max_nodes || 4).length
          ? { pending_bible: await seal(deps.bibleKey, bible) } : {};
        await store.setState({ last_rejections: rejections, ...keepBible, ...(kind === "stage" && node && !aheadNode ? { stage_wanted: node } : {}) });
        return { note: `${kind} rejected: missing ${missing.join("; ")}`, rejections, debug, aiFailed: true };
      }
      // the clue agent (src/clues.js, Teko 2026-10-23): the stage passed, its piece has a building;
      // a small call (two retries at most) rewrites the rings from that building's real facts. Any
      // failure keeps the story's own rings: never a reason to hold the chapter back
      const ringAxis = kind === "seed" ? bible?.axis?.[0] : axisNode;
      const ringPrefix = `${bible?.season || state.season || "s1"}_`;
      let intuition = null;   // the chapter's opening intuition (docs/13), from the same call
      if (ringAxis && typeof deps.askClues === "function" && ringsIn(accepted, ringAxis.id, ringPrefix)) {
        const c = await runClues({ axisNode: ringAxis, prefix: ringPrefix, answer, accepted, bible,
          buildings: buildingsOf(cellRows, index.building_fields || []), debug });
        notes.push(...c.notes);
        if (c.directives) accepted = c.directives;
        intuition = c.open ?? null;
      }
      // the extras of the closed chapters (docs/13 item 5): the AI's page score first, collab.js's
      // tally as the fallback; bridge-made, gated like the rest, never a reason to throw the stage
      // away (a building that is not there is a gift lost, noted). They go out at once, even when
      // the stage they stand by is written ahead: an extra never blocks the spine.
      const extrasOut = [];
      let extrasMade = 0;
      const extraChapters = [];
      const plan = planExtras({ closed: closedList, decided, pages: pagesOpen,
        contribs: readContributions(answer?.contribution, pagesOpen), final: !!writeStage?.final });
      const hostNode = hostIdx >= 0 ? axisList[hostIdx] : null;
      if (answer?.extra_chapter && !plan.some((p) => p.by === "ai" && p.score >= minScore)) notes.push("extra_chapter without a page scored for it: dropped");
      for (const p of plan) {
        let count = 0;
        let ec = null;
        if (p.by === "ai") {
          count = p.score >= minScore ? 1 : 0;
          notes.push(`page of ${p.chapter} by ${p.player}: ${p.score}${p.why ? ` (${p.why})` : ""} -> ${count ? "an extra chapter" : "no extra"}`);
        } else {
          const sc = collabScore(state.collab?.chapters?.[p.chapter]);
          count = extraCount(sc.score);
          notes.push(`collaboration in ${p.chapter}: ${sc.score} (${Object.entries(sc.parts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing"}) -> ${count} extra`);
        }
        let made = 0;
        if (count > 0 && hostNode) {
          const nodeIds = new Set((hostNode.pieces || []).map((x) => x.story_id));
          const hostPrefix = `${extraPrefix}${host}_extra`;
          const all = [...accepted, ...extrasOut].flatMap((d) => [d, ...(Array.isArray(d.then) ? d.then : [])]);
          const where = [...(state.placed || []), ...all].filter((d) => d && nodeIds.has(d.story_id) && d.target);
          // every building that holds a piece or an extra already: never two in one
          const busy = new Set([...(state.placed || []), ...all].filter((d) => d && d.target?.building
            && (pieceNode.has(d.story_id) || String(d.story_id || "").startsWith(extraPrefix))).map((d) => d.target.building));
          const start = (extrasBy[host] || 0) + 1;
          const ex = extraDirectives({ node: host, count, prefix: extraPrefix, pieces: hostNode.pieces || [], places, start,
            taken: [...busy], center: nodeCenter(where, hostNode), languages: state.languages || ["en"], families: CLUE_FAMILIES });
          notes.push(...ex.notes);
          let dirs = ex.directives;
          // a strong page: the extra chapter the AI grew from it (one piece, its question in the
          // finder's diary); without a usable one, the bridge's extra piece still rewards the page
          if (p.by === "ai") {
            const free = new Map(places.filter((x) => !busy.has(x.id)).map((x) => [x.id, x]));
            const chk = checkExtraChapter(answer?.extra_chapter, { languages: state.languages || ["en"], forbidden: bible?.forbidden_entities || [],
              axisIds: axisList.map((n) => n.id), freePlaces: free, families: CLUE_FAMILIES });
            notes.push(...chk.errs.map((e) => `${p.chapter}: ${e}`));
            // the AI's own building (offered, free) even when none is free near the node
            const d = dirs[0] || (chk.ok?.building ? { id: `${hostPrefix}${start}`, type: "place_item", story_id: `${hostPrefix}${start}`,
              node: host, mod_data: { node: host, extra: true } } : null);
            if (chk.ok && d) {
              const piece = { ...d, item: `ZTales.${chk.ok.family}Yellow`, title: chk.ok.title || extraTitle(chk.ok.family, state.languages || ["en"]),
                ...(chk.ok.text ? { text: chk.ok.text } : {}), mod_data: { ...d.mod_data, extra_chapter: p.chapter },
                ...(chk.ok.building ? { target: { building: chk.ok.building, ...(chk.ok.room ? { room: chk.ok.room } : {}) } } : {}) };
              const wayBack = chk.ok.way_back || axisList[hostIdx + 1]?.id || host;
              ec = { chapter: p.chapter, player: p.player, piece: d.story_id, question: chk.ok.question, way_back: wayBack, host };
              dirs = [piece, { id: `${extraPrefix}xch_${p.chapter}_${p.player}`, type: "diary_entry", player: p.player, kind: "extra_chapter",
                node: host, text: chk.ok.question }];
            }
          }
          // clue items are the story's own (never loot-gated); the rest is the loot gate's
          const ge = gateBatch(dirs, { pushedIds: await store.sentIds(), allowedBuildings, languages: state.languages, placeRule,
            forbidden: bible?.forbidden_entities || [], allowItem: (it) => (/^ZTales\./.test(it) ? true : allowItem(it)) });
          const exNode = new Map(pieceNode);
          for (const d of ge.accepted) if (d.story_id) exNode.set(d.story_id, host);
          const clash = new Set(sharedSpots(ge.accepted.filter((d) => d.story_id), exNode, where).map((x) => x.id));
          for (const r of [...ge.rejected, ...[...clash].map((id) => ({ id, reason: "shares a spot with a piece" }))]) notes.push(`extra ${r.id} dropped: ${r.reason}`);
          // the ids are numbered on from `start`: keep only an unbroken run, so the next counts right
          const ok = new Set(ge.accepted.filter((d) => d.story_id && !clash.has(d.id)).map((d) => d.id));
          let run = 0;
          while (ok.has(`${hostPrefix}${start + run}`)) run++;
          const kept = ge.accepted.filter((d) => ok.has(d.id) && Number(d.id.slice(hostPrefix.length)) < start + run);
          // the extra chapter's question only with its piece
          if (ec && kept.some((d) => d.story_id === ec.piece)) {
            kept.push(...ge.accepted.filter((d) => d.type === "diary_entry"));
            extraChapters.push(ec);
          }
          extrasOut.push(...kept);
          made = kept.filter((d) => d.story_id).length;
          if (made) extrasBy[host] = (extrasBy[host] || 0) + made;
          for (let k = start; k < start + made; k++) pieceNode.set(`${hostPrefix}${k}`, host);
        }
        extrasMade += made;
        decided[p.chapter] = { by: p.by, ...(p.by === "ai" ? { player: p.player, score: p.score } : {}), count: made, host };
      }
      // stall help repeats every cycle and reaches each player (docs/13 item 6)
      notes.push(...splitStall(accepted));
      // the chapter's end for everyone (src/chapterend.js): the AI's lines, kept for the moment
      // the piece is picked up; the bridge's own lines when they are missing or incomplete
      const endId = kind === "seed" ? bible?.axis?.[0]?.id : node;
      const endNode = (bible?.axis || []).find((n) => n.id === endId);
      const endTexts = chapterEndTexts(answer?.chapter_end, state.languages || ["en"], endNode?.ending ? [] : bible?.forbidden_entities || []);
      if (answer?.chapter_end && !endTexts.record && !endTexts.echo) notes.push(`chapter_end of ${endId}: incomplete, the bridge's lines will do`);
      const chapterEnds = { ...(kind === "seed" ? {} : state.chapter_end_texts || {}),
        ...(endNode ? { [endId]: { ...endTexts, title: endNode.chapter_title || endNode.title || null } } : {}) };
      if (kind === "seed") {
        await store.setBible(bible.season, await seal(deps.bibleKey, bible));
        await store.setState({ pending_bible: null });
        // the next story: the past one archived, the mod told to open, the diaries told the new
        // first hint (new characters get it from hints.json; those who already have a diary
        // get it as an entry, on the spot), the story's own state clean
        if (previous) {
          const seen = new Set();
          for (const e of await store.recentEvents(3000)) if (typeof e.player === "string" && e.player) seen.add(e.player);
          const hint = answer?.hints?.[bible.axis[0].id]?.full?.text ?? answer?.hints?.full?.text;
          const opening = [...seen].map((p) => ({ id: `${bible.season}_opening_${p}`, type: "diary_entry", player: p, deliver: "now",
            kind: "opening", node: bible.axis[0].id, text: hint })).filter((d) => d.text);
          accepted.unshift(...opening);
        }
        if (!accepted.some((d) => d.type === "set_node")) accepted.unshift({ id: `${bible.season}_open_${bible.axis[0].id}`, type: "set_node", node: bible.axis[0].id, color });
        if (previous) accepted.unshift({ id: `${bible.season}_open`, type: "season_open", season: bible.season, color });
        await store.setState({
          pieces_by_node: piecesByNode(bible).map((n) => ({ node: n.node, ids: n.ids })),
          story_closed: false, story_closed_game_day: null, game_day_last: null, placed: [], piece_dirs: {}, pieces: {}, lost_signaled: [],
          stories_done: previous ? state.stories_done : (state.stories_done || []),
        });
        state.placed = []; state.piece_dirs = {};
      }
      // every chapter opens in every diary (docs/13, Teko 2026-10-23): last in the batch, after the
      // set_node that enters it (numbered by it); the first chapter without its intuition (the
      // day-zero page carries the hint)
      if (ringAxis) {
        notes.push(...ensureChapterOpen(accepted, ringAxis, { prefix: ringPrefix, intuition, first: kind === "seed" }));
        // this chapter's opening goes out with its stage: the backfill above never sends it again
        const k = `${ringPrefix}${ringAxis.id}`;
        if (!(state.openings_sent || []).includes(k)) {
          state.openings_sent = [...(state.openings_sent || []), k];
          await store.setState({ openings_sent: state.openings_sent });
        }
      }
      const both = [...accepted, ...extrasOut];
      const used = new Set(state.used_buildings || []);
      for (const d of both) if (d.target?.building) used.add(d.target.building);
      await store.markMotifsUsed(Array.isArray(answer?.motifs_used) ? answer.motifs_used.map(String) : []);
      const openNode = kind === "seed" ? bible.axis[0].id : node;
      // pages scored (or given up) leave the list; the rest wait for the next call
      const pagesLeft = (state.pages || []).filter((p) => !(p.season === seasonNow && decided[p.chapter]));
      await store.setState({
        last_rejections: rejections, used_buildings: [...used],
        story_ids: [...new Set([...(state.story_ids || []), ...storyIdsIn(both)])],
        placed: [...(state.placed || []), ...both.filter((d) => d.story_id && d.target && d.type !== "define_zone")
          .map((d) => ({ story_id: d.story_id, target: d.target }))].slice(-200),
        piece_dirs: { ...(state.piece_dirs || {}), ...Object.fromEntries(both
          .filter((d) => d.story_id && ["place_item", "write_note", "write_map"].includes(d.type)).map((d) => [d.story_id, d])) },
        urn_history: urn ? [...(state.urn_history || []), urn.id] : state.urn_history || [],
        creativity: nextCreativity(state.creativity, answer?.creativity_score),
        chapter_end_texts: chapterEnds,
        rings_pending: { ...(kind === "seed" ? {} : state.rings_pending || {}), ...(ringsLater ? { [ringsLater.node]: ringsLater } : {}) },
        // the extras of this story per node, how each closed chapter's were decided, the extra
        // chapters opened, and the season's tally (the Final Tale's)
        extras_by_node: extrasBy,
        extras_decided: decided,
        extra_chapters: [...(kind === "seed" ? [] : state.extra_chapters || []), ...extraChapters],
        extras_total: (state.extras_total || 0) + extrasMade,
        pages: kind === "seed" ? [] : pagesLeft,
        season: bible?.season || state.season || "",
        state_version: (state.state_version || 0) + 1,
        ...(aheadNode
          // written ahead (docs/13 item 7): kept unsent until the story reaches this node
          ? { ahead: { node: openNode, season: bible?.season || state.season || "", at: nowSec, directives: accepted,
            hints: hintsFor(answer?.hints, openNode, color) } }
          : {
            stage_written: openNode, node: openNode, node_at: nowSec,
            // written: nothing left to retry (a stale one rewrote an older chapter, live run 2026-10-21)
            stage_wanted: null,
            ...(kind === "seed" ? { ahead: null } : {}),
          }),
      });
      if (aheadNode) {
        return { debug, directives: extrasOut, rejections, missing, season: bible?.season || state.season || "",
          note: [`stage ${openNode} written ahead, kept until the story reaches it`, ...notes].join("; ") };
      }
      return { debug, directives: both, hints: hintsFor(answer?.hints, openNode, color), rejections, missing,
        season: bible?.season || state.season || "",
        note: notes.length ? notes.join("; ") : undefined };
    }
  };
}
