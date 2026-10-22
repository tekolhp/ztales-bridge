/**
 * When a chapter stalls (docs/01 rules 1n-1o, docs/04 "When a chapter stalls").
 *
 * The clock is real days on which someone played, not game days: an empty server at night must
 * not trigger help, and a three-month server lives years of game time. The sandbox option
 * HintPace picks how many played days pass before the first help step and between the next ones.
 * Steps go 1 to 4, then repeat (each round a new cycle, answered again: help never just stops).
 * A node resolving starts the count again.
 *
 * The bridge only raises `signal { name: "stall", step }`; the story's answer to it was written
 * ahead as a reaction (docs/03). No AI call is needed to help a stalled chapter.
 */

export const PACES = {
  auto: { first: 10, every: 4 },
  patient: { first: 21, every: 7 },
  more_help: { first: 5, every: 2 },
};

/** Calendar day of an epoch, shifted to the server's time zone. */
export function dayKey(epochSec, offsetHours = 0) {
  return new Date((epochSec + offsetHours * 3600) * 1000).toISOString().slice(0, 10);
}

export function fresh(node = "") {
  return { node, days: [], sent: 0 };
}

/** A tick saw `online` players at `epochSec`: that day counts as played. Returns the new pacing. */
export function notePlayed(p, epochSec, online, offsetHours = 0) {
  if (!(online > 0)) return p;
  const k = dayKey(epochSec, offsetHours);
  if (p.days.includes(k)) return p;
  return { ...p, days: [...p.days, k] };
}

/** The node moved on (node_changed): the count starts over for the new chapter. */
export function onNode(p, node) {
  return p.node === node ? p : fresh(node);
}

/** How many help steps are due in total so far. */
export function stepsDue(p, pace = "auto") {
  const { first, every } = PACES[pace] || PACES.auto;
  const n = p.days.length;
  if (n < first) return 0;
  return Math.floor((n - first) / every) + 1;
}

/** The step number (1..4, repeating) of the k-th help. */
export const stepOf = (k) => ((k - 1) % 4) + 1;
/** The cycle of the k-th help: 1 for the first four, 2 for the next four... */
export const cycleOf = (k) => Math.floor((k - 1) / 4) + 1;

/**
 * Signals still to send, as directives. Ids carry the node and the count, so a step is never
 * sent twice even if the bridge restarts. Returns { signals, pacing }.
 */
export function pendingSignals(p, pace = "auto") {
  if (!p.node) return { signals: [], pacing: p };
  const due = stepsDue(p, pace);
  const signals = [];
  for (let k = p.sent + 1; k <= due; k++) {
    // the cycle (1 for steps 1-4, 2 once they repeat...): the mod answers a step once per cycle,
    // for the server and for each player online (gates.splitStall, docs/13 item 6)
    signals.push({ id: `stall_${p.node}_${k}`, type: "signal", name: "stall", step: stepOf(k), cycle: cycleOf(k), each_player: true });
  }
  return { signals, pacing: { ...p, sent: Math.max(p.sent, due) } };
}
