/**
 * The finale (docs/10, Teko 2026-10-20): a fixed template the bridge writes in code when the
 * last node is opened. The AI fills only texts: the nightmare that names the urn's place, the
 * server line, four lines for the event, the Tale. Everything else is here.
 *
 *   the urn      a crate-like container the mod builds in a building chosen by code: outside
 *                every spawn town (Louisville allowed), never a building used by a past story
 *   the pieces   every piece carried weighs on its carrier from the first chapter
 *                (charge_pieces per stage); the last stage adds the aura: the urn's square
 *   the reveal   finding any last-node piece writes the nightmare on the spot, says the rule
 *                line ("What was found goes into the urn.") and the place line to the server
 *   the act      the piece of every chapter inside the urn (urn_filled) fires the script
 *   the script   a sequence: the hush, the first scream, one wave per node ~4 real minutes
 *                apart (each takes one piece from the urn: the event's clock), then silence,
 *                the urn opens with the reward and the Tale, the season ends
 *   lost pieces  a node whose piece is gone gets it placed again, once, on the bridge's
 *                signal piece_lost (src/pieces.js), without an AI call
 *   kept         every reaction here is the bridge's: stage-less and `keep`, so no node change
 *                ever expires it (live run 2026-10-22: a set_node off the last chapter dropped
 *                fin_filled and the full urn never started its event)
 */
import { tier, waveParams } from "./difficulty.js";
import { drawReward, drawBonus, FOCI, URN_BONUS_MAX } from "./reward.js";
import { inSpawnTown, spawnPoints, isLouisville, SPAWN_EXCLUSION } from "./catalog.js";
import { buildingXY } from "./proximity.js";
import { missingLanguages } from "./gates.js";
import { CHAT_MAX_CHARS } from "./protocol.js";
import { gateScore, arrangeScore, beatsToDirectives, splitGap, MOD_FEATURES_VERSION } from "./toolkit.js";

// one wave per piece, a minute and a half apart (Teko, 2026-10-21: four minutes for eight zombies
// was dead time, for one player and more so for a group)
export const WAVE_SECONDS = 90;
export const URN_SPRITE = "carpentry_01_16";
export const TALE_ITEM = "ZTales.Tale";
// one item per volume (Teko, 2026-10-21: books of a set, like the game's skill books)
const ROMAN = ["I", "II", "III", "IV", "V"];
export const taleItem = (n) => `ZTales.Tale${((Math.max(1, n) - 1) % 5) + 1}`;
export const taleNumeral = (n) => ROMAN[(Math.max(1, n) - 1) % 5];
export const TALE_MAX_CHARS = 6000;
export const DEFAULT_CHARGE = [{ stat: "unhappiness", level: 1 }];
export const WEATHERS = new Set(["storm", "fog", "rain", "none"]);

/** Every node's piece story ids, in axis order. */
export function piecesByNode(bible) {
  return (bible?.axis || []).map((n) => ({ node: n.id, ids: (n.pieces || []).map((p) => p.story_id).filter(Boolean), items: n.pieces || [] }));
}

/**
 * The urn's building: among the places offered for the final stage, outside spawn towns
 * (Louisville allowed), never one a past story used; the bible's rooms first, then a named
 * place (a landmark names itself), else the first offered.
 */
export function chooseUrnPlace(places, history = [], roomsWanted = [], index = null) {
  const spawns = index ? spawnPoints(index) : [];
  const used = new Set(history || []);
  const ok = (places || []).filter((p) => p && p.id && !used.has(p.id)
    && (isLouisville(p) || !spawns.length || !inSpawnTown(buildingXY(p.id) || [0, 0], spawns, SPAWN_EXCLUSION)));
  const wanted = new Set(roomsWanted || []);
  return ok.find((p) => (p.rooms || []).some((r) => wanted.has(r)))
    || ok.find((p) => p.name)
    || ok[0] || null;
}

/** What the AI is told about the urn's place, to write where it is. */
export function urnWords(place) {
  if (!place) return null;
  const xy = buildingXY(place.id) || [0, 0];
  return { id: place.id, name: place.name || null, region: place.region || null, rooms: place.rooms || [], x: xy[0] + 4, y: xy[1] + 4 };
}

// The moods a piece may press on (Teko, 2026-10-21): one drawn per piece, repeats allowed.
// no panic (in game 2026-10-21): the game zeroes it at once whatever the mod does, so a carried
// piece made it pop on and off; the weight is the moods that stay
export const RELIC_MOODS = ["stress", "unhappiness", "anger"];

function hashOf(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}

/** The weight of one piece: a mood drawn by its id (the same every time, so a resent stage
 *  never changes it), and a level that grows with the chapter: the first chapter's pieces weigh
 *  1, the last chapter's 3 (Teko, 2026-10-21: the closer to the end, the heavier). */
export function pieceCharge(storyId, nodeIndex, nodeCount, season = "") {
  const mood = RELIC_MOODS[hashOf(`${season}|${storyId}`) % RELIC_MOODS.length];
  // a step up every chapter, however many there are: 5 chapters weigh 1, 1.5, 2, 2.5, 3
  const level = nodeCount <= 1 ? 3 : Math.round((1 + (2 * nodeIndex) / (nodeCount - 1)) * 10) / 10;
  return [{ stat: mood, level }];
}

/** charge_pieces for the given nodes' pieces: each a drawn mood, heavier toward the end. */
export function chargeDirective(id, bible, nodeIds, aura = null) {
  const pieces = {};
  const all = piecesByNode(bible);
  // the moods go round, from a point the season draws, so the pieces of one story never all
  // weigh the same way (in game 2026-10-21 six pieces drew only stress and panic)
  let k = hashOf(`${bible?.season || ""}|moods`) % RELIC_MOODS.length;
  all.forEach((n, i) => {
    for (const sid of n.ids) {
      const charge = pieceCharge(sid, i, all.length, bible?.season || "");
      charge[0].stat = RELIC_MOODS[k++ % RELIC_MOODS.length];
      if (nodeIds.includes(n.node)) pieces[sid] = charge;
    }
  });
  if (!Object.keys(pieces).length) return null;
  const d = { id, type: "charge_pieces", pieces };
  if (aura) d.aura = { x: aura[0], y: aura[1] };
  return d;
}

/**
 * Problems with the AI's finale texts (its part of the final stage); [] when fine. Its score
 * (docs/12) is never a problem: gated in place, every change pushed to `notes`.
 */
export function checkFinaleAnswer(fin, urn, languages, notes = [], scoreCtx = {}) {
  const errs = [];
  if (!fin || typeof fin !== "object") return ["finale: answer { finale: { where, lines: { hush, scream, last_wave, silence }, epilogue, vanish?, tale } }"];
  const text = (field, value, max) => {
    if (value === undefined || value === null || value === "") { errs.push(`finale.${field} missing`); return; }
    const miss = missingLanguages(value, languages);
    if (miss.length) errs.push(`finale.${field} lacks ${miss.join(", ")}`);
    const longest = Math.max(...(typeof value === "object" ? Object.values(value) : [value]).map((v) => String(v || "").length));
    if (max && longest > max) errs.push(`finale.${field} longer than ${max}`);
  };
  text("where", fin.where, 2000);
  for (const k of ["hush", "scream", "last_wave", "silence"]) text(`lines.${k}`, fin.lines?.[k], CHAT_MAX_CHARS);
  // the last diary page: what it was like when it stopped, in the character's voice
  text("epilogue", fin.epilogue, 1200);
  text("tale", fin.tale, TALE_MAX_CHARS);
  if (fin.reward_focus !== undefined && !FOCI.includes(fin.reward_focus)) errs.push(`finale.reward_focus must be one of ${FOCI.join(", ")}`);
  // one line per piece as the urn takes it (optional; the mod has its own when a piece has none)
  if (fin.vanish !== undefined) {
    if (!fin.vanish || typeof fin.vanish !== "object" || Array.isArray(fin.vanish)) errs.push("finale.vanish must map a piece's story_id to its line");
    else for (const [sid, line] of Object.entries(fin.vanish)) text(`vanish.${sid}`, line, CHAT_MAX_CHARS);
  }
  // the place must be unmistakable: the building's name (or its region) in every version
  const mark = urn?.name || urn?.region;
  if (mark) {
    for (const field of ["where"]) {
      const v = fin[field];
      const versions = v && typeof v === "object" ? Object.values(v) : [v];
      if (versions.some((s) => typeof s === "string" && !s.toLowerCase().includes(String(mark).toLowerCase()))) {
        errs.push(`finale.${field} must name the place: "${mark}"`);
      }
    }
  }
  if (fin.weather !== undefined && !WEATHERS.has(fin.weather)) errs.push(`finale.weather must be one of ${[...WEATHERS].join(", ")}`);
  if (fin.score !== undefined) {
    const g = gateScore(fin.score, scoreCtx);
    fin.score = g.score;
    notes.push(...g.notes);
  }
  return errs;
}

/**
 * The event: one step per node (a wave and one piece taken), the hush before, the silence after.
 * What is heard and seen around those steps is the urn's score (docs/12, toolkit.js): the AI's
 * beats and the pools' fill, each riding a step with a delay. No siren in the opening (Teko).
 */
export function finaleSequence({ bible, fin, urnCenter, urnBuilding, nodes, reward, bonus = [], focus, epilogue, serverLine, prefix = "",
  seed = null, modVersion = MOD_FEATURES_VERSION, tested = [] }) {
  const P = prefix;
  // the story's difficulty, a fraction of the Final Tale (difficulty.js)
  const level = bible?.difficulty?.color || "yellow";
  const WAVE = tier(level).wave_seconds;
  const vanish = fin?.vanish && typeof fin.vanish === "object" && Object.keys(fin.vanish).length ? fin.vanish : null;
  const [ux, uy] = urnCenter;
  const scoreWeather = fin?.score?.weather;
  const weather = WEATHERS.has(scoreWeather) ? scoreWeather
    : WEATHERS.has(fin?.weather) ? fin.weather : (WEATHERS.has(bible?.finale?.weather) ? bible.finale.weather : "storm");
  const score = arrangeScore(fin?.score || null, { seed: seed || `${bible?.season || ""}|${urnBuilding}`, waveSeconds: WAVE,
    gaps: Math.max(0, nodes.length - 1), placeKind: "building", tested, modVersion, storm: weather === "storm" });
  const beats = (list, idOf, offset = 0) => beatsToDirectives(list, { idOf, urn: urnCenter, building: urnBuilding, modVersion, offset });
  const steps = [];
  steps.push({ after_seconds: 0, then: [
    { id: `${P}fin_seq.0.1`, type: "radio_static", scope: "server", seconds: 6 },
    // the moment it takes what was found, the world answers (Teko: "não fez barulho")
    ...beats(score.opening, (i) => `${P}fin_seq.0.s${i}`),
    { id: `${P}fin_seq.0.2`, type: "chat", scope: "server", text: fin.lines.hush },
  ] });
  const first = [
    { id: `${P}fin_seq.1.1`, type: "play_sound", sound: "MetaScream", scope: "server" },
  ];
  if (weather !== "none") first.push({ id: `${P}fin_seq.1.3`, type: "weather", kind: weather, hours: 6 });
  // the event starts at once (Teko, 2026-10-21: a minute before the first wave felt dead)
  steps.push({ after_seconds: 5, then: first });
  nodes.forEach((n, i) => {
    const k = i + 2;
    const then = [
      { id: `${P}fin_seq.${k}.1`, type: "spawn_wave", target: { x: ux, y: uy }, at_urn: true, ...waveParams(level) },
      { id: `${P}fin_seq.${k}.2`, type: "world_sound", target: { x: ux, y: uy }, radius: 60, volume: 60 },
      { id: `${P}fin_seq.${k}.3`, type: "open_urn", consume: 1, ...(vanish ? { vanish } : {}) },
    ];
    if (i === 0) then.push({ id: `${P}fin_seq.${k}.4`, type: "chat", scope: "server", text: fin.lines.scream });
    else if (i === nodes.length - 1) then.push({ id: `${P}fin_seq.${k}.4`, type: "chat", scope: "server", text: fin.lines.last_wave });
    const isLast = i === nodes.length - 1;
    // this wave's beats: the last wave's own, or the first half of the gap that follows it
    const [gapFirst, gapMid] = isLast ? [[], []] : splitGap(score.gaps[i], WAVE);
    then.push(...beats(isLast ? score.last_wave : gapFirst, (j) => `${P}fin_seq.${k}.b${j}`));
    // the storm strikes near the urn in every wave, twice in the last (the server may turn it off)
    if (weather === "storm") then.push({ id: `${P}fin_seq.${k}.6`, type: "lightning", target: { x: ux, y: uy }, at_urn: true, count: i === nodes.length - 1 ? 2 : 1 });
    // a scream in every wave (Teko, 2026-10-21: more of them, more frightening)
    if (i > 0) then.push({ id: `${P}fin_seq.${k}.7`, type: "play_sound", sound: "MetaScream", scope: "server" });
    steps.push({ after_seconds: i === 0 ? 15 : WAVE / 2, then });
    // halfway to the next wave, something in the dark: the quiet between them is never safe
    if (i < nodes.length - 1) {
      steps.push({ after_seconds: WAVE / 2, then: [
        { id: `${P}fin_seq.${k}.m2`, type: "radio_static", scope: "server", seconds: 3 },
        ...beats(gapMid, (j) => `${P}fin_seq.${k}.mb${j}`, WAVE / 2),
      ] });
    }
  });
  const last = nodes.length + 2;
  steps.push({ after_seconds: 60, then: [
    { id: `${P}fin_seq.${last}.1`, type: "radio_static", scope: "server", seconds: 4 },
    // the urn gives way: every player hears it on their own character, nothing else needed (Teko, 2026-10-21)
    { id: `${P}fin_seq.${last}.7`, type: "play_sound", sound: "BreakFurnitureCeramic", scope: "server", local: true },
    ...beats(score.end, (j) => `${P}fin_seq.${last}.e${j}`),
    { id: `${P}fin_seq.${last}.2`, type: "charge_pieces", clear: true },
    { id: `${P}fin_seq.${last}.3`, type: "chat", scope: "server", text: fin.lines.silence },
    // bonus: one smaller draw per extra piece the urn was filled with (src/collab.js); the mod
    // counts them inside the urn and gives that many, never more than are listed here
    { id: `${P}fin_seq.${last}.4`, type: "open_urn", consume: "all", reward, ...(bonus.length ? { bonus } : {}) },
    // what it gives back, in the players' own language: the focus, seen (Teko, 2026-10-21)
    ...(focus ? [{ id: `${P}fin_seq.${last}.6`, type: "chat", scope: "server", text: `$urn_focus_${focus}` }] : []),
    // no window (Teko, 2026-10-21): one of the mod's ending lines in chat, the epilogue into diaries
    { id: `${P}fin_seq.${last}.5`, type: "season_complete", player: "$player", epilogue, ...(serverLine ? { server_line: serverLine } : {}) },
  ] });
  return { id: `${P}fin_seq`, type: "sequence", steps };
}

/**
 * Everything the bridge adds to the final stage. Returns the directives.
 *   bible, fin (the AI's finale texts), urn (urnWords), languages, allowItem (loot gate),
 *   pieceDirs: { story_id: the directive that placed it } for the lost-piece copies.
 */
export function finaleDirectives({ bible, fin, urn, languages, allowItem = () => true, pieceDirs = {}, prefix = "", storyNumber = 1, rand = Math.random, rewardRows = {},
  bonusCount = 0,
  modVersion = MOD_FEATURES_VERSION, tested = [] }) {
  const P = prefix;
  const urnId = `${P}fin_urn`;
  const nodes = piecesByNode(bible);
  const finalNode = bible.axis[bible.axis.length - 1];
  const center = [urn.x, urn.y];
  const out = [];
  // the urn: it appears only once the last chapter's piece is found, never before (Teko, in
  // game 2026-10-21); every reveal carries it (its own id, the same story id): the first one
  // raises it, the mod skips the rest (an urn of that story already stands)
  const spawnUrn = (sid) => ({ id: `${urnId}@${sid}`, type: "spawn_urn", story_id: urnId, target: { building: urn.id, room: (bible.finale?.rooms_wanted || []).find((r) => (urn.rooms || []).includes(r)) },
    sprite: URN_SPRITE, title: bible.finale?.urn?.title || { en: "Clay urn, sealed with wax" },
    // one piece per chapter (docs/13): each group is that chapter's one piece; an older bible
    // with two pieces per node asks for its first
    requires_groups: nodes.filter((n) => n.ids.length).map((n) => [n.ids[0]]), game_hour: bible.finale?.game_hour ?? null });
  // every piece weighs, the aura on the urn
  const charge = chargeDirective(`${P}fin_charge`, bible, nodes.map((n) => n.node), center);
  if (charge) out.push(charge);
  // the reveal: finding any last-node piece
  for (const sid of finalNode.pieces.map((p) => p.story_id)) {
    out.push({ id: `${P}fin_reveal_${sid}`, type: "reaction", keep: true, once: "player",
      when: { event: "item_picked", story_id: sid },
      then: [
        spawnUrn(sid),
        { id: `${P}fin_reveal_${sid}.1`, type: "diary_entry", player: "$player", deliver: "now", kind: "nightmare", node: finalNode.id, text: fin.where },
        // the chat only sends the finder to the diary (Teko, 2026-10-21); the place is in the nightmare
        { id: `${P}fin_reveal_${sid}.2`, type: "chat", scope: "player", player: "$player", text: "$reveal" },
      ] });
  }
  // the reward: the Tale always, then a catalog draw (reward.js)
  const title = {};
  const storyTitle = bible.title && typeof bible.title === "object" ? bible.title : { en: bible.title || "" };
  for (const lang of languages || ["en"]) {
    const t = storyTitle[lang] || storyTitle.en || "";
    // numbered like the game's book collections (docs/11): the five make the volume
    title[lang] = lang === "pt-br" ? `Conto Misterioso de Knox ${taleNumeral(storyNumber)} - ${t}` : `Mystery Tale of Knox ${taleNumeral(storyNumber)} - ${t}`;
  }
  // the Tale weighs like a piece, and more with every story (Teko, 2026-10-21): a drawn mood,
  // level 1 for the first Tale up to 3 for the fifth and after; carried together they add up
  const taleCharge = pieceCharge(`tale${storyNumber}`, Math.min(storyNumber, 5) - 1, 5, bible?.season || "");
  const reward = [{ item: taleItem(storyNumber), count: 1, title, text: fin.tale, charge: taleCharge }];
  // the rest is drawn from the server's own catalog, its focus the one the story asked for
  // (finale.reward_focus: weapons, food, medicine, survival), else drawn; worth the story
  const drawn = drawReward(rewardRows, { focus: fin.reward_focus || bible.finale?.reward_focus, rand });
  reward.push(...drawn.items);
  // what the extra pieces may add (src/collab.js): the story's extras and every node's spare
  // pieces, each a smaller draw of the same focus, ready in case they are in the urn
  const bonus = drawBonus(rewardRows, { focus: drawn.focus, n: Math.min(URN_BONUS_MAX, bonusCount), rand });
  // the act fires the script
  // the epilogue the finder's diary gets (the AI's finale.epilogue, every language); the bible's
  // ending is the AI's private note of the truth, never shown (Teko, 2026-10-21)
  const epilogue = fin.epilogue || fin.lines.silence;
  out.push({ id: `${P}fin_filled`, type: "reaction", keep: true, once: "server",
    when: { event: "urn_filled", story_id: urnId },
    then: [finaleSequence({ bible, fin, urnCenter: center, urnBuilding: urn.id, nodes, reward, bonus, focus: drawn.focus,
      epilogue: typeof epilogue === "object" && missingLanguages(epilogue, languages).length ? fin.lines.silence : epilogue,
      serverLine: null, prefix: P, seed: `${bible?.season || ""}|${storyNumber}|${urn.id}`, modVersion, tested })] });
  // lost pieces: the node's piece placed again, once, on the bridge's signal
  for (const n of nodes) {
    const sid = n.ids.find((id) => pieceDirs[id]);
    if (!sid) continue;
    const copy = { ...pieceDirs[sid], id: `${P}relost_${sid}`, relost: true };
    out.push({ id: `${P}fin_lost_${n.node}`, type: "reaction", keep: true, once: "server",
      when: { event: "signal", name: "piece_lost", node: n.node }, then: [copy] });
  }
  return out;
}
