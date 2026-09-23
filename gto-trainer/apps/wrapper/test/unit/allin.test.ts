/**
 * Port of tests/test_allin.py and tests/test_allin_press.py.
 *
 * An all-in is its own action, and an all-in seat is finished acting (hand 4919482454): THE STACK DECIDES, AND IT
 * HAS TO HOLD — not the badge, and not one frame of it. And pressing a shove is an ordered fallback that never
 * crosses rows: the action ALL-IN if the client offers one, else size it on the sizing row and confirm on RAISE
 * (or BET) — a sized-but-unconfirmed shove refuses loudly, naming the control it already touched.
 */
import { expect, test } from "bun:test";
import { setFakeTime } from "../../src/clock";
import { HandReconciler, makeTick } from "../../src/reconcile";
import { seams } from "../../src/state";
import { actuate, actuateAllIn, pickPlan } from "../../src/relay";
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
  setFakeTime(1_790_000_000);                        // the 0.25 s settle between the two presses is instant
  const calls: [string, string][] = [];
  const act0 = seams.act;
  const fake = (offers: Record<string, any>) => async (label: string, kind = "action") => {
    calls.push([label, kind]);
    const r = offers[`${label}|${kind}`];
    return r ? { ...r } : { ok: false, reason: `no '${label}' on the ${kind} row` };
  };
  const HIT = (what: string) => ({ ok: true, clicked: what });
  try {
    calls.length = 0;
    seams.act = fake({ "all-in|action": HIT("ALL-IN") });
    let r = await actuateAllIn();
    check("pressed once, on the action row", r.ok && J(calls) === J([["all-in", "action"]]), J(calls));
    check("  ... and the sizing row was never touched", !calls.some((c) => c[1] === "preset"));

    calls.length = 0;
    seams.act = fake({ "all-in|preset": HIT("ALL-IN"), "raise|action": HIT("RAISE TO 100 BB") });
    r = await actuateAllIn();
    check("shove goes through", r.ok === true, J(r));
    check("  ... as size-then-confirm, not a single press", r.kind === "preset+confirm", J(r));
    check("  ... action row tried FIRST, then the preset, then the confirm",
          J(calls) === J([["all-in", "action"], ["all-in", "preset"], ["raise", "action"]]), J(calls));
    check("  ... and it says what it clicked", String(r.clicked).includes("ALL-IN") && String(r.clicked).includes("RAISE"), String(r.clicked));

    calls.length = 0;
    seams.act = fake({ "all-in|preset": HIT("ALL-IN"), "bet|action": HIT("BET 100 BB") });
    r = await actuateAllIn();
    check("confirms on BET instead", r.ok === true && String(r.clicked).includes("BET"), J(r));
    const iR = calls.findIndex((c) => J(c) === J(["raise", "action"])), iB = calls.findIndex((c) => J(c) === J(["bet", "action"]));
    check("  ... only after RAISE was tried", iR >= 0 && iR < iB, J(calls));

    calls.length = 0;
    seams.act = fake({ "max|preset": HIT("MAX"), "raise|action": HIT("RAISE TO 100 BB") });
    r = await actuateAllIn();
    check("falls through to MAX", r.ok === true && String(r.clicked).includes("MAX"), J(r));
    check("  ... having tried ALL-IN first", J(calls.slice(0, 2)) === J([["all-in", "action"], ["all-in", "preset"]]), J(calls));

    calls.length = 0;
    seams.act = fake({ "all-in|preset": HIT("ALL-IN") });
    r = await actuateAllIn();
    check("refuses rather than claiming success", r.ok === false, J(r));
    check("  ... and names the control it already pressed", String(r.reason).includes("ALL-IN"), String(r.reason));

    calls.length = 0;
    seams.act = fake({});
    r = await actuateAllIn();
    check("refuses", r.ok === false, J(r));
    check("  ... never presses anything else instead",
          calls.every((c) => [J(["all-in", "action"]), J(["all-in", "preset"]), J(["max", "preset"])].includes(J(c))), J(calls));

    for (const pick of ["All-in", "ALL-IN", "all in", "jam", "shove", "RAI"]) {
      const plan = pickPlan(pick);
      check(`  '${pick}' -> the all-in plan`, J(plan) === J({ kind: "action", label: "all-in" }), J(plan));
    }
    calls.length = 0;
    seams.act = fake({ "all-in|preset": HIT("ALL-IN"), "raise|action": HIT("RAISE") });
    r = await actuate({ kind: "action", label: "all-in" });
    check("_actuate sends it to _actuate_all_in, not act('all-in')", r.kind === "preset+confirm", J(r));

    calls.length = 0;
    seams.act = fake({ "call|action": HIT("CALL 69.4 BB") });
    r = await actuate(pickPlan("Call")!);
    check("one press, on the action row", r.ok && J(calls) === J([["call", "action"]]), J(calls));
  } finally {
    seams.act = act0;
  }
  expect(fails).toEqual([]);
});
