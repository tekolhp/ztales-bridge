/**
 * The loot gate (docs/01 rules 15-19). The AI never places an item earlier than the server would
 * naturally yield it. Baseline: containers opened server-wide (the mod counts first opens).
 *
 *   horizon(item) = 1 / p_eff(item)       p_eff from catalog/loot.json (the mod reads the game's
 *                                          distribution tables, mods included)
 *   allowed when containers_opened >= horizon(item) * k
 *   k starts at 3 and falls toward 1 (never below) as the story earns it: a fixed curve of the
 *   AI's creativity_score, averaged. The AI is judged, it does not set k.
 *
 * Clue items (ZTales.*) are story props, not loot: always allowed.
 */

export const K_START = 3;
export const K_MIN = 1;

/** creativity (0..1, running average) -> k */
export function kFor(creativity) {
  const c = Math.min(1, Math.max(0, Number(creativity) || 0));
  return Math.max(K_MIN, K_START - 2 * c);
}

/** Running average of creativity scores, slow on purpose: one good window does not open the vault. */
export function nextCreativity(prev, score) {
  if (typeof score !== "number" || Number.isNaN(score)) return prev ?? 0;
  const s = Math.min(1, Math.max(0, score));
  return prev == null ? s * 0.5 : prev * 0.8 + s * 0.2;
}

/**
 * The server's own loot settings (sandbox *LootNew multipliers, from catalog index.loot_settings).
 * The game does not tell which category each item uses, so the gate takes the LOWEST multiplier:
 * a rare-loot server delays every reward, and the story is never more generous than the server.
 */
export function lootFactor(settings) {
  let f = 1;   // never above 1: generous settings do not make the story more generous
  for (const [k, v] of Object.entries(settings || {})) {
    if (/LootNew$/.test(k) && typeof v === "number" && v > 0) f = Math.min(f, v);
  }
  return f;
}

/** p_eff map scaled by the server's loot factor. */
export function scaleLoot(pEff, factor) {
  if (!pEff || factor === 1) return pEff || {};
  const out = {};
  for (const [k, v] of Object.entries(pEff)) out[k] = v * factor;
  return out;
}

export function horizon(pEff) {
  return pEff > 0 ? Math.round(1 / pEff) : Infinity;
}

/**
 * Returns allowItem(fullType) -> true | reason string, for gates.js.
 * pEff: { fullType: p }; opened: containers_opened; k from kFor().
 */
export function makeAllowItem(pEff, opened, k) {
  return (ft) => {
    if (typeof ft !== "string") return "item without a type";
    if (ft.startsWith("ZTales.")) return true;
    const p = pEff?.[ft];
    if (!(p > 0)) return `rejected: item ${ft}, never found as loot on this server`;
    const h = horizon(p);
    if (opened >= h * k) return true;
    return `rejected: item ${ft}, horizon ${h}, opened ${opened}, k ${k.toFixed(2)}`;
  };
}

/**
 * Rewards the AI may use right now: allowed items, rarest first (the most meaningful the server
 * has earned), at most `limit`, spread over item name prefixes so it is not forty kinds of soup.
 */
export function rewardCandidates(pEff, opened, k, limit = 40) {
  const allowed = Object.entries(pEff || {})
    .filter(([ft, p]) => p > 0 && !ft.startsWith("ZTales.") && opened >= horizon(p) * k)
    .sort((a, b) => a[1] - b[1]);
  const out = [];
  const seenStem = new Set();
  for (const [ft, p] of allowed) {
    const stem = ft.replace(/^[^.]+\./, "").replace(/[_\d].*$/, "");
    if (seenStem.has(stem)) continue;
    seenStem.add(stem);
    out.push({ item: ft, horizon: horizon(p) });
    if (out.length >= limit) break;
  }
  return out;
}
