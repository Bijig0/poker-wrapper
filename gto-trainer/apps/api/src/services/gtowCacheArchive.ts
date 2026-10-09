/**
 * THE GTO WIZARD CACHE'S COLD ARCHIVE (Brady, 2026-10-09). The hot cache (gtow-cache.sqlite) is capped at
 * GTOW_CACHE_MAX_MB (500) and keeps GTOW_CACHE_DAYS (14); what its maintenance window evicts or expires is not thrown
 * away — each row is COPIED here first (same tables, same columns, gzipped blobs as they were), then deleted from the hot
 * file. One file per month of eviction: <cache dir>/gtow-cache-archive/<YYYY-MM>.sqlite (GTOW_CACHE_ARCHIVE_DIR moves it,
 * GTOW_CACHE_ARCHIVE=off turns the archiving off — rows are then simply deleted, as before).
 *
 * WRITTEN only in the maintenance window, inside the hot file's own batch transactions (the archive is ATTACHed to the
 * hot connection for the pass: INSERT … SELECT, then DELETE — with WAL each file commits on its own, so the worst a crash
 * between the two leaves is a row in both, never a row in neither). Append-only: INSERT OR IGNORE, nothing is ever
 * updated or deleted here.
 *
 * READ by point lookups only (key + addr, the primary key), on read-only connections opened lazily, newest month first:
 * the hand page's "open the exact node" (gtowAiPreflop.storedPreflopGetter) and offline scripts that opt in with
 * GTOW_CACHE_ARCHIVE_READ=1. The LIVE ANSWER PATH NEVER READS IT: a node the hot cache lacks is solved afresh anyway.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const archiveMonth = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** Where the archive of the cache at `cachePath` lives, or null when archiving is off. */
export function archiveDirFor(cachePath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (/^(off|0|false|no)$/i.test(env.GTOW_CACHE_ARCHIVE?.trim() ?? "")) return null;
  return env.GTOW_CACHE_ARCHIVE_DIR?.trim() || join(dirname(cachePath), "gtow-cache-archive");
}

const ARCH = "gtow_archive";
/** how long the list of month files is trusted before the directory is read again */
const LIST_MS = 60_000;

export class GtowCacheArchive {
  private readers = new Map<string, Database>();
  private files: string[] = [];
  private listedAt = 0;
  private attached: string | null = null;

  constructor(readonly dir: string, private readonly ddl: string) {}

  /** The month file for `now`, created with the cache's schema if new. */
  private fileFor(now: number): string {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${archiveMonth(now)}.sqlite`);
    if (!existsSync(path)) {
      const db = new Database(path, { create: true });
      try { db.exec(this.ddl); } finally { db.close(); }
      this.listedAt = 0;
    }
    return path;
  }

  /** ATTACH this month's file to the hot connection for a maintenance pass (outside any transaction). */
  attach(hot: Database, now = Date.now()): string {
    if (this.attached) return this.attached;
    const path = this.fileFor(now);
    hot.query(`ATTACH DATABASE ? AS ${ARCH}`).run(path);
    this.attached = path;
    return path;
  }

  detach(hot: Database): void {
    if (!this.attached) return;
    try { hot.exec(`DETACH DATABASE ${ARCH}`); } catch { /* the connection went */ }
    this.attached = null;
  }

  /** The copy statements for the batch transactions (valid while attached). */
  copiers(hot: Database): { node: (key: string, addr: string) => void; tree: (key: string) => void } {
    const node = hot.prepare(`INSERT OR IGNORE INTO ${ARCH}.gtow_cache_nodes SELECT * FROM main.gtow_cache_nodes WHERE key = ? AND addr = ?`);
    const tree = hot.prepare(`INSERT OR IGNORE INTO ${ARCH}.gtow_cache_trees SELECT * FROM main.gtow_cache_trees WHERE key = ?`);
    return { node: (k, a) => { node.run(k, a); }, tree: (k) => { tree.run(k); } };
  }

  /** The month files, newest first. */
  private list(): string[] {
    const now = Date.now();
    if (now - this.listedAt < LIST_MS) return this.files;
    try { this.files = readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}\.sqlite$/.test(f)).sort().reverse().map((f) => join(this.dir, f)); } catch { this.files = []; }
    this.listedAt = now;
    return this.files;
  }

  private reader(path: string): Database | null {
    let db = this.readers.get(path);
    if (db) return db;
    try { db = new Database(path, { readonly: true }); this.readers.set(path, db); return db; } catch { return null; }
  }

  /** A node by its primary key, newest month first — or null. */
  lookupNode(key: string, addr: string): { status: number; reply: Uint8Array | null } | null {
    for (const f of this.list()) {
      try {
        const r = this.reader(f)?.query<{ status: number; reply: Uint8Array | null }, [string, string]>(
          "SELECT status, reply FROM gtow_cache_nodes WHERE key = ? AND addr = ?").get(key, addr);
        if (r) return r;
      } catch { /* an unreadable month is skipped */ }
    }
    return null;
  }

  /** A tree's stored body by its key, newest month first — or null. */
  lookupTree(key: string): { kind: string; body: Uint8Array } | null {
    for (const f of this.list()) {
      try {
        const r = this.reader(f)?.query<{ kind: string; body: Uint8Array }, [string]>("SELECT kind, body FROM gtow_cache_trees WHERE key = ?").get(key);
        if (r) return r;
      } catch { /* skipped */ }
    }
    return null;
  }

  close(): void {
    for (const db of this.readers.values()) { try { db.close(); } catch { /* closed */ } }
    this.readers.clear();
  }
}
