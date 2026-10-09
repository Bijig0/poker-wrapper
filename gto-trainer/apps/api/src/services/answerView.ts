import type { LoggedAnswer } from "./answerLog";
import { pathCodesOf } from "./answerPathCodes";

/**
 * THE ANSWER LOG IN MEMORY, INCREMENTALLY (2026-10-09, catalogue-incremental). answerLog.rows(days) re-read and
 * re-materialised the whole table on the live API's thread whenever anything had written since the last read — and
 * during a session something writes every few seconds, so every catalogue build paid for all of it: `cache refresh
 * sources/strategies 8.9 s: answer log 32 d 6.4 s` (12,499 answers, 16 MB) 85 s before session_20261009_155740.
 *
 * This is the pure part: the rows, ordered by (ts, id), with
 *   - upsert(row)    a new row (the writer pushes it at once) or a changed one (attach, a tail read) — by id;
 *   - evict(now)     rows older than `maxAgeMs` leave (age eviction); `completeSince` says from when the view holds
 *                    EVERY row of the table, so a caller asking further back goes to SQL instead of being short-changed;
 *   - window(since)  a fresh array over the shared rows from `since` (callers treat rows as read-only, as before).
 * Each row's chain-path codes (services/answerPathCodes) are kept beside it, computed once when the row arrives.
 * services/answerLog.ts owns the seed (off the loop), the tail read and the writer's push.
 */
export class AnswerView {
  private rowsSorted: LoggedAnswer[] = [];
  /** rows before `head` are evicted (spliced away in batches) */
  private head = 0;
  private byId = new Map<number, LoggedAnswer>();
  private codes = new WeakMap<LoggedAnswer, string[]>();
  /** the view holds every row of the table with ts >= this (−∞ = the whole table) */
  completeSince = Number.NEGATIVE_INFINITY;
  maxId = 0;

  constructor(readonly maxAgeMs: number) {}

  get size(): number { return this.rowsSorted.length - this.head; }

  has(id: number): boolean { return this.byId.has(id); }
  get(id: number): LoggedAnswer | undefined { return this.byId.get(id); }

  /** Add a row, or replace the one with its id. A row already past the age bound is not kept. */
  upsert(row: LoggedAnswer, codes?: string[], now = Date.now()): void {
    if (row.id > this.maxId) this.maxId = row.id;
    const old = this.byId.get(row.id);
    if (old) {
      const i = this.indexOf(old);
      if (i >= 0) {
        if (old.ts === row.ts) {
          this.rowsSorted[i] = row;
          this.byId.set(row.id, row);
          this.codes.set(row, codes ?? pathCodesOf(row));
          return;
        }
        this.rowsSorted.splice(i, 1);
      }
      this.byId.delete(row.id);
    }
    if (row.ts < now - this.maxAgeMs) return;
    const n = this.rowsSorted.length;
    const last = n > this.head ? this.rowsSorted[n - 1]! : null;
    if (!last || last.ts < row.ts || (last.ts === row.ts && last.id < row.id)) this.rowsSorted.push(row);
    else this.rowsSorted.splice(this.lowerBound(row.ts, row.id), 0, row);
    this.byId.set(row.id, row);
    this.codes.set(row, codes ?? pathCodesOf(row));
  }

  /** Drop the rows older than the age bound; returns how many left. */
  evict(now = Date.now()): number {
    const cutoff = now - this.maxAgeMs;
    let h = this.head, n = 0;
    while (h < this.rowsSorted.length && this.rowsSorted[h]!.ts < cutoff) { this.byId.delete(this.rowsSorted[h]!.id); h++; n++; }
    if (n) this.completeSince = Math.max(this.completeSince, cutoff);
    this.head = h;
    if (this.head > 4_096 && this.head * 2 > this.rowsSorted.length) { this.rowsSorted.splice(0, this.head); this.head = 0; }
    return n;
  }

  /** Does the view hold every row with ts >= `sinceTs`? */
  covers(sinceTs: number): boolean { return sinceTs >= this.completeSince; }

  /** The rows with ts >= `sinceTs`, oldest first: a fresh array over the shared (read-only) rows. */
  window(sinceTs: number): LoggedAnswer[] {
    return this.rowsSorted.slice(Math.max(this.head, this.lowerBound(sinceTs, Number.NEGATIVE_INFINITY)));
  }

  /** The row's chain-path codes (computed when it arrived). */
  codesOf(row: LoggedAnswer): string[] {
    let c = this.codes.get(row);
    if (!c) { c = pathCodesOf(row); this.codes.set(row, c); }
    return c;
  }

  /** first index >= head whose (ts, id) >= (ts, id) */
  private lowerBound(ts: number, id: number): number {
    let lo = this.head, hi = this.rowsSorted.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1, r = this.rowsSorted[m]!;
      if (r.ts < ts || (r.ts === ts && r.id < id)) lo = m + 1; else hi = m;
    }
    return lo;
  }

  private indexOf(row: LoggedAnswer): number {
    const i = this.lowerBound(row.ts, row.id);
    return this.rowsSorted[i] === row ? i : this.rowsSorted.indexOf(row, this.head);
  }
}
