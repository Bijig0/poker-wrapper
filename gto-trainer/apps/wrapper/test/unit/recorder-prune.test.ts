/**
 * THE RECORDINGS COUNT LIMIT (Brady, 2026-10-09: "deletes the recordings for the 6th last session"): every table of
 * a session records its own folder, so the limit keeps whole SESSIONS (session.txt), not folders.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirSize, pruneSessions } from "../../src/ignition/recorder";
import { scratchDirs } from "./helpers";

const HOUR_AGO = (Date.now() - 3600 * 1000) / 1000;

function folder(base: string, name: string, sid: string | null, opts: { note?: boolean; fresh?: boolean } = {}) {
  const p = join(base, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "log.jsonl"), "{}\n");
  if (sid) writeFileSync(join(p, "session.txt"), sid);
  if (opts.note) writeFileSync(join(p, "note.txt"), "keep");
  if (!opts.fresh) utimesSync(p, HOUR_AGO, HOUR_AGO);
}

const left = (base: string) => readdirSync(base).sort();

test("keeps the last N sessions with every table's folder, counting the session about to record", () => {
  const base = join(scratchDirs("recorder-prune-"), "debug");
  // six past sessions; s2 and s5 were 2-table sessions (a second folder a few seconds later)
  for (let i = 1; i <= 6; i++) {
    const sid = `session_2026100${i}_100000`;
    folder(base, sid, sid);
    if (i === 2 || i === 5) folder(base, `session_2026100${i}_100003`, sid);
  }
  const sess = left(base);
  const removed = pruneSessions(base, sess, 5, "session_20261007_100000");
  // keep = the new session + the 4 newest past ones (s3..s6) → s1 and BOTH of s2's folders go
  expect(removed.sort()).toEqual(["session_20261001_100000", "session_20261002_100000", "session_20261002_100003"]);
  expect(left(base)).toContain("session_20261005_100003");
});

test("a folder with a note, or one being written to, is never removed; old folders without session.txt count alone", () => {
  const base = join(scratchDirs("recorder-prune-"), "debug");
  folder(base, "session_20260101_000000", null, { note: true });
  folder(base, "session_20260102_000000", null, { fresh: true });
  folder(base, "session_20260103_000000", null);
  folder(base, "session_20260104_000000", "session_20260104_000000");
  const removed = pruneSessions(base, left(base), 1, "session_20260105_000000");
  expect(removed).toEqual(["session_20260103_000000", "session_20260104_000000"]);
  expect(existsSync(join(base, "session_20260101_000000"))).toBe(true);
  expect(existsSync(join(base, "session_20260102_000000"))).toBe(true);
});

test("0 turns the count limit off", () => {
  const base = join(scratchDirs("recorder-prune-"), "debug");
  for (let i = 1; i <= 3; i++) folder(base, `session_2026100${i}_000000`, null);
  expect(pruneSessions(base, left(base), 0, null)).toEqual([]);
  expect(left(base).length).toBe(3);
});

test("a folder removed under the scan sizes as 0, never a throw (2026-10-14: the other table's prune killed the router)", () => {
  const base = join(scratchDirs("recorder-prune-"), "debug");
  folder(base, "session_20261010_044206", null);
  expect(dirSize(join(base, "session_20261010_044206"))).toBeGreaterThan(0);
  expect(dirSize(join(base, "session_20261010_044207"))).toBe(0);   // gone: the other wrapper's rmSync won
});
