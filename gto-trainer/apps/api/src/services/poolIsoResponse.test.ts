import { afterEach, describe, expect, test } from "bun:test";
import { heroIsoResponseLockOn, isoResponseRates } from "./poolIsoResponse";
import { limpCallGroupRates, setPoolCallTable, type PoolCallTable } from "./poolCalls";

/** THE LIMPER'S REPLY TO HERO'S ISO (services/poolIsoResponse): which rates, and the switch (off by default). */
afterEach(() => { delete process.env.LIMP_LOCKS; delete process.env.HERO_ISO_RESPONSE_LOCK; delete process.env.LIMPCALL_PRODUCT; setPoolCallTable(null); });

describe("isoResponseRates", () => {
  test("LIMP_LOCKS=v4 (the default): the Ignition limp-call group rates of his band and limpers", () => {
    const r = isoResponseRates({ pos: "HJ", stack: 39, limpersInPot: 1 })!;
    expect(r.source).toBe("Ignition limp-call group rates limpcall_le60_l1");
    expect(r.groups).toEqual(limpCallGroupRates("limpcall_le60_l1")!);
    expect(isoResponseRates({ pos: "UTG", stack: 100, limpersInPot: 2 })!.source).toBe("Ignition limp-call group rates limpcall_deep_l2p");
  });
  test("v3 (or LIMPCALL_PRODUCT=class): the call table's limpcall cell averaged over each group's combos, capped at 1", () => {
    process.env.LIMP_LOCKS = "v3";
    const T: PoolCallTable = { ranges: { poolcall_limpcall_ALL_l1: { line: "limpcall", seat: "ALL", qual: "l1", stack: "all", freq: 0.7, chances: 100, calls: 70, shown: 10, shape_from: "own",
      weights: { AA: 1, KK: 0.5, "22": 0.8, "72o": 0.4 } } } };
    setPoolCallTable(T);
    const r = isoResponseRates({ pos: "HJ", stack: 39, limpersInPot: 1 })!;
    expect(r.source).toBe("poolcall_limpcall_ALL_l1 by hand group");
    // prem = AA, KK, QQ, JJ (6 combos each), AKs (4), AKo (12): (6·1 + 6·0.5) / 40
    expect(r.groups.prem).toBeCloseTo(9 / 40, 9);
    expect(r.groups.pairs).toBeCloseTo((6 * 0.8) / (9 * 6), 9);
    expect(isoResponseRates({ pos: "HJ", stack: 39, limpersInPot: 2 })).toBeNull();   // no l2p cell in this table
  });
  test("the switch: off unless HERO_ISO_RESPONSE_LOCK=on", () => {
    expect(heroIsoResponseLockOn()).toBe(false);
    process.env.HERO_ISO_RESPONSE_LOCK = "on";
    expect(heroIsoResponseLockOn()).toBe(true);
  });
});
