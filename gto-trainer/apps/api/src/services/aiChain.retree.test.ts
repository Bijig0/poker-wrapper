/**
 * RETREE CONSISTENCY + HERO ABSENT (2026-10-08). The core-bvb-007 turn from its stored traces (stress core store, solves
 * 7733 / 7734, fixture __fixtures__/retreeCoreBvb007.json): tree A = the size-free turn tree hero was answered on (CHECK /
 * BET 20.5, Qc8c checks 99.97%), the BB bets 7.5 (not on A: it offers BET 10.1) and the street is re-solved as tree B.
 * Before: B pinned only the 7.5, hero AUTOMATIC again (GTO Wizard gave him BET 3.8), his check narrowed by B's 0.38% →
 * weight 0.0005 at his facing node. Now: B carries A's menus (hero 20.5, BB 10.1 + the 7.5) and his check is narrowed by
 * the strategy he was answered with.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fxJson from "./__fixtures__/retreeCoreBvb007.json";
import { gtowApi, THREE_WAY_SIZES, type CustomTreeInput, type PlayedWager } from "./gtowApi";
import { dropAnsweredNodes, forgetCheckpoints, resolvedMenus, retreeInputs, solveAiChain, type AiChainSpec } from "./aiChain";
import { checkHeroCombo } from "./chainChecks";
import { heroAbsentAnswer, heroAbsentPick, HERO_ABSENT_TAG } from "./heroAbsent";
import { dropShortAllIns, type PressEntry } from "./allInPress";
import { solveStore } from "./solveStore";
import { OLD_MENUS, useMenus } from "../test/menuEnv";

interface Fixture {
  heroComboIdx: number; board: string; pot: number; stack: number; rake: { pct_of_pot: number; cap_in_chips: number; preflop_rake_type: string | null };
  players: string[]; rangesIn: Record<string, number>[]; nodes: Record<string, unknown>; traceA_root_check_qc8c: number; traceB_root_check_qc8c: number;
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

/** GTO Wizard scripted from the fixture: the size-free turn tree is "A", any pinned tree "B" (its nodes are 7734's). */
function script() {
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peekSol: api.peekSolution, peekNode: api.peekNode };
  const trees: CustomTreeInput[] = [];
  const solOf = (input: CustomTreeInput) => (input.played?.TURN?.length ? "B" : "A");
  const nodeOf = (sol: string, q: any) => { const nd = NODES[`${sol}|${q.turnActions ?? ""}`]; return nd ? nodeJson(nd) : null; };
  api.ensureCustomSolution = async (input: CustomTreeInput) => { trees.push(input); return { ok: true, solId: solOf(input), created: true, session: "primary" }; };
  api.customNode = async (sol: string, q: any) => { const d = nodeOf(sol, q); return d ? { ok: true, data: d, solveSecs: 0, cached: false } : { ok: false, status: 404, error: `unscripted ${sol}|${q.turnActions}` }; };
  // only tree A is solved before the re-tree (the walk's peeks): its nodes are the ones hero's answer and the fit read
  api.peekSolution = (input: CustomTreeInput) => (input.played?.TURN?.length ? null : "A");
  api.peekNode = (sol: string, q: any) => (sol === "A" ? nodeOf(sol, q) : null);
  return { trees, restore: () => { api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; api.peekSolution = saved.peekSol; api.peekNode = saved.peekNode; } };
}

const HAND = "core-bvb-007-retree-test";
const spec = (streets: string[][]): AiChainSpec => ({
  oopPos: "SB", ipPos: "BB", oopRange: dense(fx.rangesIn[0]!), ipRange: dense(fx.rangesIn[1]!),
  flopPot: fx.pot, flopStack: fx.stack, seatStacks: { SB: fx.stack, BB: fx.stack }, firstStreet: 1,
  board: fx.board, streets, heroSeat: "oop", heroComboIdx: HERO, rake: fx.rake, handKey: HAND,
});
const turnEntry = (input: CustomTreeInput) => (gtowApi.buildCustomTree(input).bet_sizes.street_bet_sizes as any[]).find((s) => s.street === "TURN").position_bet_sizes;

// the fixture's trees are the AUTOMATIC heads-up ones it was stored from: HU_FIXED_MENU=off for this file (the fixed
// heads-up menu of 2026-10-08 and its re-tree: gtowApi.huFixedMenu.test.ts)
// heads-up/off and three-way B on the gross pot (the three-seat case was written for menu B; menus F / C / net: gtowApi.menus.test.ts)
useMenus({ ...OLD_MENUS, HU_FIXED_MENU: "off" });
let restore: (() => void) | null = null;
const envBefore = process.env.HERO_STREET_AS_ANSWERED;
afterEach(() => {
  restore?.(); restore = null;
  forgetCheckpoints(HAND); dropAnsweredNodes();
  if (envBefore == null) delete process.env.HERO_STREET_AS_ANSWERED; else process.env.HERO_STREET_AS_ANSWERED = envBefore;
});

/** hero's two turn decisions: at the root on A, then facing the BB's 7.5 */
async function twoDecisions() {
  const s = script();
  restore = s.restore;
  const first = await solveAiChain(spec([[]]));
  expect(first.ok).toBe(true);
  const second = await solveAiChain(spec([["X", "R7.5"]]));
  return { s, first, second };
}

describe("core-bvb-007: the re-tree carries tree A's menus", () => {
  it("tree B's menu for hero = tree A's 20.5; the BB's = A's 10.1 with his 7.5 added", async () => {
    const { s, second } = await twoDecisions();
    expect(second.ok).toBe(true);
    const b = s.trees.find((t) => t.played?.TURN?.length)!;
    expect(b.played!.TURN).toEqual([{ seat: 1, to: 7.5 }]);
    const [oop, ip] = turnEntry(b);
    expect(oop.type).toBe("FIXED");
    expect(oop.bet_sizes).toEqual(["20.5bb", "96.7bb"]);        // A's resolved bet + his all-in (every FIXED list)
    expect(oop.raise_sizes).toEqual([...THREE_WAY_SIZES.raise, "96.7bb"]);   // a level A never showed: the base raise
    expect(ip.type).toBe("FIXED");
    expect(ip.bet_sizes).toEqual(["10.1bb", "7.5bb", "96.7bb"]);
    if (!second.ok) return;
    expect(second.trace.streets[0]!.retree).toMatchObject({ from: "A", seats: ["resolved", "resolved"], added: { seat: 1, to: 7.5 } });
  });

  it("hero's check is narrowed by the strategy he was answered with: weight 0.123, #17 passes, the note says so", async () => {
    const { second } = await twoDecisions();
    if (!second.ok) throw new Error(second.why);
    expect(second.heroWeight).toBeCloseTo(fx.rangesIn[0]![String(HERO)]! * fx.traceA_root_check_qc8c, 6);
    expect(second.heroWeight!).toBeCloseTo(0.1225, 3);
    const c17 = second.trace.streets[0]!.checks!.find((c) => c.id === 17)!;
    expect(c17.status).toBe("pass");
    const heroRoot = second.trace.nodes.find((n) => n.ti === 0 && n.heroAnswered)!;
    expect(heroRoot.heroAnswered).toMatchObject({ solId: "A", src: "memory", action: "CHECK", combo: { answered: 0.9997, tree: 0.0038 } });
    expect(second.retreeNotes).toEqual([
      "RE-TREE: turn re-solved with BB's 7.5bb added; menus carried from tree #A; hero's CHECK narrowed by his answered strategy (his hand 0.9997 on the tree he was answered on, 0.0038 on this one)",
    ]);
  });

  it("switch off = today: only the 7.5 pinned, hero AUTOMATIC, his check narrowed by tree B → absent, #17 FAILS", async () => {
    process.env.HERO_STREET_AS_ANSWERED = "off";
    const { s, second } = await twoDecisions();
    if (!second.ok) throw new Error(second.why);
    const b = s.trees.find((t) => t.played?.TURN?.length)!;
    expect(b.carry).toBeUndefined();
    const [oop, ip] = turnEntry(b);
    expect(oop.type).toBe("AUTOMATIC");
    expect(ip.bet_sizes).toEqual(["7.5bb", "96.7bb"]);
    expect(second.heroWeight!).toBeLessThan(1e-3);
    expect(second.retreeNotes).toBeUndefined();
    const c17 = second.trace.streets[0]!.checks!.find((c) => c.id === 17)!;
    expect(c17.status).toBe("fail");
    expect(c17.covered).toBe("postflop:hero-absent");
    expect(c17.text).toContain("ABSENT");
  });

  it("no answered record anywhere (a synthetic hand nobody answered): narrowed by the tree's own strategy, as before", async () => {
    const s = script();
    restore = s.restore;
    const r = await solveAiChain(spec([["X", "R7.5"]]));
    if (!r.ok) throw new Error(r.why);
    expect(r.trace.nodes.some((n) => n.heroAnswered)).toBe(false);
    expect(r.heroWeight!).toBeLessThan(1e-3);
  });

  it("after a restart the answered node comes from the stored answer's trace (solves table)", async () => {
    const s = script();
    restore = s.restore;
    const first = await solveAiChain(spec([[]]));
    if (!first.ok) throw new Error(first.why);
    solveStore.save({ origin: "test", clientHandId: HAND, wrapperHandId: null, decisionKey: "d1", street: "turn", board: fx.board, heroCards: "Qc8c",
      heroPos: "SB", tier: "ai-chain", line: first.line, solves: 1, solveMs: 1, ok: true, why: null }, first.trace);
    dropAnsweredNodes(); forgetCheckpoints(HAND);      // the restart: no memo, no answered record in memory
    const second = await solveAiChain(spec([["X", "R7.5"]]));
    if (!second.ok) throw new Error(second.why);
    const h = second.trace.nodes.find((n) => n.heroAnswered)!.heroAnswered!;
    expect(h).toMatchObject({ solId: "A", src: "store", action: "CHECK", combo: { answered: 0.9997, tree: 0.0038 } });
    expect(second.heroWeight!).toBeCloseTo(0.1225, 3);
  });
});

describe("the loop: the next disagreement carries the re-tree's menus", () => {
  it("hero raises to 30 (B offers 60%): tree C = B's lists as sent with the 30 added at his raise level", () => {
    const s = script();
    restore = s.restore;
    const base: CustomTreeInput = { board: fx.board, pot: fx.pot, stack: fx.stack, stacks: [fx.stack, fx.stack], oopRange: dense(fx.rangesIn[0]!), ipRange: dense(fx.rangesIn[1]!),
      oopPos: "SB", ipPos: "BB", startingStreet: "TURN", rake: fx.rake };
    const labels = ["Check", "Bet(750)", "Raise(3000)"];
    const actors = [0, 1, 0];
    const w1: PlayedWager = { seat: 1, to: 7.5 }, w2: PlayedWager = { seat: 0, to: 30 };
    const api = gtowApi as any;
    const b = retreeInputs({ base, played: [w1], labels, actors, stack: fx.stack, build: (x) => gtowApi.buildCustomTree(x), peekSolution: api.peekSolution, peekNode: (sol, c) => api.peekNode(sol, { turnActions: c, board: fx.board }) });
    const c = retreeInputs({ base, played: [w1, w2], labels, actors, stack: fx.stack, build: (x) => gtowApi.buildCustomTree(x),
      peekSolution: (x) => (x.played?.TURN?.length === 1 ? "B" : api.peekSolution(x)), peekNode: (sol, cs) => api.peekNode(sol, { turnActions: cs, board: fx.board }) });
    expect(c.carry?.seats).toEqual(["sent", "sent"]);
    expect(c.carry?.from).toBe("B");
    const [oopB, ipB] = turnEntry(b.input);
    const [oopC, ipC] = turnEntry(c.input);
    expect(oopC.bet_sizes).toEqual(oopB.bet_sizes);
    expect(oopC.raise_sizes).toEqual(["60%", "30bb", "96.7bb"]);
    expect(ipC.bet_sizes).toEqual(ipB.bet_sizes);
  });

  it("resolvedMenus reads only the cache along the line, up to the point of disagreement", () => {
    const s = script();
    restore = s.restore;
    const got = resolvedMenus(["Check", "Bet(750)"], [0, 1], 1, fx.stack, (c) => (gtowApi as any).peekNode("A", { turnActions: c, board: fx.board }));
    expect(got.get(0)).toEqual([["20.5bb"], null, null, null]);
    expect(got.get(1)).toEqual([["10.1bb"], null, null, null]);
    // a node the cache does not hold stops the read (no request)
    expect(resolvedMenus(["Check", "Bet(750)"], [0, 1], 1, fx.stack, () => null).size).toBe(0);
  });

  it("three seats (Brady 2026-10-08 \"do the 3-way too\"): every seat keeps 33/75 | 60 + its all-in, the actor gains the amount", () => {
    const base: CustomTreeInput = { board: fx.board, pot: fx.pot, stack: 90, oopRange: dense(fx.rangesIn[0]!), ipRange: dense(fx.rangesIn[1]!),
      mid: { pos: "BTN", range: dense(fx.rangesIn[1]!) }, oopPos: "SB", ipPos: "BB", startingStreet: "TURN" };
    const played = [{ seat: 2, to: 7.5 }];
    // the three seats are FIXED: carried as sent whether or not the tree is solved (nothing is read from its nodes)
    const r = retreeInputs({ base, played, labels: ["Check", "Check", "Bet(750)"], actors: [0, 1, 2], stack: 90, build: (x) => gtowApi.buildCustomTree(x),
      peekSolution: () => null, peekNode: () => null });
    expect(r.carry?.seats).toEqual(["sent", "sent", "sent"]);
    const ent = turnEntry(r.input);
    expect(ent.map((p: any) => p.bet_sizes)).toEqual([["33%", "75%", "90bb"], ["33%", "75%", "90bb"], ["33%", "75%", "7.5bb", "90bb"]]);
    expect(ent.map((p: any) => p.raise_sizes)).toEqual([["60%", "90bb"], ["60%", "90bb"], ["60%", "90bb"]]);
    // the old pin (the switch off): the 7.5 alone on every seat
    const old = turnEntry({ ...base, played: { TURN: played } });
    expect(old.map((p: any) => p.bet_sizes)).toEqual([["7.5bb", "90bb"], ["7.5bb", "90bb"], ["7.5bb", "90bb"]]);
  });
});

describe("hero absent at his node (live answer 13033, hand 4922572952: Th9s turn, weight 9.5e-5)", () => {
  // the mix served live: FOLD ~0 / CALL 20 51.7% / ALLIN 80.8 48.3% — the roll pressed the ALLIN
  const mix = () => [{ action: "FOLD", frequency: 8e-7 }, { action: "CALL 20", frequency: 51.697884922423675 }, { action: "ALLIN 80.8", frequency: 48.302115077576325 }];

  it("check #17 fails under 1e-3 (it passed 'carries weight 0.000'), covered by postflop:hero-absent", () => {
    const c = checkHeroCombo({ heroCombo: 592, weight: 9.5e-5 });
    expect(c.status).toBe("fail");
    expect(c.covered).toBe("postflop:hero-absent");
    expect(c.text).toContain("9.5e-5");
    expect(checkHeroCombo({ heroCombo: 592, weight: 0.0128 }).status).toBe("pass");
  });

  it("the passive pick: CALL, never the ALLIN; the warning opens HERO ABSENT AT HIS NODE:, the path code fails", () => {
    const r = heroAbsentAnswer({ actions: mix(), trees: [{ plan: null, w: 9.5e-5 }], street: "turn", hand: "4922572952", who: "Th9s BB", passive: true })!;
    expect(r.pick).toBe("CALL 20");
    expect(r.actions.find((a) => a.action === "CALL 20")!.frequency).toBeCloseTo(100, 4);
    expect(r.actions.find((a) => a.action === "ALLIN 80.8")!.frequency).toBe(0);
    expect(r.note.startsWith(HERO_ABSENT_TAG)).toBe(true);
    expect(r.note).toContain("ALLIN 80.8 48.3%");
    expect(r.reason).toMatchObject({ v: "failed", code: "postflop:hero-absent" });
    expect(r.log.startsWith("[hero-absent] hand 4922572952 turn")).toBe(true);
    expect(r.note.includes(" · ")).toBe(false);
  });

  it("switch off: the mix as read, still loud", () => {
    const r = heroAbsentAnswer({ actions: mix(), trees: [{ plan: null, w: 9.5e-5 }], street: "turn", hand: "x", who: "y", passive: false })!;
    expect(r.pick).toBeNull();
    expect(r.actions).toEqual(mix());
    expect(r.note).toContain("served as read");
  });

  it("present in every tree: nothing", () => {
    expect(heroAbsentAnswer({ actions: mix(), trees: [{ plan: null, w: 0.0128 }], street: "turn", hand: "x", who: "y" })).toBeNull();
  });

  it("the rule: 90%+ taken; check when offered; call 1%+ facing a wager; else fold", () => {
    expect(heroAbsentPick([{ action: "CHECK", frequency: 5 }, { action: "BET 20.5", frequency: 95 }])!.pick).toBe("BET 20.5");
    expect(heroAbsentPick([{ action: "CHECK", frequency: 15 }, { action: "BET 20.5", frequency: 85 }])!.pick).toBe("CHECK");
    expect(heroAbsentPick([{ action: "FOLD", frequency: 60 }, { action: "CALL 7.5", frequency: 0.5 }, { action: "RAISE 32", frequency: 39.5 }])!.pick).toBe("FOLD");
    expect(heroAbsentPick([{ action: "FOLD", frequency: 60 }, { action: "CALL 7.5", frequency: 2 }, { action: "RAISE 32", frequency: 38 }])!.pick).toBe("CALL 7.5");
  });

  it("composes with the short all-in drop: a dropped ALLIN never comes back", () => {
    const actions = [{ action: "FOLD", frequency: 3 }, { action: "CALL 15", frequency: 2 }, { action: "ALLIN 22", frequency: 95 }];
    const press = [{ action: "ALLIN 22", kind: "dropped", share: 95 } as PressEntry];
    const d = dropShortAllIns(actions, press);
    const r = heroAbsentAnswer({ actions: d.actions, trees: [{ plan: "ghost:CO", w: 0 }], street: "flop", hand: "x", who: "y", passive: true })!;
    // FOLD 60% / CALL 40% after the drop: nothing at 90%, no check, the call 1%+ → CALL; the ALLIN stays at 0
    expect(r.pick).toBe("CALL 15");
    expect(r.actions.find((a) => a.action === "ALLIN 22")?.frequency ?? 0).toBe(0);
  });
});
