import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { dropAnsweredNodes, forgetCheckpoints, solveAiChain, type AiChainSpec } from "./aiChain";
import { dropServed, recordServed, type ServedHero } from "./servedStrategy";
import { planDeadMoney } from "./deadMoneyCollapse";

/**
 * THE SERVED-MIX KEY ON A DEAD-MONEY PLAN THAT CUT THE STREET (2026-10-14, the answer-path audit's latent item 3 — code
 * reading, no stored trace carries a "(street cut)" plan: 27 dead-money rows in solves, none cut).
 *
 * The served mix of a hero decision is keyed (hand, street, hero's action number on it), "hero is never ghosted or
 * merged, so every plan's line holds his actions in the same order" (servedStrategy). A dead-money plan that CUTS the
 * street breaks that: replayKept drops the kept seats' actions before the cut and opens the line with a synthetic check
 * for each kept seat ahead of the reopening — hero's included. Counted from the line, hero's synthetic check was his
 * action 0 and his pending decision his action 1, while at the table he had already bet and called (actions 0 and 1,
 * the decision his 2nd).
 *
 * The fixture is deadMoneyCollapse.test's cut line: 4-way flop SB/HJ(hero)/CO/BTN, 100 behind each — SB checks, hero
 * bets 4, CO and BTN call, SB check-raises to 12, hero calls, CO calls, BTN raises to 30, SB calls; hero to act. The plan
 * keeping the CO is cut at the BTN's raise: "HJ:X CO:X BTN:R18" (12 each in the pot). What the line-count key did at
 * hero's synthetic check: looked up (flop, 0) — the mix he was served for his BET (decision A, menu Check / Bet 4) — and
 * narrowed him by its CHECK frequency; the record of this decision overwrote decision B's (both "action 1").
 */
const full = () => new Array(1326).fill(1);
const HERO = 7;                           // hero's combo index in the test
type Act = { code: string; name: string; betsize?: number };
type Node = { toAct: string; acts: Act[]; heroStrat?: Record<string, number> };
const strat = (nd: Node, a: Act) => { const s = new Array(1326).fill(1 / nd.acts.length); const v = nd.heroStrat?.[a.code]; if (v != null) s[HERO] = v; return s; };
const nodeJson = (nd: Node) => ({
  game: { players: [{ position: nd.toAct, is_hero: true }] },
  action_solutions: nd.acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: nd.toAct }, total_frequency: 0.5, total_ev: 0, strategy: strat(nd, a), evs: full() })),
});
const X: Act = { code: "X", name: "Check" }, F: Act = { code: "F", name: "Fold" };
const C = (b: number): Act => ({ code: "C", name: "Call", betsize: b });
const B = (b: number): Act => ({ code: `R${b}`, name: "Bet", betsize: b });
const R = (b: number): Act => ({ code: `R${b}`, name: "Raise", betsize: b });

function script(nodes: Record<string, Node>) {
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, peekNode: api.peekNode };
  const trees: any[] = [];
  api.ensureCustomSolution = async (input: any) => { trees.push(input); return { ok: true, solId: "sol-cut", created: true }; };
  const get = (q: any) => nodes[q.flopActions ?? ""];
  api.customNode = async (_solId: string, q: any) => { const nd = get(q); return nd ? { ok: true, data: nodeJson(nd), solveSecs: 0, cached: false } : { ok: false, status: 404, error: `unscripted ${JSON.stringify(q)}` }; };
  api.peekSolution = () => null;
  api.peekNode = (_solId: string, q: any) => { const nd = get(q); return nd ? nodeJson(nd) : null; };
  return { trees, restore: () => Object.assign(api, { ensureCustomSolution: saved.ensure, customNode: saved.node, peekSolution: saved.peek, peekNode: saved.peekNode }) };
}
let restore: (() => void) | null = null;
const HAND = "cut-served-test";
afterEach(() => { restore?.(); restore = null; forgetCheckpoints(HAND); dropAnsweredNodes(); dropServed(); });

/** a served mix as fastSolve records one: the menu and, per action, hero's combo at the given frequency */
const mix = (n: number, menu: { code: string; name: string; betsize: number | null; hero: number }[]): ServedHero => ({
  v: 1, k: 0, n, first: 0, plans: ["ghost:CO"], blended: false, solId: `sol-decision-${n}`,
  menu: menu.map(({ code, name, betsize }) => ({ code, name, betsize })),
  strategy: menu.map((m) => { const s = new Array(1326).fill(0.5); s[HERO] = m.hero; return s; }), src: "memory",
});
/** decision A (hero's bet: CHECK 0.2 / BET 0.8 for his hand) and decision B (his call of the 12: CALL 0.6) as served */
function servedSoFar() {
  recordServed(HAND, mix(0, [{ code: "X", name: "Check", betsize: null, hero: 0.2 }, { code: "R4", name: "Bet", betsize: 4, hero: 0.8 }]));
  recordServed(HAND, mix(1, [{ code: "F", name: "Fold", betsize: 0, hero: 0.1 }, { code: "C", name: "Call", betsize: 12, hero: 0.6 }, { code: "R30", name: "Raise", betsize: 30, hero: 0.3 }]));
}

const seats = ["SB", "HJ", "CO", "BTN"].map((pos) => ({ pos, range: full() }));
const line = (s: string) => s.split(" ").map((x) => { const [seat, tok] = x.split(":"); return { seat: seat!, tok: tok! }; });
const street = line("SB:X HJ:R4 CO:C BTN:C SB:R12 HJ:C CO:C BTN:R30 SB:C");

describe("the dead-money plan says which of its tokens are hero's real actions", () => {
  it("the cut plan: three synthetic-or-villain tokens, the decision hero's 3rd action; the plan without a cut: his bet is action 0, his call action 1", () => {
    const { plans } = planDeadMoney({ seats, heroPos: "HJ", street, behind: () => 100 });
    const cut = plans.find((p) => p.cuts > 0)!;
    expect(cut.kind).toContain("dead:SB (street cut)");
    expect(cut.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["HJ:X", "CO:X", "BTN:R18"]);
    expect(cut.heroActs).toEqual([null, null, null]);          // hero's X stands for no action of his
    expect(cut.heroDecisionN).toBe(2);                         // he bet, he called: the decision is his third
    const whole = plans.find((p) => p.cuts === 0)!;
    expect(whole.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "HJ:R4", "BTN:C", "SB:R12", "HJ:C", "BTN:R30", "SB:C"]);
    expect(whole.heroActs).toEqual([null, 0, null, null, 1, null, null]);
    expect(whole.heroDecisionN).toBe(2);
  });
});

describe("the walk on the cut plan", () => {
  // the cut plan's tree: HJ (hero, OOP) / CO / BTN, 88 behind each (100 less the 12 preloaded), the pot the street starts
  // with = 13 entering + 30 dead (the SB's) + 36 preloaded
  const nodes: Record<string, Node> = {
    "": { toAct: "HJ", acts: [X, B(30)], heroStrat: { X: 0.5, R30: 0.5 } },
    "X": { toAct: "CO", acts: [X, B(30)] },
    "X-X": { toAct: "BTN", acts: [X, B(18)] },
    "X-X-R18": { toAct: "HJ", acts: [F, C(18), R(60)] },
  };
  const spec = (over: Partial<AiChainSpec> = {}): AiChainSpec => ({
    oopPos: "HJ", midPos: "CO", ipPos: "BTN", oopRange: full(), midRange: full(), ipRange: full(),
    flopPot: 79, flopStack: 88, seatStacks: { HJ: 88, CO: 88, BTN: 88 }, board: "AdTc6d", heroSeat: "oop", heroComboIdx: HERO,
    streets: [["X", "X", "R18"]], streetSeats: [["HJ", "CO", "BTN"]], handKey: HAND, planTag: "dead:SB (street cut)",
    heroActionN: [[null, null, null]], heroDecisionN: 2, ...over,
  });

  it("hero's synthetic check is NOT narrowed by a served mix: this tree's own strategy, said so; the decision is recorded as his 3rd action", async () => {
    servedSoFar();
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(spec());
    if (!r.ok) throw new Error(r.why);
    expect(r.heroWeight).toBeCloseTo(0.5, 6);                  // the tree's CHECK for his hand, nothing of decision A's 0.2
    expect(r.heroAt).toEqual({ k: 0, n: 2 });                  // was { k: 0, n: 1 }: decision B's key, overwritten
    const h = r.trace.nodes.find((n) => n.ti === 0)!.heroAnswered!;
    expect(h.strategy).toBeNull();
    expect(h.miss).toContain("stands in for the street's cut");
    expect(r.retreeNotes?.join(" ")).toContain("NOT narrowed as answered: the check stands in for the street's cut");
  });

  it("WHAT THE LINE-COUNT KEY DID (the spec without heroActionN): the synthetic check matched decision A's mix and hero was narrowed by the CHECK frequency of the bet he made", async () => {
    servedSoFar();
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(spec({ heroActionN: undefined, heroDecisionN: undefined }));
    if (!r.ok) throw new Error(r.why);
    expect(r.heroWeight).toBeCloseTo(0.2, 6);                  // decision A's CHECK 0.2 — he bet there
    expect(r.heroAt).toEqual({ k: 0, n: 1 });                  // decision B's key
    const h = r.trace.nodes.find((n) => n.ti === 0)!.heroAnswered!;
    expect(h.src).toBe("served");
    expect(h.action).toBe("Check");
    expect(h.combo).toEqual({ answered: 0.2, tree: 0.5 });
  });

  it("a real hero token on a dead-money line keeps the served narrowing, keyed by its real number", async () => {
    servedSoFar();
    // the plan that keeps the SB (no cut): hero's bet is his action 0 (served A: BET 0.8), his call his action 1 (served B: CALL 0.6)
    const s = script({
      "": { toAct: "SB", acts: [X, B(4)] },
      "X": { toAct: "HJ", acts: [X, B(4)], heroStrat: { X: 0.5, R4: 0.5 } },
      "X-R4": { toAct: "BTN", acts: [F, C(4), R(12)] },
      "X-R4-C": { toAct: "SB", acts: [F, C(4), R(12)] },
      "X-R4-C-R12": { toAct: "HJ", acts: [F, C(12), R(30)], heroStrat: { C: 0.5 } },
      "X-R4-C-R12-C": { toAct: "BTN", acts: [F, C(12), R(30)] },
      "X-R4-C-R12-C-R30": { toAct: "SB", acts: [F, C(30), R(90)] },
      "X-R4-C-R12-C-R30-C": { toAct: "HJ", acts: [F, C(30), R(90)] },
    });
    restore = s.restore;
    const r = await solveAiChain(spec({
      oopPos: "SB", midPos: "HJ", ipPos: "BTN", heroSeat: "mid", flopPot: 25, flopStack: 100, seatStacks: { SB: 100, HJ: 100, BTN: 100 },
      streets: [["X", "R4", "C", "R12", "C", "R30", "C"]], streetSeats: [["SB", "HJ", "BTN", "SB", "HJ", "BTN", "SB"]], planTag: "dead:CO",
      heroActionN: [[null, 0, null, null, 1, null, null]], heroDecisionN: 2,
    }));
    if (!r.ok) throw new Error(r.why);
    expect(r.heroWeight).toBeCloseTo(0.8 * 0.6, 6);
    expect(r.heroAt).toEqual({ k: 0, n: 2 });
    expect(r.trace.nodes.filter((n) => n.heroAnswered?.strategy).map((n) => [n.ti, n.heroAnswered!.action])).toEqual([[1, "Bet"], [4, "Call"]]);
  });
});
