/**
 * LIVE STEPS (2026-10-12, steps.ts): the panel's one line saying what is happening on this decision right now, derived
 * from what the wrapper already keeps, plus the API's solve steps (POST /panel/steps) and a per-decision trail.
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nowMs, realTime, setFakeTime, time } from "../../src/clock";
import { S, resetState } from "../../src/state";
import { handState } from "../../src/ignition/hand";
import { decisionActions, verifyDone } from "../../src/relay";
import { currentStep, decisionKeyOf, keyFromApi, keyFromRelay, noteAnswerArrived, noteSolveSteps, stepsView, stepsTick } from "../../src/steps";
import { pyJsonDumps } from "../../src/py";
import { scratchDirs } from "./helpers";

const T0 = 1_790_000_000;

/** Hero (seat 1) to act preflop after SB/BB posts and an SB complete — the fold-on-no-answer test's table. */
function seed(o: { toAct?: boolean; answer?: boolean } = {}) {
  const { toAct = true, answer = false } = o;
  S.fakeMode = false;
  S.handNo = 7;
  S.handIds.set(7, "4917000001");
  S.feedPrev = { seated: true, seats: new Map([[1, { stack: "100 BB" }], [2, { stack: "100 BB" }], [3, { stack: "100 BB" }]]) };
  Object.assign(S.liveStatus, { toAct, practice: true, board: [], modal: null, buyPanel: null, timeBank: null });
  Object.assign(S.ws, {
    bb: 200, bbSeen: true, dealt: [1, 2, 3], heroSeat: 1, dealer: 1, board: [], heroCards: ["A♠", "K♦"], potCents: 300, maxBet: 200,
    committed: new Map([[2, 100], [3, 200]]),
    actions: [{ seat: 2, type: "post-sb", cents: 100, street: "preflop" }, { seat: 3, type: "post-bb", cents: 200, street: "preflop" },
              { seat: 2, type: "call", cents: 100, street: "preflop" }],
    actionOn: 1, heroFolded: false, foldedSeats: new Set(), domGraceUntil: 0,
  });
  const h = handState()!;
  const apiKey = pyJsonDumps(["preflop", [], ["As", "Kd"], 0, decisionActions(h).length]);
  Object.assign(S.study, {
    on: true, text: answer ? "PREFLOP — Call 100%" : null, pick: answer ? "Call" : null, roll: null, note: null,
    at: time(), decisionKey: answer ? apiKey : null, handId: answer ? h.handId : null, executed: null,
    auto: false, steps: null, pendingExec: null, lastExec: null,
  });
  return { h, apiKey };
}

afterEach(() => realTime());

test("keys: the API's and the relay's decision keys convert to the wrapper's", () => {
  expect(keyFromApi(7, pyJsonDumps(["flop", ["As"], ["Kd", "Kc"], 3, 5]))).toBe("7|flop|5");
  expect(keyFromRelay(`7|${pyJsonDumps(["turn", [], [], 0, 9])}`)).toBe("7|turn|9");
  expect(keyFromApi(null, "x")).toBeNull();
  expect(keyFromRelay("garbage")).toBeNull();
});

test("answers off: no steps at all (the /state key is omitted)", () => {
  scratchDirs();
  resetState();
  seed();
  S.study.on = false;
  expect(stepsView()).toBeNull();
});

test("hero's turn, nothing from the API yet: 'sending the spot to the solver', counted from the turn's start", () => {
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const { h } = seed();
  stepsTick();
  setFakeTime(T0 + 2.5);
  const c = currentStep()!;
  expect(c.text).toBe("Your turn — sending the spot to the solver");
  expect(c.tick).toBe(true);
  expect(nowMs() - c.at).toBe(2500);
  expect(stepsView()!.key).toBe(decisionKeyOf(h));
});

test("the API's solve steps: the active one is the line, its details ride along, finished ones go on the trail", () => {
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const { h, apiKey } = seed();
  stepsTick();
  const t = nowMs();
  const r = noteSolveSteps({ decisionKey: apiKey, handId: h.handId, steps: [
    { id: "chart", text: "Reading the HRC chart", at: t, endAt: t + 80, status: "failed" },
    { id: "ai", text: "GTO Wizard solving the preflop tree…", at: t + 100, status: "active", detail: ["Ultra 2", "new tree"], usualMs: 4700, slowMs: 8100, limitMs: 30000 },
  ] });
  expect(r.ok).toBe(true);
  setFakeTime(T0 + 6.3);
  const c = currentStep()!;
  expect(c.text).toBe("GTO Wizard solving the preflop tree…");
  expect(c.detail).toEqual(["Ultra 2", "new tree"]);
  expect(c.usualMs).toBe(4700);
  expect(c.limitMs).toBe(30000);
  const v = stepsView()!;
  expect(v.trail.map((m: any) => m.text)).toEqual(["Reading the HRC chart"]);
  expect(v.trail[0].level).toBe("bad");
  expect(v.trail[0].ms).toBe(80);
});

test("an answer whose buttons are not up yet reads as READY, not as a refusal", () => {
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const { h, apiKey } = seed({ answer: true });
  stepsTick();
  S.liveStatus.toAct = false;   // the socket says hero's turn, the strip has not drawn the buttons
  noteAnswerArrived(h.handId, apiKey, "Call", "hrc-6max-preflop", null);
  const c = currentStep()!;
  expect(c.text).toBe("Ready to execute CALL — waiting for the action buttons");
  expect(c.level).toBe("info");
  expect(stepsView()!.trail.map((m: any) => m.text)).toEqual(["Answer: CALL · HRC chart"]);
});

test("a press on its way, then the table's confirmation: pressed → landed, both on the trail", () => {
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const { h, apiKey } = seed({ answer: true });
  stepsTick();
  const rk = `${h.handId}|${apiKey}`;
  S.study.pendingExec = { key: rk, pick: "Call", plan: { kind: "action", label: "call" }, kN: decisionActions(h).length,
                          handId: h.handId, sentAt: time(), deadline: time() + 2.5, attempts: 1 };
  S.study.lastExec = { key: rk, pick: "Call", ok: true, outcome: "pending", at: nowMs(), hand: S.handNo };
  setFakeTime(T0 + 0.6);
  expect(currentStep()!.text).toBe("Pressed CALL — waiting for the table to confirm");
  const log0 = console.log;
  console.log = () => {};
  try {
    verifyDone("confirmed", null, { did: "call" });
  } finally {
    console.log = log0;
  }
  const trail = stepsView()!.trail;
  expect(trail[trail.length - 1].text).toBe("✓ CALL landed on the table");
  expect(trail[trail.length - 1].ms).toBe(600);
});

test("the panel's step line: elapsed, details, amber past slow, red near the limit", () => {
  const html = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper", "panel.html"), "utf-8").replace(/\r\n/g, "\n");
  const start = html.indexOf("  let stepLast = null");
  const end = html.indexOf("  setInterval(() => { if (stepLast");
  expect(start).toBeGreaterThan(0);
  const el = () => ({ className: "", innerHTML: "", textContent: "", style: { display: "" } });
  const box: any = { ...el(), parts: { ".st-text": el(), ".st-el": el(), ".st-det": el() } };
  box.querySelector = (q: string) => box.parts[q];
  const tr = el();
  const $ = (id: string) => (id === "sa-step" ? box : tr);
  const esc = (s: unknown) => String(s ?? "");
  const renderSteps = new Function("$", "esc", `${html.slice(start, end)}; return renderSteps;`)($, esc) as (s: any, on: boolean) => void;
  const now = Date.now();
  const cur = { id: "ai", phase: "solve", text: "GTO Wizard solving the flop tree…", level: "info", at: now - 6200, tick: true,
                detail: ["Ultra 2"], usualMs: 9000, slowMs: 19000, limitMs: 40000 };
  renderSteps({ now, current: cur, trail: [{ text: "Reading the HRC chart", ms: 70, level: "ok", at: now - 6300 }] }, true);
  expect(box.parts[".st-el"].textContent).toBe("6.2 s");
  expect(box.parts[".st-det"].textContent).toBe("Ultra 2 · usually ~9.0 s · gives up at 40 s");
  expect(box.className).toBe(" big");
  expect(tr.innerHTML).toContain("Reading the HRC chart");
  renderSteps({ now, current: { ...cur, at: now - 20000 }, trail: [] }, true);
  expect(box.className).toBe("warn big");
  expect(box.parts[".st-det"].textContent).toContain("slower than usual");
  renderSteps({ now, current: { ...cur, at: now - 33000 }, trail: [] }, true);
  expect(box.className).toBe("bad big");
});

test("a retry of the same decision keeps the first try on the trail and says 'try 2'", () => {
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const { h, apiKey } = seed();
  stepsTick();
  const t = nowMs();
  noteSolveSteps({ decisionKey: apiKey, handId: h.handId, run: 1, steps: [
    { text: "GTO Wizard solving the preflop tree…", at: t, endAt: t + 30000, status: "failed" },
    { id: "final", text: "No answer on this try (30.2 s) — GTO Wizard timed out", at: t + 30000, endAt: t + 30000, status: "failed" },
  ] });
  setFakeTime(T0 + 31);
  noteSolveSteps({ decisionKey: apiKey, handId: h.handId, run: 2, steps: [
    { text: "GTO Wizard solving the preflop tree…", at: nowMs(), status: "active", detail: ["Ultra 2"] },
  ] });
  const c = currentStep()!;
  expect(c.detail).toEqual(["Ultra 2", "try 2"]);
  expect(stepsView()!.trail.map((m: any) => m.text)).toEqual(["Try 1: No answer on this try (30.2 s) — GTO Wizard timed out"]);
});

test("a try that came back empty reads 'asking again'; the poller's final note is not doubled", () => {
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const { h, apiKey } = seed();
  stepsTick();
  const t = nowMs();
  noteSolveSteps({ decisionKey: apiKey, handId: h.handId, run: 1, steps: [
    { id: "s1", text: "Working out your preflop spot", at: t, endAt: t + 5, status: "done" },
    { id: "final", text: "No answer on this try (0.4 s) — action \"C\" not offered", at: t + 400, endAt: t + 400, status: "failed" },
  ] });
  const c = currentStep()!;
  expect(c.text).toBe("This try came back empty — asking again");
  expect(c.detail).toEqual(["action \"C\" not offered"]);
  expect(stepsView()!.trail.map((m: any) => [m.text, m.ms])).toEqual([["No answer on this try (0.4 s) — action \"C\" not offered", null]]);
  S.study.note = "no answer for this spot after 3 tries — action \"C\" not offered";
  S.study.at = time();
  expect(currentStep()!.text).toBe("No answer for this spot after 3 tries — action \"C\" not offered");
});
