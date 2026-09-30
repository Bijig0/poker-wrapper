/**
 * ON DEMAND (2026-09-30, the CoinPoker ring strategy): the poller solves NOTHING until the panel's Solve button has put
 * a request on the wrapper's /state for the decision on screen. Without one it never calls /fast-solver (so never GTO
 * Wizard); with one it solves that decision once and keeps the answer alive; a press whose solve found nothing is not
 * retried every tick — pressing Solve again (a new `at`) is the retry. Same harness as studyPoller.test.ts: the ingest
 * probe and the solve are fetch stubs, GTO Wizard's client is a module mock.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ANSWERS_DB_PATH = join(mkdtempSync(join(tmpdir(), "answers-test-")), "answers.sqlite");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

mock.module("./gtowCdp", () => ({
  gtowCdp: {
    isConnected: async () => true,
    launchApp: async () => ({ ok: true, connected: true, relaunched: false }),
  },
  isRecoverableBlocker: () => true,
  SOLUTION_SETS: [],
}));

const { studyPoller } = await import("./studyPoller");
const { CP_RING_ANTE_STRATEGY_ID } = await import("./strategies");

let originalFetch: typeof fetch;
let calls: { url: string; body: unknown }[] = [];
let ingestResponse: unknown = { ok: false };
let fastSolveResponse: unknown = { ok: false };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("/panel/answer")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.includes("/fast-solver")) return new Response(JSON.stringify(fastSolveResponse), { status: 200 });
    if (url.includes("/ingest")) return new Response(JSON.stringify(ingestResponse), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  await studyPoller.stop();
  globalThis.fetch = originalFetch;
});

const solveCalls = () => calls.filter((c) => c.url.includes("/fast-solver"));
const pushes = () => calls.filter((c) => c.url.includes("/panel/answer")).map((c) => c.body as { text: string | null });

/** hero on the clock on the flop, under the on-demand strategy; `solveRequest` = the panel's Solve press */
const probe = (solveRequest: unknown, strategyId = CP_RING_ANTE_STRATEGY_ID) => ({
  ok: true, studyAnswersOn: true, strategyId, solveRequest,
  hero: { toAct: true, cards: ["Ah", "Kd"] },
  hand: { street: "flop", board: ["Kc", "7d", "2s"], node: { toCall: 0 }, actions: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
});
const answer = { ok: true, hand: { street: "flop" }, solution: { ok: true, decision: { action: "Check", frequency: 100 }, actions: [{ action: "Check", frequency: 100 }] } };

describe("on-demand strategy: the poller solves only what Solve asked for", () => {
  it("no Solve press: hero's turn goes by with no solve at all, and the panel shows no answer", async () => {
    ingestResponse = probe(null);
    fastSolveResponse = answer;
    studyPoller.start({ intervalMs: 20 });
    await wait(200);
    expect(solveCalls().length).toBe(0);
    expect(pushes().every((p) => p.text == null)).toBe(true);
    expect(studyPoller.getStatus().lastAnswer).toBeNull();
  });

  it("a Solve press: the decision is solved once, and the answer is kept alive while the request stands", async () => {
    ingestResponse = probe({ handId: 1, clientHandId: "h1", street: "flop", n: 9, at: 1000 });
    fastSolveResponse = answer;
    studyPoller.start({ intervalMs: 20 });
    await wait(250);
    expect(solveCalls().length).toBe(1);
    expect(studyPoller.getStatus().lastAnswer).toContain("Check");
    expect(pushes().filter((p) => p.text && p.text.includes("Check")).length).toBeGreaterThan(1);   // keep-alive pushes
  });

  it("the answer outlives the request's removal on the same decision (no re-solve, no blanking)", async () => {
    ingestResponse = probe({ handId: 1, clientHandId: "h1", street: "flop", n: 9, at: 2000 });
    fastSolveResponse = answer;
    studyPoller.start({ intervalMs: 20 });
    await wait(150);
    expect(solveCalls().length).toBe(1);
    ingestResponse = probe(null);    // the wrapper stopped exporting the press — same decision on screen
    const before = pushes().length;
    await wait(150);
    expect(solveCalls().length).toBe(1);
    expect(pushes().slice(before).every((p) => p.text && p.text.includes("Check"))).toBe(true);
  });

  it("a press whose solve found nothing is not retried every tick; pressing Solve again is the retry", async () => {
    ingestResponse = probe({ handId: 1, clientHandId: "h1", street: "flop", n: 9, at: 3000 });
    fastSolveResponse = { ok: true, hand: { street: "flop" }, solution: { ok: false, reason: "GTO Wizard AI: node does not exist" } };
    studyPoller.start({ intervalMs: 20 });
    await wait(300);
    expect(solveCalls().length).toBe(1);
    // a new press on the same decision
    ingestResponse = probe({ handId: 1, clientHandId: "h1", street: "flop", n: 9, at: 4000 });
    fastSolveResponse = answer;
    await wait(200);
    expect(solveCalls().length).toBe(2);
    expect(studyPoller.getStatus().lastAnswer).toContain("Check");
  });

  it("every other strategy still answers without being asked", async () => {
    ingestResponse = probe(null, "ign200-ring-6max-equilibrium");
    fastSolveResponse = answer;
    studyPoller.start({ intervalMs: 20 });
    await wait(150);
    expect(solveCalls().length).toBe(1);
  });
});
