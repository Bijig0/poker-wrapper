/**
 * THE POOL'S 3-BET COLD-CALL (2026-10-05, Brady after stress-500 po_3way-001). An open, a 3-bet, and a seat with no
 * chips in yet CALLS: GTO Wizard AI preflop gives that call 0% of the BB's range there (Fold 94.8 / Raise 2.3 / All-in
 * 2.9), so the walk left him 0.01 combos and hero's preflop answer and every street after it were solved against a seat
 * that holds nothing. The pool does it 2-2.5% of the time from every seat (CoinPoker, 9.1M hands: 65,530 cold-calls in
 * 2.8M chances; Ignition NL100+NL200 2.5-3.5%), with pairs, AQ-AT, KQ-KJ, QJ-JT and some suited connectors.
 *
 * TWO PARTS, as for the short limper (poolLimpFloor):
 *   - THE PREFLOP LOCK (gtowAiPreflop.solvePreflopColdCallLocked, fastSolve.poolColdCallLockFirst): hero's preflop
 *     decision after such a call is read on the exact GTO Wizard AI tree of the table with the caller's node LOCKED — his
 *     call at the pool's range for his seat and stack, the rest of each hand folding or raising as the solver plays it —
 *     when the unlocked tree gives that call under coldCallLockBelow (the larger of 1% and a third of the pool's rate) of
 *     his range there. The answer pins the locked solution, so the flop walks his range off it.
 *   - THE FLOP FLOOR (applyPoolColdCallFloor): whatever piece produced the flop ranges (a chart, an unlocked AI tree, a
 *     cold-call after hero's last preflop decision), a cold-caller who reaches the flop with under 1% of hands enters it
 *     with the pool's range for his seat and stack instead.
 *
 * The ranges: poolColdCallLocks.json, a copy of poker analysis/pipeline/limp_study/locks_v2/coldcall3b_locks.json
 * (build_coldcall_locks.py: frequency from every CoinPoker cold-call decision, shape from the 18,324 seen at showdown,
 * corrected for showdown bias against Ignition's every-card-visible cold-calls; smoothing + water-filling as the limp
 * locks). Per seat (HJ borrows the CO's shape), stack bucket and 3-BET SIZE.
 *
 * THE SIZE SPLIT (2026-10-05, Brady: "yes 3-bet size should be split"; poker locks_v2/coldcall3b_bysize_report.txt):
 * the 3-bet's multiple of the open — small (under 2.5x: the pool flats ~5%, the BB ~7%, almost no premiums: they
 * 4-bet), mid (2.5-3.9x, ~2.3%), large (3.9x and up, ~2.0%). A 3-bet that is ALL-IN, or that takes 40%+ of the
 * effective stack caller vs 3-bettor, is a call of a jam — its own range (`_jam`, ~4%); those calls are out of every
 * other range (they were 21% of the old under-40bb buckets' calls). coldCallKey picks the most specific range built:
 * seat+stack+size, seat+stack, seat+size, seat. Edges and the jam share come from the JSON (size_edges, jam_commit).
 *
 * JAMS BY SIDE AND DEPTH (2026-10-06, poker locks_v2/coldcall3b_jamdepth_report.txt): the one `_jam` range per seat
 * pooled jams of every depth — mostly calls of short ones — so a deep jam's caller held ~4x the combos the pool calls
 * it with. A jam is now read by WHO IS SHORT and the EFFECTIVE STACK (caller vs 3-bettor, as dealt): `covers` — the
 * caller covers the 3-bettor and calls his shove: 5.9% under 10bb, 2.75% at 10-20, 1.9% at 20-40, 1.0% at 40bb+, the
 * premiums going from 10% to 53% of the calls; `covered` — the 3-bettor covers the caller, whom the 3-bet commits:
 * 33% / 7.8% / 4.8% / 6.6%, junk-heavy (a short stack getting a price). The 3-bettor's seat, the table size and the
 * stake move it far less. Key `coldcall3b_<seat>_jam_<side>_<depth>` (depth le10 / 10_20 / 20_40 / 40p, edges from the
 * JSON's jam_depth_edges), every seat built (its own rate with 50+ calls — the BB's and the SB's short cells — else all
 * seats'; the shape all seats'), the pooled `_jam` kept for a line whose stacks are unknown.
 *
 * THE TRIGGER (cutoff study 2026-10-05, scripts/coldCallCutoffStudy.ts): the lock stands when the exact tree's call is
 * under coldCallLockBelow(key) = the larger of 1% and a third of the pool's own rate for the range picked ("the pool
 * cold-calls at least 3x as often as the tree here"). Deep mid/large 3-bets (pool 1.2-2.2%) keep the flat 1%; a deep
 * small 3-bet 1-2.2%, under 80bb 2.3-5%. Why relative: the cliff a cutoff leaves (just under it the
 * caller holds the pool's combos, just over it the tree's) is then at most 3x — a flat 1% left up to 15x against the
 * 40-80bb small-3-bet range (200 combos vs 13) — and the lock goes where the pool really differs from the tree.
 * Measured on 22 real spots + 7 variants (GTO Wizard AI, the ranges before the size split): GTO's share is ~0% on every
 * standard 3-bet (19/22), 0.35-1.43% only against 1.5-2x 3-bets 100bb+ deep, 4.2% calling a 13bb jam; where it is
 * 0.35-1.43%, locking moves 2-5% of hero's range and <= 0.016 bb a hand at the node; at ~0% it moves 10-29% (up to
 * 0.18 bb). On the size-split ranges the same three deep spots lock to 56-85 combos instead of 5-19 and hero still
 * moves 1-2% (<= 0.006 bb). A JAM KEEPS THE FLAT 1%: locking the deep BB's call of a 60bb jam (GTO 1.65%, a 22-combo
 * call-off) to the _jam range (56 combos, TT and AQs in it) took UTG's re-jam from 2% to 21% of his range (2-6 bb a
 * hand at the node, whichever range is right), and that range pools the calls of jams of every depth — mostly short
 * shoves — so its cutoff is not raised until it is split by the jam's size. COLD_CALL_LOCK_RATIO (default 3; off = the
 * flat 1% alone) is read at every decision.
 * Since the depth split (2026-10-06) a jam's SIDE x DEPTH range takes the same rule; only the pooled `_jam` fallback keeps
 * the flat 1% (it still pools every depth). Measured (cutoff study, 24 + earlier requests): on the covering side the
 * depth ranges sit near GTO's own call (13.4bb shove: pool 2.96%, GTO 4.20%; 60bb: 1.04% vs 1.65% — no lock under
 * either rule; its triggers are 1-2.6%). On the covered side GTO's call is ~0% for a 15bb BB flatting a 3-bet to 9
 * (pool 8.7%) and a 25bb BB flatting 11 (pool 4.9%) — a lock under either rule — and 3.53% for a 9.5bb BB flatting 9
 * (pool 36.5%): the one place the rule decides. There GTO's "call" is a near-indifferent sliver beside shoving the last
 * 0.5bb, while the pool continues with 36% (127 BB calls, 96% seen at showdown); a flat 1% would leave him 47 combos of a
 * 484-combo range, so the ratio's lock (under 12.2%) is the honest one.
 *
 * THE SWITCH, COLD_CALL_POOL in the environment, read at every decision: on (unset) = the lock and the floor; floor = the
 * floor only; off = neither. Unlimped pots only (the ranges were measured there; an iso over limpers is another node).
 */
import LOCKS from "./poolColdCallLocks.json";
import { dealtByPos, SEATS6, type Seat6 } from "./hrc6max";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

export type ColdCallKey = keyof typeof LOCKS.ranges;
/** the 3-bet's size class for the caller: its multiple of the open, or a jam (all-in / 40%+ of the effective stack) */
export type ColdCallSize = "small" | "mid" | "large" | "jam";
export type ColdCallPoolMode = "on" | "floor" | "off";
export const coldCallPoolMode = (): ColdCallPoolMode => {
  const v = String(process.env.COLD_CALL_POOL ?? "on").trim().toLowerCase();
  return v === "off" ? "off" : v === "floor" ? "floor" : "on";
};
/** the unlocked tree's call, as a share of the caller's range at his node, under which the lock always applies */
export const COLD_CALL_LOCK_BELOW = 0.01;
/** the pool cold-calling at least this many times as often as the tree also locks (COLD_CALL_LOCK_RATIO; off = 1% only) */
export const coldCallLockRatio = (): number => {
  const v = Number(process.env.COLD_CALL_LOCK_RATIO ?? 3);
  return Number.isFinite(v) && v > 0 ? v : 0;
};
/** The lock's trigger for this range: the tree's call share under the larger of 1% and the pool's rate / the ratio.
 *  The pooled jam range (every depth in one, the fallback when the stacks do not say) keeps the flat 1%; a jam's side x
 *  depth range takes the rule like any other (the header). */
export const coldCallLockBelow = (key: ColdCallKey): number => {
  const k = coldCallLockRatio();
  if (key.endsWith("_jam")) return COLD_CALL_LOCK_BELOW;
  return Math.max(COLD_CALL_LOCK_BELOW, k > 0 ? LOCKS.ranges[key].freq / k : 0);
};
/** a cold-caller reaching the flop with under this many combos (1% of hands) gets the pool's range */
export const COLD_CALL_FLOOR_COMBOS = 13.26;

const POSTS = new Set(["post-sb", "post-bb", "post", "post-dead", "ante"]);
const CC_SEATS = new Set<Seat6>(["HJ", "CO", "BTN", "SB", "BB"]);

/** A villain who called an open and a 3-bet with no voluntary chips in before (posted blinds are not voluntary). */
export interface ColdCaller {
  pos: Seat6;
  /** index of his call in hand.actions */
  at: number;
  /** he raised after the call (a cold-call then a raise is not a call range) */
  raisedLater: boolean;
  /** the open and the 3-bet he called (raise-to, bb; 0 = not on the line) and who 3-bet */
  open: number;
  threeBet: number;
  threeBettor: Seat6 | null;
  /** the 3-bet was an all-in action */
  threeBetAllIn: boolean;
}

/** The unlimped open-3bet-cold-call seats of a hand's preflop (villains only), in the order they called. */
export function coldCallersOf(hand: ParsedHand, heroPos: string | null): { callers: ColdCaller[]; limped: boolean } {
  const posOf = (seatId: number): Seat6 | null => {
    const p = String(seatId === hand.heroSeatId && heroPos ? heroPos : hand.positions?.[seatId] ?? "").toUpperCase() as Seat6;
    return SEATS6.includes(p) ? p : null;
  };
  const hero = posOf(hand.heroSeatId);
  const vol = new Set<Seat6>();
  const callers: ColdCaller[] = [];
  let high = 1, raises = 0, limped = false;
  let open = 0, threeBet = 0, threeBettor: Seat6 | null = null, threeBetAllIn = false;
  (hand.actions ?? []).forEach((a, i) => {
    if (a.street !== "preflop" || POSTS.has(String(a.type))) return;
    const pos = posOf(a.seatId);
    if (!pos) return;
    const amt = Number(a.amount ?? 0);
    const isRaise = a.type === "raise" || a.type === "bet" || (a.type === "all-in" && amt > high + 1e-9);
    const isCall = a.type === "call" || (a.type === "all-in" && !isRaise);
    if (isRaise) {
      raises++; high = Math.max(high, amt);
      if (raises === 1) open = amt;
      else if (raises === 2) { threeBet = amt; threeBettor = pos; threeBetAllIn = a.type === "all-in"; }
      const c = callers.find((x) => x.pos === pos);
      if (c) c.raisedLater = true;
    } else if (isCall) {
      if (raises === 0 && pos !== "BB") limped = true;
      if (raises === 2 && !vol.has(pos) && pos !== hero && CC_SEATS.has(pos)) callers.push({ pos, at: i, raisedLater: false, open, threeBet, threeBettor, threeBetAllIn });
    }
    if (isRaise || isCall) vol.add(pos);
  });
  return { callers, limped };
}

/**
 * The size class of the 3-bet a cold-caller called: a jam when the 3-bet was all-in, took the 3-bettor's whole stack, or
 * takes LOCKS.jam_commit (40%) of the effective stack (his stack vs the 3-bettor's, as dealt); else the 3-bet's multiple
 * of the open against LOCKS.size_edges. null when the line does not carry both amounts.
 */
export function coldCallSize(c: Pick<ColdCaller, "pos" | "open" | "threeBet" | "threeBettor" | "threeBetAllIn">,
                             stacks: Partial<Record<Seat6, number>> = {}): ColdCallSize | null {
  if (c.threeBetAllIn) return "jam";
  if (!(c.threeBet > 0)) return null;
  const mine = Number(stacks[c.pos] ?? NaN), his = c.threeBettor ? Number(stacks[c.threeBettor] ?? NaN) : NaN;
  if (his > 0 && c.threeBet >= his - 1e-6) return "jam";
  const eff = Math.min(mine > 0 ? mine : Infinity, his > 0 ? his : Infinity);
  if (Number.isFinite(eff) && c.threeBet >= LOCKS.jam_commit * eff) return "jam";
  if (!(c.open > 0)) return null;
  const x = c.threeBet / c.open + 1e-9;
  for (const [k, [lo, hi]] of Object.entries(LOCKS.size_edges) as [ColdCallSize, [number, number | null]][])
    if (x >= lo && (hi == null || x < hi)) return k;
  return null;
}

/** Who is short in a jam the cold-caller called: `covers` = he covers the 3-bettor (calls a shove of the 3-bettor's
 *  stack; equal stacks count here), `covered` = the 3-bettor covers him (the 3-bet commits him). */
export type ColdCallJamSide = "covers" | "covered";
export interface ColdCallJam { side: ColdCallJamSide; /** the effective stack caller vs 3-bettor, as dealt (bb) */ depth: number }

/**
 * The side and depth of a jam (coldCallSize "jam"): depth = the smaller of his stack and the 3-bettor's, as dealt (an
 * all-in 3-bet stands for the 3-bettor's stack when that is unknown); null when his own stack is unknown.
 */
export function coldCallJam(c: Pick<ColdCaller, "pos" | "threeBet" | "threeBettor" | "threeBetAllIn">,
                            stacks: Partial<Record<Seat6, number>> = {}): ColdCallJam | null {
  const mine = Number(stacks[c.pos] ?? NaN);
  let his = c.threeBettor ? Number(stacks[c.threeBettor] ?? NaN) : NaN;
  if (!(his > 0) && c.threeBetAllIn && c.threeBet > 0) his = c.threeBet;
  if (!(mine > 0) || !(his > 0)) return null;
  return { side: mine < his ? "covered" : "covers", depth: Math.min(mine, his) };
}

/**
 * The pool range for a cold-caller of this seat, stack and 3-bet size: the most specific one built — seat+stack+size,
 * seat+stack, seat+size, seat. A jam has its own ranges per seat (calling a jam is another node: no non-jam fallback) —
 * by side and depth when `jam` is known, else the seat's pooled jam range.
 */
export function coldCallKey(pos: Seat6, stack: number, size: ColdCallSize | null = null, jam: ColdCallJam | null = null): ColdCallKey | null {
  if (!CC_SEATS.has(pos)) return null;
  const has = (k: string): k is ColdCallKey => k in LOCKS.ranges;
  if (size === "jam") {
    if (jam) {
      const d = (Object.entries(LOCKS.jam_depth_edges) as [string, [number, number | null]][])
        .find(([, [lo, hi]]) => jam.depth >= lo && (hi == null || jam.depth < hi))?.[0];
      const k = d ? `coldcall3b_${pos}_jam_${jam.side}_${d}` : null;
      if (k && has(k)) return k;
    }
    const j = `coldcall3b_${pos}_jam`;
    return has(j) ? j : null;
  }
  const b = !(stack > 0) ? null : stack < 40 ? "le40" : stack < 80 ? "40_80" : "80p";
  const order = [b && size ? `${b}_${size}` : null, b, size, "all"].filter((x): x is string => !!x);
  for (const o of order) { const k = `coldcall3b_${pos}_${o}`; if (has(k)) return k; }
  return null;
}

/** The range as 1,326 per-combo weights (each combo its class's weight) — the strategy the lock gives the call. */
export function coldCallWeights(key: ColdCallKey): number[] {
  const w = LOCKS.ranges[key].weights as Record<string, number>;
  return COMBOS.map((c) => Math.max(0, Math.min(1, Number(w[c.cls] ?? 0))));
}
export const coldCallRange = (key: ColdCallKey): { freq: number; calls: number; shown: number } =>
  ({ freq: LOCKS.ranges[key].freq, calls: LOCKS.ranges[key].calls, shown: LOCKS.ranges[key].shown });

export interface ColdCallLockTarget {
  pos: Seat6;
  key: ColdCallKey;
  /** his stack as dealt (bb) */
  stack: number;
  /** the 3-bet he called (null: the line does not say) */
  size: ColdCallSize | null;
  /** a jam's side and depth (absent: not a jam, or the stacks do not say) */
  jam?: ColdCallJam;
}

/**
 * The lock's target for hero's current preflop decision: exactly one villain cold-called the 3-bet before it, in an
 * unlimped pot with three or more dealt, and did not raise after (one lock per tree; two cold-callers stay as before).
 */
export function coldCallLockTarget(a: { hand: ParsedHand; heroPos: string | null; dealt?: Record<number, number> }):
    { ok: true; target: ColdCallLockTarget } | { ok: false; why: string } {
  const byPos = dealtByPos(a.hand, a.heroPos, a.dealt);
  if (Object.keys(byPos).length < 3) return { ok: false, why: "fewer than three players dealt" };
  const { callers, limped } = coldCallersOf(a.hand, a.heroPos);
  if (!callers.length) return { ok: false, why: "no villain cold-called a 3-bet" };
  if (limped) return { ok: false, why: "a limped pot (the pool's cold-call ranges are unlimped)" };
  const live = callers.filter((c) => !c.raisedLater);
  if (live.length !== 1 || callers.length !== 1) return { ok: false, why: `${callers.length} cold-callers — one lock per tree` };
  const c = live[0]!;
  const stack = Number(byPos[c.pos] ?? NaN);
  const size = coldCallSize(c, byPos);
  const jam = size === "jam" ? coldCallJam(c, byPos) : null;
  const key = coldCallKey(c.pos, stack, size, jam);
  if (!key) return { ok: false, why: `no pool cold-call range for the ${c.pos}${size ? ` (${size} 3-bet)` : ""}` };
  return { ok: true, target: { pos: c.pos, key, stack: Math.round(stack * 10) / 10, size, ...(jam ? { jam } : {}) } };
}

type ClassRange = Record<string, number>;
const classCombos = (c: string): number => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
const combosOf = (r: ClassRange | undefined): number =>
  Math.round(Object.entries(r ?? {}).reduce((s, [c, w]) => s + (Number(w) > 0 ? Number(w) * classCombos(c) : 0), 0) * 100) / 100;

export interface ColdCallFloorRecord { pos: Seat6; key: ColdCallKey; stack: number; freq: number; calls: number; was: number; now: number }

/**
 * The flop floor: every villain cold-caller of a 3-bet (unlimped, no raise after) whose flop-entering range is under
 * COLD_CALL_FLOOR_COMBOS gets the pool's range for his seat and stack. A seat the pinned tree LOCKED to that range
 * (`lockedPools`) keeps its walked range (the pool range narrowed by what he did after).
 */
export function applyPoolColdCallFloor(a: {
  hand: ParsedHand; heroPos: string | null; ranges: Record<string, ClassRange>; dealt?: Record<number, number>;
  lockedPools?: readonly { pos: string; key: string }[];
}): { ranges: Record<string, ClassRange>; applied: ColdCallFloorRecord[] } {
  const byPos = dealtByPos(a.hand, a.heroPos, a.dealt);
  if (Object.keys(byPos).length < 3) return { ranges: a.ranges, applied: [] };
  const { callers, limped } = coldCallersOf(a.hand, a.heroPos);
  if (limped || !callers.length) return { ranges: a.ranges, applied: [] };
  const applied: ColdCallFloorRecord[] = [];
  let out = a.ranges;
  for (const c of callers) {
    if (c.raisedLater) continue;
    const stack = Number(byPos[c.pos] ?? NaN);
    const size = coldCallSize(c, byPos);
    const key = coldCallKey(c.pos, stack, size, size === "jam" ? coldCallJam(c, byPos) : null);
    if (!key) continue;
    if (a.lockedPools?.some((p) => p.pos.toUpperCase() === c.pos && p.key === key)) continue;
    const rk = Object.keys(out).find((p) => p.toUpperCase() === c.pos);
    if (!rk) continue;
    const was = combosOf(out[rk]);
    if (was >= COLD_CALL_FLOOR_COMBOS) continue;
    const r = LOCKS.ranges[key];
    if (out === a.ranges) out = { ...a.ranges };
    out[rk] = { ...(r.weights as ClassRange) };
    applied.push({ pos: c.pos, key, stack: Math.round(stack * 10) / 10, freq: r.freq, calls: r.calls, was, now: combosOf(out[rk]) });
  }
  return { ranges: out, applied };
}

export const poolColdCallFloorNote = (applied: ColdCallFloorRecord[], source: string | null): string =>
  `POOL COLD-CALL RANGE: ${applied.map((r) => `the ${r.pos} (${Math.round(r.stack)}bb) cold-called the 3-bet — ${r.was} combos on ${source ?? "the preflop tree"}, `
    + `now the pool's ${r.key} (${(100 * r.freq).toFixed(2)}% of chances, ${r.calls.toLocaleString("en-US")} cold-calls, ${r.now} combos)`).join("; ")}`;
