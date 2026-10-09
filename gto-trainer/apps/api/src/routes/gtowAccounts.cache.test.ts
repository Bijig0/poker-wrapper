import { afterEach, describe, expect, it } from "bun:test";
import app, { ACCOUNTS_CACHE_KEY, ACCOUNTS_TTL_MS } from "./gtowAccounts";
import { __resetLivePriority, setCached } from "../services/livePriority";

// GET /api/gtow/accounts is MEMORY ONLY while its cache is fresh (2026-10-09): the setup page and the dashboard poll it
// every 5 s, and building the payload (ledger GROUP BYs, wall scans, CDP probes) on each poll held the live API's loop.
describe("GET /api/gtow/accounts — served from the shared cache", () => {
  afterEach(() => __resetLivePriority());

  it("a fresh cached payload is returned as is, without building one", async () => {
    let now = 5_000_000;
    __resetLivePriority(() => now);
    const payload = { ok: true, now: 1, marker: "cached", accounts: [] };
    setCached(ACCOUNTS_CACHE_KEY, payload);
    now += ACCOUNTS_TTL_MS - 1;
    const t0 = performance.now();
    const r = await app.request("/");
    expect(await r.json()).toEqual(payload);
    expect(performance.now() - t0).toBeLessThan(200);   // nothing probed, nothing queried
  });
  // (stale-while-revalidate itself is covered in services/livePriority.warm.test.ts: a stale route test here would start a
  //  REAL payload build in the background that leaks into the next test file's fake GTO Wizard)
});
