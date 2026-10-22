/**
 * What an urn gives back (Teko, 2026-10-21), drawn at random from the server's own item catalog
 * (the mod's catalog/items-<category>.json, its mods' items included), never from a list kept
 * here. Every urn has a focus you can see when you open it: weapons, food, medicine or
 * survival. The focus comes in plenty, the rest in some, and a touch of clothing always.
 *   the Final Tale: the focus drawn at random, everything in abundance ("grand")
 *   a story's urn:  the focus fits the story (the AI's finale.reward_focus), worth the story
 * The core is only good things: what the world hands out, never broken, dirty or scrap, never
 * toys; food that is a meal (weight), not a sugar packet; a gun comes with the box of its round.
 * Then a little "collateral" (Teko, 2026-10-21): anything the world drops, a broken katana, a few
 * jelly beans, never more than about a fifth of the urn, so the strong core always outweighs it.
 * rows: [full_type, name, item_type, weight, tags, max_damage, loot chance, round fired?]
 */

export const FOCI = ["weapons", "food", "medicine", "survival"];

// the catalog files each kind is drawn from (the game's own display categories)
export const REWARD_CATEGORIES = {
  guns: ["WepFire"], ammo: ["WepAmmo"],
  melee: ["WepMBladeL", "WepMBladeS", "WepMBluntL", "WepMBluntS", "WepMAxe", "WepMSpear"],
  food: ["FoodN"], meds: ["MedM", "MedT"], tools: ["ToolC"],
  survival: ["SurCamp", "SurTrap", "SurFish"], bags: ["ClothBack"], clothes: ["ClothBody", "ClothHead"],
};

const BAD_NAME = /broken|dirty|rotten|scrap|_open|empty|firstaid/i;   // never in the core
const NEVER = /firstaid/i;                                              // never at all: no first-aid kit boxes (Teko)
const between = (a, b, rand) => a + Math.floor(rand() * (b - a + 1));
const pickRepeat = (list, n, rand) => (list.length ? Array.from({ length: n }, () => list[Math.floor(rand() * list.length)]) : []);
const pickSome = (list, n, rand) => {
  const pool = [...list];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
};

// the quality bar each kind must clear, on top of "the world drops it" and a clean name
const KEEP = {
  guns: (r) => (r[4] || []).includes("base:firearm"),
  melee: (r) => Number(r[5]) >= 1.5,
  food: (r) => Number(r[3]) >= 0.3,              // a meal, not a sugar packet or a jelly bean
  meds: (r) => Number(r[3]) >= 0.05,
  tools: (r) => Number(r[3]) >= 0.8,             // a hammer, a saw, not a fork
  survival: (r) => Number(r[3]) >= 0.1,
  bags: () => true, clothes: (r) => Number(r[3]) >= 0.3, ammo: () => true,
};
export function usable(kind, r) {
  return Array.isArray(r) && typeof r[0] === "string" && Number(r[6]) > 0 && !BAD_NAME.test(r[0])
    && !(r[4] || []).some((t) => /fakeweapon|ismemento/.test(t)) && (KEEP[kind] ? KEEP[kind](r) : true);
}

// how much of each kind: [entries, count each] for the focus and for the rest, per scale
const AMOUNTS = {
  grand: {
    focus: { guns: [4, 6], gunAmmo: [6, 12], melee: [3, 4], food: [10, 14], foodEach: [4, 10], meds: [6, 9], medsEach: [3, 8],
             tools: [4, 6], survival: [4, 6], survivalEach: [1, 2], bags: [2, 3] },
    rest: { guns: [1, 2], gunAmmo: [3, 6], melee: [1, 2], food: [4, 6], foodEach: [2, 4], meds: [2, 3], medsEach: [1, 3],
            tools: [2, 3], survival: [1, 2], survivalEach: [1, 1], bags: [1, 1] },
  },
  story: {
    focus: { guns: [1, 2], gunAmmo: [3, 6], melee: [1, 2], food: [5, 7], foodEach: [2, 5], meds: [3, 5], medsEach: [2, 4],
             tools: [2, 3], survival: [2, 3], survivalEach: [1, 1], bags: [1, 1] },
    rest: { guns: [0, 0], gunAmmo: [0, 0], melee: [0, 1], food: [1, 2], foodEach: [1, 2], meds: [1, 1], medsEach: [1, 2],
            tools: [0, 1], survival: [0, 1], survivalEach: [1, 1], bags: [0, 1] },
  },
  // one extra piece's share (src/collab.js): the focus only, a smaller handful, nothing else
  bonus: {
    focus: { guns: [0, 1], gunAmmo: [2, 4], melee: [1, 1], food: [2, 3], foodEach: [1, 3], meds: [1, 2], medsEach: [1, 2],
             tools: [1, 1], survival: [1, 1], survivalEach: [1, 1], bags: [0, 1] },
    rest: { guns: [0, 0], gunAmmo: [0, 0], melee: [0, 0], food: [0, 0], foodEach: [0, 0], meds: [0, 0], medsEach: [0, 0],
            tools: [0, 0], survival: [0, 0], survivalEach: [0, 0], bags: [0, 0] },
  },
};
/** At most this many bonus lists ride on a story's urn (one per extra piece inside it). */
export const URN_BONUS_MAX = 6;
/** The Final Tale grows with the season's extra pieces: one bonus list each, at most this many. */
export const FINAL_BONUS_MAX = 8;

/** rowsBy: { kind -> catalog rows }; focus one of FOCI (anything else: drawn); grand for the Final Tale. */
export function drawReward(rowsBy, { focus, grand = false, bonus = false, rand = Math.random } = {}) {
  const f = FOCI.includes(focus) ? focus : FOCI[Math.floor(rand() * FOCI.length)];
  const scale = AMOUNTS[bonus ? "bonus" : grand ? "grand" : "story"];
  const A = (kind) => (f === "weapons" && ["guns", "gunAmmo", "melee"].includes(kind)) || (f === "food" && /^food/.test(kind))
    || (f === "medicine" && /^meds/.test(kind)) || (f === "survival" && /^(survival|tools|bags)/.test(kind)) ? scale.focus[kind] : scale.rest[kind];
  const ok = (kind) => (rowsBy[kind] || []).filter((r) => usable(kind, r));
  const r = [];
  const ammoRows = ok("ammo");
  const boxOf = (round) => round && (ammoRows.find((a) => a[0] === `${round}Box`) || ammoRows.find((a) => a[0].startsWith(round) && /box|carton/i.test(a[0])));
  // strong things may repeat
  for (const g of pickRepeat(ok("guns"), between(...A("guns"), rand), rand)) {
    r.push({ item: g[0], count: 1 });
    const box = boxOf(g[7]);
    if (box) r.push({ item: box[0], count: between(...A("gunAmmo"), rand) });
  }
  for (const m of pickRepeat(ok("melee"), between(...A("melee"), rand), rand)) r.push({ item: m[0], count: 1 });
  for (const x of pickSome(ok("food"), between(...A("food"), rand), rand)) r.push({ item: x[0], count: between(...A("foodEach"), rand) });
  for (const x of pickSome(ok("meds"), between(...A("meds"), rand), rand)) r.push({ item: x[0], count: between(...A("medsEach"), rand) });
  for (const x of pickSome(ok("tools"), between(...A("tools"), rand), rand)) r.push({ item: x[0], count: 1 });
  for (const x of pickSome(ok("survival"), between(...A("survival"), rand), rand)) r.push({ item: x[0], count: between(...A("survivalEach"), rand) });
  for (const x of pickRepeat(ok("bags"), between(...A("bags"), rand), rand)) r.push({ item: x[0], count: 1 });
  // a touch of clothing, always: one or two pieces, whatever the focus
  if (!bonus) for (const x of pickSome(ok("clothes"), between(1, 2, rand), rand)) r.push({ item: x[0], count: 1 });
  // collateral: whatever else the world drops, a fifth of the urn at most, a few of each
  const loose = Object.values(rowsBy).flat().filter((x) => Array.isArray(x) && typeof x[0] === "string" && Number(x[6]) > 0
    && !NEVER.test(x[0]) && !(x[4] || []).some((t) => /fakeweapon|ismemento/.test(t)) && !r.some((c) => c.item === x[0]));
  const extra = bonus ? 0 : Math.floor(r.length / 5);
  for (const x of pickSome(loose, between(Math.min(1, extra), extra, rand), rand)) r.push({ item: x[0], count: between(1, 3, rand), collateral: true });
  return { focus: f, items: r.filter((x) => x.count > 0).map(({ collateral, ...x }) => x), collateral: r.filter((x) => x.collateral).map((x) => x.item) };
}

/** n smaller draws of the same focus, one per extra piece (src/collab.js): [[{ item, count }], ...].
 *  A draw that came out empty (a thin catalog) is dropped. */
export function drawBonus(rowsBy, { focus, n = 0, max = URN_BONUS_MAX, rand = Math.random } = {}) {
  const out = [];
  for (let i = 0; i < Math.min(Math.max(0, n), max); i++) {
    const d = drawReward(rowsBy, { focus, bonus: true, rand });
    if (d.items.length) out.push(d.items);
  }
  return out;
}

/** Read the catalog files a reward draws from (a handful, only when an urn is built). */
export async function loadRewardRows(t, parse) {
  const rowsBy = {};
  for (const [kind, cats] of Object.entries(REWARD_CATEGORIES)) {
    rowsBy[kind] = [];
    for (const c of cats) {
      const doc = parse(await t.get(`catalog/items-${c}.json`));
      if (doc && Array.isArray(doc.rows)) rowsBy[kind].push(...doc.rows);
    }
  }
  return rowsBy;
}
