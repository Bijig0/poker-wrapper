/**
 * The stacks as dealt, off the table's own account (ignition/ws.ts noteAccount → the hand's `startStacks`).
 *
 * Hand 723 (Ignition 4919957209, $1/$2): its preflop frames verbatim from debug/ws_dump.jsonl (lines 36029–36051).
 * The screen had the SB and BB at 102.7 / 101.7 behind at hero's check; the table's accounts say they were dealt
 * 20741 / 20545 cents and the BTN 20000 — which the previous hand's CO_RESULT_INFO (20741 / 20545) and the BTN's
 * top-up to 20000 in between confirm independently.
 */
import { expect, test } from "bun:test";
import { S, resetState } from "../../src/state";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { handStateIgnition } from "../../src/ignition/hand";
import { scratchDirs } from "./helpers";

function hand723Preflop(): void {
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4919957209" });
  onGameMsg({ pid: "CO_DEALER_SEAT", seat: 6 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 20641, baseStakes: 0, btn: 2, bet: 100, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 4, account: 20345, baseStakes: 0, btn: 4, bet: 200, dead: 0 });
  onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat4: [33, 51], seat6: [32896, 32896] });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 6, btn: 1024, bet: 0, raise: 0, account: 20000 });   // BTN folds
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 256, bet: 100, raise: 0, account: 20541 });  // SB completes
}

test("each seat's stack as dealt is its first account this hand plus what it had put in by then", () => {
  resetState();
  scratchDirs();
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    hand723Preflop();
    // the SB's second frame (the complete) must not move it: the first account + the blind already made 20741
    expect([...S.ws.startCents]).toEqual([[1, 20741], [4, 20545], [6, 20000]]);
    expect([...S.ws.moneyIn]).toEqual([[1, 200], [4, 200]]);
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 64, bet: 0, raise: 0, account: 20345 });    // hero checks
    expect(S.ws.startCents.get(4)).toBe(20545);

    // the next hand starts clean
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4919957300" });
    expect(S.ws.startCents.size).toBe(0);
    expect(S.ws.moneyIn.size).toBe(0);
  } finally {
    wsSeams.archiveHand = arch0;
  }
});

test("a raise, a batched fold and a dead blind all come back to the stack as dealt", () => {
  resetState();
  scratchDirs();
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "1" });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 4375, btn: 2, bet: 10, dead: 0 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 2450, btn: 4, bet: 25, dead: 25 });     // BB + a dead 25
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [33, 51], seat3: [32896, 32896], seat4: [32896, 32896] });
    // raises: `raise` is the chips ADDED (75 = a raise to 3bb; the next seat's CO_SELECT_REQ asks 50 more of the BB)
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 512, bet: 25, raise: 75, account: 2416 });
    // a batched slot: seat 4 folds; the array is indexed by seat - 1
    onGameMsg({ pid: "CO_SELECT_SPEED_INFO", firstSeat: 4, btn: [0, 0, 0, 1024, 0, 0], bet: [0, 0, 0, 0, 0, 0],
                raise: [0, 0, 0, 0, 0, 0], account: [0, 0, 0, 6437, 0, 0] });
    expect(S.ws.startCents.get(1)).toBe(4385);
    expect(S.ws.startCents.get(2)).toBe(2500);        // 2450 + 25 live + 25 dead
    expect(S.ws.startCents.get(3)).toBe(2491);        // 2416 + the 75 it raised to — PLAY_SEAT_INFO said 2491 before the hand
    expect(S.ws.startCents.get(4)).toBe(6437);        // folded, nothing in
  } finally {
    wsSeams.archiveHand = arch0;
  }
});

test("the /hand export carries them in BB for the dealt seats, and a frame without an account adds nothing", () => {
  resetState();
  scratchDirs();
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    hand723Preflop();
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 64, bet: 0, raise: 0 });                   // no account field
    const h = handStateIgnition();
    expect(h).not.toBeNull();
    expect(Object.fromEntries(h!.startStacks)).toEqual({ 1: 103.7, 4: 102.72, 6: 100 });   // 20741 / 20545 / 20000 at 200
    expect(S.ws.startCents.get(4)).toBe(20545);
  } finally {
    wsSeams.archiveHand = arch0;
  }
});
