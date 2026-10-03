/**
 * OUR TABLE'S SOCKET WENT SILENT MID-HAND (session_20261003_111447 table 2, hand 4922280690): the river at 14:12:03.3,
 * then nothing on that socket — not the 14:12:20 PONG — until 14:12:44.4, when seat 2's bet, hero's turn and hero's
 * clock at 0 came together; hero was folded and sat out, removed at 14:17:21, and the socket closed at 14:27:20 on a
 * table that read "no seat was occupied". Table 1's PONG came on time at 14:12:22.
 *
 *  - ignition/stall.ts checkSocketStall: STALL_SILENT_S of silence on the bound socket with hero in a hand AND the
 *    keep-alive overdue opens a stall (session event, feed, ws dump), saying whether the page's other sockets talked
 *    meanwhile; the socket's next frame closes it with how long it was silent.
 *  - the hand carries it (stallsFor → archive.ts connStalls), so the API files the lost decision as socket-stall.
 *  - this table's later socket close is a KICK (the failure path), not the site closing an empty table — until hero is
 *    dealt into a hand again.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { SessionStore } from "../../src/sessions";
import { S, resetState } from "../../src/state";
import { noteSocketClosed, siteClosedEvidence } from "../../src/ignition/reader";
import { KEEPALIVE_GRACE_S, KEEPALIVE_S, STALL_SILENT_S, checkSocketStall, noteHeroDealt, noteTapFrame, stallMakesKick, stallsFor } from "../../src/ignition/stall";
import { checker, J, scratchDirs } from "./helpers";

const RID = "16052.2433", OTHER = "16052.1584";
/** 14:11:50.183, table 2's last PONG before the stall */
const PONG = 1_791_011_510.183;
/** 14:12:03.326, the river — the socket's last frame for 41 s */
const RIVER = 1_791_011_523.326;

function rig() {
  const tmp = scratchDirs("socket-stall-");
  delete process.env.TABLE_SLOT;
  delete process.env.TABLE_COUNT;
  reloadConfig();
  resetState();
  setFakeTime(PONG);
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  const sid = "session_20261003_111447_test";
  const rec = S.sessions.start(sid, "strategy:test", null, null, { tables: 1, format: "ign-ring-NL5-6" }, { ok: true }, {});
  Object.assign(S.session, { id: sid, rec, started: time() });
  S.tapBound = RID;
  S.handNo = 325;
  S.handIds.set(325, "4922280690");
  Object.assign(S.ws, { handOver: false, heroFolded: false, heroCards: ["Td", "Ts"], board: ["2d", "3d", "2c", "Jc", "7h"] });
  S.liveStatus.hero = "in-hand";
  S.liveStatus.heroSeatDom = 5;
  noteTapFrame(RID, "PONG");
  noteTapFrame(OTHER, "PONG");
  const log0 = console.log;
  console.log = () => {};
  const events = (kind: string): any[] => (S.sessions.get(sid).events || []).filter((e: any) => e.kind === kind);
  const undo = () => {
    console.log = log0;
    realTime();
    resetState();
  };
  return { sid, events, undo };
}

test("the bound socket silent mid-hand with its keep-alive overdue is a stall; its next frame ends it", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { events, undo } = rig();
  try {
    setFakeTime(RIVER);
    noteTapFrame(RID, "CO_CURRENT_PLAYER");
    setFakeTime(RIVER + STALL_SILENT_S + 2);                  // 12 s silent, the PONG 25 s old: not overdue yet
    checkSocketStall();
    eq("silence alone, the keep-alive not yet due → no stall", S.socketStall.cur, null);
    setFakeTime(1_791_011_542.24);                            // 14:12:22.24: table 1's PONG, on time
    noteTapFrame(OTHER, "PONG");
    setFakeTime(PONG + KEEPALIVE_S + KEEPALIVE_GRACE_S + 0.5);  // 14:12:25.7: 22 s silent, the PONG 5.5 s overdue
    checkSocketStall();
    const st = S.socketStall.cur;
    check("a stall is open", st !== null, "none");
    eq("  ... on our socket, in the hand, on the river, with the page's other table still talking",
       [st?.rid, st?.hand, st?.clientHandId, st?.street, st?.pageAlive], [RID, 325, "4922280690", "river", true]);
    eq("  ... and said once to the session", events("socket-stall").length, 1);
    checkSocketStall();
    eq("a second check does not open a second stall", [events("socket-stall").length, S.socketStall.byHand.get(325)?.length], [1, 1]);
    setFakeTime(1_791_011_564.416);                           // 14:12:44.416: the burst
    noteTapFrame(RID, "CO_SELECT_INFO");
    eq("its next frame ends it, with how long the socket was silent", [S.socketStall.cur, S.socketStall.last?.silentS], [null, 41.1]);
    eq("  ... said to the session", events("socket-stall-end").map((e) => e.silentS), [41.1]);
    eq("the hand carries it for its row", stallsFor(325)?.map((s: any) => [s.street, s.silentS, s.pageAlive]), [["river", 41.1, true]]);
    eq("another hand carries nothing", stallsFor(326), null);
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("not a stall: hero out of the hand, the keep-alive on time, no PONG ever seen, not bound", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  let r = rig();
  try {
    S.ws.heroFolded = true;
    setFakeTime(PONG + 60);
    checkSocketStall();
    eq("hero folded: an idle socket is no stall", S.socketStall.cur, null);
  } finally {
    r.undo();
  }
  r = rig();
  try {
    setFakeTime(PONG + 25);
    noteTapFrame(RID, "PONG");                                // the keep-alive came; the hand is merely quiet
    setFakeTime(PONG + 25 + STALL_SILENT_S + 5);
    checkSocketStall();
    eq("a quiet hand whose keep-alive is on time: no stall", S.socketStall.cur, null);
  } finally {
    r.undo();
  }
  r = rig();
  try {
    S.tapLast.clear();
    noteTapFrame(RID, "CO_TABLE_STATE");
    setFakeTime(PONG + 60);
    checkSocketStall();
    eq("no PONG ever seen on the socket: no cadence to call late", S.socketStall.cur, null);
  } finally {
    r.undo();
  }
  r = rig();
  try {
    S.tapBound = null;
    setFakeTime(PONG + 60);
    checkSocketStall();
    eq("no socket bound: nothing of ours to call silent", S.socketStall.cur, null);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("a close after a stall is a kick, not the site closing an empty table — until hero is dealt in again", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  let r = rig();
  try {
    setFakeTime(PONG + 40);
    checkSocketStall();
    setFakeTime(PONG + 55);
    noteTapFrame(RID, "CO_SELECT_INFO");                     // the burst: hero folded at 0 s, sat out
    // hero sat out, removed, the table emptied: the frame's last full read shows no seat occupied, no hand on
    Object.assign(S.ws, { handOver: true, heroFolded: false, heroCards: [] });
    S.feedPrev = { seated: true, seats: new Map() };
    S.handNo = 346;
    check("the frame alone would call it the site's close", siteClosedEvidence()?.why === "no seat was occupied", J(siteClosedEvidence()));
    check("the stall says kick", (stallMakesKick(RID) || "").includes("hand #325"), String(stallMakesKick(RID)));
    eq("  ... for the socket that stalled only", stallMakesKick(OTHER), null);
    setFakeTime(PONG + 1000);
    noteSocketClosed(RID);
    eq("the close takes the failure path (a kick ends the session), nothing held for a re-seat",
       [S.disconnect?.text, S.siteClosed.notice], ["the table's game socket closed", null]);
    check("  ... saying why", (S.disconnect?.via || "").includes("connection stall"), String(S.disconnect?.via));
  } finally {
    r.undo();
  }
  r = rig();
  try {
    setFakeTime(PONG + 40);
    checkSocketStall();
    setFakeTime(PONG + 55);
    noteTapFrame(RID, "CO_SELECT_INFO");
    noteHeroDealt(325);
    check("cards in the stalled hand itself prove nothing", stallMakesKick(RID) !== null, "cleared");
    noteHeroDealt(326);                                       // the stall passed and hero played on
    eq("hero dealt into a later hand: the seat survived, no kick", stallMakesKick(RID), null);
    Object.assign(S.ws, { handOver: true, heroFolded: false, heroCards: [] });
    S.liveStatus.heroSeatDom = 5;
    S.feedPrev = { seated: true, seats: new Map([[5, { hero: true }]]) };
    setFakeTime(PONG + 1000);
    noteSocketClosed(RID);
    eq("  ... so a later close of the emptied table is the site's again (held, not failed)",
       [S.disconnect, !!S.siteClosed.notice], [null, true]);
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});
