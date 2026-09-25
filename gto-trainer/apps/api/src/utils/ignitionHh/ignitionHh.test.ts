import { describe, expect, test } from "bun:test";
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";
import { compareHand, parseIgnitionHh } from "./ignitionHh";
import body from "./hh_4920544353.fixture.json";

// hand 4920544353 (NL5, 2026-09-25) as the reader archived it: a rabbit-hunt river card and a phantom winner fold
const archived: ParsedHand = {
  handId: 12, clientHandId: "4920544353", bbCents: 5, heroSeatId: 5, heroCards: ["Kd", "Jh"],
  board: ["6s", "8h", "Ks", "Qh", "Qc"], street: "river", liveSeats: [1, 2, 3, 4, 5, 6],
  committed: {}, potByStreet: {}, positions: { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" },
  startStacks: { 1: 52.4, 2: 34, 3: 104.4, 4: 226.6, 5: 100, 6: 34.2 },
  stacks: { 1: 49.8, 2: 30.4, 3: 104.4, 4: 226.6, 5: 87.4, 6: 51.6 },
  currentNode: { street: "river", toActSeatId: null, toActIsHero: false, pot: 31.4, toCall: 0, legalActions: [], complete: true },
  ended: true,
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 2, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 5, hero: true, type: "raise", amount: 2.6, street: "preflop" },
    { seatId: 6, hero: false, type: "call", amount: 2.6, street: "preflop" },
    { seatId: 1, hero: false, type: "call", amount: 2.2, street: "preflop" },
    { seatId: 2, hero: false, type: "call", amount: 1.6, street: "preflop" },
    { seatId: 1, hero: false, type: "check", street: "flop" },
    { seatId: 2, hero: false, type: "bet", amount: 1, street: "flop" },
    { seatId: 5, hero: true, type: "call", amount: 1, street: "flop" },
    { seatId: 6, hero: false, type: "raise", amount: 10, street: "flop" },
    { seatId: 1, hero: false, type: "fold", street: "flop" },
    { seatId: 2, hero: false, type: "fold", street: "flop" },
    { seatId: 5, hero: true, type: "call", amount: 9, street: "flop" },
    { seatId: 5, hero: true, type: "check", street: "turn" },
    { seatId: 6, hero: false, type: "all-in", amount: 21.6, street: "turn" },
    { seatId: 5, hero: true, type: "fold", street: "turn" },
    { seatId: 6, hero: false, type: "fold", street: "turn" },
  ],
};

describe("parseIgnitionHh", () => {
  const h = parseIgnitionHh(body);
  test("reads the record into our seats, streets and bb amounts", () => {
    expect(h.bbCents).toBe(5);
    expect(h.board).toEqual(["6s", "8h", "Ks", "Qh"]);
    expect(h.heroCards).toEqual(["Kd", "Jh"]);
    expect(h.seats.map((s) => [s.seat, s.startBb])).toEqual([[1, 52.4], [2, 34], [3, 104.4], [4, 226.6], [5, 100], [6, 34.2]]);
    expect(h.seats.find((s) => s.hero)?.seat).toBe(5);
    expect(h.actions).toHaveLength(18);
    expect(h.actions[4]).toMatchObject({ seat: 5, type: "raise", amountBb: 2.6, street: "preflop" });
    expect(h.actions[16]).toMatchObject({ seat: 6, type: "all-in", amountBb: 21.6, street: "turn" });
    expect(h.other.map((o) => o.label)).toContain("Return uncalled portion of bet");
  });
});

describe("compareHand", () => {
  test("flags exactly the rabbit-hunt card and the phantom fold", () => {
    const d = compareHand(archived, parseIgnitionHh(body));
    expect(d.map((x) => x.kind)).toEqual(["board-extra", "action-extra"]);
    expect(d[1]!.field).toBe("action 19 only in ours");
    expect(d[0]!.note).toContain("never dealt");
  });

  test("a faithful capture has no differences", () => {
    const fixed = { ...archived, board: archived.board.slice(0, 4), actions: archived.actions.slice(0, 18) };
    expect(compareHand(fixed, parseIgnitionHh(body))).toEqual([]);
  });

  test("a missed action is one row, not a cascade", () => {
    const missed = { ...archived, board: archived.board.slice(0, 4), actions: archived.actions.filter((_, i) => i !== 3 && i < 18) };
    expect(compareHand(missed, parseIgnitionHh(body))).toEqual([
      { kind: "action-missing", field: "Ignition action 4 missing from ours", ours: "—", ignition: "preflop seat 4 fold" },
    ]);
  });

  test("a wrong size and a wrong start stack are called out", () => {
    const off = { ...archived, board: archived.board.slice(0, 4), actions: archived.actions.slice(0, 18).map((a, i) => i === 11 ? { ...a, amount: 12 } : a),
      startStacks: { ...archived.startStacks, 6: 51.6 }, stacks: { ...archived.stacks, 2: 31 } };
    expect(compareHand(off, parseIgnitionHh(body)).map((x) => x.field)).toEqual(["seat 6 start stack", "seat 2 end stack", "action 12 amount"]);
  });
});
