import { describe, expect, it } from "bun:test";
import { walkArrivalRanges, shapeOf, lineOf } from "./gtowAiPreflop";
import { COMBOS, comboIndex } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * The AI preflop tree's arrival ranges expose the same shape as the 6-max chart walk
 * (position → class → weight): a fold drops the seat, every node multiplies the actor's
 * range by its strategy for the action taken, a villain's raise conditions on the union
 * of raise sizes, hero's on the exact one, and every seat is keyed once by the table's own
 * position name (heads-up the chain maps BTN↔SB itself).
 */

const arr = (fill: number | ((i: number) => number)) => COMBOS.map((_, i) => (typeof fill === "number" ? fill : fill(i)));
const node = (actor: string, actions: { code: string; strategy: number[]; allin?: boolean }[]) => ({
  data: {
    game: { players: [{ position: actor, is_hero: true }] },
    action_solutions: actions.map((a) => ({ action: { code: a.code, type: a.code[0] === "R" ? "RAISE" : a.code, betsize: a.code.slice(1), allin: !!a.allin }, strategy: a.strategy })),
  },
});

const hand3: ParsedHand = {
  handId: 1, clientHandId: "t", bbCents: 200, heroSeatId: 6, heroCards: ["Kh", "Qd"], board: ["Jc", "7d", "2s"], street: "flop",
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 5, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 6, hero: true, type: "call", amount: 1.5, street: "preflop" },
  ],
  liveSeats: [1, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "SB", 5: "BTN", 6: "BB" }, stacks: { 1: 100, 5: 97.5, 6: 97.5 },
  currentNode: { street: "flop", toActSeatId: 6, toActIsHero: true, pot: 5.5, toCall: 0, legalActions: [], complete: false }, ended: false,
};

describe("walkArrivalRanges", () => {
  it("3-handed: BTN raise (union of sizes), SB fold drops the seat, BB (hero) call exact", async () => {
    const shape = shapeOf(hand3, null);
    if ("error" in shape) throw new Error(shape.error);
    const { tokens } = lineOf(hand3, shape);
    expect(tokens).toEqual(["R2.5", "F", "C"]);
    const aa = comboIndex("Ah", "As"), kq = comboIndex("Kh", "Qd"), t2 = comboIndex("Th", "2d");
    const nodes: Record<string, any> = {
      "": node("BTN", [
        { code: "F", strategy: arr((i) => (i === aa ? 0 : i === t2 ? 1 : 0.5)) },
        { code: "R2.5", strategy: arr((i) => (i === aa ? 0.6 : i === t2 ? 0 : 0.3)) },
        { code: "R3", strategy: arr((i) => (i === aa ? 0.4 : i === t2 ? 0 : 0.2)) },
      ]),
      "R2.5": node("SB", [{ code: "F", strategy: arr(1) }, { code: "C", strategy: arr(0) }]),
      "R2.5-F": node("BB", [
        { code: "F", strategy: arr((i) => (i === kq ? 0 : 0.5)) },
        { code: "C", strategy: arr((i) => (i === kq ? 0.7 : 0.5)) },
        { code: "R8", strategy: arr((i) => (i === kq ? 0.3 : 0)) },
      ]),
    };
    const r = await walkArrivalRanges(shape, tokens, async (line) => nodes[line] ?? { error: `no node ${line}` }, 6);
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.ranges).sort()).toEqual(["BB", "BTN"]);   // the SB folded
    // BTN's raise = union of R2.5 and R3: AA 1.0, the rest 0.5 — except the one T2o combo pinned to
    // fold, so its class (12 combos) averages eleven at 0.5 and one at 0
    // (one AA combo pinned to raise 1.0, the other five at 0.5 → the class averages them)
    expect(r.ranges.BTN!.AA).toBeCloseTo((1 + 5 * 0.5) / 6, 5);
    expect(r.ranges.BTN!.T2o).toBeCloseTo((11 * 0.5) / 12, 5);
    expect(r.ranges.BTN!.J9s).toBeCloseTo(0.5, 5);
    // hero's call = the exact call branch: KQo 0.7 (its class averages the KQo combos: one at 0.7, eleven at 0.5)
    expect(r.ranges.BB!.KQo).toBeCloseTo((0.7 + 11 * 0.5) / 12, 5);
    expect(r.piece).toBe("gtow-ai-preflop");
    expect(r.seatOrder).toEqual(shape.positions);
  });

  it("heads-up: the dealer is the tree's SB (the table's BTN); one key per seat, the chain's lookup maps BTN↔SB", async () => {
    const hu: ParsedHand = {
      ...hand3, heroSeatId: 6, positions: { 2: "BB", 6: "BTN" }, liveSeats: [2, 6], stacks: { 2: 97.5, 6: 97.5 },
      actions: [
        { seatId: 6, hero: true, type: "post-sb", amount: 0.5, street: "preflop" },
        { seatId: 2, hero: false, type: "post-bb", amount: 1, street: "preflop" },
        { seatId: 6, hero: true, type: "raise", amount: 2.5, street: "preflop" },
        { seatId: 2, hero: false, type: "call", amount: 1.5, street: "preflop" },
      ],
    };
    const shape = shapeOf(hu, null);
    if ("error" in shape) throw new Error(shape.error);
    const { tokens } = lineOf(hu, shape);
    expect(tokens).toEqual(["R2.5", "C"]);
    const nodes: Record<string, any> = {
      "": node("SB", [{ code: "F", strategy: arr(0.2) }, { code: "R2.5", strategy: arr(0.8) }]),
      "R2.5": node("BB", [{ code: "F", strategy: arr(0.4) }, { code: "C", strategy: arr(0.6) }]),
    };
    const r = await walkArrivalRanges(shape, tokens, async (line) => nodes[line] ?? { error: `no node ${line}` }, 2);
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.ranges).sort()).toEqual(["BB", "SB"]);   // one key per seat — a second would read as a third player
    expect(r.ranges.SB!.AA).toBeCloseTo(0.8, 5);
    expect(r.ranges.BB!.AA).toBeCloseTo(0.6, 5);
  });

  it("four players reaching the flop: refused at cap 3, walked in full at cap 6", async () => {
    const four: ParsedHand = {
      ...hand3, positions: { 1: "SB", 3: "CO", 5: "BTN", 6: "BB" }, liveSeats: [1, 3, 5, 6], stacks: { 1: 100, 3: 100, 5: 100, 6: 100 },
      actions: [
        { seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
        { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
        { seatId: 3, hero: false, type: "raise", amount: 2.5, street: "preflop" },
        { seatId: 5, hero: false, type: "call", amount: 2.5, street: "preflop" },
        { seatId: 1, hero: false, type: "call", amount: 2, street: "preflop" },
        { seatId: 6, hero: true, type: "call", amount: 1.5, street: "preflop" },
      ],
    };
    const shape = shapeOf(four, null);
    if ("error" in shape) throw new Error(shape.error);
    const { tokens } = lineOf(four, shape);
    const any = (actor: string) => node(actor, [{ code: "F", strategy: arr(0.5) }, { code: "C", strategy: arr(0.5) }, { code: "R2.5", strategy: arr(0.5) }]);
    const order = shape.positions;
    const get = async (line: string) => any(order[line ? line.split("-").length % order.length : 0]!);

    // a caller that can only take three says so, and is told no
    const three = await walkArrivalRanges(shape, tokens, get, 3);
    expect(three.ok).toBe(false);
    if (!three.ok) expect(three.reason).toContain("4 players reach the flop");

    // ...but the REAL postflop caller collapses four to three itself, so it asks for six and gets all four
    // seats' ranges. This is the 2026-09-21 hole: fastSolve passed 3 here while the chart path passed 6, so
    // every 4+ way flop the AI preflop piece had answered died one line before the collapse that handles it.
    const six = await walkArrivalRanges(shape, tokens, get, 6);
    expect(six.ok).toBe(true);
    if (six.ok) {
      expect(Object.keys(six.ranges).sort()).toEqual(["BB", "BTN", "CO", "SB"]);   // the API's 4-seat set
      for (const pos of Object.keys(six.ranges)) expect(Object.keys(six.ranges[pos]!).length).toBeGreaterThan(0);
    }
  });
});
