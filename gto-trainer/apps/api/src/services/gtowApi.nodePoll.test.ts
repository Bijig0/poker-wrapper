import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

/**
 * The node poll's request budget (2026-09-27). GTO Wizard answers 204 while a custom solve runs AND, forever, for a
 * line with no decision node; the chain used to poll up to 8 nodes of an unfinished solve in parallel and let the
 * missing ones run to their timeout. These pin: one readiness probe per solve, a first poll no sooner than
 * FIRST_POLL_MS after creation, a missing node given up after one grace retry, the old behaviour for any other shape.
 */
process.env.GTOW_POLL_MS = "20";
process.env.GTOW_FIRST_POLL_MS = "120";
let GtowApi: typeof import("./gtowApi").GtowApi;
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
beforeAll(async () => {
  ({ GtowApi } = await import("./gtowApi"));
  ({ gtowSessions } = await import("./gtowSessions"));
  const s = secondary();
  saved = { token: s.token, tokenExpMs: s.tokenExpMs };
  s.token = "t";
  s.tokenExpMs = Date.now() + 3_600_000;
});
// the session pool is a process-wide singleton: hand the token back, or later suites (studyPoller) see GTO Wizard connected
let saved: { token: string | null; tokenExpMs: number } = { token: null, tokenExpMs: 0 };
const secondary = () => (gtowSessions as unknown as { sessions: Map<string, { token: string | null; tokenExpMs: number }> }).sessions.get("secondary")!;
afterAll(() => { Object.assign(secondary(), saved); });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ask = { at: number; node: string };
/** A fake spot-solution endpoint: the solve is served after `readyAfterMs`; `nodes` exist, anything else is 204 forever. */
function fakeGtow(opts: { readyAfterMs: number; nodes: string[]; status?: (n: string) => number | null }): Ask[] {
  const asks: Ask[] = [];
  const t0 = Date.now();
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    const node = u.searchParams.get("river_actions") || u.searchParams.get("turn_actions") || u.searchParams.get("flop_actions") || "";
    asks.push({ at: Date.now() - t0, node });
    const forced = opts.status?.(node);
    if (forced) return new Response(JSON.stringify({ detail: "Request limit exceeded" }), { status: forced });
    if (Date.now() - t0 < opts.readyAfterMs || !opts.nodes.includes(node)) return new Response(null, { status: 204 });
    return Response.json({ action_solutions: [{ action: { code: "X" } }] });
  }) as typeof fetch;
  return asks;
}

function newApi(solId: string, createdAgoMs = 10_000) {
  const api = new GtowApi();
  (api as any).solOwner.set(solId, "secondary");
  (api as any).solCreatedAt.set(solId, Date.now() - createdAgoMs);
  return api;
}

describe("customNode request budget", () => {
  it("parallel asks on an unfinished solve: one probe polls the root, the rest wait, then one read each", async () => {
    const asks = fakeGtow({ readyAfterMs: 150, nodes: ["", "X", "B5"] });
    const api = newApi("sol-a");
    const board = "Td6h7s";
    const res = await Promise.all(["", "X", "B5", "X-X", "B5-C"].map((a) => api.customNode("sol-a", { flopActions: a, board })));
    expect(res.map((r) => r.ok)).toEqual([true, true, true, false, false]);
    // before the solve was served, only the root was polled
    const beforeReady = asks.filter((a) => a.at < 150);
    expect(new Set(beforeReady.map((a) => a.node))).toEqual(new Set([""]));
    // after it: the two real nodes once each, the two missing ones twice (one grace retry) — nothing else
    const after = asks.filter((a) => a.at >= 150 && a.node !== "");
    expect(after.filter((a) => a.node === "X").length).toBe(1);
    expect(after.filter((a) => a.node === "B5").length).toBe(1);
    expect(after.filter((a) => a.node === "X-X").length).toBe(2);
    expect(after.filter((a) => a.node === "B5-C").length).toBe(2);
    const missing = res[3] as { ok: false; status: number; error: string };
    expect(missing.status).toBe(204);
    expect(missing.error).toContain("no decision node");
  });

  it("a missing node on a solve already known ready costs two requests, not a 12 s poll", async () => {
    const asks = fakeGtow({ readyAfterMs: 0, nodes: ["", "X"] });
    const api = newApi("sol-b");
    const board = "Td6h7s2c";
    expect((await api.customNode("sol-b", { turnActions: "X", board })).ok).toBe(true);
    const t = Date.now();
    const r = await api.customNode("sol-b", { turnActions: "X-X", board });
    expect(r.ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(asks.filter((a) => a.node === "X-X").length).toBe(2);
  });

  it("the first poll of a fresh solve waits FIRST_POLL_MS after it was created", async () => {
    const asks = fakeGtow({ readyAfterMs: 0, nodes: [""] });
    const api = newApi("sol-c", 0);
    const r = await api.customNode("sol-c", { riverActions: "", board: "Td6h7s2c9d" });
    expect(r.ok).toBe(true);
    expect(asks[0].at).toBeGreaterThanOrEqual(110);
  });

  it("any other query shape keeps the old behaviour: polls through 204s until the strategy", async () => {
    const asks = fakeGtow({ readyAfterMs: 120, nodes: ["X"] });
    const api = newApi("sol-d");
    // flop AND turn actions against a turn board: not the chain's single-street shape
    const r = await api.customNode("sol-d", { flopActions: "X-X", turnActions: "X", board: "Td6h7s2c" });
    expect(r.ok).toBe(true);
    // it polled through the solve's 204s (however many the poll interval allows — another suite may have loaded the
    // module first, with the default 400 ms) and was not cut off by the missing-node grace
    expect(asks[0].at).toBeLessThan(120);
    expect(asks.length).toBeGreaterThanOrEqual(2);
    expect(asks.every((a) => a.node === "X")).toBe(true);    // and never probed a root
  });

  it("a probe started by a short-timeout prefetch does not fail a caller with time left: it re-probes", async () => {
    const asks = fakeGtow({ readyAfterMs: 450, nodes: ["", "X"] });
    const api = newApi("sol-f");
    const board = "Td6h7s";
    // the prefetch (250 ms) creates the probe; the walk (2 s) joins it 20 ms later
    const prefetch = api.customNode("sol-f", { flopActions: "X", board }, 250);
    await Bun.sleep(20);
    const walk = api.customNode("sol-f", { flopActions: "", board }, 2_000);
    const [p, w] = await Promise.all([prefetch, walk]);
    expect(p.ok).toBe(false);
    expect((p as { status: number }).status).toBe(504);
    expect(w.ok).toBe(true);
    // every poll before the solve was served went to the root — the walk never polled its own node in parallel
    expect(asks.filter((a) => a.at < 450).every((a) => a.node === "")).toBe(true);
  });

  it("a 429 on the probe reaches every waiting ask without them polling", async () => {
    const asks = fakeGtow({ readyAfterMs: 0, nodes: ["", "X"], status: (n) => (n === "" ? 429 : null) });
    const api = newApi("sol-e");
    const res = await Promise.all(["X", "B5", "X-X"].map((a) => api.customNode("sol-e", { flopActions: a, board: "Td6h7s" })));
    expect(res.every((r) => !r.ok && r.status === 429)).toBe(true);
    expect(asks.every((a) => a.node === "")).toBe(true);
    expect(asks.length).toBe(1);
  });
});
