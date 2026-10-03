/**
 * THE TOP-UP REFUSAL OFF THE SOCKET (ignition/ws.ts, 2026-09-30). A buy pressed before a closing river check that then
 * CHOPS is refused when the hand ends: the client's socket says so first — PLAY_STATUS_INFO {type 3, status 2} then
 * PLAY_ACCOUNT_CASH_RES {type 5, seat: hero, cash 0} (session_20260930_104219 hand 4921602320 and six more refusals
 * across the dumps) — and its notice follows seconds later. Only a tick that reads the notice used to file it; with the
 * reader blind (a chat line read as "table broke") the press stayed "pending" and the notice held every press.
 */
import { expect, test } from "bun:test";
import { time } from "../../src/clock";
import { S, resetState } from "../../src/state";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { scratchDirs } from "./helpers";

function rig() {
  resetState();
  scratchDirs("ws-topup-");
  const events: [string, any][] = [];
  S.session.id = "session_test";
  S.sessions = { event: (_sid: string, kind: string, data: any = null) => events.push([kind, data || {}]) } as any;
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  // hero is seat 5 (the seat the deal turned face up), like table 2 of session_20260930_104219
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4921602320" });
  onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 4, account: 240, btn: 2, bet: 2, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 490, btn: 4, bet: 5, dead: 0 });
  onGameMsg({ pid: "CO_CARDTABLE_INFO", seat3: [32896, 32896], seat4: [32896, 32896], seat5: [9, 25] });
  const pressed = () => ({ pressed: true, receiptCents: null, at: Math.trunc(time() * 1000) - 4000, amountCents: 5,
                           trigger: "pre-action", terminalKind: "closing-river-check", handKey: "4921602320" });
  const refusal = () => {
    onGameMsg({ pid: "PLAY_STATUS_INFO", type: 3, status: 2, bData: 5, dwData: 500 });
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 5, seat: 5, cash: 0 });
  };
  const undo = () => { wsSeams.archiveHand = arch0; resetState(); };
  return { events, pressed, refusal, undo };
}

test("PLAY_ACCOUNT_CASH_RES type 5 / cash 0 for hero's seat settles the pressed buy as refused, once", () => {
  const { events, pressed, refusal, undo } = rig();
  try {
    expect(S.ws.heroSeat).toBe(5);
    S.study.lastTopUp = pressed();
    refusal();
    const rec = S.study.lastTopUp;
    expect(rec.refused).toBe(true);
    expect(rec.ok).toBe(false);
    expect(String(rec.refusedBy)).toContain("socket");
    const ev = events.filter(([k]) => k === "top-up-refused-over-max");
    expect(ev.length).toBe(1);
    expect(ev[0]![1].terminalKind).toBe("closing-river-check");
    expect(String(ev[0]![1].how)).toContain("socket");
    expect(S.feed.some((f) => String(f.line).startsWith("Top-up $0.05 refused"))).toBe(true);
    refusal();                                              // the same word again files nothing more
    expect(events.filter(([k]) => k === "top-up-refused-over-max").length).toBe(1);
  } finally {
    undo();
  }
});

test("another seat's buy-in (type 2) or result, or chips actually added is not a refusal; hero's type 2 is his RECEIPT; nor is a press already settled refused", () => {
  const { events, pressed, undo } = rig();
  try {
    S.study.lastTopUp = pressed();
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 3, cash: 500 });
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 5, seat: 3, cash: 0 });
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 5, seat: 5, cash: 5 });
    expect(S.study.lastTopUp.refused).toBeUndefined();
    expect(S.study.lastTopUp.receiptCents).toBeNull();
    expect(events.filter(([k]) => k === "top-up-refused-over-max").length).toBe(0);
    // 2026-10-04: type 2 for HERO's seat is the add going through — the receipt (topup.ts topUpSocketReceipt)
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 5, cash: 500 });
    expect(S.study.lastTopUp.receiptCents).toBe(5);
    expect(S.study.lastTopUp.receiptSource).toBe("socket");
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 5, seat: 5, cash: 0 });
    expect(S.study.lastTopUp.refused).toBeUndefined();
    // the client's receipt came first: the socket's later word changes nothing
    S.study.lastTopUp = { ...pressed(), receiptCents: 5, ok: true };
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 5, seat: 5, cash: 0 });
    expect(S.study.lastTopUp.refused).toBeUndefined();
    // a press older than the refusal window is not this refusal's
    S.study.lastTopUp = { ...pressed(), at: Math.trunc(time() * 1000) - 200_000 };
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 5, seat: 5, cash: 0 });
    expect(S.study.lastTopUp.refused).toBeUndefined();
    expect(events.filter(([k]) => k === "top-up-refused-over-max").length).toBe(0);
  } finally {
    undo();
  }
});
