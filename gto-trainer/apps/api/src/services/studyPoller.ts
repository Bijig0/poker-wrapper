import { DEFAULT_LIVE_URL } from "../routes/ingest";
import { buildAnswerText, type AnswerAction } from "../feed/buildAnswerText/buildAnswerText";
import { gtowCdp } from "./gtowCdp";

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
  /** Consecutive DIFFERENT decisions that have all failed to navigate — the
   *  wedge signal (see ensureGtoWizardLaunching). Resets on any success. */
  distinctFailureStreak: number;
}

interface IngestLikeResponse {
  ok?: boolean;
  hero?: { toAct?: boolean; cards?: string[] };
  hand?: { street?: string; board?: string[]; actions?: unknown[]; node?: { toCall?: number } };
  // assistive-play's own local "Study Answers" toggle, forwarded by /api/ingest
  // for the live source — the single gate: this poller runs continuously, but
  // only actually pushes an answer while the panel's own switch is on.
  studyAnswersOn?: boolean | null;
  navigation?: {
    ok?: boolean;
    /** True when the failure is the SPOT being off-tree/unsolvable — a fact
     *  about the hand, not about GTO Wizard's health. Must not feed the
     *  wedge detector, or play-money tables full of odd sizes would trigger
     *  pointless GTO Wizard relaunches mid-session. */
    offTree?: boolean;
    /** The answer came from a snapped/translated line or a fast solve. */
    approx?: boolean;
    response?: {
      decision?: { action: string; frequency?: number } | null;
      actions?: AnswerAction[];
    } | null;
  } | null;
}

const DEFAULT_SELF_BASE_URL = "http://localhost:2000/api";
const DEFAULT_INTERVAL_MS = 1000;

/** A decision's identity — a new key means a new spot worth navigating to.
 *  Mirrors the dashboard's own spotKey/lastNavKey fallback formula. */
const decisionKey = (r: IngestLikeResponse): string =>
  JSON.stringify([r.hand?.street, r.hand?.board, r.hero?.cards, r.hand?.node?.toCall, (r.hand?.actions ?? []).length]);

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
    distinctFailureStreak: 0,
  };
  private lastLaunchAttempt = 0;
  private readonly LAUNCH_COOLDOWN_MS = 30_000;
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
  // Warm-the-walk state: the board we last pre-solved prior streets for. The
  // board string identifies both the hand and the street (it grows per street),
  // so one key covers "new street" and "new hand" invalidation together.
  private lastWarmKey: string | null = null;
  private warmInFlight = false;

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
    return { ...this.status };
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

      if (probe.studyAnswersOn !== true) {
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
        await this.push(null);
        return;
      }

      // Villains are acting (or hero just isn't up yet) — dead time. Pre-pay
      // the exploit walk's prior-street solves now, so a deep-line decision
      // later only costs hero's own node (see exploitLine.warmExploitLine).
      // Skipped while hero is to act: the real solve is imminent, and a
      // concurrent warm of the same tree would double-mint cloud solves.
      if (probe.ok === true && probe.hero?.toAct !== true) this.maybeWarm(probe);

      const eligible = probe.ok === true && probe.hero?.toAct === true && probe.hand?.street != null;
      this.status.lastError = null;
      if (!eligible) {
        this.lastSolvedKey = null; // stale — a future recurrence must re-navigate fresh
        await this.push(null);
        return;
      }

      const key = decisionKey(probe);
      if (key === this.lastSolvedKey) {
        // Already navigated GTO Wizard here and it's already showing the
        // right answer — don't reload the same page again every tick.
        return;
      }

      const full = await this.fetchIngest(true);
      if (!full) return;
      const decision = full.navigation?.response?.decision;
      this.status.lastError = null;
      if (!(full.navigation?.ok === true && decision != null)) {
        // An off-tree spot is a fact about the HAND (the repair loop already
        // tried) — never a wedge signal. Counting it would relaunch GTO
        // Wizard for no reason on tables full of odd sizes.
        if (full.navigation?.offTree === true) {
          await this.push(null);
          return;
        }
        // Only count this as a wedge signal if it's a DIFFERENT decision than
        // the last failure — the same spot failing repeatedly just means
        // it's genuinely unsolved (or hero's still deliberating), not wedged.
        if (key !== this.lastFailedKey) {
          this.lastFailedKey = key;
          this.status.distinctFailureStreak++;
        }
        if (this.status.distinctFailureStreak >= this.WEDGE_THRESHOLD) {
          this.status.distinctFailureStreak = 0;
          this.lastFailedKey = null;
          this.ensureGtoWizardLaunching(true);
        }
        await this.push(null); // don't cache the key — retry this same spot next tick
        return;
      }
      // "≈" — the verdict came from a snapped (nearest-tree-size) line or a
      // fresh fast solve, not the exact sizes played. Honest, and short
      // enough for the large-print panel.
      const approx = full.navigation?.approx === true ? "≈ " : "";
      const text = approx + buildAnswerText({
        street: full.hand!.street!,
        decision,
        actions: full.navigation!.response!.actions,
      });
      this.lastSolvedKey = key;
      this.lastFailedKey = null;
      this.status.distinctFailureStreak = 0;
      await this.push(text);
    } finally {
      this.inFlight = false;
    }
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
    gtowCdp.launchApp(force ? { force: true } : undefined).catch((e) => {
      this.status.lastError = e instanceof Error ? e.message : String(e);
    });
  }

  /** POSTs to gto-trainer's own /api/ingest; returns null (and records the
   *  error + clears the panel) on any failure, so callers can bail cleanly. */
  /**
   * Fire-and-forget warm of the live line's completed streets, at most once
   * per board (= per street per hand). Only turn/river have a completed
   * postflop street behind them; on the flop the walk is empty, so warming
   * would solve nothing. Failures are ignored — a warm miss just means the
   * real solve pays what it always used to.
   */
  private maybeWarm(probe: IngestLikeResponse): void {
    const street = probe.hand?.street;
    if (street !== "turn" && street !== "river") return;
    const key = (probe.hand?.board ?? []).join("");
    if (!key || key === this.lastWarmKey || this.warmInFlight) return;
    this.warmInFlight = true;
    fetch(`${this.config.selfBaseUrl}/ai-solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ live: { url: this.config.assistiveUrl }, warm: true }),
      signal: AbortSignal.timeout(25_000),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { ok?: boolean; warmed?: boolean } | null;
        // Only a served warm pins the key — a failed one should retry next tick.
        if (body?.ok === true && body.warmed === true) this.lastWarmKey = key;
      })
      .catch(() => {})
      .finally(() => {
        this.warmInFlight = false;
      });
  }

  private async fetchIngest(navigate: boolean): Promise<IngestLikeResponse | null> {
    try {
      const res = await fetch(`${this.config.selfBaseUrl}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          live: { url: this.config.assistiveUrl },
          navigate,
          setId: this.config.setId,
          depth: this.config.depth,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json().catch(() => null)) as IngestLikeResponse | null;
      if (!body) {
        this.status.lastError = `Ingest returned non-JSON (HTTP ${res.status}).`;
        await this.push(null);
        return null;
      }
      return body;
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      await this.push(null);
      return null;
    }
  }

  private async push(text: string | null): Promise<void> {
    this.status.lastAnswer = text;
    try {
      await fetch(`${this.config.assistiveUrl}/panel/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(3000),
      });
      this.status.lastPushAt = Date.now();
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
    }
  }
}

export const studyPoller = new StudyPoller();
