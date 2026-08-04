import { describe, expect, it } from "bun:test";
import { canonicalActionKey, canonicalizeActions } from "./canonicalizeActions";

describe("canonicalActionKey", () => {
  it("keys bets and raises by pot fraction, not bb amount", () => {
    expect(canonicalActionKey("Raise 13.75 (100%)")).toBe("Raise 100%");
    expect(canonicalActionKey("Raise 17.8 (100%)")).toBe("Raise 100%");
    expect(canonicalActionKey("Bet 1.8 (33%)")).toBe("Bet 33%");
    expect(canonicalActionKey("Bet 75% (18.75)")).toBe("Bet 75%");
  });

  it("collapses all-in sizes", () => {
    expect(canonicalActionKey("Allin 97.5 (682%)")).toBe("All-in");
    expect(canonicalActionKey("Allin 100")).toBe("All-in");
  });

  it("keeps simple actions", () => {
    expect(canonicalActionKey("Check")).toBe("Check");
    expect(canonicalActionKey("Call")).toBe("Call");
    expect(canonicalActionKey("Fold")).toBe("Fold");
  });

  it("uses bb for preflop-style labels without a pot fraction", () => {
    expect(canonicalActionKey("Raise 2.5")).toBe("Raise 2.5bb");
  });
});

describe("canonicalizeActions", () => {
  it("merges same-identity actions and sorts by frequency", () => {
    expect(
      canonicalizeActions([
        { action: "Raise 13.75 (100%)", frequency: 32.1 },
        { action: "Call", frequency: 56 },
        { action: "Fold", frequency: 0 },
      ])
    ).toEqual([
      { action: "Call", frequency: 56 },
      { action: "Raise 100%", frequency: 32.1 },
      { action: "Fold", frequency: 0 },
    ]);
  });
});
