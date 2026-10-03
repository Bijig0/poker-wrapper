import { describe, expect, test } from "bun:test";
import { coverGroups, moneyThrough } from "./multiwayReroot";

const line = (streets: string[][], streetSeats: string[][], o: { behind?: Record<string, number>; amounts?: (number | null)[][]; heroPos?: string } = {}) =>
  ({ ordered: ["SB", "BB", "CO", "BTN"], heroPos: o.heroPos ?? "BTN", streets, streetSeats, flopPot: 6, flopStack: 97, ...o });
describe("moneyThrough (utils/tableMoney)", () => {
  test("a bet and three calls on the flop: every seat's chips are pot entering the turn", () => {
    const m = moneyThrough(line([["R3", "C", "C", "C"], ["X"]], [["SB", "BB", "CO", "BTN"], ["SB"]]), 1);
    expect(m.pot).toBe(18);
    expect(m.stack).toBe(94);
    expect([...m.aggressors]).toEqual(["SB"]);
    expect(m.folded.size).toBe(0);
  });
  test("a raise and a fold: the raiser's level is what the stack pays, the folder leaves", () => {
    const m = moneyThrough(line([["R3", "R9", "F", "C"]], [["SB", "BB", "CO", "BTN"]]), 1);
    expect(m.pot).toBe(6 + 3 + 9 + 9);   // SB's 3 stays in, BB and BTN put in 9
    expect(m.stack).toBe(88);
    expect(m.folded.has("CO")).toBe(true);
  });
  test("an earlier-street all-in at the TABLE's amount, not the seat's whole stack (2026-10-03)", () => {
    const m = moneyThrough(line([["RAI", "C", "C", "C"]], [["SB", "BB", "CO", "BTN"]], { behind: { SB: 40, BB: 97, CO: 97, BTN: 97 }, amounts: [[25, null, null, null]] }), 1);
    expect(m.pot).toBe(6 + 25 * 4);
    expect(m.behind.SB).toBe(15);           // was 0: the RAI put in his whole 40
    expect(m.allIn.size).toBe(0);
  });
  test("an uncalled excess goes back; each seat's own stack, not capped by the field's", () => {
    const m = moneyThrough(line([["R50", "C", "F", "F"]], [["SB", "BB", "CO", "BTN"]], { behind: { SB: 150, BB: 30, CO: 97, BTN: 97 }, heroPos: "SB" }), 1);
    expect(m.pot).toBe(6 + 30 + 30);        // SB's 20 over the BB's 30 is returned
    expect(m.behind.SB).toBe(120);
    expect([...m.allIn]).toEqual(["BB"]);
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

describe("rerootCollapse — a seat all-in since an earlier street", () => {
  test("leaves the all-in out of the narrowing groups (no more 'too many aggressors')", () => {
    // HJ bet the flop, CO jammed (all-in), BTN hero, BB caller: with CO out, one 3-seat group covers everyone
    expect(coverGroups(["BB", "HJ", "BTN"], "BTN", new Set(["HJ"]))).toEqual([["BTN", "HJ", "BB"]]);
    // with CO still counted as an aggressor it cannot be covered
    expect(coverGroups(["BB", "HJ", "CO", "BTN"], "BTN", new Set(["HJ", "CO"]))).toBeNull();
  });
});

describe("replayWithout", () => {
  test("the bettor's call of a removed jam is dropped", async () => {
    const { replayWithout } = await import("./multiwayReroot");
    // BB x, HJ bets 4, [CO jam removed], BTN c, BB c, HJ c
    expect(replayWithout(["X", "R4", "C", "C", "C"], ["BB", "HJ", "BTN", "BB", "HJ"])).toEqual(
      { toks: ["X", "R4", "C", "C"], seats: ["BB", "HJ", "BTN", "BB"] });
  });
  test("calls of removed jams with no bet left become checks", async () => {
    const { replayWithout } = await import("./multiwayReroot");
    expect(replayWithout(["C", "C", "C"], ["UTG", "HJ", "BTN"]).toks).toEqual(["X", "X", "X"]);
  });
  test("a raise over a removed jam stays a raise", async () => {
    const { replayWithout } = await import("./multiwayReroot");
    // BB x, CO bets 5, [BTN jam 27.5 removed], BB raises to 70
    expect(replayWithout(["X", "R5", "R70"], ["BB", "CO", "BB"]).toks).toEqual(["X", "R5", "R70"]);
  });
});
