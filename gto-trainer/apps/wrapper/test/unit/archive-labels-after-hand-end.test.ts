/**
 * THE ARCHIVE CARRIES THE LABELS THE LIVE DECISION USED (2026-10-14, the answer-path audit's finding 9: 3 of 137
 * two-dealt hands — 4924409838, 4923632240, 4921655739 — and 7 of 5,682 archived hands labelled the SB poster BB/BTN
 * while every live answer read the posts right). The cause, off ws_dump.jsonl: after PLAY_STAGE_END_REQ the client sends
 * PLAY_CLEAR_INFO and one CO_DEALER_SEAT before the next PLAY_STAGE_INFO — normally the ended hand's own button again, but
 * when a seat sat out or left at the hand's end it is the hand TO COME's button. 4924409838 (heads-up, hero seat 3 posted
 * the big blind, button on 2): seat 2 sat out at 00:42:34.236, CO_DEALER_SEAT 3 came at .507, the session stopped, and the
 * archive — written off the live state after that frame — named hero the dealer: positions {3: SB, 2: BB}, roster.dealer 3.
 * The frames below are the hand's own, verbatim from wrapper-debug/ws_dump.jsonl (the DOM reader is not involved).
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { DATA_DIR, reloadConfig } from "../../src/config";
import { S, resetState } from "../../src/state";
import { archiveHand } from "../../src/archive";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { handStateIgnition, heroPosition, positionsAll, seatRoster } from "../../src/ignition/hand";
import { J, scratchDirs } from "./helpers";

const sorted = (m: Map<number, string> | Record<string, string>) =>
  J((m instanceof Map ? [...m] : Object.entries(m).map(([k, v]) => [Number(k), v] as [number, string])).sort((a, b) => a[0] - b[0]));
const map = (o: Record<number, string>) => J(Object.entries(o).map(([k, v]) => [Number(k), v]).sort((a, b) => (a[0] as number) - (b[0] as number)));

function quiet<T>(fn: () => T): T {
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try { return fn(); } finally { wsSeams.archiveHand = arch0; }
}

function archivedRow(cid: string): any | null {
  const c = new Database(join(DATA_DIR(), "hands.db"));
  try {
    const r = c.query("SELECT data FROM hands WHERE client_hand_id = ? AND status = 'done' ORDER BY rowid DESC LIMIT 1").get(cid) as { data: string } | null;
    return r ? JSON.parse(r.data) : null;
  } finally {
    c.close();
  }
}

test("4924409838 from its own frames: the button that moved after the hand ended does not relabel the ended hand", () => {
  scratchDirs("wrapper-archive-labels-");
  reloadConfig();
  resetState();
  quiet(() => {
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4924409838" });                                                   // 00:41:26.270
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 2 });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 2 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 270, baseStakes: 0, btn: 2, bet: 2, dead: 0 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 3, account: 592, baseStakes: 0, btn: 4, bet: 5, dead: 0 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat2: [32896, 32896], seat3: [25, 6] });                                   // hero seat 3, K♦ 7♣
    onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 2 });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 2, btn: 256, bet: 3, raise: 0, account: 267 });                        // the SB completes
    onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 3 });
  });
  // the live read hero's decisions were answered from: the dealer posted the small blind, hero is the big blind
  expect(sorted(positionsAll())).toBe(map({ 2: "SB", 3: "BB" }));
  expect(heroPosition()).toBe("BB");
  expect(seatRoster()!.dealer).toBe(2);
  quiet(() => {
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 64, bet: 0, raise: 0, account: 592 });                         // hero checks
    onGameMsg({ pid: "CO_RESULT_INFO", account: [0, 0, 842, 0, 0, 0, 0, 0, 0], handHi2: [2, 1, 5, 0, 4], handHi3: [4, 0, 6, 3, 2] });
    onGameMsg({ pid: "PLAY_STAGE_END_REQ" });                                                                        // 00:42:32.485
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 1, seat: 2, state: 32, account: 0, nickName: "" });                     // seat 2 sits out
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4924409838" });                                                   // the end-of-hand repeat
    onGameMsg({ pid: "CO_LAST_HAND_NUMBER", stageNo: "4924409838" });
    onGameMsg({ pid: "PLAY_CLEAR_INFO" });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });                                                                   // 00:42:34.507 — the hand to come's button
  });
  // the ended hand keeps the labels it was played under — on /hand (the live row) …
  expect(sorted(positionsAll())).toBe(map({ 2: "SB", 3: "BB" }));
  expect(heroPosition()).toBe("BB");
  const r = seatRoster()!;
  expect(r.dealer).toBe(2);
  expect(r.seats[2]).toEqual({ status: "dealt", posted: "sb" });
  expect(r.seats[3]).toEqual({ status: "dealt", hero: true, posted: "bb" });
  const h = handStateIgnition()!;
  expect(sorted(h.positions)).toBe(map({ 2: "SB", 3: "BB" }));
  expect(h.roster.dealer).toBe(2);
  // … and in the archive the 8-s flush / a session stop writes off that same state
  archiveHand();
  const row = archivedRow("4924409838");
  expect(row).not.toBeNull();
  expect(sorted(row.positions)).toBe(map({ 2: "SB", 3: "BB" }));
  expect(row.roster.dealer).toBe(2);
  expect(row.actions.slice(0, 2).map((a: any) => [a.seatId, a.type])).toEqual([[2, "post-sb"], [3, "post-bb"]]);
  // the next hand opens with the moved button, as it would have before
  quiet(() => onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4924409900" }));
  expect(S.ws.dealer).toBe(3);
  expect(S.ws.nextDealer).toBeUndefined();   // held only between the hand's end and the next hand's open
  // …and its own dealer frames still name the button as before
  quiet(() => onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 }));
  expect(S.ws.dealer).toBe(3);
});

test("a dealer frame while the hand is in play still moves the button (the two frames after PLAY_STAGE_INFO)", () => {
  scratchDirs("wrapper-archive-labels-");
  reloadConfig();
  resetState();
  quiet(() => {
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4923549614" });
    expect(S.ws.dealer).toBeNull();
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 1 });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 1 });
  });
  expect(S.ws.dealer).toBe(1);
  expect(S.ws.handOver).toBe(false);
});
