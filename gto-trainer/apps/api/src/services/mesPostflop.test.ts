import { describe, expect, test } from "bun:test";
import { mesPostflopLookup, mesPostflopAvailable } from "./mesPostflop";

/** The M1 spot: BTN folds, SB raises, BB calls — hero SB, first to act on the
 *  flop. Board Kc7d2h is IN the solved set, so the exact path must trigger.
 *  NOTE the exploit preflop scheme LIMPS premiums bvb (AA/KK/AK/AQs), so an
 *  in-range test hand must come from the RAISE range — AQo does. */
const m1 = (over: Partial<Parameters<typeof mesPostflopLookup>[0]> = {}) => ({
  positions: ["BTN", "SB", "BB"],
  heroPos: "SB",
  pf3Tokens: ["F", "R3", "C"],
  flopTokens: [] as string[],
  board: ["Kc", "7d", "2h"],
  heroCards: ["Ah", "Qs"], // AQo — raised bvb under the exploit scheme
  ...over,
});

describe("mesPostflopLookup", () => {
  test("artifact is armed", () => {
    expect(mesPostflopAvailable()).toBe(true);
  });

  test("exact solved board answers hero's flop root", () => {
    const hit = mesPostflopLookup(m1());
    expect(hit).not.toBeNull();
    expect(hit!.board).toBe("Kc7d2h");
    expect(hit!.exact).toBe(true);
    expect(hit!.notInRange).toBe(false);
    expect(hit!.warning).toBeNull();
    expect(hit!.actions.length).toBeGreaterThanOrEqual(4); // Check + 3 sizes
    const total = hit!.actions.reduce((s, a) => s + a.frequency, 0);
    expect(total).toBeGreaterThan(95);
    expect(total).toBeLessThan(105);
    expect(hit!.gtoActions.length).toBe(hit!.actions.length);
    expect(hit!.exploitDecision).not.toBeNull();
    expect(hit!.chartDecision).not.toBeNull();
  });

  test("limped-premium combo reports notInRange with the reason", () => {
    // AKs limps preflop under the exploit scheme — it can never reach the
    // "SB raised" flop line, and the answer must say so, not guess.
    const hit = mesPostflopLookup(m1({ heroCards: ["Ah", "Kh"] }));
    expect(hit).not.toBeNull();
    expect(hit!.notInRange).toBe(true);
    expect(hit!.exploitDecision).toBeNull();
    expect(hit!.warning).toContain("different preflop action");
  });

  test("off-list flop maps to a nearest texture and is flagged", () => {
    const hit = mesPostflopLookup(m1({ board: ["Ks", "8d", "3h"] }));
    expect(hit).not.toBeNull();
    expect(hit!.exact).toBe(false);
    expect(hit!.warning).toContain("nearest solved texture");
  });

  test("walks a check/bet line to hero's response node", () => {
    // hero checks, BB bets ~2bb -> hero faces a bet: node must be hero's
    const hit = mesPostflopLookup(m1({ flopTokens: ["X", "R2"] }));
    expect(hit).not.toBeNull();
    expect(hit!.notInRange).toBe(false);
    const total = hit!.actions.reduce((s, a) => s + a.frequency, 0);
    expect(total).toBeGreaterThan(95);
  });

  test("wrong preflop shape (BTN open) does not match M1", () => {
    const hit = mesPostflopLookup(m1({ pf3Tokens: ["R2.5", "F", "C"] }));
    expect(hit).toBeNull(); // M2 not compiled yet, or hero_pos mismatch
  });

  test("non-3max table never matches", () => {
    const hit = mesPostflopLookup(m1({ positions: ["UTG", "HJ", "CO", "BTN", "SB", "BB"] }));
    expect(hit).toBeNull();
  });
});
