import { describe, expect, it } from "bun:test";
import { debugTree, lineOf, shapeOf, walkArrivalRanges } from "./gtowAiPreflop";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE DEAD-SB GHOST FOLDS — IT IS NOT ALL-IN (2026-10-01, hand 4921843568, session_20261001_130914 table 2).
 * Five dealt, the SB seat empty. Hero opened the CO, the BTN cold-called, the BB folded — and the flop had no ranges:
 * "token C is not an action at 'F-F-R2.6'". The ghost standing in for the empty seat was all-in for its penny, so it
 * always "reached the flop" and took one of the three flop seats GTO Wizard AI allows; with the raiser and the BB the
 * field was full and no other seat was offered a call (solve cache: 49 of 49 live-SB trees offer one, 0 of 6 ghost
 * trees). The ghost now has a stack behind and may only fold (probed: F 100% at its every node, the BTN's call back),
 * and since the tree puts it on the clock, the line carries its fold.
 */

const arr = (v: number) => COMBOS.map(() => v);
const node = (actor: string, actions: { code: string; strategy: number[] }[]) => ({
  data: {
    game: { players: [{ position: actor, is_hero: true }] },
    action_solutions: actions.map((a) => ({ action: { code: a.code, type: a.code[0] === "R" ? "RAISE" : a.code, betsize: a.code.slice(1), allin: false }, strategy: a.strategy })),
  },
});

/** The table of hand 4921843568: seat 1 BTN, (seat 2 empty), seat 3 BB, 4 UTG, 5 HJ, 6 hero CO. */
const base = {
  handId: 26, clientHandId: "4921843568", bbCents: 5, heroSeatId: 6, heroCards: ["As", "9h"], liveSeats: [1, 3, 4, 5, 6],
  committed: {}, potByStreet: {}, positions: { 1: "BTN", 3: "BB", 4: "UTG", 5: "HJ", 6: "CO" },
  stacks: { 1: 93.2, 3: 58.6, 4: 119, 5: 52.4, 6: 104 }, ended: false,
} as const;
const pre = (type: string, seatId: number, amount?: number) => ({ seatId, hero: seatId === 6, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const POST = pre("post-bb", 3, 1), F4 = pre("fold", 4), F5 = pre("fold", 5), OPEN = pre("raise", 6, 2.6), CALL = pre("call", 1, 2.6), F1 = pre("fold", 1), F3 = pre("fold", 3);
const at = (actions: any[], node: Partial<ParsedHand["currentNode"]>, extra: Partial<ParsedHand> = {}): ParsedHand => ({
  ...base, board: [], street: "preflop", actions,
  currentNode: { street: "preflop", toActSeatId: 6, toActIsHero: true, pot: 1, toCall: 1, legalActions: [], complete: false, ...node },
  ...extra,
} as unknown as ParsedHand);

const shapeFor = (h: ParsedHand, heroPos: string | null = null) => {
  const s = shapeOf(h, heroPos);
  if ("error" in s) throw new Error(s.error);
  return s;
};

describe("the dead-SB ghost", () => {
  const flop = at([POST, F4, F5, OPEN, CALL, F3], { street: "flop", pot: 6.2, toCall: 0 }, { street: "flop", board: ["7d", "Jd", "Kh"] });

  it("is written into the tree as a seat that may only fold: a penny blind, a stack behind, no limp, no calls, no sizes", () => {
    const dt = debugTree(at([POST, F4, F5], {}), null);
    if ("error" in dt) throw new Error(dt.error);
    expect(dt.shape.deadSb).toBe(true);
    expect(dt.shape.positions).toEqual(["UTG", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(dt.shape.stacks.SB).toBe(0.01);                      // the shape's label (a tree's id reads `SB:0.01`)
    const sb = dt.body.players.find((p: any) => p.position === "SB");
    expect(sb.blind).toBe(0.01);
    expect(sb.stack).toBeGreaterThan(1);                        // NOT all-in for its blind
    const sizes = dt.body.bet_sizes.street_bet_sizes[0].position_bet_sizes.find((x: any) => x.position === "SB");
    expect(sizes).toMatchObject({ allow_limp: false, allow_call_opens: false, allow_3betplus_cold_calls: false,
                                  bet_sizes: [], raise_sizes: [], second_raise_sizes: [], third_plus_raise_sizes: [] });
    // every real seat keeps its calls
    const btn = dt.body.bet_sizes.street_bet_sizes[0].position_bet_sizes.find((x: any) => x.position === "BTN");
    expect(btn).toMatchObject({ allow_limp: true, allow_call_opens: true, allow_3betplus_cold_calls: true });
    expect(btn.bet_sizes.length).toBeGreaterThan(0);
  });

  it("folds in the line on its turn — between the button and the big blind", () => {
    expect(lineOf(flop, shapeFor(flop)).tokens).toEqual(["F", "F", "R2.6", "C", "F", "F"]);
    // the button folds instead: the same place
    const hu = at([POST, F4, F5, OPEN, F1, pre("call", 3, 1.6)], { street: "flop" }, { street: "flop", board: ["7d", "Jd", "Kh"] });
    expect(lineOf(hu, shapeFor(hu)).tokens).toEqual(["F", "F", "R2.6", "F", "F", "C"]);
  });

  it("has folded when the BB is on the clock behind it, and has not when the line stops before it", () => {
    // hero in the BB, the button's call the last action: the BB's node sits behind the ghost's fold
    const bbHero = { ...base, heroSeatId: 3 };
    const facing: ParsedHand = { ...at([POST, F4, F5, { ...OPEN, hero: false }, CALL], { toActSeatId: 3 }), ...bbHero } as unknown as ParsedHand;
    expect(lineOf(facing, shapeFor(facing)).tokens).toEqual(["F", "F", "R2.6", "C", "F"]);
    // hero on the button facing the open: the ghost has not been reached
    const btnHero: ParsedHand = { ...at([POST, F4, F5, { ...OPEN, hero: false }], { toActSeatId: 1 }), ...base, heroSeatId: 1 } as unknown as ParsedHand;
    expect(lineOf(btnHero, shapeFor(btnHero)).tokens).toEqual(["F", "F", "R2.6"]);
    // hero first in from the CO: nothing of the ghost yet
    const first = at([POST, F4, F5], {});
    expect(lineOf(first, shapeFor(first)).tokens).toEqual(["F", "F"]);
  });

  it("a table WITH a small blind is untouched: no ghost, no extra fold", () => {
    const live = { ...base, liveSeats: [1, 2, 3, 4, 5, 6], positions: { ...base.positions, 2: "SB" }, stacks: { ...base.stacks, 2: 100 } };
    const h = { ...at([pre("post-sb", 2, 0.5), POST, F4, F5, OPEN, CALL, pre("fold", 2), F3], { street: "flop" }, { street: "flop", board: ["7d", "Jd", "Kh"] }), ...live } as unknown as ParsedHand;
    const s = shapeFor(h);
    expect(s.deadSb).toBe(false);
    expect(lineOf(h, s).tokens).toEqual(["F", "F", "R2.6", "C", "F", "F"]);   // the SB's own fold, from the table
    const dt = debugTree(h, null);
    if ("error" in dt) throw new Error(dt.error);
    expect(dt.body.bet_sizes.street_bet_sizes[0].position_bet_sizes.find((x: any) => x.position === "SB").allow_call_opens).toBe(true);
  });

  it("the walk reads the cold-caller's range and drops the ghost: hero and the button reach the flop", async () => {
    const shape = shapeFor(flop);
    const { tokens } = lineOf(flop, shape);
    const nodes: Record<string, any> = {
      "": node("UTG", [{ code: "F", strategy: arr(0.8) }, { code: "R2.5", strategy: arr(0.2) }]),
      "F": node("HJ", [{ code: "F", strategy: arr(0.8) }, { code: "R2.5", strategy: arr(0.2) }]),
      "F-F": node("CO", [{ code: "F", strategy: arr(0.7) }, { code: "R2.6", strategy: arr(0.3) }]),
      "F-F-R2.6": node("BTN", [{ code: "F", strategy: arr(0.82) }, { code: "C", strategy: arr(0.08) }, { code: "R9.1", strategy: arr(0.1) }]),
      "F-F-R2.6-C": node("SB", [{ code: "F", strategy: arr(1) }]),
      "F-F-R2.6-C-F": node("BB", [{ code: "F", strategy: arr(0.8) }, { code: "C", strategy: arr(0.12) }, { code: "R9.1", strategy: arr(0.08) }]),
    };
    const r = await walkArrivalRanges(shape, tokens, async (line) => nodes[line] ?? { error: `no node ${line}` }, 6);
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.ranges).sort()).toEqual(["BTN", "CO"]);   // no ghost, no BB
    expect(r.ranges.CO!.AA).toBeCloseTo(0.3, 5);
    expect(r.ranges.BTN!.AA).toBeCloseTo(0.08, 5);
  });
});
