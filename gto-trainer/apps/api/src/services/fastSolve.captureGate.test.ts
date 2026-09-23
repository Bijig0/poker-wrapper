/**
 * THE CAPTURE GATE (2026-09-23): the refusals every piece shares, checked before any piece sees the hand.
 * Pure functions, so no chart DB and no GTO Wizard are touched. The three classes and their evidence hands
 * are in fastSolve.ts above `unsolvableCapture`.
 */
import { describe, expect, test } from "bun:test";
import { preflopCaptureFaults, unsolvableCapture } from "./fastSolve";
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
