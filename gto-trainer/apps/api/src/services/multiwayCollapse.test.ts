import { describe, expect, it } from "bun:test";
import { alignStrategy, blendStrategies, planCollapses, pickCollapses, type CollapseSeat, type SeatTok } from "./multiwayCollapse";

const seat = (pos: string, w = 1): CollapseSeat => ({ pos, range: new Array(6).fill(w) });
/** four-way flop in postflop order */
const FOUR = [seat("SB", 1), seat("BB", 2), seat("CO", 3), seat("BTN", 4)];
const toks = (...xs: [string, string][]): SeatTok[] => xs.map(([tok, s]) => ({ tok, seat: s }));

describe("planCollapses", () => {
  it("a checked-around four-way flop has one ghost per villain", () => {
    const plans = planCollapses(FOUR, "BTN", [toks(["X", "SB"], ["X", "BB"], ["X", "CO"])]);
    const ghosts = plans.filter((p) => p.ghostOnly);
    expect(ghosts.map((p) => p.kind).sort()).toEqual(["ghost:BB", "ghost:CO", "ghost:SB"]);
    for (const p of ghosts) {
      expect(p.seats).toHaveLength(3);
      expect(p.seats.some((s) => s.pos === "BTN")).toBe(true);
      expect(p.streets[0]!.map((t) => t.seat)).not.toContain(p.kind.split(":")[1]);
    }
  });

  it("a villain with chips in cannot be ghosted", () => {
    // SB bets, BB calls, CO folds, hero (BTN) to act: only CO is free
    const plans = planCollapses(FOUR, "BTN", [toks(["R3", "SB"], ["C", "BB"], ["F", "CO"])]);
    expect(plans.filter((p) => p.ghostOnly).map((p) => p.kind)).toEqual(["ghost:CO"]);
  });

  it("merges two adjacent villains and sums their ranges", () => {
    const plans = planCollapses(FOUR, "BTN", [toks(["X", "SB"], ["X", "BB"], ["X", "CO"])]);
    const m = plans.find((p) => p.kind.startsWith("merge:SB+BB"));
    expect(m).toBeDefined();
    expect(m!.seats.map((s) => s.pos)).toEqual(["SB", "CO", "BTN"]);
    expect(m!.seats[0]!.range[0]).toBe(3);                       // SB 1 + BB 2
    expect(m!.streets[0]!).toHaveLength(2);                      // the pair now acts once
  });

  it("never merges across hero", () => {
    // hero in the middle: BB and BTN sit either side of him, so they may not be merged
    const plans = planCollapses(FOUR, "CO", [toks(["X", "SB"], ["X", "BB"], ["X", "CO"])]);
    expect(plans.every((p) => !/merge:BB\+BTN/.test(p.kind))).toBe(true);
    expect(plans.some((p) => p.kind.startsWith("merge:SB+BB"))).toBe(true);
  });

  it("refuses a merge where the pair commits twice on one street", () => {
    // SB bets and BB raises — one composite seat cannot carry both
    const plans = planCollapses(FOUR, "BTN", [toks(["R3", "SB"], ["R9", "BB"], ["F", "CO"])]);
    expect(plans.every((p) => !p.kind.startsWith("merge:SB+BB"))).toBe(true);
  });

  it("a five-way flop needs two primitives", () => {
    const five = [seat("SB"), seat("BB"), seat("HJ"), seat("CO"), seat("BTN")];
    const plans = planCollapses(five, "BTN", [toks(["X", "SB"], ["X", "BB"], ["X", "HJ"], ["X", "CO"])]);
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      expect(p.seats).toHaveLength(3);
      expect(p.steps).toBe(2);
    }
    expect(plans.some((p) => p.ghostOnly)).toBe(true);
  });

  it("returns nothing when every villain has chips in and no pair is mergeable", () => {
    // hero in the middle, both neighbours committed: no ghost, and a merge would cross hero
    const plans = planCollapses(FOUR, "BB", [toks(["R3", "SB"], ["C", "BB"], ["C", "CO"], ["C", "BTN"])]);
    expect(plans.filter((p) => p.ghostOnly)).toHaveLength(0);
  });
});

describe("pickCollapses", () => {
  const plans = planCollapses(FOUR, "BTN", [toks(["X", "SB"], ["X", "BB"], ["X", "CO"])]);

  it("blends when two or more ghosts are legal", () => {
    const p = pickCollapses(plans)!;
    expect(p.mode).toBe("blend");
    expect(p.plans.length).toBeGreaterThanOrEqual(2);
    expect(p.plans.every((x) => x.ghostOnly)).toBe(true);
  });

  it("caps the number of cloud walks", () => {
    expect(pickCollapses(plans, 2)!.plans).toHaveLength(2);
  });

  it("prefers a merge over a lone ghost", () => {
    const one = planCollapses(FOUR, "BTN", [toks(["R3", "SB"], ["C", "BB"], ["F", "CO"])]);
    const p = pickCollapses(one)!;
    expect(p.mode).toBe("single");
    expect(p.plans[0]!.ghostOnly).toBe(false);
    expect(p.why).toContain("merged");
  });

  it("is null when nothing is legal", () => {
    expect(pickCollapses([])).toBeNull();
  });
});

describe("blendStrategies", () => {
  const codes = ["F", "C", "R60"];

  it("folds as often as the most folding collapse and raises as little as the least raising one", () => {
    const a = [[0.2], [0.5], [0.3]];
    const b = [[0.4], [0.5], [0.1]];
    const out = blendStrategies(codes, [a, b]);
    expect(out[0]![0]).toBeCloseTo(0.4, 6);   // fold = max
    expect(out[2]![0]).toBeCloseTo(0.1, 6);   // raise = min
    expect(out[1]![0]).toBeCloseTo(0.5, 6);   // call absorbs the rest
    expect(out.reduce((s, r) => s + r[0]!, 0)).toBeCloseTo(1, 6);
  });

  it("is a no-op on a single collapse", () => {
    const a = [[0.2], [0.5], [0.3]];
    expect(blendStrategies(codes, [a])).toBe(a);
  });

  it("keeps every combo a probability distribution", () => {
    const a = [[0.9, 0.1], [0.05, 0.2], [0.05, 0.7]];
    const b = [[0.1, 0.8], [0.8, 0.1], [0.1, 0.1]];
    const out = blendStrategies(codes, [a, b]);
    for (let i = 0; i < 2; i++) expect(out.reduce((s, r) => s + r[i]!, 0)).toBeCloseTo(1, 6);
  });
});

describe("alignStrategy", () => {
  it("re-expresses a collapse on the reference action list", () => {
    const out = alignStrategy(["F", "C", "R60"], [
      { code: "R60", strategy: [0.3] }, { code: "F", strategy: [0.2] }, { code: "C", strategy: [0.5] },
    ]);
    expect(out).toEqual([[0.2], [0.5], [0.3]]);
  });

  it("refuses when the menus differ — the collapses disagree about the tree", () => {
    expect(alignStrategy(["F", "C"], [{ code: "F", strategy: [1] }, { code: "R75", strategy: [0] }])).toBeNull();
  });
});
