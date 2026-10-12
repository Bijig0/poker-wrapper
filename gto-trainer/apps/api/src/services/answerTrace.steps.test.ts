// SHARED WITH THE CHART FACTORY (setup/shared-with-factory.json): edit it in poker-wrapper only — the factory takes it with `bun scripts/sync_from_wrapper.ts`.
import { describe, expect, it } from "bun:test";
import { asActivity, cpuVerdict, currentStepper, describeStall, step, STALL_STEPS_MS } from "./answerTrace";

/**
 * A [stall] line says what the loop was doing (2026-10-07): the CPU this process used across the blocked interval
 * (computing vs waiting) and, for a stall of a second or more, the per-step timings of the ticks open across it —
 * "timer answerReconciler (55.5 s: hands query 55.4 s)". The 14-93 s freezes of 10-06/07 named the reconciler's tick
 * but not what inside it held the loop.
 */
const spin = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { /* hold the loop */ } };

describe("stall lines carry cpu and steps", () => {
  it("a tick's synchronous steps are timed into its activity and printed on a stall of a second or more", () => {
    const from = Date.now();
    asActivity("timer testTick", () => {
      step("openDb", () => spin(5));
      step("hands query", () => spin(60));
      for (let i = 0; i < 3; i++) step("enrich", () => spin(2));
    });
    const to = Date.now();
    const long = describeStall(from, Math.max(STALL_STEPS_MS, to - from), 1_050);
    expect(long.line).toContain("cpu 1.1 s");
    expect(long.line).toContain("computing");
    const named = long.rec.open.find((o) => o.startsWith("timer testTick"))!;
    expect(named).toMatch(/^timer testTick \(\d+\.\d s: hands query \d+ ms, enrich ×3 \d+ ms, openDb \d+ ms\)$/);
    // the longest step first
    expect(named.indexOf("hands query")).toBeLessThan(named.indexOf("openDb"));

    // a short stall names the activity only
    const short = describeStall(from, 400, 5);
    expect(short.rec.open.find((o) => o.startsWith("timer testTick"))).toMatch(/^timer testTick \(\d+\.\d s\)$/);
    expect(short.line).toContain("waiting: disk, a lock, or the process not scheduled");
  });

  it("an async tick keeps its steps across awaits; a callback's stepper is bound to the tick that made it", async () => {
    const from = Date.now();
    let later: ReturnType<typeof currentStepper> | null = null;
    await asActivity("timer asyncTick", async () => {
      await new Promise((r) => setTimeout(r, 5));
      step("after await", () => spin(30));
      later = currentStepper();
    });
    later!("cdp frame parse", () => spin(20));   // a WebSocket callback after the tick's own code
    const rec = describeStall(from, Math.max(STALL_STEPS_MS, Date.now() - from), null).rec;
    const named = rec.open.find((o) => o.startsWith("timer asyncTick"))!;
    expect(named).toContain("after await");
    expect(named).toContain("cdp frame parse");
  });

  it("outside an activity step() and currentStepper() only run the function", () => {
    expect(step("x", () => 7)).toBe(7);
    expect(currentStepper()("y", () => "z")).toBe("z");
  });

  it("cpu verdicts", () => {
    expect(cpuVerdict(null, 1000)).toBe("cpu unknown");
    expect(cpuVerdict(55_200, 55_500)).toBe("cpu 55.2 s (99% of the wall: computing)");
    expect(cpuVerdict(100, 55_500)).toContain("waiting");
    expect(cpuVerdict(500, 1000)).toContain("part computing, part waiting");
  });
});
