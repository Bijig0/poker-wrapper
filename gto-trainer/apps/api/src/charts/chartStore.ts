import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, utimesSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileStamp, FollowedSqlite, sameStamp, type FileStamp } from "../services/fileStamp";

/**
 * The HRC chart store behind the TypeScript chart server (chartServer.ts, :8777) — the part of the Python solve-DB
 * server (analysis/pipeline/solve/exploit_ui/server.py) the study API actually reads: the chart INDEX
 * (GET /api/solutions) and one NODE of a chart (GET /api/preflop/node?source=<id>&line=<tokens>).
 *
 * Why it exists (2026-09-27): the packaged Poker Wrapper is the wrapper + the API/dashboard and nothing else. The
 * Python server dragged a venv, numpy/pandas and ~2,500 analysis files onto a player's laptop for these two
 * endpoints. The owner's machine keeps the Python server (its study-UI / exploit / MES endpoints serve the analysis
 * app); the Poker Wrapper runs this one (.claude/chart-server.ps1). SAME CONTRACT, same env knobs, same
 * cache rules — keep the two in step when either changes:
 *
 *   - the index is the tiny .meta.json SIDECARS in one folder; a chart is listed as soon as its sidecar is there and
 *     its body (<id>.json.gz, 26 KB heads-up .. 17 MB rich 3-max) is pulled from R2 the first time it is opened;
 *   - ONE LOAD PER CHART: concurrent asks for a cold chart share one download + parse (server.py 2026-09-24);
 *   - two LRUs: big trees (HRC_UI_DOC_CACHE_MAX, ~600 MB resident each) and small bodies under HRC_UI_SMALL_BODY_BYTES
 *     (HRC_UI_SMALL_DOC_MAX) — a heads-up session walking depth rungs must not push the big trees out;
 *   - the big LRU is ALSO capped by bytes (HRC_UI_DOC_CACHE_GB of JSON text, default 1; the doc just loaded always
 *     stays). A parsed doc costs ~4.3x its JSON text resident (measured 2026-10-13: ign200_6max_D100_o2_5, 202 MB of
 *     JSON = 877 MB RSS after GC), so 1 GB of text is ~4.3 GB of memory. 2026-10-12: the 6-max pool trees are
 *     133-169 MB gzipped (~1.4 GB of JSON) each; a cap by count alone let this process reach 24 GB private on a 32 GB
 *     machine — the whole box paged (15-32k page-ins/s) and the study API's loop froze 10-52 s on cold file reads.
 *     Live 6-max NL200 answers read the baked SQLite, not this server; CoinPoker heads-up bodies (<= 0.2 MB) live in
 *     the small LRU. GET /api/cache says what is resident and how big;
 *   - the on-disk body cache is capped (HRC_UI_DISK_CACHE_GB) but only ever drops a body R2 is CONFIRMED to hold,
 *     never a small one, never the one just fetched, never the pinned family (HRC_UI_PINNED_PREFIXES).
 */

export interface ChartMeta { id?: string; [k: string]: unknown }
export type ChartDoc = { meta?: ChartMeta; nodes: Record<string, unknown> };

export interface ChartStoreOpts {
  /** the sidecars (<base>.meta.json) and the cached bodies (<base>.json.gz) */
  dir: string;
  /** rclone remote holding the bodies (HRC_UI_REMOTE); "" = no downloads */
  remote: string;
  bigMax: number;
  /** the big LRU's budget in bytes of JSON text (the doc just loaded is kept even when it alone is over) */
  bigBytesMax: number;
  smallMax: number;
  smallBytes: number;
  diskCapBytes: number;
  pinnedPrefixes: string[];
  /** the GTOW crawl SQLite (`source=gtow`); absent on a player's install */
  preflopDb: string;
  /** pull one body to `dest` (default: rclone copyto). Resolves whether it landed. */
  fetchBody?: (sid: string, dest: string) => Promise<boolean>;
  /** the body names the remote holds (default: rclone lsf); null when it cannot be listed */
  listRemote?: () => Promise<Set<string> | null>;
  /** copy the remote's sidecars into `dir`, adding and refreshing only (default: rclone copy --include *.meta.json) */
  syncSidecars?: (dir: string) => Promise<boolean>;
  log?: (msg: string) => void;
  /** how often a resident doc's body file is stat'ed on a hit (default 1000 ms) — see bodyChanged */
  bodyCheckMs?: number;
  /** a changed body is read again only once it has not been written for this long (default 2000 ms) */
  bodySettleMs?: number;
  /** how often the open GTOW crawl SQLite is stat'ed for a change (default 30 s) */
  crawlCheckMs?: number;
}

const RCLONE = () => process.env.RCLONE || "rclone";

async function rclone(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([RCLONE(), ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  } catch {
    return { code: -1, stdout: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Every setting from the environment, with server.py's defaults. */
export function optsFromEnv(dir: string, preflopDb: string): ChartStoreOpts {
  const env = process.env;
  return {
    dir,
    remote: env.HRC_UI_REMOTE ?? "r2:poker-solve-db/hrc-ui",
    bigMax: Number(env.HRC_UI_DOC_CACHE_MAX ?? 3),
    bigBytesMax: Number(env.HRC_UI_DOC_CACHE_GB ?? 1) * 2 ** 30,
    smallMax: Number(env.HRC_UI_SMALL_DOC_MAX ?? 300),
    smallBytes: Number(env.HRC_UI_SMALL_BODY_BYTES ?? 256 * 1024),
    diskCapBytes: Number(env.HRC_UI_DISK_CACHE_GB ?? 20) * 2 ** 30,
    pinnedPrefixes: (env.HRC_UI_PINNED_PREFIXES ?? "ign200_6max_").split(",").filter(Boolean),
    preflopDb,
  };
}

/** The default GTOW crawl, listed as one selectable solution alongside the file-based ones (server.py GTOW_SOLUTION). */
export const GTOW_SOLUTION = {
  id: "gtow", label: "GTO Wizard · Cash 6-max General",
  format: "GTOW crawl · RFI/3bet/4bet (no limps)",
  preflop_only: false, source: "gtow",
};

/** A body file: gzip + JSON (a plain .json is read as-is). */
export function readDoc(path: string): ChartDoc {
  return readDocSized(path).doc;
}

/** readDoc plus the size of its JSON text — what the big LRU's byte budget counts. */
export function readDocSized(path: string): { doc: ChartDoc; bytes: number } {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? new TextDecoder().decode(Bun.gunzipSync(raw)) : raw.toString("utf8");
  return { doc: JSON.parse(text), bytes: text.length };
}

const gb = (n: number) => `${(n / 2 ** 30).toFixed(2)} GB`;

/** A gzip body's trailer (CRC32 + length of the data, the file's last 8 bytes): what tells a rewritten body from one
 *  that was only touched. null for a plain .json body or when it cannot be read. */
function gzTail(path: string, size: number): string | null {
  if (!path.endsWith(".gz") || size < 8) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const b = Buffer.alloc(8);
    return readSync(fd, b, 0, 8, size - 8) === 8 ? b.toString("hex") : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
  }
}

export class ChartStore {
  private index = new Map<string, { body: string; meta: ChartMeta }>();
  private stamp = "";
  private big = new Map<string, ChartDoc>();     // insertion order = LRU order (oldest first)
  private small = new Map<string, ChartDoc>();
  /** JSON text bytes per resident doc (both LRUs) */
  private bytes = new Map<string, number>();
  /** each resident doc's body file as it was when read (bodyChanged) */
  private bodies = new Map<string, { path: string; stamp: FileStamp; tail: string | null; checkedAt: number }>();
  private loading = new Map<string, Promise<ChartDoc | null>>();
  private r2Listing: { at: number; names: Set<string> | null } = { at: 0, names: null };
  /** the GTOW crawl SQLite, reopened when the file changes (services/fileStamp.ts) */
  private crawl: FollowedSqlite;

  constructor(private o: ChartStoreOpts) {
    this.crawl = new FollowedSqlite(() => this.o.preflopDb, o.crawlCheckMs ?? 30_000, (m) => this.log(m));
  }

  /** Release the crawl handle (tests: Windows will not delete an open file). */
  close(): void { this.crawl.close(); }

  private log(m: string) { (this.o.log ?? ((s: string) => console.error(s)))(m); }

  /** Re-read the sidecars when the folder changed (names + sizes + mtimes, the way server.py stamps it). */
  refreshIndex(): void {
    if (!existsSync(this.o.dir)) return;
    const names = readdirSync(this.o.dir);
    const sides = names.filter((n) => n.endsWith(".meta.json")).sort();
    const sideSet = new Set(sides);
    // legacy bodies that never got a sidecar written
    const orphans = names.filter((n) => n.endsWith(".json.gz") && !sideSet.has(`${n.slice(0, -".json.gz".length)}.meta.json`)).sort();
    const stamp = [...sides, ...orphans].map((n) => {
      try { return `${n}@${statSync(join(this.o.dir, n)).mtimeMs}`; } catch { return n; }
    }).join("|");
    if (stamp === this.stamp) return;
    const index = new Map<string, { body: string; meta: ChartMeta }>();
    for (const side of sides) {
      const base = side.slice(0, -".meta.json".length);
      try {
        const meta = JSON.parse(readFileSync(join(this.o.dir, side), "utf8")) as ChartMeta;
        index.set(String(meta.id || base), { body: join(this.o.dir, `${base}.json.gz`), meta });
      } catch (e: any) {
        this.log(`solution index failed ${side}: ${e?.message ?? e}`);
      }
    }
    for (const n of orphans) {
      const base = n.slice(0, -".json.gz".length);
      try {
        const meta = (readDoc(join(this.o.dir, n)).meta ?? {}) as ChartMeta;
        try { writeFileSync(join(this.o.dir, `${base}.meta.json`), JSON.stringify(meta)); } catch { /* read-only is fine */ }
        index.set(String(meta.id || base), { body: join(this.o.dir, n), meta });
      } catch (e: any) {
        this.log(`solution index failed ${n}: ${e?.message ?? e}`);
      }
    }
    this.index = index;
    this.stamp = stamp;
  }

  solutions(): ChartMeta[] {
    this.refreshIndex();
    return [GTOW_SOLUTION, ...[...this.index.values()].map((e) => e.meta)];
  }

  /** Test/inspection hook: which docs are resident. */
  resident(): { big: string[]; small: string[] } { return { big: [...this.big.keys()], small: [...this.small.keys()] }; }

  /** GET /api/cache: what is resident, oldest first, with the JSON text size each doc was parsed from. */
  cacheReport() {
    const list = (m: Map<string, ChartDoc>) => [...m.keys()].map((id) => ({ id, bytes: this.bytes.get(id) ?? 0 }));
    const sum = (m: Map<string, ChartDoc>) => [...m.keys()].reduce((n, id) => n + (this.bytes.get(id) ?? 0), 0);
    return {
      big: { max: this.o.bigMax, maxBytes: this.o.bigBytesMax, bytes: sum(this.big), docs: list(this.big) },
      small: { max: this.o.smallMax, bytes: sum(this.small), docs: list(this.small) },
    };
  }

  private bigBytes(): number { let n = 0; for (const id of this.big.keys()) n += this.bytes.get(id) ?? 0; return n; }

  private cached(sid: string): ChartDoc | null {
    for (const cache of [this.small, this.big]) {
      const d = cache.get(sid);
      if (d) { cache.delete(sid); cache.set(sid, d); return d; }   // move to the young end
    }
    return null;
  }

  /**
   * A RE-CONVERTED BODY IS READ AGAIN (2026-10-13). The LRUs are keyed by chart id, and a body converted again under
   * the same id (a re-solve, a converter fix) was served from memory until evicted or restarted. On a hit the body
   * file is stat'ed (at most every bodyCheckMs per chart); when its size / mtime / file id changed, the doc is dropped
   * and read again through the normal load — once the file has not been written for bodySettleMs (the converter
   * writes the .json.gz in place over seconds; until then the old doc keeps serving).
   *   - a body gone from disk (the disk cap evicted it; R2 holds it) is NOT a change: the resident doc stays;
   *   - a body only TOUCHED (same size and file, same gzip trailer) is not a change either: load() touches every body
   *     it opens to keep the disk LRU (its own touch is in the stamp), and so do server.py and a second chart server
   *     on the same folder — re-reading a 1.4 GB tree for that would cost seconds and double its memory.
   */
  private bodyChanged(sid: string): boolean {
    const b = this.bodies.get(sid);
    if (!b) return false;
    const now = Date.now();
    if (now - b.checkedAt < (this.o.bodyCheckMs ?? 1000)) return false;
    b.checkedAt = now;
    const st = fileStamp(b.path);
    if (!st || sameStamp(st, b.stamp)) return false;
    if (now - st.mtimeMs < (this.o.bodySettleMs ?? 2000)) return false;
    if (st.size === b.stamp.size && st.ino === b.stamp.ino && b.tail !== null && gzTail(b.path, st.size) === b.tail) {
      b.stamp = st;
      return false;
    }
    this.small.delete(sid);
    this.big.delete(sid);
    this.bytes.delete(sid);
    this.bodies.delete(sid);
    this.log(`${sid}: body changed on disk - reading it again`);
    return true;
  }

  /** Full document for one id, lazily loaded (from disk, else R2) and LRU-cached. Concurrent callers share one load. */
  async doc(sid: string): Promise<ChartDoc | null> {
    const hit = this.cached(sid);
    if (hit && !this.bodyChanged(sid)) return hit;
    const pending = this.loading.get(sid);
    if (pending) return pending;
    const p = this.load(sid).finally(() => this.loading.delete(sid));
    this.loading.set(sid, p);
    return p;
  }

  private async load(sid: string): Promise<ChartDoc | null> {
    if (!this.index.has(sid)) this.refreshIndex();
    const entry = this.index.get(sid);
    if (!entry) return null;
    const path = entry.body;
    if (!existsSync(path)) {
      // indexed from its sidecar but the body lives only in R2 — fetch it, whole, before anyone reads it
      this.log(`fetching ${sid} from ${this.o.remote} ...`);
      const tmp = `${path}.part`;
      const ok = await (this.o.fetchBody ?? ((s, d) => this.rcloneFetch(s, d)))(sid, tmp);
      if (!ok || !existsSync(tmp) || statSync(tmp).size === 0) {
        try { unlinkSync(tmp); } catch { /* not there */ }
        // A FAILED FETCH IS NOT AN UNKNOWN CHART (2026-10-10, the failed-lock review): it answered "unknown solution"
        // with HTTP 200, which the client cached for the life of the process as "no such line" — the hand moved to
        // another chart or to GTO Wizard AI, and every later read of that chart did too. Thrown: the server answers
        // 500, the client retries and then says "unreachable".
        throw new Error(`the body of indexed chart '${sid}' could not be fetched from ${this.o.remote}`);
      }
      renameSync(tmp, path);
      this.touch(path);                 // just used: not rclone's R2 upload time
      await this.evictDisk(path);
    } else {
      this.touch(path);                 // LRU order on disk = last opened (Windows does not keep atime for us)
    }
    const st = statSync(path);   // after the touch: the stamp a later hit compares against
    const isSmall = st.size < this.o.smallBytes;
    const { doc, bytes } = readDocSized(path);
    const [cache, cap] = isSmall ? [this.small, this.o.smallMax] : [this.big, this.o.bigMax];
    cache.set(sid, doc);
    this.bytes.set(sid, bytes);
    this.bodies.set(sid, { path, stamp: { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }, tail: gzTail(path, st.size),
                           checkedAt: Date.now() });
    const evict = () => {
      const old = cache.keys().next().value!;
      cache.delete(old); this.bytes.delete(old); this.bodies.delete(old);
      return old;
    };
    while (cache.size > cap) evict();
    if (!isSmall) {
      // the byte budget: oldest first, never the doc just loaded (it is what the caller is about to read)
      const dropped: string[] = [];
      while (cache.size > 1 && this.bigBytes() > this.o.bigBytesMax) dropped.push(evict());
      this.log(`loaded ${sid} (${gb(bytes)} of JSON) - big cache ${cache.size} docs, ${gb(this.bigBytes())} of ${gb(this.o.bigBytesMax)}` +
               (dropped.length ? `; dropped ${dropped.join(", ")} for the byte budget` : ""));
    }
    return doc;
  }

  private touch(path: string) {
    const now = new Date();
    try { utimesSync(path, now, now); } catch { /* read-only is fine */ }
  }

  private async rcloneFetch(sid: string, dest: string): Promise<boolean> {
    if (!this.o.remote) return false;
    const r = await rclone(["copyto", `${this.o.remote}/${sid}.json.gz`, dest], 600_000);
    if (r.code !== 0) this.log(`fetch ${sid} failed (rclone exit ${r.code})`);
    return existsSync(dest) && statSync(dest).size > 0;
  }

  /** The body names the remote holds (cached 10 min); null when it cannot be listed. */
  private async r2Bodies(): Promise<Set<string> | null> {
    if (this.r2Listing.names && Date.now() - this.r2Listing.at < 600_000) return this.r2Listing.names;
    let names: Set<string> | null = null;
    if (this.o.listRemote) names = await this.o.listRemote();
    else if (this.o.remote) {
      const r = await rclone(["lsf", this.o.remote, "--include", "*.json.gz"], 300_000);
      if (r.code === 0) names = new Set(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    }
    if (names) this.r2Listing = { at: Date.now(), names };
    return names;
  }

  /**
   * Keep the on-disk bodies under the cap, least recently used first — but ONLY bodies R2 is confirmed to hold
   * (a body converted on the owner's machine and never uploaded is the only copy: server.py 2026-09-27). Never `keep`
   * (the body just fetched), never a small body, never the pinned family; nothing at all when R2 cannot be listed.
   */
  async evictDisk(keep?: string): Promise<void> {
    let bodies: { at: number; size: number; path: string; name: string }[];
    try {
      bodies = readdirSync(this.o.dir).filter((n) => n.endsWith(".json.gz")).map((name) => {
        const path = join(this.o.dir, name);
        const st = statSync(path);
        return { at: Math.max(st.atimeMs, st.mtimeMs), size: st.size, path, name };
      });
    } catch {
      return;
    }
    let total = bodies.reduce((a, b) => a + b.size, 0);
    if (total <= this.o.diskCapBytes) return;
    const inR2 = await this.r2Bodies();
    if (!inR2) { this.log("[disk-cache] over the cap but R2 cannot be listed - evicting nothing"); return; }
    for (const b of bodies.sort((x, y) => x.at - y.at)) {
      if (total <= this.o.diskCapBytes) break;
      if (b.size < this.o.smallBytes || b.path === keep) continue;
      if (this.o.pinnedPrefixes.some((p) => b.name.startsWith(p)) || !inR2.has(b.name)) continue;
      try { unlinkSync(b.path); total -= b.size; } catch { /* in use: next one */ }
    }
  }

  /**
   * Bring the index up to date with R2: every sidecar (<id>.meta.json) the remote has and this folder lacks or holds an
   * older copy of. The chart factory uploads a chart's sidecar with its body, so a chart solved after this install
   * was built is listed here without a release. Only ever ADDS: a sidecar known only here (the factory's local
   * charts on the owner's machine) is left alone. Resolves how many sidecars arrived, or null when R2 answered no.
   */
  async syncIndex(): Promise<number | null> {
    if (!this.o.remote) return null;
    const count = () => { try { return readdirSync(this.o.dir).filter((n) => n.endsWith(".meta.json")).length; } catch { return 0; } };
    const before = count();
    const r = await (this.o.syncSidecars ?? ((dir) => rclone(["copy", this.o.remote, dir, "--include", "*.meta.json", "--update"], 600_000)
      .then((x) => x.code === 0)))(this.o.dir);
    if (!r) { this.log(`[index sync] ${this.o.remote} could not be read - the index stays as it is`); return null; }
    this.refreshIndex();
    const got = count() - before;
    if (got > 0) this.log(`[index sync] ${got} new chart(s) from ${this.o.remote}`);
    return got;
  }

  /** GET /api/preflop/node — a FILE solution's node by line, or the GTOW crawl's (source=gtow). */
  async node(q: URLSearchParams): Promise<unknown> {
    const line = q.get("line") ?? "";
    const source = q.get("source") ?? "gtow";
    if (source && source !== "gtow") {
      const doc = await this.doc(source);
      if (!doc) return { ok: false, error: `unknown solution '${source}'` };
      const node = doc.nodes[line];
      if (node === undefined) {
        const prefix = line ? `${line}-` : "";
        const near: string[] = [];
        for (const ln in doc.nodes) {
          if (ln.startsWith(prefix) && ln !== line) near.push(ln);
          if (near.length >= 12) break;
        }
        return { ok: false, error: "line not in solution", near };
      }
      return node;
    }
    // default: the GTOW crawl SQLite
    const gametype = q.get("gametype") ?? "Cash6m500zGeneral";
    const depth = Number.parseInt(q.get("depth") ?? "100", 10);
    // opened read-only once and kept until 2026-10-13 — a crawl replaced on disk was never seen; now followed
    const crawl = existsSync(this.o.preflopDb) ? this.crawl.get() : null;
    if (!crawl) return { ok: false, error: `preflop DB not found at ${this.o.preflopDb}` };
    const row = crawl.query("SELECT pos, reach, actions, cells, terminal FROM nodes WHERE gametype=? AND depth=? AND line=?")
      .get(gametype, depth, line) as { pos: string; reach: number; actions: string; cells: string; terminal: number } | null;
    if (!row) {
      const have = crawl.query("SELECT line FROM nodes WHERE gametype=? AND depth=? AND line LIKE ? LIMIT 12")
        .all(gametype, depth, line ? `${line}-%` : "%") as { line: string }[];
      return { ok: false, error: "line not crawled", near: have.map((r) => r.line) };
    }
    return { ok: true, line, pos: row.pos, reach: row.reach, actions: JSON.parse(row.actions), cells: JSON.parse(row.cells),
             terminal: Boolean(row.terminal) };
  }
}
