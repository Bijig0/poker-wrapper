/**
 * Port of tests/test_reader_boundary.py — the street- and hand-boundary rules of the 2026-09-23 hardening pass:
 * the pot landing at a seat is the award, not a bet (621); a press redeemed at the street boundary lands on ITS
 * street (425/441); the cut-over refuses a derived line no table could have dealt; and an id-less hand takes its
 * id from the end-of-hand repeat / CO_LAST_HAND_NUMBER, never from the next hand (714).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HandReconciler, makeTick } from "../../src/reconcile";
import { shadowArchive } from "../../src/ignition/shadow";
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
    // heads-up the BIG BLIND opens every postflop street (the dealer posts the SB) — judged since 2026-09-24;
    // before, heads-up order was not judged at all and an SB-first derived line replaced a correct one (4920374906)
    const rc7 = RC([1, 6], 6, 1);
    const hu: any[] = [["preflop", 6, "post-sb", 0.5], ["preflop", 1, "post-bb", 1.0], ["preflop", 6, "raise", 2.5], ["preflop", 1, "call", 1.5],
                       ["flop", 1, "check", null], ["flop", 6, "bet", 1.3], ["flop", 1, "call", 1.3], ["turn", 1, "check", null], ["turn", 6, "check", null]];
    eq("heads-up: the BB opening each postflop street passes", lineOrderFault(hu, rc7), null);
    const huSbFirst = [...hu.slice(0, 4), ["flop", 6, "bet", 1.3], ["flop", 1, "call", 1.3]] as any[];
    eq("heads-up: the SB opening the flop is refused", lineOrderFault(huSbFirst, rc7), "flop opens with seat 6, seat 1 is first to act");
    const huSbTurn = [...hu.slice(0, 7), ["turn", 6, "check", null], ["turn", 1, "check", null]] as any[];
    eq("heads-up: the SB opening the turn is refused", lineOrderFault(huSbTurn, rc7), "turn opens with seat 6, seat 1 is first to act");
    const huTwice = [...hu, ["river", 1, "check", null], ["river", 1, "bet", 3.0]] as any[];
    eq("heads-up: a seat acting twice running is still refused", (lineOrderFault(huTwice, rc7) || "").includes("twice"), true);
    const potHu: any[] = [["preflop", 5, "post-sb", 0.5], ["preflop", 6, "post-bb", 1.0], ["preflop", 1, "fold", null], ["preflop", 3, "fold", null],
                          ["preflop", 5, "raise", 2.5], ["preflop", 6, "call", 1.5], ["flop", 5, "bet", 1.3], ["flop", 6, "call", 1.3]];
    eq("a heads-up POT on a table dealt four is still SB-first (hand 621)", lineOrderFault(potHu, RC([1, 3, 5, 6], 5, 6)), null);
    eq("  and a BB-first flop there is refused",
       !!lineOrderFault([...potHu.slice(0, 6), ["flop", 6, "check", null], ["flop", 5, "bet", 1.3]] as any[], RC([1, 3, 5, 6], 5, 6)), true);
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

    // hand 4920374906 (75o, hero SB vs the BB on a table dealt TWO): the BB checked the flop and the turn before hero,
    // no chips moving. The reconciler put the SB first on every heads-up street, so at hero's turn decision its line
    // ("hero X, BB X" on the flop, nothing on the turn) was not a prefix of the event line and replaced it — the BB's
    // turn check was lost and the API refused the spot as a capture fault (no answer on the turn or the river).
    const rcHu = new HandReconciler(9);
    let q = 0;
    const obHu = (bets: Record<number, string>, pot: number | null, board: number, buttons: string[] = [], badges: Record<number, string> = {}) =>
      rcHu.observe(tick(++q, bets, pot, board, buttons, badges));
    obHu({}, null, 0);
    obHu({ 6: "0.4 BB", 1: "1 BB" }, 1.4, 0);
    obHu({ 6: "0.4 BB", 1: "1 BB" }, 1.4, 0, ["FOLD", "CALL 0.6 BB", "RAISE TO 2 BB"]);
    obHu({ 6: "0.4 BB", 1: "1 BB" }, 1.4, 0);
    obHu({ 6: "3 BB", 1: "1 BB" }, 4.0, 0);
    obHu({ 6: "3 BB", 1: "3 BB" }, 6.0, 0);
    obHu({}, 6.0, 3); obHu({}, 6.0, 3);
    obHu({}, 6.0, 3, ["CHECK", "BET 1 BB"]);
    obHu({}, 6.0, 3, [], { 6: "CHECK" });
    obHu({}, 6.0, 4); obHu({}, 6.0, 4);
    obHu({}, 6.0, 4, ["CHECK", "BET 1 BB"]);
    const huLine = rcHu.line().map((a) => [a.street, a.seat, a.type]);
    eq("4920374906: heads-up flop checks are filed BB first", huLine.filter((x) => x[0] === "flop"), [["flop", 1, "check"], ["flop", 6, "check"]]);
    S.handNo = 78;
    Object.assign(S.shadow, { hand: 78, rc: rcHu });
    S.ws.dealt = [1, 6];
    const asRow = (a: any) => ({ seatId: a.seat, hero: a.seat === 6, type: a.type, street: a.street, ...(a.amount != null ? { amount: a.amount } : {}) });
    const evLine = [...rcHu.line().filter((a) => a.street === "preflop").map(asRow),
                    ...([["flop", 1], ["flop", 6], ["turn", 1]] as const).map(([st, sd]) => ({ seatId: sd, hero: sd === 6, type: "check", street: st }))];
    const [huActs, , huUnc, , huSrc] = reconciledLine(evLine, 6, "turn");
    eq("4920374906: at hero's turn decision the event line is kept", huSrc, "ws");
    eq("  with the BB's turn check in it", huActs.filter((a: any) => a.street === "turn").map((a: any) => [a.seatId, a.type]), [[1, "check"]]);
    eq("  and not flagged uncertain", huUnc, null);

    // the shadow audit compares the reconciler with the EVENT line once the cut-over has archived the reconciler's
    // own line — it used to diff the reconciler against itself and log agree:true (4920374906 was "agree")
    const sbFirst = [...evLine.slice(0, 4), { seatId: 6, hero: true, type: "check", street: "flop" }, { seatId: 1, hero: false, type: "check", street: "flop" }];
    Object.assign(S.ws, { heroSeat: 6, bb: 5, bbSeen: true,
                          actions: evLine.map((r: any) => ({ seat: r.seatId, type: r.type, street: r.street, cents: r.amount != null ? Math.round(r.amount * 5) : null })) });
    S.dbg.on = false;
    shadowArchive({ handId: 78, clientHandId: "4920374906", lineSource: "reconciled", actions: sbFirst });
    const shadowRecs = readFileSync(join(process.env.WRAPPER_DATA_DIR!, "shadow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const sr = shadowRecs[shadowRecs.length - 1];
    eq("shadow audit: a reconciled hand is diffed against the event line", sr.against, "event");
    eq("  so the archived SB-first flop is not what it compared",
       sr.archive.filter((x: any) => x[0] === "flop").map((x: any) => x[1]), [1, 6]);

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
