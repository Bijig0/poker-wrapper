import { describe, it, expect } from "bun:test";
import { CFRSolver, exploitability, actionProb } from "./cfr";
import { polarGame } from "./games/polar";

describe("Polar clairvoyance game — CFR matches the closed-form solution", () => {
  for (const bet of [1, 0.5, 2]) {
    describe(`bet = ${bet}x pot`, () => {
      const g = polarGame(bet);
      const solver = new CFRSolver(g);
      solver.train(80_000);
      const strat = solver.averageStrategy();

      const callFreq = 1 / (1 + bet);
      const bluffFreq = bet / (1 + bet);

      it("is unexploitable", () => {
        expect(exploitability(g, strat)).toBeLessThan(2e-3);
      });

      it("nuts always bet", () => {
        expect(actionProb(strat, "N|", "bet")).toBeGreaterThan(0.98);
      });

      it(`air bluffs with freq ≈ ${bluffFreq.toFixed(3)}`, () => {
        expect(Math.abs(actionProb(strat, "A|", "bet") - bluffFreq)).toBeLessThan(0.03);
      });

      it(`caller calls with freq ≈ ${callFreq.toFixed(3)} (MDF)`, () => {
        expect(
          Math.abs(actionProb(strat, "caller|b", "call") - callFreq)
        ).toBeLessThan(0.03);
      });
    });
  }
});
