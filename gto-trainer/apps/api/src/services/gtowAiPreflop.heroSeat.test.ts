import { describe, expect, it } from "bun:test";
import { debugTree, lineOf, menus, shapeOf, treeKeyOf, walkArrivalRanges } from "./gtowAiPreflop";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * HERO'S SEAT IN THE AI PREFLOP TREE (2026-10-14, the answer-path audit's latent items 1 and 2 — code reading, no hand in
 * 14 days where either fired).
 *
 *  1. A HEADS-UP HERO LABELLED BTN. shapeOf renames the two-seat table's BTN to the tree's SB (in heads-up the dealer IS
 *     the small blind) but looked hero up under his own label, "BTN": the shape named no hero seat (heroApiPos null), so
 *     the answer's pos was null, the LINE_NOT_HERO guard (`shape.heroApiPos && toAct !== shape.heroApiPos`) was off, and
 *     walkArrivalRanges read hero's raise as a villain's — the UNION of the node's raise sizes instead of the size he
 *     played. All 142 live heads-up answers carried SB/BB (the wrapper names a two-seat table SB/BB); the BTN label comes
 *     from a source that names the dealer (buildSolutionUrl's HU variant, tickToHand before its fix) or a heads-up table
 *     with a dead small blind (three seats labelled, the SB's not dealt).
 *  2. lineOf PLACED HERO'S TOKENS BY heroPosOf(hand, null) — his label alone — while shapeOf had resolved him through
 *     its heroPos override. The live callers pass his label (routes/fastSolver, replayGate, the poller sends none), so the
 *     two agreed; a hero the hand does not label (handToSpot's "pass heroPos explicitly") mapped to NO seat, and his
 *     action went to whichever seat the walk was padding — an early seat's lost fold took his open. Now his tokens sit
 *     on the seat the shape gave him.
 */

const arr = (v: number) => COMBOS.map(() => v);
const node = (actor: string, actions: { code: string; strategy: number[] }[]) => ({
  data: {
    game: { players: [{ position: actor, is_hero: true }] },
    action_solutions: actions.map((a) => ({ action: { code: a.code, type: a.code[0] === "R" ? "RAISE" : a.code, betsize: a.code.slice(1), allin: false }, strategy: a.strategy })),
  },
});
const act = (seatId: number, hero: boolean, type: string, amount?: number) => ({ seatId, hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const shapeFor = (h: ParsedHand, heroPos: string | null = null) => {
  const s = shapeOf(h, heroPos);
  if ("error" in s) throw new Error(s.error);
  return s;
};

describe("item 1: a heads-up hero labelled BTN is the tree's SB", () => {
  // two dealt: hero seat 1 is the dealer, labelled BTN by the source; seat 2 the BB. Hero posted the small blind (the
  // dealer does heads-up), opened 2.5, the BB 3-bet to 9, hero to act.
  const hand: ParsedHand = {
    handId: 1, clientHandId: "hu-btn-label", bbCents: 200, heroSeatId: 1, heroCards: ["Ah", "Kd"], board: [], street: "preflop",
    actions: [act(1, true, "post-sb", 0.5), act(2, false, "post-bb", 1), act(1, true, "raise", 2.5), act(2, false, "raise", 9)],
    liveSeats: [1, 2], committed: { 1: 2.5, 2: 9 }, potByStreet: {}, positions: { 1: "BTN", 2: "BB" },
    stacks: { 1: 97.5, 2: 91 },
    currentNode: { street: "preflop", toActSeatId: 1, toActIsHero: true, pot: 11.5, toCall: 6.5, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;

  it("shapeOf: the table's BTN is the tree's SB — and so is hero (was: heroApiPos null)", () => {
    const s = shapeFor(hand);
    expect(s.n).toBe(2);
    expect(s.positions).toEqual(["SB", "BB"]);
    expect(s.apiOf).toEqual({ SB: "SB", BB: "BB" });
    expect(s.seatOf).toEqual({ SB: 1, BB: 2 });
    expect(s.heroApiPos).toBe("SB");
    // the tree's key names hero's seat: a tree built for a hero-less shape is not this one
    expect(treeKeyOf(s, menus([2.5, 9], 2, null))).toContain('"SB"');
  });

  it("the same with the label given as the override, and with a dead small blind beside the two (three labelled, the SB seat not dealt)", () => {
    expect(shapeFor(hand, "BTN").heroApiPos).toBe("SB");
    const deadSb = { ...hand, liveSeats: [1, 3], positions: { 1: "BTN", 2: "SB", 3: "BB" },
      actions: hand.actions.map((a) => (a.seatId === 2 ? { ...a, seatId: 3 } : a)), stacks: { 1: 97.5, 2: 100, 3: 91 } } as unknown as ParsedHand;
    const s = shapeFor(deadSb);
    expect(s.positions).toEqual(["SB", "BB"]);
    expect(s.deadSb).toBe(false);                 // the dealer posts the small blind heads-up: no ghost
    expect(s.heroApiPos).toBe("SB");
    expect(s.seatOf.SB).toBe(1);
  });

  it("the line and the request: hero's open on the SB's seat, the BB's 3-bet behind it; the answer names his seat", () => {
    const s = shapeFor(hand);
    expect(lineOf(hand, s).tokens).toEqual(["R2.5", "R9"]);
    const dt = debugTree(hand, null);
    if ("error" in dt) throw new Error(dt.error);
    expect(dt.shape.heroApiPos).toBe("SB");
    expect(dt.line).toBe("R2.5-R9");
    expect(dt.body.players.map((p: any) => [p.position, p.blind, p.stack])).toEqual([["SB", 0.5, 100], ["BB", 1, 100]]);
  });

  it("the arrival walk reads hero's raise at the size he played (was: the union of the node's sizes, a villain's rule)", async () => {
    const flop = { ...hand, street: "flop", board: ["7d", "Jd", "Kh"], actions: [...hand.actions, act(1, true, "call", 9)],
      currentNode: { ...hand.currentNode, street: "flop", toCall: 0 } } as unknown as ParsedHand;
    const s = shapeFor(flop);
    const { tokens } = lineOf(flop, s);
    expect(tokens).toEqual(["R2.5", "R9", "C"]);
    const nodes: Record<string, any> = {
      "": node("SB", [{ code: "F", strategy: arr(0.2) }, { code: "C", strategy: arr(0.3) }, { code: "R2.5", strategy: arr(0.3) }, { code: "R3", strategy: arr(0.2) }]),
      "R2.5": node("BB", [{ code: "F", strategy: arr(0.5) }, { code: "C", strategy: arr(0.3) }, { code: "R9", strategy: arr(0.2) }]),
      "R2.5-R9": node("SB", [{ code: "F", strategy: arr(0.4) }, { code: "C", strategy: arr(0.5) }, { code: "R27", strategy: arr(0.1) }]),
    };
    const r = await walkArrivalRanges(s, tokens, async (line) => nodes[line] ?? { error: `no node ${line}` }, 2);
    if (!r.ok) throw new Error(r.reason);
    // the tree's SB keeps that name (the chain's lookup knows the BTN alias heads-up — walkArrivalRanges' own note)
    expect(Object.keys(r.ranges).sort()).toEqual(["BB", "SB"]);
    expect(r.ranges.SB!.AA).toBeCloseTo(0.3 * 0.5, 6);                      // R2.5 exactly (0.3), then the call (0.5) — not (0.3 + 0.2) x 0.5
    expect(r.ranges.BB!.AA).toBeCloseTo(0.2, 6);                            // the villain's 3-bet: the one size the node has
  });
});

describe("item 2: hero's tokens sit on the seat the shape gave him (the heroPos override)", () => {
  // three dealt; the hand labels the two villains and NOT hero (the panel-feed shape handToSpot's "pass heroPos
  // explicitly" exists for): hero seat 5 is the SB by the override. The button's fold was lost by the capture; hero
  // raised 3, the BB called, hero to act on the flop.
  const hand: ParsedHand = {
    handId: 2, clientHandId: "unlabelled-hero", bbCents: 200, heroSeatId: 5, heroCards: ["Qs", "Qd"], board: ["2c", "7h", "Td"], street: "flop",
    actions: [act(5, true, "post-sb", 0.5), act(6, false, "post-bb", 1), act(5, true, "raise", 3), act(6, false, "call", 3)],
    liveSeats: [4, 5, 6], committed: {}, potByStreet: { preflop: 6 }, positions: { 4: "BTN", 6: "BB" },
    stacks: { 4: 100, 5: 97, 6: 97 },
    currentNode: { street: "flop", toActSeatId: 5, toActIsHero: true, pot: 6, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;

  it("shapeOf seats hero by the override; lineOf pads the button's lost fold and puts hero's open on HIS seat (was: on the button's)", () => {
    const s = shapeFor(hand, "SB");
    expect(s.positions).toEqual(["BTN", "SB", "BB"]);
    expect(s.heroApiPos).toBe("SB");
    expect(s.seatOf).toEqual({ BTN: 4, SB: 5, BB: 6 });
    // before: hero's raise mapped to no seat and was taken by the BTN slot — "R3-F-C", hero folded out of his own hand
    expect(lineOf(hand, s).tokens).toEqual(["F", "R3", "C"]);
  });

  it("a labelled hero is unchanged: the override and the label agree, as every live caller passes them", () => {
    const labelled = { ...hand, positions: { ...hand.positions, 5: "SB" } } as unknown as ParsedHand;
    expect(lineOf(labelled, shapeFor(labelled, "SB")).tokens).toEqual(["F", "R3", "C"]);
    expect(lineOf(labelled, shapeFor(labelled, null)).tokens).toEqual(["F", "R3", "C"]);
  });

  it("the heads-up rename and the override together: a BTN-labelled hero's tokens on the tree's SB", () => {
    const hu: ParsedHand = {
      ...hand, heroSeatId: 4, liveSeats: [4, 6], positions: { 4: "BTN", 6: "BB" }, board: [], street: "preflop",
      actions: [act(4, true, "post-sb", 0.5), act(6, false, "post-bb", 1), act(4, true, "raise", 3), act(6, false, "raise", 10)],
      currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 13, toCall: 7, legalActions: [], complete: false },
    } as unknown as ParsedHand;
    const s = shapeFor(hu, "BTN");
    expect(s.heroApiPos).toBe("SB");
    expect(lineOf(hu, s).tokens).toEqual(["R3", "R10"]);
  });
});
