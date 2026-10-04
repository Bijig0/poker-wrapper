import { describe, expect, it } from "bun:test";
import { alignedAt, alignStrategy, blendEv, blendEvs, blendStrategies, planCollapses, pickCollapses, type CollapseSeat, type SeatTok } from "./multiwayCollapse";

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

  it("a villain who folded leaves as a fold; the seats with chips in are the tree (2026-09-27)", () => {
    // SB bets, BB calls, CO folds, hero (BTN) to act: CO is gone, SB/BB/BTN are exactly three seats
    const plans = planCollapses(FOUR, "BTN", [toks(["R3", "SB"], ["C", "BB"], ["F", "CO"])]);
    expect(plans).toHaveLength(1);
    const p = plans[0]!;
    expect(p.kind).toBe("fold:CO");
    expect(p.steps).toBe(0);
    expect(p.ghostOnly).toBe(true);
    expect(p.seats.map((s) => s.pos)).toEqual(["SB", "BB", "BTN"]);
    expect(p.heroIdx).toBe(2);
    expect(p.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:R3", "BB:C"]);
    expect(p.seats[1]!.range[0]).toBe(2);                        // BB's own range, not BB + CO
  });

  it("two folds leave a heads-up street: a two-seat plan, hero in position", () => {
    // SB bets, BB folds, CO folds, hero (BTN) to act
    const plans = planCollapses(FOUR, "BTN", [toks(["R3", "SB"], ["F", "BB"], ["F", "CO"])]);
    expect(plans).toHaveLength(1);
    const p = plans[0]!;
    expect(p.kind).toBe("fold:BB + fold:CO");
    expect(p.steps).toBe(0);
    expect(p.seats.map((s) => s.pos)).toEqual(["SB", "BTN"]);
    expect(p.heroIdx).toBe(1);
    expect(p.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:R3"]);
  });

  it("a fold on the turn after a checked flop: the folder leaves every street, the live seats stay (no blend)", () => {
    // flop checks around; turn: SB bets, BB folds, hero (CO) to act with the BTN still behind
    const plans = planCollapses(FOUR, "CO", [
      toks(["X", "SB"], ["X", "BB"], ["X", "CO"], ["X", "BTN"]),
      toks(["R4", "SB"], ["F", "BB"]),
    ]);
    expect(plans).toHaveLength(1);
    const p = plans[0]!;
    expect(p.kind).toBe("fold:BB");
    expect(p.seats.map((s) => s.pos)).toEqual(["SB", "CO", "BTN"]);
    expect(p.streets[0]!.map((t) => t.seat)).toEqual(["SB", "CO", "BTN"]);
    expect(p.streets[1]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:R4"]);
  });

  it("five-way: two folds make the field exact, one fold leaves a collapse over the live seats", () => {
    const five = [seat("SB"), seat("BB"), seat("HJ"), seat("CO"), seat("BTN")];
    const two = planCollapses(five, "BTN", [toks(["R3", "SB"], ["F", "BB"], ["C", "HJ"], ["F", "CO"])]);
    expect(two.map((p) => p.kind)).toEqual(["fold:BB + fold:CO"]);
    expect(two[0]!.seats.map((s) => s.pos)).toEqual(["SB", "HJ", "BTN"]);
    expect(two[0]!.steps).toBe(0);
    // SB checks, BB checks, HJ bets, CO folds: four live seats, so the live field is collapsed — never the folder
    const one = planCollapses(five, "BTN", [toks(["X", "SB"], ["X", "BB"], ["R3", "HJ"], ["F", "CO"])]);
    expect(one.map((p) => p.kind).sort()).toEqual([
      "fold:CO + ghost:BB", "fold:CO + ghost:SB", "fold:CO + merge:BB+HJ (HJ's action)", "fold:CO + merge:SB+BB",
    ]);
    for (const p of one) {
      expect(p.steps).toBe(1);
      expect(p.seats.some((s) => s.pos === "CO" || (s.members ?? []).includes("CO"))).toBe(false);
      expect(p.streets[0]!.some((t) => t.seat === "CO")).toBe(false);
    }
    const picked = pickCollapses(one)!;
    expect(picked.mode).toBe("blend");
    expect(picked.plans.map((p) => p.kind).sort()).toEqual(["fold:CO + ghost:BB", "fold:CO + ghost:SB"]);
    // and a line where every live seat committed has no collapse — before or after: SB bets, BB folds, HJ and CO call
    expect(planCollapses(five, "BTN", [toks(["R3", "SB"], ["F", "BB"], ["C", "HJ"], ["C", "CO"])])).toHaveLength(0);
  });

  it("a seat that called and then folded is not a fold-out: its chips are in the street", () => {
    // SB bets, BB calls, CO calls, hero (BTN) raises, SB folds, BB calls, CO folds — hero's second decision
    const plans = planCollapses(FOUR, "BTN", [toks(["R3", "SB"], ["C", "BB"], ["C", "CO"], ["R9", "BTN"], ["F", "SB"], ["C", "BB"], ["F", "CO"])]);
    expect(plans.some((p) => /fold:/.test(p.kind))).toBe(false);
    expect(plans).toHaveLength(0);                                 // as before: nothing collapses, the caller re-roots or falls back
  });

  it("merges two adjacent villains and sums their ranges", () => {
    const plans = planCollapses(FOUR, "BTN", [toks(["X", "SB"], ["X", "BB"], ["X", "CO"])]);
    const m = plans.find((p) => p.kind.startsWith("merge:SB+BB"));
    expect(m).toBeDefined();
    expect(m!.seats.map((s) => s.pos)).toEqual(["SB", "CO", "BTN"]);
    expect(m!.seats[0]!.range[0]).toBe(3);                       // SB 1 + BB 2
    expect(m!.streets[0]!).toHaveLength(2);                      // the pair now acts once
  });

  it("a check-RAISE stays after the bet it raises when the seat between folds (the folder leaves, nothing merges)", () => {
    // SB x, BB x, hero (CO) bets, BTN calls, SB check-raises, BB folds — hero to act. Until 2026-09-27 this was a
    // merge of SB+BB whose one-action-per-orbit rule had to keep the raise in place; now BB simply leaves and the
    // order is the capture's own. (A seat that has checked and then folded is exactly the fold-out case, so a merged
    // pair's check-raise can no longer arise with hero to act: the seat between must call, committing, or fold, leaving.)
    const plans = planCollapses(FOUR, "CO", [toks(["X", "SB"], ["X", "BB"], ["R6.6", "CO"], ["C", "BTN"], ["R19.9", "SB"], ["F", "BB"])]);
    expect(plans.map((p) => p.kind)).toEqual(["fold:BB"]);
    expect(plans[0]!.seats.map((s) => s.pos)).toEqual(["SB", "CO", "BTN"]);
    expect(plans[0]!.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "CO:R6.6", "BTN:C", "SB:R19.9"]);
  });

  it("never merges across hero", () => {
    // hero in the middle: BB and BTN sit either side of him, so they may not be merged
    const plans = planCollapses(FOUR, "CO", [toks(["X", "SB"], ["X", "BB"], ["X", "CO"])]);
    expect(plans.every((p) => !/merge:BB\+BTN/.test(p.kind))).toBe(true);
    expect(plans.some((p) => p.kind.startsWith("merge:SB+BB"))).toBe(true);
  });

  it("refuses a merge where the pair commits twice on one street", () => {
    // SB bets and BB raises, hero (CO) to act with the BTN behind — one composite seat cannot carry both wagers
    const plans = planCollapses(FOUR, "CO", [toks(["R3", "SB"], ["R9", "BB"])]);
    expect(plans.every((p) => !p.kind.startsWith("merge:SB+BB"))).toBe(true);
    expect(plans.map((p) => p.kind)).toEqual(["ghost:BTN"]);
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

  it("prefers a merge over a lone LIVE ghost", () => {
    // SB checks, BB bets, CO calls, hero (BTN) to act: SB is still in behind the bet — the one seat that can be dropped
    const one = planCollapses(FOUR, "BTN", [toks(["X", "SB"], ["R3", "BB"], ["C", "CO"])]);
    expect(one.map((p) => p.kind)).toEqual(["ghost:SB", "merge:SB+BB (BB's action)"]);
    const p = pickCollapses(one)!;
    expect(p.mode).toBe("single");
    expect(p.plans[0]!.ghostOnly).toBe(false);
    expect(p.why).toContain("merged");
  });

  it("a folded seat is never merged and never blended: the exact plan is taken as it is (2026-09-27)", () => {
    const one = planCollapses(FOUR, "BTN", [toks(["R3", "SB"], ["C", "BB"], ["F", "CO"])]);
    const p = pickCollapses(one)!;
    expect(p.mode).toBe("single");
    expect(p.plans).toHaveLength(1);
    expect(p.plans[0]!.kind).toBe("fold:CO");
    expect(p.why).toBe("CO folded — the 3 seats still in are the tree, nothing collapsed");
    expect(p.why).not.toContain("measured");
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

describe("merge: a member's fold (2026-10-05, hand 4922575177)", () => {
  const five = ["SB", "BB", "UTG", "CO", "BTN"].map((pos, i) => ({ pos, range: new Array(1326).fill(i + 1) }));
  const T = (...xs: [string, string][]) => xs.map(([tok, seat]) => ({ tok, seat }));
  it("the hand itself: UTG only checked and folded — he leaves as a fold, SB / hero / CO is the exact tree (no merge)", () => {
    // flop: SB x, BB(hero) x, UTG x, CO bets 3.2, BTN folds, SB calls, hero calls, UTG folds; turn: SB x, hero to act
    const flop = T(["X", "SB"], ["X", "BB"], ["X", "UTG"], ["R3.2", "CO"], ["F", "BTN"], ["C", "SB"], ["C", "BB"], ["F", "UTG"]);
    const plans = planCollapses(five, "BB", [flop, T(["X", "SB"])]);
    expect(plans.map((p) => p.kind)).toEqual(["fold:UTG + fold:BTN"]);
    expect(plans[0]!.steps).toBe(0);
    expect(plans[0]!.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "BB:X", "CO:R3.2", "SB:C", "BB:C"]);
  });
  it("both members fold: the composite folds, once, when the second one does", () => {
    const flop = T(["R2", "SB"], ["C", "BB"], ["F", "UTG"], ["F", "CO"]);
    const plans = planCollapses(five, "BTN", [flop]);
    // UTG and CO folded without chips: they leave as folds, no merge needed at all
    expect(plans[0]!.kind).toBe("fold:UTG + fold:CO");
  });
});

describe("blendEvs: the EV beside a blended mix describes the mix (2026-10-03)", () => {
  // three hand-made walks of the same node (hero facing a bet: fold / call / raise), hero's combo only
  const codes = ["F", "C", "R30"];
  const walks = [
    [{ code: "F", f: 0.2, ev: 0 }, { code: "C", f: 0.8, ev: 4 }, { code: "R30", f: 0, ev: 9 }],
    [{ code: "F", f: 0.5, ev: 0 }, { code: "C", f: 0.25, ev: 2 }, { code: "R30", f: 0.25, ev: 6 }],
    [{ code: "F", f: 0.0, ev: 0 }, { code: "C", f: 0.5, ev: 5 }, { code: "R30", f: 0.5, ev: 3 }],
  ];
  it("each action's EV is the walks' EVs weighted by how often each walk plays it", () => {
    const ev = blendEvs(walks.map((w) => alignedAt(codes, w)!));
    expect(ev[0]).toBe(0);
    // call: (0.8·4 + 0.25·2 + 0.5·5) / (0.8 + 0.25 + 0.5) = 6.2 / 1.55 = 4
    expect(ev[1]!).toBeCloseTo(6.2 / 1.55, 10);
    // raise: walk 1 never raises, so its 9 says nothing: (0.25·6 + 0.5·3) / 0.75 = 4 — not the first walk's 9
    expect(ev[2]!).toBeCloseTo(4, 10);
  });
  it("no walk plays the action: the plain mean of their EVs; no walk gives one: undefined", () => {
    expect(blendEv([{ f: 0, ev: 9 }, { f: 0, ev: 3 }, { f: 0, ev: 6 }])).toBe(6);
    expect(blendEv([{ f: 0.5, ev: undefined }, { f: 0.5, ev: null }])).toBeUndefined();
    expect(blendEv([{ f: 0.5, ev: undefined }, { f: 0.25, ev: 2 }])).toBe(2);   // a walk with no EV is left out
  });
  it("a menu that names a code twice: frequencies summed, the EV their own weighted mean; a different menu: null", () => {
    expect(alignedAt(["X", "R5"], [{ code: "X", f: 0.5, ev: 1 }, { code: "R5", f: 0.25, ev: 2 }, { code: "R5", f: 0.25, ev: 4 }])).toEqual([{ f: 0.5, ev: 1 }, { f: 0.5, ev: 3 }]);
    expect(alignedAt(["F", "C"], [{ code: "F", f: 1, ev: 0 }, { code: "R75", f: 0, ev: 1 }])).toBeNull();
  });
});
