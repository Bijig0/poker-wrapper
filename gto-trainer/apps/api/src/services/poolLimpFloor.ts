/**
 * THE POOL LIMP FLOOR (2026-10-05, Brady). A short stack's limp is not in any equilibrium tree: the 30bb even limp chart
 * gives a 39bb HJ's limp 2.98 combos at the flop, GTO Wizard AI preflop 0.6 (hand 4922555015), and the chain then
 * narrows that by every later action until the range is empty — the river of that hand had no node to read. Over 253
 * hands since 2026-09-19 a short limper reached the postflop solve with under half a combo 33 times. The pool limps
 * far wider when short: 26.3% of hands first in at ≤60bb (n=278), 15.1% at 60-85bb, against 3.1% deep
 * (analysis/pipeline/limp_study/locks_v2, NL200 ring 5+6-handed).
 *
 * THE RULE (Brady: "apply it to all the short stacks that don't cover the stack size threshold we have, and aren't
 * solved yet"): a villain who limped (or, from the SB, completed) before any raise and never raised after keeps the
 * range the pool-locked tree that answered gives him when that tree locks his node AND its stacks are inside the gap
 * gate's first-decision bound (treeGap.withinFirstStackBound, on the effective stack against hero). Otherwise — an
 * equilibrium limp chart, the GTO Wizard AI tree, a reduced tree, a pool tree at a stack outside the bound — his
 * flop-entering range is the pool's measured limp range for his role and stack bucket, the very range the limp-v2 pool3
 * trees lock (poolLimpLocks.v2.json is a copy of locks_v2.json; the key is chosen as genLimpPlanV2.lock_for chooses it).
 * Kept whole whatever he did after the limp (a call of an iso, a check): the caller-read study (2026-10-04) found the
 * pool limp range kept whole the best candidate for a limp-call. Short limpers only — a deep one keeps the tree's range.
 *
 * When the uneven pool3 tree for the spot lands, the picker names it (hrc6max shortLimperAlone / unevenLimp) and the
 * floor stands down by itself: the tree covers him.
 *
 * Pure: ranges in, ranges out, and a record of what was replaced.
 */
import LOCKS from "./poolLimpLocks.v2.json";
import { dealtByPos, POOL_LIMP_CHART, POOL_LIMP_CHART_SB, SEATS6, type Seat6 } from "./hrc6max";
import { hrc6maxDb } from "./hrc6maxDb";
import { chartStacks6, withinFirstStackBound } from "./treeGap";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

export type PoolLimpKey = keyof typeof LOCKS.ranges;

/** THE OFF SWITCH (an experiment, 2026-10-05): SHORT_LIMP_POOL=off in the environment turns off both halves — this floor
 *  and the picker's short-limper routing (hrc6max shortLimperAlone). Read at every decision; on when unset.
 *  Diagnostic: bun src/scripts/shortLimpPoolReport.ts [--since 2026-10-05]. */
export const shortLimpPoolOn = (): boolean => String(process.env.SHORT_LIMP_POOL ?? "on").toLowerCase() !== "off";
type ClassRange = Record<string, number>;

/** A seat that limped (or completed from the SB) before any raise. */
export interface PoolLimper {
  pos: Seat6;
  /** limps by the non-blind seats before his (hero's included): 0 = first in */
  limpsBefore: number;
  /** the SB's complete */
  complete: boolean;
  /** he raised later in the hand (a limp-raise): his range is not a limp range */
  raisedLater: boolean;
}

export interface PoolLimpFloorRecord {
  pos: Seat6;
  key: PoolLimpKey;
  /** his stack as dealt (bb) */
  stack: number;
  freq: number;
  n: number;
  /** combos before (the tree's range) and after (the pool's) */
  was: number;
  now: number;
}

const POSTS = new Set(["post-sb", "post-bb", "post", "post-dead", "ante"]);
const AGGRESSIVE = new Set(["raise", "bet", "all-in"]);

/** Every non-hero seat that limped or completed before the first preflop raise, in the order they acted. */
export function poolLimpersOf(hand: ParsedHand, heroPos: string | null): PoolLimper[] {
  const posOf = (seatId: number): Seat6 | null => {
    const p = String(seatId === hand.heroSeatId && heroPos ? heroPos : hand.positions?.[seatId] ?? "").toUpperCase() as Seat6;
    return SEATS6.includes(p) ? p : null;
  };
  const hero = posOf(hand.heroSeatId);
  const out: PoolLimper[] = [];
  const acted = new Set<Seat6>();
  let raised = false, limps = 0;
  for (const a of hand.actions ?? []) {
    if (a.street !== "preflop" || POSTS.has(String(a.type))) continue;
    const pos = posOf(a.seatId);
    if (!pos) continue;
    if (AGGRESSIVE.has(String(a.type))) {
      raised = true;
      const l = out.find((x) => x.pos === pos);
      if (l) l.raisedLater = true;
    } else if (a.type === "call" && !raised && !acted.has(pos) && pos !== "BB") {
      if (pos !== hero) out.push({ pos, limpsBefore: limps, complete: pos === "SB", raisedLater: false });
      if (pos !== "SB") limps++;
    }
    acted.add(pos);
  }
  return out;
}

/** The pool range for a limper at this stack, as genLimpPlanV2.lock_for picks it — null for a deep one (over 85bb). */
export function poolLimpKey(l: Pick<PoolLimper, "limpsBefore" | "complete">, stack: number): PoolLimpKey | null {
  if (!(stack > 0) || stack > 85) return null;
  const b = stack <= 60 ? "le60" : "60_85";
  if (l.complete) {
    if (l.limpsBefore >= 3) return "sbcomplete_b3";
    return (l.limpsBefore === 0 ? `sbcomplete_fold_short_${b}` : `sbcomplete_b${l.limpsBefore}_short_${b}`) as PoolLimpKey;
  }
  return (l.limpsBefore === 0 ? `limp_first_short_${b}` : `overlimp_short_${b}`) as PoolLimpKey;
}

/** The plan a baked chart was solved from (the bake's provenance row): `limp-v2-…` = the v2 locks, by stack bucket. */
const bakedPlanOf = (id: string): string | null => hrc6maxDb.provenance(id)?.plan ?? null;

/** Does the chart that gave the flop ranges hold this limper's node at the pool's range, at stacks inside the bound?
 *  The pool3 trees (even and uneven) lock every limp and the SB's complete; the pilot (`_olimp_pool`) locks the limps
 *  only. ONLY A V2 TREE (its bake provenance names a `limp-v2-…` plan): the v1 uneven pool3 trees still baked under the
 *  same ids (s30_SB, s30_BTN, s70_BB — plan `limp-uneven-pool3…`) locked every limper to the DEEP pool range, so a short
 *  limper there is not at his own; their v2 re-solves replace them in place, and the floor stands down by itself. The
 *  wide tree's locks are the v1 deep ones at full weight, so it never covers. */
export function poolChartCovers(chartId: string | null, l: Pick<PoolLimper, "pos" | "complete">, heroPos: Seat6,
                                table: { hero: number; limper: number }, planOf: (id: string) => string | null = bakedPlanOf): boolean {
  if (!chartId) return false;
  const locksHim = chartId === POOL_LIMP_CHART || /_olimp_pool3$/.test(chartId) || (chartId === POOL_LIMP_CHART_SB && !l.complete);
  if (!locksHim || !/^limp-v2/.test(planOf(chartId) ?? "")) return false;
  const st = chartStacks6(chartId);
  if (!st) return false;
  return withinFirstStackBound(Math.min(table.hero, table.limper), Math.min(st[heroPos], st[l.pos]));
}

const classCombos = (c: string): number => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
const combosOf = (r: ClassRange | undefined): number =>
  Math.round(Object.entries(r ?? {}).reduce((s, [c, w]) => s + (Number(w) > 0 ? Number(w) * classCombos(c) : 0), 0) * 100) / 100;

/**
 * Apply the floor to a hand's flop-entering ranges (position → class → weight, as every arrival piece produces them).
 * Returns the ranges (a new object when anything changed) and one record per limper replaced.
 */
export function applyPoolLimpFloor(a: {
  hand: ParsedHand; heroPos: string | null; ranges: Record<string, ClassRange>;
  /** the chart (or AI tree id) the ranges came from */
  chartId: string | null;
  dealt?: Record<number, number>;
  /** the plan a baked chart was solved from (tests); the bake's provenance by default */
  planOf?: (id: string) => string | null;
}): { ranges: Record<string, ClassRange>; applied: PoolLimpFloorRecord[] } {
  const hero = String(a.heroPos ?? "").toUpperCase() as Seat6;
  const byPos = dealtByPos(a.hand, a.heroPos, a.dealt);
  // the pool was measured 5-6 handed; a 3-4 handed table is still far closer to it than to an empty range — heads-up
  // (the SB's complete is the button's open there) is a different game and keeps its tree
  if (!SEATS6.includes(hero) || Object.keys(byPos).length < 3) return { ranges: a.ranges, applied: [] };
  const heroStack = Number(byPos[hero] ?? NaN);
  const applied: PoolLimpFloorRecord[] = [];
  let out = a.ranges;
  for (const l of poolLimpersOf(a.hand, a.heroPos)) {
    if (l.raisedLater) continue;
    const stack = Number(byPos[l.pos] ?? NaN);
    const key = poolLimpKey(l, stack);
    if (!key) continue;
    const rk = Object.keys(out).find((p) => p.toUpperCase() === l.pos);
    if (!rk) continue;                                                           // not at the flop
    if (Number.isFinite(heroStack) && poolChartCovers(a.chartId, l, hero, { hero: heroStack, limper: stack }, a.planOf)) continue;
    const lock = LOCKS.ranges[key];
    const was = combosOf(out[rk]);
    if (out === a.ranges) out = { ...a.ranges };
    out[rk] = { ...(lock.weights as ClassRange) };
    applied.push({ pos: l.pos, key, stack: Math.round(stack * 10) / 10, freq: lock.freq, n: lock.n, was, now: combosOf(out[rk]) });
  }
  return { ranges: out, applied };
}

/** The answer's note for the replaced limpers. */
export const poolLimpFloorNote = (applied: PoolLimpFloorRecord[], chartId: string | null): string =>
  `POOL LIMP RANGE: ${applied.map((r) => `the ${r.pos} (${Math.round(r.stack)}bb) limped — ${r.was} combos on ${chartId ?? "the preflop tree"}, `
    + `now the pool's ${r.key} (${(100 * r.freq).toFixed(1)}% of hands, n=${r.n}, ${r.now} combos)`).join("; ")}`
  + " — no pool-locked tree covers this stack yet";
