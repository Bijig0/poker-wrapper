import { describe, expect, it } from "bun:test";
import { _recordStall, runTraced, timed, tmark, tspan } from "./answerTrace";

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
