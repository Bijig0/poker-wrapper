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
 * range the pool-locked tree that answered gives him when that tree locks his node AT HIS STACK'S BUCKET (60bb or less /
 * 60-85bb) AND its stacks are inside the gap gate's first-decision bound (treeGap.withinFirstStackBound, on the
 * effective stack against hero) — see poolChartCovers. Otherwise — an
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
import LOCKS_V2 from "./poolLimpLocks.v2.json";
import LOCKS_V3 from "./poolLimpLocks.v3.json";
import { dealtByPos, limpStackBucket, POOL_LIMP_CHART, POOL_LIMP_CHART_SB, SEATS6, type Seat6 } from "./hrc6max";
import { hrc6maxDb } from "./hrc6maxDb";
import { chartStacks6, withinFirstStackBound } from "./treeGap";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/** v3 holds every v2 key (8 copied unchanged, the 8 thin ones re-measured under the same names) plus the finer bands */
export type PoolLimpKey = keyof typeof LOCKS_V3.ranges | keyof typeof LOCKS_V2.ranges;

/** THE TABLE SWITCH (2026-10-09, Brady: the thin Ignition cells replaced by CoinPoker-backed ranges, finer stack bands
 *  with real samples, Ignition-corrected where Ignition has the limps — TEMPORARY until auto-execute collects 30+
 *  Ignition limps per cell). LIMP_LOCKS in the environment, read at every decision:
 *   v3 (unset)  poolLimpLocks.v3.json (poker locks_v2/limp_locks_v3.json, build_limp_locks_v3.py): the 8 cells with 30+
 *               Ignition limps as v2; the 8 thin ones (n < 30: short over-limps, short SB completes behind limps,
 *               sbcomplete_b2_deep, sbcomplete_b3) from the CoinPoker 9.1M-hand corpus, the frequency anchored on the
 *               nearest Ignition cell with 30+ limps, the shape CoinPoker's showdown limps corrected against Ignition's
 *               visible cards; and finer stack bands (<=25 / 25-40 / 40-60bb) for the over-limp and the SB's complete
 *               behind limps — poolLimpKey takes the finest band the table has for the stack, else the coarse one;
 *   v2          poolLimpLocks.v2.json (locks_v2.json, NL200 Ignition only) and the two coarse bands — the picks before
 *               2026-10-09, byte for byte.
 *  It changes WHICH range a pool limp key names, never whether the floor / lock fires (SHORT_LIMP_POOL decides that).
 *  The HRC pool-locked limp trees stay solved on locks_v2 (their coverage rule, poolChartCovers, is unchanged). */
export type LimpLocksVersion = "v2" | "v3";
export const limpLocksVersion = (): LimpLocksVersion =>
  String(process.env.LIMP_LOCKS ?? "v3").trim().toLowerCase() === "v2" ? "v2" : "v3";
type LimpRange = { freq: number; n: number; weights: Record<string, number> };
const TABLES: Record<LimpLocksVersion, Record<string, LimpRange>> = {
  v2: LOCKS_V2.ranges as unknown as Record<string, LimpRange>,
  v3: LOCKS_V3.ranges as unknown as Record<string, LimpRange>,
};
/** the keys a table holds (tests, reports) */
export const limpLockKeys = (version: LimpLocksVersion = limpLocksVersion()): string[] => Object.keys(TABLES[version]);
/** A key's range from the table the switch names; a key only the other table has (a fine v3 band named by an answer
 *  recorded under v3, read back under v2) from that one. null = no table has it. */
export function limpLockRange(key: string, version: LimpLocksVersion = limpLocksVersion()): (LimpRange & { table: LimpLocksVersion }) | null {
  const other: LimpLocksVersion = version === "v3" ? "v2" : "v3";
  const own = TABLES[version][key];
  const r = own ?? TABLES[other][key];
  return r ? { ...r, table: own ? version : other } : null;
}

/** THE STACK BANDS (his stack as dealt, bb; the upper edge inclusive, as the tables were measured): the two coarse ones
 *  every table has, and v3's finer ones inside 60bb. Over 85bb: no short key (the `_deep` ones are the charts' own). */
export type LimpCoarseBand = "le60" | "60_85";
export type LimpFineBand = "le25" | "25_40" | "40_60" | "60_85";
export const limpCoarseBand = (stack: number): LimpCoarseBand | null => (!(stack > 0) || stack > 85 ? null : stack <= 60 ? "le60" : "60_85");
export const limpFineBand = (stack: number): LimpFineBand | null =>
  !(stack > 0) || stack > 85 ? null : stack <= 25 ? "le25" : stack <= 40 ? "25_40" : stack <= 60 ? "40_60" : "60_85";

/** THE SWITCH (an experiment, 2026-10-05), SHORT_LIMP_POOL in the environment, read at every decision:
 *   on (unset)  the picker's short-limper routing (hrc6max shortLimperAlone), this floor, AND the GTO Wizard preflop
 *               lock (gtowAiPreflop.solvePreflopPoolLocked: hero's preflop answer against the limper at the pool range);
 *   floor       the routing and this floor only — hero's preflop answer as before the lock;
 *   off         none of them.
 *  Diagnostic: bun src/scripts/shortLimpPoolReport.ts [--since 2026-10-05]. */
export type ShortLimpPoolMode = "on" | "floor" | "off";
export const shortLimpPoolMode = (): ShortLimpPoolMode => {
  const v = String(process.env.SHORT_LIMP_POOL ?? "on").trim().toLowerCase();
  return v === "off" ? "off" : v === "floor" ? "floor" : "on";
};
export const shortLimpPoolOn = (): boolean => shortLimpPoolMode() !== "off";
export const poolLimpLockOn = (): boolean => shortLimpPoolMode() === "on";

/** A pool range as 1,326 per-combo weights (each combo its class's weight) — the strategy a lock gives the limp. */
export function poolLimpWeights(key: PoolLimpKey): number[] {
  const w = limpLockRange(key)!.weights;
  return COMBOS.map((c) => Math.max(0, Math.min(1, Number(w[c.cls] ?? 0))));
}
export const poolLimpRange = (key: PoolLimpKey): { freq: number; n: number } => {
  const r = limpLockRange(key)!;
  return { freq: r.freq, n: r.n };
};
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
  /** the table the range came from (LIMP_LOCKS) */
  table: LimpLocksVersion;
  /** he then CALLED the iso (2026-10-09, services/poolCalls.applyLimpCallProduct): the call cell the whole limp cell
   *  (`base` combos) was multiplied by — `now` is the product */
  times?: { key: string; freq: number; n: number; base: number; cal?: string };
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
  // A POST-IN IS TREATED AS A LIMPER, FOR NOW (Brady 2026-10-05). A new player who posts 1bb to come in and checks his
  // option is read as a limp by normalizeHand (hand.postIns, readAs "limp") — and given the limp's pool range here, the
  // lock's and the floor's alike (hands 4921628232, 4921841315 in the replay gate). Strictly his range is closer to any
  // two cards, but there is no way yet to emulate a post-in's game state on a tree and too little data on how posters
  // play, so the minimally defensive choice is the limp. TO REVISIT as post-in data accumulates (memory:
  // todo-post-in-ranges): measure posters' hands from the downloaded histories, then give them their own range or tree.
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

/** The pool range for a limper at this stack — null for a deep one (over 85bb). Role and coarse band as
 *  genLimpPlanV2.lock_for picks it; under LIMP_LOCKS=v3 the finest band the table has for his stack first (a 30bb
 *  over-limp: overlimp_short_25_40), the coarse one when the table has no finer key (a first-in limp, the SB folded to,
 *  an SB complete behind 2 limps at 25bb or less). */
export function poolLimpKey(l: Pick<PoolLimper, "limpsBefore" | "complete">, stack: number, version: LimpLocksVersion = limpLocksVersion()): PoolLimpKey | null {
  const b = limpCoarseBand(stack);
  if (!b) return null;
  if (l.complete && l.limpsBefore >= 3) return "sbcomplete_b3";
  const base = l.complete
    ? (l.limpsBefore === 0 ? "sbcomplete_fold_short" : `sbcomplete_b${l.limpsBefore}_short`)
    : (l.limpsBefore === 0 ? "limp_first_short" : "overlimp_short");
  if (version === "v3") {
    const fine = `${base}_${limpFineBand(stack)}`;
    if (fine in TABLES.v3) return fine as PoolLimpKey;
  }
  return `${base}_${b}` as PoolLimpKey;
}

/** The plan a baked chart was solved from (the bake's provenance row): `limp-v2-…` = the v2 locks, by stack bucket. */
const bakedPlanOf = (id: string): string | null => hrc6maxDb.provenance(id)?.plan ?? null;

/**
 * Does the chart that gave the flop ranges hold this limper's node at the range HIS stack calls for?
 *   - it locks his node: the pool3 trees (even and uneven) lock every limp and the SB's complete; the pilot
 *     (`_olimp_pool`) and the hero-free trees (`_olimp_poolh`) lock the limps, not the SB's complete (in a hero-free tree
 *     the deep seats' over-limps are solved too — a deep limper is never floored, so that changes nothing here);
 *   - a V2 tree (its bake provenance names a `limp-v2-…` plan): the v1 uneven pool3 trees still baked under the same ids
 *     (s30_SB, s30_BTN, s70_BB) locked every limper to the DEEP range; their v2 re-solves replace them in place;
 *   - THE SAME STACK BUCKET (Brady 2026-10-05: "say the 60bb one hasn't [been solved], then we'll just use this one"):
 *     a tree locks a seat at the range of ITS stack in the tree — 26.3% at 60bb or less, 15.1% at 60-85bb, 3.1%
 *     deeper — so a 55bb limper read on the 100bb pool tree holds the deep range, an eighth of his own. Covered only
 *     when the tree's stack for his seat is in his bucket;
 *   - and the effective stack inside the gap gate's first-decision bound.
 * The wide tree's locks are the v1 deep ones at full weight, so it never covers.
 */
export function poolChartCovers(chartId: string | null, l: Pick<PoolLimper, "pos" | "complete">, heroPos: Seat6,
                                table: { hero: number; limper: number }, planOf: (id: string) => string | null = bakedPlanOf): boolean {
  if (!chartId) return false;
  const full = chartId === POOL_LIMP_CHART || /_olimp_pool3$/.test(chartId);
  const limpsOnly = chartId === POOL_LIMP_CHART_SB || /_olimp_poolh$/.test(chartId);
  if (!(full || (limpsOnly && !l.complete)) || !/^limp-v2/.test(planOf(chartId) ?? "")) return false;
  const st = chartStacks6(chartId);
  if (!st) return false;
  if (limpStackBucket(st[l.pos]) !== limpStackBucket(table.limper)) return false;
  return withinFirstStackBound(Math.min(table.hero, table.limper), Math.min(st[heroPos], st[l.pos]));
}

/**
 * THE GTO WIZARD PREFLOP LOCK'S TARGET (2026-10-05, Brady: "use gto wizard ai preflop, to send in the pool measured range
 * for the original limper, then re-solve the tree from there to give the correct decision for hero"). Which limper, if
 * any, hero's preflop decision should be read against at the pool's range on a node-locked GTO Wizard AI tree:
 *   - a NON-BLIND villain who limped before any raise, at 85bb or less (his range by his own stack's bucket,
 *     poolLimpKey) — whatever he did after (a limp-raise is solved behind the locked limp). NOT the SB's complete
 *     (2026-10-09, Brady: "drop the SB complete from the lock target"): folded to, GTO Wizard completes the SB ITSELF —
 *     a strategy, 5-20% of hands on specific cards (26.8bb 70 combos, 40bb 116, 52bb 267, 75bb 211), where a non-blind
 *     limp is residue (0.1-1.6 combos smeared over the deck). The pool's folded-to cell (45% / 30% on 50 / 33 completes)
 *     replaced a real range with a thin one and made hero check back 66-88 / AJo / ATs; the SB's complete is the solver's;
 *   - EXACTLY ONE non-blind limp in the line, his: GTO Wizard's preflop tree holds one non-SB limper and the SB's complete
 *     (max_allowed_limps 2). Two or more limpers — or hero's own limp before his — are the charts' and the line fit's,
 *     unchanged (Brady 2026-10-05: "this is just an addition to it"). With a non-blind limper AND the SB completing, the
 *     limper is locked and the SB's complete is the solver's;
 *   - not covered by the chart the picker would answer from (poolChartCovers: a v2 pool tree that locked him at his own
 *     bucket, inside the stack bound) — a covered limper is that chart's;
 *   - three or more players dealt (as the floor).
 */
export interface PoolLockTarget {
  pos: Seat6;
  key: PoolLimpKey;
  /** his stack as dealt (bb) */
  stack: number;
  complete: boolean;
  /** an SB who completed short too, left to the solver (the tree holds one lock per hand) */
  alsoSb: boolean;
}
export function poolLockTarget(a: {
  hand: ParsedHand; heroPos: string | null;
  /** the chart the picker would answer this decision from (null: none — a thinned table, the chart server down) */
  chartId: string | null;
  dealt?: Record<number, number>;
  planOf?: (id: string) => string | null;
}): { ok: true; target: PoolLockTarget } | { ok: false; why: string } {
  const hero = String(a.heroPos ?? "").toUpperCase() as Seat6;
  const byPos = dealtByPos(a.hand, a.heroPos, a.dealt);
  if (!SEATS6.includes(hero)) return { ok: false, why: "hero's seat is not known" };
  if (Object.keys(byPos).length < 3) return { ok: false, why: "fewer than three players dealt" };
  // every non-blind limp before the first raise, hero's included
  const posOf = (seatId: number): Seat6 | null => {
    const p = String(seatId === a.hand.heroSeatId && a.heroPos ? a.heroPos : a.hand.positions?.[seatId] ?? "").toUpperCase() as Seat6;
    return SEATS6.includes(p) ? p : null;
  };
  let raised = false, nonBlindLimps = 0;
  const acted = new Set<Seat6>();
  for (const x of a.hand.actions ?? []) {
    if (x.street !== "preflop" || POSTS.has(String(x.type))) continue;
    const p = posOf(x.seatId);
    if (!p) continue;
    if (AGGRESSIVE.has(String(x.type))) raised = true;
    else if (x.type === "call" && !raised && !acted.has(p) && p !== "SB" && p !== "BB") nonBlindLimps++;
    acted.add(p);
  }
  if (nonBlindLimps > 1) return { ok: false, why: `${nonBlindLimps} limpers — GTO Wizard's preflop tree holds one (the charts and the line fit answer)` };
  const limpers = poolLimpersOf(a.hand, a.heroPos);
  const nonBlind = limpers.find((l) => !l.complete);
  if (nonBlindLimps === 1 && !nonBlind) return { ok: false, why: "the one limp is hero's" };
  const l = nonBlind;
  if (!l) return { ok: false, why: limpers.some((x) => x.complete) ? "only the SB completed — his complete is the solver's (GTO Wizard completes the SB itself; 2026-10-09)" : "no villain limped" };
  const stack = Number(byPos[l.pos] ?? NaN);
  const key = poolLimpKey(l, stack);
  if (!key) return { ok: false, why: `the ${l.pos} limped deep (${Number.isFinite(stack) ? Math.round(stack) : "?"}bb) — the charts' own range` };
  const heroStack = Number(byPos[hero] ?? NaN);
  if (Number.isFinite(heroStack) && poolChartCovers(a.chartId, l, hero, { hero: heroStack, limper: stack }, a.planOf)) {
    return { ok: false, why: `${a.chartId} covers the ${l.pos}'s limp at his own range` };
  }
  const sb = limpers.find((x) => x.complete);
  const alsoSb = !!(nonBlind && sb && poolLimpKey(sb, Number(byPos.SB ?? NaN)));
  return { ok: true, target: { pos: l.pos, key, stack: Math.round(stack * 10) / 10, complete: l.complete, alsoSb } };
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
  /** limpers the tree the ranges were walked off LOCKED to the pool range (a pool-locked AI pin): kept as walked */
  lockedPools?: readonly { pos: string; key: string }[];
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
    // a lone SB complete (folded to) is the solver's, at the flop as preflop (2026-10-09, Brady: "drop it of course"):
    // GTO Wizard completes the SB itself, 5-20% of hands on specific cards — never the sub-combo residue the floor exists
    // for; the pool's folded-to cell (45% / 30%) would overwrite that real range. His complete BEHIND a limper is still floored
    if (l.complete && l.limpsBefore === 0) continue;
    const stack = Number(byPos[l.pos] ?? NaN);
    const key = poolLimpKey(l, stack);
    if (!key) continue;
    const rk = Object.keys(out).find((p) => p.toUpperCase() === l.pos);
    if (!rk) continue;                                                           // not at the flop
    if (Number.isFinite(heroStack) && poolChartCovers(a.chartId, l, hero, { hero: heroStack, limper: stack }, a.planOf)) continue;
    // his range was walked off a tree that locked his limp to exactly this pool range: it is already his, narrowed by
    // what he did after the limp — replacing it with the whole range would undo that
    if (a.lockedPools?.some((p) => p.pos.toUpperCase() === l.pos && p.key === key)) continue;
    const lock = limpLockRange(key);
    if (!lock) continue;
    const was = combosOf(out[rk]);
    if (out === a.ranges) out = { ...a.ranges };
    out[rk] = { ...(lock.weights as ClassRange) };
    applied.push({ pos: l.pos, key, stack: Math.round(stack * 10) / 10, freq: lock.freq, n: lock.n, was, now: combosOf(out[rk]), table: lock.table });
  }
  return { ranges: out, applied };
}

/** The answer's note for the replaced limpers. */
export const poolLimpFloorNote = (applied: PoolLimpFloorRecord[], chartId: string | null): string =>
  `POOL LIMP RANGE: ${applied.map((r) => `the ${r.pos} (${Math.round(r.stack)}bb) limped — ${r.was} combos on ${chartId ?? "the preflop tree"}, `
    + (r.times
      // he then called the iso: the whole cell × the pool's limp-call rate (the oracle reads both keys back)
      ? `now the pool's ${r.key} (${limpTableTag(r.table)}${(100 * r.freq).toFixed(1)}% of hands, n=${r.n}, ${r.times.base} combos) × his limp-call rate ${r.times.key} (${(100 * r.times.freq).toFixed(1)}% of chances, ${r.times.n.toLocaleString("en-US")} calls)${r.times.cal ? ` × Ignition calibration ${r.times.cal}` : ""} = ${r.now} combos`
      : `now the pool's ${r.key} (${limpTableTag(r.table)}${(100 * r.freq).toFixed(1)}% of hands, n=${r.n}, ${r.now} combos)`)).join("; ")}`
  + " — no pool-locked tree covers this stack yet";

/** The table tag a note carries right after the key — none for v2 (the notes exactly as before 2026-10-09), "v3: " for
 *  v3 (rangeOracle.poolFloorsOf reads it back, so a recorded answer is checked against the table it was answered from). */
export const limpTableTag = (t: LimpLocksVersion | undefined): string => (t === "v3" ? "v3: " : "");
