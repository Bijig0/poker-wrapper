import { describe, expect, test } from "bun:test";
import { menuAction, menuByClass, pickDeadMoney, planDeadMoney } from "./deadMoneyCollapse";
import { planCollapses } from "./multiwayCollapse";

const R = () => new Array(1326).fill(1);
const seatsOf = (...ps: string[]) => ps.map((pos) => ({ pos, range: R() }));
const line = (s: string) => s.split(" ").map((x) => { const [seat, tok] = x.split(":"); return { seat: seat!, tok: tok! }; });

describe("planDeadMoney", () => {
  // hand 4922578344: flop AdTc6d, 13 in the pot; behind SB 82.2 / BB 115.6 / HJ 138.8 / CO 152.8 / BTN 17.4
  const behind: Record<string, number> = { SB: 82.2, BB: 115.6, HJ: 138.8, CO: 152.8, BTN: 17.4 };
  const hand = { seats: seatsOf("SB", "BB", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("SB:X BB:X HJ:X CO:R3 BTN:R16.8 SB:C BB:F"), behind: (p: string) => behind[p] };

  test("hand 4922578344: no ghost or merge fits, the dead-money collapse keeps hero + the BTN + each other villain", () => {
    expect(planCollapses(hand.seats, "HJ", [hand.street])).toEqual([]);
    const { plans, why } = planDeadMoney(hand);
    expect(why).toBeNull();
    // ordered by what the kept villain can put against hero: the CO (138.8, capped at hero's) before the SB (99)
    expect(plans.map((p) => p.kind)).toEqual(["dead:SB + fold:BB", "fold:BB + dead:CO"]);
    const [keepCo, keepSb] = plans;
    expect(keepCo!.seats.map((s) => s.pos)).toEqual(["HJ", "CO", "BTN"]);
    expect(keepCo!.dead).toBe(16.8);
    expect(keepCo!.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["HJ:X", "CO:R3", "BTN:R16.8"]);
    expect(keepSb!.seats.map((s) => s.pos)).toEqual(["SB", "HJ", "BTN"]);
    expect(keepSb!.dead).toBe(3);
    expect(keepSb!.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "HJ:X", "BTN:R16.8", "SB:C"]);
    expect(pickDeadMoney(plans)!.mode).toBe("blend");
  });

  test("4-way bet, call, call: hero keeps the bettor and each caller in turn", () => {
    const b: Record<string, number> = { SB: 90, HJ: 100, CO: 100, BTN: 100 };
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("SB:X HJ:X CO:R3 BTN:C SB:C"), behind: (p) => b[p] });
    expect(plans.map((p) => p.seats.map((s) => s.pos).join("/"))).toEqual(["HJ/CO/BTN", "SB/HJ/CO"]);
    expect(plans.map((p) => p.dead)).toEqual([3, 3]);
    // the dropped caller's call is gone from the line; hero still faces the 3
    expect(plans[1]!.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "HJ:X", "CO:R3", "SB:C"]);
  });

  test("HEADS-UP AFTER FOLDS: a bettor who folds to a raise — hero and the raiser, the bet in the pot, hero's call his own bet", () => {
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "BB", "HJ", "CO"), heroPos: "HJ", street: line("SB:R4 BB:F HJ:C CO:R14 SB:F"), behind: () => 100 });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.headsUp).toBe(true);
    expect(plans[0]!.seats.map((s) => s.pos)).toEqual(["HJ", "CO"]);
    expect(plans[0]!.dead).toBe(4);
    expect(plans[0]!.kind).toBe("heads-up: folded:SB + fold:BB");
    // hero's 4 stays his: the table has hero 4 in facing 14 (10 to call) — so does the tree
    expect(plans[0]!.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["HJ:R4", "CO:R14"]);
    expect(plans[0]!.tookOver).toEqual(["HJ"]);
    expect(pickDeadMoney(plans)!.why).toMatch(/^HEADS-UP/);
  });

  test("a dropped raise that REOPENED the betting: the plan without him CUTS the street (2026-10-05)", () => {
    // SB checks, hero bets 4, CO and BTN call, the SB check-raises to 12, hero calls, the CO calls, the BTN raises to 30
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("SB:X HJ:R4 CO:C BTN:C SB:R12 HJ:C CO:C BTN:R30"), behind: () => 100 });
    const keepSb = plans.find((p) => p.seats.some((s) => s.pos === "SB"))!;
    expect(keepSb.cuts).toBe(0);
    expect(keepSb.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "HJ:R4", "BTN:C", "SB:R12", "HJ:C", "BTN:R30"]);
    // without the SB the kept seats' round closed at the BTN's call: cut there — each kept seat's 4 into the pot, the
    // tree's street restarts at the SB's raise: hero's call of it is hero's wager of 8 more, the BTN raises 26 more
    const keepCo = plans.find((p) => p.seats.some((s) => s.pos === "CO"))!;
    expect(keepCo.cuts).toBe(1);
    expect(keepCo.preload).toEqual({ HJ: 4, CO: 4, BTN: 4 });
    expect(keepCo.dead).toBe(12);
    expect(keepCo.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["HJ:R8", "CO:C", "BTN:R26"]);
    // the price: hero faces 26 - 8 = 18 = the table's 30 - 12; the pot 12 dead + 12 preload + 8 + 8 + 26 = the table's 66
  });

  test("review 2026-10-05: a kept seat ALL IN on the street has acted — the round closes, the reopening is cut", () => {
    const b: Record<string, number> = { SB: 80, BB: 100, UTG: 100, HJ: 8.18, BTN: 100 };
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "BB", "UTG", "HJ", "BTN"), heroPos: "BB",
      street: line("SB:X BB:R1.75 UTG:C HJ:RAI BTN:C SB:R28.33 BB:C UTG:F BTN:R69.22 SB:RAI"),
      amounts: [null, null, null, 8.18, null, null, null, null, null, 77.54].map((x) => x), behind: (p) => b[p] });
    for (const p of plans) {
      // every kept seat's round is legal: nobody raises his own called wager
      const toks = p.streets[0]!.map((t) => `${t.seat}:${t.tok}`);
      expect(toks.some((t, i) => i > 0 && t.startsWith("SB:R") && toks.slice(0, i).some((u) => u.startsWith("SB:R")) && !toks.slice(0, i).some((u) => /^(BTN|BB|HJ):R/.test(u) && toks.indexOf(u) > toks.findIndex((v) => v.startsWith("SB:R"))))).toBe(false);
    }
    expect(plans.length).toBeGreaterThan(0);
  });

  test("review 3: after a cut, a kept seat's all-in that is a CALL for less is a call (never a raise under the level)", () => {
    const b: Record<string, number> = { SB: 100, BB: 100, CO: 12, BTN: 100 };
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "BB", "CO", "BTN"), heroPos: "BTN",
      street: line("SB:X BB:R5 CO:C BTN:C SB:R20 BB:R50 CO:RAI"), amounts: [null, null, null, null, null, null, 12], behind: (p) => b[p] });
    const keep = plans.find((p) => p.seats.map((s) => s.pos).join("/") === "BB/CO/BTN")!;
    expect(keep.kind).toMatch(/street cut/);
    expect(keep.preload).toEqual({ BB: 5, CO: 5, BTN: 5 });
    expect(keep.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["BB:R45", "CO:C"]);
  });

  test("the takeover keeps a kept seat's price: a caller of a dropped bet bets it in the tree", () => {
    // UTG bets 3, hero (HJ) calls, CO raises to 10, UTG calls; the BTN is still to act — hero faces 7 more
    const { plans } = planDeadMoney({ seats: seatsOf("UTG", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("UTG:R3 HJ:C CO:R10 BTN:F UTG:C"), behind: () => 100 });
    // HU after the BTN's fold? no: UTG is still in — keep UTG (the plan) and the CO
    expect(plans).toHaveLength(1);
    expect(plans[0]!.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["UTG:R3", "HJ:C", "CO:R10", "UTG:C"]);
  });

  test("a dropped seat's chips count only up to what the kept seats can contest", () => {
    // the SB shoves 150 and the CO calls 150; hero (40 behind) faces the BTN's 30 bet — SB's 150 is 40 to hero
    const b: Record<string, number> = { SB: 150, HJ: 40, CO: 200, BTN: 30 };
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("SB:X HJ:X CO:X BTN:R30 SB:RAI CO:C"), amounts: [null, null, null, null, 150, null], behind: (p) => b[p] });
    for (const p of plans) for (const x of Object.values(p.deadBy)) expect(x).toBeLessThanOrEqual(40);
  });

  test("an unpriced wager refuses", () => {
    expect(planDeadMoney({ seats: seatsOf("SB", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("SB:R HJ:X"), behind: () => 100 }).plans).toEqual([]);
  });
});

describe("menuByClass", () => {
  const M = (xs: string) => xs.split(" ").map((c) => menuAction(c.replace(/\*$/, ""), c.endsWith("*") ? "ALLIN" : c));
  test("fold/call to themselves, the all-in to the all-in, the rest by nearest size", () => {
    expect(menuByClass(M("F C R56.6 R138.8*"), M("F C R50 R82.2*"))).toEqual(["F", "C", "R56.6", "R138.8"]);
    expect(menuByClass(M("X R4.3 R9.8 RAI"), M("X R5 R12 RAI"))).toEqual(["X", "R4.3", "R9.8", "RAI"]);
    expect(menuByClass(M("F C"), M("F C R40"))).toEqual(["F", "C", null]);
  });
  test("review 2026-10-05: a tree's plain biggest wager is not the reference's all-in", () => {
    expect(menuByClass(M("F C R20 R90*"), M("F C R20"))).toEqual(["F", "C", "R20"]);
    expect(menuByClass(M("X R3 R8 R60*"), M("X R9"))).toEqual(["X", "R8"]);
  });
});

describe("review 2026-10-05 probes", () => {
  test("a kept caller of a dropped bet keeps his chips (hero 10 to call into the table's pot)", () => {
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "BB", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("SB:R5 BB:F HJ:C CO:R15 BTN:C SB:C"), behind: () => 100 });
    const keepBtn = plans.find((p) => p.seats.some((s) => s.pos === "BTN"))!;
    expect(keepBtn.dead).toBe(15);
    expect(keepBtn.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["HJ:R5", "CO:R15", "BTN:C"]);
  });
  test("a kept short all-in does not turn a later raise into a call", () => {
    const b: Record<string, number> = { SB: 100, BB: 100, HJ: 100, CO: 100, BTN: 10 };
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "BB", "HJ", "CO", "BTN"), heroPos: "HJ",
      street: line("SB:X BB:X HJ:X CO:R3 BTN:RAI SB:R40 BB:C"), amounts: [null, null, null, null, 10, null, null], behind: (p) => b[p] });
    const keepBtn = plans.find((p) => p.seats.some((s) => s.pos === "BTN"))!;
    expect(keepBtn.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "HJ:X", "BTN:RAI", "SB:R40"]);
  });
  test("a dropped bettor, a kept caller, a kept check-raise: the caller's call is his bet, the street does not close early", () => {
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("SB:X HJ:X CO:R5 BTN:C SB:R20"), behind: () => 100 });
    const keepBtn = plans.find((p) => p.seats.some((s) => s.pos === "BTN"))!;
    expect(keepBtn.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "HJ:X", "BTN:R5", "SB:R20"]);
  });
});
