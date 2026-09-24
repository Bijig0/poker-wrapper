import { describe, expect, test } from "bun:test";
import { chartForHu, defaultChartHu, neighbourRungsHu } from "./hrc2max";

/** A heads-up hand at the flop: hero the SB/dealer, both stacks read as 100bb behind, nothing committed. */
const hand = () => ({
  heroSeatId: 2,
  positions: { 1: "BB", 2: "SB" } as Record<number, string>,
  stacks: { 1: 100, 2: 100 } as Record<number, number>,
  committed: {},
  actions: [],
  currentNode: { street: "flop" },
});

describe("chartForHu with the hand's pinned dealt stacks (2026-09-24)", () => {
  test("the pinned stacks decide the rung, not the hand's current readings", () => {
    const live = chartForHu(hand() as any, ["R2.5", "C"]);
    expect(live.depth).toBe(100);
    const pinned = chartForHu(hand() as any, ["R2.5", "C"], { 1: 60.3, 2: 95 });
    expect(pinned.effective).toBe(60.3);
    expect(pinned.depth).toBe(60);
  });

  test("a pinned seat that is not in the hand is ignored", () => {
    const c = chartForHu(hand() as any, ["R2.5", "C"], { 1: 100, 2: 100, 7: 20 });
    expect(c.depth).toBe(100);
  });
});

describe("the charts the HU preflop warm opens (2026-09-24)", () => {
  test("a rung's default chart is the one chartForHu picks before anyone raises", () => {
    const h = { ...hand(), stacks: { 1: 110, 2: 130 }, currentNode: { street: "preflop" } };
    expect(defaultChartHu(110)).toBe(chartForHu(h as any, []).id);
    expect(defaultChartHu(110)).toBe("hrc_hu_cp200a_d110_o2_5_3b10_5");
    expect(defaultChartHu(20)).toBe("hrc_hu_cp200a_d20_o2_5_3b7");
  });
  test("the neighbouring rungs are the ladder's, and the ends have one", () => {
    expect(neighbourRungsHu(110)).toEqual([105, 115]);
    expect(neighbourRungsHu(75)).toEqual([70, 80]);
    expect(neighbourRungsHu(20)).toEqual([30]);
    expect(neighbourRungsHu(150)).toEqual([125]);
    expect(neighbourRungsHu(112)).toEqual([]);
  });
});
