/**
 * ONE ACTION COUNT FOR A DECISION (2026-09-25 audit). The API's decision key leaves post-ins out (utils/foldPostIns);
 * pickReady and the no-answer fold counted that way, but spotUnchanged (the retry gate) and the press verifier counted
 * the raw line — so in any hand with a post-in, a press that did not register read as "another action landed first"
 * and was never retried. Real frames: hand 4920414446's preflop (two post-ins; hero BB on the clock).
 */
import { expect, test } from "bun:test";
import { S, resetState } from "../../src/state";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { handStateIgnition } from "../../src/ignition/hand";
import { decisionActions, spotUnchanged } from "../../src/relay";
import { scratchDirs } from "./helpers";

function preflopToHero(): void {
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4920414446" });
  onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
  onGameMsg({ pid: "CO_SIT_PLAY", play: 1, seat: 5 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 4, account: 469, baseStakes: 0, btn: 2, bet: 2, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 493, baseStakes: 0, btn: 4, bet: 5, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 145, baseStakes: 0, btn: 8, bet: 5, dead: 0 });   // HJ posts in
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 495, baseStakes: 0, btn: 8, bet: 5, dead: 0 });   // CO posts in
  onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [32896, 32896], seat4: [32896, 32896], seat5: [30, 44], seat6: [32896, 32896] });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 6, btn: 1024, bet: 0, raise: 0, account: 625 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 64, bet: 0, raise: 0, account: 145 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 2, btn: 64, bet: 0, raise: 0, account: 495 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 1024, bet: 0, raise: 0, account: 469 });
  onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 5 });
}

test("the retry gate counts the decision the way its key does: a post-in hand's unlanded press is still the same spot", () => {
  resetState();
  scratchDirs("wrapper-count-");
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    preflopToHero();
    const h = handStateIgnition()!;
    expect(h.actions.length).toBe(8);                   // the raw line holds the two post-ins
    expect(decisionActions(h).length).toBe(6);          // the key's count leaves them out
    S.liveStatus.toAct = true;
    S.liveStatus.modal = null;
    const kN = decisionActions(h).length;               // what pickReady stored for the press
    const p = { handId: h.handId, kN, key: `${h.handId}|${JSON.stringify(["preflop", [], h.heroCards, 0, kN])}` };
    expect(spotUnchanged(p, h)).toEqual([true, null]);  // was [false, "another action landed first"] → never retried

    // once hero's press lands, the spot has moved on — and the landed action is at index kN of the SAME list
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 5, btn: 64, bet: 0, raise: 0, account: 493 });   // hero checks
    const after = handStateIgnition()!;
    expect(spotUnchanged(p, after)[0]).toBe(false);
    expect(decisionActions(after)[kN]).toMatchObject({ hero: true, type: "check" });
  } finally {
    wsSeams.archiveHand = arch0;
  }
});
