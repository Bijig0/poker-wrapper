/**
 * A CONNECTION DROP ENDS THE SESSION, AND NOTHING SITS HERO BACK IN (Brady, 2026-09-25 — "do not sit back after a
 * connection drop, just end the session"). netguard.ts: NET_BAD_TO_SITOUT bad probes in a row tick "Sit out next
 * hand" and note the drop; session.ts maybeEndForNetDrop ends the session when hero's hand is over (or past
 * NET_DROP_HAND_WAIT_S); a follower hands it to the leader; the link coming back undoes nothing; sitback.ts never
 * presses I AM BACK while a drop is noted.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { netSeams, netStep } from "../../src/netguard";
import { SessionStore } from "../../src/sessions";
import { NET_DROP_HAND_WAIT_S, maybeEndForNetDrop, sessionNetDrop, sessionSeams } from "../../src/session";
import { maybeSitBackIn, sitBackSeams } from "../../src/sitback";
import { S, resetState, seams } from "../../src/state";
import { checker, J, scratchDirs } from "./helpers";

const BAD = { ok: false, why: ["round trip 290 ms (max 200)"], rttMs: 290 };
const GOOD = { ok: true, why: [], rttMs: 120 };

/** One wrapper in a live session; every outside effect recorded. */
function rig(slot: number | null, tellLeader: (b: any) => Promise<any> = async () => ({ ok: true })) {
  const tmp = scratchDirs("net-drop-");
  if (slot === null) {
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
  } else {
    process.env.TABLE_SLOT = String(slot);
    process.env.TABLE_COUNT = "4";
  }
  reloadConfig();
  resetState();
  setFakeTime(1_790_400_000);
  S.site.id = "ignition";
  S.fakeMode = false;
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  const sid = "session_20260925_netdrop_test";
  const rec = S.sessions.start(sid, "strategy:test", null, null, { tables: slot ? 4 : 1, answers: true }, { ok: true }, {});
  Object.assign(S.session, { id: sid, rec, started: time() });
  Object.assign(S.study, { on: true, sitBackIn: true, sitBackTurn: null });
  const out = { sid, sitouts: 0, backs: 0, told: [] as any[] };
  const seams0 = { ...seams }, ss0 = { ...sessionSeams }, sit0 = netSeams.sitout, back0 = sitBackSeams.press;
  seams.livePeers = async () => [];
  netSeams.sitout = async () => { out.sitouts++; return { ok: true, clicked: true, state: "ticked" }; };
  sitBackSeams.press = async () => { out.backs++; return { ok: true, clicked: true }; };
  sessionSeams.tellLeaderNetDrop = async (b: any) => { out.told.push(b); return tellLeader(b); };
  const log0 = console.log;
  console.log = () => {};
  const inHand = (yes: boolean) => {
    S.liveStatus.hero = yes ? "in-hand" : "sitting-out";
    Object.assign(S.ws, { heroCards: yes ? ["As", "Kd"] : [], handOver: !yes, heroFolded: false });
  };
  const later = (s: number) => setFakeTime(time() + s);
  const ended = () => S.sessions.get(sid);
  const undo = () => {
    console.log = log0;
    Object.assign(seams, seams0);
    Object.assign(sessionSeams, ss0);
    netSeams.sitout = sit0;
    sitBackSeams.press = back0;
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
    reloadConfig();
    realTime();
    resetState();
  };
  return { out, inHand, later, ended, undo };
}

test("the table's own check: sit out next hand, finish the hand, end the session — never sit back in", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { out, inHand, later, ended, undo } = rig(null);
  const feed = () => S.feed.map((f) => f.line as string);
  try {
    inHand(true);
    await netStep(BAD);
    eq("one bad probe: nothing yet", [out.sitouts, S.net.drop], [0, null]);
    await netStep(BAD);
    eq("two in a row: 'Sit out next hand' is ticked", out.sitouts, 1);
    eq("  ... and the drop is noted for this session", [S.net.drop?.sid, S.net.drop?.handled], [out.sid, false]);
    check("  ... the panel says the session ends", feed().some((f) => f.includes("CONNECTION DROPPED") && f.includes("session ends")), J(feed()));
    await maybeEndForNetDrop();
    eq("hero is in a hand: the session keeps answering it", S.session.id, out.sid);
    await netStep(GOOD);
    await netStep(GOOD);
    await netStep(GOOD);
    eq("the link coming back undoes nothing", [!!S.net.drop, S.session.id], [true, out.sid]);
    check("  ... and never says to press I'm back", !feed().some((f) => f.includes("I'm back")), J(feed()));
    inHand(false);
    later(5);
    await maybeSitBackIn();
    eq("sat out between hands with a drop noted: I AM BACK is not pressed", out.backs, 0);
    await maybeEndForNetDrop();
    eq("hand over: the session is ended", S.session.id, null);
    const r = ended();
    check("  ... in the record, with the reason", !!r?.ended_at && String(r?.note || "").includes("connection dropped"), J([r?.ended_at, r?.note]));
    check("  ... net-drop is a session event", (r?.events || []).some((e: any) => e.kind === "net-drop"), J((r?.events || []).map((e: any) => e.kind)));
    later(30);
    await maybeSitBackIn();
    eq("after the end nothing sits hero back in", out.backs, 0);
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("a hand that never reads as over does not hold the session open past NET_DROP_HAND_WAIT_S", async () => {
  const { fails, check } = checker();
  const { out, inHand, later, ended, undo } = rig(null);
  try {
    inHand(true);
    await netStep(BAD);
    await netStep(BAD);
    later(NET_DROP_HAND_WAIT_S - 1);
    await maybeEndForNetDrop();
    check("inside the wait: still on", S.session.id === out.sid, J(S.session.id));
    later(2);
    await maybeEndForNetDrop();
    check("past it: ended regardless", S.session.id === null, J(S.session.id));
    check("  ... and the note says hero was still in a hand", String(ended()?.note || "").includes("still in a hand"), J(ended()?.note));
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("a follower hands the drop to the leader — and ends it itself if the leader does not answer", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  {
    const { out, inHand, undo } = rig(3);
    try {
      inHand(false);
      await netStep(BAD);
      await netStep(BAD);
      await maybeEndForNetDrop();
      eq("table 3 tells the leader once", out.told.map((b) => [b.sid, b.slot]), [[out.sid, 3]]);
      eq("  ... and leaves the ending to it", S.session.id, out.sid);
      await maybeEndForNetDrop();
      eq("  ... not told twice", out.told.length, 1);
    } finally {
      undo();
    }
  }
  {
    const { out, inHand, undo } = rig(2, async () => ({ ok: false, error: "connection refused" }));
    try {
      inHand(false);
      await netStep(BAD);
      await netStep(BAD);
      await maybeEndForNetDrop();
      eq("the leader is gone: table 2 ends the session itself", [out.told.length, S.session.id], [1, null]);
    } finally {
      undo();
    }
  }
  expect(fails).toEqual([]);
});

test("the leader, told by another table, ends the session at its own hand's end", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { out, inHand, ended, undo } = rig(1);
  try {
    inHand(true);
    const [code, res] = await sessionNetDrop({ sid: out.sid, slot: 3, why: "5 of 10 lost" });
    eq("mid-hand: noted, pending", [code, res.ended, res.pending, S.net.drop?.via], [200, null, true, "table 3 told us"]);
    const [, other] = await sessionNetDrop({ sid: "some_other_session", slot: 4 });
    eq("another session's drop is not this one's", other.ended, null);
    inHand(false);
    const [, done] = await sessionNetDrop({ sid: out.sid, slot: 4 });
    eq("a later call at the boundary ends it", [done.ended, S.session.id], [out.sid, null]);
    check("  ... with table 3's reason", String(ended()?.note || "").includes("table 3 told us"), J(ended()?.note));
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("a drop noted in one session never ends the next", async () => {
  const { fails, check } = checker();
  const { out, inHand, undo } = rig(null);
  try {
    inHand(true);
    await netStep(BAD);
    await netStep(BAD);
    // that session is ended by hand before the drop is acted on, and another starts
    await (await import("../../src/session")).sessionEnd({ id: out.sid, note: "ended by hand" });
    const sid2 = "session_next_netdrop_test";
    const rec = S.sessions.start(sid2, "strategy:test", null, null, { tables: 1, answers: true }, { ok: true }, {});
    Object.assign(S.session, { id: sid2, rec, started: time() });
    inHand(false);
    await maybeEndForNetDrop();
    check("the next session is left running", S.session.id === sid2, J(S.session.id));
    check("  ... and the stale drop is cleared", S.net.drop === null, J(S.net.drop));
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});
