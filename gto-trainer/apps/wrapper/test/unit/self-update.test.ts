/**
 * THE WRAPPER RELAUNCHES ITSELF (2026-10-13, src/build.ts). For ten days "WRAPPER RELAUNCH OWED" was the most common
 * line in the owner's notes — a wrapper left open between sessions ran old code while fixes were merged. These pin
 * WHO relaunches itself and WHEN it holds: never the test rig or an extra table, never during a session, never under
 * a click, at most once per RELAUNCH_GAP_MS.
 */
import { expect, test } from "bun:test";
import { RELAUNCH_GAP_MS, USER_QUIET_MS, selfUpdateHold, selfUpdates } from "../../src/build";

const NOW = 1_800_000_000_000;
const idle = { sessionId: null, now: NOW, lastUserActionAt: 0, lastRelaunchAt: 0 };

test("only the first table of a real install relaunches itself, unless WRAPPER_SELF_UPDATE=off", () => {
  expect(selfUpdates({ fake: false, slot: null, launcherExists: true, env: {} })).toBe(true);
  expect(selfUpdates({ fake: true, slot: null, launcherExists: true, env: {} })).toBe(false);          // the rig
  expect(selfUpdates({ fake: false, slot: 2, launcherExists: true, env: {} })).toBe(false);            // an extra table
  expect(selfUpdates({ fake: false, slot: null, launcherExists: false, env: {} })).toBe(false);        // a sandbox
  expect(selfUpdates({ fake: false, slot: null, launcherExists: true, env: { WRAPPER_SELF_UPDATE: "off" } })).toBe(false);
});

test("free to go when idle; held by a session, a recent click, or a recent self-relaunch", () => {
  expect(selfUpdateHold(idle)).toBeNull();
  expect(selfUpdateHold({ ...idle, sessionId: "session_20261013_101500" })).toContain("a session is running (session_20261013_101500)");
  expect(selfUpdateHold({ ...idle, lastUserActionAt: NOW - 30_000 })).toBe("its pages were used 30 s ago");
  expect(selfUpdateHold({ ...idle, lastUserActionAt: NOW - USER_QUIET_MS - 1 })).toBeNull();
  expect(selfUpdateHold({ ...idle, lastRelaunchAt: NOW - 60_000 })).toContain("relaunched itself 60 s ago");
  expect(selfUpdateHold({ ...idle, lastRelaunchAt: NOW - RELAUNCH_GAP_MS - 1 })).toBeNull();
});
