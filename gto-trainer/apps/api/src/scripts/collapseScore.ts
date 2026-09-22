/**
 * Shared scoring for the multiway-approximation harnesses (2026-09-20).
 *
 * Every one of them asks the same question: hero plays strategy X at a node whose TRUE solution we have —
 * what does X cost him inside that true tree? So the truth's per-combo EVs are the yardstick, hero's range at
 * the node is the weight, and an approximation is only ever re-expressed onto the truth's own action list.
 *
 * Used by scripts/collapseCalibration.ts (collapsing a three-way tree to two seats) and
 * scripts/borrowCalibration.ts (feeding a solve the BORROWED arrival range instead of the real one).
 */
import type { solveAiChain, ChainTrace } from "../services/aiChain";
import { COMBOS, cardIndex } from "../utils/comboIndex/comboIndex";
import { blendStrategies as blendImpl } from "../services/multiwayCollapse";

export interface Solved {
  codes: string[];
  /** per action: the 1326-combo strategy */
  strat: number[][];
  /** per action: the 1326-combo EV */
  evs: number[][];
  /** hero's combo weights at this node */
  w: number[];
  potNode: number;
}

export interface Score {
  loss: number;
  lossPct: number;
  tv: number;
  agree: number;
  mass: number;
  freq: number[];
}

/** Hero's combo weights AT his node: his street-entering range times the equilibrium frequency of every
 *  action he already took this street — exactly the conditioning the walk itself applied. */
export function heroWeights(trace: ChainTrace, board: string): number[] {
  const st = trace.streets[0]!;
  const players = st.players ?? [];
  const s = trace.spec;
  const heroPos = s.heroSeat === "oop" ? s.oopPos : s.heroSeat === "ip" ? s.ipPos : s.midPos!;
  const hi = Math.max(0, players.findIndex((p) => p.toUpperCase() === heroPos.toUpperCase()));
  const w = (st.rangesIn?.[hi] ?? st.oopIn).slice();
  for (const n of trace.nodes) {
    if (n.si !== 0 || n.actor !== hi || n.taken == null) continue;
    const strat = n.actions[n.taken]!.strategy;
    for (let i = 0; i < w.length; i++) w[i] = (w[i] ?? 0) * (strat[i] ?? 0);
  }
  const blocked = new Set((board.match(/.{2}/g) ?? []).map(cardIndex));
  for (let i = 0; i < w.length; i++) {
    const [a, b] = COMBOS[i]!.cards;
    if (blocked.has(cardIndex(a)) || blocked.has(cardIndex(b))) w[i] = 0;
  }
  return w;
}

export function readSolved(r: Awaited<ReturnType<typeof solveAiChain>>, board: string): Solved | null {
  if (!r.ok) return null;
  const sols: any[] = r.data?.action_solutions ?? [];
  if (!sols.length) return null;
  return {
    codes: sols.map((a) => String(a.action?.code ?? a.action?.display_name ?? "?")),
    strat: sols.map((a) => a.strategy ?? []),
    evs: sols.map((a) => a.evs ?? []),
    w: heroWeights(r.trace!, board),
    potNode: r.potNode ?? 0,
  };
}

/** Range-weighted loss of playing `p` (action × combo) inside the TRUE tree, plus agreement stats and the
 *  aggregate frequency of each action — which says WHICH WAY an approximation errs, not just by how much. */
export function score(truth: Solved, p: number[][], potNode: number): Score {
  let mass = 0, loss = 0, tv = 0, agree = 0;
  const freq = truth.codes.map(() => 0);
  for (let i = 0; i < 1326; i++) {
    const w = truth.w[i] ?? 0;
    if (w <= 1e-9) continue;
    let evT = 0, evA = 0, d = 0, bT = -1, bA = -1, mT = -1, mA = -1;
    for (let a = 0; a < truth.codes.length; a++) {
      const pt = truth.strat[a]![i] ?? 0, pa = p[a]![i] ?? 0, ev = truth.evs[a]![i] ?? 0;
      evT += pt * ev; evA += pa * ev; d += Math.abs(pt - pa);
      freq[a] = freq[a]! + w * pa;
      if (pt > mT) { mT = pt; bT = a; }
      if (pa > mA) { mA = pa; bA = a; }
    }
    mass += w; loss += w * (evT - evA); tv += w * d * 0.5; agree += w * (bT === bA ? 1 : 0);
  }
  if (mass <= 0) return { loss: 0, lossPct: 0, tv: 0, agree: 0, mass: 0, freq };
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    loss: r4(loss / mass), lossPct: r4((100 * loss) / mass / Math.max(0.01, potNode)),
    tv: r4(tv / mass), agree: r4(agree / mass), mass: Math.round(mass * 100) / 100,
    freq: freq.map((f) => r4(f / mass)),
  };
}

/** Re-express an approximation's strategy on the TRUE tree's action list. Codes are identical by construction
 *  (both trees carry the same fixed size grid), so a mismatch is a real failure, not a naming difference. */
export function align(truth: Solved, apx: Solved): number[][] | null {
  const out: number[][] = truth.codes.map(() => new Array(1326).fill(0));
  for (let a = 0; a < apx.codes.length; a++) {
    const t = truth.codes.indexOf(apx.codes[a]!);
    if (t < 0) return null;
    for (let i = 0; i < 1326; i++) out[t]![i] = (out[t]![i] ?? 0) + (apx.strat[a]![i] ?? 0);
  }
  return out;
}

/** BLEND and ALIGN are the SHIPPED rules (services/multiwayCollapse.ts), re-exported so the harness scores
 *  exactly what production plays. If the policy changes there, these numbers move with it — which is the
 *  point: the calibration is only evidence about the code if it runs the same code. */
export { blendStrategies } from "../services/multiwayCollapse";

/** The rule as the harness calls it, over the truth's action list. */
export function blend(truth: Solved, gs: number[][][]): number[][] {
  return blendImpl(truth.codes, gs);
}

/** The obvious alternative to BLEND: just average the collapses. No monotonicity assumption, so it keeps more
 *  aggression — which of the two is right is what the calibration run settled (0.0079 vs 0.0281 bb). */
export function blendMean(truth: Solved, gs: number[][][]): number[][] {
  return truth.codes.map((_, a) => {
    const row = new Array(1326).fill(0);
    for (let i = 0; i < 1326; i++) {
      let v = 0;
      for (const g of gs) v += g[a]![i] ?? 0;
      row[i] = v / gs.length;
    }
    return row;
  });
}

/** No-information baseline: every legal action at equal frequency. Sets the scale for everything else. */
export function uniform(truth: Solved): number[][] {
  const n = truth.codes.length;
  return truth.codes.map(() => new Array(1326).fill(1 / n));
}
