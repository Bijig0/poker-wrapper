/**
 * Port of tests/test_reader_boundary.py — the street- and hand-boundary rules of the 2026-09-23 hardening pass:
 * the pot landing at a seat is the award, not a bet (621); a press redeemed at the street boundary lands on ITS
 * street (425/441); the cut-over refuses a derived line no table could have dealt; and an id-less hand takes its
 * id from the end-of-hand repeat / CO_LAST_HAND_NUMBER, never from the next hand (714).
 */
import { expect, test } from "bun:test";
import { HandReconciler, makeTick } from "../../src/reconcile";
import { S, resetState } from "../../src/state";
import { lineOrderFault, reconciledLine } from "../../src/ignition/hand";
import { beginHand, onGameMsg, wsSeams } from "../../src/ignition/ws";
import { checker, J, scratchDirs } from "./helpers";

const seat = (bet: string | null = null, cards = 2, hero = false, badge: string | null = null, stack = "100 BB") => ({ stack, bet, cards, hero, badge });

function tick(seq: number, bets: Record<number, string>, pot: number | null, board: number, buttons: string[] = [],
              badges: Record<number, string> = {}, cards: Record<number, number> = {}, hero = 6) {
  const seats = new Map<number, any>();
  for (let n = 1; n <= 6; n++) {
    const dealt = n === 1 || n === 6;
    seats.set(n, seat(bets[n] ?? null, cards[n] ?? (dealt ? 2 : 0), n === hero, badges[n] ?? null));
  }
  return makeTick({ seq, t: "", seats, pot, board, buttons: [...buttons], hero });
}

function riverCheckedThrough(): HandReconciler {
  const rc = new HandReconciler(1);
  let s = 0;
  const ob = (bets: Record<number, string>, pot: number | null, board: number, buttons: string[] = [], badges: Record<number, string> = {}) =>
    rc.observe(tick(++s, bets, pot, board, buttons, badges));
  ob({}, null, 0);
  ob({ 6: "0.5 BB", 1: "1 BB" }, 1.5, 0);
  ob({ 6: "0.5 BB", 1: "1 BB" }, 1.5, 0, ["FOLD", "CALL 0.5 BB", "RAISE TO 2 BB"]);
  ob({ 6: "0.5 BB", 1: "1 BB" }, 1.5, 0);
  ob({ 6: "2.5 BB", 1: "1 BB" }, 3.5, 0);
  ob({ 6: "2.5 BB", 1: "2.5 BB" }, 5.0, 0);
  ob({}, 5.0, 3, ["CHECK", "BET 1 BB"]);
  ob({}, 5.0, 3);
  ob({ 6: "1.3 BB" }, 6.3, 3);
  ob({ 6: "1.3 BB", 1: "1.3 BB" }, 7.6, 3);
  ob({}, 7.6, 4, ["CHECK", "BET 1 BB"]);
  ob({}, 7.6, 4);
  ob({}, 7.6, 4);
  ob({}, 7.6, 4, [], { 6: "CHECK" });
  ob({ 1: "2.4 BB" }, 10.0, 4);
  ob({ 1: "2.4 BB" }, 10.0, 4, ["FOLD", "CALL 2.4 BB", "RAISE TO 4.8 BB"]);
  ob({ 1: "2.4 BB" }, 10.0, 4);
  ob({ 1: "2.4 BB", 6: "2.4 BB" }, 12.4, 4);
  ob({}, 12.4, 5, ["CHECK", "BET 1 BB"]);
  ob({}, 12.4, 5);
  ob({}, 12.4, 5);
  ob({}, 12.4, 5, [], { 6: "CHECK" });
  ob({}, 12.4, 5, [], { 1: "CHECK" });
  return rc;
}

test("the street- and hand-boundary reader rules", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  scratchDirs();
  resetState();
  const log0 = console.log;
  console.log = () => {};
  const arch0 = wsSeams.archiveHand;
  try {
    // the pot landing at a seat is the award, not a bet (hand 621)
    let rc = riverCheckedThrough();
    const line0 = rc.line().map((a) => [a.street, a.seat, a.type]);
    eq("river so far: hero checked", line0[line0.length - 1], ["river", 6, "check"]);
    rc.observe(tick(99, { 6: "12.4 BB" }, null, 5, [], { 1: "CHECK" }));
    const line1 = rc.line().map((a) => J([a.street, a.seat, a.type]));
    eq("no hero bet was filed at the award", line1.includes(J(["river", 6, "bet"])), false);
    eq("no BB fold was filed at the award", line1.includes(J(["river", 1, "fold"])), false);
    eq("the hand ended at the award", rc.ended, true);

    // a real bet with the pot label still up is still a bet
    const rc3 = new HandReconciler(2);
    let s = 0;
    const ob3 = (bets: Record<number, string>, pot: number | null, board: number, buttons: string[] = [], badges: Record<number, string> = {}) =>
      rc3.observe(tick(++s, bets, pot, board, buttons, badges));
    ob3({}, null, 0); ob3({ 6: "0.5 BB", 1: "1 BB" }, 1.5, 0);
    ob3({ 6: "0.5 BB", 1: "1 BB" }, 1.5, 0, ["FOLD", "CALL 0.5 BB", "RAISE TO 2 BB"]); ob3({ 6: "0.5 BB", 1: "1 BB" }, 1.5, 0);
    ob3({ 6: "2.5 BB", 1: "1 BB" }, 3.5, 0); ob3({ 6: "2.5 BB", 1: "2.5 BB" }, 5.0, 0);
    ob3({}, 5.0, 3, ["CHECK", "BET 1 BB"]); ob3({}, 5.0, 3);
    ob3({ 6: "3.5 BB" }, 8.5, 3);
    const l3 = rc3.line();
    eq("a 70%-pot flop bet is filed as a bet", [l3[l3.length - 1]!.street, l3[l3.length - 1]!.seat, l3[l3.length - 1]!.type], ["flop", 6, "bet"]);
    eq("  and the hand goes on", rc3.ended, false);

    // a press redeemed at the street boundary lands on ITS street (425/441)
    const rc4 = new HandReconciler(3);
    const t4 = (seq: number, bets: Record<number, string>, pot: number | null, board: number, buttons: string[] = [], badges: Record<number, string> = {}) => {
      const seats = new Map<number, any>();
      for (let n = 1; n <= 6; n++) seats.set(n, seat(bets[n] ?? null, [1, 5, 6].includes(n) ? 2 : 0, n === 6, badges[n] ?? null));
      return makeTick({ seq, t: "", seats, pot, board, buttons, hero: 6 });
    };
    rc4.observe(t4(1, {}, null, 0));
    rc4.observe(t4(2, { 5: "0.5 BB", 6: "1 BB" }, 1.5, 0));
    rc4.observe(t4(3, { 5: "0.5 BB", 6: "1 BB", 1: "1 BB" }, 2.5, 0));
    rc4.observe(t4(4, { 5: "1 BB", 6: "1 BB", 1: "1 BB" }, 3.0, 0));
    rc4.observe(t4(5, { 5: "1 BB", 6: "1 BB", 1: "1 BB" }, 3.0, 0, ["CHECK", "RAISE TO 3 BB"]));
    rc4.observe(t4(6, { 5: "1 BB", 6: "1 BB", 1: "1 BB" }, 3.0, 0));
    rc4.observe(t4(7, {}, 3.0, 3));
    rc4.observe(t4(8, {}, 3.0, 3));
    rc4.observe(t4(9, {}, 3.0, 3));
    rc4.observe(t4(10, {}, 3.0, 3, [], { 5: "CHECK" }));
    rc4.observe(t4(11, {}, 3.0, 3, ["CHECK", "BET 1 BB"]));
    const line4 = rc4.line().map((a) => [a.street, a.seat, a.type] as [string, number, string]);
    eq("hero's option check is on the preflop street", line4.some((x) => J(x) === J(["preflop", 6, "check"])), true);
    eq("no hero check opens the flop", line4.filter((x) => x[0] === "flop").slice(0, 1), [["flop", 5, "check"]]);
    eq("hero checked exactly once so far", line4.filter((x) => x[1] === 6 && x[2] === "check").length, 1);

    // the cut-over's order rule
    const RC = (dealt: number[], sb: number, bbs: number) => ({ dealt: new Set(dealt), sb, bbs });
    const rc6 = RC([1, 5, 6], 5, 6);
    const good: any[] = [["preflop", 5, "post-sb", 0.5], ["preflop", 6, "post-bb", 1.0], ["preflop", 1, "call", 1.0],
                         ["preflop", 5, "call", 0.5], ["preflop", 6, "check", null],
                         ["flop", 5, "check", null], ["flop", 6, "check", null], ["flop", 1, "check", null]];
    eq("a well-ordered line passes", lineOrderFault(good, rc6), null);
    const bad425 = [...good.slice(0, 5), ["flop", 6, "check", null], ["flop", 5, "check", null], ["flop", 1, "check", null]] as any[];
    eq("hero opening the flop before the SB is refused", !!lineOrderFault(bad425, rc6), true);
    const rc7 = RC([1, 6], 6, 1);
    const hu: any[] = [["preflop", 6, "post-sb", 0.5], ["preflop", 1, "post-bb", 1.0], ["preflop", 6, "raise", 2.5], ["preflop", 1, "call", 1.5],
                       ["flop", 6, "bet", 1.3], ["flop", 1, "call", 1.3], ["river", 6, "check", null], ["river", 6, "bet", 11.8], ["river", 1, "fold", null]];
    const huF = lineOrderFault(hu, rc7);
    eq("heads-up order is not judged...", huF === null || huF.includes("twice"), true);
    eq("  ...but a seat acting twice running is", (huF || "").includes("twice"), true);
    const rc8 = RC([1, 2, 6], 6, 1);
    const foldThen: any[] = [["preflop", 6, "post-sb", 0.5], ["preflop", 1, "post-bb", 1.0], ["preflop", 2, "raise", 2.5],
                             ["preflop", 6, "call", 2.0], ["preflop", 1, "call", 1.5],
                             ["flop", 6, "check", null], ["flop", 1, "check", null], ["flop", 2, "bet", 3.0], ["flop", 6, "fold", null], ["flop", 1, "call", 3.0],
                             ["turn", 1, "check", null], ["turn", 2, "check", null]];
    eq("a folded seat is skipped when the next street opens", lineOrderFault(foldThen, rc8), null);
    const allinThen = [...foldThen.slice(0, 8), ["flop", 6, "all-in", 40.0], ["flop", 1, "call", 40.0], ["flop", 2, "call", 40.0], ["turn", 1, "check", null]] as any[];
    eq("an all-in seat is skipped too", lineOrderFault(allinThen, rc8), null);
    eq("blind posts never count as acting twice", lineOrderFault([["preflop", 6, "post-sb", 0.5], ["preflop", 6, "post-bb", 1.0]], rc8), null);

    // _reconciled_line keeps the event line when the derived line is misordered
    const rc9 = new HandReconciler(5);
    rc9.armed = true;
    rc9.dealt = new Set([1, 5, 6]);
    rc9.sb = 5; rc9.bbs = 6; rc9.hero = 6;
    rc9.street = 1;
    for (const [st, sd, ty, am] of bad425) {
      rc9.street = ["preflop", "flop", "turn", "river"].indexOf(st);
      (rc9 as any).add(sd, ty, am, 10, 0.9, "test");
    }
    S.handNo = 77;
    Object.assign(S.shadow, { hand: 77, rc: rc9 });
    S.ws.dealt = [1, 5, 6];
    const old = good.map(([st, sd, ty, am]) => ({ seatId: sd, hero: sd === 6, type: ty, street: st, ...(am !== null ? { amount: am } : {}) }));
    const [acts, , uncertain, note, source] = reconciledLine(old, 6, "flop");
    eq("source stays the event line", source, "ws");
    eq("the note says why", (note || "").includes("out of turn order"), true);
    eq("the event line is returned untouched", acts, old);
    eq("not flagged uncertain (could-not-see is not disagreement)", uncertain, null);

    // hand ids
    const archived: [number, string | null][] = [];
    wsSeams.archiveHand = () => { archived.push([S.handNo, S.handIds.get(S.handNo) ?? null]); };
    S.fakeMode = false;
    const fresh = (no: number, hid: string) => {
      S.handNo = no;
      S.handIds.clear();
      beginHand(hid);
      archived.length = 0;
      S.ws.dealt = [1, 6];
      S.ws.heroSeat = 6;
      S.ws.actions = [{ seat: 6, type: "post-sb", cents: 100, street: "preflop" }];
    };
    fresh(10, "");
    eq("setup: current hand has no id", S.handIds.get(S.handNo), "");
    onGameMsg({ pid: "PLAY_STAGE_END_REQ" });
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4919910444" });
    eq("the repeat's id is adopted", S.handIds.get(S.handNo), "4919910444");
    eq("no new hand was opened for it", archived, []);
    onGameMsg({ pid: "CO_LAST_HAND_NUMBER", stageNo: "4919910444" });
    onGameMsg({ pid: "PLAY_CLEAR_INFO" });
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4919910775" });
    eq("the next hand's PLAY_STAGE_INFO opens a new hand", archived, [[11, "4919910444"]]);
    eq("  carrying its own id", S.handIds.get(S.handNo), "4919910775");

    fresh(20, "");
    onGameMsg({ pid: "PLAY_STAGE_END_REQ" });
    onGameMsg({ pid: "CO_LAST_HAND_NUMBER", stageNo: "4919910444" });
    eq("adopted from CO_LAST_HAND_NUMBER", S.handIds.get(S.handNo), "4919910444");
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4919910775" });
    eq("a PLAY_STAGE_INFO after it is the next hand", archived, [[21, "4919910444"]]);

    fresh(30, "");
    onGameMsg({ pid: "PLAY_STAGE_END_REQ" });
    onGameMsg({ pid: "PLAY_CLEAR_INFO" });
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4919910775" });
    eq("not adopted: a new hand opens", archived, [[31, ""]]);
    eq("  with the new id", S.handIds.get(S.handNo), "4919910775");

    fresh(40, "");
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4919910775" });
    eq("a live id-less hand is never given the next hand's id: a new hand opens", archived, [[41, ""]]);

    fresh(50, "4919910444");
    onGameMsg({ pid: "PLAY_STAGE_END_REQ" });
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4919910444" });
    eq("the repeat for a hand that HAS its id: no new hand", archived, []);
    eq("id unchanged", S.handIds.get(S.handNo), "4919910444");
    onGameMsg({ pid: "CO_LAST_HAND_NUMBER", stageNo: "4919910444" });
    eq("CO_LAST_HAND_NUMBER changes nothing", S.handIds.get(S.handNo), "4919910444");

    fresh(60, "4919910444");
    S.ws.handOver = false;
    const carriedOf = () => (S.ws.dealt && S.ws.dealt.length && !S.ws.handOver ? S.handIds.get(S.handNo) ?? null : null);
    eq("a hand in flight is carried", carriedOf(), "4919910444");
    S.ws.handOver = true;
    eq("a finished hand is not", carriedOf(), null);
  } finally {
    wsSeams.archiveHand = arch0;
    console.log = log0;
  }
  expect(fails).toEqual([]);
});
