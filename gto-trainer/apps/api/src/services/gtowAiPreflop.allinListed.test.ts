import { describe, expect, it } from "bun:test";
import { debugTree, seatAllInsPreflop } from "./gtowAiPreflop";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";

/**
 * THE PREFLOP TREE: SETTINGS OFF, EACH SEAT'S ALL-IN LISTED (2026-10-03). allin_threshold 60 replaced a raise of 60%+
 * of the stack by the all-in (a 17.5 3-bet from a 28.5 stack was only ever the all-in); allin_if_less_than 500 left
 * the open-jam out at 20-30bb (an all-in past 5x the pot). Both off, the all-in is listed in every list of every seat.
 * Shape probed on two trees from the solve cache (audits/postflop-allin-fix-2026-10/probe4a.out, probe4b.out).
 */
// three-handed at 21 / 30 / 109.5 (the probed tree's stacks): BTN (hero) to open
const RAW = {
  handId: 1, clientHandId: "4999000777", bbCents: 5, heroSeatId: 1, heroCards: ["A♣", "Q♣"], board: [], street: "preflop",
  liveSeats: [1, 2, 3], committed: { 2: 0.4, 3: 1 }, potByStreet: {},
  positions: { 1: "BTN", 2: "SB", 3: "BB" }, stacks: { 1: 109.5, 2: 20.6, 3: 29 }, startStacks: { 1: 109.5, 2: 21, 3: 30 },
  currentNode: { street: "preflop", toActSeatId: 1, toActIsHero: true, pot: 1.4, toCall: 1, legalActions: [], complete: false },
  actions: [
    { seatId: 2, hero: false, type: "post-sb", street: "preflop", amount: 0.4 },
    { seatId: 3, hero: false, type: "post-bb", street: "preflop", amount: 1 },
  ],
  heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$0.03/$0.05",
};

describe("the preflop tree request (items 4, 8)", () => {
  const t = debugTree(normalizeHand(RAW as any).hand!, "BTN");
  if ("error" in t) throw new Error(t.error);
  it("the all-in settings off, no merging", () => {
    expect(t.body.bet_sizes).toMatchObject({ allin_threshold: 100, allin_if_less_than: 0, merge_sizes_threshold: 0 });
  });
  it("every list of every seat ends with that seat's all-in (its stack, capped at the deepest other)", () => {
    const ai = seatAllInsPreflop(t.shape);
    for (const p of t.body.bet_sizes.street_bet_sizes[0].position_bet_sizes) {
      for (const k of ["bet_sizes", "raise_sizes", "second_raise_sizes", "third_plus_raise_sizes"]) {
        expect(p[k].at(-1)).toBe(`${ai[p.position]}bb`);
      }
    }
    // the short SB can open-jam 21 (he could not before: an all-in past 5x the pot was left out)
    expect(Object.values(ai).sort((a, b) => a - b)).toEqual([21, 30, 30]);
  });
});

describe("the dead-SB ghost is not a seat for the all-in", () => {
  it("its lists stay empty and its stack never caps another seat's all-in", () => {
    const ai = seatAllInsPreflop({ positions: ["BTN", "SB", "BB"], stacks: { BTN: 40, SB: 100, BB: 25 }, deadSb: true } as any);
    expect(ai).toEqual({ BTN: 25, BB: 25 });
  });
});
