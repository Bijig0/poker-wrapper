import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE SEATS THAT WERE DEALT (2026-09-25, round 2 of the input-mutation harness, `undealt-seat`). The wrapper labels
 * every OCCUPIED seat, sitting-out ones included (hand 937's BTN, seat 3: no start stack, never acted), so the
 * positions map can hold a seat that was never dealt a hand. e5d4cdd8 taught the AI tree (gtowAiPreflop.shapeOf) to
 * drop such a seat; everything else still counted labels: the rake cap (by players DEALT: $3 at 4-5, $4 at 6+) was
 * one player high, and a three-handed table with a sitting-out label routed to the 6-max charts as a four-handed one
 * although three-handed is the AI piece's by design.
 *
 * A labelled seat is undealt only when BOTH say so: it is missing from `liveSeats` (the wrapper's dealt list; other
 * sources send only the unfolded seats, so a missing seat alone proves nothing) AND it has no action this hand. Hero
 * is always dealt. Returns seat id → position label (upper-cased) for the dealt seats.
 */
export function dealtSeats(hand: ParsedHand, heroPos?: string | null): Map<number, string> {
  const live = new Set(hand.liveSeats ?? []);
  const acted = new Set(hand.actions.map((a) => (a.hero ? hand.heroSeatId : a.seatId)));
  const out = new Map<number, string>();
  for (const [k, p] of Object.entries(hand.positions ?? {})) {
    const s = Number(k);
    const undealt = live.size > 0 && !live.has(s) && !acted.has(s) && s !== hand.heroSeatId;
    if (!undealt) out.set(s, String(p).toUpperCase());
  }
  if (!out.has(hand.heroSeatId) && heroPos) out.set(hand.heroSeatId, heroPos.toUpperCase());
  return out;
}

/** How many players were dealt in: the labelled seats minus the ones that were not dealt, hero included. */
export const dealtCount = (hand: ParsedHand, heroPos?: string | null): number =>
  dealtSeats(hand, heroPos).size + (dealtSeats(hand, heroPos).has(hand.heroSeatId) ? 0 : 1);
