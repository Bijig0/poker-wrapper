import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { __resetSetupLive, isSetupRequest, noteIfSetup, setupOpen, SETUP_LIVE_MS } from "./setupLive";
import { __resetLivePriority, cachedBehindLive, keepWarm } from "./livePriority";
import { __setSessionLiveReader } from "./sessionLive";
import { liveForCaches } from "../routes/sources";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// THE SETUP PAGE COUNTS AS LIVE (2026-10-09, catalogue-incremental): its marked polls hold the catalogue's rebuilds exactly
// as a declared session does, and the hold clears two minutes after the last one.
describe("setup-live", () => {
  afterEach(() => { __resetSetupLive(); __resetLivePriority(); __setSessionLiveReader(() => null); });

  it("a request is the setup page's by the wrapper's header or ?from=setup, nothing else", async () => {
    const app = new Hono();
    app.get("/x", (c) => c.json({ setup: isSetupRequest(c) }));
    expect(await (await app.request("/x", { headers: { "X-Poker-Setup": "1" } })).json()).toEqual({ setup: true });
    expect(await (await app.request("/x?from=setup")).json()).toEqual({ setup: true });
    expect(await (await app.request("/x")).json()).toEqual({ setup: false });
    expect(await (await app.request("/x?from=panel", { headers: { "X-Poker-Setup": "0" } })).json()).toEqual({ setup: false });
  });

  it("open for two minutes after the last marked poll, then clear", async () => {
    let now = 10_000_000;
    __resetSetupLive(() => now);
    const app = new Hono();
    app.get("/x", (c) => c.json({ noted: noteIfSetup(c) }));
    expect(setupOpen()).toBe(false);
    await app.request("/x");
    expect(setupOpen()).toBe(false);                     // an unmarked poll (the panel, the dashboard) says nothing
    await app.request("/x?from=setup");
    expect(setupOpen()).toBe(true);
    now += SETUP_LIVE_MS - 1;
    expect(setupOpen()).toBe(true);
    now += 2;
    expect(setupOpen()).toBe(false);
  });

  it("liveForCaches: a declared session OR the setup page", async () => {
    let now = 20_000_000;
    __resetSetupLive(() => now);
    __setSessionLiveReader(() => null, () => now);
    expect(liveForCaches()).toBe(false);
    const app = new Hono();
    app.get("/x", (c) => c.json({ noted: noteIfSetup(c) }));
    await app.request("/x", { headers: { "x-poker-setup": "1" } });
    expect(liveForCaches()).toBe(true);
    now += SETUP_LIVE_MS + 1;
    expect(liveForCaches()).toBe(false);
    __setSessionLiveReader(() => "session_20261009_155740", () => now);
    expect(liveForCaches()).toBe(true);
  });

  it("while the setup page is open the catalogue's refresh-ahead is skipped and the stale copy served; it resumes after", async () => {
    let now = 30_000_000;
    __resetLivePriority(() => now);
    __resetSetupLive(() => now);
    __setSessionLiveReader(() => null, () => now);
    let builds = 0;
    const build = () => ++builds;
    await cachedBehindLive("cat", 1_000, build, { holdWhile: liveForCaches });          // the cold build still runs
    expect(builds).toBe(1);
    const stop = keepWarm("cat", 1_000, build, { leadMs: 500, demandMs: 60_000, everyMs: 5, skipWhile: liveForCaches });
    const app = new Hono();
    app.get("/x", (c) => c.json({ noted: noteIfSetup(c) }));
    await app.request("/x?from=setup");
    now += 2_000;                                                                        // stale
    await sleep(40);
    expect(builds).toBe(1);                                                              // no refresh-ahead
    expect(await cachedBehindLive("cat", 1_000, build, { holdWhile: liveForCaches })).toBe(1);   // stale served, not rebuilt
    await sleep(20);
    expect(builds).toBe(1);
    now += SETUP_LIVE_MS + 1;                                                            // the page went away
    await cachedBehindLive("cat", 1_000, build, { holdWhile: liveForCaches });          // (demand)
    await sleep(40);
    expect(builds).toBeGreaterThanOrEqual(2);
    stop();
  });
});
