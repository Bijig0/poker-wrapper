/**
 * THE HEDGE AFTER A HUNG POLL and THE LATE LOCK'S FALLBACK (2026-10-14, hand 4924409679 — the KsJd river that ran the
 * time bank out with no answer). gtowApi header "WHAT A HUNG POLL IS": a hung poll is a solve GTO Wizard is still
 * running, so the walk keeps polling it AND posts the tree on another account; the first node to answer wins. A
 * node-locked child that is late is answered from the unlocked parent.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { firstOk, solveAiChain, type AiChainSpec } from "./aiChain";

const N = 1326;
type Act = { code: string; name: string; betsize?: number; strategy: number[]; evs: number[] };
const even = (n: number) => new Array(N).fill(1 / n);
const flat = (v: number) => new Array(N).fill(v);
const gap = (i: number) => (i < 10 ? 0 : 0.01 * (i % 300));
const checkOrBet: Act[] = [
  { code: "X", name: "Check", strategy: even(2), evs: flat(1) },
  { code: "R7", name: "Bet", betsize: 7, strategy: even(2), evs: flat(1) },
];
/** BB's flop root: a bet the solver makes 0.1% of the time with every hand (off-tree), worse than checking by gap(i) */
const offTreeBet: Act[] = [
  { code: "X", name: "Check", strategy: flat(0.999), evs: flat(1) },
  { code: "R5", name: "Bet", betsize: 5, strategy: flat(0.001), evs: new Array(N).fill(0).map((_, i) => 1 - gap(i)) },
];
const heroFacing: Act[] = [
  { code: "F", name: "Fold", strategy: even(3), evs: flat(0) },
  { code: "C", name: "Call", betsize: 5, strategy: even(3), evs: flat(0.5) },
  { code: "R15", name: "Raise", betsize: 15, strategy: even(3), evs: flat(0.4) },
];
const node = (toAct: string, acts: Act[], tag = "") => ({
  game: { players: [{ position: toAct, is_hero: true }] },
  tag,
  action_solutions: acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: toAct },
    total_frequency: 0.5, total_ev: 0, strategy: a.strategy, evs: a.evs })),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Reply = ReturnType<typeof node> | { hung: true } | { failAfterMs: number } | { okAfterMs: number; data: ReturnType<typeof node> };
/** replies per `${solId}|${line}`, consumed in order (the last one repeats) */
function script(replies: Record<string, Reply[]>, hedgeAccount = "ultra-2") {
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, lock: api.lockedCustomSolution, hedge: api.hedgeSolution, adopt: api.adoptSolution };
  const trees: any[] = [], hedges: any[] = [], adopted: string[] = [], reads: string[] = [];
  const left = Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, v.slice()]));
  const siblings = new Map<string, string>();
  const saved2 = { sibling: api.hedgeSibling, owner: api.ownerOf };
  api.ensureCustomSolution = async (input: any) => { trees.push(input); return { ok: true, solId: `sol-${input.startingStreet}`, created: true, session: "secondary" }; };
  api.hedgeSolution = async (input: any, opts: any) => {
    hedges.push({ input, opts });
    const solId = `hedge-${input.startingStreet}`;
    if (opts?.of) { siblings.set(opts.of, solId); siblings.set(solId, opts.of); }
    return { ok: true, solId, created: true, session: hedgeAccount, route: "least-loaded (no solve of ours running on it)" };
  };
  api.hedgeSibling = (solId: string) => siblings.get(solId) ?? null;
  api.ownerOf = (solId: string) => (solId.startsWith("hedge-") ? hedgeAccount : null);
  api.adoptSolution = (_input: any, solId: string) => { adopted.push(solId); };
  api.lockedCustomSolution = async (parent: string) => ({ ok: true, solId: `${parent}-locked`, created: true, session: "secondary" });
  api.customNode = async (solId: string, q: any) => {
    const key = `${solId}|${q.flopActions ?? q.turnActions ?? q.riverActions ?? ""}`;
    reads.push(key);
    const q0 = left[key];
    if (!q0?.length) return { ok: false, status: 404, error: `unscripted ${key}` };
    const r = q0.length > 1 ? q0.shift()! : q0[0]!;
    if ("hung" in r) return { ok: false, status: 0, hung: true, error: "GTO Wizard poll hung on secondary (no reply in 8.0 s)" };
    if ("failAfterMs" in r) { await sleep(r.failAfterMs); return { ok: false, status: 504, error: "AI solve timed out" }; }
    if ("okAfterMs" in r) { await sleep(r.okAfterMs); return { ok: true, data: r.data, solveSecs: r.okAfterMs / 1000, cached: false, src: "fetched" }; }
    return { ok: true, data: r, solveSecs: 0, cached: false, src: "fetched" };
  };
  return { trees, hedges, adopted, reads, restore: () => Object.assign(api, { ensureCustomSolution: saved.ensure, customNode: saved.node, lockedCustomSolution: saved.lock, hedgeSolution: saved.hedge, adoptSolution: saved.adopt, hedgeSibling: saved2.sibling, ownerOf: saved2.owner }) };
}

const ENV = ["GTOW_HUNG_HEDGE", "OFFTREE_LOCK_FALLBACK", "OFFTREE_RANGE", "OFFTREE_LOCK", "OFFTREE_BLEND_W"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.(); restore = null;
  for (const k of ENV) { if (savedEnv[k] == null) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

// heads-up: BB (villain, out of position) vs BTN (hero), flop pot 10; one street, villain checks, hero to act
const base: Omit<AiChainSpec, "streets"> = {
  oopPos: "BB", ipPos: "BTN", oopRange: flat(1), ipRange: flat(1),
  flopPot: 10, flopStack: 95, board: "2s3sQd", heroSeat: "ip", heroComboIdx: null,
};
const heroNode = (tag: string) => node("BTN", checkOrBet, tag);

describe("the hedge after a hung poll (GTOW_HUNG_HEDGE, default on)", () => {
  it("the hung solve keeps being polled while the tree is solved again elsewhere; the hedge answers first and is adopted", async () => {
    delete process.env.GTOW_HUNG_HEDGE;
    const s = script({
      "sol-FLOP|": [{ hung: true }, { failAfterMs: 400 }],          // the walk's read hangs; the kept read ends with nothing
      "hedge-FLOP|": [node("BB", checkOrBet, "hedge-root")],
      "hedge-FLOP|X": [heroNode("hedge-hero")],
    }); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X"]] });
    expect(r.ok).toBe(true);
    const flop = r.trace!.streets[0]!;
    expect(flop.solId).toBe("hedge-FLOP");
    expect(flop.account).toBe("ultra-2");
    expect(flop.leak?.code).toBe("tree:hung-hedge");
    expect(flop.treeWhy).toMatch(/second solve on ultra-2 answered first/);
    expect(s.hedges).toHaveLength(1);
    expect(s.hedges[0].opts).toEqual({ avoid: ["secondary"], of: "sol-FLOP" });   // the hung solve's owner is left out
    expect(s.adopted).toEqual(["hedge-FLOP"]);                             // the rest of the hand reads the hedge
    expect(s.trees).toHaveLength(1);                                       // the first solve was NOT forgotten and re-posted
  });

  it("the first solve answers before the hedge: it is kept, nothing adopted, the hedge recorded as extra requests", async () => {
    delete process.env.GTOW_HUNG_HEDGE;
    const s = script({
      "sol-FLOP|": [{ hung: true }, { okAfterMs: 30, data: node("BB", checkOrBet, "first-root") }],
      "sol-FLOP|X": [heroNode("first-hero")],
      "hedge-FLOP|": [{ okAfterMs: 400, data: node("BB", checkOrBet, "hedge-root") }],
      "hedge-FLOP|X": [heroNode("hedge-hero")],
    }); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X"]] });
    expect(r.ok).toBe(true);
    const flop = r.trace!.streets[0]!;
    expect(flop.solId).toBe("sol-FLOP");
    expect(flop.leak?.code).toBe("tree:hung-hedge");
    expect(flop.treeWhy).toMatch(/the first solve answered first/);
    expect(s.hedges).toHaveLength(1);
    expect(s.adopted).toEqual([]);
    expect(s.reads).toContain("sol-FLOP|X");
    expect(s.reads).not.toContain("hedge-FLOP|X");
  });

  it("neither answers: the walk fails with the first solve's reason, once (no second hedge)", async () => {
    delete process.env.GTOW_HUNG_HEDGE;
    const s = script({
      "sol-FLOP|": [{ hung: true }, { failAfterMs: 20 }],
      "hedge-FLOP|": [{ failAfterMs: 20 }],
    }); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X"]] });
    expect(r.ok).toBe(false);
    expect(s.hedges).toHaveLength(1);
    expect(s.adopted).toEqual([]);
  });

  it("the poller's next attempt finds the hedge still running: it races the pair again, no third solve", async () => {
    delete process.env.GTOW_HUNG_HEDGE;
    const s = script({
      // attempt 1: the read hangs, neither solve answers; attempt 2: the read hangs again (the solve is old), the hedge answers
      "sol-FLOP|": [{ hung: true }, { failAfterMs: 20 }, { hung: true }, { failAfterMs: 20 }],
      "hedge-FLOP|": [{ failAfterMs: 20 }, node("BB", checkOrBet, "hedge-root")],
      "hedge-FLOP|X": [heroNode("hedge-hero")],
    }); restore = s.restore;
    const first = await solveAiChain({ ...base, streets: [["X"]] });
    expect(first.ok).toBe(false);
    const second = await solveAiChain({ ...base, streets: [["X"]] });
    expect(second.ok).toBe(true);
    expect(s.hedges).toHaveLength(1);                                      // posted once, by the first attempt
    expect(s.hedges[0].opts).toEqual({ avoid: ["secondary"], of: "sol-FLOP" });
    expect(s.adopted).toEqual(["hedge-FLOP"]);
    const flop = second.trace!.streets[0]!;
    expect(flop.solId).toBe("hedge-FLOP");
    expect(flop.treeWhy).toMatch(/posted by an earlier attempt/);
  });

  it("GTOW_HUNG_HEDGE=off: the 2026-10-08 re-post — the hung solve is forgotten and the tree posted again elsewhere", async () => {
    process.env.GTOW_HUNG_HEDGE = "off";
    const s = script({
      "sol-FLOP|": [{ hung: true }, node("BB", checkOrBet, "re-posted-root")],
      "sol-FLOP|X": [heroNode("hero")],
    }); restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X"]] });
    expect(r.ok).toBe(true);
    expect(s.hedges).toHaveLength(0);
    expect(s.trees).toHaveLength(2);
    expect(r.trace!.streets[0]!.leak?.code).toBe("tree:hung-reroute");
  });
});

describe("the late lock's fallback (OFFTREE_LOCK_FALLBACK, default on)", () => {
  // the off-tree test's shape: BB bets 5 (off-tree), hero calls; the lock forks sol-FLOP into sol-FLOP-locked
  const offTree = { ...base, board: "2s3sQdJh" };
  it("the locked child never answers hero's node: the unlocked parent's node answers, and the trace says so", async () => {
    delete process.env.OFFTREE_RANGE; delete process.env.OFFTREE_LOCK; delete process.env.OFFTREE_LOCK_FALLBACK;
    const s = script({
      "sol-FLOP|": [node("BB", offTreeBet)],
      "sol-FLOP|R5": [node("BTN", heroFacing, "parent-hero")],
      // the child is late: no reply for hero's node (unscripted → fails)
      "sol-TURN|": [node("BB", checkOrBet)],
      "sol-TURN|X": [heroNode("turn-hero")],
    }); restore = s.restore;
    const r = await solveAiChain({ ...offTree, streets: [["R5", "C"], ["X"]] });
    expect(r.ok).toBe(true);
    const flop = r.trace!.streets.find((x: any) => x.street === "FLOP")!;
    expect(flop.leak?.code).toBe("lock:late-parent");
    const soft = r.trace!.nodes.find((n) => n.street === "FLOP" && n.codes.length === 0)!.offTree!.soft!;
    expect(soft.lock?.ok).toBe(true);
    expect(soft.lock?.solId).toBe("sol-FLOP-locked");
    expect(soft.lock?.late).toEqual({ why: expect.stringMatching(/unscripted sol-FLOP-locked\|R5/), parent: "sol-FLOP" });
    expect(s.reads).toContain("sol-FLOP-locked|R5");
    expect(s.reads.indexOf("sol-FLOP|R5")).toBeGreaterThan(s.reads.indexOf("sol-FLOP-locked|R5"));
  });

  // 2026-10-14, session_20261014_161508, hand 4924571783: the hung child 81227e90 was "hedged" with the UNLOCKED tree
  it("a hung read on the node-locked child is polled on — never hedged with the unlocked tree, nothing adopted", async () => {
    delete process.env.OFFTREE_RANGE; delete process.env.OFFTREE_LOCK; delete process.env.OFFTREE_LOCK_FALLBACK; delete process.env.GTOW_HUNG_HEDGE;
    const s = script({
      "sol-FLOP|": [node("BB", offTreeBet)],
      "sol-FLOP|R5": [node("BTN", heroFacing, "parent-hero")],
      "sol-FLOP-locked|R5": [{ hung: true }, node("BTN", heroFacing, "locked-hero")],    // hangs once, then answers
      "sol-TURN|": [node("BB", checkOrBet)],
      "sol-TURN|X": [heroNode("turn-hero")],
    }); restore = s.restore;
    const r = await solveAiChain({ ...offTree, streets: [["R5", "C"], ["X"]] });
    expect(r.ok).toBe(true);
    expect(s.hedges).toHaveLength(0);
    expect(s.adopted).toEqual([]);
    expect(s.trees).toHaveLength(2);                                              // flop + turn: the flop tree was never re-posted
    const flop = r.trace!.streets.find((x: any) => x.street === "FLOP")!;
    expect(flop.leak).toBeFalsy();                                                // no tree:hung-hedge, no lock:late-parent
    const soft = r.trace!.nodes.find((n) => n.street === "FLOP" && n.codes.length === 0)!.offTree!.soft!;
    expect(soft.lock?.solId).toBe("sol-FLOP-locked");
    expect(soft.lock?.late).toBeUndefined();
    expect(soft.lock?.slow).toEqual({ ms: expect.any(Number), answered: true });
    expect(s.reads.filter((x) => x === "sol-FLOP-locked|R5")).toHaveLength(2);    // the child, polled on
    expect(s.reads).not.toContain("sol-FLOP|R5");                                 // hero's node never came from the parent
  });

  it("a child that hangs and then stays late falls to the unlocked parent (lock:late-parent), still without a hedge", async () => {
    delete process.env.OFFTREE_RANGE; delete process.env.OFFTREE_LOCK; delete process.env.OFFTREE_LOCK_FALLBACK; delete process.env.GTOW_HUNG_HEDGE;
    const s = script({
      "sol-FLOP|": [node("BB", offTreeBet)],
      "sol-FLOP|R5": [node("BTN", heroFacing, "parent-hero")],
      "sol-FLOP-locked|R5": [{ hung: true }, { failAfterMs: 30 }],
      "sol-TURN|": [node("BB", checkOrBet)],
      "sol-TURN|X": [heroNode("turn-hero")],
    }); restore = s.restore;
    const r = await solveAiChain({ ...offTree, streets: [["R5", "C"], ["X"]] });
    expect(r.ok).toBe(true);
    expect(s.hedges).toHaveLength(0);
    expect(s.adopted).toEqual([]);
    const flop = r.trace!.streets.find((x: any) => x.street === "FLOP")!;
    expect(flop.leak?.code).toBe("lock:late-parent");
    const soft = r.trace!.nodes.find((n) => n.street === "FLOP" && n.codes.length === 0)!.offTree!.soft!;
    expect(soft.lock?.slow).toEqual({ ms: expect.any(Number), answered: false });
    expect(soft.lock?.late?.parent).toBe("sol-FLOP");
    expect(s.reads.indexOf("sol-FLOP|R5")).toBeGreaterThan(s.reads.lastIndexOf("sol-FLOP-locked|R5"));
  });

  it("OFFTREE_LOCK_FALLBACK=off: a late child fails the answer, as on 2026-10-13", async () => {
    delete process.env.OFFTREE_RANGE; delete process.env.OFFTREE_LOCK;
    process.env.OFFTREE_LOCK_FALLBACK = "off";
    const s = script({
      "sol-FLOP|": [node("BB", offTreeBet)],
      "sol-FLOP|R5": [node("BTN", heroFacing, "parent-hero")],
    }); restore = s.restore;
    const r = await solveAiChain({ ...offTree, streets: [["R5", "C"], ["X"]] });
    expect(r.ok).toBe(false);
    expect((r as any).why).toMatch(/unscripted sol-FLOP-locked\|R5/);
  });
});

describe("firstOk", () => {
  type R = { r: { ok: boolean }; tag: string };
  const ok = (ms: number, tag: string): Promise<R> => sleep(ms).then(() => ({ r: { ok: true }, tag }));
  const bad = (ms: number, tag: string): Promise<R> => sleep(ms).then(() => ({ r: { ok: false }, tag }));
  it("the first OK wins, even when the other was first to finish (failing)", async () => {
    expect((await firstOk(bad(5, "a"), ok(30, "b"))).tag).toBe("b");
    expect((await firstOk(ok(30, "a"), ok(5, "b"))).tag).toBe("b");
  });
  it("both fail: the FIRST read's failure comes back, after both ended", async () => {
    const t0 = Date.now();
    expect((await firstOk(bad(10, "a"), bad(60, "b"))).tag).toBe("a");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });
  it("a read that throws counts as a failure, not a crash", async () => {
    const boom = (): Promise<R> => sleep(5).then(() => { throw new Error("boom"); });
    expect((await firstOk(boom(), ok(20, "b"))).tag).toBe("b");
    const both = await firstOk(boom(), bad(10, "b"));
    expect(both.r.ok).toBe(false);
  });
});
