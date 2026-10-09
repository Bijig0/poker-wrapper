import type { Database } from "bun:sqlite";
import { pagedSeed, type PagedSeedResult } from "./sqlitePager";
import type { GtowWallState, GtowWindow } from "./gtowRequestLog";
import { WALL_SCAN_MS, WALL_SCAN_ROWS, wallFromRows } from "./gtowWall";

/**
 * THE GTO WIZARD LEDGER'S LAST THREE DAYS, IN MEMORY (2026-10-09, catalogue-incremental). The accounts payload (GET
 * /api/gtow/accounts, rebuilt every 5 s while the setup page, the panel or the dashboard's GTO Wizard tab polls it) read
 * its meters and walls from gtow_requests on the API's loop: two 24 h GROUP BYs per window and a 3-day wall scan per
 * account — `cache refresh gtow/accounts (1.2 s: ledger wall ×3 1.2 s)`, 0.4–0.8 s every few seconds during the
 * 2026-10-09 sessions, the disk waits ("cpu 7% of the wall") that showed up as freezes.
 *
 * Now every request of the trailing WALL_SCAN_MS lives here as {id, s, ts, st, o}, per account, ordered by (ts, id):
 *   - SEEDED once off the loop (a Bun Worker pages the table, services/sqlitePager.ts);
 *   - FED by this process's own ledger writes (gtowRequestLog.note → note(), at once);
 *   - SYNCED with the other processes' writes (a harness, a study, the factory — they spend the same accounts) by one
 *     primary-key range read past the last id seen, at most every SYNC_MS, when a reader asks;
 *   - rows older than WALL_SCAN_MS leave.
 * windows() and wallState() answer exactly what gtowRequestLog's SQL answers (the same rule, services/gtowRequestLog
 * wallFromRows), from memory. Until the seed lands the caller awaits ready(); if it failed, it reads SQL as before.
 */
export interface LedgerRow { id: number; s: string; ts: number; st: number; o: string }
export interface LedgerSource { path: string; db: () => Database }

const SYNC_MS = 5_000;
const SEED_RETRY_MS = 5 * 60_000;

export class GtowLedgerView {
  private by = new Map<string, LedgerRow[]>();
  private head = new Map<string, number>();
  /** ids this process noted itself that the seed / the sync has not met yet (they are skipped there) */
  private own = new Set<number>();
  private maxId = 0;
  private lastSync = 0;
  private isReady = false;
  private seeding: Promise<boolean> | null = null;
  private failedAt = 0;
  private source: LedgerSource | null = null;
  lastSeed: (PagedSeedResult & { at: number }) | null = null;
  /** the seed's reader (tests pin "loop") */
  seedMode: "auto" | "worker" | "loop" = "auto";
  private clock: () => number = () => Date.now();

  constructor(readonly keepMs = WALL_SCAN_MS) {}

  setSource(src: LedgerSource | null): void { this.source = src; this.reset(); }

  /** Tests: swap the clock. */
  setClock(fn: () => number): void { this.clock = fn; }

  reset(): void {
    this.by.clear(); this.head.clear(); this.own.clear();
    this.maxId = 0; this.lastSync = 0; this.isReady = false; this.seeding = null; this.failedAt = 0;
  }

  get ready(): boolean { return this.isReady; }

  /** Seeded (true), or the seed failed / there is no source (false — read the SQL instead). Starts the seed once. */
  whenReady(): Promise<boolean> {
    if (this.isReady) return Promise.resolve(true);
    if (this.seeding) return this.seeding;
    if (!this.source || (this.failedAt && this.clock() - this.failedAt < SEED_RETRY_MS)) return Promise.resolve(false);
    const src = this.source;
    const p = (async () => {
      try {
        const db = src.db();
        const since = this.clock() - this.keepMs;
        const start = db.query<{ m: number | null }, [number]>("SELECT min(id) m FROM gtow_requests WHERE ts >= ?").get(since)?.m ?? null;
        let after = start == null ? (db.query<{ m: number | null }, []>("SELECT max(id) m FROM gtow_requests").get()?.m ?? 0) : start - 1;
        const r: PagedSeedResult = start == null
          ? { ok: true, mode: "loop", pages: 0, rows: 0, ms: 0, maxSliceMs: 0 }
          : await pagedSeed({
            path: src.path, db: src.db, mode: this.seedMode, pageSize: 5_000,
            sql: "SELECT id, s, ts, st, o FROM gtow_requests WHERE id > $after AND ts >= $since ORDER BY id LIMIT $limit", params: { since },
            after,
            onPage: (rows: LedgerRow[]) => { for (const row of rows) this.take(row); after = Math.max(after, rows[rows.length - 1]!.id); },
          });
        this.lastSeed = { ...r, at: this.clock() };
        if (!r.ok) { this.failedAt = this.clock(); console.warn(`[gtow-ledger-view] seed failed (${r.error}) — the accounts page reads the ledger table`); return false; }
        if (after > this.maxId) this.maxId = after;
        this.isReady = true;
        this.sync(true);
        console.log(`[gtow-ledger-view] seeded ${r.rows.toLocaleString()} requests (last ${Math.round(this.keepMs / 86_400_000)} d) in ${(r.ms / 1000).toFixed(1)} s (${r.mode}) — longest slice on the loop ${r.maxSliceMs} ms`);
        return true;
      } catch (e) {
        this.failedAt = this.clock();
        console.warn(`[gtow-ledger-view] seed failed: ${e instanceof Error ? e.message : e}`);
        return false;
      } finally {
        this.seeding = null;
      }
    })();
    this.seeding = p;
    return p;
  }

  /** A request this process just wrote (gtowRequestLog.note). Ignored before a seed starts (the seed reads it). */
  note(row: LedgerRow): void {
    if (!this.isReady && !this.seeding) return;
    if (this.own.size > 20_000) this.own.clear();
    this.own.add(row.id);
    this.push(row);
  }

  /** The other processes' rows past the last id seen (one primary-key range read), at most every SYNC_MS. */
  sync(force = false): void {
    if (!this.isReady || !this.source) return;
    const now = this.clock();
    if (!force && now - this.lastSync < SYNC_MS) return;
    this.lastSync = now;
    try {
      const rows = this.source.db().query<LedgerRow, [number]>("SELECT id, s, ts, st, o FROM gtow_requests WHERE id > ? ORDER BY id LIMIT 20000").all(this.maxId);
      for (const r of rows) this.take(r);
    } catch { /* the view is advisory between syncs: a failed read leaves the last rows */ }
  }

  /** gtowRequestLog.windows, from memory: per account, per span, the requests in (now − span, now]. */
  windows(now = this.clock(), spans: Record<string, number> = { h1: 3_600_000, h24: 86_400_000 }): Record<string, Record<string, GtowWindow>> {
    this.sync();
    const out: Record<string, Record<string, GtowWindow>> = {};
    for (const [s, arr] of this.by) {
      const h = this.prune(s, now);
      for (const [name, ms] of Object.entries(spans)) {
        let n = 0, x = 0, ok = 0, oldest = Infinity;
        const byOrigin: Record<string, number> = {};
        for (let i = lowerBound(arr, now - ms, h); i < arr.length; i++) {
          const r = arr[i]!;
          if (r.ts > now) break;
          n++;
          if (r.ts < oldest) oldest = r.ts;
          if (r.st === 429) x++;
          else if (r.st >= 200 && r.st <= 299) ok++;
          byOrigin[r.o] = (byOrigin[r.o] ?? 0) + 1;
        }
        if (n) (out[s] ??= {})[name] = { n, sinceMs: oldest, x429: x, ok, byOrigin };
      }
    }
    return out;
  }

  /** gtowRequestLog.wallState, from memory. */
  wallState(session: string, now = this.clock(), wallMs = 24 * 3_600_000): GtowWallState {
    this.sync();
    const arr = this.by.get(session);
    const rows: { ts: number; st: number }[] = [];
    if (arr) {
      const h = this.prune(session, now);
      const from = now - WALL_SCAN_MS;
      for (let i = arr.length - 1; i >= h && rows.length < WALL_SCAN_ROWS; i--) {
        const r = arr[i]!;
        if (r.ts < from) break;
        if (r.st === 429 || (r.st >= 200 && r.st <= 299)) rows.push({ ts: r.ts, st: r.st });
      }
    }
    return wallFromRows(rows, wallMs);
  }

  /** how many rows it holds (tests, the step line) */
  get size(): number { let n = 0; for (const [s, arr] of this.by) n += arr.length - (this.head.get(s) ?? 0); return n; }

  private take(r: LedgerRow): void {
    if (r.id > this.maxId) this.maxId = r.id;
    if (this.own.delete(r.id)) return;
    this.push(r);
  }

  private push(r: LedgerRow): void {
    // (own rows never move maxId: only a seed / sync read does, so another process's row in a gap is still read)
    let arr = this.by.get(r.s);
    if (!arr) { arr = []; this.by.set(r.s, arr); this.head.set(r.s, 0); }
    const last = arr[arr.length - 1];
    if (!last || last.ts < r.ts || (last.ts === r.ts && last.id < r.id)) arr.push(r);
    else {
      let lo = this.head.get(r.s) ?? 0, hi = arr.length;
      while (lo < hi) { const m = (lo + hi) >> 1, x = arr[m]!; if (x.ts < r.ts || (x.ts === r.ts && x.id < r.id)) lo = m + 1; else hi = m; }
      arr.splice(lo, 0, r);
    }
  }

  private prune(s: string, now: number): number {
    const arr = this.by.get(s);
    if (!arr) return 0;
    const h = lowerBound(arr, now - this.keepMs, this.head.get(s) ?? 0);
    if (h > 4_096) { arr.splice(0, h); this.head.set(s, 0); return 0; }
    this.head.set(s, h);
    return h;
  }
}

/** first index i >= from with arr[i].ts >= x */
function lowerBound(arr: LedgerRow[], x: number, from = 0): number {
  let lo = from, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]!.ts < x) lo = m + 1; else hi = m; }
  return lo;
}

/** The process's view (gtowRequestLog gives it its source and feeds it; routes/gtowAccounts reads it). */
export const gtowLedgerView = new GtowLedgerView();
