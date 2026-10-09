/**
 * Remove the test temp directories left in the OS temp dir (answer-rows-*, answers-test-*: TEST_TEMP_PREFIXES in
 * src/test/tempDir.ts). Tests remove their own since 2026-10-09; this is for what older runs and killed processes
 * left behind — 12,692 Temp entries older than two days on 2026-10-09, thousands of them these.
 *
 *   bun src/scripts/sweepTestTemp.ts            # entries older than 1 hour (a running test is never that old)
 *   bun src/scripts/sweepTestTemp.ts --age 0    # everything, minutes
 *   bun src/scripts/sweepTestTemp.ts --dry      # list only
 *
 * Offline; touches nothing but directories whose names carry one of the prefixes.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_TEMP_PREFIXES } from "../test/tempDir";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const ageIdx = argv.indexOf("--age");
const ageMin = ageIdx >= 0 ? Number(argv[ageIdx + 1]) : 60;
if (!Number.isFinite(ageMin) || ageMin < 0) {
  console.error("--age takes minutes (>= 0)");
  process.exit(2);
}

const root = tmpdir();
const cutoff = Date.now() - ageMin * 60_000;
let seen = 0, removed = 0, skippedYoung = 0, failed = 0;
for (const name of readdirSync(root)) {
  if (!TEST_TEMP_PREFIXES.some((p) => name.startsWith(p))) continue;
  const path = join(root, name);
  let st;
  try { st = statSync(path); } catch { continue; }
  if (!st.isDirectory()) continue;
  seen++;
  if (st.mtimeMs > cutoff) { skippedYoung++; continue; }
  if (dry) { console.log(`would remove ${path}`); removed++; continue; }
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    removed++;
  } catch (e) {
    failed++;
    console.warn(`could not remove ${path}: ${String(e)}`);
  }
}
console.log(
  `${root}: ${seen} test temp dir(s) (${TEST_TEMP_PREFIXES.join(", ")}); ` +
  `${dry ? "would remove" : "removed"} ${removed}, left ${skippedYoung} younger than ${ageMin} min, ${failed} failed`
);
process.exit(failed ? 1 : 0);
