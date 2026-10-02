import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { arrivalTrust, nodeTrust, setTrustMap, TRUST_MAX_TOKENS } from "./nodeTrust";

/**
 * The trust guard on the limp trees (2026-10-02, the v2 limp re-solve): node_trust.py scores every decision node of a
 * limp tree up to 12 tokens, so on an `olimp` chart an absent chart or line is UNSCORED and refused (starved) — a fresh
 * tree must never answer unguarded. The raise charts keep the old reading: absent = no verdict.
 */
const POOL3 = "ign200_6max_D100_olimp_pool3";
const EQ = "ign200_6max_D100_olimp";
const RAISE = "ign200_6max_D100_o2_5";

const saved = process.env.TRUST_GUARD_ALL;
beforeEach(() => { delete process.env.TRUST_GUARD_ALL; });
afterEach(() => {
  setTrustMap(null);
  if (saved === undefined) delete process.env.TRUST_GUARD_ALL; else process.env.TRUST_GUARD_ALL = saved;
});

describe("nodeTrust — limp trees", () => {
  test("a limp chart absent from the trust map is refused, with the reason", () => {
    setTrustMap({ [EQ]: { "C": [0.03, 0.01] } });
    const t = nodeTrust(POOL3, "C-C-C-F-F");
    expect(t.starved).toBe(true);
    expect(t.known).toBe(false);
    expect(t.why).toContain("not in the trust map yet");
    expect(t.why).toContain("node_trust.py");
    // the uneven pool3 trees too
    expect(nodeTrust("ign200_6max_D100_s50_HJ_olimp_pool3", "C").starved).toBe(true);
  });

  test("a line absent from a scored limp chart is refused (unscored)", () => {
    setTrustMap({ [POOL3]: { "C": [0.03, 0.01] } });
    const t = nodeTrust(POOL3, "C-C-C-F-F");
    expect(t.starved).toBe(true);
    expect(t.why).toContain("UNSCORED CHART NODE");
  });

  test("a line past the 12 tokens node_trust.py scores is refused even if the map holds it", () => {
    const deep = Array.from({ length: TRUST_MAX_TOKENS + 1 }, (_, i) => (i % 2 ? "F" : "C")).join("-");
    const at12 = deep.split("-").slice(0, TRUST_MAX_TOKENS).join("-");
    setTrustMap({ [POOL3]: { [deep]: [0.01, 0.001], [at12]: [0.01, 0.001] } });
    expect(nodeTrust(POOL3, at12).starved).toBe(false);
    const t = nodeTrust(POOL3, deep);
    expect(t.starved).toBe(true);
    expect(t.why).toContain("past the 12");
  });

  test("scored nodes keep their verdicts: trusted, low reach, and (pool trees) only catastrophic regret", () => {
    setTrustMap({
      [POOL3]: { "": [1, 0.001], "F-F-C-C": [8.6e-4, 0.21], "F-F-C-C-C": [5e-6, 0.06], "C-R5": [0.002, 0.5] },
      [EQ]: { "F-F-C-C": [1e-4, 0.056] },
    });
    expect(nodeTrust(POOL3, "")).toMatchObject({ known: true, starved: false });
    expect(nodeTrust(POOL3, "F-F-C-C")).toMatchObject({ known: true, starved: false });     // a locked node's leak
    expect(nodeTrust(POOL3, "F-F-C-C-C").why).toContain("UNTRAINED CHART NODE");            // reach 1 in 200,000
    expect(nodeTrust(POOL3, "C-R5").starved).toBe(true);                                     // regret past 0.3
    expect(nodeTrust(EQ, "F-F-C-C").starved).toBe(true);                                     // equilibrium: regret > 0.03
  });
});

describe("nodeTrust — raise charts unchanged", () => {
  test("not guarded by default: no verdict, never starved", () => {
    setTrustMap({});
    expect(nodeTrust(RAISE, "F-F-R2.5")).toEqual({ known: false, reach: null, regret: null, starved: false, why: null });
  });

  test("under TRUST_GUARD_ALL=1 an absent chart or line is still 'no verdict' for a raise chart", () => {
    process.env.TRUST_GUARD_ALL = "1";
    setTrustMap({ [RAISE]: { "F": [0.9, 0.001], "F-F-R2.5-R9": [5e-5, 0.08] } });
    expect(nodeTrust(RAISE, "F-F-F").starved).toBe(false);
    expect(nodeTrust("ign200_6max_D100_o3", "F").starved).toBe(false);
    expect(nodeTrust(RAISE, "F-F-R2.5-R9").starved).toBe(true);                             // scored and starved
  });
});

describe("arrivalTrust — every decision node the flop ranges come from", () => {
  test("the first starved/unscored node on the line refuses; a fully trusted line passes", () => {
    setTrustMap({ [POOL3]: { "": [1, 0], "C": [0.036, 0.01], "C-C": [0.004, 0.01], "C-C-C": [3e-4, 0.01], "C-C-C-F": [2.9e-4, 0.01],
      "C-C-C-F-F": [5e-5, 0.02], "C-F": [0.035, 0.01], "C-F-F": [0.034, 0.01], "C-F-F-F": [0.033, 0.01], "C-F-F-F-F": [0.03, 0.01] } });
    const bad = arrivalTrust(POOL3, ["", "C", "C-C", "C-C-C", "C-C-C-F", "C-C-C-F-F"]);
    expect(bad?.line).toBe("C-C-C-F-F");
    expect(bad?.why).toContain("UNTRAINED CHART NODE");
    expect(arrivalTrust(POOL3, ["", "C", "C-F", "C-F-F", "C-F-F-F", "C-F-F-F-F"])).toBeNull();
    // a node the map does not hold refuses too
    expect(arrivalTrust(POOL3, ["", "C", "C-F-C"])?.line).toBe("C-F-C");
  });

  test("raise charts are never judged here, whatever TRUST_GUARD_ALL says", () => {
    process.env.TRUST_GUARD_ALL = "1";
    setTrustMap({ [RAISE]: { "F-F-R2.5-R9": [5e-5, 0.08] } });
    expect(arrivalTrust(RAISE, ["", "F", "F-F", "F-F-R2.5", "F-F-R2.5-R9"])).toBeNull();
  });
});
