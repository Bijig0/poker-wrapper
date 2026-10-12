import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { _clearStalls, _recordStall } from "./answerTrace";
import { labelFromCommandLine, loadReport, MachineSampler, parseTypeperf, verdictOf } from "./machineLoad";
import { __setSessionLiveReader, refreshSessionLive } from "./sessionLive";

/**
 * GET /api/load (2026-10-07) — the wrapper's panel and preflight are built against this shape and these rules:
 *   heavy = a stall >= 5 s in the last 5 min, or CPU >= 85% sustained (every sample of the last minute, two at least)
 *   warn  = a stall >= 1 s in the last 5 min, or CPU >= 60%, or a process using > 15% of the machine
 */
const NOW = new Date(2026, 9, 7, 12, 20, 0).getTime();
const stall = (agoMs: number, ms: number, open: string[] = []) => ({ at: NOW - agoMs - ms, ms, cpuMs: null, open });

describe("verdict rules", () => {
  it("ok with nothing", () => {
    expect(verdictOf({ now: NOW, stalls: [], cpu: [], heavy: [] })).toEqual({ verdict: "ok", reasons: [] });
    expect(verdictOf({ now: NOW, stalls: [stall(1000, 400)], cpu: [{ at: NOW, pct: 30 }], heavy: [] }).verdict).toBe("ok");
  });

  it("a freeze of 5 s+ is heavy and says when and what was running", () => {
    const v = verdictOf({ now: NOW, stalls: [stall(180_000, 55_500, ["timer answerReconciler (55.5 s: hands query 55.4 s)"]), stall(60_000, 1_200)], cpu: [], heavy: [] });
    expect(v.verdict).toBe("heavy");
    expect(v.reasons).toEqual(["the API froze 56 s at 12:16 (timer answerReconciler was running) — 2 freezes of 1 s or more in the last 5 min"]);
  });

  it("names the tick that timed its steps, not a long-open async one that merely spans the freeze", () => {
    const open = ["timer gtowSessions.refresh (70.0 s, still open)", "GET /api/dashboard/load (0.0 s, still open)", "timer answerReconciler (55.5 s: hands query 55.4 s)"];
    expect(verdictOf({ now: NOW, stalls: [stall(1000, 55_500, open)], cpu: [], heavy: [] }).reasons[0]).toContain("(timer answerReconciler was running)");
    const noSteps = ["timer gtowSessions.refresh (70.0 s, still open)", "GET /api/dashboard/analytics (2.0 s)"];
    expect(verdictOf({ now: NOW, stalls: [stall(1000, 2_000, noSteps)], cpu: [], heavy: [] }).reasons[0]).toContain("(GET /api/dashboard/analytics was running)");
  });

  it("a degraded runtime is a warning, said first (services/runtimeHealth.ts)", () => {
    const why = "the API is degraded: the machine slept 14.2 h (woke 19:34) — it restarts itself when no session is live";
    expect(verdictOf({ now: NOW, stalls: [], cpu: [], heavy: [], degraded: why })).toEqual({ verdict: "warn", reasons: [why] });
    const both = verdictOf({ now: NOW, stalls: [stall(10_000, 1_400)], cpu: [], heavy: [], degraded: why });
    expect(both.reasons).toEqual([why, "the API froze 1.4 s at 12:19"]);
  });

  it("a freeze of 1-5 s is a warning", () => {
    const v = verdictOf({ now: NOW, stalls: [stall(10_000, 1_400)], cpu: [], heavy: [] });
    expect(v).toEqual({ verdict: "warn", reasons: ["the API froze 1.4 s at 12:19"] });
  });

  it("CPU: 60% warns, 85% sustained over the last minute is heavy, one 85% sample is only a warning", () => {
    expect(verdictOf({ now: NOW, stalls: [], cpu: [{ at: NOW, pct: 72 }], heavy: [] })).toEqual({ verdict: "warn", reasons: ["the machine's CPU is at 72%"] });
    const sustained = verdictOf({ now: NOW, stalls: [], cpu: [{ at: NOW - 40_000, pct: 88 }, { at: NOW - 20_000, pct: 90 }, { at: NOW, pct: 91 }], heavy: [] });
    expect(sustained.verdict).toBe("heavy");
    expect(sustained.reasons[0]).toBe("the machine's CPU has been at 85% or more for the last minute (now 91%)");
    expect(verdictOf({ now: NOW, stalls: [], cpu: [{ at: NOW - 20_000, pct: 40 }, { at: NOW, pct: 90 }], heavy: [] }).verdict).toBe("warn");
    expect(verdictOf({ now: NOW, stalls: [], cpu: [{ at: NOW, pct: 90 }], heavy: [] }).verdict).toBe("warn");
  });

  it("a heavy process warns by name; heavy reasons come first", () => {
    const v = verdictOf({ now: NOW, stalls: [stall(5_000, 6_000)], cpu: [], heavy: [{ name: "bun test", pid: 42, cpuPct: 70.2 }] });
    expect(v.verdict).toBe("heavy");
    expect(v.reasons).toEqual(["the API froze 6.0 s at 12:19", "bun test is using 70% CPU"]);
  });

  it("memory: under 1 GB free is heavy (paging), under 2 GB warns, more says nothing (2026-10-12)", () => {
    const mem = (freeMb: number) => verdictOf({ now: NOW, stalls: [], cpu: [], heavy: [], mem: { at: NOW, freeMb, totalMb: 32_768 } });
    expect(mem(457)).toEqual({ verdict: "heavy", reasons: [
      "the machine is short of memory (0.4 GB of 32.0 GB free) — it is paging: file reads and the API's own memory wait on the disk"] });
    expect(mem(1_500)).toEqual({ verdict: "warn", reasons: ["the machine is short of memory (1.5 GB of 32.0 GB free)"] });
    expect(mem(4_500)).toEqual({ verdict: "ok", reasons: [] });
  });
});

describe("process sampling", () => {
  it("parses typeperf: per-process CPU as a share of the whole machine, _Total and Idle dropped", () => {
    const out = [
      "",
      '"(PDH-CSV 4.0) (AUS Eastern Daylight Time)(-660)","\\\\BRADY\\Process(Idle)\\% Processor Time","\\\\BRADY\\Process(bun#2)\\% Processor Time","\\\\BRADY\\Process(MsMpEng)\\% Processor Time","\\\\BRADY\\Process(_Total)\\% Processor Time","\\\\BRADY\\Process(Idle)\\ID Process","\\\\BRADY\\Process(bun#2)\\ID Process","\\\\BRADY\\Process(MsMpEng)\\ID Process","\\\\BRADY\\Process(_Total)\\ID Process"',
      // the first sample of a rate counter can be garbage: the last one is read, and an impossible value dropped
      '"10/07/2026 12:19:59.000","1200.0","2550.000000","80.000000","1600.0","0.000000","4242.000000","3100.000000","0.000000"',
      '"10/07/2026 12:20:00.000","1200.0","400.000000","80.000000","1600.0","0.000000","4242.000000","3100.000000","0.000000"',
      "Exiting, please wait...",
    ].join("\r\n");
    expect(parseTypeperf(out, 16)).toEqual([
      { name: "bun", pid: 4242, cpuPct: 25 },
      { name: "MsMpEng", pid: 3100, cpuPct: 5 },
    ]);
    expect(parseTypeperf("garbage", 16)).toEqual([]);
  });

  it("names a process from its command line", () => {
    expect(labelFromCommandLine("bun", '"C:\\Users\\Brady\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe" test src/services')).toBe("bun test");
    expect(labelFromCommandLine("bun", "bun run src/scripts/replayGate.ts --session x")).toBe("bun replayGate.ts");
    expect(labelFromCommandLine("node", '"C:\\Program Files\\nodejs\\node.exe" C:\\x\\node_modules\\typescript\\bin\\tsc --noEmit')).toBe("tsc");
    expect(labelFromCommandLine("python", "python C:\\x\\boxwatch.py")).toBe("python boxwatch.py");
    expect(labelFromCommandLine("MsMpEng", null)).toBe("MsMpEng");
    expect(labelFromCommandLine("chrome", '"chrome.exe" --type=renderer')).toBe("chrome");
  });
});

describe("GET /api/load", () => {
  beforeEach(() => _clearStalls());
  afterAll(() => { _clearStalls(); __setSessionLiveReader(() => null); });

  it("has the contract's shape, from memory", async () => {
    let now = NOW;
    let totals = { idle: 1000, all: 2000 };
    const s = new MachineSampler({
      now: () => now,
      cpuTotals: () => totals,
      processes: async () => [{ name: "bun", pid: 77, cpuPct: 40 }, { name: "bun", pid: 1, cpuPct: 20 }, { name: "chrome", pid: 9, cpuPct: 2 }],
      commandLines: async (pids) => new Map(pids.map((p) => [p, "bun test"])),
      memory: () => ({ freeMb: 8_192, totalMb: 32_768 }),
      selfPid: 1,
    });
    __setSessionLiveReader(() => "session_x", () => now);
    await s.sample();                                  // the first sample only sets the CPU baseline
    now += 20_000;
    totals = { idle: 1300, all: 3000 };                // 70% busy over the interval
    await s.sample();
    _recordStall(NOW + 5_000, 1_500, 20, ["timer answerReconciler (1.6 s: hands query 1.5 s)"]);
    _recordStall(NOW + 15_000, 320);
    refreshSessionLive();
    const r = loadReport(now, s);
    expect(r).toEqual({
      ok: true,
      at: now,
      verdict: "warn",
      reasons: [
        "the API froze 1.5 s at 12:20 (timer answerReconciler was running)",
        "the machine's CPU is at 70%",
        "bun test is using 40% CPU",
        "bun (this API) is using 20% CPU",
      ],
      loop: { stalls1m: 2, stalls5m: 2, maxMs5m: 1_500, blockedMs5m: 1_820, lastStallAt: NOW + 15_000 },
      machine: { cpuPct: 70, heavy: [{ name: "bun test", pid: 77, cpuPct: 40 }, { name: "bun (this API)", pid: 1, cpuPct: 20 }],
        memFreeMb: 8_192, memTotalMb: 32_768 },
      sessionLive: true,
    });
    // samples that stopped arriving are not reported
    const stale = loadReport(now + 10 * 60_000, s);
    expect(stale.machine).toEqual({ cpuPct: null, heavy: [], memFreeMb: null, memTotalMb: null });
    expect(stale.loop.stalls5m).toBe(0);
    expect(stale.loop.lastStallAt).toBe(NOW + 15_000);
  });

  it("is served by the dashboard routes without a live-answer gate", async () => {
    const { default: app } = await import("../routes/dashboard");
    const r = await app.request("/load");
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(["at", "loop", "machine", "ok", "reasons", "sessionLive", "verdict"]);
    expect(Object.keys(j.loop as object).sort()).toEqual(["blockedMs5m", "lastStallAt", "maxMs5m", "stalls1m", "stalls5m"]);
    expect(Object.keys(j.machine as object).sort()).toEqual(["cpuPct", "heavy", "memFreeMb", "memTotalMb"]);
  });
});
