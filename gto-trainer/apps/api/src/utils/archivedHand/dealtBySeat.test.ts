import { describe, expect, test } from "bun:test";
import { dealtBySeat } from "./archivedHand";
import { dealtBySeat as fromHrc6max } from "../../services/hrc6max";
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

/** A 3-handed hand read on the TURN: preflop raise to 3 + call, flop bet 5 + call, turn: hero to act. */
const onTheTurn = (): ParsedHand => ({
  handId: 1, heroSeatId: 1, heroCards: ["As", "Kd"], board: ["2c", "7d", "9h", "Js"],
  positions: { 1: "BTN", 2: "SB", 3: "BB" },
  stacks: { 1: 92, 2: 92, 3: 99 },          // behind NOW (after 3 preflop + 5 on the flop for seats 1 and 2)
  committed: { 1: 0, 2: 0, 3: 0 },           // nothing in yet this round
  actions: [
    { seatId: 2, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 3, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: true, type: "raise", amount: 3, street: "preflop" },
    { seatId: 2, type: "call", amount: 2.5, street: "preflop" },
    { seatId: 3, type: "fold", street: "preflop" },
    { seatId: 2, type: "bet", amount: 5, street: "flop" },
    { seatId: 1, hero: true, type: "call", amount: 5, street: "flop" },
  ],
  currentNode: { street: "turn", toAct: 1 },
} as unknown as ParsedHand);

describe("dealtBySeat: each seat's stack as dealt, from live readings", () => {
  test("a hand first read on the turn counts the flop's chips too (the 3-max copy left them out)", () => {
    expect(dealtBySeat(onTheTurn())).toEqual({ 1: 100, 2: 100, 3: 100 });
  });

  test("hrc6max re-exports the same function (one implementation, not three)", () => {
    expect(fromHrc6max).toBe(dealtBySeat);
  });

  test("preflop: behind + this round, nothing earlier", () => {
    const h = onTheTurn();
    (h as any).currentNode = { street: "preflop" };
    (h as any).stacks = { 1: 97, 2: 97, 3: 99 };
    (h as any).committed = { 1: 3, 2: 3, 3: 1 };
    expect(dealtBySeat(h)).toEqual({ 1: 100, 2: 100, 3: 100 });
  });
});
