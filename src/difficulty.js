/**
 * The urn's difficulty (Teko, 2026-10-21): one table, every urn. The Final Tale is the top and
 * always the hardest; each story difficulty is a fraction of it, down to green. Everything an
 * urn event does with the dead comes from here: the waves' size, their pace, and the urn's
 * silent lure, which breathes in three thirds between two waves (ZTales_Track.lureTick).
 * The mod clamps whatever it is sent (ZTales_Directives D.waveCount, D.spawn_wave).
 */

// the Final Tale: the season's last fight
export const FINAL_TIER = {
  per_player: 25,            // zombies a player, a wave
  min: 20, max: 50,          // a wave, whatever the players
  wave_seconds: 50,          // between two waves
  lure_reach: [120, 60, 30], // the urn's silent call, first, second and last third of the interval
};

// a story's difficulty, as a fraction of the Final Tale
export const TIER_FRACTION = { final: 1, red: 0.8, yellow: 0.65, green: 0.5 };

/** The numbers of one difficulty ("final", "red", "yellow", "green"; anything else is yellow). */
export function tier(name) {
  const f = TIER_FRACTION[name] ?? TIER_FRACTION.yellow;
  const r = (x) => Math.max(1, Math.round(x * f));
  return {
    name: TIER_FRACTION[name] ? name : "yellow",
    per_player: r(FINAL_TIER.per_player),
    min: r(FINAL_TIER.min),
    max: r(FINAL_TIER.max),
    // easier is slower: the interval grows as the fraction falls
    wave_seconds: Math.round(FINAL_TIER.wave_seconds / f),
    lure_reach: FINAL_TIER.lure_reach.map((x) => r(x)),
  };
}

/** What a spawn_wave carries for that difficulty (the colour factor is folded in: factor 1). */
export function waveParams(name) {
  const t = tier(name);
  return { per_player: t.per_player, min: t.min, max: t.max, factor: 1, lure_period: t.wave_seconds, lure_reach: t.lure_reach };
}
