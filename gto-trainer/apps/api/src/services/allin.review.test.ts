/**
 * THE REVIEW OF THE POSTFLOP ALL-IN FIX (2026-10-03, audits/postflop-allin-fix-2026-10/review r1.ts / r2.ts): each
 * finding as a test.
 *  1. the seatbelt never costs an answer, and does not solve again when nothing derived was reused
 *  2. check #5's table side prices a plan that leaves seats out by the pot ITS seats can contest (the tree's rule)
 *  3. a street resumed mid-way is rebuilt with today's stack caps, not the checkpoint's
 *  4. three-way: a played all-in is its own seat's all-in, never a size for the other seats
 *  5a. an unknown stack never makes a legal raise illegal; 5b. an all-in matches only an all-in
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chainPathChecks, heroVsAggressor, runSeatbelt, type FastSolveResult } from "./fastSolve";
import { gtowApi, GtowApi } from "./gtowApi";
import { forgetCheckpoints, matchWalkAction, solveAiChain, StreetState, type AiChainSpec, type ChainTrace } from "./aiChain";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";

// ---- 1 ---------------------------------------------------------------------------------------------------------
const answer = (potOff: boolean, how: "first" | "hit" = "first"): { res: FastSolveResult; why: null } => ({
  why: null,
  res: { ok: true, source: "gtow-api-postflop", street: "flop", actions: [{ action: "Fold", frequency: 100 }], decision: null, warning: null,
    path: { v: 1, verdict: potOff ? "failed" : "clean", reasons: [], street: "flop", streets: [{ street: "flop", plan: null, how, tree: "cached" }],
      checks: { flop: [potOff ? { id: 5, status: "fail", text: "pot at hero's node 134.1bb, the capture's 64.2bb", potOff: true } : { id: 5, status: "pass", text: "ok" }] } } } as any,
});
describe("1. the seatbelt never costs an answer", () => {
  it("a pot that is off, nothing reused: served at once with the failure named — no second solve", async () => {
    let again = 0;
    const r = await runSeatbelt(answer(true), async () => { again++; return answer(true); });
    expect(again).toBe(0);
    expect(r.res?.ok).toBe(true);
    expect((r.res as any).warning).toContain("POT CHECK FAILED (#5): flop: pot at hero's node 134.1bb");
  });
  it("a pot that is off after a memo hit: solved again; still off → the second answer is SERVED, both pots named", async () => {
    let again = 0;
    const r = await runSeatbelt(answer(true, "hit"), async () => { again++; return answer(true); });
    expect(again).toBe(1);
    expect(r.res?.ok).toBe(true);
    expect((r.res as any).warning).toContain("POT CHECK FAILED (#5) TWICE");
    expect((r.res as any).path.checks.flop[0].status).toBe("fail");   // the check still fails loudly
  });
  it("the second solve agrees: served, saying so; the second solve gives nothing: the first is served", async () => {
    expect(((await runSeatbelt(answer(true, "hit"), async () => answer(false))).res as any).warning).toContain("the pot now agrees");
    const r = await runSeatbelt(answer(true, "hit"), async () => ({ res: null, why: "boom" } as any));
    expect(r.res?.ok).toBe(true);
    expect((r.res as any).warning).toContain("gave no answer, so this one is served");
  });
});

// ---- 2 ---------------------------------------------------------------------------------------------------------
// r2: 4-way flop pot 20; SB shoves 80, BB and CO (200 behind) call, hero BTN (60 behind) to act; the last resort plays
// hero against the SB — the pot hero can contest is 200 at his node, not the table's 260
describe("2. a plan that leaves seats out is priced by the pot its seats can contest", () => {
  const RAW = {
    handId: 1, clientHandId: "4999000902", bbCents: 200, heroSeatId: 4, heroCards: ["A♦", "K♦"], board: ["5♦", "6♦", "5♥"], street: "flop",
    liveSeats: [1, 2, 3, 4], committed: {}, potByStreet: {}, positions: { 1: "SB", 2: "BB", 3: "CO", 4: "BTN" }, stacks: {},
    startStacks: { 1: 85, 2: 205, 3: 205, 4: 65 },
    currentNode: { street: "flop", toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 80, legalActions: [], complete: false },
    actions: [
      { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
      { seatId: 3, hero: false, type: "raise", street: "preflop", amount: 5 }, { seatId: 4, hero: true, type: "call", street: "preflop", amount: 5 },
      { seatId: 1, hero: false, type: "call", street: "preflop", amount: 4.5 }, { seatId: 2, hero: false, type: "call", street: "preflop", amount: 4 },
      { seatId: 1, hero: false, type: "all-in", street: "flop", amount: 80 }, { seatId: 2, hero: false, type: "call", street: "flop", amount: 80 },
      { seatId: 3, hero: false, type: "call", street: "flop", amount: 80 },
    ],
    heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$1/$2",
  };
  it("r2: the last resort's tree pot 200 = the table's side under the plan's rule (it was 260: a false fail, then a refusal)", () => {
    const h = normalizeHand(RAW as any).hand!;
    const lr = heroVsAggressor({ ordered: ["SB", "BB", "CO", "BTN"], heroPos: "BTN", arr: () => [], streets: [["RAI", "C", "C"]], streetSeats: [["SB", "BB", "CO"]],
      flopPot: 20, flopStack: 60, allIn: new Set(["SB"]), behind: { SB: 80, BB: 200, CO: 200, BTN: 60 } })!;
    const tree = new StreetState(2, [lr.walkable.seatStacks!.SB!, lr.walkable.seatStacks!.BTN!]);
    tree.apply("AllIn", 80);
    const potNode = lr.pot + tree.matchedPotIn;
    expect(potNode).toBe(200);
    const trace: ChainTrace = {
      spec: { oopPos: "SB", ipPos: "BTN", oopRange: [], ipRange: [], flopPot: lr.pot, flopStack: 60, board: "5d6d5h", streets: [["RAI"]], heroSeat: "ip", heroComboIdx: null, planTag: lr.walkable.kind },
      streets: [{ si: 0, street: "FLOP", board: "5d6d5h", potIn: lr.pot, stackIn: 60, labels: [], fixedLevels: null, solId: "s", created: false, oopIn: [], ipIn: [], players: ["SB", "BTN"] }],
      nodes: [{ si: 0, ti: 1, street: "FLOP", board: "5d6d5h", codes: ["R80"], actor: 1, potNode, invested: [80, 0], actions: [], taken: null, heroNode: true }],
      result: { ok: true },
    };
    const c = chainPathChecks({ hand: h, walks: [{ kind: lr.walkable.kind, trace }], arrival: undefined, potExtra: 0, dealt: RAW.startStacks as any,
      treePos: (sid) => h.positions[sid] ?? null, rake: null, site: null, handTrees: [] });
    const five = c.flop!.find((x) => x.id === 5)!;
    expect(five.status).toBe("pass");
    expect(five.text).toContain("200bb at hero's node (the pot the tree's seats (SB/BTN) can contest)");
  });
});

describe("2b. r1 §2: a ghost plan (the ghosted SB 200 deep only checked)", () => {
  it("CO bets 100 into BB 40 / hero 30: the tree's 60 is the table's side under the plan's rule (it was 120)", () => {
    const RAW = {
      handId: 2, clientHandId: "4999000903", bbCents: 200, heroSeatId: 4, heroCards: ["A♦", "K♦"], board: ["5♦", "6♦", "5♥"], street: "flop",
      liveSeats: [1, 2, 3, 4], committed: {}, potByStreet: {}, positions: { 1: "SB", 2: "BB", 3: "CO", 4: "BTN" }, stacks: {},
      startStacks: { 1: 205, 2: 45, 3: 205, 4: 35 },
      currentNode: { street: "flop", toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 100, legalActions: [], complete: false },
      actions: [
        { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
        { seatId: 3, hero: false, type: "raise", street: "preflop", amount: 5 }, { seatId: 4, hero: true, type: "call", street: "preflop", amount: 5 },
        { seatId: 1, hero: false, type: "call", street: "preflop", amount: 4.5 }, { seatId: 2, hero: false, type: "call", street: "preflop", amount: 4 },
        { seatId: 1, hero: false, type: "check", street: "flop" }, { seatId: 2, hero: false, type: "check", street: "flop" },
        { seatId: 3, hero: false, type: "bet", street: "flop", amount: 100 },
      ],
      heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$1/$2",
    };
    const h = normalizeHand(RAW as any).hand!;
    const tree = new StreetState(3, [40, 200, 30]);
    tree.apply("Check"); tree.apply("Bet", 100);
    const potNode = 20 + tree.matchedPotIn;
    const trace: ChainTrace = {
      spec: { oopPos: "BB", midPos: "CO", ipPos: "BTN", oopRange: [], midRange: [], ipRange: [], flopPot: 20, flopStack: 30, board: "5d6d5h", streets: [["X", "R100"]], heroSeat: "ip", heroComboIdx: null, planTag: "ghost:SB" },
      streets: [{ si: 0, street: "FLOP", board: "5d6d5h", potIn: 20, stackIn: 30, labels: [], fixedLevels: null, solId: "s", created: false, oopIn: [], ipIn: [], players: ["BB", "CO", "BTN"] }],
      nodes: [{ si: 0, ti: 2, street: "FLOP", board: "5d6d5h", codes: ["X", "R100"], actor: 2, potNode, invested: [0, 100, 0], actions: [], taken: null, heroNode: true }],
      result: { ok: true },
    };
    const c = chainPathChecks({ hand: h, walks: [{ kind: "ghost:SB", trace }], arrival: undefined, potExtra: 0, dealt: RAW.startStacks as any,
      treePos: (sid) => h.positions[sid] ?? null, rake: null, site: null, handTrees: [] });
    const five = c.flop!.find((x) => x.id === 5)!;
    expect(potNode).toBe(60);
    expect(five.status).toBe("pass");
    expect(five.text).toContain("60bb at hero's node (the pot the tree's seats (BB/CO/BTN) can contest)");
  });
});

// ---- 3 ---------------------------------------------------------------------------------------------------------
const full = () => new Array(1326).fill(1);
const half = () => new Array(1326).fill(0.5);
type Act = { code: string; name: string; betsize?: number };
const nodeJson = (toAct: string, acts: Act[]) => ({ game: { players: [{ position: toAct, is_hero: true }] },
  action_solutions: acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: toAct }, total_frequency: 0.5, total_ev: 0, strategy: half(), evs: half() })) });
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });
function script(nodes: Record<string, [string, Act[]]>) {
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, peekNode: api.peekNode };
  const trees: any[] = [];
  api.ensureCustomSolution = async (input: any) => { trees.push(input); return { ok: true, solId: `sol-${input.startingStreet}${input.played ? "-pinned" : ""}`, created: true }; };
  const get = (solId: string, q: any) => nodes[`${solId}|${q.flopActions ?? q.turnActions ?? q.riverActions ?? ""}`];
  api.customNode = async (solId: string, q: any) => { const nd = get(solId, q); return nd ? { ok: true, data: nodeJson(...nd), solveSecs: 0, cached: false } : { ok: false, status: 404, error: `unscripted ${solId} ${JSON.stringify(q)}` }; };
  api.peekSolution = () => null;
  api.peekNode = () => null;
  restore = () => Object.assign(api, { ensureCustomSolution: saved.ensure, customNode: saved.node, peekSolution: saved.peek, peekNode: saved.peekNode });
  return trees;
}
const X: Act = { code: "X", name: "Check" }, F: Act = { code: "F", name: "Fold" };
describe("3. a resumed street is rebuilt with today's stack caps", () => {
  it("villain read at 25, hero bets 30, villain shoves 40: the shove proves 40, the resumed street reaches hero's node", async () => {
    forgetCheckpoints("hand-resume-caps");
    script({
      "sol-FLOP|": ["BB", [X, { code: "R10", name: "Bet", betsize: 10 }]],
      "sol-FLOP|X": ["BTN", [X, { code: "R30", name: "Bet", betsize: 30 }]],
      "sol-FLOP-pinned|X": ["BTN", [X, { code: "R30", name: "Bet", betsize: 30 }]],
      "sol-FLOP-pinned|X-R30": ["BB", [F, { code: "C", name: "Call", betsize: 30 }, { code: "R40", name: "ALLIN", betsize: 40 }]],
      "sol-FLOP-pinned|X-R30-R40": ["BTN", [F, { code: "C", name: "Call", betsize: 40 }]],
    });
    const spec = (streets: string[][], amounts?: (number | null)[][]): AiChainSpec => ({ oopPos: "BB", ipPos: "BTN", oopRange: full(), ipRange: full(), flopPot: 10, flopStack: 25,
      seatStacks: { BB: 25, BTN: 100 }, board: "Ts7h2d", heroSeat: "ip", heroComboIdx: null, streets, streetSeats: [["BB", "BTN", "BB"].slice(0, streets[0]!.length)], handKey: "hand-resume-caps",
      ...(amounts ? { streetAmounts: amounts } : {}) });
    expect((await solveAiChain(spec([["X"]]))).ok).toBe(true);
    const r = await solveAiChain(spec([["X", "R30", "RAI"]], [[null, null, 40]]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trace.streets[0]!.resumedAt).toBe(1);
    expect(r.potNode).toBe(80);   // 10 + 30 + 40: hero faces the 40 shove (stale caps: a 25 call, the street closed)
  });
});

// ---- 4 ---------------------------------------------------------------------------------------------------------
describe("4. a played all-in is its own seat's all-in, never a size for the others", () => {
  const api = new GtowApi();
  const R = full();
  const body = (input: any) => api.buildCustomTree({ board: "AsKd2c", oopRange: R, ipRange: R, oopPos: "BB", ipPos: "BTN", mid: { pos: "CO", range: R }, ...input });
  const flop = (b: any) => b.bet_sizes.street_bet_sizes[0].position_bet_sizes;
  it("A bets 10, B all-in for 12 (less than a raise): the deep seats raise by the base list, not to 12", () => {
    const s = flop(body({ pot: 20, stack: 100, stacks: [100, 12, 100], played: { FLOP: [{ seat: 0, to: 10 }, { seat: 1, to: 12 }] } }));
    expect(s[0].raise_sizes).toEqual(["60%", "100bb"]);
    expect(s[2].raise_sizes).toEqual(["60%", "100bb"]);
    expect(s[1].raise_sizes).toEqual(["12bb"]);          // B's own all-in
    expect(s[0].bet_sizes).toEqual(["10bb", "100bb"]);   // A's 10 was a bet, not an all-in: every seat's bet level
  });
  it("a 0.6bb all-in bet is no bet size for a 100bb seat: they get the base bet list", () => {
    const s = flop(body({ pot: 20, stack: 100, stacks: [100, 0.6, 100], played: { FLOP: [{ seat: 1, to: 0.6 }] } }));
    expect(s[0].bet_sizes).toEqual(["33%", "75%", "100bb"]);
    expect(s[1].bet_sizes).toEqual(["0.6bb"]);
  });
});

// ---- 5 ---------------------------------------------------------------------------------------------------------
describe("5a. an unknown stack never makes a legal raise illegal", () => {
  it("BTN's stack unknown, the tree's one stack 20: BB bets 30, BTN raises to 50 — walked, the BTN's cap lifted to 50", async () => {
    const trees = script({
      "sol-FLOP-pinned|": ["BB", [X, { code: "R30", name: "Bet", betsize: 30 }]],
      "sol-FLOP-pinned|R30": ["BTN", [F, { code: "C", name: "Call", betsize: 30 }, { code: "R50", name: "Raise", betsize: 50 }]],
      "sol-FLOP-pinned|R30-R50": ["BB", [F, { code: "C", name: "Call", betsize: 50 }]],
    });
    const r = await solveAiChain({ oopPos: "BB", ipPos: "BTN", oopRange: full(), ipRange: full(), flopPot: 10, flopStack: 20, seatStacks: { BB: 100 },
      board: "Ts7h2d", heroSeat: "oop", heroComboIdx: null, streets: [["R30", "R50"]], streetSeats: [["BB", "BTN"]] });
    expect(r.ok).toBe(true);
    expect(trees[0].stacks).toEqual([100, 50]);
  });
});
describe("5b. an all-in matches only an all-in", () => {
  it("a 40 shove is not the tree's 39 bet with chips behind it", () => {
    const sols = [{ action: { code: "X", display_name: "CHECK" } }, { action: { code: "R39", display_name: "BET", betsize: 39 } }, { action: { code: "R100", display_name: "ALLIN", betsize: 100 } }];
    expect(matchWalkAction("AllIn(4000)", sols, 100)).toBe(2);   // the node's one all-in, never the 39 bet
    expect(matchWalkAction("AllIn(4000)", sols.slice(0, 2), 100)).toBe(-1);
    expect(matchWalkAction("Bet(3900)", sols, 100)).toBe(1);
  });
});
