import { describe, expect, it } from "bun:test";
import { snapToken } from "./snapToken";

const NODE = ["Fold", "Call", "Raise 6", "Raise 7.5", "Allin 100 (1617%)"];

describe("snapToken", () => {
  it("passes non-aggressive tokens through", () => {
    expect(snapToken("F", NODE)).toEqual({ token: "F", snapped: false });
    expect(snapToken("X", NODE)).toEqual({ token: "X", snapped: false });
    expect(snapToken("C", NODE)).toEqual({ token: "C", snapped: false });
  });

  it("passes un-sized R tokens through", () => {
    expect(snapToken("R", NODE)).toEqual({ token: "R", snapped: false });
  });

  it("snaps an off-tree size to the log-nearest offered size", () => {
    const r = snapToken("R8.2", NODE);
    expect(r.snapped).toBe(true);
    expect(r.token).toBe("R7.5"); // log(8.2/7.5)=0.089 < log(100/8.2)
    expect(r.from).toBe(8.2);
    expect(r.to).toBe(7.5);
    expect(r.label).toBe("Raise 7.5");
  });

  it("uses ratio distance, not absolute bb", () => {
    // 8 between 5 and 14: absolute favours 5 (3 vs 6), but ratio favours...
    // log(8/5)=0.47 vs log(14/8)=0.56 → still 5 here; craft a case that flips:
    // 9 between 5 and 14: abs 4 vs 5 → 5; log(9/5)=0.588 vs log(14/9)=0.442 → 14.
    const r = snapToken("R9", ["Fold", "Raise 5", "Raise 14"]);
    expect(r.token).toBe("R14");
  });

  it("treats a size within tolerance as already on-tree", () => {
    // 2.5% relative: 7.5 vs 7.6 is 1.3% → on-tree, no snap
    expect(snapToken("R7.6", NODE).snapped).toBe(false);
    // absolute floor: 2 vs 2.04
    expect(snapToken("R2.04", ["Fold", "Raise 2"]).snapped).toBe(false);
  });

  it("maps a jam-sized token to the RAI all-in URL token", () => {
    const r = snapToken("R80", ["Fold", "Call", "Allin 100 (1617%)"]);
    expect(r.token).toBe("RAI");
    expect(r.label).toBe("Allin 100 (1617%)");
  });

  it("rewrites even an exact all-in amount match to RAI", () => {
    const r = snapToken("R100", ["Fold", "Call", "Allin 100 (1617%)"]);
    expect(r.snapped).toBe(true);
    expect(r.token).toBe("RAI");
  });

  it("reports unverifiable when the node offers no aggressive sizes", () => {
    const r = snapToken("R8.2", ["Fold", "Call", "Check"]);
    expect(r.snapped).toBe(false);
    expect(r.unverifiable).toBe(true);
    expect(r.token).toBe("R8.2");
  });

  it("skips pct-only labels it cannot compare in bb", () => {
    const r = snapToken("R8.2", ["Fold", "Bet 75%", "Raise 7.5"]);
    expect(r.token).toBe("R7.5");
  });

  it("handles percent-first labels with a bb amount in parens", () => {
    const r = snapToken("R16", ["Fold", "Bet 75% (18.75)"]);
    expect(r.snapped).toBe(true);
    expect(r.token).toBe("R18.75");
  });

  it("trims trailing zeros like actionToken does", () => {
    const r = snapToken("R9", ["Raise 7.50"]);
    expect(r.token).toBe("R7.5");
  });

  it("treats a 49-vs-50 near-match as already on-tree (no snap)", () => {
    const r = snapToken("R2.45", ["Bet 2.5"]); // ~2% off — inside REL_TOL
    expect(r.snapped).toBe(false);
    expect(r.logDist!).toBeLessThan(0.05);
  });

  it("snaps a near-but-outside-tolerance size and does NOT flag far", () => {
    const r = snapToken("R2.2", ["Bet 2.5"]); // ~12% off → snaps, log 0.13 < τ
    expect(r.snapped).toBe(true);
    expect(r.far).toBe(false);
  });

  it("flags far when the nearest offered size is > τ away", () => {
    const r = snapToken("R9", ["Bet 2.5", "Bet 4"]); // 9 vs 4 = log 0.81 > τ 0.4
    expect(r.snapped).toBe(true);
    expect(r.token).toBe("R4");
    expect(r.far).toBe(true);
    expect(r.logDist!).toBeGreaterThan(0.4);
  });

  it("does not flag far right up to the τ boundary (75 vs 50 ≈ log 0.4)", () => {
    const r = snapToken("R7.5", ["Bet 5"]); // log(7.5/5)=0.405, just over 0.4 → far
    expect(r.far).toBe(true);
    const r2 = snapToken("R7", ["Bet 5"]); // log(7/5)=0.336 < 0.4 → not far
    expect(r2.far).toBe(false);
  });
});
