/**
 * THE DEEP-STACK RESET'S RE-ARM (2026-10-14):
 *
 * 1. A BIG BLIND POSTED BEFORE THE PRESS IS NO MISS. session_20261013_223500 table 1: armed at 171.4 bb as hand 43
 *    ended, the first press of "Sit out next big blind" went out in hand 44 after hero's big blind was posted; the
 *    machine took that blind for "the tick did not take", pressed again 0.9 s later and — the box unreadable in its
 *    shared row — unticked it. Hero posted the blind of hand 50 too and sat out at 56, an orbit late at 170-190 bb.
 * 2. THE SHARED ROW'S READ: two boxes in one row, each paired with the label nearest it.
 *
 * Seams as test/unit/stack-reset.test.ts: stackResetSeams, setFakeTime, a scratch SessionStore; no browser, no port.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { SessionStore } from "../../src/sessions";
import { S, resetState } from "../../src/state";
import { noteStackReset } from "../../src/session";
import { maybeStackReset, sitoutBbReadJs, stackResetSeams } from "../../src/stackReset";
import { FakeSitoutTable, FDoc, FEl } from "./fakeSitoutBox";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_791_032_000;
const RID = "17284.1835";
const UNREADABLE = { ok: true, clicked: true, pressed: true, method: "point (label)", state: "clicked (tick state unreadable - check the table)", shared: true };

/** One wrapper on a live session, the reset on (`bb`, 60 s), bound to RID, hero in seat 1 between hands. */
function rig(o: { bb?: number } = {}) {
  const tmp = scratchDirs("stack-reset-rearm-");
  delete process.env.TABLE_SLOT;
  delete process.env.TABLE_COUNT;
  reloadConfig();
  resetState();
  setFakeTime(T0);
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  const sid = "session_20261014_rearm_test";
  const cfg = { tables: 1, format: "ign-ring-NL200-6", stackResetBb: o.bb ?? 150, stackResetWaitS: 60 };
  const rec = S.sessions.start(sid, "strategy:test", null, null, cfg, { ok: true }, {});
  Object.assign(S.session, { id: sid, rec, started: time() });
  S.fakeMode = false;
  S.stackReset.bb = o.bb ?? 150;
  S.stackReset.waitS = 60;
  S.tapBound = RID;
  Object.assign(S.ws, { handOver: true, heroFolded: false, heroCards: [], heroSeat: 1, bb: 200, actions: [], startCents: new Map() });
  Object.assign(S.liveStatus, { hero: "in-hand", heroSeatDom: 1, toAct: false, modal: null });
  S.feedPrev = { seated: true, seats: new Map([[1, { stack: "100 BB" }], [4, { stack: "80 BB" }]]) };
  const calls = { tick: [] as boolean[], leader: [] as any[], leave: 0 };
  const pending: Promise<unknown>[] = [];
  const seams0 = { ...stackResetSeams };
  let onTick: (() => void) | null = null;
  stackResetSeams.tick = async (clickedBefore: boolean) => {
    calls.tick.push(clickedBefore);
    const f = onTick;
    onTick = null;
    f?.();
    return { ...UNREADABLE };
  };
  stackResetSeams.sitBack = async () => ({ ok: true, clicked: true });
  stackResetSeams.tellLeader = async (b: any) => { calls.leader.push(b); return noteStackReset(b)[1]; };
  stackResetSeams.tellPeers = async () => 0;
  stackResetSeams.leave = async () => { calls.leave++; return { ok: true }; };
  stackResetSeams.spawn = (p: Promise<unknown>) => { pending.push(p); };
  const logs: string[] = [];
  const log0 = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  const events = (): any[] => S.sessions.get(sid).events || [];
  const tick = async (t?: number) => {
    if (t !== undefined) setFakeTime(T0 + t);
    await maybeStackReset();
    while (pending.length) await pending.shift();
  };
  const stack = (bb: number) => S.feedPrev.seats.set(1, { stack: `${bb} BB` });
  /** a new hand on: hero posting the big blind in it or not */
  const hand = (n: number, bb: boolean) => {
    S.handNo = n;
    S.ws.handOver = false;
    S.ws.actions = bb ? [{ seat: 1, type: "post-bb", cents: 200 }] : [];
  };
  const undo = () => {
    console.log = log0;
    Object.assign(stackResetSeams, seams0);
    realTime();
    resetState();
  };
  return { sid, calls, events, logs, tick, stack, hand, undo, duringPress: (f: () => void) => { onTick = f; } };
}

test("table 1, 2026-10-13: the big blind posted while the first press went out is no miss — no second press, sat out at the next blind", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig();
  try {
    S.handNo = 43;
    r.stack(171.4);
    // the press is slow: by the time it is out, hand 44 is dealt and hero's big blind posted
    r.duringPress(() => r.hand(44, true));
    await r.tick();
    eq("armed at hand 43's end; one press, which went out in hand 44", [S.stackReset.state, r.calls.tick, S.stackReset.pressHand], ["armed", [false], 44]);
    await r.tick(1);
    await r.tick(2);
    eq("hand 44's big blind (posted before the press took): no second press, no miss counted",
       [r.calls.tick.length, S.stackReset.bbHands, S.stackReset.clicked], [1, [], true]);
    check("  ... said once in the log", r.logs.filter((l) => /hand 44 was posted before the press took/.test(l)).length === 1, J(r.logs));
    for (let n = 45; n <= 49; n++) {
      r.hand(n, false);
      await r.tick(n);
    }
    eq("hands 45-49: nothing pressed", r.calls.tick.length, 1);
    // had the press not taken, hand 50's blind is posted after it: THAT is a miss, and the box is pressed again
    r.hand(50, true);
    await r.tick(50);
    eq("a big blind in a hand after the press: a miss, pressed again (clicked forgotten)", [S.stackReset.bbHands, r.calls.tick], [[50], [false, false]]);
    // it took: hero sat out at the next big blind, between hands
    S.ws.handOver = true;
    S.liveStatus.hero = "sitting-out";
    await r.tick(60);
    eq("sat out → left the table (the reset goes on as before)", [S.stackReset.state, r.calls.leave], ["waiting", 1]);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("a press that went out wholly before the next hand: that hand's big blind is a miss, as before", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig();
  try {
    S.handNo = 43;
    r.stack(160);
    await r.tick();
    eq("pressed in hand 43", [r.calls.tick.length, S.stackReset.pressHand], [1, 43]);
    r.hand(44, true);
    await r.tick(5);
    eq("hand 44's blind posted after the press: a miss, pressed again", [S.stackReset.bbHands, r.calls.tick.length, S.stackReset.pressHand], [[44], 2, 44]);
    await r.tick(6);
    eq("  ... and not a third time in the same hand", r.calls.tick.length, 2);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

/** ONE row holding both labels and BOTH boxes, each box beside its own label (20 px apart, as on the live client). */
function sharedRowTwo(o: { bbTicked?: boolean; handTicked?: boolean; measured?: boolean } = {}) {
  const rr = (x: number, y: number, w: number, h: number) => (o.measured === false ? { x: 0, y: 0, width: 0, height: 0 } : { x, y, width: w, height: h });
  const handBox = new FEl("input", { type: "checkbox", checked: !!o.handTicked, rect: rr(18, 1440, 13, 13) });
  const bbBox = new FEl("input", { type: "checkbox", checked: !!o.bbTicked, rect: rr(18, 1460, 13, 13) });
  const handLab = new FEl("span", { text: "Sit out next hand", rect: { x: 36, y: 1440, width: 75, height: 13 } });
  const bbLab = new FEl("span", { text: "Sit out next big blind", rect: { x: 36, y: 1460, width: 90, height: 13 } });
  const row = new FEl("div", { rect: { x: 0, y: 1430, width: 300, height: 60 } }, [handBox, handLab, bbBox, bbLab]);
  const me = new FEl("div", { attrs: { "data-qa": "myPlayerTag" }, text: "Hero", rect: { x: 500, y: 600, width: 60, height: 20 } });
  return { doc: new FDoc([me, row]), handBox, bbBox };
}

test("a shared row with both boxes: each box answers for the label beside it; boxes that do not measure stay unknown", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const read = (doc: FDoc) => new FakeSitoutTable(doc).run(sitoutBbReadJs(null));
  let d = read(sharedRowTwo({ handTicked: true }).doc);
  eq("ours unticked, the hand's ticked: ours reads unticked", [d.found, d.shared, d.checked, d.via, d.on], [true, true, false, "shared-nearest input", "box"]);
  d = read(sharedRowTwo({ bbTicked: true }).doc);
  eq("ours ticked: reads ticked", [d.checked, d.via], [true, "shared-nearest input"]);
  d = read(sharedRowTwo({ bbTicked: true, measured: false }).doc);
  eq("boxes with no size: unknown, as before (never 'unticked')", [d.shared, d.checked, d.via], [true, null, null]);
  check("  ... the row's markup comes back for the log", /sit out next hand/i.test(String(d.html)) && /sit out next big blind/i.test(String(d.html)), String(d.html));
  expect(fails).toEqual([]);
});
