import { describe, expect, it } from "bun:test";
import { OFF_TREE_DUST, blendOffTreeRange, carriedOffTreeRange, isOffTree, isOffTreePostflop, offTreeBlendW, offTreeLockOn, offTreeMaxHand, offTreeFamily, offTreeLock, offTreeRangeMode, offTreeSoftT, offTreeStats, offTreeText, softOffTreeRange } from "./offTree";
import { OffTreeLog } from "./offTreeLog";

const N = 1326;
const range = (w = 1) => new Array(N).fill(0).map((_, i) => (i < 300 ? w : 0));   // 300 hands in range
/** a two-action node (check / bet) where each hand bets with `bet(i)` and the EVs are `ev(i)` */
const node = (bet: (i: number) => number, evCheck: (i: number) => number, evBet: (i: number) => number) => [
  { strategy: range().map((_, i) => 1 - bet(i)), evs: range().map((_, i) => evCheck(i)) },
  { strategy: range().map((_, i) => bet(i)), evs: range().map((_, i) => evBet(i)) },
];

describe("off-tree villain lines (2026-09-27)", () => {
  it("a villain mistake line — every hand bets a sliver and every hand loses by it: flagged (hand 4920638634's HJ flop bet)", () => {
    const s = offTreeStats(range(), node((i) => 0.001 + (i % 4) * 0.001, () => 1.0, () => 0.86), 1);
    expect(s.nodeFreq).toBeLessThan(0.01);
    expect(s.maxHand).toBeCloseTo(0.004, 6);
    expect(s.evGapBb).toBeCloseTo(0.14, 6);
    expect(isOffTree(s)).toBe(true);
  });

  it("a real narrow line — a few hands bet it often: rare overall, but NOT flagged", () => {
    const s = offTreeStats(range(), node((i) => (i < 3 ? 0.25 : 0), () => 1, () => 1), 1);
    expect(s.nodeFreq).toBeLessThan(0.01);
    expect(s.maxHand).toBe(0.25);
    expect(isOffTree(s)).toBe(false);
  });

  it("a common action is never flagged; missing EVs give a null gap", () => {
    const s = offTreeStats(range(), [{ strategy: range().map(() => 0.6) }, { strategy: range().map(() => 0.4) }], 1);
    expect(s.nodeFreq).toBeCloseTo(0.4, 6);
    expect(s.evGapBb).toBeNull();
    expect(isOffTree(s)).toBe(false);
  });

  it("names the spot family and reads as one line", () => {
    const l = { street: "flop" as const, seat: "HJ", inPosition: false, action: "BET", code: "R2.6", betsize: 2.6, codes: [], potNode: 8.5,
      nodeFreq: 0.0016, maxHand: 0.0041, evGapBb: 0.14 };
    expect(offTreeFamily(l, "Td6h7s")).toBe("flop · bet out of position · T-high board");
    expect(offTreeText(l)).toBe("HJ BET 2.6 is off-tree — the solver takes it 0.16%, no hand above 0.41%, costs him 0.14bb on average");
  });

  it("the log keeps a spot once per hand, fills villain's shown cards by position, and groups by family", () => {
    const log = new OffTreeLog(":memory:");
    const l = { street: "flop" as const, seat: "HJ", inPosition: false, action: "BET", code: "R2.6", betsize: 2.6, codes: [], potNode: 8.5,
      nodeFreq: 0.0016, maxHand: 0.0041, evGapBb: 0.14 };
    const meta = { clientHandId: "4920638634", sessionId: "session_20260926_030543", origin: "live", board: "Td6h7s7c", heroPos: "BTN" };
    log.record(meta, l);
    log.record({ ...meta, origin: "warm" }, l);                        // the same spot again: kept once
    log.record({ ...meta, clientHandId: "4920638700" }, l);
    expect(log.forSession("session_20260926_030543").length).toBe(2);
    expect(log.forHand("4920638634")[0]!.board).toBe("Td6h7s");         // the board as of the line's street
    expect(log.fillShown("4920638634", [{ position: "BTN", cards: ["As", "Ts"], hero: true }, { position: "HJ", cards: ["Kd", "Kc"] }])).toBe(1);
    const fams = log.families(log.recent());
    expect(fams).toEqual([{ family: "flop · bet out of position · T-high board", n: 2, shown: [{ hand: "4920638634", cards: "KdKc", action: "HJ BET 2.6" }] }]);
  });
});

describe("the soft range after an off-tree action (option 3, 2026-10-06)", () => {
  // 300 hands; the bet loses gap(i) bb against checking: 0 for the first 10 (the bet is their best action), then growing
  const gap = (i: number) => (i < 10 ? 0 : 0.01 * i);
  const sols = node((i) => (i < 10 ? 0.002 : 0.0001), () => 1, (i) => 1 - gap(i));

  it("the dust fix: a sliver-weight combo betting often no longer vetoes the flag (po_hu-004's Td9d)", () => {
    const r = range();
    r[400] = 0.0001;                                         // dust: 0.01% of the top weight
    const s2 = node((i) => (i === 400 ? 0.023 : 0.001), () => 1, () => 0.9);
    expect(isOffTree(offTreeStats(r, s2, 1))).toBe(false);   // without it: maxHand 2.3%
    const d = offTreeStats(r, s2, 1, { dust: OFF_TREE_DUST });
    expect(d.maxHand).toBeCloseTo(0.001, 9);
    expect(isOffTree(d)).toBe(true);
  });

  it("range x exp(-dEV / (t x pot)): best-action hands keep full weight, worse ones fall off with the gap", () => {
    const r = softOffTreeRange(range(), sols, 1, 10, 0.1);
    if ("why" in r) throw new Error(r.why);
    expect(r.range[0]).toBe(1);
    expect(r.range[100]).toBeCloseTo(Math.exp(-1 / 1), 9);   // gap 1bb, T = 1bb
    expect(r.range[299]).toBeCloseTo(Math.exp(-2.99), 9);
    expect(r.range[500]).toBe(0);                             // not in his range: stays out
    // a combo with a board card: in his range as sent, but strategy 0 and EV 0 for every action at the node — dropped
    const blocked = sols.map((x) => ({ strategy: x.strategy.map((v, i) => (i === 5 ? 0 : v)), evs: x.evs.map((v, i) => (i === 5 ? 0 : v)) }));
    const rb = softOffTreeRange(range(), blocked, 1, 10, 0.1);
    if ("why" in rb) throw new Error(rb.why);
    expect(rb.range[5]).toBe(0);
    expect(r.combos).toBeGreaterThan(10);
  });

  it("T -> 0 keeps only the hands for which the action is best; T -> infinity is the range before the action", () => {
    const cold = softOffTreeRange(range(), sols, 1, 10, 1e-6);
    const hot = softOffTreeRange(range(), sols, 1, 10, 1e6);
    if ("why" in cold || "why" in hot) throw new Error("not computable");
    expect(cold.combos).toBeCloseTo(10, 6);
    expect(hot.combos).toBeCloseTo(300, 1);
  });

  it("T is a share of the pot: double the pot and the EVs, the same range", () => {
    const big = node((i) => (i < 10 ? 0.002 : 0.0001), () => 2, (i) => 2 - 2 * gap(i));
    const a = softOffTreeRange(range(), sols, 1, 10, 0.1), b = softOffTreeRange(range(), big, 1, 20, 0.1);
    if ("why" in a || "why" in b) throw new Error("not computable");
    expect(b.range[150]).toBeCloseTo(a.range[150]!, 9);
  });

  it("no per-combo EVs or no pot: not computable, said why", () => {
    const noEv = [{ strategy: range() }, { strategy: range() }];
    expect(softOffTreeRange(range(), noEv, 1, 10, 0.1)).toEqual({ why: "the node carries no per-combo EVs" });
    expect("why" in softOffTreeRange(range(), sols, 1, 0, 0.1)).toBe(true);
  });

  it("the switches: OFFTREE_RANGE blend by default (2026-10-13), soft, log, off; OFFTREE_RANGE_T sane or 0.20", () => {
    const keep = { r: process.env.OFFTREE_RANGE, t: process.env.OFFTREE_RANGE_T };
    try {
      delete process.env.OFFTREE_RANGE; delete process.env.OFFTREE_RANGE_T;
      expect(offTreeRangeMode()).toBe("blend");
      process.env.OFFTREE_RANGE = "soft"; expect(offTreeRangeMode()).toBe("soft");
      process.env.OFFTREE_RANGE = "blend"; expect(offTreeRangeMode()).toBe("blend");
      expect(offTreeSoftT()).toBe(0.2);
      process.env.OFFTREE_RANGE = "log"; expect(offTreeRangeMode()).toBe("log");
      process.env.OFFTREE_RANGE = "OFF"; expect(offTreeRangeMode()).toBe("off");
      process.env.OFFTREE_RANGE_T = "0.2"; expect(offTreeSoftT()).toBe(0.2);
      process.env.OFFTREE_RANGE_T = "abc"; expect(offTreeSoftT()).toBe(0.2);
    } finally {
      if (keep.r == null) delete process.env.OFFTREE_RANGE; else process.env.OFFTREE_RANGE = keep.r;
      if (keep.t == null) delete process.env.OFFTREE_RANGE_T; else process.env.OFFTREE_RANGE_T = keep.t;
    }
  });

  it("OFFTREE_BLEND_W: 0.5 unless a number in [0, 1]; OFFTREE_LOCK on unless set off (2026-10-13)", () => {
    const keep = { w: process.env.OFFTREE_BLEND_W, l: process.env.OFFTREE_LOCK };
    try {
      delete process.env.OFFTREE_BLEND_W; expect(offTreeBlendW()).toBe(0.5);
      process.env.OFFTREE_BLEND_W = "0.3"; expect(offTreeBlendW()).toBe(0.3);
      process.env.OFFTREE_BLEND_W = "0"; expect(offTreeBlendW()).toBe(0);
      for (const bad of ["1.5", "-0.1", "abc", ""]) { process.env.OFFTREE_BLEND_W = bad; expect(offTreeBlendW()).toBe(0.5); }
      delete process.env.OFFTREE_LOCK; expect(offTreeLockOn()).toBe(true);
      for (const off of ["off", "OFF", "0", "false", "no"]) { process.env.OFFTREE_LOCK = off; expect(offTreeLockOn()).toBe(false); }
      process.env.OFFTREE_LOCK = "on"; expect(offTreeLockOn()).toBe(true);
    } finally {
      if (keep.w == null) delete process.env.OFFTREE_BLEND_W; else process.env.OFFTREE_BLEND_W = keep.w;
      if (keep.l == null) delete process.env.OFFTREE_LOCK; else process.env.OFFTREE_LOCK = keep.l;
    }
  });

  describe("the blend (2026-10-13)", () => {
    // 300 hands in range; the bet is a sliver for every hand but hands 0-9 bet it 50x as often (QRE's strength signal),
    // and it costs hand i (i % 30) x 0.1bb (the soft range's cost)
    const bet = (i: number) => (i < 10 ? 0.05 : 0.001);
    const sols = node(bet, () => 1, (i) => 1 - (i % 30) * 0.1);
    const R = range();
    const qre = R.map((w, i) => w * bet(i));
    const norm = (a: number[]) => { const t = a.reduce((x, y) => x + y, 0); return a.map((x) => x / t); };
    it("w = 0.5: half QRE's shape, half the soft range's, each normalised; the most likely hand keeps weight 1; never above his range", () => {
      const soft = softOffTreeRange(R, sols, 1, 10, 0.2);
      const b = blendOffTreeRange(R, sols, 1, 10, 0.2, 0.5);
      if ("why" in soft || "why" in b) throw new Error("not computable");
      const qn = norm(qre), sn = norm(soft.range);
      const mix = qn.map((q, i) => 0.5 * q + 0.5 * sn[i]!);
      const top = Math.max(...mix.map((m, i) => (R[i]! > 0 ? m / R[i]! : 0)));
      for (const i of [0, 5, 10, 29, 150, 299]) expect(b.range[i]).toBeCloseTo(mix[i]! / top, 9);
      expect(Math.max(...b.factor)).toBeCloseTo(1, 12);
      expect(b.range.every((x, i) => x <= R[i]! + 1e-12)).toBe(true);
      expect(b.combos).toBeCloseTo(b.range.reduce((x, y) => x + y, 0), 9);
      expect(b.range[400]).toBe(0);                              // not in his range: stays out
      // the strength signal is kept: hand 0 (QRE's favourite) outweighs hand 30 (same cost, QRE's sliver) by far
      expect(b.range[0]! / b.range[30]!).toBeGreaterThan(5);
    });
    it("w = 0 is the soft range's shape, w = 1 QRE's (both scaled to a top of 1)", () => {
      const soft = softOffTreeRange(R, sols, 1, 10, 0.2);
      const b0 = blendOffTreeRange(R, sols, 1, 10, 0.2, 0);
      const b1 = blendOffTreeRange(R, sols, 1, 10, 0.2, 1);
      if ("why" in soft || "why" in b0 || "why" in b1) throw new Error("not computable");
      const sTop = Math.max(...soft.range);
      for (const i of [0, 7, 29, 299]) expect(b0.range[i]).toBeCloseTo(soft.range[i]! / sTop, 9);
      const qTop = Math.max(...qre);
      for (const i of [0, 7, 29, 299]) expect(b1.range[i]).toBeCloseTo(qre[i]! / qTop, 9);
    });
    it("an empty QRE narrowing falls back to the soft range's shape; a node with no EVs is not computable", () => {
      const none = node(() => 0, () => 1, (i) => 1 - (i % 30) * 0.1);
      const soft = softOffTreeRange(R, none, 1, 10, 0.2);
      const b = blendOffTreeRange(R, none, 1, 10, 0.2, 0.5);
      if ("why" in soft || "why" in b) throw new Error("not computable");
      const sTop = Math.max(...soft.range);
      expect(b.range[29]).toBeCloseTo(soft.range[29]! / sTop, 9);
      expect(blendOffTreeRange(R, [{ strategy: R }, { strategy: R }], 1, 10, 0.2, 0.5)).toEqual({ why: "the node carries no per-combo EVs" });
    });
    it("carriedOffTreeRange: the pages rebuild exactly the carried range from the trace's record; null when nothing was applied", () => {
      const b = blendOffTreeRange(R, sols, 1, 10, 0.2, 0.5);
      const soft = softOffTreeRange(R, sols, 1, 10, 0.2);
      if ("why" in b || "why" in soft) throw new Error("not computable");
      const rec = (mode: "blend" | "soft" | "log", applied: boolean) => ({ mode, w: mode === "soft" ? undefined : 0.5, t: 0.2, pot: 10, qreCombos: 0, softCombos: 1, applied });
      expect(carriedOffTreeRange(R, sols, 1, rec("blend", true))).toEqual(b.range);
      expect(carriedOffTreeRange(R, sols, 1, rec("soft", true))).toEqual(soft.range);
      expect(carriedOffTreeRange(R, sols, 1, rec("log", false))).toBeNull();
      expect(carriedOffTreeRange(R, sols, 1, undefined)).toBeNull();
    });
  });

  it("the node lock: one history line per street from preflop, the taken action = the soft factor scaled to 1, each hand sums to 1", () => {
    const r = softOffTreeRange(range(), sols, 1, 10, 0.1);
    if ("why" in r) throw new Error(r.why);
    const withCodes = sols.map((x, j) => ({ ...x, action: { code: j ? "R3" : "X" } }));
    const lk = offTreeLock(withCodes, 1, r.factor, 2, ["X"]);    // a turn tree: ["", "", "X"]
    expect(lk.action_history).toEqual(["", "", "X"]);
    expect(lk.previous_nodes_lock_type).toBe("street_all");
    expect(lk.strategy.map((x) => x.action)).toEqual(["X", "R3"]);
    expect(lk.strategy[1]!.strategy[0]).toBe(1);
    expect(lk.strategy[1]!.strategy[100]).toBeCloseTo(Math.exp(-1), 9);
    for (const i of [0, 100, 299, 700]) expect(lk.strategy[0]!.strategy[i]! + lk.strategy[1]!.strategy[i]!).toBeCloseTo(1, 9);
    // range x lock = the soft range (up to scale)
    expect((range()[100]! * lk.strategy[1]!.strategy[100]!) / (range()[0]! * lk.strategy[1]!.strategy[0]!)).toBeCloseTo(r.range[100]! / r.range[0]!, 9);
  });

  it("says what was carried, and the log keeps the soft and QRE combos", () => {
    const l = { street: "flop" as const, seat: "BB", inPosition: false, action: "BET", code: "R5", betsize: 5, codes: ["X"], potNode: 10.4,
      nodeFreq: 0.0005, maxHand: 0.015, evGapBb: 0.89,
      soft: { mode: "soft" as const, t: 0.1, pot: 10.4, qreCombos: 0.0719, softCombos: 55.7, applied: true } };
    expect(offTreeText(l)).toContain("his range carried as 56 combos instead of QRE's 0.072 (soft, T = 10% of the 10.4bb pot)");
    const log = new OffTreeLog(":memory:");
    log.record({ clientHandId: "4921650489", sessionId: "s", origin: "live", board: "QsKcJd", heroPos: "BTN" }, l);
    const row = log.forHand("4921650489")[0]!;
    expect([row.softMode, row.softT, row.qreCombos, row.softCombos]).toEqual(["soft", 0.1, 0.0719, 55.7]);
  });
});

describe("the postflop trigger: the node share alone (2026-10-06)", () => {
  it("a rare action one hand takes often: flagged postflop, not by the preflop rule; OFFTREE_MAX_HAND=0.02 brings the old cut back", () => {
    const keep = process.env.OFFTREE_MAX_HAND;
    try {
      delete process.env.OFFTREE_MAX_HAND;
      const s = offTreeStats(range(), node((i) => (i < 3 ? 0.25 : 0), () => 1, () => 1), 1, { dust: OFF_TREE_DUST });
      expect(s.nodeFreq).toBeLessThan(0.01);
      expect(offTreeMaxHand()).toBe(Infinity);
      expect(isOffTreePostflop(s)).toBe(true);
      expect(isOffTree(s)).toBe(false);
      process.env.OFFTREE_MAX_HAND = "0.02";
      expect(isOffTreePostflop(s)).toBe(false);
      process.env.OFFTREE_MAX_HAND = "nonsense";
      expect(isOffTreePostflop(s)).toBe(true);
    } finally {
      if (keep == null) delete process.env.OFFTREE_MAX_HAND; else process.env.OFFTREE_MAX_HAND = keep;
    }
  });

  it("a common action never fires", () => {
    const s = offTreeStats(range(), [{ strategy: range().map(() => 0.6) }, { strategy: range().map(() => 0.4) }], 1, { dust: OFF_TREE_DUST });
    expect(isOffTreePostflop(s)).toBe(false);
  });
});
