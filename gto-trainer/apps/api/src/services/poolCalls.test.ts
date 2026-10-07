import { afterEach, describe, expect, test } from "bun:test";
import { applyPoolCallRanges, poolCallKey, poolCallNote, poolCallersOf, setPoolCallTable, type PoolCallTable } from "./poolCalls";
import { poolFloorsOf } from "../scripts/mutation/rangeOracle";
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
    expect(poolCallKey({ pos: "BTN", line: "overlimp", opener: null, before: 3, openTo: 0, complete: false }, 30)).toEqual({ table: "limp", key: "overlimp_short_le60" });
    expect(poolCallKey({ pos: "UTG", line: "limp", opener: null, before: 0, openTo: 0, complete: false }, NaN)).toBeNull();
  });
  test("with the provisional (empty) shipped table nothing is replaced", () => {
    expect(poolCallKey({ pos: "BTN", line: "flat", opener: "UTG", before: 0, openTo: 2.5, complete: false }, 100)).toBeNull();
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
    expect(r.applied.map((x) => [x.pos, x.table, x.key])).toEqual([["UTG", "limp", "limp_first_deep"], ["HJ", "limp", "overlimp_short_le60"], ["BTN", "call", "poolcall_overlimp_ALL_b2p"], ["SB", "limp", "sbcomplete_b3"]]);
    expect(r.ranges.CO).toEqual({ AA: 1 });
    expect(r.ranges.BB).toEqual({ AA: 1 });
    expect(r.applied[0]!.now).toBeGreaterThan(20);
  });
  test("no table: ranges untouched, nothing applied", () => {
    const rg = fitted();
    const r = applyPoolCallRanges({ hand: hand(BRIEF_I_002, 6), heroPos: "BB", ranges: rg, dealt: dealt() });
    expect(r.applied).toEqual([]);
    expect(r.ranges).toBe(rg);
  });
});
