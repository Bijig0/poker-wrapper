/**
 * THE ONE TRIGGER RULE: WHEN A VILLAIN'S SOLVER RANGE IS REPLACED OR LOCKED BY THE POOL'S (2026-10-09, calibrated
 * offline — poker branch claude/trigger-rule, analysis/pipeline/range_qa/trigger/trigger_rule.md; memory trigger-rule).
 *
 * Until now every pool overlay fired on STRUCTURE alone (the limp lock: one non-blind limper ≤85bb; the cold-call floor:
 * under 13.26 combos; the pool-call ranges: the pin-cap lines only) and never asked whether the solver's own range was
 * actually wrong. The calibration scored 569 live villain decisions whose solver range was on record against the hands
 * Ignition players really held in the same spots (every card visible; "ideal" = fire iff the pool cell explains the
 * held hands better by ≥0.2 nats a hand) and swept 70 rules. The recommended one:
 *
 *   fire =    fSolver < 1%                                               RESIDUE — the QRE smear, nothing to keep
 *          OR (    fSolver < fPool / k            (k = 2)                DIVERGENCE — the pool plays it ≥2x as often
 *              AND wilsonLower95(pool counts) > fSolver                    EVIDENCE — the pool's own rate excludes his
 *              AND KL_group(pool ‖ solver) ≥ 0.3 nats )                    SHAPE — the 8-group hand mix really differs
 *          OR reachPre < 1%                       (preflop only)         LINE GUARD — the product of his PREFLOP shares
 *
 * precision 0.90 / recall 0.78 / balanced 0.80 / 1 clearly-worse firing, against today's code 0.84 / 0.13 / 0.54 / 4.
 * k = 2, not 3: at a 2-3x ratio the pool is better in 77 of 91 decisions. The KL test removes exactly the folded-to SB
 * completes (KL 0.12-0.14, the pool no better) and cuts harmful firings 3 → 1. The line guard catches the thin LINE
 * seats a node rule cannot see (limp-callers, a call of a 3-bet after a call). It NEVER runs postflop: normal narrowing
 * takes the median villain to 0.75% of his hands by the river (it would fire on 54% of river actions) — postflop the
 * cumulative check is a FLAG on check #3 (chainChecks), never a replacement.
 *
 * THE EVIDENCE TEST'S COUNTS (documented gap): the rule wants Ignition's own count for the cell (the builders are to write
 * `ign: {x, n}` per cell — factory side, not yet). Until they do, the Wilson bound is taken on the cell's OWN counts:
 * the call / cold-call tables' (calls, chances) — CoinPoker-sized, so it almost always passes, which at k = 2 is nearly
 * the same rule (the CI barely binds there; §3.2) — and the limp table's n limps of n / freq chances (Ignition NL200 for
 * the first-in / folded-to cells, CoinPoker-backed for v3's re-measured thin ones).
 *
 * "DEALT": a walked range here is a CLASS range (169 classes, at most 1,326 combos), so a share of his dealt hands is
 * combos / 1,326 — the cold-call floor's 13.26-combo "1% of hands". (The calibration counted at flop entry against
 * 1,176 combos, the board's three cards removed: 11.8 combos; the 11% difference is inside the rule's own margin.)
 *
 * THE SWITCHES, read at every decision (config/local.env):
 *   POOL_TRIGGER_K           the divergence ratio k (default 2)
 *   POOL_TRIGGER_DIVERGENCE  on (default) | off — the divergence arm (the calibration's suggested stage 2)
 *   POOL_TRIGGER_LINE_GUARD  on (default) | off — the preflop line guard
 *   POOL_TRIGGER_ABS / POOL_TRIGGER_KL / POOL_TRIGGER_REACH  the residue floor (0.01), the KL bar (0.3 nats), the
 *                            line-guard floor (0.01) — for a study, not to be tuned live
 * Pure: numbers in, a verdict out. The callers (gtowAiPreflop.solvePreflopPoolLocked, poolFlatFloor) say what fired.
 */
import { COMBOS } from "../utils/comboIndex/comboIndex";

export type TriggerWhy = "residue" | "divergence" | "line-guard" | null;
export type ClassRange = Record<string, number>;

export interface TriggerParams { abs: number; k: number; z: number; klMin: number; reach: number; divergence: boolean; lineGuard: boolean }
export const TRIGGER_DEFAULTS: TriggerParams = { abs: 0.01, k: 2, z: 1.96, klMin: 0.3, reach: 0.01, divergence: true, lineGuard: true };

const envNum = (name: string, dflt: number, ok: (v: number) => boolean): number => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return dflt;
  const v = Number(raw);
  return Number.isFinite(v) && ok(v) ? v : dflt;
};
const envOn = (name: string): boolean => !/^(off|0|false|no)$/i.test(String(process.env[name] ?? "on").trim());

/** The parameters as the environment says now (read at every decision). */
export function triggerParams(): TriggerParams {
  return {
    abs: envNum("POOL_TRIGGER_ABS", TRIGGER_DEFAULTS.abs, (v) => v >= 0 && v < 1),
    k: envNum("POOL_TRIGGER_K", TRIGGER_DEFAULTS.k, (v) => v >= 1),
    z: TRIGGER_DEFAULTS.z,
    klMin: envNum("POOL_TRIGGER_KL", TRIGGER_DEFAULTS.klMin, (v) => v >= 0),
    reach: envNum("POOL_TRIGGER_REACH", TRIGGER_DEFAULTS.reach, (v) => v >= 0 && v < 1),
    divergence: envOn("POOL_TRIGGER_DIVERGENCE"),
    lineGuard: envOn("POOL_TRIGGER_LINE_GUARD"),
  };
}

/** Wilson score interval's LOWER bound for x successes in n (95% at z = 1.96). n ≤ 0 → NaN. */
export function wilsonLower(x: number, n: number, z = TRIGGER_DEFAULTS.z): number {
  if (!(n > 0)) return NaN;
  const p = Math.min(1, Math.max(0, x / n));
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  return c - (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}

/** The pool cell's evidence bound from its own counts: the call / cold-call tables' (calls, chances); the limp table's
 *  n limps at rate freq (n / freq chances). null when the cell carries no counts. */
export function poolCiLower(c: { calls?: number | null; chances?: number | null; n?: number | null; freq?: number | null }, z = TRIGGER_DEFAULTS.z): number | null {
  if (c.calls != null && c.chances != null && c.chances > 0) return wilsonLower(c.calls, c.chances, z);
  if (c.n != null && c.n > 0 && c.freq != null && c.freq > 0) return wilsonLower(c.n, c.n / c.freq, z);
  return null;
}

/** The builders' eight hand groups (poolcalls_measure.cat, verbatim) — the calibration's and the KL test's unit. */
export function handGroup(cls: string): string {
  if (["AA", "KK", "QQ", "JJ", "AKs", "AKo"].includes(cls)) return "prem";
  if (cls.length === 2) return "pairs";
  const a = cls[0]!, b = cls[1]!, s = cls[2];
  if (a === "A") return s === "s" ? "Axs" : "Axo";
  if ("TJQK".includes(b)) return s === "s" ? "s-bway" : "o-bway";
  return s === "s" ? "oth-s" : "o-junk";
}
export const HAND_GROUPS = ["prem", "pairs", "Axs", "Axo", "s-bway", "o-bway", "oth-s", "o-junk"] as const;

const classCombos = (c: string): number => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
/** the deck's combos per hand group (1,326 in all) */
const DECK_GROUP: Record<string, number> = (() => {
  const out: Record<string, number> = Object.fromEntries(HAND_GROUPS.map((g) => [g, 0]));
  for (const c of COMBOS) out[handGroup(c.cls)]! += 1;
  return out;
})();

/** A class range's combos (weights ≤ 0 count nothing). */
export const combosOfRange = (r: ClassRange | null | undefined): number =>
  Object.entries(r ?? {}).reduce((s, [c, w]) => s + (Number(w) > 0 ? Number(w) * classCombos(c) : 0), 0);

/** A class range's mass by hand group, as shares summing to 1 — each smoothed with `eps` of the deck's own group share
 *  so an empty group never divides by zero (the calibration's eps 1e-3). An empty range → the deck's shares. */
export function groupShares(r: ClassRange, eps = 1e-3): Record<string, number> {
  const m: Record<string, number> = Object.fromEntries(HAND_GROUPS.map((g) => [g, 0]));
  for (const [c, w] of Object.entries(r)) if (Number(w) > 0) m[handGroup(c)]! += Number(w) * classCombos(c);
  const tot = Object.values(m).reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  for (const g of HAND_GROUPS) {
    const p = tot > 0 ? m[g]! / tot : DECK_GROUP[g]! / 1326;
    out[g] = (p + eps * (DECK_GROUP[g]! / 1326)) / (1 + eps);
  }
  return out;
}

/** KL(pool ‖ solver) over the 8 hand groups, in nats: Σ_g p_pool(g) · ln(p_pool(g) / p_solver(g)). */
export function klGroup(pool: ClassRange, solver: ClassRange, eps = 1e-3): number {
  const p = groupShares(pool, eps), q = groupShares(solver, eps);
  let kl = 0;
  for (const g of HAND_GROUPS) kl += p[g]! * Math.log(p[g]! / q[g]!);
  return Math.max(0, kl);
}

/** A 1,326-combo strategy (or range) as a class range: each class's mean over its combos. */
export function classRangeOf(weights: ArrayLike<number>): ClassRange {
  const sum: Record<string, number> = {}, n: Record<string, number> = {};
  COMBOS.forEach((c, i) => { sum[c.cls] = (sum[c.cls] ?? 0) + Math.max(0, Number(weights[i] ?? 0)); n[c.cls] = (n[c.cls] ?? 0) + 1; });
  const out: ClassRange = {};
  for (const c of Object.keys(sum)) out[c] = sum[c]! / n[c]!;
  return out;
}

export interface TriggerInput {
  /** the solver's share of the action at his node, 0..1 (null: not known — only the line guard can fire) */
  fSolver: number | null;
  /** the pool cell's rate for the action (null: no cell — nothing but the residue arm and the line guard) */
  fPool: number | null;
  /** the pool rate's 95% Wilson lower bound (poolCiLower; null = no counts → the divergence arm cannot fire) */
  poolCI: number | null;
  /** KL(pool cell ‖ the solver's range after the action) over the 8 groups (klGroup; null = the solver's shape is not
   *  known → the shape test is skipped, as the calibration did for shape-less rows) */
  groupKL: number | null;
  /** where the decision is: the line guard runs preflop only */
  line: "preflop" | "postflop";
  /** the product of his preflop shares since the deal = his flop-entering combos / the combos dealt (null: not known) */
  reach: number | null;
}
export interface TriggerResult {
  fire: boolean;
  why: TriggerWhy;
  /** one line for the answer's note / path: the numbers that decided it */
  text: string;
}

const pct = (x: number): string => `${(100 * x).toFixed(x < 0.001 ? 3 : 2)}%`;

/**
 * THE RULE (the header). `p` defaults to the environment's parameters, read now. The order of the arms only names the
 * firing: residue (the node), then the line guard (the line), then divergence.
 */
export function shouldReplace(a: TriggerInput, p: TriggerParams = triggerParams()): TriggerResult {
  const { fSolver, fPool } = a;
  if (fSolver != null && Number.isFinite(fSolver) && fSolver < p.abs) {
    return { fire: true, why: "residue", text: `residue: the solver plays it ${pct(fSolver)} (< ${pct(p.abs)})` };
  }
  if (p.lineGuard && a.line === "preflop" && a.reach != null && Number.isFinite(a.reach) && a.reach < p.reach) {
    return { fire: true, why: "line-guard", text: `line guard: his preflop line leaves ${pct(a.reach)} of his dealt hands (< ${pct(p.reach)})` };
  }
  if (fSolver == null || !Number.isFinite(fSolver)) return { fire: false, why: null, text: "the solver's share is not known" };
  if (fPool == null || !Number.isFinite(fPool)) return { fire: false, why: null, text: `the solver plays it ${pct(fSolver)}; no pool cell` };
  const vs = `the solver ${pct(fSolver)} vs the pool ${pct(fPool)}`;
  if (!p.divergence) return { fire: false, why: null, text: `${vs} — the divergence arm is off (POOL_TRIGGER_DIVERGENCE=off)` };
  if (!(fSolver < fPool / p.k)) return { fire: false, why: null, text: `${vs}: not under the pool's rate / ${p.k}` };
  if (a.poolCI == null || !Number.isFinite(a.poolCI)) return { fire: false, why: null, text: `${vs}: the pool cell carries no counts (no evidence)` };
  if (!(a.poolCI > fSolver)) return { fire: false, why: null, text: `${vs}: the pool's 95% lower bound ${pct(a.poolCI)} does not exclude the solver's share` };
  if (a.groupKL != null && Number.isFinite(a.groupKL) && a.groupKL < p.klMin) {
    return { fire: false, why: null, text: `${vs}: the same hand-group mix (KL ${a.groupKL.toFixed(2)} < ${p.klMin})` };
  }
  return { fire: true, why: "divergence", text: `divergence: ${vs} (under 1/${p.k}, the pool's lower bound ${pct(a.poolCI)}${a.groupKL != null ? `, KL ${a.groupKL.toFixed(2)}` : ""})` };
}
