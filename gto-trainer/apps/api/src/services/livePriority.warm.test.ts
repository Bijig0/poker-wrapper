import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  __resetLivePriority, cachedBehindLive, coldBuilding, keepWarm, liveBegin, liveEnd, peekCached, setCached, warmBehindLive,
} from "./livePriority";
import { processWindow, StallSummary } from "./answerTrace";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("warm / keep-warm / peek / set (2026-10-09: nothing heavy is built on a caller's time)", () => {
  let now = 0;
  beforeEach(() => { now = 1_000_000; __resetLivePriority(() => now); });
  afterEach(() => __resetLivePriority());

  it("warmBehindLive builds a cold key in the background, behind a live answer; a caller then finds it warm", async () => {
    let n = 0;
    liveBegin();
    const w = warmBehindLive("k", () => ++n);
    await sleep(30);
    expect(n).toBe(0);                       // held behind the live answer
    expect(coldBuilding("k")).toBe(true);
    expect(peekCached("k")).toBeNull();
    liveEnd(); now += 2_000;
    expect(await w).toBe(1);
    expect(peekCached<number>("k")).toEqual({ value: 1, ageMs: 0 });
    expect(await cachedBehindLive("k", 10_000, () => ++n)).toBe(1);
    expect(n).toBe(1);
  });

  it("a caller arriving during the warm build shares it (one build)", async () => {
    let n = 0;
    const slow = async () => { n++; await sleep(20); return n; };
    const w = warmBehindLive("k", slow);
    await sleep(1);
    const [a, b] = await Promise.all([w, cachedBehindLive("k", 10_000, slow)]);
    expect(a).toBe(1); expect(b).toBe(1); expect(n).toBe(1);
  });

  it("setCached replaces the value a poll gets (a write route's fresh payload)", async () => {
    let n = 0;
    expect(await cachedBehindLive("acc", 5_000, () => ({ v: ++n }))).toEqual({ v: 1 });
    setCached("acc", { v: 99 });
    expect(await cachedBehindLive("acc", 5_000, () => ({ v: ++n }))).toEqual({ v: 99 });
    expect(n).toBe(1);
  });

  it("many pollers of a 5 s key: served from memory, ONE rebuild per stale period, never on the poller's time", async () => {
    let n = 0;
    const build = () => ({ n: ++n });
    await cachedBehindLive("acc", 5_000, build);
    for (let i = 0; i < 6; i++) expect((await cachedBehindLive("acc", 5_000, build)).n).toBe(1);
    now += 6_000;
    const served = await Promise.all([1, 2, 3].map(() => cachedBehindLive("acc", 5_000, build)));
    expect(served.map((x) => x.n)).toEqual([1, 1, 1]);   // stale copy at once
    await sleep(10);
    expect(n).toBe(2);                                     // one background rebuild for all three
    expect((await cachedBehindLive("acc", 5_000, build)).n).toBe(2);
  });

  it("keepWarm rebuilds a key ahead of its TTL while someone reads it, and stops when nobody does", async () => {
    let n = 0;
    await cachedBehindLive("cat", 1_000, () => ++n);
    const stop = keepWarm("cat", 1_000, () => ++n, { leadMs: 500, demandMs: 2_000, everyMs: 5 });
    now += 600;                                            // inside the lead: refreshed before anyone finds it stale
    await sleep(40);
    expect(n).toBe(2);
    now += 5_000;                                          // nobody asked for 5 s: no more rebuilds
    await sleep(40);
    expect(n).toBe(2);
    stop();
  });
});

describe("StallSummary (the 5-min [stall-summary] line)", () => {
  it("sums one window, charges each logged stall to its longest open activity, and prints once per window", () => {
    let t = Date.UTC(2026, 9, 9, 0, 0, 10);
    const s = new StallSummary(300_000, () => t);
    s.add(200, null);
    s.add(27_000, { at: t, ms: 27_000, cpuMs: 1_000, open: ["GET /api/gtow/accounts (27.0 s)", "timer hhCheck (1.0 s)"] });
    s.add(6_000, { at: t, ms: 6_000, cpuMs: 300, open: ["timer hhCheck (6.4 s, still open: check rows ×3844 5.2 s)"] });
    s.add(1_800, { at: t, ms: 1_800, cpuMs: 300, open: [] });
    expect(s.flush(t)).toBeNull();                         // window still open
    t = Date.UTC(2026, 9, 9, 0, 5, 1);
    const line = s.flush(t)!;
    expect(line).toBe("[stall-summary] 00:00–00:05Z: 4 stalls ≥100 ms (3 ≥1 s), blocked 35.0 s of 300.0 s (12%), max 27.0 s, " +
      "cpu 5% of the logged blocked time · by longest open: GET /api/gtow/accounts 27.0 s ×1, timer hhCheck 6.0 s ×1, " +
      "no request open (a timer or background job) 1.8 s ×1, short (<300 ms) 0.2 s ×1");
    expect(s.flush(t)).toBeNull();
    t = Date.UTC(2026, 9, 9, 0, 10, 0);
    expect(s.flush(t, "machine cpu 64% (last samples) · session live")).toBe("[stall-summary] 00:05–00:10Z: 0 stalls ≥100 ms (0 ≥1 s), " +
      "blocked 0.0 s of 300.0 s (0%), max 0.0 s · machine cpu 64% (last samples) · session live");
  });

  it("carries this process's CPU and memory over the window, says when a line is due, and keeps the window", () => {
    let t = Date.UTC(2026, 9, 12, 14, 20, 0);
    const s = new StallSummary(300_000, () => t);
    expect(s.due(t)).toBe(true);                // the first call opens the window
    expect(s.flush(t)).toBeNull();
    expect(s.due(t + 60_000)).toBe(false);
    expect(s.lastWindow()).toBeNull();
    s.add(231_000, { at: t, ms: 231_000, cpuMs: 630_000, open: [] });
    t = Date.UTC(2026, 9, 12, 14, 25, 4);
    expect(s.due(t)).toBe(true);
    const line = s.flush(t, "session live", { cpuPct: 249, rssMb: 1752, heapMb: 931 })!;
    expect(line).toBe("[stall-summary] 14:20–14:25Z: 1 stalls ≥100 ms (1 ≥1 s), blocked 231.0 s of 300.0 s (77%), max 231.0 s, " +
      "cpu 273% of the logged blocked time, this process 249% cpu (rss 1.7 GB, js heap 0.9 GB) · " +
      "by longest open: no request open (a timer or background job) 231.0 s ×1 · session live");
    expect(s.lastWindow()).toEqual({ from: Date.UTC(2026, 9, 12, 14, 20), to: Date.UTC(2026, 9, 12, 14, 25), blockedPct: 77 });
    expect(s.due(t)).toBe(false);
  });
});

describe("processWindow", () => {
  it("is CPU over the wall as % of one core (every thread), with memory; null without both CPU readings", () => {
    const w = processWindow(0, 1_000_000, 10_000, 25_900_000)!;   // 24.9 s of CPU in 10 s
    expect(w.cpuPct).toBe(249);
    expect(w.rssMb).toBeGreaterThan(0);
    expect(processWindow(0, null, 10_000, 5)).toBeNull();
    expect(processWindow(10_000, 1, 10_000, 5)).toBeNull();
  });
});
