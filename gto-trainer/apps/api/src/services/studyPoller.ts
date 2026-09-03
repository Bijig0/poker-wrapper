import { DEFAULT_LIVE_URL } from "../routes/ingest";
import { buildAnswerText, type AnswerAction } from "../feed/buildAnswerText/buildAnswerText";
import { gtowCdp } from "./gtowCdp";
import { gtowApi } from "./gtowApi";
import { answerLog } from "./answerLog";

/**
 * Backend poller: reads assistive-play's live hand via gto-trainer's own
 * `POST /api/ingest` (same body shape the dashboard's client-side "Go live"
 * toggle already sends — zero duplicated navigation/decision logic), and
 * pushes a short answer string to assistive-play's panel whenever hero has a
 * real decision — preflop or postflop; navigateViaUrl already works
 * identically for both, so nothing street-specific gates this poller.
 *
 * Auto-started once at server boot (see index.ts) and left running
 * indefinitely — the single control is assistive-play's own "Study Answers"
 * toggle: a cheap pre-check every tick reads that flag (no GTO Wizard
 * traffic) and the poller only ever navigates/solves while it's on. While
 * it's on and GTO Wizard isn't connected, the poller launches it itself
 * (same launchApp() the dashboard's "Connect GTO Wizard" button uses) so
 * "click Study Answers on" is the ONE action that turns everything on — no
 * separate poller start/stop or GTO Wizard connect step for normal use. The
 * manual start()/stop() controls (exposed via routes/studyPoller.ts) remain
 * as an override, e.g. to force-stop it or pin a different setId/depth.
 */

export interface StudyPollerConfig {
  assistiveUrl?: string;
  selfBaseUrl?: string;
  intervalMs?: number;
  setId?: string;
  depth?: number;
}

export interface StudyPollerStatus {
  running: boolean;
  lastTickAt: number | null;
  lastPushAt: number | null;
  lastError: string | null;
  lastAnswer: string | null;
  gtoWizardConnected: boolean;
  /** A launchApp() is currently in flight (auto-connect / wedge recovery). */
  gtoWizardLaunching: boolean;
  /** Why the most recent solve produced no decision — diagnostic breadcrumb
   *  for "no answer" reports. Cleared by the next successful solve. */
  lastNavFailure: { at: number; street: string | null; reason: string } | null;
  /** Consecutive DIFFERENT decisions that have all failed to navigate — the
   *  wedge signal (see ensureGtoWizardLaunching). Resets on any success. */
  distinctFailureStreak: number;
  /** A bearer token is in hand right now — i.e. the next solve won't stall on
   *  the CDP sniff. Free to read; never triggers one. */
  tokenReady: boolean;
  /** Result of the readiness probe fired when Study Answers came on. */
  startupProbe: { at: number; ok: boolean; ms: number; error: string | null } | null;
}

interface IngestLikeResponse {
  ok?: boolean;
  hero?: { toAct?: boolean; cards?: string[] };
  hand?: { street?: string; board?: string[]; actions?: unknown[]; node?: { toCall?: number } };
  // assistive-play's own local "Study Answers" toggle, forwarded by /api/ingest
  // for the live source — the single gate: this poller runs continuously, but
  // only actually pushes an answer while the panel's own switch is on.
  studyAnswersOn?: boolean | null;
  studyMode?: "exploit" | "chart" | null;
  navigation?: {
    ok?: boolean;
    /** True when the failure is the SPOT being off-tree/unsolvable — a fact
     *  about the hand, not about GTO Wizard's health. Must not feed the
     *  wedge detector, or play-money tables full of odd sizes would trigger
     *  pointless GTO Wizard relaunches mid-session. */
    offTree?: boolean;
    /** The answer came from a snapped/translated line or a fast solve. */
    approx?: boolean;
    /** Human-readable failure reason (wrong node, off-tree, blocker, …). */
    error?: string;
    response?: {
      decision?: { action: string; frequency?: number } | null;
      actions?: AnswerAction[];
    } | null;
  } | null;
  /** Set when the hand couldn't even be mapped to a navigable spot. */
  deferred?: string;
}

/** Shape of POST /api/fast-solver's response (routes/fastSolver.ts): the same
 *  hand envelope as ingest, with `solution` (services/fastSolve.ts) instead
 *  of `navigation` — charts + spot-solution API, no DOM, no navLock. */
interface FastSolveLikeResponse {
  ok?: boolean;
  hero?: { toAct?: boolean; cards?: string[] };
  hand?: {
    handId?: number;
    clientHandId?: string | null;
    street?: string;
    board?: string[];
    actions?: unknown[];
    node?: { toCall?: number };
  };
  studyAnswersOn?: boolean | null;
  studyMode?: "exploit" | "chart" | null;
  solution?:
    | {
        ok: true;
        decision?: { action: string; frequency?: number; band?: [number, number] } | null;
        actions?: AnswerAction[];
        approx?: boolean;
        notInRange?: boolean;
        tier?: string;
        /** Chart/solution-set id the answer came from (answer-log join key). */
        gametype?: string;
        setId?: string;
        source?: string;
        /** MES/GTO provenance (services/fastSolve.ts) — which strategy was
         *  primary and what the other one would have picked. */
        strategyMode?: "exploit" | "chart";
        exploitDecision?: { action: string } | null;
        chartDecision?: { action: string } | null;
        warning?: string | null;
      }
    | { ok: false; reason: string; street?: string }
    | null;
  deferred?: string;
}

const DEFAULT_SELF_BASE_URL = "http://localhost:2000/api";
const DEFAULT_INTERVAL_MS = 1000;

/** A decision's identity — a new key means a new spot worth navigating to.
 *  Mirrors the dashboard's own spotKey/lastNavKey fallback formula. */
const decisionKey = (r: IngestLikeResponse): string =>
  JSON.stringify([r.hand?.street, r.hand?.board, r.hero?.cards, r.hand?.node?.toCall, (r.hand?.actions ?? []).length]);

/** One roll per decision: sample the strategy mix (1-100 over cumulative
 *  frequencies) so a mixed spot ends in a single actionable pick, the way a
 *  human would RNG it at the table. Rolled ONCE when the spot is first solved
 *  — the keep-alive re-push repeats the same pick, so it never flickers
 *  while hero deliberates. Pure (≥99%) spots get the pick without a roll. */
const rollAction = (
  actions: AnswerAction[] | undefined,
  fallback: string,
): { pick: string; roll: number | null } => {
  const mix = (actions ?? []).filter((a) => a.frequency > 1);
  if (mix.length < 2) return { pick: fallback, roll: null };
  const total = mix.reduce((s, a) => s + a.frequency, 0);
  const n = 1 + Math.floor(Math.random() * 100);
  let acc = 0;
  for (const a of mix) {
    acc += (a.frequency / total) * 100;
    if (n <= acc) return { pick: a.action, roll: n };
  }
  return { pick: fallback, roll: n };
};

class StudyPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private config = {
    assistiveUrl: DEFAULT_LIVE_URL,
    selfBaseUrl: DEFAULT_SELF_BASE_URL,
    intervalMs: DEFAULT_INTERVAL_MS,
    setId: undefined as string | undefined,
    depth: undefined as number | undefined,
  };
  private status: StudyPollerStatus = {
    running: false,
    lastTickAt: null,
    lastPushAt: null,
    lastError: null,
    lastAnswer: null,
    gtoWizardConnected: false,
    gtoWizardLaunching: false,
    lastNavFailure: null,
    distinctFailureStreak: 0,
    tokenReady: false,
    startupProbe: null,
  };
  private lastLaunchAttempt = 0;
  private readonly LAUNCH_COOLDOWN_MS = 30_000;
  /** Study Answers was on as of the last tick — the false→true edge is what we
   *  treat as "the panel just opened". */
  private studyWasOn = false;
  /** The rig's MES/GTO tab as of the last probe — passed to the solver. */
  private lastStudyMode: "exploit" | "chart" | null = null;
  private probing = false;
  private readonly PROBE_COOLDOWN_MS = 5 * 60_000;
  // Identity of the decision GTO Wizard last successfully navigated to and
  // solved — without this, gotoNodeUrl's full page reload (location.href)
  // would re-fire every single tick for as long as the SAME decision sits
  // pending (a human deliberating, or just a quiet preflop spot), which
  // looks like GTO Wizard being stuck re-navigating in a loop and never
  // settling. Same idea as the dashboard's own spotKey/lastNavKey guard.
  private lastSolvedKey: string | null = null;
  // Wedge detection: GTO Wizard can stay CDP-connected (debug port answers
  // fine) while its own navigation is stuck rejecting every new URL with the
  // same stale error — confirmed manually. isConnected() alone can't see
  // this. Tracking DISTINCT failing decisions (not raw failed ticks) avoids
  // false-triggering on one genuinely unsolved spot that just sits pending
  // for a while — only several DIFFERENT decisions failing in a row is a
  // real wedge signal.
  private lastFailedKey: string | null = null;
  private readonly WEDGE_THRESHOLD = 3;

  start(config: StudyPollerConfig = {}): StudyPollerStatus {
    if (this.timer) clearInterval(this.timer);
    this.config = {
      assistiveUrl: config.assistiveUrl ?? DEFAULT_LIVE_URL,
      selfBaseUrl: config.selfBaseUrl ?? DEFAULT_SELF_BASE_URL,
      intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
      setId: config.setId,
      depth: config.depth,
    };
    this.status.running = true;
    this.status.lastError = null;
    // start() re-points a RUNNING poller at a different wrapper (the panel
    // calls it whenever Study Answers goes on, so the one poller follows
    // whichever rig you switched). Carrying the old target's progress across
    // that switch is wrong in every case: a solved-key from the other table
    // suppresses the new table's first solve, and a solve still in flight
    // holds the single-flight guard against a spot it was never for.
    this.lastSolvedKey = null;
    this.lastFailedKey = null;
    this.lastProbeKey = null;
    this.nav = null;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
    return this.getStatus();
  }

  async stop(): Promise<StudyPollerStatus> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status.running = false;
    this.lastSolvedKey = null;
    this.lastFailedKey = null;
    this.status.distinctFailureStreak = 0;
    this.lastLaunchAttempt = 0; // a fresh start() shouldn't inherit an old cooldown
    await this.push(null);
    return this.getStatus();
  }

  getStatus(): StudyPollerStatus {
    // Read-time, not tick-time: the tick returns early whenever the panel is
    // unreachable or the switch is off, and a token-readiness field that only
    // updates on the happy path reports "not ready" for a token we're holding.
    return { ...this.status, tokenReady: gtowApi.hasLiveToken() };
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.status.lastTickAt = Date.now();
    try {
      // Cheap first check (no navigate) — reads assistive-play's hand + its
      // Study Answers flag without touching GTO Wizard at all. Keeps this
      // poller idle (no navLock contention, no CDP traffic) whenever the
      // panel's own switch is off, so it's safe to just always be running.
      const probe = await this.fetchIngest(false);
      if (!probe) return; // error already recorded, null already pushed

      // an MES/GTO tab flip is a NEW question about the same spot — drop the
      // solved-key so the next tick re-answers instead of re-pushing the cache
      if ((probe.studyMode ?? null) !== this.lastStudyMode) this.lastSolvedKey = null;
      this.lastStudyMode = probe.studyMode ?? null;
      if (probe.studyAnswersOn !== true) {
        this.studyWasOn = false; // switching it back on re-arms the readiness probe
        this.status.lastError = null;
        await this.push(null);
        return;
      }

      // Study Answers is on — make sure GTO Wizard is actually up. Launching
      // takes up to ~30s, so this is fire-and-forget (never blocks the tick
      // loop) with a cooldown so we don't relaunch every single tick while
      // one attempt is already in flight or just failed.
      this.status.gtoWizardConnected = await gtowCdp.isConnected();
      if (!this.status.gtoWizardConnected) {
        this.ensureGtoWizardLaunching();
        this.status.lastError = null;
        // Blanking the answer means the spot is unsolved again, so forget
        // that it was ever solved — otherwise the keep-alive above matches a
        // key whose answer no longer exists.
        this.lastSolvedKey = null;
        await this.push(null);
        return;
      }

      // Panel on AND the client reachable — the earliest instant a token CAN
      // be sniffed. Do it here rather than let the first real decision pay for
      // it: the sniff measured 7.2-8.6s, bigger than any solve, and the token
      // keeper's 30s cadence loses that race whenever GTO Wizard was launched
      // to order (which is the normal path — the poller launches it itself).
      gtowApi.primeToken();
      if (!this.studyWasOn) {
        this.studyWasOn = true;
        this.runStartupProbe();
      }

      const eligible = probe.ok === true && probe.hero?.toAct === true && probe.hand?.street != null;
      this.status.lastError = null;
      if (!eligible) {
        this.lastSolvedKey = null; // stale — a future recurrence must re-navigate fresh
        await this.push(null);
        return;
      }

      const key = decisionKey(probe);
      this.lastProbeKey = key;
      // Only keep alive an answer that EXISTS. Any push(null) — GTO Wizard
      // dropping for a single tick was enough — blanks lastAnswer while
      // leaving lastSolvedKey set, and this branch then re-pushed that null
      // every tick and never re-solved. The panel sat on "solving your
      // spot…" for a spot the fast path answers in 0.2s, while the poller
      // reported running, connected, no error: healthy and permanently
      // silent, which is the worst way to fail.
      if (key === this.lastSolvedKey && this.status.lastAnswer) {
        // Already navigated GTO Wizard here and it's already showing the
        // right answer — don't reload the same page again every tick. But DO
        // re-push the same text: the panel expires answers 3s after the last
        // push (so a dead poller can't show stale advice), and without a
        // keep-alive the verdict blanked out while hero was still deciding.
        await this.push(this.status.lastAnswer);
        return;
      }

      // Solve in the BACKGROUND. A postflop navigation can take tens of
      // seconds; awaiting it here froze the whole tick loop, so on a fast
      // table (Zone) the NEXT hand's preflop couldn't even be probed until
      // the previous hand's abandoned solve timed out. Strictly ONE solve
      // outstanding, and never aborted early: cancelling the fetch can't
      // cancel the server-side navigation, which kept holding the single-
      // flight navLock and bounced every later solve as "skipped". Let it
      // finish (a verdict for a spot hero left is dropped) and start the
      // current spot's solve on the next tick.
      if (this.nav) return;
      this.nav = { key };
      void this.solveSpot(key).finally(() => {
        this.nav = null;
      });
    } finally {
      this.inFlight = false;
    }
  }

  /** Solve one spot via the FAST path and push its verdict — runs detached
   *  from the tick loop. No GTO Wizard DOM navigation: preflop answers come
   *  from the local charts and postflop from the spot-solution API (with the
   *  far-snap AI escape for off-tree sizes) — seconds, not tens of seconds,
   *  which is the difference between useful and useless on a Zone table.
   *  A verdict for a spot hero has already left is dropped. */
  private async solveSpot(key: string): Promise<void> {
    const t0 = Date.now();
    const full = await this.fetchFastSolve();
    if (!full) return;
    if (key !== this.lastProbeKey) return; // stale — hero is on a new decision
    const sol = full.solution;
    // Every solve outcome is persisted (services/answerLog.ts) — the
    // dashboard's per-node "what was I told" trail and latency stats.
    const logBase = {
      ts: Date.now(),
      wrapperHandId: full.hand?.handId ?? null,
      clientHandId: full.hand?.clientHandId ?? null,
      street: full.hand?.street ?? null,
      board: (full.hand?.board ?? []).join("") || null,
      heroCards: (full.hero?.cards ?? []).join("") || null,
      decisionKey: key,
      latencyMs: Date.now() - t0,
      chart: (sol?.ok === true ? sol.gametype : null) ?? null,
    };
    this.status.lastError = null;
    if (!(sol?.ok === true && sol.decision != null)) {
      // Breadcrumb for "no answer" reports: WHY did this spot yield nothing.
      // Fast-solve failures are facts about the hand/charts, never a GTO
      // Wizard health signal (no DOM involved) — so no wedge relaunching.
      const reason =
        sol?.ok === false
          ? sol.reason
          : sol?.ok === true && sol.notInRange
            ? "hero's hand isn't in the chart range at this node"
            : (full.deferred ?? "no decision in response");
      this.status.lastNavFailure = { at: Date.now(), street: full.hand?.street ?? null, reason };
      answerLog.add({ ...logBase, text: null, pick: null, roll: null, tier: null, warning: null, failReason: reason });
      await this.push(null); // don't cache the key — retry this same spot next tick
      return;
    }
    // "≈" — the verdict came from a snapped (nearest-tree-size) line or a
    // fresh fast solve, not the exact sizes played. Honest, and short
    // enough for the large-print panel.
    const approx = sol.approx === true ? "≈ " : "";
    // A pure decision (>=99%) IS the answer — never roll over the display
    // mix. The pool-exploit overlay returns decision 100% with the chart mix
    // in `actions` for context; rolling over that mix served the chart's
    // action instead of the exploit's (caught live on the fake table).
    const rolled = (sol.decision.frequency ?? 0) >= 99
      ? { pick: sol.decision.action, roll: null }
      : rollAction(sol.actions, sol.decision.action);
    const text = approx + buildAnswerText({
      street: full.hand!.street!,
      decision: sol.decision,
      actions: sol.actions,
    }) + (rolled.roll != null ? ` · roll ${rolled.roll} → ${rolled.pick.toUpperCase()}` : "");
    this.lastSolvedKey = key;
    this.status.distinctFailureStreak = 0;
    this.status.lastNavFailure = null;
    answerLog.add({
      ...logBase,
      text,
      pick: rolled.pick,
      roll: rolled.roll,
      tier: sol.tier ?? (full.hand?.street === "preflop" ? "local-preflop" : null),
      warning: sol.warning ?? null,
      failReason: null,
    });
    // The solve's own caveat (snapped sizes, generic ranges, …) rides along
    // so the panel can show HOW MUCH to trust this verdict.
    // Provenance rides along with the pick so a recording can say not just
    // WHAT we advised but from WHICH strategy/chart and WHERE the roll fell.
    await this.push(text, {
      ...rolled,
      band: sol.decision?.band ?? null,
      strategy: sol.strategyMode ?? null,
      source: sol.source ?? null,
      tier: sol.tier ?? null,
      chart: sol.setId ?? null,
      exploitPick: sol.exploitDecision?.action ?? null,
      chartPick: sol.chartDecision?.action ?? null,
    }, (sol as { warning?: string | null }).warning ?? null);
  }

  /** POST /api/fast-solver — same body as ingest, no navigation, no navLock. */
  private async fetchFastSolve(): Promise<FastSolveLikeResponse | null> {
    try {
      const res = await fetch(`${this.config.selfBaseUrl}/fast-solver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          live: { url: this.config.assistiveUrl },
          setId: this.config.setId,
          depth: this.config.depth,
          strategy: this.lastStudyMode ?? undefined,
        }),
        // Library lookups return in ~1-2s; the far-snap AI escape can take
        // a cloud solve (~5-30s). Generous, but nothing blocks behind it.
        signal: AbortSignal.timeout(45000),
      });
      const body = (await res.json().catch(() => null)) as FastSolveLikeResponse | null;
      if (!body) {
        this.status.lastError = `Fast-solver returned non-JSON (HTTP ${res.status}).`;
        return null;
      }
      return body;
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  /**
   * One throwaway solve when Study Answers comes on, so the things that make
   * the FIRST real decision fail — a logged-out client, an exhausted daily
   * solve limit, a cold TLS connection — surface while hero is still between
   * hands instead of mid-decision. Fire-and-forget; the result lands in
   * `status.startupProbe` for the dashboard to show.
   *
   * The board and ranges are FIXED, so gtowApi's caches make this free after
   * the first run in a process: a genuine end-to-end check once per session,
   * a smoke test thereafter. `status.tokenReady` is the signal that stays
   * honest every tick. Set GTOW_STARTUP_PROBE=0 to skip it entirely.
   */
  private runStartupProbe(): void {
    if (process.env.GTOW_STARTUP_PROBE === "0" || this.probing) return;
    if (Date.now() - (this.status.startupProbe?.at ?? 0) < this.PROBE_COOLDOWN_MS) return;
    this.probing = true;
    const t0 = Date.now();
    void (async () => {
      try {
        const full = new Array(1326).fill(1);
        const r = await gtowApi.customSolve({
          board: "Ts7h2d", pot: 5, stack: 97.5, oopRange: full, ipRange: full,
          oopPos: "BB", ipPos: "SB", startingStreet: "FLOP", flopActions: "X",
        });
        this.status.startupProbe = {
          at: Date.now(), ok: r.ok, ms: Date.now() - t0, error: r.ok ? null : r.error,
        };
      } catch (e) {
        this.status.startupProbe = {
          at: Date.now(), ok: false, ms: Date.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        };
      } finally {
        this.probing = false;
      }
    })();
  }

  /** Fire-and-forget launchApp(), gated by a cooldown so a slow/failed launch
   *  isn't retried every tick. Same launchApp() the "Connect GTO Wizard"
   *  button already uses — quits and relaunches with remote debugging.
   *  `force` bypasses launchApp()'s own "debug port already reachable"
   *  shortcut — needed for the wedged-but-connected case, where that check
   *  alone would report everything fine and skip relaunching entirely. */
  private ensureGtoWizardLaunching(force = false): void {
    const now = Date.now();
    if (now - this.lastLaunchAttempt < this.LAUNCH_COOLDOWN_MS) return;
    this.lastLaunchAttempt = now;
    // Surfaced in status so the panel can show "connecting…" instead of a
    // bare "not connected" while the relaunch is actually in flight.
    this.status.gtoWizardLaunching = true;
    gtowCdp
      .launchApp(force ? { force: true } : undefined)
      .catch((e) => {
        this.status.lastError = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.status.gtoWizardLaunching = false;
      });
  }

  /** POSTs to gto-trainer's own /api/ingest; returns null (and records the
   *  error + clears the panel) on any failure, so callers can bail cleanly. */
  private async fetchIngest(navigate: boolean, abort?: AbortSignal): Promise<IngestLikeResponse | null> {
    try {
      // The no-navigate probe is a local read — 5s is generous. A real
      // navigation loads GTO Wizard's page and waits for the solve to
      // render; postflop that routinely takes >5s, and aborting it here
      // made every postflop verdict die as "The operation timed out."
      const timeout = AbortSignal.timeout(navigate ? 45000 : 5000);
      const res = await fetch(`${this.config.selfBaseUrl}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          live: { url: this.config.assistiveUrl },
          navigate,
          setId: this.config.setId,
          depth: this.config.depth,
        }),
        signal: abort ? AbortSignal.any([timeout, abort]) : timeout,
      });
      const body = (await res.json().catch(() => null)) as IngestLikeResponse | null;
      if (!body) {
        this.status.lastError = `Ingest returned non-JSON (HTTP ${res.status}).`;
        await this.push(null);
        return null;
      }
      return body;
    } catch (e) {
      // A deliberate abort (hero moved to a new decision) is not an error —
      // the new spot's own solve is already underway.
      if (abort?.aborted) return null;
      this.status.lastError = e instanceof Error ? e.message : String(e);
      await this.push(null);
      return null;
    }
  }

  /** The rolled pick for the current answer, repeated verbatim by the
   *  keep-alive so the sampled action never re-rolls mid-decision. */
  private lastExtra: { pick: string; roll: number | null; band?: [number, number] | null;
                       strategy?: string | null; source?: string | null; tier?: string | null;
                       chart?: string | null; exploitPick?: string | null; chartPick?: string | null } | null = null;
  /** The solve's caveat (snapped sizes, generic ranges) for the current
   *  answer — repeated by the keep-alive alongside it. */
  private lastNote: string | null = null;

  /** The in-flight background solve, if any. Never aborted mid-flight (the
   *  server-side navigation can't be cancelled and holds the navLock); a new
   *  spot simply waits for the next tick after this one completes. */
  private nav: { key: string } | null = null;
  /** decisionKey of the most recent probe — verdicts for any other key are
   *  stale and get dropped instead of pushed. */
  private lastProbeKey: string | null = null;

  private async push(
    text: string | null,
    extra?: { pick: string; roll: number | null; band?: [number, number] | null;
              strategy?: string | null; source?: string | null; tier?: string | null;
              chart?: string | null; exploitPick?: string | null; chartPick?: string | null } | null,
    note?: string | null,
  ): Promise<void> {
    this.status.lastAnswer = text;
    this.lastExtra = text ? (extra ?? this.lastExtra) : null;
    this.lastNote = text ? (note !== undefined ? note : this.lastNote) : null;
    try {
      await fetch(`${this.config.assistiveUrl}/panel/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // pick/roll/note ride along for panels that headline the sampled
        // action and show the solve's caveat; assistive-play's original
        // panel reads only `text` and is unharmed.
        body: JSON.stringify({
          text,
          pick: this.lastExtra?.pick ?? null,
          roll: this.lastExtra?.roll ?? null,
          band: this.lastExtra?.band ?? null,
          strategy: this.lastExtra?.strategy ?? null,
          source: this.lastExtra?.source ?? null,
          tier: this.lastExtra?.tier ?? null,
          chart: this.lastExtra?.chart ?? null,
          exploitPick: this.lastExtra?.exploitPick ?? null,
          chartPick: this.lastExtra?.chartPick ?? null,
          note: this.lastNote,
        }),
        signal: AbortSignal.timeout(3000),
      });
      this.status.lastPushAt = Date.now();
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
    }
  }
}

export const studyPoller = new StudyPoller();
