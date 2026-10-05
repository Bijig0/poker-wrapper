/**
 * THE TAKEOVER NARROWING (2026-10-05, Brady: "Need 100% coverage"): a turn whose flop had more bettors than one
 * three-seat walk holds. Pure: the groups and the replayed earlier streets, no cloud.
 */
import { describe, expect, test } from "bun:test";
import { narrowingPlan, moneyThrough, takeoverGroups, takeoverStreets, type RerootArgs } from "./multiwayReroot";

const base = (o: Partial<RerootArgs>): RerootArgs => ({
  ordered: [], heroPos: "", arr: () => new Array(1326).fill(1), streets: [], streetSeats: [], flopPot: 0, flopStack: 100,
  board: "", heroComboIdx: null, rake: null, specOf: (() => { throw new Error("unused"); }) as any, ...o,
});

describe("hand 4921735317 turn: UTG bet 2, BTN raised 4, SB and hero called, UTG called; turn UTG bets 19, BTN folds, SB calls", () => {
  const a = base({
    ordered: ["SB", "BB", "UTG", "BTN"], heroPos: "BB", flopPot: 4,
    behind: { SB: 103.2, BB: 91.8, UTG: 91.8, BTN: 36.8 },
    streets: [["X", "X", "R2", "R4", "C", "C", "C"], ["X", "X", "R19", "F", "C"]],
    streetSeats: [["SB", "BB", "UTG", "BTN", "SB", "BB", "UTG"], ["SB", "BB", "UTG", "BTN", "SB"]],
  });
  test("coverGroups cannot: hero + both flop bettors fill the walk and the SB is left over", () => {
    expect(narrowingPlan(a, 1, moneyThrough(a, 1)).groups).toBeNull();
  });
  test("the takeover groups cover the SB and the UTG (the BTN folded on the turn: no range needed)", () => {
    const g = takeoverGroups(a, 1, ["SB", "BB", "UTG", "BTN"], new Set(["UTG", "BTN"]), ["SB", "UTG"])!;
    expect(g).not.toBeNull();
    expect(new Set(g.flat())).toEqual(new Set(["BB", "SB", "UTG"]));
  });
  test("walking SB/BB/UTG through the flop: the calls of the BTN's raise are a layer (2 each into the pot), never a lead", () => {
    const t = takeoverStreets(a, 1, ["BB", "SB", "UTG"])!;
    expect(t.streets[0]!.map((x, i) => `${t.seats[0]![i]}:${x}`)).toEqual(["SB:X", "BB:X", "UTG:R2", "SB:C", "BB:C"]);
    expect(t.preload).toEqual({ SB: 2, BB: 2, UTG: 2 });
    expect(t.dead).toBe(4);
  });
});

describe("hand 4922305100 turn: flop UTG bets 1, hero/BTN call, SB raises 10.2, all call; turn SB bets 31.4, BB calls, UTG folds", () => {
  const a = base({
    ordered: ["SB", "BB", "UTG", "HJ", "BTN"], heroPos: "HJ", flopPot: 15.2,
    behind: { SB: 22.4, BB: 97, UTG: 93, HJ: 220.8, BTN: 80 },
    streets: [["X", "X", "R1", "C", "C", "R10.2", "C", "C", "C", "C"], ["R31.4", "C", "F"]],
    streetSeats: [["SB", "BB", "UTG", "HJ", "BTN", "SB", "BB", "UTG", "HJ", "BTN"], ["SB", "BB", "UTG"]],
  });
  test("every live villain but the turn folder is covered by walkable groups", () => {
    const g = takeoverGroups(a, 1, ["SB", "BB", "UTG", "HJ", "BTN"], new Set(["UTG", "SB"]), ["SB", "BB", "BTN"])!;
    expect(g).not.toBeNull();
    for (const p of ["SB", "BB", "BTN"]) expect(g.some((x) => x.includes(p))).toBe(true);
    for (const x of g) expect(takeoverStreets(a, 1, x)).not.toBeNull();
  });
  test("a group without the UTG: hero's call of his 1 bet is a layer, never hero's lead (stress-500 brief_H-002)", () => {
    const t = takeoverStreets(a, 1, ["HJ", "SB", "BB"])!;
    // the three checks then the SB's raise: the kept round restarts there, the SB bets 9.2 over the 1 in the pot
    expect(t.streets[0]!.map((x, i) => `${t.seats[0]![i]}:${x}`)).toEqual(["SB:R9.2", "BB:C", "HJ:C"]);
    expect(t.preload).toEqual({ HJ: 1, SB: 1, BB: 1 });
  });
});
