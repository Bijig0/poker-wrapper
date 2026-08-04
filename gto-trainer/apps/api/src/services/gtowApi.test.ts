import { describe, it, expect, afterEach } from "bun:test";
import { GtowApi } from "./gtowApi";

/**
 * The token keeper's guard rails. `primeToken` is called from studyPoller's 1s
 * tick, so the thing that matters is that it stays cheap and can't turn into a
 * sniff storm against a client that's reachable but has no token to give.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Count CDP target-list hits — the first thing sniffToken does. */
function countingCdp(): () => number {
  let n = 0;
  globalThis.fetch = (async (input: any) => {
    if (String(input).includes("/json/list")) n++;
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => n;
}

describe("primeToken", () => {
  it("collapses a burst of calls into a single sniff attempt", async () => {
    const sniffs = countingCdp();
    const api = new GtowApi();

    for (let i = 0; i < 25; i++) api.primeToken();
    await Bun.sleep(20);

    // No token exists, so every call WANTS to sniff; the attempt rate limit is
    // what keeps the 1s poll loop from re-navigating the client forever.
    expect(sniffs()).toBe(1);
  });

  it("is a no-op while a healthy token is in hand", async () => {
    const sniffs = countingCdp();
    const api = new GtowApi();
    const g = api as unknown as { token: string; tokenExpMs: number };
    g.token = "live";
    g.tokenExpMs = Date.now() + 3_600_000;

    api.primeToken();
    await Bun.sleep(20);

    expect(sniffs()).toBe(0);
    expect(api.hasLiveToken()).toBe(true);
  });

  it("reports a token near expiry as not ready", () => {
    const api = new GtowApi();
    const g = api as unknown as { token: string; tokenExpMs: number };
    g.token = "stale";
    g.tokenExpMs = Date.now() + 5_000; // inside the 60s skew
    expect(api.hasLiveToken()).toBe(false);
  });
});
