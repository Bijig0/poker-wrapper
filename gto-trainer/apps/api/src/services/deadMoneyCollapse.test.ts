import { describe, expect, test } from "bun:test";
import { heroPreloadAtNode, menuAction, menuByClass, pickDeadMoney, planDeadMoney, tableTotalActions, treeAllInAmounts, treePotAtHero, treeStreetChips, type DeadMoneyPlan } from "./deadMoneyCollapse";
import { shortAllInPress, treeAllInTo } from "./allInPress";
import { streetChips, streetFromTokens } from "../utils/tableMoney/tableMoney";
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
    expect(plans[0]!.kind).toBe("heads-up: folded:SB + fold:BB (called level in the pot)");
    // hero CALLED the SB's 4 — he never led (stress-500 brief_B-002: as a lead his range was cut to the tree's betting
    // frequency): the 4 is in the pot for hero and the CO alike, hero checks, the CO's raise to 14 is a bet of 10 —
    // hero faces 10, the table's 14 - 4
    expect(plans[0]!.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["HJ:X", "CO:R10"]);
    expect(plans[0]!.preload).toEqual({ HJ: 4, CO: 4 });
    expect(plans[0]!.tookOver).toEqual([]);
    expect(pickDeadMoney(plans)!.why).toMatch(/^HEADS-UP/);
  });

  test("a dropped raise that REOPENED the betting: the plan without him CUTS the street (2026-10-05)", () => {
    // SB checks, hero bets 4, CO and BTN call, the SB check-raises to 12, hero calls, the CO calls, the BTN raises to 30,
    // the SB calls — hero to act (the plans are walked: the line must end on hero, which it does only after the SB acts)
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("SB:X HJ:R4 CO:C BTN:C SB:R12 HJ:C CO:C BTN:R30 SB:C"), behind: () => 100 });
    const keepSb = plans.find((p) => p.seats.some((s) => s.pos === "SB"))!;
    expect(keepSb.cuts).toBe(0);
    expect(keepSb.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "HJ:R4", "BTN:C", "SB:R12", "HJ:C", "BTN:R30", "SB:C"]);
    // without the SB the kept seats' round closed at the BTN's call: cut there — each kept seat's 4 into the pot, the
    // tree's street restarts at the SB's raise: hero's call of it is hero's wager of 8 more, the BTN raises 26 more
    const keepCo = plans.find((p) => p.seats.some((s) => s.pos === "CO"))!;
    expect(keepCo.cuts).toBe(1);
    // hero's and the CO's calls of the SB's 12 are a layer (never hero's lead); the BTN's raise over the closed round
    // cuts it: 12 each into the pot, hero and the CO check, the BTN bets 18 — hero faces the table's 30 - 12
    expect(keepCo.preload).toEqual({ HJ: 12, CO: 12, BTN: 12 });
    expect(keepCo.dead).toBe(30);
    expect(keepCo.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["HJ:X", "CO:X", "BTN:R18"]);
  });

  test("a line that does not end on hero gives no plan (the walk is checked)", () => {
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "HJ", "CO", "BTN"), heroPos: "HJ", street: line("SB:X HJ:R4 CO:C BTN:C SB:R12 HJ:C CO:C BTN:R30"), behind: () => 100 });
    expect(plans.some((p) => p.seats.some((s) => s.pos === "SB"))).toBe(false);   // the SB is to act, not hero
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

  test("stress-500: a takeover of an INCOMPLETE all-in raise is a call, the increment into the pot (never a raise under the minimum)", async () => {
    const { replayKept } = await import("./deadMoneyCollapse");
    const { streetFromTokens } = await import("../utils/tableMoney/tableMoney");
    // brief_I-003: SB jams 15, BB calls, UTG jams 22 (+7 over 15: incomplete), CO calls 22, BTN calls 22, BB calls 7
    const b: Record<string, number> = { SB: 15, BB: 100, UTG: 22, CO: 100, BTN: 100 };
    const toks = ["RAI", "C", "RAI", "C", "C", "C"], who = ["SB", "BB", "UTG", "CO", "BTN", "BB"];
    const r = replayKept(streetFromTokens(toks, who, [15, null, 22, null, null, null]), toks, new Set(["BB", "CO", "BTN"]), (p) => b[p], ["SB", "BB", "UTG", "CO", "BTN"]);
    expect(r.toks.map((t, i) => `${r.seats[i]}:${t}`)).toEqual(["BB:R15", "CO:C", "BTN:C"]);
    expect(r.preload).toEqual({ CO: 7, BTN: 7, BB: 7 });
    // brief_D-001: … BTN raises 69.22 (+40.89), SB jams 78 (+8.78: incomplete), BB calls 78, BTN calls 78
    const b2: Record<string, number> = { SB: 78, BB: 99, UTG: 99, HJ: 9.18, BTN: 109 };
    const t2 = ["X", "R1.75", "C", "RAI", "C", "R28.33", "C", "F", "R69.22", "RAI", "C", "C"];
    const w2 = ["SB", "BB", "UTG", "HJ", "BTN", "SB", "BB", "UTG", "BTN", "SB", "BB", "BTN"];
    const r2 = replayKept(streetFromTokens(t2, w2, [null, null, null, 9.18, null, null, null, null, null, 78, null, null]), t2, new Set(["BB", "BTN"]), (p) => b2[p], ["SB", "BB", "UTG", "HJ", "BTN"]);
    expect(r2.toks.map((t, i) => `${r2.seats[i]}:${t}`)).toEqual(["BB:R1.75", "BTN:R9.18", "BB:R28.33", "BTN:R69.22", "BB:C"]);
    expect(r2.preload).toEqual({ BB: 8.78, BTN: 8.78 });
  });

  test("an incomplete increment applies to the raiser past it too: hero's call is the table's", () => {
    // SB X, BB bets 3.5, UTG(hero) calls, HJ calls, CO folds, SB raises 16.63, BB all in 14.75, hero calls, HJ raises 75.14, SB folds
    const b: Record<string, number> = { SB: 190.7, BB: 14.75, UTG: 146.14, HJ: 197.02, CO: 177.55 };
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "BB", "UTG", "HJ", "CO"), heroPos: "UTG",
      street: line("SB:X BB:R3.5 UTG:C HJ:C CO:F SB:R16.63 BB:C UTG:C HJ:R75.14 SB:F"), behind: (p) => b[p] });
    expect(plans).toHaveLength(1);
    const p = plans[0]!;
    // the kept round (BB 3.5, hero and HJ call) closed before the SB's raise: CUT — 3.5 each into the pot; the BB's all-in
    // call of 14.75 is his all-in; hero's call of 16.63 is 1.88 short of a legal raise over it: called, 1.88 into the pot;
    // the HJ's raise to 75.14 passes that level: his 1.88 too. Hero faces 69.76 - 11.25 = 58.51 = the table's 75.14 - 16.63
    expect(p.preload).toEqual({ BB: 3.5, UTG: 5.38, HJ: 5.38 });
    expect(p.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["BB:RAI", "UTG:C", "HJ:R69.76"]);
  });

  test("review 5: an all-in caller whose layer share leaves him all in does not check; a zero-stack seat after a cut is out", () => {
    // SB 1.98, BB (7.1 behind) raises 5.97, UTG 9.96, HJ 33.87, SB calls, BB calls all in — keep BB/UTG/HJ, hero UTG
    const b: Record<string, number> = { SB: 100, BB: 7.1, UTG: 100, HJ: 100 };
    const r1 = planDeadMoney({ seats: seatsOf("SB", "BB", "UTG", "HJ"), heroPos: "UTG", street: line("SB:R1.98 BB:R5.97 UTG:R9.96 HJ:R33.87 SB:C BB:C"), behind: (p) => b[p] });
    const k1 = r1.plans.find((p) => p.seats.map((s) => s.pos).join("/") === "BB/UTG/HJ");
    expect(k1).toBeDefined();
    expect(k1!.streets[0]!.some((t) => t.seat === "BB" && t.tok === "X")).toBe(false);
    // a cut that puts the BB's whole stack in the pot: the plan walks without him acting again (hero CO)
    const b2: Record<string, number> = { SB: 14.16, BB: 30.48, CO: 100, BTN: 100 };
    const r2 = planDeadMoney({ seats: seatsOf("SB", "BB", "CO", "BTN"), heroPos: "CO",
      street: line("SB:R3 BB:R6 CO:C BTN:C SB:RAI BB:C CO:C BTN:R22.32 BB:R30.48"), amounts: [null, null, null, null, 14.16, null, null, null, null], behind: (p) => b2[p] });
    expect(r2.plans.length).toBeGreaterThan(0);
  });

  test("stress-500 brief_B-002: hero CALLED a dropped raise — he checks in the tree, he never leads it", () => {
    // SB bets 4, BB raises 12, hero (HJ) calls 12, CO 3-bets 36, SB and BB fold → hero
    const { plans } = planDeadMoney({ seats: seatsOf("SB", "BB", "HJ", "CO"), heroPos: "HJ", street: line("SB:R4 BB:R12 HJ:C CO:R36 SB:F BB:F"), behind: () => 100 });
    expect(plans).toHaveLength(1);
    const p = plans[0]!;
    expect(p.headsUp).toBe(true);
    expect(p.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["HJ:X", "CO:R24"]);   // was HJ:R12 CO:R36 (a lead)
    expect(p.preload).toEqual({ HJ: 12, CO: 12 });
    expect(p.dead).toBe(16);
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
    // hero called the SB's 5: a layer (5 into the pot for hero, the CO and the BTN), hero checks, the CO bets 10
    expect(keepBtn.preload).toEqual({ HJ: 5, CO: 5, BTN: 5 });
    expect(keepBtn.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["HJ:X", "CO:R10", "BTN:C"]);
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

describe("THE POT AT HERO'S NODE IS THE TABLE'S (2026-10-07, stress-500 brief_I-004 flop decision 13)", () => {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  /** a spot, its plans, and for each plan: the tree's pot at hero's node as the chain is sent it (its all-ins at
   *  treeAllInAmounts), the same with the table's raw all-in amounts (the bug), the table's pot the tree's seats contest,
   *  and hero's amount to call in the tree */
  const spot = (seats: string[], hero: string, l: string, amounts: (number | null)[], b: Record<string, number>, start: number) => {
    const street = line(l);
    const { plans, why } = planDeadMoney({ seats: seatsOf(...seats), heroPos: hero, street, amounts, behind: (p) => b[p] });
    expect(why).toBeNull();
    const sc = streetChips(streetFromTokens(street.map((t) => t.tok), street.map((t) => t.seat), amounts), (p) => b[p]);
    const tableAllIn = (p: string) => { let to: number | null = null; street.forEach((t, i) => { if (t.seat === p && t.tok === "RAI" && amounts[i] != null) to = amounts[i]!; }); return to; };
    const tablePot = r2(start + [...sc.put.values()].reduce((x, y) => x + y, 0));
    const read = (p: DeadMoneyPlan) => {
      const am = treeAllInAmounts(p, tableAllIn)[0]!;
      const raw = p.streets[0]!.map((t) => (t.tok === "RAI" ? tableAllIn(t.seat) : null));
      const st = p.streets[0]!;
      const tc = treeStreetChips({ toks: st.map((x) => x.tok), seats: st.map((x) => x.seat), preload: p.preload }, (q) => b[q]!, am);
      return {
        kind: p.kind, amounts: am,
        pot: treePotAtHero(p, start, (q) => b[q]!, am),
        potRaw: treePotAtHero(p, start, (q) => b[q]!, raw),
        contested: r2(start + p.dead + p.seats.reduce((x, s) => x + (sc.put.get(s.pos) ?? 0), 0)),
        heroCall: r2(Math.min(tc.level, tc.cap(hero)) - (tc.put[hero] ?? 0)),
        heroCap: tc.cap(hero), heroIn: tc.put[hero] ?? 0,
      };
    };
    return { plans, tablePot, read, heroCall: r2(sc.level - (sc.put.get(hero) ?? 0)) };
  };

  test("brief_I-004: SB jams 15, hero calls, UTG jams 22 over it, CO and BTN call — hero faces 7 into 108.5 in every tree", () => {
    const b = { SB: 15, BB: 97.5, UTG: 22, CO: 97.5, BTN: 97.5 };
    const s = spot(["SB", "BB", "UTG", "CO", "BTN"], "BB", "SB:RAI BB:C UTG:RAI CO:C BTN:C", [15, null, 22, null, null], b, 12.5);
    expect(s.tablePot).toBe(108.5);
    expect(s.heroCall).toBe(7);
    const rs = s.plans.map(s.read);
    expect(rs.map((x) => x.kind)).toEqual(["dead:SB + dead:BTN (called level in the pot)", "dead:SB + dead:CO (called level in the pot)", "dead:CO + dead:BTN"]);
    // the called level (15) is in the starting pot for every kept seat past it — hero, and UTG / CO who went past it to 22
    expect(s.plans[0]!.preload).toEqual({ BB: 15, UTG: 15, CO: 15 });
    expect(s.plans[0]!.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["BB:X", "UTG:RAI", "CO:C"]);
    // so UTG's all-in is sent as the 7 he has in in the tree, not the table's 22
    expect(rs[0]!.amounts).toEqual([null, 7, null]);
    for (const r of rs) {
      expect(r.pot).toBe(108.5);
      expect(r.contested).toBe(108.5);
      expect(r.heroCall).toBe(7);
    }
    // THE BUG: the table's 22 beside UTG's all-in (the chain lifts his 7 to it, the CO calls 22) = 15 twice for each
    expect(rs.slice(0, 2).map((x) => x.potRaw)).toEqual([138.5, 138.5]);
    expect(rs[2]!.potRaw).toBe(108.5);   // no preload: the table's amount is the tree's
  });

  test("brief_I-004: the short all-in press detector still sees no short all-in at decision 13", () => {
    const b = { SB: 15, BB: 97.5, UTG: 22, CO: 97.5, BTN: 97.5 };
    const s = spot(["SB", "BB", "UTG", "CO", "BTN"], "BB", "SB:RAI BB:C UTG:RAI CO:C BTN:C", [15, null, 22, null, null], b, 12.5);
    const money = { heroCommitted: 15, heroBehind: 82.5, level: 22, minRaiseTo: 37,
      villains: [{ pos: "UTG", chips: 22, seat: 5 }, { pos: "CO", chips: 97.5, seat: 1 }, { pos: "BTN", chips: 97.5, seat: 2 }] };
    // hero's all-in in a tree = his tree stack there, his tree chips in at his node (treeAllInTo puts back his
    // preloaded 15); the third tree (SB, hero, UTG — both villains all in) offers hero no raise
    const trees = s.plans.map((p) => {
      const r = s.read(p);
      const live = p.streets[0]!.filter((t) => t.seat !== "BB").some((t) => t.tok !== "RAI");
      const node = live ? { actor: 0, invested: [r.heroIn], actions: [{ name: "FOLD", betsize: null }, { name: "CALL", betsize: null }, { name: "ALLIN", betsize: r.heroCap }] } : null;
      return { plan: p.kind, seats: p.seats.map((x) => x.pos), to: treeAllInTo(node, money.heroCommitted) };
    });
    expect(trees.map((t) => t.to)).toEqual([97.5, 97.5, null]);   // hero's whole 97.5: not short
    expect(shortAllInPress({ actions: [{ action: "FOLD", frequency: 0 }, { action: "CALL 7", frequency: 100 }, { action: "ALLIN 82.5", frequency: 0 }],
      heroPos: "BB", money, trees })).toEqual([]);
  });

  test("brief_D-001: a street cut and a called level, the SB jamming 78 over them — every tree's pot is the table's 191.48", () => {
    const b = { SB: 78, BB: 99, UTG: 99, HJ: 9.18, BTN: 109 };
    const s = spot(["SB", "BB", "UTG", "HJ", "BTN"], "BB", "SB:X BB:R1.75 UTG:C HJ:RAI BTN:C SB:R28.33 BB:C UTG:F BTN:R69.22 SB:RAI",
      [null, null, null, 9.18, null, null, null, null, null, 78], b, 5);
    expect(s.tablePot).toBe(191.48);
    const rs = s.plans.map(s.read);
    expect(rs.length).toBe(2);
    for (const r of rs) {
      expect(r.pot).toBe(191.48);
      expect(r.contested).toBe(191.48);
      expect(r.heroCall).toBe(49.67);
    }
    // the cut plan: the SB's 28.33 in the starting pot, his all-in sent as the 49.67 over it (the table's 78 put the
    // 28.33 in twice); the called-level plan: 7.43 (the HJ's 9.18 less hero's 1.75) layered, 70.57 sent
    expect(rs.find((x) => /street cut/.test(x.kind))!.amounts).toEqual([49.67]);
    expect(rs.find((x) => /called level/.test(x.kind))!.amounts.at(-1)).toBe(70.57);
    for (const r of rs) expect(r.potRaw).toBeGreaterThan(191.48 + 7);
  });

  test("bet-call-call (no preload): the tree's pot is the table's, unchanged", () => {
    const b = { SB: 90, HJ: 100, CO: 100, BTN: 100 };
    const s = spot(["SB", "HJ", "CO", "BTN"], "HJ", "SB:X HJ:X CO:R3 BTN:C SB:C", [null, null, null, null, null], b, 10);
    expect(s.plans.length).toBe(2);
    for (const r of s.plans.map(s.read)) { expect(r.pot).toBe(19); expect(r.potRaw).toBe(19); expect(r.heroCall).toBe(3); }
    for (const p of s.plans) expect(p.preload).toEqual({});
  });

  test("a kept seat RAISES OVER the level hero called: a sized raise and an all-in raise both price hero's node as the table", () => {
    const deep = { SB: 97.5, BB: 97.5, UTG: 97.5, CO: 97.5, BTN: 97.5 };
    const sized = spot(["SB", "BB", "UTG", "CO", "BTN"], "BB", "SB:R5 BB:C UTG:R20 CO:C BTN:C", [null, null, null, null, null], deep, 12.5);
    expect(sized.tablePot).toBe(82.5);
    expect(sized.plans.length).toBeGreaterThan(0);
    for (const r of sized.plans.map(sized.read)) { expect(r.pot).toBe(82.5); expect(r.heroCall).toBe(15); }
    const jam = spot(["SB", "BB", "UTG", "CO", "BTN"], "BB", "SB:R5 BB:C UTG:RAI CO:C BTN:C", [null, null, 30, null, null], { ...deep, UTG: 30 }, 12.5);
    expect(jam.tablePot).toBe(112.5);
    const rs = jam.plans.map(jam.read);
    for (const r of rs) { expect(r.pot).toBe(112.5); expect(r.heroCall).toBe(25); }
    expect(rs.filter((r) => /called level/.test(r.kind)).map((r) => [r.amounts[1], r.potRaw])).toEqual([[25, 122.5], [25, 122.5]]);
  });
});

describe("THE SERVED SIZES ARE THE TABLE'S on a preloaded plan (tableTotalActions, 2026-10-07)", () => {
  /** the menu as fastSolve builds it from GTO Wizard's action_solutions (label = name + betsize, betsize as sent) */
  const menu = (xs: [string, string][]) => xs.map(([action, betsize]) => ({ action, frequency: 0, betsize }));
  const planOf = (seats: string[], hero: string, l: string, amounts: (number | null)[], b: Record<string, number>, kind: RegExp) => {
    const { plans } = planDeadMoney({ seats: seatsOf(...seats), heroPos: hero, street: line(l), amounts, behind: (p) => b[p] });
    return plans.find((p) => kind.test(p.kind))!;
  };

  test("brief_I-004 decision 13: hero's 15 preloaded — RAISE 76.3 → 91.3, ALLIN 82.5 → his whole 97.5, CALL 7 → the call to 22", () => {
    const p = planOf(["SB", "BB", "UTG", "CO", "BTN"], "BB", "SB:RAI BB:C UTG:RAI CO:C BTN:C", [15, null, 22, null, null],
      { SB: 15, BB: 97.5, UTG: 22, CO: 97.5, BTN: 97.5 }, /called level/);
    expect(heroPreloadAtNode(p, "BB")).toBe(15);
    const served = tableTotalActions(menu([["FOLD", "0"], ["CALL 7", "7.000"], ["RAISE 76.3", "76.3"], ["ALLIN 82.5", "82.500"]]), heroPreloadAtNode(p, "BB"));
    expect(served.map((a) => a.action)).toEqual(["FOLD", "CALL 22", "RAISE 91.3", "ALLIN 97.5"]);
    expect(served.map((a) => a.betsize)).toEqual(["0", "22", "91.3", "97.5"]);
    expect(served.map((a) => a.treeBetsize)).toEqual([undefined, "7.000", "76.3", "82.500"]);
    // the third plan (dead:CO + dead:BTN) preloads nothing: its sizes are the table's already
    const plain = planOf(["SB", "BB", "UTG", "CO", "BTN"], "BB", "SB:RAI BB:C UTG:RAI CO:C BTN:C", [15, null, 22, null, null],
      { SB: 15, BB: 97.5, UTG: 22, CO: 97.5, BTN: 97.5 }, /^dead:CO \+ dead:BTN$/);
    expect(heroPreloadAtNode(plain, "BB")).toBe(0);
  });

  test("brief_D-001 / D-004 decision 18: the called level preloads hero's 7.43 — CALL 70.57 → the call to 78, ALLIN 91.57 → 99", () => {
    const p = planOf(["SB", "BB", "UTG", "HJ", "BTN"], "BB", "SB:X BB:R1.75 UTG:C HJ:RAI BTN:C SB:R28.33 BB:C UTG:F BTN:R69.22 SB:RAI",
      [null, null, null, 9.18, null, null, null, null, null, 78], { SB: 78, BB: 99, UTG: 99, HJ: 9.18, BTN: 109 }, /called level/);
    expect(heroPreloadAtNode(p, "BB")).toBe(7.43);
    const served = tableTotalActions(menu([["FOLD", "0"], ["CALL 70.57", "70.570"], ["ALLIN 91.57", "91.570"]]), 7.43);
    expect(served.map((a) => a.action)).toEqual(["FOLD", "CALL 78", "ALLIN 99"]);
    expect(served.map((a) => a.betsize)).toEqual(["0", "78", "99"]);
  });

  test("a plan without preload, or hero not preloaded, or hero's node past the plan's street: the menu byte-identical", () => {
    const m = menu([["CHECK", "0"], ["BET 38.1", "38.1"], ["ALLIN 75.5", "75.500"]]);
    const before = JSON.stringify(m);
    for (const pre of [0, null, undefined, 0.004, NaN]) {
      const out = tableTotalActions(m, pre);
      expect(out).toBe(m);
      expect(JSON.stringify(out)).toBe(before);
    }
    expect(heroPreloadAtNode({ streets: [[]] }, "BB")).toBe(0);
    expect(heroPreloadAtNode({ preload: {}, streets: [[]] }, "BB")).toBe(0);
    expect(heroPreloadAtNode({ preload: { UTG: 15 }, streets: [[]] }, "BB")).toBe(0);
    expect(heroPreloadAtNode({ preload: { BB: 15 }, streets: [[], []] }, "BB")).toBe(0);   // a later street: no preload
    expect(heroPreloadAtNode({ preload: { BB: 15 }, streets: [[]] }, null)).toBe(0);
  });

  test("a label the betsize does not end (a name with its own number) keeps its label; the betsize is still the table's", () => {
    const out = tableTotalActions([{ action: "Raise 2.5", frequency: 1, betsize: "6" }], 4);
    expect(out[0]).toMatchObject({ action: "Raise 2.5", betsize: "10", treeBetsize: "6" });
  });
});
