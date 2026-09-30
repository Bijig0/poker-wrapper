/**
 * ON DEMAND (2026-09-30, the CoinPoker ring strategy): the panel's SOLVE button records a request on the decision in
 * front of hero (relay.requestSolve → POST /panel/solve); /state carries it as `solveRequest` only while it still belongs
 * to the decision on screen (relay.currentSolveRequest), which is what the API's poller solves; and an on-demand
 * session can never arm auto-execute (relay.setAuto). The panel's renderSolve is read straight out of panel.html.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { S, resetState } from "../../src/state";
import { currentSolveRequest, requestSolve, setAuto } from "../../src/relay";

const hand = (over: Record<string, any> = {}) => ({
  handId: 7, clientHandId: "140900000001", street: "flop", ended: false,
  actions: [{ type: "post-sb" }, { type: "post-bb" }, { type: "raise" }, { type: "call" }, { type: "check" }],
  currentNode: { toActIsHero: true },
  ...over,
});

beforeEach(() => { resetState(); S.study.on = true; S.study.onDemand = true; });
afterEach(() => { resetState(); });

describe("requestSolve — the Solve press", () => {
  test("records the decision on screen: hand, street, the line's length", () => {
    const r = requestSolve(hand());
    expect(r.ok).toBe(true);
    expect(S.study.solveRequest).toMatchObject({ handId: 7, clientHandId: "140900000001", street: "flop", n: 5 });
    expect(typeof S.study.solveRequest.at).toBe("number");
  });
  test("refused with answers off, on a strategy that is not on demand, off hero's turn, with no hand", () => {
    S.study.on = false;
    expect(requestSolve(hand()).why).toContain("answers are off");
    S.study.on = true; S.study.onDemand = false;
    expect(requestSolve(hand()).why).toContain("on-demand strategies");
    S.study.onDemand = true;
    expect(requestSolve(hand({ currentNode: { toActIsHero: false } })).why).toContain("not your turn");
    expect(requestSolve(hand({ ended: true })).ok).toBe(false);
    expect(requestSolve(null).why).toContain("no hand");
    expect(S.study.solveRequest).toBeNull();
  });
});

describe("currentSolveRequest — the /state solveRequest key", () => {
  test("carried while the same decision is on screen", () => {
    requestSolve(hand());
    expect(currentSolveRequest(hand())).toMatchObject({ street: "flop", n: 5 });
    expect(currentSolveRequest(hand())).not.toBeNull();   // reading it does not consume it
  });
  test("dropped the moment the table moves on: another action, another street, another hand, hero no longer to act", () => {
    for (const moved of [
      hand({ actions: [...hand().actions, { type: "bet" }] }),
      hand({ street: "turn" }),
      hand({ clientHandId: "140900000002" }),
      hand({ currentNode: { toActIsHero: false } }),
      null,
    ]) {
      requestSolve(hand());
      expect(currentSolveRequest(moved)).toBeNull();
      expect(S.study.solveRequest).toBeNull();
    }
  });
  test("nothing when the session is not on demand", () => {
    requestSolve(hand());
    S.study.onDemand = false;
    expect(currentSolveRequest(hand())).toBeNull();
  });
});

describe("setAuto — an on-demand session never auto-executes", () => {
  test("arming is refused, even on a practice table", () => {
    S.liveStatus.practice = true;
    const r = setAuto(true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("on demand");
    expect(S.study.auto).toBe(false);
    expect(setAuto(true, { allowReal: true, minutes: 10, hands: 5, reason: "test" }).ok).toBe(false);
    expect(S.study.auto).toBe(false);
  });
  test("disarming still works", () => {
    expect(setAuto(false).ok).toBe(true);
  });
});

describe("the panel's renderSolve", () => {
  const html = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper", "panel.html"), "utf-8").replace(/\r\n/g, "\n");
  const start = html.indexOf("let solveBusy = false;");
  const fnAt = html.indexOf("function renderSolve(answer, myTurn, st) {", start);
  const end = html.indexOf("\n  }\n", fnAt) + 4;
  const src = html.slice(start, end);
  const make = (saOn = true) => {
    const btn = { style: { display: "none" }, disabled: false, innerHTML: "" };
    const renderSolve = new Function("$", "saOn", `${src}; return renderSolve;`)(() => btn, saOn) as (a: any, t: any, st: any) => boolean;
    return { btn, renderSolve };
  };
  test("found in panel.html", () => { expect(start).toBeGreaterThan(0); expect(fnAt).toBeGreaterThan(start); });
  test("hero's turn, no answer, on demand: SOLVE shows and is live", () => {
    const { btn, renderSolve } = make();
    expect(renderSolve(null, true, { onDemand: true })).toBe(true);
    expect(btn.style.display).toBe("block");
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toContain("SOLVE");
  });
  test("a live request: SOLVING…, disabled", () => {
    const { btn, renderSolve } = make();
    renderSolve(null, true, { onDemand: true, solveRequest: { at: 1 } });
    expect(btn.disabled).toBe(true);
    expect(btn.innerHTML).toContain("SOLVING");
  });
  test("hidden once there is an answer, off hero's turn, with answers off, and on any other strategy", () => {
    let m = make();
    m.renderSolve({ text: "FLOP — Check 100%" }, true, { onDemand: true });
    expect(m.btn.style.display).toBe("none");
    m = make();
    m.renderSolve(null, false, { onDemand: true });
    expect(m.btn.style.display).toBe("none");
    m = make(false);
    m.renderSolve(null, true, { onDemand: true });
    expect(m.btn.style.display).toBe("none");
    m = make();
    expect(m.renderSolve(null, true, {})).toBe(false);
    expect(m.btn.style.display).toBe("none");
  });
});

describe("the session preset of an on-demand strategy", () => {
  const view = (over: Record<string, any>) => ({
    id: "x", name: "X", status: "ok", reasons: [], preflop: "p", postflop: "gto",
    preflopLayer: { source: "hrc-6max", label: "charts" }, postflopLayer: { source: "gtow-ai" }, opponentLayer: { source: "hrc-6max" },
    formats: ["ign-ring-NL200-6"], defaultFormat: "ign-ring-NL200-6", ...over,
  });
  test("carries onDemand to the session config and needs no chart server (its preflop piece is GTO Wizard AI alone)", async () => {
    const { strategyPreset } = await import("../../src/sessions");
    const p = strategyPreset(view({ id: "cp-ring-6max-ante-ondemand", onDemand: true, preflopLayer: { source: "gtow-ai-preflop" },
      formats: ["cp-ring-NL50-6"], defaultFormat: "cp-ring-NL50-6" }));
    expect(p.config.onDemand).toBe(true);
    expect(p.config.autoExecute).toBe(false);
    expect(p.onDemand).toBe(true);
    expect(p.chartFree).toBe(true);
    expect(p.requires).toEqual(["api", "gtow"]);
    expect(p.sites).toEqual(["coinpoker"]);
  });
  test("every other strategy's preset is exactly as before (no onDemand, no chartFree keys)", async () => {
    const { strategyPreset } = await import("../../src/sessions");
    const p = strategyPreset(view({}));
    expect("onDemand" in p || "chartFree" in p || "onDemand" in p.config).toBe(false);
    expect(p.requires).toEqual(["api", "hrc6max", "gtow"]);
  });
});
