/**
 * THE RESIDUE GATE (2026-10-13, services/residueGate) — hermetic half. The calibration case is hand 4923399329 (answers
 * row 13446): HJ AhTh opened 2.5 on ign200_6max_D50_o2_5, the CO 3-bet to 9.2, the walk read it at R9 — 0.14% of the
 * CO's range while his 3-bets sit on R7.5 at 8.18%. The nodes are the factory bake's own (__fixtures__, read 2026-10-13).
 * The bake-backed half (the real answer path, log / live / fallback / stickiness) is fastSolve.residueGate.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actionType, chartLineShares, memoNodes, residueGateMode, residueHits, residueVerdict, type ResidueMark } from "./residueGate";
import { gapText, residueReasons, residueRouted, routingReasons, treeGap6 } from "./treeGap";
import { unsafeReasons, UNSAFE_CODES } from "./unsafeAnswer";
import { scoreChartLine } from "./fastSolve";
import { classifyPath } from "./chainPath";
import type { HrcNode } from "./hrc3max";

const FX = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "residueD50o25_13446.json"), "utf8")) as { chart: string; nodes: Record<string, HrcNode> };
let reads = 0;
const get = async (line: string): Promise<HrcNode | null> => { reads++; return FX.nodes[line] ?? null; };
const LINE = "F-R2.5-R9-F-F-F";   // UTG folds, HJ (hero) opens 2.5, CO 3-bets (read at R9), BTN / SB / BB fold
const heroMix = (cls: string) => Object.entries(FX.nodes[LINE]!.cells.find((c) => c.hand === cls)!.actions).map(([action, frequency]) => ({ action, frequency }));
const fold = (cls: string) => heroMix(cls).find((x) => x.action === "Fold")?.frequency ?? 0;

describe("chartLineShares: every action on hero's line against the range its player takes it with", () => {
  it("hand 13446: the CO's R9 is 0.14% of his range, his 3-bets (non-all-in raises) 8.32% — the rule fires on it alone", async () => {
    const r = await chartLineShares(get, LINE, "HJ", { forcedFolds: true });
    if (!("lines" in r)) throw new Error(r.na);
    const co = r.lines.find((l) => l.seat === "CO")!;
    expect(co.code).toBe("R9");
    expect(co.type).toBe("raise");
    expect(co.nodeFreq).toBeCloseTo(0.00141, 4);
    expect(co.typeFreq).toBeCloseTo(0.0832, 3);
    const hj = r.lines.find((l) => l.seat === "HJ")!;
    expect(hj.hero).toBe(true);
    expect(hj.nodeFreq).toBeCloseTo(0.2249, 3);
    expect(residueHits(r.lines).map((l) => `${l.seat} ${l.code}`)).toEqual(["CO R9"]);
  });

  it("a snapped size the villain uses commonly does not fire (the CO's 3-bet read at R7.5, 8.18%)", async () => {
    const r = await chartLineShares(get, "F-R2.5-R7.5", "HJ");
    if (!("lines" in r)) throw new Error(r.na);
    expect(r.lines.find((l) => l.seat === "CO")!.nodeFreq).toBeCloseTo(0.0818, 3);
    expect(residueHits(r.lines)).toEqual([]);
  });

  it("a rare ACTION (a cold call / limp, a < 1%) is not this rule: the BTN's cold call of the 3-bet, 0.91% of his range", async () => {
    const r = await chartLineShares(get, "F-R2.5-R9-C", "SB");
    if (!("lines" in r)) throw new Error(r.na);
    const btn = r.lines.find((l) => l.seat === "BTN")!;
    expect(btn.type).toBe("call");
    expect(btn.nodeFreq).toBeLessThan(0.01);
    expect(btn.typeFreq).toBe(btn.nodeFreq);        // a call is its own type: a = s, never 5·s
    expect(residueHits(r.lines).map((l) => l.seat)).toEqual(["CO"]);   // only the CO's leftover size
  });

  it("an all-in counts with the raises only when the all-in is the token taken (the CO's 50bb jam, 0.001%)", async () => {
    const r = await chartLineShares(get, "F-R2.5-R50", "HJ");
    if (!("lines" in r)) throw new Error(r.na);
    const co = r.lines.find((l) => l.seat === "CO")!;
    expect(co.type).toBe("allin");
    expect(co.nodeFreq).toBeLessThan(0.0001);
    expect(co.typeFreq).toBeCloseTo(0.0832, 3);     // R7.5 + R9 + the jam
    expect(residueHits(r.lines).map((l) => l.code)).toEqual(["R50"]);
  });

  it("hero's own earlier rare size fires: hero is the CO who 3-bet at R9, facing the HJ's jam", async () => {
    const r = await chartLineShares(get, `${LINE}-R50`, "CO");
    if (!("lines" in r)) throw new Error(r.na);
    const hits = residueHits(r.lines);
    expect(hits.map((l) => `${l.seat} ${l.code} ${l.hero}`)).toEqual(["CO R9 true"]);
    // the HJ's jam is read on his OWN range after his open (rebuilt, not the bake's reach ratio): a common action
    const hjJam = r.lines.find((l) => l.seat === "HJ" && l.code === "R50")!;
    expect(hjJam.nodeFreq).toBeGreaterThan(0.1);
  });

  it("check #3's scorer is a view of the same walk, unchanged: villains only, no folds, no forced-fold stepping", async () => {
    const v = await scoreChartLine(get, LINE, "HJ");
    if (!("lines" in v)) throw new Error(v.na);
    expect(v.lines.map((l) => `${l.seat} ${l.code}`)).toEqual(["CO R9"]);
    expect(v.lines[0]!.nodeFreq).toBeCloseTo(0.00141, 4);
    expect(v.lines[0]!.offTree).toBe(false);
    const missing = await scoreChartLine(async (l) => (l === "C" ? null : FX.nodes[l] ?? null), "C-F", null);
    expect("na" in missing).toBe(true);
  });

  it("a forced fold (no node, a fold in the line) is stepped over only when asked", async () => {
    const n = (pos: string, acts: [string, string][], cells: Record<string, Record<string, number>>): HrcNode =>
      ({ pos, terminal: false, actions: acts.map(([action, token]) => ({ action, token })), cells: Object.entries(cells).map(([hand, actions]) => ({ hand, actions })) });
    const tree: Record<string, HrcNode> = {
      "": n("UTG", [["Fold", "F"], ["Raise 2.5", "R2.5"], ["Raise 3", "R3"]], { AA: { "Raise 2.5": 100 }, "72o": { Fold: 99.5, "Raise 3": 0.5 } }),
      "R3": n("HJ", [["Fold", "F"], ["Call", "C"]], { AA: { Call: 100 } }),
      "R3-C-F": n("BTN", [["Fold", "F"], ["Call", "C"]], { AA: { Fold: 100 } }),
    };
    const g = async (l: string) => tree[l] ?? null;
    const without = await chartLineShares(g, "R3-C-F-F", "BTN");
    expect("na" in without).toBe(true);
    const withF = await chartLineShares(g, "R3-C-F-F", "BTN", { forcedFolds: true });
    if (!("lines" in withF)) throw new Error(withF.na);
    expect(withF.lines.map((l) => `${l.seat} ${l.code}`)).toEqual(["UTG R3", "HJ C", "BTN F"]);
    // UTG's R3: 0.5% of 72o's 12 combos over 18 = 0.33% of his range; raises 33.6% (AA's R2.5 6 + 0.06) → fires
    expect(residueHits(withF.lines).map((l) => l.code)).toEqual(["R3"]);
  });

  it("actionType: by token, the label telling an all-in from a raise", () => {
    expect(actionType({ action: "Fold", token: "F" })).toBe("fold");
    expect(actionType({ action: "Call", token: "C" })).toBe("call");
    expect(actionType({ action: "Check", token: "X" })).toBe("check");
    expect(actionType({ action: "Raise 9", token: "R9" })).toBe("raise");
    expect(actionType({ action: "All-in", token: "R50" })).toBe("allin");
  });

  it("memoNodes: the walk's nodes are read once", async () => {
    reads = 0;
    const m = memoNodes(get);
    await chartLineShares(m, LINE, "HJ");
    const first = reads;
    await chartLineShares(m, LINE, "HJ");
    expect(reads).toBe(first);
  });
});

describe("residueVerdict: the switch, the Fold exemption, stickiness", () => {
  it("PREFLOP_RESIDUE_GATE: log by default; live and off as set; anything else is log", () => {
    const was = process.env.PREFLOP_RESIDUE_GATE;
    try {
      delete process.env.PREFLOP_RESIDUE_GATE; expect(residueGateMode()).toBe("log");
      process.env.PREFLOP_RESIDUE_GATE = "LIVE"; expect(residueGateMode()).toBe("live");
      process.env.PREFLOP_RESIDUE_GATE = "off"; expect(residueGateMode()).toBe("off");
      process.env.PREFLOP_RESIDUE_GATE = "on"; expect(residueGateMode()).toBe("log");
    } finally { if (was == null) delete process.env.PREFLOP_RESIDUE_GATE; else process.env.PREFLOP_RESIDUE_GATE = was; }
  });

  it("13446's own hand, AhTh, folds 99.77% at hero's node: detected, EXEMPT, not routed", async () => {
    const shares = await chartLineShares(get, LINE, "HJ", { forcedFolds: true });
    expect(fold("ATs")).toBeCloseTo(99.77, 2);
    const v = residueVerdict({ mode: "live", shares, heroFold: fold("ATs") });
    expect(v.hits.map((h) => h.seat)).toEqual(["CO"]);
    expect(v.exempt).toBe("fold");
    expect(v.fire).toBe(false);
    expect(residueReasons(v)).toEqual([]);
  });

  it("the same line with AQs (Call 64 / All-in 35): fires, and under live it is a gap-gate reason with its sentence", async () => {
    const shares = await chartLineShares(get, LINE, "HJ", { forcedFolds: true });
    const v = residueVerdict({ mode: "live", shares, heroFold: fold("AQs") });
    expect(v.fire).toBe(true);
    const rs = residueReasons(v);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.rule).toBe("residue");
    expect(rs[0]!.ratio).toBeCloseTo(0.00141, 4);
    expect(gapText(rs)).toContain(`the CO's Raise 9 at "F-R2.5" is 0.14% of his range while his raises are 8.32%`);
    // log: recorded, never a reason
    expect(residueReasons(residueVerdict({ mode: "log", shares, heroFold: fold("AQs") }))).toEqual([]);
  });

  it("a later decision of a hand the rule routed is routed again, the Fold exemption aside (the hand stays on one tree)", () => {
    const mark: ResidueMark = { at: 9, rawTokens: LINE.split("-"), chart: FX.chart, seat: "CO", code: "R9", line: "F-R2.5", s: 0.0014, a: 0.083 };
    const v = residueVerdict({ mode: "live", shares: { lines: [] }, heroFold: 100, sticky: mark });
    expect(v.fire).toBe(true);
    expect(v.exempt).toBeUndefined();
    const rs = residueReasons(v);
    expect(rs.map((r) => r.why)).toEqual(["sticky"]);
    expect(rs[0]!.what).toContain("an earlier decision of this hand was routed");
  });
});

describe("treeGap6 with the residue verdict: routes only under its own switch", () => {
  const byPos = { UTG: 50, HJ: 46, CO: 50, BTN: 50, SB: 50, BB: 50 };
  const base = { chartId: "ign200_6max_D50_o2_5", byPos, hero: "HJ", folded: new Set(["UTG", "BTN", "SB", "BB"]), aggressor: "CO", after: [] as string[],
    rawTokens: ["F", "R2.5", "R9.2", "F", "F", "F"] };
  const shares = { lines: [{ seat: "CO", code: "R9", label: "Raise 9", line: "F-R2.5", hero: false, type: "raise" as const, nodeFreq: 0.0014, typeFreq: 0.083, maxHand: 0.5 }] };

  it("residue live + gap gate live: the residue reason routes; the record rides on treeGap.residue", () => {
    const g = treeGap6({ ...base, mode: "live", residue: residueVerdict({ mode: "live", shares, heroFold: 0 }) })!;
    expect(g.gate.route).toBe(true);
    expect(g.residue?.fire).toBe(true);
    expect(routingReasons(g).map((r) => r.rule)).toEqual(["residue"]);
    expect(residueRouted(g)).toBe(true);
  });
  it("residue log: recorded, nothing routes (the chart answers exactly as before)", () => {
    const g = treeGap6({ ...base, mode: "live", residue: residueVerdict({ mode: "log", shares, heroFold: 0 }) })!;
    expect(g.gate.route).toBe(false);
    expect(g.residue?.mode).toBe("log");
    expect(g.residue?.fire).toBe(true);
    expect(routingReasons(g)).toEqual([]);
  });
  it("residue live under PREFLOP_GAP_GATE=log: the residue reason still routes, a size bound does not", () => {
    const g = treeGap6({ ...base, mode: "log", repaired: [{ index: 2, from: "R12", to: "R9", logDist: Math.log(12 / 9) }], fitted: ["F", "R2.5", "R9"],
      residue: residueVerdict({ mode: "live", shares, heroFold: 0 }) })!;
    expect(g.gate.reasons.map((r) => r.rule).sort()).toEqual(["residue", "size"]);
    expect(routingReasons(g).map((r) => r.rule)).toEqual(["residue"]);
  });
  it("no residue input: exactly the gate as before (no residue field)", () => {
    const g = treeGap6({ ...base, mode: "live" })!;
    expect(g.residue).toBeUndefined();
    expect(g.gate.route).toBe(false);
  });
});

describe("unsafe: the residue gate's failures are held", () => {
  it("preflop:residue-gate-ai-failed is a FAILED verdict and unsafe", () => {
    const p = classifyPath({ street: "preflop", streets: [], preflop: { piece: "hrc-6max-preflop", how: "failed", code: "preflop:residue-gate-ai-failed", why: "RESIDUE GATE: …" } });
    expect(p.verdict).toBe("failed");
    expect(unsafeReasons(p)).toEqual([UNSAFE_CODES["preflop:residue-gate-ai-failed"]!]);
  });
  it("arrival:residue-gate-ai-failed is unsafe at the flop, and on later streets through the memo's `first`", () => {
    const flop = classifyPath({ street: "flop", streets: [], arrival: { how: "failed", producer: "pin-chart6max", code: "arrival:residue-gate-ai-failed", why: "…" } });
    expect(flop.verdict).toBe("failed");
    expect(unsafeReasons(flop)).toContain(UNSAFE_CODES["arrival:residue-gate-ai-failed"]!);
    const turn = classifyPath({ street: "turn", streets: [], arrival: { how: "hit", producer: "memo", first: { how: "failed", producer: "pin-chart6max", code: "arrival:residue-gate-ai-failed" } } });
    expect(unsafeReasons(turn)).toContain(UNSAFE_CODES["arrival:residue-gate-ai-failed"]!);
    // the exact tree's ranges at the flop (arrival:residue-gate) are not unsafe
    const ok = classifyPath({ street: "flop", streets: [], arrival: { how: "by-design", producer: "ai-arrival", code: "arrival:residue-gate" } });
    expect(unsafeReasons(ok)).toEqual([]);
  });
});

describe("the pin carries the mark: the hand's later decisions follow it (preflopPin)", () => {
  it("markPreflopResidue marks the pin of that decision only; a later pin carries it without aiFailed; an earlier one does not", async () => {
    const { setPreflopPin, getPreflopPin, forgetPreflopPin, markPreflopResidue } = await import("./preflopPin");
    const key = "residue-carry";
    const hand = { clientHandId: key, handId: 3, heroCards: ["Ah", "Qh"] } as never;
    const base = { piece: "chart6max" as const, handKey: key, chartId: FX.chart, heroPos: "HJ", depth: 50, at: 0 };
    const first = LINE.split("-");
    setPreflopPin({ ...base, actionIndex: 9, rawTokens: first, codes: first });
    const mark: ResidueMark = { at: 9, rawTokens: first, chart: FX.chart, seat: "CO", code: "R9", line: "F-R2.5", s: 0.0014, a: 0.083 };
    expect(markPreflopResidue(hand, { ...mark, at: 8 })).toBe(false);            // not that decision's pin
    expect(markPreflopResidue(hand, { ...mark, aiFailed: true })).toBe(true);
    expect(getPreflopPin(key)?.residue?.aiFailed).toBe(true);
    // hero jams, the CO 4-bets… a later decision's pin (any piece) carries the mark, its aiFailed left behind
    setPreflopPin({ ...base, actionIndex: 11, rawTokens: [...first, "R46", "C"], codes: [...first, "R50", "C"] });
    expect(getPreflopPin(key)?.residue).toEqual(mark);
    // a replay of an EARLIER decision does not inherit a later decision's mark
    setPreflopPin({ ...base, actionIndex: 4, rawTokens: ["F"], codes: ["F"] });
    expect(getPreflopPin(key)?.residue).toBeUndefined();
    forgetPreflopPin(key);
  });
});

describe("THE ORDER (Brady 2026-10-13): the gap gate first; the residue rule only on the chart that stays the answer", () => {
  const byPos = { UTG: 50, HJ: 46, CO: 50, BTN: 50, SB: 50, BB: 50 };
  const base = { chartId: "ign200_6max_D50_o2_5", byPos, hero: "HJ", folded: new Set(["UTG", "BTN", "SB", "BB"]), aggressor: "CO", after: [] as string[],
    rawTokens: ["F", "R2.5", "R10.5", "F", "F", "F"], repaired: [{ index: 2, from: "R10.5", to: "R9", logDist: Math.log(10.5 / 9) }], fitted: ["F", "R2.5", "R9"] };
  const shares = { lines: [{ seat: "CO", code: "R9", label: "Raise 9", line: "F-R2.5", hero: false, type: "raise" as const, nodeFreq: 0.0014, typeFreq: 0.083, maxHand: 0.5 }] };
  it("both fire, gap gate live: the size bound alone routes — the residue verdict is info (no second reason)", () => {
    const g = treeGap6({ ...base, mode: "live", residue: residueVerdict({ mode: "live", shares, heroFold: 0 }) })!;
    expect(routingReasons(g).map((r) => r.rule)).toEqual(["size"]);
    expect(g.gate.reasons.some((r) => r.rule === "residue")).toBe(false);
    expect(residueRouted(g)).toBe(false);
    expect(g.residue?.fire).toBe(true);
  });
  it("both fire, gap gate off: the residue rule routes", () => {
    const g = treeGap6({ ...base, mode: "off", residue: residueVerdict({ mode: "live", shares, heroFold: 0 }) })!;
    expect(routingReasons(g).map((r) => r.rule)).toEqual(["residue"]);
  });
});

describe("GTO Wizard's own residue (aiResidueOf): the trigger read in the exact tree", () => {
  it("the same seat's raise at the same raise level under 1% of his range there: the guard fires; at a real share it does not", async () => {
    const { aiResidueOf } = await import("./fastSolve");
    const mark: ResidueMark = { at: 9, rawTokens: [], chart: FX.chart, seat: "CO", code: "R9", line: "F-R2.5", s: 0.0014, a: 0.083 };
    const line = (code: string, at: string, f: number) => ({ seat: "CO", code, line: at, nodeFreq: f, maxHand: 1, offTree: false });
    expect(aiResidueOf(mark, [line("R9.2", "F-R2.6", 0.004)])?.code).toBe("R9.2");
    expect(aiResidueOf(mark, [line("R9.2", "F-R2.6", 0.08)])).toBeNull();
    // another raise level of the same seat is not the trigger (a 4-bet after the 3-bet)
    expect(aiResidueOf(mark, [line("R9.2", "F-R2.6", 0.08), line("R50", "F-R2.6-R9.2-F-F-F-R22", 0.002)])).toBeNull();
    // the seat named through the shape's API positions; no lines (not scored, or hero's own trigger): nothing
    expect(aiResidueOf({ ...mark, seat: "BTN", code: "R50", line: "F-F-F" }, [{ ...line("R46.6", "F-F-F", 0.002), seat: "BU" }], { BTN: "BU" })?.code).toBe("R46.6");
    expect(aiResidueOf(mark, undefined)).toBeNull();
  });
  it("its code is unsafe and FAILED", () => {
    const p = classifyPath({ street: "preflop", streets: [], preflop: { piece: "gtow-ai-preflop", how: "by-design", code: "preflop:residue-gate" },
      preflopAlso: [{ v: "failed", code: "preflop:residue-gate-ai-residue", text: "RESIDUE GATE: GTO Wizard's own tree …" }] });
    expect(p.verdict).toBe("failed");
    expect(unsafeReasons(p)).toEqual([UNSAFE_CODES["preflop:residue-gate-ai-residue"]!]);
  });
});
