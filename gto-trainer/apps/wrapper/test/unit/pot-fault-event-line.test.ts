/**
 * THE POT FAULT THE EVENT LINE ANSWERS (2026-09-26, NL5 session_20260926_030543, hand 4920637334: hero 9♥K♠ in the
 * CO, BB calls, flop 7♣9♦7♥). Auto-execute played every preflop decision of the session and was HELD on every postflop
 * decision of six hands: the level reconciler never saw the BB's closing call (it was swept into the pot between two
 * 1-3 s feed ticks), its ledger stayed 1.6 BB short, "pot disagrees with the ledger" became /hand's lineUncertain, and
 * the relay held the pick until Brady pressed by hand. The event line /hand carried had the call and summed to the
 * table's pot. The ticks below are the recorded ones (debug/session_20260926_030543/log.jsonl seq 373-399).
 *
 * Also the hand's auto-execute log (autoLog.ts) — the hand page's "Auto-execute: worked, 1 try".
 */
import { expect, test } from "bun:test";
import { HandReconciler, makeTick, POT_HOLD } from "../../src/reconcile";
import { S, resetState } from "../../src/state";
import { lineChips, potFaultAnswered, reconciledLine } from "../../src/ignition/hand";
import * as AUTO from "../../src/autoLog";

const DEALT = [1, 3, 5, 6];
const HERO = 1;

function tick(seq: number, bets: Record<number, string>, pot: number | null, board: number, buttons: string[] = [],
              badges: Record<number, string> = {}, cards: Record<number, number> = {}) {
  const seats = new Map<number, any>();
  for (let n = 1; n <= 6; n++) {
    seats.set(n, { stack: "100 BB", bet: bets[n] ?? null, cards: cards[n] ?? (DEALT.includes(n) ? 2 : 0), hero: n === HERO, badge: badges[n] ?? null });
  }
  return makeTick({ seq, t: "", seats, pot, board, buttons: [...buttons], hero: HERO });
}

/** The hand as the reconciler saw it: the BB's call to 2.6 is never on screen. */
function k9Reconciler(): HandReconciler {
  const rc = new HandReconciler(12);
  let s = 0;
  const ob = (bets: Record<number, string>, pot: number | null, board: number, buttons: string[] = [],
              badges: Record<number, string> = {}, cards: Record<number, number> = {}) => rc.observe(tick(++s, bets, pot, board, buttons, badges, cards));
  ob({}, null, 0);
  ob({ 3: "0.4 BB", 5: "1 BB" }, 1.4, 0);
  ob({ 3: "0.4 BB", 5: "1 BB" }, 1.4, 0, [], {}, { 6: 0 });           // the HJ folds
  ob({ 3: "0.4 BB", 5: "1 BB" }, 1.4, 0, [], {}, { 6: 0 });
  ob({ 3: "0.4 BB", 5: "1 BB" }, 1.4, 0, ["FOLD", "CALL 1 BB", "RAISE TO 2 BB"], {}, { 6: 0 });
  ob({ 1: "2.6 BB", 3: "0.4 BB", 5: "1 BB" }, 4, 0, [], {}, { 6: 0 });
  ob({ 1: "2.6 BB", 3: "0.4 BB", 5: "1 BB" }, 4, 0, [], { 1: "RAISE", 3: "FOLD" }, { 3: 0, 6: 0 });
  ob({ 1: "2.6 BB", 3: "0.4 BB", 5: "1 BB" }, 4, 0, [], {}, { 3: 0, 6: 0 });
  // frame 389: the flop — the BB's call happened and was swept between two ticks (pot 5.6 less 1c of rake)
  ob({}, 5.4, 3, [], {}, { 3: 0, 6: 0 });
  ob({}, 5.4, 3, [], { 5: "CHECK" }, { 3: 0, 6: 0 });
  for (let i = 0; i < POT_HOLD + 2; i++) ob({}, 5.4, 3, ["CHECK", "BET 1 BB"], {}, { 3: 0, 6: 0 });
  return rc;
}

const row = (street: string, seatId: number, type: string, amount?: number) =>
  ({ seatId, hero: seatId === HERO, type, street, ...(amount !== undefined ? { amount } : {}) });

/** /hand's event line at hero's flop decision (the archived hand's own actions). */
const EVENT_LINE = [
  row("preflop", 3, "post-sb", 0.4), row("preflop", 5, "post-bb", 1), row("preflop", 6, "fold"),
  row("preflop", 1, "raise", 2.6), row("preflop", 3, "fold"), row("preflop", 5, "call", 1.6),
  row("flop", 5, "check"),
];

test("hand 4920637334: the reconciler's pot fault does not hold a pick whose line accounts for the pot", () => {
  resetState();
  const rc = k9Reconciler();
  const faults = rc.faults("flop").map((v) => v.what);
  // the failure as it happened: the reconciler's ledger is short by the BB's call
  expect(faults).toContain("pot disagrees with the ledger");
  expect(rc.faults("flop").find((v) => v.what === "pot disagrees with the ledger")).toMatchObject({ pot: 5.4, ledger: 4 });

  S.handNo = 12;
  Object.assign(S.shadow, { hand: 12, rc });
  S.ws.dealt = DEALT;
  const [acts, , uncertain, note, source] = reconciledLine(EVENT_LINE, HERO, "flop");
  expect(source).toBe("ws");
  expect(acts).toEqual(EVENT_LINE);
  expect(uncertain).toBeNull();                              // was "line uncertain — pot disagrees with the ledger"
  expect(note).toContain("pot disagrees with the ledger");   // still said — the reconciler's line is not swapped in

  // a line that really IS short (the same miss in the event log) still holds the pick
  const short = EVENT_LINE.filter((a) => !(a.seatId === 5 && a.type === "call"));
  const [, , stillUncertain] = reconciledLine(short, HERO, "flop");
  expect(stillUncertain).toBe("line uncertain — pot disagrees with the ledger");
});

test("lineChips / potFaultAnswered: levels per street, the table's pot less rake", () => {
  expect(lineChips(EVENT_LINE)).toBe(5.6);
  // hand 4920635822: SB raises to 5 from 0.4, BB and a limper call 4 each → 15; the flop showed 14.4 (rake 3c)
  const h3 = [row("preflop", 6, "post-sb", 0.4), row("preflop", 1, "post-bb", 1), row("preflop", 5, "call", 1),
              row("preflop", 6, "raise", 5), row("preflop", 1, "call", 4), row("preflop", 5, "call", 4), row("flop", 6, "check")];
  expect(lineChips(h3)).toBe(15);
  expect(potFaultAnswered(h3, 14.4, "flop")).toBe(true);
  expect(potFaultAnswered(h3, 11, "flop")).toBe(false);     // the reconciler's short ledger is not the table's pot
  expect(potFaultAnswered(h3, 16, "flop")).toBe(false);     // more on the table than the line: a lost action
  expect(potFaultAnswered(EVENT_LINE, 5.4, "flop")).toBe(true);
  expect(potFaultAnswered(EVENT_LINE, null, "flop")).toBe(false);
  expect(lineChips([row("preflop", 3, "post-sb")])).toBeNull();  // an unscaled money row cannot be summed
  // a turn bet in front counts (the client's "Total pot" includes it): 5.6 + 2 → table 7.4 before hero calls
  const turn = [...EVENT_LINE, row("flop", 1, "check"), row("turn", 5, "bet", 2)];
  expect(lineChips(turn)).toBe(7.6);
  expect(potFaultAnswered(turn, 7.4, "turn")).toBe(true);
});

test("the hand's auto-execute log: tries, outcome, holds", () => {
  AUTO.resetAutoLog();
  const k1 = '12|["preflop","K9",1,0,4]';
  const k2 = '12|["flop","K9",1,0,7]';
  const k3 = '12|["turn","K9",1,0,9]';
  AUTO.notePress(k1, { pick: "Raise 2.5", source: "auto", ok: false, reason: "the bet field read 2.0" });
  AUTO.notePress(k1, { pick: "Raise 2.5", source: "auto", ok: true });
  AUTO.noteOutcome(k1, "confirmed", null, "raise 2.6");
  AUTO.noteHeld(k2, "line uncertain — pot disagrees with the ledger", "CHECK");
  AUTO.noteResumed(k2, 1.26);
  AUTO.notePress(k2, { pick: "CHECK", source: "auto", ok: true });
  AUTO.noteOutcome(k2, "confirmed", null, "check");
  AUTO.noteHeld(k3, "line uncertain — pot disagrees with the ledger", "CALL 2");
  AUTO.noteNoAnswer(k3, "fold", true, "clock nearly out (3 s left) with the answer held");
  const log = AUTO.autoLogFor(12)!;
  expect(log.map((d) => [d.street, d.pick, d.tries, d.outcome])).toEqual([
    ["preflop", "Raise 2.5", 2, "confirmed"],
    ["flop", "CHECK", 1, "confirmed"],
    ["turn", "CALL 2", 0, "no-answer"],
  ]);
  expect(log[1]!.heldS).toBe(1.3);
  expect(log[2]!.held).toContain("pot disagrees");
  expect(log[2]!.did).toBe("fold");
  // the no-answer fold's own key (no answer at all) files under the same hand
  AUTO.noteNoAnswer("12|river|11", "check", true, "no answer after 30 s");
  expect(AUTO.autoLogFor(12)!.at(-1)).toMatchObject({ street: "river", outcome: "no-answer", did: "check" });
  expect(AUTO.autoLogFor(13)).toBeNull();
});
