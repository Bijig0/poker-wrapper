/**
 * Pure helpers for the AI-study route (routes/aiStudy.ts): preflop pot/stack
 * bookkeeping, postflop token-stream splitting, and the mapping between GTOW
 * custom-solve actions and the study UI's engine-style labels
 * ("Check" | "Bet(330)" | …, chips = bb × 100 — the solve-DB convention).
 */

export const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;

/** Postflop position order (first to act … last) — mirrors the analysis UI. */
export const POSTFLOP_ORDER = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];

export const CARD_RE = /^[2-9TJQKA][cdhs]$/;

/** "aS"/"AS" → "As" (rank upper, suit lower). Throws on garbage. */
export const normCard = (c: string): string => {
  const m = c.trim().match(/^([2-9TJQKAtjqka])([shdcSHDC])$/);
  if (!m) throw new Error(`bad card: "${c}"`);
  return m[1]!.toUpperCase() + m[2]!.toLowerCase();
};

/** Preflop acting order for HU token lines (buildPreflopTokensHu's grammar):
 *  the SB/dealer acts first and there are no other seats to pad. Pass this as
 *  `seats` to preflopPotStack/preflopClosed for CashHu* lines — walking them
 *  with the 6-max rotation misassigns every action and double-counts the
 *  blinds as dead money. */
export const HU_SEATS: readonly string[] = ["SB", "BB"];

/**
 * Pot entering the flop and the effective stack behind, from a GTOW-grammar
 * preflop line ("F-F-R2.5-F-C-F"). Simulates the table rotation (6-max by
 * default, HU_SEATS for heads-up lines) so folded players' dead money
 * (blinds AND abandoned raises, e.g. squeeze pots) counts.
 */
export function preflopPotStack(
  tokens: string[],
  depth: number,
  seats: readonly string[] = SEATS,
  /**
   * The round total of each "RAI" token, in order, when the capture knows it (2026-09-25, harness seeds 1333/2053
   * [jam]). "RAI" is GTO Wizard's all-in token and carries no size, so it was read as an all-in for the whole DEPTH:
   * an 18bb small blind's jam called by two 100bb players left them "0bb behind" and every flop was refused as
   * "preflop line is (near) all-in", though both had 82bb and a side pot to play for. With the amounts, a short jam
   * raises the level to what it is (and an all-in for less than the level is a call for less).
   */
  allInTo?: number[],
  /**
   * Seats that CALLED all-in, by the tree's seat name, with the round total they had (2026-09-25, round 2, harness
   * seed 86): an all-in that does not raise the price is tokenized "C" (buildSolutionUrl.allInCalls), so the call
   * that puts a seat all-in is capped at what he had and takes him out of the rotation, as a RAI does.
   */
  allInCallBySeat?: Record<string, number>,
): { pot: number; stack: number } {
  const committed: Record<string, number> = { SB: 0.5, BB: 1 };
  let active: string[] = [...seats];
  let p = 0;
  let level = 1;
  let rai = 0;
  for (const tok of tokens) {
    if (active.length < 2) break;
    p = p % active.length;
    const seat = active[p]!;
    if (tok === "F") {
      active = active.filter((s) => s !== seat); // pointer now indexes the next seat
      continue;
    }
    if (tok === "C") {
      const cap = allInCallBySeat?.[seat];
      if (cap != null && Number.isFinite(cap) && cap <= level + 0.005) {
        committed[seat] = Math.min(cap, level);
        active = active.filter((s) => s !== seat);   // all-in: never acts again (the pointer now indexes the next seat)
        continue;
      }
      committed[seat] = level;
    }
    else if (tok === "RAI") {
      const to = allInTo?.[rai++];
      if (to != null && Number.isFinite(to) && to < depth) { committed[seat] = to; level = Math.max(level, to); }
      else { level = depth; committed[seat] = depth; }
      // an all-in seat never acts again: out of the rotation, like a fold (its chips stay in the pot)
      active = active.filter((s) => s !== seat);
      continue;
    }
    else if (/^R[\d.]+$/.test(tok)) { level = parseFloat(tok.slice(1)); committed[seat] = level; }
    // "X" (BB checking a limped pot) commits nothing
    p += 1;
  }
  const pot = Object.values(committed).reduce((s, x) => s + x, 0);
  return { pot, stack: depth - level };
}

/**
 * True when a preflop token line's betting genuinely closed: at most one
 * player left, or every remaining player has acted since the last raise.
 * The crawl can carry nodes FALSELY marked terminal (an un-crawled 3-bet
 * response, e.g. "R2-R6.5-F-F-F-F" with UTG still to act) — solving postflop
 * from such a node pairs an opener's UNCONDITIONED range against the raiser's,
 * which is garbage. Callers must reject open lines before reconstructing.
 */
export function preflopClosed(tokens: string[], seats: readonly string[] = SEATS): boolean {
  let active: string[] = [...seats];
  // everyone is owed an action preflop (the blinds keep their option), and
  // every raise re-opens all other remaining players
  let pending = new Set<string>(seats);
  let p = 0;
  for (const tok of tokens) {
    if (active.length < 2) break;
    p = p % active.length;
    const seat = active[p]!;
    if (tok === "F") {
      pending.delete(seat);
      active = active.filter((s) => s !== seat);
      continue;
    }
    if (tok.startsWith("R")) pending = new Set(active.filter((s) => s !== seat));
    else pending.delete(seat); // C or X
    p += 1;
  }
  return active.length < 2 || ![...pending].some((s) => active.includes(s));
}

/**
 * Split the study UI's postflop token stream (engine action labels with dealt
 * cards inline: ["Check","Bet(330)","Call","7d","Check",…]) into per-street
 * action segments plus the dealt turn/river cards.
 */
export function splitPostflopTokens(tokens: string[]): { streets: string[][]; cards: string[] } {
  const streets: string[][] = [[]];
  const cards: string[] = [];
  for (const t of tokens) {
    if (CARD_RE.test(t)) {
      cards.push(t);
      streets.push([]);
    } else {
      streets[streets.length - 1]!.push(t);
    }
  }
  return { streets, cards };
}

export type ActionKind = "Fold" | "Check" | "Call" | "Bet" | "Raise" | "AllIn";

interface ApiAction {
  action: { code?: string; display_name?: string; betsize?: number | null };
}

/** GTOW custom-solve action → its kind, from the URL code first (most stable). */
export function actionKindOf(a: ApiAction): ActionKind {
  const code = a.action.code ?? "";
  if (code === "F") return "Fold";
  if (code === "X") return "Check";
  if (code === "C") return "Call";
  if (code === "RAI") return "AllIn";
  const d = (a.action.display_name ?? "").toLowerCase();
  if (d.startsWith("fold")) return "Fold";
  if (d.startsWith("check")) return "Check";
  if (d.startsWith("call")) return "Call";
  if (d.startsWith("raise")) return "Raise";
  if (d.startsWith("all")) return "AllIn";
  return "Bet";
}

/** Engine-style label for a GTOW action: "Fold" | "Check" | "Call" | "Bet(330)"…
 *  Wager amounts are the street's raise-to size in chips (bb × 100). */
export function actionLabelOf(a: ApiAction, fallbackBetBb: number): string {
  const kind = actionKindOf(a);
  if (kind === "Fold" || kind === "Check" || kind === "Call") return kind;
  const bb = a.action.betsize ?? fallbackBetBb;
  return `${kind}(${Math.round(bb * 100)})`;
}

/** Index of the action matching an engine-style label, or -1. */
export function matchActionIndex(label: string, sols: ApiAction[], fallbackBetBb: number): number {
  return sols.findIndex((a) => actionLabelOf(a, fallbackBetBb) === label);
}

/**
 * Like matchActionIndex, but a wager label ("Bet(750)") may also match the
 * nearest same-family wager action (Bet/Raise/AllIn interchangeable) within a
 * small tolerance — needed after a FIXED re-solve, where the requested % of pot
 * rounds to a slightly different raise-to size than the user typed.
 */
export function matchActionLoose(label: string, sols: ApiAction[], fallbackBetBb: number): number {
  const exact = matchActionIndex(label, sols, fallbackBetBb);
  if (exact >= 0) return exact;
  const m = label.match(/^(?:Bet|Raise|AllIn)\((\d+(?:\.\d+)?)\)$/);
  if (!m) return -1;
  const wantBb = Number(m[1]) / 100;
  let best = -1;
  let bestDiff = Infinity;
  sols.forEach((a, i) => {
    const kind = actionKindOf(a);
    if (kind !== "Bet" && kind !== "Raise" && kind !== "AllIn") return;
    const diff = Math.abs((a.action.betsize ?? fallbackBetBb) - wantBb);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  });
  const tol = Math.max(0.05 * wantBb, 0.15); // 5% relative or 0.15bb
  if (bestDiff <= tol) return best;
  // NO "60% OF THE STACK IS THE ALL-IN" RULE (removed 2026-10-03). It was our twin of GTO Wizard's allin_threshold 60
  // (2026-09-24, sweep w3-river-facing-raise: the tree had turned a 73.2 raise into its all-in and offered no raise
  // size). Both are gone: the tree is now built with the threshold off and the wager pinned as its amount, so a bet
  // is the tree's all-in only when it IS the actor's all-in (within the tolerance above). A 9.4 bet with 14.2 behind
  // walked as ALLIN 14.2 (2026-09-30) is exactly what this rule did.
  return -1;
}

/** The wager amount (bb) an engine label represents, or null for non-wagers. */
export function labelBetBb(label: string): number | null {
  const m = label.match(/^(?:Bet|Raise|AllIn)\((\d+(?:\.\d+)?)\)$/);
  return m ? Number(m[1]) / 100 : null;
}
