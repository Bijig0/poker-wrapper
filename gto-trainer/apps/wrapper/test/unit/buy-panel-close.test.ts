/**
 * THE BUY-CHIPS PANEL IS CLOSED ON THE TABLE'S WORD (2026-10-10, hand 4923627018, table 1). "Buy chips" is a TOGGLE:
 * a close pressed on our belief alone, when the client had already folded the panel away, OPENED it — and nothing
 * closed it again until hero's next clock. Over 2026-10-08..10 the client re-sent PLAY_BUYIN_INFO for a panel the
 * wrapper had not asked for in 435 hands, runs of up to 16 hands; in hand 4923627018 a villain's raise was drawn
 * under the panel, the screen's pot stayed stale, auto-execute held 60 s and the client folded hero.
 *
 * Now closeBuyPanel reads the table first, presses only a panel it shows, reads again after a beat and presses once
 * more if it stands; maybeGuardBuyPanel closes a stray panel OFF the clock (two ticks shown, no buy in flight), not
 * only when hero is put on the clock.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { SessionStore } from "../../src/sessions";
import { S, resetState, seams } from "../../src/state";
import { BUY_PANEL_CLOSE_PRESSES, closeBuyPanel, maybeGuardBuyPanel, TOP_UP_STRAY_CLOSE_S, topupTuning } from "../../src/topup";
import { scratchDirs } from "./helpers";

type Reads = Array<boolean | null>;
let presses: string[] = [];
let saved: { act: typeof seams.act; target: typeof seams.ignitionTarget; evaluate: typeof cdp.io.evaluate; settle: number };

/** The table's word on each read (the run's own read, topUpRead: the page script through CDP), in order — the last
 *  one repeats; null = the table could not be read (no poker client). */
function table(reads: Reads): void {
  let i = 0;
  seams.ignitionTarget = async () => ({ webSocketDebuggerUrl: "ws://test" }) as any;
  cdp.io.evaluate = async () => {
    const r = reads[Math.min(i, reads.length - 1)];
    i += 1;
    if (r === null) return { seated: false, reason: "poker client not open" };
    return { seated: true, stackCents: 500, maxCents: 500, bbCents: 5, zone: false, panelOpen: r };
  };
}

/** A session on a scratch store, so `buy-panel-closed` events can be read back. */
function startSession(): string {
  const sid = "session_20261010_buypanel_test";
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  const rec = S.sessions.start(sid, "strategy:test", null, null, { tables: 1, answers: true }, { ok: true }, {});
  Object.assign(S.session, { id: sid, rec });
  return sid;
}
const eventsOf = (sid: string, kind: string) => (S.sessions.get(sid)?.events ?? []).filter((e: any) => e.kind === kind);

let tmp = "";
beforeEach(() => {
  resetState();
  tmp = scratchDirs("wrapper-buypanel-close-");
  presses = [];
  saved = { act: seams.act, target: seams.ignitionTarget, evaluate: cdp.io.evaluate, settle: topupTuning.closeSettleS };
  topupTuning.closeSettleS = 0;
  seams.act = async (label) => { presses.push(label); return { ok: true }; };
});

afterEach(() => {
  seams.act = saved.act;
  seams.ignitionTarget = saved.target;
  cdp.io.evaluate = saved.evaluate;
  topupTuning.closeSettleS = saved.settle;
});

test("a panel the table does not show is NOT pressed (the toggle would open it); the flag drops", async () => {
  S.topupPanel.open = true;                        // our belief: up (a BUY was just pressed)
  table([false]);
  const r = await closeBuyPanel();
  expect(presses).toEqual([]);
  expect(r).toEqual({ closed: true, presses: 0, seen: false });
  expect(S.topupPanel.open).toBe(false);
});

test("a panel the table shows is pressed once and read again; gone = closed", async () => {
  S.topupPanel.open = true;
  table([true, false]);
  const r = await closeBuyPanel();
  expect(presses).toEqual(["Buy chips"]);
  expect(r).toEqual({ closed: true, presses: 1, seen: false });
  expect(S.topupPanel.open).toBe(false);
});

test("a press that collided with the client's own close (panel up again) is followed by one more", async () => {
  S.topupPanel.open = true;
  table([true, true, false]);
  const r = await closeBuyPanel();
  expect(presses).toEqual(["Buy chips", "Buy chips"]);
  expect(r).toEqual({ closed: true, presses: 2, seen: false });
  expect(S.topupPanel.open).toBe(false);
});

test("a panel that stands after the last press is left UP for the next tick — the flag never lies", async () => {
  S.topupPanel.open = true;
  table([true]);
  const r = await closeBuyPanel();
  expect(presses.length).toBe(BUY_PANEL_CLOSE_PRESSES);
  expect(r).toEqual({ closed: false, presses: BUY_PANEL_CLOSE_PRESSES, seen: true });
  expect(S.topupPanel.open).toBe(true);
});

test("the table unreadable: the old rule — one press, closed when it went through", async () => {
  S.topupPanel.open = true;
  table([null]);
  const r = await closeBuyPanel();
  expect(presses).toEqual(["Buy chips"]);
  expect(r).toEqual({ closed: true, presses: 1, seen: null });
  expect(S.topupPanel.open).toBe(false);
});

test("a refused press leaves the flag up, whatever the table said", async () => {
  S.topupPanel.open = true;
  table([true]);
  seams.act = async () => ({ ok: false, reason: "that press would land on table 3" });
  const r = await closeBuyPanel();
  expect(r.closed).toBe(false);
  expect(r.presses).toBe(0);
  expect(S.topupPanel.open).toBe(true);
});

test("the reader's word alone (liveStatus.buyPanel, our flag down) is enough to start a verified close", async () => {
  S.topupPanel.open = false;
  S.liveStatus.buyPanel = true;
  table([true, false]);
  const r = await closeBuyPanel();
  expect(presses).toEqual(["Buy chips"]);
  expect(r.closed).toBe(true);
});

test("nothing on the table and nothing believed: no read, no press", async () => {
  S.topupPanel.open = false;
  S.liveStatus.buyPanel = false;
  let reads = 0;
  seams.ignitionTarget = async () => ({ webSocketDebuggerUrl: "ws://test" }) as any;
  cdp.io.evaluate = async () => { reads += 1; return { seated: true, panelOpen: false }; };
  const r = await closeBuyPanel();
  expect(reads).toBe(0);
  expect(presses).toEqual([]);
  expect(r.closed).toBe(true);
});

// ---- the guard, off the clock ------------------------------------------------------------------------------

/** Off the clock: no strip buttons, no toAct. The DOM has shown the panel on `ticks` ticks running. */
function strayPanel(ticks: number): void {
  S.liveStatus.toAct = false;
  S.liveStatus.buyPanel = true;
  S.feedPrev.toAct = false;
  S.topupPanel.open = true;
  S.topupPanel.domTicks = ticks;
  S.topupPanel.lastCloseAt = 0;
}

test("a stray panel — up off the clock, two ticks running, no buy in flight — is closed now", async () => {
  const sid = startSession();
  strayPanel(2);
  table([true, false]);
  await maybeGuardBuyPanel();
  expect(presses).toEqual(["Buy chips"]);
  expect(S.topupPanel.open).toBe(false);
  expect(S.topupLocked).toBe(false);               // the lock it held over the close is released
  const ev = eventsOf(sid, "buy-panel-closed");
  expect(ev.length).toBe(1);
  expect(ev[0].why).toBe("stray");
  expect(ev[0].closed).toBe(true);
});

test("one tick of the panel is not yet a stray (the client may be folding it)", async () => {
  strayPanel(1);
  table([true, false]);
  await maybeGuardBuyPanel();
  expect(presses).toEqual([]);
});

test("a run that owns the panel is left alone off the clock", async () => {
  strayPanel(3);
  table([true, false]);
  S.topupLocked = true;
  await maybeGuardBuyPanel();
  expect(presses).toEqual([]);
  S.topupLocked = false;
  S.topupPrefold.active = true;
  await maybeGuardBuyPanel();
  expect(presses).toEqual([]);
});

test("a stray close is not repeated inside its cooldown", async () => {
  strayPanel(2);
  table([true]);                                    // stands after every press
  await maybeGuardBuyPanel();
  expect(presses.length).toBe(BUY_PANEL_CLOSE_PRESSES);
  expect(S.topupPanel.open).toBe(true);
  await maybeGuardBuyPanel();                       // the same second: no new presses
  expect(presses.length).toBe(BUY_PANEL_CLOSE_PRESSES);
  expect(TOP_UP_STRAY_CLOSE_S).toBeGreaterThan(0);
});

test("hero on the clock with the panel up: closed on the table's word, the run called off, the feed says how", async () => {
  S.liveStatus.toAct = true;
  S.screenReadAt = Date.now() / 1000;
  S.liveStatus.buyPanel = true;
  S.topupPanel.open = false;
  S.topupPanel.lastCloseAt = 0;
  const sid = startSession();
  table([true, false]);
  await maybeGuardBuyPanel();
  expect(presses).toEqual(["Buy chips"]);
  expect(S.topupAbort).toBe(true);
  expect(S.topupPanel.open).toBe(false);
  const ev = eventsOf(sid, "buy-panel-closed");
  expect(ev.length).toBe(1);
  expect(ev[0].why).toBe("on-clock");
});
