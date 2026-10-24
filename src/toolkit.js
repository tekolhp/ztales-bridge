/**
 * The urn's effects toolkit (docs/12, Teko 2026-10-21): what an urn event may make the players
 * hear and see, as a catalog. The AI composes a score from it inside the final stage's answer
 * (finale.score, no extra call); the bridge gates it (gateScore), fills what it left out from
 * seeded pools (arrangeScore) and turns each beat into a directive (beatsToDirectives). The
 * Final Tale has no AI: the pools alone. Waves, horde size, reward and texts are not here.
 */

// a cue every client plays on its own character (play_sound local), with a delay in seconds
const cue = (sound, tags, max, extra = {}) => ({ directive: "play_sound", sound, params: { delay: [0, 45] }, tags, loop: false, max, ...extra });

// the mod that understands climate_pulse, lights_flicker and a server-side delay
export const MOD_FEATURES_VERSION = "0.2.0";

export const TOOLKIT = {
  version: 1,
  effects: {
    scream: cue("MetaScream", ["human", "far", "dread"], 4),
    dog: cue("MetaDogBark", ["animal", "far"], 3),
    wolf: cue("MetaWolfHowl", ["animal", "far", "dread"], 3),
    owl: cue("MetaOwl", ["animal", "far", "quiet"], 2),
    gunshot_pistol: cue("MetaPistol1", ["mechanical", "far"], 3),
    gunshot_shotgun: cue("MetaShotgun1", ["mechanical", "far", "loud"], 2),
    gunfire_rifle: cue("MetaAssaultRifle1", ["mechanical", "far", "loud", "war"], 1),
    helicopter: cue("Helicopter", ["mechanical", "far", "loud"], 1),
    rumble: cue("RumbleThunder", ["weather", "far", "dread"], 3),
    thunder_crack: cue("Thunder", ["weather", "near", "loud"], 2),
    house_alarm_cue: cue("HouseAlarm", ["mechanical", "near", "loud"], 1),
    // the game loops it; only the client's 8-second cut ends it. Kept out of every pool: no siren
    // in the urn's opening (Teko, in game 2026-10-21); the AI may still name it once
    siren_wall: cue("VehicleSirenWall", ["mechanical", "far", "loud"], 1, { loop: true }),
    siren_yelp: cue("VehicleSirenYelp", ["mechanical", "far"], 2),
    car_alarm: cue("VehicleAlarmA", ["mechanical", "far", "loud"], 1),
    car_horn: cue("VehicleHornStandard", ["mechanical", "far"], 2),
    explosion: cue("BurnedObjectExploded", ["mechanical", "far", "loud"], 1),
    groan: cue("MaleZombieVoiceA", ["undead", "near", "dread"], 3),
    groan_f: cue("FemaleZombieVoiceA", ["undead", "near", "dread"], 3),
    lunge: cue("ZombieSurprisedPlayer", ["undead", "near", "loud"], 1),
    thump_wood: cue("ZombieThumpWood", ["undead", "near", "mechanical"], 3),
    thump_window: cue("ZombieThumpWindow", ["undead", "near"], 2),
    claw_wood: cue("ZombieClawWood", ["undead", "near", "quiet"], 3),
    whisper_psst: cue("VoiceFemaleWhisperPsst", ["human", "near", "quiet", "dread"], 2),
    whisper_hey: cue("VoiceMaleWhisperHey", ["human", "near", "quiet", "dread"], 2),
    death_alone: cue("VoiceFemaleDeathAlone", ["human", "near", "loud"], 1),
    death_eaten: cue("VoiceMaleDeathEaten", ["human", "near", "loud"], 1),
    rats: cue("AnimalVoiceRatStressed", ["animal", "near", "quiet"], 2),
    rats_wall: cue("AnimalRatScuttleWall", ["animal", "near", "quiet"], 2),
    door_break: cue("BreakDoor", ["mechanical", "near", "loud"], 2),
    glass: cue("SmashWindow", ["mechanical", "near"], 2),
    // the urn giving way: the bridge plays it itself at the end, never a beat
    ceramic: cue("BreakFurnitureCeramic", ["mechanical", "near"], 1, { bridgeOnly: true }),
    backfire: cue("GeneratorBackfire", ["mechanical", "near", "loud"], 1),
    radio_talk: cue("RadioTalk", ["mechanical", "near", "quiet"], 1),
    // world and visual
    static: { directive: "radio_static", params: { seconds: [2, 10], delay: [0, 45] }, tags: ["mechanical", "near"], max: 6 },
    lightning: { directive: "lightning", params: { count: [1, 3], delay: [0, 45] }, tags: ["weather", "loud", "visual"], max: 1, needs: "storm" },
    alarm: { directive: "set_alarm", params: { delay: [0, 45] }, tags: ["mechanical", "loud", "at_urn"], max: 1, needs: "building" },
    window: { directive: "smash_window", params: { count: [1, 3], delay: [0, 45] }, tags: ["mechanical", "at_urn", "visual"], max: 2, needs: "building" },
    fog_pulse: { directive: "climate_pulse", kind: "fog", params: { seconds: [10, 90], intensity: [0.3, 0.9], delay: [0, 45] },
      tags: ["weather", "visual", "quiet"], max: 2, mod: MOD_FEATURES_VERSION },
    darken: { directive: "climate_pulse", kind: "dark", params: { seconds: [5, 40], strength: [0.3, 0.8], delay: [0, 45] },
      tags: ["visual", "dread"], max: 2, mod: MOD_FEATURES_VERSION },
    lights_out: { directive: "lights_flicker", params: { times: [1, 4], delay: [0, 45] }, tags: ["visual", "mechanical", "at_urn"],
      max: 1, needs: "building", mod: MOD_FEATURES_VERSION },
  },
};

// fog_pulse and darken stay out until seen in game (NEXT_TEST, docs/07: server fog unconfirmed)
export const UNTESTED = new Set(["fog_pulse", "darken"]);
export const WEATHERS = new Set(["storm", "fog", "rain", "none"]);
// the loud ones: one in the whole score, never between waves or at the end
export const LOUD_SINGLETONS = new Set(["siren_wall", "helicopter", "explosion", "house_alarm_cue", "alarm"]);

export const PHASES = ["opening", "between_waves", "last_wave", "end"];
const PHASE_CAP = { opening: 8, between_waves: 8, last_wave: 6, end: 3 };

/** Every sound the catalog may play. */
export const TOOLKIT_SOUNDS = [...new Set(Object.values(TOOLKIT.effects).filter((e) => e.sound).map((e) => e.sound))];

/** What the AI reads (stage.toolkit on the final stage): one line per effect it may name. */
export const TOOLKIT_PROMPT = Object.entries(TOOLKIT.effects)
  .filter(([, e]) => !e.bridgeOnly)
  .map(([id, e]) => {
    const params = Object.entries(e.params).filter(([k]) => k !== "delay").map(([k, [a, b]]) => `${k} ${a}..${b}`).join(", ");
    return `${id}  ${e.tags.join(",")}${params ? `  ${params}` : ""}${e.needs ? `  (${e.needs === "building" ? "not on a cemetery" : "storm only"})` : ""}`;
  }).join("\n");

/** Seconds a phase's beats may sit at (`at`): the gap's window depends on the wave pace. */
export function phaseWindow(phase, waveSeconds) {
  if (phase === "opening") return 18;
  if (phase === "between_waves") return Math.max(10, waveSeconds - 10);
  if (phase === "last_wave") return 20;
  return 15;
}

function hashOf(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}

/** A small seeded RNG: the same seed always gives the same draws. */
export function mulberry32(seed) {
  let a = typeof seed === "number" ? seed >>> 0 : hashOf(seed);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const versionAtLeast = (v, min) => {
  const a = String(v || "0").split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
};
export const modHasFeatures = (modVersion) => versionAtLeast(modVersion, MOD_FEATURES_VERSION);

/** Whether an effect may be used on this urn, with this mod; the reason when not. */
function usableEffect(id, { placeKind, tested, modVersion, storm }) {
  const e = TOOLKIT.effects[id];
  if (!e || e.bridgeOnly) return "unknown effect";
  if (UNTESTED.has(id) && !(tested || []).includes(id)) return "not tested in game yet";
  if (e.mod && !versionAtLeast(modVersion, e.mod)) return `needs mod ${e.mod}`;
  if (e.needs === "building" && placeKind === "cemetery") return "no building on a cemetery";
  if (e.needs === "storm" && storm === false) return "no storm";
  return null;
}

// at most 3 beats within any 2 s: the crowded ones move 2 s later, or go past the window's edge
function spread(beats, window, notes, phase) {
  const out = [...beats].sort((a, b) => a.at - b.at);
  for (let guard = 0; guard < 50; guard++) {
    let moved = false;
    for (let i = 3; i < out.length; i++) {
      if (out[i].at - out[i - 3].at < 2) {
        out[i] = { ...out[i], at: out[i].at + 2 };
        moved = true;
        out.sort((a, b) => a.at - b.at);
        break;
      }
    }
    if (!moved) break;
  }
  const kept = out.filter((b) => b.at <= window);
  if (kept.length < out.length) notes.push(`score.${phase}: ${out.length - kept.length} beat(s) too crowded, dropped`);
  return kept;
}

/**
 * The AI's score, made safe (docs/12 3.1). Never refuses anything: it drops and clamps, and
 * every change is a note the stage log keeps. Returns { score, notes } (score null when unusable).
 */
export function gateScore(score, { waveSeconds = 60, placeKind = "building", tested = [], modVersion = MOD_FEATURES_VERSION, storm = null } = {}) {
  const notes = [];
  if (score === undefined || score === null) return { score: null, notes };
  if (typeof score !== "object" || Array.isArray(score)) return { score: null, notes: ["score dropped: not an object"] };
  const out = { mood: Array.isArray(score.mood) ? score.mood.filter((m) => typeof m === "string").slice(0, 3) : [] };
  const used = {};
  let loud = 0;
  for (const phase of PHASES) {
    let list = score[phase];
    if (list === undefined) list = [];
    if (!Array.isArray(list)) { notes.push(`score.${phase} dropped: not a list`); list = []; }
    const window = phaseWindow(phase, waveSeconds);
    const beats = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const id = raw.effect;
      const why = usableEffect(id, { placeKind, tested, modVersion, storm });
      if (why) { notes.push(`score.${phase}: ${id} dropped (${why})`); continue; }
      const e = TOOLKIT.effects[id];
      if (!Number.isFinite(raw.at)) { notes.push(`score.${phase}: ${id} dropped (no time)`); continue; }
      if (e.loop && !["opening", "last_wave"].includes(phase)) { notes.push(`score.${phase}: ${id} dropped (loops)`); continue; }
      if (LOUD_SINGLETONS.has(id)) {
        if (phase === "between_waves" || phase === "end") { notes.push(`score.${phase}: ${id} dropped (too loud here)`); continue; }
        if (loud >= 1) { notes.push(`score.${phase}: ${id} dropped (one loud cue already)`); continue; }
      }
      if ((used[id] || 0) >= e.max) { notes.push(`score.${phase}: ${id} dropped (more than ${e.max})`); continue; }
      if (beats.length >= PHASE_CAP[phase]) { notes.push(`score.${phase}: ${id} dropped (phase full)`); continue; }
      const beat = { effect: id, at: Math.max(0, Math.min(window, Math.round(raw.at))) };
      for (const [k, [lo, hi]] of Object.entries(e.params)) {
        if (k === "delay" || raw[k] === undefined) continue;
        const v = Number(raw[k]);
        if (Number.isFinite(v)) beat[k] = Math.max(lo, Math.min(hi, v));
      }
      used[id] = (used[id] || 0) + 1;
      if (LOUD_SINGLETONS.has(id)) loud++;
      beats.push(beat);
    }
    out[phase] = spread(beats, window, notes, phase);
  }
  if (score.weather !== undefined) {
    if (WEATHERS.has(score.weather)) out.weather = score.weather;
    else notes.push(`score.weather dropped: ${score.weather}`);
  }
  return { score: out, notes };
}

// the pools the arranger draws from (docs/12 3.2); no siren anywhere (Teko, 2026-10-21)
const POOLS = {
  animal: ["dog", "wolf", "owl", "rats"],
  human: ["scream", "whisper_psst", "whisper_hey", "death_alone", "death_eaten"],
  openingLoud: ["car_alarm", "explosion", "helicopter"],
  openingVisual: ["darken", "fog_pulse"],
  near: ["groan", "groan_f", "claw_wood", "thump_wood", "whisper_psst", "whisper_hey", "rats_wall"],
  far: ["dog", "wolf", "owl", "gunshot_pistol", "car_horn"],
  lastLoud: ["gunfire_rifle", "gunshot_shotgun", "thunder_crack", "door_break", "lunge"],
  quiet: ["owl", "rats", "whisper_psst"],
};

/**
 * The full score of one urn (docs/12 3.2): the AI's beats (already gated) and, around them,
 * draws from the pools until every phase has its minimum. Seeded: the same urn always sounds
 * the same; two urns never do. gaps = how many quiet stretches there are between waves.
 * Returns { opening, gaps: [[beats]...], last_wave, end, weather }.
 */
export function arrangeScore(score, { seed, waveSeconds = 60, gaps = 4, placeKind = "building", tested = [], modVersion = MOD_FEATURES_VERSION, storm = true } = {}) {
  const rand = mulberry32(String(seed));
  const s = score || {};
  const ctx = { placeKind, tested, modVersion, storm };
  const used = {};
  let loud = 0;
  const count = (b) => { used[b.effect] = (used[b.effect] || 0) + 1; if (LOUD_SINGLETONS.has(b.effect)) loud++; };
  for (const p of PHASES) (s[p] || []).forEach(count);
  // the AI's chosen tags pull the fill toward the story's key
  const chosenTags = new Set(PHASES.flatMap((p) => (s[p] || []).flatMap((b) => TOOLKIT.effects[b.effect]?.tags || [])));
  const can = (id) => !usableEffect(id, ctx) && (used[id] || 0) < TOOLKIT.effects[id].max && !(LOUD_SINGLETONS.has(id) && loud >= 1);
  const draw = (pool) => {
    const options = pool.filter(can);
    if (!options.length) return null;
    const w = options.map((id) => (TOOLKIT.effects[id].tags.some((t) => chosenTags.has(t)) ? 2 : 1));
    let r = rand() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < options.length; i++) { r -= w[i]; if (r <= 0) return options[i]; }
    return options[options.length - 1];
  };
  const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const add = (list, id, window, extra = {}) => {
    if (!id) return;
    const b = { effect: id, at: between(0, window), ...extra };
    count(b);
    list.push(b);
  };
  const paramsFor = (id) => {
    if (id === "fog_pulse") return { seconds: between(30, 60), intensity: 0.6 };
    if (id === "darken") return { seconds: between(15, 30), strength: 0.6 };
    if (id === "static") return { seconds: 3 };
    if (id === "window") return { count: 2 };
    return {};
  };
  const W = (p) => phaseWindow(p, waveSeconds);

  // the opening: the world answers at once
  const opening = [...(s.opening || [])];
  if (!opening.some((b) => b.effect === "rumble") && can("rumble")) { count({ effect: "rumble" }); opening.unshift({ effect: "rumble", at: 0 }); }
  const want = between(6, 8);
  for (let i = between(1, 2); i > 0 && opening.length < want; i--) add(opening, draw(POOLS.animal), W("opening"));
  for (let i = between(1, 3); i > 0 && opening.length < want; i--) add(opening, draw(POOLS.human), W("opening"));
  if (rand() < 0.7 && opening.length < 8) add(opening, draw(POOLS.openingLoud), W("opening"));
  if (rand() < 0.5 && opening.length < 8) { const v = draw(POOLS.openingVisual); add(opening, v, W("opening"), paramsFor(v)); }
  while (opening.length < 6) { const id = draw([...POOLS.human, ...POOLS.animal]); if (!id) break; add(opening, id, W("opening")); }

  // the gaps: the AI's bank dealt in rotation, then the dark comes closer
  const gapLists = Array.from({ length: Math.max(0, gaps) }, () => []);
  (s.between_waves || []).forEach((b, i) => { if (gapLists.length) gapLists[i % gapLists.length].push(b); });
  let fogLast = false;
  gapLists.forEach((g) => {
    const target = between(2, 4);
    if (!g.some((b) => (TOOLKIT.effects[b.effect]?.tags || []).includes("near")) && g.length < 4) add(g, draw(POOLS.near), W("between_waves"));
    if (g.length < target && rand() < 0.6) add(g, draw(POOLS.far), W("between_waves"));
    const hasFog = g.some((b) => b.effect === "fog_pulse");
    if (!hasFog && !fogLast && g.length < 4 && rand() < 0.4 && can("fog_pulse")) add(g, "fog_pulse", W("between_waves"), paramsFor("fog_pulse"));
    fogLast = g.some((b) => b.effect === "fog_pulse");
    while (g.length < 2) { const id = draw([...POOLS.near, ...POOLS.far]); if (!id) break; add(g, id, W("between_waves")); }
  });

  // the last wave: the loudest moment of the night
  const lastWave = [...(s.last_wave || [])];
  for (let i = between(1, 2); i > 0 && lastWave.length < 6; i--) add(lastWave, draw(POOLS.lastLoud), W("last_wave"));
  if (lastWave.length < 6 && can("scream")) add(lastWave, "scream", W("last_wave"));
  if (lastWave.length < 6 && rand() < 0.6 && can("window")) add(lastWave, "window", W("last_wave"), paramsFor("window"));
  if (lastWave.length < 6 && rand() < 0.5 && can("alarm")) add(lastWave, "alarm", 0);
  if (lastWave.length < 6 && rand() < 0.4 && can("lights_out")) add(lastWave, "lights_out", W("last_wave"), { times: between(2, 4) });
  while (lastWave.length < 4) { const id = draw([...POOLS.lastLoud, ...POOLS.human]); if (!id) break; add(lastWave, id, W("last_wave")); }

  // the end: small
  const end = [...(s.end || [])];
  if (end.length < 3 && rand() < 0.5) add(end, draw(POOLS.quiet), W("end"));

  const sort = (l) => l.sort((a, b) => a.at - b.at);
  return { opening: sort(opening), gaps: gapLists.map(sort), last_wave: sort(lastWave), end: sort(end), weather: s.weather };
}

/**
 * One beat, one directive, played `delay` seconds into the step that carries it. With a mod
 * older than MOD_FEATURES_VERSION the world beats (lightning, window, alarm) land at the step
 * itself (no server-side delay) and the effects it cannot do were never drawn.
 */
export function beatsToDirectives(beats, { idOf, urn = null, building = null, slot = null, modVersion = MOD_FEATURES_VERSION, offset = 0 }) {
  const serverDelay = modHasFeatures(modVersion);
  const out = [];
  (beats || []).forEach((b, i) => {
    const e = TOOLKIT.effects[b.effect];
    if (!e) return;
    const delay = Math.max(0, Math.min(45, Math.round(b.at - offset)));
    const d = { id: idOf(i), type: e.directive };
    const later = (o) => (delay > 0 ? { ...o, delay } : o);
    if (e.directive === "play_sound") Object.assign(d, later({ sound: e.sound, scope: "server", local: true }));
    else if (e.directive === "radio_static") Object.assign(d, later({ scope: "server", seconds: b.seconds || 3 }));
    else if (e.directive === "climate_pulse") Object.assign(d, later({ scope: "server", kind: e.kind, seconds: b.seconds || 30, intensity: b.intensity ?? b.strength ?? 0.6 }));
    else if (e.directive === "lightning") {
      if (!urn) return;
      Object.assign(d, { target: { x: urn[0], y: urn[1] }, at_urn: true, count: b.count || 1, ...(slot ? { slot } : {}) }, serverDelay && delay ? { delay } : {});
    } else {
      if (!building) return;
      Object.assign(d, { target: { building } }, serverDelay && delay ? { delay } : {});
      if (e.directive === "set_alarm") d.ring_now = true;
      if (e.directive === "smash_window") d.count = b.count || 1;
      if (e.directive === "lights_flicker") d.times = b.times || 2;
    }
    out.push(d);
  });
  return out;
}

/**
 * A gap's beats split over its two steps: the wave's (from its start) and the halfway one
 * (from WAVE/2). Returns [atWaveStep, atMidStep], each with the offset its delays count from.
 */
export function splitGap(beats, waveSeconds) {
  const half = waveSeconds / 2;
  const first = [];
  const second = [];
  for (const b of beats || []) {
    if (b.at < Math.min(45, half)) first.push(b);
    else second.push({ ...b, at: Math.max(half, b.at) });
  }
  return [first, second];
}
