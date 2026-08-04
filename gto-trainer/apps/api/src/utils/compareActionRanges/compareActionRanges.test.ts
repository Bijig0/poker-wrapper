import { describe, it, expect } from "bun:test";
import { compareActionRanges, type HandCell } from "./compareActionRanges";

const B75 = "Bet 75% (18.75)";
const B50 = "Bet 50% (12.5)";

const cells: HandCell[] = [
  { hand: "AA", actions: { [B75]: 26.2, [B50]: 41, Check: 29.8 }, inRange: true },
  { hand: "ATo", actions: { [B75]: 86.2, [B50]: 11.5 }, inRange: true },
  { hand: "76s", actions: { [B75]: 2.7, [B50]: 32.8, Check: 61.2 }, inRange: true },
  { hand: "K7s", actions: { [B75]: 12 }, inRange: true },
  { hand: "T5s", actions: { [B50]: 8 }, inRange: true },
  { hand: "99", actions: { Check: 100 }, inRange: true },
  { hand: "72o", actions: {}, inRange: false },
];

describe("compareActionRanges", () => {
  it("keeps only hands that use one of the two actions", () => {
    const cmp = compareActionRanges(cells, B75, B50);
    expect(cmp.rows.map((r) => r.hand)).toEqual(["AA", "ATo", "76s", "K7s", "T5s"]);
  });

  it("computes per-hand diffs in percentage points", () => {
    const cmp = compareActionRanges(cells, B75, B50);
    const aa = cmp.rows.find((r) => r.hand === "AA")!;
    expect(aa.diff).toBeCloseTo(-14.8, 1);
  });

  it("sorts skew lists toward each action", () => {
    const cmp = compareActionRanges(cells, B75, B50);
    expect(cmp.skewToA[0].hand).toBe("ATo"); // +74.7 toward B75
    expect(cmp.skewToB[0].hand).toBe("76s"); // -30.1 toward B50
  });

  it("counts exclusive and mixed hands", () => {
    const cmp = compareActionRanges(cells, B75, B50);
    expect(cmp.onlyA).toBe(1); // K7s
    expect(cmp.onlyB).toBe(1); // T5s
    expect(cmp.both).toBe(3); // AA, ATo, 76s
  });

  it("handles an action absent from every cell", () => {
    const cmp = compareActionRanges(cells, "Bet 20% (5)", B50);
    expect(cmp.onlyA).toBe(0);
    expect(cmp.rows.every((r) => r.a === 0)).toBe(true);
  });
});
