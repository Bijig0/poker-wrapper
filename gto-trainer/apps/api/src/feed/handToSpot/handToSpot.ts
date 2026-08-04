/**
 * handToSpot
 * ----------
 * Map a hand (live from assistive-play's /state, or recovered by
 * parsePanelFeed) onto the GTO Wizard node-navigation contract the trainer
 * already implements: setupSpot({setId, depth, heroSeat, villainSeat, potType})
 * → setCards(flop) → respondToBet(heroHand, sizePct).
 *
 * Situations the navigator can't reach (limped pots, 4-bet+ pots, multiway
 * flops, preflop decisions) come back as { ok: false, reason } — the same
 * recognized-but-unsupported philosophy the WASM solver service uses.
 */

import { toShortCard, type ParsedHand, type Street } from "../parsePanelFeed/parsePanelFeed";

export interface SpotSpec {
  setId: string;
  depth: number;
  heroSeat: string;
  villainSeat: string;
  potType: "SRP" | "3bet";
  /** Flop cards, space-separated short form ("Ad 7c 2h") — what setCards takes. */
  board: string;
  /** Full board seen so far (for display / later streets). */
  fullBoard: string;
  /** Hero's holding as respondToBet expects it ("As5c"), null if unknown. */
  heroHand: string | null;
  /** Street the decision is on. */
  street: Street;
  /** Villain's bet as % of the pot BEFORE the bet, when hero faces a bet. */
  villainBetPct: number | null;
  /** The hand's actual preflop open size (BB) — picks the nearest tree size. */
  openSize: number | null;
  /** The hand's actual 3-bet size (BB), when the pot is 3-bet. */
  threeBetSize: number | null;
  toAct: "hero" | "villain" | "closed";
}

export type SpotOutcome =
  | { ok: true; spot: SpotSpec; notes: string[] }
  | { ok: false; reason: string };

export interface SpotOptions {
  setId?: string;
  depth?: number;
  /** Override when the feed never showed hero posting (position unknowable). */
  heroPos?: string;
  /** Library depths to snap the stack-derived depth to (defaults to 6-max's). */
  availableDepths?: number[];
}

const DEFAULT_DEPTHS = [20, 40, 50, 75, 100, 150, 200];

export const handToSpot = (hand: ParsedHand, opts: SpotOptions = {}): SpotOutcome => {
  const notes: string[] = [];
  const setId = opts.setId ?? "6max";

  // --- hero position ---------------------------------------------------------
  let heroPos = opts.heroPos ?? null;
  if (!heroPos) {
    const post = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
    if (post) heroPos = post.type === "post-sb" ? "SB" : "BB";
  }
  if (!heroPos && hand.heroSeatId >= 0 && hand.positions[hand.heroSeatId]) {
    heroPos = hand.positions[hand.heroSeatId]!;
  }
  if (!heroPos) {
    return { ok: false, reason: "Hero's position is unknown — it never appears in the rows. Pass heroPos explicitly." };
  }

  // --- who is still in the hand ---------------------------------------------
  const folded = new Set(hand.actions.filter((a) => a.type === "fold" && !a.hero).map((a) => a.seatId));
  if (hand.actions.some((a) => a.hero && a.type === "fold")) {
    return { ok: false, reason: "Hero folded — nothing to solve." };
  }
  const seen = new Set(hand.actions.filter((a) => !a.hero).map((a) => a.seatId));
  const villains = [...seen].filter((id) => !folded.has(id));

  const street = hand.currentNode.complete ? hand.street : hand.currentNode.street;
  if (street === "preflop") {
    return { ok: false, reason: "The decision is preflop — the trainer flow starts at a dealt flop." };
  }
  if (villains.length !== 1) {
    return {
      ok: false,
      reason:
        villains.length === 0
          ? "No live villain found in the action rows."
          : `${villains.length + 1} players reach the flop — GTO Wizard postflop nodes are heads-up only.`,
    };
  }
  const villainSeatId = villains[0]!;
  const villainSeat = hand.positions[villainSeatId];
  if (!villainSeat) {
    return { ok: false, reason: `Villain (seat ${villainSeatId + 1}) has no position label in the rows.` };
  }
  if (villainSeat === heroPos) {
    return { ok: false, reason: `Hero and villain both map to ${heroPos} — position labels are inconsistent.` };
  }

  // --- depth: explicit > derived from the players' stacks > 100bb ------------
  // Effective stack = the smaller of hero's and villain's stacks (other seats'
  // stacks are irrelevant once they fold), snapped to the nearest library depth.
  const depths = opts.availableDepths?.length ? opts.availableDepths : DEFAULT_DEPTHS;
  let depth = opts.depth ?? 0;
  if (!depth) {
    const relevant = [hand.stacks?.[hand.heroSeatId], hand.stacks?.[villainSeatId]].filter(
      (s): s is number => Number.isFinite(s) && (s as number) > 0
    );
    if (relevant.length) {
      const effective = Math.min(...relevant);
      depth = depths.reduce((a, b) => (Math.abs(b - effective) < Math.abs(a - effective) ? b : a));
      notes.push(`Effective stack ≈ ${effective}bb from the hand — using the ${depth}bb library.`);
    } else {
      depth = 100;
      notes.push("Stack depth not in the feed — defaulted to 100bb.");
    }
  }

  // --- pot type + actual sizes from the preflop raises -----------------------
  const raiseActions = hand.actions.filter(
    (a) => a.street === "preflop" && (a.type === "raise" || a.type === "all-in")
  );
  const raises = raiseActions.length;
  let potType: "SRP" | "3bet";
  if (raises === 1) potType = "SRP";
  else if (raises === 2) potType = "3bet";
  else if (raises === 0) {
    return { ok: false, reason: "Limped pot — the spot navigator only walks SRP and 3-bet preflop lines." };
  } else {
    return { ok: false, reason: `${raises} preflop raises (4-bet+) — the spot navigator only walks SRP and 3-bet lines.` };
  }
  const openSize = raiseActions[0]?.amount ?? null;
  const threeBetSize = potType === "3bet" ? raiseActions[1]?.amount ?? null : null;
  if (openSize != null) {
    notes.push(
      `Preflop sizes from the hand: open to ${openSize}bb${threeBetSize != null ? `, 3-bet to ${threeBetSize}bb` : ""} — nearest tree sizes will be used.`
    );
  }

  // --- board -----------------------------------------------------------------
  const board = hand.board.map(toShortCard);
  if (board.length < 3) {
    return { ok: false, reason: "No full flop on the board yet." };
  }
  if (street !== "flop") {
    notes.push(
      `The decision is on the ${street.toUpperCase()} — auto-navigation deals the flop; walk the remaining streets in the trainer.`
    );
  }

  // --- hero hand -------------------------------------------------------------
  const heroCards = hand.heroCards.map(toShortCard).filter((c) => /^[2-9TJQKA][shdc]$/.test(c));
  const heroHand = heroCards.length === 2 ? heroCards.join("") : null;
  if (!heroHand) notes.push("Hero's cards aren't readable — navigation can open the node but not read a combo strategy.");

  // --- facing a bet? ---------------------------------------------------------
  const node = hand.currentNode;
  let villainBetPct: number | null = null;
  if (!node.complete && node.toActIsHero && node.toCall > 0) {
    const potBefore = node.pot - node.toCall;
    if (potBefore > 0) {
      villainBetPct = Math.round((node.toCall / potBefore) * 1000) / 10;
    } else {
      notes.push("Pot/toCall in the live line don't reconcile — facing-bet size not derived.");
    }
  }

  const toAct: SpotSpec["toAct"] = node.complete ? "closed" : node.toActIsHero ? "hero" : "villain";

  return {
    ok: true,
    notes,
    spot: {
      setId,
      depth,
      heroSeat: heroPos,
      villainSeat,
      potType,
      board: board.slice(0, 3).join(" "),
      fullBoard: board.join(" "),
      heroHand,
      street,
      villainBetPct,
      openSize,
      threeBetSize,
      toAct,
    },
  };
};
