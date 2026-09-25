/**
 * A TABLE LOST THE POKER SERVER: END THE SESSION, NEVER RECONNECT (Brady, 2026-09-25 — "if a table gets
 * disconnected, keep it disconnected, do not allow a reconnect, just end the session then and there").
 *
 * What a disconnect looks like, from the recordings (session_20260925_180244 18:09:19, and session_20260807_115240
 * 12:01:42): an overlay inside the table frame — "You are currently disconnected from our poker server." /
 * "Reconnecting..." / "Attempt N of 32" over CANCEL, an attempt about every 3 s — then the client reconnects BY
 * ITSELF ("Connected", 22-27 s later) and the seats come back as "Sit here". The captures below are the real ones
 * (test/fixtures/disconnect-overlay-2026-09-25.json), fed through the real reader and loop.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { SessionStore } from "../../src/sessions";
import { S, pressBlocked, resetState, seams } from "../../src/state";
import { disconnectOf, mySel, tableJs, watchJs } from "../../src/ignition/dom";
import { feedLoopOnce } from "../../src/loops";
import { pickReady, pointIsMyTable } from "../../src/relay";
import { sessionDisconnected, sessionJoin, sessionSeams } from "../../src/session";
import { corpusFiles, readCorpus } from "../golden/lib";
import { checker, J, scratchDirs } from "./helpers";

const FIX = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "disconnect-overlay-2026-09-25.json"), "utf8"));
const TICK = (seq: number) => FIX.ticks.find((t: any) => t.seq === seq).d;
const CONNECTED_BEFORE = 514, ATTEMPT_0 = 515, ATTEMPT_4 = 536, RECONNECTED = 552;

test("the client's disconnect overlay is recognised on the real captures — and nothing else is", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  eq("the tick before: nothing (the 'You're connected to our server' tooltip is always in the DOM)", disconnectOf(TICK(CONNECTED_BEFORE)), null);
  eq("18:09:19 — disconnected, attempt 0 of 32", disconnectOf(TICK(ATTEMPT_0)),
     { text: "You are currently disconnected from our poker server.", attempt: 0, of: 32, reconnected: false });
  eq("  ... still, at attempt 4", disconnectOf(TICK(ATTEMPT_4))?.attempt, 4);
  eq("the client's own reconnect ('Connected' over CANCEL) is a disconnect that already happened", disconnectOf(TICK(RECONNECTED)),
     { text: "Connected", attempt: null, of: null, reconnected: true });
  // every table read in the golden corpus: the overlay only where a disconnect really happened
  let n = 0;
  const hits = new Map<string, number>();
  for (const f of corpusFiles("reader-")) {
    for (const r of readCorpus(f)) {
      if (r.type !== "in" || r.kind !== "dom") continue;
      n++;
      const x = disconnectOf(r.d);
      if (x) hits.set(f, (hits.get(f) || 0) + 1);
    }
  }
  check("the corpus was read", n > 20_000, String(n));
  eq("over every recorded table read, only the 2026-08-07 disconnect (61 ticks of its overlay) is seen", Object.fromEntries(hits),
     { "reader-session_20260807_115240.jsonl.gz": 61 });
  expect(fails).toEqual([]);
}, 120_000);

/** One wrapper with a live session, the client answering from the fixture, every outside effect recorded. */
function rig(slot: number | null, tellLeader: (b: any) => Promise<any> = async () => ({ ok: true })) {
  const tmp = scratchDirs("disconnect-");
  if (slot === null) {
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
  } else {
    process.env.TABLE_SLOT = String(slot);
    process.env.TABLE_COUNT = "4";
  }
  reloadConfig();
  resetState();
  setFakeTime(1_790_334_559);
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  const sid = "session_20260925_180244_test";
  const rec = S.sessions.start(sid, "strategy:test", null, null, { tables: slot ? 4 : 1 }, { ok: true }, {});
  Object.assign(S.session, { id: sid, rec, started: time() });
  Object.assign(S.study, { on: true, auto: true, text: "PREFLOP — Fold 100%", pick: "Fold", at: time(),
                           decisionKey: JSON.stringify(["preflop", [], ["As", "Kd"], 0, 3]), handId: S.handNo });
  const io0 = { ...cdp.io }, seams0 = { ...seams }, ss0 = { ...sessionSeams };
  // the real press code, for asking it directly (the loop's own presses go to the recorders below)
  const out = { sid, closes: 0, told: [] as any[], presses: [] as any[], cur: {} as any, act: seams0.act, raiseTo: seams0.raiseTo };
  const target = { id: "client", webSocketDebuggerUrl: "ws://client", url: "https://www.ignitioncasino.uno/static/poker-game/" };
  cdp.io.available = async () => false;
  cdp.io.pageTargets = async () => [target];
  cdp.io.evaluate = async (_ws: string, expr: string) => {
    if (expr === tableJs(mySel())) return structuredClone(out.cur);
    if (expr === watchJs(mySel())) return [];
    return null;
  };
  cdp.io.dispatchClick = async (_ws: string, x: number, y: number) => { out.presses.push({ click: [x, y] }); };
  seams.ignitionTarget = async () => target;
  seams.livePeers = async () => [];
  seams.act = async (label: string, kind = "action") => { out.presses.push({ act: [label, kind] }); return { ok: true }; };
  seams.raiseTo = async (amount: string) => { out.presses.push({ raiseTo: amount }); return { ok: true }; };
  sessionSeams.closeClient = async () => { out.closes++; return "closed (test)"; };
  sessionSeams.tellLeader = async (b: any) => { out.told.push(b); return tellLeader(b); };
  const log0 = console.log;
  console.log = () => {};
  const tick = async (seq: number) => {
    out.cur = TICK(seq);
    setFakeTime(time() + 0.25);
    await feedLoopOnce({ fails: 0 });
  };
  const undo = () => {
    console.log = log0;
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
    Object.assign(sessionSeams, ss0);
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
    realTime();
    resetState();
  };
  return { out, tick, undo };
}

test("the table that sees it closes the client at once and ends the session — nothing reconnects, nothing is pressed", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { out, tick, undo } = rig(null);
  try {
    await tick(CONNECTED_BEFORE);
    eq("connected: nothing happens", [S.disconnect, out.closes, S.session.id], [null, 0, out.sid]);
    await tick(ATTEMPT_0);
    eq("the first overlay tick: the client is closed, once", out.closes, 1);
    eq("  ... and the session is over", S.session.id, null);
    const rec = S.sessions.get(out.sid);
    check("  ... in the record: ended, with why", !!rec.ended_at && String(rec.note).includes("lost the poker server") && String(rec.note).includes("attempt 0 of 32"), J([rec.ended_at, rec.note]));
    const kinds = (rec.events || []).map((e: any) => e.kind);
    check("  ... a table-disconnected event, then ended", kinds.indexOf("table-disconnected") >= 0 && kinds.indexOf("table-disconnected") < kinds.indexOf("ended"), J(kinds));
    const ev = (rec.events || []).find((e: any) => e.kind === "table-disconnected");
    eq("  ... saying what the table showed and what became of the client", [ev?.attempt, ev?.of, ev?.client], [0, 32, "closed (test)"]);
    eq("auto-execute is off and the router stopped", [S.study.auto, S.router.cancel], [false, true]);
    eq("nothing was pressed", out.presses, []);
    await tick(ATTEMPT_4);
    await tick(RECONNECTED);
    eq("later ticks (the attempts, the client's own reconnect) do nothing more", out.closes, 1);
    const blocked = await out.act("fold", "action");
    check("any press after it is refused, saying why", !blocked.ok && blocked.blocked && String(blocked.reason).includes("lost the poker server"), J(blocked));
    check("  ... a sized raise too", !(await out.raiseTo("2.5", true)).ok);
    check("  ... and at the last check every click site makes (sit back in, sit out)", String(await pointIsMyTable("ws://client", 1, 1)).includes("lost the poker server"));
    eq("  ... and nothing reached the table", out.presses, []);
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("the client reconnected before we saw the overlay: still a disconnect — ended, not played on", async () => {
  const { fails, check } = checker();
  const { out, tick, undo } = rig(null);
  try {
    await tick(RECONNECTED);
    check("the 'Connected' dialog alone ends the session", out.closes === 1 && S.session.id === null, J([out.closes, S.session.id]));
    check("  ... saying the client had reconnected by itself", String(S.sessions.get(out.sid).note).includes("reconnected by itself"));
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("a table that is not the leader closes the client and tells the leader — and ends it itself if the leader is gone", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  let r = rig(2);
  try {
    await r.tick(ATTEMPT_0);
    eq("table 2: the client is closed at once (not waiting on the leader)", r.out.closes, 1);
    eq("  ... and the leader is told which table and what it showed", [r.out.told.length, r.out.told[0]?.sid, r.out.told[0]?.slot, r.out.told[0]?.attempt],
       [1, r.out.sid, 2, 0]);
    eq("  ... the leader ends the session, not table 2", S.session.id, r.out.sid);
    check("  ... table 2 presses nothing from here on", !!pressBlocked() && !pickReady().ok, J(pickReady()));
  } finally {
    r.undo();
  }
  r = rig(2, async () => ({ ok: false, error: "connection refused" }));
  try {
    await r.tick(ATTEMPT_0);
    check("the leader not answering: table 2 ends the session itself", S.session.id === null && !!S.sessions.get(r.out.sid).ended_at,
          J([S.session.id, S.sessions.get(r.out.sid).ended_at]));
  } finally {
    r.undo();
  }
  expect(fails).toEqual([]);
});

test("the leader, told by another table, ends the session once", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { out, undo } = rig(1);
  try {
    const [code, res] = await sessionDisconnected({ sid: out.sid, slot: 3, text: "You are currently disconnected from our poker server.", attempt: 2, of: 32 });
    eq("the leader ends it", [code, res.ok, res.ended], [200, true, out.sid]);
    eq("  ... closing the client itself too (idempotent)", out.closes, 1);
    eq("  ... recorded as table 3's", [S.disconnect?.slot, S.disconnect?.via], [3, "table 3 told us"]);
    const [, again] = await sessionDisconnected({ sid: out.sid, slot: 4 });
    eq("a second table telling it later changes nothing", [again.ended, out.closes], [null, 1]);
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});

test("a new session starts clean", async () => {
  const { fails, check } = checker();
  const { out, tick, undo } = rig(2, async () => ({ ok: false, error: "gone" }));
  try {
    await tick(ATTEMPT_0);
    check("the last session ended on a disconnect", S.session.id === null && !!S.disconnect);
    const sid2 = "session_next_test";
    S.sessions.start(sid2, "strategy:test", null, null, { tables: 4 }, { ok: true }, {});
    const [code] = await sessionJoin({ sid: sid2, config: {} });
    check("table 2 joins the next session", code === 200 && S.session.id === sid2, J([code, S.session.id]));
    check("  ... and may press again", S.disconnect === null && pressBlocked() === null);
  } finally {
    undo();
  }
  expect(fails).toEqual([]);
});
