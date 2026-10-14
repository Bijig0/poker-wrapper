import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";

/**
 * THE HEDGE SOLVE and THE IN-FLIGHT COUNT (2026-10-14, hand 4924409679 — gtowApi header "WHAT A HUNG POLL IS"). A real
 * local HTTP server stands in for GTO Wizard (as gtowApi.hungPoll.test.ts): it answers every tree / solution POST and
 * every node read, except the solves in `hang`, which it never answers.
 */
process.env.GTOW_POLL_MS = "20";
let GtowApi: typeof import("./gtowApi").GtowApi;
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
type S = { token: string | null; tokenExpMs: number };
const sess = (id: string) => (gtowSessions as unknown as { sessions: Map<string, S> }).sessions.get(id)!;
let saved: Record<string, S> = {};
let hang = new Set<string>();
const seen: { path: string; auth: string; sol: string | null }[] = [];
let server: ReturnType<typeof Bun.serve>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ GtowApi } = await import("./gtowApi"));
  ({ gtowSessions } = await import("./gtowSessions"));
  for (const id of ["primary", "secondary", "ultra-2"]) {
    const s = sess(id);
    if (!s) continue;
    saved[id] = { token: s.token, tokenExpMs: s.tokenExpMs };
    s.token = `tok-${id}`;
    s.tokenExpMs = Date.now() + 3_600_000;
  }
  let made = 0;
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const sol = u.searchParams.get("custom_solution_id");
      seen.push({ path: u.pathname, auth: req.headers.get("authorization") ?? "", sol });
      if (u.pathname.endsWith("/custom-trees/")) return Response.json({ id: `tree-${++made}` });
      if (u.pathname.endsWith("/custom-solutions/")) return Response.json({ id: `sol-new-${made}` }, { status: 201 });
      if (sol && hang.has(sol)) return new Promise<Response>(() => { /* never replies */ });
      return Response.json({ action_solutions: [{ action: { code: "X", display_name: "CHECK" }, strategy: [1] }] });
    },
  });
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.hostname !== "api.gtowizard.com") return realFetch(input, init);
    return realFetch(`http://127.0.0.1:${server.port}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
  for (const [id, v] of Object.entries(saved)) Object.assign(sess(id), v);
});
afterEach(() => { hang = new Set(); seen.length = 0; });

const board = "Td6h7s";
const input = (pot: number): any => ({ board, pot, stack: 97, oopRange: new Array(1326).fill(1), ipRange: new Array(1326).fill(1), oopPos: "BB", ipPos: "BTN" });
const treesOn = (acct: string) => seen.filter((x) => x.path.endsWith("/custom-trees/") && x.auth === `Bearer tok-${acct}`).length;

describe("hedgeSolution", () => {
  it("posts a second solve of the same tree on another account without replacing the tree's solve; adoptSolution does", async () => {
    const api = new GtowApi();
    const first = await api.ensureCustomSolution(input(6), { noCache: true });
    expect(first.ok).toBe(true);
    const owner = (first as any).session as string;
    const hedge = await api.hedgeSolution(input(6), { avoid: [owner] });
    expect(hedge.ok).toBe(true);
    expect((hedge as any).session).not.toBe(owner);
    expect((hedge as any).solId).not.toBe((first as any).solId);
    expect((hedge as any).why).toMatch(/hedge/);
    expect(treesOn(owner)).toBe(1);
    // the tree still resolves to the FIRST solve (a hedge is never a tree-cache hit)…
    const again = await api.ensureCustomSolution(input(6), { noCache: true });
    expect((again as any).solId).toBe((first as any).solId);
    // …until the hedge is adopted
    api.adoptSolution(input(6), (hedge as any).solId);
    const after = await api.ensureCustomSolution(input(6), { noCache: true });
    expect((after as any).solId).toBe((hedge as any).solId);
    expect((after as any).session).toBe((hedge as any).session);
    // and the hedge's nodes are read with its own account's token
    const node = await api.customNode((hedge as any).solId, { flopActions: "", board }, 2_000, "walk");
    expect(node.ok).toBe(true);
    expect(seen.filter((x) => x.sol === (hedge as any).solId).every((x) => x.auth === `Bearer tok-${(hedge as any).session}`)).toBe(true);
  });

  it("is never a cache hit or a join: two hedges of one tree are two solves", async () => {
    const api = new GtowApi();
    const a = await api.hedgeSolution(input(7), {});
    const b = await api.hedgeSolution(input(7), {});
    expect(a.ok && b.ok).toBe(true);
    expect((a as any).solId).not.toBe((b as any).solId);
  });

  it("nobody left to take it: no answer, never the avoided accounts", async () => {
    const api = new GtowApi();
    const none = await api.hedgeSolution(input(8), { avoid: ["primary", "secondary", "ultra-2"] });
    expect(none.ok).toBe(false);
    expect((none as any).error).toMatch(/no other GTO Wizard account/);
    expect(seen.filter((x) => x.path.endsWith("/custom-trees/"))).toHaveLength(0);
  });

  // ONE HEDGE PER HUNG SOLVE (2026-10-14, session_20261014_161508): the warm-up's walk and the live walk hang on the same solve
  // within milliseconds and each posted a hedge — the sibling is only known once its POST returned
  it("two reads hanging on the same solve at once post ONE hedge: the second joins the first's POST", async () => {
    const api = new GtowApi();
    const first = await api.ensureCustomSolution(input(12), { noCache: true });
    expect(first.ok).toBe(true);
    const owner = (first as any).session as string, of = (first as any).solId as string;
    const [a, b] = await Promise.all([api.hedgeSolution(input(12), { avoid: [owner], of }), api.hedgeSolution(input(12), { avoid: [owner], of })]);
    expect(a.ok && b.ok).toBe(true);
    expect((a as any).solId).toBe((b as any).solId);
    expect([(a as any).created, (b as any).created].sort()).toEqual([false, true]);
    expect(([a, b].find((x) => !(x as any).created) as any).why).toMatch(/joined the second solve/);
    expect(seen.filter((x) => x.path.endsWith("/custom-trees/"))).toHaveLength(2);     // the first solve's tree + ONE hedge
    expect(api.hedgeSibling(of)).toBe((a as any).solId);
    // once the POST is back, a later hedge of the same solve is a new one (the caller checks hedgeSibling first, as aiChain does)
    const c = await api.hedgeSolution(input(12), { avoid: [owner], of });
    expect(seen.filter((x) => x.path.endsWith("/custom-trees/"))).toHaveLength(3);
    for (const id of [of, (a as any).solId, (c as any).solId]) gtowSessions.noteSolveReady(id);
  });

  it("hedges of different solves never join each other, nor do hedges with no `of`", async () => {
    const api = new GtowApi();
    const two = await Promise.all([api.hedgeSolution(input(13), { of: "sol-x" }), api.hedgeSolution(input(13), { of: "sol-y" })]);
    expect(seen.filter((x) => x.path.endsWith("/custom-trees/"))).toHaveLength(2);
    const more = await Promise.all([api.hedgeSolution(input(13), {}), api.hedgeSolution(input(13), {})]);
    expect(seen.filter((x) => x.path.endsWith("/custom-trees/"))).toHaveLength(4);
    // (the fake server's ids can collide under concurrency — the POST count is the evidence)
    for (const r of [...two, ...more]) if (r.ok) gtowSessions.noteSolveReady(r.solId);
  });
});

/** the accounts the hedge test's beforeAll gave a token */
const accounts = () => ["primary", "secondary", "ultra-2"].filter((id) => sess(id));

describe("a hedge goes only to an idle account (GTOW_HEDGE_IDLE_ONLY, default on)", () => {
  const prevHang = process.env.GTOW_POLL_HANG_MS, prevIdle = process.env.GTOW_HEDGE_IDLE_ONLY;
  // the in-flight count is the singleton's: start each case with nothing of ours running anywhere
  beforeEach(() => { (gtowSessions as any).flight.clear(); (gtowSessions as any).routed = []; });
  afterEach(() => {
    if (prevHang === undefined) delete process.env.GTOW_POLL_HANG_MS; else process.env.GTOW_POLL_HANG_MS = prevHang;
    if (prevIdle === undefined) delete process.env.GTOW_HEDGE_IDLE_ONLY; else process.env.GTOW_HEDGE_IDLE_ONLY = prevIdle;
  });
  /** a solve on some account that never answers, every OTHER account given a solve of ours in flight */
  const hungSolveEverybodyBusy = async (api: InstanceType<typeof GtowApi>, pot: number) => {
    const made = await api.ensureCustomSolution(input(pot), { noCache: true });
    expect(made.ok).toBe(true);
    const owner = (made as any).session as string, solId = (made as any).solId as string;
    hang.add(solId);
    const busy = accounts().filter((id) => id !== owner).map((id) => `busy-${pot}-${id}`);
    for (const id of accounts()) if (id !== owner) gtowSessions.noteSolvePosted(id, `busy-${pot}-${id}`);
    return { owner, solId, release: () => { for (const b of busy) gtowSessions.noteSolveReady(b); gtowSessions.noteSolveReady(solId); } };
  };

  it("every other account busy with a solve of ours: the hung read polls on to its clock instead of coming back `hung`", async () => {
    process.env.GTOW_POLL_HANG_MS = "300";
    delete process.env.GTOW_HEDGE_IDLE_ONLY;
    const api = new GtowApi();
    const h = await hungSolveEverybodyBusy(api, 14);
    const t0 = Date.now();
    const r = await api.customNode(h.solId, { flopActions: "", board }, 1_500, "walk", { repostMs: 500 });
    const ms = Date.now() - t0;
    h.release();
    expect(r.ok).toBe(false);
    expect((r as any).hung).toBeUndefined();
    expect((r as any).status).toBe(504);
    expect(ms).toBeGreaterThanOrEqual(1_400);
    expect(ms).toBeLessThan(2_300);
  });

  it("an idle account exists: `hung` at the cap, as before", async () => {
    process.env.GTOW_POLL_HANG_MS = "300";
    delete process.env.GTOW_HEDGE_IDLE_ONLY;
    const api = new GtowApi();
    const h = await hungSolveEverybodyBusy(api, 15);
    const idle = accounts().find((id) => id !== h.owner)!;
    gtowSessions.noteSolveReady(`busy-15-${idle}`);          // one other account has nothing running
    const t0 = Date.now();
    const r = await api.customNode(h.solId, { flopActions: "", board }, 3_000, "walk", { repostMs: 500 });
    h.release();
    expect(Date.now() - t0).toBeLessThan(1_200);
    expect(r.ok).toBe(false);
    expect((r as any).hung).toBe(true);
  });

  it("GTOW_HEDGE_IDLE_ONLY=off: `hung` even while every other account is busy (2026-10-14 03:39 behaviour)", async () => {
    process.env.GTOW_POLL_HANG_MS = "300";
    process.env.GTOW_HEDGE_IDLE_ONLY = "off";
    const api = new GtowApi();
    const h = await hungSolveEverybodyBusy(api, 16);
    const t0 = Date.now();
    const r = await api.customNode(h.solId, { flopActions: "", board }, 3_000, "walk", { repostMs: 500 });
    h.release();
    expect(Date.now() - t0).toBeLessThan(1_200);
    expect(r.ok).toBe(false);
    expect((r as any).hung).toBe(true);
  });
});

describe("the in-flight count (routing by solves running)", () => {
  it("a solve counts on its account from its POST until its first answered node", async () => {
    const api = new GtowApi();
    const made = await api.ensureCustomSolution(input(9), { noCache: true });
    expect(made.ok).toBe(true);
    const acct = (made as any).session as string;
    expect(gtowSessions.inFlight(acct)).toBeGreaterThanOrEqual(1);
    const before = gtowSessions.inFlight(acct);
    const node = await api.customNode((made as any).solId, { flopActions: "", board }, 2_000, "walk");
    expect(node.ok).toBe(true);
    expect(gtowSessions.inFlight(acct)).toBe(before - 1);
  });

  it("a hung solve keeps counting (its account is the busy one), so the hedge's routing leaves it behind", async () => {
    const api = new GtowApi();
    const made = await api.ensureCustomSolution(input(10), { noCache: true });
    expect(made.ok).toBe(true);
    const acct = (made as any).session as string;
    hang.add((made as any).solId);
    const before = gtowSessions.inFlight(acct);
    const r = await api.customNode((made as any).solId, { flopActions: "", board }, 300, "walk");
    expect(r.ok).toBe(false);
    expect(gtowSessions.inFlight(acct)).toBe(before);
    const ex = gtowSessions.explainRoute({ multiway: false });
    expect(ex.flight[acct]).toBe(before);
    expect(ex.ids.indexOf(acct)).toBeGreaterThan(0);
    gtowSessions.noteSolveReady((made as any).solId);
  });
});
