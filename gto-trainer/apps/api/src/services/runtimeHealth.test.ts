// SHARED WITH THE CHART FACTORY (setup/shared-with-factory.json): edit it in poker-wrapper only — the factory takes it with `bun scripts/sync_from_wrapper.ts`.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testTempDir } from "../test/tempDir";
import {
  RECYCLE_AFTER_SUSPEND_MS, RuntimeHealth, SUSPEND_MIN_MS, SYMPTOM_GUARD_MS,
  degradedReason, describeSuspend, isSuspend,
} from "./runtimeHealth";

const T0 = Date.UTC(2026, 9, 12, 12, 34, 55);
const H = 3_600_000;
const bad = (end: number) => ({ end, procCpuPct: 249, blockedPct: 77 });

describe("isSuspend", () => {
  test("the lid closed 14 h: no CPU across the gap", () => {
    expect(isSuspend(50_943_500, 0)).toBe(true);
    expect(isSuspend(4_628_582, 0)).toBe(true);
  });
  test("a long freeze that computed, or a short one, is a stall", () => {
    expect(isSuspend(SUSPEND_MIN_MS, SUSPEND_MIN_MS)).toBe(false);   // the loop was busy the whole time
    expect(isSuspend(46_780, 7_400)).toBe(false);                    // 2026-10-12 22:32: a real 47 s freeze
    expect(isSuspend(SUSPEND_MIN_MS - 1, 0)).toBe(false);
  });
  test("unknown CPU: by its length only", () => {
    expect(isSuspend(SUSPEND_MIN_MS, null)).toBe(true);
    expect(isSuspend(60_000, null)).toBe(false);
  });
});

describe("describeSuspend", () => {
  test("says how long, and that a long one restarts the worker", () => {
    const line = describeSuspend(T0 - 50_943_500, 50_943_500, 0);
    expect(line).toStartWith("[suspend] the event loop was away 14.2 h (2026-10-11T22:25:51.500Z → 2026-10-12T12:34:55.000Z) with 0.0 s of CPU");
    expect(line).toContain("restarts itself when no session is live");
    expect(describeSuspend(T0, 10 * 60_000, 120)).not.toContain("restarts itself");
  });
});

describe("RuntimeHealth", () => {
  test("healthy: nothing to say", () => {
    const h = new RuntimeHealth({ now: () => T0 });
    h.noteWindow({ end: T0, procCpuPct: 16, blockedPct: 0 });
    h.noteWindow({ end: T0, procCpuPct: 60, blockedPct: 40 });      // a slow window that WAITED (disk, a lock)
    h.noteWindow({ end: T0, procCpuPct: 220, blockedPct: 5 });      // busy but the loop kept turning
    expect(h.degraded()).toBeNull();
  });

  test("a long suspend: replace the worker, whatever the windows say", () => {
    const h = new RuntimeHealth({ now: () => T0 });
    h.noteSuspend(T0 - 20 * 60_000, 20 * 60_000);                    // a short nap: no
    expect(h.degraded()).toBeNull();
    h.noteSuspend(T0 - 14.2 * H, 14.2 * H);
    const d = h.degraded()!;
    expect(d.kind).toBe("suspend");
    expect(d.recycle).toBe(true);
    expect(d.why).toStartWith("the machine slept 14.2 h (woke ");
    expect(RECYCLE_AFTER_SUSPEND_MS).toBeLessThanOrEqual(H);         // the 1.1-11 h gap: recycle on the safe side
  });

  test("the symptom needs two bad windows in a row; a good one clears it", () => {
    const h = new RuntimeHealth({ now: () => T0 });
    h.noteWindow(bad(T0));
    expect(h.degraded()).toBeNull();
    h.noteWindow({ end: T0 + 300_000, procCpuPct: 30, blockedPct: 2 });
    h.noteWindow(bad(T0 + 600_000));
    expect(h.degraded()).toBeNull();
    h.noteWindow({ end: T0 + 900_000, procCpuPct: 271, blockedPct: 90 });
    const d = h.degraded()!;
    expect(d).toMatchObject({ kind: "symptom", recycle: true });
    expect(d.why).toStartWith("this API has used 249% CPU or more with its loop blocked 77% or more for 10 min");
  });

  test("loop guard: a worker replaced for the symptom within the hour is not replaced for it again", () => {
    const dir = testTempDir("runtime-health-");
    const file = join(dir, "runtime-recycle.json");
    let now = T0;
    const first = new RuntimeHealth({ file, now: () => now });
    first.noteWindow(bad(now)); first.noteWindow(bad(now + 300_000));
    const d = first.degraded()!;
    expect(d.recycle).toBe(true);
    first.recycling(d);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ at: T0, kind: "symptom" });

    now = T0 + 12 * 60_000;                                           // the next worker, 12 min later, shows it too
    const next = new RuntimeHealth({ file, now: () => now });
    next.noteWindow(bad(now)); next.noteWindow(bad(now + 300_000));
    const again = next.degraded()!;
    expect(again.recycle).toBe(false);
    expect(again.why).toContain("a worker was already replaced for this 12 min ago");

    now = T0 + SYMPTOM_GUARD_MS + 1;                                  // after the hour: allowed again
    const later = new RuntimeHealth({ file, now: () => now });
    later.noteWindow(bad(now)); later.noteWindow(bad(now + 300_000));
    expect(later.degraded()!.recycle).toBe(true);
  });

  test("a suspend restart does not hold back a later symptom restart; an unreadable record is no guard", () => {
    const dir = testTempDir("runtime-health-");
    const file = join(dir, "runtime-recycle.json");
    writeFileSync(file, JSON.stringify({ at: T0, kind: "suspend" }));
    const h = new RuntimeHealth({ file, now: () => T0 + 60_000 });
    h.noteWindow(bad(T0)); h.noteWindow(bad(T0 + 300_000));
    expect(h.degraded()!.recycle).toBe(true);
    writeFileSync(file, "{torn");
    const h2 = new RuntimeHealth({ file, now: () => T0 + 60_000 });
    h2.noteWindow(bad(T0)); h2.noteWindow(bad(T0 + 300_000));
    expect(h2.degraded()!.recycle).toBe(true);
  });

  test("no file: recycling writes nothing and nothing throws", () => {
    const h = new RuntimeHealth({ now: () => T0 });
    h.noteSuspend(T0 - H, H);
    expect(() => h.recycling(h.degraded()!)).not.toThrow();
  });
});

describe("degradedReason", () => {
  const d = { kind: "suspend" as const, recycle: true, why: "the machine slept 14.2 h (woke 19:34)" };
  test("says what happens next", () => {
    expect(degradedReason(d, {})).toBe("the API is degraded: the machine slept 14.2 h (woke 19:34) — it restarts itself when no session is live");
    expect(degradedReason(d, { DEGRADED_RESTART: "off" })).toContain("automatic restart is off");
    expect(degradedReason(d, { AUTO_RESTART: "0" })).toContain("automatic restart is off");
    expect(degradedReason({ ...d, recycle: false }, {})).toBe("the API is degraded: the machine slept 14.2 h (woke 19:34)");
  });
});
