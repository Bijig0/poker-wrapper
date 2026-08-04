import { describe, expect, it } from "bun:test";
import { parseBetLabel } from "./parseBetLabel";

describe("parseBetLabel", () => {
  it("parses amount-first labels (6-max General format)", () => {
    expect(parseBetLabel("Bet 1.8 (33%)")).toEqual({ kind: "bet", amount: 1.8, pct: 33 });
    expect(parseBetLabel("Bet 2.75 (50%)")).toEqual({ kind: "bet", amount: 2.75, pct: 50 });
    expect(parseBetLabel("Allin 97 (1617%)")).toEqual({ kind: "allin", amount: 97, pct: 1617 });
  });

  it("parses percent-first labels (HU Complex format)", () => {
    expect(parseBetLabel("Bet 75% (18.75)")).toEqual({ kind: "bet", amount: 18.75, pct: 75 });
    expect(parseBetLabel("Bet 75%")).toEqual({ kind: "bet", pct: 75 });
  });

  it("parses preflop raise labels without a pot fraction", () => {
    expect(parseBetLabel("Raise 2.5")).toEqual({ kind: "raise", amount: 2.5 });
    expect(parseBetLabel("Allin 100")).toEqual({ kind: "allin", amount: 100 });
  });

  it("parses simple actions", () => {
    expect(parseBetLabel("Check")).toEqual({ kind: "check" });
    expect(parseBetLabel("Call")).toEqual({ kind: "call" });
    expect(parseBetLabel("Fold")).toEqual({ kind: "fold" });
  });

  it("normalizes whitespace and case", () => {
    expect(parseBetLabel("  bet   1.8  (33%) ")).toEqual({ kind: "bet", amount: 1.8, pct: 33 });
    expect(parseBetLabel("CHECK")).toEqual({ kind: "check" });
  });

  it("rejects non-action text", () => {
    expect(parseBetLabel("")).toBeNull();
    expect(parseBetLabel("FLOP 6")).toBeNull();
    expect(parseBetLabel("Bet")).toBeNull();
  });
});
