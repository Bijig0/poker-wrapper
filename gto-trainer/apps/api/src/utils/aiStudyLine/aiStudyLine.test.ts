import { describe, expect, it } from "bun:test";
import {
  actionKindOf,
  actionLabelOf,
  labelBetBb,
  matchActionIndex,
  normCard,
  preflopPotStack,
  splitPostflopTokens,
} from "./aiStudyLine";

describe("normCard", () => {
  it("normalizes case", () => {
    expect(normCard("aS")).toBe("As");
    expect(normCard("TD")).toBe("Td");
  });
  it("throws on garbage", () => {
    expect(() => normCard("1x")).toThrow();
  });
});

describe("preflopPotStack", () => {
  it("SB opens, BB calls (blind-vs-blind after folds)", () => {
    // UTG F, HJ F, CO F, BTN F, SB R3, BB C
    const { pot, stack } = preflopPotStack(["F", "F", "F", "F", "R3", "C"], 100);
    expect(pot).toBe(6); // both at 3
    expect(stack).toBe(97);
  });
  it("BTN opens, BB defends — SB's dead blind counts", () => {
    // UTG F, HJ F, CO F, BTN R2.5, SB F, BB C
    const { pot, stack } = preflopPotStack(["F", "F", "F", "R2.5", "F", "C"], 100);
    expect(pot).toBeCloseTo(5.5); // 2.5 + 2.5 + 0.5 dead SB
    expect(stack).toBe(97.5);
  });
  it("squeeze pot counts the abandoned open", () => {
    // UTG R2, HJ F, CO C, BTN F, SB R11, BB F, UTG F, CO C
    const { pot, stack } = preflopPotStack(["R2", "F", "C", "F", "R11", "F", "F", "C"], 100);
    expect(pot).toBeCloseTo(11 + 11 + 2 + 1); // SB 11, CO 11, UTG's dead 2, BB's dead 1
    expect(stack).toBe(89);
  });
  it("limped pot with BB check", () => {
    // UTG F, HJ F, CO F, BTN F, SB C, BB X
    const { pot, stack } = preflopPotStack(["F", "F", "F", "F", "C", "X"], 100);
    expect(pot).toBe(2);
    expect(stack).toBe(99);
  });
});

describe("splitPostflopTokens", () => {
  it("splits streets on card tokens", () => {
    const { streets, cards } = splitPostflopTokens(["Check", "Bet(330)", "Call", "7d", "Check"]);
    expect(streets).toEqual([["Check", "Bet(330)", "Call"], ["Check"]]);
    expect(cards).toEqual(["7d"]);
  });
  it("handles empty input", () => {
    expect(splitPostflopTokens([])).toEqual({ streets: [[]], cards: [] });
  });
});

describe("action label mapping", () => {
  const mk = (code: string, display: string, betsize: number | null = null) => ({
    action: { code, display_name: display, betsize },
  });
  it("maps kinds from codes", () => {
    expect(actionKindOf(mk("F", "Fold"))).toBe("Fold");
    expect(actionKindOf(mk("X", "Check"))).toBe("Check");
    expect(actionKindOf(mk("C", "Call"))).toBe("Call");
    expect(actionKindOf(mk("RAI", "All-in", 97.5))).toBe("AllIn");
    expect(actionKindOf(mk("R3.3", "Bet 3.3", 3.3))).toBe("Bet");
    expect(actionKindOf(mk("R11", "Raise 11", 11))).toBe("Raise");
  });
  it("labels wagers in chips", () => {
    expect(actionLabelOf(mk("R3.3", "Bet 3.3", 3.3), 0)).toBe("Bet(330)");
    expect(actionLabelOf(mk("RAI", "All-in", 97.5), 0)).toBe("AllIn(9750)");
    expect(actionLabelOf(mk("X", "Check"), 0)).toBe("Check");
  });
  it("round-trips through matchActionIndex", () => {
    const sols = [mk("X", "Check"), mk("R3.3", "Bet 3.3", 3.3), mk("RAI", "All-in", 97.5)];
    expect(matchActionIndex("Bet(330)", sols, 0)).toBe(1);
    expect(matchActionIndex("Check", sols, 0)).toBe(0);
    expect(matchActionIndex("Bet(999)", sols, 0)).toBe(-1);
  });
  it("labelBetBb parses wager labels", () => {
    expect(labelBetBb("Bet(330)")).toBeCloseTo(3.3);
    expect(labelBetBb("Check")).toBeNull();
  });
});
