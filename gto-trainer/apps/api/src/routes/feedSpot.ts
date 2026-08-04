import { Hono } from "hono";
import { resolveHand, type ResolveBody } from "../feed/resolveHand/resolveHand";
import {
  buildPreflopTokens,
  buildPreflopTokensHu,
  buildSpotSolutionTokens,
} from "../feed/buildSolutionUrl/buildSolutionUrl";
import { snapPreflopLine } from "../utils/snapPreflopLine/snapPreflopLine";
import { resolveDepth, resolveSet } from "../services/fastSolve";
import { preflopDb } from "../services/preflopDb";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * Feed audit: the ACTUAL table as the accessibility layer observed it, next to
 * the STUDY table whose answers we actually show, with every divergence named.
 * Powers the panel's "Feed" section — the point is to make the gap between
 * reality and the displayed solution inspectable, so mapping errors are found
 * by looking, not by suspicion.
 *
 * POST /api/feed-spot — accepts the same body as /ingest and /fast-solver:
 * { hand | live | rows | text, setId?, depth?, heroPos? }.
 */
const app = new Hono();

interface FeedSpotBody extends ResolveBody {
  setId?: string;
  depth?: number;
  heroPos?: string;
}

type Severity = "info" | "minor" | "major";

interface Discrepancy {
  field: string;
  actual: string | number | null;
  shown: string | number | null;
  severity: Severity;
  note?: string;
}

/** First voluntary preflop raise (the open) and limps before it, as observed. */
const openAndLimps = (hand: ParsedHand): { openBb: number | null; limpers: number } => {
  let limpers = 0;
  for (const a of hand.actions) {
    if (a.street !== "preflop") continue;
    if (a.type === "raise" || a.type === "bet" || a.type === "all-in") {
      return { openBb: a.amount ?? null, limpers };
    }
    if (a.type === "call") limpers++;
  }
  return { openBb: null, limpers };
};

/** Seats still contesting the pot at the current node (not folded, incl. hero). */
const playersInHand = (hand: ParsedHand): number => {
  const folded = new Set(
    hand.actions.filter((a) => a.type === "fold").map((a) => (a.hero ? "hero" : a.seatId))
  );
  const heroIn = !folded.has("hero") ? 1 : 0;
  const villains = hand.liveSeats.filter((s) => s !== hand.heroSeatId && !folded.has(s));
  return heroIn + villains.length;
};

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as FeedSpotBody;

  const resolved = await resolveHand(body);
  if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status as 400 | 409 | 502);
  const { hand, source, warnings, tableStatus, heroSittingOut } = resolved;
  if (!hand) {
    return c.json({ ok: false, error: "No hand in the feed (waiting for the next deal).", tableStatus, warnings }, 422);
  }

  const heroPost = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  const heroPos =
    body.heroPos ??
    hand.positions[hand.heroSeatId] ??
    (heroPost ? (heroPost.type === "post-sb" ? "SB" : "BB") : null);

  const set = resolveSet(hand, heroPos, body.setId);
  if (!set) return c.json({ ok: false, error: `Unknown solution set: ${body.setId}` }, 400);
  const isHu = set.seats.length === 2;
  const depth = resolveDepth(hand, set.depths?.length ? set.depths : [100], body.depth);

  // ---- actual side: raw observed tokens (unsnapped sizes) ----
  const tk = buildSpotSolutionTokens(hand, heroPos, isHu);
  const { openBb, limpers } = openAndLimps(hand);
  const stacks = hand.stacks ?? {};
  const liveStacks = Object.values(stacks).filter((s) => Number.isFinite(s) && s > 0);
  const effStackBb = liveStacks.length ? Math.round(Math.min(...liveStacks) * 10) / 10 : null;
  const tableSeats = new Set([
    ...Object.keys(hand.positions).map(Number),
    ...hand.liveSeats,
    hand.heroSeatId,
  ]).size;
  const inHand = playersInHand(hand);

  // ---- shown side: the line after snapping to the solved tree ----
  const chartsUp = preflopDb.available(set.gametype, depth);
  let shownPreflop = tk.preflop;
  let repaired: { index: number; from: number; to: number }[] = [];
  let snapFail: string | null = null;
  if (chartsUp && tk.preflop.length) {
    const snapped = snapPreflopLine(tk.preflop, (line) => preflopDb.rawNode(set.gametype, depth, line));
    if (snapped.ok) {
      shownPreflop = snapped.tokens;
      repaired = snapped.repaired;
    } else {
      snapFail = `${snapped.reason} (at "${snapped.at}")`;
    }
  }
  const shownOpen = (() => {
    for (const t of shownPreflop) if (t.startsWith("R") && t !== "RAI") return Number(t.slice(1));
    return null;
  })();

  const postflopStatus = !hand.board.length
    ? "preflop"
    : inHand > 2
      ? "unavailable-multiway"
      : snapFail
        ? "unsolved-line"
        : "solved";

  // ---- discrepancies: one row per divergence between the two tables ----
  const d: Discrepancy[] = [];
  if (tableSeats !== set.seats.length) {
    d.push({
      field: "table size",
      actual: `${tableSeats}-handed`,
      shown: `${set.seats.length}-max chart`,
      severity: tableSeats > set.seats.length ? "major" : "minor",
      note: "empty seats are treated as instant folds in the solved tree",
    });
  }
  if (isHu) {
    d.push({
      field: "positions",
      actual: "dealer reads as BTN",
      shown: "seated as SB",
      severity: "info",
      note: "in HU trees the dealer IS the small blind",
    });
  }
  if (effStackBb != null && Math.abs(effStackBb - depth) / depth > 0.1) {
    d.push({
      field: "effective stack",
      actual: `${effStackBb}bb`,
      shown: `${depth}bb solve`,
      severity: Math.abs(effStackBb - depth) / depth > 0.4 ? "major" : "minor",
      note: "nearest solved depth",
    });
  }
  for (const r of repaired) {
    d.push({
      field: `preflop action ${r.index + 1}`,
      actual: `${r.from}bb`,
      shown: `${r.to}bb`,
      severity: Math.abs(Math.log(r.to / r.from)) > 0.25 ? "minor" : "info",
      note: "off-tree size snapped to nearest solved size",
    });
  }
  if (snapFail) {
    d.push({
      field: "preflop line",
      actual: tk.preflop.join("-"),
      shown: null,
      severity: "major",
      note: `line not in the solved tree: ${snapFail}`,
    });
  }
  // A limp is only a discrepancy when the charts genuinely don't cover the
  // line — the crawl DOES include e.g. SB completes, and flagging every limp
  // ("the tree has no limp lines") was simply false for those.
  if (limpers > 0 && !isHu && snapFail) {
    d.push({
      field: "limpers",
      actual: limpers,
      shown: 0,
      severity: "major",
      note: "this limped line isn't in the crawled charts — answers assume raise-first pots",
    });
  }
  if (postflopStatus === "unavailable-multiway") {
    d.push({
      field: "players postflop",
      actual: inHand,
      shown: 2,
      severity: "major",
      note: "postflop solutions are heads-up only — no answer shown multiway",
    });
  }

  return c.json({
    ok: true,
    source,
    tableStatus,
    heroSittingOut,
    actual: {
      handId: hand.handId,
      street: hand.street,
      board: tk.board || null,
      tableSeats,
      playersInHand: inHand,
      heroPos,
      heroCards: hand.heroCards,
      effStackBb,
      potBb: hand.currentNode.pot,
      toCallBb: hand.currentNode.toCall,
      openRaiseBb: openBb,
      limpers,
      tokens: { preflop: tk.preflop, flop: tk.flop, turn: tk.turn, river: tk.river },
    },
    shown: {
      setId: set.id,
      label: set.label,
      gametype: set.gametype,
      depth,
      seats: set.seats,
      huRemap: isHu,
      chartsAvailable: chartsUp,
      openRaiseBb: shownOpen,
      postflop: postflopStatus,
      tokens: { preflop: shownPreflop, flop: tk.flop, turn: tk.turn, river: tk.river },
    },
    discrepancies: d,
    warnings,
  });
});

export default app;
