/**
 * THE REDUCED TREE — flop-entering ranges for a preflop line no tree of ours holds (2026-10-01, Brady: "I think this
 * is one of those issues that was just rare and I decided to put off till we faced it"; "I want this as well" — the
 * three-player version).
 *
 * Hand 4921846667: UTG limps, hero over-limps 77 (the limp chart's answer), the CO isolates, the BB and UTG call, hero
 * limp-reraises (the limp chart refused that node as untrained — it is reached 1 in 25,000,000 hands — so the GTO
 * Wizard AI tree answered, on a line FITTED to its one-limper cap: UTG read as folded), UTG calls and leads the flop.
 * The flop takes its ranges from the piece that answered last; that tree has no UTG in the pot; nothing fell back; no
 * answer, a timeout, a sit-out, and Ignition removed hero from the table.
 *
 * Every such spot still has one thing a tree CAN hold: the last raise, and each player who met it — and the exact tree
 * already solved for the hand holds most of what is around it. Every read below is on THAT tree (no tree is solved for
 * the reduced read), on the line cut where it is needed and, when the tree cannot hold the cut, fitted for that seat
 * (fitAiLine: the earliest other limper or caller folded out). services/gtowAiPreflop lastRaiseReads makes the reads.
 *
 *   THE RAISER's range is what he held before the raise (hero: what the chart told him; a limper: the pool's limp
 *   range; otherwise his range on the exact tree), narrowed by how the exact tree plays that raise from his seat
 *   (raiseFilter — the union of its raise sizes).
 *
 *   EACH CALLER (since 2026-10-04):
 *     hero        his starting range × his call as the exact tree plays it (callFilter); his starting range whole
 *                 when that cannot be read; his own hand is floored back in at 5%;
 *     all in for less than the raise: his starting range whole (the rest of a short stack in at a price nobody folds);
 *     a LIMPER    (cameInLimping — his first chip a call with no raise ahead, the SB's complete included): the pool's
 *                 limp range WHOLE, not narrowed (two independent studies found narrowing it did not help);
 *     any other   his range WALKED on the exact tree along the line fitted for him, through his own node, less the
 *                 hands that fold there (stayRange); when that cannot be read, his starting range whole. Never another
 *                 tree.
 *
 * WHY NOT THE FORCED-BET TREE IT REPLACES (2026-10-01 to 2026-10-04): each caller used to be read on a heads-up tree of
 * him and the raiser with the raise posted as a forced bet (offered as an action, the solver never took it — limp 73%,
 * jam 27%, raise 0% — so the caller's node behind it was untrained). GTO Wizard solves a preflop tree from FULL ranges
 * whatever a seat's `range` says (scripts/_probeForcedDecision.ts `range`, the record of those probes), so that caller
 * folded against ANY TWO CARDS posting the raise. Measured (scripts/callerReadStudy.ts, 65 villain calls on lines the
 * exact tree holds, the exact node as truth): the forced tree kept 84.5% of the caller's range where his node keeps
 * 35.7% — barely better than no narrowing (TV distance 55.2% against 58.6%).
 *
 * WHAT THE READ STILL GETS WRONG (the same study, measured): on the 22 non-limper calls read on a fitted line it keeps
 * 31.2% where the exact node keeps 18.2% — 13 points wide, TV 42.1% (the forced tree: 78.3%, TV 74.1%). Every fit
 * measured folded exactly ONE seat (GTO Wizard holds three to the flop); a real reduced spot folds more, and each fold
 * loosens the read — that is inferred, not measured. Limpers kept whole: their node keeps 55.5% (25 calls); worst, a
 * small blind who completed behind a limper keeps 1-24%. When nobody ahead of the caller needs folding, the read is his
 * own node — exact (17 of the 65).
 *
 * WHY "DID NOT FOLD", NOT "CALLED" (probed, scripts/_probeForcedRaise.ts): at these prices the solver often re-raises
 * where the player called. Which of the continuing hands a real player shoves and which he calls is not something the
 * solver's mix says about him — and one who flatted has shown he calls — so his range is every hand that continues.
 *
 * What it does NOT model, said in the answer's note: the folded players' cards; the calls between a player's entry
 * and the last raise where the pool's or the full range stands in; a limper's range is the pool's, not this player's.
 *
 * This file is the pure half: the plan (who met the last raise, at what price) and the limp test. The reads, the
 * starting ranges and the wiring are services/gtowAiPreflop.ts (reducedArrivalRanges, lastRaiseReads).
 */
import type { ParsedAction, ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";
import { allInCalls } from "../../feed/buildSolutionUrl/buildSolutionUrl";
import { dealtSeats } from "../dealtSeats/dealtSeats";
import { COMBOS, toClassWeights } from "../comboIndex/comboIndex";

/** First to act after the flop first. */
const POSTFLOP = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];

export interface ReducedSeat {
  /** the table's seat id and position name (upper case) */
  seat: number;
  pos: string;
  /** every chip it put in preflop (bb), and what it already had in when the last raise was made */
  putIn: number;
  prior: number;
}
export interface ReducedCaller extends ReducedSeat {
  /** what the call cost him, and the pot he called into (everything in before his answer, his own chips included) */
  toCall: number;
  potBefore: number;
}
export interface ReducedPlan {
  ok: true;
  /** every seat that sees the flop, in postflop order (table position names) */
  live: string[];
  raiser: ReducedSeat;
  raiseTo: number;
  /** in the order they sit after the flop */
  callers: ReducedCaller[];
  /** index into hand.actions of the last raise — a seat's earlier actions are what its starting range must cover */
  raiseIndex: number;
  potBb: number;
}

const isRaise = (a: ParsedAction, allInCallSet: Set<ParsedAction>) =>
  a.type === "raise" || a.type === "bet" || (a.type === "all-in" && !allInCallSet.has(a));
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Who met the last raise and at what price — or why the hand has no reduced tree. `heroPos`: hero's position name when
 * the positions map does not carry it.
 */
export function planReducedArrival(hand: ParsedHand, heroPos: string | null): ReducedPlan | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  const seatOf = (a: ParsedAction) => (a.hero ? hand.heroSeatId : a.seatId);
  const dealt = dealtSeats(hand, heroPos);
  const posOf = (seat: number): string | null => {
    const p = seat === hand.heroSeatId ? (heroPos ?? hand.positions?.[seat] ?? dealt.get(seat)) : (hand.positions?.[seat] ?? dealt.get(seat));
    return p ? String(p).toUpperCase() : null;
  };
  const calls = allInCalls(hand.actions);
  let raiseIndex = -1;
  hand.actions.forEach((a, i) => { if (a.street === "preflop" && isRaise(a, calls)) raiseIndex = i; });
  if (raiseIndex < 0) return no("nobody raised preflop — a limped pot has no last raise to reduce to");
  const raise = hand.actions[raiseIndex]!;
  const raiseTo = Number(raise.amount ?? 0);
  if (!(raiseTo > 1)) return no("the last raise carries no size");

  // each seat's chips in the pot after the first `upto` actions: a post / raise / all-in is the seat's total, a call
  // adds (gtowAiPreflop.preflopPutIn)
  const putAt = (upto: number): Map<number, number> => {
    const m = new Map<number, number>();
    for (const a of hand.actions.slice(0, upto)) {
      if (a.street !== "preflop") continue;
      const amt = Number(a.amount ?? 0);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      const s = seatOf(a);
      if (a.type === "call") m.set(s, (m.get(s) ?? 0) + amt);
      else if (a.type === "post-sb" || a.type === "post-bb" || a.type === "raise" || a.type === "bet" || a.type === "all-in") m.set(s, Math.max(m.get(s) ?? 0, amt));
    }
    return m;
  };
  const sum = (m: Map<number, number>) => [...m.values()].reduce((x, y) => x + y, 0);
  const put = putAt(hand.actions.length);
  const prior = putAt(raiseIndex);
  const potBb = sum(put);

  const pre = hand.actions.filter((a) => a.street === "preflop");
  const folded = new Set(pre.filter((a) => a.type === "fold").map(seatOf));
  const liveSeats = [...dealt.keys()].filter((s) => !folded.has(s) && posOf(s) != null && POSTFLOP.includes(posOf(s)!));
  // a seat that never put a chip in and never folded was not in the hand (a label with no action behind a raise)
  const inPot = liveSeats.filter((s) => (put.get(s) ?? 0) > 0);
  const aggSeat = seatOf(raise);
  if (!inPot.includes(aggSeat)) return no("the last raiser is not among the seats that reach the flop");
  if (inPot.length < 2) return no(`${inPot.length} player reaches the flop`);
  const byPostflop = (a: number, b: number) => POSTFLOP.indexOf(posOf(a)!) - POSTFLOP.indexOf(posOf(b)!);
  const live = inPot.slice().sort(byPostflop);
  if (new Set(live.map((s) => posOf(s))).size !== live.length) return no("two live seats carry the same position name");

  const seatRec = (s: number): ReducedSeat => ({ seat: s, pos: posOf(s)!, putIn: r2(put.get(s) ?? 0), prior: r2(prior.get(s) ?? 0) });
  const callers: ReducedCaller[] = live.filter((s) => s !== aggSeat).map((s) => {
    // the pot as HE met the raise: everything in before his own answer to it (an earlier caller's chips included)
    let answerIdx = -1;
    hand.actions.forEach((a, i) => { if (i > raiseIndex && a.street === "preflop" && seatOf(a) === s && answerIdx < 0) answerIdx = i; });
    const before = answerIdx >= 0 ? putAt(answerIdx) : putAt(raiseIndex + 1);
    const mine = before.get(s) ?? 0;
    const potBefore = sum(before);
    return {
      ...seatRec(s), prior: r2(mine),
      toCall: r2(Math.max(0, Math.min(raiseTo, put.get(s) ?? raiseTo) - mine)),
      potBefore: r2(potBefore),
    };
  });
  return { ok: true, live: live.map((s) => posOf(s)!), raiser: seatRec(aggSeat), raiseTo: r2(raiseTo), callers, raiseIndex, potBb: r2(potBb) };
}

/**
 * Did this seat come into the pot with a LIMP before the action at `upto` — its first voluntary chip a call with no
 * raise ahead of it (the small blind's complete counts)? Such a caller's range is the pool's limp range and is kept
 * whole when he calls the last raise (see the header).
 */
export function cameInLimping(hand: ParsedHand, seat: number, upto: number): boolean {
  const seatOf = (a: ParsedAction) => (a.hero ? hand.heroSeatId : a.seatId);
  const calls = allInCalls(hand.actions);
  const pre = hand.actions.slice(0, upto).map((a, i) => ({ a, i })).filter(({ a }) => a.street === "preflop");
  const first = pre.find(({ a }) => seatOf(a) === seat && ["call", "raise", "bet", "all-in"].includes(a.type));
  if (!first || !(first.a.type === "call" || calls.has(first.a))) return false;
  return !pre.some(({ a, i }) => i < first.i && isRaise(a, calls));
}

/** class → weight (0..1) as the 1,326 per-combo weights a tree's `range` takes; null in → null out (the full range). */
export function classesToCombos(cls: Record<string, number> | null | undefined): number[] | null {
  if (!cls) return null;
  const out = COMBOS.map((c) => { const w = Number(cls[c.cls] ?? 0); return Number.isFinite(w) && w > 0 ? Math.min(1, w) : 0; });
  return out.some((w) => w > 0) ? out : null;
}

/** A range scaled so its heaviest class is 1 — a starting range is a COMPOSITION (the pool limps AQs 25%, 72o 0.5%);
 *  left at its raw size the tree would treat the whole seat as almost never there. */
export function normalised(cls: Record<string, number>): Record<string, number> {
  const max = Math.max(0, ...Object.values(cls).map((w) => (Number.isFinite(w) ? w : 0)));
  if (!(max > 0)) return {};
  const out: Record<string, number> = {};
  for (const [k, w] of Object.entries(cls)) if (w > 0) out[k] = Math.round((w / max) * 1e4) / 1e4;
  return out;
}

/** 1,326 weights scaled so the heaviest is 1; null when nothing is left. */
export function normalisedCombos(w: readonly number[]): number[] | null {
  const max = Math.max(0, ...w);
  return max > 1e-9 ? w.map((x) => Math.round((Math.max(0, x) / max) * 1e4) / 1e4) : null;
}

const CLASS_COMBOS: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const c of COMBOS) out[c.cls] = (out[c.cls] ?? 0) + 1;
  return out;
})();

/** 1,326 weights as class → fraction of the class (the chart walk's shape); classes at zero are left out. */
export function combosToClasses(w: readonly number[]): Record<string, number> {
  const cw = toClassWeights(w);
  const rec: Record<string, number> = {};
  for (const [cls, v] of Object.entries(cw)) if (v.weight > 0) rec[cls] = Math.min(1, v.weight / (CLASS_COMBOS[cls] ?? v.combos));
  return rec;
}
