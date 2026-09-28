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
 * RETENTION. At open: rows not hit for GTOW_CACHE_DAYS (60) are deleted, then, while the stored bytes exceed
 * GTOW_CACHE_MAX_MB (2048), the least-recently-hit nodes go (and every so many writes the cap is checked again).
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
import { gtowCachePath, openStore } from "./storePaths";

export type CacheKind = "pre" | "post";

/** A full node: a 200 with action_solutions. */
export const NODE_OK = 200;
/** GTO Wizard's verdict "no decision node on this line" (the solve is served; the line closes the street or ends the hand). */
export const NO_NODE = -204;
/** GTO Wizard's own refusals of a LINE, deterministic for the tree: stored as the negative HTTP status. */
const REFUSALS = new Set([-400, -422]);
/** the refusal bodies that are a verdict about the line (not a malformed request or a transient) */
export const DETERMINISTIC_REFUSAL = /NODE_DOES_NOT_EXIST|VALIDATION_ERROR|Incorrect actions/i;

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
const MAINTAIN_EVERY = 500;
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

export interface PostedTree { tree: unknown; solution: { actions: string; board: string } }

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
export function cacheKeyOf(kind: CacheKind, tree: unknown, solution: { actions: string; board: string }): TreeCacheKey {
  const posted: PostedTree = { tree, solution: { actions: solution.actions, board: solution.board } };
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

export interface GtowCacheSummary {
  enabled: boolean;
  trees: number;
  nodes: number;
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
  private writesSinceMaintain = 0;
  private summaryAt = 0;
  private summaryMemo: GtowCacheSummary | null = null;
  readonly since: Counters = emptyCounters();

  constructor(opts: SolveCacheOptions = {}) {
    this.path = opts.path ?? null;
    this.enabled = (opts.enabled ?? true) && this.path != null;
    this.days = opts.days ?? 60;
    this.maxBytes = opts.maxBytes ?? 2048 * MB;
    this.flushMs = opts.flushMs ?? FLUSH_MS;
    if (this.enabled && this.path) assertTestSafePath(this.path);
  }

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
      this.init(db);
      this.db = db;
    } catch (e) {
      // the cache is worth having but never worth an answer: a file that cannot be opened leaves memory only
      console.error(`[gtow-cache] cannot open ${this.path} — the solve cache stays in memory for this process: ${e instanceof Error ? e.message : e}`);
      try {
        const db = new Database(":memory:");
        this.init(db);
        this.db = db;
        this.memoryOnly = true;
      } catch {
        this.dbFailed = true;
      }
    }
    return this.db;
  }

  private init(db: Database): void {
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(DDL);
    this.maintain(db, Date.now(), true);
  }

  /**
   * Retention: rows not hit for `days` go, with the day totals past it; then, while the stored bytes exceed the cap,
   * the least-recently-hit nodes go (to 90% of it) and the trees left with no node follow them.
   */
  private maintain(db: Database, now: number, atOpen: boolean): void {
    try {
      let freed = 0;
      if (atOpen) {
        const cutoff = now - this.days * DAY_MS;
        freed += db.query("DELETE FROM gtow_cache_nodes WHERE last_hit_ms < ?").run(cutoff).changes;
        freed += db.query("DELETE FROM gtow_cache_trees WHERE last_hit_ms < ?").run(cutoff).changes;
        // the nodes of a tree that went: unreachable without its body
        freed += db.query("DELETE FROM gtow_cache_nodes WHERE key NOT IN (SELECT key FROM gtow_cache_trees)").run().changes;
        db.query("DELETE FROM gtow_cache_totals WHERE name LIKE 'd:%' AND name < ?").run(`d:${dayOf(cutoff)}`);
      }
      const live = () => (db.query<{ b: number | null }, []>("SELECT (SELECT COALESCE(SUM(bytes),0) FROM gtow_cache_nodes) + (SELECT COALESCE(SUM(bytes),0) FROM gtow_cache_trees) b").get()?.b ?? 0);
      let total = live();
      if (total > this.maxBytes) {
        const target = this.maxBytes * 0.9;
        const del = db.prepare("DELETE FROM gtow_cache_nodes WHERE key = ? AND addr = ?");
        // the small columns only (the blobs sit after them), read in full before any row is deleted
        const oldestFirst = db.query<{ key: string; addr: string; bytes: number }, []>("SELECT key, addr, bytes FROM gtow_cache_nodes ORDER BY last_hit_ms ASC").all();
        db.transaction(() => {
          for (const r of oldestFirst) {
            if (total <= target) break;
            del.run(r.key, r.addr);
            total -= r.bytes;
            freed++;
          }
          freed += db.query("DELETE FROM gtow_cache_trees WHERE key NOT IN (SELECT DISTINCT key FROM gtow_cache_nodes)").run().changes;
        })();
        total = live();
        this.known.clear();
        console.log(`[gtow-cache] over its ${(this.maxBytes / MB).toFixed(1)} MB cap — least-recently-hit nodes evicted, ${(total / MB).toFixed(1)} MB kept`);
      }
      if (freed) db.exec("PRAGMA incremental_vacuum");
    } catch (e) {
      console.error(`[gtow-cache] maintenance failed: ${e instanceof Error ? e.message : e}`);
    }
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
  treeBody(key: string): { kind: CacheKind; tree: any; solution: { actions: string; board: string } } | null {
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
      return { kind, tree: j.tree, solution: j.solution };
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
      }
    } catch {
      got = null;   // a corrupt or unreadable row is a miss: the caller asks GTO Wizard, and the reply replaces it
    }
    if (count) this.countNode(key, addr, got);
    return got;
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
      if (!raw || !DETERMINISTIC_REFUSAL.test(raw)) return;
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
      db.transaction(() => {
        for (const t of treeRows) insTree.run(t.key, t.kind, t.gz.byteLength, t.at, t.at, t.gz);
        for (const x of nodeRows) insNode.run(x.key, x.addr, x.status, x.gz?.byteLength ?? 0, x.at, x.at, x.gz);
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
      this.writesSinceMaintain += nodes.length;
      if (this.writesSinceMaintain >= MAINTAIN_EVERY) { this.writesSinceMaintain = 0; this.maintain(db, Date.now(), false); }
    } catch (e) {
      console.error(`[gtow-cache] flush failed (kept for the next one): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Flush and release the file (tests; a process that is done with the cache). */
  close(): void {
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
      for (const r of this.open()?.query<{ name: string; n: number }, []>("SELECT name, n FROM gtow_cache_totals").all() ?? []) out[r.name] = r.n;
    } catch { /* none */ }
    return out;
  }

  /** Everything GET /api/gtow/cache shows. */
  stats(recent = RECENT_MAX) {
    this.flush();
    const db = this.open();
    const rows = { trees: 0, nodes: 0, negatives: 0, storedBytes: 0 };
    let top: { tree: string; kind: string; addr: string; status: number; hits: number; lastHitMs: number }[] = [];
    try {
      if (db) {
        const t = db.query<{ n: number; b: number | null }, []>("SELECT COUNT(*) n, SUM(bytes) b FROM gtow_cache_trees").get()!;
        const n = db.query<{ n: number; neg: number | null; b: number | null }, []>("SELECT COUNT(*) n, SUM(status <> 200) neg, SUM(bytes) b FROM gtow_cache_nodes").get()!;
        rows.trees = t.n; rows.nodes = n.n; rows.negatives = n.neg ?? 0; rows.storedBytes = (t.b ?? 0) + (n.b ?? 0);
        top = db.query<{ key: string; kind: string; addr: string; status: number; hits: number; last_hit_ms: number }, [number]>(
          `SELECT n.key, t.kind, n.addr, n.status, n.hits, n.last_hit_ms FROM gtow_cache_nodes n JOIN gtow_cache_trees t ON t.key = n.key
           WHERE n.hits > 0 ORDER BY n.last_hit_ms DESC LIMIT ?`).all(recent)
          .map((r) => ({ tree: r.key.slice(0, 12), kind: r.kind, addr: r.addr, status: r.status, hits: r.hits, lastHitMs: r.last_hit_ms }));
      }
    } catch { /* an unreadable store reports empty */ }
    const all = this.persistedTotals();
    const today = dayOf(Date.now());
    return {
      enabled: this.enabled,
      path: this.path,
      memoryOnly: this.memoryOnly,
      fileBytes: this.fileBytes(),
      limits: { days: this.days, maxMb: Math.round(this.maxBytes / MB) },
      rows,
      since: { ...this.since },
      allTime: {
        hits: all.hits ?? 0, misses: all.misses ?? 0, treeHits: all.treeHits ?? 0, treeMisses: all.treeMisses ?? 0,
        materialised: all.materialised ?? 0, stored: all.stored ?? 0, requestsSaved: all.saved ?? 0, bytesServed: all.bytes ?? 0,
      },
      today: { day: today, hits: all[`d:${today}:hits`] ?? 0, requestsSaved: all[`d:${today}:saved`] ?? 0 },
      recent: top,
    };
  }

  /** The one-line summary the accounts payload carries (memoised 10 s — the GTO Wizard tab polls every 5 s). */
  summary(): GtowCacheSummary {
    const now = Date.now();
    if (this.summaryMemo && now - this.summaryAt < 10_000) return this.summaryMemo;
    const s = this.stats(0);
    this.summaryMemo = {
      enabled: s.enabled, trees: s.rows.trees, nodes: s.rows.nodes,
      mb: Math.round(((s.fileBytes || s.rows.storedBytes) / MB) * 10) / 10,
      today: s.today.day, hitsToday: s.today.hits, savedToday: s.today.requestsSaved,
    };
    this.summaryAt = now;
    return this.summaryMemo;
  }
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
  return new GtowSolveCache({ path, days: num(env.GTOW_CACHE_DAYS, 60), maxBytes: num(env.GTOW_CACHE_MAX_MB, 2048) * MB });
}

export const gtowSolveCache = solveCacheFromEnv();
// the last writes of a process that is going away (a flush is ≤ FLUSH_MS behind; this closes that gap on a clean exit)
if (gtowSolveCache.enabled) process.once("exit", () => gtowSolveCache.flush());
