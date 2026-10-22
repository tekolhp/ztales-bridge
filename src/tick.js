/**
 * One cycle of the bridge (docs/02, "Cycle"). Pure: the transport, store, clock and the
 * decision hook are passed in, so the tests drive it with memory fakes.
 *
 *   shouldConnect(state, nowSec, hasQueue) -> bool     (decided before opening any connection)
 *   tick({ t, store, nowSec, decide, version }) -> report
 */
import { OUTBOX_CONSUMED, INBOX_DIRECTIVES } from "./protocol.js";
import { gateBatch } from "./gates.js";
import { fresh as freshPacing, notePlayed, onNode, pendingSignals } from "./pacing.js";
import { updatePieces, lostSignals } from "./pieces.js";
import { updateCollab } from "./collab.js";
import { cleanModels } from "./models.js";
import { chapterEndDirectives, closedChapters, playersIn } from "./chapterend.js";
import { cleanActive, updateBlocks, dueBlocks, blockHours } from "./watch.js";
import { scoreMin } from "./contribution.js";
import { updateCarriers, isStoryPiece, carrierNote } from "./carrier.js";
import { proximityDirectives } from "./proximity.js";

export const IDLE_POLL_SEC = 600;      // nobody online: look every 10 minutes
export const BUSY_POLL_SEC = 50;       // somebody online: every cron minute
export const HEARTBEAT_SEC = 300;      // bridge-heartbeat.json at least this often while polling

/** After n failed connections in a row: wait 1, 2, 4... minutes, at most 30. */
export function backoffSec(n) {
  return Math.min(1800, 60 * 2 ** Math.max(0, n - 1));
}

export function shouldConnect(state, nowSec, hasQueue = false) {
  // a host that refused us is left alone until the backoff passes, queue or not
  if (state.ftp_backoff_until && nowSec < state.ftp_backoff_until) return false;
  if (hasQueue) return true;
  if (!state.last_poll) return true;
  const gap = nowSec - state.last_poll;
  return gap >= ((state.last_online || 0) > 0 ? BUSY_POLL_SEC : IDLE_POLL_SEC);
}

function parse(text) {
  if (text == null) return null;
  try { return JSON.parse(text.replace(/^﻿/, "")); } catch { return null; }
}

/** reaction_fired events -> ledger rows (a fact is known from its first reveal on) */
export function factsFrom(events) {
  const out = [];
  for (const ev of events) {
    if (ev.type !== "reaction_fired" || !Array.isArray(ev.reveals)) continue;
    for (const f of ev.reveals) {
      out.push({ fact: String(f), stage: ev.stage ?? null, revealed_by: ev.id ?? null,
        first_seen: { player: ev.player ?? null, game_time: ev.game_time ?? null } });
    }
  }
  return out;
}

export async function tick({ t, store, nowSec, decide = null, version = "0", tzOffsetHours = 0 }) {
  const report = { status: "ok", seq: null, pulled: 0, deleted: 0, acked: 0, pushed: 0, rejected: [], notes: [] };
  const state = await store.getState();
  const seqDoc = parse(await t.get("outbox/seq.json"));
  if (!seqDoc) {
    // the mod has not written anything yet (not installed, or the path is wrong)
    await store.setState({ last_poll: nowSec });
    report.status = "no_mod";
    return report;
  }
  report.seq = seqDoc.seq;
  const patch = { last_poll: nowSec, last_online: Number(seqDoc.players_online) || 0 };
  // the languages players' games use: the AI writes every text in each of them
  if (Array.isArray(seqDoc.languages) && seqDoc.languages.length) patch.languages = seqDoc.languages.map(String);
  // what the installed mod can do (docs/12: the urn's newer effects need 0.2.0)
  if (typeof seqDoc.mod_version === "string") patch.mod_version = seqDoc.mod_version;
  // the Claude model the owner chose per task in the sandbox (src/models.js): whitelisted ids
  // only, null = the bridge's own setting; a mod that does not write it leaves all three null
  patch.models = cleanModels(seqDoc.models);
  // the page score that opens an extra chapter (docs/13 item 5), the owner's sandbox choice
  patch.extra_chapter_score = scoreMin(seqDoc.extra_chapter_score);
  // the longest, in real seconds, a finder's chapter page stays open (ChapterPageHours + a night): the next
  // stage waits for that page at most this long plus a grace (src/story.js pageWaitSec)
  const win = Number(seqDoc.page_window_sec);
  patch.page_window_sec = Number.isFinite(win) && win > 0 ? Math.round(win) : null;
  // each player's block of real active play (docs/13 item 4): a block that reaches
  // WatchBlockHours closes and waits for the AI's look (src/watch.js); idle players add nothing
  if (seqDoc.active && typeof seqDoc.active === "object") {
    const w = updateBlocks(state.watch_blocks, cleanActive(seqDoc.active), nowSec, blockHours(seqDoc.watch_block_hours));
    const wp = { watch_blocks: w.blocks };
    const due = dueBlocks(state.watch_due, w.closed, nowSec);
    if (w.closed.length || due.length !== (state.watch_due || []).length) wp.watch_due = due;
    // stored now, not with the tick's patch: the watch task (story.js) clears what it answered
    await store.setState(wp);
    Object.assign(state, wp);
    if (w.closed.length) report.notes.push(`block closed for ${w.closed.map((c) => c.player).join(", ")}`);
  }
  const fresh = [];

  if (seqDoc.seq !== state.last_seq) {
    const names = (await t.list("outbox")).filter((n) => OUTBOX_CONSUMED.test(n)).sort();
    for (const name of names) {
      if (!(await store.hasFile(name))) {
        const doc = parse(await t.get(`outbox/${name}`));
        const kind = name.startsWith("journal-") ? "journal" : "events";
        let events = [];
        if (doc && kind === "events" && Array.isArray(doc.events)) events = doc.events;
        if (doc && kind === "journal") {
          events = (Array.isArray(doc.entries) ? doc.entries : [doc]).map((e) => ({ type: "journal", ...e }));
        }
        if (!doc) report.notes.push(`unreadable ${name}`);
        await store.addFile(name, doc ? kind : "unreadable", events);
        fresh.push(...events);
        report.pulled++;
      }
      // delete only after the store has it: a failed delete just means we skip it next time
      if (await t.del(`outbox/${name}`)) report.deleted++;
    }

    // the mod lists inbox files it consumed; it cannot delete them itself
    const ack = parse(await t.get("outbox/inbox-ack.json"));
    if (ack && Array.isArray(ack.consumed) && ack.consumed.length) {
      const present = new Set(await t.list("inbox"));
      for (const n of ack.consumed) {
        if (INBOX_DIRECTIVES.test(n) && present.has(n) && (await t.del(`inbox/${n}`))) report.acked++;
      }
    }

    const idx = parse(await t.get("catalog/index.json"));
    if (idx && idx.version && idx.version !== state.catalog_version) {
      patch.catalog_version = idx.version;
      patch.catalog_index = idx;
      // only the keys: which map cells have buildings, so no FTP round trip asks for an empty one
      const cells = parse(await t.get("catalog/cells.json"));
      patch.catalog_cells = cells && Array.isArray(cells.cells) ? cells.cells.map((c) => c.cell) : [];
      // the loot horizon (catalog/loot.json): p_eff per item, for the loot gate
      const loot = parse(await t.get("catalog/loot.json"));
      patch.loot = loot && loot.p_eff ? loot.p_eff : {};
      report.catalog = "updated";
    }
    patch.last_seq = seqDoc.seq;
  }

  // the mod's server-wide count of first container opens: the loot gate's clock
  for (const ev of fresh) {
    if (ev.type === "counters" && typeof ev.containers_opened === "number") patch.containers_opened = ev.containers_opened;
  }

  const facts = factsFrom(fresh);
  if (facts.length) await store.addFacts(facts);

  // stalled chapters: count real days with players, raise the help signals that are due
  let pacing = state.pacing || freshPacing();
  // only a chapter of the story is counted (a node outside the axis is no chapter, 2026-10-22)
  const axisIds = new Set((state.pieces_by_node || []).map((n) => n.node));
  for (const ev of fresh) if (ev.type === "node_changed" && ev.to && (!axisIds.size || axisIds.has(String(ev.to)))) pacing = onNode(pacing, String(ev.to));
  pacing = notePlayed(pacing, nowSec, patch.last_online, tzOffsetHours);
  const pace = (patch.catalog_index || state.catalog_index || {}).hint_pace || "auto";
  const due = pendingSignals(pacing, pace);
  if (due.signals.length) {
    await store.enqueue(due.signals);
    report.signals = due.signals.map((x) => x.id);
  }
  patch.pacing = due.pacing;

  // pieces in play (docs/10 2.6): a node whose every piece is lost gets its anchor piece back,
  // on a signal the mod answers with a reaction written ahead; no AI call
  patch.pieces = updatePieces(state.pieces || {}, fresh, nowSec);
  const lost = lostSignals(patch.pieces, state.pieces_by_node || [], state.lost_signaled || [], nowSec);
  if (lost.length) {
    await store.enqueue(lost);
    patch.lost_signaled = [...(state.lost_signaled || []), ...lost.map((s) => s.node)];
    report.signals = [...(report.signals || []), ...lost.map((s) => s.id)];
  }

  // a piece on a dead carrier (src/carrier.js): the story waits on that body; the marker is
  // the record and a note; the new life's dream and diary say where it lies (src/story.js)
  if (fresh.some((e) => ["player_died", "carrier_rose", "former_self_killed", "carrier_body_gone", "item_picked", "pieces_held", "urn_piece"].includes(e?.type))) {
    const pieceIds = new Set((state.pieces_by_node || []).flatMap((n) => n.ids || []));
    const before = state.carriers || [];
    patch.carriers = updateCarriers(before, fresh, isStoryPiece(pieceIds), nowSec);
    for (const c of patch.carriers) if (!before.some((b) => b.player === c.player && b.life === c.life)) report.notes.push(carrierNote(c));
    for (const e of fresh) {
      if (e?.type === "carrier_rose") report.notes.push(`the body carrying ${(e.story_ids || []).join(", ")} rose: no put-back while it walks`);
      if (e?.type === "former_self_killed") report.notes.push(`${e.by || "someone"} put down the risen carrier of ${(e.story_ids || []).join(", ")}`);
      if (e?.type === "carrier_body_gone") report.notes.push(`the body that carried ${(e.story_ids || []).join(", ")} is gone: put-back allowed`);
    }
  }

  // proximity rings written before their piece had a place (src/story.js ringsLater): drawn
  // around where the mod really put it, once it says so
  const ringsPending = state.rings_pending || {};
  if (Object.keys(ringsPending).length && fresh.length) {
    const left = { ...ringsPending };
    const rings = [];
    for (const [node, p] of Object.entries(ringsPending)) {
      if ((state.chapter_ends || []).includes(`${state.season || ""}:${node}`)) { delete left[node]; continue; }
      const ev = fresh.find((e) => e?.type === "directive_applied" && (p.ids || []).includes(e.id) && typeof e.x === "number" && typeof e.y === "number");
      if (!ev) continue;
      const g = gateBatch(proximityDirectives(node, [ev.x, ev.y], p.texts || {}, p.prefix || ""), { languages: state.languages });
      rings.push(...g.accepted);
      delete left[node];
      report.notes.push(`rings of ${node} drawn around its piece (${g.accepted.length} directives${g.rejected.length ? `, ${g.rejected.length} refused` : ""})`);
    }
    if (rings.length) await store.enqueue(rings);
    if (Object.keys(left).length !== Object.keys(ringsPending).length) patch.rings_pending = left;
  }

  // what players did in each chapter (src/collab.js): the next chapter's extra pieces
  if (fresh.length || !state.collab) {
    patch.collab = updateCollab(state.collab || null, fresh, { season: state.season || "", node: state.node || null,
      piecesByNode: state.pieces_by_node || [] });
  }

  // the end of a chapter, for everyone (src/chapterend.js, docs/13): a record for those who took
  // part, an echo for the rest, the mark for all; no AI call, the texts written with the stage
  const season = state.season || "";
  const seen = state.seen_players?.season === season ? state.seen_players.players || [] : [];
  const seenNow = playersIn(fresh, seen);
  if (seenNow.length !== seen.length || state.seen_players?.season !== season) patch.seen_players = { season, players: seenNow };
  const closed = closedChapters(fresh, state.pieces_by_node || [], season, state.chapter_ends || [], patch.pieces);
  if (closed.length) {
    const tally = (patch.collab || state.collab)?.chapters || {};
    const ends = closed.flatMap((c) => chapterEndDirectives({ season, node: c.node, finder: c.finder,
      near: tally[c.node]?.players || [], seen: seenNow, texts: state.chapter_end_texts?.[c.node] || {},
      languages: state.languages || patch.languages || ["en"] }));
    await store.enqueue(ends);
    patch.chapter_ends = [...(state.chapter_ends || []), ...closed.map((c) => `${season}:${c.node}`)].slice(-50);
    // who got each closed chapter's page (grant_page): the next stage waits for that page (src/story.js)
    const finders = Object.entries({ ...(state.chapter_finders || {}),
      ...Object.fromEntries(closed.filter((c) => c.finder).map((c) => [`${season}:${c.node}`, c.finder])) });
    patch.chapter_finders = Object.fromEntries(finders.slice(-50));
    report.notes.push(...closed.map((c) => `chapter ${c.node} ended (finder ${c.finder || "unknown"}): ${ends.filter((d) => d.node === c.node).length} diary lines`));
  }

  // Phase 2 plugs the AI in here; it returns directives to queue, already in story terms.
  if (decide) {
    const out = await decide({ state: { ...state, ...patch }, fresh, store, nowSec, t });
    const list = Array.isArray(out) ? out : out?.directives;
    if (Array.isArray(list) && list.length) await store.enqueue(list);
    if (out?.hints) {
      await t.put("inbox/hints.json", JSON.stringify({ schema: 1, ...out.hints }));
      report.hints = true;
    }
    if (out?.note) report.notes.push(out.note);
    if (out?.debug?.length) report.debug = out.debug;
    if (out?.season) state.season = out.season;   // the batches below carry the season the AI just opened
    if (out?.rejections?.length) report.rejected.push(...out.rejections);
  }

  // every batch passes the gates right before it leaves, against everything already sent
  const queue = await store.takeQueue();
  if (queue.length) {
    const sent = await store.sentIds();
    let n = 0;
    for (const q of queue) {
      const g = gateBatch(q.directives, { pushedIds: sent, knownStoryIds: state.known_story_ids ? new Set(state.known_story_ids) : null });
      report.rejected.push(...g.rejected);
      report.notes.push(...g.notes);
      if (g.accepted.length) {
        n++;
        const name = `directives-${nowSec}-${String(q.qid).padStart(5, "0")}.json`;
        await t.put(`inbox/${name}`, JSON.stringify({ schema: 1, season: state.season || "", issued_at: new Date(nowSec * 1000).toISOString(), directives: g.accepted }));
        report.pushed += g.accepted.length;
      }
      const ids = g.accepted.flatMap((d) => [d.id, ...(Array.isArray(d.then) ? d.then.map((x) => x.id) : [])]);
      ids.forEach((i) => sent.add(i));
      await store.markPushed(q.qid, ids);
    }
    if (n) {
      // fallback for hosts where the mod cannot list directories
      const files = (await t.list("inbox")).filter((x) => INBOX_DIRECTIVES.test(x)).sort();
      await t.put("inbox/index.json", JSON.stringify({ schema: 1, files }));
    }
  }

  if (report.pushed || !state.last_heartbeat || nowSec - state.last_heartbeat >= HEARTBEAT_SEC) {
    await t.put("inbox/bridge-heartbeat.json", JSON.stringify({ schema: 1, ts: new Date(nowSec * 1000).toISOString(), epoch: nowSec, version }));
    patch.last_heartbeat = nowSec;
  }
  await store.setState(patch);
  return report;
}
