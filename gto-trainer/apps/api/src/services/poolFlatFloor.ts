/**
 * THE POOL FLAT FLOOR (2026-10-09, phase two of the range-coverage work — memory range-coverage-audit / trigger-rule).
 * The audit's biggest live gap: an SB who FLATS an open at 40bb or less enters the flop with 0.1-0.4 combos (the solver
 * 3-bets or folds there; the pool flats 28.6% of hands — `poolcall_flat_SB_*_le40` exists), and every later street
 * narrows that residue to nothing. The pool-call overlay (services/poolCalls) replaces callers only on the lines the AI
 * tree cannot hold (arrival:pin-cap); on a line a chart or the tree DOES hold, the residue stood. Same family: a short
 * cold-call of an open (a deep caller against a short opener too), the BB's call of an iso over one limper, a blind's
 * over-call.
 *
 * THE RULE: at the flop, on EVERY line (the chart walk and the AI tree's, not only pin-cap), each villain CALLER the pool
 * call table measures — a flat of an open (the BB's defend included), an over-call behind 1 / 2+ callers, the BB's call
 * of an iso — whose flop-entering range FAILS the trigger rule (services/poolTrigger.shouldReplace) holds the pool's
 * cell instead. His only voluntary preflop action is that call, so his combos / the 1,326 he was dealt is exactly the
 * solver's calling share implied by the walk: fSolver = reach = combos / 1,326; fPool = the cell's rate; the evidence
 * = the cell's (calls, chances) Wilson bound; the shape = KL(cell ‖ his walked range) over the 8 hand groups. So a 0.3-
 * combo SB flat (residue) is replaced; a BB defending 40% where the pool defends 45% is not (no divergence); a 16% BB
 * defend against the pool's 49% with a different hand mix is (divergence — the calibration's +1.69 nats a hand).
 * REPLACED by the cell, not floored, as the pool-call overlay does: the flat cells are P(call | dealt, hand) over all
 * hands — no earlier voluntary action of his to condition on, so the cell IS his holding. NOT here: a limper's call of
 * the iso and the SB completer's (limpcall / sbiso: the limp floor's limp × call product), a plain limp (the limp floor),
 * a cold-call of a 3-bet (the cold-call floor), a caller who raised or CALLED AGAIN later (no cell for flat-then-call-a-
 * 3-bet: flag only, per the rule), an all-in for less, a seat another floor or a pinned lock already gave a pool range
 * (`skip`), hero. On the pin-cap lines the structural pool-call overlay runs instead (fastSolve: this floor stands down
 * there while POOL_CALLS is on).
 *
 * THE SWITCH, POOL_FLAT_FLOOR in the environment, read at every decision: on (unset) | off. The trigger's own switches
 * (POOL_TRIGGER_K, POOL_TRIGGER_DIVERGENCE, POOL_TRIGGER_LINE_GUARD) apply. Register entry pool-flat-floor, path code
 * arrival:pool-flat-floor, note "POOL FLAT RANGE:" (rangeOracle.poolFloorsOf reads it back). Pure: ranges in, ranges
 * out, and a record of what was replaced.
 */
import { dealtByPos, type Seat6 } from "./hrc6max";
import { poolCallKey, poolCallRange, poolCallersOf, type PoolCaller, type PoolCallLine } from "./poolCalls";
import { combosOfRange, klGroup, poolCiLower, shouldReplace, type ClassRange, type TriggerWhy } from "./poolTrigger";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

export type PoolFlatFloorMode = "on" | "off";
export const poolFlatFloorMode = (): PoolFlatFloorMode =>
  /^(off|0|false|no)$/i.test(String(process.env.POOL_FLAT_FLOOR ?? "on").trim()) ? "off" : "on";

/** the lines this floor takes (the call table's lines with no earlier voluntary action of the caller's) */
export const FLAT_FLOOR_LINES: readonly PoolCallLine[] = ["flat", "overcall", "bbiso"];

export interface PoolFlatFloorRecord {
  pos: Seat6; line: PoolCallLine; key: string;
  /** his stack as dealt (bb) */
  stack: number;
  freq: number; calls: number;
  /** combos before (the walk's) and after (the pool cell's) */
  was: number; now: number;
  /** what he did, for the note */
  did: string;
  /** which arm of the trigger fired, and its numbers */
  why: Exclude<TriggerWhy, null>; text: string;
}
/** A caller the floor looked at and left (the trigger did not fire) — for the log. */
export interface PoolFlatFloorKept { pos: Seat6; key: string; was: number; text: string }

const r2 = (x: number) => Math.round(x * 100) / 100;
const didText = (c: PoolCaller): string =>
  c.line === "flat" ? (c.pos === "BB" ? `defended the BB against the ${c.opener ?? "?"}'s open` : `flat-called the ${c.opener ?? "?"}'s open`)
    : c.line === "overcall" ? `over-called the open behind ${c.before} caller${c.before === 1 ? "" : "s"}`
      : `called the iso from the big blind over ${c.before} limper${c.before === 1 ? "" : "s"}`;

export function applyPoolFlatFloor(a: {
  hand: ParsedHand; heroPos: string | null; ranges: Record<string, ClassRange>; dealt?: Record<number, number>;
  /** seats already given a pool range this arrival (the limp floor, the cold-call floor, a pinned lock) — left as they are */
  skip?: readonly string[];
}): { ranges: Record<string, ClassRange>; applied: PoolFlatFloorRecord[]; kept: PoolFlatFloorKept[] } {
  const byPos = dealtByPos(a.hand, a.heroPos, a.dealt);
  // measured 5-6 handed; 3-4 handed is still far closer to it than residue; heads-up is another game
  if (Object.keys(byPos).length < 3) return { ranges: a.ranges, applied: [], kept: [] };
  const skip = new Set((a.skip ?? []).map((s) => s.toUpperCase()));
  const applied: PoolFlatFloorRecord[] = [];
  const kept: PoolFlatFloorKept[] = [];
  let out = a.ranges;
  for (const c of poolCallersOf(a.hand, a.heroPos)) {
    if (!FLAT_FLOOR_LINES.includes(c.line) || c.raisedLater || c.calledLater || c.allIn || skip.has(c.pos)) continue;
    const rk = Object.keys(out).find((p) => p.toUpperCase() === c.pos);
    if (!rk) continue;                                            // not at the flop
    const stack = Number(byPos[c.pos] ?? NaN);
    const k = poolCallKey(c, stack);
    if (!k || k.table !== "call") continue;
    const r = poolCallRange(k);
    if (!r) continue;
    const walked = out[rk] ?? {};
    const was = r2(combosOfRange(walked));
    const f = was / 1326;
    const t = shouldReplace({
      fSolver: f, fPool: r.freq, poolCI: poolCiLower({ calls: r.calls, chances: r.chances ?? null }),
      groupKL: was > 0 ? klGroup(r.weights, walked) : null, line: "preflop", reach: f,
    });
    if (!t.fire || !t.why) { kept.push({ pos: c.pos, key: k.key, was, text: t.text }); continue; }
    if (out === a.ranges) out = { ...a.ranges };
    out[rk] = { ...r.weights };
    applied.push({ pos: c.pos, line: c.line, key: k.key, stack: Math.round(stack * 10) / 10, freq: r.freq, calls: r.calls,
      was, now: r2(combosOfRange(out[rk])), did: didText(c), why: t.why, text: t.text });
  }
  return { ranges: out, applied, kept };
}

/** The answer's note (its opening is the register entry's `warn`; the hand page and the mutation oracle parse it). */
export const poolFlatFloorNote = (applied: PoolFlatFloorRecord[], source: string | null): string =>
  `POOL FLAT RANGE: ${applied.map((r) => `the ${r.pos} (${Math.round(r.stack)}bb) ${r.did} — ${r.was} combos on ${source ?? "the preflop tree"}, `
    + `now the pool's ${r.key} (${(100 * r.freq).toFixed(2)}% of chances, ${r.calls.toLocaleString("en-US")} calls measured, ${r.now} combos; trigger ${r.text})`).join("; ")}`
  + " — the solver's range for the call failed the trigger rule (residue, or far from the pool's), so the caller holds the pool's measured calling range";
