/**
 * The harness's solver-input oracle (inputMismatch) and its generator's legality — pure, no charts, no network: these
 * run in the plain `bun test`. The sweep itself is gated (mutationHarness.test.ts / .fixtures.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { inputMismatch, type Hand } from "./mutationHarness";

// seed 1333 [jam]: HJ opens 2.5, BTN calls, the 18bb SB jams, BB folds, HJ and BTN call
const jamHand: Hand = {
  seats: [{ id: 1, pos: "HJ", stack: 100 }, { id: 2, pos: "CO", stack: 96.5 }, { id: 3, pos: "BTN", stack: 112.1 },
    { id: 4, pos: "SB", stack: 18 }, { id: 5, pos: "BB", stack: 108.7 }, { id: 6, pos: "UTG", stack: 100 }],
  hero: 1, bbCents: 200, sbPost: 0.5, heroCards: ["Qd", "Ad"], board: ["Ks", "Kc", "Ts", "3h", "Ac"], ops: ["jam"],
  actions: [
    { street: 0, seat: 4, type: "post-sb", amount: 0.5 }, { street: 0, seat: 5, type: "post-bb", amount: 1 },
    { street: 0, seat: 6, type: "fold" }, { street: 0, seat: 1, type: "raise", amount: 2.5 }, { street: 0, seat: 2, type: "fold" },
    { street: 0, seat: 3, type: "call", amount: 2.5 }, { street: 0, seat: 4, type: "all-in", amount: 18 }, { street: 0, seat: 5, type: "fold" },
    { street: 0, seat: 1, type: "call", amount: 15.5 }, { street: 0, seat: 3, type: "call", amount: 15.5 },
  ],
};

describe("inputMismatch — the solver input against the dealt hand", () => {
  test("the right pot and the players who can act: no mismatch", () => {
    expect(inputMismatch(jamHand, { flopPot: 55, flopSeats: ["HJ", "BTN"] })).toBeNull();
  });
  test("a pot that lost a caller's chips is named", () => {
    expect(inputMismatch(jamHand, { flopPot: 39.5, flopSeats: ["HJ", "BTN"] })).toContain("flop pot is 39.5bb, the table's 55bb");
  });
  test("the all-in jammer modelled as a live flop seat is named (seed 1333's old three-way tree)", () => {
    expect(inputMismatch(jamHand, { flopPot: 55, flopSeats: ["HJ", "BTN", "SB"] })).toContain("flop seats are BTN/HJ/SB, the table's BTN/HJ");
  });
  test("a player who reached the flop missing from the input is named", () => {
    expect(inputMismatch(jamHand, { flopPot: 55, flopSeats: ["HJ"] })).toContain("the table's BTN/HJ");
  });
});
