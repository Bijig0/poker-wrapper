import { describe, expect, it } from "bun:test";
import { walkPreflopLine, type WalkNode } from "./walkPreflopLine";

/** A tiny HU-style tree: SB root (fold/limp/raise), BB response, SB vs 3-bet. */
const TREE: Record<string, WalkNode> = {
  "": {
    pos: "SB",
    terminal: false,
    actions: [
      { action: "Fold", token: "F" },
      { action: "Call", token: "C" },
      { action: "Raise 2.5", token: "R2.5" },
      { action: "Allin 100", token: "RAI" },
    ],
  },
  "R2.5": {
    pos: "BB",
    terminal: false,
    actions: [
      { action: "Fold", token: "F" },
      { action: "Call", token: "C" },
      { action: "Raise 10", token: "R10" },
      { action: "Raise 12.5", token: "R12.5" },
    ],
  },
  "R2.5-R10": {
    pos: "SB",
    terminal: false,
    actions: [
      { action: "Fold", token: "F" },
      { action: "Call", token: "C" },
      { action: "Raise 24", token: "R24" },
    ],
  },
  "R2.5-C": { pos: null, terminal: true, actions: [] },
};

const getNode = (line: string) => TREE[line] ?? null;

describe("walkPreflopLine", () => {
  it("walks an exact on-tree line to the hero node", () => {
    const r = walkPreflopLine(["R2.5", "R10"], getNode);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.pos).toBe("SB");
      expect(r.repaired).toEqual([]);
      expect(r.tokens).toEqual(["R2.5", "R10"]);
    }
  });

  it("snaps an off-tree size to the nearest offered and continues", () => {
    // villain 3-bet to 9.4 — tree offers 10 and 12.5; log-nearest is 10
    const r = walkPreflopLine(["R2.5", "R9.4"], getNode);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tokens).toEqual(["R2.5", "R10"]);
      expect(r.repaired).toEqual([{ index: 1, from: 9.4, to: 10 }]);
    }
  });

  it("snaps the open size too", () => {
    const r = walkPreflopLine(["R3", "R10"], getNode);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toEqual(["R2.5", "R10"]);
  });

  it("fails cleanly when a node is missing from the DB", () => {
    const r = walkPreflopLine(["R2.5", "R12.5"], getNode); // R2.5-R12.5 not crawled
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingAt).toBe("R2.5-R12.5");
  });

  it("drops an impossible check instead of failing (capture phantom)", () => {
    // A check where checking isn't offered (e.g. facing a raise) can only be
    // a mis-captured action — the walk skips it and the line survives.
    const r = walkPreflopLine(["X"], getNode); // no check at SB root
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toEqual([]);
  });

  it("fails cleanly when the line ends on a terminal", () => {
    const r = walkPreflopLine(["R2.5", "C"], getNode); // call closes preflop
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("terminal");
  });

  it("empty line resolves to the root node (hero first to act)", () => {
    const r = walkPreflopLine([], getNode);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.pos).toBe("SB");
  });
});
