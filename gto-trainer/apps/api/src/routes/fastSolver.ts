import { Hono } from "hono";
import { resolveHand, type ResolveBody } from "../feed/resolveHand/resolveHand";
import { handToSpot, type SpotOptions } from "../feed/handToSpot/handToSpot";
import { renderPanelRows } from "../feed/parsePanelFeed/parsePanelFeed";
import { fastSolve } from "../services/fastSolve";
import { SOLUTION_SETS } from "../services/gtowCdp";

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
  /** MES/GTO tab: which preflop strategy is primary. Omitted = the rig's own
   *  studyMode, so a caller that forgets it still honours the user's choice. */
  strategy?: "exploit" | "chart";
}

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as FastSolverBody;
  const set = SOLUTION_SETS.find((s) => s.id === (body.setId ?? "6max"));

  const resolved = await resolveHand(body);
  if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status as 400 | 409 | 502);
  const { hand, source, warnings, tableStatus, heroSittingOut, studyAnswersOn, studyMode } = resolved;

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
    studyMode,
    rerendered: renderPanelRows(hand),
    hero: {
      pos: heroPos,
      cards: hand.heroCards,
      folded: heroFolded,
      sittingOut: heroSittingOut,
      toAct: heroTurn,
    },
    hand: {
      handId: hand.handId,
      clientHandId: hand.clientHandId ?? null,
      heroCards: hand.heroCards,
      board: hand.board,
      street: hand.street,
      positions: hand.positions,
      actions: hand.actions,
      ended: hand.ended,
      node: hand.currentNode,
      result: hand.result ?? null,
    },
    spot: spotOutcome.ok ? spotOutcome.spot : null,
    notes: spotOutcome.ok ? spotOutcome.notes : [],
  };

  if (!heroTurn) {
    return c.json({ ...base, solution: null, deferred: hand.ended ? "Hand is over." : "Not hero's turn." });
  }

  const solution = await fastSolve(hand, heroPos, {
    setId: body.setId, depth: body.depth, heroPos,
    ...(body.strategy === "exploit" || body.strategy === "chart"
      ? { strategy: body.strategy }
      : studyMode ? { strategy: studyMode } : {}),
  });
  return c.json({ ...base, solution });
});

export default app;
