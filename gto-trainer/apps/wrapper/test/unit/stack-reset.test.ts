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
import {
  STACK_RESET_MAX_ABORTS, STACK_RESET_MISS_S, STACK_RESET_RETRY_HANDS, STACK_RESET_TICKS, heroStackBb, ignitionSitoutNextBb, maybeStackReset,
  peerLeaving, sitoutBbReadJs, stackResetSeams,
} from "../../src/stackReset";
import * as cdp from "../../src/cdp";
import { seams } from "../../src/state";
import { StateReply } from "../../src/contract";
import { state } from "../../src/view";
import { FakeSitoutTable, FDoc, FEl, ariaRows, labelRows, sharedRow } from "./fakeSitoutBox";
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

// ---- 2026-10-09 (session_20261009_052537): the read that never found the box, the ticks it burned, /state ----------

/** The real tick (ignitionSitoutNextBb) over a fake table frame: one table, fake time (its 0.4 s waits are instant). */
async function realTick(doc: FDoc, o: { clickedBefore?: boolean; visibility?: string } = {}) {
  delete process.env.TABLE_SLOT;
  delete process.env.TABLE_COUNT;
  reloadConfig();
  resetState();
  setFakeTime(T0);
  const t = new FakeSitoutTable(doc);
  if (o.visibility) t.visibility = o.visibility;
  const undo = t.install();
  try {
    const res = await ignitionSitoutNextBb(!!o.clickedBefore);
    return { res, t };
  } finally {
    undo();
    realTime();
    resetState();
  }
}

test("the read finds the label by its text — a <label> holding its box is not a leaf — presses the box, reads it ticked", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const L = labelRows();
  const t = new FakeSitoutTable(L.doc);
  const d = t.run(sitoutBbReadJs(null));
  eq("found, unticked, by the box inside the label, pointing at the box", [d.found, d.checked, d.via, d.shared, d.on], [true, false, "input", false, "box"]);
  eq("  ... at the box's centre in page coordinates (frame 2,70)", [d.x, d.y], [2 + 18 + 6.5, 70 + 1460 + 6.5]);
  // what the old read did with the same frame: leaves only — the label holds an <input>, so it never matched
  const old = L.doc.body.querySelectorAll("*").filter((e) => e.children.length === 0 && /^\s*sit out next big blind\s*$/i.test(e.textContent));
  eq("  (the old leaf-only read: nothing — the live defect)", old.length, 0);
  const { res, t: t2 } = await realTick(L.doc);
  eq("the tick: a pointer press on the box, ticked", [res.ok, res.pressed, res.state, res.method, L.bbBox.checked], [true, true, "ticked", "point (box)", true]);
  eq("  ... one press, on our box; the other box untouched", [t2.presses.map((p) => p.hit), L.handBox.checked], [["input"], false]);
  const again = await realTick(L.doc);
  eq("read again: already ticked, nothing pressed", [again.res.ok, again.res.state, again.t.presses.length], [true, "already ticked", 0]);
  expect(fails).toEqual([]);
});

test("an undrawn frame (every box 0 x 0): the label is still found, pressed through the DOM in our frame, ticked", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const A = ariaRows();
  A.doc.undrawn = true;
  const d = new FakeSitoutTable(A.doc).run(sitoutBbReadJs(null));
  eq("found by text, unticked (aria), nothing to point at", [d.found, d.checked, d.via, d.x, d.y, d.w, d.h], [true, false, "aria", null, null, 0, 0]);
  check("  ... the frame's draw heartbeat reported (idle 2,593 s)", d.idleMs > 2_000_000, J(d.idleMs));
  const { res, t } = await realTick(A.doc);
  eq("the tick: no pointer press, a DOM click on the box, ticked", [res.ok, res.pressed, res.state, t.presses.length, A.bb.box.attrs["aria-checked"]],
     [true, true, "ticked", 0, "true"]);
  check("  ... said so", /^dom: div \(the box\) \(nothing to point at/.test(res.method), res.method);
  eq("  ... the other row untouched", A.hand.box.attrs["aria-checked"], "false");
  // drawn, the same component shape: the span measures nothing itself (display: contents) — the box is pressed
  const B = ariaRows();
  const p = await realTick(B.doc);
  eq("drawn: a pointer press on the aria box, the row's handler ticks it", [p.res.ok, p.res.method, p.t.presses[0]?.hit, B.bb.box.attrs["aria-checked"]],
     [true, "point (box)", "div", "true"]);
  // the page not rendering (minimised): a pointer press would be parked — the DOM click goes instead
  const C = ariaRows();
  const h = await realTick(C.doc, { visibility: "hidden" });
  eq("page hidden: DOM click, ticked", [h.res.ok, h.t.presses.length, C.bb.box.attrs["aria-checked"]], [true, 0, "true"]);
  expect(fails).toEqual([]);
});

test("a pointer press that leaves the box unticked: once more through the DOM, on the box", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  // the handler sits on the box alone; the box measures nothing, so the press goes to the label text — which does nothing
  const box = new FEl("div", { attrs: { "aria-checked": "false" } });
  box.onClick = () => { box.attrs["aria-checked"] = "true"; };
  const lab = new FEl("span", { text: "Sit out next big blind", rect: { x: 36, y: 1460, width: 90, height: 13 } });
  const doc = new FDoc([new FEl("div", { attrs: { "data-qa": "myPlayerTag" } }), new FEl("div", {}, [box, lab])]);
  const { res, t } = await realTick(doc);
  eq("pointer on the label, then the DOM click on the box: ticked", [res.ok, t.presses.map((p) => p.hit), box.attrs["aria-checked"], box.clicks],
     [true, ["span:Sit out next big blind"], "true", 1]);
  check("  ... the method says both", /^point \(label\) → dom: div \(the box\)$/.test(res.method), res.method);
  expect(fails).toEqual([]);
});

test("a container holding BOTH labels is rejected: its box never answers for ours, never pressed for ours", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const Sh = sharedRow();
  const d = new FakeSitoutTable(Sh.doc).run(sitoutBbReadJs(null));
  eq("found; the shared row's (ticked) box is NOT read as ours — unknown", [d.found, d.checked, d.via, d.shared, d.on], [true, null, null, true, "label"]);
  const { res, t } = await realTick(Sh.doc);
  eq("the press goes to OUR label, the other box stays as it was", [t.presses.map((p) => p.hit), Sh.handBox.checked, Sh.handBox.clicks],
     [["span:Sit out next big blind"], true, 0]);
  eq("  ... and the result says the state is unreadable, never 'ticked'", [res.ok, res.state], [true, "clicked (tick state unreadable - check the table)"]);
  const again = await realTick(Sh.doc, { clickedBefore: true });
  eq("pressed before, state unreadable: not pressed again", [again.res.state, again.t.presses.length], ["clicked earlier (tick state unreadable)", 0]);
  expect(fails).toEqual([]);
});

test("a hidden label (display: none up its chain, [hidden], visibility: hidden, opacity 0) is not found and not clicked", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  type Rows = ReturnType<typeof labelRows>;
  const ways: [string, (L: Rows) => void][] = [
    ["display: none on the row", (L) => { L.bb.parentElement!.style.display = "none"; }],
    ["[hidden] on the label", (L) => { L.bb.hidden = true; }],
    ["visibility: hidden", (L) => { L.bb.style.visibility = "hidden"; }],
    ["opacity 0", (L) => { L.bb.style.opacity = "0"; }],
  ];
  for (const [name, hide] of ways) {
    const L = labelRows();
    hide(L);
    const { res, t } = await realTick(L.doc);
    eq(`${name}: not found, nothing pressed, a retry (no tick)`,
       [res.ok, res.retry, res.pressed ?? false, t.presses.length, t.evals.filter((e) => e === "click").length, L.bbBox.checked],
       [false, true, false, 0, 0, false]);
    check(`  ... says it is hidden`, /\(1 hidden by style\)/.test(res.why), res.why);
  }
  // a hidden stale copy beside the shown one: the shown one is the one pressed
  const L = labelRows();
  const stale = new FEl("label", { text: "Sit out next big blind", style: { display: "none" } }, [new FEl("input", { type: "checkbox" })]);
  L.doc.body.append(stale);
  stale.doc = L.doc;
  const { res } = await realTick(L.doc);
  eq("a hidden stale copy beside the shown one: the shown one ticked", [res.ok, L.bbBox.checked], [true, true]);
  expect(fails).toEqual([]);
});

test("a read that presses nothing costs no tick: tried again after STACK_RESET_MISS_S, said once; ticks count presses only", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(null);
  try {
    const nobox = { ok: false, retry: true, why: "no 'Sit out next big blind' box on the table" };
    const answers: Record<string, any>[] = [
      { ok: false, retry: true, why: "table read failed: the page's reply never came" },
      nobox, nobox, nobox, nobox,
      { ok: true, clicked: true, pressed: true, state: "ticked", method: "dom: div (the box)" },
    ];
    stackResetSeams.tick = async (cb: boolean) => { r.calls.tick.push(cb); return { ...answers.shift()! }; };
    r.stack(170);
    S.stackReset.bb = 150;
    await r.tick(0);
    eq("armed; the first read failed: no tick spent, still armed", [S.stackReset.state, S.stackReset.ticks, S.stackReset.misses, r.calls.tick.length], ["armed", 0, 1, 1]);
    await r.tick(1); await r.tick(STACK_RESET_MISS_S - 0.5);
    eq(`  ... not read again inside ${STACK_RESET_MISS_S} s`, r.calls.tick.length, 1);
    for (let k = 1; k <= 4; k++) await r.tick(k * STACK_RESET_MISS_S + 0.1);
    eq("four more reads that found nothing (more than STACK_RESET_TICKS): still armed, 0 ticks, 5 misses",
       [S.stackReset.state, S.stackReset.ticks, S.stackReset.misses, r.kinds().includes("stack-reset-aborted")], ["armed", 0, 5, false]);
    eq("  ... said once per reason (two reasons), not per read", r.kinds().filter((k) => k === "stack-reset-miss").length, 2);
    await r.tick(5 * STACK_RESET_MISS_S + 0.2);
    eq("the box found and pressed: tick 1", [S.stackReset.ticks, S.stackReset.clicked, S.stackReset.lastTick?.method], [1, true, "dom: div (the box)"]);
    eq("  ... one stack-reset-tick event, attempt 1", r.events().filter((e) => e.kind === "stack-reset-tick").map((e) => e.attempt), [1]);
    S.liveStatus.hero = "sitting-out";
    await r.tick(40);
    eq("then the client sat hero out: the reset goes on (left)", [S.stackReset.state, r.calls.leave], ["waiting", 1]);
  } finally {
    r.undo();
  }
  // nothing ever found, and hero keeps posting the big blind: THAT is the failure (the table's, not a read's)
  const r2 = rig(null);
  try {
    stackResetSeams.tick = async (cb: boolean) => { r2.calls.tick.push(cb); return { ok: false, retry: true, why: "no 'Sit out next big blind' box on the table" }; };
    r2.stack(260);
    await r2.tick(0);
    for (let k = 1; k <= STACK_RESET_TICKS; k++) {
      S.handNo += 1;
      S.ws.actions = [{ seat: 1, type: "post-bb", cents: 200 }];
      await r2.tick(100 * k);
      if (k < STACK_RESET_TICKS) eq(`posted big blind ${k}: still armed, retrying`, S.stackReset.state, "armed");
    }
    const ab = r2.events().find((e) => e.kind === "stack-reset-aborted");
    eq(`the big blind posted ${STACK_RESET_TICKS} times: aborted`, [S.stackReset.state, S.stackReset.aborts, S.stackReset.ticks], ["idle", 1, 0]);
    check("  ... saying the presses and the reads",
          ab && /posted the big blind 3 times since the arming with 0 press/.test(ab.why) && /read\(s\) pressed nothing/.test(ab.why), J(ab));
  } finally {
    r2.undo();
  }
  expect(fails).toEqual([]);
});

test(`stack-reset-off after ${STACK_RESET_MAX_ABORTS} aborts: said on the feed once, then nothing arms`, async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(null, { leaderOk: false });
  try {
    for (let k = 0; k < STACK_RESET_MAX_ABORTS; k++) {
      S.liveStatus.hero = "in-hand";
      r.stack(300);
      await r.tick(10 * k);
      eq(`round ${k + 1}: armed`, S.stackReset.state, "armed");
      S.liveStatus.hero = "sitting-out";
      await r.tick(10 * k + 1);
      eq(`round ${k + 1}: the leader silent — aborted`, [S.stackReset.state, S.stackReset.aborts], ["idle", k + 1]);
      eq(`  ... stack-reset-off ${k + 1 < STACK_RESET_MAX_ABORTS ? "not yet" : "now"}`, r.kinds().filter((x) => x === "stack-reset-off").length,
         k + 1 < STACK_RESET_MAX_ABORTS ? 0 : 1);
      S.handNo += STACK_RESET_RETRY_HANDS;
    }
    const off = r.events().find((e) => e.kind === "stack-reset-off");
    eq("the off event carries the count and the last reason", [off?.aborts, /leader did not answer/.test(off?.why ?? "")], [STACK_RESET_MAX_ABORTS, true]);
    check("the feed says it is off for the session", S.feed.some((f: any) => /Deep stack reset is OFF for the rest of this session/.test(String(f.line ?? f))),
          J(S.feed.slice(-3)));
    S.liveStatus.hero = "in-hand";
    S.handNo += 100;
    await r.tick(500);
    eq("a deep stack later: nothing arms, no second off", [S.stackReset.state, r.kinds().filter((x) => x === "stack-reset-off").length], ["idle", 1]);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("/state carries stackReset while the session has the reset on (and not otherwise); the reply schema takes it", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(null);
  const io0 = { ...cdp.io };
  const reg0 = seams.registry;
  try {
    cdp.io.available = async () => false;
    seams.registry = () => [];
    stackResetSeams.tick = async () => ({ ok: false, retry: true, why: "no 'Sit out next big blind' box on the table" });
    r.stack(255);
    await r.tick(0);
    const st = await state(true);
    const sr = st.stackReset;
    eq("state, bb, armed hand, ticks, misses, aborts, off",
       [sr?.state, sr?.bb, sr?.armedHand, sr?.ticks, sr?.maxTicks, sr?.misses, sr?.aborts, sr?.maxAborts, sr?.off],
       ["armed", 250, S.handNo, 0, STACK_RESET_TICKS, 1, 0, STACK_RESET_MAX_ABORTS, false]);
    eq("  ... since (epoch s) and for how long", [sr?.since, sr?.forS], [T0, 0]);
    eq("  ... the last tick's why, and when the next read is due", [sr?.lastTick?.ok, sr?.lastTick?.why, sr?.retryInS],
       [false, "no 'Sit out next big blind' box on the table", STACK_RESET_MISS_S]);
    const parsed = StateReply.safeParse({ ...st, connected: false, hand: null, studyAnswers: false, site: "ignition", sessionId: r.sid,
                                          practice: false, fakeTable: false, pickReady: { ok: false, reason: null } });
    check("  ... the reply schema (src/contract.ts StateReply) takes it", parsed.success, J(parsed.error?.issues?.slice(0, 3)));
    S.stackReset.bb = 0;
    eq("the reset off for the session: no stackReset key (a /state as before)", "stackReset" in (await state(true)), false);
  } finally {
    Object.assign(cdp.io, io0);
    seams.registry = reg0;
    r.undo();
  }
  expect(fails).toEqual([]);
});
