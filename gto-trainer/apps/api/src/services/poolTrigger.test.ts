import { afterEach, describe, expect, test } from "bun:test";
import { classRangeOf, combosOfRange, groupShares, handGroup, klGroup, poolCiLower, shouldReplace, triggerParams, TRIGGER_DEFAULTS, wilsonLower, type TriggerInput } from "./poolTrigger";
import { COMBOS } from "../utils/comboIndex/comboIndex";

/**
 * THE ONE TRIGGER RULE (services/poolTrigger), with the numbers of the calibration (poker claude/trigger-rule,
 * analysis/pipeline/range_qa/trigger/trigger_rule.md §3.4 / §4 and trigger_summary.json's study nodes).
 */
const ENV = ["POOL_TRIGGER_K", "POOL_TRIGGER_DIVERGENCE", "POOL_TRIGGER_LINE_GUARD", "POOL_TRIGGER_ABS", "POOL_TRIGGER_KL", "POOL_TRIGGER_REACH"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

const pre = (x: Partial<TriggerInput>): TriggerInput => ({ fSolver: null, fPool: null, poolCI: null, groupKL: null, line: "preflop", reach: null, ...x });

describe("wilsonLower / poolCiLower", () => {
  test("the 95% lower bound", () => {
    expect(wilsonLower(278, 1056)).toBeCloseTo(0.23759, 4);     // limp_first_short_le60: 26.3% of 1,056 Ignition chances
    expect(wilsonLower(2, 9)).toBeCloseTo(0.06322, 4);          // a thin cell (overcall BTN ≤40bb, n = 9)
    expect(wilsonLower(0, 0)).toBeNaN();
  });
  test("the cell's own counts: (calls, chances) or the limp table's n limps at freq", () => {
    expect(poolCiLower({ calls: 278, chances: 1056 })).toBeCloseTo(0.23759, 4);
    expect(poolCiLower({ n: 50, freq: 0.45045 })).toBeCloseTo(0.36109, 4);   // sbcomplete_fold_short_le60: 50 completes
    expect(poolCiLower({})).toBeNull();
  });
});

describe("klGroup", () => {
  test("the same range is 0; a premium-heavy pool against a junk-heavy solver is large", () => {
    const r = { AA: 1, "72o": 0.5, KQs: 0.3 };
    expect(klGroup(r, r)).toBeCloseTo(0, 9);
    expect(klGroup({ AA: 1, KK: 1, QQ: 1 }, { "72o": 1, "83o": 1 })).toBeGreaterThan(3);
    expect(handGroup("A5s")).toBe("Axs");
    const g = groupShares({});
    expect(Object.values(g).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);    // an empty range: the deck's shares
  });
  test("classRangeOf: a per-combo strategy's class means", () => {
    const w = COMBOS.map((c) => (c.cls === "AKs" ? 1 : c.cls === "72o" ? 0.5 : 0));
    const r = classRangeOf(w);
    expect(r.AKs).toBe(1);
    expect(r["72o"]).toBe(0.5);
    expect(combosOfRange(r)).toBeCloseTo(4 + 6, 9);
  });
});

describe("shouldReplace — the calibration's cases", () => {
  test("RESIDUE: the 21.4bb BTN limps 0.12% on the plain tree (study node 1) — fires, no evidence needed", () => {
    const r = shouldReplace(pre({ fSolver: 0.0012095, fPool: 0.26326, poolCI: null, groupKL: null }));
    expect(r).toMatchObject({ fire: true, why: "residue" });
    expect(r.text).toContain("residue");
  });
  test("DIVERGENCE: the HJ 79.2bb limp at 5.55% vs the pool's 15.1% (Ignition 16.7% of 947) fires when the mix differs, not when it is the same", () => {
    const base = { fSolver: 0.0555, fPool: 0.15051, poolCI: wilsonLower(158, 947) };
    expect(shouldReplace(pre({ ...base, groupKL: 0.34 }))).toMatchObject({ fire: true, why: "divergence" });
    const same = shouldReplace(pre({ ...base, groupKL: 0.12 }));
    expect(same).toMatchObject({ fire: false, why: null });
    expect(same.text).toContain("same hand-group mix");
  });
  test("SB 52bb complete: ×2.9 but KL 0.12 — skipped (the 10-09 reversal as a number)", () => {
    expect(shouldReplace(pre({ fSolver: 0.154, fPool: 0.45045, poolCI: poolCiLower({ n: 50, freq: 0.45045 }), groupKL: 0.12 })).fire).toBe(false);
  });
  test("SB 77bb complete 17.7% vs 29.7% (×1.7) and the 24.8bb BTN limp 15.7% vs 26.3%: under k — skipped", () => {
    expect(shouldReplace(pre({ fSolver: 0.177, fPool: 0.29729, poolCI: 0.2, groupKL: 0.9 })).fire).toBe(false);
    expect(shouldReplace(pre({ fSolver: 0.157, fPool: 0.26326, poolCI: 0.237, groupKL: 0.9 })).fire).toBe(false);
  });
  test("the CO 76.2bb limp at 31.6% (the solver limps MORE than the pool's 15.1%): skipped", () => {
    const r = shouldReplace(pre({ fSolver: 0.316, fPool: 0.15051, poolCI: 0.13, groupKL: 1 }));
    expect(r.fire).toBe(false);
    expect(r.text).toContain("not under the pool's rate / 2");
  });
  test("a BB defend at 40% where the pool plays 45%: never (the BB-defend case of the flat floor)", () => {
    expect(shouldReplace(pre({ fSolver: 0.40, fPool: 0.45, poolCI: 0.44, groupKL: 0.5 })).fire).toBe(false);
  });
  test("BB 29bb vs CO: 16.2% vs 48.8% (Ignition 44.8%), Δ +1.69 — fires on divergence", () => {
    expect(shouldReplace(pre({ fSolver: 0.162, fPool: 0.488, poolCI: 0.40, groupKL: 0.8 }))).toMatchObject({ fire: true, why: "divergence" });
  });
  test("EVIDENCE: a thin cell (2 of 9) whose lower bound 6.3% does not exclude a 8% solver share — skipped", () => {
    const r = shouldReplace(pre({ fSolver: 0.08, fPool: 0.222, poolCI: wilsonLower(2, 9), groupKL: 1.2 }));
    expect(r.fire).toBe(false);
    expect(r.text).toContain("does not exclude");
    // no counts at all: no evidence, no divergence firing (the residue arm needs none)
    expect(shouldReplace(pre({ fSolver: 0.08, fPool: 0.3, poolCI: null, groupKL: 1.2 })).fire).toBe(false);
  });
  test("an unknown shape (no solver range on record): the KL test is skipped, as the calibration did", () => {
    expect(shouldReplace(pre({ fSolver: 0.05, fPool: 0.26, poolCI: 0.23, groupKL: null })).why).toBe("divergence");
  });
  test("LINE GUARD: a limp-caller whose preflop line leaves 0.5% of his hands — fires preflop, never postflop", () => {
    expect(shouldReplace(pre({ fSolver: 0.5, fPool: 0.7, poolCI: 0.6, reach: 0.005 }))).toMatchObject({ fire: true, why: "line-guard" });
    expect(shouldReplace(pre({ fSolver: 0.5, fPool: 0.7, poolCI: 0.6, reach: 0.005, line: "postflop" })).fire).toBe(false);
    // reach exactly at 1%: not under it
    expect(shouldReplace(pre({ fSolver: 0.5, reach: 0.01 })).fire).toBe(false);
  });
  test("no share, no pool: nothing fires (bar the line guard)", () => {
    expect(shouldReplace(pre({})).fire).toBe(false);
    expect(shouldReplace(pre({ fSolver: 0.05 })).text).toContain("no pool cell");
  });
});

describe("the switches, read at every call", () => {
  test("defaults", () => {
    expect(triggerParams()).toEqual(TRIGGER_DEFAULTS);
  });
  test("POOL_TRIGGER_K: k = 3 skips a 2.7x divergence that k = 2 fires", () => {
    const x = pre({ fSolver: 0.0555, fPool: 0.15051, poolCI: 0.14, groupKL: 0.5 });
    expect(shouldReplace(x).fire).toBe(true);
    process.env.POOL_TRIGGER_K = "3";
    expect(shouldReplace(x).fire).toBe(false);
    process.env.POOL_TRIGGER_K = "junk";
    expect(triggerParams().k).toBe(2);
  });
  test("POOL_TRIGGER_DIVERGENCE=off: residue and the line guard only", () => {
    process.env.POOL_TRIGGER_DIVERGENCE = "off";
    expect(shouldReplace(pre({ fSolver: 0.0555, fPool: 0.15051, poolCI: 0.14, groupKL: 0.5 })).fire).toBe(false);
    expect(shouldReplace(pre({ fSolver: 0.001, fPool: 0.15 })).why).toBe("residue");
    expect(shouldReplace(pre({ fSolver: 0.3, reach: 0.002 })).why).toBe("line-guard");
  });
  test("POOL_TRIGGER_LINE_GUARD=off", () => {
    process.env.POOL_TRIGGER_LINE_GUARD = "off";
    expect(shouldReplace(pre({ fSolver: 0.3, reach: 0.002 })).fire).toBe(false);
  });
});
