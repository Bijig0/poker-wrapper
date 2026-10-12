import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

/**
 * DATA FILES ARE FOLLOWED, NOT READ ONCE (2026-10-13). The factory re-exports its outputs into files the API and the
 * chart server already read (resolved-charts.json, the MES turn files, the 6-max bake, the chart bodies,
 * preflop-db.sqlite). A module that read one at start, or cached it by name, kept answering from the old copy until a
 * restart — and a file missing at start stayed "missing" for the life of the process. These are the two pieces the
 * readers share: a stamp that says whether a file changed, and a read-only SQLite handle that follows its file.
 *
 * mtime ALONE IS NOT ENOUGH on Windows: two writes inside one clock tick carry the same mtime (measured 2026-10-13: a
 * file written and another renamed over it read the same mtimeMs to the 1/10000 ms). Size and the file id (ino: a
 * replace-by-rename is a new file) go with it.
 */
export interface FileStamp { size: number; mtimeMs: number; ino: number }

/** The file's stamp now, or null when it is not there (or cannot be stat'ed). */
export function fileStamp(path: string): FileStamp | null {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return null;
  }
}

/** Same file, same content as far as a stat can tell (both missing counts as the same). */
export function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (!a || !b) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * A read-only SQLite handle that follows its file.
 *
 *   - the file missing: `get()` is null, and the next call looks again (an existsSync-cheap stat) — as before;
 *   - the file open: stat'ed at most every `checkMs`; when its stamp changed, the NEW file is opened first and only
 *     then is the old handle closed (a new file that will not open yet keeps the old handle serving; the next check
 *     tries again). A first open that throws still throws to the caller, as `new Database` did.
 *
 * ON WINDOWS an open SQLite file cannot be replaced or deleted (rename-over = EPERM, unlink = EBUSY, measured
 * 2026-10-13), and in-place writes are already visible to the open handle — so there the reopen is cheap and changes
 * little. It matters where a replace succeeds while the handle holds the old file (POSIX), and it re-reads a schema an
 * in-place rebuild changed. Statements must be prepared per call (`db.query` caches per handle), never kept across get().
 */
export class FollowedSqlite {
  private db: Database | null = null;
  private stamp: FileStamp | null = null;
  private checkedAt = 0;

  constructor(private readonly path: () => string, private checkMs = 30_000, private readonly log?: (m: string) => void) {}

  get(): Database | null {
    const path = this.path();
    const now = Date.now();
    if (this.db && now - this.checkedAt < this.checkMs) return this.db;
    this.checkedAt = now;
    const stamp = fileStamp(path);
    if (this.db && (stamp === null || sameStamp(stamp, this.stamp))) return this.db;   // unchanged, or gone (keep it)
    if (!stamp) return null;
    let next: Database | null = null;
    try {
      next = new Database(path, { readonly: true });
      if (this.db) next.query("SELECT count(*) AS n FROM sqlite_master").get();   // a replacement must read before it replaces
    } catch (e) {
      if (!this.db) throw e;
      try { next?.close(); } catch { /* never opened */ }
      this.log?.(`[sqlite] ${path} changed but would not open (${e instanceof Error ? e.message : String(e)}) - the open handle keeps serving`);
      return this.db;
    }
    if (this.db) {
      try { this.db.close(); } catch { /* already gone */ }
      // a crawler writing in place changes the stamp every few seconds: say so only when it is another file
      if (stamp.ino !== this.stamp?.ino) this.log?.(`[sqlite] ${path} was replaced - reopened`);
    }
    this.db = next;
    this.stamp = stamp;
    return next;
  }

  /** Release the handle (tests: Windows will not delete an open file). */
  close(): void {
    try { this.db?.close(); } catch { /* already gone */ }
    this.db = null;
    this.stamp = null;
    this.checkedAt = 0;
  }

  /** Test hook: how often an open file is stat'ed. */
  setCheckMs(ms: number): void { this.checkMs = ms; }
}
