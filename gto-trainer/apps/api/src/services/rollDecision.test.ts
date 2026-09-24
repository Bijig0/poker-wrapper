import { describe, expect, test } from "bun:test";
import { drawRoll, fmtRoll, resolvePick, rollDecision } from "./rollDecision";
import { checkAnswerIntegrity } from "./answerIntegrity";

const A = (action: string, frequency: number) => ({ action, frequency });

describe("rollDecision — one roll per decision", () => {
  test("the roll walks the mix in solve order; a band is (lo, hi]", () => {
    const mix = [A("Fold", 70), A("Raise 3", 30)];
    const drawn = A("Raise 3", 30); // whatever the solver drew must not matter
    expect(resolvePick(drawn, mix, 70.0)).toEqual({ pick: "Fold", frequency: 70, roll: 70, band: [0, 70] });
    expect(resolvePick(drawn, mix, 70.1)).toEqual({ pick: "Raise 3", frequency: 30, roll: 70.1, band: [70, 100] });
  });

  test("one decimal place: a 63.4% action is played on 63.4 of every 100.0", () => {
    const mix = [A("Raise 2.5", 63.4), A("Fold", 36.6)];
    expect(resolvePick(A("Fold", 36.6), mix, 63.4).pick).toBe("Raise 2.5");
    expect(resolvePick(A("Fold", 36.6), mix, 63.5).pick).toBe("Fold");
  });

  test("2026-09-24: the solver drew 0.69% noise — the one real action is served, not the noise", () => {
    const mix = [A("CHECK", 99.3141879076708), A("BET 1.3", 0.6858167629537717)];
    const r = resolvePick(A("BET 1.3", 0.6858167629537717), mix, 42);
    expect(r).toEqual({ pick: "CHECK", frequency: 99.3141879076708, roll: null, band: [0, 100] });
  });

  test("a pure piece (>= 99%) is the answer outright, whatever mix rides along", () => {
    // the exploit overlay's shape: its pick at 100% over the chart's mix
    const r = resolvePick(A("Raise 2.5", 100), [A("Fold", 99.97), A("Raise 2.5", 0.01)], 5);
    expect(r).toEqual({ pick: "Raise 2.5", frequency: 100, roll: null, band: [0, 100] });
  });

  test("#7444: the headline, band and pick all come from the one roll", () => {
    const mix = [A("Fold", 13), A("Limp", 30), A("Raise 4", 29), A("Raise 5", 28)];
    const r = rollDecision({ decision: A("Fold", 13), actions: mix }, 95);
    expect(r.pick).toBe("Raise 5");
    expect(r.frequency).toBe(28);
    expect(r.band).toEqual([72, 100]);
    expect(r.roll).toBe(95);
  });

  test("every one of the 1000 rolls lands inside the band it reports; each action owns its share to 0.1", () => {
    // 63.46 used to report band [0, 63.5] yet hand a roll of 63.5 to Fold
    const mix = [A("Raise 2.5", 63.46), A("Fold", 36.54)];
    let raise = 0;
    for (let t = 1; t <= 1000; t++) {
      const r = resolvePick(A("Fold", 36.54), mix, t / 10);
      expect(r.roll! > r.band[0] && r.roll! <= r.band[1]).toBe(true);
      if (r.pick === "Raise 2.5") raise++;
    }
    expect(raise).toBe(634);
    expect(resolvePick(A("Fold", 36.54), mix, 63.4).band).toEqual([0, 63.4]);
    expect(resolvePick(A("Fold", 36.54), mix, 63.5).band).toEqual([63.4, 100]);
  });

  test("a roll of 100.0 lands on the last action even when the running sum drifts under 100", () => {
    const mix = [A("Fold", 33.3), A("Call", 33.3), A("Raise 3", 33.4)];
    expect(resolvePick(A("Fold", 33.3), mix, 100).pick).toBe("Raise 3");
  });

  test("the piece that did not answer is walked on the SAME roll over its own mix", () => {
    const exploit = { action: "Raise 2.5", frequency: 100, roll: 100, band: [0, 100] };
    const sol = {
      decision: exploit, exploitDecision: exploit,
      actions: [A("Raise 2.5", 100)],
      chartDecision: { action: "Fold", frequency: 60, roll: 12, band: [0, 60] },
      chartActions: [A("Fold", 60), A("Raise 2.5", 40)],
    };
    expect(rollDecision(sol, 75)).toMatchObject({ pick: "Raise 2.5", roll: null, exploitPick: "Raise 2.5", chartPick: "Raise 2.5" });
    expect(rollDecision(sol, 12)).toMatchObject({ pick: "Raise 2.5", exploitPick: "Raise 2.5", chartPick: "Fold" });
  });

  test("when the chart answered, its column IS the served pick (not the solver's own draw)", () => {
    const chartDraw = { action: "Check", frequency: 55, roll: 20, band: [0, 55] };
    const r = rollDecision({
      decision: chartDraw, chartDecision: chartDraw, actions: [A("Check", 55), A("Bet 33%", 45)],
      exploitDecision: { action: "Check", frequency: 80 }, exploitActions: [A("Check", 80), A("Bet 33%", 20)],
    }, 90);
    expect(r).toMatchObject({ pick: "Bet 33%", chartPick: "Bet 33%", exploitPick: "Bet 33%" });
  });

  test("drawRoll: 0.1 … 100.0, one decimal, and fmtRoll always prints the decimal", () => {
    for (let i = 0; i < 20_000; i++) {
      const r = drawRoll();
      expect(r >= 0.1 && r <= 100).toBe(true);
      expect(Math.abs(r * 10 - Math.round(r * 10)) < 1e-9).toBe(true);
    }
    expect(fmtRoll(41)).toBe("41.0");
    expect(fmtRoll(63.4)).toBe("63.4");
  });

  test("the integrity check agrees with every roll the roller makes", () => {
    const mixes = [
      [A("Fold", 13), A("Limp", 30), A("Raise 4", 29), A("Raise 5", 28)],
      [A("Fold", 33.3), A("Call", 33.3), A("Raise 3", 33.4), A("Raise 9", 0.01)],
      [A("Check", 99.3), A("Bet", 0.7)],
    ];
    for (const actions of mixes) {
      for (let t = 1; t <= 1000; t++) {
        const r = rollDecision({ decision: actions[actions.length - 1]!, actions }, t / 10);
        expect(checkAnswerIntegrity({ pick: r.pick, roll: r.roll, actions })).toEqual([]);
      }
    }
  });
});
