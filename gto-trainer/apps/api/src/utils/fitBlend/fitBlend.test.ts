import { describe, expect, it } from "bun:test";
import { blendFitMixes, blendTaken, type MixAction } from "./fitBlend";

const mixOf = (out: MixAction[]) => Object.fromEntries(out.map((a) => [a.action, Math.round(a.frequency * 100) / 100]));

describe("blendTaken: the range side of the same blend (2026-10-07, hero-range-as-answered)", () => {
  const keepCo = [{ action: "Fold", frequency: 0.6 }, { action: "Call", frequency: 0.1 }, { action: "Raise 7", frequency: 0.3 }];
  const keepSb = [{ action: "Fold", frequency: 0.2 }, { action: "Call", frequency: 0.7 }, { action: "Raise 7", frequency: 0.1 }];
  const took = (m: MixAction[], label: string) => m.map((a) => ({ ...a, taken: a.action === label }));

  it("for every action it is the answer's own frequency", () => {
    const answer = mixOf(blendFitMixes([keepCo, keepSb]));
    expect(answer).toEqual({ Fold: 60, Call: 30, "Raise 7": 10 });
    for (const label of ["Fold", "Call", "Raise 7"]) {
      expect(blendTaken([took(keepCo, label), took(keepSb, label)]) * 100).toBeCloseTo(answer[label]!, 9);
    }
  });

  it("hand 4922577588's 77 (BB vs CO open + BTN + SB): SB folded calls 92 / raises 8, BTN folded 3-bets 96 — the blend calls 92", () => {
    const sbFolded = [{ action: "Fold", frequency: 0 }, { action: "Call", frequency: 0.919654 }, { action: "Raise 7", frequency: 0.080225 }, { action: "All-in", frequency: 0.000121 }];
    const btnFolded = [{ action: "Fold", frequency: 0 }, { action: "Call", frequency: 0.040681 }, { action: "Raise 7", frequency: 0.956517 }, { action: "All-in", frequency: 0.002802 }];
    expect(blendTaken([took(sbFolded, "Call"), took(btnFolded, "Call")])).toBeCloseTo(0.919654, 5);
    // and 73s, which the BTN-folded fit calls 93%: the blend folds it at the SB-folded fit's 75%
    const a = [{ action: "Fold", frequency: 0.746907 }, { action: "Call", frequency: 0.252752 }, { action: "Raise 7", frequency: 0.000342 }];
    const b = [{ action: "Fold", frequency: 0.064782 }, { action: "Call", frequency: 0.932122 }, { action: "Raise 7", frequency: 0.003096 }];
    expect(blendTaken([took(a, "Call"), took(b, "Call")])).toBeCloseTo(0.252751, 5);
  });

  it("a hand one fit calls and the other folds 100% is OUT of hero's calling range — the one fit alone kept it", () => {
    const folds = [{ action: "Fold", frequency: 1 }, { action: "Call", frequency: 0 }];
    const calls = [{ action: "Fold", frequency: 0.05 }, { action: "Call", frequency: 0.95 }];
    expect(blendTaken([took(folds, "Call"), took(calls, "Call")])).toBe(0);
    expect(blendTaken([took(calls, "Call")])).toBeCloseTo(0.95, 9);     // one fit: its own frequency
  });

  it("a raise: the blended aggression times the taken size's share of the least raising fit's raises", () => {
    const a = [{ action: "Fold", frequency: 0.5 }, { action: "Call", frequency: 0.1 }, { action: "Raise 7", frequency: 0.3 }, { action: "Raise 9", frequency: 0.1 }];
    const b = [{ action: "Fold", frequency: 0.3 }, { action: "Call", frequency: 0.5 }, { action: "Raise 7", frequency: 0.2 }];
    // least raising = b (20%), all of it at 7 — exactly what blendFitMixes answers
    expect(mixOf(blendFitMixes([a, b]))).toEqual({ Fold: 50, Call: 30, "Raise 7": 20 });
    expect(blendTaken([took(a, "Raise 7"), took(b, "Raise 7")])).toBeCloseTo(0.2, 9);
    expect(blendTaken([took(a, "Raise 9"), took(b, "Raise 9")])).toBe(0);
  });

  it("a fit that gives the hand no weight is left out; no fit, or no taken action, is 0", () => {
    const none = [{ action: "Fold", frequency: 0 }, { action: "Call", frequency: 0 }];
    expect(blendTaken([took(none, "Call"), took(keepSb, "Call")])).toBeCloseTo(0.7, 9);
    expect(blendTaken([])).toBe(0);
    expect(blendTaken([keepCo, keepSb])).toBe(0);
  });

  it("blendFitMixes is unchanged by the shared core (the answer's own blend)", () => {
    expect(mixOf(blendFitMixes([keepCo, keepSb]))).toEqual({ Fold: 60, Call: 30, "Raise 7": 10 });
    expect(mixOf(blendFitMixes([keepSb]))).toEqual({ Fold: 20, Call: 70, "Raise 7": 10 });
    // no passive action on any fit: fold and raise renormalised
    expect(mixOf(blendFitMixes([[{ action: "Fold", frequency: 0.6 }, { action: "Raise 7", frequency: 0.4 }], [{ action: "Fold", frequency: 0.2 }, { action: "Raise 7", frequency: 0.8 }]])))
      .toEqual({ Fold: 60, "Raise 7": 40 });
    expect(blendFitMixes([])).toEqual([]);
  });
});
