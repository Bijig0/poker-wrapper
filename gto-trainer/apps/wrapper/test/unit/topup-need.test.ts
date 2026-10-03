/**
 * THE TOP-UP NEED (2026-10-04, session_20261003_234358): the pure need function (topupNeed.ts), the socket's receipt
 * and the screen's counted one (topup.ts noteTopUpFrame / checks.ts topUpReceipt / reader.ts receiptRises), the need at
 * the deal with its KPI and stall alarm (topUpDealNeed), the run's "nothing to add" (hand 4922343004, table 2), and the
 * session itself replayed off the table's own frames (test/fixtures/ign-topup-lockout-20261003.jsonl.gz: table 1,
 * 23:53:50 → 23:57:20 — the $0.05 buy of hand 4922343204 that landed at 23:54:11 and the four hands that started at
 * 384 of 500 inside the old 180 s lockout).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { S, resetState, seams } from "../../src/state";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { topUpReceipt } from "../../src/ignition/checks";
import { receiptRises } from "../../src/ignition/reader";
import { needFor, topUpDealNeed, topupSeams, topUpRun } from "../../src/topup";
import { topUpNeed, topUpTolCents, type NeedInput } from "../../src/topupNeed";
import { dumpEntries, replayTopUp } from "../../src/tools/topupReplayCore";
import { scratchDirs } from "./helpers";

const T0 = 1_791_046_000_000;
const inp = (o: Partial<NeedInput> = {}): NeedInput => ({
  point: "deal", handKey: "h2", handNo: 2, stackCents: 384, stackSource: "socket: as dealt", maxCents: 500, bbCents: 5, zone: false,
  pending: null, handEndsMs: [], nowMs: T0, ...o,
});
const pressed = (o: Record<string, any> = {}) => ({ pressed: true, amountCents: 5, beforeCents: 495, pressedAtMs: T0 - 2000, hand: 1, pressHandNo: 1,
                                                    handKey: "h1", receiptCents: null, ...o });

test("the need: short, not short, exactly at the floor, above the max, Zone, unknown, the client's own offer, a reset", () => {
  let v = topUpNeed(inp());
  expect([v.need, v.known, v.shortCents, v.shortBb, v.amountCents, v.blockedBy, v.pendingVerdict]).toEqual([true, true, 116, 23.2, 116, null, null]);
  v = topUpNeed(inp({ stackCents: 498 }));
  expect([v.need, v.known, v.shortCents]).toEqual([false, true, 2]);
  // the floor is 1bb (TOP_UP_MIN_SHORT_BB stays 1.0): 5c short at NL5 is a buy, 4c is not
  expect(topUpNeed(inp({ stackCents: 495 })).need).toBe(true);
  expect(topUpNeed(inp({ stackCents: 496 })).need).toBe(false);
  v = topUpNeed(inp({ stackCents: 507 }));
  expect([v.need, v.known, v.why]).toEqual([false, true, "at or above the max"]);
  v = topUpNeed(inp({ zone: true }));
  expect([v.need, v.blockedBy]).toEqual([false, null]);
  v = topUpNeed(inp({ stackCents: null }));
  expect([v.need, v.known, v.blockedBy]).toEqual([false, false, null]);
  expect(topUpNeed(inp({ maxCents: null })).known).toBe(false);
  // allowedMax 0 = the client says nothing can be added; a smaller offer caps the amount
  expect(topUpNeed(inp({ allowedMaxCents: 0 })).need).toBe(false);
  expect(topUpNeed(inp({ allowedMaxCents: 30 })).amountCents).toBe(30);
  expect(topUpNeed(inp({ stackReset: "armed" })).blockedBy).toContain("deep-stack reset");
  expect(topUpNeed(inp({ stackReset: "idle" })).blockedBy).toBe(null);
  // half a big blind, at least a cent — it was a flat $1 (20bb at NL5)
  expect([topUpTolCents(5), topUpTolCents(200), topUpTolCents(null)]).toEqual([2, 100, 1]);
});

test("a pending buy: pending, landed (receipt / the stack at the deal), lost (a hand end with nothing / no socket), refused", () => {
  // pressed 2 s ago, no hand end since: in flight — it blocks, and says why
  let v = topUpNeed(inp({ pending: pressed() }));
  expect([v.need, v.pendingVerdict]).toEqual([true, "pending"]);
  expect(v.blockedBy).toContain("still in flight");
  // an unknown stack is blocked all the same (the run would read it)
  expect(topUpNeed(inp({ pending: pressed(), stackCents: null })).blockedBy).toContain("still in flight");
  // a receipt (the socket's or the screen's): landed, nothing blocks
  v = topUpNeed(inp({ pending: pressed({ receiptCents: 5 }) }));
  expect([v.pendingVerdict, v.blockedBy]).toEqual(["landed", null]);
  // the stack at the deal shows it: 334 + 116 bought → 450 (no receipt read)
  v = topUpNeed(inp({ stackCents: 450, pending: pressed({ beforeCents: 334, amountCents: 116 }) }));
  expect([v.pendingVerdict, v.need, v.blockedBy]).toEqual(["landed", true, null]);
  // … but only AT THE DEAL: mid-hand the chips are not on the stack yet
  expect(topUpNeed(inp({ point: "final", stackCents: 450, pending: pressed({ beforeCents: 334, amountCents: 116 }) })).pendingVerdict).toBe("pending");
  // a hand ended 1.5 s after the press and nothing came of it 3.5 s later: lost — a new window may press
  v = topUpNeed(inp({ point: "final", pending: pressed({ pressedAtMs: T0 - 5000 }), handEndsMs: [T0 - 3500] }));
  expect([v.pendingVerdict, v.need, v.blockedBy]).toEqual(["lost", true, null]);
  // the end only just happened (the client's word is due within the wait): still pending
  expect(topUpNeed(inp({ point: "final", pending: pressed({ pressedAtMs: T0 - 5000 }), handEndsMs: [T0 - 1000] })).pendingVerdict).toBe("pending");
  // an end within the grace after the press may not be this press's hand: still pending
  expect(topUpNeed(inp({ point: "final", pending: pressed({ pressedAtMs: T0 - 5000 }), handEndsMs: [T0 - 4500] })).pendingVerdict).toBe("pending");
  // no socket at all: two deals and a minute
  expect(topUpNeed(inp({ handNo: 3, pending: pressed({ pressedAtMs: T0 - 61_000 }) })).pendingVerdict).toBe("lost");
  expect(topUpNeed(inp({ handNo: 3, pending: pressed({ pressedAtMs: T0 - 59_000 }) })).pendingVerdict).toBe("pending");
  expect(topUpNeed(inp({ handNo: 2, pending: pressed({ pressedAtMs: T0 - 120_000 }) })).pendingVerdict).toBe("pending");
  // refused: settled, does not block
  v = topUpNeed(inp({ pending: pressed({ refused: true }) }));
  expect([v.pendingVerdict, v.blockedBy]).toEqual(["refused", null]);
});

function rig(prefix: string) {
  resetState();
  scratchDirs(prefix);
  const events: [string, any][] = [];
  S.session.id = "session_test";
  S.sessions = { event: (_sid: string, kind: string, data: any = null) => events.push([kind, data || {}]) } as any;
  Object.assign(S.study, { topUp: true, on: true });
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  const log0 = console.log;
  console.log = () => {};
  const undo = () => { wsSeams.archiveHand = arch0; console.log = log0; realTime(); resetState(); };
  return { events, undo };
}

/** A hand with hero (seat 3) in it; `sb` = hero posts the small blind with this much behind. */
function deal(id: string, o: { sb?: number | null } = {}) {
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: id });
  if (o.sb !== null && o.sb !== undefined) onGameMsg({ pid: "CO_BLIND_INFO", seat: 3, account: o.sb, btn: 2, bet: 2, dead: 0 });
  else onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 600, btn: 2, bet: 2, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 4, account: 700, btn: 4, bet: 5, dead: 0 });
  onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat3: [44, 9], seat4: [32896, 32896] });
}
const endHand = (accounts: number[]) => {
  onGameMsg({ pid: "CO_RESULT_INFO", account: accounts });
  onGameMsg({ pid: "PLAY_STAGE_END_REQ" });
};

test("the stack as dealt: the blinds hero posted go back on (socket and screen), the last hand's end, a buy since", async () => {
  const { events, undo } = rig("topup-need-deal-");
  try {
    setFakeTime(T0 / 1000);
    S.study.topUpMax = { maxCents: 500, bbCents: 5 };
    // the socket: hero posts the small blind with 493 behind — dealt with 495, 1bb short
    deal("4922343204", { sb: 493 });
    let v = needFor("deal");
    expect([v.stackCents, v.stackSource, v.need, v.shortCents]).toEqual([495, "socket: as dealt", true, 5]);
    // the hand ends with hero at 384; the next hand he posts nothing: his stack as dealt is that end
    endHand([600, 0, 384, 700]);
    deal("4922343257");
    v = needFor("deal");
    expect([v.stackCents, v.stackSource, v.shortCents]).toEqual([384, "socket: last hand's end", 116]);
    // a buy landing at that hand's end: the stack as dealt is the new stack
    endHand([600, 0, 384, 700]);
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 3, cash: 500 });
    deal("4922343380");
    v = needFor("deal");
    expect([v.stackCents, v.stackSource, v.need]).toEqual([500, "socket: after the buy", false]);
    // no socket word on hero: the screen's stack with what he has put in this hand added back (topUpDealNeed)
    resetState();
    S.session.id = "session_test";
    S.sessions = { event: (_sid: string, kind: string, data: any = null) => events.push([kind, data || {}]) } as any;
    Object.assign(S.study, { topUp: true, on: true });
    Object.assign(S.ws, { heroSeat: 3, bb: 5, bbSeen: true, committed: new Map([[3, 2]]) });
    S.handNo = 9;
    S.handIds.set(9, "4922343999");
    topupSeams.read = async () => ({ seated: true, stackCents: 493, maxCents: 500, bbCents: 5, zone: false });
    events.length = 0;
    v = (await topUpDealNeed("4922343999"))!;
    expect([v.stackCents, v.stackSource, v.need, v.shortCents]).toEqual([495, "screen", true, 5]);
    const ss = events.find(([k]) => k === "top-up-short-start")?.[1];
    expect([ss?.hand, ss?.stackCents, ss?.dealtCents, ss?.maxCents]).toEqual(["4922343999", 493, 495, 500]);
    const need = events.filter(([k]) => k === "top-up-need");
    expect(need.length).toBe(1);
    expect([need[0]![1].point, need[0]![1].need, need[0]![1].blockedBy]).toEqual(["deal", true, null]);
    expect([S.topupKpi.hands, S.topupKpi.short]).toEqual([1, 1]);
  } finally {
    undo();
  }
});

test("the stall alarm: short at two deals in a row with no run tried between them — once, and not when a run was tried", async () => {
  const { events, undo } = rig("topup-need-stall-");
  try {
    setFakeTime(T0 / 1000);
    topupSeams.read = async () => ({ seated: true, stackCents: 384, maxCents: 500, bbCents: 5, zone: false });
    S.ws.heroSeat = 3;
    for (const [n, id] of [[10, "4922343380"], [11, "4922343479"], [12, "4922343529"]] as [number, string][]) {
      S.handNo = n;
      S.handIds.set(n, id);
      setFakeTime(time() + 40);
      await topUpDealNeed(id);
    }
    let stalls = events.filter(([k]) => k === "top-up-stalled");
    expect(stalls.length).toBe(2);
    expect([stalls[0]![1].handKey, stalls[0]![1].prevHandKey, stalls[0]![1].need]).toEqual(["4922343479", "4922343380", true]);
    expect(S.feed.some((f) => String(f.line).includes("TOP-UP STALLED"))).toBe(true);
    // a run tried since the last deal: no alarm
    S.topupNeed.lastAttemptAt = time();
    S.handNo = 13;
    S.handIds.set(13, "4922343652");
    setFakeTime(time() + 40);
    await topUpDealNeed("4922343652");
    stalls = events.filter(([k]) => k === "top-up-stalled");
    expect(stalls.length).toBe(2);
    // one top-up-need event per hand
    expect(events.filter(([k]) => k === "top-up-need").length).toBe(4);
  } finally {
    undo();
  }
});

test("receipts: two identical screen lines are two receipts; the socket's type 2 settles exactly; one buy is filed once", () => {
  // THE SCREEN'S LINES, COUNTED: hand 2's "$0.05" line, then hand 8's identical one
  const L5 = { text: "You have successfully added $5 in chips." };
  const L05 = { text: "You have successfully added $0.05 in chips." };
  let [rose, counts] = receiptRises([L5, L05], null);
  expect(rose).toEqual(["5", "0.05"]);
  [rose, counts] = receiptRises([L5, L05, L05], counts);
  expect(rose).toEqual(["0.05"]);
  [rose, counts] = receiptRises([{ text: "Seat 2 folds" }], counts);       // the list not drawn for a tick
  expect(rose).toEqual([]);
  [rose, counts] = receiptRises([L5, L05, L05], counts);                    // back: nothing new
  expect(rose).toEqual([]);
  [rose, counts] = receiptRises([L05, L05], counts);                        // the oldest line scrolled off the history
  expect(rose).toEqual([]);
  // the client's TOAST beside the history line (golden recordings 2026-08/09): one receipt, counted in the history's column
  const toast = (x: number) => ({ text: "You have successfully added $200 in chips.", x, y: 118 });
  const hist = (y: number) => ({ text: "You have successfully added $200 in chips.", x: 922, y });
  [rose, counts] = receiptRises([toast(745), hist(192)], null);
  expect(rose).toEqual(["200"]);
  [rose, counts] = receiptRises([toast(734), hist(482)], counts);
  expect(rose).toEqual([]);
  [rose, counts] = receiptRises([toast(734), hist(482), hist(530)], counts);  // a second $200 buy's line
  expect(rose).toEqual(["200"]);

  const { events, undo } = rig("topup-need-receipt-");
  try {
    setFakeTime(T0 / 1000);
    deal("4922343204", { sb: 493 });
    // a seat-down buy-in with no pressed record: noted, nothing filed
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 3, cash: 500 });
    expect(events.filter(([k]) => k === "top-up-receipt").length).toBe(0);
    // SOCKET FIRST: pressed at 495, the hand ends at 495, PLAY_ACCOUNT_CASH_RES {type 2, hero, cash 500} → exactly $0.05
    S.study.lastTopUp = { pressed: true, ok: false, amountCents: 5, beforeCents: 495, at: T0, pressedAtMs: T0, bbCents: 5, handKey: "4922343204", hand: S.handNo };
    setFakeTime(T0 / 1000 + 2);
    endHand([877, 490, 495, 651]);
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 2, cash: 500 });   // another seat's rebuy: not ours
    expect(S.study.lastTopUp.receiptCents).toBeFalsy();
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 3, cash: 500 });
    let rec = S.study.lastTopUp;
    expect([rec.ok, rec.receiptCents, rec.receiptSource, rec.afterCents]).toEqual([true, 5, "socket", 500]);
    // … then its line on the screen: the same buy — not counted again
    topUpReceipt("0.05");
    expect(S.study.lastTopUp.receiptSource).toBe("socket+screen");
    let rx = events.filter(([k]) => k === "top-up-receipt");
    expect(rx.length).toBe(1);
    expect(rx[0]![1].source).toBe("socket");
    // SCREEN FIRST, then the socket: filed once too
    S.study.lastTopUp = { pressed: true, ok: false, amountCents: 5, beforeCents: 495, at: T0 + 10_000, pressedAtMs: T0 + 10_000, bbCents: 5, handKey: "4922343257" };
    setFakeTime(T0 / 1000 + 12);
    topUpReceipt("0.05");
    expect([S.study.lastTopUp.receiptCents, S.study.lastTopUp.receiptSource]).toEqual([5, "screen"]);
    onGameMsg({ pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 3, cash: 500 });
    expect(S.study.lastTopUp.receiptSource).toBe("screen+socket");
    rx = events.filter(([k]) => k === "top-up-receipt");
    expect(rx.length).toBe(2);
    // THE TOLERANCE IS HALF A BIG BLIND: a $0.10 line is not this $0.05 press's receipt (it was within $1)
    S.study.lastTopUp = { pressed: true, ok: false, amountCents: 5, beforeCents: 495, at: T0 + 20_000, pressedAtMs: T0 + 20_000, bbCents: 5 };
    setFakeTime(T0 / 1000 + 21);
    topUpReceipt("0.10");
    rec = S.study.lastTopUp;
    expect(rec.receiptCents).toBeFalsy();
  } finally {
    undo();
  }
});

test("a window after the table paid hero above the max is no buy (hand 4922342889); a panel at Max $0 is closed, nothing pressed", async () => {
  const { events, undo } = rig("topup-need-max0-");
  const seams0 = { ...seams };
  const io0 = { ...cdp.io };
  try {
    setFakeTime(1791046351.0);
    S.study.topUpMax = { maxCents: 500, bbCents: 5 };
    deal("4922342889", { sb: null });
    // the table paid hero 507; the felt still read 495 (99 BB)
    endHand([602, 143, 507, 301, 612, 485]);
    const v = needFor("final", { stackCents: 495, maxCents: 500, bbCents: 5 });
    expect([v.stackCents, v.stackSource, v.need]).toEqual([507, "socket: last hand's end", false]);

    // THE RUN AT "MAX. $0": the client's socket says allowedMax 0 as the panel opens — close it, press no BUY
    const pressedLabels: string[] = [];
    let panelUp = false;
    seams.ignitionTarget = async () => ({ webSocketDebuggerUrl: "ws://stub" });
    seams.act = async (label: string) => {
      pressedLabels.push(label);
      if (label === "Buy chips") {
        panelUp = !panelUp;
        if (panelUp) onGameMsg({ pid: "PLAY_BUYIN_INFO", type: 1, seat: 3, displayMax: 500, allowedMax: 0, allowedMin: 0, defaultBuyin: 0 });
      }
      return { ok: true };
    };
    cdp.io.evaluate = async () => ({ seated: true, stackCents: 495, stackText: "99 BB", maxCents: 500, bbCents: 5, zone: false,
                                     panelOpen: panelUp, offerCents: panelUp ? 0 : null });
    // no socket word on this hand's stack (a new hand dealt, hero not yet in it): the screen's 495 says 5 short
    deal("4922343004", { sb: null });
    S.ws.dealt = [1, 4];
    S.ws.heroDealt = false;
    S.topupSock.end = null;
    Object.assign(S.feedPrev, { seated: true, waiting: false, toAct: false });
    S.liveStatus = { hero: "not-in-hand", toAct: false, modal: null };
    S.study.topUpTrigger = "not-dealt";
    const rec = await topUpRun();
    expect(pressedLabels).toEqual(["Buy chips", "Buy chips"]);
    expect([rec.ok, rec.pressed]).toEqual([true, false]);
    expect(String(rec.reason)).toContain("nothing to add");
    expect(S.topupPanel.open).toBe(false);
  } finally {
    Object.assign(seams, seams0);
    Object.assign(cdp.io, io0);
    undo();
  }
});

test("REPLAY session_20261003_234358 table 1: the 23:54:09 buy settles at 23:54:11.494 off the socket; hands 10-13 are no longer locked out", () => {
  const { undo } = rig("topup-need-replay-");
  try {
    const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(import.meta.dir, "..", "fixtures", "ign-topup-lockout-20261003.jsonl.gz"))));
    const entries = dumpEntries(text);
    // the press as the session recorded it (top-up, hand 4922343204, pre-action, $0.05 at 495), and the screen receipts
    // the session actually filed (none between 23:54:09 and the end of the old lockout — the identical line was missed)
    const { hands, events } = replayTopUp(entries, {
      viaTap: true, maxCents: 500,
      presses: [{ atMs: 1791046449156, amountCents: 5, beforeCents: 495, handKey: "4922343204", trigger: "pre-action" }],
      oldReceiptsMs: [1791045921096, 1791045926418, 1791045979061, 1791046212846, 1791046233466, 1791046239300, 1791046341585],
    });
    const h = (id: string) => hands.find((x) => x.handKey === id)!;
    // THE BUY LANDED, AND THE SOCKET SAID SO: 23:54:11.494, $0.05 exactly
    expect(h("4922343204").receiptsAt).toEqual([{ at: 1791046451.494, cents: 5, source: "socket" }]);
    // its own fold came while it was in flight: held, and saying so
    expect(h("4922343204").window!.pressAllowed).toBe(false);
    expect(h("4922343204").window!.blockedBy).toContain("still in flight");
    // KThh folded at 384: the fold window presses now (the old rule was locked out)
    expect([h("4922343257").window!.trigger, h("4922343257").window!.pressAllowed, h("4922343257").window!.oldBlocked]).toEqual(["fold", true, true]);
    // hands 10-13: started at 384 of 500 — need at the deal, off the socket, nothing in the way; the fold window
    // presses; the old rule blocked every one
    for (const id of ["4922343380", "4922343479", "4922343529", "4922343652"]) {
      const x = h(id);
      expect([x.deal!.need, x.deal!.shortCents, x.deal!.stackCents, x.deal!.blockedBy, x.deal!.pendingVerdict]).toEqual([true, 116, 384, null, "landed"]);
      expect(String(x.deal!.stackSource)).toStartWith("socket");
      expect([x.window!.trigger, x.window!.need, x.window!.pressAllowed, x.window!.oldBlocked]).toEqual(["fold", true, true, true]);
    }
    // nothing given up as lost: every buy in the window was settled by its receipt
    expect(events.filter(([k]) => k === "top-up-lost").length).toBe(0);
  } finally {
    undo();
  }
});
