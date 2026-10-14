/**
 * WHICH LINE WAS SERVED (2026-10-14, hand 4924546540, session_20261014_131738 table 1, hero BB A♣A♥): for at least 50 s
 * mid-hand /state's line carried a FOLD by seat 4, the button, all-in for his whole 2.2bb (his CO_SELECT_INFO: btn 4096
 * "raise", bet 5, raise 11, account 0); the server skipped him and the hand got no answer, and nothing recorded which
 * line /state served then or why. ignition/hand.ts now logs (logs and ws_dump markers only — /state and /hand carry
 * nothing new):
 *   1. the protocol line unavailable while a hand is on, the line served instead, and its coming back;
 *   2. a fold read for a seat with nothing behind outside the protocol reducer (the level reconciler, the DOM backfill);
 *   3. an all-in the protocol's frame typed as a raise (wsLine.ts nothingBehind — the row still typed "raise").
 * The frames are shaped like the hand's own (6-max, 5c big blind); the seat numbers and money are its.
 */
import { afterEach, expect, test } from "bun:test";
import { realTime, setFakeTime } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { S, resetState } from "../../src/state";
import { HandReconciler, makeTick } from "../../src/reconcile";
import { tapFrame, wsSeams } from "../../src/ignition/ws";
import { wsHand } from "../../src/ignition/wsLine";
import { handStateIgnition, lineDiagSeams, noteFoldNothingBehind } from "../../src/ignition/hand";
import { scratchDirs } from "./helpers";

const RID = "31337.4242";
const T0 = 1791976658.0;

/** Hand 4924546540's shape: BTN seat 4, SB 5, hero BB 6; seats 1-3 fold, the button jams 2.2bb on btn 4096 "raise". */
const FRAMES: Record<string, any>[] = [
  { pid: "PLAY_STAGE_INFO", stageNo: "4924546540" },
  { seat: 4, pid: "CO_DEALER_SEAT" },
  { pid: "CO_BLIND_INFO", seat: 5, account: 598, baseStakes: 0, btn: 2, bet: 2, dead: 0 },
  { pid: "CO_BLIND_INFO", seat: 6, account: 495, baseStakes: 0, btn: 4, bet: 5, dead: 0 },
  { pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [32896, 32896], seat3: [32896, 32896], seat4: [32896, 32896], seat5: [32896, 32896], seat6: [33, 46] },
  { seat: 1, pid: "CO_CURRENT_PLAYER" },
  { pid: "CO_SELECT_INFO", seat: 1, btn: 1024, bet: 0, raise: 0, account: 500 },
  { seat: 2, pid: "CO_CURRENT_PLAYER" },
  { pid: "CO_SELECT_INFO", seat: 2, btn: 1024, bet: 0, raise: 0, account: 700 },
  { seat: 3, pid: "CO_CURRENT_PLAYER" },
  { pid: "CO_SELECT_INFO", seat: 3, btn: 1024, bet: 0, raise: 0, account: 450 },
  { seat: 4, pid: "CO_CURRENT_PLAYER" },
  { pid: "CO_SELECT_INFO", seat: 4, btn: 4096, bet: 5, raise: 11, account: 0 },     // the button's whole 2.2bb, typed "raise"
  { seat: 6, pid: "CO_CURRENT_PLAYER" },
  { seat: 5, pid: "CO_CURRENT_PLAYER" },
];

let lines: string[] = [];
const log0 = lineDiagSeams.log;
const console0 = console.log;

function fresh(): void {
  scratchDirs("wrapper-line-diag-");
  reloadConfig();
  resetState();
  S.fakeMode = false;
  S.feedPrev = { seated: true, seats: new Map([[1, { stack: "100 BB" }], [2, { stack: "140 BB" }], [3, { stack: "90 BB" }], [4, { stack: "0 BB" }], [5, { stack: "120 BB" }], [6, { stack: "100 BB" }]]) };
  Object.assign(S.liveStatus, { toAct: false, toActSince: null, practice: true, board: [], modal: null, buyPanel: null, timeBank: null, heroSeatDom: 6 });
  lines = [];
  lineDiagSeams.log = (m: string) => { lines.push(m); };
  console.log = () => {};
}

afterEach(() => {
  lineDiagSeams.log = log0;
  console.log = console0;
  realTime();
});

function play(): void {
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    FRAMES.forEach((f, i) => {
      setFakeTime(T0 + i * 0.4);
      tapFrame(f, RID);
    });
  } finally {
    wsSeams.archiveHand = arch0;
  }
}

test("wsHand: a raise frame that leaves its seat with 0 behind is still filed a raise, and is listed in nothingBehind; a real all-in and a raise with chips behind are not", () => {
  const p = wsHand(FRAMES, 5);
  const four = p.actions.filter((a) => a.seatId === 4);
  expect(four).toEqual([{ seatId: 4, hero: false, type: "raise", street: "preflop", amount: 2.2 }]);   // typing unchanged
  expect(p.nothingBehind).toEqual([{ seat: 4, verb: "raise", type: "raise", street: "preflop", toCents: 11 }]);
  // the same jam typed by the frame as an all-in (btn 2048): nothing to say
  const typed = FRAMES.map((f) => (f.pid === "CO_SELECT_INFO" && f.seat === 4 ? { ...f, btn: 2048 } : f));
  expect(wsHand(typed, 5).nothingBehind).toEqual([]);
  // a raise with chips behind: nothing to say
  const deep = FRAMES.map((f) => (f.pid === "CO_SELECT_INFO" && f.seat === 4 ? { ...f, account: 989 } : f));
  expect(wsHand(deep, 5).nothingBehind).toEqual([]);
  // a call that puts in the last chip (btn 256, account 0) is listed too; unscaled (no bb) it still is
  const call = [...FRAMES, { pid: "CO_SELECT_INFO", seat: 5, btn: 256, bet: 9, raise: 0, account: 0 }];
  expect(wsHand(call, null).nothingBehind.map((x) => `${x.seat} ${x.verb} ${x.toCents}`)).toEqual(["4 raise 11", "5 call 11"]);
});

test("handStateIgnition logs the protocol's all-in-typed-as-raise once per seat per hand, and /hand still carries the raise and no new key", () => {
  fresh();
  play();
  const h = handStateIgnition()!;
  expect(h).not.toBeNull();
  expect(h.lineSource).toBe("ws");
  expect(h.actions.filter((a: any) => a.seatId === 4)).toEqual([{ seatId: 4, hero: false, type: "raise", street: "preflop", amount: 2.2 }]);
  expect(JSON.stringify(Object.keys(h))).not.toContain("nothingBehind");
  handStateIgnition();
  handStateIgnition();
  expect(lines).toEqual([`[line] hand ${S.handNo} (4924546540) seat 4: raise to 2.2bb leaves 0 behind — an all-in the frame typed "raise" (preflop)`]);
});

test("the protocol line unavailable mid-hand: logged and marked in the ws_dump once with the line served instead; logged once more when it comes back", () => {
  fresh();
  play();
  handStateIgnition();
  lines = [];
  const frames = S.ws.frames;
  S.ws.frames = [];
  const dumpAt = S.wsDump.length;
  const h = handStateIgnition()!;
  expect(h).not.toBeNull();
  handStateIgnition();
  expect(lines.length).toBe(1);
  expect(lines[0]).toStartWith(`[line] hand ${S.handNo} (4924546540): protocol line unavailable — frames 0, tapBound ${RID}, serving the event line`);
  const marks = S.wsDump.slice(dumpAt).filter((e) => e.pid === "<line-fallback>");
  expect(marks.length).toBe(1);
  expect(marks[0]!.data).toMatchObject({ frames: 0, tapBound: RID, served: "event" });
  expect(marks[0]!.data.line).toContain("p 4 raise 2.2");
  // back: once
  S.ws.frames = frames;
  handStateIgnition();
  handStateIgnition();
  expect(lines.length).toBe(2);
  expect(lines[1]).toBe(`[line] hand ${S.handNo} (4924546540): protocol line available again — frames ${frames.length}`);
  expect(S.wsDump.slice(dumpAt).filter((e) => e.pid === "<line-back>").length).toBe(1);
});

/** The level reconciler's ticks for the same hand, from the SB's post: the button's 2.2 went in on a tick the
 *  reconciler did not see as chips (here: never drawn in front of him), his stack reads 0 and his cards are gone. */
function reconcilerTicks(): ReturnType<typeof makeTick>[] {
  const seat = (bet: string | null, cards: number, stack: string, hero = false) => ({ bet, cards, stack, hero, badge: null });
  return [
    makeTick({ seq: 1, seats: new Map([[4, seat(null, 2, "2.2 BB")], [5, seat(null, 2, "120 BB")], [6, seat(null, 2, "100 BB", true)]]), pot: 0, hero: 6 }),
    makeTick({ seq: 2, seats: new Map([[4, seat(null, 2, "2.2 BB")], [5, seat("0.4 BB", 2, "119.6 BB")], [6, seat("1 BB", 2, "99 BB", true)]]), pot: 1.4, hero: 6 }),
    // the SB completes; the button, skipped while he "owes", has 0 behind and no cards on screen
    makeTick({ seq: 3, seats: new Map([[4, seat(null, 0, "0 BB")], [5, seat("1 BB", 2, "119 BB")], [6, seat("1 BB", 2, "99 BB", true)]]), pot: 2, hero: 6 }),
  ];
}

test("the level reconciler's fold for a skipped seat with 0 behind is logged once (via the order rule), and the line is the same with or without the listener", () => {
  fresh();
  play();
  lines = [];
  S.ws.wsAccount = new Map();      // the socket's word on seat 4 not in (as on a fallback): the screen's 0 decides
  const told: [number, string, number | null][] = [];
  const rc = new HandReconciler(S.handNo);
  rc.onFold = (seat, via, behind) => {
    told.push([seat, via, behind]);
    noteFoldNothingBehind(seat, `the level reconciler (${via})`, behind);
  };
  const bare = new HandReconciler(S.handNo);
  for (const tk of reconcilerTicks()) {
    rc.observe(tk);
    bare.observe(tk);
  }
  expect(rc.line().map((a) => `${a.seat} ${a.type} ${a.via}`)).toContain("4 fold order+cards");
  expect(JSON.stringify(rc.journal)).toBe(JSON.stringify(bare.journal));
  expect(told).toEqual([[4, "order+cards", 0]]);
  expect(lines).toEqual([`[line] hand ${S.handNo} (4924546540) seat 4: fold read via the level reconciler (order+cards) but the seat has 0 behind (socket account unread, screen 0, last action raise 11c)`]);
  // once per seat per hand: the DOM backfill reading the same fold says nothing more
  noteFoldNothingBehind(4, "the DOM backfill (cards gone)", 0);
  expect(lines.length).toBe(1);
});

test("a DOM-backfill fold for a seat whose socket account is 0 is logged; a fold from a seat with chips behind, or hero's own, is not", () => {
  fresh();
  play();
  lines = [];
  expect(S.ws.wsAccount.get(4)).toBe(0);
  noteFoldNothingBehind(1, "the DOM backfill (cards gone)", 100);     // chips behind on both readings
  noteFoldNothingBehind(6, "the DOM backfill (FOLD badge)", 0);       // hero: not this diagnostic's
  expect(lines).toEqual([]);
  noteFoldNothingBehind(4, "the DOM backfill (cards gone)", null);    // screen unread, socket says 0
  expect(lines).toEqual([`[line] hand ${S.handNo} (4924546540) seat 4: fold read via the DOM backfill (cards gone) but the seat has 0 behind (socket account 0, screen unread, last action raise 11c)`]);
  // a new hand clears the latches
  S.handNo += 1;
  S.ws.wsAccount = new Map([[4, 0]]);
  noteFoldNothingBehind(4, "the DOM backfill (cards gone)", null);
  expect(lines.length).toBe(2);
});
