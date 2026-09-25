/**
 * Port of tests/test_allin.py and tests/test_allin_press.py.
 *
 * An all-in is its own action, and an all-in seat is finished acting (hand 4919482454): THE STACK DECIDES, AND IT
 * HAS TO HOLD — not the badge, and not one frame of it. And pressing a shove is an ordered fallback that never
 * crosses rows: the action ALL-IN if the client offers one, else size it on the sizing row and confirm on the RAISE/BET
 * control once the client has relabelled it ALL-IN — a sized-but-unconfirmed shove refuses loudly, naming the control
 * it already touched (the strips as recorded: allin-strip.test.ts).
 */
import { expect, test } from "bun:test";
import { setFakeTime } from "../../src/clock";
import { HandReconciler, makeTick } from "../../src/reconcile";
import { seams } from "../../src/state";
import { actuate, actuateAllIn, pickPlan } from "../../src/relay";
import { scriptedStrip } from "./fakeIgnition";
import { checker, J } from "./helpers";

type Spec = Record<number, [number | null, string | number | null, number, string | null]>;

function seats(spec: Spec) {
  return new Map(Object.entries(spec).map(([n, [s, b, c, g]]) => [Number(n), {
    stack: s === null ? null : `${s} BB`, bet: b === null ? null : `${b} BB`, cards: c, hero: Number(n) === 6, badge: g,
  }]));
}

function run(frames: [number, number, Spec][], hero = 6) {
  const rc = new HandReconciler(1);
  let seq = 0;
  for (const [board, pot, spec] of frames) {
    seq++;
    rc.observe(makeTick({ seq, t: "", seats: seats(spec), pot, board, buttons: [], hero }));
  }
  rc.finish(seq);
  return rc;
}

const PRE: [number, number, Spec][] = [[0, 1.5, { 5: [100, "0.5", 2, null], 6: [100, "1", 2, null] }]];
const POT_JAM = 70.9;
const POT_CALLED = 140.3;

function turnFrames(nZero: number) {
  const f = [...PRE];
  f.push([4, 1.5, { 5: [69.4, null, 2, null], 6: [76.6, null, 2, null] }]);
  for (let i = 0; i < nZero; i++) f.push([4, POT_JAM, { 5: [0, "69.4", 2, i ? "ALL-IN" : null], 6: [76.6, null, 2, null] }]);
  return f;
}

test("an all-in is its own action, and an all-in seat is finished acting", () => {
  const { fails, check } = checker();
  let rc = run(turnFrames(3));
  const jam = rc.line().filter((a) => a.seat === 5 && a.type === "all-in");
  check("seat 5's 69.4 of 69.4 is an all-in, not a bet", jam.length === 1, J(rc.line().filter((a) => a.seat === 5).map((a) => [a.type, a.amount])));
  check("  ... at the amount played", jam.length && Math.abs((jam[0]!.amount || 0) - 69.4) < 0.01);
  check("  ... and the seat is recorded as all-in", rc.allin.has(5), J([...rc.allin]));
  check("  ... with no invariant violated", !rc.violations.length, J(rc.violations));

  rc = run(turnFrames(1));
  check("a single tick of zero does not type an all-in", !rc.line().some((a) => a.type === "all-in"), J(rc.line().map((a) => [a.seat, a.type])));

  let f: [number, number, Spec][] = [...PRE, [4, 1.5, { 5: [69.4, null, 2, null], 6: [76.6, null, 2, null] }]];
  for (let i = 0; i < 4; i++) f.push([4, POT_JAM, { 5: [null, "69.4", 2, null], 6: [76.6, null, 2, null] }]);
  rc = run(f);
  check("a dropped stack read never invents an all-in", !rc.line().some((a) => a.type === "all-in"));

  f = [...PRE, [4, 1.5, { 5: [69.4, null, 2, null], 6: [76.6, null, 2, null] }]];
  for (let i = 0; i < 4; i++) f.push([4, POT_JAM, { 5: [30.0, "69.4", 2, "ALL-IN"], 6: [76.6, null, 2, null] }]);
  rc = run(f);
  check("an ALL-IN badge over a live stack is not believed", !rc.line().some((a) => a.type === "all-in"));

  f = turnFrames(3);
  for (let i = 0; i < 2; i++) f.push([4, POT_CALLED, { 5: [0, "69.4", 2, null], 6: [7.3, "69.4", 2, null] }]);
  for (let i = 0; i < 3; i++) f.push([5, POT_CALLED, { 5: [0, null, 2, null], 6: [7.3, null, 2, null] }]);
  for (let i = 0; i < 3; i++) f.push([5, POT_CALLED, { 5: [0, null, 0, null], 6: [7.3, null, 2, null] }]);
  rc = run(f);
  const after = rc.line().filter((a) => a.seat === 5 && a.street === "river");
  check("no river action for a seat with nothing behind", !after.length, J(after));
  check("  ... and its cards clearing is not read as a fold", !rc.line().some((a) => a.seat === 5 && a.type === "fold"));
  expect(fails).toEqual([]);
});

test("pressing a shove: the ordered fallback, and the rows it must not cross", async () => {
  const { fails, check } = checker();
  setFakeTime(1_790_000_000);                        // the settle between the two presses is instant
  const act0 = seams.act;
  // the strip as the client shows it; the ALL-IN / MAX preset relabels the confirm "ALL-IN <stack> BB" (hand 4920545590)
  const FACING = (): [string, string][] => [["foldButton", "FOLD"], ["callButton", "CALL 10 BB"], ["raiseButton", "RAISE TO 20 BB"]];
  const BETTING = (): [string, string][] => [["checkButton", "CHECK"], ["betButton", "BET 1 BB"]];
  try {
    let s = scriptedStrip([["foldButton", "FOLD"], ["raiseButton", "ALL-IN 100 BB"]], ["ALL-IN"]);
    seams.act = s.act;
    let r = await actuateAllIn();
    check("pressed once, on the action row, when a control already reads ALL-IN", r.ok && J(s.calls) === J([["all-in", "action"]]), J(s.calls));
    check("  ... and the sizing row was never touched", !s.calls.some((c) => c[1] === "preset"));

    s = scriptedStrip(FACING(), ["Pot", "ALL-IN"], { stack: 100 });
    seams.act = s.act;
    r = await actuateAllIn();
    check("shove goes through", r.ok === true, J(r));
    check("  ... as size-then-confirm, not a single press", r.kind === "preset+confirm", J(r));
    check("  ... action row tried FIRST, then the preset, then the confirm",
          J(s.calls) === J([["all-in", "action"], ["all-in", "preset"], ["confirm", "action"]]), J(s.calls));
    check("  ... confirmed on the control the client relabelled ALL-IN", J(s.pressed) === J(["ALL-IN 100 BB"]), J(s.pressed));

    s = scriptedStrip(BETTING(), ["ALL-IN"], { stack: 100 });
    seams.act = s.act;
    r = await actuateAllIn();
    check("confirms on BET too (it relabels the same way)", r.ok === true && J(s.pressed) === J(["ALL-IN 100 BB"]), J(r));

    s = scriptedStrip(FACING(), ["MAX"], { stack: 100 });
    seams.act = s.act;
    r = await actuateAllIn();
    check("falls through to MAX", r.ok === true && String(r.clicked).includes("MAX"), J(r));
    check("  ... having tried ALL-IN first", J(s.calls.slice(0, 2)) === J([["all-in", "action"], ["all-in", "preset"]]), J(s.calls));

    s = scriptedStrip(FACING(), ["ALL-IN"], { presetTakes: false });
    seams.act = s.act;
    r = await actuateAllIn();
    check("refuses rather than claiming success when the confirm never reads ALL-IN", r.ok === false, J(r));
    check("  ... and names the control it already pressed", String(r.reason).includes("ALL-IN"), String(r.reason));
    check("  ... never pressing the min-raise instead", !s.pressed.length, J(s.pressed));

    s = scriptedStrip(FACING(), []);
    seams.act = s.act;
    r = await actuateAllIn();
    check("refuses with no preset to size it on", r.ok === false && String(r.reason).includes("preset"), J(r));
    check("  ... never presses anything else instead", !s.pressed.length, J(s.calls));

    for (const pick of ["All-in", "ALL-IN", "all in", "jam", "shove", "RAI"]) {
      const plan = pickPlan(pick);
      check(`  '${pick}' -> the all-in plan`, J(plan) === J({ kind: "action", label: "all-in" }), J(plan));
    }
    s = scriptedStrip(FACING(), ["ALL-IN"], { stack: 100 });
    seams.act = s.act;
    r = await actuate({ kind: "action", label: "all-in" });
    check("_actuate sends it to _actuate_all_in, not act('all-in')", r.kind === "preset+confirm", J(r));

    s = scriptedStrip(FACING(), ["ALL-IN"]);
    seams.act = s.act;
    r = await actuate(pickPlan("Call")!);
    check("one press, on the action row", r.ok && J(s.calls) === J([["call", "action"]]), J(s.calls));
  } finally {
    seams.act = act0;
  }
  expect(fails).toEqual([]);
});
