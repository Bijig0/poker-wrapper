// SHARED WITH THE CHART FACTORY (setup/shared-with-factory.json): edit it in poker-wrapper only — the factory takes it with `bun scripts/sync_from_wrapper.ts`.
/**
 * Temp directories for tests — removed when the file's tests are done.
 *
 * mkdtempSync under %TEMP% with no teardown left thousands of answer-rows-* / answers-test-* directories behind
 * (12,692 Temp entries older than two days on 2026-10-09, 5,816 still there after a clean; every bun test, replay
 * gate and regress run added four). bun test fires neither process "exit" nor "beforeExit", and the one afterAll
 * that tried rmSync failed quietly on Windows because the sqlite handle was still open. So every test temp dir comes
 * from here: the file's afterAll runs the caller's `release` (close the handles that live in the dir), then removes
 * the dir. KEEP_TEST_TMP=1 keeps them for a look. Leftovers from older runs or killed processes:
 * `bun src/scripts/sweepTestTemp.ts` (see TEST_TEMP_PREFIXES — add a new prefix there when you add a caller).
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every prefix a test asks for; the sweep script removes these (and only these) from the OS temp dir. */
export const TEST_TEMP_PREFIXES = ["answer-rows-", "answers-test-", "gtow-cache-counters-", "answer-view-", "gtow-ledger-view-", "hands-view-", "supervisor-restart-", "runtime-health-", "data-reread-", "page-token-"] as const;
export type TestTempPrefix = (typeof TEST_TEMP_PREFIXES)[number];

/**
 * A fresh directory under the OS temp dir, removed in this test file's afterAll. `release` runs first: close every
 * sqlite / file handle that points into the dir, or Windows refuses the removal.
 */
export function testTempDir(prefix: TestTempPrefix, opts: { release?: () => void } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => {
    try { opts.release?.(); } catch (e) { console.warn(`[test-temp] release for ${dir} threw: ${String(e)}`); }
    removeTestTempDir(dir);
  });
  return dir;
}

/** Remove a test temp dir (kept under KEEP_TEST_TMP=1). Returns whether it is gone. */
export function removeTestTempDir(dir: string): boolean {
  if (process.env.KEEP_TEST_TMP) {
    console.warn(`[test-temp] kept ${dir} (KEEP_TEST_TMP)`);
    return false;
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return true;
  } catch (e) {
    console.warn(`[test-temp] could not remove ${dir}: ${String(e)} — bun src/scripts/sweepTestTemp.ts later`);
    return false;
  }
}
