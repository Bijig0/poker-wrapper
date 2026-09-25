/**
 * A refused auto press is retried (hand 4920431586, 2026-09-25: 99's Raise 2.5 was typed the instant the strip
 * appeared, the bet field still read its default 2.0, the press was refused and never tried again — the clock ran),
 * and the raise read-back accepts the client's one-cent rounding (NL5: a typed 2.5 reads back 2.6).
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime, time } from "../../src/clock";
import { S, resetState } from "../../src/state";
import { AUTO_RETRIES, maybeAutoAct, raiseReadBackOk, relaySeams } from "../../src/relay";
import { pyJsonDumps } from "../../src/py";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_790_000_000;
const KEY = pyJsonDumps(["preflop", [], ["9s", "9h"], 1, 2]);

function seed() {
  S.fakeMode = false;
  S.handNo = 17;
  S.handIds.set(17, "4920431586");
  S.feedPrev = { seated: true, seats: new Map([[2, { stack: "95 BB" }], [3, { stack: "87.4 BB" }], [5, { stack: "101 BB" }]]) };
  Object.assign(S.liveStatus, { toAct: true, practice: true, board: [], modal: null, buyPanel: null, timeBank: null });
  Object.assign(S.ws, {
    bb: 5, bbSeen: true, dealt: [2, 3, 5], heroSeat: 5, dealer: 1, board: [], heroCards: ["9♠", "9♥"], potCents: 7, maxBet: 5,
    committed: new Map([[2, 2], [3, 5]]),
    actions: [{ seat: 2, type: "post-sb", cents: 2, street: "preflop" }, { seat: 3, type: "post-bb", cents: 5, street: "preflop" }],
    actionOn: 5, heroFolded: false, foldedSeats: new Set(), domGraceUntil: 0,
  });
  Object.assign(S.study, {
    on: true, text: "PREFLOP — Raise 2.5 100%", pick: "Raise 2.5", roll: null, note: null, at: time(), decisionKey: KEY,
    handId: 17, executed: null, auto: true, autoDelay: "instant", autoTried: null, autoRetry: null, lastExec: null,
    autoHeld: null, uncertain: null, autoDue: null, autoNotFired: null,
  });
}

test("a refused auto press is retried, then left alone", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  const log0 = console.log;
  console.log = () => {};
  const exec0 = relaySeams.executePick;
  let refuse = true;
  let presses = 0;
  relaySeams.executePick = async (source: string) => {
    presses += 1;
    const key = `17|${KEY}`;
    const ok = !refuse;
    S.study.lastExec = { at: Math.trunc(time() * 1000), source, pick: S.study.pick, key, ok, outcome: ok ? "pending" : "refused",
                         result: ok ? { ok: true } : { ok: false, reason: "client changed 2.5 to 2.0 (min/max clamp) — not pressed" } };
    if (ok) S.study.executed = key;
    return { ok };
  };
  const tickAt = async (t: number) => { setFakeTime(T0 + t); S.study.at = time(); await maybeAutoAct(); };
  try {
    setFakeTime(T0);
    seed();
    await tickAt(0);
    check("first press", presses === 1, J(presses));
    await tickAt(0.5);
    check("not re-pressed inside the retry gap", presses === 1, J(presses));
    await tickAt(1.1);
    check("refused → pressed again after the gap", presses === 2, J(presses));
    await tickAt(2.2); await tickAt(3.3); await tickAt(4.4); await tickAt(9);
    check(`at most ${AUTO_RETRIES} retries`, presses === 1 + AUTO_RETRIES, J(presses));

    seed();
    presses = 0;
    await tickAt(20);
    refuse = false;
    await tickAt(21.1);
    check("a retry that lands ends it", presses === 2 && S.study.executed === `17|${KEY}`, J({ presses, executed: S.study.executed }));
    await tickAt(23); await tickAt(25);
    check("nothing after it landed", presses === 2, J(presses));
  } finally {
    relaySeams.executePick = exec0;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});

test("the raise read-back accepts the client's one-cent rounding, not its default", () => {
  expect(raiseReadBackOk(2.5, 2.6, 5)).toBe(true);    // NL5: $0.125 → $0.13
  expect(raiseReadBackOk(2.5, 2.4, 5)).toBe(true);
  expect(raiseReadBackOk(2.5, 2.0, 5)).toBe(false);   // hand 4920431586: the field still on its default
  expect(raiseReadBackOk(2.5, 2.5, 200)).toBe(true);
  expect(raiseReadBackOk(2.5, 2.6, 200)).toBe(false); // NL200: one cent is 0.005 bb — 2.6 is a different size
  expect(raiseReadBackOk(2.5, NaN, 5)).toBe(false);
  expect(raiseReadBackOk(2.5, 2.51, null)).toBe(true);
});
