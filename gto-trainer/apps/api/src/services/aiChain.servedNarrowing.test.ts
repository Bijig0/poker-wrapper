/**
 * SERVED-STRATEGY NARROWING (2026-10-08). Live answer 11381 (hand 4922298483, solves 5926 / 5927 / 5928; fixture
 * __fixtures__/servedNarrowing11381.json, the turn of the three traces): 4-way turn 2c7hJh9c, hero SB 2d2h. He checks
 * (answer 11378, plan merge:CO+BTN, tree M0), the CO bets 18, the BTN calls, he RAISES to 73.1 (answer 11380, merge:CO+BTN,
 * tree M1: RAISE 71.3% for 2d2h); the CO shoves 92.8, the BTN calls and the decision (11381) can only be solved on plan
 * ghost:BTN (tree G). No ghost:BTN node answered his check or his raise: before, both were narrowed by G's strategy (CHECK
 * 0.39%, RAISE 13.7%) and hero was absent at his node; now by the mix he was served for each (0.1026, 0.7129).
 */
import { afterEach, describe, expect, it } from "bun:test";
import fxJson from "./__fixtures__/servedNarrowing11381.json";
import { gtowApi, type CustomTreeInput } from "./gtowApi";
import { dropAnsweredNodes, forgetCheckpoints, solveAiChain, type AiChainResult, type AiChainSpec } from "./aiChain";
import { blendWalks, dropServed, heroAtOfTrace, recordServed, runsOf, servedActionIndex, servedFromRun, servedHeroStrategy, servedMixOf, servedTraceField } from "./servedStrategy";
import { alignStrategy, blendStrategies } from "./multiwayCollapse";
import { solveStore } from "./solveStore";

interface FxPlan { oopPos: string; midPos: string; ipPos: string; players: string[]; pot: number; stack: number; stacksIn: Record<string, number>; rangesIn: Record<string, number>[] }
type FxNode = { toAct: string; actions: { code: string; name: string; betsize: number; allin?: boolean; strategy: Record<string, number> }[] };
interface Fixture {
  heroComboIdx: number; board: string; rake: { pct_of_pot: number; cap_in_chips: number; preflop_rake_type: string | null };
  plans: Record<string, FxPlan>; decisions: { solve: number; plan: string; turn: string[]; turnSeats: string[]; tag: string }[];
  nodes: Record<string, FxNode>; answer11380: { action: string; frequency: number }[]; answer11378: { action: string; frequency: number }[];
}
const fx = fxJson as unknown as Fixture;
const dense = (sp: Record<string, number>): number[] => { const a = new Array(1326).fill(0); for (const [k, v] of Object.entries(sp)) a[Number(k)] = v; return a; };
const nodeJson = (nd: FxNode) => ({
  game: { players: [{ position: nd.toAct, is_hero: true }] },
  action_solutions: nd.actions.map((a) => ({
    action: { code: a.code, display_name: a.name, betsize: a.betsize ? String(a.betsize) : "0", betsize_by_pot: null, allin: !!a.allin, position: nd.toAct },
    total_frequency: 0.5, total_ev: 0, strategy: dense(a.strategy), evs: new Array(1326).fill(0),
  })),
});
const HERO = fx.heroComboIdx;
const MERGE = "merge:CO+BTN", GHOST = "ghost:BTN";

/** GTO Wizard scripted from the fixture: the merge plan's trees by their pot (37.8), M0 size-free / M1 pinned; the ghost
 *  plan's (pot 39) G — the one tree 5928 walked */
function script() {
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peekSol: api.peekSolution, peekNode: api.peekNode };
  const trees: CustomTreeInput[] = [];
  const solOf = (input: CustomTreeInput) => {
    const pinned = !!input.played?.TURN?.length;
    return Math.abs(input.pot - fx.plans[MERGE]!.pot) < 0.01 ? (pinned ? "M1" : "M0") : (pinned ? "G" : "G0");
  };
  const nodeOf = (sol: string, q: any) => { const nd = fx.nodes[`${sol}|${q.turnActions ?? ""}`]; return nd ? nodeJson(nd) : null; };
  const solved = new Set<string>();
  api.ensureCustomSolution = async (input: CustomTreeInput) => { trees.push(input); const s = solOf(input); solved.add(s); return { ok: true, solId: s, created: true, session: "primary" }; };
  api.customNode = async (sol: string, q: any) => { const d = nodeOf(sol, q); return d ? { ok: true, data: d, solveSecs: 0, cached: false } : { ok: false, status: 404, error: `unscripted ${sol}|${q.turnActions}` }; };
  api.peekSolution = (input: CustomTreeInput) => { const s = solOf(input); return solved.has(s) ? s : null; };
  api.peekNode = (sol: string, q: any) => (solved.has(sol) ? nodeOf(sol, q) : null);
  return { trees, restore: () => { api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; api.peekSolution = saved.peekSol; api.peekNode = saved.peekNode; } };
}

const HAND = "4922298483-served-test";
const spec = (plan: string, turn: string[]): AiChainSpec => {
  const p = fx.plans[plan]!;
  return {
    oopPos: p.oopPos, midPos: p.midPos, ipPos: p.ipPos,
    oopRange: dense(p.rangesIn[0]!), midRange: dense(p.rangesIn[1]!), ipRange: dense(p.rangesIn[2]!),
    flopPot: p.pot, flopStack: p.stack, seatStacks: p.stacksIn, firstStreet: 1,
    board: fx.board, streets: [turn], streetSeats: [turn.map((_, i) => p.players[i % 3]!)],
    heroSeat: "oop", heroComboIdx: HERO, rake: fx.rake, handKey: HAND, planTag: plan,
  };
};
/** fastSolve after a single-tree answer: the mix served is that tree's node (servedMixOf / recordServed, as it calls them) */
function served(r: AiChainResult, plan: string) {
  if (!r.ok) throw new Error(r.why);
  const w = { kind: plan, data: r.data, trace: r.trace };
  const mix = servedMixOf({ walks: [w], aligned: [w], blended: null, heroAt: r.heroAt! });
  recordServed(HAND, mix!);
  return mix!;
}

let restore: (() => void) | null = null;
const envBefore = process.env.HERO_STREET_AS_ANSWERED;
afterEach(() => {
  restore?.(); restore = null;
  forgetCheckpoints(HAND); dropAnsweredNodes(); dropServed();
  if (envBefore == null) delete process.env.HERO_STREET_AS_ANSWERED; else process.env.HERO_STREET_AS_ANSWERED = envBefore;
});

/** the hand's three turn decisions in order: 11378 and 11380 on the merge plan (their served mixes kept as fastSolve
 *  keeps them), then 11381 on the ghost plan */
async function threeDecisions(opts: { keep?: boolean } = {}) {
  const s = script();
  restore = s.restore;
  const a = await solveAiChain(spec(MERGE, []));
  const mixA = served(a, MERGE);
  const b = await solveAiChain(spec(MERGE, ["X", "R18", "C"]));
  const mixB = served(b, MERGE);
  if (opts.keep === false) dropServed();
  const c = await solveAiChain(spec(GHOST, fx.decisions[2]!.turn));
  if (!c.ok) throw new Error(c.why);
  return { s, a, b, c, mixA, mixB };
}

describe("11381: hero's earlier turn actions on another plan are narrowed by the mix he was served", () => {
  it("the served mixes are the answers': CHECK 10.26% (11378), RAISE 73.1 71.29% (11380) for 2d2h", async () => {
    const { mixA, mixB } = await threeDecisions();
    expect(mixA).toMatchObject({ k: 1, n: 0, plans: [MERGE], blended: false });
    expect(mixB).toMatchObject({ k: 1, n: 1, plans: [MERGE], blended: false });
    const chk = mixA.menu.findIndex((m) => m.code === "X");
    const rz = mixB.menu.findIndex((m) => m.name === "RAISE");
    expect(mixA.strategy[chk]![HERO]).toBe(0.1026);
    expect(mixB.strategy[rz]![HERO]).toBe(0.7129);
    expect(mixB.strategy[rz]![HERO]! * 100).toBeCloseTo(fx.answer11380.find((x) => x.action === "RAISE 73.1")!.frequency, 1);
  });

  it("hero keeps the weight the served mixes give him: 0.05 x 0.1026 x 0.7129; #17 passes; no absent flag; the note names the plan change", async () => {
    const { c } = await threeDecisions();
    if (!c.ok) return;
    const entry = fx.plans[GHOST]!.rangesIn[0]![String(HERO)]!;
    expect(c.heroWeight!).toBeCloseTo(entry * 0.1026 * 0.7129, 6);
    expect(c.heroWeight!).toBeGreaterThan(1e-3);
    const turn = c.trace.streets.find((x) => x.street === "TURN")!;
    const c17 = turn.checks!.find((x) => x.id === 17)!;
    expect(c17.status).toBe("pass");
    expect(c17.text).not.toContain("ABSENT");
    const narrowed = c.trace.nodes.filter((n) => n.heroAnswered);
    expect(narrowed.map((n) => [n.ti, n.heroAnswered!.src, n.heroAnswered!.action, n.heroAnswered!.combo])).toEqual([
      [0, "served", "CHECK", { answered: 0.1026, tree: 0.0039 }],
      [3, "served", "RAISE", { answered: 0.7129, tree: 0.1367 }],
    ]);
    expect(narrowed[1]!.heroAnswered!.served).toMatchObject({ plans: [MERGE], blended: false, kept: "memory", plan: GHOST });
    expect(c.retreeNotes).toHaveLength(1);
    expect(c.retreeNotes![0]).toContain("hero's CHECK narrowed by the mix he was served (plan changed: merge:CO+BTN → ghost:BTN; his hand 0.1026 in that mix, 0.0039 on this tree)");
    expect(c.retreeNotes![0]).toContain("hero's RAISE narrowed by the mix he was served (plan changed: merge:CO+BTN → ghost:BTN; his hand 0.7129 in that mix, 0.1367 on this tree)");
  });

  it("the same-plan case is today's path: 11380's check on M1 narrowed by the node he was answered on (M0), not the served record", async () => {
    const { b } = await threeDecisions();
    if (!b.ok) throw new Error(b.why);
    const h = b.trace.nodes.filter((n) => n.heroAnswered);
    // the walk resumes from 11378's node or reads M1's root — either way never the served record
    for (const n of h) expect(n.heroAnswered!.src).toBe("memory");
    expect(b.retreeNotes?.join(" ") ?? "").not.toContain("mix he was served");
  });

  it("switch off = the rule before: no narrowing by any answer, hero under 1e-3, #17 fails covered", async () => {
    process.env.HERO_STREET_AS_ANSWERED = "off";
    const { c } = await threeDecisions();
    if (!c.ok) return;
    expect(c.trace.nodes.some((n) => n.heroAnswered)).toBe(false);
    expect(c.heroWeight!).toBeLessThan(1e-3);
    const c17 = c.trace.streets.find((x) => x.street === "TURN")!.checks!.find((x) => x.id === 17)!;
    expect(c17.status).toBe("fail");
    expect(c17.covered).toBe("postflop:hero-absent");
  });

  it("nothing kept anywhere (no record, no stored row): this tree's strategy, as before — hero absent", async () => {
    const { c } = await threeDecisions({ keep: false });
    if (!c.ok) return;
    expect(c.trace.nodes.some((n) => n.heroAnswered?.src === "served")).toBe(false);
    expect(c.heroWeight!).toBeLessThan(1e-3);
  });

  it("after a restart the served mix comes from the stored answer (`served` on the trace); old rows rebuild it", async () => {
    const s = script();
    restore = s.restore;
    const save = (r: AiChainResult, key: string, withServed: boolean) => {
      if (!r.ok) throw new Error(r.why);
      const w = { kind: MERGE, data: r.data, trace: r.trace };
      const mix = servedMixOf({ walks: [w], aligned: [w], blended: null, heroAt: r.heroAt! })!;
      const trace = withServed ? { ...r.trace, served: servedTraceField(mix) } : r.trace;
      // a single tree's strategies are its hero node's (already in the trace): the descriptor alone
      if (withServed) expect(trace.served!.strategy).toBeUndefined();
      solveStore.save({ origin: "live", clientHandId: HAND, wrapperHandId: null, decisionKey: key, street: "turn", board: fx.board, heroCards: "2d2h",
        heroPos: "SB", tier: "ai-chain", line: r.line, solves: 1, solveMs: 1, ok: true, why: null }, trace);
    };
    for (const withServed of [true, false]) {
      const a = await solveAiChain(spec(MERGE, []));
      save(a, `d0-${withServed}`, withServed);
      const b = await solveAiChain(spec(MERGE, ["X", "R18", "C"]));
      save(b, `d1-${withServed}`, withServed);
      dropAnsweredNodes(); dropServed(); forgetCheckpoints(HAND);     // the restart
      if (!withServed) {
        // the rows with `served` are newer for the other pass: this pass reads its own (the newest live rows first)
        const sv = servedHeroStrategy(HAND, 1, 1)!;
        expect(sv.src).toBe("rebuilt");
        dropServed();
      }
      const c = await solveAiChain(spec(GHOST, fx.decisions[2]!.turn));
      if (!c.ok) throw new Error(c.why);
      const h = c.trace.nodes.filter((n) => n.heroAnswered).map((n) => n.heroAnswered!);
      expect(h.map((x) => [x.src, x.served?.kept, x.combo?.answered])).toEqual([
        ["served", withServed ? "store" : "rebuilt", 0.1026], ["served", withServed ? "store" : "rebuilt", 0.7129],
      ]);
      expect(c.heroWeight!).toBeCloseTo(fx.plans[GHOST]!.rangesIn[0]![String(HERO)]! * 0.1026 * 0.7129, 6);
      dropAnsweredNodes(); dropServed(); forgetCheckpoints(HAND);
    }
  });
});

describe("the served mix of a blend (servedStrategy.blendWalks = fastSolve's blend)", () => {
  const sol = (code: string, name: string, xs: number[]) => ({ code, name, strategy: xs });
  it("blends by class like fastSolve: fold at the most folding walk, wager at the least wagering, the rest passive", () => {
    const w0 = [sol("F", "FOLD", [0.1, 0]), sol("C", "CALL", [0.5, 0.2]), sol("R60", "RAISE", [0.4, 0.8])];
    const w1 = [sol("F", "FOLD", [0.3, 0]), sol("C", "CALL", [0.6, 0.7]), sol("R55", "RAISE", [0.1, 0.3])];  // another pot: R55
    const bw = blendWalks([w0, w1], false);
    expect(bw.onRef[1]!.byClass).toBe(true);
    expect(bw.codeOn(1, "R55")).toBe("R60");
    const a0 = alignStrategy(bw.codes, w0.map((x) => ({ code: x.code, strategy: x.strategy })))!;
    const a1 = alignStrategy(bw.codes, w1.map((x) => ({ code: bw.codeOn(1, x.code), strategy: x.strategy })))!;
    expect(bw.blended).toEqual(blendStrategies(bw.codes, [a0, a1]));
    expect(bw.blended!.map((r) => r.map((x) => Math.round(x * 1000) / 1000))).toEqual([[0.3, 0], [0.6, 0.7], [0.1, 0.3]]);
    // one walk: nothing blended
    expect(blendWalks([w0], false).blended).toBeNull();
  });

  it("a stored blended decision: `served` carries the strategies; an old run is rebuilt from its walks with the same code", () => {
    const node = (acts: { code: string; name: string; strategy: number[] }[]) => ({ si: 0, ti: 0, actor: 0, heroNode: true, actions: acts.map((x) => ({ ...x, betsize: null })) });
    const tr = (plan: string, acts: { code: string; name: string; strategy: number[] }[]) => ({
      spec: { firstStreet: 1, planTag: plan, heroSeat: "oop", oopPos: "SB", midPos: "BB", ipPos: "CO", streetSeats: [[]] },
      streets: [{ si: 0, solId: `sol-${plan}` }], nodes: [node(acts)],
    });
    const w0 = [sol("X", "CHECK", [0.5, 1]), sol("R10", "BET", [0.5, 0])];
    const w1 = [sol("X", "CHECK", [0.9, 0.2]), sol("R12", "BET", [0.1, 0.8])];
    const run = [{ id: 1, trace: tr("ghost:BB", w0) }, { id: 2, trace: tr("ghost:CO", w1) }];
    expect(heroAtOfTrace(run[0]!.trace)).toEqual({ k: 1, n: 0 });
    const rebuilt = servedFromRun(run)!;
    expect(rebuilt).toMatchObject({ src: "rebuilt", blended: true, plans: ["ghost:BB", "ghost:CO"], k: 1, n: 0, first: 1 });
    expect(rebuilt.strategy).toEqual([[0.9, 1], [0.1, 0]]);
    // the live path's own record of the same decision, stored on the reference walk's trace
    const walks = [{ kind: "ghost:BB", data: { action_solutions: w0.map((x) => ({ action: { code: x.code, display_name: x.name, betsize: "0" }, strategy: x.strategy })) }, trace: run[0]!.trace },
      { kind: "ghost:CO", data: { action_solutions: w1.map((x) => ({ action: { code: x.code, display_name: x.name, betsize: "0" }, strategy: x.strategy })) }, trace: run[1]!.trace }];
    const bw = blendWalks(walks.map((w) => w.data.action_solutions.map((x) => ({ code: x.action.code, name: x.action.display_name, strategy: x.strategy }))), false);
    const mix = servedMixOf({ walks, aligned: walks, blended: bw.blended, heroAt: { k: 1, n: 0 } })!;
    const field = servedTraceField(mix);
    expect(field.strategy).toEqual(rebuilt.strategy);
    const fromStore = servedFromRun([{ id: 1, trace: { ...run[0]!.trace, served: field } }])!;
    expect(fromStore).toMatchObject({ src: "store", blended: true, plans: ["ghost:BB", "ghost:CO"] });
    expect(fromStore.strategy).toEqual(mix.strategy);
  });

  it("a stored decision's walks: same decision key and origin, saved within a second, each plan once (two calls split)", () => {
    const row = (id: number, ts: number, plan: string, decisionKey = "d", origin = "live") => ({ id, ts, plan, decisionKey, origin });
    const runs = runsOf([row(1, 0, "ghost:BB"), row(2, 5, "ghost:CO"), row(3, 9, "ghost:BB"), row(4, 12, "ghost:CO"), row(5, 3000, "ghost:BB"), row(6, 3001, "ghost:BB", "e")]);
    expect(runs.map((r) => r.map((x) => x.id))).toEqual([[1, 2], [3, 4], [5], [6]]);
  });

  it("hero's action on the served menu: the walk's matcher, else by class (another plan's sizes)", () => {
    const menu = [{ code: "F", name: "FOLD", betsize: 0 }, { code: "C", name: "CALL", betsize: 18 }, { code: "R73.1", name: "RAISE", betsize: 73.1 }, { code: "R94", name: "ALLIN", betsize: 94 }];
    const exact = (l: string, sols: any[]) => sols.findIndex((s) => (l === "Call" && s.action.code === "C") || (l === "Raise(7310)" && s.action.code === "R73.1"));
    expect(servedActionIndex("Raise(7310)", menu, exact)).toEqual({ j: 2, byClass: false });
    expect(servedActionIndex("Raise(6000)", menu, exact)).toEqual({ j: 2, byClass: true });
    expect(servedActionIndex("AllIn(9280)", menu, exact)).toEqual({ j: 3, byClass: true });
    expect(servedActionIndex("Check", menu, exact)).toEqual({ j: -1, byClass: false });
  });
});
