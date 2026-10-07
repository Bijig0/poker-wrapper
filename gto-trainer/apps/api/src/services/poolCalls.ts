/**
 * THE POOL'S CALLING RANGES WHERE THE TREE CANNOT HOLD THE LINE (2026-10-07, Brady's NARROW scope). GTO Wizard's AI
 * preflop tree holds ONE caller behind an open and ONE limper (three players to the flop; the cap cannot be switched
 * off — gtowAiPreflop's header). On every 4-way raised pot and every two-limper pot the pinned tree answers "'C' is not
 * offered" (fastSolve.pinMissProv → arrival:pin-cap) and each seat's flop-entering range is a FITTED read: the solver's
 * range on a neighbouring line that folds the earliest other caller (stress brief_I-002: UTG opens, BTN calls, SB
 * over-calls, hero BB calls — the SB entered the flop with 7.2 combos, 0.5%, as the lone caller of a line the table
 * never played; the caller-read research measured real Ignition callers at SB 11% vs the chart's 2%, a cold-caller 9% vs
 * 4%, the BB 34% vs 24%). Live: 73 of the 1,024 postflop answers since 2026-10-03 (27 hands) are this family.
 *
 * BRADY'S RULE: in these spots the CALLERS' ranges are the POOL's measured calling ranges, not the solver's
 * neighbouring-line ranges — "we should never be responding to a non-existent range". NARROW: only where the tree cannot
 * hold the line (the arrival came through gtowAiPreflop's per-seat fit); where it can, nothing changes. REPLACED
 * OUTRIGHT, not floored: the cold-call floor (poolColdCall) replaces a range under 13.26 combos because the tree's
 * cold-call is ~0% and the rest of the range is real; here the fitted ranges are "real but neighbouring" — a 7-combo SB
 * over-call is the solver's lone-caller range, not a thin tail of the right one — so the whole range is the pool's.
 * EVERY villain caller of the line is replaced, the first caller too (his own node the tree does hold): the table was
 * played by pool players throughout, and the preflop side (Part 3) locks the kept caller to the same pool range, so one
 * seat on GTO's range beside another on the pool's would answer a table nobody sat at. Hero's own range is NEVER
 * replaced. A raiser keeps the tree's range (the opener's root range is exact; a 3-bettor's is the tree's read).
 *
 * THE TABLE: poolCallLocks.json, a copy of poker analysis/pipeline/limp_study/locks_v2/poolcalls_locks.json
 * (build_poolcall_locks.py — the cold-call construction: frequency from every decision in the CoinPoker 9.1M-hand corpus,
 * shape from the calls seen at showdown, showdown bias corrected per hand group against Ignition's downloaded NL100/NL200
 * ring histories where every seat's cards show; own frequency with 50+ calls, own shape with 300+ shown, else the
 * parent's; water-filled so the frequency is exact). Keyed by LINE x SEAT x QUALIFIER x STACK BUCKET (le40 / 40_80 / 80p,
 * the caller's stack as dealt):
 *   flat      the first caller of an open (no limpers)          qual vs<OPENER seat>
 *   overcall  a caller of an open behind 1 / 2+ earlier callers  qual b1 / b2p   (the SB's and the BB's own keys)
 *   limpcall  a limper calling the iso raise                     qual l1 / l2p   (limpers in the pot)
 *   bbiso     the BB calling an iso raise over limpers           qual l1 / l2p
 *   sbiso     the SB completer calling an iso raise              qual l1 / l2p
 *   overlimp  an over-limp behind 2+ limps (behind 1 = the limp table's overlimp_deep)   qual b2p
 * poolCallKey picks the most specific key built: seat+line+qual(+open size)+stack → seat+line+qual → seat+line+stack →
 * seat+line → ALL seats+line+qual+stack → ALL+line+qual → ALL+line+stack → ALL+line (the seat before the qualifier: the
 * BB calls an open 34% of the time, a cold caller 9% — the seat is the larger effect). An open-size qualifier (_oS/_oM/_oL/_oXL) is tried first only when the
 * table says the split was adopted (`open_split_adopted`). Plain limps in a two-limper pot (first-in, over-limp behind one,
 * the SB's complete) are the LIMP table's (poolLimpLocks.v2.json: limp_first_*, overlimp_*, sbcomplete_*), deep keys
 * included — the short-limper floor (poolLimpFloor) already gave a short one his range and is not repeated.
 *
 * THE SWITCH, POOL_CALLS in the environment, read at every decision: on (unset) = the overlay; off = the fitted ranges as
 * before. Diagnostic: bun src/scripts/departuresReport.ts --id pool-call-ranges. Register entry pool-call-ranges.
 * Pure: ranges in, ranges out, and a record of what was replaced.
 */
import LOCKS from "./poolCallLocks.json";
import LIMP from "./poolLimpLocks.v2.json";
import { dealtByPos, SEATS6, type Seat6 } from "./hrc6max";
import { poolLimpKey } from "./poolLimpFloor";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

export type PoolCallLine = "flat" | "overcall" | "limpcall" | "bbiso" | "sbiso" | "overlimp" | "limp";
export type PoolCallsMode = "on" | "off";
export const poolCallsMode = (): PoolCallsMode => (String(process.env.POOL_CALLS ?? "on").trim().toLowerCase() === "off" ? "off" : "on");

/** one range of the table (the builder's schema) */
export interface PoolCallRange {
  line: string; seat: string; qual?: string | null; stack: string;
  freq: number; chances: number; calls: number; shown: number;
  shape_from: string; freq_from?: string;
  weights: Record<string, number>;
}
export interface PoolCallTable {
  stack_edges?: Record<string, [number, number | null]>;
  open_edges?: Record<string, [number, number | null]>;
  open_split_adopted?: boolean;
  ranges: Record<string, PoolCallRange>;
}
let table: PoolCallTable = LOCKS as unknown as PoolCallTable;
/** TEST HOOK (the tests are hermetic — they never read the shipped table): a table to use instead, null = the shipped one. */
export function setPoolCallTable(t: PoolCallTable | null): void { table = t ?? (LOCKS as unknown as PoolCallTable); }
export const poolCallTable = (): PoolCallTable => table;

const POSTS = new Set(["post-sb", "post-bb", "post", "post-dead", "ante"]);

/** A villain who CALLED preflop (and never raised): his line, as the table keys it. */
export interface PoolCaller {
  pos: Seat6;
  line: PoolCallLine;
  /** index of the call in hand.actions (the last call that set the line) */
  at: number;
  /** flat: the opener's seat */
  opener: Seat6 | null;
  /** overcall: callers of the open before him; limp lines: the limps before his (non-blind, hero's included — the limp
   *  table's count); iso lines: the limpers in the pot (the SB's complete included) */
  before: number;
  /** the open (or iso raise) as a multiple of the big blind, 0 when the line has none */
  openTo: number;
  /** he raised later in the preflop (his range is not a calling range) */
  raisedLater: boolean;
  /** his call was an all-in for less */
  allIn: boolean;
  /** the SB's complete (limp line) */
  complete: boolean;
}

/** Every villain caller of the preflop, in the order they acted — one record per seat (a limper who then calls the iso
 *  is a limpcall). A seat that raised later is marked, not dropped. Hero is never listed (his range is his own). */
export function poolCallersOf(hand: ParsedHand, heroPos: string | null): PoolCaller[] {
  const posOf = (seatId: number): Seat6 | null => {
    const p = String(seatId === hand.heroSeatId && heroPos ? heroPos : hand.positions?.[seatId] ?? "").toUpperCase() as Seat6;
    return SEATS6.includes(p) ? p : null;
  };
  const hero = posOf(hand.heroSeatId);
  const out: PoolCaller[] = [];
  const put = (c: PoolCaller) => { const i = out.findIndex((x) => x.pos === c.pos); if (i >= 0) out[i] = c; else out.push(c); };
  let raises = 0, high = 1, opener: Seat6 | null = null, openTo = 0, raiseTo = 0;
  const limpers: Seat6[] = [];       // every call before the first raise (the SB's complete included; the BB never calls there)
  let nonBlindLimps = 0;             // the limp table's count (hero's limp included)
  const callers1: Seat6[] = [];      // callers of the first raise (hero's included), in order
  (hand.actions ?? []).forEach((a, i) => {
    if (a.street !== "preflop" || POSTS.has(String(a.type))) return;
    const pos = posOf(a.seatId);
    if (!pos) return;
    const amt = Number(a.amount ?? 0);
    const isRaise = a.type === "raise" || a.type === "bet" || (a.type === "all-in" && amt > high + 1e-9);
    const isCall = a.type === "call" || (a.type === "all-in" && !isRaise);
    if (isRaise) {
      raises++; high = Math.max(high, amt); raiseTo = amt;
      if (raises === 1) { opener = pos; openTo = amt; }
      const c = out.find((x) => x.pos === pos);
      if (c) c.raisedLater = true;
      return;
    }
    if (!isCall) return;
    const allIn = a.type === "all-in";
    if (raises === 0) {
      if (pos === "BB") return;                    // the BB's "call" before any raise is his check
      if (pos !== hero) {
        put({ pos, line: pos === "SB" ? "limp" : nonBlindLimps >= 2 ? "overlimp" : "limp", at: i, opener: null, before: nonBlindLimps, openTo: 0,
              raisedLater: false, allIn, complete: pos === "SB" });
      }
      limpers.push(pos);
      if (pos !== "SB") nonBlindLimps++;
      return;
    }
    if (raises === 1) {
      const before = callers1.length;
      if (pos !== hero) {
        if (limpers.length) {
          if (limpers.includes(pos)) put({ pos, line: pos === "SB" ? "sbiso" : "limpcall", at: i, opener, before: limpers.length, openTo: raiseTo, raisedLater: false, allIn, complete: pos === "SB" });
          else if (pos === "BB") put({ pos, line: "bbiso", at: i, opener, before: limpers.length, openTo: raiseTo, raisedLater: false, allIn, complete: false });
          // a cold call of an iso raise: no range measured — the fitted read stands
        } else {
          put({ pos, line: before === 0 ? "flat" : "overcall", at: i, opener, before, openTo, raisedLater: false, allIn, complete: false });
        }
      }
      callers1.push(pos);
      return;
    }
    // a call of a 3-bet or later: the cold-call table (poolColdCall) or the tree — not this overlay
  });
  return out;
}

/** the open as a multiple of the big blind → the table's size qualifier, when the split was adopted */
function openQual(openTo: number): string | null {
  if (!table.open_split_adopted || !table.open_edges || !(openTo > 0)) return null;
  for (const [k, [lo, hi]] of Object.entries(table.open_edges)) if (openTo >= lo && (hi == null || openTo < hi)) return k;
  return null;
}
const stackBucket = (stack: number): string | null => (!(stack > 0) ? null : stack < 40 ? "le40" : stack < 80 ? "40_80" : "80p");

export interface PoolCallKey { table: "call" | "limp"; key: string }

/**
 * The pool range for this caller at this stack: the most specific key built (the header's order). Limp lines go to the
 * limp table (short: as poolLimpFloor picks it; deep: the `_deep` keys); an over-limp behind 2+ limps takes this table's
 * overlimp key when it exists, else the limp table's. null = no range measured (the fitted read stands).
 */
export function poolCallKey(c: Pick<PoolCaller, "pos" | "line" | "opener" | "before" | "openTo" | "complete">, stack: number): PoolCallKey | null {
  const has = (k: string) => k in table.ranges;
  const b = stackBucket(stack);
  if (c.line === "limp" || c.line === "overlimp") {
    if (c.line === "overlimp" && !c.complete) {
      for (const k of [b ? `poolcall_overlimp_${c.pos}_b2p_${b}` : null, `poolcall_overlimp_${c.pos}_b2p`, b ? `poolcall_overlimp_ALL_b2p_${b}` : null, "poolcall_overlimp_ALL_b2p"])
        if (k && has(k)) return { table: "call", key: k };
    }
    const short = poolLimpKey({ limpsBefore: c.before, complete: c.complete }, stack);
    if (short) return { table: "limp", key: short };
    if (!(stack > 0)) return null;
    const deep = c.complete
      ? (c.before >= 3 ? "sbcomplete_b3" : c.before === 0 ? "sbcomplete_fold_deep" : `sbcomplete_b${c.before}_deep`)
      : (c.before === 0 ? "limp_first_deep" : "overlimp_deep");
    return deep in LIMP.ranges ? { table: "limp", key: deep } : null;
  }
  const qual = c.line === "flat" ? (c.opener ? `vs${c.opener}` : null)
    : c.line === "overcall" ? (c.before >= 2 ? "b2p" : "b1")
    : (c.before >= 2 ? "l2p" : "l1");
  const o = openQual(c.openTo);
  const cands = [
    qual && o && b ? `poolcall_${c.line}_${c.pos}_${qual}_${o}_${b}` : null,
    qual && o ? `poolcall_${c.line}_${c.pos}_${qual}_${o}` : null,
    qual && b ? `poolcall_${c.line}_${c.pos}_${qual}_${b}` : null,
    qual ? `poolcall_${c.line}_${c.pos}_${qual}` : null,
    b ? `poolcall_${c.line}_${c.pos}_${b}` : null,
    `poolcall_${c.line}_${c.pos}_all`,
    `poolcall_${c.line}_${c.pos}`,
    qual && b ? `poolcall_${c.line}_ALL_${qual}_${b}` : null,
    qual ? `poolcall_${c.line}_ALL_${qual}` : null,
    b ? `poolcall_${c.line}_ALL_${b}` : null,
    `poolcall_${c.line}_ALL_all`,
    `poolcall_${c.line}_ALL`,
  ];
  for (const k of cands) if (k && has(k)) return { table: "call", key: k };
  return null;
}

type ClassRange = Record<string, number>;
const classCombos = (c: string): number => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
const combosOf = (r: ClassRange | undefined): number =>
  Math.round(Object.entries(r ?? {}).reduce((s, [c, w]) => s + (Number(w) > 0 ? Number(w) * classCombos(c) : 0), 0) * 100) / 100;

/** a key's range and its measurement, from whichever table holds it */
export function poolCallRange(k: PoolCallKey): { weights: ClassRange; freq: number; calls: number; shown: number | null } | null {
  if (k.table === "limp") {
    const r = (LIMP.ranges as Record<string, { freq: number; n: number; weights: ClassRange }>)[k.key];
    return r ? { weights: r.weights, freq: r.freq, calls: r.n, shown: null } : null;
  }
  const r = table.ranges[k.key];
  return r ? { weights: r.weights, freq: r.freq, calls: r.calls, shown: r.shown } : null;
}

export interface PoolCallRecord {
  pos: Seat6; line: PoolCallLine; key: string; table: "call" | "limp";
  /** his stack as dealt (bb) */
  stack: number;
  freq: number; calls: number;
  /** combos before (the fitted read) and after (the pool's) */
  was: number; now: number;
  /** what he did, for the note */
  did: string;
}

const didText = (c: PoolCaller): string => {
  switch (c.line) {
    case "flat": return `flat-called the ${c.opener ?? "?"}'s open`;
    case "overcall": return `over-called the open behind ${c.before} caller${c.before === 1 ? "" : "s"}`;
    case "limpcall": return `limped and called the iso over ${c.before} limper${c.before === 1 ? "" : "s"}`;
    case "bbiso": return `called the iso from the big blind over ${c.before} limper${c.before === 1 ? "" : "s"}`;
    case "sbiso": return `completed and called the iso over ${c.before} limper${c.before === 1 ? "" : "s"}`;
    case "overlimp": return `over-limped behind ${c.before} limps`;
    case "limp": return c.complete ? (c.before ? `completed behind ${c.before} limp${c.before === 1 ? "" : "s"}` : "completed the small blind") : (c.before ? `over-limped behind ${c.before} limp` : "limped first in");
  }
};

/**
 * THE OVERLAY: every villain caller of the line (no raise after, not an all-in for less, not in `skip`) whose line the
 * pool table measured enters the flop with the pool's range for his seat, line and stack. Called only when the arrival
 * ranges came from the exact tree's per-seat FIT (the tree cannot hold the line) — the caller's decision, not this one.
 */
export function applyPoolCallRanges(a: {
  hand: ParsedHand; heroPos: string | null; ranges: Record<string, ClassRange>; dealt?: Record<number, number>;
  /** seats already given a pool range this arrival (the limp floor, the cold-call floor, a pinned lock) — left as they are */
  skip?: readonly string[];
}): { ranges: Record<string, ClassRange>; applied: PoolCallRecord[] } {
  const byPos = dealtByPos(a.hand, a.heroPos, a.dealt);
  const skip = new Set((a.skip ?? []).map((s) => s.toUpperCase()));
  const applied: PoolCallRecord[] = [];
  let out = a.ranges;
  for (const c of poolCallersOf(a.hand, a.heroPos)) {
    if (c.raisedLater || c.allIn || skip.has(c.pos)) continue;
    const rk = Object.keys(out).find((p) => p.toUpperCase() === c.pos);
    if (!rk) continue;                           // not at the flop
    const stack = Number(byPos[c.pos] ?? NaN);
    const k = poolCallKey(c, stack);
    if (!k) continue;
    const r = poolCallRange(k);
    if (!r) continue;
    const was = combosOf(out[rk]);
    if (out === a.ranges) out = { ...a.ranges };
    out[rk] = { ...r.weights };
    applied.push({ pos: c.pos, line: c.line, key: k.key, table: k.table, stack: Math.round(stack * 10) / 10, freq: r.freq, calls: r.calls, was, now: combosOf(out[rk]), did: didText(c) });
  }
  return { ranges: out, applied };
}

/** The answer's note (its opening is the register entry's `warn`; the hand page and the mutation oracle parse it). */
export const poolCallNote = (applied: PoolCallRecord[], source: string | null): string =>
  `POOL CALL RANGE: ${applied.map((r) => `the ${r.pos} (${Math.round(r.stack)}bb) ${r.did} — ${r.was} combos on ${source ?? "the preflop tree"}, `
    + `now the pool's ${r.key} (${(100 * r.freq).toFixed(2)}% of chances, ${r.calls.toLocaleString("en-US")} calls measured, ${r.now} combos)`).join("; ")}`
  + " — the tree cannot hold this line, so the callers hold the pool's measured ranges, not the solver's neighbouring-line ones";
