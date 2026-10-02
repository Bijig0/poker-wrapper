/**
 * THE POT ENTERING THE FLOP IS THE TABLE'S MONEY (2026-10-03, Brady): tableFlopPot — the preflop chips that can be
 * matched, plus what no action carries (a folded poster's dead post, the antes) — on every solve; the line's token
 * rebuild (preflopPotStack) only a cross-check. And each seat's flop stack is its dealt stack less its own preflop chips.
 */
import { describe, expect, it } from "bun:test";
import { flopSeatStacks, matchedRound, tableFlopPot } from "./fastSolve";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { preflopPotStack } from "../utils/aiStudyLine/aiStudyLine";

const A = (seatId: number, type: string, amount?: number, hero = false, street = "preflop") => ({ seatId, hero, type, street, ...(amount != null ? { amount } : {}) });
const base = (actions: any[], extra: any = {}) => normalizeHand({
  handId: 1, clientHandId: "4999000901", bbCents: 5, heroSeatId: 5, heroCards: ["A♦", "9♦"], board: ["5♦", "6♦", "5♥"], street: "flop",
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: { 1: "BB", 2: "UTG", 3: "HJ", 4: "CO", 5: "BTN", 6: "SB" },
  stacks: {}, startStacks: { 1: 30, 2: 55.6, 3: 17.4, 4: 120.6, 5: 146, 6: 137.2 },
  currentNode: { street: "flop", toActSeatId: 5, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false },
  heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$0.03/$0.05", actions, ...extra,
} as any).hand!;
const dealt = { 1: 30, 2: 55.6, 3: 17.4, 4: 120.6, 5: 146, 6: 137.2 };

describe("hand 4920416336 (NL5): the BB jams 30 over two limps, both call — a preflop all-in called, two players with chips on the flop", () => {
  const actions = [A(6, "post-sb", 0.4), A(1, "post-bb", 1), A(2, "call", 1), A(3, "fold"), A(4, "fold"), A(5, "call", 1, true), A(6, "fold"),
    A(1, "all-in", 30), A(2, "call", 29), A(5, "call", 29, true)];
  it("the table's 90.4 (the 0.4 small blind in it); the token rebuild says 90.5 — the table's is sent", () => {
    const t = tableFlopPot(base(actions), dealt);
    expect(t.pot).toBe(90.4);
    expect(t.returned).toEqual([]);
    // the cross-check's number: the rebuild prices the small blind at half a blind
    expect(preflopPotStack(["C", "F", "F", "C", "F", "RAI", "C", "C"], 146, ["UTG", "HJ", "CO", "BTN", "SB", "BB"], [30]).pot).toBe(90.5);
  });
});

describe("an uncalled excess is not in the pot (requirement a)", () => {
  it("the CO raises to 25, the BTN calls all-in for 8, the blinds fold: 17 goes back to the CO; the pot is 17.4", () => {
    const h = base([A(6, "post-sb", 0.4), A(1, "post-bb", 1), A(2, "fold"), A(3, "fold"), A(4, "raise", 25), A(5, "all-in", 8, true), A(6, "fold"), A(1, "fold")]);
    const t = tableFlopPot(h, { ...dealt, 5: 8 });
    expect(t.pot).toBe(17.4);
    expect(t.returned).toEqual([{ seat: 4, bb: 17 }]);
  });
  it("matchedRound: a bet called by a folded seat's chips and nobody else's stack is capped at the most anyone else can put in", () => {
    const m = new Map([[1, 10], [2, 4], [3, 2]]);
    expect(matchedRound(m, new Set([1, 2, 3]), new Set([3]), (s) => (s === 2 ? 4 : 100))).toEqual({ sum: 10, returned: [{ seat: 1, bb: 6 }] });
    // an opponent whose stack is unknown never lets an excess be taken off
    expect(matchedRound(m, new Set([1, 2, 3]), new Set([3]), () => null).returned).toEqual([]);
  });
});

describe("what roundContributions carries and what is added once (requirement b)", () => {
  it("a posted-in player who checks his option: his post rides on his limp (counted once, not as a dead post)", () => {
    const h = base([A(6, "post-sb", 0.4), A(1, "post-bb", 1), A(3, "post", 1), A(2, "fold"), A(3, "check"), A(4, "fold"), A(5, "call", 1, true), A(6, "fold"), A(1, "check")]);
    expect(h.postIns?.[0]?.readAs).toBe("limp");
    expect(tableFlopPot(h, dealt).pot).toBe(3.4);   // 0.4 + 1 + 1 (the post, as his limp) + 1
  });
  it("a posted-in player who folds: his post is dead money, added once by deadPostsBb (no action carries it)", () => {
    const h = base([A(6, "post-sb", 0.4), A(1, "post-bb", 1), A(3, "post", 1), A(2, "fold"), A(3, "fold"), A(4, "fold"), A(5, "raise", 2.5, true), A(6, "fold"), A(1, "call", 1.5)]);
    const t = tableFlopPot(h, dealt);
    expect(t.preflop).toBe(5.4);                    // 0.4 + 2.5 + 2.5
    expect(t.pot).toBe(6.4);                        // + the folded poster's 1
  });
  it("a returning player's live blind + dead small blind (one post of 1.4) who checks: 1.4 in the pot once", () => {
    const h = base([A(6, "post-sb", 0.4), A(1, "post-bb", 1), A(3, "post", 1.4), A(2, "fold"), A(3, "check"), A(4, "fold"), A(5, "call", 1, true), A(6, "fold"), A(1, "check")]);
    expect(tableFlopPot(h, dealt).pot).toBe(3.8);
  });
  it("no small blind posted (hands 4921628906, 4921650780): none in the pot", () => {
    const h = base([A(1, "post-bb", 1), A(2, "fold"), A(3, "fold"), A(4, "raise", 2.6), A(5, "fold", undefined, true), A(1, "call", 1.6)]);
    expect(tableFlopPot(h, dealt).pot).toBe(5.2);
  });
  it("antes are not actions: CoinPoker heads-up 2 x ante, a ring table the ante x the seats dealt, each added once", () => {
    const h = base([A(6, "post-sb", 0.5), A(1, "post-bb", 1), A(2, "fold"), A(3, "fold"), A(4, "fold"), A(5, "raise", 2.5, true), A(6, "fold"), A(1, "call", 1.5)]);
    expect(tableFlopPot(h, dealt).pot).toBe(5.5);
    expect(tableFlopPot(h, dealt, { anteRing: 0.6 }).pot).toBe(6.1);
    expect(tableFlopPot(h, dealt, { anteHu: 0.2 }).pot).toBe(5.9);
  });
});

describe("each seat's flop stack is its dealt stack less its own preflop chips (requirement c)", () => {
  it("a seat that limped 1 into a pot raised to 2.5 and called is at dealt − 2.5; the table's chips win over the token price", () => {
    const out = flopSeatStacks({ seats: ["BB", "BTN"], depth: 100, flopStack: 97.4 /* a token price of 2.6 */, dealtByPos: { BB: 30, BTN: 146 },
      streets: [[]], streetSeats: [[]], paidPre: { BB: 2.5, BTN: 2.5 } });
    expect(out).toEqual({ BB: 27.5, BTN: 143.5 });
  });
});
