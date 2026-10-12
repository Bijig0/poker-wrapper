import os from "node:os";
import { asActivity, lastLoggedStall, loggedStallsSince, setStallSummaryExtra, type StallRecord } from "./answerTrace";
import { degradedReason, runtimeHealth } from "./runtimeHealth";
import { refreshSessionLive, sessionLiveCached } from "./sessionLive";

/**
 * IS THIS MACHINE FIT TO ANSWER A TABLE RIGHT NOW? — GET /api/load (2026-10-07).
 *
 * The latency audit of 2026-10-07: live answers over the 15 s clock (1.3%) were the API's event loop FREEZING, not GTO
 * Wizard — and the freezes come in clusters while heavy local work runs on the same machine (test suites, tsc, replay
 * gates, stress-run starts). The wrapper's panel and its preflight warning read this endpoint to say so before and
 * during a session ("the API froze 55 s at 12:17", "bun test is using 70% CPU").
 *
 * CONTRACT (the wrapper is built against it — keep it exactly):
 *   { ok: true, at: ms, verdict: "ok" | "warn" | "heavy", reasons: string[],
 *     loop: { stalls1m, stalls5m, maxMs5m, blockedMs5m, lastStallAt: ms | null },
 *     machine: { cpuPct: number | null, heavy: [{ name, pid, cpuPct }] },
 *     sessionLive: boolean }
 *
 * `loop` counts the stall monitor's LOGGED stalls (>= 300 ms, services/answerTrace) that ended in the window.
 * `machine.cpuPct` is the whole machine's CPU use, 0-100 (os.cpus() deltas between two samples ~20 s apart — the
 * average over that span, the number Task Manager's total shows). `machine.heavy` lists processes using more than
 * HEAVY_PROC_PCT of the WHOLE machine (Task Manager's per-process scale, not "% of one core"), from typeperf's
 * 1 s sample of every process, named from their command line where it says more than the exe ("bun test", "tsc",
 * "bun replayGate.ts"). Both are sampled OFF the request: a timer every SAMPLE_MS starts a child process and awaits
 * it; the endpoint reads memory only — never a file, the DB or a process — and is never gated behind live answers.
 *
 * VERDICT RULE:
 *   heavy — any stall >= 5 s in the last 5 min, OR cpuPct >= 85 sustained (every sample of the last minute, two at least)
 *   warn  — any stall >= 1 s in the last 5 min, OR cpuPct >= 60, OR any heavy process, OR the API's runtime is
 *           degraded (services/runtimeHealth.ts: back from a long sleep, or ~250% CPU with its loop mostly blocked)
 *   ok    — none of these
 * `reasons` holds a plain sentence for every condition that holds (the heavy ones first).
 */
export const HEAVY_STALL_MS = 5_000;
export const WARN_STALL_MS = 1_000;
export const HEAVY_CPU_PCT = 85;
export const WARN_CPU_PCT = 60;
/** a process using more than this share of the whole machine is listed */
export const HEAVY_PROC_PCT = 15;
export const SUSTAIN_MS = 60_000;
export const SAMPLE_MS = 20_000;
const WINDOW_5M = 5 * 60_000;
/** a sample older than this is not reported */
const STALE_MS = 3 * SAMPLE_MS;

export type Verdict = "ok" | "warn" | "heavy";
export interface HeavyProc { name: string; pid: number; cpuPct: number }
export interface LoadReport {
  ok: true;
  at: number;
  verdict: Verdict;
  reasons: string[];
  loop: { stalls1m: number; stalls5m: number; maxMs5m: number; blockedMs5m: number; lastStallAt: number | null };
  machine: { cpuPct: number | null; heavy: HeavyProc[] };
  sessionLive: boolean;
}

// ── pure: the verdict ────────────────────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
const clockOf = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const secsOf = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
/** "timer answerReconciler (55.5 s: hands query 55.4 s)" → "timer answerReconciler" */
const labelOf = (open: string) => open.replace(/ \(.*$/, "");

export interface VerdictInput {
  now: number;
  /** logged stalls (>= 300 ms) that ended in the last 5 minutes */
  stalls: StallRecord[];
  /** machine CPU samples, oldest first */
  cpu: { at: number; pct: number }[];
  heavy: HeavyProc[];
  /** the API's runtime is degraded (services/runtimeHealth.ts): the sentence, or null */
  degraded?: string | null;
}

export function verdictOf(x: VerdictInput): { verdict: Verdict; reasons: string[] } {
  const heavyWhy: string[] = [];
  const warnWhy: string[] = [];
  if (x.degraded) warnWhy.push(x.degraded);
  const worst = x.stalls.reduce<StallRecord | null>((w, s) => (!w || s.ms > w.ms ? s : w), null);
  if (worst && worst.ms >= WARN_STALL_MS) {
    const big = x.stalls.filter((s) => s.ms >= WARN_STALL_MS).length;
    // the likeliest culprit: an activity that timed its steps, else one that finished inside the stall, else the
    // longest open (a long-open async activity heads every stall line it spans)
    const culprit = worst.open.find((o) => /: [^)]*\)$/.test(o)) ?? worst.open.find((o) => !o.includes("still open")) ?? worst.open[0];
    const what = culprit ? ` (${labelOf(culprit)} was running)` : "";
    const more = big > 1 ? ` — ${big} freezes of 1 s or more in the last 5 min` : "";
    (worst.ms >= HEAVY_STALL_MS ? heavyWhy : warnWhy).push(`the API froze ${secsOf(worst.ms)} at ${clockOf(worst.at)}${what}${more}`);
  }
  const last = x.cpu[x.cpu.length - 1];
  if (last) {
    const recent = x.cpu.filter((c) => c.at >= x.now - SUSTAIN_MS);
    if (recent.length >= 2 && recent.every((c) => c.pct >= HEAVY_CPU_PCT)) {
      heavyWhy.push(`the machine's CPU has been at ${HEAVY_CPU_PCT}% or more for the last minute (now ${Math.round(last.pct)}%)`);
    } else if (last.pct >= WARN_CPU_PCT) {
      warnWhy.push(`the machine's CPU is at ${Math.round(last.pct)}%`);
    }
  }
  for (const p of x.heavy) warnWhy.push(`${p.name} is using ${Math.round(p.cpuPct)}% CPU`);
  return { verdict: heavyWhy.length ? "heavy" : warnWhy.length ? "warn" : "ok", reasons: [...heavyWhy, ...warnWhy] };
}

// ── typeperf: every process's CPU over one second ──────────────────────────────────────────────────────────────

const csvCells = (line: string): string[] => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);

/**
 * typeperf "\Process(*)\% Processor Time" "\Process(*)\ID Process" output → processes from its LAST sample, CPU as a
 * share of the whole machine (typeperf's per-process figure is % of ONE core). _Total and Idle are dropped.
 */
export function parseTypeperf(out: string, cores: number): { name: string; pid: number; cpuPct: number }[] {
  const rows = out.split(/\r?\n/).filter((l) => l.startsWith('"'));
  if (rows.length < 2) return [];
  const head = csvCells(rows[0]!);
  const vals = csvCells(rows[rows.length - 1]!);
  const byInst = new Map<string, { pct?: number; pid?: number }>();
  head.forEach((h, i) => {
    const m = /\\Process\((.+)\)\\(% Processor Time|ID Process)$/i.exec(h);
    if (!m) return;
    const v = Number(vals[i]);
    if (!Number.isFinite(v)) return;
    const e = byInst.get(m[1]!) ?? {};
    if (/ID Process/i.test(m[2]!)) e.pid = v; else e.pct = v;
    byInst.set(m[1]!, e);
  });
  const out2: { name: string; pid: number; cpuPct: number }[] = [];
  for (const [inst, e] of byInst) {
    if (/^(_total|idle)$/i.test(inst) || e.pct == null || e.pid == null || e.pid === 0) continue;
    const pct = e.pct / Math.max(1, cores);
    if (pct > 100) continue;   // an impossible reading (a counter that wrapped, a process born mid-sample)
    out2.push({ name: inst.replace(/#\d+$/, ""), pid: e.pid, cpuPct: pct });
  }
  return out2.sort((a, b) => b.cpuPct - a.cpuPct);
}

/** What a person calls the process: "bun test", "tsc", "bun replayGate.ts", "python boxwatch.py" — else the exe. */
export function labelFromCommandLine(exe: string, cmd: string | null): string {
  if (!cmd) return exe;
  if (/\btsc(\.js|\.cmd)?\b/i.test(cmd) && /typescript|\btsc\b/i.test(cmd)) return "tsc";
  if (!/^(bun|node|python\d*|pythonw|powershell|pwsh|cmd)$/i.test(exe)) return exe;
  const toks = cmd.match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, "")) ?? [];
  const args = toks.slice(1);
  if (/^bun$/i.test(exe) && args.some((a) => a === "test")) return "bun test";
  const script = args.find((a) => /\.(ts|tsx|js|mjs|cjs|py|ps1|cmd|bat)$/i.test(a));
  if (script) return `${exe} ${script.split(/[\\/]/).pop()}`;
  const sub = args.find((a) => !a.startsWith("-"));
  return sub && sub.length <= 24 ? `${exe} ${sub}` : exe;
}

async function runChild(cmd: string[], timeoutMs: number): Promise<string | null> {
  try {
    // a short-lived child: Bun.spawn on Windows lets it inherit the API's listening socket for its ~2 s life
    // (services/replayScheduler.ts); the server binds with reusePort, so a restart inside that window still binds
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", windowsHide: true } as Parameters<typeof Bun.spawn>[1]);
    const kill = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeoutMs);
    try {
      const out = await new Response(p.stdout as ReadableStream).text();
      await p.exited;
      return out;
    } finally { clearTimeout(kill); }
  } catch { return null; }
}

/** Every process's CPU (typeperf, Windows), or null when it cannot be sampled. */
export async function sampleProcesses(): Promise<{ name: string; pid: number; cpuPct: number }[] | null> {
  if (process.platform !== "win32") return null;
  // TWO 1 s samples, the second one read: typeperf's first value of a rate counter is sometimes garbage (measured
  // 2026-10-07: a 4-core load read 159% of the 16-core machine on the first sample, 23.6% on the second)
  const out = await runChild(["typeperf", "\\Process(*)\\% Processor Time", "\\Process(*)\\ID Process", "-sc", "2", "-si", "1"], 12_000);
  return out ? parseTypeperf(out, os.cpus().length || 1) : null;
}

/** Command lines of `pids` (one PowerShell CIM query), pid → command line. */
export async function commandLines(pids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (process.platform !== "win32" || !pids.length) return m;
  const filter = pids.map((p) => `ProcessId=${Math.trunc(p)}`).join(" OR ");
  const out = await runChild(["powershell", "-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`], 15_000);
  for (const line of (out ?? "").split(/\r?\n/)) {
    const i = line.indexOf("\t");
    if (i > 0) m.set(Number(line.slice(0, i)), line.slice(i + 1).trim());
  }
  return m;
}

// ── the sampler (state) and the report ───────────────────────────────────────────────────────────────────────────

const cpuTotals = (): { idle: number; all: number } | null => {
  try {
    return os.cpus().reduce((a, c) => {
      const t = c.times;
      a.idle += t.idle;
      a.all += t.user + t.nice + t.sys + t.idle + t.irq;
      return a;
    }, { idle: 0, all: 0 });
  } catch { return null; }
};

export interface SamplerDeps {
  cpuTotals: () => { idle: number; all: number } | null;
  processes: () => Promise<{ name: string; pid: number; cpuPct: number }[] | null>;
  commandLines: (pids: number[]) => Promise<Map<number, string>>;
  now: () => number;
  selfPid: number;
}

export class MachineSampler {
  private cpu: { at: number; pct: number }[] = [];
  private heavy: HeavyProc[] = [];
  private heavyAt = 0;
  private lastTotals: { idle: number; all: number } | null = null;
  private labels = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private d: SamplerDeps;

  constructor(deps: Partial<SamplerDeps> = {}) {
    this.d = { cpuTotals, processes: sampleProcesses, commandLines, now: Date.now, selfPid: process.pid, ...deps };
  }

  /**
   * One sample: machine CPU since the last one, the session-live answer refreshed, the heavy processes now. Only the
   * SYNCHRONOUS parts run as the activity "timer machineLoad": the child processes are awaited outside it, so a stall
   * while typeperf runs (~2 s) is not pinned on this sampler (a long-open async tick heads every stall line it spans).
   */
  async sample(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      asActivity("timer machineLoad", () => {
        const t = this.d.cpuTotals();
        if (t && this.lastTotals && t.all > this.lastTotals.all) {
          const pct = 100 * (1 - (t.idle - this.lastTotals.idle) / (t.all - this.lastTotals.all));
          this.cpu.push({ at: this.d.now(), pct: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)) });
          if (this.cpu.length > 20) this.cpu.splice(0, this.cpu.length - 20);
        }
        if (t) this.lastTotals = t;
        try { refreshSessionLive(); } catch { /* the report keeps the last answer */ }
      });
      const procs = await this.d.processes();
      if (!procs) return;
      const hot = procs.filter((p) => p.cpuPct > HEAVY_PROC_PCT);
      const unknown = hot.map((p) => p.pid).filter((pid) => pid !== this.d.selfPid && !this.labels.has(pid));
      const cmds = unknown.length ? await this.d.commandLines(unknown).catch(() => new Map<number, string>()) : new Map<number, string>();
      asActivity("timer machineLoad", () => {
        const exeOf = new Map(hot.map((p) => [p.pid, p.name]));
        for (const pid of unknown) this.labels.set(pid, labelFromCommandLine(exeOf.get(pid) ?? "?", cmds.get(pid) ?? null));
        // a label is forgotten once its pid is gone (pids are reused)
        const seen = new Set(procs.map((p) => p.pid));
        for (const pid of [...this.labels.keys()]) if (!seen.has(pid)) this.labels.delete(pid);
        this.heavyAt = this.d.now();
        this.heavy = hot.map((p) => ({
          name: p.pid === this.d.selfPid ? `${p.name} (this API)` : this.labels.get(p.pid) ?? p.name,
          pid: p.pid,
          cpuPct: Math.round(p.cpuPct * 10) / 10,
        }));
      });
    } finally {
      this.busy = false;
    }
  }

  /** Sample every `everyMs` (first one at once, the second soon after so cpuPct is known within seconds). */
  start(everyMs = SAMPLE_MS): void {
    if (this.timer) return;
    const tick = () => { this.sample().catch(() => { /* never the API's problem */ }); };
    tick();
    const first = setTimeout(tick, 3_000);
    (first as { unref?: () => void }).unref?.();
    this.timer = setInterval(tick, everyMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** The samples still fresh at `now` (a sampler that stopped answering reports nothing rather than old numbers). */
  state(now = this.d.now()): { cpu: { at: number; pct: number }[]; heavy: HeavyProc[] } {
    const cpu = this.cpu.filter((c) => c.at >= now - STALE_MS);
    return { cpu, heavy: this.heavyAt >= now - STALE_MS ? this.heavy : [] };
  }
}

export const machineSampler = new MachineSampler();

// The [stall-summary] line carries the machine beside the freezes (2026-10-09): on that day two sessions with the same
// API code were 2-3% blocked and two others 20%, 92% of it at low CPU (waiting) — the difference was outside the
// process, and nothing on disk said what the machine was doing. Memory only: the sampler's last samples.
setStallSummaryExtra(() => {
  const { cpu, heavy } = machineSampler.state();
  const pcts = cpu.map((c) => c.pct);
  const cpuTxt = pcts.length ? `machine cpu ${Math.round(Math.max(...pcts))}% (last samples)` : "machine cpu not sampled";
  return `${cpuTxt}${heavy.length ? `, heavy: ${heavy.slice(0, 4).map((p) => `${p.name} ${p.pid} ${Math.round(p.cpuPct)}%`).join(", ")}` : ""} · session ${sessionLiveCached().live ? "live" : "not live"}`;
});

/** GET /api/load's body — memory only (the stall monitor's kept stalls, the sampler's last sample, the cached session). */
export function loadReport(now = Date.now(), sampler: MachineSampler = machineSampler): LoadReport {
  const s5 = loggedStallsSince(now - WINDOW_5M);
  const s1 = s5.filter((s) => s.at + s.ms >= now - 60_000);
  const { cpu, heavy } = sampler.state(now);
  const deg = runtimeHealth.degraded();
  const { verdict, reasons } = verdictOf({ now, stalls: s5, cpu, heavy, degraded: deg ? degradedReason(deg) : null });
  const lastCpu = cpu[cpu.length - 1];
  return {
    ok: true,
    at: now,
    verdict,
    reasons,
    loop: {
      stalls1m: s1.length,
      stalls5m: s5.length,
      maxMs5m: s5.reduce((m, s) => Math.max(m, s.ms), 0),
      blockedMs5m: s5.reduce((m, s) => m + s.ms, 0),
      lastStallAt: lastLoggedStall()?.at ?? null,
    },
    machine: { cpuPct: lastCpu ? lastCpu.pct : null, heavy },
    sessionLive: sessionLiveCached().live,
  };
}
