import { describe, expect, test } from "bun:test";
import { coverGroups, moneyThrough } from "./multiwayReroot";

describe("moneyThrough", () => {
  test("a bet and three calls on the flop: every seat's chips are pot entering the turn", () => {
    const m = moneyThrough([["R3", "C", "C", "C"], ["X"]], [["SB", "BB", "CO", "BTN"], ["SB"]], 6, 97, 1);
    expect(m.pot).toBe(18);
    expect(m.stack).toBe(94);
    expect([...m.aggressors]).toEqual(["SB"]);
    expect(m.folded.size).toBe(0);
  });
  test("a raise and a fold: the raiser's level is what the stack pays, the folder leaves", () => {
    const m = moneyThrough([["R3", "R9", "F", "C"]], [["SB", "BB", "CO", "BTN"]], 6, 97, 1);
    expect(m.pot).toBe(6 + 3 + 9 + 9);   // SB's 3 stays in, BB and BTN put in 9
    expect(m.stack).toBe(88);
    expect(m.folded.has("CO")).toBe(true);
  });
});

describe("coverGroups", () => {
  test("hero between: every walk keeps hero and the flop bettor, the callers are covered one per walk", () => {
    expect(coverGroups(["SB", "BB", "CO", "BTN"], "BB", new Set(["SB"]))).toEqual([["BB", "SB", "CO"], ["BB", "SB", "BTN"]]);
  });
  test("no aggressor (a checked-through street): two callers per walk", () => {
    expect(coverGroups(["SB", "BB", "CO", "BTN"], "CO", new Set())).toEqual([["CO", "SB", "BB"], ["CO", "BTN", "SB"]]);
  });
  test("three aggressors besides hero: no three-seat walk can hold them", () => {
    expect(coverGroups(["SB", "BB", "CO", "BTN"], "BTN", new Set(["SB", "BB", "CO"]))).toBeNull();
  });
});
