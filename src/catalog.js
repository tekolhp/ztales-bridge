/**
 * The slice of the mod's catalog (docs/03, "Files the bridge polls") that one AI call sees.
 *
 * The AI may only aim at buildings it was offered: it gets a short list of real building ids
 * around where players actually are, and the gate rejects any other id. That is how "never use
 * a building that is not in the catalog" is enforced in code instead of trusted.
 */

export const DEFAULT_LIMIT = 60;

export function cellOf(x, y, size = 300) {
  return `${Math.floor(x / size)}_${Math.floor(y / size)}`;
}

/** The cell and its eight neighbours. */
export function cellsAround(x, y, size = 300) {
  const cx = Math.floor(x / size);
  const cy = Math.floor(y / size);
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(`${cx + dx}_${cy + dy}`);
  return out;
}

/** Row -> object, using the column names the mod wrote into index.json. */
export function rowToBuilding(row, fields) {
  const b = {};
  fields.forEach((f, i) => { b[f] = row[i]; });
  b.id = `b_${b.x}_${b.y}`;
  return b;
}

/**
 * Where the story may act (Teko, 2026-10-13: random spawns widen the stage, they do not narrow
 * it). Every spawn town, one point each, plus where players actually were lately. Returns
 * { near: [[x, y]...] players, towns: [[x, y]...] one per spawn region }.
 */
export function stagePoints(events, index, maxPlayers = 2) {
  const near = focusPlayers(events, maxPlayers);
  const towns = [];
  for (const r of index?.spawn_regions || []) {
    const p = (r.points || [])[0];
    if (p) towns.push([p[0], p[1]]);
  }
  return { near, towns };
}

function focusPlayers(events, max) {
  const pts = [];
  for (let i = events.length - 1; i >= 0 && pts.length < max; i--) {
    const e = events[i];
    if (typeof e.x === "number" && typeof e.y === "number" && (e.x || e.y)) pts.push([e.x, e.y]);
  }
  return pts;
}

/** Cells to read: the 3x3 around each player, and the one cell of each spawn town. */
export function stageCells({ near, towns }, size = 300) {
  return [...new Set([...near.flatMap(([x, y]) => cellsAround(x, y, size)), ...towns.map(([x, y]) => cellOf(x, y, size))])];
}

/**
 * Where to look: positions from recent events (players' x,y), else the spawn points.
 * Returns up to `max` points, most recent first.
 */
export function focusPoints(events, index, max = 4) {
  const pts = [];
  for (let i = events.length - 1; i >= 0 && pts.length < max; i--) {
    const e = events[i];
    if (typeof e.x === "number" && typeof e.y === "number" && (e.x || e.y)) pts.push([e.x, e.y]);
  }
  if (!pts.length) {
    for (const r of index?.spawn_regions || []) {
      for (const p of r.points || []) { if (pts.length < max) pts.push([p[0], p[1]]); }
    }
  }
  return pts;
}

/**
 * Candidate buildings near the focus points, spread across room types so the AI can pick a
 * place by its function (a pharmacy, a fire station, a farm) and still use a real id.
 * cellRows: { "cx_cy": rows[] }; fields: index.building_fields.
 */
export function candidates(cellRows, fields, points, limit = DEFAULT_LIMIT) {
  const all = [];
  const seen = new Set();
  for (const rows of Object.values(cellRows)) {
    for (const row of rows || []) {
      const b = rowToBuilding(row, fields);
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      let d = Infinity;
      for (const [px, py] of points) d = Math.min(d, Math.hypot(b.x - px, b.y - py));
      b.distance = Math.round(d);
      all.push(b);
    }
  }
  all.sort((a, b) => a.distance - b.distance);
  // round-robin over each building's main room type, nearest first, so ten houses do not
  // crowd out the one police station
  const byType = new Map();
  for (const b of all) {
    const k = (b.rooms && b.rooms[0]) || b.name || "other";
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(b);
  }
  const out = [];
  const queues = [...byType.values()];
  while (out.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) { if (q.length && out.length < limit) out.push(q.shift()); }
  }
  return out.map((b) => ({ id: b.id, rooms: b.rooms, region: b.region || undefined, name: b.name || undefined,
    flags: b.flags || undefined, floors: b.floors, distance: b.distance }));
}

// ---------------------------------------------------------------- the final node (docs/01 rule 20)
// The final node is never inside a spawn town: nothing within SPAWN_EXCLUSION tiles of any spawn
// point, Louisville excepted. Intermediate nodes may be in spawn towns.

export const SPAWN_EXCLUSION = 600;

export function spawnPoints(index) {
  const out = [];
  for (const r of index?.spawn_regions || []) for (const p of r.points || []) out.push([p[0], p[1]]);
  return out;
}

export const isLouisville = (place) => /louisville/i.test(`${place?.region || ""} ${place?.name || ""}`);

export function inSpawnTown(xy, spawns, radius = SPAWN_EXCLUSION) {
  return spawns.some(([sx, sy]) => Math.hypot(xy[0] - sx, xy[1] - sy) < radius);
}

/** Cells for the final stage: outside every spawn town, nearest to where players were. */
export function finalStageCells(index, catalogCells, near, max = 8) {
  const size = index?.cell_size || 300;
  const spawns = spawnPoints(index);
  const ref = near.length ? near : spawns;
  return (catalogCells || [])
    .map((k) => { const [cx, cy] = k.split("_").map(Number); return { k, x: cx * size + size / 2, y: cy * size + size / 2 }; })
    .filter((c) => !inSpawnTown([c.x, c.y], spawns, SPAWN_EXCLUSION - size / 2))
    .map((c) => ({ ...c, d: Math.min(...ref.map(([x, y]) => Math.hypot(c.x - x, c.y - y))) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((c) => c.k);
}

/**
 * For gates.js (ctx.placeRule): the reason a target breaks the final-node rule, or null.
 * byId: { buildingId: place } for region names (Louisville).
 */
export function finalPlaceRule(index, byId = {}) {
  const spawns = spawnPoints(index);
  return (target) => {
    if (!target) return null;
    const id = target.building;
    const xy = typeof target.x === "number" ? [target.x, target.y]
      : (/^b_(\d+)_(\d+)$/.exec(String(id || "")) || []).slice(1).map(Number);
    if (xy.length !== 2) return null;
    if (byId[id] && isLouisville(byId[id])) return null;
    return inSpawnTown(xy, spawns) ? `the final node cannot be inside a spawn town (${id || xy.join(",")})` : null;
  };
}

/** The world part of the slice: what the catalog index says, without the long lists the AI does not need. */
export function worldSlice(index) {
  if (!index) return {};
  return {
    world_start: index.world_start, game_time: index.game_time, story_language: index.story_language,
    story_difficulty: index.story_difficulty, story_max_nodes: index.story_max_nodes, hint_pace: index.hint_pace,
    mods: (index.mods || []).map((m) => m.name || m.id),
    professions: (index.professions || []).map((p) => p.id),
    outfits: index.outfits || [],
    item_categories: (index.item_categories || []).map((c) => c.category),
  };
}
