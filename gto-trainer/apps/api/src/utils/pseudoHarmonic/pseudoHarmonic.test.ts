import { describe, it, expect } from "bun:test";
import { pseudoHarmonicProbLow, bracket } from "./pseudoHarmonic";

describe("pseudoHarmonicProbLow", () => {
  it("is boundary-consistent (x=A → 1, x=B → 0)", () => {
    expect(pseudoHarmonicProbLow(0.33, 0.33, 0.67)).toBeCloseTo(1);
    expect(pseudoHarmonicProbLow(0.67, 0.33, 0.67)).toBeCloseTo(0);
  });

  it("clamps outside the bracket", () => {
    expect(pseudoHarmonicProbLow(0.2, 0.33, 0.67)).toBe(1); // below A → all A
    expect(pseudoHarmonicProbLow(0.9, 0.33, 0.67)).toBe(0); // above B → all B
  });

  it("is monotone decreasing between A and B", () => {
    const lo = pseudoHarmonicProbLow(0.4, 0.33, 0.67);
    const mid = pseudoHarmonicProbLow(0.5, 0.33, 0.67);
    const hi = pseudoHarmonicProbLow(0.6, 0.33, 0.67);
    expect(lo).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(hi);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("matches the closed form for a known case", () => {
    // 55% between 33% and 67%: (0.67-0.55)(1.33)/((0.34)(1.55))
    const expected = ((0.67 - 0.55) * (1 + 0.33)) / ((0.67 - 0.33) * (1 + 0.55));
    expect(pseudoHarmonicProbLow(0.55, 0.33, 0.67)).toBeCloseTo(expected, 6);
  });

  it("is scale-invariant only in the ratio sense it claims (sanity: valid range)", () => {
    const p = pseudoHarmonicProbLow(1.0, 0.5, 1.5); // pot-sized between 0.5 and 1.5 pot
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("throws when the bracket is degenerate", () => {
    expect(() => pseudoHarmonicProbLow(0.5, 0.5, 0.5)).toThrow();
  });
});

describe("bracket", () => {
  const SIZES = [0.33, 0.67, 1.0]; // 33% / 67% / pot

  it("finds the surrounding sizes", () => {
    expect(bracket(0.55, SIZES)).toEqual({ low: 0.33, high: 0.67, clamped: false });
    expect(bracket(0.8, SIZES)).toEqual({ low: 0.67, high: 1.0, clamped: false });
  });

  it("clamps below the smallest and above the largest", () => {
    expect(bracket(0.2, SIZES)).toEqual({ low: 0.33, high: 0.33, clamped: true });
    expect(bracket(1.5, SIZES)).toEqual({ low: 1.0, high: 1.0, clamped: true });
  });

  it("sits exactly on an available size", () => {
    expect(bracket(0.67, SIZES)).toEqual({ low: 0.67, high: 0.67, clamped: false });
  });

  it("dedupes and sorts unsorted input", () => {
    expect(bracket(0.55, [1.0, 0.33, 0.67, 0.33])).toEqual({
      low: 0.33,
      high: 0.67,
      clamped: false,
    });
  });

  it("throws on empty sizes", () => {
    expect(() => bracket(0.5, [])).toThrow();
  });
});
