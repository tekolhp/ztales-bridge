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
 * The rings are INDIRECT (Teko, 2026-10-23): they never say what the place is ("laundry",
 * "garage", "house", "shop"...). They suggest it through what any person would smell, hear, feel
 * or do there: starch and the spin of a drum, grease and rust, the cold of a meat locker. Only the
 * late stall steps (3-4) may name the kind of place.
 *
 * The gate is code (cluesGate): no ring names a room or the kind of place (proper names stay
 * allowed); mid shows one of the building's facts through its activity words, near a distinctive
 * one, in every language. Anything less, a failed call, or a spent budget: plain indirect lines
 * from the facts (plainRings). The ring ids never change, so a stage written twice adds nothing.
 */
import { rowToBuilding } from "./catalog.js";

/** Short rules sent with the facts (docs/04, "Task clues", is the long form). */
export const CLUES_PROMPT = "Rewrite the three ring lines (far, mid, near) for the building the piece is really in. "
  + "Indirect: never say what the place is (no laundry, kitchen, garage, workshop, bar, house, shop...); suggest it through what "
  + "any person would smell, hear, feel or do there (starch, steam, folding; grease, rust, oil; alcohol, tobacco; the cold). "
  + "far: the chapter's feeling. mid: turns the reader toward the real kind of place by what was done there. "
  + "near: what only a fact marked distinctive gives (its room's work and smells; a basement: the cold of the steps going down). "
  + "Proper names (the town, the nearest named place) are allowed. Never a coordinate, a direction, a distance, the piece itself, "
  + "or a forbidden name. Answer only { far, mid, near, cites }.";

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
  kidsbedroom: ["nursery", "kids room", "kids bedroom"],
  mechanic: ["mechanic", "auto shop", "repair shop"],
  workshop: ["workshop"],
  butcher: ["butcher", "butchery", "meat locker"],
  coldstorage: ["cold storage", "cold room", "freezer", "meat locker"],
  theatre: ["theatre", "theater", "cinema", "movie theater", "movies"],
  bakery: ["bakery"],
  gym: ["gym", "gymnasium"],
};

/** Room ids the catalog uses for a room above (the same names, activities and plain line). */
const ROOM_ALIAS = { knoxbutcher: "butcher", butchery: "butcher", coldroom: "coldstorage", groceryfreezer: "coldstorage",
  jerkycoldroom: "coldstorage", homecinema: "theatre", movietheater: "theatre", hallway: "hall", racetrackmechanic: "mechanic",
  bakerykitchen: "bakery" };

/** The table's room for a catalog room id (an alias, or a "...kitchen" / "...workshop" id), else null. */
function canonRoom(id) {
  const r = String(id || "").toLowerCase();
  if (ROOM_WORDS[r]) return r;
  if (ROOM_ALIAS[r]) return ROOM_ALIAS[r];
  for (const suf of ["kitchen", "workshop"]) if (r.endsWith(suf)) return suf;
  return null;
}

// Names of places in Portuguese (the gate refuses them in every ring, as the English names above)
const ROOM_PT = {
  livingroom: ["sala", "sala de estar"], diningroom: ["sala de jantar"], laundry: ["lavanderia", "maquina de lavar", "area de servico"],
  garagestorage: ["garagem"], garage: ["garagem"], bathroom: ["banheiro"], bedroom: ["quarto"], kitchen: ["cozinha"],
  hall: ["corredor", "hall"], closet: ["armario", "closet"], office: ["escritorio"], pool: ["piscina"], poolroom: ["piscina"],
  shed: ["galpao", "barracao"], storage: ["deposito"], medical: ["clinica", "consultorio", "medico"], pharmacy: ["farmacia", "drogaria"],
  church: ["igreja", "capela"], bar: ["bar", "boteco"], grocery: ["mercearia", "mercado"], gasstore: ["posto de gasolina"],
  policestorage: ["delegacia", "policia"], firestorage: ["bombeiros", "quartel"], restaurant: ["restaurante", "lanchonete"],
  library: ["biblioteca"], school: ["escola"], classroom: ["sala de aula", "escola"], motelroom: ["motel"], barn: ["celeiro", "estabulo"],
  farmstorage: ["celeiro", "fazenda"], kidsbedroom: ["quarto das criancas", "quarto infantil"], mechanic: ["oficina", "mecanico"],
  workshop: ["oficina"], butcher: ["acougue", "acougueiro"], coldstorage: ["camara fria", "frigorifico", "congelador", "freezer"],
  theatre: ["cinema", "teatro"], bakery: ["padaria"], gym: ["academia", "ginasio"],
};
// the kind of place and a few common place nouns: never in a ring, whatever the building
const KIND_NAMES = {
  "kind:home": ["house", "home", "household", "casa", "lar", "residencia"],
  "kind:shop": ["shop", "store", "loja", "comercio"],
  "kind:rural": ["farm", "farmhouse", "ranch", "fazenda", "sitio", "granja"],
  basement: ["basement", "cellar", "porao", "subsolo"],
  other: ["laundromat"],
};
// names that are also ordinary words ("a bar of soap", "a pool of light", "um quarto de hora"):
// refused only when the building has that room
const AMBIGUOUS = new Set(["bar", "bath", "pool", "hall", "study", "lounge", "quarto", "deposito", "armario", "medico", "mercado", "movies", "police", "policia", "doctor"]);

/**
 * What a person would do, smell, hear or feel in a place: the evidence words for an indirect line.
 * A one-word entry of 4+ letters also matches a longer word it begins ("iron" -> "ironed").
 */
const garageEn = ["motor oil", "oil", "grease", "wrench", "spanner", "workbench", "toolbox", "engine", "tyre", "tire", "exhaust", "car jack", "rust"];
const garagePt = ["oleo", "graxa", "chave inglesa", "bancada", "caixa de ferramentas", "motor", "pneu", "escapamento", "macaco", "ferrugem"];
const barnEn = ["hay", "straw", "horse", "manure", "pitchfork", "bale", "feed"];
const barnPt = ["feno", "palha", "cavalo", "esterco", "forcado", "fardo", "racao"];
const bedEn = ["bed", "pillow", "blanket", "mattress", "nightstand", "sleep"];
const bedPt = ["cama", "travesseiro", "cobertor", "colchao", "criado mudo", "dormir"];
const schoolEn = ["chalk", "blackboard", "desks in rows", "homework", "recess", "bell", "lesson"];
const schoolPt = ["giz", "quadro negro", "carteiras enfileirad", "recreio", "licao", "licoes"];
const poolEn = ["chlorine", "deep end", "diving board", "swimming", "laps"];
const poolPt = ["cloro", "parte funda", "trampolim", "nadando", "nadava", "mergulh"];
const ACTS = {
  livingroom: { en: ["sofa", "couch", "armchair", "television", "tv", "fireplace", "rug", "cushion"],
    pt: ["sofa", "poltrona", "televisao", "tv", "lareira", "tapete", "almofada"] },
  diningroom: { en: ["tablecloth", "good plates", "place settings", "sunday dinner"], pt: ["toalha de mesa", "pratos bons", "mesa posta", "almoco de domingo"] },
  laundry: { en: ["starch", "iron", "pressed", "fold", "soap", "steam", "spin", "drum", "linen", "whites", "clothesline", "detergent", "washing", "warm cotton"],
    pt: ["goma", "engoma", "ferro de passar", "passar roupa", "roupa branca", "dobra", "sabao", "vapor", "centrifug", "varal", "lencol", "lencois", "lavar", "lavava", "tambor", "algodao"] },
  garage: { en: garageEn, pt: garagePt },
  garagestorage: { en: garageEn, pt: garagePt },
  mechanic: { en: [...garageEn, "engine hoist", "car lift", "chain"], pt: [...garagePt, "talha", "elevador de carro", "corrente"] },
  workshop: { en: ["sawdust", "vice", "filings", "rust", "wood shavings", "wood glue", "lathe", "oil"],
    pt: ["serragem", "morsa", "limalha", "ferrugem", "maravalha", "cola de madeira", "torno", "oleo"] },
  bathroom: { en: ["shower", "tub", "towel", "faucet", "toothbrush", "tiles", "steam", "soap"],
    pt: ["chuveiro", "banheira", "banho", "toalha de banho", "torneira", "escova de dente", "azulejo", "vapor", "sabonete"] },
  bedroom: { en: bedEn, pt: bedPt },
  kidsbedroom: { en: [...bedEn, "crayon", "toy"], pt: [...bedPt, "giz de cera", "gizes de cera", "brinquedo"] },
  kitchen: { en: ["onion", "frying", "kettle", "bread", "stove", "simmer", "cooking", "pans"],
    pt: ["cebola", "fritando", "fritura", "chaleira", "pao", "fogao", "panela", "cozinhando"] },
  hall: { en: ["coat", "doormat", "front door", "umbrella"], pt: ["casaco", "capacho", "porta da frente", "guarda chuva"] },
  closet: { en: ["hanger", "mothball", "cedar", "shoe boxes"], pt: ["cabide", "naftalina", "cedro", "caixas de sapato"] },
  office: { en: ["typewriter", "paperwork", "ledger", "desk lamp", "stapler", "invoice", "filing cabinet"],
    pt: ["maquina de escrever", "papelada", "livro caixa", "luminaria de mesa", "grampeador", "nota fiscal"] },
  pool: { en: poolEn, pt: poolPt },
  poolroom: { en: poolEn, pt: poolPt },
  shed: { en: ["lawnmower", "rake", "seed packet", "flower pot", "garden tool", "hose"],
    pt: ["cortador de grama", "rastelo", "pacotes de semente", "vaso de planta", "mangueira"] },
  storage: { en: ["cardboard", "stacked", "dust sheet", "crate"], pt: ["papelao", "empilhad", "caixote", "tralha"] },
  medical: { en: ["antiseptic", "gauze", "bandage", "stethoscope"], pt: ["antissept", "gaze", "curativo", "estetoscopio"] },
  pharmacy: { en: ["tablet", "prescription", "cough syrup", "aspirin", "pills"], pt: ["comprimido", "receita", "xarope", "aspirina", "remedio"] },
  church: { en: ["candle", "pews", "hymn", "incense", "pray", "altar", "stained glass", "bell"],
    pt: ["vela", "bancos de madeira", "hino", "incenso", "reza", "oracao", "altar", "vitral", "sino"] },
  bar: { en: ["alcohol", "tobacco", "beer", "whiskey", "stool", "smoke", "jukebox", "last call"],
    pt: ["alcool", "tabaco", "cerveja", "uisque", "banquinho", "fumaca", "jukebox", "saideira"] },
  grocery: { en: ["canned", "shopping cart", "checkout", "produce", "bag of flour"], pt: ["em lata", "enlatado", "carrinho de compras", "bipe", "hortifruti"] },
  gasstore: { en: ["gasoline", "fumes", "pump", "diesel", "road map"], pt: ["gasolina", "bomba", "diesel", "mapas de estrada", "combustivel"] },
  policestorage: { en: ["handcuff", "evidence bag", "holster", "badge", "radio crackl"], pt: ["algema", "sacos de prova", "radio chiando", "coldre", "distintivo"] },
  firestorage: { en: ["hose", "helmet", "siren", "smoke", "heavy boots"], pt: ["mangueira", "capacete", "sirene", "fumaca", "botas pesadas"] },
  restaurant: { en: ["grill", "order pad", "menu", "booth", "fryer", "coffee"], pt: ["chapa", "comanda", "cardapio", "cafe requentado", "fritadeira"] },
  library: { en: ["book", "page", "quiet", "due date", "card catalog", "reading"], pt: ["livros", "pagina", "silencio", "devolucao", "carimb", "leitura"] },
  school: { en: schoolEn, pt: schoolPt },
  classroom: { en: schoolEn, pt: schoolPt },
  motelroom: { en: ["ice machine", "plastic tag", "thin walls", "walls so thin", "neon", "vacancy"],
    pt: ["maquina de gelo", "chaveiro de plastico", "paredes finas", "paredes tao finas", "neon", "letreiro"] },
  barn: { en: barnEn, pt: barnPt },
  farmstorage: { en: [...barnEn, "feed sack", "fertilizer"], pt: [...barnPt, "sacos de racao", "adubo"] },
  butcher: { en: ["cleaver", "raw meat", "meat on hooks", "blood", "bone saw", "the cold", "frost"],
    pt: ["cutelo", "carne crua", "cepo", "sangue", "serra de osso", "o frio", "geada"] },
  coldstorage: { en: ["the cold", "frost", "breath smoking", "numb", "compressor"], pt: ["o frio", "geada", "respiracao branca", "dormentes", "compressor"] },
  theatre: { en: ["projector", "audience", "applause", "popcorn", "air conditioning", "velvet seats"],
    pt: ["projetor", "plateia", "aplauso", "pipoca", "ar condicionado", "veludo"] },
  bakery: { en: ["flour", "dough", "yeast", "oven", "bread", "crust"], pt: ["farinha", "massa", "fermento", "forno", "pao", "casca"] },
  gym: { en: ["sweat", "rubber mats", "barbell", "dumbbell", "treadmill", "weights"], pt: ["suor", "colchonete", "halter", "esteira", "pesos"] },
  // the kind of place, a basement, upper floors, size: by what living or working there was like
  "kind:home": { en: ["lived there", "cooked", "own things", "family", "slept there"], pt: ["morava", "cozinhava", "proprias coisas", "familia", "dormia ali"] },
  "kind:shop": { en: ["came and went", "counter", "till", "customers", "price tag", "receipt", "shelves"],
    pt: ["entrava e saia", "balcao", "caixa registradora", "clientes", "etiqueta de preco", "prateleira", "troco"] },
  "kind:rural": { en: ["out of town", "dirt road", "hay", "field", "harvest", "tractor", "cattle"],
    pt: ["fora da cidade", "estrada de terra", "feno", "campo", "colheita", "trator", "gado"] },
  basement: { en: ["steps going down", "stairs going down", "down the steps", "down the stairs", "going down", "under the floor", "underground"],
    pt: ["degraus descendo", "escada descendo", "descendo a escada", "descendo", "debaixo do chao", "subterr", "la embaixo"] },
  floors: { en: ["upstairs", "stairs going up", "up the stairs", "second floor", "upper floor", "top floor", "two floors", "footsteps over"],
    pt: ["andar de cima", "la em cima", "subindo a escada", "escada subindo", "segundo andar", "dois andares", "passos em cima"] },
  size: { en: ["big", "large", "huge", "sprawling", "so many rooms"], pt: ["grande", "enorme", "tantos comodos"] },
};

/** A fact's activity words { en, pt }, or null (proper names and rooms with no list). */
function factActs(f) {
  if (!f || f.proper) return null;
  if (f.kind === "room") { const c = canonRoom(f.id.slice(5)); return c ? ACTS[c] : null; }
  if (f.kind === "floors" || f.kind === "size") return ACTS[f.kind];
  return ACTS[f.id] || null;
}

/** Every place name a ring may not hold, for these facts (normalized, no padding). */
function placeNames(facts) {
  const out = new Set();
  const add = (w) => { const n = normalize(w).trim(); if (n) out.add(n); };
  for (const ws of Object.values(KIND_NAMES)) ws.forEach(add);
  for (const [id, ws] of Object.entries(ROOM_WORDS)) for (const w of [...ws, ...(ROOM_PT[id] || [])]) if (!AMBIGUOUS.has(normalize(w).trim())) add(w);
  for (const f of facts) {
    if (f.kind !== "room") continue;
    const id = f.id.slice(5);
    const c = canonRoom(id);
    if (c) [...ROOM_WORDS[c], ...(ROOM_PT[c] || [])].forEach(add);
    // a room id the table does not know: its full forms only ("tool storage", never the bare "tool")
    for (const w of Array.isArray(f.words) ? f.words : roomWords(id)) if (/\s/.test(w) || w === id) add(w);
    add(id);
  }
  return [...out];
}

/** Every place name in a normalized text (a plural "s" / "es" counts), at most 4. */
function nameHits(norm, names) {
  return names.filter((n) => norm.includes(` ${n} `) || norm.includes(` ${n}s `) || norm.includes(` ${n}es `)).slice(0, 4);
}

/** The first activity of `list` a normalized text shows (whole words; the last may be a 4+ letter stem), or null. */
function actHit(norm, list) {
  const t = norm.trim().split(" ").filter(Boolean);
  for (const act of list || []) {
    const a = normalize(act).trim().split(" ");
    const last = a.length - 1;
    for (let i = 0; i + last < t.length; i++) {
      let ok = true;
      for (let j = 0; j <= last && ok; j++) ok = j === last && a[j].length >= 4 ? t[i + j].startsWith(a[j]) : t[i + j] === a[j];
      if (ok) return act;
    }
  }
  return null;
}

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
 * What the clue agent may say about a building, each fact with an id, its words (a proper name,
 * which stays the same in every language and may appear; otherwise the place's own names, which a
 * ring may not use: cluesGate reads ACTS for evidence), and whether it is
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

const isEnglish = (l) => /^en\b/i.test(String(l || ""));
const isPt = (l) => /^pt/i.test(String(l || ""));
const textIn = (v, lang, languages) => (typeof v === "string" ? (languages.length <= 1 ? v : null) : v && typeof v === "object" ? v[lang] : null);
const actsIn = (A, lang) => (!A ? [] : isEnglish(lang) ? A.en : isPt(lang) ? A.pt : []);
// facts mid may turn the reader by: the kind of place, a room, a basement, upper floors (not size, not a name)
const MID_KINDS = new Set(["room", "kind", "basement", "floors"]);

/**
 * The code gate on a clue answer. answer: { far, mid, near, cites: { mid: [cite], near: [cite] } }
 * (or { proximity: {...}, cites }), a cite being { fact: "<id>", words: { lang: "the words used" } }.
 * opts: { facts, languages, room } (room: the room the piece was asked into, if any).
 *
 * Indirect rings (Teko, 2026-10-23): what the place is, never; what a person did or sensed there.
 *  1. far, mid and near each have a text in every language, at most CLUE_TEXT_MAX characters.
 *  2. No ring names a room or the kind of place, in any language (ROOM_WORDS, ROOM_PT, KIND_NAMES,
 *     plus the building's own room ids; a plural counts). Proper names (region, building name,
 *     neighbour) are taken out first, so "Riverside Laundromat" may stand.
 *  3. A fact shows in a ring when, in every language, the text holds one of its ACTIVITY words
 *     (English and PT-BR lists; another language: the cite's words for it). Declared cites are
 *     optional: the gate reads the text itself.
 *  4. mid shows a room, the kind of place, a basement or upper floors; near shows a distinctive fact.
 *  5. When the piece was asked into a room, near evokes no other room of the building (an activity
 *     word both rooms share does not count).
 *
 * Returns { ok, texts: { far, mid, near }, cited: { mid: [ids], near: [ids] }, room: the room the
 * near line evokes (or null), errors: [] }.
 */
export function cluesGate(answer, { facts = [], languages = ["en"], room = null } = {}) {
  const langs = Array.isArray(languages) && languages.length ? languages : ["en"];
  const errors = [];
  const src = answer && typeof answer === "object" ? (answer.proximity && typeof answer.proximity === "object" ? answer.proximity : answer) : {};
  const texts = { far: src.far, mid: src.mid, near: src.near };
  const propers = facts.filter((f) => f.proper).flatMap((f) => f.words || []).map((w) => normalize(w).trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  // a ring's text in one language, normalized, the proper names taken out
  const clean = (k, l) => {
    const s = textIn(texts[k], l, langs);
    if (typeof s !== "string") return null;
    let n = normalize(s);
    for (const p of propers) n = n.split(` ${p} `).join("  ");
    return n;
  };
  const names = placeNames(facts);
  for (const k of ["far", "mid", "near"]) {
    for (const l of langs) {
      const s = textIn(texts[k], l, langs);
      if (typeof s !== "string" || !s.trim()) { errors.push(`${k}: no text in ${l}`); continue; }
      if (s.length > CLUE_TEXT_MAX) errors.push(`${k}: longer than ${CLUE_TEXT_MAX} characters in ${l}`);
      for (const hit of nameHits(clean(k, l), names)) errors.push(`${k}: names the place ("${hit}") in ${l}`);
    }
  }
  const byId = new Map(facts.map((f) => [f.id, f]));
  const cites = answer && typeof answer.cites === "object" && answer.cites ? answer.cites : {};
  const cited = { mid: [], near: [] };
  for (const ring of ["mid", "near"]) {
    const declared = Array.isArray(cites[ring]) ? cites[ring] : [];
    const list = [...declared, ...facts.filter((f) => !declared.some((c) => c?.fact === f.id)).map((f) => ({ fact: f.id, auto: true }))];
    for (const c of list) {
      const f = byId.get(c?.fact);
      if (!f) { if (c?.fact) errors.push(`${ring}: cites ${String(c.fact).slice(0, 60)}, a fact it was not given`); continue; }
      const A = factActs(f);
      if (!A || cited[ring].includes(f.id)) continue;
      const shown = langs.every((l) => {
        const s = clean(ring, l);
        if (s === null) return false;
        if (actHit(s, actsIn(A, l))) return true;
        if (isEnglish(l) || isPt(l)) return false;
        const w = c.words && typeof c.words === "object" ? c.words[l] : null;
        return typeof w === "string" && mentions(s, w);
      });
      if (shown) cited[ring].push(f.id);
    }
  }
  if (!cited.mid.some((id) => MID_KINDS.has(byId.get(id)?.kind))) errors.push("mid: shows none of the building's facts");
  if (!cited.near.some((id) => byId.get(id)?.distinctive)) errors.push("near: shows nothing only this building has");
  if (room) {
    const ownA = ACTS[canonRoom(room)] || { en: [], pt: [] };
    const own = new Set([...ownA.en, ...ownA.pt].map((w) => normalize(w).trim()));
    for (const f of facts) {
      if (f.kind !== "room" || f.id === `room:${room}`) continue;
      const A = factActs(f);
      if (!A) continue;
      for (const l of langs) {
        const s = clean("near", l);
        const hit = s === null ? null : actHit(s, actsIn(A, l).filter((w) => !own.has(normalize(w).trim())));
        if (hit) { errors.push(`near: evokes ${f.id} ("${hit}") but the piece is in the ${room}`); break; }
      }
    }
  }
  const nearRooms = cited.near.map((id) => byId.get(id)).filter((f) => f?.kind === "room");
  const nearRoom = (room && nearRooms.find((f) => f.id === `room:${room}`)) || nearRooms.find((f) => f.distinctive) || nearRooms[0];
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
// mid and near rings still narrow the search (Teko, 2026-10-23), indirect like the agent's: mid by
// what living or working in that kind of place was like, near by what the distinctive room smells
// and sounds of, then where it lies from the nearest named place. Never the room's or the place's
// name. The story's own far ring stays: it only sets the mood.

/** mid, from the kind of place: [en, pt]. */
const PLAIN_MID = {
  home: ["Someone lived there, cooked there, kept their own things in order.", "Alguém morava ali, cozinhava ali, cuidava das próprias coisas."],
  shop: ["People came and went all day, money over the counter, the till ringing.", "Gente entrava e saía o dia todo, dinheiro no balcão, a caixa registradora tocando."],
  rural: ["Out of town, a dirt road, the smell of hay and open fields.", "Fora da cidade, uma estrada de terra, cheiro de feno e campo aberto."],
  none: ["One building, not the whole street. I would know it if I saw it.", "Um prédio só, não a rua inteira. Eu reconheceria se visse."],
};

/** near, from the distinctive room (or a basement, upper floors): [en, pt], first person, remembered. */
const PLAIN_NEAR = {
  livingroom: ["The sofa sagging in the middle, a cushion still shaped by someone, the television dark.",
    "O sofá afundado no meio, uma almofada ainda com a forma de alguém, a televisão apagada."],
  diningroom: ["A tablecloth still on, the good plates set out for a dinner nobody sat down to.",
    "A toalha de mesa ainda posta, os pratos bons arrumados para um jantar em que ninguém sentou."],
  laundry: ["Warm cotton, starch, the drum still turning in my head.", "Algodão morno, goma, o tambor girando na minha cabeça."],
  garage: ["Motor oil on my hands, a wrench on the workbench, the smell of an engine gone cold.",
    "Óleo de motor nas mãos, uma chave inglesa na bancada, o cheiro de um motor frio."],
  mechanic: ["Grease and rust, oil black under my nails, an engine hanging from its chain.",
    "Graxa e ferrugem, óleo preto debaixo das unhas, um motor pendurado na corrente."],
  workshop: ["Sawdust in my collar, a vice still clamped, metal filings and the smell of rust.",
    "Serragem na gola, uma morsa ainda apertada, limalha e cheiro de ferrugem."],
  bathroom: ["Steam on the mirror, a damp towel, the shower dripping into the tub.",
    "Vapor no espelho, uma toalha de banho úmida, o chuveiro pingando na banheira."],
  bedroom: ["An unmade bed, the pillow still dented, a blanket pulled half off.", "A cama desfeita, o travesseiro ainda afundado, o cobertor puxado pela metade."],
  kidsbedroom: ["Crayons on the floor, a small bed, a toy left on the pillow.", "Gizes de cera no chão, uma cama pequena, um brinquedo largado no travesseiro."],
  kitchen: ["Onions frying, the kettle starting to sing, bread warm on the board.", "Cebola fritando, a chaleira começando a apitar, pão quente na tábua."],
  hall: ["Coats on their hooks, a doormat worn through, the front door that always stuck.",
    "Casacos pendurados, um capacho gasto, a porta da frente que sempre emperrava."],
  closet: ["Hangers clinking, the smell of mothballs and cedar, shoe boxes up to the ceiling.",
    "Cabides tilintando, cheiro de naftalina e cedro, caixas de sapato até o teto."],
  office: ["The typewriter's keys, paperwork in piles, a ledger left open under the desk lamp.",
    "As teclas da máquina de escrever, papelada em pilhas, um livro-caixa aberto sob a luminária de mesa."],
  pool: ["Chlorine on my skin, the deep end, someone swimming laps that never ended.",
    "Cloro na pele, a parte funda, alguém nadando de um lado para o outro sem parar."],
  shed: ["A lawnmower that never started, a rake, seed packets gone soft in the damp.",
    "Um cortador de grama que nunca pegava, um rastelo, pacotes de sementes amolecidos pela umidade."],
  storage: ["Cardboard boxes stacked to the rafters, dust sheets over things nobody wanted.",
    "Caixas de papelão empilhadas até o teto, panos velhos cobrindo o que ninguém queria."],
  medical: ["Antiseptic in my nose, gauze and bandages, a stethoscope cold against the skin.",
    "Antisséptico no nariz, gaze e curativos, um estetoscópio frio contra a pele."],
  pharmacy: ["Bitter tablets, a prescription in a stranger's hand, the cough syrup's sweetness.",
    "Comprimidos amargos, uma receita na letra de outra pessoa, o doce do xarope."],
  church: ["Candles guttering, the creak of the pews, a hymn I had almost forgotten.",
    "Velas se apagando, o rangido dos bancos de madeira, um hino que eu quase tinha esquecido."],
  bar: ["The smell of spilled alcohol and old tobacco, a jukebox playing to empty stools.",
    "Cheiro de álcool derramado e tabaco velho, uma jukebox tocando para banquinhos vazios."],
  grocery: ["Canned peaches, a shopping cart with one bad wheel, the beep at the checkout.",
    "Pêssego em lata, um carrinho de compras com a roda torta, o bipe no caixa."],
  gasstore: ["Gasoline fumes, the pumps ticking over, road maps nobody would need again.",
    "Cheiro de gasolina, as bombas estalando, mapas de estrada que ninguém mais ia usar."],
  policestorage: ["Handcuffs on a hook, evidence bags, the radio crackling with nobody answering.",
    "Algemas num gancho, sacos de provas, o rádio chiando sem ninguém responder."],
  firestorage: ["Heavy boots by the trucks, a coiled hose, smoke soaked into the helmets.",
    "Botas pesadas junto aos caminhões, uma mangueira enrolada, fumaça entranhada nos capacetes."],
  restaurant: ["Sizzle from the grill, an order pad, coffee reheated for the third time.",
    "O chiado da chapa, uma comanda, café requentado pela terceira vez."],
  library: ["Pages turning in the quiet, rows of books, a due date stamped in purple.",
    "Páginas virando no silêncio, fileiras de livros, uma data de devolução carimbada de roxo."],
  school: ["Chalk on my fingers, desks in rows, the bell for recess.", "Giz nos dedos, carteiras enfileiradas, o sinal do recreio."],
  motelroom: ["A key on a plastic tag, the ice machine humming, walls so thin I heard every word.",
    "Uma chave com chaveiro de plástico, a máquina de gelo zumbindo, paredes tão finas que eu ouvia tudo."],
  barn: ["Hay in my hair, the smell of horses and manure, a pitchfork left in the straw.",
    "Feno no cabelo, cheiro de cavalo e esterco, um forcado esquecido na palha."],
  farmstorage: ["Feed sacks and fertilizer, a dust that tasted of seed, hay piled to the rafters.",
    "Sacos de ração e adubo, uma poeira com gosto de semente, feno até as vigas."],
  butcher: ["A cleaver in the block, raw meat on hooks, the cold biting at my fingers.",
    "Um cutelo no cepo, carne crua nos ganchos, o frio mordendo os dedos."],
  coldstorage: ["Frost on the walls, my breath smoking, the cold that numbs the fingers.",
    "Geada nas paredes, a respiração branca no ar, o frio que deixa os dedos dormentes."],
  theatre: ["The hum of a projector, an audience laughing in the dark, the air conditioning too cold.",
    "O zumbido de um projetor, uma plateia rindo no escuro, o ar condicionado gelado demais."],
  bakery: ["Flour in the air, dough rising under a cloth, the oven still warm.", "Farinha no ar, massa crescendo sob um pano, o forno ainda morno."],
  gym: ["Sweat and rubber mats, a barbell left on the rack, the clank of weights.",
    "Suor e colchonetes, um halter largado no suporte, o tinido dos pesos."],
  basement: ["The cold of the steps going down, the dark under the floor.", "O frio dos degraus descendo, o escuro debaixo do chão."],
  floors: ["The creak of the stairs going up, footsteps over my head.", "O rangido da escada subindo, passos em cima da minha cabeça."],
};
PLAIN_NEAR.garagestorage = PLAIN_NEAR.garage;
PLAIN_NEAR.poolroom = PLAIN_NEAR.pool;
PLAIN_NEAR.classroom = PLAIN_NEAR.school;

/** Every room the plain near lines cover (tests run each through cluesGate). */
export const PLAIN_ROOMS = Object.keys(PLAIN_NEAR).filter((k) => k !== "basement" && k !== "floors");

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
 * { mid, near, room } from facts alone, in every language in use ("en" and "pt-br" written; any
 * other language gets the English line). facts: buildingFacts(...). room: the room the piece is
 * asked into. room in the answer: the room near evokes (the piece is asked into it), or null.
 */
export function plainRings(facts, { languages = ["en"], room = null } = {}) {
  if (!facts?.building) return null;
  const f = facts.facts || [];
  const has = (id) => f.some((x) => x.id === id);
  const b = facts.building;
  const lineOf = (id) => PLAIN_NEAR[canonRoom(id)] || null;
  const pick = (room && lineOf(room) ? room : null)
    || (f.find((x) => x.kind === "room" && x.distinctive && lineOf(x.id.slice(5))) || {}).id?.slice(5) || null;
  const other = !pick && (f.find((x) => x.id === "basement" && x.distinctive) ? "basement"
    : f.find((x) => x.kind === "floors" && x.distinctive) ? "floors" : null);
  const [rx, ry] = String(b.id || "").split("_").slice(1).map(Number);
  const n = facts.neighbour;
  const dir = n && Number.isFinite(rx) && Number.isFinite(n.x) ? compass(n.x, n.y, rx, ry) : null;
  const mid = PLAIN_MID[has("kind:home") ? "home" : has("kind:shop") ? "shop" : has("kind:rural") ? "rural" : "none"];
  const line = pick ? lineOf(pick) : other ? PLAIN_NEAR[other] : ["I would know it if I saw it.", "Eu reconheceria se visse."];
  const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
  const where = [dir ? ` ${cap(dir[0])} of ${n.name}.` : b.region ? ` Somewhere in ${b.region}.` : "",
    dir ? ` A ${dir[1]} de ${n.name}.` : b.region ? ` Em algum lugar de ${b.region}.` : ""];
  // far only stands in when the story's own far names the place (it must not, docs/04)
  const en = { far: "Something about that place keeps coming back to me, the way a smell does.", mid: mid[0], near: `${line[0]}${where[0]} It is in there.` };
  const pt = { far: "Alguma coisa daquele lugar volta pra mim, como um cheiro volta.", mid: mid[1], near: `${line[1]}${where[1]} Está lá dentro.` };
  const one = (k) => (languages.length <= 1 ? (/^pt/i.test(languages[0] || "") ? pt[k] : en[k])
    : Object.fromEntries(languages.map((l) => [l, /^pt/i.test(l) ? pt[k] : en[k]])));
  return { far: one("far"), mid: one("mid"), near: one("near"), room: pick };
}
