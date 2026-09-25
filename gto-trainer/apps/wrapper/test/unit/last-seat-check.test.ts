/**
 * THE LAST SEAT STANDING NEVER CHECKS (2026-09-25). The level reconciler files a check for every live seat that has
 * not acted and owes nothing when a street closes (endStreet, "street-end") — and it filed one for the seat everyone
 * else had folded to: a walk's big blind (golden 20260920_131406 hand 51, 4919432644, ended 'preflop 3 check/street-end';
 * 20260923_020036 hand 3, 4919956824, hero's own walk) and the winner of a pot a card came after
 * (20260807_115240 hand 27, 4909420583: 'river 2 check/street-end' on a river dealt after the turn was won). Nobody is
 * left to check to. Most came from finish() at archive time — after the row's line was taken, so never archived, but
 * the live /hand of the ended hand showed them ("added: 3 check") and the shadow audit counted them as differences.
 *
 * The reconciler over ticks shaped like those hands; the same checks while TWO seats are live are still filed.
 */
import { expect, test } from "bun:test";
import { HandReconciler, makeTick } from "../../src/reconcile";
import { checker, J } from "./helpers";

/** A table of `nums`, one reconciler; `ob` feeds a tick (every seat 2 cards unless `cards` says otherwise). */
function table(nums: number[], hero: number | null) {
  const rc = new HandReconciler(1);
  let q = 0;
  const ob = (bets: Record<number, string>, pot: number | null, cards: Record<number, number> = {}, board = 0) => {
    const seats = new Map<number, any>();
    for (const n of nums) seats.set(n, { stack: "100 BB", bet: bets[n] ?? null, cards: cards[n] ?? 2, hero: n === hero, badge: null });
    rc.observe(makeTick({ seq: ++q, t: "", seats, pot, board, buttons: [], hero }));
  };
  const line = () => rc.line().map((a) => [a.street, a.seat, a.type, a.via]);
  return { rc, ob, line };
}

test("a walk: the big blind everyone folded to files no check (4919956824, hero's big blind, small blind never read)", () => {
  const { fails, check } = checker();
  const { rc, ob, line } = table([1, 2, 4], 4);
  ob({}, null);
  ob({ 4: "1 BB" }, 1.0);                                                          // the big blind; no small blind read
  ob({ 4: "1 BB" }, 1.0, { 1: 0 }); ob({ 4: "1 BB" }, 1.0, { 1: 0 });              // seat 1 folds
  ob({ 4: "1 BB" }, 1.0, { 1: 0, 2: 0 }); ob({ 4: "1 BB" }, 1.0, { 1: 0, 2: 0 });  // seat 2 folds: hero's walk
  rc.finish(rc.prev!.seq);
  const want = [["preflop", 4, "post-bb", "level"], ["preflop", 1, "fold", "cards"], ["preflop", 2, "fold", "cards"]];
  check("the line ends at the last fold — no 'preflop 4 check/street-end'", J(line()) === J(want), J(line()));
  check("  and it is well formed: nothing broke an invariant", rc.violations.length === 0, J(rc.violations));
  expect(fails).toEqual([]);
});

test("a card after the pot is won files no check for the winner (4909420583); two live seats still check at a street's end", () => {
  const { fails, check } = checker();
  const { rc, ob, line } = table([2, 4, 6], null);
  ob({}, null);
  ob({ 6: "0.4 BB" }, 0.4);                                                        // small blind
  ob({ 6: "0.4 BB", 2: "1 BB" }, 1.4);                                             // big blind
  ob({ 6: "0.4 BB", 2: "1 BB" }, 1.4, { 4: 0 }); ob({ 6: "0.4 BB", 2: "1 BB" }, 1.4, { 4: 0 });  // seat 4 folds
  ob({ 6: "1 BB", 2: "1 BB" }, 2.0, { 4: 0 });                                     // the small blind completes
  ob({}, 2.0, { 4: 0 }, 3);                                                        // flop: the big blind checked its option
  ob({}, 2.0, { 4: 0 }, 4);                                                        // turn: both checked the flop
  ob({ 2: "1.5 BB" }, 3.5, { 4: 0 }, 4);                                           // seat 6 checks, seat 2 bets
  ob({ 2: "1.5 BB" }, 3.5, { 4: 0, 6: 0 }, 4); ob({ 2: "1.5 BB" }, 3.5, { 4: 0, 6: 0 }, 4);      // seat 6 folds: 2 wins
  ob({}, 3.5, { 4: 0, 6: 0 }, 4);                                                  // the pot goes to seat 2
  ob({}, 3.5, { 4: 0, 6: 0 }, 5);                                                  // a river card comes anyway
  rc.finish(rc.prev!.seq);
  const want = [["preflop", 6, "post-sb", "level"], ["preflop", 2, "post-bb", "level"], ["preflop", 4, "fold", "cards"],
                ["preflop", 6, "call", "level"], ["preflop", 2, "check", "street-end"],
                ["flop", 6, "check", "street-end"], ["flop", 2, "check", "street-end"],
                ["turn", 6, "check", "order"], ["turn", 2, "bet", "level"], ["turn", 6, "fold", "cards"]];
  check("the line ends at seat 6's fold — no river check by the winner", J(line()) === J(want), J(line()));
  check("the street-end checks filed while two seats were live are kept",
        line().filter(([, , t, via]) => t === "check" && via === "street-end").length === 3, J(line()));
  expect(fails).toEqual([]);
});
