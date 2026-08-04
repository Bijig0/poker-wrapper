import { describe, it, expect } from "bun:test";
import { pollDelayMs } from "./gtowApi";

/**
 * The poll schedule is what turns "the cloud solved it at 1.6s" into "we saw it
 * at 1.6s" rather than 3.0s. These lock in its shape: sit out the dead period
 * once, poll tightly through the window solves land in, back off after.
 */
describe("pollDelayMs", () => {
  it("waits out the dead period in one hop rather than polling into it", () => {
    // Nothing lands before ~0.7s, so the first re-poll should be scheduled
    // exactly at the edge of that window regardless of when we ask.
    expect(pollDelayMs(0)).toBe(700);
    expect(pollDelayMs(300)).toBe(400);
    expect(pollDelayMs(699)).toBe(1);
  });

  it("polls tightly through the window where solves actually land", () => {
    for (const t of [700, 1_500, 2_500, 5_999]) expect(pollDelayMs(t)).toBe(300);
  });

  it("backs off once a solve is clearly queued behind others", () => {
    expect(pollDelayMs(6_000)).toBe(1_500);
    expect(pollDelayMs(20_000)).toBe(1_500);
  });

  it("never returns a non-positive delay (would spin the poll loop)", () => {
    for (let t = 0; t <= 30_000; t += 97) expect(pollDelayMs(t)).toBeGreaterThan(0);
  });

  it("beats the old flat interval to a typical 1.8s solve", () => {
    // Walk both schedules to the first poll at-or-after the solve landing.
    const firstPollAfter = (landMs: number, next: (t: number) => number) => {
      let t = 0;
      while (t < landMs) t += next(t);
      return t;
    };
    const adaptive = firstPollAfter(1_800, pollDelayMs);
    const flat = firstPollAfter(1_800, () => 1_500);
    expect(flat).toBe(3_000);
    expect(adaptive).toBeLessThanOrEqual(1_900);
    expect(adaptive).toBeLessThan(flat);
  });
});
