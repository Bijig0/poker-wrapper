import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NEVER THE LIVE ANSWER LOG (EIP-07 / PF-11, 2026-09-23). The poller under test drives the real answerLog
// singleton, which is created at import from ANSWERS_DB_PATH or data/answers.sqlite — every earlier run of this
// file appended its fixtures ("PREFLOP — Raise 2.5 80%", the NODE_DOES_NOT_EXIST line, the AcQc "Unable to
// connect" rows) to the production database: ~1,600 rows by 2026-09-23, most of the recorded solver-unreachable
// and gtow-down failures. The env is set here, before the dynamic import below instantiates the log.
process.env.ANSWERS_DB_PATH = join(mkdtempSync(join(tmpdir(), "answers-test-")), "answers.sqlite");

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

const { studyPoller, studyPollers } = await import("./studyPoller");

let originalFetch: typeof fetch;
let calls: { url: string; body: unknown }[] = [];
/** Set per-test to control the mocked ingest (probe) response body. */
let ingestResponse: unknown = { ok: false };
/** Set per-test to control the mocked /fast-solver (solve) response body. */
let fastSolveResponse: unknown = { ok: false };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  gtowConnected = true;
  launchAppCalls = [];
  fastSolveResponse = { ok: false };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("/panel/answer")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/fast-solver")) {
      // "REJECT" = the request itself fails, the way a wedged client does:
      // this is the real message Bun's fetch throws on a refused connection.
      if (fastSolveResponse === "REJECT") throw new Error("Unable to connect. Is the computer able to access the url?");
      return new Response(JSON.stringify(fastSolveResponse), { status: 200 });
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
const solveCalls = () => calls.filter((c) => c.url.includes("/fast-solver"));

describe("studyPoller", () => {
  it("pushes formatted text on the happy path (studyAnswersOn required)", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "flop" },
    };
    fastSolveResponse = {
      ok: true,
      hero: { toAct: true },
      hand: { street: "flop" },
      solution: {
        ok: true,
        decision: { action: "Check", frequency: 76.2 },
        actions: [
          { action: "Check", frequency: 76.2 },
          { action: "Bet 1.8 (33%)", frequency: 7.3 },
        ],
      },
    };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    const pushed = pushCalls();
    expect(pushed.length).toBeGreaterThan(0);
    // Mixed strategy ⇒ the push carries an RNG-rolled pick (CONTRACT.md §2).
    const body = pushed[pushed.length - 1]!.body as { text: string; pick: string; roll: number };
    expect(body.text).toMatch(
      /^FLOP — Check 76% · Bet 1\.8 \(33%\) 7% · roll \d+ → (CHECK|BET 1\.8 \(33%\))$/,
    );
    expect(["Check", "Bet 1.8 (33%)"]).toContain(body.pick);
    expect(body.roll).toBeGreaterThanOrEqual(1);
    expect(body.roll).toBeLessThanOrEqual(100);
    expect(studyPoller.getStatus().lastAnswer).toBe(body.text);
  });

  // Hand 4919236052 asked the same unanswerable question 13 times, ~1 s apart, and got the
  // same sentence back every time — clock and solve budget spent on a question whose
  // answer could not change, behind a blank panel. Re-asking is only worth something when
  // something has changed.
  it("rests a decision that keeps failing the same way, and says why", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true, cards: ["Ac", "Qc"] },
      hand: { street: "preflop", board: [], node: { toCall: 5.2 }, actions: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    };
    const reason = "GTO Wizard AI preflop: node 'R2.5-F-C-R4-R9.2-F-R14.4' — NODE_DOES_NOT_EXIST";
    fastSolveResponse = { ok: true, hand: { street: "preflop" }, solution: { ok: false, reason } };
    studyPoller.start({ intervalMs: 20 });
    await wait(300);                       // many ticks, all identical
    const tries = solveCalls().length;
    expect(tries).toBeGreaterThan(0);
    expect(tries).toBeLessThanOrEqual(3);  // rested, not asked once per tick

    // and the panel is TOLD, rather than left blank behind an invisible retry loop
    const said = calls.filter((c) => c.url.includes("/panel/answer")).map((c) => (c.body as any)?.note).filter(Boolean);
    expect(said.some((n: string) => n.includes("no answer for this spot after"))).toBe(true);

    // ANY change re-arms it at once — that is the whole point of resting rather than giving up
    ingestResponse = {
      ...(ingestResponse as object),
      hand: { street: "flop", board: ["2d", "9h", "5s"], node: { toCall: 0 }, actions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    };
    fastSolveResponse = {
      ok: true, hand: { street: "flop" },
      solution: { ok: true, decision: { action: "Check", frequency: 88 }, actions: [] },
    };
    await wait(120);
    expect(solveCalls().length).toBeGreaterThan(tries);
    expect(studyPoller.getStatus().lastAnswer).toContain("Check");
  });

  it("does not re-solve while the same decision is still pending", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true, cards: ["Kh", "Qs"] },
      hand: { street: "flop", board: ["9h", "5s", "2c"], node: { toCall: 0 }, actions: [1, 2, 3] },
    };
    fastSolveResponse = {
      ok: true,
      hand: { street: "flop" },
      solution: { ok: true, decision: { action: "Check", frequency: 76 }, actions: [] },
    };
    studyPoller.start({ intervalMs: 30 });
    await wait(20); // one tick — solves
    expect(solveCalls().length).toBe(1);

    await wait(80); // several more ticks — same identical decision each time
    expect(solveCalls().length).toBe(1); // still just the one — no repeat solve

    // a genuinely new decision (a new board) must trigger a fresh solve
    ingestResponse = {
      ...(ingestResponse as object),
      hand: { street: "turn", board: ["9h", "5s", "2c", "Kd"], node: { toCall: 0 }, actions: [1, 2, 3, 4] },
    };
    fastSolveResponse = {
      ok: true,
      hand: { street: "turn" },
      solution: { ok: true, decision: { action: "Check", frequency: 60 }, actions: [] },
    };
    await wait(80);
    expect(solveCalls().length).toBe(2);
  });

  it("records a breadcrumb on solve failure and never relaunches GTO Wizard for it", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "flop", board: ["9h", "5s", "2c"], node: { toCall: 0 }, actions: [1] },
    };
    fastSolveResponse = {
      ok: true,
      hand: { street: "flop" },
      solution: { ok: false, reason: "no solution for this spot" },
    };
    studyPoller.start({ intervalMs: 30 });
    await wait(150); // several ticks, identical failing spot every time

    const status = studyPoller.getStatus();
    expect(status.lastNavFailure?.reason).toBe("no solution for this spot");
    expect(status.lastNavFailure?.street).toBe("flop");
    // fast-solve failures are facts about the hand/charts, not GTO Wizard
    // health — the DOM-era wedge relauncher must stay quiet
    expect(status.distinctFailureStreak).toBe(0);
    expect(launchAppCalls.length).toBe(0);
    const pushed = pushCalls();
    // A failure clears the answer. The FIRST ones say nothing more than that; once the
    // same spot has failed the same way its limit of times the poller rests it and the
    // note says so, rather than leaving a blank card behind an invisible retry loop.
    expect(pushed[0]!.body).toMatchObject({ text: null, pick: null, roll: null, note: null });
    expect(pushed[pushed.length - 1]!.body).toMatchObject({ text: null, pick: null, roll: null });
    expect((pushed[pushed.length - 1]!.body as any).note).toContain("no answer for this spot after");
  });

  it("also answers a preflop decision through the fast path", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "preflop" },
    };
    fastSolveResponse = {
      ok: true,
      hand: { street: "preflop" },
      solution: {
        ok: true,
        decision: { action: "Raise 2.5", frequency: 80 },
        actions: [{ action: "Raise 2.5", frequency: 80 }],
      },
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
    };
    fastSolveResponse = {
      ok: true,
      hand: { street: "flop" },
      solution: { ok: true, decision: { action: "Check", frequency: 90 }, actions: [] },
    };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    expect(studyPoller.getStatus().lastAnswer).toBeNull();
    // the cheap pre-check ran, but no solve ever fired — the poller must
    // stay idle while the toggle is off
    expect(navigateCalls().length).toBe(0);
    expect(solveCalls().length).toBe(0);
  });

  it("launches GTO Wizard when Study Answers is on but it isn't connected, and stays idle meanwhile", async () => {
    gtowConnected = false;
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "flop" },
    };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    expect(launchAppCalls.length).toBe(1);
    expect(launchAppCalls[0]).toEqual({});
    expect(studyPoller.getStatus().gtoWizardConnected).toBe(false);
    expect(studyPoller.getStatus().lastAnswer).toBeNull();
    // never even attempted a solve while GTO Wizard is down
    expect(navigateCalls().length).toBe(0);
    expect(solveCalls().length).toBe(0);
  });

  it("pushes null when hero isn't to act", async () => {
    ingestResponse = { ok: true, studyAnswersOn: true, hero: { toAct: false }, hand: { street: "flop" } };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);

    const pushed = pushCalls();
    expect(pushed[pushed.length - 1]!.body).toMatchObject({ text: null, pick: null, roll: null, note: null });
    expect(studyPoller.getStatus().lastAnswer).toBeNull();
  });

  it("stop() clears the interval and pushes a final null", async () => {
    ingestResponse = {
      ok: true,
      studyAnswersOn: true,
      hero: { toAct: true },
      hand: { street: "river" },
    };
    fastSolveResponse = {
      ok: true,
      hand: { street: "river" },
      solution: {
        ok: true,
        decision: { action: "Bet 10", frequency: 100 },
        actions: [{ action: "Bet 10", frequency: 100 }],
      },
    };
    studyPoller.start({ intervalMs: 100_000 });
    await wait(20);
    expect(studyPoller.getStatus().lastAnswer).not.toBeNull();

    const status = await studyPoller.stop();
    expect(status.running).toBe(false);
    expect(status.lastAnswer).toBeNull();
    expect(pushCalls()[pushCalls().length - 1]!.body).toMatchObject({ text: null, pick: null, roll: null, note: null });
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

// MULTI-TABLE: one poller per wrapper. The hazard being designed against is two pollers
// on the SAME wrapper — they double-answer a decision and, because rollAction samples
// the mix, can roll two different actions for one spot. A map keyed by assistiveUrl
// cannot express that; four different wrappers are four different tables.
describe("one poller per table", () => {
  afterEach(async () => { await studyPollers.stop(); });

  it("starting the same wrapper twice is one poller, not two", () => {
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 });
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 });
    expect(studyPollers.list().map((p) => p.assistiveUrl)).toEqual(["http://127.0.0.1:7700"]);
  });

  it("four wrappers get four pollers", () => {
    for (const port of [7700, 7710, 7720, 7730]) {
      studyPollers.start({ assistiveUrl: `http://127.0.0.1:${port}`, intervalMs: 100_000 });
    }
    const urls = studyPollers.list().map((p) => p.assistiveUrl);
    expect(urls).toHaveLength(4);
    expect(new Set(urls).size).toBe(4);
    expect(studyPollers.list().every((p) => p.status.running)).toBe(true);
  });

  it("stopping one table leaves the others answering, and drops it from the set", async () => {
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 });
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7710", intervalMs: 100_000 });
    await studyPollers.stop("http://127.0.0.1:7700");
    const byUrl = Object.fromEntries(studyPollers.list().map((p) => [p.assistiveUrl, p.status.running]));
    expect(byUrl["http://127.0.0.1:7700"]).toBeUndefined();   // gone, not lingering as stopped
    expect(byUrl["http://127.0.0.1:7710"]).toBe(true);
  });

  it("stopping with no url stops every table", async () => {
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 });
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7710", intervalMs: 100_000 });
    await studyPollers.stop();
    expect(studyPollers.list().some((p) => p.status.running)).toBe(false);
  });

  it("the flat status still answers 'is the chain live', across tables", async () => {
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 });
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7710", intervalMs: 100_000 });
    await studyPollers.stop("http://127.0.0.1:7700");          // table 1 off, table 2 still on
    const st = studyPoller.getStatus() as ReturnType<typeof studyPollers.status>;
    expect(st.running).toBe(true);
    expect(st.pollers.map((p) => p.assistiveUrl)).toEqual(["http://127.0.0.1:7710"]);
  });

  // THE WEDGED-BUT-CONNECTED CLIENT (2026-09-19). GTO Wizard's debug port kept
  // answering isConnected() while every solve through it failed, so the tick
  // loop's "is it up?" check saw a healthy client and never relaunched. The
  // recovery for exactly this was written — distinctFailureStreak, lastFailedKey
  // and launchApp({force}) — but nothing ever incremented the counter or passed
  // force, so it was unreachable code that READ as a working safety net. It cost
  // the answers tier 14 of 15 fixtures, each blaming the cloud, and recovered
  // only when the port happened to drop and the ordinary relaunch fired.
});

describe("wedged-but-connected recovery", () => {
  const spot = (n: number) => ({
    ok: true,
    studyAnswersOn: true,
    hero: { toAct: true, cards: ["Ac", "Qc"] },
    hand: { street: "flop", board: ["2c", "7d", "9s"], actions: Array.from({ length: n }, (_, i) => i) },
  });
  const forced = () => launchAppCalls.filter((c) => c.force === true).length;

  it("forces a relaunch once DISTINCT decisions keep failing in the solve chain", async () => {
    gtowConnected = true;             // the port answers — nothing else can catch this
    fastSolveResponse = "REJECT";

    ingestResponse = spot(1);
    studyPoller.start({ intervalMs: 20 });
    await wait(120);
    expect(forced()).toBe(0);         // one dead spot is not a wedge

    ingestResponse = spot(2);
    await wait(120);
    expect(forced()).toBe(0);         // nor two

    ingestResponse = spot(3);
    await wait(150);
    expect(forced()).toBe(1);         // three distinct failures: stop believing it
    expect(studyPoller.getStatus().distinctFailureStreak).toBe(0);
  });

  it("does not count ONE spot re-asked, however long hero sits there", async () => {
    gtowConnected = true;
    fastSolveResponse = "REJECT";
    ingestResponse = spot(1);
    studyPoller.start({ intervalMs: 20 });
    await wait(400);                  // many ticks, one decision
    expect(forced()).toBe(0);
  });

  // A solver that ANSWERS "not in range" is working correctly. Counting a
  // poker refusal as a client fault would quit GTO Wizard mid-session for
  // three hands hero happened to be out of range with.
  it("does not count the solver's own poker refusals", async () => {
    gtowConnected = true;
    ingestResponse = spot(1);
    fastSolveResponse = { ok: true, hand: { street: "flop" }, solution: { ok: false, reason: "hand isn't in the chart range" } };
    studyPoller.start({ intervalMs: 20 });
    await wait(120);
    ingestResponse = spot(2);
    await wait(120);
    ingestResponse = spot(3);
    await wait(150);
    expect(forced()).toBe(0);
  });
});

// TWO POLLERS ON ONE WRAPPER (2026-09-20). index.ts starts a poller at boot with no
// config — DEFAULT_LIVE_URL, i.e. "http://localhost:7700" — and the wrapper then
// registers itself as "http://127.0.0.1:7700". Keyed on the raw string those are two
// instances on one table, each with its own single-flight guard, each rolling the mix
// independently and POSTing to /panel/answer. The panel kept whichever landed last, so
// the displayed pick flickered and the relay executed a coin flip. Every hand of the
// 2026-09-19 20:47-21:12 session doubled this way.
describe("one poller per wrapper, however its URL is spelled", () => {
  afterEach(async () => { await studyPollers.stop(); });

  it("folds localhost and 127.0.0.1 onto a single poller", () => {
    studyPollers.start({ assistiveUrl: "http://localhost:7700", intervalMs: 100_000 });
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 });
    expect(studyPollers.list().map((p) => p.assistiveUrl)).toEqual(["http://127.0.0.1:7700"]);
  });

  it("folds a trailing slash and upper case too", () => {
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 });
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700/", intervalMs: 100_000 });
    studyPollers.start({ assistiveUrl: "HTTP://LocalHost:7700", intervalMs: 100_000 });
    expect(studyPollers.list()).toHaveLength(1);
  });

  it("the boot default and the wrapper's own registration are the same table", () => {
    studyPollers.start({ intervalMs: 100_000 });                       // index.ts at boot
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 }); // launch.py
    expect(studyPollers.list()).toHaveLength(1);
  });

  it("still keeps genuinely different tables apart", () => {
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 });
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7710", intervalMs: 100_000 });
    expect(studyPollers.list()).toHaveLength(2);
  });

  it("stops by any spelling of the URL", async () => {
    studyPollers.start({ assistiveUrl: "http://127.0.0.1:7700", intervalMs: 100_000 });
    await studyPollers.stop("http://localhost:7700/");
    expect(studyPollers.list()).toHaveLength(0);
  });
});
