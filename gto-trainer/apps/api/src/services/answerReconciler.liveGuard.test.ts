import { afterAll, describe, expect, it } from "bun:test";
import { answerReconciler, RECONCILE_MIN_GAP_MS } from "./answerReconciler";
import { __setSessionLiveReader, sessionLive } from "./sessionLive";
import { __resetLivePriority, liveBegin, liveEnd } from "./livePriority";

/**
 * The reconciler is post-hand bookkeeping (2026-10-07): it never runs while a poker session is live, and at most once
 * per 10 min when idle. The latency audit pinned 14-93 s event-loop freezes on its 2-minute tick.
 */
describe("answerReconciler waits for a quiet table", () => {
  afterAll(() => { answerReconciler.configure({ live: () => sessionLive(), now: Date.now }); __setSessionLiveReader(() => null); __resetLivePriority(); });

  it("skips every tick while a session is live, runs on the first idle one, then at most once per gap", () => {
    let now = 1_000_000_000_000;
    let live = true;
    const runs: number[] = [];
    answerReconciler.configure({ live: () => live, now: () => now, run: (since) => { runs.push(since); } });
    expect(answerReconciler.tick()).toBe("live");
    now += 120_000;
    expect(answerReconciler.tick()).toBe("live");
    expect(runs).toEqual([]);
    live = false;
    now += 120_000;
    expect(answerReconciler.tick()).toBe("ran");
    expect(runs).toEqual([now - 86_400_000]);
    now += 120_000;
    expect(answerReconciler.tick()).toBe("recent");
    now += RECONCILE_MIN_GAP_MS;
    expect(answerReconciler.tick()).toBe("ran");
    expect(runs.length).toBe(2);
  });

  it("the default 'live' is the sessions table (cached a minute) or a live answer in the last minute", () => {
    let now = 5_000_000;
    let reads = 0;
    let id: string | null = "session_20261007_120000";
    __setSessionLiveReader(() => { reads++; return id; }, () => now);
    __resetLivePriority(() => now);
    expect(sessionLive()).toBe(true);
    id = null;
    now += 30_000;
    expect(sessionLive()).toBe(true);    // remembered: no second read inside a minute
    expect(reads).toBe(1);
    now += 31_000;
    expect(sessionLive()).toBe(false);   // re-read
    expect(reads).toBe(2);
    liveBegin(); liveEnd();              // an answer was just computed: the table is live whatever the table says
    expect(sessionLive()).toBe(true);
    now += 61_000;
    expect(sessionLive()).toBe(false);
  });

  it("a store that cannot be read keeps the last answer", () => {
    let now = 9_000_000;
    let r: string | null | undefined = "s1";
    __setSessionLiveReader(() => r, () => now);
    __resetLivePriority(() => now);
    expect(sessionLive()).toBe(true);
    r = undefined;
    now += 61_000;
    expect(sessionLive()).toBe(true);
  });
});
