/**
 * THE TABLE'S MONEY, FROM THE CAPTURE TO THE CHECKS (2026-10-03, the postflop all-in fix): the all-in amounts beside
 * the tokens, each seat's stack the shove proves, the pot hero can win on both sides of check #5 (an uncalled excess is
 * not in it), the all-in compared like any wager in #6, and the flag the seatbelt reads.
 */
import { describe, expect, it } from "bun:test";
import { chainPathChecks, flopSeatStacks, postflopAllInAmounts } from "./fastSolve";
import { checkLine, checkPotStack, mergeChecks } from "./chainChecks";
import type { ChainTrace } from "./aiChain";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { buildSpotSolutionTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";

// hand 4922087007 (2026-10-02 18:38, NL5): UTG opens 3, HJ and CO call, hero BTN 3-bets to 10.6, HJ and CO call; flop
// 7sJd5s: HJ shoves his last 28, CO folds, hero (AcQc) to act
const RAW = {
  handId: 69, clientHandId: "4922087007", bbCents: 5, heroSeatId: 3, heroCards: ["A♣", "Q♣"], board: ["7♠", "J♦", "5♠"], street: "flop",
  liveSeats: [1, 2, 3, 4, 5, 6], committed: { 1: 28 }, potByStreet: {},
  positions: { 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB", 6: "UTG" },
  stacks: { 1: 0, 2: 113.2, 3: 97.8, 4: 115.4, 5: 110.6, 6: 132.6 },
  startStacks: { 1: 38.6, 2: 123.8, 3: 108.4, 4: 115.8, 5: 111.6, 6: 135.6 },
  currentNode: { street: "flop", toActSeatId: 3, toActIsHero: true, pot: 64.2, toCall: 28, legalActions: [], complete: false },
  actions: [
    { seatId: 4, hero: false, type: "post-sb", street: "preflop", amount: 0.4 },
    { seatId: 5, hero: false, type: "post-bb", street: "preflop", amount: 1 },
    { seatId: 6, hero: false, type: "raise", street: "preflop", amount: 3 },
    { seatId: 1, hero: false, type: "call", street: "preflop", amount: 3 },
    { seatId: 2, hero: false, type: "call", street: "preflop", amount: 3 },
    { seatId: 3, hero: true, type: "raise", street: "preflop", amount: 10.6 },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 5, hero: false, type: "fold", street: "preflop" },
    { seatId: 6, hero: false, type: "fold", street: "preflop" },
    { seatId: 1, hero: false, type: "call", street: "preflop", amount: 7.6 },
    { seatId: 2, hero: false, type: "call", street: "preflop", amount: 7.6 },
    { seatId: 1, hero: false, type: "all-in", street: "flop", amount: 28 },
    { seatId: 2, hero: false, type: "fold", street: "flop" },
  ],
  heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$0.03/$0.05",
};
const hand = () => normalizeHand(RAW as any).hand!;

describe("the all-in amounts travel beside the tokens (item 2)", () => {
  it("hand 4922087007: the flop's RAI carries 28, parallel to the tokens", () => {
    const h = hand();
    expect(buildSpotSolutionTokens(h, "BTN").flop).toEqual(["RAI", "F"]);   // the token itself stays GTO Wizard's literal
    expect(postflopAllInAmounts(h).flop).toEqual([28, null]);
  });
  it("an all-in that does not raise the price is a call (C), with no amount", () => {
    const h = hand();
    h.actions.push({ seatId: 3, hero: true, type: "all-in", street: "flop", amount: 28 } as any);
    expect(postflopAllInAmounts(h).flop).toEqual([28, null, null]);
  });
});

describe("the stack a shove proves (flopSeatStacks)", () => {
  it("a seat all-in on the turn for 20 after 8 on the flop had 28 entering the flop — the table's figure wins over a reading of 30", () => {
    const out = flopSeatStacks({ seats: ["HJ", "BTN"], depth: 100, flopStack: 90, dealtByPos: { HJ: 40, BTN: 100 },
      streets: [["R8", "C"], ["RAI"]], streetSeats: [["HJ", "BTN"], ["HJ"]], allIns: [{ pos: "HJ", k: 1, to: 20 }] });
    expect(out).toEqual({ HJ: 28, BTN: 90 });
  });
  it("a reading the shove agrees with is kept as read", () => {
    const out = flopSeatStacks({ seats: ["HJ", "BTN"], depth: 100, flopStack: 90, dealtByPos: { HJ: 38, BTN: 100 },
      streets: [["RAI"]], streetSeats: [["HJ"]], allIns: [{ pos: "HJ", k: 0, to: 28 }] });
    expect(out?.HJ).toBe(28);
  });
});

describe("check #6: an all-in is compared like any wager", () => {
  it("hand 4922087007 as it was walked: the 28 shove as the tree's 97.8 all-in fails", () => {
    const c = checkLine({ captured: ["AllIn(2800)", "Fold"], walked: [{ name: "ALLIN", betsize: 97.8 }, { name: "FOLD", betsize: null }] });
    expect(c.status).toBe("fail");
    expect(c.text).toContain("28bb bet at the table, walked as the tree's ALLIN 97.8bb");
  });
  it("…and as it is walked now", () => {
    expect(checkLine({ captured: ["AllIn(2800)", "Fold"], walked: [{ name: "ALLIN", betsize: 28 }, { name: "FOLD", betsize: null }] }).status).toBe("pass");
  });
});

describe("check #5 flags the POT for the seatbelt", () => {
  it("a pot that disagrees sets potOff; a stack that disagrees does not", () => {
    expect(checkPotStack({ street: "flop", potIn: 36.3, capturePot: 36.2, stackIn: 97.8, captureStack: 97.8, potNode: 134.1, captureNodePot: 64.2 }).potOff).toBe(true);
    const st = checkPotStack({ street: "flop", potIn: 36.3, capturePot: 36.2, stackIn: 60, captureStack: 97.8 });
    expect(st.status).toBe("fail");
    expect(st.potOff).toBeUndefined();
  });
  it("each seat's own stack sent is compared with the table's", () => {
    const c = checkPotStack({ street: "flop", potIn: 36.3, capturePot: 36.2, stackIn: 97.8, captureStack: 97.8, seatStacks: [{ pos: "HJ", tree: 97.8, table: 28 }] });
    expect(c.status).toBe("fail");
    expect(c.text).toContain("HJ 97.8bb (table 28bb)");
  });
  it("the flag survives the merge of a street's results", () => {
    const m = mergeChecks([{ id: 5, status: "pass", text: "a" }, { id: 5, status: "fail", text: "b", potOff: true }]);
    expect(m[0]!.potOff).toBe(true);
  });
});

describe("check #5's table side: the pot hero can win (an uncalled excess is not in it)", () => {
  // heads-up flop, both 100 deep entering it... the BB has 30: a 100bb shove into him is a 30bb bet in the pot hero can win
  const HU = {
    ...RAW, clientHandId: "4999000123", heroSeatId: 2, heroCards: ["A♣", "Q♣"],
    positions: { 1: "SB", 2: "BB" }, liveSeats: [1, 2], startStacks: { 1: 110, 2: 40 }, stacks: { 1: 0, 2: 30 },
    currentNode: { street: "flop", toActSeatId: 2, toActIsHero: true, pot: 120, toCall: 30, legalActions: [], complete: false },
    actions: [
      { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 },
      { seatId: 2, hero: true, type: "post-bb", street: "preflop", amount: 1 },
      { seatId: 1, hero: false, type: "raise", street: "preflop", amount: 10 },
      { seatId: 2, hero: true, type: "call", street: "preflop", amount: 9 },
      { seatId: 2, hero: true, type: "check", street: "flop" },
      { seatId: 1, hero: false, type: "all-in", street: "flop", amount: 100 },
    ],
  };
  it("the capture's pot at hero's node counts the 30 that can be matched, as the tree does", () => {
    const h = normalizeHand(HU as any).hand!;
    const trace: ChainTrace = {
      spec: { oopPos: "BB", ipPos: "SB", oopRange: [], ipRange: [], flopPot: 20, flopStack: 30, seatStacks: { BB: 30, SB: 100 }, board: "7sJd5s", streets: [["X", "RAI"]], heroSeat: "oop", heroComboIdx: null },
      streets: [{ si: 0, street: "FLOP", board: "7sJd5s", potIn: 20, stackIn: 30, labels: [], fixedLevels: null, solId: "s", created: false, oopIn: [], ipIn: [], players: ["BB", "SB"], stacksIn: { BB: 30, SB: 100 } }],
      nodes: [{ si: 0, ti: 2, street: "FLOP", board: "7sJd5s", codes: ["X", "R100"], actor: 0, potNode: 50, invested: [0, 100], actions: [], taken: null, heroNode: true }],
      result: { ok: true },
    };
    const c = chainPathChecks({ hand: h, walks: [{ kind: null, trace }], arrival: undefined, potExtra: 0, dealt: { 1: 110, 2: 40 },
      treePos: (sid) => (sid === 1 ? "SB" : "BB"), rake: null, site: null, handTrees: [] });
    const five = c.flop!.find((x) => x.id === 5)!;
    expect(five.status).toBe("pass");
    expect(five.text).toContain("50bb at hero's node");
    expect(five.text).toContain("BB 30 / SB 100");
  });
});
