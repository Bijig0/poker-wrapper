import { describe, expect, it } from "bun:test";
import { matchToken, menus } from "./gtowAiPreflop";

/**
 * Hand 4919236052 (dashboard #443). CO opens 2.5, BB 3-bets to 4, hero 4-bets to 9.2,
 * BB 5-bets to 14.4. The AI tree answered the 9.2 and then rejected the 14.4 with
 * NODE_DOES_NOT_EXIST — and because the postflop chain reads its arrival ranges from
 * that node, every decision for the rest of the hand failed the same way: 21 no-answers
 * from one rounded multiplier.
 */
const LEVELS = [2.5, 4, 9.2, 14.4];

const raise = (code: string, bb: number) => ({ action: { code, type: "RAISE", betsize: bb } });
const fold = { action: { code: "F", type: "FOLD" } };
const call = { action: { code: "C", type: "CALL" } };

describe("the line's own sizes reach the tree", () => {
  it("keeps enough precision for the size actually played", () => {
    const m = menus(LEVELS, 4);
    // the villain's 5-bet is 14.4 over 9.2 = 1.5652x. At one decimal that is 1.6x, and
    // the tree's node lands at 14.72 — a node the walk never asks for.
    const five = m.villain.five.map((s) => parseFloat(s));
    const best = five.reduce((b, v) => (Math.abs(9.2 * v - 14.4) < Math.abs(9.2 * b - 14.4) ? v : b));
    expect(Math.abs(9.2 * best - 14.4)).toBeLessThan(0.05);
  });

  it("still carries every level's observed size", () => {
    const m = menus(LEVELS, 4);
    const near = (list: string[], base: number, want: number) =>
      list.map((x) => base * parseFloat(x)).some((v) => Math.abs(v - want) < 0.05);
    expect(near(m.hero.opens, 1, 2.5)).toBe(true);
    expect(near(m.villain.three, 2.5, 4)).toBe(true);
    expect(near(m.hero.four, 4, 9.2)).toBe(true);
    expect(near(m.villain.five, 9.2, 14.4)).toBe(true);
  });
});

describe("matchToken — what a line token means at a node", () => {
  const sols = [fold, call, raise("R14.72", 14.72), raise("RAI", 78.1)];

  it("takes an exact code when the tree has one", () => {
    expect(matchToken("R14.72", sols)?.code).toBe("R14.72");
  });

  it("snaps a raise to the nearest size the tree offers", () => {
    // THE CASE THAT COST THE HAND: we ask R14.4, the tree has R14.72
    expect(matchToken("R14.4", sols)?.code).toBe("R14.72");
  });

  it("  ... and picks the nearest, not the first", () => {
    const many = [raise("R10", 10), raise("R14.7", 14.7), raise("R20", 20)];
    expect(matchToken("R14.4", many)?.code).toBe("R14.7");
    expect(matchToken("R19", many)?.code).toBe("R20");
  });

  it("maps fold, call and check by kind", () => {
    expect(matchToken("F", sols)?.code).toBe("F");
    expect(matchToken("C", sols)?.code).toBe("C");
    expect(matchToken("X", [{ action: { code: "X", type: "CHECK" } }])?.code).toBe("X");
  });

  it("refuses rather than guessing when the kind is not on offer", () => {
    expect(matchToken("R5", [fold, call])).toBeNull();   // nothing to raise onto
    expect(matchToken("X", [fold, call])).toBeNull();
  });
});
