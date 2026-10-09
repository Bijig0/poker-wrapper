import { afterEach, describe, expect, test } from "bun:test";
import {
  SB_FLAT_CI_MIN_CHANCES, SB_FLAT_MIN_HANDS, sbFlatBand, sbFlatEvidence, sbFlatKey, sbFlatOwnFactorOn, sbFlatRange, sbFlatSize, sbFlatSizeOfQual,
  sbFlatTable, sbFlatTableMode, sbFlatVband, sbFlatVpip, sbFlatVpipText,
} from "./poolSbFlat";
import { wilsonLower } from "./poolTrigger";

/**
 * THE SB-FLAT TABLE v2 (services/poolSbFlat, 2026-10-10): the shipped table (poker a0692acb sbflat_ranges.json) and the
 * port of the builder's reference lookup live_key(). The reference samples below are live_key()'s OWN outputs: its
 * source exec'd verbatim (build_sbflat_ranges.py @ a0692acb) with the table's lookup as its globals, on Ignition SB
 * rows (sbflat_ignition_events.json: stack, opener, raise-to, the before-the-hand n / v) plus the edges. The same run
 * over all 10,901 scanned rows agreed with sbFlatKey on every one (2026-10-10).
 */
afterEach(() => { delete process.env.SB_FLAT_TABLE; delete process.env.SB_FLAT_OWN_FACTOR; });

/** [stack, opener, raise-to, n, v, live_key()] */
const REFERENCE: [number | null, string | null, number | null, number | null, number | null, string][] = [
  [64.3, "CO", 2.5, 20, 5, "poolcall_flat_SB_vsCO_oM_le75_v30"],
  [87.5, "BTN", 2.0, 33, 21, "poolcall_flat_SB_vsBTN_oS_75_90_v40p"],
  [63.4, "CO", 2.0, 37, 11, "poolcall_flat_SB_vsCO_oS_le75_v30"],
  [56.5, "UTG", 3.0, 51, 10, "poolcall_flat_SB_vsUTG_oL_le75_v30"],
  [13.2, "BTN", 3.5, 33, 16, "poolcall_flat_SB_vsBTN_oL_le75_v30_40"],
  [87.6, "BTN", 2.5, 91, 36, "poolcall_flat_SB_vsBTN_oM_75_90_v30_40"],
  [56.5, "HJ", 2.3, 100, 22, "poolcall_flat_SB_vsHJ_oM_le75_v30"],
  [280.8, "BTN", 2.5, 63, 25, "poolcall_flat_SB_vsBTN_oM_90p_v30_40"],
  [78.7, "CO", 2.0, 53, 38, "poolcall_flat_SB_vsCO_oS_75_90_v40p"],
  [112.0, "HJ", 2.0, 34, 13, "poolcall_flat_SB_vsHJ_oS_90p_v30_40"],
  [26.5, "BTN", 5.5, 25, 16, "poolcall_flat_SB_vsBTN_oL_le75_v40p"],
  [75.2, "HJ", 2.5, 25, 16, "poolcall_flat_SB_vsHJ_oM_75_90_v40p"],
  [92.2, "CO", 2.5, 3, 2, "poolcall_flat_SB_vsCO_oM_80_98"],
  [101.4, "BTN", 3.0, 0, 0, "poolcall_flat_SB_vsBTN_oL_98_110"],
  [18.1, "BTN", 2.5, 4, 3, "poolcall_flat_SB_vsBTN_oM_le25"],
  [60.5, "UTG", 3.5, 0, 0, "poolcall_flat_SB_vsUTG_oL_25_65"],
  [23.4, "HJ", 2.0, 7, 2, "poolcall_flat_SB_vsHJ_oS_le25"],
  [70.3, "BTN", 2.5, 16, 6, "poolcall_flat_SB_vsBTN_oM_65_80"],
  [214.8, "CO", 2.0, 0, 0, "poolcall_flat_SB_vsCO_oS_110p"],
  [88.9, "UTG", 2.0, 8, 1, "poolcall_flat_SB_vsUTG_oS_80_98"],
  [213.2, "UTG", 3.0, 5, 1, "poolcall_flat_SB_vsUTG_oL_110p"],
  [83.0, "BTN", 3.5, 4, 2, "poolcall_flat_SB_vsBTN_oL_80_98"],
  [25.0, "BTN", 2.25, 0, 0, "poolcall_flat_SB_vsBTN_oM_25_65"],
  [24.99, "UTG", 2.2499, 19, 19, "poolcall_flat_SB_vsUTG_oS_le25"],
  [98.0, "CO", 2.75, 20, 1, "poolcall_flat_SB_vsCO_oL_90p_v30"],
  [97.9, "HJ", 2.7499, 20, 14, "poolcall_flat_SB_vsHJ_oM_90p_v40p"],
  [110.0, "BTN", 3.55, 100, 30, "poolcall_flat_SB_vsBTN_oL_90p_v30"],
  [75.0, "CO", 3.0, 40, 12, "poolcall_flat_SB_vsCO_oL_75_90_v30"],
  [74.9, "CO", 3.0, 40, 13, "poolcall_flat_SB_vsCO_oL_le75_v30_40"],
  [90.0, "UTG", 2.5, 60, 21, "poolcall_flat_SB_vsUTG_oM_90p_v30_40"],
  [65.0, null, 2.5, null, null, "poolcall_flat_SB_oM_65_80"],
  [80.0, "HJ", null, null, null, "poolcall_flat_SB_vsHJ_80_98"],
  [null, "BTN", 2.5, null, null, "poolcall_flat_SB_vsBTN_oM"],
  [null, null, null, 25, 20, "poolcall_flat_SB_v40p"],
  [150.0, null, null, 30, 3, "poolcall_flat_SB_90p_v30"],
  [12.0, "BTN", 5.0, 22, 9, "poolcall_flat_SB_vsBTN_oL_le75_v30_40"]
];

const P = (p: string) => `poolcall_flat_SB_${p}`;

describe("the bucketers (lookup.bucketers, lo ≤ x < hi)", () => {
  test("band: le25 / 25_65 / 65_80 / 80_98 / 98_110 / 110p on the stack as dealt", () => {
    expect([0.1, 24.99, 25, 64.99, 65, 79.99, 80, 97.99, 98, 109.99, 110, 400].map(sbFlatBand))
      .toEqual(["le25", "le25", "25_65", "25_65", "65_80", "65_80", "80_98", "80_98", "98_110", "98_110", "110p", "110p"]);
    expect([0, -5, NaN, null, undefined].map(sbFlatBand)).toEqual([null, null, null, null, null]);
  });
  test("vband (the VPIP keys' own): le75 / 75_90 / 90p", () => {
    expect([10, 74.99, 75, 89.99, 90, 250].map(sbFlatVband)).toEqual(["le75", "le75", "75_90", "75_90", "90p", "90p"]);
  });
  test("size: oS [0, 2.25) oM [2.25, 2.75) oL [2.75, ∞); the call table's oXL → oL", () => {
    expect([2, 2.2499, 2.25, 2.7499, 2.75, 3.55, 9].map(sbFlatSize)).toEqual(["oS", "oS", "oM", "oM", "oL", "oL", "oL"]);
    expect([0, null, NaN].map(sbFlatSize)).toEqual([null, null, null]);
    expect(["oS", "oM", "oL", "oXL", "oZ", null].map(sbFlatSizeOfQual)).toEqual(["oS", "oM", "oL", "oL", null, null]);
  });
  test("vpip: known with 20 hands; (v + 28.18 × 0.28) / (n + 28.18); v30 < 0.30 ≤ v30_40 < 0.40 ≤ v40p", () => {
    expect(SB_FLAT_MIN_HANDS).toBe(20);
    expect(sbFlatVpip(19, 19)!.known).toBe(false);
    expect(sbFlatVpip(19, 19)!.code).toBeNull();
    const v = sbFlatVpip(20, 6)!;
    expect(v.known).toBe(true);
    expect(v.est).toBeCloseTo((6 + 28.18 * 0.28) / (20 + 28.18), 12);
    expect(v.code).toBe("v30");
    // the edges: (v + 7.89) / (n + 28.18) ≥ 0.30 → v30_40, ≥ 0.40 → v40p
    expect(sbFlatVpip(100, 30)!.code).toBe("v30");      // 37.89 / 128.18 = 0.2956
    expect(sbFlatVpip(100, 31)!.code).toBe("v30_40");   // 0.3034
    expect(sbFlatVpip(100, 43)!.code).toBe("v30_40");   // 0.3970
    expect(sbFlatVpip(100, 44)!.code).toBe("v40p");     // 0.4048
    expect(sbFlatVpip(null, 3)).toBeNull();
  });
});

describe("the chains (lookup.chain, in order)", () => {
  test("the table's chains are the ones the port was written for", () => {
    const u = ["vs{opener}_{size}_{band}", "{size}_{band}", "vs{opener}_{band}", "{band}", "vs{opener}_{size}", "{size}", "vs{opener}", "all"].map(P);
    const k = ["vs{opener}_{size}_{vband}_{vpip}", "{size}_{vband}_{vpip}", "vs{opener}_{vband}_{vpip}", "{vband}_{vpip}", "vs{opener}_{size}_{vpip}", "{size}_{vpip}", "vs{opener}_{vpip}", "{vpip}"].map(P);
    expect(sbFlatTable().lookup.chain.vpip_unknown).toEqual(u);
    expect(sbFlatTable().lookup.chain.vpip_known).toEqual([...k, ...u]);
  });
  test("each step taken in order as the inputs go missing", () => {
    const seen = { n: 50, v: 10 };
    const steps = (ctx: Parameters<typeof sbFlatKey>[0]) => { const r = sbFlatKey(ctx); return [r.key, r.chain, r.step]; };
    expect(steps({ opener: "CO", openTo: 2.5, stack: 100, seen })).toEqual([P("vsCO_oM_90p_v30"), "vpip_known", 0]);
    expect(steps({ openTo: 2.5, stack: 100, seen })).toEqual([P("oM_90p_v30"), "vpip_known", 1]);
    expect(steps({ opener: "CO", stack: 100, seen })).toEqual([P("vsCO_90p_v30"), "vpip_known", 2]);
    expect(steps({ stack: 100, seen })).toEqual([P("90p_v30"), "vpip_known", 3]);
    expect(steps({ opener: "CO", openTo: 2.5, seen })).toEqual([P("vsCO_oM_v30"), "vpip_known", 4]);
    expect(steps({ openTo: 2.5, seen })).toEqual([P("oM_v30"), "vpip_known", 5]);
    expect(steps({ opener: "CO", seen })).toEqual([P("vsCO_v30"), "vpip_known", 6]);
    expect(steps({ seen })).toEqual([P("v30"), "vpip_known", 7]);
    const few = { n: 12, v: 3 };
    expect(steps({ opener: "BTN", openTo: 3, stack: 40, seen: few })).toEqual([P("vsBTN_oL_25_65"), "vpip_unknown", 0]);
    expect(steps({ openTo: 3, stack: 40 })).toEqual([P("oL_25_65"), "vpip_unknown", 1]);
    expect(steps({ opener: "BTN", stack: 40 })).toEqual([P("vsBTN_25_65"), "vpip_unknown", 2]);
    expect(steps({ stack: 40 })).toEqual([P("25_65"), "vpip_unknown", 3]);
    expect(steps({ opener: "BTN", openTo: 3 })).toEqual([P("vsBTN_oL"), "vpip_unknown", 4]);
    expect(steps({ openTo: 3 })).toEqual([P("oL"), "vpip_unknown", 5]);
    expect(steps({ opener: "BTN" })).toEqual([P("vsBTN"), "vpip_unknown", 6]);
    expect(steps({})).toEqual([P("all"), "vpip_unknown", 7]);
    expect(steps({ opener: "SB", openTo: -1, stack: NaN })).toEqual([P("all"), "vpip_unknown", 7]);   // not a 6-max opener: unknown
  });
  test("every pattern of every chain resolves for every value (the builder's 12,096 fills)", () => {
    const t = sbFlatTable(), b = t.lookup.bucketers;
    let n = 0;
    const missing: string[] = [];
    for (const opener of b.opener.labels) for (const size of Object.keys(b.size.edges)) for (const band of b.band.labels) {
      for (const vband of b.vband.labels) for (const vpip of [undefined, "v30", "v30_40", "v40p"]) {
        const d: Record<string, string | undefined> = { opener, size, band, vband, vpip };
        for (const p of vpip ? t.lookup.chain.vpip_known : t.lookup.chain.vpip_unknown) {
          const k = p.replace(/\{(\w+)\}/g, (_m, x: string) => d[x]!);
          n++;
          if (!(k in t.ranges)) missing.push(k);
        }
      }
    }
    expect(n).toBe(12096);
    expect(missing).toEqual([]);
  });
});

describe("sbFlatKey = the builder's live_key()", () => {
  test.each(REFERENCE)("stack %p, %p opens to %p, n %p v %p → %s", (stack, opener, openTo, n, v, key) => {
    expect(sbFlatKey({ stack, opener, openTo, seen: n == null ? null : { n, v: v ?? 0 } }).key).toBe(key);
  });
});

describe("the table and its ranges", () => {
  test("380 keys; Ignition counts (shown ≤ calls ≤ chances); NL200 freq = pooled × 0.894 off the VPIP keys, = pooled on them", () => {
    const t = sbFlatTable();
    expect(Object.keys(t.ranges).length).toBe(380);
    expect(t.nl200_factor).toBe(0.894);
    expect(t.own_nl200_factor).toBe(0.765);
    for (const [k, c] of Object.entries(t.ranges)) {
      expect(k.startsWith("poolcall_flat_SB_")).toBe(true);
      expect(c.shown <= c.calls && c.calls <= c.chances).toBe(true);
      if (c.vpip == null) expect(Math.abs(c.freq - c.freq_pooled * 0.894)).toBeLessThan(2e-4);
      else expect(c.freq).toBe(c.freq_pooled);
    }
    expect([t.ranges[P("all")]!.calls, t.ranges[P("all")]!.chances]).toEqual([1109, 10845]);
  });
  test("sbFlatRange: the cell's weights, NL200 freq and its IGNITION counts (not CoinPoker's)", () => {
    const r = sbFlatRange(P("vsCO_oM_90p_v30"))!;
    expect([r.freq, r.calls, r.chances, r.own]).toEqual([0.05194, 27, 525, false]);
    expect(r.weights).toEqual(sbFlatTable().ranges[P("vsCO_oM_90p_v30")]!.weights);
    expect(sbFlatRange(P("nope"))).toBeNull();
  });
  test("SB_FLAT_OWN_FACTOR=on: freq_pooled × 0.765 on a key without a vpip, the weights re-water-filled to it; VPIP keys unchanged", () => {
    const k = P("vsBTN_oM_98_110");
    const base = sbFlatRange(k)!;
    expect(sbFlatOwnFactorOn()).toBe(false);
    process.env.SB_FLAT_OWN_FACTOR = "on";
    expect(sbFlatOwnFactorOn()).toBe(true);
    const own = sbFlatRange(k)!;
    const cell = sbFlatTable().ranges[k]!;
    expect(own.own).toBe(true);
    expect(own.freq).toBeCloseTo(cell.freq_pooled * 0.765, 12);
    const combos = (w: Record<string, number>) => Object.entries(w).reduce((s, [c, x]) => s + x * (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12), 0);
    expect(combos(own.weights) / 1326).toBeCloseTo(own.freq, 6);
    expect(combos(own.weights)).toBeLessThan(combos(base.weights));
    expect(Math.max(...Object.values(own.weights))).toBeLessThanOrEqual(1);
    expect(sbFlatRange(k)!.weights).toEqual(own.weights);                 // deterministic (the oracle rebuilds it)
    expect(sbFlatRange(P("vsCO_oM_90p_v30"))!.own).toBe(false);          // a VPIP key: no stake factor to replace
    expect(sbFlatRange(k, { own: false })!.freq).toBe(base.freq);
  });
  test("the switch: off unless SB_FLAT_TABLE=v2", () => {
    expect(sbFlatTableMode()).toBe("off");
    process.env.SB_FLAT_TABLE = "v2";
    expect(sbFlatTableMode()).toBe("v2");
    process.env.SB_FLAT_TABLE = "on";
    expect(sbFlatTableMode()).toBe("off");
  });
  test("the vpip text", () => {
    expect(sbFlatVpipText(sbFlatKey({ seen: { n: 45, v: 10 } }))).toBe("vpip v30 (n=45, v=10, 24.4%)");
    expect(sbFlatVpipText(sbFlatKey({ seen: { n: 12, v: 3 } }))).toBe("vpip unknown (n=12)");
    expect(sbFlatVpipText(sbFlatKey({}))).toBe("vpip unknown (no seat history)");
  });
});

describe("THE EVIDENCE BOUND (sbFlatEvidence — the review's P1 / P2)", () => {
  test("P1: the pooled NL100+NL200 Wilson bound scaled to the served NL200 rate (× 0.894 off the VPIP keys, × 1 on them, × 0.765 / pooled under the own factor)", () => {
    const k = sbFlatKey({ opener: "BTN", openTo: 2.5, stack: 35 });
    expect(k.key).toBe(P("vsBTN_oM_25_65"));
    const c = sbFlatTable().ranges[k.key]!;
    expect([c.calls, c.chances]).toEqual([51, 131]);
    const ev = sbFlatEvidence(k);
    expect(ev).toMatchObject({ key: k.key, calls: 51, chances: 131, borrowed: false });
    expect(ev.scale).toBeCloseTo(c.freq / c.freq_pooled, 12);
    expect(ev.scale).toBeCloseTo(0.894, 3);
    expect(ev.ci!).toBeCloseTo(wilsonLower(51, 131) * c.freq / c.freq_pooled, 12);
    expect(ev.ci!).toBeLessThan(wilsonLower(51, 131));                     // ~11% lower than the unscaled bound
    // a VPIP key: no stake factor, the bound as it is
    const v = sbFlatKey({ opener: "CO", openTo: 2.5, stack: 98, seen: { n: 20, v: 1 } });
    const cv = sbFlatTable().ranges[v.key]!;
    expect(cv.vpip).not.toBeNull();
    expect(sbFlatEvidence(v).scale).toBe(1);
    expect(sbFlatEvidence(v).ci!).toBeCloseTo(wilsonLower(cv.calls, cv.chances), 12);
    // the own factor: the bound follows the served rate
    process.env.SB_FLAT_OWN_FACTOR = "on";
    expect(sbFlatEvidence(k).scale).toBeCloseTo(0.765, 12);
    expect(sbFlatEvidence(k, { own: false }).scale).toBeCloseTo(c.freq / c.freq_pooled, 12);
  });
  test("P2: a cell with 0 Ignition chances (vsUTG_oS_le75_v40p) borrows the bound of the first key after it in its chain with ≥ 20 chances", () => {
    const k = sbFlatKey({ opener: "UTG", openTo: 2.0, stack: 60, seen: { n: 30, v: 25 } });
    expect(k.key).toBe(P("vsUTG_oS_le75_v40p"));
    expect(sbFlatTable().ranges[k.key]!.chances).toBe(0);
    const ev = sbFlatEvidence(k);
    // skipped: oS_le75_v40p (9 chances), vsUTG_le75_v40p (6) — taken: le75_v40p (29 of 47)
    expect(ev).toMatchObject({ key: P("le75_v40p"), calls: 29, chances: 47, borrowed: true, scale: 1 });
    expect(ev.ci!).toBeCloseTo(wilsonLower(29, 47), 12);
    // the rule, on every 0-chance key the chains can reach: the first later key with ≥ 20 chances
    const t = sbFlatTable();
    let zero = 0;
    for (const [key, c] of Object.entries(t.ranges)) {
      if (c.chances > 0) continue;
      zero++;
      const chain = t.lookup.chain.vpip_known;
      const fields = { opener: c.opener ?? undefined, size: c.size ?? undefined, vband: c.band ?? undefined, vpip: c.vpip ?? undefined } as Record<string, string | undefined>;
      const step = chain.findIndex((p) => p.replace(/\{(\w+)\}/g, (_m, f: string) => fields[f] ?? "?") === key);
      expect(step).toBe(0);
      const e = sbFlatEvidence({ key, chain: "vpip_known", step, fields });
      expect(e.borrowed).toBe(true);
      expect(e.chances).toBeGreaterThanOrEqual(SB_FLAT_CI_MIN_CHANCES);
      expect(e.ci).not.toBeNull();
    }
    expect(zero).toBe(6);
  });
  test("a key not in the table: no bound", () => {
    expect(sbFlatEvidence({ key: P("nope"), chain: "vpip_unknown", step: 0, fields: {} })).toMatchObject({ ci: null, borrowed: false });
  });
});
