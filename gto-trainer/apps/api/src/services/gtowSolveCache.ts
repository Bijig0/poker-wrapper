/**
 * THE GTO WIZARD SOLVE CACHE (2026-09-28, Brady: "whenever we solve a spot live using gto wizard ai i want it cached
 * and stored somewhere so that future hits can go to it, both pre and postflop").
 *
 * WHY. Every AI answer — the preflop fallback piece (services/gtowAiPreflop.ts) and the postflop chain
 * (services/gtowApi.ts, driven by aiChain) — is a custom tree POSTed to GTO Wizard, a custom solution POSTed on it, and
 * one or more node reads polled until the strategy lands. All of it lived in in-process Maps, so an API restart, a
 * replay of last night's hands or the next hand with the same tree paid the whole thing again — against a limit of
 * 2,250 requests per rolling hour per account whose trip costs the account about a day (gtowRequestLog.ts). A solved
 * tree does not change: the same body POSTed again is the same game, and GTO Wizard answers the same node with the same
 * strategy. So what came back is kept, in its own SQLite file (`<data root>/gtow-cache.sqlite`, storePaths.gtowCachePath),
 * and served again without a request.
 *
 * LOSSLESS, EXACT MATCH. A tree's key is the sha256 of the canonical JSON (object keys sorted, recursively) of exactly
 * what was POSTed — the tree body plus the solution's {actions, board} — with the fields that differ between two
 * identical requests left out (ids, uuids, timestamps, the account). No bucketing, no rounding: a hit is the solve GTO
 * Wizard would have returned. `normalizeForKey` is the seam for a lossy key later (bucketed stacks); it is the
 * identity today. A node's address is its action strings and board (`nodeAddr`).
 *
 * WHAT IS KEPT. Only COMPLETE replies — a 200 with action_solutions, exactly as GTO Wizard sent it (gzipped) — and
 * GTO Wizard's DETERMINISTIC verdicts about a line: "no decision node here" (NO_NODE: the solve is served and the line
 * closes the street / ends the hand) and its own refusal of the line (400 VALIDATION_ERROR, 422 NODE_DOES_NOT_EXIST,
 * stored as the negative status). Never a 204 (still solving), 404, 429, 5xx or an auth failure: those say something
 * about the moment or the account, not about the solve.
 *
 * LAZY MATERIALISATION (the callers' half, gtowApi / gtowAiPreflop). A tree already in the store is handed out as a
 * SYNTHETIC solution id, `gc:<key>`, without a request; its nodes are read from the store. Only a node the store does
 * not hold makes the caller create the solve for real (tree + solution, through the normal routing, once however many
 * ask) and poll it as always — and that reply is stored too. So a full hit costs ZERO requests, and a restart never
 * meets a stale solution id: the store holds no GTO Wizard ids at all.
 *
 * RETENTION (Brady, 2026-10-09): rows not hit for GTOW_CACHE_DAYS (14) are deleted, then, while the stored bytes exceed
 * GTOW_CACHE_MAX_MB (500), the least-recently-hit nodes go (to 90% of the cap), then the freed pages are given back to
 * the file. ALL OF IT RUNS IN A MAINTENANCE WINDOW — only while no poker session is live (maintenance()), in batches of
 * at most MAINT_BUDGET_MS with the live check between them; during a session the cache does point reads, batched appends
 * and its counters only. (Until 2026-10-09: 60 days / 2048 MB, checked at open and every 500 writes, on any thread
 * state — and the file had grown to 1.5 GB, all of it under the cap, so nothing was ever evicted.)
 *
 * NOTHING EVICTED IS LOST (Brady, 2026-10-09): every row the window removes — expired or evicted, node or tree — is
 * first copied to the COLD ARCHIVE, <cache dir>/gtow-cache-archive/<YYYY-MM>.sqlite (services/gtowCacheArchive.ts: same
 * schema, append-only, ATTACHed for the pass and written in the same batches). It is read by point lookups only, after
 * the hot file: the hand page's "open the exact node" (getNodeArchived) and offline scripts with
 * GTOW_CACHE_ARCHIVE_READ=1. The live answer path never reads it. GTOW_CACHE_ARCHIVE=off deletes without archiving.
 *
 * OFF: GTOW_CACHE=off, or GTOW_CACHE_DB_PATH=off. Under bun test it is off unless GTOW_CACHE_DB_PATH names a temp
 * file — one test's replies must never answer another's. A file that cannot be opened leaves a memory-only cache.
 *
 * WRITES ARE DEFERRED (a flush every FLUSH_MS, one transaction): gzipping a 500 KB reply is ~10 ms of CPU the answer
 * does not need to wait for — the flush runs while the walk awaits its next node. A pending write is readable at once.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { isAuthFailure } from "./gtowAuthBody";
import { gtowCachePath, openStore } from "./storePaths";
import { sessionLive } from "./sessionLive";
import type { ScanReply, ScanRecent, ScanRows } from "./gtowCacheScanWorker";
import { archiveDirFor, GtowCacheArchive } from "./gtowCacheArchive";

export type CacheKind = "pre" | "post";

/** A full node: a 200 with action_solutions. */
export const NODE_OK = 200;
/** GTO Wizard's verdict "no decision node on this line" (the solve is served; the line closes the street or ends the hand). */
export const NO_NODE = -204;
/** GTO Wizard's own refusals of a LINE, deterministic for the tree: stored as the negative HTTP status. */
const REFUSALS = new Set([-400, -422]);
/** the refusal bodies that are a verdict about the line (not a malformed request or a transient). NOT ENOUGH ALONE
 *  (2026-10-08): GTO Wizard's auth refusal is a VALIDATION_ERROR too — `400 {"code": "VALIDATION_ERROR", "detail":
 *  "Invalid API Key"}` — so `isLineVerdict` also requires the body not to be one (services/gtowAuthBody). */
export const DETERMINISTIC_REFUSAL = /NODE_DOES_NOT_EXIST|VALIDATION_ERROR|Incorrect actions/i;

/** A refusal the store may keep as a fact about the line: a verdict body that is not an auth refusal. */
export function isLineVerdict(status: number, raw: string | null | undefined): boolean {
  const st = Math.abs(status);
  return !!raw && DETERMINISTIC_REFUSAL.test(raw) && !isAuthFailure(st, raw);
}

/** Synthetic solution ids: `gc:<key>` — a tree the store holds, not (yet) a solve on any account. */
export const STORED_PREFIX = "gc:";
/** The `session` a stored tree reports until a node miss makes an account mint it. */
export const CACHE_SESSION = "cache";
export const isStoredSolId = (id: unknown): id is string => typeof id === "string" && id.startsWith(STORED_PREFIX);
export const storedSolId = (key: string): string => `${STORED_PREFIX}${key}`;
export const keyOfStoredSolId = (id: string): string => id.slice(STORED_PREFIX.length);

const KEY_VERSION = "gtow-cache/v1";
/** Fields that differ between two identical requests. None of them is in a body we POST today; the set is the guard
 *  for a caller that passes something carrying them — dropping a field that DID matter would make a false hit, so it
 *  holds only names that can never shape a solve. */
const KEY_EXCLUDE: ReadonlySet<string> = new Set([
  "id", "uuid", "custom_tree_id", "custom_solution_id", "tree_id", "solution_id",
  "created_at", "updated_at", "timestamp", "account", "session",
]);

const DAY_MS = 86_400_000;
const MB = 1024 * 1024;
const FLUSH_MS = 50;
/** re-check the size cap after this many node writes (a long-running API would otherwise only prune at start) */
/**
 * THE MAINTENANCE WINDOW (Brady, 2026-10-09). Retention, eviction to the cap, giving pages back (incremental vacuum), the
 * WAL checkpoint and the counting scan run only while no poker session is live, in batches of at most MAINT_BUDGET_MS
 * of this thread (under the 100 ms a [stall] counts, so the stall summary stays quiet), MAINT_YIELD_MS apart, the live
 * check before every batch. Checked every MAINT_CHECK_MS; a retention sweep at most every RETENTION_EVERY_MS.
 */
export const MAINT_BUDGET_MS = 60;
const MAINT_YIELD_MS = 25;
const MAINT_CHECK_MS = 5 * 60_000;
const RETENTION_EVERY_MS = 6 * 3_600_000;
/** pages per incremental_vacuum step to start from (re-sized after each step to fit the budget) */
const VACUUM_STEP0 = 256;
const VACUUM_STEP_MAX = 512;
const MAINT_WAL_CHECKPOINT_PAGES = 128;
const MAINT_BATCH_ROWS = 100;
const MAINT_BATCH_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CACHE_DAYS = 14;
export const DEFAULT_CACHE_MAX_MB = 500;
export interface MaintenanceResult { ran: boolean; why: string; rows: number; freedBytes: number;
  /** rows copied to the cold archive before they were deleted, and its file */
  archived: number; archivedTo?: string; filePagesFreed: number; batches: number; ms: number; stoppedBy?: string;
  /** the longest single batch of each kind (this thread's time: the event loop was held that long) */
  maxMs: { delete: number; commit: number; vacuum: number; checkpoint: number };
  /** which batch was the longest (phase, its number in the pass, its rows) */
  slowest?: { phase: string; batch: number; ms: number; rows: number } }
const FRESH_MAX = 300;
const BODIES_MAX = 200;
const RECENT_MAX = 12;

/** Canonical JSON: object keys sorted (recursively), `undefined` members dropped as JSON.stringify drops them, and the
 *  names in `drop` left out at every level. Arrays keep their order — a range IS its order. */
export function canonicalJson(v: unknown, drop?: ReadonlySet<string>): string {
  const walk = (x: unknown): string => {
    if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
    if (typeof (x as { toJSON?: unknown }).toJSON === "function") return walk((x as { toJSON: () => unknown }).toJSON());
    if (Array.isArray(x)) return `[${x.map((e) => (e === undefined || typeof e === "function" || typeof e === "symbol" ? "null" : walk(e))).join(",")}]`;
    const o = x as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== "function" && typeof o[k] !== "symbol" && !drop?.has(k)).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(o[k])}`).join(",")}}`;
  };
  return walk(v);
}

/**
 * What was POSTed for one solve. `locks` (2026-10-04, scripts/_probePreflopNodeLock.ts): a NODE-LOCKED solution is a
 * chain — the plain solution, then one `POST /v4/custom-solutions/ {parent_solution_id, last_node_lock}` per lock, each
 * forked from the one before. Its identity is the plain tree + solution + every lock body in order (which is the
 * parent's key plus the locks: the parent's key is a function of the first two). A plain solve has no `locks` member,
 * so its canonical JSON — and its key — is exactly what it was before locks existed. Materialising a locked entry
 * re-POSTs the tree, the solution and each lock in turn (gtowAiPreflop.postPreflopSolution).
 */
export interface PostedTree { tree: unknown; solution: { actions: string; board: string }; locks?: unknown[] }

/**
 * THE SEAM FOR A LOSSY KEY (bucketed stacks, rounded ranges …). The identity today, on purpose: every hit is then the
 * solve GTO Wizard would have returned for this exact request. Whatever this ever changes is folded into the KEY only —
 * the stored body stays what was really POSTed, so a materialisation still solves the tree that was asked for.
 */
export function normalizeForKey(_kind: CacheKind, posted: PostedTree): PostedTree {
  return posted;
}

export interface TreeCacheKey { key: string; /** canonical JSON of what was POSTed — the stored body */ body: string }

/** The key of a tree + its solution request, and the canonical body the store keeps for it. */
export function cacheKeyOf(kind: CacheKind, tree: unknown, solution: { actions: string; board: string }, locks?: readonly unknown[]): TreeCacheKey {
  const posted: PostedTree = { tree, solution: { actions: solution.actions, board: solution.board }, ...(locks?.length ? { locks: [...locks] } : {}) };
  const body = canonicalJson(posted);
  const keyed = canonicalJson(normalizeForKey(kind, posted), KEY_EXCLUDE);
  return { key: createHash("sha256").update(`${KEY_VERSION}|${kind}|${keyed}`).digest("hex"), body };
}

/** A node's address inside a tree: the spot-solution query minus the solution id. */
export interface NodeAddress { preflop?: string; flop?: string; turn?: string; river?: string; board?: string }
export const nodeAddr = (a: NodeAddress): string => [a.preflop ?? "", a.flop ?? "", a.turn ?? "", a.river ?? "", a.board ?? ""].join("|");

/** A node as the store holds it: the parsed reply for a full node, the refusal text for a stored refusal. */
export interface StoredNode { status: number; data: any | null; text: string | null; bytes: number }

export interface SolveCacheOptions {
  /** the SQLite file; null = no file (disabled unless memoryOnly) */
  path?: string | null;
  enabled?: boolean;
  /** rows not hit for this many days are deleted at open */
  days?: number;
  /** the stored bytes the cache is kept under (least-recently-hit nodes go first) */
  maxBytes?: number;
  /** ms between a write and its flush (tests: flush() by hand) */
  flushMs?: number;
  /** the cold archive's directory (null = no archive); default <cache dir>/gtow-cache-archive (services/gtowCacheArchive) */
  archiveDir?: string | null;
}

/** The counters this process has seen since it started (stats().since). */
interface Counters {
  startedMs: number;
  /** stored trees handed out as synthetic ids (each spared a tree + a solution POST) */
  treeHits: number;
  /** trees created afresh because the store did not hold them */
  treeMisses: number;
  /** stored trees a node miss made an account mint after all (their two POSTs were spent in the end) */
  materialised: number;
  /** nodes served from the store: full replies, and stored verdicts */
  nodeHits: number;
  negHits: number;
  /** node reads the store could not serve on a cached tree */
  nodeMisses: number;
  /** replies written */
  stored: number;
  /** requests not sent because of the store — a lower bound: a node hit counts the one poll a served solve needs */
  requestsSaved: number;
  /** reply bytes (uncompressed) served from the store */
  bytesServed: number;
}

const emptyCounters = (): Counters => ({ startedMs: Date.now(), treeHits: 0, treeMisses: 0, materialised: 0, nodeHits: 0, negHits: 0, nodeMisses: 0, stored: 0, requestsSaved: 0, bytesServed: 0 });

/** A node's worth in requests: a served node is one poll, a no-node verdict was two (the read and its grace retry). */
const savedFor = (status: number) => (status === NO_NODE ? 2 : 1);

const DDL = `
CREATE TABLE IF NOT EXISTS gtow_cache_trees (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  last_hit_ms INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  body BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS gtow_cache_nodes (
  key TEXT NOT NULL,
  addr TEXT NOT NULL,
  status INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  last_hit_ms INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  reply BLOB,
  PRIMARY KEY (key, addr)
);
CREATE INDEX IF NOT EXISTS idx_gtow_cache_nodes_hit ON gtow_cache_nodes(last_hit_ms);
CREATE INDEX IF NOT EXISTS idx_gtow_cache_trees_hit ON gtow_cache_trees(last_hit_ms);
CREATE TABLE IF NOT EXISTS gtow_cache_totals (name TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
`;
// (The blobs are the LAST column and the tables keep their rowid: SQLite reads a row's small columns without walking its
//  overflow pages only when they come first, and it advises against WITHOUT ROWID for rows this size — a node reply is
//  tens to hundreds of KB even gzipped. The totals table is tiny rows, where WITHOUT ROWID is the right call.)

function assertTestSafePath(path: string): void {
  if (process.env.NODE_ENV !== "test") return;
  if (path === ":memory:" || path.startsWith("file::memory:")) return;
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(realpathSync(tmpdir())), norm(path));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return;
  throw new Error(`gtowSolveCache: refusing to open ${path} under bun test — tests must use a temp file (GTOW_CACHE_DB_PATH)`);
}

/** The local calendar day, for the "hits today" totals. */
const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const gzip = (s: string): Uint8Array => Bun.gzipSync(Buffer.from(s));
const gunzip = (b: Uint8Array): string => new TextDecoder().decode(Bun.gunzipSync(b as Uint8Array<ArrayBuffer>));

/**
 * THE ROW COUNTERS (2026-10-09). The cache's size used to be COUNTED: COUNT/SUM over both tables (and a SUM in the size
 * cap check every 500 writes) — full scans of a 1.5 GB file on the live API's thread, 6–15 s each, every 10 s while the
 * accounts page or /gtow-status was polled. Now four counters live in gtow_cache_totals (rows_trees, rows_nodes,
 * rows_neg, rows_bytes), changed in the SAME transaction as every insert, verdict upgrade, age deletion and eviction,
 * by every process that writes the file. `rows_seeded` says they are valid. A new file starts seeded at zero; a file from
 * before the counters is counted ONCE by a scan in a Bun Worker (services/gtowCacheScanWorker.ts: its own read-only
 * connection, its own thread — never this loop), held while a poker session is live; until then the counts read null
 * ("counting…") and the size cap waits for them.
 */
const COUNTERS = ["rows_trees", "rows_nodes", "rows_neg", "rows_bytes"] as const;
type CounterDelta = { trees: number; nodes: number; neg: number; bytes: number };
const zeroDelta = (): CounterDelta => ({ trees: 0, nodes: 0, neg: 0, bytes: 0 });
/** an unseeded file is asked to be counted again at most this often (while a session is live it waits) */
const SEED_RETRY_MS = 5 * 60_000;
/** the GET /api/gtow/cache "recent hits" list comes from the worker, memoised this long */
const RECENT_MEMO_MS = 60_000;

export interface GtowCacheSummary {
  enabled: boolean;
  /** null while the counters are not seeded yet ("counting…") */
  trees: number | null;
  nodes: number | null;
  mb: number;
  today: string;
  hitsToday: number;
  savedToday: number;
}

export class GtowSolveCache {
  readonly path: string | null;
  readonly enabled: boolean;
  private db: Database | null = null;
  private dbFailed = false;
  /** the file could not be opened: this process keeps a memory-only cache */
  memoryOnly = false;
  private readonly days: number;
  private readonly maxBytes: number;
  private readonly flushMs: number;
  /** trees this process created whose first node is not stored yet — the row is written WITH that node */
  private fresh = new Map<string, { kind: CacheKind; body: string }>();
  /** keys this process knows to be in the store (skips a lookup per write) */
  private known = new Set<string>();
  /** gzipped bodies of trees handed out lately — a materialisation must never find its tree evicted under it */
  private bodies = new Map<string, { kind: CacheKind; gz: Uint8Array }>();
  private pendingTrees = new Map<string, { kind: CacheKind; body: string; at: number }>();
  private pendingNodes = new Map<string, { key: string; addr: string; status: number; raw: string | null; at: number }>();
  private touches = new Map<string, { key: string; addr: string | null; n: number; at: number }>();
  private totals = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private maintTimer: ReturnType<typeof setInterval> | null = null;
  private maintaining: Promise<MaintenanceResult> | null = null;
  private lastRetention = 0;
  private summaryAt = 0;
  private summaryMemo: GtowCacheSummary | null = null;
  /** the counters are valid in the file (rows_seeded) — re-read inside every write transaction */
  private seeded = false;
  /** a seeding scan in flight, and what this process wrote while it ran (added to the scan's totals) */
  private seeding: Promise<boolean> | null = null;
  private seedDelta: CounterDelta | null = null;
  private seedTriedAt = 0;
  private recentMemo: { at: number; recent: ScanRecent[]; refreshing: boolean } | null = null;
  /** test hooks: the off-loop scan, and whether a session is live */
  scanOffLoop: (path: string, recent: number) => Promise<ScanReply> = runScanWorker;
  liveNow: () => boolean = () => { try { return sessionLive(); } catch { return false; } };
  readonly since: Counters = emptyCounters();

  constructor(opts: SolveCacheOptions = {}) {
    this.path = opts.path ?? null;
    this.enabled = (opts.enabled ?? true) && this.path != null;
    this.days = opts.days ?? DEFAULT_CACHE_DAYS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_CACHE_MAX_MB * MB;
    this.flushMs = opts.flushMs ?? FLUSH_MS;
    if (this.enabled && this.path) assertTestSafePath(this.path);
    const archiveDir = opts.archiveDir !== undefined ? opts.archiveDir
      : this.enabled && this.path && this.path !== ":memory:" ? archiveDirFor(this.path) : null;
    this.archive = archiveDir ? new GtowCacheArchive(archiveDir, DDL) : null;
    // offline scripts (replay gate, studies) may opt in to reading the archive after a hot miss; the live API never does
    this.readArchive = process.env.GTOW_CACHE_ARCHIVE_READ === "1";
  }

  /** the cold archive evicted / expired rows are moved to (null = none) */
  readonly archive: GtowCacheArchive | null;
  private readonly readArchive: boolean;

  // ── the database ───────────────────────────────────────────────────────────────────────────────────────────────
  private open(): Database | null {
    if (!this.enabled) return null;
    if (this.db) return this.db;
    if (this.dbFailed) return null;
    try {
      const fresh = this.path !== ":memory:" && !existsSync(this.path!);
      const db = openStore(this.path!);
      // a NEW file can shrink after an eviction (incremental vacuum); an existing one keeps its mode — the cap counts
      // the stored bytes, not the file, so either way it holds. (The WAL switch has already written the header, so the
      // mode only takes with a VACUUM — instant on a file with nothing in it.)
      if (fresh) { db.exec("PRAGMA auto_vacuum = INCREMENTAL"); db.exec("VACUUM"); }
      this.db = db;
      this.init(db, fresh);
    } catch (e) {
      // the cache is worth having but never worth an answer: a file that cannot be opened leaves memory only
      console.error(`[gtow-cache] cannot open ${this.path} — the solve cache stays in memory for this process: ${e instanceof Error ? e.message : e}`);
      try {
        const db = new Database(":memory:");
        this.db = db;
        this.memoryOnly = true;
        this.init(db, true);
      } catch {
        this.dbFailed = true;
      }
    }
    return this.db;
  }

  private init(db: Database, fresh = false): void {
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(DDL);
    // a file with no rows at all is exact at zero (a new file, or one never written): seeded on the spot
    if (!this.readSeeded(db) && (fresh || !db.query("SELECT 1 FROM gtow_cache_trees LIMIT 1").get())) {
      const put = db.prepare("INSERT OR REPLACE INTO gtow_cache_totals (name, n) VALUES (?, ?)");
      db.transaction(() => { for (const c of COUNTERS) put.run(c, 0); put.run("rows_seeded", Date.now()); })();
    }
    this.seeded = this.readSeeded(db);
    if (!this.seeded) this.seedSoon();
    this.scheduleMaintenance();
  }

  /** The maintenance window's timer (a file cache only; the first check a minute after open). Never keeps a process up. */
  private scheduleMaintenance(): void {
    if (this.maintTimer || !this.path || this.path === ":memory:" || this.memoryOnly || process.env.NODE_ENV === "test") return;
    const kick = () => { void this.maintenance().catch((e) => console.error(`[gtow-cache] maintenance failed: ${e instanceof Error ? e.message : e}`)); };
    const first = setTimeout(kick, 60_000);
    (first as { unref?: () => void }).unref?.();
    this.maintTimer = setInterval(kick, MAINT_CHECK_MS);
    (this.maintTimer as { unref?: () => void }).unref?.();
  }

  private readSeeded(db: Database): boolean {
    try { return !!db.query("SELECT 1 FROM gtow_cache_totals WHERE name = 'rows_seeded'").get(); } catch { return false; }
  }

  /** Add a delta to the counters inside the caller's transaction (only once they are seeded). */
  private bump(db: Database, d: CounterDelta): void {
    if (!d.trees && !d.nodes && !d.neg && !d.bytes) return;
    if (this.readSeeded(db)) {
      const add = db.prepare("INSERT INTO gtow_cache_totals (name, n) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET n = n + excluded.n");
      if (d.trees) add.run("rows_trees", d.trees);
      if (d.nodes) add.run("rows_nodes", d.nodes);
      if (d.neg) add.run("rows_neg", d.neg);
      if (d.bytes) add.run("rows_bytes", d.bytes);
    } else if (this.seedDelta) {
      this.seedDelta.trees += d.trees; this.seedDelta.nodes += d.nodes; this.seedDelta.neg += d.neg; this.seedDelta.bytes += d.bytes;
    }
  }

  /** The counters, or null while unseeded — four primary-key reads of a tiny table, never a scan. */
  private counters(): ScanRows | null {
    const db = this.open();
    if (!db) return null;
    try {
      const m = new Map(db.query<{ name: string; n: number }, []>(
        "SELECT name, n FROM gtow_cache_totals WHERE name IN ('rows_seeded','rows_trees','rows_nodes','rows_neg','rows_bytes')").all().map((r) => [r.name, r.n]));
      this.seeded = m.has("rows_seeded");
      if (!this.seeded) return null;
      return { trees: m.get("rows_trees") ?? 0, nodes: m.get("rows_nodes") ?? 0, negatives: m.get("rows_neg") ?? 0, storedBytes: m.get("rows_bytes") ?? 0 };
    } catch { return null; }
  }

  /** Count an unseeded file once, OFF the loop (a Worker), never while a poker session is live. */
  private seedSoon(force = false): void {
    if (this.seeded || this.seeding || !this.path || this.path === ":memory:" || this.memoryOnly) return;
    const now = Date.now();
    if (!force && now - this.seedTriedAt < SEED_RETRY_MS && this.seedTriedAt) return;
    this.seedTriedAt = now;
    if (this.liveNow()) { console.log("[gtow-cache] row counters not seeded yet — the counting scan waits: a poker session is live"); return; }
    this.flush();
    this.seedDelta = zeroDelta();
    this.seeding = this.scanOffLoop(this.path, 0).then((r) => {
      if (!r.ok) { console.warn(`[gtow-cache] counting scan failed (retried later): ${r.error}`); return false; }
      const d = this.seedDelta ?? zeroDelta();
      const db = this.open();
      if (!db) return false;
      const put = db.prepare("INSERT OR REPLACE INTO gtow_cache_totals (name, n) VALUES (?, ?)");
      db.transaction(() => {
        if (this.readSeeded(db)) return;   // another process seeded it meanwhile
        put.run("rows_trees", r.rows.trees + d.trees); put.run("rows_nodes", r.rows.nodes + d.nodes);
        put.run("rows_neg", r.rows.negatives + d.neg); put.run("rows_bytes", r.rows.storedBytes + d.bytes);
        put.run("rows_seeded", Date.now());
      })();
      this.seeded = true;
      this.summaryMemo = null;
      console.log(`[gtow-cache] row counters seeded off the loop in ${r.ms} ms: ${r.rows.trees} trees, ${r.rows.nodes} nodes, ${(r.rows.storedBytes / MB).toFixed(1)} MB stored`);
      return true;
    }).catch((e) => { console.warn(`[gtow-cache] counting scan failed (retried later): ${e instanceof Error ? e.message : e}`); return false; })
      .finally(() => { this.seeding = null; this.seedDelta = null; });
  }

  /** Wait for a seeding scan in flight (tests, scripts). */
  async whenSeeded(): Promise<boolean> { if (this.seeding) await this.seeding; return this.seeded; }

  /**
   * ONE MAINTENANCE PASS, only while no poker session is live (see MAINT_BUDGET_MS): count the file if its counters are
   * not seeded (the Worker), the retention sweep (rows not hit for `days`, a tree with its nodes), eviction while the
   * stored bytes exceed the cap (least-recently-hit nodes to 90% of it, then the trees left with no node), the freed pages
   * given back to the file (incremental vacuum), a PASSIVE WAL checkpoint. Every batch is a transaction of at most
   * MAINT_BUDGET_MS that moves the row counters with the rows; between batches the live check — a session that starts
   * stops the pass (the rest waits for the next window). One line when it starts and one when it ends.
   */
  async maintenance(): Promise<MaintenanceResult> {
    if (this.maintaining) return this.maintaining;
    const res: MaintenanceResult = { ran: false, why: "", rows: 0, archived: 0, freedBytes: 0, filePagesFreed: 0, batches: 0, ms: 0, maxMs: { delete: 0, commit: 0, vacuum: 0, checkpoint: 0 } };
    const db = this.open();
    if (!db || this.memoryOnly || !this.path || this.path === ":memory:") return { ...res, why: "no file" };
    if (this.liveNow()) return { ...res, why: "a poker session is live" };
    // smaller automatic checkpoints while it runs: a checkpoint fsyncs what it copied, and one over a big WAL held a
    // commit 477 ms in the 2026-10-09 dry run (1.5 GB → 455 MB); 1000 pages (SQLite's default) comes back after
    try { db.exec(`PRAGMA wal_autocheckpoint = ${MAINT_WAL_CHECKPOINT_PAGES}`); } catch { /* the default stays */ }
    this.maintaining = this.runMaintenance(db, res).finally(() => {
      this.maintaining = null;
      try { db.exec("PRAGMA wal_autocheckpoint = 1000"); } catch { /* closed */ }
    });
    return this.maintaining;
  }

  private async runMaintenance(db: Database, res: MaintenanceResult): Promise<MaintenanceResult> {
    const t0 = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const stop = () => (this.liveNow() ? "a poker session started" : undefined);
    if (!this.seeded) { this.seedSoon(true); await this.whenSeeded(); }
    const c0 = this.counters();
    if (!c0) return { ...res, why: "row counters not seeded yet" };
    const now = Date.now();
    const cutoff = now - this.days * DAY_MS;
    const retention = now - this.lastRetention >= RETENTION_EVERY_MS;
    const over = c0.storedBytes > this.maxBytes;
    const free0 = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    if (!retention && !over && !free0) return { ...res, why: "nothing to do" };
    this.flush();
    // THE ARCHIVE FIRST: no row leaves the hot file unless it can be copied (an archive that cannot be opened stops the
    // pass before anything is deleted)
    let copy: ReturnType<GtowCacheArchive["copiers"]> | null = null;
    if (this.archive) {
      try { res.archivedTo = this.archive.attach(db); copy = this.archive.copiers(db); }
      catch (e) {
        this.archive.detach(db);
        console.error(`[gtow-cache] maintenance skipped: the cold archive ${this.archive.dir} cannot be opened — nothing is deleted without it: ${e instanceof Error ? e.message : e}`);
        return { ...res, why: "the cold archive cannot be opened" };
      }
    }
    res.ran = true;
    res.why = [retention ? `retention ${this.days} d` : "", over ? `${(c0.storedBytes / MB).toFixed(0)} MB stored over the ${(this.maxBytes / MB).toFixed(0)} MB cap` : "", free0 ? `${free0} free pages` : ""].filter(Boolean).join(", ");
    console.log(`[gtow-cache] maintenance start (no session live): ${res.why} — file ${(this.fileBytes() / MB).toFixed(1)} MB, ${c0.trees} trees, ${c0.nodes} nodes, ${(c0.storedBytes / MB).toFixed(1)} MB stored`);
    const delNode = db.prepare("DELETE FROM gtow_cache_nodes WHERE key = ? AND addr = ?");
    const delTree = db.prepare("DELETE FROM gtow_cache_trees WHERE key = ?");
    const nodesOf = db.prepare<{ addr: string; status: number; bytes: number }, [string]>("SELECT addr, status, bytes FROM gtow_cache_nodes WHERE key = ? LIMIT 64");
    const orphan = db.prepare<{ bytes: number }, [string, string]>("SELECT bytes FROM gtow_cache_trees WHERE key = ? AND NOT EXISTS (SELECT 1 FROM gtow_cache_nodes WHERE key = ?)");
    /** one transaction of at most MAINT_BUDGET_MS: `step` deletes one unit and returns false when there is no more */
    let phase = "retention";
    const batch = (step: (d: CounterDelta, deadline: number) => boolean): boolean => {
      let more = true;
      const rows0 = res.rows;
      const t = performance.now();
      const deadline = t + MAINT_BUDGET_MS * 0.5;   // the commit gets the rest of the budget
      let tc = t;
      db.transaction(() => {
        const d = zeroDelta();
        // bounded three ways: time, rows and bytes — the COMMIT is what costs (it writes every page the deletes dirtied,
        // and a checkpoint may run in it): 2,108 small rows in 30 ms of deletes took a 1.37 s commit in the dry run
        let units = 0;
        while ((more = step(d, deadline)) && performance.now() < deadline && ++units < MAINT_BATCH_ROWS && -d.bytes < MAINT_BATCH_BYTES) { /* next unit */ }
        this.bump(db, d);
        res.freedBytes -= d.bytes;
        tc = performance.now();
      })();
      const end = performance.now();
      if (!res.slowest || end - t > res.slowest.ms) res.slowest = { phase, batch: res.batches + 1, ms: Math.round(end - t), rows: res.rows - rows0 };
      res.maxMs.delete = Math.max(res.maxMs.delete, Math.round(end - t));
      res.maxMs.commit = Math.max(res.maxMs.commit, Math.round(end - tc));
      res.batches++;
      return more;
    };
    const dropNode = (d: CounterDelta, key: string, r: { addr: string; status: number; bytes: number }) => {
      copy?.node(key, r.addr);
      if (!delNode.run(key, r.addr).changes) return;
      if (copy) res.archived++;
      d.nodes--; d.bytes -= r.bytes; if (r.status !== NODE_OK) d.neg--; res.rows++;
    };
    const dropTreeIfEmpty = (d: CounterDelta, key: string) => {
      const t = orphan.get(key, key);
      if (!t) return;
      copy?.tree(key);
      if (delTree.run(key).changes) { d.trees--; d.bytes -= t.bytes; res.rows++; if (copy) res.archived++; }
    };
    try {
    // 1. retention: old nodes, then old trees with whatever nodes they still have
    if (retention) {
      const oldNodes = db.prepare<{ key: string; addr: string; status: number; bytes: number }, [number]>(
        "SELECT key, addr, status, bytes FROM gtow_cache_nodes WHERE last_hit_ms < ? ORDER BY last_hit_ms LIMIT 1");
      const oldTree = db.prepare<{ key: string; bytes: number }, [number]>("SELECT key, bytes FROM gtow_cache_trees WHERE last_hit_ms < ? ORDER BY last_hit_ms LIMIT 1");
      for (let more = true; more;) {
        if ((res.stoppedBy = stop())) break;
        more = batch((d) => { const r = oldNodes.get(cutoff); if (!r) return false; dropNode(d, r.key, r); dropTreeIfEmpty(d, r.key); return true; });
        await sleep(MAINT_YIELD_MS);
      }
      for (let more = !res.stoppedBy; more;) {
        if ((res.stoppedBy = stop())) break;
        more = batch((d) => {
          const t = oldTree.get(cutoff);
          if (!t) return false;
          const ns = nodesOf.all(t.key);
          for (const r of ns) dropNode(d, t.key, r);
          if (ns.length < 64) { copy?.tree(t.key); if (delTree.run(t.key).changes) { d.trees--; d.bytes -= t.bytes; res.rows++; if (copy) res.archived++; } }
          return true;
        });
        await sleep(MAINT_YIELD_MS);
      }
      if (!res.stoppedBy) {
        db.query("DELETE FROM gtow_cache_totals WHERE name LIKE 'd:%' AND name < ?").run(`d:${dayOf(cutoff)}`);
        this.lastRetention = now;
      }
    }
    // 2. eviction to 90% of the cap, least recently hit first
    const target = this.maxBytes * 0.9;
    const oldest = db.prepare<{ key: string; addr: string; status: number; bytes: number }, []>(
      "SELECT key, addr, status, bytes FROM gtow_cache_nodes ORDER BY last_hit_ms LIMIT 1");
    let stored = this.counters()?.storedBytes ?? 0;
    phase = "eviction";
    if (stored > this.maxBytes) {
      for (let more = true; more && stored > target;) {
        if ((res.stoppedBy = stop())) break;
        more = batch((d) => {
          if (stored + d.bytes <= target) return false;
          const r = oldest.get();
          if (!r) return false;
          dropNode(d, r.key, r); dropTreeIfEmpty(d, r.key);
          return true;
        });
        stored = this.counters()?.storedBytes ?? 0;
        await sleep(MAINT_YIELD_MS);
      }
      this.known.clear();
    }
    } finally {
      this.archive?.detach(db);
    }
    // 3. the freed pages back to the file, a step re-sized to fit the budget
    let pages = VACUUM_STEP0;
    for (;;) {
      if ((res.stoppedBy ??= stop())) break;
      const free = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
      if (!free) break;
      const t = performance.now();
      db.exec(`PRAGMA incremental_vacuum(${Math.min(free, pages)})`);
      const took = performance.now() - t;
      res.maxMs.vacuum = Math.max(res.maxMs.vacuum, Math.round(took));
      res.filePagesFreed += Math.min(free, pages);
      res.batches++;
      // re-size the step to 30% of the budget, growing at most 1.5x a step (a step's cost varies with the WAL checkpoints)
      pages = Math.max(16, Math.min(VACUUM_STEP_MAX, Math.ceil(pages * 1.5), Math.round(pages * (MAINT_BUDGET_MS * 0.3) / Math.max(1, took))));
      await sleep(MAINT_YIELD_MS);
    }
    // 4. the WAL folded back in (PASSIVE: never waits on a reader)
    if (!res.stoppedBy) {
      const t = performance.now();
      try { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* the next window */ }
      res.maxMs.checkpoint = Math.round(performance.now() - t);
    }
    res.ms = Date.now() - t0;
    const c1 = this.counters();
    this.summaryMemo = null;
    console.log(`[gtow-cache] maintenance end${res.stoppedBy ? ` — STOPPED: ${res.stoppedBy}` : ""}: ${res.rows} rows and ${(res.freedBytes / MB).toFixed(1)} MB freed (${res.archived} archived${res.archivedTo ? ` to ${res.archivedTo}` : ""}), ${res.filePagesFreed} pages (${(res.filePagesFreed * 4096 / MB).toFixed(1)} MB) given back to the file, ${res.batches} batches in ${(res.ms / 1000).toFixed(1)} s (longest: delete ${res.maxMs.delete} ms, of it commit ${res.maxMs.commit} ms, vacuum step ${res.maxMs.vacuum} ms, checkpoint ${res.maxMs.checkpoint} ms) — now ${(this.fileBytes() / MB).toFixed(1)} MB file, ${(((c1?.storedBytes) ?? 0) / MB).toFixed(1)} MB stored`);
    return res;
  }

  // ── trees ──────────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * Is this tree in the store? `count` (the default) is a HAND-OUT: the caller is about to use the synthetic id instead
   * of creating the solve, which spares a tree POST and a solution POST. A peek passes count=false.
   */
  hasTree(key: string, count = true): boolean {
    if (!this.enabled) return false;
    let hit = this.pendingTrees.has(key);
    if (!hit) {
      try {
        const row = this.open()?.query<{ kind: CacheKind; body: Uint8Array }, [string]>("SELECT kind, body FROM gtow_cache_trees WHERE key = ?").get(key);
        if (row) { hit = true; this.known.add(key); this.keepBody(key, row.kind, row.body); }
      } catch { /* a read failure is a miss */ }
    }
    if (hit && count) {
      this.since.treeHits++;
      this.since.requestsSaved += 2;
      this.touch(key, null);
      this.add("treeHits", 1);
      this.add("saved", 2, true);
    }
    return hit;
  }

  private keepBody(key: string, kind: CacheKind, gz: Uint8Array): void {
    this.bodies.delete(key);
    this.bodies.set(key, { kind, gz });
    while (this.bodies.size > BODIES_MAX) this.bodies.delete(this.bodies.keys().next().value as string);
  }

  /** What was POSTed for a stored tree — for materialising it. null when the store does not hold it. */
  treeBody(key: string): { kind: CacheKind; tree: any; solution: { actions: string; board: string }; locks: any[] } | null {
    try {
      const pend = this.pendingTrees.get(key) ?? this.fresh.get(key);
      let kind: CacheKind | null = null, text: string | null = null;
      if (pend) { kind = pend.kind; text = pend.body; }
      else {
        let b = this.bodies.get(key) ?? null;
        if (!b && this.enabled) {
          const row = this.open()?.query<{ kind: CacheKind; body: Uint8Array }, [string]>("SELECT kind, body FROM gtow_cache_trees WHERE key = ?").get(key);
          if (row) b = { kind: row.kind, gz: row.body };
        }
        if (b) { kind = b.kind; text = gunzip(b.gz); }
      }
      if (!kind || text == null) return null;
      const j = JSON.parse(text) as PostedTree;
      return { kind, tree: j.tree, solution: j.solution, locks: Array.isArray(j.locks) ? j.locks : [] };
    } catch {
      return null;
    }
  }

  /**
   * A tree this process created afresh (the store did not hold it). Nothing is written yet: the row goes in with the
   * tree's first stored node — a tree whose solve never answered is not worth a row.
   */
  noteTree(key: string, kind: CacheKind, body: string): void {
    if (!this.enabled) return;
    this.since.treeMisses++;
    this.add("treeMisses", 1);
    this.fresh.delete(key);
    this.fresh.set(key, { kind, body });
    while (this.fresh.size > FRESH_MAX) this.fresh.delete(this.fresh.keys().next().value as string);
  }

  /** A stored tree a node miss made an account mint after all: the two POSTs its hand-out spared were spent. */
  noteMaterialised(_key: string): void {
    if (!this.enabled) return;
    this.since.materialised++;
    this.since.requestsSaved -= 2;
    this.add("materialised", 1);
    this.add("saved", -2, true);
  }

  // ── nodes ──────────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * A node from the store, or null. `count` (the default) records a hit or a miss; a peek passes false. A hit replaces
   * the request, so it counts the requests it spared.
   */
  getNode(key: string, addr: string, count = true): StoredNode | null {
    if (!this.enabled) return null;
    let got: StoredNode | null = null;
    try {
      const pend = this.pendingNodes.get(`${key}|${addr}`);
      if (pend) got = this.decode(pend.status, pend.raw);
      else {
        const row = this.open()?.query<{ status: number; reply: Uint8Array | null }, [string, string]>(
          "SELECT status, reply FROM gtow_cache_nodes WHERE key = ? AND addr = ?").get(key, addr);
        if (row) got = this.decode(row.status, row.reply ? gunzip(row.reply) : null);
        else if (this.readArchive && this.archive) {
          const r = this.archive.lookupNode(key, addr);
          if (r) got = this.decode(r.status, r.reply ? gunzip(r.reply) : null);
        }
      }
    } catch {
      got = null;   // a corrupt or unreadable row is a miss: the caller asks GTO Wizard, and the reply replaces it
    }
    if (count) this.countNode(key, addr, got);
    return got;
  }

  /**
   * A node from the hot file, else from the COLD ARCHIVE (point lookups, read-only) — for viewing old answers (the hand
   * page's "open the exact node") and offline scripts. Never counted as a hit or a miss. NOT for the live answer path.
   */
  getNodeArchived(key: string, addr: string): StoredNode | null {
    const hot = this.getNode(key, addr, false);
    if (hot || !this.archive) return hot;
    try {
      const r = this.archive.lookupNode(key, addr);
      return r ? this.decode(r.status, r.reply ? gunzip(r.reply) : null) : null;
    } catch { return null; }
  }

  /**
   * Count one lookup: `served` is what the caller was actually served (a hit: it replaces requests), null a miss. A
   * caller that looks a node up and then declines a stored verdict (gtowApi serves NO_NODE to its prefetch only)
   * counts the lookup itself, as a miss.
   */
  countNode(key: string, addr: string, served: StoredNode | null): void {
    if (!this.enabled) return;
    if (served) {
      if (served.status === NODE_OK) this.since.nodeHits++; else this.since.negHits++;
      const saved = savedFor(served.status);
      this.since.requestsSaved += saved;
      this.since.bytesServed += served.bytes;
      this.touch(key, addr);
      this.touch(key, null);
      this.add("hits", 1, true);
      this.add("saved", saved, true);
      this.add("bytes", served.bytes);
    } else {
      this.since.nodeMisses++;
      this.add("misses", 1);
    }
  }

  private decode(status: number, raw: string | null): StoredNode | null {
    if (status === NODE_OK) {
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data?.action_solutions?.length ? { status, data, text: null, bytes: raw.length } : null;
    }
    // a stored refusal that is an auth body (never written since 2026-10-08; one from before would answer for ever) is
    // a miss: the caller asks GTO Wizard again
    if (REFUSALS.has(status) && !isLineVerdict(status, raw)) return null;
    return { status, data: null, text: raw, bytes: raw?.length ?? 0 };
  }

  /**
   * Keep a reply. Only what is a fact about the solve: a full node (NODE_OK with its raw JSON), GTO Wizard's no-node
   * verdict (NO_NODE) and its refusal of the line (-400/-422 with the refusal's body). Anything else is ignored. The
   * tree's row goes in with its first node; a node of a tree the store has never seen (its body lost) is not kept —
   * nothing could reach it after a restart.
   */
  putNode(key: string, addr: string, status: number, raw: string | null): void {
    if (!this.enabled) return;
    if (status === NODE_OK) {
      if (!raw) return;
    } else if (status === NO_NODE) {
      raw = null;
    } else if (REFUSALS.has(status)) {
      // a verdict about the line, never an auth refusal: "Invalid API Key" says nothing about the tree (2026-10-08)
      if (!raw || !isLineVerdict(status, raw)) return;
      raw = raw.slice(0, 2000);
    } else {
      return;
    }
    const nk = `${key}|${addr}`;
    const pend = this.pendingNodes.get(nk);
    if (pend && !(status === NODE_OK && pend.status !== NODE_OK)) return;
    if (!this.pendingTrees.has(key) && !this.known.has(key)) {
      const f = this.fresh.get(key);
      if (f) {
        this.pendingTrees.set(key, { kind: f.kind, body: f.body, at: Date.now() });
        this.fresh.delete(key);
      } else if (!this.treeInStore(key)) {
        return;
      }
    }
    this.pendingNodes.set(nk, { key, addr, status, raw, at: Date.now() });
    this.since.stored++;
    this.add("stored", 1);
    this.schedule();
  }

  private treeInStore(key: string): boolean {
    try {
      const hit = !!this.open()?.query("SELECT 1 FROM gtow_cache_trees WHERE key = ?").get(key);
      if (hit) this.known.add(key);
      return hit;
    } catch {
      return false;
    }
  }

  // ── bookkeeping ────────────────────────────────────────────────────────────────────────────────────────────────
  private touch(key: string, addr: string | null): void {
    const tk = addr == null ? `t|${key}` : `n|${key}|${addr}`;
    const t = this.touches.get(tk);
    if (t) { t.n++; t.at = Date.now(); } else this.touches.set(tk, { key, addr, n: 1, at: Date.now() });
    this.schedule();
  }

  /** A persisted total (all processes, all time); `daily` also counts it on today's row. */
  private add(name: string, n: number, daily = false): void {
    this.totals.set(name, (this.totals.get(name) ?? 0) + n);
    if (daily) {
      const d = `d:${dayOf(Date.now())}:${name}`;
      this.totals.set(d, (this.totals.get(d) ?? 0) + n);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer || !this.enabled) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.flushMs);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  /** Write everything pending in one transaction. Never throws — a failed flush keeps its rows for the next one. */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.enabled || (!this.pendingNodes.size && !this.pendingTrees.size && !this.touches.size && !this.totals.size)) return;
    const db = this.open();
    if (!db) return;
    const trees = [...this.pendingTrees.entries()];
    const nodes = [...this.pendingNodes.values()];
    const touches = [...this.touches.values()];
    const totals = [...this.totals.entries()];
    try {
      // the gzip happens here, off the answer's path
      const treeRows = trees.map(([key, t]) => { const gz = gzip(t.body); return { key, kind: t.kind, gz, at: t.at }; });
      const nodeRows = nodes.map((x) => { const gz = x.raw != null ? gzip(x.raw) : null; return { ...x, gz }; });
      const insTree = db.prepare("INSERT OR IGNORE INTO gtow_cache_trees (key, kind, bytes, created_ms, last_hit_ms, hits, body) VALUES (?,?,?,?,?,0,?)");
      // the first reply for a node stays (two processes storing the same node store the same thing) — except that a
      // FULL node replaces a stored verdict: a node GTO Wizard has since answered was never missing
      const insNode = db.prepare(`INSERT INTO gtow_cache_nodes (key, addr, status, bytes, created_ms, last_hit_ms, hits, reply) VALUES (?,?,?,?,?,?,0,?)
        ON CONFLICT(key, addr) DO UPDATE SET status = excluded.status, bytes = excluded.bytes, reply = excluded.reply
        WHERE excluded.status = ${NODE_OK} AND gtow_cache_nodes.status <> ${NODE_OK}`);
      const hitTree = db.prepare("UPDATE gtow_cache_trees SET last_hit_ms = MAX(last_hit_ms, ?), hits = hits + ? WHERE key = ?");
      const hitNode = db.prepare("UPDATE gtow_cache_nodes SET last_hit_ms = MAX(last_hit_ms, ?), hits = hits + ? WHERE key = ? AND addr = ?");
      const addTotal = db.prepare("INSERT INTO gtow_cache_totals (name, n) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET n = n + excluded.n");
      const before = db.prepare<{ status: number; bytes: number }, [string, string]>("SELECT status, bytes FROM gtow_cache_nodes WHERE key = ? AND addr = ?");
      db.transaction(() => {
        // the row counters move with the rows (see COUNTERS): a new tree, a new node, a verdict replaced by a full node
        const d = zeroDelta();
        for (const t of treeRows) if (insTree.run(t.key, t.kind, t.gz.byteLength, t.at, t.at, t.gz).changes) { d.trees++; d.bytes += t.gz.byteLength; }
        for (const x of nodeRows) {
          const was = before.get(x.key, x.addr);
          const bytes = x.gz?.byteLength ?? 0;
          if (!insNode.run(x.key, x.addr, x.status, bytes, x.at, x.at, x.gz).changes) continue;
          if (!was) { d.nodes++; d.bytes += bytes; if (x.status !== NODE_OK) d.neg++; }
          else { d.bytes += bytes - was.bytes; if (was.status !== NODE_OK && x.status === NODE_OK) d.neg--; }
        }
        this.bump(db, d);
        for (const t of touches) {
          if (t.addr == null) hitTree.run(t.at, t.n, t.key);
          else hitNode.run(t.at, t.n, t.key, t.addr);
        }
        for (const [name, n] of totals) if (n) addTotal.run(name, n);
      })();
      for (const [key] of trees) { this.pendingTrees.delete(key); this.known.add(key); }
      for (const x of nodes) this.pendingNodes.delete(`${x.key}|${x.addr}`);
      for (const t of touches) this.touches.delete(t.addr == null ? `t|${t.key}` : `n|${t.key}|${t.addr}`);
      for (const [name, n] of totals) { const left = (this.totals.get(name) ?? 0) - n; if (left) this.totals.set(name, left); else this.totals.delete(name); }
      // no maintenance here: the cap and retention wait for the maintenance window (no session live)
      if (!this.seeded) this.seedSoon();
    } catch (e) {
      console.error(`[gtow-cache] flush failed (kept for the next one): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Flush and release the file (tests; a process that is done with the cache). */
  close(): void {
    if (this.maintTimer) { clearInterval(this.maintTimer); this.maintTimer = null; }
    this.archive?.close();
    this.flush();
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }

  // ── what it holds, what it saved ───────────────────────────────────────────────────────────────────────────────
  private fileBytes(): number {
    if (!this.path || this.path === ":memory:" || this.memoryOnly) return 0;
    let n = 0;
    for (const f of [this.path, `${this.path}-wal`]) { try { n += statSync(f).size; } catch { /* absent */ } }
    return n;
  }

  private persistedTotals(): Record<string, number> {
    const out: Record<string, number> = {};
    try {
      // the totals table is a few hundred tiny rows (WITHOUT ROWID) — not the node tables
      for (const r of this.open()?.query<{ name: string; n: number }, []>("SELECT name, n FROM gtow_cache_totals").all() ?? []) out[r.name] = r.n;
    } catch { /* none */ }
    return out;
  }

  private statsBody(rows: ScanRows | null, recent: ScanRecent[]) {
    const all = this.persistedTotals();
    const today = dayOf(Date.now());
    return {
      enabled: this.enabled,
      path: this.path,
      memoryOnly: this.memoryOnly,
      fileBytes: this.fileBytes(),
      limits: { days: this.days, maxMb: Math.round(this.maxBytes / MB) },
      /** null while the row counters are not seeded yet ("counting…") */
      rows,
      since: { ...this.since },
      allTime: {
        hits: all.hits ?? 0, misses: all.misses ?? 0, treeHits: all.treeHits ?? 0, treeMisses: all.treeMisses ?? 0,
        materialised: all.materialised ?? 0, stored: all.stored ?? 0, requestsSaved: all.saved ?? 0, bytesServed: all.bytes ?? 0,
      },
      today: { day: today, hits: all[`d:${today}:hits`] ?? 0, requestsSaved: all[`d:${today}:saved`] ?? 0 },
      recent,
    };
  }

  /**
   * Everything GET /api/gtow/cache shows — the row counts from the counters (no scan), the "recent hits" list from
   * the Worker (memo 60 s, refreshed on demand behind the reply: the first call after a boot answers with an empty list).
   */
  statsOffLoop(recent = RECENT_MAX) {
    this.flush();
    const rows = this.counters();
    if (!rows) this.seedSoon();
    const m = this.recentMemo;
    if (this.path && this.path !== ":memory:" && !this.memoryOnly && recent > 0 && (!m || (Date.now() - m.at > RECENT_MEMO_MS && !m.refreshing))) {
      const memo = (this.recentMemo ??= { at: 0, recent: [], refreshing: false });
      memo.refreshing = true;
      void this.scanOffLoop(this.path, recent).then((r) => { if (r.ok) { memo.recent = r.recent; memo.at = Date.now(); } })
        .catch(() => { /* the list stays as it was */ }).finally(() => { memo.refreshing = false; });
    }
    return { ...this.statsBody(rows, (this.recentMemo?.recent ?? []).slice(0, recent)), recentAt: this.recentMemo?.at || null };
  }

  /**
   * The same, counted IN THIS THREAD (the recent list is a query here) — for tests and scripts only, never the live API:
   * the counters when seeded, a scan when not.
   */
  stats(recent = RECENT_MAX) {
    this.flush();
    const db = this.open();
    let rows = this.counters();
    let top: ScanRecent[] = [];
    try {
      if (db) {
        if (!rows) {
          const t = db.query<{ n: number; b: number | null }, []>("SELECT COUNT(*) n, SUM(bytes) b FROM gtow_cache_trees").get()!;
          const n = db.query<{ n: number; neg: number | null; b: number | null }, []>("SELECT COUNT(*) n, SUM(status <> 200) neg, SUM(bytes) b FROM gtow_cache_nodes").get()!;
          rows = { trees: t.n, nodes: n.n, negatives: n.neg ?? 0, storedBytes: (t.b ?? 0) + (n.b ?? 0) };
        }
        if (recent > 0) top = db.query<{ key: string; kind: string; addr: string; status: number; hits: number; last_hit_ms: number }, [number]>(
          `SELECT n.key, t.kind, n.addr, n.status, n.hits, n.last_hit_ms FROM gtow_cache_nodes n JOIN gtow_cache_trees t ON t.key = n.key
           WHERE n.hits > 0 ORDER BY n.last_hit_ms DESC LIMIT ?`).all(recent)
          .map((r) => ({ tree: r.key.slice(0, 12), kind: r.kind, addr: r.addr, status: r.status, hits: r.hits, lastHitMs: r.last_hit_ms }));
      }
    } catch { /* an unreadable store reports empty */ }
    return this.statsBody(rows ?? { trees: 0, nodes: 0, negatives: 0, storedBytes: 0 }, top);
  }

  /**
   * The one-line summary the accounts payload carries (memoised 10 s — the GTO Wizard tab polls every 5 s). NEVER A
   * SCAN: the row counters (four primary-key reads), the day's totals, the file's size from statSync. Unseeded counters
   * read null ("counting…") and ask the Worker to count, unless a session is live.
   */
  summary(): GtowCacheSummary {
    const now = Date.now();
    if (this.summaryMemo && now - this.summaryAt < 10_000) return this.summaryMemo;
    const rows = this.counters();
    if (!rows) this.seedSoon();
    const all = this.persistedTotals();
    const today = dayOf(now);
    const fileBytes = this.fileBytes();
    this.summaryMemo = {
      enabled: this.enabled, trees: rows?.trees ?? null, nodes: rows?.nodes ?? null,
      mb: Math.round(((fileBytes || rows?.storedBytes || 0) / MB) * 10) / 10,
      today, hitsToday: all[`d:${today}:hits`] ?? 0, savedToday: all[`d:${today}:saved`] ?? 0,
    };
    this.summaryAt = now;
    return this.summaryMemo;
  }
}

/** The counting scan in a Bun Worker (services/gtowCacheScanWorker.ts); a 2-minute bound, then it is given up on. */
export function runScanWorker(path: string, recent: number): Promise<ScanReply> {
  return new Promise<ScanReply>((resolveScan) => {
    let done = false;
    const w = new Worker(new URL("./gtowCacheScanWorker.ts", import.meta.url).href);
    const end = (r: ScanReply) => { if (done) return; done = true; clearTimeout(timer); try { w.terminate(); } catch { /* gone */ } resolveScan(r); };
    const timer = setTimeout(() => end({ ok: false, error: "the counting scan took over 2 min" }), 120_000);
    w.onmessage = (ev: MessageEvent<ScanReply>) => end(ev.data);
    w.onerror = (ev: ErrorEvent) => end({ ok: false, error: ev.message || "worker error" });
    w.postMessage({ path, recent });
  });
}

/**
 * The process's cache, from the environment: GTOW_CACHE=off or GTOW_CACHE_DB_PATH=off disable it; under bun test it is
 * off unless GTOW_CACHE_DB_PATH names a temp file. Every process shares the one file — the live worker, a replay, a
 * sweep: a hit is exact, so sharing it is only ever a request not sent. A script that must measure the cloud itself
 * (a latency bench, the pool-routing check) runs with GTOW_CACHE=off or passes { noCache: true }.
 */
export function solveCacheFromEnv(env: NodeJS.ProcessEnv = process.env): GtowSolveCache {
  const num = (v: string | undefined, d: number) => { const x = Number(v); return v != null && v.trim() !== "" && Number.isFinite(x) && x > 0 ? x : d; };
  const explicit = env.GTOW_CACHE_DB_PATH?.trim() ?? "";
  if (/^(off|0|false|no)$/i.test(env.GTOW_CACHE?.trim() ?? "") || /^off$/i.test(explicit)) return new GtowSolveCache({ enabled: false });
  // tests must not see each other's replies: only a test that names its own (temp) file gets a cache
  if (env.NODE_ENV === "test" && !explicit) return new GtowSolveCache({ enabled: false });
  const path = env === process.env ? gtowCachePath() : explicit ? resolve(explicit) : null;
  if (!path) return new GtowSolveCache({ enabled: false });
  return new GtowSolveCache({ path, days: num(env.GTOW_CACHE_DAYS, DEFAULT_CACHE_DAYS), maxBytes: num(env.GTOW_CACHE_MAX_MB, DEFAULT_CACHE_MAX_MB) * MB });
}

export const gtowSolveCache = solveCacheFromEnv();
// the last writes of a process that is going away (a flush is ≤ FLUSH_MS behind; this closes that gap on a clean exit)
if (gtowSolveCache.enabled) process.once("exit", () => gtowSolveCache.flush());
