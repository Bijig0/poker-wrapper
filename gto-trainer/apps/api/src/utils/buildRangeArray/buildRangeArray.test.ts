import { describe, it, expect } from "bun:test";
import { buildRangeArray, rangeCombos } from "./buildRangeArray";
import { comboIndex } from "../comboIndex/comboIndex";

describe("buildRangeArray", () => {
  it("full/*/100% → all 1326 combos", () => {
    for (const spec of ["full", "*", "100%", "any", ""]) {
      const r = buildRangeArray(spec);
      expect(r.length).toBe(1326);
      expect(rangeCombos(r)).toBe(1326);
    }
  });

  it("explicit class list sets those combos, rest zero", () => {
    const r = buildRangeArray("AA,KK");
    expect(rangeCombos(r)).toBe(12); // 6 + 6
    expect(r[comboIndex("As", "Ah")]).toBe(1);
    expect(r[comboIndex("Kd", "Kc")]).toBe(1);
    expect(r[comboIndex("Qs", "Qh")]).toBe(0);
  });

  it("per-class weights", () => {
    const r = buildRangeArray("AKs:0.5");
    expect(r[comboIndex("As", "Ks")]).toBeCloseTo(0.5);
    // AKs is 4 combos × 0.5 = 2
    expect(rangeCombos(r)).toBeCloseTo(2);
  });

  it("shorthand expands (22+ = all pairs)", () => {
    const r = buildRangeArray("22+");
    expect(rangeCombos(r)).toBe(13 * 6); // 13 pairs × 6 combos
  });

  it("clamps out-of-range weights", () => {
    const r = buildRangeArray("AA:5");
    expect(r[comboIndex("As", "Ah")]).toBe(1);
  });
});
