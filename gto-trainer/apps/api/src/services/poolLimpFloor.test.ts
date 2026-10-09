import { afterEach, describe, expect, test } from "bun:test";
import {
  applyPoolLimpFloor, limpCoarseBand, limpFineBand, limpLockKeys, limpLockRange, limpLocksVersion, poolChartCovers, poolLimpersOf,
  poolLimpFloorNote, poolLimpKey, poolLimpRange, poolLimpWeights, type LimpLocksVersion,
} from "./poolLimpFloor";
import V2_TABLE from "./poolLimpLocks.v2.json";
import V3_TABLE from "./poolLimpLocks.v3.json";
import { poolFloorsOf, poolRangeOf } from "../scripts/mutation/rangeOracle";
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
    expect(poolLimpersOf(hand(HAND_4922555015), "BB")).toEqual([{ pos: "HJ", limpsBefore: 0, complete: false, raisedLater: false, calledLater: false }]);
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
  test("LIMP_LOCKS=v2: by role and stack bucket; deep limpers get none", () => {
    expect(poolLimpKey({ limpsBefore: 0, complete: false }, 39, "v2")).toBe("limp_first_short_le60");
    expect(poolLimpKey({ limpsBefore: 0, complete: false }, 60, "v2")).toBe("limp_first_short_le60");
    expect(poolLimpKey({ limpsBefore: 0, complete: false }, 70, "v2")).toBe("limp_first_short_60_85");
    expect(poolLimpKey({ limpsBefore: 2, complete: false }, 30, "v2")).toBe("overlimp_short_le60");
    expect(poolLimpKey({ limpsBefore: 0, complete: true }, 40, "v2")).toBe("sbcomplete_fold_short_le60");
    expect(poolLimpKey({ limpsBefore: 1, complete: true }, 80, "v2")).toBe("sbcomplete_b1_short_60_85");
    expect(poolLimpKey({ limpsBefore: 3, complete: true }, 30, "v2")).toBe("sbcomplete_b3");
    expect(poolLimpKey({ limpsBefore: 0, complete: false }, 86, "v2")).toBeNull();
  });
});

/** THE LIMP TABLE SWITCH + THE FINER BANDS (LIMP_LOCKS=v3|v2, 2026-10-09). */
describe("limp lock tables v3 / v2 (LIMP_LOCKS)", () => {
  const ROLES: [string, { limpsBefore: number; complete: boolean }][] = [
    ["first-in", { limpsBefore: 0, complete: false }], ["over-limp b1", { limpsBefore: 1, complete: false }],
    ["over-limp b2", { limpsBefore: 2, complete: false }], ["over-limp b4", { limpsBefore: 4, complete: false }],
    ["SB folded to", { limpsBefore: 0, complete: true }], ["SB behind 1", { limpsBefore: 1, complete: true }],
    ["SB behind 2", { limpsBefore: 2, complete: true }], ["SB behind 3", { limpsBefore: 3, complete: true }],
    ["SB behind 5", { limpsBefore: 5, complete: true }],
  ];
  /** poolLimpKey as it was before 2026-10-09 (the v2 lookup, verbatim) */
  const legacyKey = (l: { limpsBefore: number; complete: boolean }, stack: number): string | null => {
    if (!(stack > 0) || stack > 85) return null;
    const b = stack <= 60 ? "le60" : "60_85";
    if (l.complete) {
      if (l.limpsBefore >= 3) return "sbcomplete_b3";
      return l.limpsBefore === 0 ? `sbcomplete_fold_short_${b}` : `sbcomplete_b${l.limpsBefore}_short_${b}`;
    }
    return l.limpsBefore === 0 ? `limp_first_short_${b}` : `overlimp_short_${b}`;
  };
  const STACKS = [-1, 0, 0.4, 1, 5, 10, 19.9, 20, 24.9, 25, 25.01, 25.1, 30, 39.9, 40, 40.01, 45, 59.9, 60, 60.01, 60.5, 70, 84.9, 85,
    85.01, 85.5, 86, 100, 150, 300, Number.NaN, Number.POSITIVE_INFINITY];
  const saved = process.env.LIMP_LOCKS;
  afterEach(() => { if (saved === undefined) delete process.env.LIMP_LOCKS; else process.env.LIMP_LOCKS = saved; });

  test("the switch: unset / v3 / garbage = v3, v2 (any case, padded) = v2 — read at every call", () => {
    delete process.env.LIMP_LOCKS; expect(limpLocksVersion()).toBe("v3");
    process.env.LIMP_LOCKS = "v3"; expect(limpLocksVersion()).toBe("v3");
    process.env.LIMP_LOCKS = " V2 "; expect(limpLocksVersion()).toBe("v2");
    process.env.LIMP_LOCKS = "v1"; expect(limpLocksVersion()).toBe("v3");
    process.env.LIMP_LOCKS = "v2";
    expect(poolLimpKey({ limpsBefore: 1, complete: false }, 30)).toBe("overlimp_short_le60");
    delete process.env.LIMP_LOCKS;
    expect(poolLimpKey({ limpsBefore: 1, complete: false }, 30)).toBe("overlimp_short_25_40");
  });

  test("the band edges: upper edge inclusive (25 / 40 / 60 / 85), nothing over 85bb or for a missing stack", () => {
    const cases: [number, string | null, string | null][] = [
      [0, null, null], [-3, null, null], [Number.NaN, null, null], [0.4, "le25", "le60"], [25, "le25", "le60"], [25.01, "25_40", "le60"],
      [40, "25_40", "le60"], [40.01, "40_60", "le60"], [60, "40_60", "le60"], [60.01, "60_85", "60_85"], [85, "60_85", "60_85"],
      [85.5, null, null], [300, null, null], [Number.POSITIVE_INFINITY, null, null],
    ];
    for (const [s, fine, coarse] of cases) {
      expect([s, limpFineBand(s)]).toEqual([s, fine as any]);
      expect([s, limpCoarseBand(s)]).toEqual([s, coarse as any]);
    }
  });

  test("v3 picks the finest band the table has: over-limps and SB completes behind 1 / 2 limps by <=25 / 25-40 / 40-60 / 60-85bb", () => {
    const k = (l: { limpsBefore: number; complete: boolean }, s: number) => poolLimpKey(l, s, "v3");
    const ol = { limpsBefore: 1, complete: false }, b1 = { limpsBefore: 1, complete: true }, b2 = { limpsBefore: 2, complete: true };
    expect([25, 25.1, 40, 40.1, 60, 60.1, 85].map((s) => k(ol, s))).toEqual(["overlimp_short_le25", "overlimp_short_25_40", "overlimp_short_25_40",
      "overlimp_short_40_60", "overlimp_short_40_60", "overlimp_short_60_85", "overlimp_short_60_85"]);
    expect([10, 30, 50, 70].map((s) => k(b1, s))).toEqual(["sbcomplete_b1_short_le25", "sbcomplete_b1_short_25_40", "sbcomplete_b1_short_40_60", "sbcomplete_b1_short_60_85"]);
    // a missing fine band falls to the coarse one: the SB behind 2 limps at <=25bb (8 CoinPoker completes — no key)
    expect(V3_TABLE.ranges).not.toHaveProperty("sbcomplete_b2_short_le25");
    expect([20, 25, 30, 50, 70].map((s) => k(b2, s))).toEqual(["sbcomplete_b2_short_le60", "sbcomplete_b2_short_le60", "sbcomplete_b2_short_25_40",
      "sbcomplete_b2_short_40_60", "sbcomplete_b2_short_60_85"]);
    // first-in and the SB folded to have no finer keys (the Ignition cells, n=278 / 166 / 50 / 33): the coarse ones
    expect([20, 39, 59, 61].map((s) => k({ limpsBefore: 0, complete: false }, s))).toEqual(["limp_first_short_le60", "limp_first_short_le60", "limp_first_short_le60", "limp_first_short_60_85"]);
    expect([20, 39, 59, 61].map((s) => k({ limpsBefore: 0, complete: true }, s))).toEqual(["sbcomplete_fold_short_le60", "sbcomplete_fold_short_le60", "sbcomplete_fold_short_le60", "sbcomplete_fold_short_60_85"]);
    // 3+ limps before the SB: one key at any short stack; over 85bb nothing (the charts' own range)
    expect([5, 30, 85].map((s) => k({ limpsBefore: 3, complete: true }, s))).toEqual(["sbcomplete_b3", "sbcomplete_b3", "sbcomplete_b3"]);
    expect([85.5, 300].map((s) => k(ol, s))).toEqual([null, null]);
    expect([85.5, 300].map((s) => k(b1, s))).toEqual([null, null]);
  });

  test("v2 = the picks before 2026-10-09, byte for byte, on every role x stack (edges, 85.5, 300, NaN)", () => {
    for (const [, l] of ROLES) for (const s of STACKS) expect([l, s, poolLimpKey(l, s, "v2")]).toEqual([l, s, legacyKey(l, s) as any]);
  });

  test("every key either switch can pick exists in that table, and v3 only ever refines v2's coarse band", () => {
    const v2Keys = new Set(limpLockKeys("v2")), v3Keys = new Set(limpLockKeys("v3"));
    for (const [, l] of ROLES) {
      for (let s = 0.5; s <= 85; s += 0.5) {
        const k2 = poolLimpKey(l, s, "v2")!, k3 = poolLimpKey(l, s, "v3")!;
        expect(v2Keys.has(k2)).toBe(true);
        expect(v3Keys.has(k3)).toBe(true);
        // the same role and the same coarse band, or a finer band inside it
        if (k3 !== k2) {
          expect(k2.endsWith("_le60")).toBe(true);
          expect(k3.replace(/_(le25|25_40|40_60)$/, "_le60")).toBe(k2);
        }
      }
    }
  });

  test("the tables: 169 classes each, weights in [0,1], frequency = the water-filled weights (1e-4); v3 keeps v2's 8 thick cells exactly", () => {
    const RANKS = "23456789TJQKA";
    const classes: string[] = [];
    for (let i = 12; i >= 0; i--) for (let j = 12; j >= 0; j--) {
      if (i === j) classes.push(RANKS[i]! + RANKS[j]!); else if (i > j) classes.push(RANKS[i]! + RANKS[j]! + "s", RANKS[i]! + RANKS[j]! + "o");
    }
    const pc = (c: string) => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12) / 1326;
    for (const [name, t] of [["v2", V2_TABLE], ["v3", V3_TABLE]] as const) {
      for (const [k, r] of Object.entries(t.ranges as Record<string, { freq: number; n: number; weights: Record<string, number> }>)) {
        expect([name, k, Object.keys(r.weights).sort()]).toEqual([name, k, [...classes].sort()]);
        for (const w of Object.values(r.weights)) { expect(w).toBeGreaterThanOrEqual(0); expect(w).toBeLessThanOrEqual(1); }
        const f = classes.reduce((s, c) => s + pc(c) * r.weights[c]!, 0);
        expect(Math.abs(f - r.freq)).toBeLessThan(1e-4);
        expect(r.n).toBeGreaterThanOrEqual(name === "v3" ? 1 : 0);      // v2's sbcomplete_b2_short_60_85 was n=0
      }
    }
    expect(Object.keys(V3_TABLE.ranges)).toHaveLength(24);
    const v2 = V2_TABLE.ranges as Record<string, any>, v3 = V3_TABLE.ranges as Record<string, any>;
    const kept = ["limp_first_deep", "overlimp_deep", "limp_first_short_le60", "limp_first_short_60_85", "sbcomplete_b1_deep",
      "sbcomplete_fold_deep", "sbcomplete_fold_short_le60", "sbcomplete_fold_short_60_85"];
    for (const k of kept) expect([k, v3[k].freq, v3[k].n, v3[k].weights]).toEqual([k, v2[k].freq, v2[k].n, v2[k].weights]);
    for (const k of Object.keys(v2)) {
      expect(v3).toHaveProperty(k);
      if (!kept.includes(k)) { expect(v2[k].n).toBeLessThan(30); expect(v3[k].weights).not.toEqual(v2[k].weights); }
    }
  });

  test("limpLockRange: the switch's table, else the other one; poolLimpWeights / poolLimpRange read it", () => {
    expect(limpLockRange("overlimp_short_le60", "v2")!.freq).toBe((V2_TABLE.ranges as any).overlimp_short_le60.freq);
    expect(limpLockRange("overlimp_short_le60", "v3")!.freq).toBe((V3_TABLE.ranges as any).overlimp_short_le60.freq);
    // a fine v3 key named by a v3 answer, read back under v2
    expect(limpLockRange("overlimp_short_25_40", "v2")).toMatchObject({ table: "v3", freq: (V3_TABLE.ranges as any).overlimp_short_25_40.freq });
    expect(limpLockRange("nope", "v3")).toBeNull();
    process.env.LIMP_LOCKS = "v2";
    expect(poolLimpRange("sbcomplete_b3").freq).toBe((V2_TABLE.ranges as any).sbcomplete_b3.freq);
    delete process.env.LIMP_LOCKS;
    expect(poolLimpRange("sbcomplete_b3").freq).toBe((V3_TABLE.ranges as any).sbcomplete_b3.freq);
    const w = poolLimpWeights("overlimp_short_le25");
    expect(w).toHaveLength(1326);
    expect(w.every((x) => x >= 0 && x <= 1)).toBe(true);
  });

  test("the floor under each switch: a 30bb over-limper gets v3's 25-40bb range, tagged 'v3:' in the note, or v2's <=60bb, untagged", () => {
    // UTG limps (150bb), the 30bb HJ over-limps, CO / BTN / SB fold, hero checks his BB
    const acts = [pre(6, "post-sb", 0.4), pre(1, "post-bb", 1), pre(2, "call", 1), pre(3, "call", 1), pre(4, "fold"), pre(5, "fold"), pre(6, "fold"), pre(1, "check")];
    const run = (v: LimpLocksVersion | undefined) => {
      if (v) process.env.LIMP_LOCKS = v; else delete process.env.LIMP_LOCKS;
      return applyPoolLimpFloor({ hand: hand(acts), heroPos: "BB", ranges: { UTG: { ...TINY }, HJ: { ...TINY }, BB: { AKs: 1 } }, chartId: "gtow-ai · 6-handed", dealt: dealt({ 2: 150, 3: 30 }), planOf: V2 });
    };
    const a3 = run(undefined), a2 = run("v2");
    expect(a3.applied.map((x) => [x.pos, x.key, x.table])).toEqual([["HJ", "overlimp_short_25_40", "v3"]]);
    expect(a2.applied.map((x) => [x.pos, x.key, x.table])).toEqual([["HJ", "overlimp_short_le60", "v2"]]);
    expect(a3.ranges.HJ).toEqual((V3_TABLE.ranges as any).overlimp_short_25_40.weights);
    expect(a2.ranges.HJ).toEqual((V2_TABLE.ranges as any).overlimp_short_le60.weights);
    expect(a3.ranges.UTG).toEqual(TINY);                                  // a deep limper keeps the tree's range
    const n3 = poolLimpFloorNote(a3.applied, "gtow-ai"), n2 = poolLimpFloorNote(a2.applied, "gtow-ai");
    expect(n3).toContain("now the pool's overlimp_short_25_40 (v3: ");
    expect(n2).toContain("now the pool's overlimp_short_le60 (25.0% of hands, n=9, ");
    // the mutation oracle reads the table back from the note: v3 -> the v3 range, untagged (every note before) -> v2
    const f3 = poolFloorsOf(`x · ${n3}`).get("HJ")!, f2 = poolFloorsOf(`x · ${n2}`).get("HJ")!;
    expect([f3.key, f3.limpTable, f2.key, f2.limpTable]).toEqual(["overlimp_short_25_40", "v3", "overlimp_short_le60", "v2"]);
    expect(poolRangeOf(f3)).toEqual(a3.ranges.HJ!);
    expect(poolRangeOf(f2)).toEqual(a2.ranges.HJ!);
    // a replaced key under its old name: the untagged (v2) note still reconstructs v2's range, not v3's
    expect(poolRangeOf({ kind: "limp", key: "overlimp_short_le60", was: 0 })).toEqual((V2_TABLE.ranges as any).overlimp_short_le60.weights);
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
  test("THE SAME BUCKET: a tree covers only a limper it locked at his own stack's range", () => {
    // the 100bb pool tree locks every limper at the deep 3.1% — inside the stack bound from 50bb, and still not his range
    expect(poolChartCovers("ign200_6max_D100_olimp_pool3", hj, "BB", { hero: 135, limper: 55 }, V2)).toBe(false);
    expect(poolChartCovers("ign200_6max_D100_olimp_pool3", hj, "BB", { hero: 135, limper: 84 }, V2)).toBe(false);
    // 59bb is a 26% limper: the 50bb tree locked him so, the (nearer) 70bb tree at 15%
    expect(poolChartCovers("ign200_6max_D100_s50_HJ_olimp_pool3", hj, "BB", { hero: 135, limper: 59 }, V2)).toBe(true);
    expect(poolChartCovers("ign200_6max_D100_s70_HJ_olimp_pool3", hj, "BB", { hero: 135, limper: 59 }, V2)).toBe(false);
    expect(poolChartCovers("ign200_6max_D100_s70_HJ_olimp_pool3", hj, "BB", { hero: 135, limper: 62 }, V2)).toBe(true);
    // another seat's uneven tree holds the HJ at 100bb: the deep range
    expect(poolChartCovers("ign200_6max_D100_s30_UTG_olimp_pool3", hj, "BB", { hero: 135, limper: 30 }, V2)).toBe(false);
  });
  test("the hero-free trees cover the short limper they lock, not an SB complete (solved there)", () => {
    expect(poolChartCovers("ign200_6max_D100_s30_HJ_olimp_poolh", hj, "BTN", { hero: 100, limper: 39 }, V2)).toBe(true);
    expect(poolChartCovers("ign200_6max_D100_s30_HJ_olimp_poolh", hj, "BTN", { hero: 100, limper: 70 }, V2)).toBe(false);
    expect(poolChartCovers("ign200_6max_D100_s30_HJ_olimp_poolh", { pos: "SB", complete: true }, "BB", { hero: 100, limper: 30 }, V2)).toBe(false);
    expect(poolChartCovers("ign200_6max_D100_s30_HJ_olimp_poolh", hj, "BTN", { hero: 100, limper: 39 }, () => null)).toBe(false);
  });
  test("equilibrium trees and the AI tree never cover", () => {
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
    // (a 100bb tree: its limpers hold the deep range, so the only limper it can cover is a deep one — never floored)
    expect(poolChartCovers("ign200_6max_D100_olimp_pool", hj, "BB", { hero: 100, limper: 100 }, V2)).toBe(true);
    expect(poolChartCovers("ign200_6max_D100_olimp_pool", hj, "BB", { hero: 100, limper: 70 }, V2)).toBe(false);
    expect(poolChartCovers("ign200_6max_D100_olimp_pool", { pos: "SB", complete: true }, "BB", { hero: 100, limper: 100 }, V2)).toBe(false);
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

  test("a 70bb limper: the 60-85bb range on the 100bb pool3 tree (deep lock) and on an equilibrium chart; his own 70bb tree covers", () => {
    const d = dealt({ 3: 70 });
    const on = (chartId: string) => applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: ranges(), chartId, dealt: d, planOf: V2 }).applied.map((x) => x.key);
    expect(on("ign200_6max_D100_olimp_pool3")).toEqual(["limp_first_short_60_85"]);
    expect(on("ign200_6max_D50_olimp")).toEqual(["limp_first_short_60_85"]);
    expect(on("ign200_6max_D100_s70_HJ_olimp_pool3")).toEqual([]);
    expect(on("ign200_6max_D100_s70_HJ_olimp_poolh")).toEqual([]);
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

  test("a lone SB complete (folded to) is NOT floored — GTO Wizard completes the SB itself (2026-10-09); behind a limper it still is", () => {
    // folded to the 40bb SB, who completes; hero checks his BB — the SB's flop range stays the tree's
    const lone = [pre(6, "post-sb", 0.5), pre(1, "post-bb", 1), pre(2, "fold"), pre(3, "fold"), pre(4, "fold"), pre(5, "fold"), pre(6, "call", 0.5), pre(1, "check")];
    expect(applyPoolLimpFloor({ hand: hand(lone), heroPos: "BB", ranges: { SB: { ...TINY }, BB: { AKs: 1 } }, chartId: "gtow-ai · 3-handed", dealt: dealt({ 6: 40 }), planOf: V2 }).applied).toEqual([]);
    // the 45bb HJ limps, the 50bb SB completes behind him: both floored, as before
    const behind = [pre(6, "post-sb", 0.5), pre(1, "post-bb", 1), pre(2, "fold"), pre(3, "call", 1), pre(4, "fold"), pre(5, "fold"), pre(6, "call", 0.5), pre(1, "check")];
    const r = applyPoolLimpFloor({ hand: hand(behind), heroPos: "BB", ranges: { HJ: { ...TINY }, SB: { ...TINY }, BB: { AKs: 1 } }, chartId: "gtow-ai · 6-handed", dealt: dealt({ 3: 45, 6: 50 }), planOf: V2 });
    expect(r.applied.map((x) => [x.pos, x.key])).toEqual([["HJ", "limp_first_short_le60"], ["SB", "sbcomplete_b1_short_40_60"]]);
  });

  test("heads-up keeps its tree (the SB's complete is the button's open there)", () => {
    const hu = { heroSeatId: 1, positions: { 1: "BB", 6: "SB" }, actions: [pre(6, "post-sb", 0.5), pre(1, "post-bb", 1), pre(6, "call", 0.5), pre(1, "check")], stacks: {}, committed: {} } as unknown as ParsedHand;
    expect(applyPoolLimpFloor({ hand: hu, heroPos: "BB", ranges: { SB: { ...TINY }, BB: { AKs: 1 } }, chartId: "gtow-ai · 2-handed", dealt: { 1: 100, 6: 30 } }).applied).toEqual([]);
  });
});

describe("the trigger rule on the floor (2026-10-09, services/poolTrigger — POOL_LIMP_TRIGGER)", () => {
  afterEach(() => { delete process.env.POOL_LIMP_TRIGGER; });
  const CLASSES = Object.keys(limpLockRange("limp_first_deep")!.weights);
  const flat = (w: number) => Object.fromEntries(CLASSES.map((c) => [c, w]));
  const at76 = dealt({ 3: 76 });
  test("a 76bb HJ the solver limps 31.6% of the time (the pool 15.1%): his own range is kept, the reason recorded", () => {
    const r = applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: { HJ: flat(0.316), BB: { AKs: 1 } }, chartId: "gtow-ai · 6-handed", dealt: at76, planOf: V2 });
    expect(r.applied).toEqual([]);
    expect(r.kept.map((k) => [k.pos, k.key])).toEqual([["HJ", "limp_first_short_60_85"]]);
    expect(r.kept[0]!.text).toContain("not under the pool's rate / 2");
    expect(r.ranges.HJ).toEqual(flat(0.316));
  });
  test("residue (2.98 combos on the 30bb limp chart) is still floored", () => {
    const r = applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: ranges(), chartId: "ign200_6max_D30_olimp", dealt: dealt(), planOf: V2 });
    expect(r.applied.map((x) => x.key)).toEqual(["limp_first_short_le60"]);
    expect(r.kept).toEqual([]);
  });
  test("POOL_LIMP_TRIGGER=off: structural, as before — the real range is floored too", () => {
    process.env.POOL_LIMP_TRIGGER = "off";
    const r = applyPoolLimpFloor({ hand: hand(HAND_4922555015), heroPos: "BB", ranges: { HJ: flat(0.316), BB: { AKs: 1 } }, chartId: "gtow-ai · 6-handed", dealt: at76, planOf: V2 });
    expect(r.applied.map((x) => x.key)).toEqual(["limp_first_short_60_85"]);
  });
  test("a limp-caller stays structural (the limp × call product's floor): floored whatever his walked range", () => {
    const iso = [...HAND_4922555015.slice(0, 7), pre(1, "raise", 4), pre(3, "call", 4)];
    expect(poolLimpersOf(hand(iso), "BB")[0]!.calledLater).toBe(true);
    const r = applyPoolLimpFloor({ hand: hand(iso), heroPos: "BB", ranges: { HJ: flat(0.316), BB: { AKs: 1 } }, chartId: "gtow-ai · 6-handed", dealt: at76, planOf: V2 });
    expect(r.applied.map((x) => x.key)).toEqual(["limp_first_short_60_85"]);
  });
});
