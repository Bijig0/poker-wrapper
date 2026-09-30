import { describe, expect, it } from "bun:test";
import { lineOf, shapeOf } from "./gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * Hand 4921657513 (session_20260930_150739, table 2, 16:15 local): five dealt, HJ opens 2.6, the CO shoves his 12.2bb,
 * hero (BTN, KcJd) is on the clock. The tree used to round every stack to the half-blind, giving the CO 12bb: its only
 * raise there is the all-in R12, and the line 'R2.6-R12.2' asks for more than his tree stack — GTO Wizard answered
 * 400 VALIDATION_ERROR "Incorrect actions", which reads as a capture fault, so nothing answered and hero timed out.
 * Replayed 2026-09-30: the same tree + line still fails; with the exact 12.2 stack the same line answers
 * (BTN Fold 95.8 / Call 4.2). The wrapper exported seat 6 as "0 BB" behind with 12.2 in front.
 */
const hand: ParsedHand = {
  handId: 83, clientHandId: "4921657513", bbCents: 5, heroSeatId: 2,
  heroCards: ["Kc", "Jd"], board: [], street: "preflop",
  actions: [
    { seatId: 3, hero: false, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 4, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 5, hero: false, type: "raise", amount: 2.6, street: "preflop" },
    { seatId: 6, hero: false, type: "raise", amount: 12.2, street: "preflop" },
  ],
  liveSeats: [2, 3, 4, 5, 6],
  committed: { 3: 0.4, 4: 1, 5: 2.6, 6: 12.2 },
  potByStreet: {},
  positions: { 2: "BTN", 3: "SB", 4: "BB", 5: "HJ", 6: "CO" },
  stacks: { 1: 30, 2: 153.8, 3: 87.4, 4: 98.4, 5: 223.4, 6: 0 },
  currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 0, toCall: 12.2, legalActions: [], complete: false },
  ended: false,
};

describe("shapeOf — a seat all in keeps its exact stack", () => {
  it("the CO's 12.2bb shove is a 12.2 tree stack, the others still round to the half-blind", () => {
    const s = shapeOf(hand, null);
    if ("error" in s) throw new Error(s.error);
    expect(s.positions).toEqual(["HJ", "CO", "BTN", "SB", "BB"]);
    expect(s.stacks.CO).toBe(12.2);
    expect(s.stacks.HJ).toBe(226);      // 223.4 + 2.6
    expect(s.stacks.BB).toBe(99.5);     // 98.4 + 1 = 99.4 → half-blind
    expect(s.stacks.BTN).toBe(154);     // 153.8 → half-blind
    expect(lineOf(hand, s).tokens.join("-")).toBe("R2.6-R12.2");
  });

  it("the same reading from the pinned dealt stacks (a postflop resume)", () => {
    const s = shapeOf(hand, null, 0, undefined, { 2: 153.8, 3: 87.8, 4: 99.4, 5: 226, 6: 12.2 });
    if ("error" in s) throw new Error(s.error);
    expect(s.stacks.CO).toBe(12.2);
    expect(s.stacks.HJ).toBe(226);
  });

  it("a shove a few chips short of the rounded figure is not rounded past what he put in", () => {
    const h: ParsedHand = { ...hand, stacks: { ...hand.stacks, 6: 0 }, committed: { ...hand.committed, 6: 12.3 },
      actions: hand.actions.map((a) => (a.seatId === 6 ? { ...a, amount: 12.3 } : a)) };
    const s = shapeOf(h, null);
    if ("error" in s) throw new Error(s.error);
    expect(s.stacks.CO).toBe(12.3);
  });
});
