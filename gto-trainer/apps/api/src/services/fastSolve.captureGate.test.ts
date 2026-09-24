/**
 * THE CAPTURE GATE (2026-09-23): the refusals every piece shares, checked before any piece sees the hand.
 * Pure functions, so no chart DB and no GTO Wizard are touched. The three classes and their evidence hands
 * are in fastSolve.ts above `unsolvableCapture`.
 */
import { describe, expect, test } from "bun:test";
import { preflopCaptureFaults, unsolvableCapture, zeroMixReason } from "./fastSolve";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";

const act = (seatId: number, type: string, street: string, amount?: number): ParsedAction =>
  ({ seatId, hero: false, type, street, ...(amount != null ? { amount } : {}) }) as ParsedAction;

const hand = (over: Partial<ParsedHand> & { positions?: Record<number, string> } = {}): ParsedHand => ({
  handId: 1, heroSeatId: 2, heroCards: ["Ah", "Kd"], board: [], street: "preflop",
  actions: [act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1)],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" },
  currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 1.5, toCall: 0, legalActions: [], complete: false },
  ended: false,
  ...over,
} as ParsedHand);

describe("unsolvableCapture", () => {
  test("a clean preflop hand passes", () => {
    expect(unsolvableCapture(hand())).toBeNull();
  });

  test("EH-9: no hero cards is refused with kind no-hero-cards", () => {
    const r = unsolvableCapture(hand({ heroCards: [] }));
    expect(r && !r.ok && r.kind).toBe("no-hero-cards");
    const r2 = unsolvableCapture(hand({ heroCards: ["Ah"] }));
    expect(r2 && !r2.ok && r2.kind).toBe("no-hero-cards");
  });

  test("EIP-01: a one-card board (missed flop frame) is refused with kind board-incomplete", () => {
    const r = unsolvableCapture(hand({ board: ["3c"], street: "preflop" }));
    expect(r && !r.ok && r.kind).toBe("board-incomplete");
    expect(r && !r.ok && r.reason).toContain("3c");
  });

  test("EIP-01: a board that disagrees with the decision street is refused", () => {
    const flopNode = { street: "flop", toActSeatId: 2, toActIsHero: true, pot: 5, toCall: 0, legalActions: [], complete: false } as ParsedHand["currentNode"];
    const r = unsolvableCapture(hand({ board: ["3c", "7d", "Ts", "2h"], street: "turn", currentNode: flopNode }));
    expect(r && !r.ok && r.kind).toBe("board-incomplete");
    // and a full, agreeing board passes
    const turnNode = { ...flopNode, street: "turn" } as ParsedHand["currentNode"];
    expect(unsolvableCapture(hand({ board: ["3c", "7d", "Ts", "2h"], street: "turn", currentNode: turnNode }))).toBeNull();
  });

  // 2026-09-24, stress multi-07: hero AhTh on Th6d3sQc2h reached the AI chain and came back all zeros.
  test("a hero card that is also on the board is refused as a capture fault", () => {
    const riverNode = { street: "river", toActSeatId: 2, toActIsHero: true, pot: 30, toCall: 12, legalActions: [], complete: false } as ParsedHand["currentNode"];
    const r = unsolvableCapture(hand({ heroCards: ["Ah", "Th"], board: ["Th", "6d", "3s", "Qc", "2h"], street: "river", currentNode: riverNode }));
    expect(r && !r.ok && r.kind).toBe("capture-fault");
    expect(r && !r.ok && r.reason).toContain("hero holds Th and Th is on the board");
    expect(r && !r.ok && r.reason).toContain("internally inconsistent");
    // the same hand with a card the board does not hold passes
    expect(unsolvableCapture(hand({ heroCards: ["Ad", "Td"], board: ["Th", "6d", "3s", "Qc", "2h"], street: "river", currentNode: riverNode }))).toBeNull();
  });

  test("a board that repeats a card is refused as a capture fault; card case does not hide it", () => {
    const flopNode = { street: "flop", toActSeatId: 2, toActIsHero: true, pot: 5, toCall: 0, legalActions: [], complete: false } as ParsedHand["currentNode"];
    const r = unsolvableCapture(hand({ heroCards: ["Ah", "Kd"], board: ["7c", "7C", "2h"], street: "flop", currentNode: flopNode }));
    expect(r && !r.ok && r.kind).toBe("capture-fault");
    expect(r && !r.ok && r.reason).toContain("7c appears twice on the board");
  });
});

describe("zeroMixReason", () => {
  const base = { heroCards: ["Ah", "Th"], board: ["Th", "6d", "3s", "Qc", "2h"], heroPos: "BTN", nodePos: "BTN",
    heroClass: "ATs", arrivalWeight: 0.6, plan: "last-resort:hero vs BB", actions: ["FOLD", "CALL 12", "RAISE 30.8", "ALLIN 92.5"] };

  test("a hero card on the board is named first", () => {
    const why = zeroMixReason(base);
    expect(why).toContain("AhTh has every action at 0% over FOLD/CALL 12/RAISE 30.8/ALLIN 92.5 (last-resort:hero vs BB)");
    expect(why).toContain("Th is on the board Th 6d 3s Qc 2h");
    expect(why).toContain("internally inconsistent");
  });

  test("a node that belongs to another seat says so", () => {
    const why = zeroMixReason({ ...base, heroCards: ["Ad", "Td"], nodePos: "BB" });
    expect(why).toContain("the node read is BB's, not hero's (BTN)");
  });

  test("heads-up, the tree's SB is the table's BTN — not another seat", () => {
    const why = zeroMixReason({ ...base, heroCards: ["Ad", "Td"], nodePos: "SB", hu: true });
    expect(why).not.toContain("another seat");
    // and six-handed the same pair IS a mismatch
    expect(zeroMixReason({ ...base, heroCards: ["Ad", "Td"], nodePos: "SB" })).toContain("another seat");
  });

  test("a class with no arrival weight is a not-in-range refusal the answer log can classify", () => {
    const why = zeroMixReason({ ...base, heroCards: ["Ad", "Td"], arrivalWeight: 0 });
    expect(why).toContain("ATs carries no weight in BTN's arrival range");
    expect(why.toLowerCase()).toContain("not in range");
  });

  test("nothing recognisable reports the facts and points at the trace", () => {
    const why = zeroMixReason({ ...base, heroCards: ["Ad", "Td"], plan: null, actions: [] });
    expect(why).toContain("AdTd has every action at 0% although the class is floored in BTN's entering range (arrival weight 0.6)");
    expect(why).toContain("trace");
  });
});

describe("preflopCaptureFaults", () => {
  test("names the faults captureFaults finds (a non-BB preflop check)", () => {
    const h = hand({ actions: [act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(6, "check", "preflop")] });
    expect(preflopCaptureFaults(h).some((f) => f.includes("checked preflop"))).toBe(true);
  });

  test("heads-up: the dealer posting the small blind is the table's normal shape, not a fault", () => {
    const h = hand({ positions: { 6: "BTN", 2: "BB" }, liveSeats: [2, 6],
      actions: [act(6, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(6, "raise", "preflop", 2.5)] });
    expect(preflopCaptureFaults(h)).toEqual([]);
  });

  test("a dead-small-blind hand as the wrapper now labels it (BB, mids, BTN) is not a fault", () => {
    const h = hand({ positions: { 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, liveSeats: [2, 3, 4, 5, 6],
      actions: [act(2, "post-bb", "preflop", 1), act(3, "fold", "preflop"), act(4, "fold", "preflop"), act(5, "fold", "preflop"), act(6, "raise", "preflop", 2.5)] });
    expect(preflopCaptureFaults(h)).toEqual([]);
  });
});
