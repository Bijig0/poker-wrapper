import { describe, it, expect } from "bun:test";
import { CFRSolver, exploitability, gameValue, actionProb } from "./cfr";
import { kuhn } from "./games/kuhn";

describe("Kuhn poker — CFR reaches the published equilibrium", () => {
  const solver = new CFRSolver(kuhn);
  solver.train(120_000);
  const strat = solver.averageStrategy();

  it("is essentially unexploitable (< 0.5% of a chip)", () => {
    expect(exploitability(kuhn, strat)).toBeLessThan(5e-3);
  });

  it("has game value ≈ -1/18 to player 0", () => {
    expect(Math.abs(gameValue(kuhn, strat) - -1 / 18)).toBeLessThan(1e-2);
  });

  it("player 0 essentially never bets Q first", () => {
    expect(actionProb(strat, "Q|", "b")).toBeLessThan(0.02);
  });

  it("player 1 bluffs J after a check with freq ≈ 1/3", () => {
    expect(Math.abs(actionProb(strat, "J|p", "b") - 1 / 3)).toBeLessThan(0.05);
  });

  it("player 1 bluff-catches Q vs a bet with freq ≈ 1/3", () => {
    expect(Math.abs(actionProb(strat, "Q|b", "b") - 1 / 3)).toBeLessThan(0.05);
  });

  it("player 0 bets K three times as often as J (the alpha relationship)", () => {
    const betK = actionProb(strat, "K|", "b");
    const betJ = actionProb(strat, "J|", "b");
    expect(Math.abs(betK - 3 * betJ)).toBeLessThan(0.06);
  });
});
