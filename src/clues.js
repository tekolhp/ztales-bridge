/**
 * The clue agent (Teko, 2026-10-23). The story AI writes the three proximity reflections (far,
 * mid, near) before its piece has a place: production 2026-10-22, chapter 1's laundry ticket went
 * into a big house with a pool while all three rings said "the laundromat at the edge of
 * Riverside", and the closer a player came the more the diary pointed at the wrong place.
 *
 * Once a stage has passed the gates and its piece's building is known, one more small call (the
 * chapter model) rewrites the rings from the REAL building: its rooms, floors, flags, region and
 * name from the catalog, plus the nearest named neighbour. A ladder: far the feeling, mid corrects
 * the course toward the real kind of place, near a detail only that building has.
 *
 * The gate is code (cluesGate): mid and near must each cite a fact the bridge passed, and show
 * it in their text; near must cite one the bridge marked distinctive. Anything less, a failed
 * call, or a spent budget: the story AI's own rings stay. The ring ids never change, so a stage
 * written twice adds nothing.
 */
import { rowToBuilding } from "./catalog.js";

/** Short rules sent with the facts (docs/04, "Task clues", is the long form). */
export const CLUES_PROMPT = "Rewrite the three ring lines (far, mid, near) for the building the piece is really in. "
  + "far: the chapter's theme or feeling. mid: turns the reader toward the real kind of place (cite a fact). "
  + "near: a detail only this building has (cite a fact marked distinctive). Cite facts by id in `cites`, with the exact words "
  + "used for each in every language. Never a coordinate, a direction, a distance, the piece itself, or a forbidden name. "
  + "Answer only { far, mid, near, cites }.";

/** How long one ring line may be (each language). */
export const CLUE_TEXT_MAX = 400;

/** Plain words for the game's room ids, so a fact can be found in an English sentence. */
const ROOM_WORDS = {
  livingroom: ["living room", "lounge", "sitting room"],
  diningroom: ["dining room"],
  laundry: ["laundry", "laundry room", "washing machine", "washer"],
  garagestorage: ["garage"],
  garage: ["garage"],
  bathroom: ["bathroom", "bath"],
  bedroom: ["bedroom"],
  kitchen: ["kitchen"],
  hall: ["hall", "hallway"],
  closet: ["closet", "wardrobe"],
  office: ["office", "study"],
  pool: ["pool", "swimming pool"],
  poolroom: ["pool"],
  shed: ["shed"],
  storage: ["storage", "store room", "storeroom"],
  medical: ["clinic", "medical", "doctor"],
  pharmacy: ["pharmacy", "drugstore"],
  church: ["church", "chapel"],
  bar: ["bar"],
  grocery: ["grocery", "groceries"],
  gasstore: ["gas station"],
  policestorage: ["police"],
  firestorage: ["fire station"],
  restaurant: ["restaurant", "diner"],
  library: ["library"],
  school: ["school", "classroom"],
  classroom: ["classroom", "school"],
  motelroom: ["motel"],
  barn: ["barn"],
  farmstorage: ["farm", "barn"],
};

/** A room id -> words to look for: the table above, else the id itself split at a known suffix. */
export function roomWords(id) {
  const r = String(id || "").toLowerCase();
  if (!r) return [];
  if (ROOM_WORDS[r]) return [...ROOM_WORDS[r]];
  const out = [r];
  for (const suf of ["storage", "room", "store", "kitchen", "office"]) {
    if (r.endsWith(suf) && r.length > suf.length + 2) { const head = r.slice(0, -suf.length); out.push(`${head} ${suf}`, head); }
  }
  return out;
}

/** Text -> lower case, no accents, words separated by single spaces, padded: " a b c ". */
export function normalize(s) {
  return ` ${String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** Does `text` hold `phrase` as whole words? */
export function mentions(text, phrase) {
  const p = normalize(phrase).trim();
  return p.length >= 2 && normalize(text).includes(` ${p} `);
}

/** Every catalog row of the loaded cells, as buildings (rowToBuilding). */
export function buildingsOf(cellRows, fields) {
  const out = [];
  const seen = new Set();
  for (const rows of Object.values(cellRows || {})) {
    for (const row of rows || []) {
      const b = rowToBuilding(row, fields || []);
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
    }
  }
  return out;
}

/** The building a target is in: its id, else the one whose rectangle holds x,y. */
export function buildingOfTarget(target, buildings) {
  if (!target) return null;
  if (typeof target.building === "string") {
    const b = buildings.find((x) => x.id === target.building);
    if (b) return b;
  }
  if (typeof target.x === "number" && typeof target.y === "number") {
    return buildings.find((b) => target.x >= b.x && target.x < b.x + (b.w || 0) && target.y >= b.y && target.y < b.y + (b.h || 0)) || null;
  }
  return null;
}

/**
 * The directive that places a node's piece (the anchor first), with its target, or null.
 * Looks inside reactions' `then` too.
 */
export function pieceDirective(directives, axisNode) {
  if (!axisNode) return null;
  const ids = [axisNode.anchor, ...(axisNode.pieces || []).map((p) => p.story_id)].filter(Boolean);
  const flat = [];
  for (const d of directives || []) { flat.push(d); if (Array.isArray(d?.then)) flat.push(...d.then); }
  for (const id of ids) {
    const d = flat.find((x) => x && x.story_id === id && x.target && ["place_item", "write_note", "write_map"].includes(x.type));
    if (d) return d;
  }
  return null;
}

const share = (list, pred) => (list.length ? list.filter(pred).length / list.length : 1);
const rareShare = 0.15;

/**
 * What the clue agent may say about a building, each fact with an id, the words that show it in a
 * sentence (English, or a proper name that stays the same in every language), and whether it is
 * distinctive: a room few buildings around have (the rarest one at least), its name, a basement or
 * a second floor few have, the room the piece was asked into.
 * Returns { building, facts: [{ id, kind, words, proper, distinctive, about }], neighbour }.
 */
export function buildingFacts(b, buildings, { room = null } = {}) {
  if (!b) return null;
  const others = buildings.filter((x) => x.id !== b.id);
  const all = others.length ? others : [b];
  const facts = [];
  const rooms = [...new Set((Array.isArray(b.rooms) ? b.rooms : []).map(String).filter(Boolean))].slice(0, 20);
  const freq = Object.fromEntries(rooms.map((r) => [r, share(all, (x) => Array.isArray(x.rooms) && x.rooms.includes(r))]));
  const minFreq = rooms.length ? Math.min(...rooms.map((r) => freq[r])) : 1;
  for (const r of rooms) {
    facts.push({ id: `room:${r}`, kind: "room", words: roomWords(r), proper: false,
      distinctive: freq[r] <= rareShare || freq[r] === minFreq || r === room, about: `has a ${r} room (${Math.round(freq[r] * 100)}% of buildings around have one)` });
  }
  const flags = String(b.flags || "");
  if (flags.includes("r")) facts.push({ id: "kind:home", kind: "kind", words: ["house", "home"], proper: false, distinctive: false, about: "a home, residential" });
  if (flags.includes("s")) facts.push({ id: "kind:shop", kind: "kind", words: ["shop", "store"], proper: false, distinctive: false, about: "a shop" });
  if (flags.includes("u")) facts.push({ id: "kind:rural", kind: "kind", words: ["farm", "countryside", "out of town", "fields"], proper: false, distinctive: false, about: "rural, out of town" });
  if (flags.includes("b")) {
    facts.push({ id: "basement", kind: "basement", words: ["basement", "cellar"], proper: false,
      distinctive: share(all, (x) => String(x.flags || "").includes("b")) <= 0.25, about: "has a basement" });
  }
  const floors = Number(b.floors) || 1;
  if (floors >= 2) {
    facts.push({ id: `floors:${floors}`, kind: "floors", words: ["upstairs", "second floor", "upper floor", "top floor", "two floors", "two storeys", "two stories", "stairs"],
      proper: false, distinctive: share(all, (x) => (Number(x.floors) || 1) >= floors) <= 0.25, about: `${floors} floors` });
  }
  const area = (Number(b.w) || 0) * (Number(b.h) || 0);
  if (area && share(all, (x) => (Number(x.w) || 0) * (Number(x.h) || 0) >= area) <= 0.2) {
    facts.push({ id: "size:large", kind: "size", words: ["big", "large", "huge", "biggest", "sprawling"], proper: false, distinctive: false,
      about: "one of the biggest buildings around" });
  }
  const region = String(b.region || "").trim();
  if (region) facts.push({ id: `region:${region}`, kind: "region", words: [...new Set([region, region.split(",")[0].trim()])], proper: true, distinctive: false, about: "the town or area" });
  const name = String(b.name || "").trim();
  if (name) facts.push({ id: `name:${name}`, kind: "name", words: [name], proper: true, distinctive: true, about: "the building's own name" });
  // the nearest building with a name of its own: a landmark the line may lean on
  let neighbour = null;
  let best = Infinity;
  for (const x of others) {
    const n = String(x.name || "").trim();
    if (!n || n === name) continue;
    const d = Math.hypot(x.x - b.x, x.y - b.y);
    if (d < best && d <= 200) { best = d; neighbour = { name: n, region: x.region || null, rooms: (x.rooms || []).slice(0, 3), x: x.x, y: x.y }; }
  }
  if (neighbour) facts.push({ id: `neighbour:${neighbour.name}`, kind: "neighbour", words: [neighbour.name], proper: true, distinctive: false, about: "the nearest named place" });
  return {
    building: { id: b.id, w: b.w, h: b.h, floors, flags: flags || null, region: region || null, name: name || null, rooms,
      zombie_density: b.zombie_density ?? null },
    facts, neighbour,
  };
}

// Portuguese words that show a fact (the gate reads PT-BR lines itself, not only the agent's cites)
const PT_KIND = {
  "kind:home": ["casa", "lar"], "kind:shop": ["loja"], "kind:rural": ["fazenda", "campo", "fora da cidade"],
  basement: ["porao", "subsolo"], "size:large": ["grande", "enorme", "maior"],
};
function factWordsPt(f) {
  if (f.kind === "room") {
    const id = f.id.slice(5);
    const pt = { livingroom: ["sala"], diningroom: ["sala de jantar"], laundry: ["lavanderia", "maquina de lavar", "area de servico"],
      garagestorage: ["garagem"], garage: ["garagem"], bathroom: ["banheiro"], bedroom: ["quarto"], kitchen: ["cozinha"],
      hall: ["corredor"], office: ["escritorio"], pool: ["piscina"], poolroom: ["piscina"], shed: ["galpao"], storage: ["deposito"],
      medical: ["clinica"], pharmacy: ["farmacia"], church: ["igreja"], bar: ["bar"], grocery: ["mercearia"],
      restaurant: ["restaurante"], library: ["biblioteca"], school: ["escola"], classroom: ["sala de aula"], barn: ["celeiro"],
      farmstorage: ["celeiro"] }[id];
    return pt || [];
  }
  if (f.kind === "floors") return ["andar de cima", "segundo andar", "dois andares", "escada"];
  return PT_KIND[f.id] || [];
}

const isEnglish = (l) => /^en\b/i.test(String(l || ""));
const textIn = (v, lang, languages) => (typeof v === "string" ? (languages.length <= 1 ? v : null) : v && typeof v === "object" ? v[lang] : null);

/**
 * The code gate on a clue answer. answer: { far, mid, near, cites: { mid: [cite], near: [cite] } }
 * (or { proximity: {...}, cites }), a cite being { fact: "<id>", words: { lang: "the words used" } }.
 * opts: { facts, languages, room } (room: the room the piece was asked into, if any).
 *
 *  1. far, mid and near each have a text in every language, at most CLUE_TEXT_MAX characters.
 *  2. A cite counts for a ring when its fact is one the bridge passed and, in every language, the
 *     ring's text shows it: a proper fact (region, name, neighbour) by its own word in every
 *     language; any other fact by one of its own words, or, outside English, by the cite's words
 *     for that language found in that text (English must show the fact's own word).
 *  3. mid has at least one cite that counts; near at least one whose fact is distinctive.
 *  4. When the piece was asked into a room, no ring may cite another room of the building.
 *
 * Returns { ok, texts: { far, mid, near }, cited: { mid: [ids], near: [ids] }, room: the room the
 * near line names (or null), errors: [] }.
 */
export function cluesGate(answer, { facts = [], languages = ["en"], room = null } = {}) {
  const langs = Array.isArray(languages) && languages.length ? languages : ["en"];
  const errors = [];
  const src = answer && typeof answer === "object" ? (answer.proximity && typeof answer.proximity === "object" ? answer.proximity : answer) : {};
  const texts = { far: src.far, mid: src.mid, near: src.near };
  for (const k of ["far", "mid", "near"]) {
    for (const l of langs) {
      const s = textIn(texts[k], l, langs);
      if (typeof s !== "string" || !s.trim()) errors.push(`${k}: no text in ${l}`);
      else if (s.length > CLUE_TEXT_MAX) errors.push(`${k}: longer than ${CLUE_TEXT_MAX} characters in ${l}`);
    }
  }
  const byId = new Map(facts.map((f) => [f.id, f]));
  const cites = answer && typeof answer.cites === "object" && answer.cites ? answer.cites : {};
  const cited = { mid: [], near: [] };
  for (const ring of ["mid", "near"]) {
    // the gate also reads the text itself: every fact it shows in every language counts, cited or
    // not (live call 2026-10-23: Haiku wrote a good near line on the basement and listed no cite)
    const declared = Array.isArray(cites[ring]) ? cites[ring] : [];
    const list = [...declared, ...facts.filter((f) => !declared.some((c) => c?.fact === f.id)).map((f) => ({ fact: f.id, auto: true }))];
    for (const c of list) {
      const f = byId.get(c?.fact);
      if (!f) { if (c?.fact) errors.push(`${ring}: cites ${String(c.fact).slice(0, 60)}, a fact it was not given`); continue; }
      const shown = langs.every((l) => {
        const s = textIn(texts[ring], l, langs);
        if (typeof s !== "string") return false;
        if (f.words.some((w) => mentions(s, w))) return true;
        if (f.proper || isEnglish(l)) return false;
        if (/^pt/i.test(l) && factWordsPt(f).some((w) => mentions(s, w))) return true;
        const w = c.words && typeof c.words === "object" ? c.words[l] : typeof c.words === "string" && langs.length === 1 ? c.words : null;
        return typeof w === "string" && mentions(s, w);
      });
      if (!shown) continue;
      if (room && f.kind === "room" && f.id !== `room:${room}`) errors.push(`${ring}: names ${f.id} but the piece is in the ${room}`);
      cited[ring].push(f.id);
    }
  }
  if (!cited.mid.length) errors.push("mid: shows none of the building's facts");
  if (!cited.near.some((id) => byId.get(id)?.distinctive)) errors.push("near: shows nothing only this building has");
  const nearRoom = cited.near.map((id) => byId.get(id)).find((f) => f?.kind === "room");
  return { ok: errors.length === 0, texts, cited, room: nearRoom ? nearRoom.id.slice(5) : null, errors };
}

/** Each ring's diary line in `directives` (src/proximity.js ids) given new texts; ids unchanged. */
export function withRingTexts(directives, node, texts, prefix = "") {
  const ids = new Map(["far", "mid", "near"].map((k) => [`${prefix}prox_${node}_${k}_r`, k]));
  let changed = 0;
  const out = (directives || []).map((d) => {
    const k = d && ids.get(d.id);
    if (!k || !Array.isArray(d.then)) return d;
    changed++;
    return { ...d, then: d.then.map((x) => (x && x.type === "diary_entry" ? { ...x, text: texts[k] } : x)) };
  });
  return { directives: out, changed };
}

/** The ring reactions present in a batch (all three are needed to rewrite them). */
export function ringsIn(directives, node, prefix = "") {
  const want = ["far", "mid", "near"].map((k) => `${prefix}prox_${node}_${k}_r`);
  return want.every((id) => (directives || []).some((d) => d?.id === id));
}

/**
 * What the chapter says, for the clue agent: the piece's own texts, and every line the stage
 * wrote (notes, chats, diary entries, stall hints), short. Never more than `max` characters.
 */
export function stageTexts(directives, hints, max = 6000) {
  const out = [];
  let size = 0;
  const add = (where, v) => {
    if (v === undefined || v === null || v === "") return;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    const cut = s.length > 400 ? `${s.slice(0, 400)}…` : s;
    if (size + cut.length > max) return;
    size += cut.length;
    out.push({ where, text: typeof v === "string" ? cut : (s.length > 400 ? cut : v) });
  };
  const walk = (d, where) => {
    if (!d || typeof d !== "object") return;
    if (/^.*prox_.*_r$/.test(String(d.id || ""))) return;   // the rings being rewritten
    const w = d.type === "reaction" ? `${where}${d.when?.name === "stall" ? `stall ${d.when.step}` : d.when?.event || "reaction"}` : where;
    if (d.type !== "reaction") {
      add(`${w}${d.type}`, d.title);
      add(`${w}${d.type}`, d.text);
    }
    for (const x of Array.isArray(d.then) ? d.then : []) walk(x, d.type === "reaction" ? `${w} > ` : w);
  };
  for (const d of directives || []) walk(d, "");
  if (hints && typeof hints === "object") {
    add("hint", hints.full?.text);
    add("echo hint", hints.echo?.text);
  }
  return out;
}

/** The piece's directive (by id, top level or inside a reaction) asked into `room`; ids unchanged. */
export function withPieceRoom(directives, pieceId, room) {
  const fix = (d) => (d && d.id === pieceId && d.target && !d.target.room && typeof d.target.building === "string"
    && typeof d.target.x !== "number" ? { ...d, target: { ...d.target, room } } : d);
  return (directives || []).map((d) => {
    const top = fix(d);
    return top !== d || !Array.isArray(d?.then) ? top : { ...d, then: d.then.map(fix) };
  });
}

// ---------------------------------------------------------------- plain rings, no AI
// When the clue agent cannot run (no credit, the day's cap, a failed call, a refused answer), the
// mid and near rings still narrow the search (Teko, 2026-10-23): plain words built from the same
// catalog facts, the kind of place, a room it really has, and where it lies from the nearest
// named place. Less pretty, never wrong. The story's own far ring stays: it only sets the mood.

const ROOM_PT = {
  livingroom: "a sala", diningroom: "a sala de jantar", laundry: "a lavanderia", garagestorage: "a garagem", garage: "a garagem",
  bathroom: "o banheiro", bedroom: "o quarto", kitchen: "a cozinha", hall: "o corredor", office: "o escritório", pool: "a piscina",
  poolroom: "a piscina", shed: "o galpão", storage: "o depósito", medical: "a clínica", pharmacy: "a farmácia", church: "a igreja",
  bar: "o bar", grocery: "a mercearia", restaurant: "o restaurante", library: "a biblioteca", school: "a escola", classroom: "a sala de aula",
  barn: "o celeiro", farmstorage: "o celeiro",
};

/** Compass words for the direction from (ax, ay) to (bx, by) in game coordinates (y grows south). */
export function compass(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  if (Math.hypot(dx, dy) < 15) return null;
  const a = (Math.atan2(-dy, dx) * 180) / Math.PI;   // 0 = east, 90 = north
  const i = Math.round(((a + 360) % 360) / 45) % 8;
  return [["east", "leste"], ["northeast", "nordeste"], ["north", "norte"], ["northwest", "noroeste"],
    ["west", "oeste"], ["southwest", "sudoeste"], ["south", "sul"], ["southeast", "sudeste"]][i];
}

/**
 * { mid, near } from facts alone, in every language in use ("en" and "pt-br" written; any other
 * language gets the English line). facts: buildingFacts(...). room: the room the piece is asked into.
 */
export function plainRings(facts, { languages = ["en"], room = null } = {}) {
  if (!facts?.building) return null;
  const f = facts.facts || [];
  const has = (id) => f.some((x) => x.id === id);
  const home = has("kind:home"), shop = has("kind:shop"), rural = has("kind:rural");
  const b = facts.building;
  const pick = room || (f.find((x) => x.kind === "room" && x.distinctive) || {}).id?.slice(5) || null;
  const [rx, ry] = String(b.id || "").split("_").slice(1).map(Number);
  const n = facts.neighbour;
  const dir = n && Number.isFinite(rx) && Number.isFinite(n.x) ? compass(n.x, n.y, rx, ry) : null;
  const en = {}, pt = {};
  en.mid = home ? "Not a shop, I think. Someone's house." : shop ? "A shop, not a house. Somewhere people used to come and go."
    : rural ? "Out of town, past the last houses." : "One building, not the whole street. I would know it if I saw it.";
  pt.mid = home ? "Não é loja, acho. A casa de alguém." : shop ? "Uma loja, não uma casa. Um lugar onde gente entrava e saía."
    : rural ? "Fora da cidade, depois das últimas casas." : "Um prédio só, não a rua inteira. Eu reconheceria se visse.";
  const kindEn = home ? "a house" : shop ? "a shop" : "a building", kindPt = home ? "uma casa" : shop ? "uma loja" : "um prédio";
  const roomEn = pick ? (ROOM_WORDS[pick] || [pick])[0] : null, roomPt = pick ? ROOM_PT[pick] || roomEn : null, inPt = home || shop ? "dela" : "dele";
  const two = Number(b.floors) >= 2;
  en.near = `${kindEn[0].toUpperCase()}${kindEn.slice(1)}${two ? " with an upper floor" : ""}${roomEn ? `, and in it the ${roomEn}` : ""}`
    + `${dir ? `, ${dir[0]} of ${n.name}` : b.region ? `, in ${b.region}` : ""}. It is in there.`;
  pt.near = `${kindPt[0].toUpperCase()}${kindPt.slice(1)}${two ? " de dois andares" : ""}${roomPt ? `, e dentro ${inPt} ${roomPt}` : ""}`
    + `${dir ? `, a ${dir[1]} de ${n.name}` : b.region ? `, em ${b.region}` : ""}. Está lá dentro.`;
  const one = (k) => (languages.length <= 1 ? (/^pt/i.test(languages[0] || "") ? pt[k] : en[k])
    : Object.fromEntries(languages.map((l) => [l, /^pt/i.test(l) ? pt[k] : en[k]])));
  return { mid: one("mid"), near: one("near"), room: pick };
}
