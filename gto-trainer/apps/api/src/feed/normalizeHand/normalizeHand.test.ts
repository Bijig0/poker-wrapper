import { describe, expect, it } from "bun:test";
import { normalizeHand } from "./normalizeHand";
import { parsePanelFeed, renderPanelRows } from "../parsePanelFeed/parsePanelFeed";
import { handToSpot } from "../handToSpot/handToSpot";

/** The full Hand shape, exactly as assistive-play's /state would send it. */
const FULL_HAND = {
  handId: 7,
  heroSeatId: 4,
  heroCards: ["As", "5c"],
  board: ["Ad", "7c", "2h"],
  street: "flop",
  actions: [
    { seatId: 4, hero: true, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 5, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 0, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 4, hero: true, type: "call", amount: 2.5, street: "preflop" },
    { seatId: 5, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "bet", amount: 3, street: "flop" },
  ],
  liveSeats: [2, 4],
  committed: {},
  potByStreet: { flop: 6 },
  positions: { 0: "UTG", 2: "HJ", 4: "SB", 5: "BB" },
  currentNode: {
    street: "flop",
    toActSeatId: 4,
    toActIsHero: true,
    pot: 9,
    toCall: 3,
    legalActions: ["fold", "call", "raise"],
    complete: false,
  },
  ended: false,
};

describe("normalizeHand", () => {
  it("accepts the full /state Hand shape unchanged", () => {
    const { hand, warnings } = normalizeHand(FULL_HAND);
    expect(warnings).toEqual([]);
    expect(hand.heroCards).toEqual(["As", "5c"]);
    expect(hand.actions).toHaveLength(7);
    expect(hand.currentNode.toActIsHero).toBe(true);
  });

  it("maps a Hand-shaped node onto the same spot as the equivalent feed rows", () => {
    const fromHand = handToSpot(normalizeHand(FULL_HAND).hand);
    const fromRows = handToSpot(
      parsePanelFeed(renderPanelRows(normalizeHand(FULL_HAND).hand)).hand!
    );
    expect(fromHand.ok).toBe(true);
    expect(fromRows.ok).toBe(true);
    if (!fromHand.ok || !fromRows.ok) return;
    // Hand JSON in, feed rows in — identical node out. That's the proof.
    expect(fromHand.spot).toEqual(fromRows.spot);
    expect(fromHand.spot).toMatchObject({
      heroSeat: "SB",
      villainSeat: "HJ",
      potType: "SRP",
      board: "Ad 7c 2h",
      heroHand: "As5c",
      villainBetPct: 50,
      toAct: "hero",
    });
  });

  it("forgives omitted bookkeeping and normalizes card spellings", () => {
    const { hand, warnings } = normalizeHand({
      heroCards: ["A♠", "5c"],
      board: ["ad", "7♣", "2h"],
      actions: [
        { hero: true, type: "post-sb", amount: 0.5 },
        { seatId: 2, type: "raise", amount: 2.5 },
        { hero: true, type: "call", amount: 2.5 },
      ],
      positions: { 2: "HJ" },
      currentNode: { toActIsHero: true, pot: 6 },
    });
    expect(hand.heroCards).toEqual(["As", "5c"]);
    expect(hand.board).toEqual(["Ad", "7c", "2h"]);
    expect(hand.street).toBe("flop"); // derived from 3 board cards
    expect(hand.heroSeatId).toBe(-1);
    expect(hand.actions[0]).toMatchObject({ seatId: -1, hero: true, street: "preflop" });
    expect(hand.ended).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("round-trips a normalized hand through the feed renderer", () => {
    const { hand } = normalizeHand(FULL_HAND);
    const rows = renderPanelRows(hand);
    const { hand: reparsed, warnings } = parsePanelFeed(rows);
    expect(warnings).toEqual([]);
    expect(renderPanelRows(reparsed)).toEqual(rows);
  });

  it("passes stacks through for depth derivation", () => {
    const { hand } = normalizeHand({ ...FULL_HAND, stacks: { 2: 148.5, 4: 97 } });
    expect(hand.stacks).toEqual({ 2: 148.5, 4: 97 });
    expect(() => normalizeHand({ ...FULL_HAND, stacks: { 2: "deep" } })).toThrow(/stacks has an invalid entry/);
  });

  it("passes the stacks as dealt through, and drops the legacy CoinPoker name → money map whole", () => {
    expect(normalizeHand({ ...FULL_HAND, startStacks: { 2: 150, 4: 100.5 } }).hand.startStacks).toEqual({ 2: 150, 4: 100.5 });
    // a CoinPoker row archived before 2026-09-24: player NAME → table money — never read as seats, even a numeric name
    expect(normalizeHand({ ...FULL_HAND, startStacks: { megturism0: 20.5, "4": 18 } }).hand.startStacks).toBeUndefined();
    // a malformed entry of a seat map is dropped alone, never failing a hand that is otherwise fine
    expect(normalizeHand({ ...FULL_HAND, startStacks: { 2: "x", 4: 99 } }).hand.startStacks).toEqual({ 4: 99 });
  });

  it("rejects garbage with precise messages", () => {
    expect(() => normalizeHand("nope")).toThrow(/JSON object/);
    expect(() => normalizeHand({ actions: [{ type: "yolo" }] })).toThrow(/actions\[0\]\.type/);
    expect(() => normalizeHand({ actions: [{ type: "fold" }] })).toThrow(/seatId is required/);
    expect(() => normalizeHand({ board: "AdKc2h" })).toThrow(/array of card strings/);
    expect(() => normalizeHand({ street: "turnpike" })).toThrow(/street must be one of/);
  });
});
