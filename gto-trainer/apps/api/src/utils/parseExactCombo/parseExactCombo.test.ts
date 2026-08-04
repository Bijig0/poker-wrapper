import { describe, expect, it } from "bun:test";
import { parseExactCombo } from "./parseExactCombo";

describe("parseExactCombo", () => {
  it("parses a combo and orders higher rank first", () => {
    expect(parseExactCombo("AhKs")).toEqual({
      comboId: "AhKs",
      handClass: "AKo",
      cards: ["Ah", "Ks"],
    });
    expect(parseExactCombo("KsAh")).toEqual({
      comboId: "AhKs",
      handClass: "AKo",
      cards: ["Ah", "Ks"],
    });
  });

  it("detects suitedness", () => {
    expect(parseExactCombo("Ts9s")?.handClass).toBe("T9s");
    expect(parseExactCombo("Th9s")?.handClass).toBe("T9o");
  });

  it("orders pairs by suit s > h > d > c (GTO Wizard panel order)", () => {
    expect(parseExactCombo("5h5s")?.comboId).toBe("5s5h");
    expect(parseExactCombo("5c5d")?.comboId).toBe("5d5c");
    expect(parseExactCombo("QdQh")?.handClass).toBe("QQ");
  });

  it("accepts separators and mixed case", () => {
    expect(parseExactCombo("ah ks")?.comboId).toBe("AhKs");
    expect(parseExactCombo("AH,KS")?.comboId).toBe("AhKs");
  });

  it("returns null for class notation (caller falls back to class read)", () => {
    expect(parseExactCombo("AKo")).toBeNull();
    expect(parseExactCombo("TT")).toBeNull();
    expect(parseExactCombo("72s")).toBeNull();
  });

  it("throws on a duplicated card", () => {
    expect(() => parseExactCombo("AhAh")).toThrow();
  });
});
