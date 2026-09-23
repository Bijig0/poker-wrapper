import { DEFAULT_LIVE_URL } from "../routes/ingest";
import { buildAnswerText, type AnswerAction } from "../feed/buildAnswerText/buildAnswerText";
import { gtowCdp } from "./gtowCdp";
import { gtowApi } from "./gtowApi";
import { answerLog, isFailKind, type FailKind } from "./answerLog";
import { isBackgroundOwner } from "./backgroundLock";
import { checkAnswerIntegrity } from "./answerIntegrity";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY ANSWER ATTEMPT, ONE LINE (2026-09-24). The poller kept only its LAST error in memory, so a hand whose
 * postflop never answered ("socket disconnected", hand 750: flop 17.9 s, turn/river never asked) left nothing to
 * read afterwards — the ledger showed GTO Wizard itself answering in 2 s. data/jobs/poller-events.jsonl: time,
 * panel, how long the /fast-solver call took, and the exact outcome or error text.
 */
const POLLER_EVENTS = join(import.meta.dir, "..", "..", "data", "jobs", "poller-events.jsonl");
function pollerEvent(row: Record<string, unknown>): void {
  try {
    mkdirSync(join(import.meta.dir, "..", "..", "data", "jobs"), { recursive: true });
    appendFileSync(POLLER_EVENTS, JSON.stringify({ ts: Date.now(), ...row }) + "\n");
  } catch { /* the log must never cost an answer */ }
}

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
  /** Answers this process served that disagreed with their own mix — a bug
   *  counter that should read 0 (see services/answerIntegrity.ts). */
  integrityFaults: number;
  lastIntegrityFault: { at: number; kind: string; detail: string } | null;
}

interface IngestLikeResponse {
  ok?: boolean;
  /** HTTP status of the /api/ingest reply, stamped on by fetchIngest — the only
   *  way to tell a FAILED ingest from an idle one (both are ok:false). */
  httpStatus?: number;
  /** routes/ingest.ts's failure text on any ok:false reply. */
  error?: string;
  hero?: { toAct?: boolean; cards?: string[];
           /** wrapper state provenance (2026-09-19): the client's turn buttons are on
            *  screen, and why the export nevertheless says it is not hero's turn */
           buttonsUp?: boolean | null; notToActWhy?: string | null; status?: string | null;
           /** the three turn signals (CONTRACT §1b), forwarded by /api/ingest since 2026-09-23 */
           toActSources?: { buttons?: boolean; ws?: boolean; actionOn?: boolean } | null };
  hand?: { street?: string; board?: string[]; actions?: unknown[]; node?: { toCall?: number };
           handId?: number | null; clientHandId?: string | null };
  // assistive-play's own local "Study Answers" toggle, forwarded by /api/ingest
  // for the live source — the single gate: this poller runs continuously, but
  // only actually pushes an answer while the panel's own switch is on.
  studyAnswersOn?: boolean | null;
  /** the session's declared strategy (services/strategies.ts id) — what decides
   *  which preflop piece answers, forwarded by /api/ingest from the wrapper */
  strategyId?: string | null;
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
  hero?: { toAct?: boolean; cards?: string[]; pos?: string | null };
  hand?: {
    handId?: number;
    clientHandId?: string | null;
    street?: string;
    board?: string[];
    actions?: unknown[];
    node?: { toCall?: number };
    /** Wrapper-exported stake/seating facts, persisted with each answer. */
    bbCents?: number | null;
    liveSeats?: number[];
    /** which betting line the wrapper exported and whether it can be trusted */
    lineSource?: string | null;
    lineUncertain?: string | null;
    lineNote?: string | null;
  };
  studyAnswersOn?: boolean | null;
  /** the session's declared strategy — what actually decides the preflop piece */
  strategyId?: string | null;
  sessionId?: string | null;
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
        exploitTag?: string | null;
        mesBoard?: string | null;
        mesEvGainBb?: number | null;
        mesExact?: boolean | null;
        depth?: number;
        pos?: string | null;
        line?: string;
        solveId?: number | null;
      rangeSource?: string;
        warning?: string | null;
      }
    | { ok: false; reason: string; street?: string; gametype?: string; depth?: number; line?: string }
    /* ok:true also carries rangeSource?: string (see fastSolve.ts) */
    | null;
  deferred?: string;
}

const DEFAULT_SELF_BASE_URL = "http://localhost:2000/api";
const DEFAULT_INTERVAL_MS = 1000;

/** MES family of a postflop overlay answer: the tag names it when the
 *  overlay set one, else hero's position implies it (M1 = hero SB bvb,
 *  M2 = hero BTN SRP) — the only two families served today. */
const mesFamilyOf = (tag: string | null | undefined, pos: string | null | undefined): string | null => {
  const m = tag?.match(/^(M\d+_[A-Za-z0-9_]+)/);
  if (m) return m[1]!;
  if (pos === "SB") return "M1_heroSB_bvb_cbet";
  if (pos === "BTN") return "M2_heroBTN_srp_vs_BB";
  return null;
};

/** A decision's identity — a new key means a new spot worth navigating to.
 *  Mirrors the dashboard's own spotKey/lastNavKey fallback formula. */
const decisionKey = (r: IngestLikeResponse): string =>
  JSON.stringify([r.hand?.street, r.hand?.board, r.hero?.cards, r.hand?.node?.toCall, (r.hand?.actions ?? []).length]);

/** One roll per decision: sample the strategy mix (1-100 over cumulative
 *  frequencies) so a mixed spot ends in a single actionable pick, the way a
 *  human would RNG it at the table. Rolled ONCE when the spot is first solved
 *  — the keep-alive re-push repeats the same pick, so it never flickers
 *  while hero deliberates. Pure (≥99%) spots get the pick without a roll. */
export const rollAction = (
  actions: AnswerAction[] | undefined,
  fallback: string,
  /** a roll drawn earlier for this same decision (see rollMemo) — supplied on a re-solve so the pick cannot flip */
  seeded?: number,
): { pick: string; roll: number | null } => {
  const mix = (actions ?? []).filter((a) => a.frequency > 1);
  if (mix.length < 2) return { pick: fallback, roll: null };
  const total = mix.reduce((s, a) => s + a.frequency, 0);
  const n = seeded ?? (1 + Math.floor(Math.random() * 100));
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
    integrityFaults: 0,
    lastIntegrityFault: null,
  };
  private lastLaunchAttempt = 0;
  private readonly LAUNCH_COOLDOWN_MS = 30_000;
  /** How many DIFFERENT decisions may fail in the solve chain, back to back,
   *  before we stop believing the client is healthy and force a relaunch.
   *  Three is deliberately conservative: it is already three lost spots, and a
   *  forced relaunch quits GTO Wizard out from under a live session. */
  private readonly WEDGE_STREAK = 3;
  /** Study Answers was on as of the last tick — the false→true edge is what we
   *  treat as "the panel just opened". */
  private studyWasOn = false;
  /** The rig's MES/GTO tab as of the last probe — passed to the solver. */

  private lastStrategyId: string | null = null;
  /** The wrapper's current MES/GTO toggle as last probed (Sources registry). */
  /** the strategy the live session declared — what decides the preflop piece */
  get strategyId(): string | null {
    return this.lastStrategyId;
  }
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
  /**
   * A DECISION THAT KEEPS FAILING THE SAME WAY (2026-09-19, Brady). Hand 4919236052 asked
   * the same unanswerable question 13 times at ~1 s apart and got the same sentence back
   * every time — burning the clock and the solve budget on a question whose answer could
   * not change, while the panel showed nothing but a blank card. Re-asking is only worth
   * anything when something has CHANGED: the reader recovering (reconcile._revive), a
   * villain acting, a card landing. So the same (decision, reason) is asked
   * REPEAT_FAIL_LIMIT times and then rested — and the panel is told why, instead of
   * watching an invisible retry loop. Any change in the key or the reason re-arms it
   * immediately, because that is new information.
   */
  private repeatFail: { key: string; reason: string; n: number } | null = null;
  private readonly REPEAT_FAIL_LIMIT = 3;

  start(config: StudyPollerConfig = {}): StudyPollerStatus {
    // Two pollers answer the same decision twice, and because rollAction() samples the mix with
    // Math.random() they can roll DIFFERENT actions and both POST to /panel/answer — the panel
    // keeps whichever landed last, so the pick the relay executes becomes a coin flip between two
    // independent rolls (and answers.sqlite gets two rows per decision). Only the background-lock
    // owner polls. The guard is here, not only at boot, because the wrapper's "Study Answers"
    // toggle calls start() through routes/studyPoller.ts — and with reusePort every request lands
    // on whichever instance the OS picked, demoted or not.
    if (!isBackgroundOwner()) {
      this.status.running = false;
      this.status.lastError = "another API process owns the background work (data/background.lock) — this instance serves HTTP only and will not poll";
      return this.getStatus();
    }
    const next = {
      assistiveUrl: config.assistiveUrl ?? DEFAULT_LIVE_URL,
      selfBaseUrl: config.selfBaseUrl ?? DEFAULT_SELF_BASE_URL,
      intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
      setId: config.setId,
      depth: config.depth,
    };
    // SAME TARGET, ALREADY RUNNING = NOTHING TO DO (2026-09-19). The wrapper's chain keeper calls
    // start() every 20 s for as long as a session has answers on, and every call below wipes the
    // in-flight guard (nav) and the probe key — so a solve still running for hero's spot was
    // forgotten and the very next tick started a second one for the same key (session 010011:
    // river rows 1028/1029, 14.8 s + 6.8 s, two rolls, two solve ids for one decision). Only a
    // real re-point (a different wrapper URL / set / depth) or a stopped poller goes through.
    if (this.timer && this.status.running
        && this.config.assistiveUrl === next.assistiveUrl && this.config.selfBaseUrl === next.selfBaseUrl
        && this.config.intervalMs === next.intervalMs && this.config.setId === next.setId && this.config.depth === next.depth) {
      return this.getStatus();
    }
    if (this.timer) clearInterval(this.timer);
    this.config = next;
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
    this.repeatFail = null;
    this.lastProbeKey = null;
    this.nav = null;
    void this.tick();
    // a rejected tick must not become an unhandled rejection: see services/jobs.ts start()
    this.timer = setInterval(() => { this.tick().catch((e) => console.error(`[studyPoller] tick failed (retrying next tick): ${(e as Error)?.stack ?? String(e)}`)); }, this.config.intervalMs);
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
    // Ownership can be lost after start() — the lock's heartbeat found another process had taken it
    // over. Stop answering immediately rather than keep a second poller alive on a stale claim.
    if (!isBackgroundOwner()) { void this.stop(); return; }
    if (this.inFlight) return;
    if (Date.now() < this.skipTicksUntil) return;   // backing off a wrapper whose probes keep failing (EIP-19)
    this.inFlight = true;
    this.status.lastTickAt = Date.now();
    try {
      // Cheap first check (no navigate) — reads assistive-play's hand + its
      // Study Answers flag without touching GTO Wizard at all. Keeps this
      // poller idle (no navLock contention, no CDP traffic) whenever the
      // panel's own switch is off, so it's safe to just always be running.
      const probe = await this.fetchIngest(false);
      if (!probe) return; // error already recorded, null already pushed

      // A different DECLARED STRATEGY is a new question about the same spot — drop
      // the solved-key so the next tick re-answers instead of re-pushing the cache.
      // (This keyed off the panel's MES/GTO tab until 2026-09-14; there is no such
      // tab any more — the strategy names its preflop piece, see services/strategies.ts.)
      if ((probe.strategyId ?? null) !== this.lastStrategyId) this.lastSolvedKey = null;
      this.lastStrategyId = probe.strategyId ?? null;

      // A FAILED ingest is not an idle table. A 502/400 body carries no
      // studyAnswersOn, so until 2026-09-21 it fell into the toggle-off branch
      // below — which reports healthy AND sets lastError = null, actively
      // erasing the evidence. That is how a dead assistive-play server ran
      // unnoticed for ~14h behind a poller whose status page read "running,
      // no error". 409 (wrapper up, no table) and 422 (no hand in the feed)
      // are the genuinely idle ok:false replies and still fall through.
      if (probe.httpStatus != null && ![200, 409, 422].includes(probe.httpStatus)) {
        pollerEvent({ url: this.config.assistiveUrl, ev: "ingest failed", http: probe.httpStatus, error: (probe.error ?? "").slice(0, 300),
                      failures: this.ingestFailures + 1 });
        this.lastSolvedKey = null;
        // BACK OFF A DEAD WRAPPER (EIP-19, 2026-09-23). The boot poller hammered a wrapper that was not running at
        // 1 Hz for days — 1.35 M ingest lines in api.log, two per second — and posted a null to the same dead port
        // each time. Consecutive failures double the wait up to 10 s; the first healthy probe resets it.
        this.ingestFailures = Math.min(this.ingestFailures + 1, 10);
        this.skipTicksUntil = Date.now() + Math.min(10_000, 1000 * 2 ** (this.ingestFailures - 1));
        if (this.ingestFailures > 1) { this.status.lastError = probe.error ?? `Ingest failed (HTTP ${probe.httpStatus}).`; return; }
        // push() BEFORE recording the reason, not after: clearing the panel posts to
        // that same wrapper, so when the wrapper is the thing that died the push
        // fails too and its catch overwrites lastError with the vaguer "Unable to
        // connect. Is the computer able to access the url?" — which names no URL and
        // reads like a GTO Wizard fault. The ingest reason is the diagnostic one, so
        // it gets the last word.
        await this.push(null);
        this.status.lastError = probe.error ?? `Ingest failed (HTTP ${probe.httpStatus}).`;
        return;
      }

      this.ingestFailures = 0;   // a probe that answered at all (200/409/422) ends the back-off
      if (probe.studyAnswersOn !== true) {
        this.studyWasOn = false; // switching it back on re-arms the readiness probe
        this.status.lastError = null;
        await this.push(null);
        return;
      }
      // NEVER SILENT (2026-09-19) — a state-reading fact, checked BEFORE the GTO Wizard gate
      // because it has nothing to do with the solver. This used to be the one place a lost
      // decision left no trace: hero's buttons up, the export saying "not hero's turn", nothing
      // asked, nothing logged (hand 4919080696: a villain's SITTING OUT label read as hero's,
      // 19 s on the clock). The wrapper now says whether the buttons are up and why it still
      // says no; when that holds for 2 s it is written as a failure row and shown on the panel,
      // once per spot.
      // …EXCEPT the client's own end of hero's turn (EIP-24, 2026-09-23): after hero's real fold the action strip
      // can stay rendered for 2 s while the export correctly says "hero folded" / "hand won". That is not a lost
      // decision (answers 3396, 2378 were such rows), so it is not written — unless the client's request (ws)
      // still says hero is to act, which would be a real contradiction.
      const ownEnd = /^(hero folded|hand won)/.test(probe.hero?.notToActWhy ?? "") && probe.hero?.toActSources?.ws !== true;
      if (probe.ok === true && probe.hero?.buttonsUp === true && probe.hero?.toAct !== true && probe.hand?.street != null && !ownEnd) {
        const k = `${probe.hand.street}|${(probe.hand.actions ?? []).length}|${(probe.hero.cards ?? []).join("")}`;
        if (this.buttonsUpSince?.key !== k) this.buttonsUpSince = { key: k, at: Date.now() };
        else if (Date.now() - this.buttonsUpSince.at >= 2000) {
          this.logNoAnswer(decisionKey(probe), probe, "not-to-act-live",
            `your buttons are up but the state says not your turn: ${probe.hero.notToActWhy ?? "no reason given"}`, null);
        }
      } else {
        this.buttonsUpSince = null;
      }

      // Study Answers is on — make sure GTO Wizard is actually up. Launching
      // takes up to ~30s, so this is fire-and-forget (never blocks the tick
      // loop) with a cooldown so we don't relaunch every single tick while
      // one attempt is already in flight or just failed.
      this.status.gtoWizardConnected = await gtowCdp.isConnected();
      // THE CDP PORT IS NOT THE SOLVER (EIP-11, 2026-09-23). The 6-max ring strategy answers preflop from the local
      // bake and postflop over HTTP with a token that outlives the debug port, so a CDP hiccup used to blank every
      // decision until the port answered again — including chart preflop spots that never touch GTO Wizard. Solve
      // when a token is in hand or the spot needs none; the relaunch below still runs, it just no longer gates.
      const localPreflop = probe.strategyId === "ign200-ring-6max-equilibrium" && probe.hand?.street === "preflop";
      const canSolveAnyway = gtowApi.hasLiveToken() || localPreflop;
      if (!this.status.gtoWizardConnected && canSolveAnyway) this.ensureGtoWizardLaunching();
      if (!this.status.gtoWizardConnected && !canSolveAnyway) {
        // Hero on the clock with no client to solve with: a decision is being
        // lost right now, and until 2026-09-14 only an in-memory flag said so.
        if (probe.ok === true && probe.hero?.toAct === true && probe.hand?.street != null) {
          this.logNoAnswer(decisionKey(probe), probe, "gtow-down", "GTO Wizard was not connected while hero was on the clock", null);
        }
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
        // (the buttons-up-but-not-to-act case was recorded above, before the GTO Wizard gate)
        await this.push(null);
        return;
      }

      const key = decisionKey(probe);
      this.lastProbeKey = key;
      if (!this.seenKeys.has(key)) {
        this.seenKeys.add(key);
        if (this.seenKeys.size > 200) this.seenKeys = new Set([key]);
        pollerEvent({ url: this.config.assistiveUrl, ev: "decision seen", key, street: probe.hand?.street ?? null,
                      inFlight: this.nav ? { key: this.nav.key, forMs: Date.now() - this.nav.at } : null });
      }
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
      if (this.nav) {
        // THE ONE-SOLVE-AT-A-TIME GATE: a decision waiting here is not being answered. Written once per key, with
        // what it is waiting on and for how long — a slow or hung solve for an OLD spot holds every later one.
        if (this.nav.key !== key && !this.waitLogged.has(key)) {
          this.waitLogged.add(key);
          if (this.waitLogged.size > 200) this.waitLogged = new Set([key]);
          pollerEvent({ url: this.config.assistiveUrl, ev: "waiting on another solve", key, busyWith: this.nav.key, busyForMs: Date.now() - this.nav.at });
        }
        return;
      }
      this.nav = { key, at: Date.now() };
      pollerEvent({ url: this.config.assistiveUrl, ev: "solve started", key });
      void this.solveSpot(key, probe).finally(() => {
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
  private async solveSpot(key: string, probe: IngestLikeResponse): Promise<void> {
    // rested: this exact decision has failed the same way REPEAT_FAIL_LIMIT times, and
    // nothing about it has changed since. Asking again costs a solve and answers nothing.
    const rf = this.repeatFail;
    if (rf && rf.key === key && rf.n >= this.REPEAT_FAIL_LIMIT) {
      // keep SAYING it, at no solve cost: the panel's answer is freshness-gated, so a
      // note pushed once would vanish a few seconds later and leave the blank card this
      // exists to replace. A dead poller still blanks it, which is the point of the gate.
      await this.push(null, null, `no answer for this spot after ${rf.n} tries — ${rf.reason}`);
      return;
    }
    const t0 = Date.now();
    const full = await this.fetchFastSolve();
    if (!full) {
      // The request itself failed — timeout, refused, or not JSON. This used to
      // return in silence, so a decision lost this way left no trace at all:
      // status.lastError is in memory and gone by the time anyone looks.
      this.logNoAnswer(key, probe, this.lastFetchFailKind ?? "solver-unreachable",
        this.status.lastError ?? "the fast-solver did not answer", Date.now() - t0);
      return;
    }
    if (key !== this.lastProbeKey) {
      // Hero acted while this solve was still running. Logged WITH the latency:
      // "the chain is too slow for Zone" is only a measurable claim if the
      // abandoned solves are counted, and they never were.
      this.logNoAnswer(key, probe, "abandoned-stale",
        `the verdict arrived ${((Date.now() - t0) / 1000).toFixed(1)}s after the probe, hero had already acted`,
        Date.now() - t0, full);
      return; // stale — hero is on a new decision
    }
    const sol = full.solution;
    // Every solve outcome is persisted (services/answerLog.ts) — the
    // dashboard's per-node "what was I told" trail and latency stats.
    const logBase = {
      ts: Date.now(),
      wrapperHandId: full.hand?.handId ?? null,
      clientHandId: full.hand?.clientHandId ?? null,
      // which of the open tables this answer is for — the wrapper stamps it on /hand.
      // wrapperHandId is a per-process counter and collides across tables; this does not.
      tableSlot: (full.hand as { tableSlot?: number | null } | undefined)?.tableSlot ?? null,
      street: full.hand?.street ?? null,
      board: (full.hand?.board ?? []).join("") || null,
      heroCards: (full.hero?.cards ?? []).join("") || null,
      decisionKey: key,
      latencyMs: Date.now() - t0,
      chart: (sol?.ok === true ? (sol.rangeSource ?? sol.gametype) : sol?.ok === false ? sol.gametype : null) ?? null,
      // Provenance persisted since 2026-09-03 (Sources tab live grading).
      // which KIND of piece answered, recorded for the Sources/Analytics comparison
      // only — the table surfaces never read it
      strategyMode: (sol?.ok === true ? sol.strategyMode : null) ?? null,
      source: (sol?.ok === true ? sol.source : null) ?? null,
      bandLo: (sol?.ok === true ? sol.decision?.band?.[0] : null) ?? null,
      bandHi: (sol?.ok === true ? sol.decision?.band?.[1] : null) ?? null,
      exploitPick: (sol?.ok === true ? sol.exploitDecision?.action : null) ?? null,
      chartPick: (sol?.ok === true ? sol.chartDecision?.action : null) ?? null,
      exploitTag: (sol?.ok === true ? sol.exploitTag : null) ?? null,
      mesFamily: (sol?.ok === true && sol.mesBoard ? mesFamilyOf(sol.exploitTag, sol.pos) : null) ?? null,
      mesBoard: (sol?.ok === true ? sol.mesBoard : null) ?? null,
      mesEvGainBb: (sol?.ok === true ? sol.mesEvGainBb : null) ?? null,
      mesExact: (sol?.ok === true ? sol.mesExact : null) ?? null,
      bbCents: full.hand?.bbCents ?? null,
      tableSeats: Array.isArray(full.hand?.liveSeats) ? full.hand.liveSeats.length : full.hand?.liveSeats && typeof full.hand.liveSeats === "object" ? Object.keys(full.hand.liveSeats).length : null,
      heroPos: (sol?.ok === true ? sol.pos : null) ?? full.hero?.pos ?? null,
      depth: (sol?.ok === true ? sol.depth : sol?.ok === false ? sol.depth : null) ?? null,
      setId: (sol?.ok === true ? sol.setId : null) ?? null,
      decisionJson: sol?.ok === true && sol.actions ? JSON.stringify(sol.actions) : null,
      line: (sol?.ok === true ? sol.line : sol?.ok === false ? sol.line : null) ?? null,
      solveId: (sol?.ok === true ? sol.solveId : null) ?? null,
      sessionId: full.sessionId ?? null,
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
      // THE EXPORT LAGS THE BUTTONS (2026-09-19). Hero's buttons are up, but the wrapper's hand has not yet got
      // the villain's action that put them there (hand 4919059283, turn: 13 actions facing 0, one tick later 14
      // facing 6.89). The route answers "Not hero's turn." for that tick — not a solve failure. Recording it as
      // one put the panel on "no answer — couldn't solve this spot" for 15 s, right through the real solve that
      // followed: the "answer only came after the time bank" report. So no breadcrumb and no failure row; the
      // next tick re-probes and the corrected key solves. Only a stall on the same stale key (>3 s) is logged.
      if (sol == null && /not hero's turn/i.test(full.deferred ?? "")) {
        const since = this.deferredSince?.key === key ? this.deferredSince.at : Date.now();
        this.deferredSince = { key, at: since };
        if (Date.now() - since < 3000) { await this.push(null); return; }
      }
      this.status.lastNavFailure = { at: Date.now(), street: full.hand?.street ?? null, reason };
      const rf = this.repeatFail;
      this.repeatFail = rf && rf.key === key && rf.reason === reason
        ? { ...rf, n: rf.n + 1 }
        : { key, reason, n: 1 };
      // the fast-solver stamps a machine `kind` on its terminal refusals (capture-fault / no-hero-cards /
      // board-incomplete, fastSolve.ts 2026-09-23); log it when it is one of ours, else classify the sentence
      const kind = sol?.ok === false ? (sol as { kind?: unknown }).kind : undefined;
      answerLog.add({ ...logBase, text: null, pick: null, roll: null, tier: null, warning: null, failReason: reason,
        failKind: isFailKind(kind) ? kind : undefined });
      // Say it on the panel rather than leaving a blank card: this is the last ask for
      // this spot unless something about it changes.
      if (this.repeatFail.n >= this.REPEAT_FAIL_LIMIT) {
        await this.push(null, null, `no answer for this spot after ${this.repeatFail.n} tries — ${reason}`);
      } else {
        await this.push(null); // don't cache the key — retry this same spot next tick
      }
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
      : rollAction(sol.actions, sol.decision.action, this.memoRoll(full, probe));
    const text = approx + buildAnswerText({
      street: full.hand!.street!,
      decision: sol.decision,
      actions: sol.actions,
    }) + (rolled.roll != null ? ` · roll ${rolled.roll} → ${rolled.pick.toUpperCase()}` : "");
    // INTEGRITY: does this answer agree with its OWN evidence? A fault is a bug in
    // the machine (pick and mix from different pieces, or the roll walked wrongly),
    // never a poker judgement — so it is shouted about and counted, but it does NOT
    // withhold the answer: on 2026-09-14 the fault was a CORRECT pick carrying the
    // wrong mix, and refusing it would have cost a right answer mid-hand.
    const faults = checkAnswerIntegrity({ pick: rolled.pick, roll: rolled.roll, actions: sol.actions });
    for (const f of faults) {
      console.error(`[integrity] SEVERE ${f.kind} - ${f.detail} | ${full.hand?.street ?? "?"} ${(full.hero?.cards ?? []).join("")} tier=${sol.tier ?? "?"}`);
    }
    if (faults.length) {
      this.status.integrityFaults += faults.length;
      this.status.lastIntegrityFault = { at: Date.now(), kind: faults[0]!.kind, detail: faults[0]!.detail };
    }

    this.lastSolvedKey = key;
    this.deferredSince = null;
    // An answer means the client is healthy: the wedge signal starts over, key
    // included — otherwise the next failure of this same spot would not read as
    // a new one and the streak could never rebuild.
    this.status.distinctFailureStreak = 0;
    this.lastFailedKey = null;
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
      // the decision this pick was rolled for: the wrapper's pick-to-relay
      // path refuses to act unless the table still matches (launch.py
      // _pick_ready) — a Zone hand moves on, the pick must not
      decisionKey: key,
      handId: full.hand?.handId ?? null,
      band: sol.decision?.band ?? null,
      strategy: sol.strategyMode ?? null,
      source: sol.source ?? null,
      tier: sol.tier ?? null,
      chart: sol.setId ?? null,
      exploitPick: sol.exploitDecision?.action ?? null,
      chartPick: sol.chartDecision?.action ?? null,
      // the line's trust (wrapper _reconciled_line): an uncertain line holds auto-execute
      uncertain: full.hand?.lineUncertain ?? null,
    }, [(sol as { warning?: string | null }).warning ?? null, full.hand?.lineUncertain ?? null, full.hand?.lineNote ?? null]
      .filter((s): s is string => !!s).join(" · ") || null);
  }

  /** POST /api/fast-solver — same body as ingest, no navigation, no navLock. */
  private async fetchFastSolve(): Promise<FastSolveLikeResponse | null> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.config.selfBaseUrl}/fast-solver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          live: { url: this.config.assistiveUrl },
          setId: this.config.setId,
          depth: this.config.depth,
          // the declared strategy decides the preflop piece (no mode flag any more)
          strategyId: this.lastStrategyId ?? undefined,
          origin: "live",
        }),
        // Library lookups return in ~1-2s; the far-snap AI escape can take
        // a cloud solve (~5-30s). Generous, but nothing blocks behind it.
        signal: AbortSignal.timeout(45000),
      });
      const body = (await res.json().catch(() => null)) as FastSolveLikeResponse | null;
      let trace: unknown = null;
      try { const h = res.headers.get("x-answer-trace"); trace = h ? JSON.parse(h) : null; } catch { trace = null; }
      if (!body) {
        this.status.lastError = `Fast-solver returned non-JSON (HTTP ${res.status}).`;
        this.lastFetchFailKind = "solver-bad-response";
        pollerEvent({ url: this.config.assistiveUrl, ms: Date.now() - t0, outcome: "bad-response", http: res.status });
        return null;
      }
      this.lastFetchFailKind = null;
      const b = body as { ok?: boolean; reason?: string; error?: string; hand?: { handId?: unknown; street?: string } | null;
                          solution?: { source?: string; tier?: string; ok?: boolean; reason?: string } | null };
      pollerEvent({ url: this.config.assistiveUrl, ms: Date.now() - t0, outcome: b.ok === false ? "not-ok" : "ok",
                    hand: b.hand?.handId ?? null, street: b.hand?.street ?? null,
                    source: b.solution?.source ?? null, tier: b.solution?.tier ?? null,
                    reason: (b.reason ?? b.error ?? b.solution?.reason ?? null)?.toString().slice(0, 300) ?? null, trace });
      return body;
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      pollerEvent({ url: this.config.assistiveUrl, ms: Date.now() - t0, outcome: "threw",
                    error: `${e instanceof Error ? e.name + ": " + e.message : String(e)}`.slice(0, 400) });
      // a deadline and a refused connection are different problems with the
      // same symptom (no answer) — tell them apart in the log
      this.lastFetchFailKind = e instanceof Error && /timeout|abort|deadline/i.test(e.name + e.message)
        ? "solver-timeout" : "solver-unreachable";
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
      body.httpStatus = res.status;
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

  /** consecutive failed (non-idle) ingest probes and the moment the next tick may run (EIP-19) */
  private ingestFailures = 0;
  private skipTicksUntil = 0;
  /**
   * ONE ROLL PER DECISION, ACROSS RE-SOLVES (EIP-03 / EIP-04, 2026-09-23). The keep-alive repeats the pick, but
   * the poller RE-SOLVES the same decision whenever the key changes without an action — toCall flickers between
   * the ws and reconciler ledgers (4919260243: 1.5 -> 2 with picks Call / Raise 9 / Call), and any one-tick
   * transient (an ingest 5xx, a CDP blip, a buttons repaint) nulls lastSolvedKey. Each re-solve drew a fresh
   * Math.random(), so a mixed spot could flip its headline pick under hero (13 decisions in 9 archived hands
   * showed two different picks live). The roll is now remembered per (hand, street, action count, hero cards)
   * for 90 s and handed back to rollAction on a re-solve.
   */
  private rollMemo = new Map<string, { roll: number; at: number }>();
  private memoRoll(full: FastSolveLikeResponse | null | undefined, probe: IngestLikeResponse): number | undefined {
    const h = (full?.hand ?? {}) as { handId?: number | null; clientHandId?: string | null; street?: string | null; actions?: unknown[] };
    const key = JSON.stringify([h.clientHandId ?? h.handId ?? null, h.street ?? probe.hand?.street ?? null,
      (h.actions ?? probe.hand?.actions ?? []).length, (full?.hero?.cards ?? probe.hero?.cards ?? []).join("")]);
    const now = Date.now();
    for (const [k, v] of this.rollMemo) if (now - v.at > 90_000) this.rollMemo.delete(k);
    const hit = this.rollMemo.get(key);
    if (hit) return hit.roll;
    const roll = 1 + Math.floor(Math.random() * 100);
    this.rollMemo.set(key, { roll, at: now });
    return roll;
  }
  /** The rolled pick for the current answer, repeated verbatim by the
   *  keep-alive so the sampled action never re-rolls mid-decision. */
  private lastExtra: { pick: string; roll: number | null; decisionKey?: string | null; handId?: number | null;
                       band?: [number, number] | null;
                       strategy?: string | null; source?: string | null; tier?: string | null;
                       chart?: string | null; exploitPick?: string | null; chartPick?: string | null;
                       uncertain?: string | null } | null = null;
  /** The solve's caveat (snapped sizes, generic ranges) for the current
   *  answer — repeated by the keep-alive alongside it. */
  private lastNote: string | null = null;

  /** The in-flight background solve, if any. Never aborted mid-flight (the
   *  server-side navigation can't be cancelled and holds the navLock); a new
   *  spot simply waits for the next tick after this one completes. */
  private nav: { key: string; at: number } | null = null;
  /** decision keys already written as "seen" / "waiting" (poller-events.jsonl): once per key, not once per tick */
  private seenKeys = new Set<string>();
  private waitLogged = new Set<string>();
  /** decisionKey of the most recent probe — verdicts for any other key are
   *  stale and get dropped instead of pushed. */
  private lastProbeKey: string | null = null;
  /** the first tick the fast-solver said "not hero's turn" for the current key — see solveSpot */
  private deferredSince: { key: string; at: number } | null = null;
  /** the first tick hero's buttons were up while the export said not-to-act — see tick() */
  private buttonsUpSince: { key: string; at: number } | null = null;
  private lastFetchFailKind: FailKind | null = null;
  /** `${decisionKey}|${kind}` already written — the tick loop revisits the same
   *  dead spot every few seconds and must not write a row each time. */
  private noAnswerLogged = new Set<string>();

  /**
   * Record a decision that got no answer for a reason the SOLVE never spoke to:
   * the request failed, the verdict came too late, the client was down. One row
   * per decision per kind, with whatever attribution is available — a probe
   * carries no hand id, so services/answerReconciler.ts attaches those to their
   * hand once it is archived.
   */
  private logNoAnswer(key: string, probe: IngestLikeResponse, kind: FailKind, reason: string, latencyMs: number | null, full?: FastSolveLikeResponse): void {
    const tag = `${key}|${kind}`;
    if (this.noAnswerLogged.has(tag)) return;
    if (this.noAnswerLogged.size > 500) this.noAnswerLogged.clear();
    this.noAnswerLogged.add(tag);
    this.status.lastNavFailure = { at: Date.now(), street: probe.hand?.street ?? null, reason };
    this.noteWedgeSignal(key, kind);
    answerLog.add({
      ts: Date.now(),
      wrapperHandId: full?.hand?.handId ?? null,
      clientHandId: full?.hand?.clientHandId ?? null,
      street: full?.hand?.street ?? probe.hand?.street ?? null,
      board: (full?.hand?.board ?? probe.hand?.board ?? []).join("") || null,
      heroCards: (full?.hero?.cards ?? probe.hero?.cards ?? []).join("") || null,
      decisionKey: key,
      text: null, pick: null, roll: null, tier: null, warning: null,
      latencyMs, failReason: reason, failKind: kind,
      sessionId: full?.sessionId ?? null,
    });
  }

  /**
   * THE WEDGED-BUT-CONNECTED CASE, which until 2026-09-19 was only a comment.
   *
   * `isConnected()` asks the debug port for its target list. A GTO Wizard that
   * has been up for hours answers that happily while every solve through it
   * fails — the port is alive, the page is not. So the "is it up?" check at the
   * top of the tick loop sees nothing wrong and never relaunches, and the only
   * recovery is the client happening to drop the port altogether.
   *
   * `distinctFailureStreak` and `lastFailedKey` were declared and reset for
   * exactly this, and `ensureGtoWizardLaunching(force)` was written to act on
   * it — but nothing ever incremented the counter or passed `force`, so the
   * whole path was unreachable. It cost the answers tier 14 of 15 fixtures on
   * 2026-09-19 (~91 s each, every one blaming the cloud), and it recovered only
   * when the port finally went down of its own accord and the ORDINARY relaunch
   * fired. In a live session that is fourteen spots answered with a blank card.
   *
   * Only kinds that mean "the chain failed to produce anything" count. A solver
   * that answers "not in range" or "off tree" is working correctly and says
   * nothing about the client's health; nor does hero having already acted.
   * DISTINCT decisions only — the tick loop revisits one dead spot for as long
   * as hero sits there, and that is one failure, not thirty.
   */
  private noteWedgeSignal(key: string, kind: FailKind): void {
    if (kind !== "solver-unreachable" && kind !== "solver-timeout" && kind !== "solver-bad-response") return;
    if (key === this.lastFailedKey) return;
    this.lastFailedKey = key;
    this.status.distinctFailureStreak += 1;
    if (this.status.distinctFailureStreak < this.WEDGE_STREAK) return;
    console.error(`[poller] ${this.status.distinctFailureStreak} distinct decisions failed in the solve chain `
      + `while GTO Wizard reported connected — forcing a relaunch (last: ${kind})`);
    this.status.distinctFailureStreak = 0;
    this.lastFailedKey = null;
    this.ensureGtoWizardLaunching(true);
  }

  private async push(
    text: string | null,
    extra?: { pick: string; roll: number | null; decisionKey?: string | null; handId?: number | null;
              band?: [number, number] | null;
              strategy?: string | null; source?: string | null; tier?: string | null;
              chart?: string | null; exploitPick?: string | null; chartPick?: string | null;
              uncertain?: string | null } | null,
    note?: string | null,
  ): Promise<void> {
    this.status.lastAnswer = text;
    this.lastExtra = text ? (extra ?? this.lastExtra) : null;
    // AN EXPLICIT NOTE SURVIVES A NULL ANSWER (2026-09-19). This used to clear the note
    // whenever the answer was cleared, which is right for a stale caveat — but it also
    // silenced the one case where there is nothing BUT a note to show: a spot that has
    // been asked its limit of times and will not be asked again. The panel was left with
    // a blank card and no way to know that nothing more was coming.
    this.lastNote = note !== undefined ? note : (text ? this.lastNote : null);
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
          decisionKey: this.lastExtra?.decisionKey ?? null,
          handId: this.lastExtra?.handId ?? null,
          band: this.lastExtra?.band ?? null,
          strategy: this.lastExtra?.strategy ?? null,
          source: this.lastExtra?.source ?? null,
          tier: this.lastExtra?.tier ?? null,
          chart: this.lastExtra?.chart ?? null,
          exploitPick: this.lastExtra?.exploitPick ?? null,
          chartPick: this.lastExtra?.chartPick ?? null,
          uncertain: this.lastExtra?.uncertain ?? null,
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

/**
 * ONE POLLER PER TABLE (2026-09-19). Ignition allows four tables at once, and four
 * tables are four wrapper processes on four panel ports — so the poller stops being a
 * singleton and becomes a set keyed by the wrapper it answers for.
 *
 * Keyed by URL on purpose: the hazard this replaces is two pollers on the SAME wrapper,
 * which double-answers every decision and — because rollAction samples the mix — can
 * roll two different actions for one spot (see start()). A map keyed by assistiveUrl
 * cannot express that, whereas a list could. Different wrappers are the opposite case:
 * they are different tables, and each needs its own answer.
 *
 * Solving does not serialize behind this. gtowApi talks to GTO Wizard over HTTP with
 * in-flight coalescing by content key, so four tables solve in parallel and share one
 * cache and one token.
 */
/**
 * ONE POLLER PER WRAPPER, AND SPELLING IS NOT IDENTITY (2026-09-20).
 *
 * The set is keyed by assistiveUrl, and it used to key on the raw string. The API
 * starts a poller at boot with no config (index.ts), which defaults to
 * DEFAULT_LIVE_URL = "http://localhost:7700"; the wrapper's own chain keeper then
 * registers itself as "http://127.0.0.1:7700" (launch.py `public`). Same wrapper,
 * two keys, two StudyPoller instances — each with its own single-flight guard, so
 * neither could see the other. Both solved EVERY decision, both rolled the mix
 * independently with Math.random(), and both POSTed to /panel/answer: the panel
 * showed whichever landed last, so the pick flickered and the relay's action was a
 * coin flip between two rolls. Measured on the 2026-09-19 session: every hand from
 * 20:47 to 21:12 doubled, 2-400ms apart, six of them landing on different actions
 * (hand 20 FOLD/CALL 4.6, hand 21 Raise 23/Call). Pure spots hid it — two rolls
 * against "Fold 100%" agree.
 *
 * So the key is normalised. localhost / 127.0.0.1 / [::1] are the same wrapper here
 * by construction: launch.py binds loopback and PANEL_PUBLIC_URL is only ever a
 * loopback address or an SSH-tunnel end that is also loopback.
 */
const normUrl = (url: string): string => {
  let u = String(url ?? "").trim().replace(/\/+$/, "");
  try {
    const p = new URL(u);
    const host = p.hostname.toLowerCase();
    p.hostname = host === "localhost" || host === "::1" || host === "[::1]" ? "127.0.0.1" : host;
    p.protocol = p.protocol.toLowerCase();
    u = p.origin + (p.pathname === "/" ? "" : p.pathname);
  } catch {
    u = u.toLowerCase();                 // not a URL we can parse — at least fold case
  }
  return u;
};

class StudyPollerSet {
  private byUrl = new Map<string, StudyPoller>();
  private order: string[] = [];

  private ensure(url: string): StudyPoller {
    let p = this.byUrl.get(url);
    if (!p) {
      p = new StudyPoller();
      this.byUrl.set(url, p);
      this.order.push(url);
    }
    return p;
  }

  start(config: StudyPollerConfig = {}): StudyPollerStatus {
    // Normalised BEFORE the lookup and passed on normalised, so the poller's own
    // same-target check (start() is called every 20s by the wrapper's keeper)
    // compares like with like too.
    const url = normUrl(config.assistiveUrl ?? DEFAULT_LIVE_URL);
    return this.ensure(url).start({ ...config, assistiveUrl: url });
  }

  /**
   * Stop one wrapper's poller, or every one of them. A stopped poller LEAVES the set:
   * the set means "tables being answered right now", which is what the overview strip
   * and `running` are asking. Keeping dead entries would have a table you closed an
   * hour ago still listed, and its stale status counted.
   */
  async stop(url?: string): Promise<StudyPollerStatus> {
    const urls = url ? [normUrl(url)] : [...this.order];
    for (const u of urls) {
      const p = this.byUrl.get(u);
      if (p) await p.stop();
      this.byUrl.delete(u);
      this.order = this.order.filter((x) => x !== u);
    }
    return this.status();
  }

  /**
   * Never started, and never in the set: what the flat status looks like with no tables
   * open. READING MUST NOT CREATE. primary() used to ensure() a default entry, so any
   * caller asking "is the chain live" conjured a table into the registry and the
   * overview listed a wrapper nobody had started.
   */
  private readonly idle = new StudyPoller();

  /** The first poller started, or the idle stand-in — whose flat status old callers read. */
  primary(): StudyPoller {
    const first = this.order[0];
    return (first ? this.byUrl.get(first) : undefined) ?? this.idle;
  }

  get(url: string): StudyPoller | null {
    return this.byUrl.get(url) ?? null;
  }

  list(): { assistiveUrl: string; status: StudyPollerStatus }[] {
    return this.order.map((u) => ({ assistiveUrl: u, status: this.byUrl.get(u)!.getStatus() }));
  }

  /**
   * The flat status the panel and the Sources registry have always read, plus every
   * poller under `pollers`. `running` is true when ANY table is being answered — the
   * question those callers are actually asking is "is the answer chain live", and with
   * four tables the first one's timer is a worse answer to it than the set's.
   */
  status(): StudyPollerStatus & { pollers: { assistiveUrl: string; status: StudyPollerStatus }[] } {
    const all = this.list();
    const primary = this.primary().getStatus();
    return { ...primary, running: all.some((p) => p.status.running) || primary.running, pollers: all };
  }
}

export const studyPollers = new StudyPollerSet();

/**
 * The single-table façade every existing caller uses. Kept so routes, the Sources
 * registry and the tests did not all have to learn about the set on the same day.
 */
export const studyPoller = {
  start: (config: StudyPollerConfig = {}) => studyPollers.start(config),
  stop: () => studyPollers.stop(),
  getStatus: () => studyPollers.status(),
  get strategyId(): string | null {
    return studyPollers.primary().strategyId;
  },
};
