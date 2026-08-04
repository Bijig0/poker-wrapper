import { describe, it, expect } from "bun:test";
import { comboIndex, classOf, cardIndex, COMBOS, toClassWeights, toRangeString } from "./comboIndex";

describe("cardIndex", () => {
  it("maps 2c to 0 and As to 51", () => {
    expect(cardIndex("2c")).toBe(0);
    expect(cardIndex("As")).toBe(51);
  });
  it("orders rank*4+suit", () => {
    expect(cardIndex("2d")).toBe(1);
    expect(cardIndex("3c")).toBe(4);
  });
});

describe("comboIndex", () => {
  it("is order-independent", () => {
    expect(comboIndex("As", "Kh")).toBe(comboIndex("Kh", "As"));
  });
  it("indexes the full range 0..1325 uniquely", () => {
    const seen = new Set<number>();
    for (let b = 0; b < 52; b++) for (let a = 0; a < b; a++) seen.add((b * (b - 1)) / 2 + a);
    expect(seen.size).toBe(1326);
  });
  it("matches C(b,2)+a", () => {
    // 2c(0),2d(1) → C(1,2)+0 = 0
    expect(comboIndex("2c", "2d")).toBe(0);
  });
});

describe("classOf", () => {
  it("labels pairs, suited and offsuit", () => {
    expect(classOf("Ts", "Th")).toBe("TT");
    expect(classOf("As", "Ks")).toBe("AKs");
    expect(classOf("As", "Kh")).toBe("AKo");
    expect(classOf("7d", "2d")).toBe("72s");
  });
});

describe("COMBOS table", () => {
  it("has 1326 entries", () => {
    expect(COMBOS.length).toBe(1326);
    expect(COMBOS.every((c) => c && c.cls && c.hand)).toBe(true);
  });
  it("agrees with comboIndex for a sample", () => {
    const i = comboIndex("As", "Kh");
    expect(COMBOS[i]!.cls).toBe("AKo");
  });
  it("has exactly 6 combos per pair, 4 suited, 12 offsuit", () => {
    const counts: Record<string, number> = {};
    for (const c of COMBOS) counts[c.cls] = (counts[c.cls] ?? 0) + 1;
    expect(counts["AA"]).toBe(6);
    expect(counts["AKs"]).toBe(4);
    expect(counts["AKo"]).toBe(12);
  });
});

describe("toClassWeights", () => {
  it("aggregates combo weights into classes", () => {
    const w = new Array(1326).fill(0);
    w[comboIndex("As", "Ks")] = 1;
    w[comboIndex("Ah", "Kh")] = 0.5;
    const cls = toClassWeights(w);
    expect(cls["AKs"]).toEqual({ weight: 1.5, combos: 2 });
  });
});

describe("toRangeString", () => {
  it("emits only nonzero combos with weights", () => {
    const w = new Array(1326).fill(0);
    w[comboIndex("As", "Ks")] = 1;
    w[comboIndex("Ah", "Kh")] = 0.5;
    const s = toRangeString(w);
    expect(s).toContain(":1");
    expect(s).toContain(":0.5");
    expect(s.split(",").length).toBe(2);
  });
});
