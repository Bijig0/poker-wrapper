import { describe, expect, it } from "bun:test";
import { cameInLimping, classesToCombos, combosToClasses, normalised, normalisedCombos, planReducedArrival, type ReducedCaller } from "./reducedArrival";
import { COMBOS } from "../comboIndex/comboIndex";
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE REDUCED TREE's plan and read (2026-10-01, hand 4921846667 — see reducedArrival.ts). The fixtures are that hand
 * and its neighbours: the same table with the BB calling too, the limper as the re-raiser (the raiser out of
 * position), four to the flop, a short caller all in, and the lines that have no reduced tree.
 */

const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as const;
const a = (type: string, seatId: number, amount?: number, street = "preflop") =>
  ({ seatId, hero: seatId === 2, type, street, ...(amount != null ? { amount } : {}) });
const hand = (actions: any[], extra: Partial<ParsedHand> = {}): ParsedHand => ({
  handId: 66, clientHandId: "4921846667", bbCents: 5, heroSeatId: 2, heroCards: ["7s", "7c"], board: ["Ks", "9s", "Qd"], street: "flop",
  actions, liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { ...POS },
  stacks: { 1: 73.9, 2: 135.9, 3: 95.5, 4: 28.5, 5: 112.1, 6: 50.5 },
  currentNode: { street: "flop", toActSeatId: 2, toActIsHero: true, pot: 78.2, toCall: 32.6, legalActions: [], complete: false }, ended: false,
  ...extra,
} as unknown as ParsedHand);

const OPENING = [a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("call", 1, 1), a("call", 2, 1), a("raise", 3, 5), a("fold", 4), a("fold", 5)];
/** the hand as played: BB and UTG call the iso, hero limp-reraises to 17.6, CO and BB fold, UTG calls */
const REAL = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("fold", 6), a("call", 1, 12.6), a("bet", 1, 32.6, "flop")]);
/** the BB calls the limp-reraise too: three to the flop */
const THREE = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("call", 6, 12.6), a("call", 1, 12.6)]);
/** UTG is the limp-reraiser, hero calls: the raiser is out of position */
const UTG_RERAISES = hand([...OPENING, a("fold", 6), a("raise", 1, 17.6), a("call", 2, 16.6), a("fold", 3)]);
/** UTG limp-reraises, hero and then the BB call */
const MIDDLE = hand([...OPENING, a("call", 6, 4), a("raise", 1, 17.6), a("call", 2, 16.6), a("fold", 3), a("call", 6, 12.6)]);
/** four to the flop: the CO, the BB and UTG all call hero's limp-reraise */
const FOUR = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("call", 3, 12.6), a("call", 6, 12.6), a("call", 1, 12.6)]);

const plan = (h: ParsedHand) => {
  const p = planReducedArrival(h, "HJ");
  if (!p.ok) throw new Error(p.reason);
  return p;
};
const brief = (c: ReducedCaller) => `${c.pos}: had ${c.prior} in, ${c.toCall} to call into ${c.potBefore}`;

describe("planReducedArrival", () => {
  it("the hand as played: hero raised to 17.6 with 1 in; UTG had 5 in and met it for 12.6 into 33, 10.4 of it dead", () => {
    const p = plan(REAL);
    expect(p.live).toEqual(["UTG", "HJ"]);                    // postflop order: UTG acts first
    expect(p.potBb).toBe(45.6);
    expect(p.raiser).toEqual({ seat: 2, pos: "HJ", putIn: 17.6, prior: 1 });
    expect(p.raiseTo).toBe(17.6);
    expect(REAL.actions[p.raiseIndex]).toMatchObject({ type: "raise", seatId: 2 });
    expect(p.callers.map(brief)).toEqual(["UTG: had 5 in, 12.6 to call into 33"]);
    // the pot once he calls is the table's flop pot
    const c = p.callers[0]!;
    expect(c.potBefore + c.toCall).toBeCloseTo(p.potBb, 5);
  });

  it("the raiser out of position: the caller is the tree's SB (in position) and acts at its root", () => {
    const p = plan(UTG_RERAISES);
    expect(p.raiser).toMatchObject({ pos: "UTG", prior: 1, putIn: 17.6 });
    expect(p.callers.map(brief)).toEqual(["HJ: had 1 in, 16.6 to call into 25"]);
  });

  it("three to the flop: each caller at his own price — a later caller's pot holds the earlier caller's chips", () => {
    const p = plan(THREE);
    expect(p.live).toEqual(["BB", "UTG", "HJ"]);
    expect(p.callers.map(brief)).toEqual([
      "BB: had 5 in, 12.6 to call into 33",
      "UTG: had 5 in, 12.6 to call into 45.6",
    ]);
    expect(p.potBb).toBe(58.2);
  });

  it("the raiser between two callers: each caller seated by HIS position against the raiser", () => {
    const p = plan(MIDDLE);
    expect(p.raiser.pos).toBe("UTG");
    expect(p.callers.map(brief)).toEqual([
      "BB: had 5 in, 12.6 to call into 45.6",      // called second, after hero
      "HJ: had 1 in, 16.6 to call into 29",
    ]);
  });

  it("four to the flop: three callers, every live seat accounted for", () => {
    const p = plan(FOUR);
    expect(p.live).toEqual(["BB", "UTG", "HJ", "CO"]);
    expect([p.raiser.pos, ...p.callers.map((c) => c.pos)].sort()).toEqual([...p.live].sort());
    expect(p.callers.map(brief)).toEqual([
      "BB: had 5 in, 12.6 to call into 45.6",
      "UTG: had 5 in, 12.6 to call into 58.2",
      "CO: had 5 in, 12.6 to call into 33",   // the CO called first
    ]);
  });

  it("a caller all in for less: what the call cost him is what he had left, the pot he met is the same", () => {
    const short = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("fold", 6), a("all-in", 1, 12)]);
    const p = plan(short);
    expect(REAL.actions[p.raiseIndex]).toMatchObject({ seatId: 2 });        // the all-in for less than the price is a call, not the last raise
    expect(p.callers.map(brief)).toEqual(["UTG: had 5 in, 7 to call into 33"]);
  });

  it("a raiser with nothing in before his raise; a caller with nothing in yet", () => {
    // UTG opens, hero calls, the BTN squeezes to 11 (his first chip), both call
    const squeeze = plan(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("raise", 1, 2.5), a("call", 2, 2.5), a("fold", 3), a("raise", 4, 11), a("fold", 5), a("fold", 6), a("call", 1, 8.5), a("call", 2, 8.5)]));
    expect(squeeze.raiser).toMatchObject({ pos: "BTN", prior: 0, putIn: 11 });
    expect(squeeze.callers.map((c) => `${c.pos}:${c.prior}`)).toEqual(["UTG:2.5", "HJ:2.5"]);
    // UTG opens, hero 3-bets to 9, the CO cold-calls with nothing in, UTG calls
    const cold = plan(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("raise", 1, 2.5), a("raise", 2, 9), a("call", 3, 9), a("fold", 4), a("fold", 5), a("fold", 6), a("call", 1, 6.5)]));
    expect(cold.callers.map(brief)).toEqual([
      "UTG: had 2.5 in, 6.5 to call into 21.9",
      "CO: had 0 in, 9 to call into 12.9",
    ]);
    // a blind who had only his blind in
    const bb = plan(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("raise", 1, 2.5), a("fold", 2), a("fold", 3), a("raise", 4, 9), a("fold", 5), a("call", 6, 8), a("call", 1, 6.5)]));
    expect(bb.callers.map(brief)[0]).toBe("BB: had 1 in, 8 to call into 12.9");
  });

  it("has no reduced tree: a limped pot, one player left, a raiser who is not there", () => {
    const limped = planReducedArrival(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("call", 1, 1), a("call", 2, 1), a("fold", 3), a("fold", 4), a("call", 5, 0.6), a("check", 6)]), "HJ");
    expect(limped.ok).toBe(false);
    if (!limped.ok) expect(limped.reason).toContain("nobody raised");
    const walk = planReducedArrival(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("raise", 2, 2.5), a("fold", 1), a("fold", 3), a("fold", 4), a("fold", 5), a("fold", 6)]), "HJ");
    expect(walk.ok).toBe(false);
  });
});

describe("cameInLimping", () => {
  it("a first chip that is a call with no raise ahead of it — the SB's complete too; not a cold-call, a raise, a blind", () => {
    expect(cameInLimping(REAL, 1, REAL.actions.length)).toBe(true);           // UTG limped, then called the iso and the re-raise
    expect(cameInLimping(REAL, 2, REAL.actions.length)).toBe(true);           // hero over-limped
    expect(cameInLimping(REAL, 6, REAL.actions.length)).toBe(false);          // the BB's first chip after his blind is the call of the iso
    expect(cameInLimping(REAL, 3, REAL.actions.length)).toBe(false);          // the iso-raiser
    const sbComplete = hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("call", 1, 1), a("fold", 2), a("fold", 3), a("fold", 4), a("call", 5, 0.6), a("raise", 6, 5), a("call", 1, 4), a("call", 5, 4)]);
    expect(cameInLimping(sbComplete, 5, sbComplete.actions.length)).toBe(true);
    const cold = hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("raise", 1, 2.5), a("call", 2, 2.5), a("fold", 3), a("fold", 4), a("fold", 5), a("call", 6, 1.5)]);
    expect(cameInLimping(cold, 2, cold.actions.length)).toBe(false);
    // only what happened before `upto` counts: before his limp he has not come in at all
    expect(cameInLimping(REAL, 1, 2)).toBe(false);
  });
});
describe("range helpers", () => {
  it("normalised: the heaviest class becomes 1, the composition is kept, zeros dropped", () => {
    expect(normalised({ AQs: 0.2545, "77": 0.1798, "72o": 0 })).toEqual({ AQs: 1, "77": 0.7065 });
    expect(normalised({})).toEqual({});
  });
  it("classesToCombos / combosToClasses / normalisedCombos", () => {
    const w = classesToCombos({ "77": 0.5 })!;
    expect(w.length).toBe(1326);
    expect(w.filter((x) => x > 0).length).toBe(6);
    expect(w.every((x, i) => (COMBOS[i]!.cls === "77" ? x === 0.5 : x === 0))).toBe(true);
    expect(classesToCombos(null)).toBeNull();
    expect(classesToCombos({ "77": 0 })).toBeNull();
    expect(combosToClasses(w)).toEqual({ "77": 0.5 });
    expect(normalisedCombos(w)!.filter((x) => x === 1).length).toBe(6);
    expect(normalisedCombos(new Array(1326).fill(0))).toBeNull();
  });
});
