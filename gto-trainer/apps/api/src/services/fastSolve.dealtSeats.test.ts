/**
 * A LABELLED SEAT THAT WAS NOT DEALT (2026-09-25, round 2 of the input-mutation harness, `undealt-seat`: 64
 * piece-routing and 92 rake-cap findings in 300 seeds + 300 pairs). The wrapper labels a sitting-out seat (hand 937's
 * BTN); e5d4cdd8 taught the AI tree to drop it, but the routing and the rake still counted labels. Pure: no charts.
 */
import { describe, expect, test } from "bun:test";
import { is3Handed, is6Handed, sixMaxRakeCapBb } from "./fastSolve";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const a = (seatId: number, type: string, amount?: number) =>
  ({ seatId, hero: false, type, street: "preflop", ...(amount != null ? { amount } : {}) }) as ParsedHand["actions"][number];
const hand = (positions: Record<number, string>, liveSeats: number[], actions = [a(5, "post-sb", 0.5), a(6, "post-bb", 1)]): ParsedHand => ({
  handId: 1, clientHandId: "t", heroSeatId: 4, heroCards: ["Ah", "Kd"], board: [], street: "preflop", actions, liveSeats,
  committed: {}, potByStreet: {}, positions,
  currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 1.5, toCall: 1, legalActions: [], complete: false }, ended: false,
}) as ParsedHand;

describe("the seats that were dealt decide the piece and the rake", () => {
  // harness seed 1 [undealt-seat]: CO (3) sitting out, BTN hero, SB, BB — three dealt
  const threeDealt = hand({ 3: "CO", 4: "BTN", 5: "SB", 6: "BB" }, [4, 5, 6]);
  test("three dealt with a sitting-out label is three-handed: the AI piece's, not the 6-max charts'", () => {
    expect(is6Handed(threeDealt, "BTN")).toBe(false);
    expect(is3Handed(threeDealt, "BTN")).toBe(true);
  });
  test("the rake cap follows the players dealt ($2 three-handed = 1bb at NL200), not the labels ($3)", () => {
    expect(sixMaxRakeCapBb(threeDealt, "BTN")).toBe(1);
    // six labels, five dealt: $3 = 1.5bb, not $4
    const fiveDealt = hand({ 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" }, [1, 3, 4, 5, 6]);
    expect(sixMaxRakeCapBb(fiveDealt, "BTN")).toBe(1.5);
  });
  // golden hands 4919260843 and 4919958663 (2026-09-19/22, answered from the 6-max charts then): six labels, the BTN
  // seat not in liveSeats and never acting — a sitting-out player on a dead button, five dealt. The first cut of the
  // dealt-seats rule asked for a DEALT BTN and sent both to the AI piece; the BTN position is still in the tree (folded)
  test("a dead button (the BTN label on a sitting-out seat, five dealt) is still the 6-max charts' table", () => {
    const deadButton = hand({ 1: "BB", 2: "UTG", 3: "HJ", 4: "CO", 5: "BTN", 6: "SB" }, [1, 2, 3, 4, 6],
      [a(6, "post-sb", 0.5), a(1, "post-bb", 1), a(2, "raise", 2.5)]);
    expect(is6Handed(deadButton, "CO")).toBe(true);
    expect(sixMaxRakeCapBb(deadButton, "CO")).toBe(1.5);        // five dealt: $3
  });
  test("a seat that acted was dealt even when liveSeats leaves it out (a source that sends unfolded seats only)", () => {
    const folded = hand({ 3: "CO", 4: "BTN", 5: "SB", 6: "BB" }, [4, 5, 6], [a(5, "post-sb", 0.5), a(6, "post-bb", 1), a(3, "fold")]);
    expect(is6Handed(folded, "BTN")).toBe(true);
    expect(sixMaxRakeCapBb(folded, "BTN")).toBe(1.5);
  });
});
