import { describe, expect, test } from "bun:test";
import { loneSbComplete } from "./fastSolve";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/** A lone SB complete — folded to the SB, who completes, hero's option in the BB — is the exact tree's (2026-10-09). */
const SEAT = { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 } as const;
type Pp = keyof typeof SEAT;
const hand = (heroPos: Pp, acts: [Pp, string, number?][], seats: Pp[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"]): ParsedHand => {
  const hero = SEAT[heroPos];
  const a = (pos: Pp, type: string, amount?: number) => ({ seatId: SEAT[pos], hero: SEAT[pos] === hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
  const positions = Object.fromEntries(seats.map((p) => [SEAT[p], p]));
  const stacks = Object.fromEntries(seats.map((p) => [SEAT[p], 100]));
  return {
    handId: 1, clientHandId: "lone-sb", bbCents: 200, heroSeatId: hero, heroCards: ["Ah", "Td"], board: [], street: "preflop",
    actions: [a("SB", "post-sb", 0.5), a("BB", "post-bb", 1), ...acts.map(([p, t, x]) => a(p, t, x))],
    liveSeats: seats.map((p) => SEAT[p]), committed: {}, potByStreet: {}, positions, stacks, startStacks: { ...stacks },
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 1.5, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
};

describe("loneSbComplete", () => {
  test("folded to the SB, who completes, hero the BB: yes — 6, 5 and 4 handed", () => {
    expect(loneSbComplete(hand("BB", [["UTG", "fold"], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "call", 0.5]]), "BB")).toBe(true);
    expect(loneSbComplete(hand("BB", [["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "call", 0.5]], ["HJ", "CO", "BTN", "SB", "BB"]), "BB")).toBe(true);
    expect(loneSbComplete(hand("BB", [["CO", "fold"], ["BTN", "fold"], ["SB", "call", 0.5]], ["CO", "BTN", "SB", "BB"]), "BB")).toBe(true);
  });
  test("not: a limper ahead of the complete, the SB raising, hero the SB first in, a 3-handed table, hero already acted", () => {
    expect(loneSbComplete(hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "call", 0.5]]), "BB")).toBe(false);
    expect(loneSbComplete(hand("BB", [["UTG", "fold"], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "raise", 3]]), "BB")).toBe(false);
    expect(loneSbComplete(hand("SB", [["UTG", "fold"], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"]]), "SB")).toBe(false);
    expect(loneSbComplete(hand("BB", [["BTN", "fold"], ["SB", "call", 0.5]], ["BTN", "SB", "BB"]), "BB")).toBe(false);
    expect(loneSbComplete(hand("BB", [["UTG", "fold"], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "call", 0.5], ["BB", "check"]]), "BB")).toBe(false);
  });
});
