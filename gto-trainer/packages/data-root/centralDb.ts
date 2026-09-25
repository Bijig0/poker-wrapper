/**
 * THE CENTRAL DATABASE (2026-09-25) — one SQLite file, `<data root>/poker.sqlite`, holding every runtime record the
 * wrapper and the API keep: hands (live + finished), sessions + balances, answers, stored chains, the GTO Wizard
 * request ledger, poller events, jobs, the miss queue, river MES, hand facts. Brady: "a local SQLite db that we read
 * off of … the dashboard reads off the same row that the reader/study answer writes to".
 *
 * Every store opens it through `openStore(path)`: when the path is the central one (the default), the connection is
 * WAL with a busy timeout, and the FIRST open in a process adopts the legacy per-store files (below). A store whose
 * env override points somewhere else (tests: `:memory:`, a temp file) opens that file plainly, exactly as before.
 *
 * LEGACY ADOPTION. Before this, each store had its own file (api/data/answers.sqlite, solves.sqlite, jobs.sqlite,
 * miss-queue.sqlite, river_mes.sqlite, hand_facts.sqlite; ignition-study-wrapper/data/hands.db, sessions.sqlite).
 * No two share a table name. On open, for each legacy file that still exists:
 *   - a table the central DB does not have yet is created from the legacy file's own DDL (and indexes) and copied
 *     WITH its rowids — so /hands/<dbId> links and answers.solve_id keep pointing at the same rows;
 *   - a watermark (`_poker_adopted`: table → highest rowid copied) is written INTO the legacy file, so rows an
 *     old-code process appends there during the restart window are picked up on the next open (as new rows);
 *   - once nothing holds the file open (Windows refuses to rename an open file), it is renamed to
 *     `<name>.adopted-<yyyymmdd>` — no stale second copy is left to be read by mistake.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataLayout, storePath, type DataLayout } from "./dataRoot";

export const CENTRAL_DB_NAME = "poker.sqlite";

/** `<root>/poker.sqlite`; POKER_DB_PATH overrides (tests / verify snapshots). */
export function centralDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return storePath("poker.sqlite", join(dataLayout(env).root, CENTRAL_DB_NAME), "POKER_DB_PATH", env).path;
}

export interface LegacySource {
  file: string;
  tables: string[];
}

/** The per-store files the central DB replaces, where the code before 2026-09-25 put them (main checkout). */
export function legacySources(L: DataLayout = dataLayout()): LegacySource[] {
  const api = join(L.mainCheckout, "gto-trainer", "apps", "api", "data");
  const wrapper = join(L.mainCheckout, "ignition-study-wrapper", "data");
  return [
    { file: join(wrapper, "hands.db"), tables: ["hands"] },
    { file: join(wrapper, "sessions.sqlite"), tables: ["sessions", "balances"] },
    { file: join(api, "answers.sqlite"), tables: ["answers"] },
    { file: join(api, "solves.sqlite"), tables: ["solves"] },
    { file: join(api, "jobs.sqlite"), tables: ["jobs"] },
    { file: join(api, "miss-queue.sqlite"), tables: ["misses"] },
    { file: join(api, "river_mes.sqlite"), tables: ["river_mes"] },
    { file: join(api, "hand_facts.sqlite"), tables: ["hand_facts"] },
  ];
}

export interface AdoptionNote {
  file: string;
  table: string;
  copied: number;
  preservedIds: boolean;
}

export interface AdoptionResult {
  notes: AdoptionNote[];
  retired: string[];
  stillOpen: string[];
  errors: string[];
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

function tableExists(db: Database, schema: string, t: string): boolean {
  return !!db.query(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(t);
}

function columnsOf(db: Database, schema: string, t: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA ${schema}.table_info(${q(t)})`).all().map((c) => c.name);
}

/**
 * Copy the legacy files' rows into `db` (the central DB). Idempotent: a watermark in each legacy file says how far
 * it was copied. `retire` renames fully-copied files that nothing holds open (off in tests that inspect them).
 */
export function adoptLegacy(db: Database, sources: LegacySource[], opts: { retire?: boolean; now?: number } = {}): AdoptionResult {
  const out: AdoptionResult = { notes: [], retired: [], stillOpen: [], errors: [] };
  const now = opts.now ?? Date.now();
  for (const src of sources) {
    if (!existsSync(src.file) || resolve(src.file) === resolve(db.filename)) continue;
    let attached = false;
    try {
      db.run(`ATTACH DATABASE ? AS legacy`, [src.file]);
      attached = true;
      db.run(`CREATE TABLE IF NOT EXISTS legacy._poker_adopted (tbl TEXT PRIMARY KEY, max_rowid INTEGER NOT NULL, at INTEGER NOT NULL)`);
      db.transaction(() => {
        for (const t of src.tables) {
          if (!tableExists(db, "legacy", t)) continue;
          const mark = db.query<{ max_rowid: number }, [string]>(`SELECT max_rowid FROM legacy._poker_adopted WHERE tbl = ?`).get(t)?.max_rowid ?? null;
          const top = db.query<{ m: number | null }, []>(`SELECT MAX(rowid) m FROM legacy.${q(t)}`).get()?.m ?? 0;
          if (mark != null && top <= mark) continue;
          let preservedIds = false;
          let copied = 0;
          if (!tableExists(db, "main", t)) {
            // the legacy DDL itself (constraints, AUTOINCREMENT, defaults), then its indexes
            const ddl = db.query<{ sql: string }, [string]>(`SELECT sql FROM legacy.sqlite_master WHERE type='table' AND name=?`).get(t)!.sql;
            db.run(ddl);
            for (const ix of db.query<{ sql: string | null }, [string]>(`SELECT sql FROM legacy.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(t)) {
              db.run(ix.sql!.replace(/^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?/i, (_m, u) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS `));
            }
          }
          const mainCols = new Set(columnsOf(db, "main", t));
          const cols = columnsOf(db, "legacy", t).filter((c) => mainCols.has(c));
          const colList = cols.map(q).join(", ");
          const mainEmpty = !db.query(`SELECT 1 FROM main.${q(t)} LIMIT 1`).get();
          const where = mark != null ? `WHERE rowid > ${mark}` : "";
          if (mainEmpty) {
            // first adoption: keep every rowid (links elsewhere point at them)
            copied = db.run(`INSERT INTO main.${q(t)} (rowid, ${colList}) SELECT rowid, ${colList} FROM legacy.${q(t)} ${where}`).changes;
            preservedIds = true;
          } else {
            // rows an old-code process appended after the first adoption: new rowids; keyed tables keep the
            // central row when the key already exists (the central one is the newer writer's)
            const pk = db.query<{ name: string; pk: number; type: string }, []>(`PRAGMA main.table_info(${q(t)})`).all().filter((c) => c.pk > 0);
            const rowidPk = pk.length === 1 && /^INTEGER$/i.test(pk[0]!.type);
            const insertCols = rowidPk ? cols.filter((c) => c !== pk[0]!.name) : cols;
            const list = insertCols.map(q).join(", ");
            copied = db.run(`INSERT OR IGNORE INTO main.${q(t)} (${list}) SELECT ${list} FROM legacy.${q(t)} ${where}`).changes;
          }
          db.run(`INSERT INTO legacy._poker_adopted (tbl, max_rowid, at) VALUES (?, ?, ?) ON CONFLICT(tbl) DO UPDATE SET max_rowid = excluded.max_rowid, at = excluded.at`, [t, top, now]);
          out.notes.push({ file: src.file, table: t, copied, preservedIds });
        }
      })();
    } catch (e) {
      out.errors.push(`${src.file}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (attached) try { db.run(`DETACH DATABASE legacy`); } catch { /* keep going */ }
    }
    if (opts.retire && !out.errors.some((x) => x.startsWith(src.file))) {
      const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
      try {
        // fold the WAL back into the file first so the renamed copy is complete on its own
        try { const l = new Database(src.file); l.run("PRAGMA wal_checkpoint(TRUNCATE)"); l.close(); } catch { /* best effort */ }
        renameSync(src.file, `${src.file}.adopted-${stamp}`);
        for (const sfx of ["-wal", "-shm"]) if (existsSync(src.file + sfx)) try { renameSync(src.file + sfx, `${src.file}.adopted-${stamp}${sfx}`); } catch { /* left behind, harmless */ }
        out.retired.push(src.file);
      } catch {
        out.stillOpen.push(src.file);   // another (old-code) process holds it: the watermark carries the next copy
      }
    }
  }
  return out;
}

let adoptedThisProcess = false;
let lastAdoption: AdoptionResult | null = null;

/** What this process's adoption did (for the start-up log and /api/dashboard/storage). */
export function adoptionReport(): AdoptionResult | null {
  return lastAdoption;
}

export interface OpenOpts {
  readonly?: boolean;
  /** ms to wait for another writer; the wrapper's best-effort live writes use a short one */
  busyMs?: number;
}

/**
 * Open a store's database. The central path → WAL + busy timeout (+ legacy adoption on the first writable open in
 * this process, main-checkout and POKER_DATA_DIR modes only). Any other path (an override) → opened as asked.
 */
export function openStore(path: string, opts: OpenOpts = {}): Database {
  const central = path === centralDbPath();
  if (path !== ":memory:" && !path.startsWith("file::memory:") && !opts.readonly) mkdirSync(dirname(path), { recursive: true });
  const db = opts.readonly ? new Database(path, { readonly: true }) : new Database(path);
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.round(opts.busyMs ?? 5000))}`);
  if (!opts.readonly) {
    db.run("PRAGMA journal_mode=WAL");
    if (central && !adoptedThisProcess && dataLayout().mode !== "test") {
      adoptedThisProcess = true;
      lastAdoption = adoptLegacy(db, legacySources(), { retire: true });
      const n = lastAdoption.notes.reduce((s, x) => s + x.copied, 0);
      if (n || lastAdoption.errors.length || lastAdoption.stillOpen.length) {
        console.log(`[data-root] adopted ${n} legacy row(s) into ${path}: ` +
          lastAdoption.notes.map((x) => `${x.table} +${x.copied}`).join(", ") +
          (lastAdoption.retired.length ? ` · retired ${lastAdoption.retired.length} file(s)` : "") +
          (lastAdoption.stillOpen.length ? ` · still open elsewhere (old code running?): ${lastAdoption.stillOpen.join(", ")}` : "") +
          (lastAdoption.errors.length ? ` · ERRORS: ${lastAdoption.errors.join(" | ")}` : ""));
      }
    }
  }
  return db;
}

/** Test hook: let the next central open adopt again. */
export function resetAdoptionForTests(): void {
  adoptedThisProcess = false;
  lastAdoption = null;
}
