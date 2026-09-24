/**
 * AN ALL-IN THAT DOES NOT RAISE THE PRICE IS A CALL (2026-09-25, round 2 of the input-mutation harness, range-level
 * oracle: preflop-node-mismatch, seed 2328 [jam]). A 25bb small blind went all-in for 25 facing the button's raise to
 * 25 — a call — and the token line read it "RAI", which every walk maps onto the node's jam: the 30bb short chart's
 * SB all-in to 30, a RAISE. Hero's JJ was then answered facing a five-bet that never happened.
 */
import { describe, expect, it } from "bun:test";
import { allInCalls, buildPreflopTokens, buildSpotSolutionTokens } from "./buildSolutionUrl";
import type { ParsedHand } from "../parsePanelFeed/parsePanelFeed";

const a = (seatId: number, type: string, amount?: number, street = "preflop", hero = false) =>
  ({ seatId, hero, type, street, ...(amount != null ? { amount } : {}) }) as ParsedHand["actions"][number];
// seats: 1 CO, 2 BTN, 3 SB (25bb), 4 BB, 6 HJ (hero)
const hand = (actions: ParsedHand["actions"], street = "preflop"): ParsedHand => ({
  handId: 2328, clientHandId: "mh-2328-jam", bbCents: 200, heroSeatId: 6, heroCards: ["Jd", "Jc"], board: street === "preflop" ? [] : ["5d", "9s", "4s"], street: street as never,
  actions, liveSeats: [1, 2, 3, 4, 6], committed: {}, potByStreet: {}, positions: { 1: "CO", 2: "BTN", 3: "SB", 4: "BB", 6: "HJ" },
  currentNode: { street: street as never, toActSeatId: 6, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false }, ended: false,
});
const seed2328 = [a(3, "post-sb", 0.5), a(4, "post-bb", 1), a(6, "raise", 2.5, "preflop", true), a(1, "raise", 10), a(2, "raise", 25), a(3, "all-in", 25), a(4, "fold")];

describe("allInCalls", () => {
  it("an all-in for exactly the price is a call; one that raises it is not", () => {
    const acts = [...seed2328, a(6, "all-in", 100, "preflop", true)];
    const calls = allInCalls(acts);
    expect(calls.has(acts[5]!)).toBe(true);    // SB all-in for 25 facing 25
    expect(calls.has(acts[7]!)).toBe(false);   // hero's jam to 100
  });
  it("an all-in for LESS than the price is a call; the price is per street", () => {
    const acts = [a(3, "post-sb", 0.5), a(4, "post-bb", 1), a(1, "raise", 2.5), a(4, "call", 1.5),
      a(4, "bet", 20, "flop"), a(1, "all-in", 15, "flop"), a(4, "check", undefined, "turn"), a(1, "all-in", 3, "turn")];
    const calls = allInCalls(acts);
    expect(calls.has(acts[5]!)).toBe(true);    // 15 all-in facing a 20 bet
    expect(calls.has(acts[7]!)).toBe(false);   // a new street: a 3bb all-in is a bet
  });
});

describe("the token lines read an all-in call as C", () => {
  it("preflop: the SB's all-in call is C, not RAI (seed 2328)", () => {
    expect(buildPreflopTokens(hand(seed2328), "HJ")).toEqual(["F", "R2.5", "R10", "R25", "C", "F"]);
  });
  it("postflop: an all-in for less than the bet is C", () => {
    const h = hand([a(3, "post-sb", 0.5), a(4, "post-bb", 1), a(6, "raise", 2.5, "preflop", true), a(1, "call", 2.5), a(2, "fold"), a(3, "fold"), a(4, "call", 1.5),
      a(4, "bet", 20, "flop"), a(1, "all-in", 15, "flop")], "flop");
    expect(buildSpotSolutionTokens(h, "HJ").flop).toEqual(["R20", "C"]);
  });
});
