import { describe, expect, it } from "bun:test";
import { positionsFor, tickToHand, type Tick } from "./tickToHand";

/**
 * Fixtures are real states from session_20260807_115240, the first recording
 * carrying hero's seat. Both are checkable against the recorded FRAME, which
 * is the point: the button this derives is drawn on screen, and the amount it
 * computes for hero to call is printed on hero's own call button.
 */

/** Hand 6, seq 188: hero (seat 4) in the BB facing a 2.4 BB open from seat 1. */
const HAND_6: Tick = {
  seq: 188,
  hand: 6,
  pot: "3.8 BB",
  board: [],
  heroCards: ["3♦", "4♠"],
  toAct: true,
  seats: {
    "1": { stack: "194.2 BB", bet: "2.4 BB", badge: null, cards: 2 },
    "2": { stack: "100 BB", bet: null, badge: "FOLD", cards: 0 },
    "3": { stack: "214.4 BB", bet: "0.4 BB", badge: "POST-SB", cards: 2 },
    "4": { stack: "99 BB", bet: "1 BB", badge: null, cards: 2, hero: true },
    "5": { stack: "49.6 BB", bet: null, badge: null, cards: 0 },
    "6": { stack: "287.4 BB", bet: null, badge: "FOLD", cards: 0 },
  },
  actions: ["FOLD", "CALL 1.4 BB", "RAISE TO 3.8 BB"],
  feedTail: [
    "───── new hand ─────",
    "(hand id 4909417880)",
    "Seat 3 posts small blind (0.4 BB)",
    "Seat 4 posts big blind (1 BB)",
    "Your hand: High card, four",
    "Seat 5 folds",
    "Seat 6 folds",
    "Seat 1 raises to 2.4 BB",
    "Seat 2 folds",
    "Seat 3 folds",
    "YOUR TURN: FOLD / CALL 1.4 BB / RAISE TO 3.8 BB",
  ],
};

describe("positionsFor", () => {
  it("names the ring from the button, as the wrapper does", () => {
    expect(positionsFor([1, 2, 3, 4, 5, 6], 2)).toEqual({
      3: "SB", 4: "BB", 5: "UTG", 6: "HJ", 1: "CO", 2: "BTN",
    });
  });

  it("is heads-up when two are dealt: the button is the small blind", () => {
    expect(positionsFor([1, 4], 1)).toEqual({ 1: "SB", 4: "BB" });
  });

  it("is BTN/SB/BB three-handed", () => {
    expect(positionsFor([2, 5, 6], 6)).toEqual({ 2: "SB", 5: "BB", 6: "BTN" });
  });
});

describe("tickToHand", () => {
  it("derives the button the reader cannot see, from the small blind post", () => {
    const { hand, buttonSeat } = tickToHand(HAND_6);
    // The recorded frame draws the D on seat 2. Nothing in the tick says so —
    // this comes from the SB being seat 3 and the button preceding it.
    expect(buttonSeat).toBe(2);
    expect(hand!.positions[4]).toBe("BB"); // hero
    expect(hand!.positions[1]).toBe("CO"); // the opener
  });

  it("computes the amount hero owes, matching the client's own call button", () => {
    const { hand } = tickToHand(HAND_6);
    // The client offered "CALL 1.4 BB": a 2.4 BB open against hero's 1 BB post.
    expect(hand!.currentNode.toCall).toBeCloseTo(1.4, 5);
    expect(hand!.currentNode.toActIsHero).toBe(true);
    expect(hand!.currentNode.pot).toBeCloseTo(3.8, 5);
  });

  it("reads hero, cards, stacks and who is still live", () => {
    const { hand } = tickToHand(HAND_6);
    expect(hand!.heroSeatId).toBe(4);
    expect(hand!.heroCards).toEqual(["3d", "4s"]);
    expect(hand!.stacks![4]).toBe(99);
    expect(hand!.liveSeats).toEqual([1, 4]); // 2, 3, 5, 6 folded
    expect(hand!.street).toBe("preflop");
  });

  it("records calls as increments and raises as totals", () => {
    const { hand } = tickToHand({
      ...HAND_6,
      feedTail: [
        "───── new hand ─────",
        "Seat 6 posts small blind (0.4 BB)",
        "Seat 1 posts big blind (1 BB)",
        "Seat 2 raises to 2.2 BB",
        "Seat 1 calls 1.2 BB",
      ],
    });
    // Seat 1 posted 1 and added 1.2; both seats have 2.2 in front, so the
    // action is square and nobody owes anything.
    expect(hand!.committed[1]).toBeCloseTo(2.2, 5);
    expect(hand!.committed[2]).toBeCloseTo(2.2, 5);
  });

  it("resets commitment across a street, so toCall is street-local", () => {
    const { hand } = tickToHand({
      ...HAND_6,
      board: ["2♦", "3♠", "A♦"],
      toAct: true,
      feedTail: [
        "───── new hand ─────",
        "Seat 6 posts small blind (0.4 BB)",
        "Seat 4 posts big blind (1 BB)",
        "Seat 2 raises to 2.2 BB",
        "Seat 4 calls 1.2 BB",
        "— FLOP — 2♦ 3♠ A♦ — pot 4.8 BB",
        "Seat 4 checks",
        "Seat 2 bets 1.6 BB",
      ],
    });
    expect(hand!.street).toBe("flop");
    expect(hand!.currentNode.toCall).toBeCloseTo(1.6, 5); // not 1.6 + preflop
  });

  it("drops the previous hand's tail, which would move the blinds", () => {
    const { hand, buttonSeat } = tickToHand({
      ...HAND_6,
      feedTail: [
        // The rolling feed opens mid-way through the hand BEFORE this one.
        "Seat 3 raises to 0.32 BB",
        "Seat 5 folds",
        ...HAND_6.feedTail!,
      ],
    });
    // Same answer as the clean feed: the stale lines change nothing.
    expect(buttonSeat).toBe(2);
    expect(hand!.positions[4]).toBe("BB");
    expect(hand!.actions[0]).toMatchObject({ seatId: 3, type: "post-sb" });
    expect(hand!.currentNode.toCall).toBeCloseTo(1.4, 5);
  });

  it("refuses to build a hand when hero's seat was never recorded", () => {
    const noHero = { ...HAND_6, seats: { ...HAND_6.seats } };
    delete (noHero.seats as any)["4"].hero;
    const { hand, notes } = tickToHand(noHero as Tick);
    // Guessing hero is exactly what produced a table drawn round the wrong
    // seat; an unbuildable hand that says why is the honest outcome.
    expect(hand).toBeNull();
    expect(notes[0]).toMatch(/predates/);
  });
});
