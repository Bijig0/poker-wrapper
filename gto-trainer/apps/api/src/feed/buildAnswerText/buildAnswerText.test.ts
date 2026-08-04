import { describe, expect, it } from "bun:test";
import { buildAnswerText } from "./buildAnswerText";

describe("buildAnswerText", () => {
  it("formats a single decision with no alternatives", () => {
    expect(
      buildAnswerText({
        street: "river",
        decision: { action: "Fold", frequency: 100 },
        actions: [{ action: "Fold", frequency: 100 }],
      })
    ).toBe("RIVER — Fold 100%");
  });

  it("appends alternatives above the noise floor, sorted descending", () => {
    expect(
      buildAnswerText({
        street: "flop",
        decision: { action: "Check", frequency: 76.2 },
        actions: [
          { action: "Check", frequency: 76.2 },
          { action: "Bet 1.8 (33%)", frequency: 7.3 },
          { action: "Bet 6.9 (125%)", frequency: 7 },
          { action: "Bet 4.1 (75%)", frequency: 7 },
          { action: "Bet 2.75 (50%)", frequency: 2.5 },
        ],
      })
    ).toBe("FLOP — Check 76% · Bet 1.8 (33%) 7% · Bet 6.9 (125%) 7%");
  });

  it("filters out alternatives at or below the 5% noise floor", () => {
    expect(
      buildAnswerText({
        street: "turn",
        decision: { action: "Bet 10", frequency: 90 },
        actions: [
          { action: "Bet 10", frequency: 90 },
          { action: "Check", frequency: 5 },
          { action: "Bet 20", frequency: 5 },
        ],
      })
    ).toBe("TURN — Bet 10 90%");
  });

  it("caps alternatives at two even when more clear the noise floor", () => {
    expect(
      buildAnswerText({
        street: "flop",
        decision: { action: "Check", frequency: 40 },
        actions: [
          { action: "Check", frequency: 40 },
          { action: "Bet A", frequency: 30 },
          { action: "Bet B", frequency: 20 },
          { action: "Bet C", frequency: 10 },
        ],
      })
    ).toBe("FLOP — Check 40% · Bet A 30% · Bet B 20%");
  });

  it("omits the frequency suffix when the decision has none", () => {
    expect(
      buildAnswerText({
        street: "preflop",
        decision: { action: "Raise 2.5" },
      })
    ).toBe("PREFLOP — Raise 2.5");
  });
});
