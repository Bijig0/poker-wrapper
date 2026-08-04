import { describe, it, expect } from "bun:test";
import { pickWeightedAction } from "./pickWeightedAction";

const MIX = [
  { action: "Raise 2", frequency: 79 },
  { action: "Fold", frequency: 21 },
];

describe("pickWeightedAction", () => {
  it("returns null for an empty or all-zero strategy", () => {
    expect(pickWeightedAction([])).toBeNull();
    expect(pickWeightedAction([{ action: "Fold", frequency: 0 }])).toBeNull();
  });

  it("picks by frequency band from the roll", () => {
    expect(pickWeightedAction(MIX, 0.0)?.action).toBe("Raise 2"); // start of Raise band
    expect(pickWeightedAction(MIX, 0.5)?.action).toBe("Raise 2"); // 50 < 79
    expect(pickWeightedAction(MIX, 0.78)?.action).toBe("Raise 2"); // 78 < 79
    expect(pickWeightedAction(MIX, 0.8)?.action).toBe("Fold"); // 80 ≥ 79
    expect(pickWeightedAction(MIX, 0.999)?.action).toBe("Fold"); // top of range
  });

  it("reports the roll on a 0–100 scale and the chosen band", () => {
    const p = pickWeightedAction(MIX, 0.5)!;
    expect(p.roll).toBeCloseTo(50, 1);
    expect(p.band).toEqual([0, 79]);
    const q = pickWeightedAction(MIX, 0.9)!;
    expect(q.band).toEqual([79, 100]);
  });

  it("normalizes frequencies that don't sum to 100", () => {
    const half = [
      { action: "Bet", frequency: 30 },
      { action: "Check", frequency: 30 },
    ];
    // total 60; roll 0.5 → target 30 → lands exactly at Check boundary
    expect(pickWeightedAction(half, 0.5)?.action).toBe("Check");
    expect(pickWeightedAction(half, 0.4)?.action).toBe("Bet");
  });

  it("always returns a positive-frequency action (skips zeros)", () => {
    const withZero = [
      { action: "Allin", frequency: 0 },
      { action: "Raise", frequency: 100 },
    ];
    for (const r of [0, 0.3, 0.6, 0.99]) {
      expect(pickWeightedAction(withZero, r)?.action).toBe("Raise");
    }
  });

  it("is a pure draw over many rolls, hitting each action in proportion", () => {
    let raise = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      // deterministic sweep of the [0,1) interval
      if (pickWeightedAction(MIX, i / N)?.action === "Raise 2") raise++;
    }
    expect(raise / N).toBeCloseTo(0.79, 1);
  });
});
