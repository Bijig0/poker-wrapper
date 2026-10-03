import { describe, expect, it } from "bun:test";
import { dealtSeats, dealtCount, namesFromRoster, relabelDeadButton } from "./dealtSeats";
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

/**
 * THE NAMES THE SEATS DEALT GIVE (2026-10-04, the dead button): the table's geometry from the hand's seat roster —
 * clockwise from the first dealt seat after the button seat, dealt or not — named as the fixed wrapper names them.
 */
describe("namesFromRoster", () => {
  const withRoster = (dealer: number, dealt: number[], actions: ParsedHand["actions"], heroSeatId = dealt[0]!) =>
    hand({ heroSeatId, actions, liveSeats: dealt, roster: { dealer, deadButton: !dealt.includes(dealer), deadSb: false, dealt, seats: {} } });
  const names = (h: ParsedHand) => Object.fromEntries([...namesFromRoster(h)!].sort((x, y) => x[0] - y[0]));
  it("a live button: SB first after it, the button last (six, five, four, three dealt)", () => {
    expect(names(withRoster(4, [1, 2, 3, 4, 5, 6], [a(5, "post-sb", 0.5), a(6, "post-bb", 1)]))).toEqual({ 5: "SB", 6: "BB", 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN" });
    expect(names(withRoster(4, [1, 2, 4, 5, 6], [a(5, "post-sb", 0.5), a(6, "post-bb", 1)]))).toEqual({ 5: "SB", 6: "BB", 1: "HJ", 2: "CO", 4: "BTN" });
    expect(names(withRoster(4, [1, 4, 5, 6], [a(5, "post-sb", 0.5), a(6, "post-bb", 1)]))).toEqual({ 5: "SB", 6: "BB", 1: "CO", 4: "BTN" });
    expect(names(withRoster(4, [4, 5, 6], [a(5, "post-sb", 0.5), a(6, "post-bb", 1)]))).toEqual({ 5: "SB", 6: "BB", 4: "BTN" });
  });
  it("a dead button: the last dealt seat before the blinds is the BTN (4922299303, 4922296152)", () => {
    expect(names(withRoster(4, [1, 2, 3, 5, 6], [a(5, "post-sb", 0.4), a(6, "post-bb", 1)]))).toEqual({ 5: "SB", 6: "BB", 1: "HJ", 2: "CO", 3: "BTN" });
    expect(names(withRoster(4, [1, 3, 5, 6], [a(5, "post-sb", 0.4), a(6, "post-bb", 1)]))).toEqual({ 5: "SB", 6: "BB", 1: "CO", 3: "BTN" });
    expect(names(withRoster(6, [1, 2, 3], [a(1, "post-sb", 0.4), a(2, "post-bb", 1)]))).toEqual({ 1: "SB", 2: "BB", 3: "BTN" });
  });
  it("a dead small blind, with and without a dead button: BB first", () => {
    expect(names(withRoster(3, [1, 2, 3, 5, 6], [a(5, "post-bb", 1)]))).toEqual({ 5: "BB", 6: "UTG", 1: "HJ", 2: "CO", 3: "BTN" });
    expect(names(withRoster(1, [4, 5, 6], [a(4, "post-bb", 1)]))).toEqual({ 4: "BB", 5: "CO", 6: "BTN" });
  });
  it("heads-up: the small blind is the seat that posted it, else the dealer", () => {
    expect(names(withRoster(3, [2, 5], [a(5, "post-sb", 0.5), a(2, "post-bb", 1)]))).toEqual({ 2: "BB", 5: "SB" });
    expect(names(withRoster(5, [2, 5], []))).toEqual({ 2: "BB", 5: "SB" });
  });
  it("nothing to place by: no roster, no button seat, one seat", () => {
    expect(namesFromRoster(hand())).toBeNull();
    expect(namesFromRoster(hand({ roster: { dealer: null, deadButton: false, deadSb: false, dealt: [4, 5, 6], seats: {} } }))).toBeNull();
    expect(namesFromRoster(withRoster(2, [4], []))).toBeNull();
  });
});

describe("relabelDeadButton", () => {
  it("the BTN label on an undealt seat: the dealt non-blind seats take the latest names, the label is dropped", () => {
    const r = relabelDeadButton(hand({ heroSeatId: 3, liveSeats: [1, 2, 3, 5, 6], positions: { 5: "SB", 6: "BB", 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN" } }));
    expect(r.hand.positions).toEqual({ 5: "SB", 6: "BB", 1: "HJ", 2: "CO", 3: "BTN" });
    expect(r.note).toContain("seat 1 UTG→HJ, seat 2 HJ→CO, seat 3 CO→BTN");
    expect(r.hand.seatRelabel?.from[4]).toBe("BTN");
  });
  it("anything else is left as it is", () => {
    const h = hand();   // the CO label sat out, the BTN was dealt
    expect(relabelDeadButton(h).hand).toBe(h);
    expect(relabelDeadButton(h).note).toBeNull();
  });
});
