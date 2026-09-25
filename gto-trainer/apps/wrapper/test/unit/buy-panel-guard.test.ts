/**
 * THE BUY-CHIPS PANEL OVER THE STRIP (2026-09-25 audit): closeBuyPanel dropped its flag BEFORE pressing and ignored
 * the result, and actReal only checked that flag — so a close that was refused left the panel up and the next press
 * (a panel /act) clicked the strip's coordinates on the panel. Now the press refuses on its own read, and the flag
 * drops only when the close went through.
 */
import { expect, test } from "bun:test";
import * as cdp from "../../src/cdp";
import { S, resetState, seams } from "../../src/state";
import { act } from "../../src/relay";
import { closeBuyPanel } from "../../src/topup";
import { buyPanelUp } from "../../src/ignition/dom";
import { scratchDirs } from "./helpers";

const read = (panel: boolean) => ({
  seated: true,
  nodes: [],
  buttons: [
    { text: "FOLD", qa: "foldButton", x: 100, y: 500, w: 80, h: 30 },
    { text: "CALL 1", qa: "callButton", x: 200, y: 500, w: 80, h: 30 },
    ...(panel ? [{ text: "BUY", qa: "buyInButton", x: 150, y: 480, w: 80, h: 30 }] : []),
  ],
});

test("one definition of 'the panel is up'", () => {
  expect(buyPanelUp(read(true))).toBe(true);
  expect(buyPanelUp(read(false))).toBe(false);
});

test("a press refuses when ITS OWN read shows the Buy-chips panel, whatever our flag says", async () => {
  resetState();
  scratchDirs("wrapper-buypanel-");
  const t0 = seams.ignitionTarget, ev0 = cdp.io.evaluate;
  seams.ignitionTarget = async () => ({ webSocketDebuggerUrl: "ws://test" }) as any;
  cdp.io.evaluate = async () => read(true);
  try {
    S.topupPanel.open = false;                     // the flag believes the panel is gone
    const r = await act("FOLD", "action");
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("Buy-chips panel");
  } finally {
    seams.ignitionTarget = t0;
    cdp.io.evaluate = ev0;
  }
});

test("the panel counts as closed only when the close press went through", async () => {
  resetState();
  const act0 = seams.act;
  try {
    S.topupPanel.open = true;
    seams.act = async () => ({ ok: false, reason: "that press would land on table 3" });
    await closeBuyPanel();
    expect(S.topupPanel.open).toBe(true);          // refused: still up, and every later check knows it
    seams.act = async () => ({ ok: true });
    await closeBuyPanel();
    expect(S.topupPanel.open).toBe(false);
  } finally {
    seams.act = act0;
  }
});
