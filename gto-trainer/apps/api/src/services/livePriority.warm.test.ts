import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  __resetLivePriority, cachedBehindLive, coldBuilding, keepWarm, liveBegin, liveEnd, peekCached, setCached, warmBehindLive,
} from "./livePriority";

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
