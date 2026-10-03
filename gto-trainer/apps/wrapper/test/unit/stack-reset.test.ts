/**
 * THE DEEP-STACK RESET (stackReset.ts, 2026-10-03, Brady): hero's stack at the session's `stackResetBb` → tick "Sit out
 * next big blind" → once sat out, the leader is told, the table is left, the wait, a fresh seat of the format in the
 * same slot. Session session_20261003_153908 ended because GTO Wizard refuses a preflop tree past 250bb effective; the
 * API caps the tree (gtowAiPreflop PREFLOP_STACK_CAP_BB) and this takes hero's own stack off the table.
 *
 * Seams: stackResetSeams (the tick, I AM BACK, the leader, the siblings, the leave, the background runner),
 * setFakeTime, a scratch SessionStore. Nothing here touches a browser or a port.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { SessionStore } from "../../src/sessions";
import { S, resetState } from "../../src/state";
import { forgetFrame, pinFrame } from "../../src/ignition/dom";
import { LEAVE_GRACE_S, SITE_CLOSE_SETTLE_S, maybeSettleSiteClose, noteSocketClosed } from "../../src/ignition/reader";
import {
  STACK_RESET_LEAVE_S, applySessionConfig, honourClosedTables, noteStackReset, stackResetDeferred, stackResetRoute, stackResetSeatWant, tablesWanted,
} from "../../src/session";
import { maybeSitBackIn, sitBackSeams } from "../../src/sitback";
import { STACK_RESET_TICKS, heroStackBb, maybeStackReset, peerLeaving, stackResetSeams } from "../../src/stackReset";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_791_032_000;
const RID = "30376.2001", OTHER = "30376.2002";

/** One wrapper on a live session with the reset on (250 bb, 60 s), bound to RID, hero seated between hands. */
function rig(slot: number | null, o: { tables?: number; leaderOk?: boolean; leaveOk?: boolean; tickOk?: boolean } = {}) {
  const tmp = scratchDirs("stack-reset-");
  if (slot === null) {
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
  } else {
    process.env.TABLE_SLOT = String(slot);
    process.env.TABLE_COUNT = String(o.tables ?? 2);
  }
  reloadConfig();
  resetState();
  setFakeTime(T0);
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  const sid = "session_20261003_deep_test";
  const cfg = { tables: slot ? o.tables ?? 2 : 1, format: "ign-ring-NL200-6", stackResetBb: 250, stackResetWaitS: 60 };
  const rec = S.sessions.start(sid, "strategy:test", null, null, cfg, { ok: true }, {});
  Object.assign(S.session, { id: sid, rec, started: time() });
  S.fakeMode = false;
  S.stackReset.bb = 250;
  S.stackReset.waitS = 60;
  S.tapBound = RID;
  Object.assign(S.ws, { handOver: true, heroFolded: false, heroCards: [], heroSeat: 1, bb: 200, actions: [], startCents: new Map() });
  Object.assign(S.liveStatus, { hero: "in-hand", heroSeatDom: 1, toAct: false, modal: null });
  S.feedPrev = { seated: true, seats: new Map([[1, { stack: "100 BB" }], [4, { stack: "80 BB" }]]) };
  const calls = { tick: [] as boolean[], sitBack: 0, leader: [] as any[], peers: [] as any[], leave: 0 };
  const pending: Promise<unknown>[] = [];
  const seams0 = { ...stackResetSeams };
  stackResetSeams.tick = async (clickedBefore: boolean) => { calls.tick.push(clickedBefore); return o.tickOk === false ? { ok: false, why: "no box" } : { ok: true, clicked: true, state: "ticked" }; };
  stackResetSeams.sitBack = async () => { calls.sitBack++; return { ok: true, clicked: true }; };
  stackResetSeams.tellLeader = async (b: any) => { calls.leader.push(b); return o.leaderOk === false ? { ok: false, error: "timed out" } : noteStackReset(b)[1]; };
  stackResetSeams.tellPeers = async (b: any) => { calls.peers.push(b); return 1; };
  stackResetSeams.leave = async () => { calls.leave++; return o.leaveOk === false ? { ok: false, error: "leave confirmation did not appear" } : { ok: true }; };
  stackResetSeams.spawn = (p: Promise<unknown>) => { pending.push(p); };
  const log0 = console.log;
  console.log = () => {};
  const events = (): any[] => S.sessions.get(sid).events || [];
  const kinds = (): string[] => events().map((e: any) => String(e.kind));
  /** one feed-loop pass of the reset, its background step run to the end */
  const tick = async (t?: number) => {
    if (t !== undefined) setFakeTime(T0 + t);
    await maybeStackReset();
    while (pending.length) await pending.shift();
  };
  const stack = (bb: number) => S.feedPrev.seats.set(1, { stack: `${bb} BB` });
  const undo = () => {
    console.log = log0;
    Object.assign(stackResetSeams, seams0);
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
    realTime();
    resetState();
  };
  return { sid, cfg, calls, events, kinds, tick, stack, undo };
}

test("arms at the threshold only; ticks once; ticks again after a posted big blind; gives up after the last tick", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(null);
  try {
    r.stack(249.9);
    await r.tick();
    eq("249.9 bb: idle, nothing pressed", [S.stackReset.state, r.calls.tick.length], ["idle", 0]);
    r.stack(250);
    await r.tick();
    eq("250 bb: armed and the box ticked once", [S.stackReset.state, r.calls.tick], ["armed", [false]]);
    eq("  ... the record says so, with the stack", r.events().filter((e) => e.kind === "stack-reset-armed").map((e) => e.stackBb), [250]);
    await r.tick(1); await r.tick(2);
    eq("  ... not again on the ticks after", r.calls.tick.length, 1);
    r.stack(180);
    await r.tick(3);
    eq("the stack falling back under the threshold: still armed", S.stackReset.state, "armed");
    // the hand's own account is the reading while a hand is on: exact, the screen ignored
    Object.assign(S.ws, { handOver: false, startCents: new Map([[1, 50_000]]) });
    eq("hero's stack as dealt (50,000 cents at a 200-cent blind) off the table's account", heroStackBb(), 250);
    // the next hands: hero still posts the big blind → the tick did not take
    for (let k = 1; k <= STACK_RESET_TICKS; k++) {
      S.handNo += 1;
      S.ws.actions = [{ seat: 1, type: "post-bb", cents: 200 }];
      S.liveStatus.toAct = true;
      await r.tick(10 * k);
      if (k < STACK_RESET_TICKS) eq(`hand ${k}: hero on the clock — the re-tick waits`, r.calls.tick.length, k);
      S.liveStatus.toAct = false;
      await r.tick(10 * k + 1);
      if (k < STACK_RESET_TICKS) eq(`hand ${k}: then ticked again (clicked over an unknown state, it did not take)`, [r.calls.tick.length, r.calls.tick[k]], [k + 1, false]);
    }
    eq(`a big blind posted after ${STACK_RESET_TICKS} ticks: given up, back to idle`, [S.stackReset.state, r.kinds().includes("stack-reset-aborted")], ["idle", true]);
    eq("  ... hero was not sitting out, so no I AM BACK", r.calls.sitBack, 0);
    S.handNo += 1;
    S.ws.actions = [];
    await r.tick(100);
    eq("  ... and it does not arm again for a while", S.stackReset.state, "idle");
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("off unless the session says so: absent keys, 0, another site, a connection drop", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(null);
  try {
    await applySessionConfig({ site: "ignition", answers: true });
    eq("no stackResetBb in the config: off", S.stackReset.bb, 0);
    r.stack(400);
    await r.tick();
    eq("  ... a 400 bb stack arms nothing", [S.stackReset.state, r.calls.tick.length], ["idle", 0]);
    await applySessionConfig({ site: "ignition", stackResetBb: 0 });
    eq("stackResetBb 0: off", S.stackReset.bb, 0);
    await applySessionConfig({ site: "ignition", stackResetBb: 250 });
    eq("stackResetBb 250, no wait given: on, the wait 60 s", [S.stackReset.bb, S.stackReset.waitS], [250, 60]);
    S.net.drop = { sid: r.sid, at: time(), why: "slow", via: "test", handled: false };
    await r.tick();
    eq("a connection drop noted: it stands aside", S.stackReset.state, "idle");
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("sat out → the leader says yes → the table is left, the wait, the new table: done", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(2);
  try {
    forgetFrame();
    pinFrame("3", true);
    r.stack(260);
    await r.tick();
    S.liveStatus.hero = "sitting-out";
    // this table is not the leader: its tellLeader seam reaches noteStackReset, which refuses at a follower (409)
    stackResetSeams.tellLeader = async (b: any) => { r.calls.leader.push(b); return { ok: true, noted: true }; };
    await r.tick(5);
    eq("sat out: the leader was told first (pending), then the siblings, then the leave", [r.calls.leader[0]?.phase, r.calls.peers[0]?.rid, r.calls.leave], ["pending", RID, 1]);
    eq("  ... waiting, the leader told when the seat is due", [S.stackReset.state, r.calls.leader[1]?.phase, r.calls.leader[1]?.notBefore], ["waiting", "left", T0 + 5 + 60]);
    eq("  ... our frame and socket let go", [S.frame.tag, S.stackReset.oldRid, S.stackReset.oldTag], [null, RID, "3"]);
    eq("  ... the record: armed, sat out, left", ["stack-reset-armed", "stack-reset-satout", "stack-reset-left"].every((k) => r.kinds().includes(k)), true);
    // the old table's socket closes 45 s after the click: ours, no failure, no kick
    setFakeTime(T0 + 5 + 45);
    S.tapBound = RID;
    noteSocketClosed(RID);
    eq(`our socket closing 45 s after the leave (past LEAVE_GRACE_S ${LEAVE_GRACE_S}): no disconnect`, [S.disconnect, S.tapBound], [null, null]);
    await r.tick(5 + 59);
    eq("inside the wait: still waiting", S.stackReset.state, "waiting");
    await r.tick(5 + 61);
    eq("past it: reseating", S.stackReset.state, "reseating");
    await r.tick(5 + 70);
    eq("  ... not done before a frame is pinned and a socket bound", S.stackReset.state, "reseating");
    pinFrame("5", true);
    S.tapBound = "30376.3001";
    Object.assign(S.liveStatus, { hero: "waiting-for-bb" });
    await r.tick(5 + 80);
    eq("pinned to the new frame, seated, bound: done", [S.stackReset.state, S.frame.tag], ["idle", "5"]);
    const done = r.events().find((e) => e.kind === "stack-reset-done");
    eq("  ... with the time since the leave", done?.waitedS, 80);
    eq("no disconnect anywhere, the session is live", [S.disconnect, S.session.id, r.kinds().includes("table-disconnected")], [null, r.sid, false]);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("the leader silent, or the leave failing: I AM BACK, aborted, play goes on", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  let r = rig(2, { leaderOk: false });
  try {
    r.stack(300);
    await r.tick();
    S.liveStatus.hero = "sitting-out";
    await r.tick(3);
    eq("the leader did not answer: no leave, I AM BACK pressed, idle", [r.calls.leave, r.calls.sitBack, S.stackReset.state], [0, 1, "idle"]);
    const ab = r.events().find((e) => e.kind === "stack-reset-aborted");
    check("  ... aborted, saying why", ab && /leader did not answer/.test(ab.why) && ab.phase === "sat-out", J(ab));
  } finally {
    r.undo();
  }
  r = rig(null, { leaveOk: false });
  try {
    r.stack(300);
    await r.tick();
    S.liveStatus.hero = "sitting-out";
    await r.tick(3);
    eq("the leave failed: I AM BACK, idle, the leader's note withdrawn", [r.calls.leave, r.calls.sitBack, S.stackReset.state, r.calls.leader.map((b) => b.phase)],
       [1, 1, "idle", ["pending", "aborted"]]);
    eq("  ... the only table's router has nothing to re-seat", [S.stackReset.notes.length, stackResetRoute()], [0, null]);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("I AM BACK is never pressed by sit-back-in while a reset is under way", async () => {
  const { fails, check } = checker();
  const r = rig(null);
  const press0 = sitBackSeams.press;
  let presses = 0;
  sitBackSeams.press = async () => { presses++; return { ok: true, clicked: true }; };
  try {
    S.study.sitBackIn = true;
    Object.assign(S.liveStatus, { hero: "sitting-out", modal: null, buyPanel: null });
    for (const st of ["armed", "sat-out", "leaving", "waiting", "reseating"] as const) {
      S.stackReset.state = st;
      setFakeTime(T0); await maybeSitBackIn();
      setFakeTime(T0 + 30); await maybeSitBackIn();
      check(`state ${st}: no press`, presses === 0, String(presses));
    }
    S.stackReset.state = "idle";
    setFakeTime(T0 + 31); await maybeSitBackIn();
    setFakeTime(T0 + 60); await maybeSitBackIn();
    check("idle again: sit-back-in presses as before", presses === 1, String(presses));
  } finally {
    sitBackSeams.press = press0;
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("a sibling's noted socket closing is not weighed; the sibling's own site close still settles as the site's", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(1);
  try {
    eq("table 2's notice is taken", peerLeaving({ sid: r.sid, slot: 2, rid: OTHER })[1].noted, true);
    noteSocketClosed(OTHER);
    eq("its socket closing: tapOtherClosedAt untouched", S.tapOtherClosedAt, 0);
    // our own table closes on the site the next second (hero alone, no hand on): still the site's close
    S.feedPrev = { seated: true, seats: new Map([[1, { stack: "100 BB" }]]) };
    setFakeTime(T0 + 1);
    noteSocketClosed(RID);
    eq("our close is held as the site's", [S.disconnect, !!S.siteClosed.notice], [null, true]);
    setFakeTime(T0 + 1 + SITE_CLOSE_SETTLE_S + 0.5);
    maybeSettleSiteClose();
    eq("  ... and settles as the site's, not as a drop", [S.siteClosed.notice?.settled, S.disconnect], [true, null]);
    // a socket nobody noted is weighed as before
    noteSocketClosed("30376.9999");
    check("an un-noted socket still counts", S.tapOtherClosedAt > 0, String(S.tapOtherClosedAt));
    eq("another session's notice is refused", peerLeaving({ sid: "session_other", slot: 2, rid: "x" })[1].noted, false);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("the leader: the seat-count drop is a reset, nothing seated before the wait, one seat after", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(1);
  try {
    const CFG = { tables: 2 };
    S.seating.reached = 2;
    eq("table 2 says it is leaving", noteStackReset({ sid: r.sid, slot: 2, phase: "pending", waitS: 60 })[1].noted, true);
    eq("the seat count falls by one: wanted unchanged", honourClosedTables(CFG, 1), 2);
    eq("  ... no table given up, the record says why", [J([...S.closedTables]), r.events().find((e) => e.kind === "table-reseat")?.byStackReset], ["[]", 1]);
    eq("  ... and nothing is seated yet (the leave is under way)", [stackResetDeferred(), stackResetSeatWant(2)], [1, 1]);
    noteStackReset({ sid: r.sid, slot: 2, phase: "left", notBefore: T0 + 60 });
    setFakeTime(T0 + 59);
    eq("left, inside the wait: still one seat short on purpose", stackResetSeatWant(2), 1);
    setFakeTime(T0 + 60);
    eq("the wait over: both seats wanted again", stackResetSeatWant(2), 2);
    eq("the next drop with no note is a close by hand, as before", (() => { S.seating.reached = 2; return honourClosedTables(CFG, 1); })(), 1);
    eq("a follower refuses the note", (() => { process.env.TABLE_SLOT = "2"; const c = noteStackReset({ sid: r.sid, slot: 1, phase: "pending" })[0]; process.env.TABLE_SLOT = "1"; return c; })(), 409);
    eq("a 'left' note that never came: the seat is due on the leader's own clock", (() => {
      S.stackReset.notes = []; S.closedTables.clear(); S.seating.reached = 2;
      noteStackReset({ sid: r.sid, slot: 2, phase: "pending", waitS: 60 });
      honourClosedTables(CFG, 1);
      setFakeTime(time() + STACK_RESET_LEAVE_S + 60 + 1);
      return stackResetSeatWant(2);
    })(), 2);
    eq("tables wanted never moved", tablesWanted(CFG), 2);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("the only table: the router goes back to the format after the wait, not before", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(null);
  try {
    eq("nothing noted: no reset route", stackResetRoute(), null);
    r.stack(255);
    await r.tick();
    S.liveStatus.hero = "sitting-out";
    await r.tick(2);
    eq("left: the router waits", [S.stackReset.state, stackResetRoute()], ["waiting", "wait"]);
    setFakeTime(T0 + 2 + 59);
    eq("  ... inside the wait still", stackResetRoute(), "wait");
    setFakeTime(T0 + 2 + 60);
    eq("the wait over: go (and the note is spent)", [stackResetRoute(), stackResetRoute()], ["go", null]);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("two tables resetting at once each end on a frame of their own (the page's registry)", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  // the page side of frame resolution (src/js/launch.FRAME_JS.js), run over a fake document: tables 2 and 3 both
  // left their tables and forgot their tags; the client then opens tags 7 and 8 while table 1 keeps reading tag 0
  const { js } = require("../../src/js");
  const src: string = js("launch.FRAME_JS");
  const frame = (tag: string) => ({ getAttribute: (k: string) => (k === "src" ? "x?playMode=1" : k === "data-multitableslot" ? tag : null),
                                    getBoundingClientRect: () => ({ width: 1, height: 1, right: 1, bottom: 1, left: 0, top: 0 }) });
  const frames = [frame("0"), frame("7"), frame("8")];
  const win: any = {};
  const resolve = new Function("document", "window", "innerWidth", "innerHeight", "Date", `${src}; return __frame;`)(
    { querySelectorAll: () => frames }, win, 2000, 2000, { now: () => 1_000_000 });
  resolve({ tag: "0", ord: 0, me: 1 });                   // table 1, pinned, reading its own table
  const t2 = resolve({ ord: 1, me: 2 });
  const t3 = resolve({ ord: 2, me: 3 });
  const tagOf = (f: any) => f?.getAttribute("data-multitableslot") ?? null;
  eq("table 2 and table 3 each take a different new frame", [tagOf(t2), tagOf(t3)], ["7", "8"]);
  eq("  ... read again, each keeps its own", [tagOf(resolve({ ord: 1, me: 2 })), tagOf(resolve({ ord: 2, me: 3 }))], ["7", "8"]);
  // with only ONE new frame open, the second unpinned table finds nothing rather than a neighbour's
  frames.splice(2, 1);
  const win2: any = {};
  const r2 = new Function("document", "window", "innerWidth", "innerHeight", "Date", `${src}; return __frame;`)(
    { querySelectorAll: () => frames }, win2, 2000, 2000, { now: () => 2_000_000 });
  r2({ tag: "0", ord: 0, me: 1 });
  const a = r2({ ord: 1, me: 2 }), b = r2({ ord: 2, me: 3 });
  eq("one new frame: the first unpinned table takes it, the other takes none", [tagOf(a), tagOf(b)], ["7", null]);
  expect(fails).toEqual([]);
});
