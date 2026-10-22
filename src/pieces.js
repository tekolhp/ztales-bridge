/**
 * Pieces in play (docs/10 2.6). The bridge keeps a register per piece, fed by the mod's events,
 * to know when a node has gone dark: its piece lost. Then, with no AI call, it
 * raises `signal piece_lost` and the final stage's reaction (src/finale.js) puts that node's
 * piece back once (one piece per chapter, docs/13): a loss never blocks the story.
 *
 *   in_world   placed (directive_applied of its placing directive)
 *   held       in a living player's hands (item_picked, pieces_held)
 *   loose      a holder reported it gone (dropped somewhere) — lost after LOST_AFTER_SEC
 *   on_corpse  its holder died carrying it: the story waits on that body, never lost by time
 *              (Teko, 2026-10-22: the new life finds the body, or kills its risen former self)
 *   risen      that body got up and walks, carrying it: never lost while it walks
 *   gone       the mod reported the carrier's body gone (carrier_body_gone): lost at once
 *   in_urn     done
 */
export const LOST_AFTER_SEC = 3 * 86400;
const PLACING = new Set(["place_item", "write_note", "write_map"]);

/** The register after these events. Pure: returns a new object. */
export function updatePieces(reg, events, nowSec) {
  const out = {};
  for (const [k, v] of Object.entries(reg || {})) out[k] = { ...v };
  const set = (sid, fields) => { out[sid] = { ...(out[sid] || {}), ...fields, seen: nowSec }; };
  for (const e of events || []) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "directive_applied" && typeof e.story_id === "string" && PLACING.has(e.directive_type)) {
      set(e.story_id, { status: "in_world", holder: null, since: nowSec });
    } else if (e.type === "item_picked" && typeof e.story_id === "string") {
      set(e.story_id, { status: "held", holder: e.player || null, since: nowSec });
    } else if (e.type === "pieces_held" && Array.isArray(e.ids) && e.player) {
      const now = new Set(e.ids);
      for (const sid of e.ids) set(sid, { status: "held", holder: e.player, since: nowSec });
      for (const [sid, p] of Object.entries(out)) {
        if (p.status === "held" && p.holder === e.player && !now.has(sid)) set(sid, { status: "loose", holder: null, since: nowSec });
      }
    } else if (e.type === "player_died" && Array.isArray(e.carrying)) {
      for (const sid of e.carrying) set(sid, { status: "on_corpse", holder: null, since: nowSec, at: e.x != null ? [e.x, e.y] : undefined,
        rises: e.rises === true });
    } else if (e.type === "carrier_rose" && Array.isArray(e.story_ids)) {
      for (const sid of e.story_ids) if (out[sid]?.status === "on_corpse") set(sid, { status: "risen", since: nowSec });
    } else if (e.type === "former_self_killed" && Array.isArray(e.story_ids)) {
      for (const sid of e.story_ids) set(sid, { status: "on_corpse", holder: null, since: nowSec, rises: false, at: e.x != null ? [e.x, e.y] : undefined });
    } else if (e.type === "carrier_body_gone" && Array.isArray(e.story_ids)) {
      for (const sid of e.story_ids) if (["on_corpse", "risen"].includes(out[sid]?.status)) set(sid, { status: "gone", since: nowSec });
    } else if (e.type === "urn_piece" && typeof e.piece === "string") {
      set(e.piece, { status: "in_urn", holder: null, since: nowSec });
    }
  }
  return out;
}

export function isLost(p, nowSec) {
  if (!p) return false;
  if (p.status === "gone") return true;
  return p.status === "loose" && nowSec - (p.since || 0) >= LOST_AFTER_SEC;
}

/** Nodes whose every piece is lost. nodes: [{ node, ids }]. */
export function lostNodes(reg, nodes, nowSec) {
  return (nodes || []).filter((n) => n.ids.length && n.ids.every((sid) => isLost(reg?.[sid], nowSec))).map((n) => n.node);
}

/** The signals to push now, once per node ever (the mod's reaction fires once too). */
export function lostSignals(reg, nodes, signaled, nowSec) {
  const done = new Set(signaled || []);
  return lostNodes(reg, nodes, nowSec).filter((n) => !done.has(n))
    .map((n) => ({ id: `lost_${n}_${nowSec}`, type: "signal", name: "piece_lost", node: n }));
}
