/**
 * THE RECORD IS CLOSED WHEN THE HAND ENDS UNSEEN (2026-10-14, the answer-path audit's merged records). Hand 4923409614
 * (session_20261009_010205, table 1 of 2, NL5): the river answer BET 1.2 was served at 03:11:49.7, the table's socket
 * then went silent (a 34 s connection stall) and CLOSED at 03:12:23.740 with the hand in play. The close released the
 * bind but forgot nothing: 60 ms later the DOM tick saw hero's 2♣J♣ still on screen, matched them to the CLOSED socket's
 * deal and re-bound it — replaying its 86 frames into the record still open for the hand (`<tap-bound> replayed: 86`;
 * PLAY_STAGE_INFO a "dup" for the same id, every other frame appended). The session's closing archive stored 25
 * actions: the hand's 15, then its blinds on the "river" (post-sb at index 15), its flop and its turn again. The API's
 * reconciler read hero's replayed actions as decisions nobody asked about (answers 13721-13724). Tables 2's 4923409734
 * (the same instant) and session_20261008_175953's 4923345879 went the same way.
 *
 * Replayed here from the socket dump (test/fixtures/ign-socket-close-rebind-20261009.jsonl.gz: the hand's frames,
 * the three `<socket-closed>` markers; nicknames, chat, uuids and buy amounts blanked). The DOM tick is tapVerify with
 * hero's cards, as reader.ts calls it. Pinned:
 *  - a closed socket never binds again (ws.ts tapSocketClosed / tapBind): the record keeps its 15 actions;
 *  - the archive stamps the record `endedUnseen` (its end never came) with what it had;
 *  - the connection guard is untouched: the close still ends the session (S.disconnect);
 *  - a blind post arriving while the hand in progress is past its posts (a lost PLAY_STAGE_INFO) closes the record,
 *    ended unseen, and opens the hand the post belongs to;
 *  - a hand whose PLAY_STAGE_END_REQ came is archived without the stamp.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realTime, setFakeTime } from "../../src/clock";
import { DATA_DIR, reloadConfig } from "../../src/config";
import { S, resetState } from "../../src/state";
import { archiveHand } from "../../src/archive";
import { handState } from "../../src/ignition/hand";
import { noteSocketClosed } from "../../src/ignition/reader";
import { endUnseenNote, tapFrame, tapVerify, wsSeams } from "../../src/ignition/ws";
import { checker, J, scratchDirs } from "./helpers";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "ign-socket-close-rebind-20261009.jsonl.gz");
const HAND = "4923409614", RID = "48560.8024", HERO_CARDS = ["2♣", "J♣"];

/** the hand as the table sent it, and as Ignition's own history has it up to the stall */
const SEEN = [
  ["preflop", 6, "post-sb", 0.4], ["preflop", 1, "post-bb", 1], ["preflop", 3, "post", 1],
  ["preflop", 3, "check", null], ["preflop", 4, "fold", null], ["preflop", 6, "call", 0.6], ["preflop", 1, "check", null],
  ["flop", 6, "check", null], ["flop", 1, "check", null], ["flop", 3, "check", null],
  ["turn", 6, "check", null], ["turn", 1, "check", null], ["turn", 3, "bet", 1], ["turn", 6, "call", 1], ["turn", 1, "fold", null],
];

type Rec = { ts: number; rid: string | null; d: Record<string, any> };
const readFixture = (): Rec[] =>
  new TextDecoder().decode(Bun.gunzipSync(readFileSync(FIXTURE))).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.k !== "meta");

const line = (h: any) => (h?.actions || []).map((a: any) => [a.street, a.seatId, a.type, a.amount ?? null]);

function rowsNow(): { data: any; status: string }[] {
  const dbp = join(DATA_DIR(), "hands.db");
  if (!existsSync(dbp)) return [];
  const c = new Database(dbp);
  try {
    return (c.query("SELECT data, status FROM hands ORDER BY rowid").all() as any[]).map((r) => ({ data: JSON.parse(r.data), status: r.status }));
  } finally {
    c.close();
  }
}

/** Table 1 of a two-table session, bound by the cards on its own frame (the multi-table tap keeps every socket's hand). */
function rig() {
  scratchDirs("wrapper-rebind-");
  process.env.TABLE_SLOT = "1";
  process.env.TABLE_COUNT = "2";
  reloadConfig();
  resetState();
  S.session.id = "session_20261009_010205_test";
  S.liveStatus.heroSeatDom = 6;
  const log0 = console.log;
  console.log = () => {};
  return () => {
    console.log = log0;
    realTime();
    resetState();
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
    reloadConfig();
  };
}

/** The frames up to (not including) the socket closes, through the tap, with the DOM tick after each. */
function playUntilClose(recs: Rec[]): Rec[] {
  const closes: Rec[] = [];
  for (const r of recs) {
    setFakeTime(r.ts);
    const pid = String(r.d.pid);
    if (pid === "<socket-closed>") { closes.push(r); continue; }
    if (pid.startsWith("<")) continue;
    tapFrame(r.d, r.rid, null);
    tapVerify(HERO_CARDS);
  }
  return closes;
}

test("4923409614: our socket closing mid-hand never re-binds — the record keeps the hand once, archived as ended unseen", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const undo = rig();
  try {
    const recs = readFixture();
    const closes = playUntilClose(recs);
    eq("the fixture: three sockets closed, ours among them", closes.map((c) => [c.d.rid, c.d.ours]), [["48560.7787", false], [RID, true], ["48560.8312", false]]);
    eq("bound to the table's socket, the hand read as the table sent it", [S.tapBound, S.handIds.get(S.handNo), line(handState())], [RID, HAND, SEEN]);
    const framesBefore = (S.ws.frames || []).length;
    const boundEvents = () => S.wsDump.filter((e) => e.data?.pid === "<tap-bound>").length;
    const bound0 = boundEvents();

    // the closes, in the order the tap saw them (Browser.close took every socket of the page)
    for (const c of closes) {
      setFakeTime(c.ts);
      noteSocketClosed(String(c.d.rid));
    }
    eq("our socket's close releases the bind", S.tapBound, null);
    check("…and ends the session as before (the connection guard's rule)", S.disconnect?.text === "the table's game socket closed", J(S.disconnect));
    // the DOM ticks that followed: hero's cards still on screen (the client was being closed)
    for (let i = 0; i < 8; i++) {
      setFakeTime(closes[closes.length - 1]!.ts + 0.06 + i * 0.25);
      tapVerify(HERO_CARDS);
    }
    eq("the closed socket is not bound again on the cards it dealt", [S.tapBound, boundEvents() - bound0], [null, 0]);
    eq("nothing was replayed into the open record", [(S.ws.frames || []).length, line(handState())], [framesBefore, SEEN]);

    // the session's closing archive (session.ts sessionEnd → archiveHand)
    setFakeTime(closes[closes.length - 1]!.ts + 0.7);
    archiveHand();
    const rows = rowsNow().filter((x) => x.data.clientHandId === HAND);
    eq("one stored row for the hand", [rows.length, rowsNow().length], [1, 1]);
    const row = rows[0]?.data;
    if (row) {
      eq("it is finished, on the river, with the 15 actions the table sent — nothing twice", [rows[0]!.status, row.street, line(row)], ["done", "river", SEEN]);
      eq("the board is the hand's five cards", row.board, ["K♦", "5♣", "J♥", "8♥", "5♠"]);
      check("the record says its end was never seen", !!row.endedUnseen, J(row.endedUnseen));
      eq("  … on the river, with its 15 actions", [row.endedUnseen?.street, row.endedUnseen?.actions], ["river", 15]);
      check("  … because the table's socket closed", /socket closed/.test(row.endedUnseen?.why ?? ""), J(row.endedUnseen));
    }
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("a blind post while the hand in progress is past its posts closes the record (ended unseen) and opens the next hand", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const undo = rig();
  const keep = wsSeams.archiveHand;
  const archived: { id: string | null; line: any; unseen: ReturnType<typeof endUnseenNote> }[] = [];
  // the archive as archive.ts makes it, less the write: a hand with no actions is never archived
  wsSeams.archiveHand = () => {
    if (!(S.ws.actions || []).length) return;
    archived.push({ id: S.handIds.get(S.handNo) ?? null, line: line(handState()), unseen: endUnseenNote() });
  };
  try {
    const recs = readFixture();
    // the hand up to hero's turn on the flop
    const flop = recs.findIndex((r) => r.d.pid === "CO_BCARD3_INFO");
    const upToFlop = recs.slice(0, flop + 1);
    playUntilClose(upToFlop);
    eq("the hand so far", line(handState()), SEEN.slice(0, 7));
    eq("nothing archived yet", archived.length, 0);
    // the next hand's small blind, its PLAY_STAGE_INFO lost
    setFakeTime(upToFlop[upToFlop.length - 1]!.ts + 2);
    tapFrame({ pid: "CO_BLIND_INFO", seat: 1, account: 600, baseStakes: 0, btn: 2, bet: 2, dead: 0 }, RID, null);
    eq("the record was closed as it stood, ended unseen", archived.map((a) => [a.id, a.line.length, a.unseen?.street, a.unseen?.actions]), [[HAND, 7, "flop", 7]]);
    check("  … and says why", /blind was posted/.test(archived[0]?.unseen?.why ?? ""), J(archived[0]?.unseen));
    eq("  … with the seven actions the table had sent, the post not among them", archived[0]?.line, SEEN.slice(0, 7));
    eq("the post opened the hand it belongs to (id-less until the table names it)", [S.handIds.get(S.handNo), (S.ws.actions || []).map((a: any) => [a.seat, a.type])], ["", [[1, "post-sb"]]]);
    eq("  … whose protocol line holds only that post", (S.ws.frames || []).map((f: any) => f.pid), ["CO_BLIND_INFO"]);
  } finally {
    wsSeams.archiveHand = keep;
    undo();
  }
  expect(fails).toEqual([]);
});

test("a hand closed by the session's end, its socket still open, is stamped ended unseen", () => {
  const { fails, check } = checker();
  const undo = rig();
  try {
    const recs = readFixture();
    const closes = playUntilClose(recs);
    // the session ends with the hand in play (sessionEnd → archiveHand), the socket still open
    setFakeTime(closes[0]!.ts - 1);
    const unseen = endUnseenNote();
    check("a hand in play has no end yet", !!unseen && unseen.street === "river" && unseen.actions === 15, J(unseen));
    archiveHand();
    const row = rowsNow().find((x) => x.data.clientHandId === HAND)?.data;
    check("the session-end archive stamps it", !!row?.endedUnseen && /closed before the table's end-of-hand frame/.test(row.endedUnseen.why), J(row?.endedUnseen));
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("a hand whose end came (PLAY_STAGE_END_REQ) is archived without the stamp", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const undo = rig();
  try {
    const recs = readFixture();
    const closes = playUntilClose(recs);
    setFakeTime(closes[0]!.ts - 1);
    tapFrame({ pid: "PLAY_STAGE_END_REQ" }, RID, null);
    eq("the end came: no stamp to give", endUnseenNote(), null);
    archiveHand();
    const rows = rowsNow().filter((x) => x.data.clientHandId === HAND);
    eq("one row, finished", [rows.length, rows[0]?.status, line(rows[0]?.data).length], [1, "done", 15]);
    check("…without the stamp", rows[0]!.data.endedUnseen === undefined, J(rows[0]!.data.endedUnseen));
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});
