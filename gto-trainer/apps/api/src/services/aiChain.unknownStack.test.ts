import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { solveAiChain, type AiChainSpec } from "./aiChain";
import { flopSeatStacks, postflopAllInAmounts, postflopAllInCalls } from "./fastSolve";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * A SEAT WHOSE STACK IS NOT KNOWN GOES ALL IN FOR LESS (2026-10-14, the answer-path audit's latent item 4 — code reading,
 * no hand in 14 days). The chain gives a seat with no stack reading the tree's one stack, lifted to the street's largest
 * wager (`caps = behind ?? max(stack, seenTo)`), so that an unknown stack never makes a legal raise illegal.
 *
 *  - A SHOVE below the wager ("RAI" with the table's amount beside it): the chain fixes the actor's cap to the amount
 *    whether or not his stack was read ("the table's all-in is the seat's stack") — an all-in for less, a call for less,
 *    out of the rotation, the pot the table's. Proven here; nothing to fix.
 *  - An ALL-IN CALL for less: its token is "C" (an all-in for no more than the price is a call — buildSolutionUrl
 *    allInCalls) and no amount travels with it, so with his stack unknown the chain counted the call WHOLE: the pot over
 *    by the shortfall, the seat kept live with the tree's stack and acting on the later streets. The bound: the pot is
 *    over by (price − his stack) and one seat too many is modelled; the amount to call at hero's node is right.
 *    FIXED upstream: the all-in call proves his stack entering the flop as a shove does (postflopAllInCalls →
 *    flopSeatStacks), so the chain is sent it and caps his call. After the deal-stacks merge (723843c) every dealt seat
 *    normally has a stack as dealt; `behind` is still unknown for a seat the table never reported (the first hand on a
 *    socket, a seat the result frame had at 0) whose stack the screen could not read either (STACK NOT CONFIRMED
 *    "unreadable").
 */
const full = () => new Array(1326).fill(1);
const half = () => new Array(1326).fill(0.5);
type Act = { code: string; name: string; betsize?: number };
type Node = { toAct: string; acts: Act[] };
const nodeJson = (nd: Node) => ({
  game: { players: [{ position: nd.toAct, is_hero: true }] },
  action_solutions: nd.acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: nd.toAct }, total_frequency: 0.5, total_ev: 0, strategy: half(), evs: half() })),
});
const X: Act = { code: "X", name: "Check" }, F: Act = { code: "F", name: "Fold" };
const C = (b: number): Act => ({ code: "C", name: "Call", betsize: b });
const B = (b: number): Act => ({ code: `R${b}`, name: "Bet", betsize: b });
const AI = (b: number): Act => ({ code: `R${b}`, name: "ALLIN", betsize: b });

function script(nodes: Record<string, Node>) {
  const trees: any[] = [];
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, peekNode: api.peekNode };
  api.ensureCustomSolution = async (input: any) => { trees.push(input); return { ok: true, solId: "sol-flop", created: true }; };
  const get = (q: any) => nodes[q.flopActions ?? ""];
  api.customNode = async (_s: string, q: any) => { const nd = get(q); return nd ? { ok: true, data: nodeJson(nd), solveSecs: 0, cached: false } : { ok: false, status: 404, error: `unscripted ${JSON.stringify(q)}` }; };
  api.peekSolution = () => null;
  api.peekNode = (_s: string, q: any) => { const nd = get(q); return nd ? nodeJson(nd) : null; };
  return { trees, restore: () => Object.assign(api, { ensureCustomSolution: saved.ensure, customNode: saved.node, peekSolution: saved.peek, peekNode: saved.peekNode }) };
}
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

// HJ (OOP) bets 20 into 36.3, the CO is all in for 12, hero BTN (IP, 97.8) to act; the CO's stack was never read
const spec = (over: Partial<AiChainSpec> = {}): AiChainSpec => ({
  oopPos: "HJ", midPos: "CO", ipPos: "BTN", oopRange: full(), midRange: full(), ipRange: full(),
  flopPot: 36.3, flopStack: 97.8, seatStacks: { HJ: 100, BTN: 97.8 },
  board: "7sJd5s", heroSeat: "ip", heroComboIdx: null, streets: [["R20", "C"]], streetSeats: [["HJ", "CO"]], ...over,
});
const nodes = {
  "": { toAct: "HJ", acts: [X, B(20)] },
  "R20": { toAct: "CO", acts: [F, C(20), AI(12), AI(97.8)] },   // the scripted tree offers both reads of the CO's action
  "R20-C": { toAct: "BTN", acts: [F, C(20), B(60)] },
  "R20-R12": { toAct: "BTN", acts: [F, C(20), B(60)] },
};

describe("a shove below the wager by a seat with no stack reading (RAI + the table's amount)", () => {
  it("is his all-in for 12: the tree is sent his 12, the label is AllIn(1200), the pot is the table's 68.3, the answer says so", async () => {
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(spec({ streets: [["R20", "RAI"]], streetAmounts: [[null, 12]] }));
    if (!r.ok) throw new Error(r.why);
    expect(s.trees[0].stacks).toEqual([100, 12, 97.8]);        // not [100, 97.8, 97.8]
    expect(r.trace.streets[0]!.labels).toEqual(["Bet(2000)", "AllIn(1200)"]);
    expect(r.potNode).toBe(68.3);
    expect(r.stackNotes?.join(" ")).toContain("CO went all-in for 12bb");
  });
});

describe("an all-in CALL for less by a seat with no stack reading (a bare \"C\")", () => {
  it("THE BOUND: the chain cannot tell it from a call — the pot is over by the 8 shortfall and the CO keeps the tree's 97.8 behind", async () => {
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(spec());
    if (!r.ok) throw new Error(r.why);
    expect(s.trees[0].stacks).toEqual([100, 97.8, 97.8]);
    expect(r.trace.streets[0]!.labels).toEqual(["Bet(2000)", "Call"]);
    expect(r.potNode).toBe(76.3);                                // the table's 68.3 + the 8 he did not have
    expect(r.trace.streets[0]!.stacksIn).toEqual({ HJ: 100, CO: 97.8, BTN: 97.8 });
  });
  it("with his stack proven (the fix: the chain is sent 12) the call is for less: pot 68.3, the CO all in", async () => {
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(spec({ seatStacks: { HJ: 100, CO: 12, BTN: 97.8 } }));
    if (!r.ok) throw new Error(r.why);
    expect(s.trees[0].stacks).toEqual([100, 12, 97.8]);
    expect(r.trace.streets[0]!.labels).toEqual(["Bet(2000)", "Call"]);
    expect(r.potNode).toBe(68.3);
  });
});

describe("the all-in call proves the seat's stack (postflopAllInCalls → flopSeatStacks)", () => {
  const act = (seatId: number, type: string, street: string, amount?: number) => ({ seatId, hero: seatId === 4, type, street, ...(amount != null ? { amount } : {}) });
  // the hand: HJ (seat 2) raised 2.5, the CO (seat 3, stack unreadable) and hero BTN (seat 4) called; flop HJ bets 20,
  // the CO's all-in is 12 (his street total), hero to act
  const hand = {
    handId: 1, clientHandId: "unknown-stack", bbCents: 200, heroSeatId: 4, heroCards: ["Ac", "Kc"], board: ["7s", "Jd", "5s"], street: "flop",
    actions: [act(5, "post-sb", "preflop", 0.5), act(6, "post-bb", "preflop", 1), act(2, "raise", "preflop", 2.5), act(3, "call", "preflop", 2.5), act(4, "call", "preflop", 2.5),
      act(5, "fold", "preflop"), act(6, "fold", "preflop"), act(2, "bet", "flop", 20), act(3, "all-in", "flop", 12)],
    liveSeats: [2, 3, 4, 5, 6], committed: { 2: 20, 3: 12 }, potByStreet: { preflop: 9 }, positions: { 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
    stacks: { 2: 77.5, 4: 95.3, 5: 99.5, 6: 99 },
    currentNode: { street: "flop", toActSeatId: 4, toActIsHero: true, pot: 41, toCall: 20, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;

  it("the amount rides beside the \"C\" (postflopAllInCalls) and NOT among the shoves (postflopAllInAmounts, unchanged)", () => {
    expect(postflopAllInCalls(hand).flop).toEqual([null, 12]);
    expect(postflopAllInAmounts(hand).flop).toEqual([null, null]);
    // a shove above the price is the other list's
    const shove = { ...hand, actions: hand.actions.map((a) => (a.type === "all-in" ? { ...a, amount: 45 } : a)) } as unknown as ParsedHand;
    expect(postflopAllInAmounts(shove).flop).toEqual([null, 45]);
    expect(postflopAllInCalls(shove).flop).toEqual([null, null]);
  });

  it("flopSeatStacks: the CO, unread, enters the flop with exactly the 12 he called with; a read that disagrees gives way to it", () => {
    const base = { seats: ["HJ", "CO", "BTN"], depth: 100, flopStack: 95, dealtByPos: { HJ: 100, BTN: 97.8 }, streets: [["R20", "C"]], streetSeats: [["HJ", "CO"]],
      paidPre: { HJ: 2.5, CO: 2.5, BTN: 2.5 } };
    expect(flopSeatStacks(base)).toEqual({ HJ: 97.5, BTN: 95.3 });                             // the CO unknown: the chain's caps = max(stack, 20)
    expect(flopSeatStacks({ ...base, allIns: [{ pos: "CO", k: 0, to: 12 }] })).toEqual({ HJ: 97.5, CO: 12, BTN: 95.3 });
    expect(flopSeatStacks({ ...base, dealtByPos: { ...base.dealtByPos, CO: 30 }, allIns: [{ pos: "CO", k: 0, to: 12 }] })!.CO).toBe(12);
  });
});
