import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { actorsOfTokens, coveringAllIns, matchWalkAction, playedOf, solveAiChain, StreetState, type AiChainSpec } from "./aiChain";
import { wagerLabelForWalk } from "../utils/aiChainTokens/aiChainTokens";
import { planCollapses } from "./multiwayCollapse";

/**
 * THE CHAIN WALKS THE TABLE'S MONEY (2026-10-03). Fixtures are the logged hands: 4922087007 (three-way flop, HJ shoves
 * 28 with CO 113.2 and hero BTN 97.8 behind — walked as a 97.8 all-in, pot 134.1 against the table's 64.2) and
 * 4921655625 (heads-up river, BB bets 18.8 with 26.2 behind — walked as ALLIN 26.2). A scripted GTO Wizard answers the
 * nodes; it names each node's seat and offers the actions the line needs, as the real API does.
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

function script(nodes: Record<string, Node>, opts: { peek?: (input: any) => string | null } = {}) {
  const trees: any[] = [];
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, peekNode: api.peekNode };
  api.ensureCustomSolution = async (input: any) => { trees.push(input); return { ok: true, solId: `sol-${input.startingStreet}${input.played ? "-pinned" : ""}`, created: true }; };
  const get = (solId: string, q: any) => nodes[`${solId}|${q.flopActions ?? q.turnActions ?? q.riverActions ?? ""}`];
  api.customNode = async (solId: string, q: any) => { const nd = get(solId, q); return nd ? { ok: true, data: nodeJson(nd), solveSecs: 0, cached: false } : { ok: false, status: 404, error: `unscripted ${solId}|${JSON.stringify(q)}` }; };
  api.peekSolution = opts.peek ?? (() => null);
  api.peekNode = (solId: string, q: any) => { const nd = get(solId, q); return nd ? nodeJson(nd) : null; };
  return { trees, restore: () => Object.assign(api, { ensureCustomSolution: saved.ensure, customNode: saved.node, peekSolution: saved.peek, peekNode: saved.peekNode }) };
}
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

// hand 4922087007: HJ (OOP) / CO (OOP+1) / BTN (IP, hero), pot 36.3 entering the flop
const hand4922087007 = (over: Partial<AiChainSpec> = {}): AiChainSpec => ({
  oopPos: "HJ", midPos: "CO", ipPos: "BTN", oopRange: full(), midRange: full(), ipRange: full(),
  flopPot: 36.3, flopStack: 97.8, seatStacks: { HJ: 28, CO: 113.2, BTN: 97.8 },
  board: "7sJd5s", heroSeat: "ip", heroComboIdx: null, streets: [["RAI", "F"]], streetSeats: [["HJ", "CO"]], ...over,
});

describe("hand 4922087007: the 28bb shove is a 28bb shove (items 1, 2)", () => {
  const nodes = {
    "sol-FLOP-pinned|": { toAct: "HJ", acts: [X, AI(28)] },
    "sol-FLOP-pinned|R28": { toAct: "CO", acts: [F, C(28), AI(113.2)] },
    "sol-FLOP-pinned|R28-F": { toAct: "BTN", acts: [F, C(28)] },
  };
  it("each seat its own stack in the tree, the all-in at the table's amount, the pot at hero's node the table's 64.3", async () => {
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(hand4922087007({ streetAmounts: [[28, null]] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(s.trees[0].stacks).toEqual([28, 113.2, 97.8]);                  // was 97.8 for every seat
    expect(s.trees[0].played).toEqual({ FLOP: [{ seat: 0, to: 28 }] });   // was "269.4%" of the pot
    expect(r.trace.streets[0]!.labels).toEqual(["AllIn(2800)", "Fold"]);  // was AllIn(9780)
    expect(r.potNode).toBe(64.3);                                          // was 134.1
    expect(r.trace.streets[0]!.stacksIn).toEqual({ HJ: 28, CO: 113.2, BTN: 97.8 });
  });
  it("without the amount beside the token, an all-in is still the ACTOR's all-in (his own stack), never the tree's", async () => {
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(hand4922087007());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.trace.streets[0]!.labels[0]).toBe("AllIn(2800)");
  });
  it("the table's all-in proves the seat's stack: a reading of 30 for a 28 shove sends the tree 28", async () => {
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(hand4922087007({ seatStacks: { HJ: 30, CO: 113.2, BTN: 97.8 }, streetAmounts: [[28, null]] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(s.trees[0].stacks[0]).toBe(28);
    expect(r.stackNotes?.join(" ")).toContain("HJ went all-in for 28bb");
  });
});

describe("an all-in player leaves the later streets (item 9)", () => {
  it("HJ shoves 28, CO and hero call: the turn tree is heads-up CO vs hero at their own stacks, the 120.3 pot in the middle", async () => {
    const s = script({
      "sol-FLOP-pinned|": { toAct: "HJ", acts: [X, AI(28)] },
      "sol-FLOP-pinned|R28": { toAct: "CO", acts: [F, C(28)] },
      "sol-FLOP-pinned|R28-C": { toAct: "BTN", acts: [F, C(28)] },
      "sol-TURN|": { toAct: "CO", acts: [X, B(40)] },
      "sol-TURN|X": { toAct: "BTN", acts: [X, B(40)] },
    });
    restore = s.restore;
    const r = await solveAiChain(hand4922087007({ board: "7sJd5s2c", streets: [["RAI", "C", "C"], ["X"]], streetSeats: [["HJ", "CO", "BTN"], ["CO"]], streetAmounts: [[28, null, null], [null]] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const turn = s.trees.find((t) => t.startingStreet === "TURN");
    expect(turn.mid).toBeUndefined();                                // HJ is gone: a two-seat tree
    expect([turn.oopPos, turn.ipPos]).toEqual(["CO", "BTN"]);
    expect(turn.stacks).toEqual([85.2, 69.8]);
    expect(turn.pot).toBe(120.3);
    expect(r.stackNotes?.join(" ")).toContain("HJ all-in — left out of the tree");
  });
  it("everyone else all-in: no decision", async () => {
    const s = script({
      "sol-FLOP-pinned|": { toAct: "HJ", acts: [X, AI(28)] },
      "sol-FLOP-pinned|R28": { toAct: "CO", acts: [F, C(28)] },
      "sol-FLOP-pinned|R28-F": { toAct: "BTN", acts: [F, C(28)] },
    });
    restore = s.restore;
    const r = await solveAiChain(hand4922087007({ board: "7sJd5s2c", streets: [["RAI", "F", "C"], []], streetSeats: [["HJ", "CO", "BTN"], []] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("every other player still in is all-in");
  });
});

describe("no 60%-of-the-stack all-in rule in the walk (items 4, 5)", () => {
  // hand 4921655625's river: BB (OOP) 26.2 behind bets 18.8 into 19.6; SB (hero) 152 behind. The size-free river tree
  // offered only CHECK / ALLIN 26.2 — the old walk took the 18.8 as that all-in.
  const spec: AiChainSpec = { oopPos: "BB", ipPos: "SB", oopRange: full(), ipRange: full(), flopPot: 19.6, flopStack: 26.2,
    seatStacks: { BB: 26.2, SB: 152 }, board: "4sJh9d7h5h", firstStreet: 2, heroSeat: "ip", heroComboIdx: null, streets: [["R18.8"]], streetSeats: [["BB"]] };
  it("the 18.8 is pinned as 18.8 (a tree of its own), hero faces 18.8 into 19.6", async () => {
    const s = script({
      "sol-RIVER|": { toAct: "BB", acts: [X, AI(26.2)] },
      "sol-RIVER-pinned|": { toAct: "BB", acts: [X, B(18.8), AI(26.2)] },
      "sol-RIVER-pinned|R18.8": { toAct: "SB", acts: [F, C(18.8), AI(152)] },
    }, { peek: (input) => (input.played ? null : "sol-RIVER") });
    restore = s.restore;
    const r = await solveAiChain(spec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trace.streets[0]!.reuse).toContain("not reusable");
    expect(s.trees[0].played).toEqual({ RIVER: [{ seat: 0, to: 18.8 }] });
    expect(r.trace.streets[0]!.labels).toEqual(["Bet(1880)"]);
    expect(r.potNode).toBe(38.4);   // the table's: 19.6 + 18.8 (was 45.8)
  });
});

describe("the street's money, seat by seat (StreetState with each seat's stack)", () => {
  it("an all-in seat is skipped by the rotation and a raise does not re-open him", () => {
    // HJ shoves 28, CO raises to 60, BTN shoves 97.8, CO to act — HJ never acts again
    expect(actorsOfTokens(["RAI", "R60", "RAI", "C"], 3, [28, 113.2, 97.8], [28, null, 97.8, null])).toEqual([0, 1, 2, 1]);
  });
  it("HJ (28) calls a 50 bet all-in for 28; the street closes when the deep two have matched", () => {
    const st = new StreetState(3, [28, 113.2, 97.8]);
    st.apply("Check");            // HJ
    st.apply("Bet", 50);          // CO
    st.apply("Call");             // BTN
    st.apply("Call");             // HJ, all-in for 28
    expect(st.inv).toEqual([28, 50, 50]);
    expect(st.closed).toBe(true);
  });
  it("an uncalled excess is not in the pot hero can win: a 150 shove into 50 behind matches 50", () => {
    const st = new StreetState(2, [150, 50]);
    st.apply("AllIn", 150);
    expect(st.matched(0)).toBe(50);
    expect(st.matchedPotIn).toBe(50);
  });
  it("the RAI label is the table's amount, capped at the actor's stack", () => {
    const caps = [28, 113.2, 97.8];
    const ta = actorsOfTokens(["RAI", "F"], 3, caps, [28]);
    expect(wagerLabelForWalk(["RAI", "F"], 97.8, (i) => Math.min([28][i] ?? Infinity, caps[ta[i]!]!))).toEqual(["AllIn(2800)", "Fold"]);
    expect(wagerLabelForWalk(["RAI"], 97.8, () => 40)).toEqual(["AllIn(4000)"]);
  });
  it("a wager that covers every other stack still in is the actor's all-in; one that does not stays a bet", () => {
    expect(coveringAllIns(["Bet(6000)"], 2, [150, 50]).labels).toEqual(["AllIn(15000)"]);
    expect(coveringAllIns(["Bet(940)"], 2, [14.2, 89.6]).labels).toEqual(["Bet(940)"]);       // 66% of his stack: a bet
    expect(coveringAllIns(["Bet(1420)"], 2, [14.2, 89.6]).labels).toEqual(["AllIn(1420)"]);   // his whole stack
  });
  it("an all-in label takes the node's all-in when it is the only one (the actor's all-in, whatever stack the tree has)", () => {
    const sols = [{ action: { code: "X", display_name: "CHECK" } }, { action: { code: "R30", display_name: "ALLIN", betsize: 30 } }];
    expect(matchWalkAction("AllIn(2800)", sols, 30)).toBe(1);
    expect(matchWalkAction("Bet(1800)", sols, 30)).toBe(-1);
  });
  it("the wagers played, with their seats", () => {
    expect(playedOf(["Check", "Bet(860)", "Raise(2500)", "Call"], [0, 1, 0, 1])).toEqual([{ seat: 1, to: 8.6 }, { seat: 0, to: 25 }]);
  });
});

describe("an all-in seat is never merged (item 9, multiwayCollapse)", () => {
  it("SB shoves, BB calls, CO and hero to act: no plan merges SB with BB", () => {
    const seats = ["SB", "BB", "CO", "BTN"].map((pos) => ({ pos, range: full() }));
    const plans = planCollapses(seats, "BTN", [[{ tok: "RAI", seat: "SB" }, { tok: "C", seat: "BB" }, { tok: "C", seat: "CO" }]]);
    expect(plans.some((p) => /merge:SB\+BB/.test(p.kind))).toBe(false);
  });
});
