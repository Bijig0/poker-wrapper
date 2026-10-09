/**
 * THE SOFT RANGE THROUGH THE WALK (services/offTree, OPTION 3, 2026-10-06): an off-tree villain bet on the flop, hero
 * calls, and the TURN tree is asked with villain's soft range — range x exp(-dEV / (0.20 x pot)) — not the QRE sliver;
 * OFFTREE_RANGE=log / off keep the sliver; OFFTREE_LOCK=on node-locks a mid-street off-tree action and reads the rest
 * of the street (hero's node) on the locked child.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { solveAiChain, type AiChainSpec } from "./aiChain";

const N = 1326;
const gap = (i: number) => (i < 10 ? 0 : 0.01 * (i % 300));          // what the bet costs each hand (bb)
type Act = { code: string; name: string; betsize?: number; strategy: number[]; evs: number[] };
const even = (n: number) => new Array(N).fill(1 / n);
const flat = (v: number) => new Array(N).fill(v);
/** BB's flop root: a bet the solver makes 0.1% of the time with every hand, worse than checking by gap(i) */
const offTreeBet: Act[] = [
  { code: "X", name: "Check", strategy: flat(0.999), evs: flat(1) },
  { code: "R5", name: "Bet", betsize: 5, strategy: flat(0.001), evs: new Array(N).fill(0).map((_, i) => 1 - gap(i)) },
];
const heroFacing: Act[] = [
  { code: "F", name: "Fold", strategy: even(3), evs: flat(0) },
  { code: "C", name: "Call", betsize: 5, strategy: even(3), evs: flat(0.5) },
  { code: "R15", name: "Raise", betsize: 15, strategy: even(3), evs: flat(0.4) },
];
const checkOrBet: Act[] = [
  { code: "X", name: "Check", strategy: even(2), evs: flat(1) },
  { code: "R7", name: "Bet", betsize: 7, strategy: even(2), evs: flat(1) },
];
const node = (toAct: string, acts: Act[]) => ({
  game: { players: [{ position: toAct, is_hero: true }] },
  action_solutions: acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: toAct },
    total_frequency: 0.5, total_ev: 0, strategy: a.strategy, evs: a.evs })),
});

function script(nodes: Record<string, ReturnType<typeof node>>) {
  const trees: any[] = [], locks: any[] = [];
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, lock: api.lockedCustomSolution };
  api.ensureCustomSolution = async (input: any) => { trees.push(input); return { ok: true, solId: `sol-${input.startingStreet}`, created: true, session: "secondary" }; };
  api.customNode = async (solId: string, q: any) => {
    const nd = nodes[`${solId}|${q.flopActions ?? q.turnActions ?? q.riverActions ?? ""}`];
    return nd ? { ok: true, data: nd, solveSecs: 0, cached: false } : { ok: false, status: 404, error: `unscripted ${solId}` };
  };
  api.lockedCustomSolution = async (parent: string, lock: any) => { locks.push({ parent, lock }); return { ok: true, solId: `${parent}-locked`, created: true, session: "secondary" }; };
  return { trees, locks, restore: () => { api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; api.lockedCustomSolution = saved.lock; } };
}

const ENV = ["OFFTREE_RANGE", "OFFTREE_RANGE_T", "OFFTREE_LOCK"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.(); restore = null;
  for (const k of ENV) { if (savedEnv[k] == null) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

// heads-up: BB (villain, out of position) vs BTN (hero), flop pot 10
const base: Omit<AiChainSpec, "streets"> = {
  oopPos: "BB", ipPos: "BTN", oopRange: flat(1), ipRange: flat(1),
  flopPot: 10, flopStack: 95, board: "2s3sQdJh", heroSeat: "ip", heroComboIdx: null,
};
const toTurn = {
  "sol-FLOP|": node("BB", offTreeBet),
  "sol-FLOP|R5": node("BTN", heroFacing),
  "sol-TURN|": node("BB", checkOrBet),
  "sol-TURN|X": node("BTN", checkOrBet),
};

describe("the soft range after an off-tree villain action", () => {
  it("soft (the default): the turn tree is asked with range x exp(-dEV / (0.20 x pot)), and the node says what was carried", async () => {
    delete process.env.OFFTREE_RANGE;
    const s = script(toTurn); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["R5", "C"], ["X"]] });
    expect(r.ok).toBe(true);
    const turnIn = s.trees.find((t) => t.startingStreet === "TURN")!.oopRange as number[];
    expect(turnIn[0]).toBeCloseTo(1, 9);                         // the bet is this hand's best action: kept whole
    expect(turnIn[100]).toBeCloseTo(Math.exp(-1 / 2), 9);       // gap 1bb, T = 20% of the 10bb pot
    const flopNode = r.trace!.nodes.find((n) => n.street === "FLOP" && n.codes.length === 0)!;
    expect(flopNode.offTree?.soft?.applied).toBe(true);
    expect(flopNode.offTree!.soft!.qreCombos).toBeCloseTo(N * 0.001, 6);
    expect(flopNode.offTree!.soft!.softCombos!).toBeGreaterThan(50);
  });

  it("log: computed and recorded, the QRE sliver carried", async () => {
    process.env.OFFTREE_RANGE = "log";
    const s = script(toTurn); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["R5", "C"], ["X"]] });
    expect(r.ok).toBe(true);
    const turnIn = s.trees.find((t) => t.startingStreet === "TURN")!.oopRange as number[];
    expect(turnIn[100]).toBeCloseTo(0.001, 9);
    const soft = r.trace!.nodes.find((n) => n.street === "FLOP" && n.codes.length === 0)!.offTree!.soft!;
    expect([soft.mode, soft.applied, soft.softCombos! > 50]).toEqual(["log", false, true]);
  });

  it("off: the narrowing of before (no soft record)", async () => {
    process.env.OFFTREE_RANGE = "off";
    const s = script(toTurn); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["R5", "C"], ["X"]] });
    expect(r.ok).toBe(true);
    expect((s.trees.find((t) => t.startingStreet === "TURN")!.oopRange as number[])[100]).toBeCloseTo(0.001, 9);
    expect(r.trace!.nodes.find((n) => n.street === "FLOP" && n.codes.length === 0)!.offTree?.soft).toBeUndefined();
  });

  it("OFFTREE_LOCK=on: hero answers on the same street — villain's node is locked and hero's node read on the child", async () => {
    process.env.OFFTREE_LOCK = "on";
    const s = script({ ...toTurn, "sol-FLOP-locked|R5": node("BTN", heroFacing) }); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["R5"]] });
    expect(r.ok).toBe(true);
    expect(s.locks).toHaveLength(1);
    expect(s.locks[0].parent).toBe("sol-FLOP");
    expect(s.locks[0].lock.action_history).toEqual(["", ""]);  // preflop, then the flop's line before the bet (root)
    expect(s.locks[0].lock.strategy[1].strategy[100]).toBeCloseTo(Math.exp(-1 / 2), 9);   // gap 1bb, T = 20% of 10bb
    const hero = r.trace!.nodes.find((n) => n.heroNode)!;
    expect(hero.codes).toEqual(["R5"]);
    expect(r.trace!.nodes.find((n) => n.codes.length === 0)!.offTree!.soft!.lock).toEqual({ ok: true, solId: "sol-FLOP-locked" });
  });

  it("OFFTREE_LOCK unset: no lock, hero's node read on the street's own tree", async () => {
    const s = script(toTurn); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["R5"]] });
    expect(r.ok).toBe(true);
    expect(s.locks).toHaveLength(0);
  });
});

describe("check #3 cumulative through the walk (2026-10-09)", () => {
  it("BB bets the flop 5% and the turn 15% (each ≥1%): at hero's turn node his line is 0.75% of his flop range — flagged on the turn's #3, the range kept", async () => {
    const bet = (f: number, size: number): Act[] => [
      { code: "X", name: "Check", strategy: flat(1 - f), evs: flat(1) },
      { code: `R${size}`, name: "Bet", betsize: size, strategy: flat(f), evs: flat(1) },
    ];
    const s = script({
      "sol-FLOP|": node("BB", bet(0.05, 5)),
      "sol-FLOP|R5": node("BTN", heroFacing),
      "sol-TURN|": node("BB", bet(0.15, 12)),
      "sol-TURN|R12": node("BTN", heroFacing),
    }); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["R5", "C"], ["R12"]], streetSeats: [["BB", "BTN"], ["BB"]] });
    expect(r.ok).toBe(true);
    const turn = r.trace!.streets.find((x: any) => x.street === "TURN" || x.k === 1)!;
    const c3 = (turn.checks ?? []).find((c) => c.id === 3)!;
    expect(c3.status).toBe("flag");
    // 1,128 combos the four board cards leave × 5% × 15% = 8.46
    expect(c3.text).toStartWith("cumulative: BB 1128.00 → 8.46 combos over R5-R12 (0.75% of his flop range");
    const flop = r.trace!.streets.find((x: any) => x.street === "FLOP" || x.k === 0)!;
    expect((flop.checks ?? []).find((c) => c.id === 3)!.status).toBe("pass");   // 5% alone: nothing to say on the flop
  });
});
