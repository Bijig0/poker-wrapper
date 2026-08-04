import { describe, expect, test } from "bun:test";
import { summarizeHand } from "./handSummary";
import { normalizeHand } from "../../feed/normalizeHand/normalizeHand";

// The K9o SB-vs-BB hand (2026-07-30 audit hand 11): raise 3 called, flop bet
// 1.52 called, turn x/b2.84/call, river lead 6 raised to 32, hero folds.
const k9 = () =>
  normalizeHand({
    handId: 11,
    heroSeatId: 1,
    heroCards: ["Kh", "9d"],
    board: ["7c", "Kd", "Ah", "8c", "3s"],
    street: "river",
    ended: true,
    liveSeats: [1, 2, 3],
    positions: { 1: "SB", 2: "BB", 3: "BTN" },
    actions: [
      { seatId: 1, hero: true, type: "post-sb", street: "preflop", amount: 0.5 },
      { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
      { seatId: 3, hero: false, type: "fold", street: "preflop" },
      { seatId: 1, hero: true, type: "raise", street: "preflop", amount: 3 },
      { seatId: 2, hero: false, type: "call", street: "preflop", amount: 2 },
      { seatId: 1, hero: true, type: "bet", street: "flop", amount: 1.52 },
      { seatId: 2, hero: false, type: "call", street: "flop", amount: 1.52 },
      { seatId: 1, hero: true, type: "check", street: "turn" },
      { seatId: 2, hero: false, type: "bet", street: "turn", amount: 2.84 },
      { seatId: 1, hero: true, type: "call", street: "turn", amount: 2.84 },
      { seatId: 1, hero: true, type: "bet", street: "river", amount: 6 },
      { seatId: 2, hero: false, type: "raise", street: "river", amount: 32 },
      { seatId: 1, hero: true, type: "fold", street: "river" },
    ],
    currentNode: { street: "river", toActIsHero: false, complete: true },
  }).hand;

describe("summarizeHand", () => {
  test("K9o hand: investments, pot, stats flags", () => {
    const s = summarizeHand(k9());
    // hero: raise-to 3 preflop, bet 1.52 flop, call 2.84 turn, bet 6 river
    expect(s.heroInvestedBb).toBeCloseTo(3 + 1.52 + 2.84 + 6, 2);
    // villain BB: 1 post + 2 call = 3 preflop, 1.52 flop, 2.84 turn, 32 river
    expect(s.potBb).toBeCloseTo(13.36 + 3 + 1.52 + 2.84 + 32, 2);
    expect(s.vpip).toBe(true);
    expect(s.pfr).toBe(true);
    expect(s.threeBet).toBe(false);
    expect(s.threeBetOpp).toBe(false);
    expect(s.limpedPot).toBe(false);
    expect(s.heroFolded).toBe(true);
    expect(s.heroWonUncontested).toBe(false);
    expect(s.sawFlop).toBe(true);
    expect(s.heroPos).toBe("SB");
    expect(s.tableSeats).toBe(3);
    expect(s.heroStreets).toEqual(["preflop", "flop", "turn", "river"]);
  });

  test("open-limped pot + 3-bet opportunity flags", () => {
    const hand = normalizeHand({
      handId: 1,
      heroSeatId: 6,
      heroCards: ["As", "Ad"],
      board: [],
      street: "preflop",
      ended: true,
      liveSeats: [1, 5, 6],
      positions: { 1: "UTG", 5: "SB", 6: "BB" },
      actions: [
        { seatId: 5, hero: false, type: "post-sb", street: "preflop", amount: 0.5 },
        { seatId: 6, hero: true, type: "post-bb", street: "preflop", amount: 1 },
        { seatId: 1, hero: false, type: "call", street: "preflop", amount: 1 },
        { seatId: 5, hero: false, type: "raise", street: "preflop", amount: 5 },
        { seatId: 6, hero: true, type: "raise", street: "preflop", amount: 15 },
        { seatId: 1, hero: false, type: "fold", street: "preflop" },
        { seatId: 5, hero: false, type: "fold", street: "preflop" },
      ],
      currentNode: { street: "preflop", toActIsHero: false, complete: true },
    }).hand;
    const s = summarizeHand(hand);
    expect(s.limpedPot).toBe(true);
    expect(s.threeBetOpp).toBe(true);
    expect(s.threeBet).toBe(true);
    expect(s.heroWonUncontested).toBe(true);
    // pot: sb 0.5 + hero raise-to 15 + limper 1 + sb raise-to 5
    expect(s.potBb).toBeCloseTo(15 + 1 + 5, 2);
  });
});
