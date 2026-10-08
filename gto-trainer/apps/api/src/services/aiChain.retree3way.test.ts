/**
 * RETREE CONSISTENCY, THREE-WAY (Brady 2026-10-08: "do the 3-way too"). Stress core-srp-3way-003's flop from its stored
 * solves (core store 7579 / 7580, fixture __fixtures__/retreeCoreSrp3way003.json): BB (hero) / HJ / BTN on 3dTc8h, pot 8,
 * everyone 101.7 behind. Tree A = the 3-way base tree (33% / 75% | 60% + each seat's all-in): hero checks (his hand 99.21%),
 * the HJ bets 4 (A offers 2.6 / 6), the BTN folds. Before: tree B was the 4bb ALONE on every seat — hero's own bet menu
 * became [4bb] — and his check was narrowed by B. Now: B = A's lists for every seat, the HJ's with his 4 added, and hero's
 * check narrowed by the strategy he was answered with.
 */
import { afterEach, describe, expect, it } from "bun:test";
import fxJson from "./__fixtures__/retreeCoreSrp3way003.json";
import { gtowApi, type CustomTreeInput } from "./gtowApi";
import { dropAnsweredNodes, forgetCheckpoints, solveAiChain, type AiChainSpec } from "./aiChain";

interface Fixture {
  heroComboIdx: number; board: string; pot: number; stack: number; rake: { pct_of_pot: number; cap_in_chips: number; preflop_rake_type: string | null };
  players: string[]; rangesIn: Record<string, number>[]; sentA: any[]; sentB: any[]; nodes: Record<string, unknown>;
}
const fx = fxJson as unknown as Fixture;
const dense = (sp: Record<string, number>): number[] => { const a = new Array(1326).fill(0); for (const [k, v] of Object.entries(sp)) a[Number(k)] = v; return a; };
type FxNode = { toAct: string; actions: { code: string; name: string; betsize: number; betsize_by_pot?: number | null; allin?: boolean; strategy: Record<string, number> }[] };
const nodeJson = (nd: FxNode) => ({
  game: { players: [{ position: nd.toAct, is_hero: true }] },
  action_solutions: nd.actions.map((a) => ({
    action: { code: a.code, display_name: a.name, betsize: a.betsize ? String(a.betsize) : "0", betsize_by_pot: a.betsize_by_pot ?? null, allin: !!a.allin, position: nd.toAct },
    total_frequency: 0.5, total_ev: 0, strategy: dense(a.strategy), evs: new Array(1326).fill(0),
  })),
});
const NODES = fx.nodes as unknown as Record<string, FxNode>;
const HERO = fx.heroComboIdx;

function script() {
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peekSol: api.peekSolution, peekNode: api.peekNode };
  const trees: CustomTreeInput[] = [];
  const solOf = (input: CustomTreeInput) => (input.played?.FLOP?.length ? "B" : "A");
  const nodeOf = (sol: string, q: any) => { const nd = NODES[`${sol}|${q.flopActions ?? ""}`]; return nd ? nodeJson(nd) : null; };
  api.ensureCustomSolution = async (input: CustomTreeInput) => { trees.push(input); return { ok: true, solId: solOf(input), created: true, session: "primary" }; };
  api.customNode = async (sol: string, q: any) => { const d = nodeOf(sol, q); return d ? { ok: true, data: d, solveSecs: 0, cached: false } : { ok: false, status: 404, error: `unscripted ${sol}|${q.flopActions}` }; };
  api.peekSolution = (input: CustomTreeInput) => (input.played?.FLOP?.length ? null : "A");
  api.peekNode = (sol: string, q: any) => (sol === "A" ? nodeOf(sol, q) : null);
  return { trees, restore: () => { api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; api.peekSolution = saved.peekSol; api.peekNode = saved.peekNode; } };
}

const HAND = "core-srp-3way-003-retree-test";
const spec = (streets: string[][]): AiChainSpec => ({
  oopPos: "BB", midPos: "HJ", ipPos: "BTN", oopRange: dense(fx.rangesIn[0]!), midRange: dense(fx.rangesIn[1]!), ipRange: dense(fx.rangesIn[2]!),
  flopPot: fx.pot, flopStack: fx.stack, seatStacks: { BB: fx.stack, HJ: fx.stack, BTN: fx.stack },
  board: fx.board, streets, heroSeat: "oop", heroComboIdx: HERO, rake: fx.rake, handKey: HAND,
});
const flopEntry = (input: CustomTreeInput) => (gtowApi.buildCustomTree(input).bet_sizes.street_bet_sizes as any[]).find((s) => s.street === "FLOP").position_bet_sizes;
const ALL = "101.7bb";
const BASE = { bet_sizes: ["33%", "75%", ALL], raise_sizes: ["60%", ALL], second_raise_sizes: ["60%", ALL], third_plus_raise_sizes: ["60%", ALL] };

let restore: (() => void) | null = null;
const envBefore = process.env.HERO_STREET_AS_ANSWERED;
afterEach(() => {
  restore?.(); restore = null;
  forgetCheckpoints(HAND); dropAnsweredNodes();
  if (envBefore == null) delete process.env.HERO_STREET_AS_ANSWERED; else process.env.HERO_STREET_AS_ANSWERED = envBefore;
});

async function twoDecisions(second: string[]) {
  const s = script();
  restore = s.restore;
  const first = await solveAiChain(spec([[]]));
  if (!first.ok) throw new Error(first.why);
  const r = await solveAiChain(spec([second]));
  return { s, first, second: r };
}

describe("core-srp-3way-003: a three-way re-tree carries every seat's menu", () => {
  it("tree A as stored is the base 3-way tree (33/75 | 60, each seat's all-in)", () => {
    for (const p of fx.sentA[0].position_bet_sizes) expect(p).toMatchObject(BASE);
    // …and the stored tree B is the old pin: the 4bb ALONE on every seat
    for (const p of fx.sentB[0].position_bet_sizes) expect(p.bet_sizes).toEqual(["4bb", ALL]);
  });

  it("tree B = A's lists for every seat on the street and the streets after; the HJ's bet list gains his 4", async () => {
    const { s, second } = await twoDecisions(["X", "R4", "F"]);
    if (!second.ok) throw new Error(second.why);
    const b = s.trees.find((t) => t.played?.FLOP?.length)!;
    expect(b.played!.FLOP).toEqual([{ seat: 1, to: 4 }]);
    const [bb, hj, btn] = flopEntry(b);
    expect(bb).toMatchObject({ type: "FIXED", ...BASE });
    expect(hj).toMatchObject({ type: "FIXED", ...BASE, bet_sizes: ["33%", "75%", "4bb", ALL] });
    expect(btn).toMatchObject({ type: "FIXED", ...BASE });
    // the turn and river: the base lists, exactly as tree A sent them
    const body = gtowApi.buildCustomTree(b).bet_sizes.street_bet_sizes as any[];
    const bodyA = gtowApi.buildCustomTree(s.trees[0]!).bet_sizes.street_bet_sizes as any[];
    expect(body.filter((x) => x.street !== "FLOP")).toEqual(bodyA.filter((x) => x.street !== "FLOP"));
    expect(second.trace.streets[0]!.retree).toMatchObject({ from: "A", seats: ["sent", "sent", "sent"], added: { seat: 1, to: 4 } });
    expect(second.retreeNotes?.[0]).toBe("RE-TREE: flop re-solved with HJ's 4bb added; menus carried from tree #A; hero's CHECK narrowed by his answered strategy (his hand 0.9921 on the tree he was answered on, 0.9926 on this one)");
  });

  it("hero's weight at his facing node comes from his answered check (0.6793 x 0.9921)", async () => {
    const { second } = await twoDecisions(["X", "R4", "F"]);
    if (!second.ok) throw new Error(second.why);
    expect(second.heroWeight!).toBeCloseTo(0.6793 * 0.9921, 4);
    expect(second.trace.nodes.find((n) => n.heroAnswered)!.heroAnswered).toMatchObject({ solId: "A", action: "CHECK" });
    expect(second.trace.streets[0]!.checks!.find((c) => c.id === 17)!.status).toBe("pass");
  });

  it("a three-way street whose sizes are all on the menu: no re-tree, the request byte-identical to the answered tree's", async () => {
    // the HJ bets A's own 2.6: the size-free tree is walked (its X-R2.6 node is not scripted, so the walk stops there —
    // what matters is the tree asked for)
    const { s } = await twoDecisions(["X", "R2.6"]);
    expect(s.trees.length).toBe(2);
    expect(s.trees.some((t) => t.played || t.carry)).toBe(false);
    expect(JSON.stringify(gtowApi.buildCustomTree(s.trees[1]!))).toBe(JSON.stringify(gtowApi.buildCustomTree(s.trees[0]!)));
  });

  it("switch off = today: the 4bb alone on every seat, no carry", async () => {
    process.env.HERO_STREET_AS_ANSWERED = "off";
    const { s } = await twoDecisions(["X", "R4", "F"]);
    const b = s.trees.find((t) => t.played?.FLOP?.length)!;
    expect(b.carry).toBeUndefined();
    for (const p of flopEntry(b)) expect(p.bet_sizes).toEqual(["4bb", ALL]);
    expect(JSON.stringify(flopEntry(b))).toBe(JSON.stringify(fx.sentB[0].position_bet_sizes));
  });
});
