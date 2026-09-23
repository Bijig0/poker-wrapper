/**
 * Port of tests/test_session_tables.py — a multi-table sitting must not split into two sessions (session
 * 20260920_130435): a table leaves the session it was NAMED; a follower notices its session was ended behind its
 * back (and the leader never orphans itself); a follower whose JOIN never arrived takes the session up itself —
 * only one that declared enough tables — and keeps trying without hammering the store.
 */
import { expect, test } from "bun:test";
import { realTime } from "../../src/clock";
import { S, resetState } from "../../src/state";
import { maybeSessionAdopt, maybeSessionOrphaned, sessionLeave, sessionSeams } from "../../src/session";
import { checker, J, scratchDirs } from "./helpers";

test("a multi-table sitting must not split into two sessions", async () => {
  const { fails, check } = checker();
  scratchDirs();
  realTime();
  resetState();
  const EVENTS: [string, string, any][] = [];
  const ENDED = new Set<string>();
  let OPEN: any[] = [];
  class Store {
    get(sid: string): any {
      for (const r of OPEN) if (r.id === sid) return { ...r, ended_at: ENDED.has(sid) ? 1 : null };
      if (sid !== "live-session" && sid !== "dead-session") return null;
      return { id: sid, ended_at: ENDED.has(sid) ? 1 : null };
    }
    event(sid: string, kind: string, data: any = null) { EVENTS.push([sid, kind, data]); }
    openSessions() { return OPEN.filter((r) => !ENDED.has(r.id)); }
  }
  const seams0 = { ...sessionSeams };
  const slot0 = process.env.TABLE_SLOT;
  const log0 = console.log;
  console.log = () => {};
  const install = (slot: number | null) => {
    S.sessions = new Store() as any;
    sessionSeams.hands = () => 7;
    if (slot === null) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = String(slot);
    Object.assign(S.orphanCheck, { at: 0.0, said: null });
  };
  try {
    // 1. a table leaves the session it was NAMED
    install(2);
    Object.assign(S.session, { id: "live-session", rec: {}, started: 0.0 });
    let [code, body] = sessionLeave({ sid: "some-other-session" });
    check("asked to leave a session it is not on → stays", S.session.id === "live-session", String(S.session.id));
    check("  ... and says so rather than erroring", code === 200 && body.left === null, J(body));
    [code, body] = sessionLeave({ sid: "live-session" });
    check("asked to leave its OWN session → leaves", S.session.id === null, String(S.session.id));
    check("  ... reporting the id and its hand count", body.left === "live-session" && body.hands === 7, J(body));
    check("  ... and records table-left with the slot", EVENTS.some((e) => e[1] === "table-left" && (e[2] || {}).slot === 2), J(EVENTS));
    EVENTS.length = 0;
    Object.assign(S.session, { id: "live-session", rec: {}, started: 0.0 });
    sessionLeave({});
    check("no sid given → leaves (the old caller shape still works)", S.session.id === null);

    // 2. a follower notices its session was ended behind its back
    install(3);
    ENDED.clear();
    Object.assign(S.session, { id: "live-session", rec: {}, started: 0.0 });
    await maybeSessionOrphaned();
    check("session still open → carries on", S.session.id === "live-session");
    ENDED.add("live-session");
    S.orphanCheck.at = 0.0;
    await maybeSessionOrphaned();
    check("session ended elsewhere → stands itself down", S.session.id === null, String(S.session.id));

    // 3. the leader never orphans itself
    install(null);
    ENDED.add("live-session");
    Object.assign(S.session, { id: "live-session", rec: {}, started: 0.0 });
    await maybeSessionOrphaned();
    check("single-table wrapper ignores the check", S.session.id === "live-session");
    install(1);
    Object.assign(S.session, { id: "live-session", rec: {}, started: 0.0 });
    await maybeSessionOrphaned();
    check("leader of four ignores it too — the record is its own", S.session.id === "live-session");

    // 4. the poll does not hammer the store
    install(2);
    let reads = 0;
    class Counting extends Store {
      override get(sid: string) {
        reads++;
        return super.get(sid);
      }
    }
    S.sessions = new Counting() as any;
    Object.assign(S.session, { id: "live-session", rec: {}, started: 0.0 });
    ENDED.clear();
    for (let i = 0; i < 50; i++) await maybeSessionOrphaned();
    check("fifty ticks → one read, not fifty", reads === 1, `${reads} reads`);

    // 5. a follower whose invitation never arrived joins the session itself
    const JOINS: any[] = [];
    const join = async (b: any): Promise<[number, any]> => {
      JOINS.push(b);
      if (b.fail) return [409, { ok: false, error: "no" }];
      Object.assign(S.session, { id: b.sid, rec: {}, started: 0.0 });
      return [200, { ok: true }];
    };
    sessionSeams.join = join;
    const fresh = (slot: number | null, sessions: any[]) => {
      install(slot);
      S.sessions = new Store() as any;
      Object.assign(S.session, { id: null, rec: null, started: 0.0 });
      Object.assign(S.adoptCheck, { at: 0.0, said: null });
      JOINS.length = 0;
      EVENTS.length = 0;
      ENDED.clear();
      OPEN = sessions;
    };
    const TWO = { id: "s-two", config: { tables: 2, answers: true, format: "ign-ring-NL200-6" } };
    const ONE = { id: "s-one", config: { tables: 1, answers: true } };
    fresh(2, [TWO]);
    await maybeSessionAdopt();
    check("a session that declared 2 tables → slot 2 joins it", J(JOINS.map((j) => j.sid)) === J(["s-two"]), J(JOINS));
    check("  ... carrying the session's own config, not a guess", (JOINS[0]?.config || {}).format === "ign-ring-NL200-6", J(JOINS));
    check("  ... and it is on that session now", S.session.id === "s-two");
    fresh(2, [ONE]);
    await maybeSessionAdopt();
    check("a SINGLE-table session is not ours to join", !JOINS.length, J(JOINS));
    fresh(3, [TWO]);
    await maybeSessionAdopt();
    check("a two-table session is not table 3's either", !JOINS.length, J(JOINS));
    fresh(4, [ONE, TWO]);
    await maybeSessionAdopt();
    check("  ... and it looks past the ones that are not, without taking them", !JOINS.length, J(JOINS));
    fresh(1, [TWO]);
    await maybeSessionAdopt();
    check("the LEADER never adopts — it owns the record", !JOINS.length, J(JOINS));
    fresh(null, [TWO]);
    await maybeSessionAdopt();
    check("nor does a single-table wrapper", !JOINS.length, J(JOINS));

    // 6. ... and it keeps trying, without saying so every time
    fresh(2, [TWO]);
    OPEN = [{ ...TWO, config: { ...TWO.config }, fail: true }];
    sessionSeams.join = async (b: any) => {
      JOINS.push(b);
      return [409, { ok: false, error: "the leader had not written it yet" }];
    };
    for (let i = 0; i < 5; i++) {
      S.adoptCheck.at = 0.0;
      await maybeSessionAdopt();
    }
    check("five polls, five attempts — a transient refusal is not the end of it", JOINS.length === 5, `${JOINS.length} attempts`);
    sessionSeams.join = join;
    S.adoptCheck.at = 0.0;
    await maybeSessionAdopt();
    check("  ... and the moment it can join, it does", S.session.id === "s-two");

    // 7. the pull does not hammer the store either
    fresh(2, [TWO]);
    let reads2 = 0;
    class CountingOpen extends Store {
      override openSessions() {
        reads2++;
        return super.openSessions();
      }
    }
    S.sessions = new CountingOpen() as any;
    sessionSeams.join = async () => [409, { ok: false, error: "busy" }];
    for (let i = 0; i < 50; i++) await maybeSessionAdopt();
    check("fifty ticks → one read, not fifty", reads2 === 1, `${reads2} reads`);
  } finally {
    Object.assign(sessionSeams, seams0);
    if (slot0 === undefined) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = slot0;
    Object.assign(S.session, { id: null, rec: null, started: 0.0 });
    console.log = log0;
    resetState();
  }
  expect(fails).toEqual([]);
});
