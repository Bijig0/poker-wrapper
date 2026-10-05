import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { COMBOS } from "../utils/comboIndex/comboIndex";

/**
 * THE POOL'S 3-BET COLD-CALL (2026-10-05, services/poolColdCall + gtowAiPreflop.solvePreflopColdCallLocked): stress-500
 * po_3way-001 — CO opens 2.5, the SB 3-bets to 11, the 60bb BB cold-calls; the exact tree gives that call 0% and the
 * BB entered every later node with 0.01 combos. Over the lock's seams — no request leaves.
 */
let P: typeof import("./gtowAiPreflop");
let C: typeof import("./poolColdCall");
let Pin: typeof import("./preflopPin");
let seams0: any;
beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  C = await import("./poolColdCall");
  Pin = await import("./preflopPin");
  seams0 = { ...P.poolLockSeams };
});
afterEach(() => {
  Object.assign(P.poolLockSeams, seams0);
  P.resetAiPreflopMemory();
  delete process.env.COLD_CALL_POOL;
});

const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as const;
const SEAT = { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 } as const;
type Pp = keyof typeof SEAT;
let handNo = 0;
const hand = (heroPos: Pp, acts: [Pp, string, number?][], stacks: Partial<Record<Pp, number>> = {}): ParsedHand => {
  const hero = SEAT[heroPos];
  const a = (pos: Pp, type: string, amount?: number) => ({ seatId: SEAT[pos], hero: SEAT[pos] === hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
  const st: Record<number, number> = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 };
  for (const [p, v] of Object.entries(stacks)) st[SEAT[p as Pp]] = v!;
  return {
    handId: ++handNo, clientHandId: `cc-lock-${handNo}`, bbCents: 200, heroSeatId: hero, heroCards: ["7s", "7c"], board: [], street: "preflop",
    actions: [a("SB", "post-sb", 0.5), a("BB", "post-bb", 1), ...acts.map(([p, t, x]) => a(p, t, x))],
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { ...POS }, stacks: st, startStacks: { ...st },
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
};
const dealt = (h: ParsedHand) => ({ ...(h as any).startStacks });
// po_3way-001's preflop, hero the CO facing the 3-bet and the cold-call
const po3way001 = () => hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "fold"], ["SB", "raise", 11], ["BB", "call", 11]], { BB: 60 });

describe("coldCallLockTarget: which cold-caller, if any", () => {
  it("po_3way-001: the BB (60bb) called the SB's 4.4x 3-bet: his 40-80bb range against a LARGE 3-bet", () => {
    const h = po3way001();
    expect(C.coldCallLockTarget({ hand: h, heroPos: "CO", dealt: dealt(h) })).toEqual({ ok: true, target: { pos: "BB", key: "coldcall3b_BB_40_80_large", stack: 60, size: "large" } });
  });
  it("deep: the 80bb+ range at the 3-bet's size; with no size on the line, the seat+stack range", () => {
    const deep = hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "fold"], ["SB", "raise", 11], ["BB", "call", 11]]);
    expect((C.coldCallLockTarget({ hand: deep, heroPos: "CO", dealt: dealt(deep) }) as any).target.key).toBe("coldcall3b_BB_80p_large");
    const noSize = hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise"], ["BTN", "fold"], ["SB", "raise"], ["BB", "call"]]);
    expect((C.coldCallLockTarget({ hand: noSize, heroPos: "CO", dealt: dealt(noSize) }) as any).target).toEqual({ pos: "BB", key: "coldcall3b_BB_80p", stack: 100, size: null });
    expect(C.coldCallKey("UTG", 100)).toBeNull();
  });
  it("never: no cold-call, a limped pot, two cold-callers, hero's own cold-call, a flat of the open calling the 3-bet", () => {
    const none = hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "fold"], ["SB", "raise", 11], ["BB", "fold"]]);
    expect(C.coldCallLockTarget({ hand: none, heroPos: "CO" }).ok).toBe(false);
    const limped = hand("CO", [["UTG", "call", 1], ["HJ", "fold"], ["CO", "raise", 5], ["BTN", "fold"], ["SB", "raise", 16], ["BB", "call", 16]]);
    expect((C.coldCallLockTarget({ hand: limped, heroPos: "CO" }) as any).why).toContain("limped");
    const two = hand("HJ", [["UTG", "fold"], ["HJ", "raise", 2.5], ["CO", "raise", 8], ["BTN", "call", 8], ["SB", "fold"], ["BB", "call", 8]]);
    expect((C.coldCallLockTarget({ hand: two, heroPos: "HJ" }) as any).why).toContain("2 cold-callers");
    const heroCalls = hand("BB", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "fold"], ["SB", "raise", 11], ["BB", "call", 11]]);
    expect(C.coldCallLockTarget({ hand: heroCalls, heroPos: "BB" }).ok).toBe(false);
    // the BTN flatted the open, then calls the 3-bet: not a cold call
    const flat = hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "call", 2.5], ["SB", "raise", 13], ["BB", "fold"], ["CO", "call", 13], ["BTN", "call", 13]]);
    expect(C.coldCallersOf(flat, "CO").callers).toEqual([]);
  });
  it("a cold-caller who raises later keeps no target (his call is not a call range)", () => {
    const h = hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "fold"], ["SB", "raise", 11], ["BB", "call", 11], ["CO", "raise", 25], ["SB", "fold"], ["BB", "raise", 60]]);
    expect(C.coldCallersOf(h, "CO").callers[0]?.raisedLater).toBe(true);
    expect(C.coldCallLockTarget({ hand: h, heroPos: "CO" }).ok).toBe(false);
  });
  it("THE SIZE (2026-10-05): the 3-bet's multiple of the open — small under 2.5x, mid 2.5-3.9x, large 3.9x+; a jam when all-in or 40%+ of the effective stack", () => {
    const cc = (open: number, threeBet: number, more: Partial<{ allIn: boolean; tb: "SB" | "BTN" }> = {}) =>
      ({ pos: "BB" as const, open, threeBet, threeBettor: more.tb ?? ("BTN" as const), threeBetAllIn: !!more.allIn });
    const st = { BB: 100, BTN: 100, SB: 100 };
    expect(C.coldCallSize(cc(2.5, 6), st)).toBe("small");          // 2.4x
    expect(C.coldCallSize(cc(2, 5), st)).toBe("mid");              // 2.5x exactly
    expect(C.coldCallSize(cc(2.5, 7.5), st)).toBe("mid");          // 3x
    expect(C.coldCallSize(cc(2.5, 9.75), st)).toBe("large");       // 3.9x
    expect(C.coldCallSize(cc(2.5, 11, { tb: "SB" }), st)).toBe("large");
    expect(C.coldCallSize(cc(2.5, 11, { allIn: true }), st)).toBe("jam");
    expect(C.coldCallSize(cc(2.5, 11), { BB: 25, BTN: 100 })).toBe("jam");   // 44% of the caller's 25bb
    expect(C.coldCallSize(cc(2.5, 11), { BB: 100, BTN: 11 })).toBe("jam");   // the 3-bettor's whole stack
    expect(C.coldCallSize(cc(2.5, 11), { BB: 30, BTN: 100 })).toBe("large"); // 37%: not yet a jam
    expect(C.coldCallSize(cc(0, 11), st)).toBeNull();
    expect(C.coldCallSize(cc(2.5, 0), st)).toBeNull();
  });
  it("THE KEY: the most specific range built — seat+stack+size, seat+stack, seat+size, seat; a jam: the seat's jam range", () => {
    expect(C.coldCallKey("BB", 60, "small")).toBe("coldcall3b_BB_40_80_small");
    expect(C.coldCallKey("BB", 120, "mid")).toBe("coldcall3b_BB_80p_mid");
    expect(C.coldCallKey("BB", 60, null)).toBe("coldcall3b_BB_40_80");
    expect(C.coldCallKey("BB", NaN, "small")).toBe("coldcall3b_BB_small");
    expect(C.coldCallKey("BB", 60, "jam")).toBe("coldcall3b_BB_jam");
    expect(C.coldCallKey("BB", 20, "jam")).toBe("coldcall3b_BB_jam");
    // too few HJ small 3-bets for a size range of their own: the stack range, then the seat's
    expect(C.coldCallKey("HJ", 60, "small")).toBe("coldcall3b_HJ_40_80");
    expect(C.coldCallKey("HJ", 30, "small")).toBe("coldcall3b_HJ_all");
    expect(C.coldCallKey("HJ", NaN, "small")).toBe("coldcall3b_HJ_all");
    expect(C.coldCallKey("CO", 30, "large")).toBe("coldcall3b_CO_le40");
    expect(C.coldCallKey("HJ", 120, "jam")).toBe("coldcall3b_HJ_jam");
    // a min 3-bet is flatted far wider than a large one, from the same seat and stack
    const f = (k: string) => C.coldCallRange(k as any).freq;
    expect(f("coldcall3b_BB_80p_small")).toBeGreaterThan(2.5 * f("coldcall3b_BB_80p_large"));
  });
  it("from the hand: a min 3-bet, a jam", () => {
    const min3 = hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "raise", 6], ["SB", "fold"], ["BB", "call", 6]]);
    expect((C.coldCallLockTarget({ hand: min3, heroPos: "CO", dealt: dealt(min3) }) as any).target).toEqual({ pos: "BB", key: "coldcall3b_BB_80p_small", stack: 100, size: "small" });
    const jam = hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "fold"], ["SB", "all-in", 30], ["BB", "call", 30]], { SB: 30 });
    expect(C.coldCallersOf(jam, "CO").callers[0]).toMatchObject({ pos: "BB", open: 2.5, threeBet: 30, threeBettor: "SB", threeBetAllIn: true });
    expect((C.coldCallLockTarget({ hand: jam, heroPos: "CO", dealt: dealt(jam) }) as any).target).toEqual({ pos: "BB", key: "coldcall3b_BB_jam", stack: 100, size: "jam" });
  });
  it("the switch: COLD_CALL_POOL", () => {
    expect(C.coldCallPoolMode()).toBe("on");
    process.env.COLD_CALL_POOL = "floor";
    expect(C.coldCallPoolMode()).toBe("floor");
    process.env.COLD_CALL_POOL = "off";
    expect(C.coldCallPoolMode()).toBe("off");
  });
  it("the weights are the class weights per combo, a real range (dozens of combos), not zero", () => {
    const w = C.coldCallWeights("coldcall3b_BB_80p");
    const jj = COMBOS.findIndex((c) => c.cls === "JJ"), seven2 = COMBOS.findIndex((c) => c.cls === "72o");
    expect(w[jj]).toBeGreaterThan(0.15);
    expect(w[seven2]).toBeLessThan(0.05);
    const combos = w.reduce((t, x) => t + x, 0);
    expect(combos).toBeGreaterThan(20);
    expect(combos).toBeLessThan(45);
  });
});

describe("solvePreflopColdCallLocked over its seams", () => {
  const arr = (x: number) => new Array(1326).fill(x);
  const node = (actor: string, sols: { code: string; p: number[] | number; tot?: number }[]) => ({
    data: {
      action_solutions: sols.map((x) => ({
        action: { code: x.code, type: ({ F: "FOLD", C: "CALL", X: "CHECK" } as Record<string, string>)[x.code] ?? "RAISE", betsize: x.code.startsWith("R") ? x.code.slice(1) : "0", allin: false },
        strategy: Array.isArray(x.p) ? x.p : arr(x.p), total_frequency: x.tot ?? (Array.isArray(x.p) ? 0 : x.p),
      })),
      game: { players: ["UTG", "HJ", "CO", "BTN", "SB", "BB"].map((p) => ({ position: p, is_hero: p === actor })) },
    }, cached: true,
  });
  /** P = the plain tree (the BB cold-calls `share`), L = the locked one */
  function rig(opts: { share?: number; lockHolds?: boolean } = {}) {
    const calls: { locks: any[][]; reads: string[] } = { locks: [], reads: [] };
    const w = C.coldCallWeights("coldcall3b_BB_40_80_large");
    const share = opts.share ?? 0;
    Object.assign(P.poolLockSeams, {
      solve: async () => ({ solId: "P" }),
      prefetch: () => {},
      lock: async (_p: string, _b: any, locks: any[]) => { calls.locks.push(locks); return { solId: "L" }; },
      repair: async (_s: string, tokens: string[]) => ({ line: tokens.join("-"), changed: [] }),
      node: async (solId: string, line: string) => {
        calls.reads.push(`${solId}:${line}`);
        if (line === "F-F-R2.5-F-R11") return solId === "P"
          ? node("BB", [{ code: "F", p: 0.948 - share }, { code: "C", p: share }, { code: "R25.3", p: 0.023 }, { code: "RAI", p: 0.029 }])
          : node("BB", [{ code: "F", p: w.map((x) => (1 - x) * 0.948) }, { code: "C", p: opts.lockHolds === false ? arr(0) : w }, { code: "R25.3", p: w.map((x) => (1 - x) * 0.052) }]);
        if (line === "F-F-R2.5-F-R11-C") return node("CO", [{ code: "F", p: solId === "L" ? 0.35 : 0.9 }, { code: "C", p: solId === "L" ? 0.65 : 0.1 }]);
        return { error: `NODE_DOES_NOT_EXIST ${line}` };
      },
    });
    return calls;
  }
  const target = { pos: "BB" as const, key: "coldcall3b_BB_40_80_large" as const, stack: 60, size: "large" as const };

  it("the exact tree gives the call 0%: the BB's node locked to the pool range, hero's node read on the locked tree, pinned with the caller named", async () => {
    const calls = rig();
    const hd = po3way001();
    const r = await P.solvePreflopColdCallLocked(hd, "CO", target);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.locks).toHaveLength(1);
    expect(calls.locks[0]![0].action_history).toEqual(["F-F-R2.5-F-R11"]);
    const callStrat = calls.locks[0]![0].strategy.find((s: any) => s.action === "C").strategy;
    expect(callStrat).toEqual(C.coldCallWeights("coldcall3b_BB_40_80_large"));
    expect(r.solId).toBe("L");
    expect(r.actions.map((a) => [a.action, a.frequency])).toEqual([["Fold", 35], ["Call", 65]]);
    expect(r.note).toContain("POOL-LOCKED COLD-CALL");
    expect(r.note).toContain("coldcall3b_BB_40_80_large");
    const pin = Pin.preflopPinFor(hd);
    expect((pin as any).solId).toBe("L");
    expect((pin as any).poolLocks).toEqual([{ pos: "BB", key: "coldcall3b_BB_40_80_large" }]);
  });

  it("the regular (unlocked) answer for the same decision never pins over the locked tree; a later decision does (stress-500 pf_3bet-034)", async () => {
    rig();
    const hd = po3way001();
    const r = await P.solvePreflopColdCallLocked(hd, "CO", target);
    expect(r.ok).toBe(true);
    const locked = Pin.preflopPinFor(hd) as any;
    expect(locked.solId).toBe("L");
    // the regular GTO Wizard AI answer of the same decision lands after it
    Pin.setPreflopPin({ ...locked, solId: "U", poolLocks: undefined }, hd.heroCards.join(""));
    expect((Pin.preflopPinFor(hd) as any).solId).toBe("L");
    // hero's NEXT preflop decision (a longer line) replaces it as before
    Pin.setPreflopPin({ ...locked, solId: "N", poolLocks: undefined, rawTokens: [...locked.rawTokens, "R30"] }, hd.heroCards.join(""));
    expect((Pin.preflopPinFor(hd) as any).solId).toBe("N");
  });

  it("the exact tree already gives the call a real share (2%): NOT NEEDED, nothing locked", async () => {
    const calls = rig({ share: 0.02 });
    const r = await P.solvePreflopColdCallLocked(po3way001(), "CO", target);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain(P.COLD_CALL_NOT_NEEDED);
    expect(calls.locks).toHaveLength(0);
  });

  it("a lock that did not hold is no answer", async () => {
    rig({ lockHolds: false });
    const r = await P.solvePreflopColdCallLocked(po3way001(), "CO", target);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("the lock did not hold");
  });
});

describe("applyPoolColdCallFloor: the flop", () => {
  const flop = () => hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "fold"], ["SB", "raise", 11], ["BB", "call", 11], ["CO", "call", 11]], { BB: 60 });
  it("a cold-caller at 0.01 combos gets the pool range; the others are untouched", () => {
    const h = flop();
    const ranges = { SB: { AA: 1, KK: 1 }, BB: { "72o": 0.001 }, CO: { "77": 1 } };
    const r = C.applyPoolColdCallFloor({ hand: h, heroPos: "CO", ranges, dealt: dealt(h) });
    expect(r.applied.map((x) => [x.pos, x.key])).toEqual([["BB", "coldcall3b_BB_40_80_large"]]);
    expect(r.applied[0]!.was).toBeCloseTo(0.01, 2);
    expect(r.applied[0]!.now).toBeGreaterThan(50);
    expect(r.ranges.SB).toEqual({ AA: 1, KK: 1 });
    expect(C.poolColdCallFloorNote(r.applied, "gtow-ai")).toContain("POOL COLD-CALL RANGE");
  });
  it("a cold-caller the tree gave a real range keeps it; one the pinned tree locked keeps his walked range", () => {
    const h = flop();
    const real = { BB: { "99": 1, TT: 1, AQs: 1 } };        // 16 combos
    expect(C.applyPoolColdCallFloor({ hand: h, heroPos: "CO", ranges: real, dealt: dealt(h) }).applied).toEqual([]);
    const thin = { BB: { "72o": 0.001 } };
    expect(C.applyPoolColdCallFloor({ hand: h, heroPos: "CO", ranges: thin, dealt: dealt(h), lockedPools: [{ pos: "BB", key: "coldcall3b_BB_40_80_large" }] }).applied).toEqual([]);
  });
});
