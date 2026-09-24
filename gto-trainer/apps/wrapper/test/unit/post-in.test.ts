/**
 * POST-INS (2026-09-25, hands 4920414446 56o / 4920414607 9Ts). A new or returning player's live blind, posted out
 * of turn: CO_BLIND_INFO btn 8. The event log dropped it, so the poster's option-CHECK read as an illegal check (the
 * API's capture gate refused all 14 decisions of 56o) and the level reconciler turned a 0.4bb post into an
 * out-of-turn "call". Frames below are hand 4920414446's preflop verbatim from debug/ws_dump.jsonl (40799-40826).
 */
import { expect, test } from "bun:test";
import { S, resetState } from "../../src/state";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { handStateIgnition } from "../../src/ignition/hand";
import { scratchDirs } from "./helpers";

function hand4920414446Preflop(): void {
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4920414446" });
  onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
  onGameMsg({ pid: "CO_SIT_PLAY", play: 1, seat: 5 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 4, account: 469, baseStakes: 0, btn: 2, bet: 2, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 493, baseStakes: 0, btn: 4, bet: 5, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 145, baseStakes: 0, btn: 8, bet: 5, dead: 0 });   // HJ posts in
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 495, baseStakes: 0, btn: 8, bet: 5, dead: 0 });   // CO posts in
  onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [32896, 32896], seat4: [32896, 32896], seat5: [30, 44], seat6: [32896, 32896] });
  onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 6 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 6, btn: 1024, bet: 0, raise: 0, account: 625 });   // UTG folds
  onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 1 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 64, bet: 0, raise: 0, account: 145 });    // HJ checks his option
  onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 2 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 2, btn: 64, bet: 0, raise: 0, account: 495 });    // CO checks his option
  onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 4 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 1024, bet: 0, raise: 0, account: 469 });  // SB folds
  onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 5 });
  onGameMsg({ pid: "CO_SELECT_REQ", btns: 6292032, bet: 0, raise: 10, maxRaise: 498, betPot: 22, halfPot: 13, timeBank: 45 });
}

test("a post-in is recorded as its own action, before the poster's option-check (hand 4920414446)", () => {
  resetState();
  scratchDirs();
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    hand4920414446Preflop();
    const h = handStateIgnition();
    expect(h).not.toBeNull();
    const line = h!.actions.map((a: any) => `${a.seatId}:${a.type}${a.amount != null ? ` ${a.amount}` : ""}`);
    expect(line).toEqual(["4:post-sb 0.4", "5:post-bb 1", "1:post 1", "2:post 1", "6:fold", "1:check", "2:check", "4:fold"]);
    // the posts' chips are this street's money in front of the posters (what the reconciler used to read as calls)
    expect(h!.committed.get(1)).toBe(1);
    expect(h!.committed.get(2)).toBe(1);
  } finally {
    wsSeams.archiveHand = arch0;
  }
});

test("a zero post is not an action (a post frame carrying no chips records nothing)", () => {
  resetState();
  scratchDirs();
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "1" });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 4, account: 469, btn: 2, bet: 2, dead: 0 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 493, btn: 4, bet: 5, dead: 0 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 145, btn: 8, bet: 0, dead: 0 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat4: [32896, 32896], seat5: [30, 44] });
    expect((S.ws.actions ?? []).map((a: any) => a.type)).toEqual(["post-sb", "post-bb"]);
  } finally {
    wsSeams.archiveHand = arch0;
  }
});
