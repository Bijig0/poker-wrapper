/**
 * IGNITION'S DEAD BUTTON (2026-10-04, hands 4922296152 / 4922299303 of 2026-10-03, table 2). Ignition dealt with the
 * button on a seat it did not deal; the wrapper labelled that seat BTN and the dealt seats one name early, so hero on
 * the real last seat was answered at the CO node of the 6-max charts — a node that assumes a live button behind him.
 * normalizeHand now renames the dealt seats among the dealt (utils/dealtSeats.relabelDeadButton) and the fixed wrapper
 * sends them so (with the hand's seat roster); #14 checks hero's label against the table's geometry. Pure: no charts —
 * the walk's input (the positional tokens) and the routing are what decide the node.
 */
import { describe, expect, test } from "bun:test";
import { aiHeroDepth, decisionChecks, heroGeometry, is3Handed, is6Handed, sixMaxRakeCapBb, type FastSolveResult } from "./fastSolve";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { buildPreflopTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { classifyPath } from "./chainPath";
import type { AiPreflopShape } from "./gtowAiPreflop";

const act = (seatId: number, type: string, amount?: number, hero = false) =>
  ({ seatId, hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const node = (toCall: number) => ({ street: "preflop", toActSeatId: 3, toActIsHero: true, pot: 1.5 + toCall, toCall, legalActions: [], complete: false });

/** 4922296152 as a wrapper BEFORE the fix exported it: seat 4 sat out and held the button; dealt 1, 3, 5, 6; hero seat
 *  3 (A♠6♥) after seat 1's fold. The old labels counted seat 4: SB 5, BB 6, HJ 1, CO 3 (hero), BTN 4. */
const h4922296152 = (extra: Record<string, unknown> = {}) => normalizeHand({
  handId: 1, clientHandId: "4922296152", bbCents: 5, heroSeatId: 3, heroCards: ["As", "6h"], board: [], street: "preflop",
  liveSeats: [1, 3, 5, 6], committed: { 5: 0.4, 6: 1 }, potByStreet: {}, positions: { 5: "SB", 6: "BB", 1: "HJ", 3: "CO", 4: "BTN" },
  stacks: { 1: 333.2, 3: 100, 5: 110, 6: 61.8 }, startStacks: { 1: 333.2, 3: 100, 5: 110.4, 6: 62.8 },
  actions: [act(5, "post-sb", 0.4), act(6, "post-bb", 1), act(1, "fold")],
  currentNode: node(1), ended: false, lineSource: "ws", ...extra,
});

/** 4922299303 the same way: seat 4 busted and left, a new player had reserved it; dealt 1, 2, 3, 5, 6; seat 1 limps,
 *  seat 2 folds, hero seat 3 (J♥5♣). Old labels: SB 5, BB 6, UTG 1, HJ 2, CO 3 (hero), BTN 4 — the line "C-F". */
const h4922299303 = () => normalizeHand({
  handId: 2, clientHandId: "4922299303", bbCents: 5, heroSeatId: 3, heroCards: ["Jh", "5c"], board: [], street: "preflop",
  liveSeats: [1, 2, 3, 5, 6], committed: { 5: 0.4, 6: 1, 1: 1 }, potByStreet: {},
  positions: { 5: "SB", 6: "BB", 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN" },
  stacks: { 1: 360.6, 2: 38.2, 3: 201.4, 5: 95.2, 6: 86 },
  actions: [act(5, "post-sb", 0.4), act(6, "post-bb", 1), act(1, "call", 1), act(2, "fold")],
  currentNode: node(1), ended: false, lineSource: "ws",
});

describe("a dead button is renamed from the seats dealt (normalizeHand)", () => {
  test("4922296152: four dealt — SB/BB/CO/BTN, hero's seat 3 is the BTN; the undealt seat 4 loses its label", () => {
    const { hand, warnings } = h4922296152();
    expect(hand.positions).toEqual({ 5: "SB", 6: "BB", 1: "CO", 3: "BTN" });
    expect(hand.seatRelabel?.from).toEqual({ 5: "SB", 6: "BB", 1: "HJ", 3: "CO", 4: "BTN" });
    expect(warnings.some((w) => /^DEAD BUTTON: the button seat \(seat 4\) was not dealt .* seat 1 HJ→CO, seat 3 CO→BTN/.test(w))).toBe(true);
    // the routing: four dealt is the 6-max charts' table (UTG/HJ padded as folds), raked as four ($3 = 1.5bb at NL200)
    expect(is6Handed(hand, "BTN")).toBe(true);
    expect(sixMaxRakeCapBb(hand, "BTN")).toBe(1.5);
    // THE NODE: the positional walk reaches hero at the BUTTON — UTG and HJ never dealt, the CO (seat 1) folded.
    // Before the fix the tokens were F-F with hero at the CO, a live "BTN" still to act behind him.
    expect(buildPreflopTokens(hand, "BTN")).toEqual(["F", "F", "F"]);
    expect(buildPreflopTokens({ ...hand, positions: hand.seatRelabel!.from }, "CO")).toEqual(["F", "F"]);
  });
  test("4922299303: five dealt — SB/BB/HJ/CO/BTN, hero BTN facing the HJ's limp (the line F-C-F, not C-F)", () => {
    const { hand } = h4922299303();
    expect(hand.positions).toEqual({ 5: "SB", 6: "BB", 1: "HJ", 2: "CO", 3: "BTN" });
    expect(is6Handed(hand, "BTN")).toBe(true);
    expect(sixMaxRakeCapBb(hand, "BTN")).toBe(1.5);   // five dealt: $3
    expect(buildPreflopTokens(hand, "BTN")).toEqual(["F", "C", "F"]);
    expect(buildPreflopTokens({ ...hand, positions: hand.seatRelabel!.from }, "CO")).toEqual(["C", "F"]);
  });
  test("hero in the blinds: the villains are named among the dealt too — a button open is the BTN's, not a CO's", () => {
    const { hand } = normalizeHand({
      handId: 3, clientHandId: "t", bbCents: 5, heroSeatId: 5, heroCards: ["Ks", "Qs"], board: [], street: "preflop",
      liveSeats: [1, 2, 3, 5, 6], committed: { 5: 0.4, 6: 1, 3: 2.5 }, potByStreet: {},
      positions: { 5: "SB", 6: "BB", 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN" },
      actions: [act(5, "post-sb", 0.4, true), act(6, "post-bb", 1), act(1, "fold"), act(2, "fold"), act(3, "raise", 2.5)],
      currentNode: { ...node(2.1), toActSeatId: 5 }, ended: false,
    });
    expect(hand.positions[3]).toBe("BTN");
    expect(hand.positions[5]).toBe("SB");
    expect(buildPreflopTokens(hand, "SB")).toEqual(["F", "F", "F", "R2.5"]);   // UTG padded; HJ, CO fold; the BTN opens
  });
  test("three dealt with the button dead stays the AI piece's three-handed table, now named BTN/SB/BB outright", () => {
    const { hand } = normalizeHand({
      handId: 4, clientHandId: "4921651217", bbCents: 5, heroSeatId: 2, heroCards: ["6c", "2h"], board: [], street: "preflop",
      liveSeats: [1, 2, 6], committed: {}, potByStreet: {}, positions: { 6: "SB", 1: "BB", 2: "CO", 4: "BTN" },
      actions: [act(6, "post-sb", 0.4), act(1, "post-bb", 1)], currentNode: { ...node(1), toActSeatId: 2 }, ended: false,
    });
    expect(hand.positions).toEqual({ 6: "SB", 1: "BB", 2: "BTN" });
    expect(is3Handed(hand, "BTN")).toBe(true);
    expect(is6Handed(hand, "BTN")).toBe(false);
  });
  test("a dead button AND a dead small blind (4920414398): BB/CO/BTN — the blinds keep their names", () => {
    const { hand } = normalizeHand({
      handId: 5, clientHandId: "4920414398", bbCents: 5, heroSeatId: 6, heroCards: ["Ah", "Kh"], board: [], street: "preflop",
      liveSeats: [4, 5, 6], committed: {}, potByStreet: {}, positions: { 4: "BB", 5: "HJ", 6: "CO", 1: "BTN" },
      actions: [act(4, "post-bb", 1)], currentNode: { ...node(1), toActSeatId: 6 }, ended: false,
    });
    expect(hand.positions).toEqual({ 4: "BB", 5: "CO", 6: "BTN" });
  });
  test("heads-up with the button dead: SB and BB", () => {
    const { hand } = normalizeHand({
      handId: 6, clientHandId: "t", bbCents: 5, heroSeatId: 2, heroCards: ["Ah", "Kh"], board: [], street: "preflop",
      liveSeats: [2, 5], committed: {}, potByStreet: {}, positions: { 2: "CO", 5: "BB", 9: "BTN" },
      actions: [act(5, "post-bb", 1)], currentNode: { ...node(1), toActSeatId: 2 }, ended: false,
    });
    expect(hand.positions).toEqual({ 2: "SB", 5: "BB" });
  });
  test("left alone: a dealt button, an undealt seat that is not the button, a nine-seat vocabulary, a seat that acted", () => {
    const base = { handId: 7, clientHandId: "t", bbCents: 5, heroSeatId: 3, heroCards: ["Ah", "Kh"], board: [], street: "preflop",
      committed: {}, potByStreet: {}, currentNode: node(1), ended: false };
    const live = normalizeHand({ ...base, liveSeats: [1, 2, 3, 4, 5, 6], positions: { 5: "SB", 6: "BB", 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN" },
      actions: [act(5, "post-sb", 0.4), act(6, "post-bb", 1)] }).hand;
    expect(live.positions[3]).toBe("CO");
    expect(live.seatRelabel).toBeUndefined();
    const sitter = normalizeHand({ ...base, liveSeats: [1, 3, 4, 5, 6], positions: { 5: "SB", 6: "BB", 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN" },
      actions: [act(5, "post-sb", 0.4), act(6, "post-bb", 1)] }).hand;
    expect(sitter.positions[3]).toBe("CO");                 // the HJ label sat out: not this signature (dealtSeats drops it)
    const nine = normalizeHand({ ...base, liveSeats: [1, 2, 3, 5, 6], positions: { 5: "SB", 6: "BB", 1: "UTG1", 2: "LJ", 3: "CO", 4: "BTN" },
      actions: [act(5, "post-sb", 0.4), act(6, "post-bb", 1)] }).hand;
    expect(nine.positions[3]).toBe("CO");
    // a source that sends only the UNFOLDED seats: the BTN folded (an action) — dealt, not a dead button
    const folded = normalizeHand({ ...base, liveSeats: [3, 5, 6], positions: { 5: "SB", 6: "BB", 3: "CO", 4: "BTN" },
      actions: [act(5, "post-sb", 0.4), act(6, "post-bb", 1), act(4, "fold")] }).hand;
    expect(folded.positions).toEqual({ 5: "SB", 6: "BB", 3: "CO", 4: "BTN" });
  });
});

describe("#14: hero's label against the table's geometry", () => {
  const chart = (pos: string): FastSolveResult => ({
    ok: true, source: "hrc-6max-preflop", tier: "chart-6max", street: "preflop", setId: "6max", gametype: "ign200_6max_D100_s70_BB_o2_5", depth: 100,
    line: "F-F-F", pos, heroClass: "A6o", actions: [{ action: "Raise 2.5", frequency: 60 }, { action: "Fold", frequency: 40 }] as any, decision: null,
  });
  const roster = (labels: Record<number, string>) => normalizeHand({
    handId: 1, clientHandId: "4922296152", bbCents: 5, heroSeatId: 3, heroCards: ["As", "6h"], board: [], street: "preflop",
    liveSeats: [1, 3, 5, 6], committed: { 5: 0.4, 6: 1 }, potByStreet: {}, positions: labels,
    actions: [act(5, "post-sb", 0.4), act(6, "post-bb", 1), act(1, "fold")], currentNode: node(1), ended: false,
    roster: { dealer: 4, deadButton: true, deadSb: false, dealt: [1, 3, 5, 6],
      seats: { 1: { status: "dealt" }, 2: { status: "empty", word: "type 0 state 16" }, 3: { status: "dealt", hero: true },
               4: { status: "sitting-out", word: "type 1 state 32" }, 5: { status: "dealt", posted: "sb" }, 6: { status: "dealt", posted: "bb" } } },
  }).hand;
  test("the fixed wrapper's hand (labels and roster agree): pass, and the roster rides on the hand", () => {
    const h = roster({ 5: "SB", 6: "BB", 1: "CO", 3: "BTN" });
    expect(h.roster?.seats[4]).toEqual({ status: "sitting-out", word: "type 1 state 32" });
    expect(heroGeometry(h)).toEqual({ name: "BTN", dealtN: 4, dealer: 4, deadButton: true });
    const xs = decisionChecks(h, chart("BTN"), "live", 900, "BTN").filter((x) => x.id === 14);
    expect(xs.map((x) => x.status)).toEqual(["pass", "pass"]);
    expect(xs[1]!.text).toBe("hero's BTN is his name among the 4 seats dealt (button seat 4, not dealt — a dead button)");
  });
  test("labels that disagree with the roster's geometry fail — never 'clean' again", () => {
    // a label set no renaming touches (every labelled seat dealt) but one seat early: hero CO at the real button
    const h = roster({ 5: "SB", 6: "BB", 1: "HJ", 3: "CO" });
    const xs = decisionChecks(h, chart("CO"), "live", 900, "CO");
    const c14 = xs.filter((x) => x.id === 14);
    expect(c14.map((x) => x.status)).toEqual(["pass", "fail"]);   // the node is the label's (old #14 half) — the label is wrong
    expect(c14[1]!.text).toContain("hero is labelled CO but is the BTN among the 4 seats dealt (button seat 4, not dealt — a dead button)");
    expect(classifyPath({ street: "preflop", streets: [], checks: { preflop: xs } }).verdict).toBe("failed");
  });
  test("an old wrapper's hand renamed by normalizeHand passes and says where the name came from", () => {
    const { hand } = h4922296152();
    const c = decisionChecks(hand, chart("BTN"), "live", 900, "BTN").filter((x) => x.id === 14);
    expect(c.map((x) => x.status)).toEqual(["pass", "pass"]);
    expect(c[1]!.text).toContain("(the source labelled him CO; renamed from the seats dealt)");
  });
  test("a hand with nothing to place hero by adds no line to #14", () => {
    const { hand } = normalizeHand({
      handId: 9, clientHandId: "t", bbCents: 200, heroSeatId: 3, heroCards: ["As", "6h"], board: [], street: "preflop",
      liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { 5: "SB", 6: "BB", 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN" },
      actions: [act(5, "post-sb", 0.5), act(6, "post-bb", 1)], currentNode: node(1), ended: false,
    });
    expect(decisionChecks(hand, chart("CO"), "live", 900, "CO").filter((x) => x.id === 14)).toHaveLength(1);
  });
});

describe("the AI preflop answer's logged depth is hero's effective stack (hand 4922314840)", () => {
  // 2026-10-03: UTG folds, hero HJ (360bb) opens 2.6, CO and BTN (71bb) fold, the SB (173) 3-bets to 4.2, the BB folds.
  // The row read depth 71 — the folded button's stack, the tree's shortest; hero plays the SB at 173.
  const shape: AiPreflopShape = {
    n: 6, apiOf: { UTG: "UTG", HJ: "HJ", CO: "CO", BTN: "BTN", SB: "SB", BB: "BB" },
    seatOf: { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 }, positions: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
    stacks: { UTG: 170.5, HJ: 360, CO: 165, BTN: 71, SB: 173, BB: 98.5 }, sb: 0.5, bb: 1, straddle: null, rakeCapBb: 2,
    deadSb: false, deadBb: 0, heroApiPos: "HJ",
  };
  const hand = normalizeHand({
    handId: 1, clientHandId: "4922314840", bbCents: 200, heroSeatId: 2, heroCards: ["Td", "As"], board: [], street: "preflop",
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
    actions: [act(5, "post-sb", 0.5), act(6, "post-bb", 1), act(1, "fold"), act(2, "raise", 2.6, true), act(3, "fold"), act(4, "fold"),
              act(5, "raise", 4.2), act(6, "fold")],
    currentNode: { ...node(1.6), toActSeatId: 2 }, ended: false,
  }).hand;
  test("173, not the folded button's 71", () => {
    expect(aiHeroDepth(shape, hand, "HJ")).toBe(173);
  });
  test("first in, every villain still to act: hero against the deepest of them", () => {
    const first = { ...hand, actions: hand.actions.slice(0, 3) };
    expect(aiHeroDepth({ ...shape, heroApiPos: "CO" }, { ...first, heroSeatId: 3 }, "CO")).toBe(165);   // CO 165 < HJ 360
    expect(aiHeroDepth({ ...shape, heroApiPos: "BTN" }, { ...first, heroSeatId: 4 }, "BTN")).toBe(71);  // the short stack is hero
  });
});
