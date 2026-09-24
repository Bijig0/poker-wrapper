import { Database } from "bun:sqlite";
import { join } from "node:path";
// Python's zlib.compress() is zlib-wrapped deflate, NOT gzip — inflateSync, never gunzipSync.
import { inflateSync } from "node:zlib";
import { fetchNode, type HrcNode } from "./hrc3max";

/**
 * The 6-max ring preflop charts, read straight out of SQLite.
 *
 * WHY: an HRC solution body is one json.gz holding EVERY node of the tree in a
 * dict keyed by line — 59k-82k nodes, 29MB gzipped. Asking :8777 for one node
 * means parsing all of them: measured 3.6s and ~600MB resident. The server
 * exists to hold those parsed dicts in memory so the cost is paid once per tree
 * rather than once per query — hence its LRU, its tuned HRC_UI_DOC_CACHE_MAX and
 * its 8.4GB RSS. It works until the working set exceeds the cache, and then it
 * thrashes: seven distinct trees touched in a row came back cold on EVERY one,
 * and a ring session moves between trees whenever the open size or the short
 * stack's seat changes. That is the 2-18s you feel at hero's turn, and it is
 * neither R2 nor the network — the bodies are already on local disk.
 *
 * The node shape is already a table. So analysis/pipeline/solve/build_6max_preflop_db.py
 * bakes `(source, line) -> pos, terminal, actions, cells` once, and this reads it:
 * ~0.13ms per node measured, nothing resident, no warm-up, no eviction.
 *
 * SCOPE: ign200_6max_* only. Everything else — the 3-max asym families, the
 * solve-DB browser, exploit tooling — still goes to :8777 unchanged, and :8777
 * remains the record. This is a read cache for one hot family, never the truth.
 */

/** Set HRC6MAX_DB to point elsewhere; set it to "off" to disable the local path
 *  entirely and send every node back to :8777 (the pre-2026-09-20 behaviour).
 *
 *  Read on OPEN, not at module load. Binding it at load makes the module's
 *  behaviour depend on who imported it first — a test that sets the env var in
 *  beforeAll passes alone and then reads the real 2.5GB bake as soon as any
 *  other file imports hrc6max.ts ahead of it — and it stops reload() from being
 *  able to follow a changed path. */
const dbPath = (): string =>
  process.env.HRC6MAX_DB ?? join(import.meta.dir, "..", "..", "data", "hrc6max-preflop.sqlite");
const PREFIX = "ign200_6max_";

type Row = { pos: string | null; terminal: number; actions: string; cells: Uint8Array; pruned?: number };

class Hrc6MaxDb {
  private db: Database | null = null;
  private tried = false;
  /** Sources the bake covers. Empty set = no local coverage at all. */
  private baked = new Set<string>();
  private nodeStmt: ReturnType<Database["query"]> | null = null;

  /** Opened lazily and at most once: a missing file is the normal state on a
   *  machine that has not run the bake, and must cost nothing per call. */
  private open(): Database | null {
    if (this.tried) return this.db;
    this.tried = true;
    const path = dbPath();
    if (path === "off") return null;
    try {
      const db = new Database(path, { readonly: true });
      for (const r of db.query("SELECT source FROM trees").all() as { source: string }[]) {
        this.baked.add(r.source);
      }
      // `pruned` (0 close / 1 reach / 2 cut) arrived 2026-09-25; a bake from before it has no such column.
      const hasPruned = (db.query("PRAGMA table_info(nodes)").all() as { name: string }[]).some((c) => c.name === "pruned");
      this.nodeStmt = db.query(`SELECT pos, terminal, actions, cells${hasPruned ? ", pruned" : ""} FROM nodes WHERE source = ? AND line = ?`);
      this.db = db;
    } catch {
      this.db = null;            // not baked on this machine — :8777 answers everything
    }
    return this.db;
  }

  /**
   * Drop the handle and the coverage set so the next call re-opens the file.
   *
   * The bake ADDS trees. Coverage is read once, at first open, so a re-bake
   * against a running API would stay invisible until it was restarted — and the
   * failure mode is quiet (those spots keep going to :8777 and keep paying the
   * cold open) rather than loud. Call this after re-running the builder.
   */
  reload(): void {
    try { this.db?.close(); } catch { /* already gone */ }
    this.db = null;
    this.tried = false;
    this.baked.clear();
    this.nodeStmt = null;
  }

  /** Is this chart baked here? Only then is a missing line authoritative. */
  covers(source: string): boolean {
    if (!source.startsWith(PREFIX)) return false;
    return this.open() !== null && this.baked.has(source);
  }

  get size(): number {
    this.open();
    return this.baked.size;
  }

  /**
   * `undefined` = not covered here, ask the server. `null` = covered, and this
   * line genuinely is not in the tree. THE DIFFERENCE MATTERS: a null is a fact
   * about the chart that makes the caller fall back to another chart, so
   * returning it for an unbaked tree would silently answer from the wrong one.
   */
  node(source: string, line: string): HrcNode | null | undefined {
    if (!this.covers(source)) return undefined;
    const row = this.nodeStmt!.get(source, line) as Row | null;
    if (!row) return null;
    return {
      pos: row.pos,
      terminal: row.terminal === 1,
      ...(row.pruned === 1 ? { pruned: "reach" as const } : row.pruned === 2 ? { pruned: "cut" as const } : {}),
      actions: JSON.parse(row.actions) as HrcNode["actions"],
      cells: JSON.parse(inflateSync(row.cells).toString("utf8")) as HrcNode["cells"],
    };
  }
}

export const hrc6maxDb = new Hrc6MaxDb();

/**
 * Drop-in for hrc3max's `fetchNode`, for the 6-max family only: the baked DB
 * first, :8777 for anything it does not cover. Same return contract, so
 * resolveChart6max's candidate walk and walk3max behave identically — including
 * "unreachable", which only the HTTP path can produce.
 */
export const fetchNode6max: (source: string, line: string) => Promise<HrcNode | null | "unreachable"> =
  async (source, line) => {
    const local = hrc6maxDb.node(source, line);
    if (local !== undefined) return local;
    return fetchNode(source, line);
  };
