import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE EXACT RECORD OF AN AI PREFLOP ANSWER (2026-10-14, the answer-path audit's finding 9; gtowAiPreflop.AiPreflopTrace).
 * A served answer carries a trace of the tree request as POSTed, the account, the solution id and cache key, the line as
 * walked and as read, hero's node as GTO Wizard sent it and the mix served; stored through services/solveStore it reads
 * back exactly, and the hand page's view rebuilds from the trace ALONE — an empty cache, a restarted process, no request.
 * Hermetic: a fake fetch, a stubbed session pool, temp cache and store files (the cache test's harness).
 */
let P: typeof import("./gtowAiPreflop");
let C: typeof import("./gtowSolveCache");
let SS: typeof import("./solveStore");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  C = await import("./gtowSolveCache");
  SS = await import("./solveStore");
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
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "gtow-pre-trace-")); dirs.push(d); return d; };
const freshCache = (path: string) => {
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

const arr = (x: number) => new Array(1326).fill(x);
const pnode = (actor: string, acts: [string, string, number][], evs = false) => ({
  game: { players: [{ position: actor, is_hero: true }] },
  action_solutions: acts.map(([code, type, f], i) => ({ action: { code, type, betsize: code.startsWith("R") ? code.slice(1) : "" }, strategy: arr(f), total_frequency: f,
    ...(evs ? { evs: arr(10 * (i + 1)) } : {}) })),
});
const NODES: Record<string, object | number> = {
  "": pnode("BTN", [["F", "FOLD", 0.5], ["R2.5", "RAISE", 0.5]], true),
  "R2.5": pnode("SB", [["F", "FOLD", 0.9], ["C", "CALL", 0.1]]),
  "R2.5-F": pnode("BB", [["F", "FOLD", 0.4], ["C", "CALL", 0.6]], true),
  R7: 422,
};

/** Three-handed: the BTN opens 2.5, the SB folds, hero (BB) to act. */
const hand: ParsedHand = {
  handId: 1, clientHandId: "gtow-pre-trace-1", bbCents: 200, heroSeatId: 6, heroCards: ["Kh", "Qd"], board: [], street: "preflop",
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 5, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
  ],
  liveSeats: [1, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "SB", 5: "BTN", 6: "BB" }, stacks: { 1: 100, 5: 100, 6: 100 },
  currentNode: { street: "preflop", toActSeatId: 6, toActIsHero: true, pot: 4, toCall: 1.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand;

describe("AI preflop: the served answer's exact record (2026-10-14)", () => {
  it("the answer carries the tree as POSTed, the account, solution and cache key, the line, hero's node as sent and the mix served", async () => {
    const dir = tempDir();
    const log = fakeGtow(NODES);
    freshCache(join(dir, "gtow-cache.sqlite"));
    const r = await P.solvePreflopGtowAi(hand, null, "test");
    if (!r.ok) throw new Error(r.reason);
    await Bun.sleep(50);
    const t = r.trace!;
    expect(t.kind).toBe("preflop-ai");
    expect(t.request.bodyFrom).toBe("posted");
    expect(t.request.body).toEqual(log.treeBodies[0]);                       // exactly what went to /custom-trees/
    expect(t.request.account).toBe("primary");
    expect(t.request.solId).toBe(r.solId);
    expect(t.request.cacheKey).toBeTruthy();
    expect(t.request.locks).toEqual([]);
    expect(t.request.stored).toBe(false);
    // the seats: API position, the table's name, the seat, the stack sent, the blind posted
    expect(t.seats).toEqual([
      { api: "BTN", table: "BTN", seat: 5, stack: 100, blind: null },
      { api: "SB", table: "SB", seat: 1, stack: 100, blind: 0.5 },
      { api: "BB", table: "BB", seat: 6, stack: 100, blind: 1 },
    ]);
    expect(t.menu).not.toBeNull();
    expect(t.line).toEqual({ raw: "R2.5-F", used: "R2.5-F", snapped: [] });
    // hero's node as GTO Wizard sent it, and his own row read out of it
    expect(t.hero.pos).toBe("BB");
    expect(t.hero.cards).toBe("KhQd");
    expect(t.hero.class).toBe("KQo");
    expect(t.hero.node?.line).toBe("R2.5-F");
    expect(t.hero.node?.actor).toBe("BB");
    expect(t.hero.node?.data).toEqual(NODES["R2.5-F"]);
    expect(t.hero.node?.actions.map((a) => [a.label, a.strategy, a.ev, a.totalFrequency])).toEqual([["Fold", 0.4, 10, 0.4], ["Call", 0.6, 20, 0.6]]);
    expect(t.hero.mix).toEqual(r.actions);
    expect(t.hero.decision).toEqual(r.decision);
    // every prefix node the walk read is kept (without its EVs), so the record stands on its own
    expect(t.prefix.map((p) => [p.line, p.actor, p.taken, p.where])).toEqual([["", "BTN", "R2.5", "memory"], ["R2.5", "SB", "F", "memory"]]);
    expect(t.prefix[0]!.data.action_solutions[0]).not.toHaveProperty("evs");
    expect(t.cached).toBe(false);
    expect(t.stored).toBe(false);
    expect(t.repostedFrom).toBeNull();
  });

  it("stored through the solve store it reads back exactly, and the hand page's view rebuilds from the trace alone — empty cache, fresh process, no request", async () => {
    const dir = tempDir();
    fakeGtow(NODES);
    freshCache(join(dir, "gtow-cache.sqlite"));
    const r = await P.solvePreflopGtowAi(hand, null, "test");
    if (!r.ok) throw new Error(r.reason);
    await Bun.sleep(50);
    const store = new SS.SolveStore(join(dir, "solves.sqlite"));
    const id = store.save({ origin: "preflop-ai", clientHandId: hand.clientHandId, wrapperHandId: hand.handId, decisionKey: "k", street: "preflop", board: null,
      heroCards: "KhQd", heroPos: "BB", tier: "ai-preflop", line: r.usedLine, solves: 1, solveMs: 1, ok: true, why: null }, r.trace);
    expect(id).toBeGreaterThan(0);
    const got = store.forAnswer(id, hand.clientHandId, "k");
    if (!got.ok) throw new Error(got.error);
    expect(got.via).toBe("id");
    expect(got.row.origin).toBe("preflop-ai");
    expect(got.trace).toEqual(JSON.parse(JSON.stringify(r.trace)));
    // a restarted process with an EMPTY cache: the view comes from the stored trace, GTO Wizard is never asked
    const log = fakeGtow(NODES);
    freshCache(join(dir, "gtow-cache-empty.sqlite"));
    const v = await P.preflopViewFromTrace(got.trace, hand.heroCards);
    if (!v.ok) throw new Error(v.reason);
    expect([log.tree, log.solution, log.poll]).toEqual([0, 0, 0]);
    expect(v.hero?.pos).toBe("BB");
    expect(v.hero?.actions).toEqual(["Fold", "Call"]);
    expect(P.actionPct(v.hero!.strategy!, 0)).toBe(40);                     // hero's class folds 40% at his node, calls 60%
    expect(P.actionPct(v.hero!.strategy!, 1)).toBe(60);
    expect(v.opponents.map((o) => o.pos)).toEqual(["BTN"]);                   // the SB folded
    expect(v.opponents[0]!.action?.taken).toBe("Raise 2.5");
    expect(v.folded?.map((f) => f.pos)).toEqual(["SB"]);
  });

  it("the record is kept under the TABLE's decision index when the piece reads a reduced hand (the last resort)", async () => {
    const dir = tempDir();
    fakeGtow(NODES);
    freshCache(join(dir, "gtow-cache.sqlite"));
    const h = { ...hand, clientHandId: "gtow-pre-trace-idx" } as ParsedHand;
    const r = await P.solvePreflopGtowAi(h, null, "test", { actionIndex: 9 });
    if (!r.ok) throw new Error(r.reason);
    const { preflopNodeFor } = await import("./preflopPin");
    expect(preflopNodeFor(h, 9)?.piece).toBe("gtow-ai-preflop");
    expect(preflopNodeFor(h, h.actions.length)).toBeUndefined();
  });
});
