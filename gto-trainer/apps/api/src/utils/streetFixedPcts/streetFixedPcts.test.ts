import { describe, expect, it } from "bun:test";
import { streetFixedPcts, wagerBb } from "./streetFixedPcts";

describe("wagerBb", () => {
  it("parses wager labels to bb", () => {
    expect(wagerBb("Bet(330)")).toBe(3.3);
    expect(wagerBb("Raise(2100)")).toBe(21);
    expect(wagerBb("AllIn(9800)")).toBe(98);
  });
  it("returns null for non-wagers", () => {
    expect(wagerBb("Check")).toBeNull();
    expect(wagerBb("Call")).toBeNull();
    expect(wagerBb("Fold")).toBeNull();
    expect(wagerBb("7d")).toBeNull();
  });
});

describe("streetFixedPcts", () => {
  it("computes a lone bet as % of pot", () => {
    // pot 6bb, bet 3bb = 50%
    expect(streetFixedPcts(["Check", "Bet(300)"], 6)).toEqual({
      pcts: ["50%"],
      sizesBb: [3],
    });
  });

  it("computes a raise as % of pot-after-call", () => {
    // pot 6, OOP bets 3 (50%), IP raises to 10.5:
    // raise-by = 10.5-3 = 7.5, pot-after-call = 6+3+3 = 12 → 62.5%
    expect(streetFixedPcts(["Bet(300)", "Raise(1050)"], 6)).toEqual({
      pcts: ["50%", "62.5%"],
      sizesBb: [3, 10.5],
    });
  });

  it("handles bet-raise-reraise chains", () => {
    // pot 4: bet 2 (50%); raise to 6: by 4 over pot 4+2+2=8 → 50%;
    // reraise to 15: by 9 over pot 4+2+6+(6-2)=16 → 56.3%
    const r = streetFixedPcts(["Bet(200)", "Raise(600)", "Raise(1500)"], 4);
    expect(r.pcts).toEqual(["50%", "50%", "56.3%"]);
    expect(r.sizesBb).toEqual([2, 6, 15]);
  });

  it("ignores checks and calls for levels but tracks commits", () => {
    // check-check street: no levels
    expect(streetFixedPcts(["Check", "Check"], 5)).toEqual({ pcts: [], sizesBb: [] });
  });

  it("throws when the wager is not a raise", () => {
    expect(() => streetFixedPcts(["Bet(300)", "Raise(200)"], 6)).toThrow();
  });

  it("follows an explicit 3-way rotation with a fold in it", () => {
    // pot 7.5: OOP checks, OOP+1 checks, IP bets 2.5 (33.3%), OOP folds, OOP+1 raises to 10:
    // raise-by 7.5 over pot-after-call 7.5+2.5+2.5 = 12.5 → 60%
    const r = streetFixedPcts(["Check", "Check", "Bet(250)", "Fold", "Raise(1000)"], 7.5, [0, 1, 2, 0, 1]);
    expect(r.pcts).toEqual(["33.3%", "60%"]);
    expect(r.sizesBb).toEqual([2.5, 10]);
  });
});
