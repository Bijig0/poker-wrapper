/**
 * THE SITE CLOSED OUR TABLE: KEEP THE SESSION, SEAT A NEW ONE (Brady, 2026-10-01, after session_20261001_021221: table
 * 2 thinned to hero alone at 04:06:44, Ignition shut it at 04:06:59 with the connection healthy, and the socket-closed
 * rule closed the one client both tables live in — table 1 mid-hand. "We keep playing until we get kicked off the
 * table, and if so, then we try join a new table at that stake.")
 *
 *  - ignition/reader.ts noteSocketClosed: our socket closing on a table that was OVER (hero the only one seated on the
 *    last full read / the felt breaking / our frame gone) with no hand on is held, not failed; another socket of the
 *    page closing around it, or the client's overlay, makes it the drop it always was; past the settle window it is the
 *    site's close — nothing pressed, nothing ended, the closed socket forgotten, our frame re-pinned when it vanishes.
 *  - session.ts maybeReseatAfterSiteClose: the record says so; the leader notes it (a follower tells the leader), and
 *    honourClosedTables counts the seat drop as a re-seat, not a close by hand — undoing a by-hand verdict it beat by
 *    seconds; a note nothing matched within its window expires.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { SessionStore } from "../../src/sessions";
import { S, pressBlocked, resetState } from "../../src/state";
import { forgetFrame, pinFrame } from "../../src/ignition/dom";
import { SITE_CLOSE_OTHERS_S, SITE_CLOSE_SETTLE_S, maybeSettleSiteClose, noteDisconnect, noteSocketClosed, siteClosedEvidence } from "../../src/ignition/reader";
import { HONOUR_UNDO_S, SITE_CLOSE_WINDOW_S, honourClosedTables, maybeReseatAfterSiteClose, noteSiteClosePending, sessionSeams, sessionTableClosed, tablesWanted } from "../../src/session";
import { checker, J, scratchDirs } from "./helpers";

const RID = "30376.1396", OTHER = "30376.1108";
const T0 = 1_790_802_419;

/** One wrapper on a live session, bound to RID, its frame's last full read showing `seats` occupied (hero's is 1). */
function rig(slot: number | null, seats: number[] = [1]) {
  const tmp = scratchDirs("site-close-");
  if (slot === null) {
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
  } else {
    process.env.TABLE_SLOT = String(slot);
    process.env.TABLE_COUNT = "2";
  }
  reloadConfig();
  resetState();
  setFakeTime(T0);
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  const sid = "session_20261001_021221_test";
  const rec = S.sessions.start(sid, "strategy:test", null, null, { tables: slot ? 2 : 1, format: "ign-ring-NL5-6" }, { ok: true }, {});
  Object.assign(S.session, { id: sid, rec, started: time() });
  S.study.auto = true;
  S.tapBound = RID;
  S.tapHist.set(RID, [{ pid: "PLAY_STAGE_INFO" }]);
  S.tapDeals.set(RID, { up: new Map([[1, ["Kd", "3d"]]]), at: time() });
  Object.assign(S.ws, { handOver: true, heroFolded: false, heroCards: [] });
  S.liveStatus.hero = "in-hand";               // what the frame says of a seated hero between hands
  S.liveStatus.heroSeatDom = 1;
  S.feedPrev = { seated: true, seats: new Map(seats.map((n) => [n, { stack: "100 BB", hero: n === 1 }])) };
  const ss0 = { ...sessionSeams };
  const told: any[] = [];
  sessionSeams.tellLeaderTableClosed = async (b: any) => { told.push(b); return { ok: true }; };
  const log0 = console.log;
  console.log = () => {};
  const events = (): string[] => (S.sessions.get(sid).events || []).map((e: any) => String(e.kind));
  const undo = () => {
    console.log = log0;
    Object.assign(sessionSeams, ss0);
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
    realTime();
    resetState();
  };
  return { sid, told, events, undo };
}

test("the socket closing on a table hero had to himself is held, then called the site's close — nothing ends", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { sid, events, undo } = rig(null);
  try {
    eq("the evidence: hero alone, no hand on", siteClosedEvidence()?.why, "hero was the only player seated");
    noteSocketClosed(RID);
    eq("no failure latched", S.disconnect, null);
    eq("the bind is released, the socket forgotten", [S.tapBound, S.tapHist.has(RID), S.tapDeals.has(RID)], [null, false, false]);
    check("a notice is held, unsettled", S.siteClosed.notice && !S.siteClosed.notice.settled, J(S.siteClosed.notice));
    eq("auto-execute stays on, presses are not blocked (there is no hand to press in)", [S.study.auto, pressBlocked()], [true, null]);
    maybeSettleSiteClose();
    eq("inside the settle window nothing is decided", S.siteClosed.notice?.settled, false);
    await maybeReseatAfterSiteClose();
    eq("  ... and the session has not acted", events().includes("table-closed-by-site"), false);
    setFakeTime(T0 + SITE_CLOSE_SETTLE_S + 0.5);
    maybeSettleSiteClose();
    eq("past it: the site's close", [S.siteClosed.notice?.settled, S.disconnect], [true, null]);
    await maybeReseatAfterSiteClose();
    eq("the record says which table the site closed", events().filter((k) => k === "table-closed-by-site").length, 1);
    const ev = (S.sessions.get(sid).events || []).find((e: any) => e.kind === "table-closed-by-site");
    eq("  ... with what the frame showed", [ev.slot, ev.seats, ev.hero, ev.rid], [null, [1], "in-hand", RID]);
    eq("the leader (the only table) has a re-seat pending for its router", S.siteClosed.pending.length, 1);
    eq("the notice is spent, the session is live", [S.siteClosed.notice, S.session.id], [null, sid]);
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("what is NOT the site's close: a hand on, other players seated, the page's other sockets going too", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  let r = rig(null, [1, 3, 6]);
  try {
    eq("three seated → no evidence", siteClosedEvidence(), null);
    noteSocketClosed(RID);
    eq("  ... the failure it always was", S.disconnect?.text, "the table's game socket closed");
  } finally {
    r.undo();
  }
  r = rig(null);
  try {
    Object.assign(S.ws, { handOver: false, heroCards: ["Kd", "3d"] });
    eq("hero holding cards → no evidence", siteClosedEvidence(), null);
    noteSocketClosed(RID);
    eq("  ... a failure", S.disconnect?.text, "the table's game socket closed");
  } finally {
    r.undo();
  }
  r = rig(null);
  try {
    noteSocketClosed(OTHER);                          // another socket of the page went first
    setFakeTime(T0 + SITE_CLOSE_OTHERS_S - 1);
    eq("another socket closed moments before → no evidence", siteClosedEvidence(), null);
    noteSocketClosed(RID);
    eq("  ... a failure", S.disconnect?.text, "the table's game socket closed");
  } finally {
    r.undo();
  }
  r = rig(null);
  try {
    noteSocketClosed(RID);
    eq("held", S.disconnect, null);
    setFakeTime(T0 + 1);
    noteSocketClosed(OTHER);                          // ... and the rest of the page follows: a drop after all
    eq("another socket closing inside the window makes it the drop", S.disconnect?.text, "the table's game socket closed");
    eq("  ... the notice withdrawn", S.siteClosed.notice, null);
  } finally {
    r.undo();
  }
  r = rig(null);
  try {
    noteSocketClosed(RID);
    noteDisconnect({ text: "You are currently disconnected from our poker server.", attempt: 0, of: 32, reconnected: false }, "our own table showed it");
    setFakeTime(T0 + SITE_CLOSE_SETTLE_S + 1);
    maybeSettleSiteClose();
    eq("the client's overlay inside the window: the failure stands, the notice is withdrawn", [S.disconnect?.attempt, S.siteClosed.notice], [0, null]);
  } finally {
    r.undo();
  }
  r = rig(null);
  try {
    S.feedPrev = {};                                  // never read in full, no table ever gone from the frame
    eq("a socket closing before the frame was ever read in full → no evidence", siteClosedEvidence(), null);
    S.tableGoneAt = time() - 10;                      // the frame had just stopped showing the table
    eq("  ... but the frame having just lost its table is one", siteClosedEvidence()?.why, "our frame had just stopped showing the table");
    S.tableGoneAt = 0;
    S.feedPrev = { seated: true, waiting: true };     // the felt: "please wait — moving you to another table"
    eq("  ... and so is the felt saying the table is breaking", siteClosedEvidence()?.why, "the felt said the table is breaking");
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("a follower tells the leader; the leader seats a new table instead of honouring the drop", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  let r = rig(2);
  try {
    noteSocketClosed(RID);
    setFakeTime(T0 + SITE_CLOSE_SETTLE_S + 1);
    maybeSettleSiteClose();
    await maybeReseatAfterSiteClose();
    eq("table 2 told the leader, with the session and what it saw", [r.told.length, r.told[0]?.sid, r.told[0]?.slot, r.told[0]?.seats], [1, r.sid, 2, [1]]);
    eq("  ... and noted nothing for itself (seating is the leader's)", S.siteClosed.pending.length, 0);
    eq("  ... the session is live, nothing pressed", [S.session.id, pressBlocked()], [r.sid, null]);
  } finally {
    r.undo();
  }
  r = rig(1);
  try {
    const CFG = { tables: 2 };
    S.seating.reached = 2;
    const [code, res] = sessionTableClosed({ sid: r.sid, slot: 2, hand: 189, seats: [1], hero: "in-hand", rid: RID });
    eq("the leader takes the note", [code, res.noted, res.pending, res.want], [200, true, 1, 2]);
    eq("  ... into the record", r.events().filter((k) => k === "table-closed-by-site").length, 1);
    eq("the seat count falling by one is then a re-seat: the session still wants 2", honourClosedTables(CFG, 1), 2);
    eq("  ... no table given up, the note spent, reached follows the count", [J([...S.closedTables]), S.siteClosed.pending.length, S.seating.reached], ["[]", 0, 1]);
    eq("  ... and the record says so", r.events().includes("table-reseat"), true);
    S.seating.reached = 2;
    eq("the next drop, with nothing pending, is a close by hand as before", honourClosedTables(CFG, 1), 1);
    eq("  ... table 2 given up", J([...S.closedTables]), "[2]");
    // a note nothing matched expires
    S.closedTables.clear();
    S.seating.reached = 2;
    noteSiteClosePending(2, "test");
    setFakeTime(time() + SITE_CLOSE_WINDOW_S + 1);
    eq("a stale note does not turn a later close by hand into a re-seat", [honourClosedTables(CFG, 1), S.siteClosed.pending.length], [1, 0]);
    // the notice for another session, or at a follower, is refused
    eq("another session's notice is ignored", sessionTableClosed({ sid: "session_other", slot: 2 })[1].noted, false);
  } finally {
    r.undo();
  }
  r = rig(2);
  try {
    eq("a follower refuses to take the note", sessionTableClosed({ sid: r.sid, slot: 1 })[0], 409);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("the router's pass beating the notice: a by-hand verdict seconds old is undone", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(1);
  try {
    const CFG = { tables: 2 };
    S.seating.reached = 2;
    eq("the count fell first: taken as closed by hand", [honourClosedTables(CFG, 1), J([...S.closedTables])], [1, "[2]"]);
    setFakeTime(time() + 3);
    noteSiteClosePending(2, "table 2 told us");
    eq("the notice 3 s later gives the table back, nothing pending", [tablesWanted(CFG), J([...S.closedTables]), S.siteClosed.pending.length], [2, "[]", 0]);
    S.seating.reached = 2;
    honourClosedTables(CFG, 1);
    setFakeTime(time() + HONOUR_UNDO_S + 1);
    noteSiteClosePending(2, "table 2 told us, late");
    eq("a verdict older than the undo window stands; the note waits for the next drop", [J([...S.closedTables]), S.siteClosed.pending.length], ["[2]", 1]);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("our frame vanishing after the site's close lets the pinned tag go — the next table the client opens is ours", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const r = rig(2);
  try {
    forgetFrame();
    eq("pinned to the client's tag 7", pinFrame("7", true), "pinned");
    noteSocketClosed(RID);
    setFakeTime(T0 + SITE_CLOSE_SETTLE_S + 1);
    maybeSettleSiteClose();
    check("the re-pin window is open", S.siteClosed.repinUntil > time(), String(S.siteClosed.repinUntil));
    eq("the frame goes: lost, as ever", pinFrame(null, false), "lost");
    // the reader's tick calls repinAfterSiteClose on "lost" while the window is open: modelled by its own call
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});
