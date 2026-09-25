/**
 * Port of tests/test_hand_state_toact.py, tests/test_monitor.py and tests/test_net_guard.py.
 *
 *  - /hand: hero-to-act follows the client's buttons when the WS missed the villain action that put hero on the
 *    clock (hand 4917810973) — but not inside the deal grace, not for a folded hero, not on blinds alone.
 *  - Which screen the wrapper opens on: the external whenever one is attached, the same answer however often asked.
 *  - The connection guard: the 2026-09-22 link fails the gate, one bad probe warns, two sit out, the box is
 *    re-asserted while bad, and it never sits back in by itself.
 */
import { expect, test } from "bun:test";
import { realTime, time } from "../../src/clock";
import * as NC from "../../src/netcheck";
import { S, resetState } from "../../src/state";
import { handState } from "../../src/ignition/hand";
import { netSeams, netStep } from "../../src/netguard";
import { targetArea, winSeams, type Area } from "../../src/windows";
import { checker, J, scratchDirs } from "./helpers";

function riverState(o: { domToAct: boolean; wsActionOn: number; graceAhead?: number; heroFolded?: boolean; voluntary?: boolean }) {
  const { domToAct, wsActionOn, graceAhead = -1.0, heroFolded = false, voluntary = true } = o;
  S.handNo = 11;
  S.handIds.set(11, "4917810973");
  const acts: any[] = [{ seat: 3, type: "post-sb", cents: 100, street: "preflop" }, { seat: 1, type: "post-bb", cents: 200, street: "preflop" }];
  if (voluntary) {
    acts.push({ seat: 2, type: "raise", cents: 500, street: "preflop" }, { seat: 3, type: "fold", street: "preflop" },
              { seat: 1, type: "call", cents: 300, street: "preflop" }, { seat: 1, type: "check", street: "flop" },
              { seat: 2, type: "bet", cents: 280, street: "flop" }, { seat: 1, type: "call", cents: 280, street: "flop" },
              { seat: 1, type: "check", street: "turn" }, { seat: 2, type: "check", street: "turn" },
              { seat: 1, type: "bet", cents: 520, street: "river" });
  }
  Object.assign(S.ws, {
    dealt: [1, 2, 3], heroSeat: 2, dealer: 2, actions: acts, committed: voluntary ? new Map([[1, 520]]) : new Map(),
    bb: 200, bbSeen: true, board: ["6♣", "A♥", "J♦", "9♠", "10♠"], actionOn: wsActionOn, maxBet: voluntary ? 520 : 200,
    potCents: 2100, heroFolded, domGraceUntil: time() + graceAhead, heroCards: ["J♥", "8♦"],
  });
  S.liveStatus.board = ["6♣", "A♥", "J♦", "9♠", "10♠"];
  S.liveStatus.toAct = domToAct;
  Object.assign(S.feedPrev, { seated: true, seats: new Map([[1, { stack: "96.9 BB" }], [2, { stack: "89.6 BB" }], [3, { stack: "210.6 BB" }]]) });
}

test("/hand: hero-to-act follows the client's buttons when the WS missed the villain action", () => {
  const { fails, check } = checker();
  realTime();
  resetState();
  riverState({ domToAct: true, wsActionOn: 1 });
  let h = handState();
  check("DOM buttons override a stale WS action-on", h && h.currentNode.toActIsHero === true && h.street === "river", J(h && [h.currentNode, h.street]));
  riverState({ domToAct: false, wsActionOn: 1 });
  h = handState();
  check("no buttons -> WS action-on kept", h && h.currentNode.toActIsHero === false);
  riverState({ domToAct: true, wsActionOn: 1, graceAhead: 5.0 });
  h = handState();
  check("deal grace blocks the override", h && h.currentNode.toActIsHero === false);
  riverState({ domToAct: true, wsActionOn: 1, heroFolded: true });
  h = handState();
  check("a folded hero is never put on the clock", h && h.currentNode.toActIsHero === false);
  riverState({ domToAct: true, wsActionOn: 1, voluntary: false });
  h = handState();
  check("no voluntary action yet -> WS action-on kept", h && h.currentNode.toActIsHero === false);
  riverState({ domToAct: true, wsActionOn: 2 });
  h = handState();
  check("WS already on hero -> still hero", h && h.currentNode.toActIsHero === true);
  expect(fails).toEqual([]);
});

test("which screen the wrapper opens on", () => {
  const { fails, check } = checker();
  const LAPTOP: Area = { x: 0, y: 0, w: 2880, h: 1704, primary: true };
  const EXTERNAL: Area = { x: 2880, y: 0, w: 2560, h: 1504, primary: false };
  const mons0 = winSeams.monitors;
  const env0 = process.env.STUDY_MONITOR;
  const withMonitors = (m: Area[]) => { winSeams.monitors = () => [...m]; };
  const env = (v: string | null) => { if (v === null) delete process.env.STUDY_MONITOR; else process.env.STUDY_MONITOR = v; };
  try {
    env(null);
    withMonitors([LAPTOP, EXTERNAL]);
    check("two screens → the external", targetArea() === EXTERNAL, J(targetArea()));
    withMonitors([EXTERNAL, LAPTOP]);
    check("  ... whatever order Windows enumerates them", targetArea() === EXTERNAL);
    withMonitors([LAPTOP]);
    check("laptop alone → the laptop", targetArea() === LAPTOP);
    withMonitors([]);
    check("no monitors at all → a sane default, never a crash", targetArea().w > 0);
    withMonitors([LAPTOP, EXTERNAL]);
    check("twenty calls, one answer", new Set([...Array(20)].map(() => J(targetArea()))).size === 1);
    env("primary");
    check("STUDY_MONITOR=primary → the laptop", targetArea() === LAPTOP);
    env("external");
    check("STUDY_MONITOR=external → the external", targetArea() === EXTERNAL);
    env("secondary");
    check("  ... 'secondary' still accepted", targetArea() === EXTERNAL);
    env("EXTERNAL");
    check("  ... and case does not matter", targetArea() === EXTERNAL);
    env("primary");
    withMonitors([EXTERNAL]);
    check("primary asked for, only the external attached → the external", targetArea() === EXTERNAL);
    env("cursor");
    withMonitors([LAPTOP, EXTERNAL]);
    const a = targetArea();
    check("STUDY_MONITOR=cursor returns a real monitor", a === LAPTOP || a === EXTERNAL, J(a));
  } finally {
    winSeams.monitors = mons0;
    if (env0 === undefined) delete process.env.STUDY_MONITOR;
    else process.env.STUDY_MONITOR = env0;
  }
  expect(fails).toEqual([]);
});

test("the connection guard: a link too slow for GTO Wizard answers sits us out", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  scratchDirs();
  const deps0 = { ...NC.deps };
  const sit0 = netSeams.sitout;
  const log0 = console.log;
  console.log = () => {};
  const probeWith = (conn: number[], lost: number, warm: number[], err: string | null = null) => {
    NC.deps.connects = async () => [conn, lost];
    NC.deps.warm = async () => [warm, err];
    return NC.probe();
  };
  try {
    const bad = await probeWith([285, 290, 300, 288, 292], 5, [604, 598, 1735, 595, 644]);
    eq("2026-09-22's link fails", bad.ok, false);
    eq("  ... on round trip AND loss", bad.why.map((w: string) => w.split(" ")[0]).slice(0, 2), ["round", "5"]);
    eq("a clean Jakarta->Sydney link passes", (await probeWith([110, 120, 105, 130, 110, 120, 105, 130, 115, 118], 0, [390, 410, 420, 400, 450])).ok, true);
    eq("one lost packet of ten is tolerated", (await probeWith(Array(9).fill(120), 1, Array(5).fill(420))).ok, true);
    eq("two lost of ten is not", (await probeWith(Array(8).fill(120), 2, Array(5).fill(420))).ok, false);
    eq("a single request stalling past 2 s fails", (await probeWith(Array(10).fill(120), 0, [400, 400, 2300, 400, 400])).ok, false);
    eq("unreachable fails, never raises", (await probeWith([], 10, [], "could not open HTTPS")).ok, false);

    resetState();
    S.site.id = "ignition";
    S.session.id = null;
    const calls: any[] = [];
    netSeams.sitout = async () => { calls.push({}); return { ok: true, clicked: true, state: "ticked" }; };
    const feed = () => S.feed.map((f) => f.line as string);
    const BAD = { ok: false, why: ["round trip 290 ms (max 200)"], rttMs: 290 };
    const GOOD = { ok: true, why: [], rttMs: 120 };
    await netStep(BAD);
    eq("one bad probe does not sit out", calls.length, 0);
    eq("  ... but says so", feed().some((f) => f.includes("Connection slow")), true);
    await netStep(BAD);
    eq("two in a row sit out", calls.length, 1);
    eq("  ... and say why on the panel", feed().some((f) => f.includes("CONNECTION TOO SLOW") && f.includes("sitting out")), true);
    await netStep(BAD);
    eq("still bad: the box is re-asserted (the click itself is idempotent)", calls.length, 2);
    await netStep(GOOD);
    eq("one good probe does not clear it", S.net.sitout !== null, true);
    await netStep(GOOD);
    eq("two good probes: said once, and nothing is undone (a drop ends the session - net-drop.test.ts)",
       [S.net.sitout !== null, feed().filter((f) => f.includes("Connection is good again")).length, feed().some((f) => f.includes("I'm back"))], [true, 1, false]);
    eq("  ... never sitting back in by itself", calls.length, 2);
    Object.assign(S.net, { bad: 0, good: 0, sitout: null });
    await netStep(BAD);
    await netStep(GOOD);
    await netStep(BAD);
    eq("bad, good, bad is not two in a row", calls.length, 2);
    Object.assign(S.net, { bad: 0, good: 0, sitout: null });
    S.feed.length = 0;
    netSeams.sitout = async () => ({ ok: false, why: "no 'Sit out next hand' box on the table" });
    await netStep(BAD);
    await netStep(BAD);
    eq("a sit-out that could not be made tells you to do it yourself", feed().some((f) => f.includes("SIT OUT YOURSELF")), true);
  } finally {
    Object.assign(NC.deps, deps0);
    netSeams.sitout = sit0;
    console.log = log0;
  }
  expect(fails).toEqual([]);
});

