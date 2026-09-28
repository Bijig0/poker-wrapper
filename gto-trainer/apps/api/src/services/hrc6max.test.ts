import { describe, expect, it, test } from "bun:test";
import { afterEach } from "bun:test";
import { chartFor6max, openFromTokens, replayTokens6, setPatchSource } from "./hrc6max";
import { patchKeys } from "./patchKey";

/**
 * The two ways a limped pot used to lose its answer, both found by replaying 1,653 real preflop decisions through
 * the picker (src/scripts/sixmaxBacktest.ts) and both fixed on 2026-09-16. They are worth a test because neither
 * failed loudly: the picker returned a perfectly reasonable chart id, and the line only died later, deep in the
 * walk, with 'action "C" not offered' - which reads like a tree problem rather than a routing one.
 */

/** Six seats, hero wherever you put him, every stack the same unless overridden. */
const table = (heroSeat: number, stacks: Partial<Record<number, number>> = {}) => ({
  heroSeatId: heroSeat,
  committed: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as Record<number, string>,
  stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, ...stacks } as Record<number, number>,
});

describe("openFromTokens", () => {
  test("a raise with nothing in front of it is that raise's tree", () => {
    expect(openFromTokens(["F", "F", "R2.5"])).toEqual({ open: 2.5, observed: 2.5 });
  });

  test("an off-tree raise snaps to the nearest solved size, and says what it saw", () => {
    expect(openFromTokens(["F", "R2.7"])).toEqual({ open: 2.5, observed: 2.7 });
  });

  test("a limp with no raise behind it is the limp tree", () => {
    expect(openFromTokens(["C", "F"])).toEqual({ open: "limp", observed: null });
  });

  test("a limp RAISED behind is still the limp tree - the raise is an iso", () => {
    // the bug: this returned { open: 3.5 }, a raise tree, whose opening node offers fold or raise and no call,
    // so the very first token of the line had nowhere to go
    expect(openFromTokens(["C", "R3.5"])).toEqual({ open: "limp", observed: 3.5 });
    expect(openFromTokens(["F", "C", "C", "R4"])).toEqual({ open: "limp", observed: 4 });
  });

  test("nobody in yet reads as the pool's most common open", () => {
    expect(openFromTokens(["F", "F"])).toEqual({ open: 2.5, observed: null });
  });
});

describe("chartFor6max with the hand's pinned dealt stacks (2026-09-24)", () => {
  test("the pinned stacks decide the rung, not the hand's current readings", () => {
    const pinned = { 1: 50, 2: 50, 3: 50, 4: 50, 5: 50, 6: 50 };
    const c = chartFor6max(table(6) as any, "BB", ["F", "F", "F", "R3", "F"], pinned);
    expect(c.id).toBe("ign200_6max_D50_o3");
    expect(chartFor6max(table(6) as any, "BB", ["F", "F", "F", "R3", "F"]).id).toBe("ign200_6max_D100_o3");
  });
});

describe("chartFor6max", () => {
  test("an even table at a solved rung wants that rung's chart for the open it faces", () => {
    const c = chartFor6max(table(6) as any, "BB", ["F", "F", "F", "R3", "F"]);
    expect(c.id).toBe("ign200_6max_D100_o3");
    expect(c.candidates[0]).toBe("ign200_6max_D100_o3");
  });

  test("a limped pot only ever falls back to other LIMP charts", () => {
    // the second bug: the depth ladder swapped 2.5x in for "limp", offering raise trees that cannot hold a limp
    const c = chartFor6max(table(6) as any, "BB", ["C", "C", "F", "F", "F"]);
    expect(c.openSize).toBe("limp");
    expect(c.candidates.every((id) => /_olimp(_pool3?|_widex)?$/.test(id))).toBe(true);
  });

  test("a limped pot at 100bb: the BB behind limps reads the full pool-locked tree, the SB facing limps the pilot, an over-limper the equilibrium chart", () => {
    const t = table(6) as any;
    expect(chartFor6max(t, "BB", ["F", "F", "C", "C", "C"]).id).toBe("ign200_6max_D100_olimp_pool3");
    expect(chartFor6max(t, "SB", ["F", "F", "C", "C"]).id).toBe("ign200_6max_D100_olimp_pool");
    expect(chartFor6max(t, "SB", ["F", "F", "F", "C"]).id).toBe("ign200_6max_D100_olimp_pool");
    expect(chartFor6max(t, "BTN", ["C", "C", "F"]).id).toBe("ign200_6max_D100_olimp");
    expect(chartFor6max(t, "CO", ["C", "F"]).id).toBe("ign200_6max_D100_olimp");
    // facing an iso after completing: the full pool tree (the BB's iso range is solved against the pool's completes)
    expect(chartFor6max(t, "SB", ["F", "F", "F", "C", "C", "R5"]).id).toBe("ign200_6max_D100_olimp_pool3");
    // the fallback ladder still holds only limp charts
    expect(chartFor6max(t, "BB", ["F", "F", "C", "C", "C"]).candidates.every((id) => /_olimp(_pool3?|_widex)?$/.test(id))).toBe(true);
    // shallower rungs keep the equilibrium chart until the pool re-solves exist
    const short = table(6, { 1: 50, 2: 50, 3: 50, 4: 50, 5: 50, 6: 50 });
    expect(chartFor6max(short as any, "BB", ["F", "F", "C", "C", "C"]).id).toBe("ign200_6max_D50_olimp");
  });

  test("three limpers: the BB's option and every response to an iso read the wide tree; BTN/SB facing three limps do not", () => {
    const t = table(6) as any;
    // UTG, HJ, CO limp, BTN folds, SB folds — BB's option
    expect(chartFor6max(t, "BB", ["C", "C", "C", "F", "F"]).id).toBe("ign200_6max_D100_olimp_widex");
    // BB isos to 8 over three limps — the first limper responds
    expect(chartFor6max(t, "UTG", ["C", "C", "C", "F", "F", "R8"]).id).toBe("ign200_6max_D100_olimp_widex");
    // BTN facing three limps: the tree has no over-limp there — not the wide tree
    expect(chartFor6max(t, "BTN", ["C", "C", "C"]).id).not.toBe("ign200_6max_D100_olimp_widex");
    // SB facing three (or four) limps: no complete in the wide tree, and pool3's SB node is LOCKED — the pilot answers
    expect(chartFor6max(t, "SB", ["F", "C", "C", "C"]).id).toBe("ign200_6max_D100_olimp_pool");
    expect(chartFor6max(t, "SB", ["C", "C", "C", "C"]).id).toBe("ign200_6max_D100_olimp_pool");
    // two limps stay on pool3
    expect(chartFor6max(t, "BB", ["F", "F", "C", "C", "C"]).id).toBe("ign200_6max_D100_olimp_pool3");
  });

  test("125bb limp - a chart we deliberately do not have - reaches the 100bb limp chart without naming a phantom", () => {
    const deep = table(6, { 1: 125, 2: 125, 3: 125, 4: 125, 5: 125, 6: 125 });
    const c = chartFor6max(deep as any, "BB", ["C", "F", "F", "F", "F"]);
    expect(c.id).toBe("ign200_6max_D100_olimp_pool3");
    // 2026-09-27: the 125/150bb limp ids exist nowhere; naming them sent every deep limped pot to the chart server
    expect(c.candidates).not.toContain("ign200_6max_D125_olimp");
    expect(c.candidates).not.toContain("ign200_6max_D150_olimp");
    expect(c.candidates).toContain("ign200_6max_D100_olimp");
    expect(c.depth).toBe(125);
    expect(c.note).toContain("125bb limped pot");
    // hero in a non-blind seat facing a limp (a pool-locked node): the equilibrium 100bb limp chart is first, not a phantom
    const co = chartFor6max(deep as any, "CO", ["C", "F"]);
    expect(co.id).toBe("ign200_6max_D100_olimp");
    expect(co.candidates[0]).toBe("ign200_6max_D100_olimp");
    expect(co.candidates.every((id) => /^ign200_6max_D(30|50|75|100)_olimp$/.test(id))).toBe(true);
  });

  test("one short seat at a 100bb table takes the uneven chart for that seat", () => {
    const uneven = table(6, { 1: 30 });
    const c = chartFor6max(uneven as any, "BB", ["R2.5", "F", "F", "F", "F"]);
    expect(c.id).toBe("ign200_6max_D100_s30_UTG_o2_5");
    expect(c.shortSeat).toBe("UTG");
  });

  test("a limped pot at an uneven table uses the even limp chart, since the uneven set has no limp tree", () => {
    const uneven = table(6, { 1: 30 });
    const c = chartFor6max(uneven as any, "BB", ["C", "F", "F", "F", "F"]);
    expect(c.candidates.every((id) => /_olimp(_pool3?|_widex)?$/.test(id))).toBe(true);
  });
});

/**
 * Rungs by effective stack (2026-09-17). Hero always reloads to 100bb, opponents cannot be made to: below 100bb only
 * the opponents still in the hand can set the rung, above it the rung is hero against the opponent that matters.
 * The old table-median rule put a reloaded hero on the 150bb chart at a deep table and ignored both shorts when a
 * 100bb table had two of them.
 */
describe("chartFor6max — effective stack, live seats", () => {
  test("a reloaded 100bb hero at a deep table is a 100bb spot, not the table's 150", () => {
    const t = table(4, { 1: 150, 2: 150, 3: 150, 4: 100, 5: 150, 6: 150 });
    const c = chartFor6max(t as any, "BTN", ["F", "R2.5", "F"]);
    expect(c.id).toBe("ign200_6max_D100_o2_5");
    expect(c.effective).toBe(100);
    expect(c.relevant).toBe("HJ");
  });

  test("a deep hero against a deep raiser is the deep chart; against a 100bb raiser it is the 100bb chart", () => {
    const deep = table(6, { 1: 150, 6: 150 });
    expect(chartFor6max(deep as any, "BB", ["R3", "F", "F", "F", "F"]).id).toBe("ign200_6max_D150_o3");
    const mixed = table(6, { 1: 100, 3: 150, 6: 150 });
    const c = chartFor6max(mixed as any, "BB", ["R3", "F", "F", "F", "F"]);
    expect(c.id).toBe("ign200_6max_D100_o3");
    expect(c.relevant).toBe("UTG");
  });

  test("first in, the deepest live opponent sets the depth", () => {
    const t = table(3, { 1: 100, 2: 100, 3: 150, 4: 125, 5: 100, 6: 100 });
    const c = chartFor6max(t as any, "CO", ["F", "F"]);
    expect(c.id).toBe("ign200_6max_D125_o2_5");
    expect(c.relevant).toBe("BTN");
  });

  test("a short stack that already folded does not count", () => {
    const t = table(4, { 1: 30 });
    const c = chartFor6max(t as any, "BTN", ["F", "F", "R2.5"]);
    expect(c.id).toBe("ign200_6max_D100_o2_5");
    expect(c.shortSeat).toBe("EQ");
  });

  test("two live shorts: the one whose raise hero faces gets the chart, the other is noted", () => {
    const t = table(6, { 2: 30, 4: 50 });
    const c = chartFor6max(t as any, "BB", ["F", "R2.5", "F", "C", "F"]);
    expect(c.id).toBe("ign200_6max_D100_s30_HJ_o2_5");
    expect(c.note).toContain("BTN 50bb also short");
  });

  test("two live shorts, hero first in: the short still to act behind him gets the chart", () => {
    const t = table(2, { 1: 30, 4: 50 });
    const c = chartFor6max(t as any, "HJ", ["C"]);
    // UTG limped (in the pot already); the BTN is the short hero has to plan for
    expect(c.openSize).toBe("limp");
    expect(c.candidates.every((id) => /_olimp(_pool3?|_widex)?$/.test(id))).toBe(true);
    const raise = table(2, { 1: 30, 4: 50 });
    const r = chartFor6max(raise as any, "HJ", ["F"]);
    expect(r.id).toBe("ign200_6max_D100_s50_BTN_o2_5");
  });

  test("three or more shorts against a short raiser: the even chart at the effective stack", () => {
    const t = table(6, { 1: 45, 3: 45, 4: 50 });
    const c = chartFor6max(t as any, "BB", ["R2.5", "F", "C", "C", "F"]);
    expect(c.id).toBe("ign200_6max_D50_o2_5");
    expect(c.effective).toBe(45);
  });

  test("a deep spot with a short bystander: the depth wins and the short is noted", () => {
    const t = table(6, { 1: 150, 4: 30, 6: 150 });
    const c = chartFor6max(t as any, "BB", ["R3", "F", "F", "C", "F"]);
    expect(c.id).toBe("ign200_6max_D150_o3");
    expect(c.note).toContain("BTN's 30bb is not modelled");
  });

  test("a hero who has not reloaded follows his own stack, and says so", () => {
    const t = table(6, { 6: 60 });
    const c = chartFor6max(t as any, "BB", ["F", "F", "F", "R2.5", "F"]);
    expect(c.id).toBe("ign200_6max_D50_o2_5");
    expect(c.note).toContain("hero has 60bb");
  });

  test("replayTokens6 follows later orbits through the live seats only", () => {
    // UTG raises, HJ/CO fold, BTN calls, SB folds, BB 3-bets; UTG then 4-bets (second orbit: UTG, BTN, BB live)
    const r = replayTokens6(["R2.5", "F", "F", "C", "F", "R9", "R22"]);
    expect([...r.folded].sort()).toEqual(["CO", "HJ", "SB"]);
    expect(r.aggressor).toBe("UTG");
    expect(r.after).toEqual(["BB"]); // BTN acts now; the BB is still to act behind him
  });
});

describe("chartFor6max — postflop reads stacks as dealt", () => {
  test("a turn node after a 3x open, call, and a 6bb flop bet still picks the 100bb chart", () => {
    // hero SB opened 3x (100 → 97 behind), BB called, hero bet 6 on the flop and was called: 91 behind on the turn
    const t = {
      heroSeatId: 5, committed: {},
      positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as Record<number, string>,
      stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 91, 6: 91 } as Record<number, number>,
      currentNode: { street: "turn" },
      actions: [
        { seatId: 5, type: "post-sb", amount: 0.5, street: "preflop", hero: true }, { seatId: 6, type: "post-bb", amount: 1, street: "preflop" },
        { seatId: 1, type: "fold", street: "preflop" }, { seatId: 2, type: "fold", street: "preflop" }, { seatId: 3, type: "fold", street: "preflop" }, { seatId: 4, type: "fold", street: "preflop" },
        { seatId: 5, type: "raise", amount: 3, street: "preflop", hero: true }, { seatId: 6, type: "call", amount: 2, street: "preflop" },
        { seatId: 5, type: "bet", amount: 6, street: "flop", hero: true }, { seatId: 6, type: "call", amount: 6, street: "flop" },
      ],
    };
    const c = chartFor6max(t as any, "SB", ["F", "F", "F", "F", "R3", "C"]);
    expect(c.id).toBe("ign200_6max_D100_o3");
    expect(c.effective).toBe(100);
    expect(c.note ?? "").not.toContain("unreadable");
  });
});

// The picker's fallback prose is also a list of solves we do not own. This is the
// exact note from a real spot (2026-09-20):
//   "the uneven set has 2.5x and 3x only — using its 2.5x tree ·
//    the BB has 81bb — answered from the 70bb short chart"
// Two separate chart gaps, each with its own minimal job — the open at the short
// rung we HAVE, and the rung at the open we HAVE. Solving one grid cell that
// combined both would be a tree we would not otherwise build.
describe("chart-selection gaps (Approx6)", () => {
  const handWith = (bbStack: number) => ({
    heroSeatId: 1,
    positions: { 1: "BTN", 2: "SB", 3: "BB", 4: "UTG" },
    stacks: { 1: 100, 2: 100, 3: bbStack, 4: 100 },
    committed: {}, actions: [], currentNode: { street: "preflop" },
  }) as never;

  it("names the missing 2x uneven tree, and the missing 80bb rung, separately", () => {
    const c = chartFor6max(handWith(81), "BTN", ["R2"]);
    const by = Object.fromEntries((c.approx ?? []).map((a) => [a.kind, a]));

    expect(by["open-not-in-set"]).toMatchObject({
      want: 2, got: 2.5, seat: "BB",
      solve: "ign200_6max_D100_s70_BB_o2",
      asym: "deep=100;shorts=70;opens=2;seats=BB",
    });
    expect(by["short-rung-snapped"]).toMatchObject({
      want: 80, got: 70, seat: "BB",
      solve: "ign200_6max_D100_s80_BB_o2_5",
    });
    // the prose the panel shows is unchanged — the structure is additive
    expect(c.note).toContain("the uneven set has 2.5x and 3x only");
    expect(c.note).toContain("the BB has 81bb");
  });

  it("records nothing when the state lands on a tree we actually own", () => {
    const c = chartFor6max(handWith(70), "BTN", ["R2.5"]);
    expect(c.id).toBe("ign200_6max_D100_s70_BB_o2_5");
    expect(c.approx ?? []).toHaveLength(0);
  });

  // A reader fault is not a chart gap: no tree fixes an unreadable stack, and
  // suggesting one would send a solve box after a chart we already have.
  it("keeps reader faults out of the gap list", () => {
    const blind: any = { heroSeatId: 1, positions: { 1: "BTN" }, stacks: {}, committed: {}, actions: [], currentNode: { street: "preflop" } };
    const c = chartFor6max(blind, "BTN", []);
    expect(c.note).toContain("unreadable");
    expect(c.approx ?? []).toHaveLength(0);
  });
});

describe("patch charts answer first (2026-09-27)", () => {
  afterEach(() => setPatchSource(() => []));
  // hero the SB facing a BTN open, the BB behind him short at 80bb, everyone else 100: capped and exact keys coincide
  const bb80 = () => table(6, { 6: 80 }) as any;

  test("no solved patch: the grid pick is unchanged", () => {
    setPatchSource(() => []);
    const c = chartFor6max(bb80(), "SB", ["F", "F", "F", "R2.5"]);
    expect(c.patch).toBeUndefined();
    expect(c.id).toBe("ign200_6max_D100_s70_BB_o2_5");
  });

  test("a solved patch for this table goes first, the grid chart stays behind it, and the stack gap is not filed", () => {
    setPatchSource(() => ["ign200_6max_P_BB80_o2_5", "ign200_6max_P_SB80_o2_5"]);
    const c = chartFor6max(bb80(), "SB", ["F", "F", "F", "R2.5"]);
    expect(c.id).toBe("ign200_6max_P_BB80_o2_5");
    expect(c.patch).toEqual({ id: "ign200_6max_P_BB80_o2_5", variant: "exact" });
    expect(c.candidates[0]).toBe("ign200_6max_P_BB80_o2_5");
    expect(c.candidates).toContain("ign200_6max_D100_s70_BB_o2_5");
    expect(c.candidates).not.toContain("ign200_6max_P_SB80_o2_5");
    expect((c.approx ?? []).some((a) => a.kind === "short-rung-snapped")).toBe(false);
  });

  test("the patch id is the queue's own key for the same table (one rule, services/patchKey.ts)", () => {
    const want = patchKeys("ign200", { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 80 }, 2.5).map((k) => k.id);
    setPatchSource(() => want);
    expect(chartFor6max(bb80(), "SB", ["F", "F", "F", "R2.5"]).id).toBe(want[0]!);
  });

  test("exact before capped: a 130bb BTN makes the exact key differ, and the exact chart wins when both are solved", () => {
    const t = table(6, { 4: 130, 6: 80 }) as any;
    setPatchSource(() => ["ign200_6max_P_BB80_o2_5", "ign200_6max_P_BTN130_BB80_o2_5"]);
    const c = chartFor6max(t, "SB", ["F", "F", "F", "R2.5"]);
    expect(c.id).toBe("ign200_6max_P_BTN130_BB80_o2_5");
    expect(c.patch?.variant).toBe("exact");
    expect(c.candidates.slice(0, 2)).toEqual(["ign200_6max_P_BTN130_BB80_o2_5", "ign200_6max_P_BB80_o2_5"]);
    setPatchSource(() => ["ign200_6max_P_BB80_o2_5"]);
    expect(chartFor6max(t, "SB", ["F", "F", "F", "R2.5"]).patch).toEqual({ id: "ign200_6max_P_BB80_o2_5", variant: "capped" });
  });

  test("the open actually played picks the patch tree: a 2x open reads the o2 patch, not the grid's snapped size", () => {
    setPatchSource(() => ["ign200_6max_P_BB80_o2", "ign200_6max_P_BB80_o2_5"]);
    const c = chartFor6max(bb80(), "SB", ["F", "F", "F", "R2"]);
    expect(c.id).toBe("ign200_6max_P_BB80_o2");
    expect((c.approx ?? []).some((a) => a.kind === "open-not-in-set" || a.kind === "open-snapped")).toBe(false);
  });

  test("a size patch of the table (wider menu) is preferred to the plain one", () => {
    setPatchSource(() => ["ign200_6max_P_BB80_o2_5", "ign200_6max_P_BB80_o2_5_3b11"]);
    expect(chartFor6max(bb80(), "SB", ["F", "F", "F", "R2.5"]).id).toBe("ign200_6max_P_BB80_o2_5_3b11");
  });

  test("an even table can use an EVEN size patch; a limped pot never reads a patch", () => {
    setPatchSource(() => ["ign200_6max_P_EVEN_o2_5_3b11", "ign200_6max_P_BB80_olimp"]);
    expect(chartFor6max(table(6) as any, "SB", ["F", "F", "F", "R2.5"]).id).toBe("ign200_6max_D100_o2_5");
    expect(chartFor6max(bb80(), "SB", ["F", "F", "C", "C"]).patch).toBeUndefined();
  });
});

describe("the two-short grid (2026-09-27)", () => {
  afterEach(() => setPatchSource(() => []));
  test("two shorts and no patch of this table: the nearest-rung two-short chart answers, and the gaps stay filed", () => {
    const t = table(4, { 3: 63, 6: 38 }) as any;               // CO 63, BB 38, hero BTN 100
    setPatchSource(() => ["ign200_6max_P_CO60_BB40_o2_5"]);
    const c = chartFor6max(t, "BTN", ["F", "F", "R2.5"]);
    expect(c.id).toBe("ign200_6max_P_CO60_BB40_o2_5");
    expect(c.patch?.variant).toBe("snapped");
    expect(c.note).toContain("CO 63→60");
    setPatchSource(() => []);
    expect(c.approx).toEqual(chartFor6max(t, "BTN", ["F", "F", "R2.5"]).approx);   // the grid pick's gaps, kept as they were
  });
  test("the table's own patch beats the snapped grid tree", () => {
    const t = table(4, { 3: 63, 6: 38 }) as any;
    setPatchSource(() => ["ign200_6max_P_CO60_BB40_o2_5", "ign200_6max_P_CO65_BB40_o2_5"]);
    expect(chartFor6max(t, "BTN", ["F", "F", "R2.5"]).patch).toEqual({ id: "ign200_6max_P_CO65_BB40_o2_5", variant: "exact" });
  });
});
