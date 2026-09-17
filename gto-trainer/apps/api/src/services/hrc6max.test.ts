import { describe, expect, test } from "bun:test";
import { chartFor6max, openFromTokens, replayTokens6 } from "./hrc6max";

/**
 * The two ways a limped pot used to lose its answer, both found by replaying 1,653 real preflop decisions through
 * the picker (src/scripts/sixmaxBacktest.ts) and both fixed on 2026-09-16. They are worth a test because neither
 * failed loudly: the picker returned a perfectly reasonable chart id, and the line only died later, deep in the
 * walk, with 'action "C" not offered' - which reads like a tree problem rather than a routing one.
 */

/** Six seats, hero wherever you put him, every stack the same unless overridden. */
const table = (heroSeat: number, stacks: Partial<Record<number, number>> = {}) => ({
  heroSeatId: heroSeat,
  committed: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as Record<number, string>,
  stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, ...stacks } as Record<number, number>,
});

describe("openFromTokens", () => {
  test("a raise with nothing in front of it is that raise's tree", () => {
    expect(openFromTokens(["F", "F", "R2.5"])).toEqual({ open: 2.5, observed: 2.5 });
  });

  test("an off-tree raise snaps to the nearest solved size, and says what it saw", () => {
    expect(openFromTokens(["F", "R2.7"])).toEqual({ open: 2.5, observed: 2.7 });
  });

  test("a limp with no raise behind it is the limp tree", () => {
    expect(openFromTokens(["C", "F"])).toEqual({ open: "limp", observed: null });
  });

  test("a limp RAISED behind is still the limp tree - the raise is an iso", () => {
    // the bug: this returned { open: 3.5 }, a raise tree, whose opening node offers fold or raise and no call,
    // so the very first token of the line had nowhere to go
    expect(openFromTokens(["C", "R3.5"])).toEqual({ open: "limp", observed: 3.5 });
    expect(openFromTokens(["F", "C", "C", "R4"])).toEqual({ open: "limp", observed: 4 });
  });

  test("nobody in yet reads as the pool's most common open", () => {
    expect(openFromTokens(["F", "F"])).toEqual({ open: 2.5, observed: null });
  });
});

describe("chartFor6max", () => {
  test("an even table at a solved rung wants that rung's chart for the open it faces", () => {
    const c = chartFor6max(table(6) as any, "BB", ["F", "F", "F", "R3", "F"]);
    expect(c.id).toBe("ign200_6max_D100_o3");
    expect(c.candidates[0]).toBe("ign200_6max_D100_o3");
  });

  test("a limped pot only ever falls back to other LIMP charts", () => {
    // the second bug: the depth ladder swapped 2.5x in for "limp", offering raise trees that cannot hold a limp
    const c = chartFor6max(table(6) as any, "BB", ["C", "C", "F", "F", "F"]);
    expect(c.openSize).toBe("limp");
    expect(c.candidates.every((id) => id.endsWith("_olimp"))).toBe(true);
  });

  test("125bb limp - a chart we deliberately do not have - reaches the 100bb limp chart", () => {
    const deep = table(6, { 1: 125, 2: 125, 3: 125, 4: 125, 5: 125, 6: 125 });
    const c = chartFor6max(deep as any, "BB", ["C", "F", "F", "F", "F"]);
    expect(c.id).toBe("ign200_6max_D125_olimp");
    expect(c.candidates).toContain("ign200_6max_D100_olimp");
  });

  test("one short seat at a 100bb table takes the uneven chart for that seat", () => {
    const uneven = table(6, { 1: 30 });
    const c = chartFor6max(uneven as any, "BB", ["R2.5", "F", "F", "F", "F"]);
    expect(c.id).toBe("ign200_6max_D100_s30_UTG_o2_5");
    expect(c.shortSeat).toBe("UTG");
  });

  test("a limped pot at an uneven table uses the even limp chart, since the uneven set has no limp tree", () => {
    const uneven = table(6, { 1: 30 });
    const c = chartFor6max(uneven as any, "BB", ["C", "F", "F", "F", "F"]);
    expect(c.candidates.every((id) => id.endsWith("_olimp"))).toBe(true);
  });
});

/**
 * Rungs by effective stack (2026-09-17). Hero always reloads to 100bb, opponents cannot be made to: below 100bb only
 * the opponents still in the hand can set the rung, above it the rung is hero against the opponent that matters.
 * The old table-median rule put a reloaded hero on the 150bb chart at a deep table and ignored both shorts when a
 * 100bb table had two of them.
 */
describe("chartFor6max — effective stack, live seats", () => {
  test("a reloaded 100bb hero at a deep table is a 100bb spot, not the table's 150", () => {
    const t = table(4, { 1: 150, 2: 150, 3: 150, 4: 100, 5: 150, 6: 150 });
    const c = chartFor6max(t as any, "BTN", ["F", "R2.5", "F"]);
    expect(c.id).toBe("ign200_6max_D100_o2_5");
    expect(c.effective).toBe(100);
    expect(c.relevant).toBe("HJ");
  });

  test("a deep hero against a deep raiser is the deep chart; against a 100bb raiser it is the 100bb chart", () => {
    const deep = table(6, { 1: 150, 6: 150 });
    expect(chartFor6max(deep as any, "BB", ["R3", "F", "F", "F", "F"]).id).toBe("ign200_6max_D150_o3");
    const mixed = table(6, { 1: 100, 3: 150, 6: 150 });
    const c = chartFor6max(mixed as any, "BB", ["R3", "F", "F", "F", "F"]);
    expect(c.id).toBe("ign200_6max_D100_o3");
    expect(c.relevant).toBe("UTG");
  });

  test("first in, the deepest live opponent sets the depth", () => {
    const t = table(3, { 1: 100, 2: 100, 3: 150, 4: 125, 5: 100, 6: 100 });
    const c = chartFor6max(t as any, "CO", ["F", "F"]);
    expect(c.id).toBe("ign200_6max_D125_o2_5");
    expect(c.relevant).toBe("BTN");
  });

  test("a short stack that already folded does not count", () => {
    const t = table(4, { 1: 30 });
    const c = chartFor6max(t as any, "BTN", ["F", "F", "R2.5"]);
    expect(c.id).toBe("ign200_6max_D100_o2_5");
    expect(c.shortSeat).toBe("EQ");
  });

  test("two live shorts: the one whose raise hero faces gets the chart, the other is noted", () => {
    const t = table(6, { 2: 30, 4: 50 });
    const c = chartFor6max(t as any, "BB", ["F", "R2.5", "F", "C", "F"]);
    expect(c.id).toBe("ign200_6max_D100_s30_HJ_o2_5");
    expect(c.note).toContain("BTN 50bb also short");
  });

  test("two live shorts, hero first in: the short still to act behind him gets the chart", () => {
    const t = table(2, { 1: 30, 4: 50 });
    const c = chartFor6max(t as any, "HJ", ["C"]);
    // UTG limped (in the pot already); the BTN is the short hero has to plan for
    expect(c.openSize).toBe("limp");
    expect(c.candidates.every((id) => id.endsWith("_olimp"))).toBe(true);
    const raise = table(2, { 1: 30, 4: 50 });
    const r = chartFor6max(raise as any, "HJ", ["F"]);
    expect(r.id).toBe("ign200_6max_D100_s50_BTN_o2_5");
  });

  test("three or more shorts against a short raiser: the even chart at the effective stack", () => {
    const t = table(6, { 1: 45, 3: 45, 4: 50 });
    const c = chartFor6max(t as any, "BB", ["R2.5", "F", "C", "C", "F"]);
    expect(c.id).toBe("ign200_6max_D50_o2_5");
    expect(c.effective).toBe(45);
  });

  test("a deep spot with a short bystander: the depth wins and the short is noted", () => {
    const t = table(6, { 1: 150, 4: 30, 6: 150 });
    const c = chartFor6max(t as any, "BB", ["R3", "F", "F", "C", "F"]);
    expect(c.id).toBe("ign200_6max_D150_o3");
    expect(c.note).toContain("BTN's 30bb is not modelled");
  });

  test("a hero who has not reloaded follows his own stack, and says so", () => {
    const t = table(6, { 6: 60 });
    const c = chartFor6max(t as any, "BB", ["F", "F", "F", "R2.5", "F"]);
    expect(c.id).toBe("ign200_6max_D50_o2_5");
    expect(c.note).toContain("hero has 60bb");
  });

  test("replayTokens6 follows later orbits through the live seats only", () => {
    // UTG raises, HJ/CO fold, BTN calls, SB folds, BB 3-bets; UTG then 4-bets (second orbit: UTG, BTN, BB live)
    const r = replayTokens6(["R2.5", "F", "F", "C", "F", "R9", "R22"]);
    expect([...r.folded].sort()).toEqual(["CO", "HJ", "SB"]);
    expect(r.aggressor).toBe("UTG");
    expect(r.after).toEqual(["BB"]); // BTN acts now; the BB is still to act behind him
  });
});

describe("chartFor6max — postflop reads stacks as dealt", () => {
  test("a turn node after a 3x open, call, and a 6bb flop bet still picks the 100bb chart", () => {
    // hero SB opened 3x (100 → 97 behind), BB called, hero bet 6 on the flop and was called: 91 behind on the turn
    const t = {
      heroSeatId: 5, committed: {},
      positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as Record<number, string>,
      stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 91, 6: 91 } as Record<number, number>,
      currentNode: { street: "turn" },
      actions: [
        { seatId: 5, type: "post-sb", amount: 0.5, street: "preflop", hero: true }, { seatId: 6, type: "post-bb", amount: 1, street: "preflop" },
        { seatId: 1, type: "fold", street: "preflop" }, { seatId: 2, type: "fold", street: "preflop" }, { seatId: 3, type: "fold", street: "preflop" }, { seatId: 4, type: "fold", street: "preflop" },
        { seatId: 5, type: "raise", amount: 3, street: "preflop", hero: true }, { seatId: 6, type: "call", amount: 2, street: "preflop" },
        { seatId: 5, type: "bet", amount: 6, street: "flop", hero: true }, { seatId: 6, type: "call", amount: 6, street: "flop" },
      ],
    };
    const c = chartFor6max(t as any, "SB", ["F", "F", "F", "F", "R3", "C"]);
    expect(c.id).toBe("ign200_6max_D100_o3");
    expect(c.effective).toBe(100);
    expect(c.note ?? "").not.toContain("unreadable");
  });
});
