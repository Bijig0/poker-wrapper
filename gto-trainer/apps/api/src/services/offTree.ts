/**
 * OFF-TREE VILLAIN LINES (2026-09-27, Brady: "mark when an action is off-tree by some threshold … later on we figure out
 * what the range actually looks like and nodelock"). A villain action the solver itself almost never takes: hand
 * 4920638634's HJ flop bet was 0.16% of the node, no hand above 0.41%, and worse than checking for every hand (median
 * 0.14bb). The chain still narrows his range by those frequencies — which there are convergence noise — so the next
 * streets are solved against an arbitrary slice of his range. DETECTION ONLY: nothing about the answer changes. The
 * lines are logged (services/offTreeLog) with villain's hand when Ignition's history shows it, the data a pool
 * range for node-locking these spots would be built from.
 *
 * Pure: the chain computes the numbers on the node it already read.
 */

/** the action's share of villain's range at the node, and the most any one hand takes it: both under = off-tree */
export const OFF_TREE_NODE_FREQ = 0.01;
export const OFF_TREE_MAX_HAND = 0.02;

export interface OffTreeStats {
  /** share of villain's range (by weight) that takes the action at this node */
  nodeFreq: number;
  /** the highest frequency any one hand in his range takes it with */
  maxHand: number;
  /** what the action costs him on average (bb): each hand's best action's EV minus the action's EV, range-weighted;
   *  null when the node carries no per-hand EVs */
  evGapBb: number | null;
}

export interface OffTreeLine extends OffTreeStats {
  street: "flop" | "turn" | "river";
  /** villain's seat (position) and whether he was in position on the street */
  seat: string;
  inPosition: boolean;
  /** the action as GTO Wizard names it (BET / RAISE / CALL / CHECK / FOLD / ALLIN), its code and size (bb) */
  action: string;
  code: string;
  betsize: number | null;
  /** the street's codes before this action, and the pot at the node */
  codes: string[];
  potNode: number;
}

type Sol = { strategy?: number[] | null; evs?: number[] | null };

/** The node's numbers for the action taken, from villain's range entering the node (before it is narrowed). */
export function offTreeStats(range: number[], sols: Sol[], taken: number): OffTreeStats {
  const f = sols[taken]?.strategy ?? [];
  let w = 0, wf = 0, maxHand = 0, gw = 0, gap = 0, evsOk = sols.every((s) => Array.isArray(s.evs) && s.evs.length > 0);
  for (let i = 0; i < range.length; i++) {
    const wi = range[i] ?? 0;
    if (!(wi > 0)) continue;
    const fi = f[i] ?? 0;
    w += wi; wf += wi * fi;
    if (fi > maxHand) maxHand = fi;
    if (evsOk) {
      let best = -Infinity;
      for (const s of sols) { const e = s.evs![i]; if (e != null && Number.isFinite(e) && e > best) best = e; }
      const mine = sols[taken]!.evs![i];
      if (Number.isFinite(best) && mine != null && Number.isFinite(mine)) { gap += wi * (best - mine); gw += wi; }
    }
  }
  return { nodeFreq: w > 0 ? wf / w : 0, maxHand, evGapBb: gw > 0 ? Math.round((gap / gw) * 1000) / 1000 : null };
}

export const isOffTree = (s: OffTreeStats): boolean => s.nodeFreq < OFF_TREE_NODE_FREQ && s.maxHand < OFF_TREE_MAX_HAND;

/** "0.16%" — enough digits for the small numbers this is about */
export const pctOf = (x: number): string => `${(x * 100).toFixed(x < 0.001 ? 3 : x < 0.1 ? 2 : 1)}%`;

/** One line a person reads: "HJ BET 2.6 off-tree — the solver takes it 0.16%, no hand above 0.41%, costs him 0.14bb". */
export const offTreeText = (l: OffTreeLine): string =>
  `${l.seat} ${l.action}${l.betsize != null ? ` ${l.betsize}` : ""} is off-tree — the solver takes it ${pctOf(l.nodeFreq)}, ` +
  `no hand above ${pctOf(l.maxHand)}${l.evGapBb != null ? `, costs him ${l.evGapBb.toFixed(2)}bb on average` : ""}`;

const RANKS = "23456789TJQKA";
/** The spot family a pool range would be keyed by: street, the action and who took it, the board's high card. */
export function offTreeFamily(l: Pick<OffTreeLine, "street" | "action" | "inPosition">, board: string): string {
  const cards = board.match(/[2-9TJQKA][cdhs]/gi) ?? [];
  const hi = cards.reduce((m, c) => Math.max(m, RANKS.indexOf(c[0]!.toUpperCase())), -1);
  return `${l.street} · ${l.action.toLowerCase()} ${l.inPosition ? "in position" : "out of position"} · ${hi >= 0 ? RANKS[hi] : "?"}-high board`;
}
