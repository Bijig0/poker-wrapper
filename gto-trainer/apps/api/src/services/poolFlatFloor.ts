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
 * defend against the pool's 49% with a different hand mix is (divergence — the calibration's +1.69 nats a hand) ONLY
 * with the divergence arm on: it is OFF by default since 2026-10-10 (poolTrigger's header — the call table's counts
 * are CoinPoker's, so its evidence test is vacuous), and this floor then fills residue callers only.
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
 *
 * THE SB'S FLAT, TABLE v2 (2026-10-10, services/poolSbFlat — register entry pool-sbflat-v2): with SB_FLAT_TABLE=v2 the
 * SB who flatted an open (line "flat", pos SB — the node the table was built on: one raise, nobody limped or called
 * before him) takes the Ignition-first SB-flat table instead of the call table's cell: the key from his opener, the
 * open's raise-to, his stack as dealt and, when the caller passes his seat's history (`seen`, seatStats), his VPIP;
 * the trigger's pool rate is that cell's NL200 freq and its evidence bound the cell's IGNITION calls / chances (the
 * first family whose counts are Ignition's own — the CI binds there: a 14-chance VPIP cell rarely clears the
 * divergence arm; the residue arm is unchanged). The note's clause carries "sbflat v2" (+ " own" under
 * SB_FLAT_OWN_FACTOR=on), the key, the Ignition counts and the vpip ("vpip v30 (n=…, v=…, …%)" / "vpip unknown
 * (n=…)"); rangeOracle.poolFloorsOf reads it back to this table. An all-in open is outside the table's node: today's
 * cell stands there. Default (unset / off): today's cell, byte for byte.
 */
import { dealtByPos, type Seat6 } from "./hrc6max";
import { poolCallKey, poolCallRange, poolCallersOf, type PoolCaller, type PoolCallLine } from "./poolCalls";
import { combosOfRange, klGroup, poolCiLower, shouldReplace, type ClassRange, type TriggerWhy } from "./poolTrigger";
import { sbFlatKey, sbFlatRange, sbFlatTableMode, sbFlatVpipText, type SbFlatKey } from "./poolSbFlat";
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
  /** the SB's flat read on the SB-flat table v2 (SB_FLAT_TABLE=v2) */
  sbflat?: SbFlatUse;
}
/** What the SB-flat table v2 was asked and answered (the note, the [sbflat] log line). */
export interface SbFlatUse {
  chain: SbFlatKey["chain"]; step: number; fields: SbFlatKey["fields"];
  /** "vpip v30 (n=45, v=10, 24.4%)" / "vpip unknown (n=12)" / "vpip unknown (no seat history)" */
  vpip: string;
  /** the cell's Ignition chances (its calls are the record's) */
  chances: number;
  /** SB_FLAT_OWN_FACTOR applied */
  own: boolean;
  /** the open's raise-to (bb) */
  openTo: number;
}
/** A caller the floor looked at and left (the trigger did not fire) — for the log. */
export interface PoolFlatFloorKept { pos: Seat6; key: string; was: number; text: string; sbflat?: SbFlatUse }

const r2 = (x: number) => Math.round(x * 100) / 100;
const didText = (c: PoolCaller): string =>
  c.line === "flat" ? (c.pos === "BB" ? `defended the BB against the ${c.opener ?? "?"}'s open` : `flat-called the ${c.opener ?? "?"}'s open`)
    : c.line === "overcall" ? `over-called the open behind ${c.before} caller${c.before === 1 ? "" : "s"}`
      : `called the iso from the big blind over ${c.before} limper${c.before === 1 ? "" : "s"}`;

export function applyPoolFlatFloor(a: {
  hand: ParsedHand; heroPos: string | null; ranges: Record<string, ClassRange>; dealt?: Record<number, number>;
  /** seats already given a pool range this arrival (the limp floor, the cold-call floor, a pinned lock) — left as they are */
  skip?: readonly string[];
  /** each villain seat's history at this table (seatStats.seatHistoryFor, by position): the SB-flat table v2's VPIP */
  seen?: Partial<Record<string, { n: number; v: number } | null>>;
}): { ranges: Record<string, ClassRange>; applied: PoolFlatFloorRecord[]; kept: PoolFlatFloorKept[] } {
  const byPos = dealtByPos(a.hand, a.heroPos, a.dealt);
  // measured 5-6 handed; 3-4 handed is still far closer to it than residue; heads-up is another game
  if (Object.keys(byPos).length < 3) return { ranges: a.ranges, applied: [], kept: [] };
  const skip = new Set((a.skip ?? []).map((s) => s.toUpperCase()));
  const applied: PoolFlatFloorRecord[] = [];
  const kept: PoolFlatFloorKept[] = [];
  let out = a.ranges;
  const sbv2 = sbFlatTableMode() === "v2" && !openWasAllIn(a.hand);
  for (const c of poolCallersOf(a.hand, a.heroPos)) {
    if (!FLAT_FLOOR_LINES.includes(c.line) || c.raisedLater || c.calledLater || c.allIn || skip.has(c.pos)) continue;
    const rk = Object.keys(out).find((p) => p.toUpperCase() === c.pos);
    if (!rk) continue;                                            // not at the flop
    const stack = Number(byPos[c.pos] ?? NaN);
    let k: { key: string };
    let r: { weights: ClassRange; freq: number; calls: number; chances?: number } | null;
    let sb: SbFlatUse | undefined;
    if (sbv2 && c.line === "flat" && c.pos === "SB") {
      // THE SB-FLAT TABLE v2: his key from the opener, the open, his stack as dealt and his VPIP at this table
      const sk = sbFlatKey({ opener: c.opener, openTo: c.openTo, stack, seen: a.seen?.SB ?? null });
      const sr = sbFlatRange(sk.key);
      if (!sr) continue;
      k = { key: sk.key };
      r = { weights: sr.weights, freq: sr.freq, calls: sr.calls, chances: sr.chances };   // Ignition's counts: the CI
      sb = { chain: sk.chain, step: sk.step, fields: sk.fields, vpip: sbFlatVpipText(sk), chances: sr.chances, own: sr.own, openTo: c.openTo };
    } else {
      const ck = poolCallKey(c, stack);
      if (!ck || ck.table !== "call") continue;
      k = ck;
      r = poolCallRange(ck);
    }
    if (!r) continue;
    const walked = out[rk] ?? {};
    const was = r2(combosOfRange(walked));
    const f = was / 1326;
    const t = shouldReplace({
      fSolver: f, fPool: r.freq, poolCI: poolCiLower({ calls: r.calls, chances: r.chances ?? null }), countsFrom: "pool",
      groupKL: was > 0 ? klGroup(r.weights, walked) : null, line: "preflop", reach: f,
    });
    if (!t.fire || !t.why) { kept.push({ pos: c.pos, key: k.key, was, text: t.text, ...(sb ? { sbflat: sb } : {}) }); continue; }
    if (out === a.ranges) out = { ...a.ranges };
    out[rk] = { ...r.weights };
    applied.push({ pos: c.pos, line: c.line, key: k.key, stack: Math.round(stack * 10) / 10, freq: r.freq, calls: r.calls,
      was, now: r2(combosOfRange(out[rk])), did: didText(c), why: t.why, text: t.text, ...(sb ? { sbflat: sb } : {}) });
  }
  return { ranges: out, applied, kept };
}

/** The open was an all-in (outside the SB-flat table's node: the builder left those out). */
function openWasAllIn(hand: ParsedHand): boolean {
  for (const x of hand.actions ?? []) {
    if (x.street !== "preflop") continue;
    const amt = Number(x.amount ?? 0);
    if (x.type === "raise" || x.type === "bet") return false;
    if (x.type === "all-in" && amt > 1 + 1e-9) return true;
  }
  return false;
}

/** the record's clause after "now the pool's <key> (" — the SB-flat table v2's names its table, counts and vpip */
const cellText = (r: PoolFlatFloorRecord): string => r.sbflat
  ? `sbflat v2${r.sbflat.own ? " own" : ""}: ${(100 * r.freq).toFixed(2)}% of chances${r.sbflat.own ? " (own NL200 factor)" : ""}, ${r.calls.toLocaleString("en-US")} calls measured of ${r.sbflat.chances.toLocaleString("en-US")} Ignition chances, ${r.sbflat.vpip}, ${r.now} combos; trigger ${r.text}`
  : `${(100 * r.freq).toFixed(2)}% of chances, ${r.calls.toLocaleString("en-US")} calls measured, ${r.now} combos; trigger ${r.text}`;

/** The answer's note (its opening is the register entry's `warn`; the hand page and the mutation oracle parse it). */
export const poolFlatFloorNote = (applied: PoolFlatFloorRecord[], source: string | null): string =>
  `POOL FLAT RANGE: ${applied.map((r) => `the ${r.pos} (${Math.round(r.stack)}bb) ${r.did} — ${r.was} combos on ${source ?? "the preflop tree"}, `
    + `now the pool's ${r.key} (${cellText(r)})`).join("; ")}`
  + " — the solver's range for the call failed the trigger rule (residue, or far from the pool's), so the caller holds the pool's measured calling range";
