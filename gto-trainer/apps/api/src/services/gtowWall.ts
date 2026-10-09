import type { GtowWallState } from "./gtowRequestLog";

/** How far back the wall reading looks (gtowRequestLog.wallState; services/gtowLedgerView keeps this much in memory). */
export const WALL_SCAN_MS = 3 * 86_400_000;
/** …and at most this many of an account's wall-relevant rows, newest first. */
export const WALL_SCAN_ROWS = 5_000;

/**
 * THE WALL, READ FROM AN ACCOUNT'S ROWS (pure; 2026-10-09 split out of wallState so the accounts page can read it from
 * memory, services/gtowLedgerView.ts). `rows`: the account's 429 and 2xx requests of the last WALL_SCAN_MS, NEWEST FIRST
 * (ts desc, id desc), at most WALL_SCAN_ROWS.
 */
export function wallFromRows(rows: { ts: number; st: number }[], wallMs = 24 * 3_600_000): GtowWallState {
  const none: GtowWallState = { walled: false, sinceMs: null, expectedLiftMs: null, last429Ms: null, lastOkMs: null, clearedAtMs: null, leaks: 0 };
  if (!rows.length) return none;
  const last429 = rows.find((r) => r.st === 429)?.ts ?? null;
  const lastOk = rows.find((r) => r.st !== 429)?.ts ?? null;
  if (!last429) return { ...none, lastOkMs: lastOk };
  // A wall is a RUN of 429s. One success inside it is a leak, not a lift (Elite, 2026-09-27 09:40 local: a single
  // 200 fourteen hours in, then 429s for hours more) — the run ends only at two successes in a row.
  let i = 0, okRun = 0, leaks = 0, since = last429, clearedAt: number | null = null;
  for (; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.st === 429) { since = r.ts; okRun = 0; continue; }
    okRun++;
    if (okRun >= 2) break;
  }
  const lifted = rows[0]!.st !== 429 && rows.length > 1 && rows[1]!.st !== 429;
  if (lifted) {
    // cleared at the first of the two successes that ended the run; leaks = lone successes inside it
    let j = 0; while (j < rows.length && rows[j]!.st !== 429) j++;
    clearedAt = rows[Math.max(0, j - 1)]!.ts;
    for (let k = j; k < rows.length; k++) { const r = rows[k]!; if (r.st === 429) continue; if (rows[k + 1]?.st === 429 && rows[k - 1]?.st === 429) leaks++; else break; }
    return { walled: false, sinceMs: null, expectedLiftMs: null, last429Ms: last429, lastOkMs: lastOk, clearedAtMs: clearedAt, leaks };
  }
  // a leak is a success with a 429 on both sides (or the newest request) — not the pair that ended the run
  for (let k = 0; k < i; k++) if (rows[k]!.st !== 429 && rows[k + 1]?.st === 429 && (k === 0 || rows[k - 1]!.st === 429)) leaks++;
  // the newest request itself was a lone success: the wall may be lifting — say so, and still count it walled
  return { walled: true, sinceMs: since, expectedLiftMs: since + wallMs, last429Ms: last429, lastOkMs: lastOk, clearedAtMs: null, leaks };
}
