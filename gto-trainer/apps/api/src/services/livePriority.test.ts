import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  LIVE_GRACE_MS, __resetLivePriority, asLive, cachedBehindLive, liveBegin, liveBusy, liveEnd, yieldFirst, yieldToLive,
} from "./livePriority";

let now = 0;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("livePriority — live answers go first (2026-09-26)", () => {
  beforeEach(() => { now = 1_000_000; __resetLivePriority(() => now); });

  it("busy while a live answer runs, and for the grace after it", () => {
    expect(liveBusy()).toBe(false);
    liveBegin();
    expect(liveBusy()).toBe(true);
    liveEnd();
    expect(liveBusy()).toBe(true);
    now += LIVE_GRACE_MS;
    expect(liveBusy()).toBe(false);
  });

  it("a live answer that throws still ends its mark", async () => {
    await expect(asLive(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    now += LIVE_GRACE_MS;
    expect(liveBusy()).toBe(false);
  });

  it("a GET behind yieldFirst waits for the live answer; a write never waits", async () => {
    const app = new Hono();
    const ran: string[] = [];
    app.use("/heavy", yieldFirst);
    app.get("/heavy", (c) => { ran.push("GET"); return c.text("ok"); });
    app.post("/heavy", (c) => { ran.push("POST"); return c.text("ok"); });
    liveBegin();
    const get = app.request("/heavy");
    await app.request("/heavy", { method: "POST" });
    await tick(150);
    expect(ran).toEqual(["POST"]);        // the GET is held
    liveEnd();
    now += LIVE_GRACE_MS;
    await get;
    expect(ran).toEqual(["POST", "GET"]);
  });

  it("yieldToLive returns at once when idle and never waits past its limit", async () => {
    __resetLivePriority();                // real clock
    expect(await yieldToLive(1_000, 10)).toBeLessThan(50);
    liveBegin();                          // a stuck answer
    const waited = await yieldToLive(200, 10);
    expect(waited).toBeGreaterThanOrEqual(190);
    expect(waited).toBeLessThan(1_000);
  });
});

describe("cachedBehindLive — a heavy value served stale while it refreshes behind live answers", () => {
  beforeEach(() => { now = 1_000_000; __resetLivePriority(() => now); });

  it("concurrent cold callers share one computation; a fresh value is not recomputed", async () => {
    let n = 0;
    const compute = async () => { n++; await tick(20); return { v: n }; };
    const [a, b] = await Promise.all([cachedBehindLive("k", 30_000, compute), cachedBehindLive("k", 30_000, compute)]);
    expect(a).toEqual({ v: 1 });
    expect(b).toBe(a);
    now += 29_000;
    expect(await cachedBehindLive("k", 30_000, compute)).toBe(a);
    expect(n).toBe(1);
  });

  it("a stale value is served at once; ONE refresh runs, after the live answer", async () => {
    let n = 0;
    const compute = () => ++n;
    expect(await cachedBehindLive("k", 30_000, compute)).toBe(1);
    now += 31_000;
    liveBegin();
    expect(await cachedBehindLive("k", 30_000, compute)).toBe(1);   // stale, instantly
    expect(await cachedBehindLive("k", 30_000, compute)).toBe(1);   // no second refresh queued
    await tick(250);
    expect(n).toBe(1);                                             // still waiting for the live answer
    liveEnd();
    now += LIVE_GRACE_MS;
    await tick(250);
    expect(n).toBe(2);
    expect(await cachedBehindLive("k", 30_000, compute)).toBe(2);
  });

  it("a failed refresh keeps the old value and tries again next time", async () => {
    let fail = false, n = 0;
    const compute = () => { if (fail) throw new Error("down"); return ++n; };
    expect(await cachedBehindLive("k", 1_000, compute)).toBe(1);
    fail = true;
    now += 2_000;
    expect(await cachedBehindLive("k", 1_000, compute)).toBe(1);
    await tick(20);
    fail = false;
    expect(await cachedBehindLive("k", 1_000, compute)).toBe(1);   // stale again: a new refresh starts
    await tick(20);
    expect(await cachedBehindLive("k", 1_000, compute)).toBe(2);
  });
});
