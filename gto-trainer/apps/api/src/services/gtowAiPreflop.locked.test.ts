import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE NODE LOCK (2026-10-04, scripts/_probePreflopNodeLock.ts): a locked solution is a chain — the plain solution, then
 * one POST {parent_solution_id, last_node_lock} per lock. Here: its solve-cache key (tree + every lock, a plain solve's
 * key unchanged), the chain POSTed on the parent's account, a stored chain materialised after a restart by re-POSTing
 * tree, solution and every lock; and the locked last resort over its seams (lockedSeams). Hermetic: a fake fetch, a
 * stubbed session pool, temp cache files.
 */
let P: typeof import("./gtowAiPreflop");
let C: typeof import("./gtowSolveCache");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
let seams0: any;
beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  C = await import("./gtowSolveCache");
  ({ gtowSessions } = await import("./gtowSessions"));
  seams0 = { ...P.lockedSeams };
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
  P.setPreflopSolveCache(null);
  P.resetAiPreflopMemory();
});
const realFetch = globalThis.fetch;
const dirs: string[] = [];
const caches: { close(): void; flush(): void }[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(P.lockedSeams, seams0);
  P.setPreflopSolveCache(null);
  P.resetAiPreflopMemory();
  for (const c of caches.splice(0)) c.close();
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* WAL handle settling */ }
});
const tempFile = () => { const d = mkdtempSync(join(tmpdir(), "gtow-cache-lock-")); dirs.push(d); return join(d, "gtow-cache.sqlite"); };
const restartOn = (path: string) => {
  for (const old of caches) old.flush();
  P.resetAiPreflopMemory();
  const c = new C.GtowSolveCache({ path, flushMs: 1 });
  caches.push(c);
  P.setPreflopSolveCache(c);
  return c;
};

const arr = (x: number) => new Array(1326).fill(x);
const sol = (code: string, type: string, betsize: string, p: number, extra: object = {}) => ({ action: { code, type, betsize, allin: false, ...extra }, strategy: arr(p), evs: arr(0), total_frequency: p });
const nodeOf = (actor: string, sols: any[], chips: Record<string, number> = {}) => ({
  action_solutions: sols, game: { players: ["SB", "BB"].map((p) => ({ position: p, is_hero: p === actor, chips_on_table: String(chips[p] ?? 0) })) }, players_info: [],
});
const lock = (line: string): import("./gtowAiPreflop").NodeLock => ({ action_history: [line], strategy: [{ action: "F", strategy: arr(1) }], hands_locked: new Array(1326).fill(true), previous_nodes_lock_type: "street_all" });

describe("a locked solution in the solve cache", () => {
  it("its key is the tree + every lock; a plain solve's key is what it was", () => {
    const tree = { a: 1 }, s0 = { actions: "", board: "" };
    expect(C.cacheKeyOf("pre", tree, s0, []).key).toBe(C.cacheKeyOf("pre", tree, s0).key);
    const one = C.cacheKeyOf("pre", tree, s0, [lock("")]).key;
    expect(one).not.toBe(C.cacheKeyOf("pre", tree, s0).key);
    expect(C.cacheKeyOf("pre", tree, s0, [lock(""), lock("X")]).key).not.toBe(one);
  });

  it("the chain is POSTed on the parent's account; after a restart a node it lacks re-POSTs tree, solution and every lock", async () => {
    const posts: any[] = [];
    let seq = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/custom-trees/")) { posts.push({ kind: "tree" }); return Response.json({ id: `tree-${++seq}` }, { status: 201 }); }
      if (u.pathname.endsWith("/custom-solutions/")) { const b = JSON.parse(init.body); posts.push({ kind: b.parent_solution_id ? "lock" : "solution", body: b }); return Response.json({ id: `sol-${++seq}` }, { status: 201 }); }
      return Response.json(nodeOf("BB", [sol("F", "FOLD", "0", 1)]));
    }) as typeof fetch;
    const path = tempFile();
    restartOn(path);
    const body = { tree: "locked-test" };
    const parent = await P.lockedSeams.solve("k-lock-test", body);
    if ("error" in parent) throw new Error(parent.error);
    const locked = await P.lockedSolution(parent.solId, body, [lock(""), lock("X")]);
    if ("error" in locked) throw new Error(locked.error);
    expect(posts.map((p) => p.kind)).toEqual(["tree", "solution", "lock", "lock"]);
    expect(posts[2].body.parent_solution_id).toBe(parent.solId);
    expect(posts[3].body.parent_solution_id).toBe(posts[2].body ? "sol-3" : "?");
    expect(posts[3].body.last_node_lock.action_history).toEqual(["X"]);
    const first = await P.fetchNode(locked.solId, "R3");
    expect("error" in first).toBe(false);
    // the restart: the chain is in the store — handed out without a request, and a node it lacks mints the whole chain
    restartOn(path);
    posts.length = 0;
    const again = await P.lockedSolution("gc:parent-unused", body, [lock(""), lock("X")]);
    if ("error" in again) throw new Error(again.error);
    expect(again.solId.startsWith("gc:")).toBe(true);
    expect(posts.length).toBe(0);
    const stored = await P.fetchNode(again.solId, "R3");                // stored: no request
    expect("error" in stored).toBe(false);
    expect(posts.length).toBe(0);
    const miss = await P.fetchNode(again.solId, "R3-C");                // not stored: tree, solution, lock, lock, then the poll
    expect("error" in miss).toBe(false);
    expect(posts.map((p) => p.kind)).toEqual(["tree", "solution", "lock", "lock"]);
    expect(posts[3].body.last_node_lock.action_history).toEqual(["X"]);
  });
});

// ── the locked last resort over its seams ─────────────────────────────────────────────────────────────────────────
const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as const;
const SEAT = { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 } as const;
type Pp = keyof typeof SEAT;
const hand = (heroPos: Pp, acts: [Pp, string, number?][]): ParsedHand => {
  const hero = SEAT[heroPos];
  const a = (pos: Pp, type: string, amount?: number) => ({ seatId: SEAT[pos], hero: SEAT[pos] === hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
  return {
    handId: 1, clientHandId: "lr-locked", bbCents: 200, heroSeatId: hero, heroCards: ["Ah", "Kd"], board: [], street: "preflop",
    actions: [a("SB", "post-sb", 0.5), a("BB", "post-bb", 1), ...acts.map(([p, t, x]) => a(p, t, x))],
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { ...POS }, stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
};
function rig(nodes: Record<string, any>, range: number[] | null = arr(0.25)) {
  const asked = { locks: [] as any[], bodies: [] as any[], reads: [] as string[] };
  P.lockedSeams.rake = () => ({ rakeCapBb: 0.5, siteRake: undefined, anteBb: undefined } as any);
  P.lockedSeams.raiserRange = async () => (range ? { w: range, how: "his range on the exact tree up to the raise, then the share of it that makes the raise there" } : null);
  P.lockedSeams.solve = async (_k, body) => { asked.bodies.push(body); return { solId: "parent" }; };
  P.lockedSeams.lock = async (_p, _b, locks) => { asked.locks.push(...locks); return { solId: "locked" }; };
  P.lockedSeams.node = async (solId, line) => { asked.reads.push(`${solId}:${line}`); const n = nodes[`${solId}:${line}`]; return n ? { data: n, cached: false } : { error: "no such node" }; };
  return asked;
}

describe("the last resort on a locked tree", () => {
  it("raiser first (hero OOP): one lock at the root — the raise at his weights, the fold at the rest — and hero is read behind it", async () => {
    const asked = rig({
      "parent:": nodeOf("SB", [sol("F", "FOLD", "0", 0.3), sol("C", "CALL", "2.6", 0.1), sol("R8.2", "RAISE", "8.2", 0.6), sol("R100", "RAISE", "100", 0)]),
      "locked:R8.2": nodeOf("BB", [sol("F", "FOLD", "0", 0.2), sol("C", "CALL", "8.2", 0.5), sol("R18", "RAISE", "18", 0.3)], { SB: 8.2, BB: 2.6 }),
    });
    const h = hand("UTG", [["UTG", "raise", 2.6], ["HJ", "raise", 8.2], ["CO", "call", 8.2], ["BTN", "fold"], ["SB", "fold"], ["BB", "fold"]]);
    const r = await P.solveLockedLastResort(h, "UTG", "the exact tree cannot hold it");
    if (!r.ok) throw new Error(r.reason);
    expect(asked.locks.length).toBe(1);
    const l = asked.locks[0]!;
    expect(l.action_history).toEqual([""]);
    expect(l.strategy.map((x: any) => [x.action, x.strategy[0]])).toEqual([["F", 0.75], ["C", 0], ["R8.2", 0.25], ["R100", 0]]);
    expect(l.hands_locked.every(Boolean)).toBe(true);
    expect(r.usedLine).toBe("R8.2");
    expect(r.actions.map((a) => a.action)).toEqual(["Fold", "Call", "Raise 18"]);
    expect(r.pos).toBe("UTG");
    expect(asked.bodies[0].pot).toBe(1.5);                             // the folded blinds; CO's call is not dead
    expect(asked.bodies[0].players.map((p: any) => [p.position, p.blind])).toEqual([["SB", 0.01], ["BB", 2.6]]);
    expect(r.note).toContain("LAST RESORT, LOCKED TREE");
    expect(r.note).toContain("CO still in the hand (left out, with their chips)");
    expect(r.lastResort!.how).toContain("the raise locked to his range");
  });

  it("hero first (hero in position): his call of nothing locked for every hand, then the raiser's node — two locks; a raise named at the table's size", async () => {
    const asked = rig({
      "parent:": nodeOf("SB", [sol("F", "FOLD", "0", 0.1), sol("C", "CALL", "1", 0.9), sol("R2.5", "RAISE", "2.5", 0)]),
      "parent:C": nodeOf("BB", [sol("X", "CHECK", "0", 0.5), sol("R3.5", "RAISE", "3.5", 0.5)]),
      "locked:C-R3.5": nodeOf("SB", [sol("F", "FOLD", "0", 0.4), sol("C", "CALL", "3.5", 0.4), sol("R12", "RAISE", "12", 0.2)], { SB: 1, BB: 3.5 }),
    });
    const r = await P.solveLockedLastResort(hand("BTN", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5]]), "BTN", "why");
    if (!r.ok) throw new Error(r.reason);
    expect(asked.locks.map((l) => l.action_history[0])).toEqual(["", "C"]);
    expect(asked.locks[0].strategy.map((x: any) => [x.action, x.strategy[0]])).toEqual([["F", 0], ["C", 1], ["R2.5", 0]]);
    expect(asked.locks[1].strategy.map((x: any) => [x.action, x.strategy[0]])).toEqual([["X", 0.75], ["R3.5", 0.25]]);
    expect(r.usedLine).toBe("C-R3.5");
    expect(r.actions.map((a) => a.action)).toContain("Raise 11");   // R12 in the tree, 1 shifted (utils/lockedHeadsUp)
    expect(r.note).toContain("bigger than that");                     // 1.5 dead could not give the 2bb shift back
  });

  it("refuses — and the caller falls back — when the raiser cannot be read, the node is not priced as the table, or the raise is not offered", async () => {
    rig({}, null);
    const h = hand("BB", [["UTG", "raise", 3], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]]);
    const a = await P.solveLockedLastResort(h, "BB", "why");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toContain("cannot be read on the exact tree");
    rig({
      "parent:": nodeOf("SB", [sol("F", "FOLD", "0", 0.5), sol("R3", "RAISE", "3", 0.5)]),
      "locked:R3": nodeOf("BB", [sol("F", "FOLD", "0", 1)], { SB: 3, BB: 2 }),
    });
    const b = await P.solveLockedLastResort(h, "BB", "why");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toContain("not priced as the table");
    rig({ "parent:": nodeOf("SB", [sol("F", "FOLD", "0", 0.5), sol("R7", "RAISE", "7", 0.5)]) });
    const c = await P.solveLockedLastResort(h, "BB", "why");
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toContain("no raise to 3");
  });
});
