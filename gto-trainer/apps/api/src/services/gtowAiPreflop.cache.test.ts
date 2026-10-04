import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * The persistent solve cache's PREFLOP half (services/gtowSolveCache.ts at gtowAiPreflop's ensureSolution / fetchNode,
 * 2026-09-28): an AI preflop answer solved once is answered again after a restart with no request; GTO Wizard's
 * NODE_DOES_NOT_EXIST verdict is kept; a node the store lacks mints the stored tree once, from the body first POSTed.
 * Hermetic: a fake fetch, a stubbed session pool, temp cache files; resetAiPreflopMemory() is the restart.
 */
let P: typeof import("./gtowAiPreflop");
let C: typeof import("./gtowSolveCache");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  C = await import("./gtowSolveCache");
  ({ gtowSessions } = await import("./gtowSessions"));
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
  P.setPreflopSolveCache(null);
  P.resetAiPreflopMemory();
  for (const c of caches.splice(0)) c.close();
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* WAL handle settling */ }
});
const tempFile = () => { const d = mkdtempSync(join(tmpdir(), "gtow-cache-pre-")); dirs.push(d); return join(d, "gtow-cache.sqlite"); };
/** a restart: the old process's last writes flushed (its exit does that), the module's in-process maps forgotten, a
 *  fresh cache on the same file */
const restartOn = (path: string) => {
  for (const old of caches) old.flush();
  P.resetAiPreflopMemory();
  const c = new C.GtowSolveCache({ path, flushMs: 1 });
  caches.push(c);
  P.setPreflopSolveCache(c);
  return c;
};

interface FakeLog { tree: number; solution: number; poll: number; treeBodies: any[] }
function fakeGtow(nodes: Record<string, object | number>): FakeLog {
  const log: FakeLog = { tree: 0, solution: 0, poll: 0, treeBodies: [] };
  let seq = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/custom-trees/")) { log.tree++; log.treeBodies.push(JSON.parse(init.body)); return Response.json({ id: `tree-${++seq}` }, { status: 201 }); }
    if (u.pathname.endsWith("/custom-solutions/")) { log.solution++; return Response.json({ id: `sol-${++seq}` }, { status: 201 }); }
    log.poll++;
    const v = nodes[u.searchParams.get("preflop_actions") ?? ""];
    if (v === undefined) return new Response(null, { status: 204 });
    if (typeof v === "number") return new Response(JSON.stringify({ code: "NODE_DOES_NOT_EXIST", detail: "NODE_DOES_NOT_EXIST" }), { status: v });
    return Response.json(v);
  }) as typeof fetch;
  return log;
}
const reset = (log: FakeLog) => { log.tree = 0; log.solution = 0; log.poll = 0; log.treeBodies.length = 0; };

const arr = (x: number) => new Array(1326).fill(x);
const pnode = (actor: string, acts: [string, string, number][]) => ({
  game: { players: [{ position: actor, is_hero: true }] },
  action_solutions: acts.map(([code, type, f]) => ({ action: { code, type, betsize: code.startsWith("R") ? code.slice(1) : "" }, strategy: arr(f), total_frequency: f })),
});
const NODES: Record<string, object | number> = {
  "": pnode("BTN", [["F", "FOLD", 0.5], ["R2.5", "RAISE", 0.5]]),
  "R2.5": pnode("SB", [["F", "FOLD", 0.9], ["C", "CALL", 0.1]]),
  "R2.5-F": pnode("BB", [["F", "FOLD", 0.4], ["C", "CALL", 0.6]]),
  "R2.5-C": pnode("BB", [["F", "FOLD", 0.3], ["C", "CALL", 0.7]]),
  R7: 422,
};

/** Three-handed: the BTN opens 2.5, the SB folds, hero (BB) to act. */
const hand: ParsedHand = {
  handId: 1, clientHandId: "gtow-cache-pre-1", bbCents: 200, heroSeatId: 6, heroCards: ["Kh", "Qd"], board: [], street: "preflop",
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 5, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
  ],
  liveSeats: [1, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "SB", 5: "BTN", 6: "BB" }, stacks: { 1: 100, 5: 100, 6: 100 },
  currentNode: { street: "preflop", toActSeatId: 6, toActIsHero: true, pot: 4, toCall: 1.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand;

describe("AI preflop: every decision's node kept and read back (2026-10-04)", () => {
  it("the answer's record names its tree in the store; after a restart the node and every seat's range read back with ZERO requests", async () => {
    const path = tempFile();
    const log = fakeGtow(NODES);
    restartOn(path);
    const h = { ...hand, clientHandId: "gtow-cache-pre-kept" } as ParsedHand;
    const first = await P.solvePreflopGtowAi(h, null, "test");
    if (!first.ok) throw new Error(first.reason);
    await Bun.sleep(50);                                   // the pin's background pre-fetch of the prefix nodes
    const { preflopNodeFor } = await import("./preflopPin");
    const rec = preflopNodeFor(h, h.actions.length);
    if (!rec || rec.piece !== "gtow-ai-preflop") throw new Error("no AI record kept");
    expect(rec.cacheKey).toBeTruthy();
    expect(rec).not.toHaveProperty("warm");
    // a pin written before the key was kept: the tree's key is rebuilt from its shape and line — the same key
    expect(P.preflopCacheKeyOf({ ...rec, cacheKey: null, solId: "sol-from-another-process" })).toBe(rec.cacheKey!);
    reset(log);
    restartOn(path);
    const v = await P.livePreflopNodeView(rec, h.heroCards, P.storedPreflopGetter(P.preflopCacheKeyOf(rec)!));
    if (!v.ok) throw new Error(v.reason);
    expect([log.tree, log.solution, log.poll]).toEqual([0, 0, 0]);
    expect(v.hero?.pos).toBe("BB");
    expect(v.hero?.actions).toEqual(["Fold", "Call"]);
    expect(v.opponents.map((o) => o.pos)).toEqual(["BTN"]);   // the SB folded
    expect(v.opponents[0]!.action?.taken).toBe("Raise 2.5");
  });

  it("the store-only getter never asks GTO Wizard: a node it lacks is an error, not a request", async () => {
    const log = fakeGtow(NODES);
    restartOn(tempFile());
    const r = await P.storedPreflopGetter("no-such-tree")("R2.5");
    expect("error" in r && r.error).toContain("not in the GTO Wizard solve cache");
    expect([log.tree, log.solution, log.poll]).toEqual([0, 0, 0]);
  });
});

describe("AI preflop: the persistent solve cache", () => {
  it("an answer solved once is answered again after a restart with ZERO requests, and says it came from the cache", async () => {
    const path = tempFile();
    const log = fakeGtow(NODES);
    restartOn(path);
    const first = await P.solvePreflopGtowAi(hand, null, "test");
    if (!first.ok) throw new Error(first.reason);
    expect([log.tree, log.solution]).toEqual([1, 1]);
    expect(first.stored).toBeFalsy();
    await Bun.sleep(50);                                   // the pin's background pre-fetch of the prefix nodes
    reset(log);
    restartOn(path);
    const again = await P.solvePreflopGtowAi(hand, null, "test");
    if (!again.ok) throw new Error(again.reason);
    await Bun.sleep(50);
    expect([log.tree, log.solution, log.poll]).toEqual([0, 0, 0]);
    expect(again.stored).toBe(true);
    expect(again.note).toContain("from the GTO Wizard solve cache");
    expect(again.actions).toEqual(first.actions);
    // the preflop pin now names the stored tree — after a restart it resolves through the cache, not a dead id
    const { getPreflopPin } = await import("./preflopPin");
    const pin = getPreflopPin("gtow-cache-pre-1");
    expect(pin?.piece).toBe("gtow-ai-preflop");
    expect(pin?.piece === "gtow-ai-preflop" && pin.solId.startsWith("gc:")).toBe(true);
  });

  it("GTO Wizard's NODE_DOES_NOT_EXIST is kept: the same line after a restart gets the same verdict with no request", async () => {
    const path = tempFile();
    const log = fakeGtow(NODES);
    restartOn(path);
    const r1 = await P.debugPreflopNode(hand, null, "R7");
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.reason).toContain("NODE_DOES_NOT_EXIST");
    // the tree row is written with the tree's first node — here the verdict IS its first node
    reset(log);
    restartOn(path);
    const r2 = await P.debugPreflopNode(hand, null, "R7");
    expect(r2).toEqual(r1);
    expect([log.tree, log.solution, log.poll]).toEqual([0, 0, 0]);
  });

  it("a node the store lacks mints the stored tree once, from the very body first POSTed, and is kept from then on", async () => {
    const path = tempFile();
    const log = fakeGtow(NODES);
    restartOn(path);
    expect((await P.debugPreflopNode(hand, null, "R2.5-F")).ok).toBe(true);
    const firstBody = log.treeBodies[0];
    reset(log);
    restartOn(path);
    const [a, b] = await Promise.all([P.debugPreflopNode(hand, null, "R2.5-C"), P.debugPreflopNode(hand, null, "R2.5")]);
    expect(a.ok && b.ok).toBe(true);
    expect([log.tree, log.solution]).toEqual([1, 1]);
    expect(log.treeBodies[0]).toEqual(firstBody);
    reset(log);
    restartOn(path);
    const c = await P.debugPreflopNode(hand, null, "R2.5-C");
    expect(c).toEqual(a);
    expect([log.tree, log.solution, log.poll]).toEqual([0, 0, 0]);
  });

  it("with the cache off (every test's default) nothing is kept: the same answer twice is two solves", async () => {
    const log = fakeGtow(NODES);
    P.setPreflopSolveCache(null);                          // the process's cache — off under bun test
    expect((await P.debugPreflopNode(hand, null, "R2.5-F")).ok).toBe(true);
    P.resetAiPreflopMemory();
    expect((await P.debugPreflopNode(hand, null, "R2.5-F")).ok).toBe(true);
    expect([log.tree, log.solution]).toEqual([2, 2]);
  });
});
