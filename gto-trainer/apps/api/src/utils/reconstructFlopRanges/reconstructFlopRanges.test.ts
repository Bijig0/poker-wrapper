import { describe, it, expect } from "bun:test";
import { reconstructFlopRanges, classWeightsToSpec, type RawNode } from "./reconstructFlopRanges";

// UTG/HJ fold, CO opens 2.5, BTN/SB fold, BB calls → flop CO (opener) vs BB (caller).
const nodes: Record<string, RawNode> = {
  "": { pos: "UTG", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }], cells: [] },
  F: { pos: "HJ", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }], cells: [] },
  "F-F": {
    pos: "CO", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }],
    cells: [
      { hand: "AA", actions: { "Raise 2.5": 100 } },
      { hand: "AKs", actions: { "Raise 2.5": 80, Fold: 20 } },
      { hand: "72o", actions: { Fold: 100 } },
    ],
  },
  "F-F-R2.5": { pos: "BTN", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }], cells: [] },
  "F-F-R2.5-F": { pos: "SB", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }], cells: [] },
  "F-F-R2.5-F-F": {
    pos: "BB", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }],
    cells: [
      { hand: "T9s", actions: { Call: 60, Fold: 40 } },
      { hand: "KQo", actions: { Call: 50, Fold: 50 } },
    ],
  },
};
const getNode = (l: string): RawNode | null => nodes[l] ?? null;

describe("reconstructFlopRanges", () => {
  it("recovers both flop players' weighted ranges by position", async () => {
    const r = await reconstructFlopRanges("F-F-R2.5-F-F-C".split("-"), getNode);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ranges["CO"]!["AA"]).toBeCloseTo(1);
    expect(r.ranges["CO"]!["AKs"]).toBeCloseTo(0.8);
    expect(r.ranges["CO"]!["72o"]).toBeUndefined();
    expect(r.ranges["BB"]!["T9s"]).toBeCloseTo(0.6);
    expect(r.ranges["BB"]!["KQo"]).toBeCloseTo(0.5);
  });

  it("snaps an off-tree open (2.6 → 2.5)", async () => {
    const r = await reconstructFlopRanges("F-F-R2.6-F-F-C".split("-"), getNode);
    expect(r.ok).toBe(true);
  });

  it("fails when not exactly two reach the flop", async () => {
    const r = await reconstructFlopRanges("F-F-R2.5-F-F-F".split("-"), getNode);
    expect(r.ok).toBe(false);
  });
});

describe("classWeightsToSpec", () => {
  it("bare for full weight, class:weight otherwise", async () => {
    expect(classWeightsToSpec({ AA: 1, AKs: 0.8, T9s: 0 })).toBe("AA,AKs:0.8");
  });
});
