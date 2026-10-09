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

import { asActivity } from "./answerTrace";

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
/** when each key was last asked for by a caller (keepWarm refreshes only what someone is reading) */
const askedAt = new Map<string, number>();
/** a refresh off the request path runs as a named activity, so a [stall] across it says which cache it was */
const named = <T>(key: string, compute: () => T | Promise<T>) => () => asActivity(`cache refresh ${key}`, compute) as T | Promise<T>;

function refreshBehind<T>(key: string, compute: () => T | Promise<T>): void {
  const e = heavy.get(key);
  if (!e || e.refreshing) return;
  skipping.delete(key);
  e.refreshing = true;
  void (async () => {
    try {
      await yieldToLive();
      heavy.set(key, { at: clock(), value: await named(key, compute)(), refreshing: false });
    } catch (err) {
      e.refreshing = false;
      console.warn(`[livePriority] refreshing ${key} failed (the old value stays): ${err instanceof Error ? err.message : err}`);
    }
  })();
}

function coldBuild<T>(key: string, compute: () => T | Promise<T>, behindLive: boolean): Promise<T> {
  let p = cold.get(key) as Promise<T> | undefined;
  if (!p) {
    p = (async () => {
      try {
        if (behindLive) await yieldToLive();
        const value = await (behindLive ? named(key, compute)() : compute());
        heavy.set(key, { at: clock(), value, refreshing: false });
        return value;
      } finally { cold.delete(key); }
    })();
    cold.set(key, p);
  }
  return p;
}

export async function cachedBehindLive<T>(key: string, ttlMs: number, compute: () => T | Promise<T>,
  opts: { holdWhile?: () => boolean } = {}): Promise<T> {
  askedAt.set(key, clock());
  const e = heavy.get(key);
  if (e && clock() - e.at < ttlMs) return e.value as T;
  // `holdWhile` (2026-10-09: a poker session is live): the stale copy is served and NOT rebuilt — a rebuild is
  // synchronous work on the answering thread; only a cold key is still built
  if (e) { if (!opts.holdWhile?.()) refreshBehind(key, compute); else noteSkip(key); return e.value as T; }
  return coldBuild(key, compute, false);
}

/** One log line per key each time its refreshes start being skipped (cleared when one runs again). */
const skipping = new Set<string>();
function noteSkip(key: string): void {
  if (skipping.has(key)) return;
  skipping.add(key);
  console.log(`[livePriority] ${key}: not rebuilt while a poker session is live — the copy it has is served until the session ends`);
}

/** The cached value and its age, never computing (null = cold). A read counts as demand for keepWarm. */
export function peekCached<T>(key: string): { value: T; ageMs: number } | null {
  askedAt.set(key, clock());
  const e = heavy.get(key);
  return e ? { value: e.value as T, ageMs: clock() - e.at } : null;
}

/** Is a cold build of `key` running (the first value is on its way)? */
export const coldBuilding = (key: string): boolean => cold.has(key);

/** Forget a key (a write route changed what it shows): the next caller builds it. */
export function forgetCached(key: string): void { heavy.delete(key); }

/** Replace the cached value (a write route that has just computed the fresh payload). */
export function setCached<T>(key: string, value: T): void {
  heavy.set(key, { at: clock(), value, refreshing: false });
}

/** Build a cold key in the background, behind live answers, so the first request finds it warm (boot). */
export function warmBehindLive<T>(key: string, compute: () => T | Promise<T>): Promise<T | null> {
  if (heavy.has(key)) return Promise.resolve(heavy.get(key)!.value as T);
  return coldBuild(key, compute, true).catch((err) => {
    console.warn(`[livePriority] warming ${key} failed (the first request builds it): ${err instanceof Error ? err.message : err}`);
    return null;
  });
}

/**
 * REFRESH-AHEAD (2026-10-09): every `everyMs`, a key that someone asked for in the last `demandMs` and that is within
 * `leadMs` of its TTL (or past it) is rebuilt behind live answers BEFORE a caller finds it stale — so a poll never
 * waits, and a key nobody reads costs nothing (no rebuild while only Brady's tables are open and no page asks).
 * Returns a stop function.
 */
export function keepWarm<T>(key: string, ttlMs: number, compute: () => T | Promise<T>,
  opts: { leadMs?: number; demandMs?: number; everyMs?: number; skipWhile?: () => boolean } = {}): () => void {
  const leadMs = opts.leadMs ?? Math.min(60_000, ttlMs / 4), demandMs = opts.demandMs ?? 10 * 60_000;
  const t = setInterval(() => {
    const e = heavy.get(key);
    if (!e || clock() - (askedAt.get(key) ?? 0) > demandMs) return;
    if (clock() - e.at < ttlMs - leadMs) return;
    // `skipWhile` (a poker session is live): no refresh-ahead — the copy is served stale until it ends
    if (opts.skipWhile?.()) { noteSkip(key); return; }
    refreshBehind(key, compute);
  }, opts.everyMs ?? Math.max(1_000, Math.min(30_000, leadMs / 2)));
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
}

/** Status for /api/build-style pages and tests. */
export const liveState = () => ({ inFlight, lastEndAt });

/** Tests only: reset the counters and swap the clock. */
export function __resetLivePriority(nowFn?: () => number): void {
  inFlight = 0; lastEndAt = 0; clock = nowFn ?? (() => Date.now());
  heavy.clear(); cold.clear(); askedAt.clear(); skipping.clear();
}

/** Hono middleware for a heavy read-only page: a GET waits for live answers first (yieldToLive); writes never wait. */
export async function yieldFirst(c: { req: { method: string } }, next: () => Promise<void>): Promise<void> {
  if (c.req.method === "GET") await yieldToLive();
  await next();
}
