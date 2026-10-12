// SHARED WITH THE CHART FACTORY (setup/shared-with-factory.json): edit it in poker-wrapper only — the factory takes it with `bun scripts/sync_from_wrapper.ts`.
import { describe, expect, it } from "bun:test";
import { _recordStall, processWindow, runTraced, StallSummary, timed, tmark, tspan } from "./answerTrace";

/**
 * The answer timeline and the event-loop stall monitor (2026-09-24). The monitor exists because a river answer
 * showed 2.4 s between two GTO Wizard polls with no request in it — a hole. A stall recorded while a request is
 * open must appear in that request's timeline; one from before it must not.
 */
describe("answerTrace", () => {
  it("a stall that overlaps the request lands in its timeline; one before it does not", async () => {
    const r = await runTraced(async () => {
      const now = Date.now();
      _recordStall(now, 250);            // during this request
      _recordStall(now - 10_000, 900);   // long over before it started
      tmark("a mark");
      await new Promise((res) => setTimeout(res, 20));
      return 1;
    });
    expect(r.value).toBe(1);
    const stalls = r.trace.filter((e) => e.ev === "event loop stalled");
    expect(stalls.map((s) => s.ms)).toEqual([250]);
    expect(stalls[0]!.at).toBeGreaterThanOrEqual(0);
  });

  it("tspan records a caller-timed step, timed an awaited one, and a summary keeps its length when asked", async () => {
    const r = await runTraced(async () => {
      const t0 = Date.now();
      await new Promise((res) => setTimeout(res, 15));
      tspan("gzip", t0, "40 KB");
      await timed("poll", async () => "HTTP 200", (x) => x);
      tmark("chain summary", "x".repeat(500), 1200);
      tmark("short", "y".repeat(500));
      return null;
    });
    const gzip = r.trace.find((e) => e.ev === "gzip")!;
    expect(gzip.ms).toBeGreaterThanOrEqual(10);
    expect(gzip.info).toBe("40 KB");
    expect(r.trace.find((e) => e.ev === "poll")!.info).toBe("HTTP 200");
    expect(r.trace.find((e) => e.ev === "chain summary")!.info!.length).toBe(500);
    expect(r.trace.find((e) => e.ev === "short")!.info!.length).toBe(160);
  });

  it("is a no-op outside a traced request", () => {
    expect(() => { tmark("x"); tspan("y", Date.now()); }).not.toThrow();
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
