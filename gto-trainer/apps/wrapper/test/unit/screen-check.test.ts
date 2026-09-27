/**
 * THE SCREEN CHECKS THE PROTOCOL'S LINE (ignition/shadow.ts screenPotCheck, 2026-09-26). The screen redraws after the
 * socket delivers — every disagreement on a line Ignition confirms cleared within 1.4 s over the golden recordings —
 * so a disagreement holds the decision only once it has lasted SCREEN_POT_HOLD ticks AND SCREEN_POT_HOLD_S seconds,
 * and only while the screen shows this hand (hero's hole cards and the protocol's board).
 */
import { afterEach, expect, test } from "bun:test";
import { realTime, setFakeTime } from "../../src/clock";
import { S, resetState } from "../../src/state";
import { protocolUncertain, protocolHand } from "../../src/ignition/hand";
import { SCREEN_POT_HOLD_S, screenPotCheck } from "../../src/ignition/shadow";
import { onGameMsg } from "../../src/ignition/ws";

afterEach(() => realTime());

/** Blinds 2/5, hero (seat 1) dealt two cards face up, seat 3 raises to 15: 22 cents in; the screen shows hero's cards. */
function hand() {
  resetState();
  S.handNo = 0;
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4920000001" });
  onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 498, btn: 2, bet: 2, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 495, btn: 4, bet: 5, dead: 0 });
  onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [12, 25], seat2: [32896, 32896], seat3: [32896, 32896] });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 4096, bet: 0, raise: 15, account: 485 });
  const p = protocolHand()!;
  S.tapDomCards = [...p.heroCards];
  return p;
}

const tick = (t: number, potBb: number, board: string[] = []) => {
  setFakeTime(t);
  screenPotCheck(S.handNo, potBb, board);
};

test("a screen lagging the socket for a second is not a disagreement", () => {
  const p = hand();
  for (let k = 0; k < 8; k++) tick(1000 + k * 0.2, 1.4);        // the screen still shows the blinds (1.4 BB), 1.4 s
  expect(protocolUncertain(p, null)).toBeNull();
  tick(1002, 4.4);                                               // it catches up: 22 cents = 4.4 BB
  expect(S.screenCheck.bad).toBe(0);
});

test("a disagreement that lasts holds the decision, and clears when the screen agrees", () => {
  const p = hand();
  for (let k = 0; k <= 16; k++) tick(1000 + k * 0.25, 1.4);    // 4 s of 1.4 BB against a 4.4 BB line
  expect(SCREEN_POT_HOLD_S).toBeLessThanOrEqual(4);
  expect(protocolUncertain(p, null)).toBe("line uncertain — the pot on screen (1.4 BB) disagrees with the protocol's line");
  tick(1005, 4.4);
  expect(protocolUncertain(p, null)).toBeNull();
});

test("a screen showing another hand (other hole cards) or another street is not compared", () => {
  hand();
  S.tapDomCards = ["2♣", "3♦"];
  for (let k = 0; k <= 16; k++) tick(1000 + k * 0.25, 1.4);
  expect(S.screenCheck.bad).toBe(0);
  hand();
  for (let k = 0; k <= 16; k++) tick(1000 + k * 0.25, 1.4, ["2♣", "3♦", "4♥"]);   // a flop no frame dealt
  expect(S.screenCheck.bad).toBe(0);
});
