import { describe, expect, test } from "bun:test";
import { applyPoolLimpFloor, poolChartCovers, poolLimpersOf, poolLimpKey } from "./poolLimpFloor";
import { withinFirstStackBound } from "./treeGap";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * Hand 4922555015 (2026-10-04, table 1): UTG folds, a 39bb HJ limps, CO/BTN/SB fold, hero checks his BB with 76o. The
 * even 30bb limp chart gave the HJ 2.98 combos at the flop; two checks later his range was empty and the river had no
 * node. The floor gives him the pool's ≤60bb first-in limp range unless a pool-locked tree covers his stack.
 */
const POS = { 1: "BB", 2: "UTG", 3: "HJ", 4: "CO", 5: "BTN", 6: "SB" } as Record<number, string>;
const pre = (seatId: number, type: string, amount?: number) => ({ seatId, hero: seatId === 1, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const hand = (actions: any[], heroSeatId = 1): ParsedHand => ({ heroSeatId, positions: POS, actions, stacks: {}, committed: {} } as unknown as ParsedHand);
const dealt = (over: Record<number, number> = {}) => ({ 1: 135.8, 2: 11.6, 3: 39, 4: 26.2, 5: 96.2, 6: 151.2, ...over });
const HAND_4922555015 = [pre(6, "post-sb", 0.4), pre(1, "post-bb", 1), pre(2, "fold"), pre(3, "call", 1), pre(4, "fold"), pre(5, "fold"), pre(6, "fold"), pre(1, "check")];
const TINY = { QJs: 0.01, "77": 0.01, KTs: 0.01 };
const ranges = () => ({ HJ: { ...TINY }, BB: { "72o": 1, AKs: 1 } });
/** the bake's provenance plan per chart: every pool tree a v2 one unless a test says otherwise */
const V2 = (id: string) => (/olimp_pool/.test(id) ? "limp-v2-uneven" : null);

describe("withinFirstStackBound (the gap gate's first-decision bound)", () => {
  test("1.5x while the smaller stack is under 50bb, no bound from 50bb", () => {
    expect(withinFirstStackBound(39, 30)).toBe(true);     // 1.3x
    expect(withinFirstStackBound(20, 30)).toBe(true);     // 1.5x exactly
    expect(withinFirstStackBound(18, 30)).toBe(false);    // 1.67x
    expect(withinFirstStackBound(39, 100)).toBe(false);   // 2.56x, 39 < 50
    expect(withinFirstStackBound(55, 100)).toBe(true);    // 55 >= 50
    expect(withinFirstStackBound(0, 30)).toBe(false);
  });
});

describe("poolLimpersOf", () => {
  test("the HJ's call before any raise is a first-in limp; hero's own check is not", () => {
    expect(poolLimpersOf(hand(HAND_4922555015), "BB")).toEqual([{ pos: "HJ", limpsBefore: 0, complete: false, raisedLater: false }]);
  });

  test("an over-limp counts the limps before it (hero's included), the SB's call is a complete, a limp-raise is marked", () => {
    const acts = [pre(6, "post-sb", 0.4), pre(1, "post-bb", 1), pre(2, "call", 1), pre(3, "call", 1), pre(4, "fold"), pre(5, "call", 1),
      pre(6, "call", 0.6), pre(1, "raise", 6), pre(2, "raise", 20)];
    const ls = poolLimpersOf(hand(acts), "BB");
    expect(ls.map((l) => [l.pos, l.limpsBefore, l.complete, l.raisedLater])).toEqual([
      ["UTG", 0, false, true], ["HJ", 1, false, false], ["BTN", 2, false, false], ["SB", 3, true, false],
    ]);
  });

  test("a call after a raise is not a limp", () => {
    const acts = [pre(6, "post-sb", 0.4), pre(1, "post-bb", 1), pre(2, "raise", 2.5), pre(3, "call", 2.5), pre(4, "fold")];
    expect(poolLimpersOf(hand(acts), "BB")).toEqual([]);
  });
});

describe("poolLimpKey (as genLimpPlanV2.lock_for picks it)", () => {
  test("by role and stack bucket; deep limpers get none", () => {
    expect(poolLimpKey({ limpsBefore: 0, complete: false }, 39)).toBe("limp_first_short_le60");
    expect(poolLimpKey({ limpsBefore: 0, complete: false }, 60)).toBe("limp_first_short_le60");
    expect(poolLimpKey({ limpsBefore: 0, complete: false }, 70)).toBe("limp_first_short_60_85");
    expect(poolLimpKey({ limpsBefore: 2, complete: false }, 30)).toBe("overlimp_short_le60");
    expect(poolLimpKey({ limpsBefore: 0, complete: true }, 40)).toBe("sbcomplete_fold_short_le60");
    expect(poolLimpKey({ limpsBefore: 1, complete: true }, 80)).toBe("sbcomplete_b1_short_60_85");
    expect(poolLimpKey({ limpsBefore: 3, complete: true }, 30)).toBe("sbcomplete_b3");
    expect(poolLimpKey({ limpsBefore: 0, complete: false }, 86)).toBeNull();
  });
});

describe("poolChartCovers", () => {
  const hj = { pos: "HJ" as const, complete: false };
  test("an uneven pool3 tree inside the bound covers; the even 100bb pool3 does not cover a 39bb limper", () => {
    expect(poolChartCovers("ign200_6max_D100_s30_HJ_olimp_pool3", hj, "BB", { hero: 135, limper: 39 }, V2)).toBe(true);
    expect(poolChartCovers("ign200_6max_D100_s50_HJ_olimp_pool3", hj, "BB", { hero: 135, limper: 39 }, V2)).toBe(true);
    expect(poolChartCovers("ign200_6max_D100_olimp_pool3", hj, "BB", { hero: 135, limper: 39 }, V2)).toBe(false);
    expect(poolChartCovers("ign200_6max_D100_s30_HJ_olimp_pool3", hj, "BB", { hero: 135, limper: 18 }, V2)).toBe(false);
  });
  test("from 50bb the even pool3 tree is inside the bound; equilibrium trees and the AI tree never cover", () => {
    expect(poolChartCovers("ign200_6max_D100_olimp_pool3", hj, "BB", { hero: 135, limper: 55 }, V2)).toBe(true);
    expect(poolChartCovers("ign200_6max_D30_olimp", hj, "BB", { hero: 135, limper: 30 }, V2)).toBe(false);
    expect(poolChartCovers("ign200_6max_D100_s30_HJ_olimp", hj, "BB", { hero: 135, limper: 30 }, V2)).toBe(false);
    expect(poolChartCovers("gtow-ai · 6-handed · UTG:11.5/HJ:38/CO:26/BTN:96/SB:151/BB:135", hj, "BB", { hero: 135, limper: 38 }, V2)).toBe(false);
    expect(poolChartCovers(null, hj, "BB", { hero: 135, limper: 38 }, V2)).toBe(false);
  });
  test("a v1 pool3 tree (deep locks for every limper) does not cover; nor does a bake without provenance", () => {
    const v1 = () => "limp-uneven-pool3.bak-20261002-fixed-iso";
    expect(poolChartCovers("ign200_6max_D100_s30_HJ_olimp_pool3", hj, "BB", { hero: 135, limper: 39 }, v1)).toBe(false);
    expect(poolChartCovers("ign200_6max_D100_s30_HJ_olimp_pool3", hj, "BB", { hero: 135, limper: 39 }, () => null)).toBe(false);
  });
  test("the SB pilot locks the limps, not the SB's complete", () => {
    expect(poolChartCovers("ign200_6max_D100_olimp_pool", hj, "BB", { hero: 100, limper: 70 }, V2)).toBe(true);
    expect(poolChartCovers("ign200_6max_D100_olimp_pool", { pos: "SB", complete: true }, "BB", { hero: 100, limper: 70 }, V2)).toBe(false);
  });
});

describe("applyPoolLimpFloor", () => {
  test("hand 4922555015: the 39bb HJ on the even 30bb limp chart gets the pool's ≤60bb first-in limp range", () => {
    const r = applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: ranges(), chartId: "ign200_6max_D30_olimp", dealt: dealt(), planOf: V2 });
    expect(r.applied).toHaveLength(1);
    const a = r.applied[0]!;
    expect([a.pos, a.key, a.stack, a.n]).toEqual(["HJ", "limp_first_short_le60", 39, 278]);
    expect(a.was).toBeCloseTo(0.14, 2);                                  // QJs 4 + 77 6 + KTs 4 combos at 0.01
    expect(a.now).toBeGreaterThan(300);                                  // 26.3% of 1,326 ≈ 349
    expect(r.ranges.HJ!.KTs).toBeGreaterThan(0.05);                      // the KcTc that limped is in it (short pool players mostly raise it)
    expect(r.ranges.BB).toEqual({ "72o": 1, AKs: 1 });                   // hero untouched
  });

  test("the same on a GTO Wizard AI tree, and the input is not mutated", () => {
    const input = ranges();
    const r = applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: input, chartId: "gtow-ai · 6-handed · …", dealt: dealt(), planOf: V2 });
    expect(r.applied.map((x) => x.key)).toEqual(["limp_first_short_le60"]);
    expect(input.HJ).toEqual(TINY);
  });

  test("a v1 uneven pool3 tree answered (deep locks): the floor still gives the short limper his own range", () => {
    const r = applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: ranges(), chartId: "ign200_6max_D100_s30_HJ_olimp_pool3", dealt: dealt(),
      planOf: () => "limp-uneven-pool3" });
    expect(r.applied.map((x) => x.key)).toEqual(["limp_first_short_le60"]);
  });

  test("covered: the uneven 30bb pool3 tree of the HJ answered — the floor stands down", () => {
    const r = applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: ranges(), chartId: "ign200_6max_D100_s30_HJ_olimp_pool3", dealt: dealt(), planOf: V2 });
    expect(r.applied).toEqual([]);
    expect(r.ranges.HJ).toEqual(TINY);
  });

  test("a 70bb limper on the 100bb pool3 tree is inside the bound (no bound from 50bb); on the even 50bb chart he gets the 60-85bb range", () => {
    const d = dealt({ 3: 70 });
    expect(applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: ranges(), chartId: "ign200_6max_D100_olimp_pool3", dealt: d, planOf: V2 }).applied).toEqual([]);
    expect(applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: ranges(), chartId: "ign200_6max_D50_olimp", dealt: d, planOf: V2 }).applied.map((x) => x.key))
      .toEqual(["limp_first_short_60_85"]);
  });

  test("a deep limper keeps the tree's range; a limp-raiser keeps his; a limper not at the flop is skipped", () => {
    expect(applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: ranges(), chartId: "ign200_6max_D100_olimp", dealt: dealt({ 3: 100 }), planOf: V2 }).applied).toEqual([]);
    const limpRaise = [...HAND_4922555015.slice(0, 7), pre(1, "raise", 4), pre(3, "raise", 12), pre(1, "call", 12)];
    expect(applyPoolLimpFloor({ hand: hand(limpRaise), heroPos: "BB", ranges: ranges(), chartId: "ign200_6max_D30_olimp", dealt: dealt(), planOf: V2 }).applied).toEqual([]);
    expect(applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: { BB: { AKs: 1 } }, chartId: "ign200_6max_D30_olimp", dealt: dealt(), planOf: V2 }).applied).toEqual([]);
  });

  test("a limp-call of hero's iso keeps the pool limp range whole", () => {
    const iso = [...HAND_4922555015.slice(0, 7), pre(1, "raise", 4), pre(3, "call", 4)];
    const r = applyPoolLimpFloor({ hand: hand(iso), heroPos: "BB", ranges: ranges(), chartId: "ign200_6max_D30_olimp", dealt: dealt(), planOf: V2 });
    expect(r.applied.map((x) => x.key)).toEqual(["limp_first_short_le60"]);
  });

  test("heads-up keeps its tree (the SB's complete is the button's open there)", () => {
    const hu = { heroSeatId: 1, positions: { 1: "BB", 6: "SB" }, actions: [pre(6, "post-sb", 0.5), pre(1, "post-bb", 1), pre(6, "call", 0.5), pre(1, "check")], stacks: {}, committed: {} } as unknown as ParsedHand;
    expect(applyPoolLimpFloor({ hand: hu, heroPos: "BB", ranges: { SB: { ...TINY }, BB: { AKs: 1 } }, chartId: "gtow-ai · 2-handed", dealt: { 1: 100, 6: 30 } }).applied).toEqual([]);
  });
});
