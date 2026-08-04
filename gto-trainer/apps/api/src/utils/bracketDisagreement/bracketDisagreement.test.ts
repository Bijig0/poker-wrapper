import { describe, it, expect } from "bun:test";
import { totalVariation, blend, agrees } from "./bracketDisagreement";

const FOLD100 = [{ action: "Fold", frequency: 100 }];
const CALL100 = [{ action: "Call", frequency: 100 }];
const MIX = [
  { action: "Call", frequency: 60 },
  { action: "Fold", frequency: 40 },
];

describe("totalVariation", () => {
  it("is 0 for identical distributions", () => {
    expect(totalVariation(FOLD100, [{ action: "Fold", frequency: 100 }])).toBe(0);
  });

  it("is 100 for disjoint pure strategies", () => {
    expect(totalVariation(FOLD100, CALL100)).toBe(100);
  });

  it("measures partial overlap", () => {
    // Fold100 vs Call60/Fold40 → ½(|0-60| + |100-40|) = ½(120) = 60
    expect(totalVariation(FOLD100, MIX)).toBe(60);
  });

  it("is order-independent over actions", () => {
    const a = [
      { action: "Fold", frequency: 40 },
      { action: "Call", frequency: 60 },
    ];
    expect(totalVariation(a, MIX)).toBe(0);
  });
});

describe("blend", () => {
  it("returns endpoint distributions at the extremes", () => {
    expect(blend(FOLD100, CALL100, 1)).toEqual([{ action: "Fold", frequency: 100 }]);
    expect(blend(FOLD100, CALL100, 0)).toEqual([{ action: "Call", frequency: 100 }]);
  });

  it("mixes proportionally in between", () => {
    const out = blend(FOLD100, CALL100, 0.7);
    const map = Object.fromEntries(out.map((o) => [o.action, o.frequency]));
    expect(map.Fold).toBeCloseTo(70);
    expect(map.Call).toBeCloseTo(30);
  });

  it("sorts descending and drops negligible slivers (< 0.05%)", () => {
    const out = blend(FOLD100, CALL100, 0.9996); // Call = 0.04% → dropped
    expect(out[0].action).toBe("Fold");
    expect(out.find((o) => o.action === "Call")).toBeUndefined();
  });
});

describe("agrees", () => {
  it("agrees when responses are near-identical", () => {
    const a = [{ action: "Fold", frequency: 100 }];
    const b = [
      { action: "Fold", frequency: 96 },
      { action: "Call", frequency: 4 },
    ];
    expect(agrees(a, b)).toBe(true); // TV = 4 ≤ 8
  });

  it("disagrees on a big strategy swing", () => {
    const a = [{ action: "Fold", frequency: 100 }];
    const b = [
      { action: "Fold", frequency: 70 },
      { action: "Call", frequency: 30 },
    ];
    expect(agrees(a, b)).toBe(false); // TV = 30 > 8
  });

  it("tightens tolerance as the pot grows", () => {
    const a = [{ action: "Fold", frequency: 100 }];
    const b = [
      { action: "Fold", frequency: 93 },
      { action: "Call", frequency: 7 },
    ];
    expect(agrees(a, b, 1)).toBe(true); // TV=7 ≤ 8
    expect(agrees(a, b, 20)).toBe(false); // tol shrinks to 0.4 in a big pot
  });
});
