/**
 * THE POSTFLOP LAST RESORT AT THE TABLE'S STACKS (2026-09-25, hand 4920544353, Ignition NL5 6-max). Hero CO (100bb)
 * opens 2.6, the BTN (dealt 34.2), SB (52.4) and BB (34) call: a four-way flop 6s8hKs, 10.4 in the pot, the field's
 * effective stack 49.8 (hero against the SB). Flop: SB checks, BB bets 1, hero calls, BTN raises to 10, both blinds
 * fold, hero calls. Turn Qh: hero checks, the BTN jams his last 21.6. Every collapse hit GTO Wizard's daily cap, so
 * the last resort answered: hero against the BTN, heads-up at the turn — at 39.8 behind, the field's number, where
 * the BTN had 21.6. His jam went in as a bet with chips behind it and the answer was "ALLIN 39.8 100%" against a
 * player who was already all-in. Pure: no charts, no cloud.
 */
import { describe, expect, test } from "bun:test";
import { flopSeatStacks, heroVsAggressor } from "./fastSolve";

const ordered = ["SB", "BB", "CO", "BTN"];
const arr = () => new Array(1326).fill(1);
const FLOP = ["X", "R1", "C", "R10", "F", "F", "C"];
const FLOP_SEATS = ["SB", "BB", "CO", "BTN", "SB", "BB", "CO"];
// each seat's own stack entering the flop: dealt − the 2.6 every flop seat put in preflop
const behind = { SB: 49.8, BB: 31.4, CO: 97.4, BTN: 31.6 };
const base = { ordered, heroPos: "CO", arr, flopPot: 10.4, flopStack: 49.8, behind };

describe("flopSeatStacks: each flop seat's own stack from the pinned dealt stacks", () => {
  test("dealt − the preflop level (depth − flopStack)", () => {
    expect(flopSeatStacks({
      seats: ordered, depth: 52.4, flopStack: 49.8, dealtByPos: { SB: 52.4, BB: 34, CO: 100, BTN: 34.2 },
      streets: [FLOP, ["X", "R21.6"]], streetSeats: [FLOP_SEATS, ["CO", "BTN"]],
    })).toEqual(behind);
  });
  test("a reading the hand contradicts (the BTN raised to more than it leaves him) is left out, never trusted", () => {
    const got = flopSeatStacks({
      seats: ordered, depth: 52.4, flopStack: 49.8, dealtByPos: { SB: 52.4, BB: 34, CO: 100, BTN: 8 },
      streets: [FLOP], streetSeats: [FLOP_SEATS],
    });
    expect(got).toEqual({ SB: 49.8, BB: 31.4, CO: 97.4 });
  });
  test("no dealt stacks at all: undefined (every tree keeps the field's stack)", () => {
    expect(flopSeatStacks({ seats: ordered, depth: 52.4, flopStack: 49.8, dealtByPos: {}, streets: [FLOP], streetSeats: [FLOP_SEATS] })).toBeUndefined();
  });
});

describe("heroVsAggressor plays hero against the aggressor at THEIR stacks", () => {
  test("the turn jam: 21.6 behind (the BTN's), and his 21.6 is the tree's all-in — fold or call, nothing else", () => {
    const lr = heroVsAggressor({ ...base, streets: [FLOP, ["X", "R21.6"]], streetSeats: [FLOP_SEATS, ["CO", "BTN"]] })!;
    expect(lr).not.toBeNull();
    expect(lr.villain).toBe("BTN");
    expect(lr.first).toBe(1);
    expect(lr.pot).toBe(31.4);            // 10.4 + the BB's 1 + 10 + 10
    expect(lr.stack).toBe(21.6);          // was 39.8: the field's 49.8 less the flop's 10
    expect(lr.bet).toBe(21.6);
    expect(lr.walkable.streets).toEqual([["X", "RAI"]]);
    expect(lr.walkable.seatSpec).toMatchObject({ oopPos: "CO", ipPos: "BTN", heroSeat: "oop" });
    expect(lr.walkable.seatStacks).toEqual({ CO: 87.4, BTN: 21.6 });
  });
  test("the same jam captured as an all-in action (RAI) is the BTN's 21.6, not the field's 39.8", () => {
    const lr = heroVsAggressor({ ...base, streets: [FLOP, ["X", "RAI"]], streetSeats: [FLOP_SEATS, ["CO", "BTN"]] })!;
    expect(lr.bet).toBe(21.6);
    expect(lr.stack).toBe(21.6);
    expect(lr.walkable.streets).toEqual([["X", "RAI"]]);
  });
  test("the turn checked to hero: solved at 21.6 behind", () => {
    const lr = heroVsAggressor({ ...base, streets: [FLOP, []], streetSeats: [FLOP_SEATS, []] })!;
    expect(lr.villain).toBe("BTN");
    expect(lr.stack).toBe(21.6);
    expect(lr.pot).toBe(31.4);
  });
  test("the flop raise: the folded BB's 1bb stays in the pot, and the BTN has 30.6 behind hero's call", () => {
    const lr = heroVsAggressor({ ...base, streets: [FLOP.slice(0, 6)], streetSeats: [FLOP_SEATS.slice(0, 6)] })!;
    expect(lr.villain).toBe("BTN");
    expect(lr.others).toEqual(["BB"]);
    expect(lr.dead).toBe(1);
    expect(lr.pot).toBe(13.4);            // 10.4 + BB's 1 + hero's 1 + the BTN's matching 1 (was 12.4: the BB's bet lost)
    expect(lr.bet).toBe(9);
    expect(lr.stack).toBe(30.6);          // the BTN's 31.6 less the 1 both have in (was 48.8)
    expect(lr.walkable.streets).toEqual([["X", "R9"]]);
  });
  test("a bet that covers hero is hero's all-in", () => {
    const lr = heroVsAggressor({ ...base, behind: { ...behind, CO: 15 }, streets: [FLOP, ["X", "R21.6"]], streetSeats: [FLOP_SEATS, ["CO", "BTN"]] })!;
    expect(lr.stack).toBe(5);             // hero had 15, 10 of it went in on the flop
    expect(lr.bet).toBe(5);
    expect(lr.walkable.streets).toEqual([["X", "RAI"]]);
  });
  test("without seat stacks the field's number stands (the old model), the dead money is still counted", () => {
    const lr = heroVsAggressor({ ...base, behind: undefined, streets: [FLOP, ["X", "R21.6"]], streetSeats: [FLOP_SEATS, ["CO", "BTN"]] })!;
    expect(lr.stack).toBe(39.8);
    expect(lr.walkable.streets).toEqual([["X", "R21.6"]]);
    const flop = heroVsAggressor({ ...base, behind: undefined, streets: [FLOP.slice(0, 6)], streetSeats: [FLOP_SEATS.slice(0, 6)] })!;
    expect(flop.pot).toBe(13.4);
  });
});
