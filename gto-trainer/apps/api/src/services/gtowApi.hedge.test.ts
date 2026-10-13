import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

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
