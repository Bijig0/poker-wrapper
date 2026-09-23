/**
 * Port of tests/test_topup_window.py — the auto top-up's windows and guards, offline: the three windows (not-dealt,
 * fold, hand-over) or why there is none; the hard blocks; the gate is the same rule; the Buy-chips panel guards
 * (closed the moment hero is on the clock, idempotent); the relay folds our own panel away before an action; a
 * stale abort does not wedge the next window; once-per-hand keyed on the CLIENT's hand id; one run per hand.
 */
import { expect, test } from "bun:test";
import { realTime, time } from "../../src/clock";
import { S, resetState, seams } from "../../src/state";
import { act } from "../../src/relay";
import { closeBuyPanel, handKey, maybeGuardBuyPanel, maybeTopUp, topUpGate, topupSeams, topupTuning, topUpWindow } from "../../src/topup";
import { checker, J, scratchDirs } from "./helpers";

function seed(o: { seated?: boolean; waiting?: boolean; toAct?: boolean; hero?: string; modal?: any; folded?: boolean; over?: boolean;
                   settled?: boolean; stack?: string } = {}) {
  const { seated = true, waiting = false, toAct = false, hero = "in-hand", modal = null, folded = false, over = false, settled = true,
          stack = "95.0 BB" } = o;
  S.feedPrev = { seated, waiting, toAct, seats: new Map([[4, { stack, hero: true }]]) };
  S.liveStatus = { hero, toAct, modal };
  Object.assign(S.ws, { heroSeat: 4, heroFolded: folded, handOver: over });
  S.study.stackStable = { text: stack, ticks: settled ? 9 : 0 };
  S.topupPanel.open = false;
  S.topupAbort = false;
}

test("the auto top-up's windows and guards", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  scratchDirs();
  realTime();
  resetState();
  const win = () => topUpWindow();
  const log0 = console.log;
  console.log = () => {};
  const saved = { seams: { ...seams }, topup: { ...topupSeams }, jitter: [...topupTuning.jitterS] as [number, number] };
  try {
    seed({ hero: "not-in-hand" });
    eq("hero not dealt into the hand", win(), [true, "not-dealt", null]);
    seed({ hero: "sitting-out" });
    eq("hero sitting out", win()[1], "not-dealt");
    seed({ hero: "waiting-for-bb" });
    eq("hero waiting for the big blind", win()[1], "not-dealt");
    seed({ hero: "folded", folded: true, settled: false });
    eq("hero folded — fires without waiting for the stack to settle", win(), [true, "fold", null]);
    seed({ over: true, settled: true });
    eq("hand over and the stack has settled", win(), [true, "hand-over", null]);
    seed({ over: true, settled: false });
    check("hand over but the award has not landed", win()[0] === false && (win()[2] || "").includes("award"), J(win()));
    seed({ over: false, folded: false });
    eq("a hand live for hero is not a window", win(), [false, null, "a hand is live for hero"]);

    seed({ hero: "not-in-hand", toAct: true });
    eq("hero on the clock beats every window", win()[2], "hero is on the clock");
    seed({ hero: "folded", folded: true, modal: { text: "Buy-in maximum", harmless: false } });
    eq("a client notice beats every window", win()[2], "a client notice is on screen");
    seed({ seated: false });
    eq("not seated", win()[2], "not seated");
    seed({ waiting: true });
    eq("table broke", win()[2], "waiting for the next hand");

    seed({ hero: "folded", folded: true });
    eq("gate open when the window is", topUpGate(), [true, null]);
    seed({ toAct: true });
    eq("gate shut when hero is on the clock", topUpGate(), [false, "hero is on the clock"]);

    // the Buy-chips panel is modal — the guards
    const pressed: string[] = [];
    seams.act = async (label: string, kind = "action") => { pressed.push(`${kind}:${label}`); return { ok: true }; };
    seed({ hero: "folded", folded: true });
    S.topupPanel.open = true;
    await maybeGuardBuyPanel();
    eq("panel left alone while hero is not on the clock", pressed, []);
    seed({ hero: "folded", folded: true, toAct: true });
    S.topupPanel.open = true;
    await maybeGuardBuyPanel();
    eq("panel closed the moment hero is on the clock", pressed, ["button:Buy chips"]);
    check("and the run is called off", S.topupAbort === true);
    check("and the flag says it is shut", S.topupPanel.open === false);
    pressed.length = 0;
    await maybeGuardBuyPanel();
    eq("closing twice does not re-open it (the press is a toggle)", pressed, []);
    pressed.length = 0;
    S.topupPanel.open = true;
    await closeBuyPanel();
    await closeBuyPanel();
    eq("_close_buy_panel is idempotent", pressed, ["button:Buy chips"]);
    Object.assign(seams, saved.seams);

    // the relay never presses through our own panel
    const seen: string[] = [];
    seams.ignitionTarget = async () => { seen.push("looked for the table"); return null; };
    seed({ hero: "folded", folded: true });
    S.topupPanel.open = true;
    await act("fold", "action");
    check("an action folds the panel away first", S.topupPanel.open === false);
    check("and calls the top-up off", S.topupAbort === true);
    Object.assign(seams, saved.seams);

    // the abort is cleared once the run is over
    Object.assign(S.study, { topUp: true, topUpHand: null, topUpAt: 0.0, topUpDue: null, lastTopUp: null, topUpTrigger: null });
    S.session.id = "test-session";
    S.fakeMode = false;
    seed({ hero: "folded", folded: true });
    S.topupAbort = true;
    maybeTopUp();
    check("a stale abort does not wedge the next window", (S.topupAbort as boolean) === false);
    check("and nothing was scheduled on that tick", S.study.topUpDue !== null && S.study.topUpDue !== undefined, "the wait should be drawn, not skipped");
    S.study.topUpDue = time() + 30;
    seed();
    maybeTopUp();
    check("the wait is dropped when the window shuts", S.study.topUpDue === null);

    // the once-per-hand guard is keyed on the CLIENT's hand id
    S.handNo = 7;
    S.handIds.set(7, "4919080696");
    eq("client id when there is one", handKey(), "4919080696");
    S.handIds.delete(7);
    eq("the reader's own counter only as a fallback", handKey(), "local-7");

    // the scheduler over a run of ticks
    const runs: (string | null)[] = [];
    topupSeams.spawn = (name) => {
      if (name === "top-up") {
        runs.push(S.study.topUpTrigger ?? null);
        S.topupLocked = false;
      }
    };
    topupTuning.jitterS = [0.0, 0.0];
    Object.assign(S.study, { topUp: true, topUpHand: null, topUpAt: 0.0, topUpDue: null, lastTopUp: null, topUpTrigger: null });
    S.session.id = "test-session";
    S.handNo = 101;
    S.handIds.set(101, "hand-101");
    seed();
    for (let i = 0; i < 20; i++) maybeTopUp();
    eq("nothing while the hand is live", runs, []);
    seed({ hero: "folded", folded: true });
    for (let i = 0; i < 20; i++) maybeTopUp();
    eq("exactly one run on the fold", runs, ["fold"]);
    S.handNo = 102;
    S.handIds.set(102, "hand-102");
    S.study.topUpAt = 0.0;
    seed({ hero: "not-in-hand" });
    for (let i = 0; i < 20; i++) maybeTopUp();
    eq("the next hand gets its own run, from the not-dealt window", runs, ["fold", "not-dealt"]);
    S.study.topUpAt = 0.0;
    for (let i = 0; i < 20; i++) maybeTopUp();
    eq("but only once for that hand", runs, ["fold", "not-dealt"]);
    S.handNo = 103;
    S.handIds.set(103, "hand-103");
    Object.assign(S.study, { topUpAt: 0.0, lastTopUp: { at: Math.trunc(time() * 1000), pressed: true, receiptCents: null } });
    seed({ hero: "folded", folded: true });
    for (let i = 0; i < 20; i++) maybeTopUp();
    eq("chips still in flight block the next press", runs, ["fold", "not-dealt"]);
  } finally {
    Object.assign(seams, saved.seams);
    Object.assign(topupSeams, saved.topup);
    topupTuning.jitterS = saved.jitter;
    console.log = log0;
    resetState();
  }
  expect(fails).toEqual([]);
});
