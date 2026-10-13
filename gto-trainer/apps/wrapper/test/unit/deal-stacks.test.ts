/**
 * EVERY DEALT SEAT'S STACK AT THE DEAL (ignition/ws.ts dealtCents → /hand `startStacks` + `startStacksSource`,
 * 2026-10-14, the answer-path audit's finding 1).
 *
 * Until now `startStacks` covered a seat only once it had sent a frame this hand, so at an HJ / CO / BTN first-in
 * hero and every seat behind him were the screen's readings — the previous hand's END stack while a top-up or reload
 * was landing (4923624883: the HJ read 77.4bb, dealt 149.2; 4923399415: the BTN read 50.4 after a reload to 166.8;
 * 4924193800: nothing readable, 100bb assumed). The figures here are the frames of a $1/$2 table in the shape the
 * socket dumps show them: the previous hand's CO_RESULT_INFO, a buy (PLAY_ACCOUNT_CASH_RES type 2), a seat word
 * (PLAY_SEAT_INFO), and the seat's own first frame, which is exact and replaces the carried figure.
 */
import { expect, test } from "bun:test";
import { S, resetState } from "../../src/state";
import { dealtCents, onGameMsg, wsSeams } from "../../src/ignition/ws";
import { handStateIgnition } from "../../src/ignition/hand";
import { scratchDirs } from "./helpers";

const HERO_CARDS = { seat1: [32896, 32896], seat2: [32896, 32896], seat3: [33, 51], seat4: [32896, 32896], seat5: [32896, 32896], seat6: [32896, 32896] };

/** Hand 1 played to its end: six seats, the pot paid, every seat's account in the result frame. */
function handOneEnds(result = [20741, 20545, 15000, 7340, 30020, 20000, 0, 0, 0]): void {
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4923624800" });
  onGameMsg({ pid: "CO_DEALER_SEAT", seat: 6 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 20641, btn: 2, bet: 100, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 20345, btn: 4, bet: 200, dead: 0 });
  onGameMsg({ pid: "CO_CARDTABLE_INFO", ...HERO_CARDS });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 1024, bet: 0, raise: 0, account: 15000 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 1024, bet: 0, raise: 0, account: 7340 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 5, btn: 1024, bet: 0, raise: 0, account: 30020 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 6, btn: 1024, bet: 0, raise: 0, account: 20000 });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 1024, bet: 0, raise: 0, account: 20641 });
  onGameMsg({ pid: "CO_RESULT_INFO", account: result });
  onGameMsg({ pid: "PLAY_STAGE_END_REQ" });
}

/** Hand 2 up to the deal: the button moved, the blinds posted, the cards out — nobody else has acted. */
function handTwoDealt(): void {
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4923624883" });
  onGameMsg({ pid: "CO_DEALER_SEAT", seat: 1 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 20445, btn: 2, bet: 100, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 3, account: 14800, btn: 4, bet: 200, dead: 0 });
  onGameMsg({ pid: "CO_CARDTABLE_INFO", ...HERO_CARDS });
}

function fresh(): () => void {
  resetState();
  scratchDirs();
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  return () => { wsSeams.archiveHand = arch0; };
}

const cents = () => Object.fromEntries([...dealtCents()].map(([s, v]) => [s, [v.cents, v.source]]));

test("at the deal every dealt seat has a figure: the blinds' own frames, the previous hand's result for the rest", () => {
  const done = fresh();
  try {
    handOneEnds();
    handTwoDealt();
    expect(cents()).toEqual({
      1: [20741, "result"], 2: [20545, "frame"], 3: [15000, "frame"], 4: [7340, "result"], 5: [30020, "result"], 6: [20000, "result"],
    });
    const h = handStateIgnition()!;
    expect(Object.fromEntries(h.startStacks)).toEqual({ 1: 103.7, 2: 102.72, 3: 75, 4: 36.7, 5: 150.1, 6: 100 });
    expect(Object.fromEntries(h.startStacksSource)).toEqual({ 1: "result", 2: "frame", 3: "frame", 4: "result", 5: "result", 6: "result" });
  } finally { done(); }
});

test("the seat's own first frame replaces the carried figure — and a carried figure never overrides a frame", () => {
  const done = fresh();
  try {
    handOneEnds();
    handTwoDealt();
    // the CO's fold frame: its account says 7340 as dealt (nothing put in) — the exact figure, source "frame"
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 1024, bet: 0, raise: 0, account: 7340 });
    expect(cents()[4]).toEqual([7340, "frame"]);
    // the BTN's raise: account after the raise + the chips added = dealt; the carried 20000 was a cent off (a chip
    // the result frame did not show) and the frame wins
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 4096, bet: 0, raise: 500, account: 19501 });
    expect(cents()[1]).toEqual([20001, "frame"]);
    expect(S.ws.startCents.get(1)).toBe(20001);
  } finally { done(); }
});

test("a top-up between hands is the seat's new stack (PLAY_ACCOUNT_CASH_RES type 2 `cash`), a reload too", () => {
  const done = fresh();
  try {
    // the CO busted in hand 1 (0 in the result) and rebought; the BTN topped up to the max
    handOneEnds([20741, 20545, 15000, 0, 30020, 15555, 0, 0, 0]);
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 4, cash: 20000 });
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 6, cash: 20000 });
    // a refused top-up (type 5, cash 0) changes nothing
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 5, seat: 1, cash: 0 });
    handTwoDealt();
    expect(cents()[4]).toEqual([20000, "buy"]);
    expect(cents()[6]).toEqual([20000, "buy"]);
    expect(cents()[1]).toEqual([20741, "result"]);
  } finally { done(); }
});

test("a seat change: the seat word carries the new player's stack, and an emptied seat has no figure", () => {
  const done = fresh();
  try {
    handOneEnds();
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 0, seat: 5, state: 16, account: 0, nickName: "" });       // left
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 1, seat: 4, state: 32, account: 9930, nickName: "" });    // sitting out, 9930 behind
    handTwoDealt();
    expect(cents()[5]).toBeUndefined();
    expect(cents()[4]).toEqual([9930, "seat"]);
    // the new player in seat 5 is heard from only when he posts: his post-in frame is exact
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 19800, btn: 8, bet: 200, dead: 0 });
    expect(cents()[5]).toEqual([20000, "frame"]);
  } finally { done(); }
});

test("a seat the result gives 0 (busted, empty) has no carried figure", () => {
  const done = fresh();
  try {
    handOneEnds([20741, 20545, 15000, 0, 30020, 20000, 0, 0, 0]);
    handTwoDealt();
    expect(cents()[4]).toBeUndefined();
    expect(handStateIgnition()!.startStacks.has(4)).toBe(false);
  } finally { done(); }
});

test("a result the tap never read for the hand just closed carries nothing: the figures would be a hand stale", () => {
  const done = fresh();
  try {
    handOneEnds();
    // a hand the socket played while its result frame was held (a bind-replay gap): it begins and the next one begins
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4923624850" });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 1 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", ...HERO_CARDS });
    expect(Object.keys(cents()).length).toBe(6);          // this one is the next hand after the result: carried
    handTwoDealt();                                        // no CO_RESULT_INFO came for 4923624850
    expect(cents()).toEqual({ 2: [20545, "frame"], 3: [15000, "frame"] });
  } finally { done(); }
});

test("a table snapshot (our socket joined a table, Zone moved us) drops the carried result", () => {
  const done = fresh();
  try {
    handOneEnds();
    onGameMsg({ pid: "CO_TABLE_INFO", seatState: [48, 48, 48, 48, 48, 48, 0, 0, 0], dealerSeat: 2, account: [100, 200, 300, 400, 500, 600, 0, 0, 0] });
    handTwoDealt();
    expect(cents()).toEqual({ 2: [20545, "frame"], 3: [15000, "frame"] });
  } finally { done(); }
});

test("a buy that lands mid-hand is for the NEXT deal — the hand in progress keeps the figures it was dealt with", () => {
  const done = fresh();
  try {
    handOneEnds();
    handTwoDealt();
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 6, cash: 25000 });
    expect(cents()[6]).toEqual([20000, "result"]);
    // the hand ends; the result frame shows the buy landed, and the next deal carries it
    onGameMsg({ pid: "CO_RESULT_INFO", account: [20741, 20445, 14800, 7340, 30020, 25000, 0, 0, 0] });
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4923624900" });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 2 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", ...HERO_CARDS });
    expect(cents()[6]).toEqual([25000, "result"]);
    expect(cents()[3]).toEqual([14800, "result"]);
  } finally { done(); }
});
