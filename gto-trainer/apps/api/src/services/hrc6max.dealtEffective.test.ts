/**
 * THE EFFECTIVE STACK IS AGAINST THE PLAYERS STILL IN (2026-09-25, round 2 of the input-mutation harness: a new
 * stack-behind check, 32 findings in 300 seeds + 300 pairs). dealtEffective — the depth every postflop tree seat is
 * modelled at — took the deepest "opponent not folded", and two kinds of seat that are not in the hand passed that
 * test: a seat whose preflop fold the tap lost (no action at all; seed 85 [missed-fold]: the solver played 99bb behind
 * where the table's effective was 94) and a labelled seat that was never dealt (seed 22 [undealt-seat]: 99.95 vs 89.45).
 * Pure: no charts.
 */
import { describe, expect, test } from "bun:test";
import { dealtEffective } from "./hrc6max";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const a = (seatId: number, type: string, amount?: number, hero = false) =>
  ({ seatId, hero, type, street: "preflop", ...(amount != null ? { amount } : {}) }) as ParsedHand["actions"][number];
// seats: 1 SB, 2 BB, 3 HJ (deep, 150), 4 CO (hero, 100), 5 BTN (95)
const hand = (actions: ParsedHand["actions"], liveSeats = [1, 2, 3, 4, 5]): ParsedHand => ({
  handId: 1, clientHandId: "t", heroSeatId: 4, heroCards: ["Ah", "Kd"], board: ["2c", "7d", "9s"], street: "flop",
  actions, liveSeats, committed: {}, potByStreet: {}, positions: { 1: "SB", 2: "BB", 3: "HJ", 4: "CO", 5: "BTN" },
  currentNode: { street: "flop", toActSeatId: 4, toActIsHero: true, pot: 6.5, toCall: 0, legalActions: [], complete: false }, ended: false,
}) as ParsedHand;
const dealt = { 1: 100, 2: 100, 3: 150, 4: 100, 5: 95 };
const line = [a(1, "post-sb", 0.5), a(2, "post-bb", 1), a(4, "raise", 2.5, true), a(5, "call", 2.5), a(1, "fold"), a(2, "fold")];

describe("dealtEffective — against the players still in", () => {
  test("the HJ folded (captured): hero's 100 against the BTN's 95", () => {
    expect(dealtEffective(hand([a(1, "post-sb", 0.5), a(2, "post-bb", 1), a(3, "fold"), ...line.slice(2)]), dealt)).toBe(95);
  });
  test("the HJ's fold was lost (no action at all): he is not an opponent — still 95, not 100", () => {
    expect(dealtEffective(hand(line), dealt)).toBe(95);
  });
  test("the HJ was never dealt (labelled, not in liveSeats, no action): not an opponent either", () => {
    expect(dealtEffective(hand(line, [1, 2, 4, 5]), dealt)).toBe(95);
  });
});
