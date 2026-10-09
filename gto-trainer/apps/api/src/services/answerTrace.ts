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
export const STALL_LOG_MS = 300;
const STALL_TICK_MS = 50;
const STALL_KEEP = 400;
/** a stall at least this long carries the per-step timings of the ticks open across it */
export const STALL_STEPS_MS = 1_000;
const stalls: { at: number; ms: number }[] = [];
let stallTimer: ReturnType<typeof setInterval> | null = null;

/**
 * A LOGGED stall (>= STALL_LOG_MS), kept with what it was (2026-10-07). `cpuMs` is the CPU time this process used
 * across the blocked interval (process.cpuUsage(), every thread): about the wall time = the loop was COMPUTING; about
 * zero = it was WAITING (disk, a SQLite lock, the OS not scheduling it). `open` is what the [stall] line named, steps
 * included. The last STALL_KEEP are kept, memory only, for GET /api/load (services/machineLoad.ts).
 */
export interface StallRecord { at: number; ms: number; cpuMs: number | null; open: string[] }
const logged: StallRecord[] = [];

// What was running. Until 2026-09-26 a stall line named no culprit, and the access log only showed a request after it
// finished — so the API's requests register here (index.ts middleware) and a stall line lists the ones that were open
// across the blocked interval. None open means a timer or background job held the loop.
//
// STEPS (2026-10-07). "timer answerReconciler (55.5 s)" named the tick but not what inside it held the loop (the same
// pass is 12 ms standalone), so a tick marks its synchronous steps — step("hands query", () => …) — and a stall of a
// second or more prints them: "timer answerReconciler (55.5 s: hands query 55.4 s)". A step's time is its SYNCHRONOUS
// part only (until the function returns), which is exactly what blocks the loop; repeats of a name are summed (×n).
type StepStat = { ms: number; n: number; first: number; last: number };
type Activity = { label: string; start: number; end?: number; steps?: Map<string, StepStat> };
const open = new Map<number, Activity>();
const ended: Activity[] = [];
let activitySeq = 0;
const activityAls = new AsyncLocalStorage<Activity>();
const MAX_STEP_NAMES = 24;

function begin(label: string): { a: Activity; done: () => void } {
  const id = ++activitySeq;
  const a: Activity = { label, start: Date.now() };
  open.set(id, a);
  return {
    a,
    done: () => {
      if (!open.delete(id)) return;
      a.end = Date.now();
      ended.push(a);
      if (ended.length > 64) ended.splice(0, ended.length - 64);
    },
  };
}

/** Mark `label` (e.g. "GET /api/dashboard/hands") as running; call the returned function when it ends. */
export function trackActivity(label: string): () => void {
  return begin(label).done;
}

/** Run `fn` (a timer's tick, sync or async) as a named activity, so a stall while it runs names it — and the steps it
 *  marks with step() (in it or in anything it calls, across awaits) are timed into it. */
export function asActivity<T>(label: string, fn: () => T): T {
  const { a, done } = begin(label);
  try {
    const r = activityAls.run(a, fn);
    if (r instanceof Promise) return r.finally(done) as T;
    done();
    return r;
  } catch (e) {
    done();
    throw e;
  }
}

/** Times a synchronous step into an activity (see step()). */
export type Stepper = <R>(name: string, fn: () => R) => R;
const noStepper: Stepper = (_name, fn) => fn();

function addStep(a: Activity, name: string, start: number, ms: number): void {
  const steps = (a.steps ??= new Map());
  let s = steps.get(name);
  if (!s) {
    if (steps.size >= MAX_STEP_NAMES) return;
    steps.set(name, (s = { ms: 0, n: 0, first: start, last: start }));
  }
  s.ms += ms;
  s.n++;
  s.last = start + ms;
}

const stepperOf = (a: Activity): Stepper => (name, fn) => {
  const w0 = Date.now();
  const t0 = performance.now();
  try { return fn(); } finally { addStep(a, name, w0, performance.now() - t0); }
};

/** Time `fn`'s synchronous run as a step of the activity this code runs in (asActivity). Outside one it just runs. */
export function step<R>(name: string, fn: () => R): R {
  const a = activityAls.getStore();
  return a ? stepperOf(a)(name, fn) : fn();
}

/** The current activity's step timer, for callbacks that run outside its async context (a WebSocket's onmessage). */
export function currentStepper(): Stepper {
  const a = activityAls.getStore();
  return a ? stepperOf(a) : noStepper;
}

const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

/** An activity's steps that ran inside [from, to], longest first: "hands query 55.4 s, enrich ×12 300 ms". */
function stepsDuring(a: Activity, from: number, to: number, max = 3): string {
  if (!a.steps) return "";
  const hit = [...a.steps.entries()].filter(([, s]) => s.first <= to && s.last >= from && s.ms >= 1);
  return hit.sort((x, y) => y[1].ms - x[1].ms).slice(0, max)
    .map(([name, s]) => `${name}${s.n > 1 ? ` ×${s.n}` : ""} ${secs(s.ms)}`).join(", ");
}

/** The activities open at any point of [from, to], longest first, as "GET /x (2.1 s)" — with their steps inside the
 *  interval when `withSteps`: "timer answerReconciler (55.5 s: hands query 55.4 s)". */
export function activityDuring(from: number, to: number, max = 4, withSteps = false): string[] {
  const hit = [...open.values(), ...ended].filter((a) => a.start <= to && (a.end === undefined || a.end >= from));
  const dur = (a: Activity) => (a.end ?? to) - a.start;
  return hit.sort((a, b) => dur(b) - dur(a)).slice(0, max).map((a) => {
    const steps = withSteps ? stepsDuring(a, from, to) : "";
    return `${a.label} (${(dur(a) / 1000).toFixed(1)} s${a.end === undefined ? ", still open" : ""}${steps ? `: ${steps}` : ""})`;
  });
}

/** "cpu 55.2 s (99% of the wall: computing)" — what this process did while its loop was blocked. */
export function cpuVerdict(cpuMs: number | null, wallMs: number): string {
  if (cpuMs == null) return "cpu unknown";
  const r = wallMs > 0 ? cpuMs / wallMs : 0;
  const what = r >= 0.7 ? "computing" : r <= 0.2 ? "waiting: disk, a lock, or the process not scheduled" : "part computing, part waiting";
  return `cpu ${secs(cpuMs)} (${Math.round(r * 100)}% of the wall: ${what})`;
}

/** The [stall] line for a stall of `ms` at `at`, and the record kept for /api/load. */
export function describeStall(at: number, ms: number, cpuMs: number | null): { line: string; rec: StallRecord } {
  const during = activityDuring(at, at + ms, 4, ms >= STALL_STEPS_MS);
  const line = `[stall] the event loop was blocked for ${ms} ms at ${new Date(at).toISOString()} — ` +
    `synchronous work in this process; every answer in flight waited that long — ${cpuVerdict(cpuMs, ms)} — ` +
    (during.length ? `open: ${during.join(", ")}` : "no request open (a timer or background job)");
  return { line, rec: { at, ms, cpuMs, open: during } };
}

function keep(rec: StallRecord): void {
  logged.push(rec);
  if (logged.length > STALL_KEEP) logged.splice(0, logged.length - STALL_KEEP);
}

const cpuNowUs = (): number | null => {
  try { const u = process.cpuUsage(); return u.user + u.system; } catch { return null; }
};

/** Start sampling the event loop (idempotent; the timer never keeps the process alive). */
export function startStallMonitor(): void {
  if (stallTimer) return;
  let last = Date.now();
  let lastCpu = cpuNowUs();
  stallTimer = setInterval(() => {
    const now = Date.now();
    const cpu = cpuNowUs();
    const late = now - last - STALL_TICK_MS;
    // the CPU this process used since the previous tick — across a stall, the blocked interval (plus one 50 ms tick)
    const cpuMs = cpu != null && lastCpu != null ? Math.max(0, Math.round((cpu - lastCpu) / 1000)) : null;
    last = now;
    lastCpu = cpu;
    if (late < STALL_MIN_MS) return;
    stalls.push({ at: now - late, ms: late });
    if (stalls.length > STALL_KEEP) stalls.splice(0, stalls.length - STALL_KEEP);
    let rec: StallRecord | null = null;
    if (late >= STALL_LOG_MS) {
      const d = describeStall(now - late, late, cpuMs);
      rec = d.rec;
      keep(rec);
      console.log(d.line);
    }
    summary.add(late, rec);
  }, STALL_TICK_MS);
  // the 5-min summary also prints for a window with no stall at all (its absence would read as "the API was down")
  summaryTimer = setInterval(() => {
    let extra: string | undefined;
    try { extra = summaryExtra?.(); } catch { /* the summary never fails on its extra */ }
    const line = summary.flush(Date.now(), extra);
    if (line) console.log(line);
  }, 10_000);
  (summaryTimer as { unref?: () => void }).unref?.();
  (stallTimer as { unref?: () => void }).unref?.();
}

/**
 * THE STALL RATE, ONE LINE PER 5 MIN (2026-10-09). The [stall] lines say what each freeze was; judging a fix needs the
 * RATE — on 2026-10-09 07:00–07:35 the loop was blocked 60–80% of every 5-min window and that took a scan of api.log to
 * see. Every wall-clock 5-min window (…:00, …:05) ends with:
 *   [stall-summary] 00:00–00:05Z: 31 stalls ≥100 ms (9 ≥1 s), blocked 182.3 s of 300 s (61%), max 27.0 s, cpu 9% of the
 *   blocked time · by longest open: timer hhCheck 95.2 s ×12, GET /api/gtow/accounts 41.0 s ×5, … · short (<300 ms) 2.1 s ×17
 * "by longest open" charges each logged stall (≥ STALL_LOG_MS) to the longest activity open across it (its [stall] line's
 * first name) — an attribution, not proof. Pure accumulator; the monitor feeds it.
 */
export const STALL_SUMMARY_MS = 5 * 60_000;
export class StallSummary {
  private winStart: number | null = null;
  private n = 0; private nLong = 0; private ms = 0; private max = 0; private cpuMs = 0; private cpuWallMs = 0;
  private by = new Map<string, { ms: number; n: number }>();
  constructor(private windowMs = STALL_SUMMARY_MS, private clock: () => number = () => Date.now()) {}
  /** One stall of `ms` (a logged one carries its record). */
  add(ms: number, rec: StallRecord | null): void {
    if (this.winStart == null) this.winStart = Math.floor(this.clock() / this.windowMs) * this.windowMs;
    this.n++; this.ms += ms; this.max = Math.max(this.max, ms);
    if (ms >= 1000) this.nLong++;
    if (rec?.cpuMs != null) { this.cpuMs += rec.cpuMs; this.cpuWallMs += ms; }
    const label = rec ? (rec.open[0]?.replace(/ \(.*$/, "") ?? "no request open (a timer or background job)") : `short (<${STALL_LOG_MS} ms)`;
    const b = this.by.get(label) ?? { ms: 0, n: 0 };
    b.ms += ms; b.n++;
    this.by.set(label, b);
  }
  /** The line for the window that ended before `now`, once; null while the window is still open. `extra` is appended
   *  (the machine's state at the end of the window, services/machineLoad.ts). */
  flush(now: number, extra?: string): string | null {
    const cur = Math.floor(now / this.windowMs) * this.windowMs;
    if (this.winStart == null) { this.winStart = cur; return null; }
    if (cur <= this.winStart) return null;
    const from = this.winStart, to = from + this.windowMs;
    const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
    const s = (x: number) => (x / 1000).toFixed(1);
    const parts = [...this.by.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6).map(([k, v]) => `${k} ${s(v.ms)} s ×${v.n}`);
    const line = `[stall-summary] ${hhmm(from)}–${hhmm(to)}Z: ${this.n} stalls ≥${STALL_MIN_MS} ms (${this.nLong} ≥1 s), ` +
      `blocked ${s(this.ms)} s of ${s(this.windowMs)} s (${Math.round((100 * this.ms) / this.windowMs)}%), max ${s(this.max)} s` +
      (this.cpuWallMs ? `, cpu ${Math.round((100 * this.cpuMs) / this.cpuWallMs)}% of the logged blocked time` : "") +
      (parts.length ? ` · by longest open: ${parts.join(", ")}` : "") + (extra ? ` · ${extra}` : "");
    this.winStart = cur; this.n = 0; this.nLong = 0; this.ms = 0; this.max = 0; this.cpuMs = 0; this.cpuWallMs = 0; this.by.clear();
    return line;
  }
}
const summary = new StallSummary();
let summaryTimer: ReturnType<typeof setInterval> | null = null;
let summaryExtra: (() => string) | null = null;
/** What the 5-min summary line appends (services/machineLoad.ts registers the machine's CPU + heavy processes). */
export function setStallSummaryExtra(fn: (() => string) | null): void { summaryExtra = fn; }

/** Stalls that overlap [fromMs, toMs] (wall clock), oldest first. */
export function stallsBetween(fromMs: number, toMs: number): { at: number; ms: number }[] {
  return stalls.filter((s) => s.at + s.ms >= fromMs && s.at <= toMs);
}

/** The logged stalls (>= STALL_LOG_MS) that ended at or after `sinceMs`, oldest first — memory only. */
export function loggedStallsSince(sinceMs: number): StallRecord[] {
  return logged.filter((s) => s.at + s.ms >= sinceMs);
}

/** The most recent logged stall (any age), or null. */
export function lastLoggedStall(): StallRecord | null {
  return logged[logged.length - 1] ?? null;
}

/** Test hook: record a stall as the monitor would (a logged one too when it is >= STALL_LOG_MS). */
export function _recordStall(at: number, ms: number, cpuMs: number | null = null, openList: string[] = []): void {
  stalls.push({ at, ms });
  if (ms >= STALL_LOG_MS) keep({ at, ms, cpuMs, open: openList });
}

/** Test hook: forget every recorded stall. */
export function _clearStalls(): void {
  stalls.length = 0;
  logged.length = 0;
}
