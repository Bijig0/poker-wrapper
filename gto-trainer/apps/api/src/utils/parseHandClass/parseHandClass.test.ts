import { describe, it, expect } from "bun:test";
import { parseHandClass } from "./parseHandClass";

describe("parseHandClass", () => {
  it("maps specific combos to their class", () => {
    expect(parseHandClass("AhKs")).toBe("AKo"); // different suits
    expect(parseHandClass("AhKh")).toBe("AKs"); // same suit
    expect(parseHandClass("KhAs")).toBe("AKo"); // order-independent
    expect(parseHandClass("AhAs")).toBe("AA"); // pair
    expect(parseHandClass("7c2d")).toBe("72o");
    expect(parseHandClass("Th9h")).toBe("T9s");
  });

  it("accepts class notation directly", () => {
    expect(parseHandClass("AKo")).toBe("AKo");
    expect(parseHandClass("72s")).toBe("72s");
    expect(parseHandClass("TT")).toBe("TT");
    expect(parseHandClass("kqs")).toBe("KQs"); // case-insensitive
    expect(parseHandClass("2 2")).toBe("22");
  });

  it("orders ranks high-to-low", () => {
    expect(parseHandClass("2Ao")).toBe("A2o");
    expect(parseHandClass("9Ts")).toBe("T9s");
  });

  it("rejects ambiguous non-pair without a suffix", () => {
    expect(() => parseHandClass("AK")).toThrow(/Ambiguous/);
  });

  it("rejects nonsense and duplicate cards", () => {
    expect(() => parseHandClass("ZZ")).toThrow();
    expect(() => parseHandClass("AhAh")).toThrow(/same card/);
    expect(() => parseHandClass("")).toThrow(/Empty/);
  });
});
