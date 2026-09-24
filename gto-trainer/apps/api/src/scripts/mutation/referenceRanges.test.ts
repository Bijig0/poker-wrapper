import { describe, expect, test } from "bun:test";
import { referenceRanges, rangeDiff, type RefAction } from "./referenceRanges";
import type { RawNode } from "../../utils/reconstructFlopRanges/reconstructFlopRanges";

// A toy 6-max tree: UTG and HJ fold or open, CO faces the open, the blinds close it.
const N = (pos: string, actions: [string, string][], cells: Record<string, Record<string, number>>, terminal = false): RawNode =>
  ({ pos, terminal, actions: actions.map(([action, token]) => ({ action, token })), cells: Object.entries(cells).map(([hand, a]) => ({ hand, actions: a })) });
const OPEN: [string, string][] = [["Fold", "F"], ["Raise 2.5", "R2.5"], ["Raise 3", "R3"], ["All-in", "R100"]];
const TREE: Record<string, RawNode> = {
  "": N("UTG", OPEN, { AA: { "Raise 2.5": 50, "Raise 3": 50 }, KK: { "Raise 2.5": 100 }, "72o": { Fold: 100 } }),
  "F": N("HJ", OPEN, { AA: { "Raise 3": 100 }, KK: { "Raise 2.5": 40, "All-in": 60 }, "72o": { Fold: 100 } }),
  "F-R2.5": N("CO", [["Fold", "F"], ["Call", "C"], ["Raise 8", "R8"], ["All-in", "R100"]], { AA: { "Raise 8": 100 }, KK: { Call: 50, "Raise 8": 50 }, QQ: { Call: 100 } }),
  "F-R3": N("CO", [["Fold", "F"], ["Call", "C"], ["Raise 9", "R9"], ["All-in", "R100"]], { AA: { "Raise 9": 100 }, KK: { Call: 100 } }),
  "F-R2.5-C": N("BTN", [["Fold", "F"]], { AA: { Fold: 100 } }),
  "F-R2.5-C-F": N("SB", [["Fold", "F"]], { AA: { Fold: 100 } }),
  "F-R2.5-C-F-F": N("BB", [["Fold", "F"], ["Call", "C"]], { AA: { Fold: 100 }, "72o": { Fold: 100 } }),
  "F-R2.5-C-F-F-F": N("", [], {}, true),
  "F-R3-C": N("", [], {}, true),
  "F-R2.5-R100": N("HJ", [["Fold", "F"], ["Call", "C"]], { AA: { Call: 100 }, KK: { Call: 30, Fold: 70 } }),
};
const get = async (line: string) => TREE[line] ?? null;
const FIVE = ["HJ", "CO", "BTN", "SB", "BB"];

describe("referenceRanges — the independent oracle walk", () => {
  test("an undealt UTG folds, the open and the call condition their seats; the flop is HJ vs CO", async () => {
    const line: RefAction[] = [{ pos: "HJ", kind: "R", to: 2.5 }, { pos: "CO", kind: "C" }, { pos: "BTN", kind: "F" }, { pos: "SB", kind: "F" }, { pos: "BB", kind: "F" }];
    const r = await referenceRanges(line, get, { dealt: FIVE, heroPos: "CO" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toEqual(["F", "R2.5", "C", "F", "F", "F"]);
    expect(r.atFlop.sort()).toEqual(["CO", "HJ"]);
    // a villain's open is his whole raise range: AA opens 3 only, still 100% of a raise
    expect(r.ranges.HJ).toEqual({ AA: 1, KK: 0.4 });
    expect(r.ranges.CO).toEqual({ KK: 0.5, QQ: 1 });
  });
  test("hero's raise is conditioned on his exact size", async () => {
    const r = await referenceRanges([{ pos: "HJ", kind: "R", to: 2.4 }], get, { dealt: FIVE, heroPos: "HJ", pending: true });
    expect(r.ok && r.ranges.HJ).toEqual({ KK: 0.4 });
    expect(r.ok && r.pendingNode?.pos).toBe("CO");
  });
  test("a raise takes the nearest size in log distance", async () => {
    const r = await referenceRanges([{ pos: "HJ", kind: "R", to: 2.9 }], get, { dealt: FIVE, heroPos: "HJ", pending: true });
    expect(r.ok && r.path).toEqual(["F", "R3"]);
  });
  test("an all-in that raises takes the all-in action, never the nearest raise", async () => {
    const r = await referenceRanges([{ pos: "HJ", kind: "R", to: 2.5 }, { pos: "CO", kind: "A", to: 25 }], get, { dealt: FIVE, heroPos: "HJ", pending: true });
    expect(r.ok && r.path).toEqual(["F", "R2.5", "R100"]);
    expect(r.ok && r.steps[1]!.label).toBe("All-in");
  });
  test("an all-in that does not raise the price is a call", async () => {
    const r = await referenceRanges([{ pos: "HJ", kind: "R", to: 2.5 }, { pos: "CO", kind: "A", to: 2.2 }], get, { dealt: FIVE, heroPos: "HJ", pending: true });
    expect(r.ok && r.path).toEqual(["F", "R2.5", "C"]);
  });
  test("the table's actor must be the tree's: a rotation error stops the walk", async () => {
    const r = await referenceRanges([{ pos: "CO", kind: "R", to: 2.5 }], get, { dealt: FIVE, heroPos: "CO" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("the tree has HJ to act");
  });
  test("a check the node does not offer stops the walk (no borrowing)", async () => {
    const r = await referenceRanges([{ pos: "HJ", kind: "R", to: 2.5 }, { pos: "CO", kind: "X" }], get, { dealt: FIVE, heroPos: "HJ" });
    expect(!r.ok && r.why).toContain("CO's X is not offered");
  });
  test("a terminal followed only by folds is the flop (a branch the chart never wrote past)", async () => {
    const r = await referenceRanges([{ pos: "HJ", kind: "R", to: 3 }, { pos: "CO", kind: "C" }, { pos: "BTN", kind: "F" }, { pos: "SB", kind: "F" }, { pos: "BB", kind: "F" }],
      get, { dealt: FIVE, heroPos: "CO" });
    expect(r.ok && r.atFlop.sort()).toEqual(["CO", "HJ"]);
    expect(r.ok && r.ranges.CO).toEqual({ KK: 1 });
  });
  test("a terminal with a real action after it stops the walk", async () => {
    const r = await referenceRanges([{ pos: "HJ", kind: "R", to: 3 }, { pos: "CO", kind: "C" }, { pos: "BTN", kind: "C" }], get, { dealt: FIVE, heroPos: "CO" });
    expect(!r.ok && r.why).toContain("terminal at \"F-R3-C\"");
  });
  test("with UTG dealt, the root is his: a line starting with the HJ is a rotation error", async () => {
    const r = await referenceRanges([{ pos: "HJ", kind: "R", to: 2.5 }], get, { dealt: ["UTG", ...FIVE], heroPos: "HJ" });
    expect(!r.ok && r.why).toContain("the tree has UTG to act");
  });
  test("rangeDiff names the class that differs most", () => {
    expect(rangeDiff({ AA: 1, KK: 0.5 }, { AA: 1, KK: 0.2, QQ: 0.1 })).toEqual({ max: 0.3, cls: "KK", a: 0.5, b: 0.2 });
  });
});
