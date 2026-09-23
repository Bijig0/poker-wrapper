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
 */
export type TraceEvent = { at: number; ev: string; ms?: number; info?: string };
type Trace = { t0: number; events: TraceEvent[] };

const als = new AsyncLocalStorage<Trace>();
const MAX_EVENTS = 150;

export async function runTraced<T>(fn: () => Promise<T>): Promise<{ value: T; totalMs: number; trace: TraceEvent[] }> {
  const t: Trace = { t0: Date.now(), events: [] };
  const value = await als.run(t, fn);
  return { value, totalMs: Date.now() - t.t0, trace: t.events };
}

function push(e: TraceEvent): void {
  const t = als.getStore();
  if (t && t.events.length < MAX_EVENTS) t.events.push(e);
}

/** A point in time (a decision made, a branch taken). */
export function tmark(ev: string, info?: string): void {
  const t = als.getStore();
  if (t) push({ at: Date.now() - t.t0, ev, ...(info ? { info: info.slice(0, 160) } : {}) });
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
