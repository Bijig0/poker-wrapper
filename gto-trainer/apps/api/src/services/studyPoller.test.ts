import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// gtowCdp opens a real CDP connection when unmocked — replace it before
// studyPoller (which imports it directly) is loaded. ingest.ts (imported
// transitively for DEFAULT_LIVE_URL, though its route body never runs here
// since fetch itself is mocked below) also needs isRecoverableBlocker and
// SOLUTION_SETS to exist on this module, even as unused stubs.
let gtowConnected = true;
let launchAppCalls: { force?: boolean }[] = [];
mock.module("./gtowCdp", () => ({
  gtowCdp: {
    isConnected: async () => gtowConnected,
    launchApp: async (opts?: { force?: boolean }) => {
      launchAppCalls.push(opts ?? {});
      return { ok: true, connected: true, relaunched: false };
    },
  },
  isRecoverableBlocker: () => true,
  SOLUTION_SETS: [],
}));

const { studyPoller } = await import("./studyPoller");

let originalFetch: typeof fetch;
let calls: { url: string; body: unknown }[] = [];
/** Set per-test to control the mocked ingest response body. */
let ingestResponse: unknown = { ok: false };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  gtowConnected = true;
  launchAppCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("/panel/answer")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/ingest")) {
      if (ingestResponse === "REJECT") throw new Error("network down");
      return new Response(JSON.stringify(ingestResponse), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  await studyPoller.stop();
  globalThis.fetch = originalFetch;
});

const pushCalls = () => calls.filter((c) => c.url.includes("/panel/answer"));
const navigateCalls = () => calls.filter((c) => c.url.includes("/ingest") && (c.body as { navigate?: boolean })?.navigate === true);

describe("studyPoller", () => {
  it("pushes formatted text on the happy path (studyAnswersOn required)", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "flop" },
      navigation: {
        ok: true,
        response: {
          decision: { action: "Check", frequency: 76.2 },
          actions: [
            { action: "Check", frequency: 76.2 },
            { action: "Bet 1.8 (33%)", frequency: 7.3 },
          ],
        },
      },
    };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    const pushed = pushCalls();
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[pushed.length - 1]!.body).toEqual({ text: "FLOP — Check 76% · Bet 1.8 (33%) 7%" });
    expect(studyPoller.getStatus().lastAnswer).toBe("FLOP — Check 76% · Bet 1.8 (33%) 7%");
  });

  it("does not re-navigate GTO Wizard while the same decision is still pending", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true, cards: ["Kh", "Qs"] },
      hand: { street: "flop", board: ["9h", "5s", "2c"], node: { toCall: 0 }, actions: [1, 2, 3] },
      navigation: { ok: true, response: { decision: { action: "Check", frequency: 76 } } },
    };
    studyPoller.start({ intervalMs: 30 });
    await wait(20); // one tick — navigates and solves
    expect(navigateCalls().length).toBe(1);

    await wait(80); // several more ticks — same identical decision each time
    expect(navigateCalls().length).toBe(1); // still just the one — no repeat reload

    // a genuinely new decision (a new board) must trigger a fresh navigation
    ingestResponse = {
      ...(ingestResponse as object),
      hand: { street: "turn", board: ["9h", "5s", "2c", "Kd"], node: { toCall: 0 }, actions: [1, 2, 3, 4] },
    };
    await wait(80);
    expect(navigateCalls().length).toBe(2);
  });

  it("force-relaunches GTO Wizard after several DIFFERENT decisions fail in a row (wedge detection)", async () => {
    const board = (n: number) => ({
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "flop", board: [`board-${n}`], node: { toCall: 0 }, actions: [n] },
      navigation: { ok: false, error: "no solution for this spot" },
    });

    ingestResponse = board(1);
    studyPoller.start({ intervalMs: 30 });
    await wait(20);
    expect(studyPoller.getStatus().distinctFailureStreak).toBe(1);
    expect(launchAppCalls.length).toBe(0); // not wedged yet — just one failed spot

    ingestResponse = board(2);
    await wait(60);
    expect(studyPoller.getStatus().distinctFailureStreak).toBe(2);
    expect(launchAppCalls.length).toBe(0);

    ingestResponse = board(3);
    await wait(150);
    // three DIFFERENT decisions failed in a row → treated as wedged, not "unlucky"
    // — and the cooldown means it fires exactly once, not on every later tick.
    expect(launchAppCalls.length).toBe(1);
    expect(launchAppCalls[0]).toEqual({ force: true });
  });

  it("does not treat the SAME spot failing repeatedly as a wedge", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "flop", board: ["9h", "5s", "2c"], node: { toCall: 0 }, actions: [1] },
      navigation: { ok: false, error: "no solution for this spot" },
    };
    studyPoller.start({ intervalMs: 30 });
    await wait(150); // several ticks, identical failing spot every time

    expect(studyPoller.getStatus().distinctFailureStreak).toBe(1); // only counted once
    expect(launchAppCalls.length).toBe(0); // never treated as wedged
  });

  it("also answers a preflop decision — navigateViaUrl works identically for both streets", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "preflop" },
      navigation: { ok: true, response: { decision: { action: "Raise 2.5", frequency: 80 } } },
    };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    expect(studyPoller.getStatus().lastAnswer).toBe("PREFLOP — Raise 2.5 80%");
  });

  it("never navigates or pushes an answer while assistive-play's Study Answers toggle is off", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: false,
      hero: { toAct: true },
      hand: { street: "flop" },
      navigation: { ok: true, response: { decision: { action: "Check", frequency: 90 } } },
    };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    expect(studyPoller.getStatus().lastAnswer).toBeNull();
    // the cheap pre-check ran, but the real navigate:true call never fired —
    // the poller must stay idle (no GTO Wizard traffic) while the toggle is off
    expect(navigateCalls().length).toBe(0);
  });

  it("launches GTO Wizard when Study Answers is on but it isn't connected, and stays idle meanwhile", async () => {
    gtowConnected = false;
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "flop" },
      navigation: { ok: true, response: { decision: { action: "Check", frequency: 90 } } },
    };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    expect(launchAppCalls.length).toBe(1);
    expect(launchAppCalls[0]).toEqual({});
    expect(studyPoller.getStatus().gtoWizardConnected).toBe(false);
    expect(studyPoller.getStatus().lastAnswer).toBeNull();
    // never even attempted a real navigation while GTO Wizard is down
    expect(navigateCalls().length).toBe(0);
  });

  it("pushes null when hero isn't to act", async () => {
    ingestResponse = { ok: true, studyAnswersOn: true, hero: { toAct: false }, hand: { street: "flop" } };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    const pushed = pushCalls();
    expect(pushed[pushed.length - 1]!.body).toEqual({ text: null });
    expect(studyPoller.getStatus().lastAnswer).toBeNull();
  });

  it("stop() clears the interval and pushes a final null", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "river" },
      navigation: { ok: true, response: { decision: { action: "Bet 10", frequency: 100 } } },
    };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);
    expect(studyPoller.getStatus().lastAnswer).not.toBeNull();

    const status = await studyPoller.stop();
    expect(status.running).toBe(false);
    expect(status.lastAnswer).toBeNull();
    expect(pushCalls()[pushCalls().length - 1]!.body).toEqual({ text: null });
  });

  it("surfaces a fetch failure in lastError and clears the answer", async () => {
    ingestResponse = "REJECT";
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    const status = studyPoller.getStatus();
    expect(status.lastError).toBe("network down");
    expect(status.lastAnswer).toBeNull();
  });
});
