import { describe, expect, test } from "bun:test";
import { heroAwardCents, summarizeHand } from "./handSummary";
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
  // hand 4922314918 (session_20261003_153908): BTN raises 2.6, BB calls; turn 1/1; river BB bets 19.2, hero shoves
  // 242.4, BB all-in for 24.6. Ignition returned hero's uncalled 217.8: hero put in 28.2 and won a 56.4 pot
  test("the uncalled part of a shove comes back to the seat that made it", () => {
    const s = summarizeHand(normalizeHand({
      handId: 4028, heroSeatId: 4, heroCards: ["Jd", "9d"], board: ["5h", "5d", "7h", "Td", "2d"], street: "river", ended: true,
      liveSeats: [4, 6], positions: { 4: "BTN", 5: "SB", 6: "BB" },
      actions: [
        { seatId: 5, hero: false, type: "post-sb", street: "preflop", amount: 0.4 },
        { seatId: 6, hero: false, type: "post-bb", street: "preflop", amount: 1 },
        { seatId: 4, hero: true, type: "raise", street: "preflop", amount: 2.6 },
        { seatId: 5, hero: false, type: "fold", street: "preflop" },
        { seatId: 6, hero: false, type: "call", street: "preflop", amount: 1.6 },
        { seatId: 6, hero: false, type: "bet", street: "turn", amount: 1 },
        { seatId: 4, hero: true, type: "call", street: "turn", amount: 1 },
        { seatId: 6, hero: false, type: "bet", street: "river", amount: 19.2 },
        { seatId: 4, hero: true, type: "raise", street: "river", amount: 242.4 },
        { seatId: 6, hero: false, type: "all-in", street: "river", amount: 24.6 },
      ],
      currentNode: { street: "river", toActIsHero: false, complete: true },
    }).hand);
    expect(s.heroInvestedBb).toBeCloseTo(28.2, 2);
    expect(s.potBb).toBeCloseTo(0.4 + 28.2 + 28.2, 2);
  });


  test("K9o hand: investments, pot, stats flags", () => {
    const s = summarizeHand(k9());
    // hero: raise-to 3 preflop, bet 1.52 flop, call 2.84 turn, bet 6 river
    expect(s.heroInvestedBb).toBeCloseTo(3 + 1.52 + 2.84 + 6, 2);
    // villain BB: 1 post + 2 call = 3 preflop, 1.52 flop, 2.84 turn, 32 river — of which the 26 hero never
    // called comes back to him, so the pot is what both put in up to hero's 6
    expect(s.potBb).toBeCloseTo(13.36 + 3 + 1.52 + 2.84 + 6, 2);
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
    // pot: hero raise-to 15 + limper 1 + sb raise-to 5, less the 10 of hero's 3-bet nobody called
    expect(s.potBb).toBeCloseTo(15 + 1 + 5 - 10, 2);
    expect(s.heroInvestedBb).toBeCloseTo(5, 2);
  });
});

describe("heroAwardCents", () => {
  // hand 4922307385: the board played, a chop — the archived result kept seat 2's line only
  test("a split pot credits hero's own line from the feed", () => {
    const raw = {
      feedLines: ["Seat 2 shows 2♣ Q♣", "★ Player 2 wins main pot ($0.09) with (Two pair, aces and eights).", "★ Player 3 wins main pot ($0.10) with (Two pair, aces and eights)."],
      result: { text: "★ Player 2 wins main pot ($0.09) with (Two pair, aces and eights).", winnerSeat: 2, wonCents: 9 },
    };
    expect(heroAwardCents(raw, 3)).toBe(10);
    expect(heroAwardCents(raw, 2)).toBe(9);
  });
  test("main and side pot add up; a nameless line names nobody", () => {
    expect(heroAwardCents({ feedLines: ["★ Player 4 wins main pot ($3.39) with (Flush).", "★ Player 4 wins side pot ($1.00) with (Flush)."] }, 4)).toBe(439);
    expect(heroAwardCents({ result: { text: "★ wins main pot ($0.50) with (Two pair)." } }, 4)).toBeNull();
    expect(heroAwardCents({ result: { text: "★ Player 1 wins ($1,234.50)." } }, 4)).toBe(0);
  });
});
