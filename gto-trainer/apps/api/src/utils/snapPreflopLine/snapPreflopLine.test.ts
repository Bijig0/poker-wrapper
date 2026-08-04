import { describe, it, expect } from "bun:test";
import { snapPreflopLine, type SnapNode } from "./snapPreflopLine";

// CO opens (tree offers 2.3, not 2.5), BB calls.
const nodes: Record<string, SnapNode> = {
  "": { pos: "UTG", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.3", token: "R2.3" }] },
  F: { pos: "HJ", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.3", token: "R2.3" }] },
  "F-F": { pos: "CO", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.3", token: "R2.3" }] },
  "F-F-R2.3": { pos: "BTN", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }] },
  "F-F-R2.3-F": { pos: "SB", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }] },
  "F-F-R2.3-F-F": { pos: "BB", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }] },
};
const getNode = (l: string): SnapNode | null => nodes[l] ?? null;

describe("snapPreflopLine", () => {
  it("snaps an off-tree open (2.5 → 2.3) across the whole line", () => {
    const r = snapPreflopLine("F-F-R2.5-F-F-C".split("-"), getNode);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.join("-")).toBe("F-F-R2.3-F-F-C");
    expect(r.repaired).toHaveLength(1);
    expect(r.repaired[0]!.index).toBe(2);
  });

  it("leaves an on-tree line unchanged", () => {
    const r = snapPreflopLine("F-F-R2.3-F-F-C".split("-"), getNode);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repaired).toHaveLength(0);
  });

  it("fails on a missing node", () => {
    const r = snapPreflopLine("F-F-R2.3-F-F-C".split("-"), (l) => (l === "F-F" ? null : getNode(l)));
    expect(r.ok).toBe(false);
  });
});
