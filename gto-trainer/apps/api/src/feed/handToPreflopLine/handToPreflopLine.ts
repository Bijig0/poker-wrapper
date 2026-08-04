/**
 * handToPreflopLine
 * -----------------
 * When hero faces a PREFLOP decision, express the hand's actual preflop
 * action sequence as a line the GTO Wizard preflop tree can walk: one step
 * per decision in order, blinds' posts excluded (the tree starts at UTG with
 * blinds implicit). Sizes ride along so the walker can pick the nearest tree
 * raise. Multiway is fine preflop — the tree covers the full ring.
 */

import type { ParsedHand } from "../parsePanelFeed/parsePanelFeed";

export interface PreflopStep {
  kind: "fold" | "call" | "raise" | "allin";
  sizeBb: number | null;
  hero: boolean;
  seatId: number;
  /** Table position ("UTG", "HJ"…) when known — lets the walker align steps
   *  with tree cards, since the tree merges/auto-folds some seats. */
  pos: string | null;
}

export type PreflopLineOutcome =
  | { ok: true; line: PreflopStep[]; heroHand: string | null; toCall: number }
  | { ok: false; reason: string };

export const handToPreflopLine = (hand: ParsedHand): PreflopLineOutcome => {
  const node = hand.currentNode;
  if (hand.ended || !node.toActIsHero || node.street !== "preflop") {
    return { ok: false, reason: "Hero isn't facing a preflop decision." };
  }
  if (hand.actions.some((a) => a.hero && a.type === "fold")) {
    return { ok: false, reason: "Hero folded — nothing to solve." };
  }

  const line: PreflopStep[] = [];
  for (const a of hand.actions) {
    if (a.street !== "preflop") continue;
    if (a.type === "post-sb" || a.type === "post-bb") continue; // implicit in the tree
    if (a.type === "check") continue; // BB option checks aren't tree decisions before hero acts
    const kind =
      a.type === "all-in" ? "allin" : a.type === "bet" ? "raise" : a.type;
    if (kind !== "fold" && kind !== "call" && kind !== "raise" && kind !== "allin") {
      return { ok: false, reason: `Unexpected preflop action "${a.type}".` };
    }
    line.push({
      kind,
      sizeBb: a.amount ?? null,
      hero: a.hero,
      seatId: a.seatId,
      pos: hand.positions[a.seatId] ?? null,
    });
  }

  const heroCards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c));
  return {
    ok: true,
    line,
    heroHand: heroCards.length === 2 ? heroCards.join("") : null,
    toCall: node.toCall,
  };
};
