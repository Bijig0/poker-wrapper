import { describe, expect, it } from "bun:test";
import { buildLinePlan, type LineState } from "./buildLinePlan";

const act = (
  position: string,
  taken: string | null,
  active = false,
  options: string[] = []
) => ({ tst: `hs_x_${position}`, position, active, taken, options });

/** BTN opens 2.5x, SB folds, BB calls; flop checks through to a turn decision. */
const turnLine: LineState = {
  streets: [
    {
      street: "preflop",
      cards: [],
      pot: null,
      actions: [
        act("UTG", "Fold"),
        act("HJ", "Fold"),
        act("CO", "Fold"),
        act("BTN", "Raise 2.5"),
        act("SB", "Fold"),
        act("BB", "Call"),
      ],
    },
    {
      street: "flop",
      cards: ["Q", "J", "2"],
      pot: 5.5,
      actions: [act("BB", "Check"), act("BTN", "Bet 1.8 (33%)"), act("BB", "Call")],
    },
    {
      street: "turn",
      cards: ["8"],
      pot: 9.1,
      actions: [act("BB", "Check"), act("BTN", null, true, ["Check", "Bet 3 (33%)", "Bet 6.8 (75%)"])],
    },
  ],
  activeTst: "hs_x_BTN",
  activePosition: "BTN",
  board: "QhJh2s8c",
};

describe("buildLinePlan", () => {
  it("builds a turn off-tree plan from an SRP line", () => {
    const plan = buildLinePlan(turnLine, "BTN");
    expect(plan.seats.sort()).toEqual(["BB", "BTN"]);
    expect(plan.scenario).toBe("SRP");
    expect(plan.offTreeStreet).toBe("turn");
    expect(plan.villainIsOOP).toBe(false); // BB acts first postflop, villain is BTN
    expect(plan.boards).toEqual({ flop: ["Qh", "Jh", "2s"], turn: "8c" });
    expect(plan.lineSizes).toEqual({ flop: [33] });
    expect(plan.replay).toEqual([
      { street: "flop", labels: ["Check", "Bet 1.8 (33%)", "Call"] },
      { street: "turn", labels: ["Check"] },
    ]);
    expect(plan.potAtNode).toBe(9.1);
  });

  it("classifies 3-bet pots", () => {
    const line: LineState = {
      ...turnLine,
      streets: [
        {
          street: "preflop",
          cards: [],
          pot: null,
          actions: [
            act("UTG", "Fold"),
            act("HJ", "Fold"),
            act("CO", "Fold"),
            act("BTN", "Raise 2.5"),
            act("SB", "Raise 12"),
            act("BB", "Fold"),
            act("BTN", "Call"),
          ],
        },
        {
          street: "flop",
          cards: ["Q", "J", "2"],
          pot: 25,
          actions: [act("SB", null, true, ["Check", "Bet 8 (33%)"])],
        },
      ],
      board: "QhJh2s",
    };
    const plan = buildLinePlan(line, "SB");
    expect(plan.scenario).toBe("3bet");
    expect(plan.offTreeStreet).toBe("flop");
    expect(plan.villainIsOOP).toBe(true);
    expect(plan.replay).toEqual([{ street: "flop", labels: [] }]);
  });

  it("rejects multiway pots", () => {
    const line: LineState = {
      ...turnLine,
      streets: [
        {
          street: "preflop",
          cards: [],
          pot: null,
          actions: [act("CO", "Raise 2.3"), act("BTN", "Call"), act("BB", "Call")],
        },
        { street: "flop", cards: [], pot: 8, actions: [act("BB", null, true)] },
      ],
    };
    expect(() => buildLinePlan(line, "CO")).toThrow(/heads-up/);
  });

  it("rejects hero/villain not in the hand", () => {
    expect(() => buildLinePlan(turnLine, "SB")).toThrow(/isn't in the hand/);
  });

  it("requires a flop", () => {
    const line = { ...turnLine, board: null };
    expect(() => buildLinePlan(line, "BTN")).toThrow(/flop/);
  });
});
