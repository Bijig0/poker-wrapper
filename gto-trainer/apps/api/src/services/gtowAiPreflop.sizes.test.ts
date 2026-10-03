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
  it("carries the size actually played as its exact amount", () => {
    const m = menus(LEVELS, 4);
    // the villain's 5-bet is 14.4 over 9.2 = 1.5652x. As a multiple at one decimal that was 1.6x, and the tree's
    // node landed at 14.72 — a node the walk never asks for. As an amount it is the node the line spells.
    expect(m.villain.five).toContain("14.4bb");
  });

  it("carries every level's observed size, to the cent of a blind", () => {
    const m = menus(LEVELS, 4);
    expect(m.hero.opens).toEqual(["2.5bb"]);
    expect(m.villain.three).toEqual(["4bb"]);
    expect(m.hero.four).toEqual(["9.2bb"]);
    expect(m.villain.five).toEqual(["2.2x", "14.4bb"]);   // this list also serves every raise after the fifth
    expect(menus([2.5, 8.75], 6).hero.three).toEqual(["8.75bb"]);
  });

  it("a 'raise' that does not top the one below it is not a level: the default stays", () => {
    expect(menus([3, 3], 6).hero.three).toEqual(["3.5x"]);
    expect(menus([1], 6).hero.opens).toEqual(["2.5x"]);
  });
});

/**
 * Hand 4922086187 (2026-10-02). Three-handed, hero BTN opens 2.6 (a 2.5 pick, a cent up at NL5), the SB 3-bets to 13.
 * The tree listed 2.2/2.5/3 beside the 2.6: GTO Wizard merged the 2.6 away, hero's node 'R2.6-R13-F' had no address
 * and the hand fell to the last resort. A level already played holds the size played and nothing else.
 */
describe("a level already played holds only the size played", () => {
  it("three-handed, facing the 3-bet: one open and one 3-bet on every seat, the 4-bet still a choice", () => {
    const m = menus([2.6, 13], 3);
    for (const seat of [m.hero, m.villain]) {
      expect(seat.opens).toEqual(["2.6bb"]);
      expect(seat.three).toEqual(["13bb"]);
    }
    expect(m.hero.four).toEqual(["2.3x"]);
  });

  it("nothing played yet, three or more seats: every seat opens one size, 2.5x — hero's included", () => {
    for (const n of [3, 4, 5, 6]) {
      const m = menus([], n);
      expect(m.hero.opens).toEqual(["2.5x"]);
      expect(m.villain.opens).toEqual(["2.5x"]);
      expect(m.hero.three).toEqual(["3.5x"]);
    }
  });

  it("heads-up: the played open alone, the full 3-bet menu still to choose from", () => {
    const m = menus([2.6], 2);
    expect(m.hero.opens).toEqual(["2.6bb"]);
    expect(m.hero.three.length).toBeGreaterThan(1);
    expect(m.villain).toEqual(m.hero);
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
