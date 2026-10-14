/**
 * HERO'S TURN IS THE SOCKET'S WORD WHILE THE SOCKET IS ALIVE (2026-10-14, the answer-path audit's independent review of
 * hand 4921603348). Hero SB 8♥8♠ was answered twice ("Raise 2.5", answers 8166 / 8167) on a line padded F-F-F-F, 18.7 s
 * and 15.7 s BEFORE the socket asked him: toActSources {buttons: true, ws: false, actionOn: false} — the socket said
 * action on seat 1 then 2 while the screen's strip (Ignition's pre-action "CALL 3" buttons, which carry a digit) counted
 * as his turn through the held-buttons rule 0.14 s past the deal grace. The table had gone F-R2-C-C by the time it asked
 * (CO_SELECT_REQ bet 8 = 1.6bb to call). Nine such answers in six hands since 09-20, all preflop.
 *
 * The frames are the hand's own, verbatim from wrapper-debug/ws-archive/ws_dump-2_20261013_224720.jsonl (slot 2, socket
 * 22016.862), with their timestamps driving the clock. The DOM reader is not run: the strip's reading is set by hand to
 * what the recorder saw (buttons up, held, fresh).
 *
 * Also here: the socket's ask makes the turn EARLIER than the buttons ever did (Ignition draws them 3-4 s after the ask);
 * the strip rules still decide for a socket that has gone silent past SOCKET_ALIVE_S, or when none is bound (the fake
 * table); and a hand the socket JOINED MID-WAY (ws_dump-3.jsonl 04:50:17, socket 27500.2642's join snapshot) is flagged,
 * exports nothing, presses nothing and is never folded on no answer.
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { S, resetState, seams } from "../../src/state";
import { onGameMsg, tapFrame, wsSeams } from "../../src/ignition/ws";
import { handSeams, handStateIgnition, SOCKET_ALIVE_S, socketWord } from "../../src/ignition/hand";
import { maybeFoldNoAnswer, NO_ANSWER_DEADLINE_S, pickReady } from "../../src/relay";
import { currentStep } from "../../src/steps";
import { J, scratchDirs } from "./helpers";

const RID = "22016.862";

/** Hand 4921603348's frames on its socket, from PLAY_STAGE_INFO to the seat after hero: [epoch seconds, frame]. */
const FRAMES: [number, Record<string, any>][] = [
  [1790740230.162, { pid: "PLAY_STAGE_INFO", stageNo: "4921603348" }],
  [1790740230.171, { tableState: 2, pid: "CO_TABLE_STATE" }],
  [1790740230.173, { seat: 4, pid: "CO_DEALER_SEAT" }],
  [1790740230.175, { seat: 4, pid: "CO_DEALER_SEAT" }],
  [1790740230.176, { play: 1, seat: 5, pid: "CO_SIT_PLAY" }],
  [1790740230.178, { tableState: 4, pid: "CO_TABLE_STATE" }],
  [1790740230.18, { pid: "CO_BLIND_INFO", seat: 5, account: 535, baseStakes: 0, btn: 2, bet: 2, dead: 0 }],     // hero posts the SB
  [1790740230.182, { pid: "CO_BLIND_INFO", seat: 6, account: 358, baseStakes: 0, btn: 4, bet: 5, dead: 0 }],
  [1790740230.363, { pid: "CO_BLIND_INFO", seat: 3, account: 495, baseStakes: 0, btn: 8, bet: 5, dead: 0 }],    // a post-in
  [1790740230.366, { tableState: 8, pid: "CO_TABLE_STATE" }],
  [1790740230.368, { pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [32896, 32896], seat3: [32896, 32896], seat4: [32896, 32896], seat5: [33, 46], seat6: [32896, 32896] }],
  [1790740230.369, { time: 15, pid: "PLAY_TIME_INFO" }],
  [1790740230.371, { seat: 1, pid: "CO_CURRENT_PLAYER" }],
  [1790740230.372, { btns: 9, selected: 0, bet: 0, call: 3, raise: 0, pid: "CO_SELECT_SPEED_BTN" }],             // the pre-action strip: "CALL 3"
  [1790740234.939, { pid: "CO_SELECT_INFO", seat: 1, btn: 1024, bet: 0, raise: 0, account: 500 }],              // UTG folds
  [1790740235.208, { time: 15, pid: "PLAY_TIME_INFO" }],
  [1790740235.21, { seat: 2, pid: "CO_CURRENT_PLAYER" }],
  [1790740240.124, { pid: "CO_SELECT_INFO", seat: 2, btn: 512, bet: 5, raise: 10, account: 70 }],               // HJ raises to 10 (2bb)
  [1790740240.39, { time: 15, pid: "PLAY_TIME_INFO" }],
  [1790740240.391, { seat: 3, pid: "CO_CURRENT_PLAYER" }],
  [1790740240.395, { btns: 9, selected: 0, bet: 0, call: 8, raise: 0, pid: "CO_SELECT_SPEED_BTN" }],
  [1790740242.124, { pid: "CO_SELECT_INFO", seat: 3, btn: 256, bet: 5, raise: 0, account: 490 }],               // CO calls
  [1790740242.382, { time: 15, pid: "PLAY_TIME_INFO" }],
  [1790740242.386, { seat: 4, pid: "CO_CURRENT_PLAYER" }],
  [1790740251.199, { pid: "CO_SELECT_INFO", seat: 4, btn: 256, bet: 10, raise: 0, account: 227 }],              // BTN calls
  [1790740251.467, { time: 15, pid: "PLAY_TIME_INFO" }],
  [1790740251.477, { seat: 5, pid: "CO_CURRENT_PLAYER" }],
  [1790740251.513, { pid: "CO_SELECT_REQ", btns: 6293248, bet: 8, raise: 15, maxRaise: 537, betPot: 55, halfPot: 28, timeBank: 45 }],  // hero's ask
  [1790740254.088, { pid: "PONG", uuid: "e0193939-63dc-413e-8a8e-d4a048b4a640" }],
  [1790740254.458, { pid: "CO_SELECT_INFO", seat: 5, btn: 256, bet: 8, raise: 0, account: 527 }],               // hero calls
  [1790740254.732, { time: 15, pid: "PLAY_TIME_INFO" }],
  [1790740254.734, { seat: 6, pid: "CO_CURRENT_PLAYER" }],
];
const ASK_AT = 1790740251.513;

function quiet<T>(fn: () => T): T {
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try { return fn(); } finally { wsSeams.archiveHand = arch0; }
}

function fresh(): void {
  scratchDirs("wrapper-to-act-socket-");
  reloadConfig();
  resetState();
  S.fakeMode = false;
  S.feedPrev = { seated: true, seats: new Map([[1, { stack: "100 BB" }], [2, { stack: "14 BB" }], [3, { stack: "98 BB" }], [4, { stack: "45 BB" }], [5, { stack: "107 BB" }], [6, { stack: "72 BB" }]]) };
  Object.assign(S.liveStatus, { toAct: false, toActSince: null, practice: true, board: [], modal: null, buyPanel: null, timeBank: null, heroSeatDom: 5 });
}

/** The strip as the recorder saw it from `since`: hero's buttons up (the pre-action "CALL 3"), read this tick. */
function stripUp(since: number): void {
  S.liveStatus.toAct = true;
  S.liveStatus.toActSince = since;
  S.screenReadAt = time();
}

/** Replay the frames up to (not including) epoch `until`, the clock following each frame. */
function playUntil(until: number, from = 0): number {
  let i = from;
  for (; i < FRAMES.length && FRAMES[i]![0] < until; i++) {
    setFakeTime(FRAMES[i]![0]);
    tapFrame(FRAMES[i]![1], RID);
  }
  return i;
}

const voluntary = (h: Record<string, any>) => h.actions.filter((a: any) => !/^post/.test(a.type)).map((a: any) => `${a.seatId} ${a.type}${a.amount != null ? ` ${a.amount}` : ""}`);

test("4921603348 from its own frames: no turn before the socket's ask while the socket is alive; after it, the line is F-R2-C-C and the ask's price is 1.6bb", () => {
  fresh();
  try {
    quiet(() => {
      // 10:50:32.8 — answer 8166's moment: past the 2.5 s deal grace, the strip's buttons up and held over a second,
      // the socket alive (its last frame 2.4 s ago, action on seat 1), hero not asked
      let i = playUntil(1790740232.8);
      stripUp(1790740230.5);
      setFakeTime(1790740232.8);
      let h = handStateIgnition()!;
      expect(h).not.toBeNull();
      expect(S.tapBound).toBe(RID);
      expect(h.toActSources.socket).toBe("alive");
      expect(h.toActSources.buttons).toBe(true);
      expect(h.toActSources.ws).toBe(false);
      expect(h.currentNode.toActIsHero).toBe(false);
      expect(h.notToActWhy).toContain("the table's connection is alive and has not asked you to act");
      expect(h.notToActWhy).toContain("action on seat 1");
      expect(h.askedToCall).toBeUndefined();
      // 10:50:35.8 — answer 8167's moment (the UTG fold is in: a voluntary action, the other strip rule's condition)
      i = playUntil(1790740235.8, i);
      setFakeTime(1790740235.8);
      S.screenReadAt = time();
      h = handStateIgnition()!;
      expect(voluntary(h)).toEqual(["1 fold"]);
      expect(h.currentNode.toActIsHero).toBe(false);
      expect(h.notToActWhy).toContain("action on seat 2");
      // every tick up to the socket's own word on hero: never his turn
      for (const t of [1790740240.2, 1790740242.5, 1790740251.47]) {
        i = playUntil(t, i);
        setFakeTime(t);
        S.screenReadAt = time();
        expect(handStateIgnition()!.currentNode.toActIsHero).toBe(false);
      }
      // 10:50:51.477 — CO_CURRENT_PLAYER names hero: the socket's word, 36 ms before its ask — his turn (as before)
      i = playUntil(1790740251.48, i);
      setFakeTime(1790740251.48);
      S.screenReadAt = time();
      h = handStateIgnition()!;
      expect(h.toActSources).toMatchObject({ actionOn: true, ws: false, buttons: true, socket: "alive" });
      expect(h.currentNode.toActIsHero).toBe(true);
      expect(h.askedToCall).toBeUndefined();
      // 10:50:51.513 — the socket asks hero: his turn, on the line the table played, at the price the client named
      i = playUntil(ASK_AT + 0.001, i);
      setFakeTime(ASK_AT + 0.05);
      S.screenReadAt = time();
      h = handStateIgnition()!;
      expect(h.currentNode.toActIsHero).toBe(true);
      expect(h.toActSources.ws).toBe(true);
      expect(voluntary(h)).toEqual(["1 fold", "2 raise 2", "3 call 1", "4 call 2"]);   // seat 3 posted in 1bb: its call tops up 1
      expect(h.heroCards).toEqual(["8♥", "8♠"]);
      expect(h.positions.get(5)).toBe("SB");
      expect(h.currentNode.toCall).toBe(1.6);
      expect(h.askedToCall).toBe(1.6);
      expect(h.askedSizes).toEqual({ betPot: 11, halfPot: 5.6 });
      // hero's call (the strip goes with his press), action on seat 6: his turn is over, the ask is gone from the export
      i = playUntil(1790740254.8, i);
      setFakeTime(1790740254.8);
      S.liveStatus.toAct = false;
      S.screenReadAt = time();
      h = handStateIgnition()!;
      expect(h.currentNode.toActIsHero).toBe(false);
      expect(h.askedToCall).toBeUndefined();
    });
  } finally {
    realTime();
  }
});

test("the socket's ask is hero's turn at once — before the buttons are drawn (Ignition draws them 3-4 s after the ask), so the turn is never later than the strip made it", () => {
  fresh();
  try {
    quiet(() => {
      const i = playUntil(ASK_AT + 0.001);
      // no buttons on screen yet (the deal / fold animation), the ask just in
      setFakeTime(ASK_AT + 0.05);
      S.liveStatus.toAct = false;
      S.screenReadAt = time();
      const h = handStateIgnition()!;
      expect(h.toActSources).toMatchObject({ ws: true, buttons: false, socket: "alive" });
      expect(h.currentNode.toActIsHero).toBe(true);
      expect(h.askedToCall).toBe(1.6);
      // the buttons 3.5 s later change nothing about the turn
      setFakeTime(ASK_AT + 3.5);
      stripUp(ASK_AT + 3.4);
      expect(handStateIgnition()!.currentNode.toActIsHero).toBe(true);
      expect(i).toBeGreaterThan(0);
    });
  } finally {
    realTime();
  }
});

test("a socket silent past SOCKET_ALIVE_S hands the turn back to the strip (a stall, a lost tap); no socket bound at all (the fake table) keeps the strip's rules", () => {
  fresh();
  try {
    quiet(() => {
      // the hand up to UTG's fold, then the socket goes quiet with the strip up and held
      playUntil(1790740235.8);
      const last = 1790740235.21;
      expect(socketWord()).toEqual({ word: "alive", silentS: expect.any(Number) });
      // 20 s of silence: still inside the keep-alive window (a villain thinking; a PONG every 30 s) — the socket's word
      setFakeTime(last + 20);
      stripUp(last + 18);
      let h = handStateIgnition()!;
      expect(h.toActSources.socket).toBe("alive");
      expect(h.currentNode.toActIsHero).toBe(false);
      // past the keep-alive-overdue mark: the socket is silent, the held buttons decide as they always did
      setFakeTime(last + SOCKET_ALIVE_S + 0.5);
      S.screenReadAt = time();
      h = handStateIgnition()!;
      expect(h.toActSources.socket).toBe("silent");
      expect(h.toActSources.socketSilentS).toBeCloseTo(SOCKET_ALIVE_S + 0.5, 0);
      expect(h.currentNode.toActIsHero).toBe(true);
      expect(h.notToActWhy).toBeNull();
      // and with nothing bound (the socket closed, a replay without rids) the strip rules apply as before
      S.tapBound = null;
      h = handStateIgnition()!;
      expect(h.toActSources.socket).toBe("none");
      expect(h.currentNode.toActIsHero).toBe(true);
    });
  } finally {
    realTime();
  }
});

/** Socket 27500.2642's join snapshot (ws_dump-3.jsonl 04:50:17.591-.595, verbatim): hand 4920430856 already dealt and in
 *  play — tableState 8, action on seat 2, dealer 1, pbet [5, 2, 0, 5] — with no blind or deal frame of it heard. */
const JOIN: Record<string, any>[] = [
  { pid: "PLAY_STAGE_INFO", stageNo: "4920430856" },
  { pid: "CO_OPTION_INFO", bblind: 5, sblind: 2, gameType: 2, gameType2: 5, hiLow: 0, maxSeat: 9, maxStakes: 0, minStakes: 0, real: 1 },
  { pid: "CO_TABLE_INFO", time: 10, currentSeat: 2, dealerSeat: 1, lockSeat: 0, tableState: 8, seatState: [80, 80, 0, 80, 16, 0, 0, 0, 0],
    account: [316, 498, 0, 696, 454, 0, 0, 0, 0], pcard1: [32896, 32896], pcard2: [32896, 32896], pcard4: [32896, 32896], pcard5: [32896, 32896],
    pbet: [5, 2, 0, 5, 0, 0, 0, 0, 0], curPot: [0, 0, 0, 0, 0, 0, 0, 0, 0], curRake: [0, 0, 0, 0, 0, 0, 0, 0, 0], potCount: 0, totalpot: 0 },
];

test("a hand the socket joined mid-way is flagged, exports nothing, presses nothing and is never folded on no answer; the next hand clears it", async () => {
  fresh();
  const T0 = 1790286617.591;
  const log0 = console.log;
  console.log = () => {};
  const act0 = seams.act;
  const calls: string[] = [];
  seams.act = async (label: string) => { calls.push(label); return { ok: true, clicked: label.toUpperCase() }; };
  try {
    setFakeTime(T0);
    quiet(() => { for (const d of JOIN) onGameMsg(d); });
    expect(S.ws.joinedMidHand).toMatchObject({ tableState: 8, currentSeat: 2, dealerSeat: 1 });
    expect(S.feed.some((f) => /Joined this hand mid-way/.test(String(f.line)))).toBe(true);
    // no deal frame: no export (nothing for the poller to ask about)
    expect(handStateIgnition()).toBeNull();
    // answers on, auto-execute armed, fold-on-no-answer on, the strip up for the whole clock: nothing is pressed
    Object.assign(S.study, { on: true, auto: true, foldNoAnswer: true, timeBank: false, text: null, pick: null, note: null, at: time(),
                             decisionKey: null, handId: null, executed: null, noAnswerTurn: null, lastNoAnswerFold: null });
    stripUp(T0 + 1);
    expect(pickReady().reason).toContain("joined this hand mid-way");
    expect(currentStep()?.id).toBe("joined-mid-hand");
    for (const t of [0, 2, 10, NO_ANSWER_DEADLINE_S + 1, NO_ANSWER_DEADLINE_S + 5]) {
      setFakeTime(T0 + t);
      S.screenReadAt = time();
      S.study.at = time();
      S.study.note = t >= 2 ? "no answer for this spot after 3 tries — joined this hand mid-way" : null;
      await maybeFoldNoAnswer();
    }
    expect(calls).toEqual([]);
    expect(S.study.lastNoAnswerFold).toBeNull();
    // even an export that says it is hero's turn (a snapshot taken before the deal, the deal then heard) is not folded
    handSeams.override = () => ({ handId: S.handNo, street: "preflop", actions: [{ seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" }],
                                  heroCards: ["Ah", "Kd"], heroFolded: false, ended: false, joinedMidHand: true,
                                  currentNode: { street: "preflop", toActSeatId: 3, toActIsHero: true, pot: 1.5, toCall: 1, legalActions: [], complete: false } });
    try {
      expect(currentStep()?.id).toBe("joined-mid-hand");
      for (const t of [NO_ANSWER_DEADLINE_S + 10, NO_ANSWER_DEADLINE_S + 40]) {
        setFakeTime(T0 + t);
        S.screenReadAt = time();
        S.study.at = time();
        await maybeFoldNoAnswer();
      }
      expect(calls).toEqual([]);
      // the next hand opens: the flag is gone, and the same export IS folded on no answer as before
      quiet(() => onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4920430900" }));
      expect(S.ws.joinedMidHand).toBeUndefined();
      S.study.noAnswerTurn = null;
      handSeams.override = () => ({ handId: S.handNo, street: "preflop", actions: [{ seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" }],
                                    heroCards: ["Ah", "Kd"], heroFolded: false, ended: false,
                                    currentNode: { street: "preflop", toActSeatId: 3, toActIsHero: true, pot: 1.5, toCall: 1, legalActions: [], complete: false } });
      setFakeTime(T0 + 100);
      S.screenReadAt = time();
      S.study.at = time();
      await maybeFoldNoAnswer();   // the turn's first tick
      setFakeTime(T0 + 103);
      S.screenReadAt = time();
      S.study.at = time();
      await maybeFoldNoAnswer();   // the refusal note is trusted from the second tick
      expect(calls).toEqual(["check"]);
    } finally {
      handSeams.override = null;
    }
  } finally {
    seams.act = act0;
    console.log = log0;
    realTime();
  }
});
