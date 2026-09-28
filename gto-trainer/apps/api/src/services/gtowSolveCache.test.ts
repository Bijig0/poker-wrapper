import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE PERSISTENT GTO WIZARD SOLVE CACHE (services/gtowSolveCache.ts, 2026-09-28): the store itself, and the postflop
 * half wired beneath gtowApi's ensureCustomSolution / customNode. Hermetic: GTO Wizard is a fake fetch, the session pool
 * is stubbed (every account has a token), every cache is a temp file. Two GtowApi instances on one file stand for two
 * processes — an API before and after a restart.
 */
process.env.GTOW_POLL_MS = "20";
process.env.GTOW_FIRST_POLL_MS = "20";
let GtowApi: typeof import("./gtowApi").GtowApi;
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
let C: typeof import("./gtowSolveCache");

const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
beforeAll(async () => {
  ({ GtowApi } = await import("./gtowApi"));
  ({ gtowSessions } = await import("./gtowSessions"));
  C = await import("./gtowSolveCache");
  // the pool, stubbed: heads-up postflop on "secondary", multiway / preflop on "primary", a token for everyone
  const s = gtowSessions as any;
  for (const m of POOL_METHODS) savedPool.push({ m, own: Object.prototype.hasOwnProperty.call(s, m), fn: s[m] });
  s.route = (need: { multiway?: boolean; preflop?: boolean } = {}) => (need.multiway || need.preflop ? ["primary"] : ["secondary"]);
  s.routeIgnoringBlocks = s.route;
  s.liveFirst = (ids: string[]) => ids;
  s.tokenFor = async () => "t";
  s.bestToken = async () => ({ id: "primary", token: "t" });
  s.noteSuccess = () => {};
  s.noteFailure = () => null;
  s.forceRefresh = async () => true;
});
// the pool is a process-wide singleton: hand every method back, or later suites see a pool that always has a token
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of savedPool) { if (own) s[m] = fn; else delete s[m]; }
});

const realFetch = globalThis.fetch;
const dirs: string[] = [];
const caches: { close(): void }[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const c of caches.splice(0)) c.close();         // Windows will not delete a folder with an open database in it
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* WAL handle settling */ }
});
const tempFile = () => { const d = mkdtempSync(join(tmpdir(), "gtow-cache-")); dirs.push(d); return join(d, "gtow-cache.sqlite"); };
/** a cache on `path` — a second one on the same path is a second process */
const cacheOn = (path: string, opts: { days?: number; maxBytes?: number } = {}) => {
  const c = new C.GtowSolveCache({ path, flushMs: 1, ...opts });
  caches.push(c);
  return c;
};

type NodeSpec = object | number | ((n: number) => object | number);
interface FakeLog { tree: number; solution: number; poll: number; polls: string[]; treeBodies: any[]; solBodies: any[] }
/**
 * A fake api.gtowizard.com: custom-trees / custom-solutions answer 201 with fresh ids; spot-solution answers by the
 * node's action line — an object is the node (200), a number is that status, a function gets the poll count for that
 * line; an unknown line is 204 (no decision node, or still solving).
 */
function fakeGtow(nodes: Record<string, NodeSpec>): FakeLog {
  const log: FakeLog = { tree: 0, solution: 0, poll: 0, polls: [], treeBodies: [], solBodies: [] };
  let seq = 0;
  const seen = new Map<string, number>();
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/custom-trees/")) { log.tree++; log.treeBodies.push(JSON.parse(init.body)); return Response.json({ id: `tree-${++seq}` }, { status: 201 }); }
    if (u.pathname.endsWith("/custom-solutions/")) { log.solution++; log.solBodies.push(JSON.parse(init.body)); return Response.json({ id: `sol-${++seq}` }, { status: 201 }); }
    log.poll++;
    const p = u.searchParams;
    const line = p.get("preflop_actions") || p.get("river_actions") || p.get("turn_actions") || p.get("flop_actions") || "";
    log.polls.push(`${p.get("custom_solution_id")}|${line}`);
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    let v = nodes[line];
    if (typeof v === "function") v = v(n);
    if (v === undefined) return new Response(null, { status: 204 });
    if (typeof v === "number") {
      if (v === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ detail: v === 422 ? "NODE_DOES_NOT_EXIST" : v === 429 ? "Request limit exceeded" : "error" }), { status: v });
    }
    return Response.json(v);
  }) as typeof fetch;
  return log;
}
const resetLog = (log: FakeLog) => { log.tree = 0; log.solution = 0; log.poll = 0; log.polls.length = 0; log.treeBodies.length = 0; log.solBodies.length = 0; };

const node = (code: string, who = "BB") => ({
  game: { players: [{ position: who, is_hero: true }] },
  action_solutions: [{ action: { code, type: "CHECK", display_name: "Check" }, strategy: [0.25, 0.75], evs: [1.5, -0.25] }],
});
const full = new Array(1326).fill(1);
const tree = () => ({
  board: "Td6h7s", pot: 5, stack: 97.5, oopRange: full.slice(), ipRange: full.map((_, i) => (i % 3 ? 1 : 0.5)),
  oopPos: "BB", ipPos: "BTN", startingStreet: "FLOP" as const,
});
const BOARD = "Td6h7s";
/** the postflop tests poll: if another suite imported gtowApi first, its default 400 ms interval / 600 ms first poll apply */
const SLOW = 30_000;
const FLOP_NODES = { "": node("X"), X: node("X", "BTN"), B5: node("C"), C: node("X") };

/** Solve the root and "X" on a fresh process (instance A) and return the file it stored them in. */
async function solvedOnce(nodes: Record<string, NodeSpec> = FLOP_NODES) {
  const path = tempFile();
  const log = fakeGtow(nodes);
  const cache = cacheOn(path);
  const api = new GtowApi(cache);
  const ens = await api.ensureCustomSolution(tree());
  if (!ens.ok) throw new Error(ens.error);
  const root = await api.customNode(ens.solId, { flopActions: "", board: BOARD });
  const x = await api.customNode(ens.solId, { flopActions: "X", board: BOARD });
  if (!root.ok || !x.ok) throw new Error("fresh solve failed");
  cache.flush();
  return { path, log, api, cache, ens, root, x };
}

describe("the key", () => {
  it("ignores object key order and the fields two identical requests differ in, never array order or a value", () => {
    const sol = { actions: "", board: "Td6h7s" };
    const a = C.cacheKeyOf("post", { b: 1, a: [1, 2], nested: { y: 1, x: 2 } }, sol);
    expect(C.cacheKeyOf("post", { nested: { x: 2, y: 1 }, a: [1, 2], b: 1 }, sol).key).toBe(a.key);
    expect(C.cacheKeyOf("post", { b: 1, a: [1, 2], nested: { y: 1, x: 2, id: "tree-7", uuid: "u" }, created_at: "2026-09-28", account: "primary" }, sol).key).toBe(a.key);
    expect(C.cacheKeyOf("post", { b: 1, a: [2, 1], nested: { y: 1, x: 2 } }, sol).key).not.toBe(a.key);
    expect(C.cacheKeyOf("post", { b: 1, a: [1, 2.0000001], nested: { y: 1, x: 2 } }, sol).key).not.toBe(a.key);
    expect(C.cacheKeyOf("pre", { b: 1, a: [1, 2], nested: { y: 1, x: 2 } }, sol).key).not.toBe(a.key);
    expect(C.cacheKeyOf("post", { b: 1, a: [1, 2], nested: { y: 1, x: 2 } }, { actions: "", board: "Td6h7c" }).key).not.toBe(a.key);
    // the stored body is what was POSTed (nothing dropped), canonically ordered
    expect(JSON.parse(C.cacheKeyOf("post", { z: 1, id: "t" }, sol).body)).toEqual({ solution: sol, tree: { id: "t", z: 1 } });
    expect(C.normalizeForKey("post", { tree: { a: 1 }, solution: sol })).toEqual({ tree: { a: 1 }, solution: sol });
  });
});

describe("the store", () => {
  it("keeps full nodes and GTO Wizard's verdicts only — never a 204, 404, 429, 5xx or a refusal that is not about the line", () => {
    const path = tempFile();
    const c = cacheOn(path);
    c.noteTree("k1", "post", JSON.stringify({ tree: { a: 1 }, solution: { actions: "", board: "" } }));
    c.putNode("k1", "a", C.NODE_OK, JSON.stringify(node("X")));
    c.putNode("k1", "b", C.NO_NODE, null);
    c.putNode("k1", "c", -422, '{"detail":"NODE_DOES_NOT_EXIST"}');
    for (const [addr, st] of [["d", 204], ["e", 404], ["f", 429], ["g", 500], ["h", 401], ["i", -204 + 1]] as const) c.putNode("k1", addr, st, "{}");
    c.putNode("k1", "j", -400, '{"detail":"Invalid token"}');          // a 400 that says nothing about the line
    c.putNode("k1", "k", C.NODE_OK, null);                               // no body: nothing to keep
    c.putNode("k2", "a", C.NODE_OK, JSON.stringify(node("X")));          // a tree the store never saw: unreachable, not kept
    c.flush();
    const db = new Database(path, { readonly: true });
    const rows = db.query("SELECT key, addr, status FROM gtow_cache_nodes ORDER BY addr").all();
    const trees = db.query("SELECT key, kind FROM gtow_cache_trees").all();
    db.close();
    expect(rows).toEqual([{ key: "k1", addr: "a", status: 200 }, { key: "k1", addr: "b", status: -204 }, { key: "k1", addr: "c", status: -422 }]);
    expect(trees).toEqual([{ key: "k1", kind: "post" }]);
    // a second process reads them back: the node as sent, the verdicts as verdicts
    const c2 = cacheOn(path);
    expect(c2.getNode("k1", "a")!.data).toEqual(node("X"));
    expect(c2.getNode("k1", "b")!.status).toBe(C.NO_NODE);
    expect(c2.getNode("k1", "c")!.text).toContain("NODE_DOES_NOT_EXIST");
    expect(c2.getNode("k1", "d")).toBeNull();
    expect(c2.since.nodeHits).toBe(1);
    expect(c2.since.negHits).toBe(2);
    expect(c2.since.nodeMisses).toBe(1);
  });

  it("a full node replaces a stored verdict — a node GTO Wizard has since answered was never missing", () => {
    const path = tempFile();
    const c = cacheOn(path);
    c.noteTree("k", "post", "{}");
    c.putNode("k", "a", C.NO_NODE, null);
    c.flush();
    c.putNode("k", "a", C.NODE_OK, JSON.stringify(node("R5")));
    c.flush();
    expect(cacheOn(path).getNode("k", "a")!.data).toEqual(node("R5"));
  });

  it("retention: rows not hit for GTOW_CACHE_DAYS go at open; over the size cap the least-recently-hit nodes go first", () => {
    const path = tempFile();
    const c = cacheOn(path);
    const junk = (n: number) => JSON.stringify({ action_solutions: [{ pad: Array.from({ length: n }, () => Math.random().toString(36).slice(2)).join("") }] });
    c.noteTree("old", "post", "{}");
    c.putNode("old", "x", C.NODE_OK, junk(10));
    c.noteTree("new", "post", "{}");
    for (const a of ["n1", "n2", "n3", "n4", "n5"]) c.putNode("new", a, C.NODE_OK, junk(1500));   // ~20 KB each, incompressible
    c.close();
    const now = Date.now();
    const db = new Database(path);
    db.query("UPDATE gtow_cache_trees SET last_hit_ms = ? WHERE key = 'old'").run(now - 61 * 86_400_000);
    db.query("UPDATE gtow_cache_nodes SET last_hit_ms = ? WHERE key = 'old'").run(now - 61 * 86_400_000);
    ["n1", "n2", "n3", "n4", "n5"].forEach((a, i) => db.query("UPDATE gtow_cache_nodes SET last_hit_ms = ? WHERE addr = ?").run(now - (10 - i) * 60_000, a));
    const total = (db.query("SELECT SUM(bytes) b FROM gtow_cache_nodes WHERE key = 'new'").get() as { b: number }).b;
    expect(db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });   // a new file can give pages back
    db.close();
    // a cap that holds ~3 of the 5: the two least-recently hit (n1, n2) go, and the 61-day-old tree with its node
    const c2 = cacheOn(path, { days: 60, maxBytes: Math.round(total * 0.62) });
    const s = c2.stats();
    expect(s.rows.trees).toBe(1);
    const db2 = new Database(path, { readonly: true });
    const left = db2.query("SELECT addr FROM gtow_cache_nodes ORDER BY addr").all().map((r: any) => r.addr);
    db2.close();
    expect(left).not.toContain("x");
    expect(left).not.toContain("n1");
    expect(left).toContain("n5");
    expect(left.length).toBeLessThanOrEqual(3);
    expect(s.rows.storedBytes).toBeLessThanOrEqual(total * 0.62);
  });

  it("is off under bun test unless a temp file is named, off by GTOW_CACHE=off / GTOW_CACHE_DB_PATH=off, and refuses a live path", () => {
    expect(C.gtowSolveCache.enabled).toBe(false);                                     // this process: no GTOW_CACHE_DB_PATH
    expect(C.solveCacheFromEnv({ NODE_ENV: "test" } as any).enabled).toBe(false);
    const path = tempFile();
    const on = C.solveCacheFromEnv({ NODE_ENV: "test", GTOW_CACHE_DB_PATH: path } as any);
    caches.push(on);
    expect(on.enabled).toBe(true);
    expect(C.solveCacheFromEnv({ NODE_ENV: "test", GTOW_CACHE_DB_PATH: path, GTOW_CACHE: "off" } as any).enabled).toBe(false);
    expect(C.solveCacheFromEnv({ NODE_ENV: "test", GTOW_CACHE_DB_PATH: "off" } as any).enabled).toBe(false);
    expect(() => new C.GtowSolveCache({ path: "C:/Users/Public/not-a-temp-dir/gtow-cache.sqlite" })).toThrow(/refusing/);
  });
});

describe("postflop: beneath ensureCustomSolution / customNode", () => {
  it("the same tree in a second process: a stored tree and a stored node cost ZERO requests", async () => {
    const a = await solvedOnce();
    expect([a.log.tree, a.log.solution]).toEqual([1, 1]);
    expect(a.ens.ok && a.ens.created).toBe(true);
    resetLog(a.log);
    const cache = cacheOn(a.path);
    const api = new GtowApi(cache);
    const ens = await api.ensureCustomSolution(tree());
    if (!ens.ok) throw new Error(ens.error);
    expect(ens.solId.startsWith("gc:")).toBe(true);
    expect(ens).toMatchObject({ created: false, stored: true, session: "cache" });
    const x = await api.customNode(ens.solId, { flopActions: "X", board: BOARD }, undefined, "walk");
    expect(x.ok && x.store && x.src).toBe("cache");
    expect(x.ok && x.data).toEqual(node("X", "BTN"));
    // what the chain's size-free-tree reuse peeks at (aiChain) sees the stored tree and nodes too, without a hit counted
    expect(api.peekSolution(tree())).toBe(ens.solId);
    expect(api.peekNode(ens.solId, { flopActions: "", board: BOARD })).toEqual(node("X"));
    const solved = await api.customSolve({ ...tree(), flopActions: "" });
    expect(solved.ok && solved.stored).toBe(true);
    expect([a.log.tree, a.log.solution, a.log.poll]).toEqual([0, 0, 0]);
    expect(cache.since).toMatchObject({ treeHits: 1, nodeHits: 2, materialised: 0 });
    expect(cache.since.requestsSaved).toBe(4);   // a tree and a solution POST, and two polls
  }, SLOW);

  it("a node the store lacks mints the stored tree ONCE — concurrent misses join — from the very body first POSTed", async () => {
    const a = await solvedOnce();
    const firstBody = a.log.treeBodies[0];
    resetLog(a.log);
    const cache = cacheOn(a.path);
    const api = new GtowApi(cache);
    const ens = await api.ensureCustomSolution(tree());
    if (!ens.ok) throw new Error(ens.error);
    const [b5, c] = await Promise.all([
      api.customNode(ens.solId, { flopActions: "B5", board: BOARD }, 5_000, "walk"),
      api.customNode(ens.solId, { flopActions: "C", board: BOARD }, 5_000, "walk"),
    ]);
    expect(b5.ok && c.ok).toBe(true);
    expect([a.log.tree, a.log.solution]).toEqual([1, 1]);
    expect(a.log.treeBodies[0]).toEqual(firstBody);
    expect(a.log.solBodies[0]).toMatchObject({ actions: "", board: BOARD });
    expect(cache.since.materialised).toBe(1);
    // the materialised solve's owner is the account routing chose; ensure reports it from now on
    const again = await api.ensureCustomSolution(tree());
    expect(again.ok && again.session).toBe("secondary");
    // …and what it answered is stored: a third process reads both with no request
    cache.flush();
    resetLog(a.log);
    const api3 = new GtowApi(cacheOn(a.path));
    const e3 = await api3.ensureCustomSolution(tree());
    if (!e3.ok) throw new Error(e3.error);
    const [b5b, cb] = await Promise.all(["B5", "C"].map((l) => api3.customNode(e3.solId, { flopActions: l, board: BOARD })));
    expect(b5b.ok && b5b.store && cb.ok && cb.store).toBe(true);
    expect(a.log.tree + a.log.solution + a.log.poll).toBe(0);
  }, SLOW);

  it("a speculative prefetch never mints a stored tree; it joins the solve once the walk mints it", async () => {
    const a = await solvedOnce();
    resetLog(a.log);
    const api = new GtowApi(cacheOn(a.path));
    const ens = await api.ensureCustomSolution(tree());
    if (!ens.ok) throw new Error(ens.error);
    const alone = await api.customNode(ens.solId, { flopActions: "B5", board: BOARD }, 150, "prefetch");
    expect(alone.ok).toBe(false);
    expect(a.log.tree + a.log.solution + a.log.poll).toBe(0);
    // the prefetch asks first and waits; the walk's miss mints the tree; the prefetch then reads on that solve
    const pre = api.customNode(ens.solId, { flopActions: "B5", board: BOARD }, 5_000, "prefetch");
    await Bun.sleep(30);
    const walk = await api.customNode(ens.solId, { flopActions: "C", board: BOARD }, 5_000, "walk");
    const p = await pre;
    expect(walk.ok && p.ok).toBe(true);
    expect([a.log.tree, a.log.solution]).toEqual([1, 1]);
  }, SLOW);

  it("stores the finished reply, never the 204s before it or a 429; a no-node verdict is served to the prefetch only", async () => {
    const path = tempFile();
    let rootPolls = 0;
    const log = fakeGtow({ "": () => (++rootPolls < 3 ? 204 : node("X")), X: node("X"), R9: 429 });
    const cache = cacheOn(path);
    const api = new GtowApi(cache);
    const ens = await api.ensureCustomSolution(tree());
    if (!ens.ok) throw new Error(ens.error);
    expect((await api.customNode(ens.solId, { flopActions: "", board: BOARD })).ok).toBe(true);
    const walled = await api.customNode(ens.solId, { flopActions: "R9", board: BOARD });
    expect(!walled.ok && walled.status).toBe(429);
    const none = await api.customNode(ens.solId, { flopActions: "X-X", board: BOARD });   // served solve, 204 twice
    expect(!none.ok && none.status).toBe(204);
    cache.flush();
    const db = new Database(path, { readonly: true });
    const rows = db.query("SELECT addr, status FROM gtow_cache_nodes ORDER BY status DESC").all();
    db.close();
    expect(rows).toEqual([{ addr: `||||${BOARD}`, status: 200 }, { addr: `|X-X|||${BOARD}`, status: -204 }]);
    // another process: the prefetch is told "no node" from the store; the walk asks GTO Wizard again
    resetLog(log);
    const api2 = new GtowApi(cacheOn(path));
    const e2 = await api2.ensureCustomSolution(tree());
    if (!e2.ok) throw new Error(e2.error);
    const pre = await api2.customNode(e2.solId, { flopActions: "X-X", board: BOARD }, 1_000, "prefetch");
    expect(!pre.ok && pre.store && pre.status).toBe(204);
    expect(log.tree + log.solution + log.poll).toBe(0);
    const walk = await api2.customNode(e2.solId, { flopActions: "X-X", board: BOARD }, 3_000, "walk");
    expect(!walk.ok && walk.store).toBeFalsy();
    expect(log.tree).toBe(1);
  }, SLOW);

  it("noCache (the poller's startup probe): neither served from the store nor written to it", async () => {
    const a = await solvedOnce();
    resetLog(a.log);
    const cache = cacheOn(a.path);
    const api = new GtowApi(cache);
    const r = await api.customSolve({ ...tree(), flopActions: "X" }, { noCache: true });
    expect(r.ok && r.stored).toBeFalsy();
    expect(r.ok && r.session).toBe("secondary");
    expect([a.log.tree, a.log.solution]).toEqual([1, 1]);
    expect(a.log.poll).toBeGreaterThan(0);
    cache.flush();
    expect(cache.since).toMatchObject({ treeHits: 0, nodeHits: 0, stored: 0 });
  }, SLOW);

  it("a 429 mid-walk forgets the stored tree's solve: the next read mints it again on the account routing allows now", async () => {
    const a = await solvedOnce();
    resetLog(a.log);
    let bPolls = 0;
    fakeGtow({ ...FLOP_NODES, B5: () => (++bPolls === 1 ? 429 : node("C")) });
    const api = new GtowApi(cacheOn(a.path));
    const ens = await api.ensureCustomSolution(tree());
    if (!ens.ok) throw new Error(ens.error);
    const first = await api.customNode(ens.solId, { flopActions: "B5", board: BOARD }, 3_000, "walk");
    expect(!first.ok && first.status).toBe(429);
    api.forgetSolution(ens.solId);                       // what aiChain does on a 429, then ensure again
    const again = await api.ensureCustomSolution(tree());
    expect(again.ok && again.solId).toBe(ens.solId);     // still the stored tree — no request for it
    const second = await api.customNode(ens.solId, { flopActions: "B5", board: BOARD }, 3_000, "walk");
    expect(second.ok).toBe(true);
  }, SLOW);
});
