/**
 * A piece on a dead carrier (Teko, 2026-10-22). When a character dies carrying a story piece,
 * the story waits on that body: in Build 42 a dead player's inventory stays on the corpse
 * (IsoDeadBody's container), and an infected one rises (IsoDeadBody.reanimate -> an IsoZombie with
 * isReanimatedPlayer, still carrying it). The new life must find the body, or kill its former
 * self, to take the piece back. The bridge never puts the piece back while that body exists;
 * only when the mod reports it truly gone (src/pieces.js, `carrier_body_gone`).
 *
 * The mod's events (ZTales_Diary.onDeath, ZTales_Track):
 *   player_died         { player, life, carrying: [story_id], rises, x, y, z }
 *   carrier_rose        { story_ids }        the body got up and walks, carrying them
 *   former_self_killed  { story_ids, by, x, y }  the risen body was put down: they lie there now
 *   carrier_body_gone   { story_ids }        the body is gone (removed, burnt): put-back allowed
 *
 * Here: the carrier records (state.carriers), and the new life's diary line saying where the
 * body lies, by the place's function and the town around it, never a coordinate.
 */
import { cellsAround, rowToBuilding } from "./catalog.js";

/** A story piece the carrier matters for: the bible's pieces and the bridge's extras. */
export const isStoryPiece = (pieceIds) => (sid) => typeof sid === "string" && (pieceIds.has(sid) || /_extra\d+$/.test(sid));

/**
 * The carrier records after these events: [{ player, life (the life that ended), ids, x, y, z,
 * rises, state: "body" | "risen" | "killed", at }]. Pure.
 *   isPiece   (story_id) -> bool (isStoryPiece)
 */
export function updateCarriers(prev, events, isPiece, nowSec) {
  let out = (prev || []).map((c) => ({ ...c, ids: [...(c.ids || [])] }));
  const drop = (sids) => {
    const gone = new Set(sids || []);
    for (const c of out) c.ids = c.ids.filter((sid) => !gone.has(sid));
  };
  const touch = (sids, fields) => {
    const s = new Set(sids || []);
    for (const c of out) if (c.ids.some((sid) => s.has(sid))) Object.assign(c, fields);
  };
  for (const e of events || []) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "player_died" && e.player && Array.isArray(e.carrying)) {
      const ids = e.carrying.filter(isPiece);
      if (!ids.length) continue;
      drop(ids);   // a piece is on one body only: the newest
      out.push({ player: e.player, life: Number(e.life) || null, ids, x: e.x ?? null, y: e.y ?? null, z: e.z || 0,
        rises: e.rises === true, state: "body", at: nowSec });
    } else if (e.type === "carrier_rose" && Array.isArray(e.story_ids)) {
      touch(e.story_ids, { state: "risen", rises: true });
    } else if (e.type === "former_self_killed" && Array.isArray(e.story_ids)) {
      touch(e.story_ids, { state: "killed", rises: false, ...(e.x != null ? { x: e.x, y: e.y } : {}), killed_by: e.by || null });
    } else if (e.type === "carrier_body_gone" && Array.isArray(e.story_ids)) {
      drop(e.story_ids);
    } else if (e.type === "item_picked" && typeof e.story_id === "string") {
      drop([e.story_id]);
    } else if (e.type === "pieces_held" && Array.isArray(e.ids)) {
      drop(e.ids);
    } else if (e.type === "urn_piece" && typeof e.piece === "string") {
      drop([e.piece]);
    }
  }
  out = out.filter((c) => c.ids.length);
  return out.slice(-50);
}

/** The building the body lies in, else the nearest within `reach` tiles; null when none. */
export function bodyPlace(cellRows, fields, x, y, reach = 80) {
  if (typeof x !== "number" || typeof y !== "number") return null;
  let best = null;
  for (const rows of Object.values(cellRows || {})) {
    for (const row of rows || []) {
      const b = rowToBuilding(row, fields || []);
      const w = Number(b.w) || 1;
      const h = Number(b.h) || 1;
      const inside = x >= b.x && x < b.x + w && y >= b.y && y < b.y + h;
      const dx = Math.max(b.x - x, 0, x - (b.x + w - 1));
      const dy = Math.max(b.y - y, 0, y - (b.y + h - 1));
      const d = inside ? 0 : Math.hypot(dx, dy);
      if (d > reach) continue;
      if (!best || d < best.distance) best = { inside, distance: Math.round(d), rooms: b.rooms || [], name: b.name || "", region: b.region || "" };
    }
  }
  return best;
}

/** The cells to read for a body at x,y (one small file each). */
export function bodyCells(x, y, size = 300) {
  return typeof x === "number" && typeof y === "number" ? cellsAround(x, y, size) : [];
}

// What a building is, by its rooms (the catalog's room names), most telling first.
const FUNCTIONS = [
  [["church"], "a church", "uma igreja"],
  [["pharmacy", "pharmacystorage"], "a pharmacy", "uma farmácia"],
  [["policestorage", "police"], "a police station", "uma delegacia"],
  [["firestorage", "fire"], "a fire station", "um quartel de bombeiros"],
  [["medical", "hospitalroom", "medclinic", "medicalstorage"], "a clinic", "uma clínica"],
  [["gasstore", "gasstorage", "gasstation"], "a gas station", "um posto de gasolina"],
  [["grocery", "grocerystorage", "zippeestore", "zippeestorage"], "a grocery store", "um mercado"],
  [["restaurant", "restaurantkitchen", "dinerkitchen", "diner", "pizzawhirled", "spiffo"], "a restaurant", "um restaurante"],
  [["bar", "barstorage"], "a bar", "um bar"],
  [["classroom", "school"], "a school", "uma escola"],
  [["warehouse", "storageunit"], "a warehouse", "um galpão"],
  [["barn", "farmstorage", "stall"], "a barn", "um celeiro"],
  [["mechanic", "garage"], "a garage", "uma oficina"],
  [["office"], "an office", "um escritório"],
  [["motelroom", "motelroomoccupied"], "a motel", "um motel"],
  [["shed"], "a shed", "um galpãozinho"],
  [["bedroom", "kitchen", "livingroom", "bathroom"], "a house", "uma casa"],
];

/** "a barn" / "um celeiro" for a building, by its rooms; a plain building when unknown. */
export function placeKind(place, lang = "en") {
  const rooms = new Set((place?.rooms || []).map((r) => String(r).toLowerCase()));
  for (const [keys, en, pt] of FUNCTIONS) if (keys.some((k) => rooms.has(k))) return lang === "pt-br" ? pt : en;
  return lang === "pt-br" ? "uma construção" : "a building";
}

/**
 * The new life's diary line about the body (in a gap of their play, like every diary line): the
 * place by its function and the town around it, whether it rises. No coordinates, no names of
 * the dead. One per carrier record; languages as the story's.
 */
export function carrierEntry(rec, place, languages, prefix = "") {
  if (!rec || !rec.player || !rec.ids?.length) return null;
  const text = {};
  for (const l of languages && languages.length ? languages : ["en"]) {
    const pt = l === "pt-br";
    const kind = place ? placeKind(place, l) : null;
    const town = place?.region ? (pt ? ` em ${place.region}` : ` in ${place.region}`) : "";
    const where = !place ? (pt ? "ao ar livre, longe de qualquer casa" : "out in the open, far from any house")
      : place.inside ? (pt ? `dentro de ${kind}${town}` : `inside ${kind}${town}`)
      : (pt ? `do lado de fora de ${kind}${town}` : `outside ${kind}${town}`);
    const first = pt
      ? `Sonhei de novo com o lugar onde caí: ${where}. Alguma coisa que a história precisa ficou no corpo, esperando por mim.`
      : `I dreamt again of the place where I fell: ${where}. Something the story needs stayed on the body, waiting for me.`;
    const rise = rec.rises
      ? (pt ? " E o corpo não ficou deitado. Vou ter que derrubá-lo eu mesmo." : " And the body did not stay down. I will have to put it down myself.")
      : "";
    text[l] = first + rise;
  }
  return { id: `${prefix}carrier_${rec.player}_${rec.life ?? 0}`, type: "diary_entry", player: rec.player,
    life: (Number(rec.life) || 0) + 1, kind: "carrier_body", text };
}

/** What the dream may use (task echo, `bodies`): the place in words, whether it walks. */
export function bodyForDream(rec, place) {
  return { pieces: rec.ids.length, place: place ? { kind: placeKind(place, "en"), inside: !!place.inside, town: place.region || null,
    name: place.name || null } : null, rises: !!rec.rises };
}

/** One line for the bridge's notes: the marker that the story now waits on a body. */
export function carrierNote(rec) {
  return `carrier ${rec.player} (life ${rec.life ?? "?"}) died with ${rec.ids.join(", ")}: the story waits on the body${rec.rises ? " (it will rise)" : ""}`;
}
