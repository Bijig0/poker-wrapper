/**
 * EACH GTO WIZARD ACCOUNT'S LOAD, IN MEMORY (2026-10-08, least-loaded routing — services/gtowSessions `GTOW_ROUTE`).
 *
 * Brady (2026-10-08): "for the same type of work … rotate through all the accounts we have … PER request, this sort of
 * balances out so that no individual account gets too much and is split evenly". Routing orders the capable accounts by
 * the requests each sent in the trailing HOUR (GTO Wizard's binding limit: 2,250 per rolling hour per account, a trip
 * costs the account ~a day — memory gtow-quota-unit-unknown) and the trailing 24 h (the DAY throttle seen near ~6,000).
 *
 * THE COUNT MUST BE CHEAP: route() runs for every tree, on the API's one event loop (its freezes are a known problem), so
 * it never queries the ledger. The counter keeps each account's request timestamps for the trailing 24 h:
 *   - SEEDED once from gtow_requests (one query for the last 24 h, every origin) the first time it is read;
 *   - FED by this process's own ledger writes (gtowRequestLog.note → note()), at once;
 *   - SYNCED with every OTHER process's writes (a harness, a study, the factory — they all spend the same accounts) by a
 *     primary-key range read of the rows past the last id seen (`id > ?`, normally a few dozen rows), at most every
 *     SYNC_MS, and only from the keeper's timer or a stale read — so another process's requests count within ~30 s.
 * A tree just routed is RESERVED (reserve()): TREE_RESERVE requests on its account until that many of its requests are
 * noted (or RESERVE_MS passes), so trees posted in the same instant (a blend's plans) do not all take the same account.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** how stale the other processes' share may get before a read syncs it */
const SYNC_MS = 30_000;
/** what a routed tree is expected to cost its account before its own requests are noted: the tree + solution POSTs and
 *  ~3 polls (ledger 2026-09-26..10-08: a cold postflop tree's first node is 1-3 polls) */
export const TREE_RESERVE = 5;
const RESERVE_MS = 15_000;

/** One account's trailing counts. `pending` = reserved for trees just routed, not yet noted. */
export interface LoadCounts { h1: number; h24: number; pending: number }

/** Where the counter reads the ledger: every row of the last `sinceTs` (seed), or every row past `afterId` (sync). */
export interface LoadSource {
  seed(sinceTs: number): { id: number; s: string; ts: number }[];
  after(afterId: number): { id: number; s: string; ts: number }[];
}

/** What routing needs from the counter (a test hands route() fixed numbers through this). */
export interface LoadView { counts(id: string, now?: number): LoadCounts; reserve?(id: string): void }

export class GtowLoad implements LoadView {
  private ts = new Map<string, number[]>();
  private head = new Map<string, number>();
  /** row ids this process noted itself since the last sync (the sync skips them) */
  private own = new Set<number>();
  private maxId = 0;
  private seeded = false;
  private lastSync = 0;
  private source: LoadSource | null = null;
  private pending = new Map<string, { until: number; left: number }[]>();

  setSource(src: LoadSource | null): void {
    this.source = src;
    this.seeded = false;
  }

  /** A request this process just wrote to the ledger (`id`: its row id, when known). */
  note(s: string, ts: number, id?: number): void {
    this.push(s, ts);
    if (id != null) {
      // (the next sync drops each one as it meets it; a process whose sync never runs keeps the set bounded here)
      if (this.own.size > 20_000) this.own.clear();
      this.own.add(id);
    }
    const p = this.pending.get(s);
    if (p) {
      const now = Date.now();
      const r = p.find((x) => x.left > 0 && x.until > now);
      if (r) r.left--;
    }
  }

  /** A tree was just routed to `s`: count its expected requests now (see TREE_RESERVE). */
  reserve(s: string, n = TREE_RESERVE): void {
    const now = Date.now();
    const p = (this.pending.get(s) ?? []).filter((x) => x.left > 0 && x.until > now);
    p.push({ until: now + RESERVE_MS, left: n });
    this.pending.set(s, p);
  }

  counts(s: string, now = Date.now()): LoadCounts {
    this.ensure(now);
    const arr = this.ts.get(s) ?? [];
    this.prune(s, now);
    const h = this.head.get(s) ?? 0;
    const h24 = arr.length - h;
    const h1 = arr.length - lowerBound(arr, now - HOUR_MS, h);
    const pending = (this.pending.get(s) ?? []).reduce((n, x) => n + (x.until > now ? x.left : 0), 0);
    return { h1, h24, pending };
  }

  /** Seed (once) and sync (when stale) from the ledger. Never throws. */
  ensure(now = Date.now(), force = false): void {
    if (!this.source) return;
    try {
      if (!this.seeded) {
        this.seeded = true;
        this.lastSync = now;
        this.ts.clear(); this.head.clear(); this.own.clear();
        for (const r of this.source.seed(now - DAY_MS)) { this.push(r.s, r.ts); if (r.id > this.maxId) this.maxId = r.id; }
        return;
      }
      if (!force && now - this.lastSync < SYNC_MS) return;
      this.lastSync = now;
      for (const r of this.source.after(this.maxId)) {
        if (r.id > this.maxId) this.maxId = r.id;
        if (this.own.delete(r.id)) continue;
        this.push(r.s, r.ts);
      }
    } catch { /* the counter is advisory: a failed read leaves the last counts */ }
  }

  private push(s: string, ts: number): void {
    let arr = this.ts.get(s);
    if (!arr) { arr = []; this.ts.set(s, arr); this.head.set(s, 0); }
    // nearly always in order; another process's rows can arrive a little late — keep the array sorted
    if (!arr.length || arr[arr.length - 1]! <= ts) arr.push(ts);
    else arr.splice(lowerBound(arr, ts, this.head.get(s) ?? 0), 0, ts);
  }

  private prune(s: string, now: number): void {
    const arr = this.ts.get(s);
    if (!arr) return;
    const h = lowerBound(arr, now - DAY_MS, this.head.get(s) ?? 0);
    if (h > 4_096) { arr.splice(0, h); this.head.set(s, 0); }
    else this.head.set(s, h);
  }
}

/** first index i >= from with arr[i] >= x */
function lowerBound(arr: number[], x: number, from = 0): number {
  let lo = from, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]! < x) lo = m + 1; else hi = m; }
  return lo;
}

/** The process's counter (gtowRequestLog feeds it and gives it its source; gtowSessions' pool reads it). */
export const gtowLoad = new GtowLoad();
