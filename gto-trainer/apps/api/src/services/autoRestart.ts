import { LoadedCode, bootCheck, uncommittedOf, type CodeStatus } from "./loadedCode";
import { livePort } from "./ports";
import { MIN_UPTIME_MS, SUPERVISOR_REPLACE_EXIT, type SupervisorWatch, type WatchCheck } from "./supervisorRestart";

/**
 * A MERGE TO MAIN IS THE DEPLOY (2026-10-03).
 *
 * The services run without --watch on purpose, so new code used to wait for someone to notice the dashboard's banner
 * and press Restart — or for a session to remember to kill the worker. Fixes sat on disk unread for hours, and the
 * page (read from disk on every request) ran ahead of the server behind it.
 *
 * Now a supervised worker restarts ITSELF, by a clean exit its supervisor relaunches, when all of this holds:
 *   - a file it loaded has other content on disk (services/loadedCode.ts), and at least one of those changes is
 *     COMMITTED — an edit nobody committed is somebody's work in progress and never restarts anything by itself;
 *   - the change has been quiet for a moment (a merge followed by a fix-up is one restart, not two);
 *   - no poker session is live (the wrapper's /session) and nothing else says it is busy — a restart is ~20 s without
 *     answers and a GTO Wizard token re-sniff, so during a session it is HELD and runs when the session ends;
 *   - the code on disk passes the boot check (it bundles: every import resolves, every file parses).
 * Otherwise the status says which of these is in the way; the dashboard's banner and `bun setup/live.ts` show it.
 *
 * AUTO_RESTART=off (config/local.env) turns the restart off and leaves the reporting on.
 *
 * THE SUPERVISOR'S CONFIG TOO (2026-10-10, services/supervisorRestart.ts): with `supervisor` set, the files in this
 * process's supervisor stamp (its script, scripts/supervisor_lib.ps1, config/env.ps1, config/local.env) are watched
 * on the same tick, and `reason` says which kind of change a state is about:
 *   code-changed        the above
 *   env-changed         only config/env.ps1 / config/local.env changed (no port key): a plain clean exit (0) — the
 *                       supervisor re-reads them before it starts the next worker
 *   supervisor-changed  its script changed, a port key changed, or it refused a re-read: the request file
 *                       data/jobs/supervisor-<name>.replace.json + exit 3, and the supervisor replaces itself
 * The same guards (AUTO_RESTART=off, settling, held while a session is live) plus: the worker up >= 60 s, at most one
 * such restart per supervisor every 5 min, and never while a loaded file has an uncommitted edit (the restart would
 * pick it up). `others` are supervisors with no worker of their own (the GTO Wizard watchdog): only their request
 * file is written, and they act on it within a minute.
 */

export type AutoState =
  | "current"            // running what is on disk
  | "uncommitted"        // only uncommitted edits differ: not picked up until committed (or restarted by hand)
  | "settling"           // a committed change landed moments ago; restarting once it is quiet
  | "held"               // a committed change is waiting: a session is live / the process is busy
  | "boot-check-failed"  // the code on disk would not start; the old process keeps serving
  | "unsupervised"       // nothing would bring this process back, so it will not exit on its own
  | "off"                // AUTO_RESTART=off
  | "supervisor-old"     // the supervisor's config changed, but it predates restarting itself: restart it by hand once
  | "restarting";

/** What a state is about: this process's code, or its supervisor's config / script. */
export type AutoReason = "code-changed" | "env-changed" | "supervisor-changed";

/** A supervisor without a worker of its own (the watchdog): what was decided for it on the last tick. */
export interface OtherStatus { state: AutoState | "requested"; why: string }

export interface AutoStatus {
  state: AutoState;
  /** one sentence a person can act on */
  why: string;
  /** changed loaded files that are not committed (relative to the checkout) */
  uncommitted: string[];
  checkedAt: number;
  /** what the state is about; absent when nothing is waiting */
  reason?: AutoReason;
  /** supervisors this process asks for on their behalf (the API: the GTO Wizard watchdog), when one is behind */
  others?: Record<string, OtherStatus>;
}

export interface AutoRestartOpts {
  code: LoadedCode;
  /** the service's name in log lines */
  name: string;
  /** true when a clean exit is relaunched by a supervisor */
  supervised: () => boolean;
  /** what to do about a committed change when nothing relaunches this process (the wrapper: "relaunch the Poker Wrapper") */
  byHand?: string;
  /** a reason not to restart now, or null */
  busy: () => Promise<string | null>;
  /** exits the process with this code; replaced by tests */
  exit?: (code: number) => void;
  check?: (entry: string) => Promise<string | null>;
  dirty?: (repo: string | null, files: string[]) => Promise<Set<string> | null>;
  log?: (line: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  settleMs?: number;
  minUptimeMs?: number;
  tickMs?: number;
  /** this process's own supervisor: its stamp's files are watched too (services/supervisorRestart.ts) */
  supervisor?: SupervisorWatch;
  /** supervisors with no worker of their own that this process requests a self-replace for (request file only) */
  others?: SupervisorWatch[];
}

export class AutoRestart {
  private state: AutoStatus = { state: "current", why: "", uncommitted: [], checkedAt: 0 };
  /** the change set the boot check last failed on: the same broken code is not re-bundled every tick */
  private failed: { sig: string; why: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private otherStatus: Record<string, OtherStatus> = {};
  private readonly o: Required<Omit<AutoRestartOpts, "env" | "supervisor" | "others">> & {
    env: NodeJS.ProcessEnv; supervisor?: SupervisorWatch; others: SupervisorWatch[];
  };

  constructor(opts: AutoRestartOpts) {
    this.o = {
      exit: (code: number) => { setTimeout(() => process.exit(code), 250); },
      check: bootCheck,
      dirty: uncommittedOf,
      log: (l) => console.log(l),
      now: Date.now,
      env: process.env,
      byHand: "no supervisor would bring this process back — restart it by hand",
      settleMs: 20_000,
      minUptimeMs: 45_000,
      tickMs: 15_000,
      others: [],
      ...opts,
    };
  }

  status(): AutoStatus { return this.state; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.o.tickMs);
    (this.timer as any).unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private set(state: AutoState, why: string, uncommitted: string[] = [], reason?: AutoReason): AutoStatus {
    if (state !== this.state.state || why !== this.state.why) {
      if (state !== "current" || this.state.state !== "current") {
        this.o.log(`[auto-restart] ${this.o.name}: ${state}${reason && reason !== "code-changed" ? ` (${reason})` : ""}${why ? ` — ${why}` : ""}`);
      }
    }
    const others = Object.keys(this.otherStatus).length ? { others: { ...this.otherStatus } } : {};
    return this.state = { state, why, uncommitted, checkedAt: this.o.now(), ...(reason ? { reason } : {}), ...others };
  }

  private get autoOff(): boolean { return /^(off|0|false|no)$/i.test((this.o.env.AUTO_RESTART ?? "").trim()); }

  /** One decision. Returns the status it left; exits the process (via opts.exit) when everything holds. */
  async tick(): Promise<AutoStatus> {
    if (this.running || this.state.state === "restarting") return this.state;
    this.running = true;
    try { return await this.decide(); }
    catch (e: any) { this.o.log(`[auto-restart] ${this.o.name}: check failed: ${e?.message ?? e}`); return this.state; }
    finally { this.running = false; }
  }

  private async decide(): Promise<AutoStatus> {
    const { code } = this.o;
    const st: CodeStatus = code.status(true);
    // this process's own supervisor — only when it IS the one running this process (its stamp carries that pid)
    const sup = this.o.supervisor && this.o.supervised() ? this.o.supervisor.check() : null;
    const supBehind = !!sup && sup.state !== "current" && sup.state !== "unknown";
    // one busy answer for everything this tick asks (one /session request, not one per supervisor)
    let busyMemo: Promise<string | null> | null = null;
    const busy = () => (busyMemo ??= this.o.busy());
    // the watchdog is asked for only by the install's supervised API (a verify API beside it has no stamp of its own)
    if (sup && sup.state !== "unknown") await this.decideOthers(busy);
    if (!st.stale) {
      this.failed = null;
      if (!supBehind) return this.set("current", "");
      return this.decideSupervisor(sup!, busy);
    }

    const changed = code.changedFiles();
    const dirty = await this.o.dirty(code.repo, changed);
    // git could not say: a commit that moved since boot is the best evidence that the change is a committed one
    const committed = dirty ? changed.filter((f) => !dirty.has(f)) : st.head !== st.commit ? changed : [];
    const uncommitted = dirty ? changed.filter((f) => dirty.has(f)).map((f) => code.rel(f)) : [];
    const names = (xs: string[]) => xs.slice(0, 3).join(", ") + (xs.length > 3 ? ` +${xs.length - 3} more` : "");
    if (!committed.length) {
      // a supervisor change waits too: restarting the worker for it would load somebody's uncommitted edit
      const andSup = supBehind && sup!.need ? `; the supervisor's ${sup!.need.why} waits as well (a restart would load the edit)` : "";
      return this.set("uncommitted", `${changed.length} loaded file(s) edited on disk but not committed (${names(changed.map((f) => code.rel(f)))}) — ` +
        "not picked up until they are committed, or the service is restarted by hand" + andSup, uncommitted);
    }
    const what = `${committed.length} committed file(s) changed (${names(committed.map((f) => code.rel(f)))})`;
    if (this.autoOff) return this.set("off", `${what}; AUTO_RESTART=off — restart by hand`, uncommitted, "code-changed");
    if (!this.o.supervised()) return this.set("unsupervised", `${what}; ${this.o.byHand}`, uncommitted, "code-changed");

    const now = this.o.now();
    const quietFor = now - st.changedAt;
    if (quietFor < this.o.settleMs) return this.set("settling", `${what}; restarting once the change has been quiet for ${Math.round(this.o.settleMs / 1000)} s`, uncommitted, "code-changed");
    if (now - code.bootAt < this.o.minUptimeMs) return this.set("settling", `${what}; this process only just started — restarting shortly`, uncommitted, "code-changed");

    const busyFirst = await busy();
    if (busyFirst) return this.set("held", `${what}; restart held: ${busyFirst}`, uncommitted, "code-changed");

    if (this.failed?.sig !== st.sig) {
      const err = await this.o.check(code.entry);
      this.failed = err ? { sig: st.sig, why: err } : null;
    }
    if (this.failed) return this.set("boot-check-failed", `${what}, but the code on disk does not build — still running the old code: ${this.failed.why}`, uncommitted, "code-changed");

    // the busy answer is seconds old by now (the boot check ran in between): ask once more before going
    const busyNow = await this.o.busy();
    if (busyNow) return this.set("held", `${what}; restart held: ${busyNow}`, uncommitted, "code-changed");

    // the supervisor is behind too and free to go: one restart takes both (a fresh supervisor starts the new code
    // anyway; an env-only change is re-read on the plain relaunch below)
    if (sup?.state === "ready" && sup.need?.kind === "supervisor-changed" && !this.o.supervisor!.request(sup, `${this.o.name} worker pid ${process.pid}`)) {
      const s = this.set("restarting", `${what}, and the supervisor's ${sup.need.why}; asking the supervisor to replace itself`, uncommitted, "supervisor-changed");
      this.o.exit(SUPERVISOR_REPLACE_EXIT);
      return s;
    }
    const s = this.set("restarting", `${what}; exiting for the supervisor to relaunch`, uncommitted, "code-changed");
    this.o.exit(0);
    return s;
  }

  /** The code is current; the supervisor's stamp is not. */
  private async decideSupervisor(sup: WatchCheck, busy: () => Promise<string | null>): Promise<AutoStatus> {
    const need = sup.need!;
    const reason: AutoReason = need.kind;
    const what = `the supervisor's ${need.why}`;
    if (sup.state === "old") {
      return this.set("supervisor-old", `${what} — this supervisor started before it could restart itself: restart it by hand once (CLAUDE.md, "What is live")`, [], reason);
    }
    if (this.autoOff) return this.set("off", `${what}; AUTO_RESTART=off — restart the supervisor by hand (CLAUDE.md, "What is live")`, [], reason);
    if (sup.state === "refused") {
      return this.set("boot-check-failed", `${what}, but the supervisor refused it — still running the old config: ${sup.stamp?.refused?.why ?? "?"}`, [], reason);
    }
    if (sup.state === "settling") return this.set("settling", `${what}; restarting once the change has been quiet for a moment`, [], reason);
    const up = this.o.now() - this.o.code.bootAt;
    const minUp = Math.max(this.o.minUptimeMs, MIN_UPTIME_MS);
    if (up < minUp) return this.set("settling", `${what}; this process only just started — restarting in about ${Math.ceil((minUp - up) / 1000)} s`, [], reason);
    if (sup.state === "cooldown") {
      const ago = Math.round(this.o.supervisor!.sinceLastRequest() / 1000);
      return this.set("held", `${what}; restart held: this supervisor was restarted for a config change ${ago} s ago — at most one every 5 min (loop guard)`, [], reason);
    }
    const b = await busy();
    if (b) return this.set("held", `${what}; restart held: ${b}`, [], reason);
    const err = this.o.supervisor!.request(sup, `${this.o.name} worker pid ${process.pid}`);
    if (err) return this.set("held", `${what}; restart held: ${err}`, [], reason);
    if (need.kind === "env-changed") {
      const s = this.set("restarting", `${what}; exiting for the supervisor to relaunch with the new config`, [], reason);
      this.o.exit(0);
      return s;
    }
    const s = this.set("restarting", `${what}; asking the supervisor to replace itself (request file + exit ${SUPERVISOR_REPLACE_EXIT})`, [], reason);
    this.o.exit(SUPERVISOR_REPLACE_EXIT);
    return s;
  }

  /** Supervisors without a worker of their own: write their request file when they are behind and free to go. */
  private async decideOthers(busy: () => Promise<string | null>): Promise<void> {
    const next: Record<string, OtherStatus> = {};
    for (const w of this.o.others) {
      try {
        const c = w.check();
        if (c.state === "current" || c.state === "unknown" || !c.need) continue;
        const what = c.need.why;
        const pend = w.pending();
        let st: OtherStatus;
        if (c.state === "old") st = { state: "supervisor-old", why: `${what} — it started before it could restart itself: restart it by hand once (CLAUDE.md, "What is live")` };
        else if (this.autoOff) st = { state: "off", why: `${what}; AUTO_RESTART=off — restart it by hand (CLAUDE.md, "What is live")` };
        else if (c.state === "refused") st = { state: "boot-check-failed", why: `${what}, but it refused it — still running the old one: ${c.stamp?.refused?.why ?? "?"}` };
        else if (pend) st = { state: "requested", why: `${what}; restart requested ${new Date(pend.at).toISOString()} — it picks the request up within a minute` };
        else if (c.state === "settling") st = { state: "settling", why: `${what}; restarting once the change has been quiet for a moment` };
        else if (c.state === "cooldown") st = { state: "held", why: `${what}; restart held: restarted for a config change ${Math.round(w.sinceLastRequest() / 1000)} s ago — at most one every 5 min (loop guard)` };
        else {
          const b = await busy();
          if (b) st = { state: "held", why: `${what}; restart held: ${b}` };
          else {
            // a watchdog has no worker to relaunch: whatever changed, only a fresh watchdog reads it
            const err = w.request({ ...c, need: { ...c.need, kind: "supervisor-changed" } }, `${this.o.name} pid ${process.pid}`);
            st = err ? { state: "held", why: `${what}; restart held: ${err}` } : { state: "requested", why: `${what}; restart requested — it picks the request up within a minute` };
            if (!err) this.o.log(`[auto-restart] ${this.o.name}: asked supervisor ${w.name} to replace itself — ${what}`);
          }
        }
        next[w.name] = st;
      } catch (e: any) {
        next[w.name] = { state: "held", why: `check failed: ${e?.message ?? e}` };
      }
    }
    this.otherStatus = next;
  }
}

/**
 * Is a poker session live on this install? Asked of the wrapper's panel (the table leader holds the session).
 * null = no; else the reason to hold a restart. A wrapper that is not running at all cannot have a session; one that
 * is running but does not answer is an UNKNOWN, and unknown holds — a restart must never be the thing that takes the
 * answers away mid-hand.
 */
export async function liveSessionReason(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const panel = livePort("panel", env);
  let res: Response;
  try {
    res = await fetchFn(`http://127.0.0.1:${panel}/session`, { signal: AbortSignal.timeout(5_000) });
  } catch (e: any) {
    const code = String(e?.code ?? e?.cause?.code ?? "");
    if (/ConnectionRefused|ECONNREFUSED/i.test(code) || /refused|unable to connect/i.test(String(e?.message ?? ""))) return null;
    return `the wrapper on :${panel} is not answering (${String(e?.name ?? e?.message ?? e).slice(0, 60)}) — cannot tell whether a session is live`;
  }
  if (!res.ok) return `the wrapper on :${panel} answered ${res.status} to /session — cannot tell whether a session is live`;
  let j: any;
  try { j = await res.json(); } catch { return `the wrapper on :${panel} sent an unreadable /session reply`; }
  if (j?.current) return `a poker session is live (${String(j.current.id ?? "session")}) — it restarts when the session ends`;
  return null;
}
