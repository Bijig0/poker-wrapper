import type { Database } from "bun:sqlite";
import { pagedSeed, type PagedSeedResult } from "./sqlitePager";

/**
 * THE FINISHED HANDS IN MEMORY, INCREMENTALLY (2026-10-09, catalogue-incremental). routes/dashboard.ts allRows() read
 * every finished hand — 6,437 rows, 18 MB of hand JSON — on the API's loop at every call: the Hands list, Analytics,
 * the Profiles badge (GET /profiles/alerts, every 60 s while a dashboard tab is visible), the strategy catalogue's
 * realized results, the miss queue. 66 ms on an idle machine; under a live session's disk pressure it was the freezes of
 * session_20261009_155740 at 10:26–10:27Z: `GET /api/dashboard/profiles/alerts (11.3 s)` + `analytics (10.9 s)`,
 * `GET /api/dashboard/hands (14.6 s)` (cpu 14–17% of the wall: waiting on the disk).
 *
 * Here the finished rows live in memory, keyed by rowid:
 *   - SEEDED once off the loop (a Bun Worker pages the table, services/sqlitePager.ts);
 *   - SYNCED on read with the wrapper's writes (another process): `max(rowid)` and `max(updated_at)` (two index reads);
 *     when either moved — or the newest write is under OVERLAP_MS old (the wrapper inserts a row, then patches its data
 *     a moment later without moving updated_at) — the rows past the last rowid or with updated_at in the overlap are read
 *     (a few, by index: idx_hands_updated, packages/data-root/handsSchema.ts). A row that is no longer finished leaves.
 *   - RESEEDED every RESEED_MS when nothing holds it (an offline script's UPDATE without updated_at, e.g. backfillRake).
 * `rows()` is null until the seed lands — the caller reads the table as before.
 */
export interface HandsViewSource { path: string; db: () => Database | null }
export interface HandsViewRow { rowid: number; status?: string | null; updated_at?: number | null }

export const HANDS_VIEW_OVERLAP_MS = 5_000;
export const HANDS_VIEW_RESEED_MS = 6 * 3_600_000;
const SEED_RETRY_MS = 5 * 60_000;

export class HandsView<T extends HandsViewRow> {
  private byRow = new Map<number, T>();
  private sorted: T[] | null = null;
  private maxRowid = 0;
  private maxUpd = 0;
  private isReady = false;
  private seeding: Promise<boolean> | null = null;
  private failedAt = 0;
  private seededAt = 0;
  private source: HandsViewSource | null = null;
  lastSeed: (PagedSeedResult & { at: number }) | null = null;
  seedMode: "auto" | "worker" | "loop" = "auto";
  /** a reseed waits while this is true (a poker session is live, or the setup page is open) */
  hold: () => boolean = () => false;
  private clock: () => number = () => Date.now();

  /** `cols`: the columns a row carries (must include rowid, status, updated_at); `finished`: the SQL condition. */
  constructor(private readonly cols: string, private readonly finished: string, private readonly isFinished: (r: T) => boolean) {}

  setSource(src: HandsViewSource | null): void { this.source = src; this.reset(); }
  setClock(fn: () => number): void { this.clock = fn; }
  reset(): void {
    this.byRow.clear(); this.sorted = null; this.maxRowid = 0; this.maxUpd = 0;
    this.isReady = false; this.seeding = null; this.failedAt = 0; this.seededAt = 0;
  }
  get ready(): boolean { return this.isReady; }
  get size(): number { return this.byRow.size; }

  /** Seeded (true), or no source / the seed failed (false: read the table). Starts the seed once. */
  whenReady(): Promise<boolean> {
    if (this.isReady && !this.seeding) return Promise.resolve(true);
    return this.seed();
  }

  private seed(): Promise<boolean> {
    if (this.seeding) return this.seeding;
    const src = this.source;
    if (!src || (!this.isReady && this.failedAt && this.clock() - this.failedAt < SEED_RETRY_MS)) return Promise.resolve(this.isReady);
    const p = (async () => {
      try {
        const db = src.db();
        if (!db) return this.isReady;
        // what the table says now: the sync after the seed reads everything written since (rowid past the seed's last,
        // or updated_at from here on)
        const u0 = db.query<{ u: number | null }, []>("SELECT max(updated_at) u FROM hands").get()?.u ?? 0;
        const fresh = new Map<number, T>();
        let last = 0;
        const r = await pagedSeed({
          path: src.path, db: () => src.db()!, mode: this.seedMode, pageSize: 300,
          sql: `SELECT rowid AS id, ${this.cols} FROM hands WHERE rowid > $after AND ${this.finished} ORDER BY rowid LIMIT $limit`,
          onPage: (rows: (T & { id?: number })[]) => {
            for (const row of rows) { delete row.id; fresh.set(row.rowid, row); if (row.rowid > last) last = row.rowid; }
          },
        });
        this.lastSeed = { ...r, at: this.clock() };
        if (!r.ok) { this.failedAt = this.clock(); console.warn(`[hands-view] seed failed (${r.error}) — the hands table is read as before`); return this.isReady; }
        this.byRow = fresh; this.sorted = null;
        this.maxRowid = last; this.maxUpd = Math.max(0, u0 - HANDS_VIEW_OVERLAP_MS);
        const wasReady = this.isReady;
        this.isReady = true;
        this.seededAt = this.clock();
        this.sync(true);
        console.log(`[hands-view] ${wasReady ? "reseeded" : "seeded"} ${this.byRow.size.toLocaleString()} finished hands in ${(r.ms / 1000).toFixed(1)} s (${r.mode}, ${r.pages} pages) — longest slice on the loop ${r.maxSliceMs} ms`);
        return true;
      } catch (e) {
        this.failedAt = this.clock();
        console.warn(`[hands-view] seed failed: ${e instanceof Error ? e.message : e}`);
        return this.isReady;
      } finally {
        this.seeding = null;
      }
    })();
    this.seeding = p;
    return p;
  }

  /** The other process's writes since the last read (see the header). Never throws. */
  sync(force = false): void {
    const src = this.source;
    if (!this.isReady || !src) return;
    try {
      const db = src.db();
      if (!db) return;
      const now = this.clock();
      const topRow = db.query<{ r: number | null }, []>("SELECT max(rowid) r FROM hands").get()?.r ?? 0;
      const topUpd = db.query<{ u: number | null }, []>("SELECT max(updated_at) u FROM hands").get()?.u ?? 0;
      if (!force && topRow <= this.maxRowid && topUpd <= this.maxUpd && now - topUpd >= HANDS_VIEW_OVERLAP_MS) return;
      const since = this.maxUpd - HANDS_VIEW_OVERLAP_MS;
      const rows = db.query<T, [number, number]>(`SELECT ${this.cols} FROM hands WHERE rowid > ? OR updated_at >= ?`).all(this.maxRowid, since);
      for (const row of rows) {
        if (this.isFinished(row)) this.byRow.set(row.rowid, row);
        else this.byRow.delete(row.rowid);
        if (row.rowid > this.maxRowid) this.maxRowid = row.rowid;
      }
      if (rows.length) this.sorted = null;
      this.maxUpd = Math.max(this.maxUpd, topUpd);
    } catch { /* the next read catches up */ }
  }

  /** Every finished row, by rowid (a fresh array over the shared rows), or null before the seed lands. */
  rows(): T[] | null {
    if (!this.isReady) { void this.seed(); return null; }
    if (this.clock() - this.seededAt > HANDS_VIEW_RESEED_MS && !this.seeding) {
      let held = true;
      try { held = this.hold(); } catch { /* held */ }
      if (!held) void this.seed();
    }
    this.sync();
    if (!this.sorted) this.sorted = [...this.byRow.values()].sort((a, b) => a.rowid - b.rowid);
    return this.sorted.slice();
  }
}
