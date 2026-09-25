/**
 * THE CENTRAL DATABASE (2026-09-25) — one SQLite file, `<data root>/poker.sqlite`, holding every runtime record the
 * wrapper and the API keep: hands (live + finished), sessions + balances, answers, stored chains, the GTO Wizard
 * request ledger, poller events, jobs, the miss queue, river MES, hand facts. Brady: "a local SQLite db that we read
 * off of … the dashboard reads off the same row that the reader/study answer writes to".
 *
 * Every store opens it through `openStore(path)` (WAL + a busy timeout). A store whose env override points somewhere
 * else (tests: `:memory:`, a temp file) opens that file the same way. Legacy adoption (below) is NOT lazy: the wrapper
 * calls `adoptAtStartup()` before it starts its loops (it must never spend a copy mid-hand inside a live-row write);
 * the API calls `adoptAtStartupAsync()` once its port is open, in committed chunks, and starts its background work
 * after it.
 *
 * LEGACY ADOPTION. Before this, each store had its own file (api/data/answers.sqlite, solves.sqlite, jobs.sqlite,
 * miss-queue.sqlite, river_mes.sqlite, hand_facts.sqlite; ignition-study-wrapper/data/hands.db, sessions.sqlite).
 * No two share a table name. On open, for each legacy file that still exists:
 *   - a table the central DB does not have yet is created from the legacy file's own DDL (and indexes) and copied
 *     WITH its rowids — so /hands/<dbId> links and answers.solve_id keep pointing at the same rows;
 *   - a watermark (`_poker_adopted_into`: table + DESTINATION → highest rowid copied) is written INTO the legacy file,
 *     keyed by the central DB it was copied to (a copy into some other database never counts for this one), so rows an
 *     old-code process appends there during the restart window are picked up on the next open (as new rows);
 *   - once nothing holds the file open (Windows refuses to rename an open file), it is renamed to
 *     `<name>.adopted-<yyyymmdd>` — no stale second copy is left to be read by mistake.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataLayout, storePath, type DataLayout } from "./dataRoot";
import { adoptJsonl, type JsonlSource } from "./eventTables";

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
    // services/hhCheck: its own `meta` is not carried over (renamed hh_checks_meta; the cutoff is set on first start)
    { file: join(api, "hh_checks.sqlite"), tables: ["hh_checks"] },
  ];
}

/** The append-only JSONL logs the event tables replace (eventTables.ts). */
export function legacyJsonlSources(L: DataLayout = dataLayout()): JsonlSource[] {
  const api = join(L.mainCheckout, "gto-trainer", "apps", "api", "data");
  return [
    { file: join(api, "gtow_requests.jsonl"), table: "gtow_requests" },
    { file: join(api, "jobs", "poller-events.jsonl"), table: "poller_events" },
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

/** Rows per committed chunk: each is its own short transaction (its watermark with it), so a kill mid-adoption keeps
 *  what it copied and the event loop gets a turn between chunks (adoptLegacyAsync). solves rows run ~30 KB each: 100 of them ≈ 3 MB, the loop held ≤ ~130 ms (500 held it 551 ms). */
export const ADOPT_CHUNK_ROWS = 100;

/**
 * Copy the legacy files' rows into `db` (the central DB). Idempotent and RESUMABLE: rows go over in ADOPT_CHUNK_ROWS
 * rowid ranges, each committed with its watermark (in the legacy file) — a process killed half way (2026-09-26: the
 * API supervisor's hang watchdog, twice, on a 123 MB solves.sqlite copied in one transaction before the port was
 * open) starts the next time from the last chunk. `retire` renames fully-copied files that nothing holds open (off in
 * tests that inspect them). A generator of steps: the sync and async drivers below yield between chunks.
 */
export function* adoptSteps(db: Database, sources: LegacySource[], out: AdoptionResult,
                     opts: { retire?: boolean; now?: number; chunkRows?: number }): Generator<void, void, void> {
  const now = opts.now ?? Date.now();
  const chunk = Math.max(1, Math.trunc(opts.chunkRows ?? ADOPT_CHUNK_ROWS));
  // the watermark is per DESTINATION: which central DB these rows went to
  const dest = process.platform === "win32" ? resolve(db.filename).toLowerCase() : resolve(db.filename);
  for (const src of sources) {
    if (!existsSync(src.file) || resolve(src.file) === resolve(db.filename)) continue;
    let attached = false;
    try {
      db.run(`ATTACH DATABASE ? AS legacy`, [src.file]);
      attached = true;
      db.run(`CREATE TABLE IF NOT EXISTS legacy._poker_adopted_into (tbl TEXT NOT NULL, dest TEXT NOT NULL, max_rowid INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (tbl, dest))`);
      for (const t of src.tables) {
        if (!tableExists(db, "legacy", t)) continue;
        const legacyDdl = db.query<{ sql: string }, [string]>(`SELECT sql FROM legacy.sqlite_master WHERE type='table' AND name=?`).get(t)!.sql;
        if (/WITHOUT\s+ROWID/i.test(legacyDdl)) {
          // no rowid to watermark (hand_facts): copy by primary key every pass — idempotent, and these tables are small
          const copied = db.transaction(() => {
            if (!tableExists(db, "main", t)) db.run(legacyDdl);
            const cols = columnsOf(db, "legacy", t).filter((c) => new Set(columnsOf(db, "main", t)).has(c)).map(q).join(", ");
            return db.run(`INSERT OR IGNORE INTO main.${q(t)} (${cols}) SELECT ${cols} FROM legacy.${q(t)}`).changes;
          }).immediate();
          if (copied) out.notes.push({ file: src.file, table: t, copied, preservedIds: false });
          yield;
          continue;
        }
        const top = db.query<{ m: number | null }, []>(`SELECT MAX(rowid) m FROM legacy.${q(t)}`).get()?.m ?? 0;
        const mark0 = db.query<{ max_rowid: number }, [string, string]>(`SELECT max_rowid FROM legacy._poker_adopted_into WHERE tbl = ? AND dest = ?`).get(t, dest)?.max_rowid ?? null;
        if (mark0 != null && top <= mark0) continue;
        db.transaction(() => {
          if (tableExists(db, "main", t)) return;
          // the legacy DDL itself (constraints, AUTOINCREMENT, defaults), then its indexes
          db.run(legacyDdl);
          for (const ix of db.query<{ sql: string | null }, [string]>(`SELECT sql FROM legacy.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(t)) {
            db.run(ix.sql!.replace(/^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?/i, (_m, u) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS `));
          }
        }).immediate();
        const mainCols = new Set(columnsOf(db, "main", t));
        const cols = columnsOf(db, "legacy", t).filter((c) => mainCols.has(c));
        const colList = cols.map(q).join(", ");
        const pk = db.query<{ name: string; pk: number; type: string }, []>(`PRAGMA main.table_info(${q(t)})`).all().filter((c) => c.pk > 0);
        const rowidPk = pk.length === 1 && /^INTEGER$/i.test(pk[0]!.type);
        const appendList = (rowidPk ? cols.filter((c) => c !== pk[0]!.name) : cols).map(q).join(", ");
        let cur = mark0 ?? 0;
        let copied = 0;
        let preservedIds = true;
        while (cur < top) {
          const lo = cur;
          const hi = db.query<{ r: number }, [number, number]>(`SELECT rowid r FROM legacy.${q(t)} WHERE rowid > ? ORDER BY rowid LIMIT 1 OFFSET ?`).get(lo, chunk - 1)?.r ?? top;
          copied += db.transaction(() => {
            // KEEP THE ROWIDS (links elsewhere point at them) while nothing but this copy has written the table: main's
            // highest rowid is still at or below the watermark. A row another writer added meanwhile (the API serves
            // while it adopts; an old-code process appended after a first adoption) means new rowids from here on —
            // and a keyed table keeps the central row when its key already exists (the central one is the newer writer's).
            const mainMax = db.query<{ m: number | null }, []>(`SELECT MAX(rowid) m FROM main.${q(t)}`).get()?.m ?? 0;
            const range = `WHERE rowid > ${lo} AND rowid <= ${hi}`;
            let n: number;
            if (mainMax <= lo) {
              n = db.run(`INSERT INTO main.${q(t)} (rowid, ${colList}) SELECT rowid, ${colList} FROM legacy.${q(t)} ${range}`).changes;
            } else {
              preservedIds = false;
              n = db.run(`INSERT OR IGNORE INTO main.${q(t)} (${appendList}) SELECT ${appendList} FROM legacy.${q(t)} ${range}`).changes;
            }
            db.run(`INSERT INTO legacy._poker_adopted_into (tbl, dest, max_rowid, at) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, dest) DO UPDATE SET max_rowid = excluded.max_rowid, at = excluded.at`, [t, dest, hi, now]);
            return n;
          }).immediate();
          cur = hi;
          yield;
        }
        out.notes.push({ file: src.file, table: t, copied, preservedIds });
      }
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
    yield;
  }
}

const emptyResult = (): AdoptionResult => ({ notes: [], retired: [], stillOpen: [], errors: [] });

/** The whole adoption at once (the wrapper, before its loops start; tests). */
export function adoptLegacy(db: Database, sources: LegacySource[], opts: { retire?: boolean; now?: number; chunkRows?: number } = {}): AdoptionResult {
  const out = emptyResult();
  for (const _ of adoptSteps(db, sources, out, opts)) { /* no one to yield to */ }
  return out;
}

/** The same, giving the event loop a turn between chunks (the API: it answers its health probe while it adopts). */
export async function adoptLegacyAsync(db: Database, sources: LegacySource[], opts: { retire?: boolean; now?: number; chunkRows?: number } = {}): Promise<AdoptionResult> {
  const out = emptyResult();
  for (const _ of adoptSteps(db, sources, out, opts)) await new Promise<void>((r) => setImmediate(r));
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

/** Open a store's database: WAL + busy timeout (read-only opens just get the timeout). */
export function openStore(path: string, opts: OpenOpts = {}): Database {
  if (path !== ":memory:" && !path.startsWith("file::memory:") && !opts.readonly) mkdirSync(dirname(path), { recursive: true });
  const db = opts.readonly ? new Database(path, { readonly: true }) : new Database(path);
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.round(opts.busyMs ?? 5000))}`);
  if (!opts.readonly) db.run("PRAGMA journal_mode=WAL");
  return db;
}

/**
 * Copy the legacy per-store files into the central DB — once per process, at start, before any loop runs (the API's
 * index.ts, the wrapper's main.ts). Not in test mode (the test root has no legacy files) and not when the central DB
 * is overridden away from the root. Returns the one-line summary it logged, or null when there was nothing to do.
 */
export function adoptAtStartup(log: (line: string) => void = console.log): string | null {
  const path = startupTarget();
  if (!path) return null;
  const db = openStore(path, { busyMs: 30_000 });
  try {
    lastAdoption = adoptLegacy(db, legacySources(), { retire: true });
    foldJsonl(db);
  } finally {
    db.close();
  }
  return startupLine(path, log);
}

/**
 * The API's adoption: the same copy, run AFTER the port is open, a chunk at a time with the event loop served in
 * between — the supervisor's health probe is answered throughout, and the background work (poller, dispatcher,
 * keeper) starts when it resolves (index.ts).
 */
export async function adoptAtStartupAsync(log: (line: string) => void = console.log): Promise<string | null> {
  const path = startupTarget();
  if (!path) return null;
  const db = openStore(path, { busyMs: 30_000 });
  try {
    lastAdoption = await adoptLegacyAsync(db, legacySources(), { retire: true });
    foldJsonl(db);
  } finally {
    db.close();
  }
  return startupLine(path, log);
}

function startupTarget(): string | null {
  if (adoptedThisProcess) return null;
  adoptedThisProcess = true;
  if (dataLayout().mode === "test") return null;
  const path = centralDbPath();
  return path.startsWith(":memory:") ? null : path;
}

function foldJsonl(db: Database): void {
  const j = adoptJsonl(db, legacyJsonlSources(), { retire: true });
  lastAdoption!.notes.push(...j.notes.map((n) => ({ ...n, preservedIds: false })));
  lastAdoption!.retired.push(...j.retired);
  lastAdoption!.stillOpen.push(...j.stillOpen);
  lastAdoption!.errors.push(...j.errors);
}

function startupLine(path: string, log: (line: string) => void): string | null {
  const A = lastAdoption!;
  const n = A.notes.reduce((s, x) => s + x.copied, 0);
  if (!n && !A.errors.length && !A.stillOpen.length && !A.retired.length) return null;
  const line = `[data-root] adopted ${n} legacy row(s) into ${path}: ` +
    (A.notes.map((x) => `${x.table} +${x.copied}`).join(", ") || "nothing new") +
    (A.retired.length ? ` · retired ${A.retired.join(", ")}` : "") +
    (A.stillOpen.length ? ` · still open elsewhere (old code running? restart it): ${A.stillOpen.join(", ")}` : "") +
    (A.errors.length ? ` · ERRORS: ${A.errors.join(" | ")}` : "");
  log(line);
  return line;
}

/** Test hook: let the next central open adopt again. */
export function resetAdoptionForTests(): void {
  adoptedThisProcess = false;
  lastAdoption = null;
}

/**
 * THE MIXED-VERSION WINDOW: an old-code wrapper (or API) still writing a legacy file after this process adopted it.
 * Its new rows would stay invisible until the next restart, so while any legacy file is still held open elsewhere the
 * API re-runs the (watermarked, cheap) adoption every `everyMs` and stops once every file has been retired. Returns a
 * stop function. Not the wrapper's job: a copy must never run inside a hand.
 */
export function startAdoptionCatchUp(
  log: (line: string) => void = console.log, everyMs = 60_000,
  sources: () => { db: LegacySource[]; jsonl: JsonlSource[] } = () => ({ db: legacySources(), jsonl: legacyJsonlSources() }),
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const seen = new Map<string, string>();
  const pending = () => new Set([...(lastAdoption?.stillOpen ?? [])]);
  if (!pending().size) return () => {};
  timer = setInterval(() => {
    const open = pending();
    if (!open.size) { if (timer) clearInterval(timer); timer = null; return; }
    // CHEAP WHEN NOTHING MOVED: a file (and its WAL) the same size and age as last pass has no new rows — no open, no
    // ATTACH, no scan. The first pass always looks (nothing is remembered yet). The signature is taken AFTER a pass:
    // the pass itself writes the watermark into the legacy file.
    const moved = [...open].filter((f) => fileSig(f) !== seen.get(f));
    if (!moved.length) return;
    let db: Database | null = null;
    try {
      db = openStore(centralDbPath(), { busyMs: 10_000 });
      const src = sources();
      const r = adoptLegacy(db, src.db.filter((s) => moved.includes(s.file)), { retire: true });
      const j = adoptJsonl(db, src.jsonl.filter((s) => moved.includes(s.file)), { retire: true });
      const copied = [...r.notes, ...j.notes].reduce((s, n) => s + n.copied, 0);
      const retired = [...r.retired, ...j.retired];
      const still = new Set([...[...open].filter((f) => !moved.includes(f)), ...r.stillOpen, ...j.stillOpen]);
      if (lastAdoption) lastAdoption.stillOpen = [...still];
      if (copied || retired.length) log(`[data-root] catch-up: +${copied} row(s) an old-code process wrote${retired.length ? ` · retired ${retired.join(", ")}` : ""}`);
      for (const f of moved) seen.set(f, fileSig(f));
    } catch (e) {
      log(`[data-root] catch-up failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      try { db?.close(); } catch { /* closed */ }
    }
  }, everyMs);
  return () => { if (timer) clearInterval(timer); timer = null; };
}

/** size:mtime of a file and its WAL — what the catch-up compares between passes. */
function fileSig(f: string): string {
  const one = (x: string) => { try { const st = statSync(x); return `${st.size}:${st.mtimeMs}`; } catch { return "-"; } };
  return `${one(f)}|${one(f + "-wal")}`;
}

/** Test hook: pretend start-up adoption found these legacy files still held open (the catch-up's input). */
export function _setStillOpenForTests(files: string[]): void {
  lastAdoption = { notes: [], retired: [], stillOpen: files, errors: [] };
}
