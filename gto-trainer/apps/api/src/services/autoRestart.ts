import { LoadedCode, bootCheck, uncommittedOf, type CodeStatus } from "./loadedCode";
import { livePort } from "./ports";

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
 */

export type AutoState =
  | "current"            // running what is on disk
  | "uncommitted"        // only uncommitted edits differ: not picked up until committed (or restarted by hand)
  | "settling"           // a committed change landed moments ago; restarting once it is quiet
  | "held"               // a committed change is waiting: a session is live / the process is busy
  | "boot-check-failed"  // the code on disk would not start; the old process keeps serving
  | "unsupervised"       // nothing would bring this process back, so it will not exit on its own
  | "off"                // AUTO_RESTART=off
  | "restarting";

export interface AutoStatus {
  state: AutoState;
  /** one sentence a person can act on */
  why: string;
  /** changed loaded files that are not committed (relative to the checkout) */
  uncommitted: string[];
  checkedAt: number;
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
  /** exits the process; replaced by tests */
  exit?: () => void;
  check?: (entry: string) => Promise<string | null>;
  dirty?: (repo: string | null, files: string[]) => Promise<Set<string> | null>;
  log?: (line: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  settleMs?: number;
  minUptimeMs?: number;
  tickMs?: number;
}

export class AutoRestart {
  private state: AutoStatus = { state: "current", why: "", uncommitted: [], checkedAt: 0 };
  /** the change set the boot check last failed on: the same broken code is not re-bundled every tick */
  private failed: { sig: string; why: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly o: Required<Omit<AutoRestartOpts, "env">> & { env: NodeJS.ProcessEnv };

  constructor(opts: AutoRestartOpts) {
    this.o = {
      exit: () => { setTimeout(() => process.exit(0), 250); },
      check: bootCheck,
      dirty: uncommittedOf,
      log: (l) => console.log(l),
      now: Date.now,
      env: process.env,
      byHand: "no supervisor would bring this process back — restart it by hand",
      settleMs: 20_000,
      minUptimeMs: 45_000,
      tickMs: 15_000,
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

  private set(state: AutoState, why: string, uncommitted: string[] = []): AutoStatus {
    if (state !== this.state.state || why !== this.state.why) {
      if (state !== "current" || this.state.state !== "current") this.o.log(`[auto-restart] ${this.o.name}: ${state}${why ? ` — ${why}` : ""}`);
    }
    return this.state = { state, why, uncommitted, checkedAt: this.o.now() };
  }

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
    if (!st.stale) { this.failed = null; return this.set("current", ""); }

    const changed = code.changedFiles();
    const dirty = await this.o.dirty(code.repo, changed);
    // git could not say: a commit that moved since boot is the best evidence that the change is a committed one
    const committed = dirty ? changed.filter((f) => !dirty.has(f)) : st.head !== st.commit ? changed : [];
    const uncommitted = dirty ? changed.filter((f) => dirty.has(f)).map((f) => code.rel(f)) : [];
    const names = (xs: string[]) => xs.slice(0, 3).join(", ") + (xs.length > 3 ? ` +${xs.length - 3} more` : "");
    if (!committed.length) {
      return this.set("uncommitted", `${changed.length} loaded file(s) edited on disk but not committed (${names(changed.map((f) => code.rel(f)))}) — ` +
        "not picked up until they are committed, or the service is restarted by hand", uncommitted);
    }
    const what = `${committed.length} committed file(s) changed (${names(committed.map((f) => code.rel(f)))})`;
    if (/^(off|0|false|no)$/i.test((this.o.env.AUTO_RESTART ?? "").trim())) return this.set("off", `${what}; AUTO_RESTART=off — restart by hand`, uncommitted);
    if (!this.o.supervised()) return this.set("unsupervised", `${what}; ${this.o.byHand}`, uncommitted);

    const now = this.o.now();
    const quietFor = now - st.changedAt;
    if (quietFor < this.o.settleMs) return this.set("settling", `${what}; restarting once the change has been quiet for ${Math.round(this.o.settleMs / 1000)} s`, uncommitted);
    if (now - code.bootAt < this.o.minUptimeMs) return this.set("settling", `${what}; this process only just started — restarting shortly`, uncommitted);

    const busy = await this.o.busy();
    if (busy) return this.set("held", `${what}; restart held: ${busy}`, uncommitted);

    if (this.failed?.sig !== st.sig) {
      const err = await this.o.check(code.entry);
      this.failed = err ? { sig: st.sig, why: err } : null;
    }
    if (this.failed) return this.set("boot-check-failed", `${what}, but the code on disk does not build — still running the old code: ${this.failed.why}`, uncommitted);

    // the busy answer is seconds old by now (the boot check ran in between): ask once more before going
    const busyNow = await this.o.busy();
    if (busyNow) return this.set("held", `${what}; restart held: ${busyNow}`, uncommitted);

    const s = this.set("restarting", `${what}; exiting for the supervisor to relaunch`, uncommitted);
    this.o.exit();
    return s;
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
