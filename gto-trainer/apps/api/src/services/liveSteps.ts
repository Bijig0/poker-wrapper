import { AsyncLocalStorage } from "node:async_hooks";
import { tmark } from "./answerTrace";

/**
 * LIVE STEPS (2026-10-12, Brady: "if we are doing a solve with GTO Wizard, or getting from HRC, I want live feedback on
 * what is happening … the steps that are not technical"; "while waiting for a GTO Wizard answer, say the time elapsed and
 * other details"). Design: poker-wrapper docs/2026-10-12-live-step-feedback.md.
 *
 * A live solve (POST /api/fast-solver from the study poller, routes/fastSolver.ts) runs inside a StepRun. Each stage
 * a person would recognise announces itself AS IT STARTS — tstep("Reading the HRC chart") … tstep("GTO Wizard solving
 * the flop tree…", {usualMs, limitMs}) — and the run pushes the whole list to that table's wrapper (POST /panel/steps,
 * debounced ~150 ms), so the panel shows the step while it is really running, its seconds ticking. Internal plumbing
 * (range blends, checkpoints, memo hits, prefetch) never gets a step.
 *
 * Rules:
 *   - outside a run every call is a no-op (warm-ups, offline sweeps, tests): nothing here can change an answer;
 *   - a new step in the same LANE closes the lane's open step as done (stages are sequential within a lane);
 *     parallel work (the pool lock beside the chart) runs in its own lane (withLane) so the two do not close each other;
 *   - memory only, a few small POSTs per decision, never awaited by the solve (the answer path is not slowed by it).
 * Every step is also a normal trace event ("step: …"), so the stored timeline carries them too.
 */
export type StepStatus = "active" | "done" | "failed" | "skipped";
export interface LiveStep {
  id: string; text: string; detail?: string[]; at: number; endAt?: number | null; status: StepStatus;
  lane?: string | null; usualMs?: number | null; slowMs?: number | null; limitMs?: number | null;
}
export interface StepOpts { detail?: string[]; usualMs?: number | null; slowMs?: number | null; limitMs?: number | null; id?: string }

const MAX_STEPS = 40;
const PUSH_DEBOUNCE_MS = 150;

export class StepRun {
  readonly steps: LiveStep[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  closed = false;
  /** this run's identity: a retry of the same decision is a new run, so the wrapper keeps the earlier try on the trail */
  readonly run = Date.now();
  constructor(readonly wrapperUrl: string | null, readonly decisionKey: string, readonly handId: unknown,
              private readonly send: (url: string, body: unknown) => void = postSteps) {}

  start(text: string, lane: string | null, o: StepOpts = {}): LiveStep | null {
    if (this.closed) return null;
    const now = Date.now();
    for (const s of this.steps) if (s.status === "active" && (s.lane ?? null) === lane) { s.status = "done"; s.endAt = now; }
    const st: LiveStep = { id: o.id ?? `s${++this.seq}`, text, at: now, status: "active", lane,
      ...(o.detail?.length ? { detail: o.detail.slice(0, 8) } : {}),
      ...(o.usualMs != null ? { usualMs: o.usualMs } : {}), ...(o.slowMs != null ? { slowMs: o.slowMs } : {}),
      ...(o.limitMs != null ? { limitMs: o.limitMs } : {}) };
    this.steps.push(st);
    if (this.steps.length > MAX_STEPS) this.steps.splice(0, this.steps.length - MAX_STEPS);
    this.schedule();
    return st;
  }

  /** The lane's open step (or the one named `id`) ends with `status`; `text` replaces its words when given. */
  end(lane: string | null, status: StepStatus, text?: string, id?: string): void {
    const s = this.find(lane, id);
    if (!s) return;
    s.status = status; s.endAt = Date.now();
    if (text) s.text = text;
    this.schedule();
  }

  /** Add a detail ("Ultra 2", "new tree", "try 2 of 3") to the lane's open step. */
  detail(lane: string | null, d: string): void {
    const s = this.find(lane);
    if (!s || !d) return;
    const list = (s.detail ??= []);
    if (!list.includes(d)) list.push(d);
    if (list.length > 8) list.splice(0, list.length - 8);
    this.schedule();
  }

  /** The solve is over: every open step is closed, the final line added, the list sent at once. */
  finish(final: { ok: boolean; text: string }): void {
    if (this.closed) return;
    const now = Date.now();
    for (const s of this.steps) if (s.status === "active") { s.status = final.ok ? "done" : "failed"; s.endAt = now; }
    this.steps.push({ id: "final", text: final.text, at: now, endAt: now, status: final.ok ? "done" : "failed", lane: null });
    this.closed = true;
    this.flush();
  }

  private find(lane: string | null, id?: string): LiveStep | null {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i]!;
      if (id ? s.id === id : s.status === "active" && (s.lane ?? null) === lane) return s;
    }
    return null;
  }

  private schedule(): void {
    if (this.timer || !this.wrapperUrl) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, PUSH_DEBOUNCE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.wrapperUrl) return;
    this.send(this.wrapperUrl, { decisionKey: this.decisionKey, handId: this.handId, run: this.run, steps: this.steps });
  }
}

/** Fire-and-forget: a lost push costs one panel line for a second, never the answer. */
function postSteps(url: string, body: unknown): void {
  try {
    fetch(`${url.replace(/\/+$/, "")}/panel/steps`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
  } catch { /* never on the answer path */ }
}

type Ctx = { run: StepRun; lane: string | null };
const als = new AsyncLocalStorage<Ctx>();

/** Run `fn` (the live solve) with `run` collecting its steps. */
export function runWithSteps<T>(run: StepRun, fn: () => Promise<T>): Promise<T> {
  return als.run({ run, lane: null }, fn);
}

/** Run `fn` as a parallel LANE ("pool lock"): its steps close only each other, and show beside the main lane's. */
export function withLane<T>(lane: string, fn: () => Promise<T>): Promise<T> {
  const c = als.getStore();
  return c ? als.run({ run: c.run, lane }, fn) : fn();
}

/** A stage starts (closing the lane's previous stage as done). No-op outside a live solve. */
export function tstep(text: string, o: StepOpts = {}): void {
  const c = als.getStore();
  if (!c) return;
  tmark(`step: ${text}`, o.detail?.join(" · "));
  c.run.start(text, c.lane, o);
}

/** The lane's open stage ends — `failed` with the words of what went wrong, `skipped` when it was not needed. */
export function tstepEnd(status: StepStatus, text?: string): void {
  const c = als.getStore();
  if (c) c.run.end(c.lane, status, text);
}

/** A detail on the lane's open stage (the account it went to, "new tree", "try 2 of 3"). */
export function tstepDetail(d: string): void {
  const c = als.getStore();
  if (c) c.run.detail(c.lane, d);
}

/** Is a live solve collecting steps here (for callers that would build a detail string only for it)? */
export const stepsLive = (): boolean => !!als.getStore();

/**
 * TYPICAL TIMES (measured 2026-10-12 over the last 4 days of live answers, docs/2026-10-12-live-step-feedback.md §2):
 * p50 = "usually ~X s", p90 = past it the panel says "slower than usual". Constants on purpose: nothing is read from the
 * answer log on the answer path. Re-measure when the routes change.
 */
export const USUAL = {
  aiPreflop: { usualMs: 4700, slowMs: 8100 },
  poolLock: { usualMs: 7100, slowMs: 10400 },
  postflopCached: { usualMs: 3400, slowMs: 10000 },
  postflopNewTree: { usualMs: 9200, slowMs: 19000 },
  postflopNewTreeLater: { usualMs: 5700, slowMs: 12000 },
  node: { usualMs: 1300, slowMs: 4000 },
} as const;

/** An answer's `source` in plain words — the same names the wrapper uses (steps.ts sourceName). */
export function sourceName(source: string | null | undefined, piece?: string | null): string {
  const s = String(source ?? "");
  const base: Record<string, string> = {
    "hrc-6max-preflop": "HRC chart", "gtow-ai-preflop": "GTO Wizard AI (preflop)", "gtow-api-postflop": "GTO Wizard AI (postflop)",
    "hrc-3max-preflop": "HRC 3-handed chart", "pool-exploit-preflop": "pool exploit chart", "hrc-hu-preflop": "HRC heads-up chart",
    "local-preflop": "local chart", "mes-postflop": "MES exploit",
  };
  const name = base[s] ?? (s || "the solver");
  if (s === "gtow-ai-preflop" && piece && /pool-(limp-)?lock/.test(piece)) return `${name}, limper locked to the pool`;
  if (s === "gtow-ai-preflop" && piece && /coldcall/.test(piece)) return `${name}, cold-caller locked to the pool`;
  return name;
}
