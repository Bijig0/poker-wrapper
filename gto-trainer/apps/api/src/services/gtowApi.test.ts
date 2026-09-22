import { describe, it, expect, afterEach } from "bun:test";
import { GtowSessions } from "./gtowSessions";

/**
 * The token keeper's guard rails. `prime()` is called from studyPoller's 1s
 * tick (via gtowApi.primeToken), so the thing that matters is that it stays
 * cheap and can't turn into a sniff storm against a session that's reachable
 * but has no token to give.
 *
 * These moved off GtowApi when the single token became a POOL
 * (services/gtowSessions.ts): the keeper, the rate limit and the expiry skew
 * are all per-session now, so the rate limit has to hold per session rather
 * than across the pool — otherwise one unreachable account would starve the
 * other of refreshes.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Count CDP target-list hits — the first thing a sniff does. */
function countingCdp(): () => number {
  let n = 0;
  globalThis.fetch = (async (input: any) => {
    if (String(input).includes("/json/list")) n++;
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => n;
}

/** Hand a session a token without going through CDP. */
function giveToken(pool: GtowSessions, id: "primary" | "secondary", expMs: number): void {
  const s = (pool as unknown as { sessions: Map<string, { token: string | null; tokenExpMs: number }> }).sessions.get(id)!;
  s.token = "t";
  s.tokenExpMs = expMs;
}

describe("prime", () => {
  it("collapses a burst of calls into a single sniff attempt per session", async () => {
    const sniffs = countingCdp();
    const pool = new GtowSessions();

    for (let i = 0; i < 25; i++) pool.prime();
    await Bun.sleep(20);

    // No token exists, so every call WANTS to sniff; the attempt rate limit is
    // what keeps the 1s poll loop from re-navigating the clients forever. Two
    // sessions, so two attempts — the limit is per account, not pool-wide.
    expect(sniffs()).toBe(2);
  });

  it("is a no-op while healthy tokens are in hand", async () => {
    const sniffs = countingCdp();
    const pool = new GtowSessions();
    giveToken(pool, "primary", Date.now() + 3_600_000);
    giveToken(pool, "secondary", Date.now() + 3_600_000);

    pool.prime();
    await Bun.sleep(20);

    expect(sniffs()).toBe(0);
    expect(pool.hasLiveToken()).toBe(true);
  });

  it("still refreshes the OTHER session when one is healthy", async () => {
    const sniffs = countingCdp();
    const pool = new GtowSessions();
    giveToken(pool, "secondary", Date.now() + 3_600_000);

    pool.prime();
    await Bun.sleep(20);

    expect(sniffs()).toBe(1); // only the primary needed one
  });

  it("reports a token near expiry as not ready", () => {
    const pool = new GtowSessions();
    giveToken(pool, "secondary", Date.now() + 5_000); // inside the 60s skew
    expect(pool.hasLiveToken()).toBe(false);
  });

  it("reports a heads-up-only session as unable to answer multiway", () => {
    const pool = new GtowSessions();
    giveToken(pool, "secondary", Date.now() + 3_600_000);
    expect(pool.hasLiveToken({ multiway: false })).toBe(true);
    // the Elite account holds the only live token, and its AI is heads-up only
    expect(pool.hasLiveToken({ multiway: true })).toBe(false);
  });
});
