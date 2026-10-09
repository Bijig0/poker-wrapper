/**
 * THE CLOCK ON AN UNREADABLE TICK, AND THE BANK'S MISSED START (2026-10-10, the failed-lock review): one frame whose seat
 * box did not read fired the 30 s no-answer backstop while a slow answer (a 40 s pool lock) was still coming, and a
 * bank start whose jump frame did not read counted the bank twice. relay.heroTimeLeft judges an unreadable tick from the
 * last readable clock; dom.bankStep takes a clock past the 15 s base as the bank.
 */
import { afterEach, expect, test } from "bun:test";
import { realTime, setFakeTime } from "../../src/clock";
import { bankStep } from "../../src/ignition/dom";
import { heroTimeLeft, noAnswerFoldWhy } from "../../src/relay";
import { S, resetState } from "../../src/state";

afterEach(() => { realTime(); resetState(); });

test("an unreadable tick is judged from the last readable clock (bank still to come)", () => {
  resetState();
  setFakeTime(1000);
  S.heroClock = null;
  S.heroClockGood = { clock: 9, at: 1000 };
  S.bankSeen = { secs: 45, at: 1000, started: false };
  setFakeTime(1020);                      // 20 s later, base clock ran out at 1009, the bank started itself
  const left = heroTimeLeft();
  expect(left?.estimated).toBe(true);
  expect(left?.total).toBe(34);           // 9 - 20 + 45
  expect(noAnswerFoldWhy(31)).toBeNull(); // the old backstop folded here (age >= 30, clock null)
  setFakeTime(1051);
  expect(noAnswerFoldWhy(62)).toContain("estimated from the last readable clock");
});

test("no readable clock this turn at all: the 30 s backstop as before", () => {
  resetState();
  setFakeTime(2000);
  S.heroClock = null;
  S.heroClockGood = null;
  expect(heroTimeLeft()).toBeNull();
  expect(noAnswerFoldWhy(31)).toContain("no answer after");
});

test("a bank start whose jump frame did not read is still a start", () => {
  const offer = bankStep(null, true, "+45s", 9, 8, 0)!;
  expect(offer.started).toBe(false);
  // the 0 -> 45 frame unreadable; the next readable frame shows 43 (prev readable 1)
  expect(bankStep(offer, true, null, null, 43, 3)!.started).toBe(true);
  // the base clock never reads past 15: a plain countdown is not a start
  expect(bankStep(offer, true, null, null, 7, 1)!.started).toBe(false);
});
