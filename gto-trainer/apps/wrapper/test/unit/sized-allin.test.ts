/**
 * THE SHORT ALL-IN, SIZED TO THE TREE (2026-10-07, Brady: "option 1"; the API's services/allInPress). Stress-500
 * brief_I-004 flop: 5-way on 8h9h9c, the 17.5bb SB jams 15, hero BB (Ts9s, 97.5 behind) with UTG 24.5 / CO 100 / BTN 100
 * behind him. The answer was read on three-seat trees; in ghost:CO+ghost:BTN hero's all-in is 22 (UTG's stack) and the
 * mix said CALL 15 95.56% / ALLIN 22 4.44%. An ALLIN pick was pressed as the ALL-IN preset + confirm — 97.5 into two
 * 100bb players the tree never held. Brady 2026-10-07: a short tree all-in is pressed ONLY as the raise the tree priced,
 * when the table allows that size — the answer carries `press` [{action, kind: "raise-to", amount: <the tree's own>}] and
 * the relay types it into the bet field. Under the table's minimum raise (brief_I-004's 22 < 30) the API DROPS it from the
 * mix (kind "dropped"); if such a pick ever reaches the relay it is refused, never shoved. The fixture below is the same
 * spot with the UTG at 32.5 dealt, so the tree's all-in is 30 — exactly the table's minimum raise.
 *
 * Driven against the recorded strips (fakeIgnition.ts): the relay's real reads and clicks. Without a press, an ALLIN
 * pick is pressed exactly as before.
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime, time } from "../../src/clock";
import { handSeams } from "../../src/ignition/hand";
import { pyJsonDumps } from "../../src/py";
import {
  actuate, actuateSizedAllIn, didAsTold, executePick, maybeAutoAct, maybeVerifyExec, pickPlan, pickReady, sizedAllInPlan,
} from "../../src/relay";
import { S, resetState } from "../../src/state";
import { FACING_JAM, FACING_RAISE_ONLY_ALLIN, FakeIgnition, RIVER_FACING_BET } from "./fakeIgnition";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_790_420_000;

/** the API's press entry for the brief_I-004 shape with a UTG of 32.5 (services/allInPress.shortAllInPress): a legal raise */
const PRESS = [{
  action: "ALLIN 30", kind: "raise-to", amount: 30, verb: "raise", treeAmount: 30, heroAllIn: 97.5, minRaiseTo: 30,
  plan: "ghost:CO + ghost:BTN", outside: [{ pos: "CO", chips: 97.5 }, { pos: "BTN", chips: 97.5 }],
  why: "the tree's all-in is 30 (UTG's 30, the deepest seat it holds) in ghost:CO + ghost:BTN; CO (97.5) and BTN (97.5) are outside the tree and deeper — a shove at the table would be 97.5, which the tree never priced",
}];
/** brief_I-004 decision 9 itself: the tree's 22 is under the table's minimum raise 30 — the API dropped it from the mix */
const DROPPED = [{
  action: "ALLIN 22", kind: "dropped", share: 4.44, verb: "raise", treeAmount: 22, heroAllIn: 97.5, minRaiseTo: 30,
  plan: "ghost:CO + ghost:BTN", outside: [{ pos: "CO", chips: 97.5 }, { pos: "BTN", chips: 97.5 }], why: "…so 22 cannot be played there",
}];

/** brief_I-004 at hero's flop decision (seats: 1 CO, 2 BTN, 3 SB, 4 BB = hero, 5 UTG, 6 HJ) — the wrapper's hand shape */
function briefI004(heroAct: Record<string, any> | null = null): Record<string, any> {
  const a = (seatId: number, type: string, street: string, amount?: number): Record<string, any> =>
    ({ seatId, hero: seatId === 4, type, street, ...(amount !== undefined ? { amount } : {}) });
  const actions = [
    a(3, "post-sb", "preflop", 0.5), a(4, "post-bb", "preflop", 1), a(5, "raise", "preflop", 2.5), a(6, "fold", "preflop"),
    a(1, "call", "preflop", 2.5), a(2, "call", "preflop", 2.5), a(3, "call", "preflop", 2), a(4, "call", "preflop", 1.5),
    a(3, "all-in", "flop", 15),
  ];
  if (heroAct) actions.push({ seatId: 4, hero: true, street: "flop", ...heroAct });
  return {
    handId: 31, heroSeatId: 4, street: "flop", liveSeats: [1, 2, 3, 4, 5, 6], actions,
    stacks: new Map([[1, 97.5], [2, 97.5], [3, 0], [4, 97.5], [5, 30], [6, 100]]), committed: new Map([[3, 15]]),
    currentNode: { street: "flop", toActIsHero: true, pot: 27.5, toCall: 15 }, heroFolded: false, ended: false,
  };
}

test("sizedAllInPlan: an ALLIN pick matching a press entry is a raise to its amount — nothing else changes", () => {
  const { fails, check } = checker();
  const allIn = pickPlan("ALLIN 30");
  check("the pick alone is the plain all-in", J(allIn) === J({ kind: "action", label: "all-in" }), J(allIn));
  const p = sizedAllInPlan("ALLIN 30", PRESS, allIn);
  check("with the press: raise to 30", p?.kind === "raise-to" && p?.amount === "30" && p?.verb === "raise", J(p));
  check("  ... carrying the tree's amount, hero's whole stack and why", p?.sized?.treeAmount === 30 && p?.sized?.heroAllIn === 97.5 && String(p?.sized?.why).includes("never priced"), J(p));
  check("spelling aside (case, spaces)", sizedAllInPlan("allin  30", PRESS, allIn)?.amount === "30");
  check("a bet entry is a BET", sizedAllInPlan("ALLIN 10", [{ ...PRESS[0], action: "ALLIN 10", amount: 10, verb: "bet" }], allIn)?.verb === "bet");
  check("an amount with cents is typed with them", sizedAllInPlan("ALLIN 30", [{ ...PRESS[0], amount: 30.25 }], allIn)?.amount === "30.25");
  check("no press → null (the plain all-in stays)", sizedAllInPlan("ALLIN 30", null, allIn) === null && sizedAllInPlan("ALLIN 30", [], allIn) === null);
  check("another all-in's entry → null", sizedAllInPlan("ALLIN 97.5", PRESS, pickPlan("ALLIN 97.5")) === null);
  check("not an all-in pick → null (a CALL is a call)", sizedAllInPlan("CALL 15", PRESS, pickPlan("CALL 15")) === null);
  check("a DROPPED entry is never a press", sizedAllInPlan("ALLIN 22", DROPPED, pickPlan("ALLIN 22")) === null);
  check("an entry of another kind or no amount → null", sizedAllInPlan("ALLIN 30", [{ ...PRESS[0], kind: "other" }], allIn) === null
    && sizedAllInPlan("ALLIN 30", [{ ...PRESS[0], amount: 0 }], allIn) === null);
  expect(fails).toEqual([]);
});

test("a sized ALLIN on the recorded strips: typed and confirmed at the tree's amount; no bet field → the plain all-in, said so", async () => {
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
  const plan = sizedAllInPlan("ALLIN 30", PRESS, pickPlan("ALLIN 30"))!;
  try {
    // --- FOLD / CALL / RAISE TO with the bet field: the raise to 30 -------------------------------------------------
    let t = table(RIVER_FACING_BET, { stack: 97.5 });
    let r = await actuate(plan);
    check("sized: typed 30 and the RAISE TO 30 BB control pressed", r.ok === true && t.field === "30" && t.pressed?.qa === "raiseButton" && t.pressed?.text === "RAISE TO 30 BB", J({ r, pressed: t.pressed, field: t.field }));
    check("  ... never the ALL-IN preset, one press", J(t.clicks) === J(["RAISE TO 30 BB"]), J(t.clicks));
    check("  ... recorded: kind, as, typed, why", r.kind === "sized-all-in" && r.as === "raise-to" && r.typed === "30" && String(r.why).includes("not hero's whole stack") && String(r.why).includes("never priced"), J(r));
    check("verification: hero's raise to 30 is what was told", didAsTold(plan, { type: "raise", amount: 30 }, 97.5) === true
      && didAsTold(plan, { type: "all-in", amount: 97.5 }, 97.5) === false, "");

    // --- byte-identical without the press: the plain all-in is the preset + confirm, as before ------------------------
    t = table(RIVER_FACING_BET, { stack: 97.5 });
    r = await actuate(pickPlan("ALLIN 30")!);
    check("no press: the shove as before (ALL-IN preset, confirm reads ALL-IN 97.5)", r.ok === true && J(t.clicks) === J(["ALL-IN", "ALL-IN 97.5 BB"]) && r.kind === "preset+confirm" && r.sizedPress === undefined, J({ r, clicks: t.clicks }));

    // --- the client's minimum is above the amount: refused, nothing pressed (never a size it did not price, never the shove)
    t = table(RIVER_FACING_BET, { stack: 97.5, minTyped: 37 });
    r = await actuateSizedAllIn(plan);
    check("the client lifts 30 to 37 → refused, nothing pressed", r.ok === false && t.pressed === null && !t.clicks.includes("ALL-IN"), J({ r, clicks: t.clicks }));
    check("  ... saying the sized press was refused, and why", String(r.sizedPress).includes("raise to 30 was refused") && String(r.reason).includes("client changed 30 to 37"), J(r));

    // --- no bet field: the only raise is the client's allInRaiseButton (hero's whole stack) -----------------------------
    t = table(FACING_RAISE_ONLY_ALLIN, { stack: 97.5 });
    r = await actuate(plan);
    check("no bet field, ALL-IN $ the only raise → the plain all-in press (its own fallback)", r.ok === true && t.pressed?.qa === "allInRaiseButton", J({ r, pressed: t.pressed }));
    check("  ... and the result says the sized press was not possible", r.as === "all-in" && String(r.sizedPress).includes("sized press was not possible") && String(r.sizedPress).includes("no bet input"), J(r));

    // --- FOLD / CALL only: the plain all-in's rule — the call only when it is hero's whole commitment -------------------
    t = table(FACING_JAM, { stack: 97.5 });
    handSeams.override = () => briefI004();
    r = await actuate(plan);
    check("FOLD / CALL only, deeper players still in → refused (the plain all-in's rule), nothing pressed", r.ok === false && t.pressed === null, J({ r, clicks: t.clicks }));
    check("  ... saying the sized press was not possible", String(r.reason).includes("sized press was not possible") && String(r.reason).includes("not hero's whole stack"), J(r));
  } finally {
    undo();
    handSeams.override = null;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});

test("brief_I-004 decision 9 replayed (UTG at 32.5: a legal tree all-in of 30): auto presses the ALLIN pick as a raise to 30, verified on the table's line; the real 22 (dropped) is never pressed", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const log0 = console.log;
  console.log = () => {};
  const KEY = pyJsonDumps(["flop", ["8♥", "9♥", "9♣"], ["T♠", "9♠"], 15, 9]);
  let fake!: FakeIgnition;
  let undo = () => {};
  const seed = (press: unknown[] | null) => {
    undo();
    fake = new FakeIgnition(RIVER_FACING_BET, { stack: 97.5 });
    undo = fake.install();
    handSeams.override = () => briefI004(fake.pressed ? (fake.pressed.qa === "raiseButton" && /^RAISE TO/.test(fake.pressed.text)
      ? { type: "raise", amount: Number(fake.pressed.text.match(/[\d.]+/)![0]) } : { type: "all-in", amount: 97.5 }) : null);
    Object.assign(S.liveStatus, { toAct: true, practice: true, modal: null, buyPanel: null, timeBank: null });
    S.handNo = 31;
    Object.assign(S.study, {
      on: true, auto: true, foldNoAnswer: false, timeBank: false, autoDelay: "instant",
      text: "≈ FLOP — CALL 15 96% · ALLIN 30 4% · roll 97.3 → ALLIN 30", pick: "ALLIN 30", press, note: null, at: time(),
      decisionKey: KEY, handId: 31, executed: null, autoTried: null, lastExec: null, autoRetry: null, autoDue: null,
      autoHeld: null, pendingExec: null, noAnswerTurn: null, lastNoAnswerFold: null, timeBankDecision: null, timeBankAt: 0,
    });
    S.feed.length = 0;
  };
  const feed = () => S.feed.map((f: any) => f.text ?? f.line ?? J(f)).join("\n");
  try {
    seed(PRESS);
    const ready = pickReady();
    check("pickReady: the ALLIN pick's plan is the raise to 30", ready.ok === true && ready.plan?.kind === "raise-to" && ready.plan?.amount === "30" && !!ready.plan?.sized, J(ready));
    for (let t = 0; t < 3 && !fake.pressed; t += 0.5) { setFakeTime(T0 + t); S.study.at = time(); await maybeAutoAct(); }
    check("auto pressed RAISE TO 30 BB — not the shove", fake.pressed?.text === "RAISE TO 30 BB" && !fake.clicks.includes("ALL-IN"), J({ pressed: fake.pressed, clicks: fake.clicks, feed: feed() }));
    check("the feed says it was sized to the tree", /Study pick executed — ALLIN 30 .*SIZED TO THE TREE: ALLIN sized to the tree: raise to 30/.test(feed()), feed());
    check("lastExec records what was pressed", S.study.lastExec?.result?.kind === "sized-all-in" && S.study.lastExec?.result?.typed === "30" && S.study.lastExec?.result?.as === "raise-to", J(S.study.lastExec));
    for (let t = 3; t < 6; t += 0.5) { setFakeTime(T0 + t); await maybeVerifyExec(); }
    check("verified against the table's line: hero raised to 30", S.study.lastExec?.outcome === "confirmed", J(S.study.lastExec));

    // --- the same decision without a press: the shove, exactly as before ----------------------------------------------
    seed(null);
    const plain = pickReady();
    check("no press: the plan is the plain all-in", plain.ok === true && J(plain.plan) === J({ kind: "action", label: "all-in" }), J(plain));
    const res = await executePick("press");
    check("  ... pressed as the ALL-IN preset + confirm", res.ok === true && J(fake.clicks) === J(["ALL-IN", "ALL-IN 97.5 BB"]), J({ res, clicks: fake.clicks }));
    check("  ... with no sized record", res.result?.kind === "preset+confirm" && res.result?.sizedPress === undefined && !/SIZED/.test(feed()), J(res));

    // --- a pick the API DROPPED (brief_I-004 itself: 22 under the minimum raise 30) is refused, never shoved -----------
    seed(DROPPED);
    S.study.pick = "ALLIN 22";
    const dr = pickReady();
    check("a dropped all-in as the pick → not ready, saying why", dr.ok === false && String(dr.reason).includes("dropped from the answer's mix"), J(dr));
    const dres = await executePick("press");
    check("  ... and nothing is pressed", dres.ok === false && fake.clicks.length === 0, J({ dres, clicks: fake.clicks }));
  } finally {
    undo();
    handSeams.override = null;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});
