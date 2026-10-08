import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

/**
 * THE HUNG-POLL BOUND (2026-10-08, core-real-4922578514 river: no answer after 19.0 s on a 15 s three-way node clock —
 * a poll got 8 s whatever was left of its read, twice). A REAL local HTTP server that accepts every request and never
 * replies stands in for GTO Wizard: fetch is pointed at it, so the only thing that can end a poll is its AbortSignal.
 */
process.env.GTOW_POLL_MS = "20";
let GtowApi: typeof import("./gtowApi").GtowApi;
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
type S = { token: string | null; tokenExpMs: number };
const sess = (id: string) => (gtowSessions as unknown as { sessions: Map<string, S> }).sessions.get(id)!;
let saved: Record<string, S> = {};

/** hangs every poll of the solves in `hang` (never replies); answers the rest; records each request's token and path */
let hang = new Set<string>();
const seen: { path: string; auth: string; sol: string | null }[] = [];
let server: ReturnType<typeof Bun.serve>;
const realFetch = globalThis.fetch;
const prevHang = process.env.GTOW_POLL_HANG_MS;

beforeAll(async () => {
  ({ GtowApi } = await import("./gtowApi"));
  ({ gtowSessions } = await import("./gtowSessions"));
  for (const id of ["primary", "secondary"]) {
    const s = sess(id);
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
afterEach(() => {
  hang = new Set();
  seen.length = 0;
  if (prevHang === undefined) delete process.env.GTOW_POLL_HANG_MS; else process.env.GTOW_POLL_HANG_MS = prevHang;
});

function apiOwning(solId: string, owner = "primary") {
  const api = new GtowApi();
  (api as any).solOwner.set(solId, owner);
  (api as any).solCreatedAt.set(solId, Date.now() - 10_000);
  return api;
}
const board = "Td6h7s";

describe("a poll that never replies", () => {
  it("is cut at the read's clock, not 8 s later (the per-poll cap is the read's remaining time)", async () => {
    hang.add("sol-h1");
    const api = apiOwning("sol-h1");
    const t0 = Date.now();
    const r = await api.customNode("sol-h1", { flopActions: "", board }, 1_200, "walk");
    const ms = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect((r as any).status).toBe(504);
    expect(ms).toBeLessThan(1_900);
    expect(ms).toBeGreaterThanOrEqual(1_150);
  });

  it("hangs past POLL_HANG_MS with a cold tree's cost left on the clock: `hung` at once (the walk re-posts elsewhere)", async () => {
    process.env.GTOW_POLL_HANG_MS = "300";
    hang.add("sol-h2");
    const api = apiOwning("sol-h2");
    const t0 = Date.now();
    const r = await api.customNode("sol-h2", { flopActions: "", board }, 3_000, "walk", { repostMs: 1_000 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.ok).toBe(false);
    expect((r as any).hung).toBe(true);
    expect((r as any).error).toMatch(/hung on primary/);
  });

  it("too little left to re-post: polls on to the clock and ends with no answer, as before (never `hung`)", async () => {
    process.env.GTOW_POLL_HANG_MS = "300";
    hang.add("sol-h3");
    const api = apiOwning("sol-h3");
    const t0 = Date.now();
    const r = await api.customNode("sol-h3", { flopActions: "", board }, 1_500, "walk", { repostMs: 5_000 });
    const ms = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect((r as any).hung).toBeUndefined();
    expect((r as any).status).toBe(504);
    expect(ms).toBeGreaterThanOrEqual(1_450);
    expect(ms).toBeLessThan(2_100);
    // every poll went to the owning account, several of them (each cut at 300 ms)
    const polls = seen.filter((x) => x.sol === "sol-h3");
    expect(polls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(polls.map((x) => x.auth))).toEqual(new Set(["Bearer tok-primary"]));
  });

  it("a read that joins another caller's probe waits no longer than its own clock", async () => {
    process.env.GTOW_POLL_HANG_MS = "1500";
    hang.add("sol-h4");
    const api = apiOwning("sol-h4");
    // the first caller (a warm-up, 10 s) starts the readiness probe; the second (1 s) joins it
    const slow = api.customNode("sol-h4", { flopActions: "", board }, 10_000, "warm");
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const r = await api.customNode("sol-h4", { flopActions: "X", board }, 1_000, "walk");
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_500);
    hang.delete("sol-h4");
    expect((await slow).ok).toBe(true);   // the first caller, on its own longer clock, gets the node once GTO Wizard answers
  });

  it("the re-post leaves the hung account out: the same tree is minted on another account and read there", async () => {
    const api = new GtowApi();
    const input: any = { board, pot: 6, stack: 97, oopRange: new Array(1326).fill(1), ipRange: new Array(1326).fill(1), oopPos: "BB", ipPos: "BTN" };
    const again = await api.ensureCustomSolution(input, { avoid: ["primary", "ultra-2"], noCache: true });
    expect(again.ok).toBe(true);
    expect((again as any).session).toBe("secondary");
    expect(seen.filter((x) => x.path.endsWith("/custom-trees/")).map((x) => x.auth)).toEqual(["Bearer tok-secondary"]);
    expect((again as any).route).toMatch(/least-loaded|fallback|budget/);
    // the solve's polls carry its own account's token
    const node = await api.customNode((again as any).solId, { flopActions: "", board }, 2_000, "walk");
    expect(node.ok).toBe(true);
    expect(seen.filter((x) => x.sol === (again as any).solId).every((x) => x.auth === "Bearer tok-secondary")).toBe(true);
    // nobody left: no answer, never the hung account again
    const none = await new GtowApi().ensureCustomSolution({ ...input, pot: 7 }, { avoid: ["primary", "secondary", "ultra-2"], noCache: true });
    expect(none.ok).toBe(false);
    expect((none as any).error).toMatch(/no other GTO Wizard account/);
  });

  it("a solve with no recorded owner is polled with ONE account's token for the whole read", async () => {
    hang.add("sol-h6");
    process.env.GTOW_POLL_HANG_MS = "200";
    const api = new GtowApi();
    (api as any).solCreatedAt.set("sol-h6", Date.now() - 10_000);
    await api.customNode("sol-h6", { flopActions: "", board }, 900, "walk");
    const auths = new Set(seen.filter((x) => x.sol === "sol-h6").map((x) => x.auth));
    expect(auths.size).toBe(1);
  });
});
