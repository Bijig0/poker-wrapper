/**
 * THE TABLE'S GAME SOCKET CLOSING IS A FAILURE (Brady, 2026-09-26: "table open -> connect socket. If it disconnects
 * for any reason, end the session. This keeps everything deterministic. A socket end is a failure state").
 * ignition/reader.ts noteSocketClosed, fed by the tap's Network.webSocketClosed: our bound socket closing ends the
 * session through the disconnect path (nothing pressed, auto off, client closed); another table's socket closing is
 * not ours; a close right after WE left the table (session.ts markLeaving) only releases the bind.
 * The one exception — the site closing our EMPTY table (2026-10-01) — is test/unit/site-close-reseat.test.ts; here the
 * socket closes on a table never read in full, which is the failure it always was.
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime } from "../../src/clock";
import { S, pressBlocked, resetState } from "../../src/state";
import { LEAVE_GRACE_S, noteSocketClosed } from "../../src/ignition/reader";
import { markLeaving } from "../../src/session";

function bound(rid = "34976.2278") {
  resetState();
  S.session.id = "session_test";
  S.tapBound = rid;
  S.study.auto = true;
}

test("our table's socket closing ends the session: nothing more is pressed", () => {
  try {
    setFakeTime(1000);
    bound();
    noteSocketClosed("34976.2278");
    expect(S.disconnect).toMatchObject({ text: "the table's game socket closed", sid: "session_test", handled: false });
    expect(S.study.auto).toBe(false);
    expect(S.tapBound).toBeNull();
    expect(pressBlocked()).not.toBeNull();
  } finally {
    realTime();
  }
});

test("another table's socket closing is not ours", () => {
  bound();
  noteSocketClosed("34976.2789");
  expect(S.disconnect).toBeNull();
  expect(S.tapBound).toBe("34976.2278");
});

test("a close right after we left the table releases the bind — no failure; later it is one again", () => {
  try {
    setFakeTime(1000);
    bound();
    markLeaving();
    setFakeTime(1000 + LEAVE_GRACE_S - 1);
    noteSocketClosed("34976.2278");
    expect(S.disconnect).toBeNull();
    expect(S.tapBound).toBeNull();
    // the next table binds; its socket closing long after the leave is a failure
    S.tapBound = "34976.9999";
    setFakeTime(1000 + LEAVE_GRACE_S + 60);
    noteSocketClosed("34976.9999");
    expect(S.disconnect?.text).toBe("the table's game socket closed");
  } finally {
    realTime();
  }
});

test("no session: a socket closing ends nothing", () => {
  bound();
  S.session.id = null;
  noteSocketClosed("34976.2278");
  expect(S.disconnect).toBeNull();
});
