/**
 * THE UNSAFE-ANSWER HOLD (2026-10-13, relay.unsafeHoldWhy): an answer the API marks unsafe is held for the player and the
 * SOLVED pick pressed when hero's base clock is down to UNSAFE_RELEASE_CLOCK_S — above fold-on-no-answer's 4 s, so the
 * press comes first — never waiting into the time bank (a running bank gets a short grace; no readable clock, a cap).
 */
import { afterEach, expect, test } from "bun:test";
import { realTime, setFakeTime } from "../../src/clock";
import { NO_ANSWER_CLOCK_S, UNSAFE_RELEASE_CLOCK_S, unsafeHoldWhy } from "../../src/relay";
import { S, resetState } from "../../src/state";

afterEach(() => { realTime(); resetState(); });

const arm = (hold = true) => { S.study.unsafe = { reasons: ["the pool cold-call lock failed — answered against the solver's residue cold-call range"], hold }; };

test("held while the base clock runs; released (pressed as solved) at UNSAFE_RELEASE_CLOCK_S, before fold-on-no-answer's 4 s", () => {
  expect(UNSAFE_RELEASE_CLOCK_S).toBeGreaterThan(NO_ANSWER_CLOCK_S);
  resetState(); setFakeTime(1000); arm();
  S.heroClock = 12;
  expect(unsafeHoldWhy("k1")).toContain("UNSAFE answer — the pool cold-call lock failed");
  S.heroClock = 7;
  expect(unsafeHoldWhy("k1")).not.toBeNull();
  S.heroClock = 6;
  expect(unsafeHoldWhy("k1")).toBeNull();          // released …
  expect(S.study.unsafeReleased).toBe("k1");
  S.heroClock = 12;
  expect(unsafeHoldWhy("k1")).toBeNull();          // … once, for that decision
  expect(unsafeHoldWhy("k2")).not.toBeNull();      // the next decision is held again
});

test("the time bank already running: a short grace, never a wait into the bank", () => {
  resetState(); setFakeTime(2000); arm();
  S.heroClock = 30;
  S.bankSeen = { secs: 45, at: 1990, started: true };
  expect(unsafeHoldWhy("k")).not.toBeNull();
  setFakeTime(2002);
  expect(unsafeHoldWhy("k")).not.toBeNull();
  setFakeTime(2003.1);
  expect(unsafeHoldWhy("k")).toBeNull();
});

test("no readable clock: released after the cap", () => {
  resetState(); setFakeTime(3000); arm();
  S.heroClock = null; S.heroClockGood = null;
  expect(unsafeHoldWhy("k")).not.toBeNull();
  setFakeTime(3008.1);
  expect(unsafeHoldWhy("k")).toBeNull();
});

test("UNSAFE_HOLD off on the API side (hold false), or no unsafe answer: never held", () => {
  resetState(); setFakeTime(4000);
  S.heroClock = 12;
  expect(unsafeHoldWhy("k")).toBeNull();
  arm(false);
  expect(unsafeHoldWhy("k")).toBeNull();
});
