import { describe, expect, it } from "bun:test";
import { dealtSeats, dealtCount } from "./dealtSeats";
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

const a = (seatId: number, type: string, amount?: number, hero = false) =>
  ({ seatId, hero, type, street: "preflop", ...(amount != null ? { amount } : {}) }) as ParsedHand["actions"][number];
// harness seed 1 [undealt-seat]: four labels, the CO sitting out (no action, not in liveSeats) — three players dealt
const hand = (o: Partial<ParsedHand> = {}): ParsedHand => ({
  handId: 1, clientHandId: "t", heroSeatId: 4, heroCards: ["Ah", "Kd"], board: [], street: "preflop",
  actions: [a(5, "post-sb", 0.5), a(6, "post-bb", 1)], liveSeats: [4, 5, 6], committed: {}, potByStreet: {},
  positions: { 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
  currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 1.5, toCall: 1, legalActions: [], complete: false }, ended: false,
  ...o,
}) as ParsedHand;

describe("dealtSeats", () => {
  it("a labelled seat missing from liveSeats with no action was not dealt", () => {
    expect([...dealtSeats(hand()).values()].sort()).toEqual(["BB", "BTN", "SB"]);
    expect(dealtCount(hand())).toBe(3);
  });
  it("a seat that acted was dealt, whatever liveSeats says (sources that send only unfolded seats)", () => {
    const h = hand({ liveSeats: [4, 5, 6], actions: [a(5, "post-sb", 0.5), a(6, "post-bb", 1), a(3, "fold")] });
    expect(dealtCount(h)).toBe(4);
  });
  it("no liveSeats at all: every label counts; hero always counts", () => {
    expect(dealtCount(hand({ liveSeats: [] }))).toBe(4);
    expect(dealtCount(hand({ positions: { 3: "CO", 5: "SB", 6: "BB" } }), "BTN")).toBe(3);
  });
});
