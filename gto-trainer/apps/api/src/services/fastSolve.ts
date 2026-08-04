import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { buildPreflopTokens, buildPreflopTokensHu, buildSpotSolutionTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { preflopDb } from "./preflopDb";
import { solveExploitLine } from "./exploitLine";
import { SOLUTION_SETS } from "./gtowCdp";
import { parseHandClass } from "../utils/parseHandClass/parseHandClass";
import { comboIndex } from "../utils/comboIndex/comboIndex";
import { pickWeightedAction, type WeightedPick } from "../utils/pickWeightedAction/pickWeightedAction";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { deriveExploitSpot } from "../utils/deriveExploitSpot/deriveExploitSpot";

/**
 * Fast-solver: answer a hand node the clean way — the local crawled preflop
 * charts for preflop, and GTO Wizard's spot-solution API for postflop — with no
 * live GTO Wizard DOM navigation. The spot-solution API holds BOTH heads-up and
 * multiway (6-max/9-max) postflop, board-specific; the only requirement is that
 * preflop sizes are on-tree, so the preflop line is snapped first. See
 * [[gtow-preflop-local-db]] and services/gtowApi.ts.
 */

export interface FastSolveOpts {
  setId?: string;
  depth?: number;
  heroPos?: string | null;
}

interface ActionFreq {
  action: string;
  frequency: number;
  ev?: number;
  betsize?: string;
}

export type FastSolveResult =
  | {
      ok: true;
      source: "local-preflop" | "gtow-api-postflop";
      /** which cascade layer answered (postflop only). */
      tier?: "library-exact" | "library-snap" | "far-snap" | "ai-exact";
      street: string;
      setId: string;
      gametype: string;
      depth: number;
      line: string;
      pos: string | null;
      heroClass: string | null;
      actions: ActionFreq[];
      decision: WeightedPick | null;
      notInRange?: boolean;
      approx?: boolean;
      warning?: string | null;
    }
  | { ok: false; reason: string; street?: string };

/** Depth: explicit > min live stack snapped to a library depth. */
const resolveDepth = (hand: ParsedHand, depths: number[], explicit?: number): number => {
  if (explicit) return explicit;
  const stacks = hand.stacks ?? {};
  const heroStack = stacks[hand.heroSeatId];
  const candidates =
    heroStack != null && heroStack > 0
      ? [heroStack]
      : Object.values(stacks).filter((s) => Number.isFinite(s) && s > 0);
  const eff = candidates.length ? Math.min(...candidates) : 100;
  return depths.reduce((a, b) => (Math.abs(b - eff) < Math.abs(a - eff) ? b : a));
};

const heroClassOf = (hand: ParsedHand): string | null => {
  const cards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c));
  if (cards.length !== 2) return null;
  try {
    return parseHandClass(cards.join(""));
  } catch {
    return null;
  }
};

/** Pick hero's set: explicit > 2-handed→HU (dealer BTN→SB) > 6-max. */
const resolveSet = (hand: ParsedHand, heroPos: string | null, setId?: string) => {
  const present = new Set([...Object.values(hand.positions), ...(heroPos ? [heroPos] : [])]);
  const id = setId ?? (present.size <= 2 ? "hu" : "6max");
  return SOLUTION_SETS.find((s) => s.id === id) ?? null;
};

/** Preflop answer from the local crawled DB. */
function solvePreflop(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts): FastSolveResult {
  const set = resolveSet(hand, heroPos, opts.setId);
  if (!set) return { ok: false, reason: `Unknown solution set: ${opts.setId}`, street: "preflop" };
  const isHu = set.seats.length === 2;
  const depth = resolveDepth(hand, set.depths?.length ? set.depths : [100], opts.depth);
  if (!preflopDb.available(set.gametype, depth)) {
    return { ok: false, reason: `No local preflop chart for ${set.gametype} @ ${depth}bb.`, street: "preflop" };
  }
  const tokens = isHu ? buildPreflopTokensHu(hand, heroPos) : buildPreflopTokens(hand, heroPos);
  const heroClass = heroClassOf(hand);
  const ans = preflopDb.answer(set.gametype, depth, tokens, heroClass);
  if (!ans.ok) return { ok: false, reason: ans.reason, street: "preflop" };

  return {
    ok: true,
    source: "local-preflop",
    street: "preflop",
    setId: set.id,
    gametype: set.gametype,
    depth,
    line: ans.line,
    pos: ans.pos,
    heroClass,
    actions: ans.actions,
    decision: ans.decision,
    notInRange: ans.notInRange || undefined,
    approx: ans.repaired.length > 0 || undefined,
  };
}

const SHORT_C = (c: string): string => {
  const m = c.trim().match(/^([2-9TJQKAtjqka])([shdcSHDC])$/);
  return m ? m[1]!.toUpperCase() + m[2]!.toLowerCase() : c;
};

/**
 * Postflop answer — always the GTO Wizard AI solver (custom solutions), never
 * the pre-solved library. Every observed bet is replayed at its EXACT size via
 * the street walk (services/exploitLine), so no size is ever snapped and no
 * line is off-tree by construction. Flop-entering ranges are reconstructed
 * from the local preflop charts; a raise war on a completed prior street is
 * the one unsupported shape. Latency = one cloud solve per bet-containing
 * prior street plus hero's node — the prior-street part is pre-paid during
 * dead time by the study poller's warm calls (see studyPoller.maybeWarm).
 */
async function solvePostflop(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts): Promise<FastSolveResult> {
  const street = hand.currentNode.street as "flop" | "turn" | "river";
  const set = resolveSet(hand, heroPos, opts.setId);
  if (!set) return { ok: false, reason: `Unknown solution set: ${opts.setId}`, street };
  const isHu = set.seats.length === 2;
  const depth = resolveDepth(hand, set.depths?.length ? set.depths : [100], opts.depth);
  if (!preflopDb.available(set.gametype, depth)) {
    return { ok: false, reason: `No local preflop chart for ${set.gametype} @ ${depth}bb (needed to reconstruct the flop-entering ranges).`, street };
  }

  const tk = buildSpotSolutionTokens(hand, heroPos, isHu);
  const preTokens = isHu ? buildPreflopTokensHu(hand, heroPos) : buildPreflopTokens(hand, heroPos);
  const recon = reconstructFlopRanges(preTokens, (line) => preflopDb.rawNode(set.gametype, depth, line));
  if (!recon.ok) return { ok: false, reason: `Couldn't reconstruct the flop-entering ranges: ${recon.reason}`, street };
  const d = deriveExploitSpot(hand, heroPos);
  if (!d.ok) return { ok: false, reason: d.error, street };
  const spot = d.spot;

  const byPos = (pos: string) => Object.entries(recon.ranges).find(([p]) => p.toUpperCase() === pos.toUpperCase())?.[1];
  const oopW = byPos(spot.oopPos);
  const ipW = byPos(spot.ipPos);
  if (!oopW || !ipW) return { ok: false, reason: `No reconstructed range for ${spot.oopPos} / ${spot.ipPos}.`, street };
  const oopArr = buildRangeArray(classWeightsToSpec(oopW));
  const ipArr = buildRangeArray(classWeightsToSpec(ipW));

  // pot & effective stack ENTERING the flop: 2·preflop-level + dead blinds.
  const rAmts = preTokens.filter((t) => /^R[\d.]+$/.test(t)).map((t) => parseFloat(t.slice(1)));
  const level = rAmts.length ? Math.max(...rAmts) : 1;
  const positions = new Set([spot.oopPos.toUpperCase(), spot.ipPos.toUpperCase()]);
  let dead = 0;
  if (!positions.has("SB")) dead += 0.5;
  if (!positions.has("BB")) dead += 1;
  const flopPot = 2 * level + dead;

  const heroCards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/i.test(c)).map(SHORT_C);
  const heroForceIdx = heroCards.length === 2 ? comboIndex(heroCards[0]!, heroCards[1]!) : undefined;

  const line = await solveExploitLine({
    boardFull: tk.board,
    streets: { flop: tk.flop, turn: tk.turn, river: tk.river },
    current: street,
    oopRange: oopArr, ipRange: ipArr, oopPos: spot.oopPos, ipPos: spot.ipPos,
    flopPot, effStack: depth - level,
    heroSeat: spot.heroSeat, heroForceIdx,
  });
  if (!line.ok) return { ok: false, reason: line.error, street };

  const j = line.data;
  const activePos: string | null = j.action_solutions?.[0]?.action?.position ?? null;
  let actions: ActionFreq[];
  let notInRange = false;
  if (heroCards.length === 2) {
    const idx = comboIndex(heroCards[0]!, heroCards[1]!);
    actions = (j.action_solutions ?? []).map((a: any) => ({ action: a.action.display_name, frequency: (a.strategy?.[idx] ?? 0) * 100, ev: a.evs?.[idx], betsize: a.action.betsize }));
    notInRange = actions.every((a) => a.frequency <= 0);
  } else {
    actions = (j.action_solutions ?? []).map((a: any) => ({ action: a.action.display_name, frequency: (a.total_frequency ?? 0) * 100, ev: a.total_ev, betsize: a.action.betsize }));
  }

  return {
    ok: true,
    source: "gtow-api-postflop",
    tier: "ai-exact",
    street,
    setId: set.id,
    gametype: set.gametype,
    depth,
    line: `${preTokens.join("-")} / ${[tk.flop.join("-"), tk.turn.join("-"), tk.river.join("-")].filter(Boolean).join(" / ")}`,
    pos: activePos,
    heroClass: heroClassOf(hand),
    actions,
    decision: notInRange ? null : pickWeightedAction(actions),
    notInRange: notInRange || undefined,
    warning: line.cached ? null : `AI-solved on the cloud in ${line.solveSecs.toFixed(1)}s (${line.solves} fresh solve${line.solves === 1 ? "" : "s"}).`,
  };
}

/**
 * Solve a hand node: preflop from the local charts, postflop from the GTO
 * Wizard AI solver. Assumes hero is to act (the caller checks `toActIsHero`).
 */
export async function fastSolve(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts = {}): Promise<FastSolveResult> {
  return hand.currentNode.street === "preflop"
    ? solvePreflop(hand, heroPos, opts)
    : solvePostflop(hand, heroPos, opts);
}
