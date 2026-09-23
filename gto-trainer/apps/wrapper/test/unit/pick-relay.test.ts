/**
 * Port of tests/test_pick_relay.py — pick → relay, offline: the label mapping, every guard in pickReady, the
 * executor, auto-execute, told-vs-did (the postcondition), the shove fallback and the top-up gate.
 *
 * ONE DELIBERATE DIFFERENCE from the Python test. Python's "real-money allowance" (/study-auto allowRealMoney, a
 * bounded auto-execute on a real-money table) is NOT ported: auto-execute is practice / fake-table only. Where the
 * Python test asserted that the allowance arms, is bounded and expires, this asserts it is refused outright —
 * whether asked for live or declared at setup — and never becomes "granted".
 */
import { expect, test } from "bun:test";
import { setFakeTime, time } from "../../src/clock";
import { pyJsonDumps } from "../../src/py";
import { S, resetState, seams } from "../../src/state";
import {
  actuateAllIn, autoAllowance, didAsTold, executePick, maybeAutoAct, maybeAutoArm, maybeVerifyExec, pickPlan, pickReady, setAuto,
} from "../../src/relay";
import { topUpGate } from "../../src/topup";
import { checker, J, scratchDirs } from "./helpers";

const P = pickPlan;

test("_pick_plan: the three label dialects", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), J(got));
  eq("Fold", P("Fold"), { kind: "action", label: "fold" });
  eq("FOLD (chain)", P("FOLD"), { kind: "action", label: "fold" });
  eq("Check", P("Check"), { kind: "action", label: "check" });
  eq("Call", P("Call"), { kind: "action", label: "call" });
  eq("Limp → call", P("Limp"), { kind: "action", label: "call" });
  eq("Raise 2.5 (chart)", P("Raise 2.5"), { kind: "raise-to", amount: "2.5", verb: "raise" });
  eq("RAISE 12 (chain)", P("RAISE 12"), { kind: "raise-to", amount: "12", verb: "raise" });
  eq("BET 3.35 (chain)", P("BET 3.35"), { kind: "raise-to", amount: "3.35", verb: "bet" });
  eq("Bet 4.5bb (MES)", P("Bet 4.5bb"), { kind: "raise-to", amount: "4.5", verb: "bet" });
  eq("Bet 33% with pot 12 → 3.96", P("Bet 33%", 12), { kind: "raise-to", amount: "3.96", verb: "bet" });
  eq("Bet 33% without pot → None", P("Bet 33%"), null);
  eq("Raise (unsized) → press raise", P("Raise"), { kind: "action", label: "raise" });
  eq("Allin", P("Allin"), { kind: "action", label: "all-in" });
  eq("ALL-IN", P("ALL-IN"), { kind: "action", label: "all-in" });
  eq("Jam", P("Jam"), { kind: "action", label: "all-in" });
  eq("garbage → None", P("Sit out"), null);
  eq("None → None", P(null), null);
  expect(fails).toEqual([]);
});

const KEY = (street: string, n: number) => pyJsonDumps([street, [], ["As", "Kd"], 0, n]);

function seed(o: { toAct?: boolean; on?: boolean; fresh?: boolean; handNo?: number; keyStreet?: string; keyN?: number;
                   pick?: string; keyHand?: number; folded?: boolean; executed?: string | null } = {}) {
  const { toAct = true, on = true, fresh = true, handNo = 7, keyStreet = "preflop", keyN = 3, pick = "Raise 2.5", keyHand = 7,
          folded = false, executed = null } = o;
  S.fakeMode = false;
  S.handNo = handNo;
  S.handIds.set(handNo, "4917000001");
  S.feedPrev = { seated: true, seats: new Map([[1, { stack: "100 BB" }], [2, { stack: "100 BB" }], [3, { stack: "100 BB" }]]) };
  Object.assign(S.liveStatus, { toAct, practice: false, board: [] });
  Object.assign(S.ws, {
    bb: 200, bbSeen: true, dealt: [1, 2, 3], heroSeat: 1, dealer: 1, board: [], heroCards: ["A♠", "K♦"], potCents: 300, maxBet: 200,
    committed: new Map([[2, 100], [3, 200]]),
    actions: [{ seat: 2, type: "post-sb", cents: 100, street: "preflop" }, { seat: 3, type: "post-bb", cents: 200, street: "preflop" },
              { seat: 2, type: "call", cents: 100, street: "preflop" }],
    actionOn: 1, heroFolded: folded, foldedSeats: new Set(), domGraceUntil: 0,
  });
  Object.assign(S.study, {
    on, text: "PREFLOP — Raise 2.5 63% · Fold 37%", pick, roll: 41, at: time() - (fresh ? 0 : 10),
    decisionKey: KEY(keyStreet, keyN), handId: keyHand, executed, auto: false, autoTried: null, lastExec: null,
  });
}

test("_pick_ready: every guard", () => {
  const { fails, check } = checker();
  scratchDirs();
  setFakeTime(1_790_000_000);
  resetState();
  seed();
  let r = pickReady();
  check("all guards pass", r.ok === true, J(r));
  check("plan is raise-to 2.5", J(r.plan) === J({ kind: "raise-to", amount: "2.5", verb: "raise" }), J(r.plan));
  const reason = () => String(pickReady().reason || "");
  seed({ on: false });
  check("answers off refuses", !pickReady().ok && reason().includes("off"));
  seed({ fresh: false });
  check("stale pick refuses", reason().includes("stale"));
  seed({ toAct: false });
  check("not hero's turn refuses", reason().includes("turn"));
  seed({ folded: true });
  check("hero folded refuses", reason().includes("over"));
  seed({ keyHand: 6 });
  check("pick for another hand refuses", reason().includes("hand #6"));
  seed({ keyN: 2 });
  check("action count moved on refuses", reason().includes("after 2 actions"));
  seed({ keyStreet: "flop" });
  check("street moved on refuses", reason().includes("flop"));
  seed({ executed: "7|" + KEY("preflop", 3) });
  check("already executed refuses", reason().includes("already"));
  seed({ executed: "6|" + KEY("preflop", 3) });
  check("same spot in a NEW hand is not 'already executed'", pickReady().ok);
  seed({ pick: "Sit out" });
  check("unmappable pick refuses", reason().includes("cannot map"));
  seed();
  S.study.decisionKey = null;
  check("no decision key refuses", reason().includes("decision key"));
  expect(fails).toEqual([]);
});

test("_execute_pick, auto-execute (practice only), told vs did, the shove fallback, the top-up gate", async () => {
  const { fails, check } = checker();
  scratchDirs();
  setFakeTime(1_790_000_000);
  resetState();
  const log0 = console.log;
  console.log = () => {};
  const act0 = seams.act, raise0 = seams.raiseTo;
  const calls: any[] = [];
  try {
    seams.act = async (label, kind = "action") => { calls.push(["act", label, kind]); return { ok: true, clicked: label.toUpperCase() }; };
    seams.raiseTo = async (amount, strict = false) => { calls.push(["raise_to", amount, strict]); return { ok: true, typed: amount }; };
    seed({ pick: "Fold" });
    let res = await executePick("press");
    check("fold pressed through act()", res.ok && J(calls[calls.length - 1]) === J(["act", "fold", "action"]), J(res));
    check("executed once — second press refused", !(await executePick("press")).ok);
    check("lastExec recorded", (S.study.lastExec || {}).pick === "Fold");
    seed({ pick: "Raise 2.5" });
    res = await executePick("press");
    check("sized raise goes through raise_to(strict)", res.ok && J(calls[calls.length - 1]) === J(["raise_to", "2.5", true]), J(res));
    seed({ pick: "Raise 2.5" });
    seams.raiseTo = async () => ({ ok: false, reason: "client changed 2.5 to 3 (min/max clamp) — not pressed" });
    res = await executePick("press");
    check("clamped raise is refused and not marked executed", !res.ok && S.study.executed === null);
    check("refusal reason kept for the panel", J(S.study.lastExec).includes("clamp"));

    // auto mode: refuses to arm off a practice table, fires once on one
    seed({ pick: "Call" });
    seams.act = async (label, kind = "action") => { calls.push(["act", label, kind]); return { ok: true }; };
    check("cannot arm on a real-money table", !setAuto(true).ok && S.study.auto === false);
    S.liveStatus.practice = true;
    check("arms on a practice table", setAuto(true).ok && S.study.auto === true);
    let n = calls.length;
    await maybeAutoAct();
    check("auto fires the call", calls.length === n + 1 && calls[calls.length - 1][1] === "call");
    await maybeAutoAct();
    check("auto does not fire twice for the same decision", calls.length === n + 1);
    S.liveStatus.practice = false;
    S.study.executed = null;
    await maybeAutoAct();
    check("auto stands down when the table stops being practice", calls.length === n + 1);

    // REAL MONEY: no allowance in this build — refused live, refused when declared, never granted
    seed({ pick: "Call" });
    S.liveStatus.practice = false;
    Object.assign(S.study, { auto: false, autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null });
    let r = setAuto(true);
    check("plain arm on real money refused", !r.ok && String(r.error).includes("practice-only"), J(r));
    r = setAuto(true, { allowReal: true });
    check("allowRealMoney does NOT arm on real money", !r.ok && S.study.auto === false, J(r));
    check("  ... and no allowance is ever granted", autoAllowance().granted === false, J(autoAllowance()));
    n = calls.length;
    await maybeAutoAct();
    check("  ... so nothing fires", calls.length === n);
    S.liveStatus.practice = true;
    r = setAuto(true);
    check("practice arms with no allowance at all", r.ok && r.practice && !autoAllowance().granted);
    setAuto(false);

    // DECLARED auto-execute (setup page config.autoExecute) — intent, not bypass. (Not named `declare`: Bun 1.3.14
    // — what config/env.ps1 resolves — silently drops a statement that calls a function by that name.)
    let lastDeclare: unknown = null;   // setAuto's reply, shown when the arm check fails
    const declareAuto = (cfg: Record<string, any>) => {
      Object.assign(S.study, { auto: false, executed: null, autoTried: null, lastExec: null,
                               autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null,
                               autoDeclared: !!cfg.autoExecute, autoDeclaredReal: !!cfg.autoRealMoney,
                               autoDeclaredBudget: { ...(cfg.autoBudget || { minutes: 30, hands: 50 }) } });
      if (S.study.autoDeclared) lastDeclare = setAuto(true, { allowReal: S.study.autoDeclaredReal });
    };
    seed({ pick: "Call" });
    S.liveStatus.practice = true;
    declareAuto({ autoExecute: true });
    check("declared + practice arms at start", S.study.auto && !autoAllowance().granted, J(lastDeclare));
    seed({ pick: "Call" });
    S.liveStatus.practice = false;
    declareAuto({ autoExecute: true });
    check("declared + real money does not arm", S.study.auto === false);
    check("  ... but the declaration is still pending", S.study.autoDeclared === true);
    n = calls.length;
    await maybeAutoAct();
    check("  ... and nothing fires while pending", calls.length === n);
    S.liveStatus.practice = true;
    maybeAutoArm();
    check("pending declaration arms when a practice table appears", S.study.auto === true);
    seed({ pick: "Call" });
    S.liveStatus.practice = false;
    declareAuto({ autoExecute: true, autoRealMoney: true, autoBudget: { minutes: 10, hands: 5 } });
    check("declared WITH the real-money box still does not arm on real money", S.study.auto === false && !autoAllowance().granted);
    maybeAutoArm();
    check("  ... and the pending declaration never arms there", S.study.auto === false);
    S.liveStatus.practice = true;
    maybeAutoArm();
    check("  ... only a practice table arms it", S.study.auto === true);
    setAuto(false);
    check("live off disarms", S.study.auto === false);
    check("live off clears the declaration", S.study.autoDeclared === false);
    maybeAutoArm();
    check("live off is NOT re-armed by the declaration", S.study.auto === false);
    seed({ pick: "Call" });
    S.liveStatus.practice = true;
    declareAuto({});
    check("no declaration arms nothing", S.study.auto === false && S.study.autoDeclared === false);
    maybeAutoArm();
    check("  ... and stays off", S.study.auto === false);

    // told vs did
    const D = didAsTold;
    const R105 = { kind: "raise-to", amount: "10.5", verb: "raise" };
    check("raise-to confirmed on the level it reached", D(R105, { type: "raise", amount: 10.5 }, 100) === true);
    check("  ... tolerates the client's snapping", D(R105, { type: "raise", amount: 10.0 }, 100) === true);
    check("  ... a min-raise clamp is a DIVERGENCE", D(R105, { type: "raise", amount: 4.0 }, 100) === false);
    check("  ... so is the wrong verb", D(R105, { type: "call", amount: 10.5 }, 100) === false);
    check("  ... no amount is unknown, not wrong", D(R105, { type: "raise" }, 100) === null);
    const Fo = { kind: "action", label: "fold" };
    check("fold confirmed by a fold", D(Fo, { type: "fold" }, 100) === true);
    check("fold not confirmed by a check", D(Fo, { type: "check" }, 100) === false);
    const Ca = { kind: "action", label: "call" };
    check("call confirmed by a call", D(Ca, { type: "call", amount: 3 }, 100) === true);
    check("call confirmed by a short all-in", D(Ca, { type: "all-in", amount: 12 }, 100) === true);
    const Al = { kind: "action", label: "all-in" };
    check("all-in confirmed by an all-in", D(Al, { type: "all-in" }, 86) === true);
    check("all-in confirmed by a raise for the stack", D(Al, { type: "raise", amount: 86.0 }, 86) === true);
    check("all-in DIVERGES on a part-stack raise", D(Al, { type: "raise", amount: 10.5 }, 86) === false);

    const heroActed = (kind: string, cents: number | null = null) => {
      const a: any = { seat: 1, type: kind, street: "preflop" };
      if (cents !== null) a.cents = cents;
      S.ws.actions.push(a);
    };
    const sent = async (pick: string) => {
      seams.act = async (label, kind = "action") => { calls.push(["act", label, kind]); return { ok: true }; };
      seams.raiseTo = async (amount, strict = false) => { calls.push(["raise_to", amount, strict]); return { ok: true }; };
      seed({ pick });
      return executePick("press");
    };
    res = await sent("Fold");
    check("a sent press leaves a pending outcome", res.outcome === "pending" && S.study.pendingExec, J(res));
    check("  ... pinned to hero's action index", (S.study.pendingExec || {}).kN === 3);
    await maybeVerifyExec();
    check("  ... nothing to say while the table has not moved", S.study.pendingExec !== null);
    heroActed("fold");
    await maybeVerifyExec();
    check("fold that lands is CONFIRMED", (S.study.lastExec || {}).outcome === "confirmed" && S.study.pendingExec === null, J(S.study.lastExec));

    let nFeed = S.feed.length;
    await sent("Raise 10.5");
    heroActed("raise", 800);
    await maybeVerifyExec();
    check("a size is not judged on one sighting", (S.study.pendingExec || {}).seen !== undefined && (S.study.lastExec || {}).outcome === "pending");
    await maybeVerifyExec();
    let rec = S.study.lastExec || {};
    check("a clamped raise is DIVERGED, not success", rec.outcome === "diverged", J(rec));
    check("  ... and the feed says what the table actually took", S.feed.slice(nFeed).some((l) => String(l.line).includes("MIS-EXECUTED")));

    nFeed = S.feed.length;
    await sent("Raise 9.2");
    S.ws.actions.push({ seat: 1, type: "raise", cents: 1340, street: "preflop" });
    await maybeVerifyExec();
    check("the mid-animation increment is not a verdict", (S.study.lastExec || {}).outcome === "pending");
    S.ws.actions[S.ws.actions.length - 1].cents = 1840;
    await maybeVerifyExec();
    await maybeVerifyExec();
    rec = S.study.lastExec || {};
    check("  ... and the settled total CONFIRMS the press", rec.outcome === "confirmed", J(rec));
    check("  ... with nothing alarming in the feed", !S.feed.slice(nFeed).some((l) => String(l.line).includes("MIS-EXECUTED")));

    calls.length = 0;
    await sent("Fold");
    S.study.pendingExec.deadline = time() - 1;
    await maybeVerifyExec();
    check("a press that never registered is RETRIED", calls.length === 2 && J(calls[calls.length - 1]) === J(["act", "fold", "action"]), J(calls));
    check("  ... still pending after the retry", (S.study.pendingExec || {}).attempts === 2);
    S.study.pendingExec.deadline = time() - 1;
    await maybeVerifyExec();
    check("  ... and gives up rather than pressing a third time", calls.length === 2 && (S.study.lastExec || {}).outcome === "unknown", J({ calls, rec: S.study.lastExec }));

    calls.length = 0;
    await sent("Fold");
    S.study.pendingExec.deadline = time() - 1;
    S.liveStatus.toAct = false;
    await maybeVerifyExec();
    check("no retry once the spot is no longer hero's", calls.length === 1 && (S.study.lastExec || {}).outcome === "abandoned", J(S.study.lastExec));

    calls.length = 0;
    await sent("Fold");
    S.handNo = 8;
    await maybeVerifyExec();
    check("no retry once the hand moved on", calls.length === 1 && (S.study.lastExec || {}).outcome === "unknown", J(S.study.lastExec));

    // the shove fallback
    let offered = new Set<string>();
    seams.act = async (label, kind = "action") => {
      calls.push(["act", label, kind]);
      return offered.has(`${kind}:${label}`) ? { ok: true, clicked: label.toUpperCase() } : { ok: false, reason: `'${label}' not on offer (${kind})` };
    };
    calls.length = 0; offered = new Set(["action:all-in"]);
    check("shoves on the action button when there is one", (await actuateAllIn()).ok === true);
    calls.length = 0; offered = new Set(["preset:all-in", "action:raise"]);
    r = await actuateAllIn();
    check("falls back to the sizing row + RAISE", r.ok === true && calls.some((c) => J(c) === J(["act", "raise", "action"])), J(calls));
    calls.length = 0; offered = new Set(["preset:all-in", "action:bet"]);
    check("  ... or BET when the client offers that instead", (await actuateAllIn()).ok === true);
    calls.length = 0; offered = new Set();
    r = await actuateAllIn();
    check("refuses when neither row offers a shove", r.ok === false && String(r.reason || "").includes("not on offer"));
    calls.length = 0; offered = new Set(["preset:all-in"]);
    r = await actuateAllIn();
    check("refuses rather than leaving a size set with nothing confirming it", r.ok === false && String(r.reason || "").includes("confirm"), J(r));

    // the top-up gate
    S.feedPrev = { seated: true, waiting: false, toAct: false };
    Object.assign(S.liveStatus, { toAct: false, modal: null });
    S.ws.heroFolded = true;
    S.handNo = 8;
    check("between hands, hero folded — safe", topUpGate()[0] === true);
    S.liveStatus.toAct = true;
    check("hero on the clock — NOT safe", J(topUpGate()) === J([false, "hero is on the clock"]));
    S.liveStatus.toAct = false;
    S.ws.heroFolded = false;
    S.ws.handOver = false;
    check("a hand live for hero — NOT safe", topUpGate()[0] === false);
    S.ws.handOver = true;
    S.study.stackStable = { text: "95.0 BB", ticks: 0 };
    check("the hand over but the award still landing — NOT safe", topUpGate()[0] === false);
    S.study.stackStable = { text: "95.0 BB", ticks: 9 };
    check("the hand being over is enough, folded or not", topUpGate()[0] === true);
    S.liveStatus.modal = { harmless: true };
    check("a notice over the strip — NOT safe", topUpGate()[0] === false);
    S.liveStatus.modal = null;
    S.handNo = 99;
    check("the table moving on does NOT stop a run", topUpGate()[0] === true);
  } finally {
    seams.act = act0;
    seams.raiseTo = raise0;
    console.log = log0;
  }
  expect(fails).toEqual([]);
});
