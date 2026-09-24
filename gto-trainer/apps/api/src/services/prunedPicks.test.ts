import { describe, expect, it } from "bun:test";
import { dropPrunedPicks, prunedPicksNote } from "./prunedPicks";
import type { HrcNode } from "./hrc3max";

// BTN facing a 3-bet: the chart 4-bets 23 or 28 and jams 0.4% — HRC never wrote the jam's subtree
const node: HrcNode = {
  pos: "BTN", terminal: false,
  actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }, { action: "Raise 23", token: "R23" }, { action: "Raise 28", token: "R28" }, { action: "All-in", token: "R100" }],
  cells: [],
};
const children: Record<string, HrcNode> = {
  "F-F-F-R2.5-R9-F": { pos: "SB", terminal: true, actions: [], cells: [] },
  "F-F-F-R2.5-R9-C": { pos: "BB", terminal: false, actions: [{ action: "Fold", token: "F" }], cells: [] },
  "F-F-F-R2.5-R9-R23": { pos: "SB", terminal: false, actions: [{ action: "Fold", token: "F" }], cells: [] },
  "F-F-F-R2.5-R9-R28": { pos: "SB", terminal: false, actions: [{ action: "Fold", token: "F" }], cells: [] },
  "F-F-F-R2.5-R9-R100": { pos: "BTN", terminal: true, pruned: "reach", actions: [], cells: [] },
};
const get = async (line: string) => children[line] ?? null;

describe("dropPrunedPicks", () => {
  it("drops the action whose child HRC never wrote and re-spreads the mix over the rest", async () => {
    const r = await dropPrunedPicks([{ action: "Raise 23", frequency: 60 }, { action: "Raise 28", frequency: 39.6 }, { action: "All-in", frequency: 0.4 }], node, "F-F-F-R2.5-R9", get);
    expect(r.dropped.map((d) => d.action)).toEqual(["All-in"]);
    expect(r.dropped[0]!.kind).toBe("reach");
    expect(r.actions.map((a) => a.action)).toEqual(["Raise 23", "Raise 28"]);
    expect(r.actions.reduce((s, a) => s + a.frequency, 0)).toBeCloseTo(100, 1);
    expect(r.actions[0]!.frequency).toBeCloseTo(60 * 100 / 99.6, 1);
    expect(prunedPicksNote(r.dropped)).toContain("All-in (0.4%)");
  });
  it("leaves a mix alone when no child is pruned, and keeps genuine terminals (a fold) as picks", async () => {
    const mix = [{ action: "Fold", frequency: 70 }, { action: "Call", frequency: 30 }];
    const r = await dropPrunedPicks(mix, node, "F-F-F-R2.5-R9", get);
    expect(r.actions).toBe(mix);
    expect(r.dropped).toEqual([]);
    expect(prunedPicksNote(r.dropped)).toBeNull();
  });
  it("a child the getter cannot find is not treated as pruned", async () => {
    const r = await dropPrunedPicks([{ action: "Call", frequency: 50 }, { action: "All-in", frequency: 50 }], node, "somewhere-else", get);
    expect(r.dropped).toEqual([]);
  });
});
