import { describe, expect, it } from "bun:test";
import { describeTreeChange, gtowApi, treeFingerprint, type CustomTreeInput } from "./gtowApi";

/**
 * Why a tree was created instead of reused (2026-09-24). The chain re-walks every earlier street on every
 * decision and expects those trees back from the cache; a turn that re-creates its flop tree is a leak, and
 * the fingerprint diff is what names it in the trace and the [chain] log line.
 */
const range = (w: number) => new Array(1326).fill(w);
const base: CustomTreeInput = {
  board: "4c6d5s", pot: 21.44, stack: 69.28, oopRange: range(1), ipRange: range(0.5), startingStreet: "FLOP",
  rake: { pct_of_pot: 5, cap_in_chips: 0.9, preflop_rake_type: null },
};

describe("describeTreeChange", () => {
  it("names the first tree for a board and street", () => {
    expect(describeTreeChange(null, treeFingerprint(base))).toBe("first FLOP tree for 4c6d5s in this process");
  });

  it("names a stack that drifted between probes (hand 140706500001's turn)", () => {
    expect(describeTreeChange(treeFingerprint(base), treeFingerprint({ ...base, stack: 67.88 }))).toBe("re-created: stack 69.28→67.88");
  });

  it("names a size pinned after a wager — the expected re-create", () => {
    expect(describeTreeChange(treeFingerprint(base), treeFingerprint({ ...base, fixedLevels: { FLOP: ["100%"] } })))
      .toBe("re-created: fixed sizes null→[100%]");
  });

  it("names a range that changed without printing it", () => {
    const why = describeTreeChange(treeFingerprint(base), treeFingerprint({ ...base, ipRange: range(0.4) }));
    expect(why).toContain("IP range changed");
    expect(why).toContain("663→530.4");
    expect(why).not.toContain("OOP range");
  });

  it("names a third seat by GTO Wizard's name", () => {
    const three = { ...base, mid: { pos: "BB", range: range(1) } };
    const why = describeTreeChange(treeFingerprint(three), treeFingerprint({ ...three, mid: { pos: "BB", range: range(0.9) } }));
    expect(why).toContain("OOP+1 range changed");
  });

  it("says so when nothing in the fingerprint moved", () => {
    expect(describeTreeChange(treeFingerprint(base), treeFingerprint({ ...base }))).toContain("IDENTICAL fingerprint");
  });
});

describe("node cache is a true LRU", () => {
  it("a hit is re-inserted at the end, so a hand's earlier-street nodes outlive a burst of fresh ones", async () => {
    const api = gtowApi as unknown as { nodeCache: Map<string, unknown>; customNode: typeof gtowApi.customNode };
    const cache = api.nodeCache;
    cache.clear();
    const key = (n: string) => JSON.stringify(["sol", n, "", "", "4c6d5s"]);
    cache.set(key("root"), { action_solutions: [1] });
    cache.set(key("X"), { action_solutions: [1] });
    const r = await gtowApi.customNode("sol", { flopActions: "root", board: "4c6d5s" });
    expect(r.ok && r.src).toBe("cache");
    expect([...cache.keys()]).toEqual([key("X"), key("root")]);
    cache.clear();
  });
});
