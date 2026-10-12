import { Database } from "bun:sqlite";
import { factoryFile, factoryManifestFile } from "./repoPaths";
import { existsSync, readFileSync, statSync } from "node:fs";
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
 * solve-DB browser, exploit tooling — still goes to :8777 unchanged.
 *
 * THE BAKE IS THE RECORD FOR THIS FAMILY (2026-09-27, Brady: "remove the chart
 * server altogether"). pullChart.sh bakes every ign200_6max chart it lands, so on
 * a machine with a bake an id the bake lacks is a chart that does not exist, and
 * fetchNode6max says so (null) instead of asking :8777. Only a machine with NO
 * bake at all reads the family from the chart server.
 *
 * THE FILE IS WRITTEN WHILE IT IS READ. A live bake (build_6max_preflop_db.py
 * --only, from pullChart.sh) is one ~10 s transaction per tree. The file is in
 * WAL mode for exactly that reason: in rollback-journal mode the writer holds an
 * exclusive lock for most of those seconds and a read-only handle with no busy
 * timeout threw SQLITE_BUSY straight into the answer (reproduced 2026-09-27) —
 * and a throw at first open marked the bake absent for the rest of the process.
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
  process.env.HRC6MAX_DB ?? factoryFile("hrc6max-preflop.sqlite");
const PREFIX = "ign200_6max_";
/** how stale the coverage set may get before it is re-read (a newly baked tree waits at most this long) */
const COVERAGE_TTL_MS = 60_000;

type Row = { pos: string | null; terminal: number; actions: string; cells: Uint8Array; pruned?: number };
/** A node's baked trust score (services/nodeTrust): reach null = a token on the line matched no action of its parent. */
export type BakedTrust = { reach: number | null; regret: number };
/** What the bake says about its own trust coverage — for the registry and the API's start line. */
export type TrustAudit = { tables: boolean; trees: number; scored: number; unscored: string[] };
/** One baked chart's provenance row (build_6max_preflop_db.py writes it with the tree; chart_manifest.py names it). */
export type BakedProvenance = { raw: string | null; body: string; converter: string | null; plan: string | null;
  refineMin: number | null; status: string };
/**
 * THE BAKE AGAINST THE CHART MANIFEST (2026-10-03). A chart id names the spot, not the solve: twice a rebuild put a
 * round-1 export behind a round-2 chart and nothing could tell (29 six-max charts, 48% of chart answers). The bake now
 * carries, per tree, the raw export's and the body's sha256 (`provenance`, written in the tree's own transaction), and the
 * factory's git-tracked chart_manifest.json names the export each chart must be built from.
 *   `table` false    = a bake from before provenance (an older file): the check is inert and says so;
 *   `manifest` false = chart_manifest.json could not be read here: the mismatch count is UNKNOWN (null), never 0;
 *   `mismatches`     = baked charts whose provenance row is missing, or names another raw/body than the manifest, or that
 *                      the manifest does not know.
 */
export type ProvenanceAudit = { table: boolean; trees: number; withRow: number; manifest: boolean; manifestPath: string;
  mismatches: number | null; mismatchIds: string[];
  charts: Record<string, { refineMin: number | null; raw: string | null; status: string }> };

type ManifestEntry = { raw_sha256?: string; body_sha256?: string; refine_min?: number; status?: string };
let manifestCache: { path: string; mtimeMs: number; charts: Record<string, ManifestEntry> } | null = null;
/** chart_manifest.json's charts, re-read when its mtime changes; null when it cannot be read (or is another schema). */
export function readChartManifest(): Record<string, ManifestEntry> | null {
  const path = factoryManifestFile();
  try {
    const m = statSync(path).mtimeMs;
    if (manifestCache && manifestCache.path === path && manifestCache.mtimeMs === m) return manifestCache.charts;
    const doc = JSON.parse(readFileSync(path, "utf8")) as { schema?: number; charts?: Record<string, ManifestEntry> };
    if (doc.schema !== 1 || !doc.charts) return null;
    manifestCache = { path, mtimeMs: m, charts: doc.charts };
    return doc.charts;
  } catch {
    return null;
  }
}

class Hrc6MaxDb {
  private db: Database | null = null;
  private tried = false;
  /** Sources the bake covers. Empty set = no local coverage at all. */
  private baked = new Set<string>();
  private nodeStmt: ReturnType<Database["query"]> | null = null;
  /** when the coverage set was last read from `trees` */
  private coveredAt = 0;
  /** the baked PATCH charts (ign200_6max_P_*), rebuilt with the coverage set */
  private patches: string[] = [];
  /** when a failed open was last reported (one line a minute, not one per read) */
  private lastOpenWarn = 0;
  /**
   * THE TRUST SCORES BAKED WITH EACH CHART (2026-10-03, audit finding 6). build_6max_preflop_db.py writes every
   * non-terminal node's [reach, regret] into `trust` in the same transaction as the tree, and `trust_trees` says which
   * trees are scored FROM WHICH BODY. A tree counts as scored only while its trust_trees stamp (src_mtime/src_size)
   * equals its `trees` stamp, so a tree re-baked by an older bake script reads as unscored rather than as scored with
   * another body's numbers. `trustTables` false = a bake from before the scores (every tree unscored).
   */
  private trustTables = false;
  private scored = new Set<string>();
  private trustStmt: ReturnType<Database["query"]> | null = null;
  /** the bake's `provenance` table (chart_manifest.py): which raw export and body each baked tree was built from */
  private provTable = false;
  private prov = new Map<string, BakedProvenance & { stamp: string }>();
  /** each baked tree's stamp (src_mtime/src_size): a provenance row counts only for the tree as baked now */
  private stamps = new Map<string, string>();

  /** Opened lazily. A missing file (or HRC6MAX_DB=off) is the normal state on a machine that has not run the bake:
   *  that is decided once and costs nothing per call. A file that IS there but would not open is a transient — a lock,
   *  a torn moment — and is retried on the next read: giving up quietly here used to send every 6-max node to :8777
   *  for the rest of the process. */
  private open(): Database | null {
    if (this.tried) return this.db;
    const path = dbPath();
    if (path === "off" || !existsSync(path)) { this.tried = true; this.db = null; return null; }
    try {
      const db = new Database(path, { readonly: true });
      // The bake writes while we read (see the header). WAL keeps reads off the writer's lock; the timeout is the
      // belt for the moments WAL still locks briefly (a checkpoint, the wal-index being rebuilt).
      db.exec("PRAGMA busy_timeout = 5000");
      this.readCoverage(db);
      // `pruned` (0 close / 1 reach / 2 cut) arrived 2026-09-25; a bake from before it has no such column.
      const hasPruned = (db.query("PRAGMA table_info(nodes)").all() as { name: string }[]).some((c) => c.name === "pruned");
      this.nodeStmt = db.query(`SELECT pos, terminal, actions, cells${hasPruned ? ", pruned" : ""} FROM nodes WHERE source = ? AND line = ?`);
      this.db = db;
      this.tried = true;
    } catch (e) {
      this.db = null;
      this.nodeStmt = null;
      const now = Date.now();
      if (now - this.lastOpenWarn > 60_000) {
        this.lastOpenWarn = now;
        console.warn(`[hrc6maxDb] could not open ${path}: ${e instanceof Error ? e.message : String(e)} — retrying on the next read`);
      }
    }
    return this.db;
  }

  /** Is there a bake on this machine at all? (The record for ign200_6max_* when there is — see fetchNode6max.) */
  present(): boolean {
    return this.open() !== null;
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
    this.patches = [];
    this.coveredAt = 0;
    this.nodeStmt = null;
    this.trustTables = false;
    this.scored = new Set();
    this.trustStmt = null;
    this.provTable = false;
    this.prov = new Map();
    this.stamps = new Map();
  }

  private readCoverage(db: Database): void {
    const next = new Set<string>();
    const stamps = new Map<string, string>();
    for (const r of db.query("SELECT source, src_mtime, src_size FROM trees").all() as { source: string; src_mtime: number; src_size: number }[]) {
      next.add(r.source);
      stamps.set(r.source, `${r.src_mtime}/${r.src_size}`);
    }
    this.baked = next;
    this.stamps = stamps;
    this.patches = [...next].filter((s) => s.startsWith(`${PREFIX}P_`));
    this.readTrustCoverage(db);
    this.readProvenance(db);
    this.coveredAt = Date.now();
  }
  /** The bake's provenance rows, re-read with the coverage set (the backfill adds the table to a file the API has open). */
  private readProvenance(db: Database): void {
    const has = !!db.query("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'provenance'").get();
    const m = new Map<string, BakedProvenance & { stamp: string }>();
    if (has) {
      for (const r of db.query("SELECT source, raw_sha256, body_sha256, converter, plan, refine_min, status, src_mtime, src_size FROM provenance").all() as
          { source: string; raw_sha256: string | null; body_sha256: string; converter: string | null; plan: string | null;
            refine_min: number | null; status: string; src_mtime: number; src_size: number }[]) {
        m.set(r.source, { raw: r.raw_sha256, body: r.body_sha256, converter: r.converter, plan: r.plan, refineMin: r.refine_min,
          status: r.status, stamp: `${r.src_mtime}/${r.src_size}` });
      }
    }
    this.provTable = has;
    this.prov = m;
  }
  /** Re-read with the coverage set (at most once a minute): the backfill adds the tables to a file the API already has
   *  open, and a tree it scores is guarded by its baked scores from the next refresh on — no restart, no flag. */
  private readTrustCoverage(db: Database): void {
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    if (!tables.has("trust") || !tables.has("trust_trees")) {
      this.trustTables = false; this.scored = new Set(); this.trustStmt = null;
      return;
    }
    const scored = new Set<string>();
    for (const r of db.query("SELECT t.source FROM trees t JOIN trust_trees s ON s.source = t.source " +
        "AND s.src_mtime = t.src_mtime AND s.src_size = t.src_size").all() as { source: string }[]) scored.add(r.source);
    this.trustStmt ??= db.query("SELECT reach, regret FROM trust WHERE source = ? AND line = ?");
    this.scored = scored;
    this.trustTables = true;
  }
  /**
   * A TREE BAKED WHILE THE API RUNS GOES LIVE BY ITSELF (2026-09-27, Brady: "this is a bitch to do if every time a
   * patch chart comes in I need to ask you to wire it up"). pullChart.sh bakes every chart it lands into this file
   * (one transaction per tree: the tree's rows and its `trees` row commit together, so a reader never sees half a
   * tree). The coverage set is re-read from the open handle at most once a minute — a read-only SQLite handle sees
   * another process's commits on its next read, so no reload() call and no restart are needed.
   */
  private fresh(): Database | null {
    const db = this.open();
    if (db && Date.now() - this.coveredAt > COVERAGE_TTL_MS) {
      try { this.readCoverage(db); } catch { /* keep the last good set */ }
    }
    return db;
  }
  /** Is this chart baked here? Only then is a missing line authoritative. */
  covers(source: string): boolean {
    if (!source.startsWith(PREFIX)) return false;
    return this.fresh() !== null && this.baked.has(source);
  }
  /** Every baked patch chart id (the picker looks a table's patch keys up in these). */
  patchSources(): readonly string[] {
    this.fresh();
    return this.patches;
  }

  /** How many trees the bake holds — refreshed like `covers` (it read the count at first open only until 2026-09-27,
   *  so the registry showed 117 while the file held 122). */
  get size(): number {
    this.fresh();
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

  /**
   * One node's baked trust score (services/nodeTrust).
   *   `undefined` = this bake holds no CURRENT scores for the chart (a bake from before the scores, a tree the backfill
   *                 has not reached, a tree re-baked without scoring, or a chart not baked here) — the caller falls back;
   *   `null`      = the chart IS scored and this line has no row. Every non-terminal node is scored with its chart, so
   *                 this is a bug in the scorer or a line that is not a decision node — the caller refuses.
   */
  trust(source: string, line: string): BakedTrust | null | undefined {
    if (!this.covers(source) || !this.trustTables || !this.scored.has(source) || !this.trustStmt) return undefined;
    const row = this.trustStmt.get(source, line) as BakedTrust | null;
    return row ? { reach: row.reach, regret: row.regret } : null;
  }

  /** One baked chart's provenance row - only while it was written for the tree as it is baked now (same stamp). */
  provenance(source: string): BakedProvenance | undefined {
    if (!this.covers(source)) return undefined;
    const p = this.prov.get(source);
    if (!p || p.stamp !== this.stamps.get(source)) return undefined;
    return { raw: p.raw, body: p.body, converter: p.converter, plan: p.plan, refineMin: p.refineMin, status: p.status };
  }

  /** The bake against the chart manifest: the registry, the 6-max card and the API's start line show it. */
  provenanceAudit(manifest: Record<string, ManifestEntry> | null = readChartManifest()): ProvenanceAudit {
    this.fresh();
    const charts: ProvenanceAudit["charts"] = {};
    const bad: string[] = [];
    let withRow = 0;
    for (const s of [...this.baked].sort()) {
      const p = this.provenance(s);
      if (p) withRow++;
      charts[s] = { refineMin: p?.refineMin ?? null, raw: p?.raw ? p.raw.slice(0, 12) : null, status: p?.status ?? "no row" };
      const e = manifest?.[s];
      if (!p || !e || e.raw_sha256 !== p.raw || e.body_sha256 !== p.body) bad.push(s);
    }
    const known = manifest !== null && this.provTable;
    return { table: this.provTable, trees: this.baked.size, withRow, manifest: manifest !== null, manifestPath: factoryManifestFile(),
      mismatches: known ? bad.length : null, mismatchIds: known ? bad : [], charts };
  }

  /** The bake's trust coverage: the registry shows it, the API says it at start. Must be 0 unscored after the backfill. */
  trustAudit(): TrustAudit {
    this.fresh();
    const unscored = [...this.baked].filter((s) => !this.scored.has(s)).sort();
    return { tables: this.trustTables, trees: this.baked.size, scored: this.baked.size - unscored.length, unscored };
  }
}

/** The API's start line about the bake's trust scores (index.ts). */
export function trustAuditLine(a: TrustAudit = hrc6maxDb.trustAudit()): string {
  if (a.trees === 0) return "[hrc6maxDb] trust: no 6-max bake on this machine";
  const ids = a.unscored.slice(0, 6).map((s) => s.replace(PREFIX, "")).join(", ") + (a.unscored.length > 6 ? ", …" : "");
  if (!a.tables) return `[hrc6maxDb] trust: this bake carries NO trust scores — all ${a.trees} charts are guarded from ` +
    `limp_node_trust.json, and the ones it does not score answer UNGUARDED (run backfill_trust.py)`;
  return a.unscored.length === 0
    ? `[hrc6maxDb] trust: all ${a.trees} baked charts carry their trust scores`
    : `[hrc6maxDb] trust: ${a.unscored.length} of ${a.trees} baked charts carry NO current trust scores (${ids}) — they fall back ` +
      `to limp_node_trust.json and answer unguarded where it has no score (backfill_trust.py / a re-bake scores them)`;
}

/** The API's start line about the bake against the chart manifest (index.ts), beside the trust line. */
export function provenanceAuditLine(a: ProvenanceAudit = hrc6maxDb.provenanceAudit()): string {
  if (a.trees === 0) return "[hrc6maxDb] provenance: no 6-max bake on this machine";
  if (!a.table) return `[hrc6maxDb] provenance: no provenance in this bake (an older file) - which raw export each of the ${a.trees} ` +
    `charts was built from is not recorded here (chart_manifest.py backfill-bake)`;
  if (!a.manifest) return `[hrc6maxDb] provenance: ${a.withRow} of ${a.trees} baked charts carry a provenance row; manifest not ` +
    `readable (${a.manifestPath}) - mismatches UNKNOWN`;
  const ids = a.mismatchIds.slice(0, 6).map((s) => s.replace(PREFIX, "")).join(", ") + (a.mismatchIds.length > 6 ? ", …" : "");
  return a.mismatches === 0
    ? `[hrc6maxDb] provenance: all ${a.trees} baked charts match the chart manifest (raw export + body by sha256)`
    : `[hrc6maxDb] provenance: ${a.mismatches} of ${a.trees} baked charts do NOT match the chart manifest (${ids}) - ` +
      `chart_manifest.py verify names each`;
}

export const hrc6maxDb = new Hrc6MaxDb();

/**
 * Drop-in for hrc3max's `fetchNode`, for the 6-max family only. Same return contract, so resolveChart6max's
 * candidate walk and walk3max behave identically — including "unreachable", which only the HTTP path can produce.
 *
 *   - the bake holds the chart            → its node, or null when the line is not in that tree;
 *   - a bake is here but lacks the chart  → null: no such chart on this machine (the picker takes its next
 *                                           candidate). Every grid tree, the pool limp trees and every landed patch
 *                                           are baked by pullChart.sh, so nothing legitimate is lost — and before
 *                                           2026-09-27 this asked :8777, where the reply was a 4-11 s cold open or
 *                                           "unknown solution" for ids nothing holds;
 *   - no bake on this machine             → :8777, as before the bake existed.
 * Ids outside the family always go to the server.
 */
export const fetchNode6max: (source: string, line: string) => Promise<HrcNode | null | "unreachable"> =
  async (source, line) => {
    const local = hrc6maxDb.node(source, line);
    if (local !== undefined) return local;
    if (source.startsWith(PREFIX) && hrc6maxDb.present()) return null;
    return fetchNode(source, line);
  };
