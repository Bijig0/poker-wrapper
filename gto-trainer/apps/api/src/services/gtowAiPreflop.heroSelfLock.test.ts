import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { COMBOS, comboIndex } from "../utils/comboIndex/comboIndex";

/**
 * HERO'S OWN OFF-TREE ACTION, LOCKED (2026-10-07, Brady; stress-500 pf_limp1-001). A 39bb UTG limped K9o (a chart's
 * limp; the stress script), the HJ raised to 4.1, everyone folded to him. The chart's node is untrained, GTO Wizard AI
 * preflop answers on the exact tree — where UTG never limps — and his hand read 0 for every action: an ok answer with
 * an EMPTY mix. Now his limp is node-locked on the solved tree and his node read on the locked child; a lock that fails
 * (or HERO_SELF_LOCK=off) is an explicit refusal, never an empty answer. Hermetic: a fake fetch, a stubbed session pool,
 * the chart record and chart node stubbed through heroSelfLockSeams.
 */
let P: typeof import("./gtowAiPreflop");
let Pin: typeof import("./preflopPin");
let PL: typeof import("./poolLimpFloor");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
let seams0: any, poolSeams0: any;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  Pin = await import("./preflopPin");
  PL = await import("./poolLimpFloor");
  ({ gtowSessions } = await import("./gtowSessions"));
  seams0 = { ...P.heroSelfLockSeams };
  poolSeams0 = { ...P.poolLockSeams };
  const s = gtowSessions as any;
  for (const m of POOL_METHODS) savedPool.push({ m, own: Object.prototype.hasOwnProperty.call(s, m), fn: s[m] });
  s.route = () => ["primary"];
  s.routeIgnoringBlocks = s.route;
  s.liveFirst = (ids: string[]) => ids;
  s.tokenFor = async () => "t";
  s.bestToken = async () => ({ id: "primary", token: "t" });
  s.noteSuccess = () => {};
  s.noteFailure = () => null;
  s.forceRefresh = async () => true;
});
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of savedPool) { if (own) s[m] = fn; else delete s[m]; }
  P.resetAiPreflopMemory();
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(P.heroSelfLockSeams, seams0);
  Object.assign(P.poolLockSeams, poolSeams0);
  P.resetAiPreflopMemory();
  delete process.env.HERO_SELF_LOCK;
  delete process.env.POOL_LOCK_MS;
});

const arr = (x: number) => new Array(1326).fill(x);
const of = (code: string) => ({ code, type: code === "F" ? "FOLD" : code === "C" ? "CALL" : code === "X" ? "CHECK" : "RAISE", betsize: code.startsWith("R") ? code.slice(1) : "" });
const pnode = (actor: string, acts: [string, number[] | number][]) => ({
  game: { players: ["UTG", "HJ", "CO", "BTN", "SB", "BB"].map((p) => ({ position: p, is_hero: p === actor })) },
  action_solutions: acts.map(([code, f]) => {
    const s = Array.isArray(f) ? f : arr(f);
    return { action: of(code), strategy: s, total_frequency: s.reduce((t, x) => t + x, 0) / 1326 };
  }),
});

/** pf_limp1-001: UTG (hero, 39bb) limps, HJ raises to 4.1, CO/BTN/SB/BB fold — hero to act with K9o. */
let handNo = 0;
const limpHand = (cards: [string, string] = ["Kh", "9c"]): ParsedHand => {
  const a = (seat: number, type: string, amount?: number) => ({ seatId: seat, hero: seat === 1, type, street: "preflop", ...(amount != null ? { amount } : {}) });
  const st = { 1: 39, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 };
  return {
    handId: ++handNo, clientHandId: `self-lock-${handNo}`, bbCents: 200, heroSeatId: 1, heroCards: cards, board: [], street: "preflop",
    actions: [a(5, "post-sb", 0.5), a(6, "post-bb", 1), a(1, "call", 1), a(2, "raise", 4.1), a(3, "fold"), a(4, "fold"), a(5, "fold"), a(6, "fold")],
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
    stacks: { ...st }, startStacks: { ...st },
    currentNode: { street: "preflop", toActSeatId: 1, toActIsHero: true, pot: 0, toCall: 3.1, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
};
const LINE = "C-R4.1-F-F-F-F";
/** the exact tree: UTG never limps (C = 0 for every combo); hero's node behind it has no range at all */
const parentNodes = (): Record<string, object> => ({
  "": pnode("UTG", [["F", 0.85], ["C", 0], ["R2", 0.15]]),
  C: pnode("HJ", [["F", 0.6], ["C", 0.1], ["R4.1", 0.3]]),
  "C-R4.1": pnode("CO", [["F", 1], ["C", 0], ["R12", 0]]),
  "C-R4.1-F": pnode("BTN", [["F", 1], ["C", 0], ["R12", 0]]),
  "C-R4.1-F-F": pnode("SB", [["F", 1], ["C", 0], ["R12", 0]]),
  "C-R4.1-F-F-F": pnode("BB", [["F", 1], ["C", 0], ["R12", 0]]),
  [LINE]: pnode("UTG", [["F", 0], ["C", 0], ["RAI", 0]]),
});
/** the locked child: UTG's limp is the lock's weights; hero's node folds 80 / calls 20 (or still nothing: `heroZero`) */
const childNodes = (w: number[], heroZero = false): Record<string, object> => ({
  ...parentNodes(),
  "": pnode("UTG", [["F", w.map((x) => (1 - x) * 0.85)], ["C", w], ["R2", w.map((x) => (1 - x) * 0.15)]]),
  [LINE]: pnode("UTG", heroZero ? [["F", 0], ["C", 0], ["RAI", 0]] : [["F", 0.8], ["C", 0.2], ["RAI", 0]]),
});

interface Log { locks: any[]; polls: string[] }
/** GTO Wizard: the tree's solution "P", every lock a child "L<n>" whose nodes `child(lock)` makes. */
function fakeGtow(opts: { child?: (lock: any) => Record<string, object>; lockFails?: boolean } = {}): Log {
  const log: Log = { locks: [], polls: [] };
  const sols: Record<string, Record<string, object>> = { P: parentNodes() };
  let seq = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/custom-trees/")) return Response.json({ id: `tree-${++seq}` }, { status: 201 });
    if (u.pathname.endsWith("/custom-solutions/")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (!body.parent_solution_id) return Response.json({ id: "P" }, { status: 201 });
      log.locks.push(body.last_node_lock);
      if (opts.lockFails) return new Response("upstream error", { status: 500 });
      const id = `L${++seq}`;
      sols[id] = (opts.child ?? ((lk: any) => childNodes(lk.strategy.find((s: any) => s.action === "C").strategy)))(body.last_node_lock);
      return Response.json({ id }, { status: 201 });
    }
    const sol = u.searchParams.get("custom_solution_id") ?? "";
    const line = u.searchParams.get("preflop_actions") ?? "";
    log.polls.push(`${sol}:${line}`);
    await Bun.sleep(2);
    const v = sols[sol]?.[line];
    if (v === undefined) return new Response(JSON.stringify({ code: "NODE_DOES_NOT_EXIST", detail: "NODE_DOES_NOT_EXIST" }), { status: 400 });
    return Response.json(v);
  }) as typeof fetch;
  return log;
}

/** the 30bb chart that answered hero's first decision (action index 2) at the root: K9o folds; AA and 22 limp some */
function chartAnswered(k9o: Record<string, number> = { Fold: 100 }) {
  Object.assign(P.heroSelfLockSeams, {
    chartRecord: (_h: ParsedHand, i: number) => (i === 2 ? { piece: "chart6max", chartId: "ign200_6max_D30_o2_5", rawTokens: [], codes: [], depth: 30, heroPos: "UTG", actionIndex: 2, at: 0, handKey: "x" } : undefined),
    chartNode: async () => ({
      pos: "UTG", terminal: false,
      actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }, { action: "Raise 2.5", token: "R2.5" }],
      cells: [{ hand: "K9o", actions: k9o }, { hand: "AA", actions: { Call: 20, "Raise 2.5": 80 } }, { hand: "22", actions: { Call: 50, Fold: 50 } }],
    }),
  });
}
const clsW = (w: number[], cls: string) => w[COMBOS.findIndex((c) => c.cls === cls)];
const mix = (r: { actions: { action: string; frequency: number }[] }) => Object.fromEntries(r.actions.map((a) => [a.action, a.frequency]));

// ── the pure helpers ─────────────────────────────────────────────────────────────────────────────────────────────
describe("the self-lock's pure pieces", () => {
  it("heroOffNodeOf: the first of HIS nodes whose taken action reads 0 for his combo", () => {
    const hi = comboIndex("Kh", "9c");
    const reads = [
      { line: "", isHero: true, sols: parentNodes()[""]!["action_solutions" as never] as any[] },
      { line: "C", isHero: false, sols: [] },
    ];
    expect(P.heroOffNodeOf(reads, ["C", "R4.1"], hi)).toMatchObject({ k: 0, line: "", taken: "C", share: 0 });
    // an open he takes with a real frequency is not off his tree
    expect(P.heroOffNodeOf(reads, ["R2", "R7"], hi)).toBeNull();
    // a code the node does not offer: nothing to lock
    expect(P.heroOffNodeOf(reads, ["R9", "F"], hi)).toBeNull();
  });

  it("heroSelfLockWeights: (a) the chart's range, else (b) the pool's, else (c) the tree's; his class added at 1 when the range lacks it", () => {
    const pool = COMBOS.map((c) => (c.cls === "K9o" ? 0.4 : c.cls === "QQ" ? 1 : 0));
    const tree = arr(0);
    const a = P.heroSelfLockWeights({ heroCls: "K9o", chart: { AA: 0.2, "22": 0.5 }, pool, tree });
    expect(a.source).toBe("chart");
    expect([clsW(a.weights, "AA"), clsW(a.weights, "22"), clsW(a.weights, "QQ"), clsW(a.weights, "K9o")]).toEqual([0.2, 0.5, 0, 1]);
    expect(a.classAdded).toBe(true);
    // a chart range that gives the action no hand at all falls through to the pool, which holds K9o: nothing added
    const b = P.heroSelfLockWeights({ heroCls: "K9o", chart: { AA: 0 }, pool, tree });
    expect(b.source).toBe("pool");
    expect(clsW(b.weights, "K9o")).toBe(0.4);
    expect(b.classAdded).toBe(false);
    // neither: the tree's own play (here nothing) + his class
    const c = P.heroSelfLockWeights({ heroCls: "K9o", chart: null, pool: null, tree });
    expect(c.source).toBe("tree");
    expect(c.weights.reduce((t, x) => t + x, 0)).toBe(12);
    expect(c.classAdded).toBe(true);
  });

  it("heroDecisionIndexOf / heroLimpAt: hero's m-th voluntary action, and whether it is a pool limp", () => {
    const h = limpHand();
    expect(P.heroDecisionIndexOf(h, 1)).toBe(2);
    expect(P.heroDecisionIndexOf(h, 2)).toBeNull();
    expect(P.heroLimpAt(h, "UTG", 2)).toEqual({ limpsBefore: 0, complete: false });
    expect(P.heroLimpAt(h, "UTG", 3)).toBeNull();                                  // not hero's call
    expect(PL.poolLimpKey({ limpsBefore: 0, complete: false }, 39)).toBe("limp_first_short_le60");
  });

  it("matchChartAction: the same token, a raise to the nearest size, our all-in to the largest", () => {
    const acts = [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }, { action: "Raise 2.5", token: "R2.5" }, { action: "Raise 8", token: "R8" }];
    expect(P.matchChartAction("C", acts)?.action).toBe("Call");
    expect(P.matchChartAction("R3", acts)?.action).toBe("Raise 2.5");
    expect(P.matchChartAction("RAI", acts)?.action).toBe("Raise 8");
    expect(P.matchChartAction("X", acts)).toBeNull();
    expect(P.matchChartAction("C", acts.filter((a) => a.token !== "C"))).toBeNull();
  });

  it("heroSelfLockReasons: the lock by design; an off-answer as a FAILED check (the loud flag)", () => {
    const base = { line: "", taken: "C", share: 0, source: "chart" as const, sourceText: "x", combos: 10, classAdded: false, offAnswer: false, chartSaid: null, secs: 1 };
    expect(P.heroSelfLockReasons(base, "K9o").map((r) => [r.v, r.code])).toEqual([["by-design", "preflop:hero-self-lock"]]);
    const off = P.heroSelfLockReasons({ ...base, classAdded: true, offAnswer: true, chartSaid: "Fold 100%" }, "K9o");
    expect(off.map((r) => [r.v, r.code])).toEqual([["by-design", "preflop:hero-self-lock"], ["failed", "preflop:hero-off-answer"]]);
    expect(off[1]!.text).toStartWith("HERO OFF-ANSWER:");
  });
});

// ── end to end, solvePreflopGtowAi over a fake GTO Wizard ─────────────────────────────────────────────────────────
describe("solvePreflopGtowAi: hero's hand at 0 everywhere at his node", () => {
  it("pf_limp1-001: his limp is locked to the chart's range WITH K9o ADDED, his node answered on the child, pinned; flagged OFF-ANSWER", async () => {
    chartAnswered();
    const log = fakeGtow();
    const h = limpHand();
    const r = await P.solvePreflopGtowAi(h, "UTG", "test");
    if (!r.ok) throw new Error(r.reason);
    expect(log.locks).toHaveLength(1);
    const lock = log.locks[0]!;
    expect(lock.action_history).toEqual([""]);
    expect(lock.previous_nodes_lock_type).toBe("street_all");
    const c = lock.strategy.find((s: any) => s.action === "C").strategy as number[];
    expect([clsW(c, "AA"), clsW(c, "22"), clsW(c, "K9o"), clsW(c, "72o")]).toEqual([0.2, 0.5, 1, 0]);
    // every combo's strategy sums to 1 over the node's actions
    const tot = (i: number) => lock.strategy.reduce((t: number, s: any) => t + s.strategy[i], 0);
    expect(Math.abs(tot(0) - 1) + Math.abs(tot(700) - 1)).toBeLessThan(1e-9);
    expect(mix(r)).toEqual({ Fold: 80, Call: 20 });
    expect(r.decision).not.toBeNull();
    expect(r.solId).toMatch(/^L/);
    expect(r.heroSelfLock).toMatchObject({ line: "", taken: "C", source: "chart", classAdded: true, offAnswer: true });
    expect(r.heroSelfLock!.chartSaid).toContain("Fold 100%");
    expect(r.note).toStartWith("HERO OFF-ANSWER:");
    expect(r.note).toContain("HERO SELF-LOCK:");
    expect(r.note).toContain("REVIEW THIS HAND");
    // the flop resumes from the locked child
    expect((Pin.preflopPinFor(h) as any).solId).toBe(r.solId);
  });

  it("a chart limp that held his class: locked to that range, no class added, no off-answer flag", async () => {
    chartAnswered({ Call: 30, Fold: 70 });
    const log = fakeGtow();
    const r = await P.solvePreflopGtowAi(limpHand(), "UTG", "test");
    if (!r.ok) throw new Error(r.reason);
    const c = log.locks[0]!.strategy.find((s: any) => s.action === "C").strategy as number[];
    expect(clsW(c, "K9o")).toBeCloseTo(0.3, 9);
    expect(r.heroSelfLock).toMatchObject({ source: "chart", classAdded: false, offAnswer: false });
    expect(r.note).toStartWith("HERO SELF-LOCK:");
    expect(r.note).not.toContain("HERO OFF-ANSWER");
  });

  it("no chart answered his limp (the stress harness, or an AI answer): the pool's first-in short limp range (39bb)", async () => {
    Object.assign(P.heroSelfLockSeams, { chartRecord: () => undefined });
    const log = fakeGtow();
    const r = await P.solvePreflopGtowAi(limpHand(), "UTG", "test");
    if (!r.ok) throw new Error(r.reason);
    const c = log.locks[0]!.strategy.find((s: any) => s.action === "C").strategy as number[];
    const pool = PL.poolLimpWeights("limp_first_short_le60");
    const inPool = clsW(pool, "K9o")! > 1e-4;
    for (const cls of ["AA", "72o", "T9s"]) expect(clsW(c, cls)).toBeCloseTo(clsW(pool, cls)!, 9);
    expect(clsW(c, "K9o")).toBeCloseTo(inPool ? clsW(pool, "K9o")! : 1, 9);
    expect(r.heroSelfLock).toMatchObject({ source: "pool", classAdded: !inPool, offAnswer: !inPool });
    expect(r.heroSelfLock!.sourceText).toContain("limp_first_short_le60");
  });

  it("the lock fails: an explicit refusal (HERO OFF HIS OWN TREE), never ok with an empty mix", async () => {
    chartAnswered();
    const log = fakeGtow({ lockFails: true });
    const h = limpHand();
    const r = await P.solvePreflopGtowAi(h, "UTG", "test");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe(P.HERO_OFF_TREE);
    expect(r.reason).toStartWith("HERO OFF HIS OWN TREE:");
    expect(r.reason).toContain("the self-lock failed");
    expect(log.locks).toHaveLength(1);
    expect(Pin.preflopPinFor(h)).toBeUndefined();
  });

  it("the locked child still gives his hand nothing: refused", async () => {
    chartAnswered();
    fakeGtow({ child: (lk) => childNodes(lk.strategy.find((s: any) => s.action === "C").strategy, true) });
    const r = await P.solvePreflopGtowAi(limpHand(), "UTG", "test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("still reads 0");
  });

  it("the lock does not answer inside POOL_LOCK_MS: refused, and nothing is pinned", async () => {
    chartAnswered();
    process.env.POOL_LOCK_MS = "30";
    Object.assign(P.heroSelfLockSeams, { chartNode: () => new Promise((res) => setTimeout(() => res(null), 400)) });
    fakeGtow();
    const h = limpHand();
    const r = await P.solvePreflopGtowAi(h, "UTG", "test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("did not answer inside");
    await Bun.sleep(500);
    expect(Pin.preflopPinFor(h)).toBeUndefined();
  });

  it("HERO_SELF_LOCK=off: refused at once, no lock posted", async () => {
    process.env.HERO_SELF_LOCK = "off";
    chartAnswered();
    const log = fakeGtow();
    const r = await P.solvePreflopGtowAi(limpHand(), "UTG", "test");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe(P.HERO_OFF_TREE);
    expect(r.reason).toStartWith("HERO OFF HIS OWN TREE:");
    expect(r.reason).toContain("HERO_SELF_LOCK=off");
    expect(log.locks).toHaveLength(0);
  });

  it("a hand the tree already holds is answered exactly as before (no lock)", async () => {
    chartAnswered();
    const log = fakeGtow();
    // AA: the tree's root gives AA the same 0 limp — but here hero OPENED, which the tree plays 15%
    const h = limpHand(["Ah", "Ad"]);
    (h.actions[2] as any).type = "raise"; (h.actions[2] as any).amount = 2;
    const r = await P.solvePreflopGtowAi(h, "UTG", "test");
    // the line is now R2-R4.1-…, a node this fake does not hold: what matters is that no lock was posted
    expect(log.locks).toHaveLength(0);
    if (r.ok) expect(r.heroSelfLock).toBeUndefined();
  });
});

// ── the locked trees refuse the same state (the regular answer self-locks instead) ───────────────────────────────
describe("solvePreflopColdCallLocked: hero's own open is off the locked tree", () => {
  it("hero's node on the locked child reads 0 for his hand: refused HERO_OFF_TREE (not ok with an empty mix)", async () => {
    const node = (actor: string, sols: [string, number][]) => ({ data: pnode(actor, sols.map(([c, p]) => [c, p] as [string, number])), cached: true });
    Object.assign(P.poolLockSeams, {
      solve: async () => ({ solId: "P" }),
      prefetch: () => {},
      lock: async () => ({ solId: "L" }),
      repair: async (_s: string, tokens: string[]) => ({ line: tokens.join("-"), changed: [] }),
      node: async (solId: string, line: string) => {
        if (line === "F-F-R2.5-F-R11") return solId === "P" ? node("BB", [["F", 0.95], ["C", 0], ["R25.3", 0.05]])
          : { data: pnode("BB", [["F", arr(0)], ["C", (await import("./poolColdCall")).coldCallWeights("coldcall3b_BB_40_80_large")], ["R25.3", arr(0)]]), cached: true };
        if (line === "F-F-R2.5-F-R11-C") return node("CO", [["F", 0], ["C", 0]]);
        return { error: `NODE_DOES_NOT_EXIST ${line}` };
      },
    });
    const a = (seat: number, type: string, amount?: number) => ({ seatId: seat, hero: seat === 3, type, street: "preflop", ...(amount != null ? { amount } : {}) });
    const st = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 60 };
    const h = {
      handId: 9001, clientHandId: "self-lock-cc", bbCents: 200, heroSeatId: 3, heroCards: ["7s", "2c"], board: [], street: "preflop",
      actions: [a(5, "post-sb", 0.5), a(6, "post-bb", 1), a(1, "fold"), a(2, "fold"), a(3, "raise", 2.5), a(4, "fold"), a(5, "raise", 11), a(6, "call", 11)],
      liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
      stacks: { ...st }, startStacks: { ...st },
      currentNode: { street: "preflop", toActSeatId: 3, toActIsHero: true, pot: 0, toCall: 8.5, legalActions: [], complete: false }, ended: false,
    } as unknown as ParsedHand;
    const r = await P.solvePreflopColdCallLocked(h, "CO", { pos: "BB", key: "coldcall3b_BB_40_80_large", stack: 60, size: "large" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe(P.HERO_OFF_TREE);
    expect(r.reason).toContain("HERO OFF HIS OWN TREE:");
    expect(r.reason).toContain("answered as before");
  });
});
