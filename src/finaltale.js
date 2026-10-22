/**
 * The Final Tale (docs/11, Teko 2026-10-21): the season's grand finale, written by the bridge
 * alone (no AI call). Five Tales packed in their box make the mod report `tales_boxed`; the
 * bridge answers once: a great urn on a landmark no urn ever used, the call written into the
 * packer's diary, and armed ahead the event and its colossal reward, the Ashes among it.
 * Every id starts with "final_", which the mod keeps through any story's end or opening.
 */
import { CEMETERY_CELLS, CELL, GRAVE_TILESET } from "./cemeteries.js";
import { tier, waveParams } from "./difficulty.js";
import { arrangeScore, beatsToDirectives, splitGap, MOD_FEATURES_VERSION } from "./toolkit.js";

const T = (en, pt) => ({ en, "pt-br": pt });

// how a building reads in a sentence (catalog room types)
const ROOMS = {
  church: ["the church", "a igreja"], office: ["the office", "o escritório"], library: ["the library", "a biblioteca"],
  school: ["the school", "a escola"], police: ["the police station", "a delegacia"], medical: ["the clinic", "a clínica"],
  laundry: ["the laundromat", "a lavanderia"], warehouse: ["the warehouse", "o armazém"], gasstore: ["the gas station", "o posto"],
};

export function finalTalePlaceWords(place) {
  if (!place) return T("the last building", "o último prédio");
  if (place.kind === "cemetery") {
    return place.region ? T(`the cemetery near ${place.region}`, `o cemitério perto de ${place.region}`)
      : T("the old cemetery past the last houses", "o velho cemitério depois das últimas casas");
  }
  if (place.name) return T(place.name, place.name);
  const room = (place.rooms || []).find((r) => ROOMS[r]);
  const [en, pt] = ROOMS[room] || ["the last building", "o último prédio"];
  return place.region ? T(`${en} in ${place.region}`, `${pt} de ${place.region}`) : T(`${en} past the last houses`, `${pt} depois das últimas casas`);
}

// The colossal reward: reward.js, "grand", its focus drawn (weapons, food, medicine, survival).
import { drawReward, drawBonus, FINAL_BONUS_MAX } from "./reward.js";

export const ASHES_ITEM = "ZTales.Ashes";

const WAVE_LINES = [
  T("The first story comes back for what it lost.", "A primeira história volta pelo que perdeu."),
  T("The second story remembers your name.", "A segunda história se lembra do seu nome."),
  T("The third story never left.", "A terceira história nunca foi embora."),
  T("The fourth story is already inside.", "A quarta história já está lá dentro."),
  T("The fifth story counts down.", "A quinta história faz a contagem."),
];

/**
 * Where the Final Tale happens (Teko, 2026-10-21): a church or a cemetery, drawn at random,
 * the one nearest to where players are, never one an urn already used; the other kind when the
 * drawn one has none. Cemeteries come from the game's map files (cemeteries.js), churches from
 * the catalog's rooms. null when neither exists (a modded map without them).
 */
export function chooseFinalTalePlace({ places = [], history = [], points = [], rand = Math.random }) {
  const used = new Set(history || []);
  const dist = (x, y) => (points.length ? Math.min(...points.map(([px, py]) => Math.hypot(px - x, py - y))) : 0);
  const xyOf = (p) => { const m = /^b_(\d+)_(\d+)$/.exec(p.id || ""); return m ? [Number(m[1]), Number(m[2])] : [p.x || 0, p.y || 0]; };
  const cemeteries = CEMETERY_CELLS.map(([cx, cy]) => ({ kind: "cemetery", id: `cem_${cx}_${cy}`, cell: [cx, cy],
    x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 })).filter((c) => !used.has(c.id))
    .sort((a, b) => dist(a.x, a.y) - dist(b.x, b.y));
  const churches = places.filter((p) => p && p.id && !used.has(p.id) && (p.rooms || []).includes("church"))
    .map((p) => { const [x, y] = xyOf(p); return { ...p, kind: "church", x: x + 4, y: y + 4 }; })
    .sort((a, b) => dist(a.x, a.y) - dist(b.x, b.y));
  const order = rand() < 0.5 ? [cemeteries, churches] : [churches, cemeteries];
  const pick = order[0][0] || order[1][0] || null;
  if (pick && pick.kind === "cemetery") {
    // the town it belongs to, so the nightmare can only mean this one
    const near = places.map((p) => ({ p, d: Math.hypot(xyOf(p)[0] - pick.x, xyOf(p)[1] - pick.y) })).sort((a, b) => a.d - b.d)[0];
    if (near && near.p.region) pick.region = near.p.region;
  }
  return pick;
}

/** Everything the bridge sends when five Tales are boxed. `known` is the game's item set, or null. */
// the season's last fight is the top of the difficulty table (difficulty.js): always the hardest
// extras: the season's tally of extra pieces (src/collab.js, state.extras_total): each one adds a
// smaller draw of the same focus to the great urn, at most FINAL_BONUS_MAX
export function finalTaleDirectives({ place, packer, rowsBy = {}, waveSeconds = tier("final").wave_seconds, rand = Math.random, extras = 0,
  modVersion = MOD_FEATURES_VERSION, tested = [] }) {
  const where = finalTalePlaceWords(place);
  const cx = place.x, cy = place.y;
  // no AI here: the pools alone score the night, drawn fresh for every place (docs/12 3.4)
  const building = place.kind === "cemetery" ? null : place.id;
  const score = arrangeScore(null, { seed: `final|${place.id}`, waveSeconds, gaps: WAVE_LINES.length - 1,
    placeKind: place.kind === "cemetery" ? "cemetery" : "building", tested, modVersion, storm: true });
  const beats = (list, idOf, offset = 0) => beatsToDirectives(list, { idOf, urn: [cx, cy], building, slot: "final", modVersion, offset });
  const gapHalves = score.gaps.map((g) => splitGap(g, waveSeconds));
  const drawn = drawReward(rowsBy, { grand: true, rand });
  const reward = drawn.items;
  for (const list of drawBonus(rowsBy, { focus: drawn.focus, n: extras, max: FINAL_BONUS_MAX, rand })) reward.push(...list);
  reward.push({ item: ASHES_ITEM, count: 1 });
  const steps = [];
  steps.push({ after_seconds: 0, then: [
    { id: "final_seq.0.1", type: "radio_static", scope: "server", seconds: 10 },
    ...beats(score.opening, (i) => `final_seq.0.s${i}`),
    { id: "final_seq.0.2", type: "chat", scope: "server", color: "red",
      text: T("Every radio in Knox County speaks at once. Five voices, one sentence.", "Todos os rádios de Knox County falam ao mesmo tempo. Cinco vozes, uma frase.") },
  ] });
  steps.push({ after_seconds: 5, then: [
    { id: "final_seq.1.1", type: "play_sound", sound: "MetaScream", scope: "server" },
    ...(place.kind === "cemetery" ? [] : [{ id: "final_seq.1.2", type: "set_alarm", target: { building: place.id } }]),
    { id: "final_seq.1.3", type: "weather", kind: "storm", hours: 8 },
  ] });
  WAVE_LINES.forEach((line, i) => {
    const k = i + 2;
    if (i > 0) {
      // halfway between waves, something in the dark
      steps.push({ after_seconds: waveSeconds / 2, then: [
        { id: `final_seq.${k}.m2`, type: "radio_static", scope: "server", seconds: 3 },
        ...beats(gapHalves[i - 1][1], (j) => `final_seq.${k}.mb${j}`, waveSeconds / 2),
      ] });
    }
    steps.push({ after_seconds: i === 0 ? 15 : waveSeconds / 2, then: [
      { id: `final_seq.${k}.1`, type: "spawn_wave", slot: "final", at_urn: true, target: { x: cx, y: cy }, ...waveParams("final"), lure_period: waveSeconds },
      { id: `final_seq.${k}.2`, type: "world_sound", target: { x: cx, y: cy }, radius: 80, volume: 80 },
      { id: `final_seq.${k}.3`, type: "lightning", slot: "final", at_urn: true, target: { x: cx, y: cy }, count: i === WAVE_LINES.length - 1 ? 3 : 2 },
      { id: `final_seq.${k}.6`, type: "play_sound", sound: "MetaScream", scope: "server" },
      { id: `final_seq.${k}.4`, type: "radio_static", scope: "server", seconds: 4 },
      { id: `final_seq.${k}.5`, type: "chat", scope: "server", color: "red", text: line },
      // the wave's own beats: the last wave's, or the first half of the gap after it
      ...beats(i === WAVE_LINES.length - 1 ? score.last_wave : gapHalves[i][0], (j) => `final_seq.${k}.b${j}`),
    ] });
  });
  const last = WAVE_LINES.length + 2;
  steps.push({ after_seconds: 60, then: [
    { id: `final_seq.${last}.1`, type: "radio_static", scope: "server", seconds: 8 },
    { id: `final_seq.${last}.5`, type: "play_sound", sound: "BreakFurnitureCeramic", scope: "server", local: true },
    ...beats(score.end, (j) => `final_seq.${last}.e${j}`),
    { id: `final_seq.${last}.2`, type: "open_urn", slot: "final", consume: "all", reward },
    { id: `final_seq.${last}.3`, type: "chat", scope: "server", color: "red",
      text: T("The great urn opens. Whatever was owed has been paid.", "A grande urna se abre. O que era devido foi pago.") },
    // what it gives back, in the players' own language: the focus, seen (Teko, 2026-10-21)
    { id: `final_seq.${last}.4`, type: "chat", scope: "server", color: "red", text: `$urn_focus_${drawn.focus}` },
  ] });
  return [
    { id: "final_urn", type: "spawn_urn", slot: "final", item: "ZTales.UrnGreat", story_id: "final_urn",
      target: place.kind === "cemetery" ? { cell_x: place.cell[0], cell_y: place.cell[1], near_sprite: GRAVE_TILESET } : { building: place.id },
      requires_groups: [["final_box"]],
      title: T("Great clay urn, its seal already broken", "Grande urna de barro, o selo já rompido") },
    { id: `final_call@${packer}`, type: "diary_entry", player: packer, deliver: "now", kind: "nightmare",
      text: T(`I closed the box and the five of them went quiet at once, like a room when someone important walks in. Then I dreamt all of them at the same time: the voices, the hands, the numbers, the faces in the photographs. They were all walking to ${where.en}. They were not afraid. They were waiting for me to bring them home. There is a great urn there. I know it the way you know your own front door.`,
        `Fechei a caixa e os cinco ficaram quietos de uma vez, como uma sala quando alguém importante entra. Depois sonhei com todos ao mesmo tempo: as vozes, as mãos, os números, os rostos das fotografias. Todos caminhavam até ${where["pt-br"]}. Não tinham medo. Esperavam que eu os levasse para casa. Há uma grande urna lá. Eu sei disso como se sabe a própria porta de casa.`) },
    { id: `final_call_line@${packer}`, type: "chat", scope: "player", player: packer, text: "$reveal" },
    { id: "final_filled", type: "reaction", once: "server", when: { event: "urn_filled", story_id: "final_urn" },
      then: [{ id: "final_seq", type: "sequence", steps }] },
  ];
}
