import { describe, expect, test } from "bun:test";
import { checkAnswerIntegrity, isCheckable, actionForRoll, MIX_FLOOR_PCT } from "./answerIntegrity";

describe("checkAnswerIntegrity", () => {
  test("a pure answer served with its own mix is clean", () => {
    expect(checkAnswerIntegrity({ pick: "Raise 2.5", roll: null, actions: [{ action: "Raise 2.5", frequency: 100 }] })).toEqual([]);
  });

  test("the real 2026-09-14 fault: pick from one piece, mix from another", () => {
    // SB 3d8d: the pool-exploit piece said Raise 2.5, the mix shipped was the
    // equilibrium chart's. Note Raise 2.5 IS present — at 0.01% — so a presence
    // test passes and misses it. The frequency floor is what catches it.
    const faults = checkAnswerIntegrity({
      pick: "Raise 2.5",
      roll: null,
      actions: [
        { action: "Fold", frequency: 99.97 },
        { action: "Raise 2.5", frequency: 0.01 },
        { action: "Raise 2.8", frequency: 0.01 },
        { action: "Raise 3.5", frequency: 0.01 },
      ],
    });
    expect(faults).toHaveLength(1);
    expect(faults[0]!.kind).toBe("served-off-mix");
    expect(faults[0]!.severity).toBe("severe");
    expect(faults[0]!.detail).toContain("0.01%");
  });

  test("an action absent from the mix entirely is the same fault", () => {
    const faults = checkAnswerIntegrity({ pick: "Bet 4", actions: [{ action: "Check", frequency: 100 }] });
    expect(faults.map((f) => f.kind)).toEqual(["served-off-mix"]);
    expect(faults[0]!.detail).toContain("not in the mix");
  });

  test("a genuine mix served an action it plays is clean", () => {
    expect(checkAnswerIntegrity({
      pick: "Raise 3", roll: 80,
      actions: [{ action: "Fold", frequency: 70 }, { action: "Raise 3", frequency: 30 }],
    })).toEqual([]);
  });

  test("the roll landing elsewhere than the action served is a fault", () => {
    // 70/30: a roll of 12 is inside Fold's band, so serving Raise 3 is wrong
    const faults = checkAnswerIntegrity({
      pick: "Raise 3", roll: 12,
      actions: [{ action: "Fold", frequency: 70 }, { action: "Raise 3", frequency: 30 }],
    });
    expect(faults.map((f) => f.kind)).toEqual(["roll-mismatch"]);
    expect(faults[0]!.detail).toContain("Fold");
  });

  test("sub-floor noise is dropped before the roll is walked, exactly as the roller does", () => {
    // Fold 70 / Raise 3 30 with 0.01% noise: a roll of 71 must still be Raise 3
    expect(actionForRoll([
      { action: "Fold", frequency: 70 }, { action: "Raise 3", frequency: 30 }, { action: "Raise 9", frequency: 0.01 },
    ], 71)).toBe("Raise 3");
  });

  test("a pure decision has no roll to check", () => {
    expect(actionForRoll([{ action: "Check", frequency: 100 }], 50)).toBeNull();
  });

  test("an answer with no stored mix is UNCHECKED, not clean", () => {
    const a = { pick: "Fold", roll: null, actions: null };
    expect(isCheckable(a)).toBe(false);
    expect(checkAnswerIntegrity(a)).toEqual([]);
  });

  test("label matching is exact: a neighbouring size is a different action", () => {
    // fuzzy sizing would match Raise 2.5 to Raise 2.8 and hide the fault
    const faults = checkAnswerIntegrity({ pick: "Raise 2.5", actions: [{ action: "Raise 2.8", frequency: 100 }] });
    expect(faults.map((f) => f.kind)).toEqual(["served-off-mix"]);
  });

  test("the floor is the roller's floor", () => {
    expect(MIX_FLOOR_PCT).toBe(1);
    expect(checkAnswerIntegrity({ pick: "Raise 2", actions: [{ action: "Raise 2", frequency: 0.9 }, { action: "Fold", frequency: 99.1 }] }))
      .toHaveLength(1);
    expect(checkAnswerIntegrity({ pick: "Raise 2", actions: [{ action: "Raise 2", frequency: 1.5 }, { action: "Fold", frequency: 98.5 }] }))
      .toEqual([]);
  });
});
