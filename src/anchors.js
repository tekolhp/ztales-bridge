/**
 * Anchor variety for the hints (Teko, 2026-11-04). Chapter two's 21 watch hints leaned on one
 * detail: "starch" (goma) in 16, ironing in 13, hands in 11, "says I'm tired" in 5. Each call is
 * independent, so the agent never knew what it had already written for that player.
 *
 * The bridge now remembers the chapter's last HINT_MEMORY hints (who they were for, the words they
 * used, the `anchor` each declared: the one detail of the chapter it hangs on). It tells the agent
 * the anchors to avoid and the worn words, and the gate refuses a hint that:
 *   - declares no anchor, or one of the player's last anchors or one the chapter keeps reusing;
 *   - holds one of those anchors in its text;
 *   - leans on WORN_PER_TEXT or more worn words (words in a large share of the recent hints).
 * A refused hint is asked again with the reason (the watch retries, src/story.js).
 *
 * Words are compared plain (lowercase, no accents) by a short stem, so goma/gomada and
 * passar/passando meet. Capitalised words (names, towns) and common words are never counted.
 */

export const HINT_MEMORY = 12;
/** The player's own last anchors to avoid. */
export const PLAYER_ANCHORS = 3;
/** A word is worn when it is in at least this share of the remembered hints (and WORN_MIN of them). */
export const WORN_SHARE = 0.35;
export const WORN_MIN = 3;
/** Worn words in one text that refuse it. */
export const WORN_PER_TEXT = 2;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const plain = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const stemOf = (w) => (w.length >= 6 ? w.slice(0, 5) : w);

// Common words of a diary in both languages: never counted as worn or as an anchor.
const STOP = new Set(`
para pela pelo pelos pelas como mais mesmo mesma mesmos mesmas ainda sempre nunca hoje ontem amanha agora
depois antes quando onde porque porem entao coisa coisas tudo nada algo alguem alguma algum algumas alguns
minha minhas meus dela dele delas deles isso isto aquilo aquele aquela aqueles aquelas esse essa esses essas
este esta estes estas estou estava estive estavam fico ficou fica ficar ficam sinto senti sentir sente acho
parece parecem pareceu tinha tenho tive tivesse fosse seria seriam vou vai vamos indo fui foram eram sido estar
fazer feito fazia volta voltar voltei voltou novo nova novos novas vezes noite noites dias perto longe dentro
fora sobre entre cada outra outro outras outros todo toda todos todas muito muita muitos muitas pouco pouca
talvez quase apenas mais menos casa casas lugar lugares diario pagina dentro desde ate tambem assim ainda
nossa nosso nossos nossas voce voces gente pessoa pessoas quem qual quais quanto quanta cada sabe saber sei
with that this these those from have has had been were they them their there here what when where which while
again still always never today tonight yesterday tomorrow something someone somebody some just like into onto
over back keep keeps kept feel feels felt think thought know knew seem seems seemed same then than even only
about after before would could should because every other others through down made make makes says said
days night nights mine your yours ours does doing done going went come came once more most much many very
also maybe almost house houses place places diary page around away inside outside thing things nothing
anything everything people person
`.split(/\s+/).filter(Boolean));

/**
 * The countable words of a text: Map stem -> the word as written (lowercase). A capitalised word
 * inside a sentence is a name (a town, a person): it goes to `found` (when given), never counted;
 * a sentence's first word is counted unless it is one of those names.
 */
export function wordsOf(text, { names = false, found = null } = {}) {
  const out = new Map();
  const str = String(text || "");
  const seenNames = new Set();
  const all = [...str.matchAll(/\p{L}+/gu)];
  for (const m of all) {
    const raw = m[0];
    const before = str.slice(0, m.index).trimEnd();
    const starts = !before || /[.!?:;"“—\-]$/.test(before);
    if (raw[0] !== raw[0].toLowerCase() && !starts) seenNames.add(stemOf(plain(raw)));
  }
  if (found) seenNames.forEach((n) => found.add(n));
  for (const m of all) {
    const raw = m[0];
    const w = plain(raw);
    if (w.length < 4 || STOP.has(w)) continue;
    const s = stemOf(w);
    if (!names && seenNames.has(s)) continue;
    if (!out.has(s)) out.set(s, raw.toLowerCase());
  }
  return out;
}

const textsOf = (v) => (typeof v === "string" ? [v] : isObj(v) ? Object.values(v).filter((x) => typeof x === "string") : []);

/** One remembered hint: { player, stems, anchors, words: {stem: word} } from its text and anchor. */
export function hintRecord(player, text, anchor) {
  const words = new Map();
  const found = new Set();
  for (const t of textsOf(text)) for (const [s, w] of wordsOf(t, { found })) if (!words.has(s)) words.set(s, w);
  const anchors = new Map();
  for (const t of textsOf(anchor)) for (const [s, w] of wordsOf(t, { names: true })) if (!anchors.has(s)) anchors.set(s, w);
  return { player: String(player || ""), stems: [...words.keys()], anchors: [...anchors.keys()], names: [...found],
    words: Object.fromEntries([...words, ...anchors]) };
}

/** The memory with one more hint, the oldest dropped past HINT_MEMORY. memory: { node, recent: [] } */
export function remember(memory, node, record) {
  const recent = memory && memory.node === node && Array.isArray(memory.recent) ? memory.recent : [];
  return { node, recent: [...recent, record].slice(-HINT_MEMORY) };
}

/** The memory of a chapter from directives already sent (oldest first): its watch hints. */
export function memoryFrom(node, directives) {
  let memory = { node, recent: [] };
  for (const d of directives || []) {
    if (!isObj(d) || d.type !== "diary_entry" || d.node !== node || !/^watch_/.test(String(d.kind || ""))) continue;
    memory = remember(memory, node, hintRecord(d.player, d.text, d.anchor));
  }
  return memory;
}

const wordOf = (memory, stem) => {
  for (const r of memory.recent) if (r.words && r.words[stem]) return r.words[stem];
  return stem;
};

/** What to avoid for one player: { anchors: [stems], worn: [stems] }. */
export function avoidFor(memory, player) {
  const all = memory && Array.isArray(memory.recent) ? memory.recent : [];
  // a name in any hint (a town, a person) is never worn: the pull toward a town is wanted
  const names = new Set(all.flatMap((r) => r.names || []));
  const recent = all.map((r) => ({ ...r, stems: (r.stems || []).filter((s) => !names.has(s)) }));
  const anchors = new Set();
  for (const r of recent.filter((x) => x.player === player).slice(-PLAYER_ANCHORS)) (r.anchors || []).forEach((s) => anchors.add(s));
  const anchorCount = new Map();
  for (const r of recent) for (const s of new Set(r.anchors || [])) anchorCount.set(s, (anchorCount.get(s) || 0) + 1);
  for (const [s, n] of anchorCount) if (n >= 2) anchors.add(s);
  const worn = [];
  if (recent.length >= WORN_MIN) {
    const need = Math.max(WORN_MIN, Math.ceil(recent.length * WORN_SHARE));
    const count = new Map();
    for (const r of recent) for (const s of new Set(r.stems || [])) count.set(s, (count.get(s) || 0) + 1);
    worn.push(...[...count].filter(([, n]) => n >= need).sort((a, b) => b[1] - a[1]).map(([s]) => s));
  }
  return { anchors: [...anchors], worn };
}

/** For the agent's context: the words themselves, not stems. */
export function adviceFor(memory, player) {
  const a = avoidFor(memory, player);
  return { avoid_anchors: a.anchors.map((s) => wordOf(memory, s)), worn_words: a.worn.map((s) => wordOf(memory, s)) };
}

/**
 * Reasons to refuse one hint (empty: it may go). texts: its text in every language; anchor: what
 * it declared ({lang: word} or a string).
 */
export function repeatErrors(text, anchor, memory, player) {
  const { anchors, worn } = avoidFor(memory, player);
  const said = hintRecord(player, text, anchor);
  if (!said.anchors.length) {
    return ['declare "anchor": {lang: the one detail of the chapter this hint hangs on}, a different one from the last hints'];
  }
  const errors = [];
  const avoid = new Set(anchors);
  const name = (s) => `"${wordOf(memory, s)}"`;
  const again = said.anchors.filter((s) => avoid.has(s));
  if (again.length) {
    errors.push(`the anchor ${again.map(name).join(", ")} was used in recent hints: choose another detail of the chapter`);
  }
  const inText = said.stems.filter((s) => avoid.has(s) && !again.includes(s));
  if (inText.length) {
    errors.push(`the text uses ${inText.map(name).join(", ")}, the anchor of recent hints: leave it out`);
  }
  const wornHit = said.stems.filter((s) => worn.includes(s));
  if (wornHit.length >= WORN_PER_TEXT) {
    errors.push(`leans on words worn by the last hints (${wornHit.map(name).join(", ")}): say it with other words and another sense`);
  }
  return errors;
}
