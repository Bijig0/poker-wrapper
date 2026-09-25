/**
 * Sit back in (session setup `autoSitBackIn`): when the table sits hero out, press I AM BACK — after the sit-out
 * has held for SIT_BACK_AFTER_S, at most SIT_BACK_TRIES presses SIT_BACK_RETRY_S apart, never while the connection
 * guard has hero out, never outside a session or with the setting off.
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime } from "../../src/clock";
import { S, resetState } from "../../src/state";
import { SIT_BACK_AFTER_S, SIT_BACK_RETRY_S, SIT_BACK_TRIES, maybeSitBackIn, sitBackSeams } from "../../src/sitback";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_790_000_000;

test("sit back in: when it presses I AM BACK, and when it leaves hero out", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  const log0 = console.log;
  console.log = () => {};
  const press0 = sitBackSeams.press;
  let pressOk = true;
  let presses = 0;
  sitBackSeams.press = async () => { presses += 1; return pressOk ? { ok: true, clicked: true } : { ok: false, why: "no I AM BACK button on the table" }; };
  const events: [string, any][] = [];
  const tickAt = async (t: number) => { setFakeTime(T0 + t); await maybeSitBackIn(); };
  const seed = (o: { on?: boolean; session?: boolean; hero?: string } = {}) => {
    const { on = true, session = true, hero = "sitting-out" } = o;
    S.fakeMode = false;
    S.session.id = session ? "session_test" : null;
    S.sessions = { event: (_sid: string, kind: string, data: any = null) => events.push([kind, data || {}]) } as any;
    Object.assign(S.study, { sitBackIn: on, sitBackTurn: null, lastSitBackIn: null });
    Object.assign(S.liveStatus, { hero, modal: null, buyPanel: null });
    Object.assign(S.net, { bad: 0, good: 0, sitout: null });
    presses = 0;
    events.length = 0;
  };
  try {
    seed({ on: false });
    await tickAt(0); await tickAt(30);
    check("setting off → never presses", presses === 0, J(presses));

    seed({ session: false });
    await tickAt(0); await tickAt(30);
    check("no session → never presses", presses === 0, J(presses));

    seed({ hero: "in-hand" });
    await tickAt(0); await tickAt(30);
    check("not sitting out → never presses", presses === 0, J(presses));

    seed();
    await tickAt(0);
    await tickAt(SIT_BACK_AFTER_S - 0.5);
    check("a sit-out shorter than the debounce → waits", presses === 0, J(presses));
    await tickAt(SIT_BACK_AFTER_S + 0.1);
    check("sat out past the debounce → presses I AM BACK", presses === 1, J(presses));
    check("logged as a sit-back-in event", events.length === 1 && events[0]![0] === "sit-back-in" && events[0]![1].ok === true, J(events));
    await tickAt(SIT_BACK_AFTER_S + 1);
    check("not again inside the retry gap", presses === 1, J(presses));
    S.liveStatus.hero = "in-hand";
    await tickAt(SIT_BACK_AFTER_S + 2);
    check("back in → the sit-out is closed", S.study.sitBackTurn === null, J(S.study.sitBackTurn));

    seed();
    pressOk = false;
    let t = 0;
    await tickAt(t);
    for (let i = 0; i < SIT_BACK_TRIES + 3; i++) { t += SIT_BACK_RETRY_S + 0.1; await tickAt(t); }
    check("a press that never takes is tried SIT_BACK_TRIES times", presses === SIT_BACK_TRIES, J(presses));
    check("then it gives up and says so, once", events.filter(([, d]) => d.gaveUp).length === 1, J(events));
    pressOk = true;

    seed();
    S.net.sitout = { ok: true, clicked: true };
    await tickAt(0); await tickAt(30);
    check("the connection guard sat hero out → leaves hero out", presses === 0, J(presses));

    seed();
    S.net.bad = 1;
    await tickAt(0); await tickAt(30);
    check("a bad probe in this stretch → leaves hero out", presses === 0, J(presses));

    seed();
    S.liveStatus.modal = { text: "notice" };
    await tickAt(0); await tickAt(30);
    check("a client notice on the table → holds", presses === 0, J(presses));
  } finally {
    sitBackSeams.press = press0;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});
