import { AsyncLocalStorage } from "node:async_hooks";

/**
 * WHERE AN ANSWER'S TIME GOES (2026-09-24). A per-request timeline for POST /api/fast-solver: every step that can
 * be slow records itself here — reading the wrapper's /state, a chart-server node, sniffing a GTO Wizard token, each
 * GTO Wizard HTTP request — and the route hands the whole list back in the X-Answer-Trace header, which the study
 * poller writes to data/jobs/poller-events.jsonl. Built after hand 750: postflop took 17.9 s (turn/river never
 * answered) while the GTO Wizard ledger showed its own calls finishing in 2 s — the time was going somewhere else.
 *
 * AsyncLocalStorage, not a module variable: several panels solve at once, and each request's steps must land in
 * that request's own trace. Outside a traced request every call here is a no-op.
 *
 * THE EVENT LOOP ITSELF IS WATCHED TOO (2026-09-24). The API is one bun thread: a synchronous gzip, a 36 MB
 * JSON.parse, a SQLite write waiting on a lock — any of them freezes every answer in flight, and the frozen
 * answer's own timeline shows nothing but a hole (hand 140599000044's river: 2.4 s between two node polls with
 * no request in it). startStallMonitor() samples the loop every 50 ms; a stall is a tick that arrives late, and
 * every stall that overlaps a traced request is appended to that request's timeline as "event loop stalled",
 * so a hole with a stall in it is named and a hole without one is a wait on something outside this process.
 */
export type TraceEvent = { at: number; ev: string; ms?: number; info?: string };
type Trace = { t0: number; events: TraceEvent[] };

const als = new AsyncLocalStorage<Trace>();
const MAX_EVENTS = 150;

export async function runTraced<T>(fn: () => Promise<T>): Promise<{ value: T; totalMs: number; trace: TraceEvent[] }> {
  const t: Trace = { t0: Date.now(), events: [] };
  const value = await als.run(t, fn);
  const end = Date.now();
  for (const s of stallsBetween(t.t0, end)) {
    if (t.events.length >= MAX_EVENTS) break;
    t.events.push({ at: Math.max(0, s.at - t.t0), ev: "event loop stalled", ms: s.ms,
      info: "synchronous work elsewhere in the API process blocked this answer for that long" });
  }
  return { value, totalMs: end - t.t0, trace: t.events };
}

function push(e: TraceEvent): void {
  const t = als.getStore();
  if (t && t.events.length < MAX_EVENTS) t.events.push(e);
}

/** A point in time (a decision made, a branch taken). `maxInfo` lets a summary line keep more than the usual 160 chars. */
export function tmark(ev: string, info?: string, maxInfo = 160): void {
  const t = als.getStore();
  if (t) push({ at: Date.now() - t.t0, ev, ...(info ? { info: info.slice(0, maxInfo) } : {}) });
}

/** A step the caller timed itself: started at `startMs` (Date.now() at its start), finished now. For synchronous
 *  work (a gzip, a SQLite insert) and for steps whose name is only known once they are done. */
export function tspan(ev: string, startMs: number, info?: string): void {
  const t = als.getStore();
  if (t) push({ at: startMs - t.t0, ev, ms: Date.now() - startMs, ...(info ? { info: info.slice(0, 160) } : {}) });
}

/** Time one awaited step. `info` may describe the result (a status, a size); a throw is recorded and re-thrown. */
export async function timed<R>(ev: string, fn: () => Promise<R>, info?: (r: R) => string | undefined): Promise<R> {
  const t = als.getStore();
  if (!t) return fn();
  const start = Date.now();
  try {
    const r = await fn();
    let i: string | undefined;
    try { i = info?.(r); } catch { i = undefined; }
    push({ at: start - t.t0, ev, ms: Date.now() - start, ...(i ? { info: i.slice(0, 160) } : {}) });
    return r;
  } catch (e) {
    push({ at: start - t.t0, ev, ms: Date.now() - start, info: `threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`.slice(0, 160) });
    throw e;
  }
}

// ── event-loop stalls ──────────────────────────────────────────────────────────────────────────────────────────
/** a tick this late is a stall worth recording; this late it is worth a log line of its own */
const STALL_MIN_MS = 100;
const STALL_LOG_MS = 300;
const STALL_TICK_MS = 50;
const STALL_KEEP = 400;
const stalls: { at: number; ms: number }[] = [];
let stallTimer: ReturnType<typeof setInterval> | null = null;

// What was running. Until 2026-09-26 a stall line named no culprit, and the access log only showed a request after it
// finished — so the API's requests register here (index.ts middleware) and a stall line lists the ones that were open
// across the blocked interval. None open means a timer or background job held the loop.
type Activity = { label: string; start: number; end?: number };
const open = new Map<number, Activity>();
const ended: Activity[] = [];
let activitySeq = 0;

/** Mark `label` (e.g. "GET /api/dashboard/hands") as running; call the returned function when it ends. */
export function trackActivity(label: string): () => void {
  const id = ++activitySeq;
  const a: Activity = { label, start: Date.now() };
  open.set(id, a);
  return () => {
    if (!open.delete(id)) return;
    a.end = Date.now();
    ended.push(a);
    if (ended.length > 64) ended.splice(0, ended.length - 64);
  };
}

/** Run `fn` (a timer's tick, sync or async) as a named activity, so a stall while it runs names it. */
export function asActivity<T>(label: string, fn: () => T): T {
  const done = trackActivity(label);
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(done) as T;
    done();
    return r;
  } catch (e) {
    done();
    throw e;
  }
}

/** The activities open at any point of [from, to], longest first, as "GET /x (2.1 s)". */
export function activityDuring(from: number, to: number, max = 4): string[] {
  const hit = [...open.values(), ...ended].filter((a) => a.start <= to && (a.end === undefined || a.end >= from));
  const dur = (a: Activity) => (a.end ?? to) - a.start;
  return hit.sort((a, b) => dur(b) - dur(a)).slice(0, max)
    .map((a) => `${a.label} (${(dur(a) / 1000).toFixed(1)} s${a.end === undefined ? ", still open" : ""})`);
}

/** Start sampling the event loop (idempotent; the timer never keeps the process alive). */
export function startStallMonitor(): void {
  if (stallTimer) return;
  let last = Date.now();
  stallTimer = setInterval(() => {
    const now = Date.now();
    const late = now - last - STALL_TICK_MS;
    last = now;
    if (late < STALL_MIN_MS) return;
    stalls.push({ at: now - late, ms: late });
    if (stalls.length > STALL_KEEP) stalls.splice(0, stalls.length - STALL_KEEP);
    if (late >= STALL_LOG_MS) {
      const during = activityDuring(now - late, now);
      console.log(`[stall] the event loop was blocked for ${late} ms at ${new Date(now - late).toISOString()} — ` +
        `synchronous work in this process; every answer in flight waited that long — ` +
        (during.length ? `open: ${during.join(", ")}` : "no request open (a timer or background job)"));
    }
  }, STALL_TICK_MS);
  (stallTimer as { unref?: () => void }).unref?.();
}

/** Stalls that overlap [fromMs, toMs] (wall clock), oldest first. */
export function stallsBetween(fromMs: number, toMs: number): { at: number; ms: number }[] {
  return stalls.filter((s) => s.at + s.ms >= fromMs && s.at <= toMs);
}

/** Test hook: record a stall as the monitor would. */
export function _recordStall(at: number, ms: number): void {
  stalls.push({ at, ms });
}
