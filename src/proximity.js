/**
 * Near a node, the diary feels it (Teko, 2026-10-13).
 *
 * Nodes are fixed places. Around the current node the bridge draws three nested rings; when a
 * player first enters one, a reflection is written into that player's diary, stronger the closer
 * the ring: far = a vague unease, mid = a strong pull, near = almost certainty. The AI writes the
 * three reflections (in every language in use); the geometry is code, from the real building the
 * node's anchor piece was placed in, so the rings are never where the AI imagined but where the
 * piece actually is.
 *
 * Built from the mod's own pieces: define_zone (zone_entered once per player) + a reaction per
 * ring (once per player) whose diary_entry goes to "$player". Nothing new in the mod but ordering.
 */

export const RINGS = [
  { key: "far", half: 120 },
  { key: "mid", half: 45 },
  { key: "near", half: 12 },
];

/** "b_8100_11600" -> [8100, 11600] */
export function buildingXY(id) {
  const m = /^b_(\d+)_(\d+)$/.exec(String(id || ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Where the node is: the target of the directive that places its anchor piece (or, failing that,
 * any of its pieces). Returns [x, y] or null.
 */
export function nodeCenter(directives, axisNode) {
  if (!axisNode) return null;
  const ids = [axisNode.anchor, ...(axisNode.pieces || []).map((p) => p.story_id)].filter(Boolean);
  const flat = [];
  for (const d of directives || []) {
    flat.push(d);
    if (Array.isArray(d.then)) flat.push(...d.then);
  }
  // a piece carried by a story zombie or a corpse is where that body is (live run 2026-10-22:
  // chapter 2's piece in a farmer zombie's coat left the chapter without rings)
  const holds = (x, id) => x && (x.story_id === id
    || (Array.isArray(x.inventory) && x.inventory.some((it) => it && it.story_id === id)));
  for (const id of ids) {
    const d = flat.find((x) => holds(x, id) && x.target);
    if (!d) continue;
    if (typeof d.target.x === "number" && typeof d.target.y === "number") return [d.target.x, d.target.y];
    const xy = buildingXY(d.target.building);
    if (xy) return [xy[0] + 4, xy[1] + 4];   // a few tiles in from the building's corner
  }
  return null;
}

/** What the AI must provide for a stage: { far, mid, near }, each a text (or { lang: text }). */
export function missingProximity(texts) {
  if (!texts || typeof texts !== "object") return RINGS.map((r) => r.key);
  return RINGS.map((r) => r.key).filter((k) => texts[k] === undefined || texts[k] === null || texts[k] === "");
}

/** The zones and reactions for one node. Ids carry the node, so a stage written twice adds nothing. */
export function proximityDirectives(node, center, texts, prefix = "") {
  if (!node || !center) return [];
  const [cx, cy] = center;
  const out = [];
  for (const [i, r] of RINGS.entries()) {
    const zone = `${prefix}prox_${node}_${r.key}`;
    out.push({ id: zone, type: "define_zone", story_id: zone, x: cx - r.half, y: cy - r.half, w: r.half * 2, h: r.half * 2 });
    out.push({
      id: `${zone}_r`, type: "reaction", stage: node, once: "player",
      when: { event: "zone_entered", story_id: zone },
      // one group per node: the mod keeps only the strongest ring the player reached, and
      // writes it later, in a gap of their play (ZTales_DiaryPace), never on the spot
      then: [{ id: `${zone}_e`, type: "diary_entry", player: "$player", node, group: `${prefix}prox_${node}`, weight: i + 1,
        text: texts[r.key] }],
    });
  }
  return out;
}
