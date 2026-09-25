/**
 * THE PRESS LOCK IS OWNED (2026-09-25 audit): table A's slow press lost its lock to B as "stale", then A's release()
 * deleted B's lock and C pressed while B was mid-click. A release now removes only its own token's lock, and a live
 * holder is never broken inside a whole press chain.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { time } from "../../src/clock";
import { scratchDirs } from "./helpers";

scratchDirs("wrapper-lock-");
// bun test runs every file in ONE process: a slot left set here makes every later file a multi-table run
const slot0 = process.env.TABLE_SLOT;
process.env.TABLE_SLOT = "2";
afterAll(() => { if (slot0 === undefined) delete process.env.TABLE_SLOT; else process.env.TABLE_SLOT = slot0; });
const tables = await import("../../src/tables");
const lockFile = () => join(process.env.WRAPPER_DATA_DIR!, "tables", "press.lock");

test("a release removes only its OWN lock — never the one another table took after it", async () => {
  const a = await tables.pressLock();
  expect(existsSync(lockFile())).toBe(true);
  // A outlived the TTL and table B replaced its lock
  writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, at: time(), token: "table-B" }));
  a.release();
  expect(JSON.parse(readFileSync(lockFile(), "utf8")).token).toBe("table-B");   // B's lock survives A's release
});

test("a LIVE holder inside a press chain is waited on, not broken as stale", async () => {
  writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, at: time() - 6, token: "busy" }));   // 6 s in: the old 5 s TTL broke it
  const lk = await tables.pressLock(0.2);
  expect(lk.forced).toBe(true);                                                    // waited, then pressed (and logged)
  expect(JSON.parse(readFileSync(lockFile(), "utf8")).token).toBe("busy");
  lk.release();
  expect(JSON.parse(readFileSync(lockFile(), "utf8")).token).toBe("busy");        // a forced press holds nothing to release
});

test("a holder whose process is gone is broken at once", async () => {
  writeFileSync(lockFile(), JSON.stringify({ pid: 999_999_1, at: time(), token: "dead" }));
  const lk = await tables.pressLock(1.0);
  expect(lk.forced).toBe(false);
  expect(lk.waited).toBeLessThan(0.5);
  lk.release();
  expect(existsSync(lockFile())).toBe(false);
});
