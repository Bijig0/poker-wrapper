/**
 * SHOVES ON THE REAL STRIP (2026-09-25). Hand 4920545590, QJdd on A♦K♥J♣2♠J♠: the river answer was ALLIN 89.2,
 * auto-execute clicked the ALL-IN preset, the client relabelled the confirm "RAISE TO 2 BB" → "ALL-IN 89.2 BB", the
 * relay looked for a control labelled raise/bet, found none, refused — and fold-on-no-answer folded trip jacks at
 * "4 s left" with 45 s of time bank still to come. Every preset-sized Ignition shove in the session records had
 * been refused the same way (ALLIN 18, 94.2, 89.2), and a shove the table only offered as a CALL (hand 4920544353,
 * FOLD / CALL 21.6 BB against a jam) was refused twice and folded.
 *
 * These drive the relay's REAL reads and clicks (act, raiseTo, actuateAllIn, the feed-loop functions) against a
 * fake table built from the strips recorded on the live client (fakeIgnition.ts).
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime, time } from "../../src/clock";
import { bankStep } from "../../src/ignition/dom";
import { handSeams } from "../../src/ignition/hand";
import { pyJsonDumps } from "../../src/py";
import {
  actuate, actuateAllIn, didAsTold, heroTimeLeft, maybeAutoAct, maybeFoldNoAnswer, maybeTakeTime, maybeVerifyExec, raiseTo,
} from "../../src/relay";
import { S, resetState } from "../../src/state";
import { callIsMaxCommit } from "../../src/terminal";
import * as FAKE from "../../src/faketable";
import { BET_SPOT, FACING_JAM, FakeIgnition, RIVER_FACING_BET } from "./fakeIgnition";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_790_320_459;

/** Hand 4920545590 at hero's river decision (14 actions, facing a 1 BB bet, 89.2 behind). */
function qjRiver(heroAct: Record<string, any> | null = null): Record<string, any> {
  const a = (seatId: number, type: string, street: string, amount?: number): Record<string, any> =>
    ({ seatId, hero: seatId === 5, type, street, ...(amount !== undefined ? { amount } : {}) });
  const actions: Record<string, any>[] = [
    a(3, "post-sb", "preflop", 0.4), a(4, "post-bb", "preflop", 1), a(5, "raise", "preflop", 2.6), a(6, "fold", "preflop"),
    a(2, "fold", "preflop"), a(3, "call", "preflop", 2.2), a(4, "raise", "preflop", 10.4), a(5, "call", "preflop", 7.8),
    a(3, "fold", "preflop"), a(4, "check", "flop"), a(5, "check", "flop"), a(4, "check", "turn"), a(5, "check", "turn"),
    a(4, "bet", "river", 1),
  ];
  if (heroAct) actions.push({ seatId: 5, hero: true, street: "river", ...heroAct });
  return {
    handId: 20, heroSeatId: 5, street: "river", liveSeats: [2, 3, 4, 5, 6], actions,
    stacks: new Map([[2, 58.4], [3, 183.6], [4, 221.8], [5, 89.2], [6, 29]]), committed: new Map([[4, 1]]),
    currentNode: { street: "river", toActIsHero: true, pot: 23.4, toCall: 1 }, heroFolded: false, ended: false,
  };
}

/** Hand 4920544353 facing the BTN's 21.6 jam on the turn (blinds folded on the flop). */
function kjFacingJam(o: { blindsIn?: boolean } = {}): Record<string, any> {
  const actions: any[] = [
    { seatId: 1, type: "post-sb", street: "preflop", amount: 0.4 }, { seatId: 2, type: "post-bb", street: "preflop", amount: 1 },
    { seatId: 3, type: "fold", street: "preflop" }, { seatId: 4, type: "fold", street: "preflop" },
    { seatId: 5, hero: true, type: "raise", street: "preflop", amount: 2.6 }, { seatId: 6, type: "call", street: "preflop", amount: 2.6 },
    { seatId: 2, type: "bet", street: "flop", amount: 1 }, { seatId: 5, hero: true, type: "call", street: "flop", amount: 1 },
    { seatId: 6, type: "raise", street: "flop", amount: 10 },
    ...(o.blindsIn ? [] : [{ seatId: 1, type: "fold", street: "flop" }, { seatId: 2, type: "fold", street: "flop" }]),
    { seatId: 5, hero: true, type: "call", street: "flop", amount: 9 },
    { seatId: 5, hero: true, type: "check", street: "turn" }, { seatId: 6, type: "all-in", street: "turn", amount: 21.6 },
  ];
  return {
    handId: 12, heroSeatId: 5, street: "turn", liveSeats: [1, 2, 3, 4, 5, 6], actions,
    stacks: new Map([[1, 49.8], [2, 30.4], [5, 87.4], [6, 0]]), committed: new Map([[6, 21.6]]),
    currentNode: { street: "turn", toActIsHero: true, pot: 53, toCall: 21.6 }, heroFolded: false, ended: false,
  };
}

test("a shove is pressed on the client's own controls, whatever it relabels them", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const log0 = console.log;
  console.log = () => {};
  let undo = () => {};
  const table = (spec: typeof RIVER_FACING_BET, o: ConstructorParameters<typeof FakeIgnition>[1]) => {
    undo();
    const t = new FakeIgnition(spec, o);
    undo = t.install();
    return t;
  };
  try {
    // --- the QJdd river: preset, relabel, confirm -----------------------------------------------------------
    let t = table(RIVER_FACING_BET, { stack: 89.2 });
    let r = await actuate({ kind: "action", label: "all-in" });
    check("QJdd river: the shove goes through", r.ok === true, J(r));
    check("  ... pressed on the confirm AFTER it read ALL-IN", t.pressed?.qa === "raiseButton" && t.pressed?.text === "ALL-IN 89.2 BB", J(t.pressed));
    check("  ... preset first, then the confirm — nothing else", J(t.clicks) === J(["ALL-IN", "ALL-IN 89.2 BB"]), J(t.clicks));

    t = table(RIVER_FACING_BET, { stack: 89.2, relabelAfterReads: 3 });
    r = await actuateAllIn();
    check("the client takes a few frames to relabel → waits for it", r.ok === true && t.pressed?.text === "ALL-IN 89.2 BB", J({ r, clicks: t.clicks }));
    check("  ... and never presses the min-raise in between", !t.clicks.includes("RAISE TO 2 BB"), J(t.clicks));

    t = table(RIVER_FACING_BET, { stack: 89.2, presetTakes: false });
    r = await actuateAllIn();
    check("the preset never takes → refused", r.ok === false && String(r.reason).includes("RAISE TO 2 BB"), J(r));
    check("  ... and NOTHING on the action row was pressed (a min-raise is not a shove)", t.pressed === null, J(t.clicks));

    // a retry after the preset already took: the confirm reads ALL-IN from the start — one press
    t = table(RIVER_FACING_BET, { stack: 89.2 });
    t.buttons.find((b) => b.qa === "raiseButton")!.text = "ALL-IN 89.2 BB";
    r = await actuateAllIn();
    check("confirm already reads ALL-IN → pressed directly", r.ok === true && J(t.clicks) === J(["ALL-IN 89.2 BB"]), J(t.clicks));

    // --- a bet spot: the BET control relabels the same way ------------------------------------------------------
    t = table(BET_SPOT, { stack: 50 });
    r = await actuateAllIn();
    check("CHECK / BET spot: shove confirmed on the BET control", r.ok === true && t.pressed?.qa === "betButton" && t.pressed?.text === "ALL-IN 50 BB", J({ r, pressed: t.pressed }));

    // --- FOLD / CALL only: the call is the shove, when the hand agrees ---------------------------------------------
    t = table(FACING_JAM, { stack: 87.4 });
    handSeams.override = () => kjFacingJam();
    r = await actuate({ kind: "action", label: "all-in" });
    check("facing a jam with nothing else to raise into → CALL", r.ok === true && t.pressed?.qa === "callButton", J({ r, pressed: t.pressed }));
    check("  ... and it says so", r.as === "call" && String(r.why).includes("all-in"), J(r));
    check("verification: the call confirms a shove realized as a call",
          didAsTold({ kind: "action", label: "all-in", realized: "call" }, { type: "call", amount: 21.6 }, 87.4) === true);
    check("  ... while a plain all-in plan is not confirmed by a call",
          didAsTold({ kind: "action", label: "all-in" }, { type: "call", amount: 21.6 }, 87.4) !== true);

    t = table(FACING_JAM, { stack: 87.4 });
    handSeams.override = () => kjFacingJam({ blindsIn: true });
    r = await actuateAllIn();
    check("FOLD / CALL but opponents with chips still in → refused, not called", r.ok === false && t.pressed === null, J({ r, clicks: t.clicks }));
    check("  ... naming why", String(r.reason).includes("not hero's whole stack"), String(r.reason));
    const covered = kjFacingJam({ blindsIn: true });
    covered.stacks.set(5, 20);
    check("hero covered (call ≥ stack) → the call is the shove", callIsMaxCommit(covered).yes === true, J(callIsMaxCommit(covered)));
    handSeams.override = null;

    // --- sized raises: the confirm by identity ------------------------------------------------------------------
    t = table(RIVER_FACING_BET, { stack: 89.2 });
    r = await raiseTo("2.5", true);
    check("an ordinary raise: typed, read back, confirmed", r.ok === true && t.pressed?.text === "RAISE TO 2.5 BB", J({ r, pressed: t.pressed }));

    t = table(RIVER_FACING_BET, { stack: 89.2 });
    r = await raiseTo("89.2", true);
    check("a raise TO hero's whole stack: the confirm reads ALL-IN and is still pressed", r.ok === true && t.pressed?.text === "ALL-IN 89.2 BB", J({ r, pressed: t.pressed }));

    t = table(RIVER_FACING_BET, { stack: 89.2, clampTyped: true });
    r = await raiseTo("95", true);
    check("a size above the stack, capped by the client at ALL-IN → the shove", r.ok === true && r.as === "all-in" && t.pressed?.text === "ALL-IN 89.2 BB", J({ r, pressed: t.pressed }));

    t = table(RIVER_FACING_BET, { stack: 89.2, fieldIgnoresTyping: true });
    r = await raiseTo("2.5", true);
    check("the field kept its default (hand 4920431586) → refused, nothing pressed", r.ok === false && String(r.reason).includes("client changed 2.5 to 2.0") && t.pressed === null, J({ r, clicks: t.clicks }));

    // --- a relabelled CALL is still the call ---------------------------------------------------------------------
    t = table(FACING_JAM, { stack: 10 });
    t.buttons.find((b) => b.qa === "callButton")!.text = "ALL-IN 10 BB";
    r = await actuate({ kind: "action", label: "call" });
    check("CALL on a call button the client labels ALL-IN → pressed by identity", r.ok === true && t.pressed?.qa === "callButton", J({ r, pressed: t.pressed }));
  } finally {
    undo();
    handSeams.override = null;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});

test("hand 4920545590 replayed: the shove goes, and nothing folds it with the time bank unspent", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  const log0 = console.log;
  console.log = () => {};
  const KEY = pyJsonDumps(["river", ["A♦", "K♥", "J♣", "2♠", "J♠"], ["J♦", "Q♦"], 1, 14]);
  let undo = () => {};

  /** One feed-loop pass (loops.ts order, less the top-up run) at `t` s into hero's turn; clock from the table. */
  let fake: FakeIgnition;
  let turnStart = T0;
  let prevClock: number | null = null;
  const tick = async (t: number, o: { answer?: boolean } = {}) => {
    setFakeTime(turnStart + t);
    const base = Math.max(0, 15 - Math.floor(t));
    // the client: +45s appears at 8 s, the bank starts at 0 (the button goes a frame before the clock jumps)
    if (t < 15) {
      S.heroClock = base;
      S.liveStatus.timeBank = base <= 8 ? { text: "+45s" } : null;
    } else if (t < 15.5) {
      S.heroClock = 0;
      S.liveStatus.timeBank = null;
    } else {
      S.heroClock = Math.max(0, 45 - Math.floor(t - 15.5));
      S.liveStatus.timeBank = null;
    }
    S.liveStatus.toAct = fake.pressed === null;
    S.bankSeen = bankStep(S.bankSeen, S.liveStatus.toAct, S.liveStatus.timeBank?.text ?? null, prevClock, S.heroClock, time());
    prevClock = S.heroClock;
    if (o.answer !== false) S.study.at = time();          // the poller keeps pushing the answer
    await maybeAutoAct();
    await maybeFoldNoAnswer();
    await maybeVerifyExec();
    await maybeTakeTime();
  };
  const seed = (o: { answer?: boolean; presetTakes?: boolean; hold?: number } = {}) => {
    undo();
    fake = new FakeIgnition(RIVER_FACING_BET, { stack: 89.2, presetTakes: o.presetTakes });
    undo = fake.install();
    S.bankSeen = null;
    prevClock = null;
    handSeams.override = () => qjRiver(fake.pressed ? { type: fake.pressed.qa === "foldButton" ? "fold" : "all-in", amount: fake.pressed.qa === "foldButton" ? undefined : 89.2 } : null);
    Object.assign(S.liveStatus, { toAct: true, practice: true, modal: null, buyPanel: null, timeBank: null });
    S.handNo = 20;
    Object.assign(S.study, {
      on: true, auto: true, foldNoAnswer: true, timeBank: true, autoDelay: "random",
      text: o.answer === false ? null : "≈ RIVER — ALLIN 89.2 89% · CALL 1 11% · roll 19.1 → ALLIN 89.2",
      pick: o.answer === false ? null : "ALLIN 89.2", note: null, at: time(), decisionKey: o.answer === false ? null : KEY,
      handId: o.answer === false ? null : 20, executed: null, autoTried: null, lastExec: null, autoRetry: null, autoDue: null,
      autoHeld: null, pendingExec: null, noAnswerTurn: null, lastNoAnswerFold: null, timeBankDecision: null, timeBankAt: 0,
    });
    S.feed.length = 0;
    // the pre-action top-up held the shove for 6.3 s (its run clears the flag in a finally)
    Object.assign(S.topupPrefold, { active: !!o.hold, deadline: turnStart + 2.2 + (o.hold ?? 0), kind: "shove" });
  };
  const feed = () => S.feed.map((f: any) => f.text ?? f.line ?? J(f)).join("\n");
  try {
    // --- as it happened: answer at 2.2 s, 6.3 s top-up hold, then the shove ------------------------------------
    turnStart = T0;
    setFakeTime(T0);
    seed({ hold: 6.3 });
    for (let t = 2.2; t <= 30 && !fake!.pressed; t += 0.45) {
      if (t >= 2.2 + 6.3) S.topupPrefold.active = false;
      await tick(t);
    }
    check("the shove went out", fake!.pressed?.text === "ALL-IN 89.2 BB", J({ pressed: fake!.pressed, clicks: fake!.clicks, feed: feed() }));
    check("  ... and nothing folded", !fake!.clicks.includes("FOLD"), J(fake!.clicks));
    check("  ... right after the hold — the hold counts as the randomized wait", (S.study.lastExec?.waitedS ?? 0) >= 6, J(S.study.lastExec));
    for (let t = 9; t <= 12; t += 0.45) await tick(t);
    check("verified against the table's own line", S.study.lastExec?.outcome === "confirmed", J(S.study.lastExec));
    check("the +45s was pressed at most once for the decision", fake!.clicks.filter((c) => c === "+45s").length <= 1, J(fake!.clicks));

    // --- the preset never takes: retried, and folded only at the base clock — never on the first refusal --------
    turnStart = T0 + 1000;
    setFakeTime(turnStart);
    seed({ presetTakes: false });
    const seen: string[] = [];
    for (let t = 2.2; t <= 70 && !fake!.pressed; t += 0.45) {
      await tick(t);
      seen.push(`${t.toFixed(2)}:${S.heroClock}`);
    }
    check("a shove that never confirms is not pressed as a min-raise", !fake!.clicks.includes("RAISE TO 2 BB"), J(fake!.clicks));
    check("  ... retried before anything is given up", (S.study.autoRetry?.n ?? 0) >= 2, J(S.study.autoRetry));
    check("  ... then folded, at the base clock's end — the bank is not spent on a dead answer",
          fake!.pressed?.qa === "foldButton" && String(S.study.lastNoAnswerFold?.why).includes("no retry left"), J({ pressed: fake!.pressed, why: S.study.lastNoAnswerFold }));

    // --- no answer at all: the time bank is waited out before anything folds ------------------------------------
    turnStart = T0 + 2000;
    setFakeTime(turnStart);
    seed({ answer: false });
    await tick(11.5, { answer: false });                  // clock 4, +45s on offer
    check("clock 4 with +45s on offer → hero has 49 s, not 4", heroTimeLeft()?.total === 49 && fake!.pressed === null, J({ left: heroTimeLeft(), clicks: fake!.clicks }));
    await tick(15.2, { answer: false });                  // the handover frame: clock 0, button gone
    check("the bank's handover frame (clock 0, no button) → still no fold", fake!.pressed === null && (heroTimeLeft()?.total ?? 0) >= 45, J({ left: heroTimeLeft(), clicks: fake!.clicks }));
    for (let t = 16; t <= 56; t += 0.5) await tick(t, { answer: false });   // the bank running, 45 → 5 (past the 30 s mark)
    check("the bank is running → no fold, not even past the 30 s backstop", fake!.pressed === null, J({ clicks: fake!.clicks, why: S.study.lastNoAnswerFold }));
    await tick(15.5 + 41.5, { answer: false });           // the bank's own clock at 4
    check("the bank's own clock at the mark → FOLD", fake!.pressed?.qa === "foldButton", J({ pressed: fake!.pressed, why: S.study.lastNoAnswerFold }));
  } finally {
    undo();
    handSeams.override = null;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});

test("the fake table relabels its confirm the way the client does (so rig shoves confirm)", () => {
  const { fails, check } = checker();
  const run = (qa: string, label: string, max: string) => {
    const listeners: Record<string, (() => void)[]> = {};
    const on = (k: string) => (ev: string, f: () => void) => { (listeners[`${k}:${ev}`] ??= []).push(f); };
    const bi = { value: "2", dataset: { max, min: "2" }, addEventListener: on("bi") };
    const conf = { innerText: label, getAttribute: (a: string) => (a === "data-qa" ? qa : null) };
    const allIn = { addEventListener: on("allIn") };
    const document = { querySelector: (s: string) => (s.includes("allInSelector") ? allIn : s.includes("raiseButton") ? conf : null) };
    new Function("document", "bi", FAKE.CONFIRM_RELABEL_JS)(document, bi);
    const fire = (k: string) => (listeners[k] || []).forEach((f) => f());
    return { conf, bi, click: () => fire("allIn:click"), type: (v: string) => { bi.value = v; fire("bi:input"); } };
  };
  let t = run("raiseButton", "RAISE TO 2 BB", "89.2");
  t.click();
  check("ALL-IN preset → 'ALL-IN 89.2 BB' (frames 2038 → 2039)", t.conf.innerText === "ALL-IN 89.2 BB" && t.bi.value === "89.2", t.conf.innerText);
  t.type("2.6");
  check("a size below the stack → the label it had", t.conf.innerText === "RAISE TO 2 BB", t.conf.innerText);
  t = run("betButton", "BET 1 BB", "50");
  t.type("50");
  check("a bet typed at the stack → 'ALL-IN 50 BB'", t.conf.innerText === "ALL-IN 50 BB", t.conf.innerText);
  expect(fails).toEqual([]);
});
