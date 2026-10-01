import { describe, expect, test } from "bun:test";
import { chartStacks6, treeGap6, STACK_GAP_TAU } from "./treeGap";

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

  test("the deep raiser is no gap, the short caller is the 80-on-70 one", () => {
    const g = treeGap6({ chartId: "ign200_6max_D100_s70_BTN_o2_5", byPos, hero: "SB", folded, aggressor: "CO", after: ["BB"],
      wantedId: "ign200_6max_D100_s80_BTN_o2_5" })!;
    expect(g.stack).toEqual({ seat: "BTN", real: 80.03, chart: 70, ratio: 1.143, bb: 10, role: "in" });
    expect(g.pot).toEqual(g.stack);
    expect(g.seats.map((s) => `${s.seat}:${s.role}`).sort()).toEqual(["BB:behind", "BTN:in", "CO:raiser"]);
    expect(g.seats.find((s) => s.seat === "CO")!.ratio).toBe(1);          // min(100, 242) = 100 in both
    expect(g.seats.some((s) => s.seat === "HJ")).toBe(false);             // folded
    expect(g.wanted).toEqual({ chart: "ign200_6max_D100_s80_BTN_o2_5", ratio: 1 });
    expect(g.gate).toEqual({ tau: STACK_GAP_TAU, wouldRoute: false });
  });

  test("a short seat far from its rung would route; hero's own stack caps a deep opponent", () => {
    const g = treeGap6({ chartId: "ign200_6max_D100_s30_BB_o2_5", byPos: { BTN: 100, SB: 250, BB: 44 }, hero: "BTN", folded: new Set(["UTG", "HJ", "CO"]) })!;
    expect(g.stack!.seat).toBe("BB");
    expect(g.stack!.ratio).toBe(1.467);
    expect(g.pot).toBeNull();                                            // hero first in: judged on the seats behind
    expect(g.gate.wouldRoute).toBe(true);
  });

  test("a few-bb stack still to act is the worst seat, not the pot's: the gate reads the raiser", () => {
    const g = treeGap6({ chartId: "ign200_6max_D100_o2_5", byPos: { CO: 100, BTN: 100, BB: 4 }, hero: "BTN",
      folded: new Set(["UTG", "HJ", "SB"]), aggressor: "CO", after: ["BB"] })!;
    expect([g.stack!.seat, g.stack!.ratio, g.stack!.bb]).toEqual(["BB", 25, 96]);
    expect([g.pot!.seat, g.pot!.ratio]).toEqual(["CO", 1]);
    expect(g.gate.wouldRoute).toBe(false);
  });

  test("deep hero against a deep opponent on the 150bb chart", () => {
    const g = treeGap6({ chartId: "ign200_6max_D150_o2_5", byPos: { CO: 260, BTN: 300 }, hero: "BTN", folded: new Set() })!;
    expect(g.stack).toEqual({ seat: "CO", real: 260, chart: 150, ratio: 1.733, bb: 110, role: "behind" });
  });

  test("size snaps: the largest, borrowed callers left out", () => {
    const g = treeGap6({ chartId: "ign200_6max_D100_o2_5", byPos: { CO: 100, BTN: 100 }, hero: "BTN", folded: new Set(),
      repaired: [{ from: "R2.2", to: "R2.5", logDist: Math.log(2.5 / 2.2) }, { from: "C", to: "F", logDist: 0, borrowed: "HJ" }] })!;
    expect(g.size).toEqual({ from: "R2.2", to: "R2.5", ratio: 1.136 });
    expect(g.stack!.ratio).toBe(1);
  });

  test("unmeasurable: unknown id, hero's stack unreadable", () => {
    expect(treeGap6({ chartId: "nope", byPos, hero: "SB", folded })).toBeNull();
    expect(treeGap6({ chartId: "ign200_6max_D100_o2_5", byPos: { CO: 100 }, hero: "SB", folded })).toBeNull();
  });
});
