/**
 * A TABLE READ THAT DID NOT HAPPEN IS A FAILED TICK (reader.ts TableReadError, audit 2026-09-25). Before: feedTick
 * returned quietly on a read that threw and on a missing client page, so loops.ts never counted a failure and
 * "table reader failing" could not fire; and a read that came back empty (cdp.evaluate's null: no reply in time, or
 * the page threw) read as "not seated" — "table closed", the hand in play archived, the seat memory wiped. The good
 * read is a real capture (test/fixtures/disconnect-overlay-2026-09-25.json, the tick before that disconnect).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { FEED_STALL_TICKS, feedLoopOnce } from "../../src/loops";
import { SessionStore } from "../../src/sessions";
import { S, resetState, seams } from "../../src/state";
import { mySel, tableJs, watchJs } from "../../src/ignition/dom";
import { checker, J, scratchDirs } from "./helpers";

const FIX = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "disconnect-overlay-2026-09-25.json"), "utf8"));
const GOOD = FIX.ticks.find((t: any) => t.seq === 514).d;

type Read = { kind: "good" } | { kind: "throw" } | { kind: "null" } | { kind: "noTarget" };

function rig(withSession = true) {
  const tmp = scratchDirs("table-read-");
  delete process.env.TABLE_SLOT;
  delete process.env.TABLE_COUNT;
  reloadConfig();
  resetState();
  setFakeTime(1_790_334_000);
  S.site.id = "ignition";
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  const sid = "session_20260926_readfail_test";
  if (withSession) {
    const rec = S.sessions.start(sid, "strategy:test", null, null, { tables: 1 }, { ok: true }, {});
    Object.assign(S.session, { id: sid, rec, started: time() });
  }
  const io0 = { ...cdp.io }, seams0 = { ...seams };
  let read: Read = { kind: "good" };
  const target = { id: "client", webSocketDebuggerUrl: "ws://client", url: "https://www.ignitioncasino.uno/static/poker-game/" };
  cdp.io.available = async () => true;
  cdp.io.pageTargets = async () => (read.kind === "noTarget" ? [] : [target]);
  cdp.io.evaluate = async (_ws: string, expr: string) => {
    if (expr === tableJs(mySel())) {
      if (read.kind === "throw") throw new cdp.CdpError("socket closed");
      if (read.kind === "null") return null;
      return structuredClone(GOOD);
    }
    if (expr === watchJs(mySel())) return [];
    return null;
  };
  cdp.io.dispatchClick = async () => {};
  seams.ignitionTarget = async () => (read.kind === "noTarget" ? null : target);
  seams.livePeers = async () => [];
  const log0 = console.log;
  const logs: string[] = [];
  console.log = (...a: any[]) => { logs.push(a.join(" ")); };
  const loop = { fails: 0 };
  const tick = async (r: Read["kind"]) => {
    read = { kind: r } as Read;
    setFakeTime(time() + 0.25);
    await feedLoopOnce(loop);
  };
  const feed = () => S.feed.map((f) => f.line as string);
  const events = () => (S.session.id ? (S.sessions.get(sid)?.events || []).map((e: any) => e.kind) : []);
  const undo = () => {
    console.log = log0;
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
    realTime();
    resetState();
  };
  return { loop, tick, feed, events, logs, undo };
}

test("reads that fail are counted: FEED_STALL_TICKS in a row raise the warning, stop 'to act', and are a session event", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { loop, tick, feed, events, undo } = rig();
  try {
    await tick("good");
    eq("a good read: seated, nothing failing", [S.feedPrev.seated, loop.fails], [true, 0]);
    S.liveStatus.toAct = true;   // as the last good read might have left it
    for (let i = 1; i < FEED_STALL_TICKS; i++) await tick("throw");
    eq("reads that throw are counted", loop.fails, FEED_STALL_TICKS - 1);
    eq("  ... no warning before FEED_STALL_TICKS", feed().some((f) => f.includes("table reader failing")), false);
    await tick("throw");
    check("at FEED_STALL_TICKS: the warning names the failed read",
          feed().some((f) => f.includes("table reader failing") && f.includes("TableReadError") && f.includes("socket closed")), J(feed()));
    eq("  ... /state says so and stops claiming it is our turn", [!!S.liveStatus.feedStalled, S.liveStatus.toAct], [true, false]);
    eq("  ... a feed-stalled session event", events().includes("feed-stalled"), true);
    await tick("good");
    eq("the next good read: recovered, said once", [loop.fails, S.liveStatus.feedStalled, feed().filter((f) => f === "Table reader recovered").length], [0, null, 1]);
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("an empty read mid-hand is a failed read — never 'table closed', never an archive", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { loop, tick, feed, undo } = rig();
  try {
    await tick("good");
    const hand = S.handNo;
    await tick("null");
    await tick("null");
    eq("two empty replies: counted as failures", loop.fails, 2);
    eq("  ... the table is not closed and the hand is not moved on", [feed().includes("table closed"), S.feedPrev.seated, S.handNo], [false, true, hand]);
    await tick("good");
    eq("the next good read carries on the same hand, no 'Table opened' again", [S.handNo, feed().filter((f) => f.startsWith("Table opened")).length], [hand, 1]);
    eq("  ... a blip too short for the warning is not announced as a recovery", feed().includes("Table reader recovered"), false);
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("no client page: a failure while a session expects a table, nothing outside one or after a disconnect closed it", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  {
    const { loop, tick, feed, undo } = rig();
    try {
      for (let i = 0; i < FEED_STALL_TICKS; i++) await tick("noTarget");
      eq("in a session: counted, and warned", [loop.fails, feed().some((f) => f.includes("the poker client is not open"))], [FEED_STALL_TICKS, true]);
    } finally {
      undo();
    }
  }
  {
    const { loop, tick, undo } = rig(false);
    try {
      for (let i = 0; i < FEED_STALL_TICKS; i++) await tick("noTarget");
      eq("no session (an idle wrapper, client closed): not a failure", loop.fails, 0);
    } finally {
      undo();
    }
  }
  {
    const { loop, tick, undo } = rig();
    try {
      S.disconnect = { at: time(), slot: 1, text: "disconnected", attempt: 0, of: 32, reconnected: false, sid: S.session.id, handled: true, via: "test" };
      await tick("noTarget");
      eq("the disconnect path closed the client on purpose: not a failure", loop.fails, 0);
    } finally {
      undo();
    }
  }
  expect(fails).toEqual([]);
});
