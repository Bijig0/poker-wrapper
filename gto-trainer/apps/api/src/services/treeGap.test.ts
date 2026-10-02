import { describe, expect, test } from "bun:test";
import { chartStacks6, treeGap6, gapReasons, gapGateMode, SIZE_TAU, RERAISE_STACK_TAU } from "./treeGap";

describe("chartStacks6 — the stacks a chart was solved at, off its id", () => {
  test("even, limp, one-short, patch", () => {
    expect(chartStacks6("ign200_6max_D75_o2_5")!.BTN).toBe(75);
    expect(chartStacks6("ign200_6max_D100_olimp_pool3")!.SB).toBe(100);
    const s70 = chartStacks6("ign200_6max_D100_s70_BTN_o2_5")!;
    expect([s70.BTN, s70.CO, s70.SB]).toEqual([70, 100, 100]);
    expect(chartStacks6("ign200_6max_D100_s7_5_BB_o5")!.BB).toBe(7.5);
    const p = chartStacks6("ign200_6max_P_BTN150_BB80_o2_3b11")!;
    expect([p.BTN, p.BB, p.UTG]).toEqual([150, 80, 100]);
    expect(chartStacks6("ign200_6max_P_EVEN_o2_5_3b11")!.CO).toBe(100);
    expect(chartStacks6("ign200_3maxasym_D100_s40_sb")).toBeNull();
  });
});

describe("treeGap6 — effective stacks at the table against the chart's", () => {
  // hand 4921874909: SB hero 100, CO 242.56 opens, BTN 80.03 calls, HJ folded; answered from the s70 BTN chart
  const byPos = { HJ: 108.88, CO: 242.56, BTN: 80.03, SB: 100, BB: 100.01 };
  const folded = new Set(["UTG", "HJ"]);

  test("the deep raiser is no gap, the short caller is the 80-on-70 one — and a first decision is never routed on stacks", () => {
    const g = treeGap6({ chartId: "ign200_6max_D100_s70_BTN_o2_5", byPos, hero: "SB", folded, aggressor: "CO", after: ["BB"],
      rawTokens: ["F", "F", "R2.5", "C"], wantedId: "ign200_6max_D100_s80_BTN_o2_5", mode: "live" })!;
    expect(g.stack).toEqual({ seat: "BTN", real: 80.03, chart: 70, ratio: 1.143, bb: 10, role: "in" });
    expect(g.pot).toEqual(g.stack);
    expect(g.seats.map((s) => `${s.seat}:${s.role}`).sort()).toEqual(["BB:behind", "BTN:in", "CO:raiser"]);
    expect(g.seats.find((s) => s.seat === "CO")!.ratio).toBe(1);          // min(100, 242) = 100 in both
    expect(g.seats.some((s) => s.seat === "HJ")).toBe(false);             // folded
    expect(g.wanted).toEqual({ chart: "ign200_6max_D100_s80_BTN_o2_5", ratio: 1 });
    expect([g.raises, g.allIn]).toEqual([1, false]);
    expect(g.gate).toEqual({ mode: "live", route: false, reasons: [] });
  });

  test("a short seat far from its rung, hero first in: measured, not routed", () => {
    const g = treeGap6({ chartId: "ign200_6max_D100_s30_BB_o2_5", byPos: { BTN: 100, SB: 250, BB: 44 }, hero: "BTN",
      folded: new Set(["UTG", "HJ", "CO"]), rawTokens: ["F", "F", "F"], mode: "live" })!;
    expect([g.stack!.seat, g.stack!.ratio]).toEqual(["BB", 1.467]);
    expect(g.pot).toBeNull();
    expect(g.gate.route).toBe(false);
  });

  test("deep hero against a deep opponent on the 150bb chart", () => {
    const g = treeGap6({ chartId: "ign200_6max_D150_o2_5", byPos: { CO: 260, BTN: 300 }, hero: "BTN", folded: new Set() })!;
    expect(g.stack).toEqual({ seat: "CO", real: 260, chart: 150, ratio: 1.733, bb: 110, role: "behind" });
  });

  test("unmeasurable: unknown id, hero's stack unreadable", () => {
    expect(treeGap6({ chartId: "nope", byPos, hero: "SB", folded })).toBeNull();
    expect(treeGap6({ chartId: "ign200_6max_D100_o2_5", byPos: { CO: 100 }, hero: "SB", folded })).toBeNull();
  });
});

describe("the gap gate — past a measured bound the exact tree answers", () => {
  const even = "ign200_6max_D100_o2_5";
  const flat = { CO: 100, BTN: 100, BB: 100 };
  const snap = (index: number, from: number, to: number) => ({ index, from: `R${from}`, to: `R${to}`, logDist: Math.abs(Math.log(from / to)) });

  test("the bounds as measured: open 1.25x, 3-bet 1.15x, 4-bet 1.10x; a re-raiser's stack 1.3x", () => {
    expect([...SIZE_TAU]).toEqual([1.25, 1.15, 1.1]);
    expect(RERAISE_STACK_TAU).toBe(1.3);
  });

  test("an open: 2.7 on the 2.5 tree stays, 3.3 on it goes; the level is the raise's place in the line", () => {
    const near = treeGap6({ chartId: even, byPos: flat, hero: "BB", folded: new Set(["UTG", "HJ", "CO", "SB"]), aggressor: "BTN", after: [],
      repaired: [snap(3, 2.7, 2.5)], fitted: ["F", "F", "F", "R2.5", "F"], rawTokens: ["F", "F", "F", "R2.7", "F"], mode: "live" })!;
    expect(near.size).toEqual({ from: "R2.7", to: "R2.5", ratio: 1.08, level: 1 });
    expect(near.gate.route).toBe(false);
    const far = treeGap6({ chartId: even, byPos: flat, hero: "BB", folded: new Set(["UTG", "HJ", "CO", "SB"]), aggressor: "BTN", after: [],
      repaired: [snap(3, 3.3, 2.5)], fitted: ["F", "F", "F", "R2.5", "F"], rawTokens: ["F", "F", "F", "R3.3", "F"], mode: "live" })!;
    expect(far.gate).toEqual({ mode: "live", route: true, reasons: [{ rule: "size", level: 1, ratio: 1.32, tau: 1.25, what: "R3.3→R2.5" }] });
  });

  test("a 3-bet 1.2x off goes where the same open would stay; borrowed callers and all-ins are not sizes", () => {
    const g = treeGap6({ chartId: even, byPos: flat, hero: "CO", folded: new Set(["UTG", "HJ", "SB", "BB"]), aggressor: "BTN", after: [],
      repaired: [snap(3, 9, 7.5), { index: 1, from: "C", to: "F", logDist: 0, borrowed: "HJ" }, { index: 3, from: "RAI", to: "R25", logDist: 0 }],
      fitted: ["F", "F", "R2.5", "R7.5", "F", "F"], rawTokens: ["F", "F", "R2.5", "R9", "F", "F"], mode: "live" })!;
    expect(g.size).toEqual({ from: "R9", to: "R7.5", ratio: 1.2, level: 2 });
    expect(g.gate.reasons).toEqual([{ rule: "size", level: 2, ratio: 1.2, tau: 1.15, what: "R9→R7.5" }]);
  });

  test("stacks: facing a 3-bet from a 60bb seat the chart holds at 100 goes; the same seat merely opening stays", () => {
    const byPos = { CO: 100, BTN: 60, BB: 100 };
    const opened = treeGap6({ chartId: even, byPos, hero: "BB", folded: new Set(["UTG", "HJ", "CO", "SB"]), aggressor: "BTN", after: [],
      rawTokens: ["F", "F", "F", "R2.5", "F"], mode: "live" })!;
    expect(opened.gate.route).toBe(false);
    const reraised = treeGap6({ chartId: even, byPos, hero: "CO", folded: new Set(["UTG", "HJ", "SB", "BB"]), aggressor: "BTN", after: [],
      rawTokens: ["F", "F", "R2.5", "R8.75", "F", "F"], mode: "live" })!;
    expect(reraised.gate.reasons).toEqual([{ rule: "stack", level: 2, ratio: 1.667, tau: 1.3, what: "BTN 60bb, 100bb in the chart" }]);
    // on that seat's own short chart the stacks agree
    expect(treeGap6({ chartId: "ign200_6max_D100_s60_BTN_o2_5", byPos, hero: "CO", folded: new Set(["UTG", "HJ", "SB", "BB"]), aggressor: "BTN", after: [],
      rawTokens: ["F", "F", "R2.5", "R8.75", "F", "F"], mode: "live" })!.gate.route).toBe(false);
  });

  test("an open jam is an all-in in front of hero: the jammer's stack is the price", () => {
    const g = treeGap6({ chartId: "ign200_6max_D100_s30_CO_o2_5", byPos: { CO: 14, BTN: 100, BB: 100 }, hero: "BTN",
      folded: new Set(["UTG", "HJ"]), aggressor: "CO", after: ["SB", "BB"], rawTokens: ["F", "F", "RAI"], mode: "live" })!;
    expect([g.raises, g.allIn]).toEqual([1, true]);
    expect(g.gate.reasons.map((r) => [r.rule, r.ratio])).toEqual([["stack", 2.143]]);
  });

  test("a stack still to act never routes, whatever its ratio", () => {
    const g = treeGap6({ chartId: even, byPos: { CO: 100, BTN: 100, BB: 4 }, hero: "BTN", folded: new Set(["UTG", "HJ", "SB"]),
      aggressor: "CO", after: ["BB"], rawTokens: ["F", "F", "R2.5"], mode: "live" })!;
    expect([g.stack!.seat, g.stack!.ratio]).toEqual(["BB", 25]);
    expect(g.gate.route).toBe(false);
  });

  test("gapReasons is the whole rule; modes: log records the verdict, off records none, live when unset", () => {
    expect(gapReasons({ seats: [], raises: 1, allIn: false }, [{ from: "R5", to: "R3.5", ratio: 1.429, level: 1 }]).length).toBe(1);
    expect(gapReasons({ seats: [], raises: 3, allIn: false }, [{ from: "R22", to: "R20", ratio: 1.1, level: 3 }]).length).toBe(0);
    const args = { chartId: even, byPos: flat, hero: "BB", folded: new Set(["UTG", "HJ", "CO", "SB"]), aggressor: "BTN", after: [],
      repaired: [snap(3, 5, 3.5)], fitted: ["F", "F", "F", "R3.5", "F"], rawTokens: ["F", "F", "F", "R5", "F"] };
    expect(treeGap6({ ...args, mode: "log" })!.gate).toMatchObject({ mode: "log", route: true });
    expect(treeGap6({ ...args, mode: "off" })!.gate).toEqual({ mode: "off", route: false, reasons: [] });
    const prev = process.env.PREFLOP_GAP_GATE;
    try {
      delete process.env.PREFLOP_GAP_GATE; expect(gapGateMode()).toBe("live");
      process.env.PREFLOP_GAP_GATE = "log"; expect(gapGateMode()).toBe("log");
      process.env.PREFLOP_GAP_GATE = "OFF"; expect(gapGateMode()).toBe("off");
    } finally { if (prev == null) delete process.env.PREFLOP_GAP_GATE; else process.env.PREFLOP_GAP_GATE = prev; }
  });
});
