import { describe, it, expect } from "bun:test";
import { matchActionLabel } from "./matchActionLabel";

const LABELS = [
  "Allin 352% (88)",
  "Bet 125% (31.25)",
  "Bet 75% (18.75)",
  "Bet 50% (12.5)",
  "Bet 33% (8.25)",
  "Bet 20% (5)",
  "Check",
];

describe("matchActionLabel", () => {
  it("matches bare pot-share numbers", () => {
    expect(matchActionLabel("75", LABELS)).toBe("Bet 75% (18.75)");
    expect(matchActionLabel("50", LABELS)).toBe("Bet 50% (12.5)");
    expect(matchActionLabel("125", LABELS)).toBe("Bet 125% (31.25)");
    expect(matchActionLabel("20", LABELS)).toBe("Bet 20% (5)");
  });

  it("matches b/bet prefixed shorthand", () => {
    expect(matchActionLabel("b75", LABELS)).toBe("Bet 75% (18.75)");
    expect(matchActionLabel("bet50", LABELS)).toBe("Bet 50% (12.5)");
    expect(matchActionLabel("Bet 33%", LABELS)).toBe("Bet 33% (8.25)");
  });

  it("matches check and all-in aliases", () => {
    expect(matchActionLabel("check", LABELS)).toBe("Check");
    expect(matchActionLabel("x", LABELS)).toBe("Check");
    expect(matchActionLabel("jam", LABELS)).toBe("Allin 352% (88)");
    expect(matchActionLabel("allin", LABELS)).toBe("Allin 352% (88)");
  });

  it("matches full labels case-insensitively", () => {
    expect(matchActionLabel("bet 75% (18.75)", LABELS)).toBe("Bet 75% (18.75)");
  });

  it("returns null when nothing matches", () => {
    expect(matchActionLabel("60", LABELS)).toBeNull();
    expect(matchActionLabel("raise", LABELS)).toBeNull();
    expect(matchActionLabel("", LABELS)).toBeNull();
  });
});
