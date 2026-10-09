/**
  * THE PRESENCE KEEPER (keepPresent.ts): while a session is live the leader wrapper injects one zero-movement mouse event
 * every PRESENCE_EVERY_S so Windows never calls the machine idle (Automatic Maintenance starved the disk and ended the
 * 2026-10-09 10:38 session). Off outside a session, in fake mode, on followers, and when the option is off; a nudge
 * that keeps throwing stops the keeper for the session with a presence-keeper event.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { PRESENCE_EVERY_S, PRESENCE_MAX_FAILS, maybeKeepPresent, presenceSeams } from "../../src/keepPresent";
import { SessionStore } from "../../src/sessions";
import { S, resetState } from "../../src/state";
import { scratchDirs } from "./helpers";

function rig(opts: { keepPresent?: boolean; leader?: boolean; fake?: boolean; session?: boolean } = {}) {
  const tmp = scratchDirs("presence-");
  delete process.env.TABLE_SLOT;
  delete process.env.TABLE_COUNT;
  reloadConfig();
  resetState();
  setFakeTime(1_791_500_000);
  S.site.id = "ignition";
  S.fakeMode = !!opts.fake;
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  if (opts.session !== false) {
    const sid = "session_20261009_presence_test";
    const rec = S.sessions.start(sid, "strategy:test", null, null, { tables: 1, answers: true }, { ok: true }, {});
    Object.assign(S.session, { id: sid, rec, started: time() });
  }
  S.study.keepPresent = opts.keepPresent ?? true;
  S.study.presenceAt = 0.0;
  S.study.presenceCount = 0;
  S.study.presenceFails = 0;
  const nudges: number[] = [];
  presenceSeams.nudge = async () => { nudges.push(time()); };
  presenceSeams.isLeader = () => opts.leader ?? true;
  return { nudges, events: () => S.sessions.get(S.session.id!)?.events ?? [] };
}

function done() {
  realTime();
}

test("the leader nudges once at the first tick, then every PRESENCE_EVERY_S, never faster", async () => {
  const r = rig();
  try {
    await maybeKeepPresent();
    expect(r.nudges.length).toBe(1);
    for (let i = 0; i < 10; i++) {
      setFakeTime(time() + 4);
      await maybeKeepPresent();
    }
    expect(r.nudges.length).toBe(1);                 // 40 s later: still one
    setFakeTime(time() + PRESENCE_EVERY_S);
    await maybeKeepPresent();
    expect(r.nudges.length).toBe(2);
    expect(S.study.presenceCount).toBe(2);
    const ev = r.events().filter((e: any) => e.kind === "presence-keeper");
    expect(ev.length).toBe(1);                       // the first nudge is the one event
    expect(ev[0].ok).toBe(true);
    expect(ev[0].everyS).toBe(PRESENCE_EVERY_S);
  } finally {
    done();
  }
});

test("nothing is sent outside a session, in fake mode, on a follower, or with the option off", async () => {
  for (const opts of [{ session: false }, { fake: true }, { leader: false }, { keepPresent: false }]) {
    const r = rig(opts);
    try {
      for (let i = 0; i < 3; i++) {
        await maybeKeepPresent();
        setFakeTime(time() + PRESENCE_EVERY_S + 1);
      }
      expect(r.nudges.length).toBe(0);
      expect(S.study.presenceCount).toBe(0);
    } finally {
      done();
    }
  }
});

test("the session ending stops the nudges", async () => {
  const r = rig();
  try {
    await maybeKeepPresent();
    expect(r.nudges.length).toBe(1);
    S.session.id = null;
    setFakeTime(time() + PRESENCE_EVERY_S + 1);
    await maybeKeepPresent();
    expect(r.nudges.length).toBe(1);
  } finally {
    done();
  }
});

test("a nudge that keeps throwing stops the keeper for the session, with an event that says so", async () => {
  const r = rig();
  try {
    let calls = 0;
    presenceSeams.nudge = async () => { calls += 1; throw new Error("user32 unavailable"); };
    for (let i = 0; i < PRESENCE_MAX_FAILS + 3; i++) {
      await maybeKeepPresent();
      setFakeTime(time() + PRESENCE_EVERY_S + 1);
    }
    expect(calls).toBe(PRESENCE_MAX_FAILS);
    expect(S.study.presenceFails).toBe(PRESENCE_MAX_FAILS);
    expect(S.study.presenceCount).toBe(0);
    const ev = r.events().filter((e: any) => e.kind === "presence-keeper");
    expect(ev.length).toBe(1);
    expect(ev[0].ok).toBe(false);
    expect(ev[0].gaveUp).toBe(true);
    expect(String(ev[0].reason)).toContain("user32");
    expect(r.nudges.length).toBe(0);
  } finally {
    done();
  }
});
