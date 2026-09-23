import { afterEach, describe, expect, it, mock } from "bun:test";

/**
 * The response ENVELOPES of POST /api/fast-solver and POST /api/ingest — the two
 * bodies the study poller reads and writes answers.sqlite from.
 *
 * Both routes rebuild `hand` by hand, and until 2026-09-23 that projection
 * dropped the wrapper's per-hand facts: tableSlot / bbCents / liveSeats (EIP-08,
 * PF-12 — table_slot, bb_cents, table_seats NULL in all 4,287 answers rows) and,
 * on /ingest, even handId / clientHandId (EIP-16 — every gtow-down and
 * not-to-act-live row unattributed). normalizeHand kept every one of them; the
 * loss was purely in these two object literals.
 *
 * The solver and GTO Wizard layers are mocked out: these tests are about the
 * envelope, and nothing here may reach the network (GTOW daily request cap) or
 * open a data/*.sqlite file.
 */

mock.module("../services/fastSolve", () => ({
  fastSolve: async () => ({ ok: false, reason: "mocked", gametype: null, depth: null, line: null }),
  warmPreflop6max: () => {},
  warmPostflop6max: () => {},
}));
mock.module("../services/gtowCdp", () => ({
  SOLUTION_SETS: [],
  gtowCdp: { isConnected: async () => false },
  isRecoverableBlocker: () => false,
}));
mock.module("../services/preflopDb", () => ({
  preflopDb: { available: () => false, answer: () => ({ ok: false }) },
}));
mock.module("../services/navLock", () => ({
  navLock: { run: async <T,>(fn: () => Promise<T>) => fn() },
}));

const { default: fastSolverApp } = await import("./fastSolver");
const { default: ingestApp } = await import("./ingest");
const { resolveHand } = await import("../feed/resolveHand/resolveHand");

/**
 * A live-shaped /hand export, as launch.py _hand_state() ships it on a
 * two-table NL200 session: slot 2, bbCents 200, six seats dealt, the site's
 * own clientHandId. Villain is on the clock so neither route reaches its
 * solver — the envelope is the whole subject.
 */
const LIVE_HAND = {
  handId: 41,
  clientHandId: "x",
  sessionId: "s",
  tableSlot: 2,
  bbCents: 200,
  heroSeatId: 3,
  heroCards: ["Ah", "Kd"],
  board: [],
  street: "preflop",
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 2, hero: false, type: "post-bb", amount: 1, street: "preflop" },
  ],
  liveSeats: [1, 2, 3, 4, 5, 6],
  committed: {},
  potByStreet: { preflop: 1.5 },
  positions: { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" },
  stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
  currentNode: {
    street: "preflop",
    toActSeatId: 3,
    toActIsHero: false,
    pot: 1.5,
    toCall: 1,
    legalActions: ["fold", "call", "raise"],
    complete: false,
  },
  ended: false,
};

const post = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, body: unknown) =>
  Promise.resolve(app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

const expectIds = (hand: Record<string, unknown>) => {
  expect(hand.handId).toBe(41);
  expect(hand.clientHandId).toBe("x");
  expect(hand.sessionId).toBe("s");
  expect(hand.tableSlot).toBe(2);
  expect(hand.bbCents).toBe(200);
  expect(hand.liveSeats).toEqual([1, 2, 3, 4, 5, 6]);
};

describe("POST /api/fast-solver envelope (EIP-08, PF-12)", () => {
  it("carries tableSlot, bbCents, liveSeats, clientHandId, handId and sessionId on hand", async () => {
    const res = await post(fastSolverApp, { hand: LIVE_HAND });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hand: Record<string, unknown>; sessionId: string | null };
    expect(body.ok).toBe(true);
    expectIds(body.hand);
    expect(body.sessionId).toBe("s");
  });

  it("nulls the optional facts a single-table hand has none of, rather than dropping the keys", async () => {
    const { tableSlot: _slot, bbCents: _bb, clientHandId: _cid, sessionId: _sid, ...single } = LIVE_HAND;
    const res = await post(fastSolverApp, { hand: single });
    const body = (await res.json()) as { hand: Record<string, unknown> };
    expect(body.hand).toHaveProperty("tableSlot", null);
    expect(body.hand).toHaveProperty("bbCents", null);
    expect(body.hand).toHaveProperty("clientHandId", null);
    expect(body.hand).toHaveProperty("sessionId", null);
    expect(body.hand.liveSeats).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("POST /api/ingest envelope (EIP-16)", () => {
  it("carries the same ids and table facts as /fast-solver, so probe-only answer rows can be attributed", async () => {
    const res = await post(ingestApp, { hand: LIVE_HAND });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hand: Record<string, unknown>; sessionId: string | null };
    expect(body.ok).toBe(true);
    expectIds(body.hand);
    expect(body.sessionId).toBe("s");
  });
});

describe("resolveHand live probe uses the wrapper's light path (EIP-14)", () => {
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; });

  /** Stub the wrapper: record the URL, answer a table-less-but-connected light payload. */
  const stubWrapper = (reply: Record<string, unknown> = { connected: true, hand: null, studyAnswers: true, sessionId: "s", session: { strategy: null } }) => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return urls;
  };

  it("fetches /state?light=1 from the default wrapper", async () => {
    const urls = stubWrapper();
    const r = await resolveHand({ live: true });
    expect(urls).toEqual(["http://localhost:7700/state?light=1"]);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.hand).toBeNull(); expect(r.sessionId).toBe("s"); expect(r.studyAnswersOn).toBe(true); }
  });

  it("fetches /state?light=1 from a caller-given url, trailing slash stripped", async () => {
    const urls = stubWrapper();
    await resolveHand({ live: { url: "http://localhost:7702/" } });
    expect(urls).toEqual(["http://localhost:7702/state?light=1"]);
  });

  it("still reads the live hand and its ids off the light payload", async () => {
    stubWrapper({ connected: true, hand: LIVE_HAND, studyAnswers: true, sessionId: "live-s", session: { strategy: "ign-ring-NL200-6" } });
    const r = await resolveHand({ live: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hand?.tableSlot).toBe(2);
    expect(r.hand?.bbCents).toBe(200);
    expect(r.hand?.clientHandId).toBe("x");
    // the live session id comes from state.sessionId, not the hand (launch.py stamps it on the archive only)
    expect(r.sessionId).toBe("live-s");
    expect(r.strategyId).toBe("ign-ring-NL200-6");
  });

  it("GET /api/ingest/live-status also takes the light path", async () => {
    const urls = stubWrapper({ connected: true, hand: null, snapshot: { status: "seated", seats: [{ hero: true, sittingOut: false }] } });
    const res = await ingestApp.request("/live-status?url=http://localhost:7703");
    const body = (await res.json()) as { reachable: boolean; connected: boolean; status: string | null };
    expect(urls).toEqual(["http://localhost:7703/state?light=1"]);
    expect(body).toMatchObject({ reachable: true, connected: true, status: "seated" });
  });
});
