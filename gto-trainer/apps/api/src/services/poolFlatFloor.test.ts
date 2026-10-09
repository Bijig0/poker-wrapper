import { afterEach, describe, expect, test } from "bun:test";
import { applyPoolFlatFloor, poolFlatFloorMode, poolFlatFloorNote } from "./poolFlatFloor";
import { poolCallersOf, setPoolCallTable, type PoolCallTable } from "./poolCalls";
import { poolFloorsOf, poolRangeOf } from "../scripts/mutation/rangeOracle";
import { departureForCode, departureForWarning } from "./approximations";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { sbFlatRange, sbFlatTable } from "./poolSbFlat";
import { poolCiLower, shouldReplace, wilsonLower } from "./poolTrigger";

/**
 * THE POOL FLAT FLOOR (services/poolFlatFloor, 2026-10-09): on every line, a flat / over-call / BB iso-call whose walked
 * range fails the trigger rule holds the pool's cell. Hermetic: the call table is injected.
 */
const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as Record<number, string>;
const pre = (seatId: number, type: string, amount?: number, hero = false) => ({ seatId, hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const hand = (actions: any[], heroSeatId: number): ParsedHand => ({ heroSeatId, positions: POS, actions, stacks: {}, committed: {}, heroCards: [] } as unknown as ParsedHand);
const BLINDS = [pre(5, "post-sb", 0.5), pre(6, "post-bb", 1)];
const dealt = (over: Record<number, number> = {}) => ({ 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, ...over });

const CLASSES = (() => {
  const R = "AKQJT98765432";
  const out: string[] = [];
  for (let i = 0; i < 13; i++) for (let j = i; j < 13; j++) {
    if (i === j) out.push(R[i]! + R[j]!);
    else { out.push(R[i]! + R[j]! + "s"); out.push(R[i]! + R[j]! + "o"); }
  }
  return out;
})();
const flat = (w: number) => Object.fromEntries(CLASSES.map((c) => [c, w]));
const cell = (line: string, seat: string, qual: string | null, stack: string, freq: number, weights: Record<string, number>, chances = 10000) =>
  ({ line, seat, qual, stack, freq, chances, calls: Math.round(chances * freq), shown: 400, shape_from: "own", weights });
/** the pool's SB flat ≤40bb: pairs and suited hands, premiums part-time */
const SB_FLAT = Object.fromEntries(CLASSES.map((c) => [c, c.length === 2 ? 1 : c.endsWith("s") ? 0.6 : /^[AK]/.test(c) ? 0.2 : 0.05]));
/** a pool BB defend that looks like the uniform 40% one (same mix) */
const BB_DEFEND_45 = flat(0.45);
/** a pool BB defend of pairs + broadways (49%), against a junk-only solver defend */
const BB_DEFEND_BROAD = Object.fromEntries(CLASSES.map((c) => [c, c.length === 2 || /^[AKQJT][AKQJT]/.test(c) ? 1 : c.endsWith("s") ? 0.7 : 0.2]));
const TABLE: PoolCallTable = {
  stack_edges: { le40: [0, 40], "40_80": [40, 80], "80p": [80, null] },
  open_split_adopted: false,
  ranges: {
    poolcall_flat_SB_vsBTN_le40: cell("flat", "SB", "vsBTN", "le40", 0.286, SB_FLAT, 15708),
    poolcall_flat_BB_vsCO_80p: cell("flat", "BB", "vsCO", "80p", 0.45, BB_DEFEND_45),
    poolcall_flat_BB_vsHJ_le40: cell("flat", "BB", "vsHJ", "le40", 0.488, BB_DEFEND_BROAD),
    poolcall_bbiso_BB_l1: cell("bbiso", "BB", "l1", "all", 0.14, flat(0.14)),
    poolcall_overcall_SB_b1_80p: cell("overcall", "SB", "b1", "80p", 0.106, flat(0.106)),
  },
};
afterEach(() => {
  setPoolCallTable(null);
  for (const k of ["POOL_FLAT_FLOOR", "POOL_TRIGGER_DIVERGENCE", "SB_FLAT_TABLE", "SB_FLAT_OWN_FACTOR"]) delete process.env[k];
});

/** BTN opens 2.5, a 35bb SB flats, hero calls from the BB (a chart arrival) */
const SB_FLAT_LINE = [...BLINDS, pre(1, "fold"), pre(2, "fold"), pre(3, "fold"), pre(4, "raise", 2.5), pre(5, "call", 2.5), pre(6, "call", 2.5, true)];

describe("applyPoolFlatFloor", () => {
  test("an SB flat on a chart arrival holding 0.3 combos (residue): replaced by the pool's ≤40bb flat cell", () => {
    setPoolCallTable(TABLE);
    const ranges = { BTN: { AA: 1, AKs: 1 }, SB: { AKs: 0.075 }, BB: { QJs: 1 } };
    const r = applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges, dealt: dealt({ 5: 35 }) });
    expect(r.applied.map((x) => [x.pos, x.line, x.key, x.was, x.why])).toEqual([["SB", "flat", "poolcall_flat_SB_vsBTN_le40", 0.3, "residue"]]);
    expect(r.ranges.SB).toEqual(SB_FLAT);
    expect(r.ranges.BTN).toEqual({ AA: 1, AKs: 1 });             // the opener keeps the walk's
    expect(r.ranges.BB).toEqual({ QJs: 1 });                     // hero never
    expect(ranges.SB).toEqual({ AKs: 0.075 });                   // the input is not mutated
    const note = poolFlatFloorNote(r.applied, "ign200_6max_D30");
    expect(note).toStartWith("POOL FLAT RANGE: the SB (35bb) flat-called the BTN's open — 0.3 combos on ign200_6max_D30, now the pool's poolcall_flat_SB_vsBTN_le40 (28.60% of chances, 4,492 calls measured, ");
    expect(note).toContain("trigger residue: the solver plays it 0.023% (< 1.00%)");
  });

  test("THE ORACLE ROUND TRIP: rangeOracle reads the note back and rebuilds the range exactly", () => {
    setPoolCallTable(TABLE);
    const r = applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges: { BTN: { AA: 1 }, SB: { AKs: 0.075 }, BB: { QJs: 1 } }, dealt: dealt({ 5: 35 }) });
    const note = poolFlatFloorNote(r.applied, "gtow-ai · 6-handed");
    const f = poolFloorsOf(`PREFLOP RANGES FROM THE PIN: x · ${note}`);
    expect([...f]).toEqual([["SB", { kind: "call", key: "poolcall_flat_SB_vsBTN_le40", was: 0.3 }]]);
    expect(poolRangeOf(f.get("SB")!)).toEqual(r.ranges.SB!);
  });

  test("a BB defend where the solver plays 40% and the pool 45%: NOT replaced (no divergence, even with the arm on); kept with the reason", () => {
    setPoolCallTable(TABLE);
    process.env.POOL_TRIGGER_DIVERGENCE = "on";
    // CO opens (hero), the BB defends
    const acts = [...BLINDS, pre(1, "fold"), pre(2, "fold"), pre(3, "raise", 2.5, true), pre(4, "fold"), pre(5, "fold"), pre(6, "call", 2.5)];
    const r = applyPoolFlatFloor({ hand: hand(acts, 3), heroPos: "CO", ranges: { CO: { AA: 1 }, BB: flat(0.4) }, dealt: dealt() });
    expect(r.applied).toEqual([]);
    expect(r.kept.map((k) => [k.pos, k.key])).toEqual([["BB", "poolcall_flat_BB_vsCO_80p"]]);
    expect(r.kept[0]!.text).toContain("not under the pool's rate / 2");
    expect(r.ranges.BB).toEqual(flat(0.4));
  });

  test("a 29bb BB defending 16% of junk against the pool's 49% of pairs and broadways: replaced on divergence when the arm is on (off, the default: kept)", () => {
    setPoolCallTable(TABLE);
    process.env.POOL_TRIGGER_DIVERGENCE = "on";
    const acts = [...BLINDS, pre(1, "fold"), pre(2, "raise", 2.5, true), pre(3, "fold"), pre(4, "fold"), pre(5, "fold"), pre(6, "call", 2.5)];
    const junk = Object.fromEntries(CLASSES.map((c) => [c, c.endsWith("o") && !/[AKQJT]/.test(c) ? 0.62 : 0]));
    const r = applyPoolFlatFloor({ hand: hand(acts, 2), heroPos: "HJ", ranges: { HJ: { AA: 1 }, BB: junk }, dealt: dealt({ 6: 29 }) });
    expect(r.applied.map((x) => [x.pos, x.key, x.why])).toEqual([["BB", "poolcall_flat_BB_vsHJ_le40", "divergence"]]);
    expect(r.applied[0]!.was / 1326).toBeGreaterThan(0.1);
    process.env.POOL_TRIGGER_DIVERGENCE = "off";
    expect(applyPoolFlatFloor({ hand: hand(acts, 2), heroPos: "HJ", ranges: { HJ: { AA: 1 }, BB: junk }, dealt: dealt({ 6: 29 }) }).applied).toEqual([]);
    // "ignition": the call table's counts are CoinPoker's, so the arm stays off here too
    process.env.POOL_TRIGGER_DIVERGENCE = "ignition";
    const ig = applyPoolFlatFloor({ hand: hand(acts, 2), heroPos: "HJ", ranges: { HJ: { AA: 1 }, BB: junk }, dealt: dealt({ 6: 29 }) });
    expect(ig.applied).toEqual([]);
    expect(ig.kept[0]!.text).toContain("not Ignition's");
    delete process.env.POOL_TRIGGER_DIVERGENCE;
    const dflt = applyPoolFlatFloor({ hand: hand(acts, 2), heroPos: "HJ", ranges: { HJ: { AA: 1 }, BB: junk }, dealt: dealt({ 6: 29 }) });
    expect(dflt.applied).toEqual([]);
    expect(dflt.kept[0]!.text).toContain("divergence arm is off");
  });

  test("the BB's call of an iso over one limper (residue) is floored; the limper's own call is NOT this floor's (the limp floor's product)", () => {
    setPoolCallTable(TABLE);
    // UTG limps, hero CO isolates, BB calls, UTG calls
    const acts = [...BLINDS, pre(1, "call", 1), pre(2, "fold"), pre(3, "raise", 5, true), pre(4, "fold"), pre(5, "fold"), pre(6, "call", 5), pre(1, "call", 5)];
    const r = applyPoolFlatFloor({ hand: hand(acts, 3), heroPos: "CO", ranges: { UTG: { "22": 0.01 }, CO: { AA: 1 }, BB: { KQs: 0.02 } }, dealt: dealt() });
    expect(r.applied.map((x) => [x.pos, x.line, x.key])).toEqual([["BB", "bbiso", "poolcall_bbiso_BB_l1"]]);
    expect(r.ranges.UTG).toEqual({ "22": 0.01 });
  });

  test("left alone: a caller who called a 3-bet after his flat (no cell for the line), a later raiser, a seat in `skip`, a seat not at the flop", () => {
    setPoolCallTable(TABLE);
    // BTN opens, the 35bb SB flats, hero BB 3-bets, BTN folds, SB calls the 3-bet
    const three = [...BLINDS, pre(1, "fold"), pre(2, "fold"), pre(3, "fold"), pre(4, "raise", 2.5), pre(5, "call", 2.5), pre(6, "raise", 11, true), pre(4, "fold"), pre(5, "call", 11)];
    expect(poolCallersOf(hand(three, 6), "BB").find((c) => c.pos === "SB")?.calledLater).toBe(true);
    expect(applyPoolFlatFloor({ hand: hand(three, 6), heroPos: "BB", ranges: { SB: { AKs: 0.075 }, BB: { AA: 1 } }, dealt: dealt({ 5: 35 }) }).applied).toEqual([]);
    const sq = [...BLINDS, pre(1, "fold"), pre(2, "fold"), pre(3, "fold"), pre(4, "raise", 2.5), pre(5, "call", 2.5), pre(6, "raise", 11, true), pre(4, "fold"), pre(5, "raise", 35)];
    expect(applyPoolFlatFloor({ hand: hand(sq, 6), heroPos: "BB", ranges: { SB: { AKs: 0.075 }, BB: { AA: 1 } }, dealt: dealt({ 5: 35 }) }).applied).toEqual([]);
    expect(applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges: { BTN: { AA: 1 }, SB: { AKs: 0.075 }, BB: { AA: 1 } }, dealt: dealt({ 5: 35 }), skip: ["sb"] }).applied).toEqual([]);
    expect(applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges: { BTN: { AA: 1 }, BB: { AA: 1 } }, dealt: dealt({ 5: 35 }) }).applied).toEqual([]);
  });

  test("the switch and the register", () => {
    expect(poolFlatFloorMode()).toBe("on");
    process.env.POOL_FLAT_FLOOR = "off";
    expect(poolFlatFloorMode()).toBe("off");
    expect(departureForCode("arrival:pool-flat-floor")?.id).toBe("pool-flat-floor");
    expect(departureForWarning("POOL FLAT RANGE")?.id).toBe("pool-flat-floor");
    expect(departureForCode("arrival:pool-flat-floor")?.offSwitch?.env).toBe("POOL_FLAT_FLOOR");
  });
});

describe("THE SB-FLAT TABLE v2 (SB_FLAT_TABLE=v2, services/poolSbFlat)", () => {
  const WALK = { BTN: { AA: 1, AKs: 1 }, SB: { AKs: 0.075 }, BB: { QJs: 1 } };
  const T = () => sbFlatTable().ranges;

  test("off (unset): the SB's flat takes today's call-table cell, whatever history is passed", () => {
    setPoolCallTable(TABLE);
    const r = applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges: WALK, dealt: dealt({ 5: 35 }), seen: { SB: { n: 60, v: 30 } } });
    expect(r.applied.map((x) => [x.key, x.sbflat])).toEqual([["poolcall_flat_SB_vsBTN_le40", undefined]]);
  });

  test("v2, no seat history: the 35bb SB vs the BTN's 2.5bb open → poolcall_flat_SB_vsBTN_oM_25_65, the cell's NL200 freq and Ignition counts", () => {
    setPoolCallTable(TABLE);
    process.env.SB_FLAT_TABLE = "v2";
    const r = applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges: WALK, dealt: dealt({ 5: 35 }) });
    const cell = T()["poolcall_flat_SB_vsBTN_oM_25_65"]!;
    expect(r.applied.map((x) => [x.pos, x.key, x.was, x.why, x.freq, x.calls])).toEqual([["SB", "poolcall_flat_SB_vsBTN_oM_25_65", 0.3, "residue", cell.freq, cell.calls]]);
    expect(r.applied[0]!.sbflat).toMatchObject({ chain: "vpip_unknown", step: 0, chances: cell.chances, own: false, openTo: 2.5, vpip: "vpip unknown (no seat history)" });
    expect(r.ranges.SB).toEqual(cell.weights);
    expect(r.ranges.BTN).toEqual(WALK.BTN);
    const note = poolFlatFloorNote(r.applied, "ign200_6max_D30");
    expect(note).toStartWith("POOL FLAT RANGE: the SB (35bb) flat-called the BTN's open — 0.3 combos on ign200_6max_D30, now the pool's poolcall_flat_SB_vsBTN_oM_25_65 (sbflat v2: "
      + `${(100 * cell.freq).toFixed(2)}% of chances, ${cell.calls} calls measured of ${cell.chances} Ignition chances, vpip unknown (no seat history), `);
    expect(note).toContain("trigger residue: the solver plays it 0.023% (< 1.00%)");
  });

  test("v2 with his VPIP at this table: n = 45, v = 10 → v30, the VPIP cell (vband le75); n = 12 → unknown, said with its n", () => {
    setPoolCallTable(TABLE);
    process.env.SB_FLAT_TABLE = "v2";
    const known = applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges: WALK, dealt: dealt({ 5: 35 }), seen: { SB: { n: 45, v: 10 } } });
    expect(known.applied[0]!.key).toBe("poolcall_flat_SB_vsBTN_oM_le75_v30");
    expect(known.applied[0]!.sbflat).toMatchObject({ chain: "vpip_known", step: 0, vpip: "vpip v30 (n=45, v=10, 24.4%)" });
    expect(known.ranges.SB).toEqual(T()["poolcall_flat_SB_vsBTN_oM_le75_v30"]!.weights);
    const few = applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges: WALK, dealt: dealt({ 5: 35 }), seen: { SB: { n: 12, v: 3 } } });
    expect(few.applied[0]!.key).toBe("poolcall_flat_SB_vsBTN_oM_25_65");
    expect(poolFlatFloorNote(few.applied, null)).toContain(", vpip unknown (n=12), ");
  });

  test("THE CI READS THE CELL'S IGNITION COUNTS: 12 flats in 41 chances do not exclude a 19% solver flat (kept); CoinPoker-sized counts would have", () => {
    setPoolCallTable(TABLE);
    process.env.SB_FLAT_TABLE = "v2";
    // BTN opens 2.0 (oS), the 40bb SB flats, hero BB calls
    const acts = [...BLINDS, pre(1, "fold"), pre(2, "fold"), pre(3, "fold"), pre(4, "raise", 2), pre(5, "call", 2), pre(6, "call", 2, true)];
    const key = "poolcall_flat_SB_vsBTN_oS_25_65", c = T()[key]!;
    expect([c.calls, c.chances]).toEqual([12, 41]);
    const f = 0.19;   // under the pool's 40.8% / 2, above the 95% Wilson lower bound 17.6%
    expect(f).toBeLessThan(c.freq / 2);
    expect(f).toBeGreaterThan(wilsonLower(c.calls, c.chances));
    const r = applyPoolFlatFloor({ hand: hand(acts, 6), heroPos: "BB", ranges: { BTN: { AA: 1 }, SB: flat(f), BB: { AA: 1 } }, dealt: dealt({ 5: 40 }) });
    expect(r.applied).toEqual([]);
    expect(r.kept.map((k) => k.key)).toEqual([key]);
    expect(r.kept[0]!.text).toContain("does not exclude the solver's share");
    expect(r.kept[0]!.sbflat?.chances).toBe(41);
    // the same rate on the CoinPoker counts of the cell (cp_calls / cp_chances) clears the evidence test
    expect(shouldReplace({ fSolver: f, fPool: c.freq, poolCI: poolCiLower({ calls: c.cp_calls, chances: c.cp_chances }), groupKL: null, line: "preflop", reach: f }).text)
      .not.toContain("does not exclude");
  });

  test("THE ORACLE ROUND TRIP: poolFloorsOf reads 'sbflat v2' back to the v2 table (and 'sbflat v2 own' with the own factor)", () => {
    setPoolCallTable(TABLE);
    process.env.SB_FLAT_TABLE = "v2";
    const r = applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges: WALK, dealt: dealt({ 5: 35 }), seen: { SB: { n: 45, v: 10 } } });
    const f = poolFloorsOf(`PREFLOP RANGES FROM THE PIN: x · ${poolFlatFloorNote(r.applied, "gtow-ai · 6-handed")}`);
    expect([...f]).toEqual([["SB", { kind: "call", key: "poolcall_flat_SB_vsBTN_oM_le75_v30", was: 0.3, sbflat: { own: false } }]]);
    expect(poolRangeOf(f.get("SB")!)).toEqual(r.ranges.SB!);
    process.env.SB_FLAT_OWN_FACTOR = "on";
    const o = applyPoolFlatFloor({ hand: hand(SB_FLAT_LINE, 6), heroPos: "BB", ranges: WALK, dealt: dealt({ 5: 35 }) });
    const note = poolFlatFloorNote(o.applied, null);
    expect(note).toContain("now the pool's poolcall_flat_SB_vsBTN_oM_25_65 (sbflat v2 own: ");
    expect(note).toContain("% of chances (own NL200 factor), ");
    expect(o.applied[0]!.freq).toBeCloseTo(T()["poolcall_flat_SB_vsBTN_oM_25_65"]!.freq_pooled * 0.765, 12);
    delete process.env.SB_FLAT_OWN_FACTOR;     // the oracle follows the note, not the environment
    const fo = poolFloorsOf(note).get("SB")!;
    expect(fo.sbflat).toEqual({ own: true });
    expect(poolRangeOf(fo)).toEqual(o.ranges.SB!);
    expect(poolRangeOf(fo)).toEqual(sbFlatRange("poolcall_flat_SB_vsBTN_oM_25_65", { own: true })!.weights);
  });

  test("v2 is the SB's FLAT only: the BB's over-call behind him keeps the call table; an all-in open keeps today's cell", () => {
    setPoolCallTable({ ...TABLE, ranges: { ...TABLE.ranges, poolcall_overcall_BB_b1_80p: cell("overcall", "BB", "b1", "80p", 0.326, flat(0.326)) } });
    process.env.SB_FLAT_TABLE = "v2";
    // hero UTG opens 2.5, the SB flats, the BB over-calls
    const acts = [...BLINDS, pre(1, "raise", 2.5, true), pre(2, "fold"), pre(3, "fold"), pre(4, "fold"), pre(5, "call", 2.5), pre(6, "call", 2.5)];
    const r = applyPoolFlatFloor({ hand: hand(acts, 1), heroPos: "UTG", ranges: { UTG: { AA: 1 }, SB: { AKs: 0.075 }, BB: { KQs: 0.02 } }, dealt: dealt() });
    expect(r.applied.map((x) => [x.pos, x.key, !!x.sbflat])).toEqual([["SB", "poolcall_flat_SB_vsUTG_oM_98_110", true], ["BB", "poolcall_overcall_BB_b1_80p", false]]);
    // the BTN jams 30bb, the 35bb SB calls (and the line goes on): outside the v2 node
    const jam = [...BLINDS, pre(1, "fold"), pre(2, "fold"), pre(3, "fold"), pre(4, "all-in", 30), pre(5, "call", 30), pre(6, "call", 30, true)];
    expect(applyPoolFlatFloor({ hand: hand(jam, 6), heroPos: "BB", ranges: WALK, dealt: dealt({ 5: 35 }) }).applied.map((x) => [x.key, !!x.sbflat]))
      .toEqual([["poolcall_flat_SB_vsBTN_le40", false]]);
  });
});
