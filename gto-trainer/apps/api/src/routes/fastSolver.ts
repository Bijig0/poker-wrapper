import { Hono } from "hono";
import { resolveHand, type ResolveBody } from "../feed/resolveHand/resolveHand";
import { handToSpot, type SpotOptions } from "../feed/handToSpot/handToSpot";
import { renderPanelRows } from "../feed/parsePanelFeed/parsePanelFeed";
import { fastSolve } from "../services/fastSolve";
import { SOLUTION_SETS } from "../services/gtowCdp";
import { runTraced, timed, tmark } from "../services/answerTrace";

/**
 * Fast-solver: the same hand-node input as /ingest, answered without any live
 * GTO Wizard DOM navigation. Preflop comes from the local crawled charts
 * (services/preflopDb) and postflop from GTO Wizard's spot-solution API
 * (services/gtowApi) — charts in, solution out.
 *
 * Accepts the identical body as /ingest: { hand | live | rows | text, setId?,
 * depth?, heroPos? }. Postflop is heads-up only (that's all GTOW's library
 * holds).
 */
const app = new Hono();

interface FastSolverBody extends ResolveBody {
  setId?: string;
  depth?: number;
  heroPos?: string;
  /** The DECLARED strategy (services/strategies.ts id). It alone decides which
   *  preflop piece answers. Omitted = the one the live session declared. */
  strategyId?: string | null;
  /** Low-level override of the preflop piece, for callers with no declared
   *  strategy (the playthrough tester, offline sweeps). */
  strategy?: "exploit" | "chart";
}

// Every request carries its own timeline (services/answerTrace.ts) back in X-Answer-Trace — where an answer's
// time went: the wrapper read, chart nodes, token sniffs, each GTO Wizard request.
app.post("/", async (c) => {
  const { value: res, totalMs, trace } = await runTraced(() => handleFastSolve(c));
  // A SLOW ANSWER WRITES ITS OWN TIMELINE TO THE LOG (2026-09-24): the header below has a size budget and the
  // poller may never read it, so an answer over 10 s prints every event with a gap or span of 300 ms or more.
  if (totalMs > 10_000) {
    let prev = 0;
    const slow = trace.filter((e) => { const at = e.at ?? 0, ms = e.ms ?? 0; const gap = at - prev; prev = Math.max(prev, at + ms); return ms >= 300 || gap >= 300; });
    console.log(`[slow-answer] ${totalMs} ms — ${slow.map((e) => `@${e.at}${e.ms ? `+${e.ms}` : ""} ${e.ev}${e.info ? ` (${e.info.slice(0, 90)})` : ""}`).join(" | ")}`);
  }
  // The header has a budget; a JSON string cut mid-way is no trace at all (the poller's parse fails and the
  // whole timeline is lost). Over budget, shorten each event's prose first, then drop trailing events, and say
  // how many were dropped — the [chain] line in the API log carries the full text regardless.
  try {
    const LIMIT = 7500;
    let evs = trace;
    let body = JSON.stringify({ totalMs, trace: evs });
    if (body.length > LIMIT) {
      evs = evs.map((e) => (e.info && e.info.length > 80 ? { ...e, info: `${e.info.slice(0, 77)}...` } : e));
      body = JSON.stringify({ totalMs, trace: evs });
    }
    while (body.length > LIMIT && evs.length) {
      evs = evs.slice(0, -1);
      body = JSON.stringify({ totalMs, trace: evs, dropped: trace.length - evs.length });
    }
    res.headers.set("X-Answer-Trace", body);
  } catch { /* immutable headers: no trace */ }
  return res;
});

async function handleFastSolve(c: any): Promise<Response> {
  const body = (await c.req.json().catch(() => ({}))) as FastSolverBody;
  const set = SOLUTION_SETS.find((s) => s.id === (body.setId ?? "6max"));

  const resolved = await timed("resolve hand (wrapper /state)", () => resolveHand(body), (r) => (r.ok ? "ok" : `failed: ${r.error}`));
  if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status as 400 | 409 | 502);
  tmark("hand", `${resolved.hand?.currentNode?.street ?? "?"} · ${(resolved.hand?.actions ?? []).length} actions · toActIsHero=${resolved.hand?.currentNode?.toActIsHero}`);
  const { hand, source, warnings, tableStatus, heroSittingOut, studyAnswersOn, strategyId, sessionId, liveExtras } = resolved;

  if (!hand) {
    return c.json(
      {
        ok: false,
        error: heroSittingOut
          ? "Hero is sitting out — no turns until he's dealt in."
          : "No hand in the feed (waiting for the next deal).",
        tableStatus,
        heroSittingOut,
        warnings,
      },
      422
    );
  }

  const opts: SpotOptions = { setId: body.setId, depth: body.depth, heroPos: body.heroPos, availableDepths: set?.depths };
  const spotOutcome = heroSittingOut
    ? { ok: false as const, reason: "Hero is sitting out." }
    : handToSpot(hand, opts);

  const heroPost = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  const heroPos =
    body.heroPos ??
    hand.positions[hand.heroSeatId] ??
    (heroPost ? (heroPost.type === "post-sb" ? "SB" : "BB") : null);
  const heroFolded = hand.actions.some((a) => a.hero && a.type === "fold");
  const heroTurn = !heroSittingOut && !hand.ended && hand.currentNode.toActIsHero;

  const base = {
    ok: true as const,
    source,
    warnings,
    tableStatus,
    studyAnswersOn,
    sessionId: sessionId ?? null,
    rerendered: renderPanelRows(hand),
    hero: {
      pos: heroPos,
      cards: hand.heroCards,
      folded: heroFolded,
      sittingOut: heroSittingOut,
      toAct: heroTurn,
      buttonsUp: liveExtras?.buttonsUp ?? null,
      notToActWhy: liveExtras?.notToActWhy ?? null,
    },
    hand: {
      handId: hand.handId,
      clientHandId: hand.clientHandId ?? null,
      // WHICH TABLE / WHAT STAKE / HOW MANY SEATS (EIP-08, PF-12, 2026-09-23). The wrapper
      // stamps these on /hand and normalizeHand keeps them, but this projection was built by
      // hand and dropped them — so answers.sqlite had table_slot, bb_cents and table_seats
      // NULL in every one of its 4,287 rows (incl. the two-table sessions 20260921_143046 /
      // 20260922_194118), and strategyIdForAnswer could never attribute by stake or seats.
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
      // which betting line the wrapper exported and whether it can be trusted
      // (the level reconciler cut-over, launch.py _reconciled_line)
      lineSource: liveExtras?.lineSource ?? null,
      lineUncertain: liveExtras?.lineUncertain ?? null,
      lineNote: liveExtras?.lineNote ?? null,
    },
    spot: spotOutcome.ok ? spotOutcome.spot : null,
    notes: spotOutcome.ok ? spotOutcome.notes : [],
  };

  if (!heroTurn) {
    return c.json({ ...base, solution: null, deferred: hand.ended ? "Hand is over." : "Not hero's turn." });
  }

  const solution = await timed("fastSolve", () => fastSolve(hand, heroPos, {
    setId: body.setId, depth: body.depth, heroPos,
    // who asked — stamped on every stored AI-chain trace (services/solveStore.ts)
    ...(typeof (body as { origin?: unknown }).origin === "string" ? { origin: (body as { origin: string }).origin } : {}),
    ...(sessionId ? { sessionId } : {}),
    // The session's declared strategy resolves the preflop piece. `strategy` is
    // only the override for callers with no session; the rig's old MES/GTO tab
    // no longer exists.
    ...((body.strategyId ?? strategyId) ? { strategyId: body.strategyId ?? strategyId } : {}),
    ...(body.strategy === "exploit" || body.strategy === "chart" ? { strategy: body.strategy } : {}),
  }), (s) => `${(s as { ok?: boolean }).ok ? "ok" : "not ok"} · ${(s as { source?: string }).source ?? ""} · ${(s as { tier?: string }).tier ?? ""}`);
  return c.json({ ...base, solution });
}

export default app;
