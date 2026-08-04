import { Hono } from "hono";
import { gtowApi } from "../services/gtowApi";
import { buildRangeArray, rangeCombos } from "../utils/buildRangeArray/buildRangeArray";
import { comboIndex } from "../utils/comboIndex/comboIndex";
import { pickWeightedAction } from "../utils/pickWeightedAction/pickWeightedAction";
import { resolveHand, type ResolveBody } from "../feed/resolveHand/resolveHand";
import { deriveExploitSpot } from "../utils/deriveExploitSpot/deriveExploitSpot";
import { renderPanelRows, type ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { buildPreflopTokens, buildPreflopTokensHu, buildSpotSolutionTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { preflopDb } from "../services/preflopDb";
import { SOLUTION_SETS } from "../services/gtowCdp";
import { solveExploitLine, warmExploitLine } from "../services/exploitLine";

/**
 * Exploit solver: AI-solve a postflop spot against CUSTOM ranges via GTO
 * Wizard's cloud (services/gtowApi.customSolve). This is what the spot-solution
 * lookup can't do — plug in a villain's scared/exploitable range and get the
 * maximally-exploitative line, board-specific, in ~2s.
 *
 * POST /api/ai-solve
 * {
 *   board: "Ts7h2d", pot: 5.5, stack: 97.5,
 *   oopRange: "22+,A2s+,KQs,...",   // shorthand, class list, or "full"
 *   ipRange:  "full",
 *   heroSeat: "oop" | "ip",          // whose decision to extract
 *   heroCards?: ["Ah","Kh"],         // omit for aggregate frequencies
 *   flopActions?, turnActions?, riverActions?,  // default "" (street root)
 *   oopPos?, ipPos?, startingStreet?
 * }
 */
const app = new Hono();

const SHORT = (c: string): string => {
  const m = c.trim().match(/^([2-9TJQKAtjqka])([shdcSHDC])$/);
  return m ? m[1]!.toUpperCase() + m[2]!.toLowerCase() : c;
};

interface AiSolveBody extends ResolveBody {
  /** villain/hero ranges, keyed by seat (OOP/IP). */
  oopRange?: string;
  ipRange?: string;
  /** explicit-spot fields (used when no hand is given). */
  board?: string;
  pot?: number;
  stack?: number;
  heroSeat?: "oop" | "ip";
  heroCards?: string[];
  flopActions?: string;
  turnActions?: string;
  riverActions?: string;
  oopPos?: string;
  ipPos?: string;
  startingStreet?: "FLOP" | "TURN" | "RIVER";
  heroPos?: string;
  /** default true — force hero's held combo into their range so it always gets a decision. */
  forceHeroHand?: boolean;
  /** pre-solve the line's COMPLETED streets and return immediately, without
   *  hero's node — see the warm path below. */
  warm?: boolean;
}

interface Spot {
  board: string;
  startingStreet: "FLOP" | "TURN" | "RIVER";
  pot: number;
  stack: number;
  oopPos: string;
  ipPos: string;
  heroSeat: "oop" | "ip";
  actions: string;
  heroCards: string[];
}

app.post("/", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as AiSolveBody;
  if (!b.oopRange || !b.ipRange) {
    return c.json({ ok: false, error: "oopRange and ipRange are required (shorthand, class list, or 'full')." }, 400);
  }
  const oopRange = buildRangeArray(b.oopRange);
  const ipRange = buildRangeArray(b.ipRange);
  if (rangeCombos(oopRange) <= 0 || rangeCombos(ipRange) <= 0) {
    return c.json({ ok: false, error: "A range expanded to zero combos — check the spec." }, 400);
  }

  // Resolve the spot — from a pasted/live hand (Feed-Ingest style) or explicit fields.
  let spot: Spot;
  let rerendered: unknown = undefined;
  // When we have the whole hand, we can replay the FULL postflop line (betting on
  // prior streets included) via services/exploitLine; explicit-field requests only
  // carry the current street's actions, so they take the single-node path.
  let lineCtx: {
    streets: Record<"flop" | "turn" | "river", string[]>;
    boardFull: string;
    current: "flop" | "turn" | "river";
    flopPot: number;
    effStack: number;
  } | null = null;
  if (b.hand != null || b.live || b.rows || b.text) {
    const resolved = await resolveHand(b);
    if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status as 400 | 409 | 502);
    if (!resolved.hand) return c.json({ ok: false, error: "No hand in the feed (waiting for the next deal)." }, 422);
    const hand = resolved.hand;
    const post = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
    const heroPos = b.heroPos ?? hand.positions[hand.heroSeatId] ?? (post ? (post.type === "post-sb" ? "SB" : "BB") : null);
    const d = deriveExploitSpot(hand, heroPos);
    if (!d.ok) return c.json({ ok: false, error: d.error }, 422);
    spot = d.spot;
    rerendered = renderPanelRows(hand);

    // pot & effective stack ENTERING the flop, from the preflop level + dead blinds
    const preRaises = hand.actions
      .filter((a) => a.street === "preflop" && (a.type === "raise" || a.type === "bet") && a.amount != null)
      .map((a) => a.amount as number);
    const level = preRaises.length ? Math.max(...preRaises) : 1;
    const seats = new Set([spot.oopPos.toUpperCase(), spot.ipPos.toUpperCase()]);
    const flopPot = 2 * level + (seats.has("SB") ? 0 : 0.5) + (seats.has("BB") ? 0 : 1);
    const stacks = Object.values(hand.stacks ?? {}).filter((x) => Number.isFinite(x) && (x as number) > 0) as number[];
    const eff = stacks.length ? Math.min(...stacks) : 100;
    const tk = buildSpotSolutionTokens(hand, heroPos, false);
    lineCtx = {
      streets: { flop: tk.flop, turn: tk.turn, river: tk.river },
      boardFull: spot.board,
      current: spot.startingStreet.toLowerCase() as "flop" | "turn" | "river",
      flopPot,
      effStack: eff - level,
    };
  } else {
    const board = (b.board ?? "").replace(/\s+/g, "");
    if (!board || !(b.pot! > 0) || !(b.stack! > 0)) {
      return c.json({ ok: false, error: "Provide a hand (paste/live) or board+pot+stack." }, 400);
    }
    const startingStreet = b.startingStreet ?? (board.length === 6 ? "FLOP" : board.length === 8 ? "TURN" : "RIVER");
    spot = {
      board, startingStreet, pot: b.pot!, stack: b.stack!,
      oopPos: b.oopPos ?? "OOP", ipPos: b.ipPos ?? "IP", heroSeat: b.heroSeat ?? "ip",
      actions: b.flopActions ?? b.turnActions ?? b.riverActions ?? "",
      heroCards: b.heroCards ?? [],
    };
  }

  // Warm path: walk the line's COMPLETED streets and return without solving
  // hero's node. Fire it the moment a street completes — the propagation solves
  // land in gtowApi's cache during villain's think time, so hero's real request
  // later pays for one solve instead of the whole chain. Best-effort: it always
  // answers 200 so a failed warm can't trip the caller's error handling.
  if (b.warm) {
    if (!lineCtx) return c.json({ ok: false, error: "warm needs a hand — an explicit-field request has no prior streets to walk." }, 400);
    const w = await warmExploitLine({
      boardFull: lineCtx.boardFull, streets: lineCtx.streets, current: lineCtx.current,
      oopRange, ipRange, oopPos: spot.oopPos, ipPos: spot.ipPos,
      flopPot: lineCtx.flopPot, effStack: lineCtx.effStack,
    });
    return c.json(w.ok ? { ok: true, warmed: true, solves: w.solves } : { ok: false, warmed: false, error: w.error, unsupported: w.unsupported });
  }

  // Force hero's ACTUAL combo into hero's INPUT range (whatever we're sending for
  // that seat), so it always gets a decision rather than reading "not in range"
  // when the combo isn't in that range. Common case: the default hero range is the
  // chart-reconstructed GTO range and hero holds a hand GTO plays differently
  // preflop (flatted AQs where GTO 3-bets it). One combo — negligible range shift.
  const heroCardsIn = (spot.heroCards ?? []).filter((x) => /^[2-9TJQKA][shdc]$/i.test(x)).map(SHORT);
  const heroForceIdx =
    heroCardsIn.length === 2 && b.forceHeroHand !== false ? comboIndex(heroCardsIn[0]!, heroCardsIn[1]!) : undefined;

  // Hand path → replay the full line (faced bets on every street, fixed at their
  // exact size). Explicit-field path → single street-rooted node with automatic
  // sizing (no prior-street context available).
  let heroForced = false;
  let result: { ok: true; customSolutionId?: string; solveSecs: number; cached: boolean; data: any } | { ok: false; status: number; error: string };
  if (lineCtx) {
    const line = await solveExploitLine({
      boardFull: lineCtx.boardFull, streets: lineCtx.streets, current: lineCtx.current,
      oopRange, ipRange, oopPos: spot.oopPos, ipPos: spot.ipPos,
      flopPot: lineCtx.flopPot, effStack: lineCtx.effStack,
      heroSeat: spot.heroSeat, heroForceIdx,
    });
    if (!line.ok) {
      return c.json({ ok: false, error: line.error, unsupported: line.unsupported }, (line.status === 0 ? 503 : 502) as 502 | 503);
    }
    heroForced = line.heroForced;
    result = { ok: true, solveSecs: line.solveSecs, cached: line.cached, data: line.data };
  } else {
    if (heroForceIdx != null) {
      const heroArr = spot.heroSeat === "oop" ? oopRange : ipRange;
      if ((heroArr[heroForceIdx] ?? 0) < 1) { heroArr[heroForceIdx] = 1; heroForced = true; }
    }
    const streetKey = spot.startingStreet === "FLOP" ? "flopActions" : spot.startingStreet === "TURN" ? "turnActions" : "riverActions";
    result = await gtowApi.customSolve({
      board: spot.board, pot: spot.pot, stack: spot.stack, oopRange, ipRange,
      oopPos: spot.oopPos, ipPos: spot.ipPos, startingStreet: spot.startingStreet,
      [streetKey]: spot.actions || undefined,
    });
  }
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, result.status === 0 ? 503 : 502);
  }

  const j = result.data;
  const heroCards = heroCardsIn;
  const activePos: string | null = j.action_solutions?.[0]?.action?.position ?? null;

  let actions: { action: string; frequency: number; ev?: number; betsize?: number }[];
  let notInRange = false;
  if (heroCards.length === 2) {
    const idx = comboIndex(heroCards[0]!, heroCards[1]!);
    actions = (j.action_solutions ?? []).map((a: any) => ({
      action: a.action.display_name,
      frequency: (a.strategy?.[idx] ?? 0) * 100,
      ev: a.evs?.[idx],
      betsize: a.action.betsize ?? undefined,
    }));
    notInRange = actions.every((a) => a.frequency <= 0);
  } else {
    actions = (j.action_solutions ?? []).map((a: any) => ({
      action: a.action.display_name,
      frequency: (a.total_frequency ?? 0) * 100,
      ev: a.total_ev,
      betsize: a.action.betsize ?? undefined,
    }));
  }

  // A "full" range is the silent fallback reconstructChartRanges returns when the
  // preflop line is off-tree / the chart node is missing. Solving hero-vs-villain
  // with 100%-of-combos ranges makes any strong hand trivially bet/raise ~always
  // (e.g. AhKh on a ten-high flop "bets 99%") — that is NOT a real GTO or exploit
  // answer, it's garbage-in. Flag it loudly and SUPPRESS the decision so a bogus
  // number can never masquerade as a legit result.
  const isFull = (spec: string) => spec.trim().toLowerCase() === "full";
  const oopFull = isFull(b.oopRange);
  const ipFull = isFull(b.ipRange);
  const rangesFull = oopFull || ipFull;
  const fullSides = [oopFull && `${spot.oopPos} (OOP)`, ipFull && `${spot.ipPos} (IP)`].filter(Boolean).join(" and ");
  const fullWarning = rangesFull
    ? `⚠ No solved chart range was available for ${fullSides}, so this solved against a full 100%-of-combos range. Any strong hand reads ~always bet/raise against that — this is NOT a real GTO or exploit answer. Set real ranges in the grid(s) and re-solve.`
    : null;

  return c.json({
    ok: true,
    engine: "gtow-ai-solve",
    customSolutionId: result.customSolutionId,
    solveSecs: result.solveSecs,
    cached: result.cached,
    spot: {
      board: spot.board,
      street: spot.startingStreet.toLowerCase(),
      pot: spot.pot,
      stack: spot.stack,
      oopPos: spot.oopPos,
      ipPos: spot.ipPos,
      heroSeat: spot.heroSeat,
      actions: spot.actions,
      heroCards: spot.heroCards,
    },
    rerendered,
    heroForced,
    pos: activePos,
    ranges: { oop: rangeCombos(oopRange), ip: rangeCombos(ipRange) },
    rangesFull: rangesFull ? { oop: oopFull, ip: ipFull } : undefined,
    actions,
    // suppress the decision on a full-range fallback — the numbers aren't real
    decision: notInRange || rangesFull ? null : pickWeightedAction(actions),
    notInRange: notInRange || undefined,
    warning: fullWarning ?? j.warning ?? null,
  });
});

/**
 * Wizard setup: parse a hand → the spot + BOTH players' GTO ranges reaching the
 * flop, reconstructed from the local preflop charts. No GTOW call — just the
 * charts. The page pre-fills the range grids with these; the user then tweaks
 * villain's for the exploit and solves. Ranges fall back to "full" when the
 * preflop line isn't in the charts (uncrawled/odd sizing).
 */
const heroPosOf = (hand: ParsedHand, override?: string): string | null => {
  const post = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  return override ?? hand.positions[hand.heroSeatId] ?? (post ? (post.type === "post-sb" ? "SB" : "BB") : null);
};

const reconstructChartRanges = (hand: ParsedHand, heroPos: string, oopPos: string, ipPos: string): { oop: string; ip: string; source: "charts" | "full" } => {
  // Detect table size from how many seats were DEALT (acted preflop), NOT from how
  // many still carry a position label. A fold-to-the-blinds hand often only labels
  // the two live blinds, which would misread as heads-up and look up the wrong (HU)
  // chart — the line then misses and falls back to full. Distinct preflop-action
  // seats counts everyone who folded too, so a 6-max blind-vs-blind pot reads as 6.
  const dealtSeats = new Set(hand.actions.filter((a) => a.street === "preflop").map((a) => a.seatId));
  const tableSize = Math.max(dealtSeats.size, new Set([...Object.values(hand.positions), heroPos].filter(Boolean)).size);
  const set = SOLUTION_SETS.find((s) => s.id === (tableSize <= 2 ? "hu" : "6max"));
  if (!set) return { oop: "full", ip: "full", source: "full" };
  const isHu = set.seats.length === 2;
  const stacks = Object.values(hand.stacks ?? {}).filter((x) => Number.isFinite(x) && x > 0);
  const eff = stacks.length ? Math.min(...stacks) : 100;
  const depth = (set.depths?.length ? set.depths : [100]).reduce((a, b) => (Math.abs(b - eff) < Math.abs(a - eff) ? b : a));
  if (!preflopDb.available(set.gametype, depth)) return { oop: "full", ip: "full", source: "full" };

  const tokens = isHu ? buildPreflopTokensHu(hand, heroPos) : buildPreflopTokens(hand, heroPos);
  const recon = reconstructFlopRanges(tokens, (line) => preflopDb.rawNode(set.gametype, depth, line));
  if (!recon.ok) return { oop: "full", ip: "full", source: "full" };

  const byPos = (pos: string) => Object.entries(recon.ranges).find(([p]) => p.toUpperCase() === pos.toUpperCase())?.[1];
  const oop = byPos(oopPos);
  const ip = byPos(ipPos);
  if (!oop || !ip) return { oop: "full", ip: "full", source: "full" };
  return { oop: classWeightsToSpec(oop), ip: classWeightsToSpec(ip), source: "charts" };
};

app.post("/setup", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as ResolveBody & { heroPos?: string };
  const resolved = await resolveHand(b);
  if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status as 400 | 409 | 502);
  if (!resolved.hand) return c.json({ ok: false, error: "No hand in the feed (waiting for the next deal)." }, 422);
  const hand = resolved.hand;
  const heroPos = heroPosOf(hand, b.heroPos);
  const d = deriveExploitSpot(hand, heroPos);
  if (!d.ok) return c.json({ ok: false, error: d.error }, 422);

  const ranges = reconstructChartRanges(hand, heroPos!, d.spot.oopPos, d.spot.ipPos);
  const warning = ranges.source === "full"
    ? "⚠ No solved chart ranges for this preflop line — the grids are prefilled with full 100% ranges, not GTO ranges. Solving as-is gives garbage (strong hands bet ~always). Set real ranges before solving."
    : null;
  return c.json({
    ok: true,
    spot: {
      board: d.spot.board, street: d.spot.startingStreet.toLowerCase(),
      pot: d.spot.pot, stack: d.spot.stack, oopPos: d.spot.oopPos, ipPos: d.spot.ipPos,
      heroSeat: d.spot.heroSeat, actions: d.spot.actions, heroCards: d.spot.heroCards,
    },
    ranges,
    warning,
    rerendered: renderPanelRows(hand),
  });
});

export default app;
