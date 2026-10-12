// SHARED WITH THE CHART FACTORY (setup/shared-with-factory.json): edit it in poker-wrapper only — the factory takes it with `bun scripts/sync_from_wrapper.ts`.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * A WORKER THAT SLEPT THROUGH A LONG LID-CLOSE COMES BACK DEGRADED (2026-10-12).
 *
 * On 2026-10-11 and 2026-10-12 the API worker came back from an 11-14 h Modern Standby burning ~250% CPU, all of it
 * user mode: the main thread ~80% and seven equally loaded helper threads (the JavaScriptCore GC markers, by their
 * shape — Bun 1.3.14 names no threads). Its loop was blocked ~75% of every 5 min in 0.3-1 s pieces and ingest ran 5x
 * slower, with or without a session, for as long as the process lived. A worker replaced on 10-11 at 20:12Z was clean
 * at once; the one replaced on 10-12 at 22:35 went from 249% to 16% CPU under the same traffic, holding the same 1.2
 * GB — so not a leak and not the data size. A 1.1 h suspend did not do it. What inside Bun / JSC does is unknown
 * (no upstream issue). The [stall] lines of that state name whatever was open (ingest, hhCheck, gtowSessions.refresh);
 * the steps those activities time cover 1-5% of each block.
 *
 * So the API replaces itself (services/autoRestart.ts, reason "runtime-degraded", only when no session is live):
 *   - after a SUSPEND of RECYCLE_AFTER_SUSPEND_MS or more, before the owner sits down (on 10-12 the lid opened at
 *     20:54 and the session started at 21:12). The stall monitor sees one as a tick SUSPEND_MIN_MS or more late at
 *     almost no CPU. A real freeze that long cannot happen: the supervisor kills a worker after three failed probes.
 *   - on the SYMPTOM, whatever caused it: THRASH_WINDOWS 5-min windows in a row with this process at THRASH_CPU_PCT
 *     or more of a core and its loop blocked THRASH_BLOCKED_PCT or more. A healthy API is far below (16% idle; its
 *     stalls in a live session are waits, not computing). The symptom does not restart a worker again within
 *     SYMPTOM_GUARD_MS of the last such restart (data/jobs/runtime-recycle.json): if a fresh process shows it too,
 *     the cause is elsewhere and restarting cannot help.
 * DEGRADED_RESTART=off (config/local.env) leaves both reported and restarts nothing. GET /api/load names the state.
 */

/** a tick this late at almost no CPU is the machine asleep, not the loop busy */
export const SUSPEND_MIN_MS = 5 * 60_000;
/** a suspend this long gets the worker replaced */
export const RECYCLE_AFTER_SUSPEND_MS = 30 * 60_000;
export const THRASH_CPU_PCT = 150;
export const THRASH_BLOCKED_PCT = 20;
export const THRASH_WINDOWS = 2;
export const SYMPTOM_GUARD_MS = 60 * 60_000;

export type DegradedKind = "suspend" | "symptom";
export interface Degraded {
  kind: DegradedKind;
  /** one sentence for a person */
  why: string;
  /** false: reported only (the symptom's loop guard) */
  recycle: boolean;
}
/** One 5-min [stall-summary] window: this process's CPU (% of one core) and the share of it the loop was blocked. */
export interface WindowStat { end: number; procCpuPct: number; blockedPct: number }

/** A tick `lateMs` late with `cpuMs` of this process's CPU across it is a suspend (unknown CPU: by its length only). */
export function isSuspend(lateMs: number, cpuMs: number | null): boolean {
  return lateMs >= SUSPEND_MIN_MS && (cpuMs == null || cpuMs < 0.05 * lateMs);
}

const pad = (n: number) => String(n).padStart(2, "0");
const clockOf = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const span = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);

/** The [suspend] line the stall monitor prints instead of a [stall] line. */
export function describeSuspend(at: number, ms: number, cpuMs: number | null): string {
  const cpu = cpuMs == null ? "unknown CPU" : `${(cpuMs / 1000).toFixed(1)} s of CPU`;
  return `[suspend] the event loop was away ${span(ms)} (${new Date(at).toISOString()} → ${new Date(at + ms).toISOString()}) ` +
    `with ${cpu} — the machine slept; not counted as a stall` +
    (ms >= RECYCLE_AFTER_SUSPEND_MS ? " · this worker restarts itself when no session is live (services/runtimeHealth.ts)" : "");
}

/** GET /api/load's reason for a degraded runtime: what it is and what happens about it. */
export function degradedReason(d: Degraded, env: NodeJS.ProcessEnv = process.env): string {
  const off = (k: string) => /^(off|0|false|no)$/i.test((env[k] ?? "").trim());
  const next = !d.recycle ? "" : off("AUTO_RESTART") || off("DEGRADED_RESTART")
    ? " — automatic restart is off: restart the API between sessions"
    : " — it restarts itself when no session is live";
  return `the API is degraded: ${d.why}${next}`;
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export class RuntimeHealth {
  private slept: { at: number; ms: number } | null = null;
  private run: WindowStat[] = [];
  /** the last runtime restart on record; undefined until read (once) */
  private last: { at: number; kind: string } | null | undefined = undefined;
  private file: string | null;
  private readonly now: () => number;

  constructor(o: { file?: string | null; now?: () => number } = {}) {
    this.file = o.file ?? null;
    this.now = o.now ?? Date.now;
  }

  /** Where the last runtime restart is kept (the API: data/jobs/runtime-recycle.json); null keeps nothing. */
  setFile(file: string | null): void { this.file = file; this.last = undefined; }

  /** The stall monitor saw a suspend that began at `at` and lasted `ms`. */
  noteSuspend(at: number, ms: number): void {
    if (ms >= RECYCLE_AFTER_SUSPEND_MS) this.slept = { at, ms };
  }

  /** A 5-min window closed. The symptom needs THRASH_WINDOWS bad ones in a row; a good one clears it. */
  noteWindow(w: WindowStat): void {
    const bad = w.procCpuPct >= THRASH_CPU_PCT && w.blockedPct >= THRASH_BLOCKED_PCT;
    this.run = bad ? [...this.run, w].slice(-THRASH_WINDOWS) : [];
  }

  /** Why this worker should be replaced, or null. */
  degraded(): Degraded | null {
    if (this.slept) {
      return {
        kind: "suspend", recycle: true,
        why: `the machine slept ${span(this.slept.ms)} (woke ${clockOf(this.slept.at + this.slept.ms)}) — a worker that sleeps ` +
          "that long can come back burning CPU in garbage collection until it is replaced",
      };
    }
    if (this.run.length < THRASH_WINDOWS) return null;
    const cpu = Math.round(Math.min(...this.run.map((w) => w.procCpuPct)));
    const blocked = Math.round(Math.min(...this.run.map((w) => w.blockedPct)));
    const what = `this API has used ${cpu}% CPU or more with its loop blocked ${blocked}% or more for ${THRASH_WINDOWS * 5} min — ` +
      "the state a worker comes back in after a long sleep";
    const last = this.readLast();
    const ago = last ? this.now() - last.at : Infinity;
    if (last?.kind === "symptom" && ago < SYMPTOM_GUARD_MS) {
      return {
        kind: "symptom", recycle: false,
        why: `${what}; a worker was already replaced for this ${Math.max(1, Math.round(ago / 60_000))} min ago and it came back, ` +
          "so a restart will not help — look at what else is using the CPU",
      };
    }
    return { kind: "symptom", recycle: true, why: what };
  }

  /** The worker is about to exit for `d`: keep it on record (the symptom's loop guard reads it in the next worker). */
  recycling(d: { kind?: string; why: string }): void {
    if (!this.file) return;
    try { writeAtomic(this.file, JSON.stringify({ at: this.now(), pid: process.pid, kind: d.kind ?? "unknown", why: d.why }) + "\n"); }
    catch { /* best effort: the guard only stops a restart loop */ }
  }

  private readLast(): { at: number; kind: string } | null {
    if (this.last !== undefined) return this.last;
    this.last = null;
    try {
      if (this.file && existsSync(this.file)) {
        const j = JSON.parse(readFileSync(this.file, "utf8"));
        if (Number.isFinite(j?.at) && typeof j?.kind === "string") this.last = { at: j.at, kind: j.kind };
      }
    } catch { /* unreadable: no guard */ }
    return this.last;
  }
}

/** This process's. The API points it at data/jobs (services/buildStamp.ts); the stall monitor feeds it. */
export const runtimeHealth = new RuntimeHealth();
