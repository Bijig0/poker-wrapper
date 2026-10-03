/**
 * THE RAW FRAMES ARE KEPT FOR GOOD (2026-10-04, ignition/ws.ts keepDump). A full ws_dump.jsonl used to be renamed over
 * ws_dump.jsonl.1, deleting the file before it — the only record of when each frame arrived. Every file put away must
 * still be on disk afterwards, byte for byte, and the dump's own two names must stay where the backtests read them.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WS_KEEP_DIR, keepDump } from "../../src/ignition/ws";
import { scratchDirs } from "./helpers";

test("a full dump is put away, and the one before it is kept instead of overwritten", () => {
  const dir = join(scratchDirs("ws-dump-keep-"), "debug");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "ws_dump-2.jsonl");
  const keep = join(dir, WS_KEEP_DIR);

  // first time: nothing before it — the full file becomes .1, nothing to keep yet
  writeFileSync(p, "first\n");
  keepDump(p);
  expect(existsSync(p)).toBe(false);
  expect(readFileSync(p + ".1", "utf8")).toBe("first\n");
  expect(existsSync(keep)).toBe(false);

  // second and third time (within the same second): the earlier files move to ws-archive, none is lost
  writeFileSync(p, "second\n");
  keepDump(p);
  writeFileSync(p, "third\n");
  keepDump(p);
  expect(readFileSync(p + ".1", "utf8")).toBe("third\n");
  const kept = readdirSync(keep).sort();
  expect(kept.length).toBe(2);
  expect(kept.every((f) => /^ws_dump-2_\d{8}_\d{6}(_\d+)?\.jsonl$/.test(f))).toBe(true);
  expect(kept.map((f) => readFileSync(join(keep, f), "utf8")).sort()).toEqual(["first\n", "second\n"]);
});
