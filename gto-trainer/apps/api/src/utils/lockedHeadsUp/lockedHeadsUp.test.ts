import { describe, expect, it } from "bun:test";
import { allInListing, planLockedHeadsUp, raiseListings, type LockedPlan } from "./lockedHeadsUp";
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

/** The locked heads-up tree's plan (utils/lockedHeadsUp): seating, posts, the pot hero is priced at, the shift. */
const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as const;
const SEAT = { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 } as const;
type P = keyof typeof SEAT;
const hand = (heroPos: P, acts: [P, string, number?][], stacks: Partial<Record<P, number>> = {}): ParsedHand => {
  const hero = SEAT[heroPos];
  const a = (pos: P, type: string, amount?: number) => ({ seatId: SEAT[pos], hero: SEAT[pos] === hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
  const st: Record<number, number> = {};
  for (const p of Object.keys(SEAT) as P[]) st[SEAT[p]] = stacks[p] ?? 100;
  return {
    handId: 1, clientHandId: "lock-plan", bbCents: 200, heroSeatId: hero, heroCards: ["Ah", "Kd"], board: [], street: "preflop",
    actions: [a("SB", "post-sb", 0.5), a("BB", "post-bb", 1), ...acts.map(([p, t, x]) => a(p, t, x))],
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { ...POS }, stacks: st,
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
};
const ok = (r: ReturnType<typeof planLockedHeadsUp>): LockedPlan => { if (!r.ok) throw new Error(r.reason); return r; };

describe("the locked heads-up tree's plan", () => {
  it("hand 4920545432: UTG opened, HJ 3-bet, two cold-callers — hero (OOP) is the tree's BB, the raiser locked at the root; the callers' chips are NOT dead, the folded blinds' are", () => {
    const p = ok(planLockedHeadsUp(hand("UTG", [["UTG", "raise", 2.6], ["HJ", "raise", 8.2], ["CO", "call", 8.2], ["BTN", "call", 8.2], ["SB", "fold"], ["BB", "fold"]]), "UTG"));
    expect(p).toMatchObject({ heroTree: "BB", raiserTree: "SB", heroFirst: false, heroIn: 2.6, raiserIn: 0, raiseTo: 8.2, raiseLevel: 2, shift: 0 });
    expect(p.posts).toEqual({ BB: 2.6, SB: 0.01 });                 // a raiser with nothing in posts a penny
    expect(p.deadBb).toBe(1.5);                                       // the folded blinds — not the callers' 16.4
    expect(p.pot).toBe(1.5);
    expect(p.livePos.sort()).toEqual(["BTN", "CO"]);
    expect(p.foldedPos.sort()).toEqual(["BB", "SB"]);
    expect(p.raiseToTree).toBe(8.2);
  });

  it("hero in position with nothing in (BTN over a CO open): hero first, both post 1 — the shift — the raise 1 higher, the pot 2 lower", () => {
    const p = ok(planLockedHeadsUp(hand("BTN", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5]]), "BTN"));
    expect(p).toMatchObject({ heroTree: "SB", raiserTree: "BB", heroFirst: true, heroIn: 0, shift: 1, raiseToTree: 3.5, unit: 1 });
    expect(p.posts).toEqual({ SB: 1, BB: 1 });                         // even posts: hero's call of nothing at the root
    expect(p.stacks).toEqual({ SB: 101, BB: 101 });
    expect(p.blindsBehindPos.sort()).toEqual(["BB", "SB"]);
    expect(p.deadBb).toBe(1.5);
    expect(p.pot).toBe(0);                                             // 1.5 dead − 2 × the shift
    expect(p.potOver).toBe(0.5);                                       // …the tree's pot is 0.5 bigger than the table's
  });

  it("the small blind over a button open: hero is OOP (the tree's BB), his 0.5 shifted to 1, the big blind behind is dead", () => {
    const p = ok(planLockedHeadsUp(hand("SB", [["UTG", "fold"], ["HJ", "fold"], ["CO", "fold"], ["BTN", "raise", 2.5]]), "SB"));
    expect(p).toMatchObject({ heroTree: "BB", raiserTree: "SB", heroFirst: false, heroIn: 0.5, shift: 0.5, raiseToTree: 3 });
    expect(p.posts).toEqual({ BB: 1, SB: 0.01 });
    expect(p.blindsBehindPos).toEqual(["BB"]);
    expect(p.pot).toBe(0);
    expect(p.potOver).toBe(0);
  });

  it("deep stacks: hero's post is at least the effective stack / 240 (GTO Wizard's 250bb limit counts in it)", () => {
    const p = ok(planLockedHeadsUp(hand("BB", [["UTG", "raise", 3], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]], { UTG: 400, BB: 400 }), "BB"));
    expect(p.posts.BB).toBeGreaterThanOrEqual(400 / 240);
    expect(p.raiseToTree - p.raiseTo).toBeCloseTo(p.shift, 6);
    expect(p.stacks.BB - 400).toBeCloseTo(p.shift, 6);
  });

  it("an all-in raise is marked, and `dead: false` empties the pot", () => {
    const p = ok(planLockedHeadsUp(hand("BB", [["UTG", "all-in", 22], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]], { UTG: 22 }), "BB", { dead: false }));
    expect(p.raiserAllIn).toBe(true);
    expect(p.pot).toBe(0);
    expect(p.deadBb).toBe(0.5);
  });

  it("refuses what it cannot price: nobody raised, hero's own raise last, hero acted since, hero first with less in than the raiser had", () => {
    expect(planLockedHeadsUp(hand("BB", [["UTG", "call", 1], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]]), "BB")).toMatchObject({ ok: false });
    expect(planLockedHeadsUp(hand("CO", [["UTG", "fold"], ["HJ", "raise", 2.5], ["CO", "raise", 8]]), "CO")).toMatchObject({ ok: false });
    expect(planLockedHeadsUp(hand("CO", [["UTG", "fold"], ["HJ", "raise", 2.5], ["CO", "call", 2.5], ["BTN", "fold"]]), "CO")).toMatchObject({ ok: false });
    // BB limps... SB completes 1, BB raises: hero SB is OOP — fine; hero BTN behind a limp-raiser with less in is refused
    const r = planLockedHeadsUp(hand("BTN", [["UTG", "call", 1], ["HJ", "fold"], ["CO", "fold"], ["BTN", "call", 1], ["SB", "fold"], ["BB", "check"], ["UTG", "raise", 5]]), "BTN");
    expect(r.ok).toBe(true);   // hero has 1 in, the raiser had 1: even
  });
});

describe("the sizes the raiser's node lists", () => {
  it("his raise in every reading GTO Wizard may give a size, and an all-in past any reading of the stack", () => {
    expect(raiseListings(3.85, 1)).toEqual(["3.85x", "3.85bb"]);
    expect(raiseListings(15.4, 3.7)).toEqual(["4.162x", "4.162bb", "15.4bb"]);   // a ratio is cut to three decimals
    expect(raiseListings(13, 2.6)).toEqual(["5x", "5bb", "13bb"]);
    expect(allInListing(100, 2.6)).toBe("101bb");
    expect(allInListing(58.65, 0.25)).toBe("236bb");
  });
});
