import { afterEach, describe, expect, test } from "bun:test";
import { applyLimpCallProduct, applyPoolCallRanges, handGroup, limpCallCalibration, limpCallCalibrationKey, limpCallProduct, limpKeyOf, poolCallKey, poolCallNote, poolCallRange, poolCallersOf, setPoolCallTable, type PoolCallTable } from "./poolCalls";
import CALIBRATION from "./poolLimpCallCalibration.json";
import { applyPoolLimpFloor, limpLockRange, poolLimpFloorNote } from "./poolLimpFloor";
import { poolFloorsOf, poolRangeOf } from "../scripts/mutation/rangeOracle";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * The pool-call overlay (Brady 2026-10-07): where the exact AI tree cannot hold the line, the villain callers hold the
 * pool's measured calling ranges. Hermetic: the table is injected (the shipped one is never read here).
 */
const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as Record<number, string>;
const pre = (seatId: number, type: string, amount?: number, hero = false) => ({ seatId, hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const hand = (actions: any[], heroSeatId: number): ParsedHand => ({ heroSeatId, positions: POS, actions, stacks: {}, committed: {}, heroCards: [] } as unknown as ParsedHand);
const BLINDS = [pre(5, "post-sb", 0.5), pre(6, "post-bb", 1)];
const dealt = (over: Record<number, number> = {}) => ({ 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, ...over });

/** stress brief_I-002: UTG opens 2.5, HJ/CO fold, BTN calls, SB over-calls, hero BB calls */
const BRIEF_I_002 = [...BLINDS, pre(1, "raise", 2.5), pre(2, "fold"), pre(3, "fold"), pre(4, "call", 2.5), pre(5, "call", 2.5), pre(6, "call", 2.5, true)];
/** stress brief_I-011: UTG opens, HJ, CO, BTN call, SB folds, hero BB calls */
const BRIEF_I_011 = [...BLINDS, pre(1, "raise", 2.5), pre(2, "call", 2.5), pre(3, "call", 2.5), pre(4, "call", 2.5), pre(5, "fold"), pre(6, "call", 2.5, true)];
/** a limped 6-way pot (po_56way-006), hero CO: UTG, HJ, hero, BTN limp, SB completes, BB checks */
const LIMPED_6 = [...BLINDS, pre(1, "call", 1), pre(2, "call", 1), pre(3, "call", 1, true), pre(4, "call", 1), pre(5, "call", 1), pre(6, "check")];
/** an iso: UTG limps, HJ limps, CO raises 5, BTN cold-calls, SB folds, BB calls, UTG calls, HJ folds — hero CO */
const ISO = [...BLINDS, pre(1, "call", 1), pre(2, "call", 1), pre(3, "raise", 5, true), pre(4, "call", 5), pre(5, "fold"), pre(6, "call", 5), pre(1, "call", 5), pre(2, "fold")];

const W = (cls: Record<string, number>) => cls;
const range = (line: string, seat: string, qual: string | null, stack: string, freq: number, weights: Record<string, number>) =>
  ({ line, seat, qual, stack, freq, chances: 10000, calls: Math.round(10000 * freq), shown: 400, shape_from: "own", weights });
const TABLE: PoolCallTable = {
  stack_edges: { le40: [0, 40], "40_80": [40, 80], "80p": [80, null] },
  open_edges: { oS: [0, 2.3], oM: [2.3, 2.8], oL: [2.8, 3.6], oXL: [3.6, null] },
  open_split_adopted: false,
  ranges: {
    poolcall_flat_BTN_vsUTG_80p: range("flat", "BTN", "vsUTG", "80p", 0.07, W({ AA: 0.2, TT: 1, "76s": 0.5 })),
    poolcall_flat_BTN_all: range("flat", "BTN", null, "all", 0.08, W({ TT: 1 })),
    poolcall_flat_HJ_80p: range("flat", "HJ", null, "80p", 0.06, W({ "99": 1 })),
    poolcall_overcall_SB_b1_80p: range("overcall", "SB", "b1", "80p", 0.11, W({ "88": 1, KQs: 0.8, "72o": 0 })),
    poolcall_overcall_CO_b1: range("overcall", "CO", "b1", "all", 0.09, W({ "66": 1 })),
    poolcall_overcall_ALL_b2p_80p: range("overcall", "ALL", "b2p", "80p", 0.12, W({ "55": 1 })),
    poolcall_overcall_ALL_all: range("overcall", "ALL", null, "all", 0.1, W({ "44": 1 })),
    poolcall_bbiso_BB_l2p: range("bbiso", "BB", "l2p", "all", 0.3, W({ "33": 1 })),
    poolcall_limpcall_ALL_l2p: range("limpcall", "ALL", "l2p", "all", 0.5, W({ "22": 1 })),
    poolcall_limpcall_ALL_l1: range("limpcall", "ALL", "l1", "all", 0.7, W({ AA: 1, "22": 1, "72o": 1, "76s": 1, KQo: 1 })),
    poolcall_overlimp_ALL_b2p: range("overlimp", "ALL", "b2p", "all", 0.2, W({ J9s: 1 })),
    poolcall_flat_BTN_vsUTG_oS_80p: range("flat", "BTN", "vsUTG", "80p", 0.09, W({ QQ: 1 })),
  },
};
afterEach(() => setPoolCallTable(null));

describe("poolCallersOf (the lines, as the table keys them)", () => {
  test("brief_I-002: the BTN flat-called UTG's open, the SB over-called behind one caller; hero's call is not listed", () => {
    const cs = poolCallersOf(hand(BRIEF_I_002, 6), "BB");
    expect(cs.map((c) => [c.pos, c.line, c.opener, c.before, c.openTo])).toEqual([["BTN", "flat", "UTG", 0, 2.5], ["SB", "overcall", "UTG", 1, 2.5]]);
  });
  test("brief_I-011: HJ flat, CO behind 1, BTN behind 2", () => {
    const cs = poolCallersOf(hand(BRIEF_I_011, 6), "BB");
    expect(cs.map((c) => [c.pos, c.line, c.before])).toEqual([["HJ", "flat", 0], ["CO", "overcall", 1], ["BTN", "overcall", 2]]);
  });
  test("a limped 6-way pot: first-in limp, over-limp behind one, over-limp behind 3 (hero's counted), the SB's complete behind 4", () => {
    const cs = poolCallersOf(hand(LIMPED_6, 3), "CO");
    expect(cs.map((c) => [c.pos, c.line, c.before, c.complete])).toEqual([["UTG", "limp", 0, false], ["HJ", "limp", 1, false], ["BTN", "overlimp", 3, false], ["SB", "limp", 4, true]]);
  });
  test("an iso pot: a cold call of the iso has no line, the BB's call is bbiso over 2 limpers, the limper's call is limpcall, a folding limper stays a limp", () => {
    const cs = poolCallersOf(hand(ISO, 3), "CO");
    expect(cs.map((c) => [c.pos, c.line, c.before, c.openTo])).toEqual([["UTG", "limpcall", 2, 5], ["HJ", "limp", 1, 0], ["BB", "bbiso", 2, 5]]);
  });
  test("a caller who raises later is marked; an all-in for less is marked", () => {
    const acts = [...BLINDS, pre(1, "raise", 2.5), pre(2, "call", 2.5), pre(3, "fold"), pre(4, "all-in", 2), pre(5, "fold"), pre(6, "raise", 10, true), pre(1, "fold"), pre(2, "raise", 30)];
    const cs = poolCallersOf(hand(acts, 6), "BB");
    expect(cs.map((c) => [c.pos, c.line, c.raisedLater, c.allIn])).toEqual([["HJ", "flat", true, false], ["BTN", "overcall", false, true]]);
  });
  test("a call of a 3-bet is not this overlay's (the cold-call table's)", () => {
    const acts = [...BLINDS, pre(1, "raise", 2.5), pre(2, "call", 2.5), pre(3, "raise", 9), pre(4, "call", 9), pre(5, "fold"), pre(6, "fold", undefined, true), pre(1, "call", 9), pre(2, "call", 9)];
    expect(poolCallersOf(hand(acts, 6), "BB").map((c) => [c.pos, c.line])).toEqual([["HJ", "flat"]]);
  });
});

describe("poolCallKey (the most specific key built)", () => {
  test("seat x line x qualifier x stack, then without the stack, then without the qualifier, then all seats", () => {
    setPoolCallTable(TABLE);
    const flat = (opener: any, stack: number) => poolCallKey({ pos: "BTN", line: "flat", opener, before: 0, openTo: 2.5, complete: false }, stack);
    expect(flat("UTG", 100)).toEqual({ table: "call", key: "poolcall_flat_BTN_vsUTG_80p" });
    expect(flat("UTG", 50)).toEqual({ table: "call", key: "poolcall_flat_BTN_all" });     // no 40_80 cell: the seat's all-stack range
    expect(flat("CO", 100)).toEqual({ table: "call", key: "poolcall_flat_BTN_all" });
    expect(poolCallKey({ pos: "HJ", line: "flat", opener: "UTG", before: 0, openTo: 2.5, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_flat_HJ_80p" });
    expect(poolCallKey({ pos: "SB", line: "overcall", opener: "UTG", before: 1, openTo: 2.5, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_overcall_SB_b1_80p" });
    expect(poolCallKey({ pos: "CO", line: "overcall", opener: "UTG", before: 1, openTo: 2.5, complete: false }, 30)).toEqual({ table: "call", key: "poolcall_overcall_CO_b1" });
    expect(poolCallKey({ pos: "BTN", line: "overcall", opener: "UTG", before: 2, openTo: 2.5, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_overcall_ALL_b2p_80p" });
    expect(poolCallKey({ pos: "BTN", line: "overcall", opener: "UTG", before: 2, openTo: 2.5, complete: false }, 30)).toEqual({ table: "call", key: "poolcall_overcall_ALL_all" });
    expect(poolCallKey({ pos: "BB", line: "bbiso", opener: "CO", before: 2, openTo: 5, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_bbiso_BB_l2p" });
    expect(poolCallKey({ pos: "BB", line: "bbiso", opener: "CO", before: 1, openTo: 5, complete: false }, 100)).toBeNull();
    expect(poolCallKey({ pos: "UTG", line: "limpcall", opener: "CO", before: 2, openTo: 5, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_limpcall_ALL_l2p" });
    expect(poolCallKey({ pos: "SB", line: "sbiso", opener: "CO", before: 2, openTo: 5, complete: true }, 100)).toBeNull();
  });
  test("the open-size qualifier is tried first only when the table adopted the split", () => {
    setPoolCallTable(TABLE);
    const c = { pos: "BTN" as const, line: "flat" as const, opener: "UTG" as const, before: 0, openTo: 2.0, complete: false };
    expect(poolCallKey(c, 100)!.key).toBe("poolcall_flat_BTN_vsUTG_80p");
    setPoolCallTable({ ...TABLE, open_split_adopted: true });
    expect(poolCallKey(c, 100)!.key).toBe("poolcall_flat_BTN_vsUTG_oS_80p");
    expect(poolCallKey({ ...c, openTo: 3 }, 100)!.key).toBe("poolcall_flat_BTN_vsUTG_80p");   // no oL cell built
  });
  test("plain limps go to the limp table: short as the floor picks them, deep to the _deep keys; an over-limp behind 2+ to this table when built", () => {
    setPoolCallTable(TABLE);
    expect(poolCallKey({ pos: "UTG", line: "limp", opener: null, before: 0, openTo: 0, complete: false }, 100)).toEqual({ table: "limp", key: "limp_first_deep" });
    expect(poolCallKey({ pos: "UTG", line: "limp", opener: null, before: 0, openTo: 0, complete: false }, 50)).toEqual({ table: "limp", key: "limp_first_short_le60" });
    expect(poolCallKey({ pos: "HJ", line: "limp", opener: null, before: 1, openTo: 0, complete: false }, 100)).toEqual({ table: "limp", key: "overlimp_deep" });
    expect(poolCallKey({ pos: "SB", line: "limp", opener: null, before: 2, openTo: 0, complete: true }, 100)).toEqual({ table: "limp", key: "sbcomplete_b2_deep" });
    expect(poolCallKey({ pos: "SB", line: "limp", opener: null, before: 0, openTo: 0, complete: true }, 100)).toEqual({ table: "limp", key: "sbcomplete_fold_deep" });
    expect(poolCallKey({ pos: "SB", line: "limp", opener: null, before: 4, openTo: 0, complete: true }, 100)).toEqual({ table: "limp", key: "sbcomplete_b3" });
    expect(poolCallKey({ pos: "BTN", line: "overlimp", opener: null, before: 3, openTo: 0, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_overlimp_ALL_b2p" });
    setPoolCallTable({ ...TABLE, ranges: {} });
    expect(poolCallKey({ pos: "BTN", line: "overlimp", opener: null, before: 3, openTo: 0, complete: false }, 100)).toEqual({ table: "limp", key: "overlimp_deep" });
    // the limp table's finest band for his stack (LIMP_LOCKS=v3, the default), the coarse one under v2
    expect(poolCallKey({ pos: "BTN", line: "overlimp", opener: null, before: 3, openTo: 0, complete: false }, 30)).toEqual({ table: "limp", key: "overlimp_short_25_40" });
    process.env.LIMP_LOCKS = "v2";
    try {
      expect(poolCallKey({ pos: "BTN", line: "overlimp", opener: null, before: 3, openTo: 0, complete: false }, 30)).toEqual({ table: "limp", key: "overlimp_short_le60" });
    } finally { delete process.env.LIMP_LOCKS; }
    expect(poolCallKey({ pos: "UTG", line: "limp", opener: null, before: 0, openTo: 0, complete: false }, NaN)).toBeNull();
  });
  test("the shipped table (poker locks_v2/poolcalls_locks.json): brief_I-002's seats resolve to their own cells, the open size first", () => {
    expect(poolCallKey({ pos: "BTN", line: "flat", opener: "UTG", before: 0, openTo: 2.5, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_flat_BTN_vsUTG_oM_80p" });
    expect(poolCallKey({ pos: "SB", line: "overcall", opener: "UTG", before: 1, openTo: 2.5, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_overcall_SB_b1_oM_80p" });
    expect(poolCallKey({ pos: "SB", line: "overcall", opener: "UTG", before: 1, openTo: 2.0, complete: false }, 30)).toEqual({ table: "call", key: "poolcall_overcall_SB_b1_oS_le40" });
    expect(poolCallKey({ pos: "BB", line: "bbiso", opener: "CO", before: 1, openTo: 5, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_bbiso_BB_l1_80p" });
    expect(poolCallKey({ pos: "UTG", line: "limpcall", opener: "CO", before: 2, openTo: 5, complete: false }, 50)).toEqual({ table: "call", key: "poolcall_limpcall_UTG_l2p_40_80" });
    expect(poolCallKey({ pos: "SB", line: "sbiso", opener: "CO", before: 1, openTo: 5, complete: true }, 100)).toEqual({ table: "call", key: "poolcall_sbiso_SB_l1_80p" });
    expect(poolCallKey({ pos: "BTN", line: "overlimp", opener: null, before: 3, openTo: 0, complete: false }, 100)).toEqual({ table: "call", key: "poolcall_overlimp_BTN_b2p_80p" });
    const r = poolCallRange({ table: "call", key: "poolcall_overcall_SB_b1_oM_80p" })!;
    expect(r.freq).toBeGreaterThan(0.05);
    expect(Object.keys(r.weights).length).toBe(169);
  });
});

describe("applyPoolCallRanges", () => {
  const fitted = () => ({ UTG: { AA: 1, AKs: 1 }, BTN: { TT: 0.3 }, SB: { "88": 0.1, AJs: 0.02 }, BB: { QJs: 1, "72o": 0.5 } });
  test("brief_I-002: the BTN and the SB take the pool's ranges outright; hero (BB) and the opener keep theirs", () => {
    setPoolCallTable(TABLE);
    const r = applyPoolCallRanges({ hand: hand(BRIEF_I_002, 6), heroPos: "BB", ranges: fitted(), dealt: dealt() });
    expect(r.applied.map((x) => [x.pos, x.key, x.was, x.now])).toEqual([
      ["BTN", "poolcall_flat_BTN_vsUTG_80p", 1.8, 9.2],      // 0.2*6 + 1*6 + 0.5*4
      ["SB", "poolcall_overcall_SB_b1_80p", 0.68, 9.2],      // 1*6 + 0.8*4
    ]);
    expect(r.ranges.BTN).toEqual({ AA: 0.2, TT: 1, "76s": 0.5 });
    expect(r.ranges.SB).toEqual({ "88": 1, KQs: 0.8, "72o": 0 });
    expect(r.ranges.UTG).toEqual({ AA: 1, AKs: 1 });
    expect(r.ranges.BB).toEqual({ QJs: 1, "72o": 0.5 });
    const note = poolCallNote(r.applied, "gtow-ai · 6-handed");
    expect(note).toStartWith("POOL CALL RANGE: the BTN (100bb) flat-called the UTG's open — 1.8 combos on gtow-ai · 6-handed, now the pool's poolcall_flat_BTN_vsUTG_80p (7.00% of chances, 700 calls measured, 9.2 combos); the SB (100bb) over-called the open behind 1 caller — 0.68 combos");
    // the mutation oracle reads the same note back
    expect([...poolFloorsOf(`PREFLOP: x · ${note}`)]).toEqual([["BTN", { kind: "call", key: "poolcall_flat_BTN_vsUTG_80p", was: 1.8 }], ["SB", { kind: "call", key: "poolcall_overcall_SB_b1_80p", was: 0.68 }]]);
  });
  test("a seat with no measured line, a seat not at the flop, a seat already given a pool range (skip), a later raiser: untouched", () => {
    setPoolCallTable(TABLE);
    // brief_I-011 at 30bb: HJ flat has only the 80p cell and the seat's… no `_all` → HJ gets nothing at 30bb; CO b1 (no stack); BTN b2p
    const r = applyPoolCallRanges({ hand: hand(BRIEF_I_011, 6), heroPos: "BB", ranges: { UTG: { AA: 1 }, HJ: { "99": 0.1 }, CO: { "77": 0.1 }, BTN: { "55": 0.1 }, BB: { QJs: 1 } }, dealt: dealt({ 2: 30, 3: 30, 4: 30 }), skip: ["btn"] });
    expect(r.applied.map((x) => [x.pos, x.key])).toEqual([["CO", "poolcall_overcall_CO_b1"]]);
    expect(r.ranges.HJ).toEqual({ "99": 0.1 });
    expect(r.ranges.BTN).toEqual({ "55": 0.1 });
    // the SB folded: not at the flop, nothing to replace
    expect(applyPoolCallRanges({ hand: hand(BRIEF_I_002, 6), heroPos: "BB", ranges: { UTG: { AA: 1 }, BTN: { TT: 1 } }, dealt: dealt() }).applied.map((x) => x.pos)).toEqual(["BTN"]);
  });
  test("the limped pot: deep limpers take the limp table's keys, the over-limp behind 3 this table's", () => {
    setPoolCallTable(TABLE);
    const r = applyPoolCallRanges({ hand: hand(LIMPED_6, 3), heroPos: "CO", ranges: { UTG: { AA: 1 }, HJ: { AA: 1 }, CO: { AA: 1 }, BTN: { AA: 1 }, SB: { AA: 1 }, BB: { AA: 1 } }, dealt: dealt({ 2: 60, 5: 100 }) });
    expect(r.applied.map((x) => [x.pos, x.table, x.key])).toEqual([["UTG", "limp", "limp_first_deep"], ["HJ", "limp", "overlimp_short_40_60"], ["BTN", "call", "poolcall_overlimp_ALL_b2p"], ["SB", "limp", "sbcomplete_b3"]]);
    expect(r.applied.map((x) => x.limpTable ?? null)).toEqual(["v3", "v3", null, "v3"]);
    // the note tags a limp-table range with its table; the oracle reads it back
    const note = poolCallNote(r.applied, "gtow-ai · 6-handed");
    expect(note).toContain("now the pool's overlimp_short_40_60 (v3: ");
    expect(poolFloorsOf(`x · ${note}`).get("HJ")).toEqual({ kind: "call", key: "overlimp_short_40_60", was: 6, limpTable: "v3" });          // AA = 6 combos
    expect(poolFloorsOf(`x · ${note}`).get("BTN")).toEqual({ kind: "call", key: "poolcall_overlimp_ALL_b2p", was: 6 });
    expect(r.ranges.CO).toEqual({ AA: 1 });
    expect(r.ranges.BB).toEqual({ AA: 1 });
    expect(r.applied[0]!.now).toBeGreaterThan(20);
  });
  test("no range for the line (an empty call table, a raised pot): ranges untouched, nothing applied", () => {
    setPoolCallTable({ ranges: {} });
    const rg = fitted();
    const r = applyPoolCallRanges({ hand: hand(BRIEF_I_002, 6), heroPos: "BB", ranges: rg, dealt: dealt() });
    expect(r.applied).toEqual([]);
    expect(r.ranges).toBe(rg);
  });
});

describe("a limper's call of the iso is limp × call-given-limp (2026-10-09)", () => {
  const combos = (w: Record<string, number>) => Object.entries(w).reduce((s, [c, x]) => s + x * (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12), 0);
  test("limpKeyOf: the limp table's role × stack, deep keys included", () => {
    expect(limpKeyOf(0, false, 30)).toBe("limp_first_short_le60");
    expect(limpKeyOf(1, false, 30)).toBe("overlimp_short_25_40");
    expect(limpKeyOf(0, false, 100)).toBe("limp_first_deep");
    expect(limpKeyOf(2, false, 100)).toBe("overlimp_deep");
    expect(limpKeyOf(1, true, 100)).toBe("sbcomplete_b1_deep");
    expect(limpKeyOf(0, true, 40)).toBe("sbcomplete_fold_short_le60");
  });
  test("limpCallProduct: hand by hand, rounded to 1e-4, hands the call cell lacks go to 0", () => {
    expect(limpCallProduct({ AA: 0.5, "22": 0.8, "72o": 0.1 }, { AA: 1, "22": 0.5 })).toEqual({ AA: 0.5, "22": 0.4, "72o": 0 });
  });
  test("the call overlay: the UTG who limped (100bb) and called the iso holds limp_first_deep × the limpcall cell, never the cell alone; the BB's iso call is the cell outright", () => {
    setPoolCallTable(TABLE);
    const cs = poolCallersOf(hand(ISO, 3), "CO");
    expect(cs.find((c) => c.pos === "UTG")).toMatchObject({ line: "limpcall", before: 2, limpsBefore: 0 });
    const r = applyPoolCallRanges({ hand: hand(ISO, 3), heroPos: "CO", ranges: { UTG: { AA: 1 }, CO: { AA: 1 }, BTN: { AA: 1 }, BB: { AA: 1 } }, dealt: dealt() });
    const deep = limpLockRange("limp_first_deep")!;
    const u = r.applied.find((x) => x.pos === "UTG")!;
    expect(u).toMatchObject({ key: "poolcall_limpcall_ALL_l2p", table: "call", times: { key: "limp_first_deep", freq: deep.freq, n: deep.n, limpTable: "v3" } });
    expect(r.ranges.UTG).toEqual(limpCallProduct(deep.weights as Record<string, number>, { "22": 1 }));
    expect(u.now).toBeCloseTo(6 * Math.round(1e4 * (deep.weights as Record<string, number>)["22"]!) / 1e4, 2);
    expect(u.now).toBeLessThan(6);                                              // 22 limps first in well under 100%
    expect(r.ranges.BB).toEqual({ "33": 1 });                                   // bbiso: no limp of his own — the cell as it is
    expect(r.ranges.BTN).toEqual({ AA: 1 });                                    // a cold call of the iso: no line
    const note = poolCallNote(r.applied, "gtow-ai · 6-handed");
    expect(note).toContain("now the pool's poolcall_limpcall_ALL_l2p (50.00% of chances, 5,000 calls measured) × his limp range limp_first_deep (v3: 3.1% of hands, n=667) = ");
    // the mutation oracle reads both keys back and rebuilds the product
    const f = poolFloorsOf(`x · ${note}`).get("UTG")!;
    expect(f).toEqual({ kind: "call", key: "poolcall_limpcall_ALL_l2p", was: 6, times: { kind: "limp", key: "limp_first_deep", limpTable: "v3" } });
    expect(poolRangeOf(f)).toEqual(r.ranges.UTG);
  });
  test("the floor's limp-caller: a 30bb UTG limps, hero isolates, he calls — the whole cell × his limp-call rate, said in the floor's note", () => {
    setPoolCallTable(TABLE);
    // UTG (30bb) limps, HJ limps, hero CO raises 5, BTN / SB fold, BB calls, UTG calls, HJ folds
    const h = hand(ISO, 3);
    const d = dealt({ 1: 30 });
    const fl = applyPoolLimpFloor({ hand: h, heroPos: "CO", ranges: { UTG: { AA: 0.001 }, CO: { AA: 1 }, BB: { AA: 1 } }, chartId: "gtow-ai · 6-handed", dealt: d, planOf: () => null });
    expect(fl.applied.map((x) => [x.pos, x.key])).toEqual([["UTG", "limp_first_short_le60"]]);
    const cell = limpLockRange("limp_first_short_le60")!;
    const base = fl.applied[0]!.now;
    expect(base).toBeCloseTo(combos(cell.weights as Record<string, number>), 1);
    const lc = applyLimpCallProduct({ hand: h, heroPos: "CO", ranges: fl.ranges, dealt: d, floored: fl.applied });
    expect(lc.applied).toEqual(["UTG"]);
    expect(fl.applied[0]!.times).toEqual({ key: "poolcall_limpcall_ALL_l2p", freq: 0.5, n: 5000, base });
    expect(lc.ranges.UTG).toEqual(limpCallProduct(cell.weights as Record<string, number>, { "22": 1 }));
    expect(fl.applied[0]!.now).toBeCloseTo(combos(lc.ranges.UTG!), 2);
    const note = poolLimpFloorNote(fl.applied, "gtow-ai · 6-handed");
    expect(note).toContain(`now the pool's limp_first_short_le60 (v3: 26.3% of hands, n=278, ${base} combos) × his limp-call rate poolcall_limpcall_ALL_l2p (50.0% of chances, 5,000 calls) = ${fl.applied[0]!.now} combos`);
    const f = poolFloorsOf(`x · ${note}`).get("UTG")!;
    expect(f).toEqual({ kind: "limp", key: "limp_first_short_le60", was: 0.01, limpTable: "v3", times: { kind: "call", key: "poolcall_limpcall_ALL_l2p" } });
    expect(poolRangeOf(f)).toEqual(lc.ranges.UTG);
    // a limper who folded to the iso is not at the flop; a limp-raiser keeps the tree's range: nothing multiplied
    expect(applyLimpCallProduct({ hand: h, heroPos: "CO", ranges: fl.ranges, dealt: d, floored: [] }).applied).toEqual([]);
  });
});

describe("the Ignition group calibration on top of the product (2026-10-09)", () => {
  const combos = (w: Record<string, number>) => Object.entries(w).reduce((s, [c, x]) => s + x * (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12), 0);
  test("handGroup: the builders' eight groups, verbatim", () => {
    expect(["AA", "AKo", "99", "A5s", "A5o", "KQs", "KTo", "K9s", "K9o", "76s", "72o"].map(handGroup))
      .toEqual(["prem", "prem", "pairs", "Axs", "Axo", "s-bway", "o-bway", "oth-s", "o-junk", "oth-s", "o-junk"]);
  });
  test("the shipped table: a cell is active only with leave-one-out gain; the deep first-in limper facing the iso alone is, the thin and losing cells are not", () => {
    const cells = CALIBRATION.cells as Record<string, { active: boolean; n: number; loo_gain_per_hand?: number }>;
    for (const [k, c] of Object.entries(cells)) if (c.active) expect(c.loo_gain_per_hand ?? 0).toBeGreaterThan(0);
    expect(cells.limpcall_deep_l1!.active).toBe(true);
    expect(limpCallCalibrationKey("limpcall", 100, 1)).toBe("limpcall_deep_l1");
    expect(limpCallCalibrationKey("limpcall", 30, 1)).toBeNull();            // 64 hands, no out-of-sample gain
    expect(limpCallCalibrationKey("limpcall", 100, 2)).toBeNull();           // 52 hands, no gain
    expect(limpCallCalibrationKey("sbiso", 100, 1)).toBeNull();
    const m = limpCallCalibration("limpcall_deep_l1")!;
    expect(m.prem).toBeLessThan(0.6);                                        // 5% observed premiums vs the product's 19%
    expect(m.pairs).toBeGreaterThan(1.3);
  });
  test("limpCallProduct with a cell: groups re-weighted, the total kept, no weight past 1; without one, unchanged", () => {
    const limp = { AA: 0.5, "22": 0.5, "72o": 0.5, "76s": 0.5, KQo: 0.5 };
    const cond = { AA: 1, "22": 1, "72o": 1, "76s": 1, KQo: 1 };
    const plain = limpCallProduct(limp, cond);
    const cal = limpCallProduct(limp, cond, "limpcall_deep_l1");
    const m = limpCallCalibration("limpcall_deep_l1")!;
    expect(cal.AA / plain.AA).toBeLessThan(cal["22"]! / plain["22"]!);     // premiums down, pairs up
    expect(Math.abs(combos(cal) - combos(plain))).toBeLessThan(0.05);       // the total survives the re-weighting
    expect(Object.values(cal).every((v) => v <= 1)).toBe(true);
    expect(cal["22"]! / plain["22"]! / (cal["76s"]! / plain["76s"]!)).toBeCloseTo(m.pairs / m["oth-s"]!, 2);
    expect(limpCallProduct(limp, cond, "no-such-cell")).toEqual(plain);
    expect(limpCallProduct(limp, cond, "limpcall_le60_l1")).toEqual(plain);   // an inactive cell is a no-op
  });
  test("the overlay names the cell; the oracle reads it back and rebuilds the calibrated product", () => {
    setPoolCallTable(TABLE);
    // UTG (100bb) limps alone, HJ folds, hero CO isolates to 5, everyone folds, UTG calls
    const one = [...BLINDS, pre(1, "call", 1), pre(2, "fold"), pre(3, "raise", 5, true), pre(4, "fold"), pre(5, "fold"), pre(6, "fold"), pre(1, "call", 5)];
    const r = applyPoolCallRanges({ hand: hand(one, 3), heroPos: "CO", ranges: { UTG: { AA: 1 }, CO: { AA: 1 } }, dealt: dealt() });
    const u = r.applied.find((x) => x.pos === "UTG")!;
    expect(u.times).toMatchObject({ key: "limp_first_deep", cal: "limpcall_deep_l1" });
    const deep = limpLockRange("limp_first_deep")!;
    expect(r.ranges.UTG).toEqual(limpCallProduct(deep.weights as Record<string, number>, TABLE.ranges.poolcall_limpcall_ALL_l1!.weights, "limpcall_deep_l1"));
    const note = poolCallNote(r.applied, "gtow-ai · 6-handed");
    expect(note).toContain(") × Ignition calibration limpcall_deep_l1 = ");
    const f = poolFloorsOf(`x · ${note}`).get("UTG")!;
    expect(f.times).toEqual({ kind: "limp", key: "limp_first_deep", limpTable: "v3", cal: "limpcall_deep_l1" });
    expect(poolRangeOf(f)).toEqual(r.ranges.UTG);
  });
});
