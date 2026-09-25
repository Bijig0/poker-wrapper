/**
 * LIVE ANSWERS GO FIRST (2026-09-26). The API is one Bun thread: the study poller's answer for the decision hero is
 * facing, and a dashboard page recomputing its tables, share one event loop. api.log counted 10-57 stalls a second or
 * longer every hour of 2026-09-24/25 — the Sessions list alone held the loop 4-10 s, the Hands list (re-polled every 15 s
 * while its tab is open) 0.3-3 s — and every answer in flight waited through each one.
 *
 * So the answer path marks itself (liveBegin / liveEnd around a live or warm-up fastSolve), and heavy read-only work —
 * the dashboard's and the Sources tab's GET routes — waits its turn: while a live answer is being computed, and for a
 * short grace after (the poller pushes the answer and re-probes the table), a heavy request is held, never started.
 * It still runs after `maxWaitMs`, so a page can never hang behind a stuck solve.
 *
 * Pure bookkeeping; the clock is injectable for tests.
 */

let inFlight = 0;
let lastEndAt = 0;
let clock: () => number = () => Date.now();

/** After the last live answer finishes, heavy work keeps waiting this long (the push and the next probe). */
export const LIVE_GRACE_MS = 1_500;

export function liveBegin(): void { inFlight++; }
export function liveEnd(): void {
  inFlight = Math.max(0, inFlight - 1);
  lastEndAt = clock();
}

/** A live answer is being computed now, or finished less than `graceMs` ago. */
export function liveBusy(graceMs = LIVE_GRACE_MS): boolean {
  return inFlight > 0 || clock() - lastEndAt < graceMs;
}

/** Run `fn` as live work: heavy work waits while it runs (a throw still ends it). */
export async function asLive<T>(fn: () => Promise<T>): Promise<T> {
  liveBegin();
  try { return await fn(); } finally { liveEnd(); }
}

/**
 * Wait until no live answer is being computed (checked every `pollMs`), at most `maxWaitMs`; returns how long it waited.
 * Heavy handlers await this before they start.
 */
export async function yieldToLive(maxWaitMs = 15_000, pollMs = 100): Promise<number> {
  const t0 = clock();
  while (liveBusy() && clock() - t0 < maxWaitMs) await new Promise((r) => setTimeout(r, pollMs));
  return clock() - t0;
}

/**
 * A heavy value that may be a little old (a catalogue a wrapper panel re-reads every few seconds): fresh for `ttlMs`,
 * after that the old value is served at once while ONE recompute runs behind the live answers (yieldToLive first).
 * Only a cold key computes on the caller's time, and concurrent cold callers share that one computation.
 */
const heavy = new Map<string, { at: number; value: unknown; refreshing: boolean }>();
const cold = new Map<string, Promise<unknown>>();
export async function cachedBehindLive<T>(key: string, ttlMs: number, compute: () => T | Promise<T>): Promise<T> {
  const e = heavy.get(key);
  if (e && clock() - e.at < ttlMs) return e.value as T;
  if (e) {
    if (!e.refreshing) {
      e.refreshing = true;
      void (async () => {
        try {
          await yieldToLive();
          heavy.set(key, { at: clock(), value: await compute(), refreshing: false });
        } catch (err) {
          e.refreshing = false;
          console.warn(`[livePriority] refreshing ${key} failed (the old value stays): ${err instanceof Error ? err.message : err}`);
        }
      })();
    }
    return e.value as T;
  }
  let p = cold.get(key) as Promise<T> | undefined;
  if (!p) {
    p = (async () => {
      try {
        const value = await compute();
        heavy.set(key, { at: clock(), value, refreshing: false });
        return value;
      } finally { cold.delete(key); }
    })();
    cold.set(key, p);
  }
  return p;
}

/** Status for /api/build-style pages and tests. */
export const liveState = () => ({ inFlight, lastEndAt });

/** Tests only: reset the counters and swap the clock. */
export function __resetLivePriority(nowFn?: () => number): void {
  inFlight = 0; lastEndAt = 0; clock = nowFn ?? (() => Date.now());
  heavy.clear(); cold.clear();
}

/** Hono middleware for a heavy read-only page: a GET waits for live answers first (yieldToLive); writes never wait. */
export async function yieldFirst(c: { req: { method: string } }, next: () => Promise<void>): Promise<void> {
  if (c.req.method === "GET") await yieldToLive();
  await next();
}
