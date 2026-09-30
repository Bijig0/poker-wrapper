import { Hono } from "hono";
import { renderPanelRows, type PanelRow } from "../feed/parsePanelFeed/parsePanelFeed";
import { handToSpot, type SpotOptions } from "../feed/handToSpot/handToSpot";
import { SOLUTION_SETS } from "../services/gtowCdp";
import { resolveHand } from "../feed/resolveHand/resolveHand";
import { warmPreflop6max, warmPostflop6max } from "../services/fastSolve";

/**
 * Feed ingestion: turn a hand — the live one from the wrapper's /state, a panel-feed rows payload, the same lines
 * pasted as plain text, or a Hand-shaped JSON object entered directly — into the parsed hand + spot the study poller
 * probes once a second. PARSE ONLY: the GTO Wizard page-navigation path this route used to offer (navigate:true, the
 * URL-first line loader, the local preflop lookup, navLock) had no caller left — answers come from /fast-solver —
 * and was removed on 2026-09-25 (~270 lines, plus services/navLock.ts).
 */
const app = new Hono();


/**
 * Say WHY a resolve failed. Until 2026-09-21 this path was silent: api.log
 * carried only "POST /api/ingest 502 1ms", and the study poller read the body
 * as "Study Answers is off" (see services/studyPoller.ts), so a wrapper that
 * had gone away looked exactly like an idle one. A dead :7700 went unnoticed
 * for ~14h that way, and — because the poller ticks once a second — billed
 * 317k access-log lines doing it.
 *
 * Which is also why this is throttled rather than a bare console.warn: the
 * first occurrence of each distinct reason prints immediately, identical
 * repeats fold into one line every 5 minutes, and a recovery prints once.
 *
 * 409 is exempt — "assistive-play is running but no table is detected" is the
 * DESIGNED idle reply between sessions (148k of them in this log), not a fault.
 * studyPoller.ts exempts exactly the same status, and the two must agree: a
 * status one of them treats as idle and the other as broken is the bug this
 * whole change exists to remove. (422 never reaches here — it is an ok:false
 * the route returns after resolveHand has already succeeded with hand: null.)
 */
const RESOLVE_FAIL_REPEAT_MS = 5 * 60_000;
const IDLE_STATUSES = new Set([409]);
let lastResolveFail: { key: string; at: number; suppressed: number } | null = null;

function logResolveFailure(status: number, error: string): void {
  // Reaching an idle status proves the wrapper ANSWERED, so it also ends any
  // run of real failures — otherwise a wrapper that came back and then sat
  // table-less for hours would hold the "recovered" line until the next hand.
  if (IDLE_STATUSES.has(status)) return noteResolveOk();
  const key = `${status}: ${error}`;
  const now = Date.now();
  if (lastResolveFail?.key === key) {
    lastResolveFail.suppressed++;
    if (now - lastResolveFail.at < RESOLVE_FAIL_REPEAT_MS) return;
    console.warn(`[ingest] still failing — ${key} (${lastResolveFail.suppressed} more since the last line)`);
    lastResolveFail = { key, at: now, suppressed: 0 };
    return;
  }
  console.warn(`[ingest] ${key}`);
  lastResolveFail = { key, at: now, suppressed: 0 };
}

/** First success after a run of failures — closes the story in the log. */
function noteResolveOk(): void {
  if (!lastResolveFail) return;
  const { key, suppressed } = lastResolveFail;
  lastResolveFail = null;
  console.warn(`[ingest] recovered after ${suppressed + 1} failure(s) — last was ${key}`);
}

interface IngestBody {
  /** Panel-feed rows, either the envelope { ok, rows } or the bare array. */
  rows?: PanelRow[] | { ok?: boolean; rows: PanelRow[] };
  /** Manual hand history: the same lines as plain text, one per line. */
  text?: string;
  /** A Hand-shaped JSON object (the /state shape), entered directly. */
  hand?: unknown;
  /** Pull the structured Hand straight from the assistive-play server. */
  live?: boolean | { url?: string; table?: string };
  setId?: string;
  depth?: number;
  heroPos?: string;
}

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as IngestBody;
  const set = SOLUTION_SETS.find((s) => s.id === (body.setId ?? "6max"));
  const opts: SpotOptions = {
    setId: body.setId,
    depth: body.depth,
    heroPos: body.heroPos,
    // snap stack-derived depths to what the chosen library actually has
    availableDepths: set?.depths,
  };

  // --- 1) resolve a hand from one of the four sources ------------------------
  // (shared with /fast-solver — see feed/resolveHand)
  const resolved = await resolveHand(body);
  if (!resolved.ok) {
    logResolveFailure(resolved.status, resolved.error);
    return c.json({ ok: false, error: resolved.error }, resolved.status as 400 | 409 | 502);
  }
  noteResolveOk();
  const { hand, source, warnings, tableStatus, heroSittingOut, studyAnswersOn, strategyId, sessionId, liveExtras, solveRequest } = resolved;

  // the tree this hand will need is opened now, not at hero's turn (fastSolve.warmPreflop6max)
  if (hand) {
    try { warmPreflop6max(hand, body.heroPos ?? hand.positions[hand.heroSeatId] ?? null, strategyId); } catch { /* never the ingest's problem */ }
    // and each postflop street's cloud tree the moment its card lands (fastSolve.warmPostflop6max)
    try { warmPostflop6max(hand, body.heroPos ?? hand.positions[hand.heroSeatId] ?? null, strategyId); } catch { /* ditto */ }
  }

  if (!hand) {
    return c.json(
      {
        ok: false,
        error: heroSittingOut
          ? "Hero is sitting out (wait-for-BB / post pill showing) — no turns until he's dealt in."
          : "No hand in the feed (waiting for the next deal).",
        tableStatus,
        heroSittingOut,
        // The study poller keys its idle/active branch on this — omitting it
        // here made "between hands" indistinguishable from "toggle off", so
        // the poller never refreshed its GTO Wizard health flag while idle.
        studyAnswersOn,
        strategyId,
        solveRequest: solveRequest ?? null,
        warnings,
      },
      422
    );
  }

  // --- 2) map the hand onto the node-navigation contract ---------------------
  // A sitting-out hero (wait-for-BB / post pills) has no decisions to solve,
  // whatever a lingering hand object says.
  const outcome = heroSittingOut
    ? {
        ok: false as const,
        reason: "Hero is sitting out — waiting for the big blind or to post; no turns until he's dealt in.",
      }
    : handToSpot(hand, opts);

  // Hero's journey summary — the research subject's position, whether he's
  // still in the hand, and his actions so far.
  const heroPost = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  const heroPos =
    body.heroPos ??
    hand.positions[hand.heroSeatId] ??
    (heroPost ? (heroPost.type === "post-sb" ? "SB" : "BB") : null);
  const heroFolded = hand.actions.some((a) => a.hero && a.type === "fold");

  const base = {
    ok: true as const,
    source,
    warnings,
    tableStatus,
    studyAnswersOn,
    strategyId,
    // the panel's Solve press for the decision on screen (on-demand strategies — services/studyPoller.ts)
    solveRequest: solveRequest ?? null,
    sessionId: sessionId ?? null,
    // round-trip proof surfaced to the caller: the hand re-rendered as rows
    rerendered: renderPanelRows(hand),
    hero: {
      pos: heroPos,
      cards: hand.heroCards,
      folded: heroFolded,
      sittingOut: heroSittingOut,
      actions: hand.actions.filter((a) => a.hero),
      // a sitting-out hero can't have a live turn, whatever the stale hand says
      toAct: !heroSittingOut && !hand.ended && hand.currentNode.toActIsHero,
      // state provenance (wrapper /hand, 2026-09-19): the poller says WHY it did
      // not ask instead of staying silent when the buttons are up
      buttonsUp: liveExtras?.buttonsUp ?? null,
      toActSources: liveExtras?.toActSources ?? null,
      status: liveExtras?.heroStatus ?? null,
      notToActWhy: liveExtras?.notToActWhy ?? null,
    },
    hand: {
      // WHO THIS HAND IS (EIP-16, 2026-09-23). The poller's 1 Hz probe is THIS route, and
      // its no-answer rows (gtow-down, not-to-act-live, unreachable) are written from this
      // envelope alone — which carried no ids, so all 107 gtow-down and 20 not-to-act-live
      // rows in answers.sqlite have client_hand_id NULL and the reconciler has to guess the
      // hand by hero cards + a ±60 s window (wrong when the same cards recur or two tables
      // are live). Same fields as /fast-solver's projection, same order.
      handId: hand.handId,
      clientHandId: hand.clientHandId ?? null,
      tableSlot: hand.tableSlot ?? null,
      bbCents: hand.bbCents ?? null,
      liveSeats: hand.liveSeats,
      sessionId: sessionId ?? null,
      heroCards: hand.heroCards,
      board: hand.board,
      street: hand.street,
      positions: hand.positions,
      actions: hand.actions,
      ended: hand.ended,
      node: hand.currentNode,
      result: hand.result ?? null,
      lineSource: liveExtras?.lineSource ?? null,
      lineUncertain: liveExtras?.lineUncertain ?? null,
      lineNote: liveExtras?.lineNote ?? null,
    },
  };

  const spot = outcome.ok ? outcome.spot : null;
  const notes = outcome.ok ? outcome.notes : [];

  return c.json({ ...base, spot, notes, deferred: outcome.ok ? undefined : outcome.reason, navigation: null });
});

export default app;
