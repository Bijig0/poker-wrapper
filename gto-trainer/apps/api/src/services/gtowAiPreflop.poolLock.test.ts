import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { COMBOS } from "../utils/comboIndex/comboIndex";

/**
 * THE POOL-LOCKED LIMPER (2026-10-05, gtowAiPreflop.solvePreflopPoolLocked + poolLimpFloor.poolLockTarget): hero's preflop
 * node read on the exact GTO Wizard AI tree with a short limper's limp node-locked to the pool's range. Over its seams —
 * no request leaves: the tree, the nodes, the lock and the line repair are fakes.
 */
let P: typeof import("./gtowAiPreflop");
let F: typeof import("./poolLimpFloor");
let Pin: typeof import("./preflopPin");
let seams0: any;
beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  F = await import("./poolLimpFloor");
  Pin = await import("./preflopPin");
  seams0 = { ...P.poolLockSeams };
});
afterEach(() => {
  Object.assign(P.poolLockSeams, seams0);
  P.resetAiPreflopMemory();
  delete process.env.SHORT_LIMP_POOL;
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
    handId: ++handNo, clientHandId: `pool-lock-${handNo}`, bbCents: 200, heroSeatId: hero, heroCards: ["7h", "6d"], board: [], street: "preflop",
    actions: [a("SB", "post-sb", 0.5), a("BB", "post-bb", 1), ...acts.map(([p, t, x]) => a(p, t, x))],
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { ...POS }, stacks: st, startStacks: { ...st },
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
};
const dealt = (h: ParsedHand) => ({ ...(h as any).startStacks });
const V2 = (id: string) => (/olimp_pool/.test(id) ? "limp-v2-uneven" : null);

describe("poolLockTarget: which limper, if any", () => {
  // hand 4922555015's shape: UTG folds, a 39bb HJ limps, CO/BTN/SB fold, hero's BB option
  const h4922555015 = () => hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]], { HJ: 39 });

  it("a short limper no pool chart covers: him, at his bucket's range", () => {
    const h = h4922555015();
    const t = F.poolLockTarget({ hand: h, heroPos: "BB", chartId: "ign200_6max_D30_olimp", dealt: dealt(h), planOf: V2 });
    expect(t).toEqual({ ok: true, target: { pos: "HJ", key: "limp_first_short_le60", stack: 39, complete: false, alsoSb: false } });
  });

  it("covered by his own v2 pool tree: none (that chart answers); a v1 tree or another seat's tree does not cover", () => {
    const h = h4922555015();
    expect(F.poolLockTarget({ hand: h, heroPos: "BB", chartId: "ign200_6max_D100_s30_HJ_olimp_pool3", dealt: dealt(h), planOf: V2 }).ok).toBe(false);
    expect(F.poolLockTarget({ hand: h, heroPos: "BB", chartId: "ign200_6max_D100_s30_HJ_olimp_pool3", dealt: dealt(h), planOf: () => "limp-uneven-pool3" }).ok).toBe(true);
    expect(F.poolLockTarget({ hand: h, heroPos: "BB", chartId: "ign200_6max_D100_olimp_pool3", dealt: dealt(h), planOf: V2 }).ok).toBe(true);
  });

  it("TWO OR MORE LIMPERS: never — the charts and the line fit answer, unchanged", () => {
    const two = hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "call", 1], ["BTN", "fold"], ["SB", "fold"]], { HJ: 39 });
    const t = F.poolLockTarget({ hand: two, heroPos: "BB", chartId: "ign200_6max_D30_olimp", dealt: dealt(two), planOf: V2 });
    expect(t.ok).toBe(false);
    expect((t as { why: string }).why).toContain("2 limpers");
    const three = hand("BB", [["UTG", "call", 1], ["HJ", "call", 1], ["CO", "call", 1], ["BTN", "fold"], ["SB", "fold"]], { UTG: 30 });
    expect(F.poolLockTarget({ hand: three, heroPos: "BB", chartId: null, dealt: dealt(three), planOf: V2 }).ok).toBe(false);
  });

  it("hero's own limp in front of a short over-limper: two limpers — never", () => {
    const h = hand("CO", [["UTG", "fold"], ["HJ", "fold"], ["CO", "call", 1], ["BTN", "call", 1], ["SB", "call", 0.5], ["BB", "raise", 5]], { BTN: 30 });
    expect(F.poolLockTarget({ hand: h, heroPos: "CO", chartId: null, dealt: dealt(h), planOf: V2 }).ok).toBe(false);
  });

  it("A POST-IN IS TREATED AS A LIMPER, FOR NOW (Brady 2026-10-05): a poster checking his option gets the limp's pool range", () => {
    // the CO (30.6bb) posted 1bb to come in and checked (normalizeHand reads it as a limp, the seat on postIns) — hand
    // 4921841315's shape. Minimally defensive until there is post-in data (memory todo-post-in-ranges).
    const h = hand("BB", [["UTG", "fold"], ["HJ", "fold"], ["CO", "call", 0], ["BTN", "fold"], ["SB", "call", 0.5]], { CO: 30.6, SB: 99 });
    (h as any).postIns = [{ seatId: SEAT.CO, hero: false, amount: 1, readAs: "limp" }];
    expect(F.poolLimpersOf(h, "BB").map((l) => l.pos)).toEqual(["CO", "SB"]);
    expect(F.poolLockTarget({ hand: h, heroPos: "BB", chartId: null, dealt: dealt(h), planOf: V2 }))
      .toEqual({ ok: true, target: { pos: "CO", key: "limp_first_short_le60", stack: 30.6, complete: false, alsoSb: false } });
  });

  it("a deep limper: none (the charts' own range)", () => {
    const h = hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]]);
    const t = F.poolLockTarget({ hand: h, heroPos: "BB", chartId: "ign200_6max_D100_olimp_pool3", dealt: dealt(h), planOf: V2 });
    expect(t.ok).toBe(false);
  });

  it("the SB alone completing short: the SB, at the complete's range; a short limper plus a short SB: the limper, the SB noted", () => {
    const sb = hand("BB", [["UTG", "fold"], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "call", 0.5]], { SB: 40 });
    expect(F.poolLockTarget({ hand: sb, heroPos: "BB", chartId: null, dealt: dealt(sb), planOf: V2 }))
      .toEqual({ ok: true, target: { pos: "SB", key: "sbcomplete_fold_short_le60", stack: 40, complete: true, alsoSb: false } });
    const both = hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "call", 0.5]], { HJ: 45, SB: 50 });
    expect(F.poolLockTarget({ hand: both, heroPos: "BB", chartId: null, dealt: dealt(both), planOf: V2 }))
      .toEqual({ ok: true, target: { pos: "HJ", key: "limp_first_short_le60", stack: 45, complete: false, alsoSb: true } });
  });

  it("hero behind the limper in any seat; a limp-raise after it keeps the target (his raise is solved behind the locked limp)", () => {
    const btn = hand("BTN", [["UTG", "call", 1], ["HJ", "fold"], ["CO", "fold"]], { UTG: 30 });
    expect((F.poolLockTarget({ hand: btn, heroPos: "BTN", chartId: null, dealt: dealt(btn), planOf: V2 }) as any).target?.pos).toBe("UTG");
    const lr = hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"], ["BB", "raise", 4], ["HJ", "raise", 12]], { HJ: 39 });
    expect((F.poolLockTarget({ hand: lr, heroPos: "BB", chartId: null, dealt: dealt(lr), planOf: V2 }) as any).target?.pos).toBe("HJ");
  });

  it("the switch: SHORT_LIMP_POOL=floor or off turns the lock off", () => {
    expect(F.poolLimpLockOn()).toBe(true);
    process.env.SHORT_LIMP_POOL = "floor";
    expect(F.poolLimpLockOn()).toBe(false);
    expect(F.shortLimpPoolOn()).toBe(true);
    process.env.SHORT_LIMP_POOL = "off";
    expect(F.poolLimpLockOn()).toBe(false);
    expect(F.shortLimpPoolOn()).toBe(false);
  });
});

describe("poolLimpLockOf: the lock's strategy", () => {
  it("the limp is the pool's weights; the rest spreads in the solver's own proportions; every combo sums to 1", () => {
    const w = F.poolLimpWeights("limp_first_short_le60");
    const s = (f: (i: number) => number) => Array.from({ length: 1326 }, (_, i) => f(i));
    const sols = [
      { action: { code: "F" }, strategy: s((i) => (i % 3 === 0 ? 0.6 : 0)) },
      { action: { code: "C" }, strategy: s((i) => (i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 0.2)) },
      { action: { code: "R2.5" }, strategy: s((i) => (i % 3 === 0 ? 0.4 : i % 3 === 1 ? 0 : 0.8)) },
    ];
    const lock = P.poolLimpLockOf("F", sols, "C", w);
    expect(lock.action_history).toEqual(["F"]);
    expect(lock.previous_nodes_lock_type).toBe("street_all");
    const by = Object.fromEntries(lock.strategy.map((x) => [x.action, x.strategy]));
    for (let i = 0; i < 1326; i++) {
      expect(by.C![i]).toBeCloseTo(w[i]!, 9);
      expect(by.F![i]! + by.C![i]! + by["R2.5"]![i]!).toBeCloseTo(1, 9);
      if (i % 3 === 0 && w[i]! < 1) expect(by.F![i]! / by["R2.5"]![i]!).toBeCloseTo(0.6 / 0.4, 6);     // the solver's 60/40
      if (i % 3 === 1) expect(by.F![i]!).toBeCloseTo(1 - w[i]!, 9);                                 // a pure limp: the rest folds
      if (i % 3 === 2) expect(by.F![i]!).toBeCloseTo(0, 9);                                         // 0.2 limp / 0.8 raise: the rest raises
    }
  });

  it("the pool weights are the class weights per combo", () => {
    const w = F.poolLimpWeights("limp_first_short_le60");
    const kts = COMBOS.findIndex((c) => c.cls === "KTs"), aks = COMBOS.findIndex((c) => c.cls === "AKs");
    expect(w[aks]).toBe(1);
    expect(w[kts]).toBeCloseTo(0.0943, 4);
    expect(Math.round(w.reduce((t, x) => t + x, 0))).toBeGreaterThan(300);
  });
});

describe("solvePreflopPoolLocked over its seams", () => {
  const arr = (x: number) => new Array(1326).fill(x);
  const node = (actor: string, sols: { code: string; p: number[] | number }[]) => ({
    data: {
      action_solutions: sols.map((x) => ({
        action: { code: x.code, type: ({ F: "FOLD", C: "CALL", X: "CHECK" } as Record<string, string>)[x.code] ?? "RAISE", betsize: x.code.startsWith("R") ? x.code.slice(1) : "0", allin: false },
        strategy: Array.isArray(x.p) ? x.p : arr(x.p),
      })),
      game: { players: ["UTG", "HJ", "CO", "BTN", "SB", "BB"].map((p) => ({ position: p, is_hero: p === actor })) },
    }, cached: true,
  });
  /** the fake GTO Wizard: the plain tree (P) and the locked one (L), the HJ limping 0.05% on P */
  function rig(opts: { lockHolds?: boolean } = {}) {
    const calls: { locks: any[][]; reads: string[] } = { locks: [], reads: [] };
    const w = F.poolLimpWeights("limp_first_short_le60");
    Object.assign(P.poolLockSeams, {
      solve: async () => ({ solId: "P" }),
      prefetch: () => {},
      lock: async (_p: string, _b: any, locks: any[]) => { calls.locks.push(locks); return { solId: "L" }; },
      repair: async (_s: string, tokens: string[]) => ({ line: tokens.join("-"), changed: [] }),
      node: async (solId: string, line: string) => {
        calls.reads.push(`${solId}:${line}`);
        if (line === "") return node("UTG", [{ code: "F", p: 0.8 }, { code: "R2.5", p: 0.2 }]);
        if (line === "F") return solId === "P"
          ? node("HJ", [{ code: "F", p: 0.77 }, { code: "C", p: 0.0005 }, { code: "R2.5", p: 0.2295 }])
          : node("HJ", [{ code: "F", p: w.map((x) => (1 - x) * 0.77) }, { code: "C", p: opts.lockHolds === false ? arr(0.0005) : w }, { code: "R2.5", p: w.map((x) => (1 - x) * 0.23) }]);
        if (line === "F-C-F-F-F") return node("BB", [{ code: "X", p: solId === "L" ? 0.55 : 0.92 }, { code: "R4", p: solId === "L" ? 0.45 : 0.08 }]);
        return { error: `NODE_DOES_NOT_EXIST ${line}` };
      },
    });
    return calls;
  }
  const h = () => hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]], { HJ: 39 });
  const target = { pos: "HJ" as const, key: "limp_first_short_le60" as const, stack: 39, complete: false, alsoSb: false };

  it("locks the HJ's limp node, reads hero's node on the locked tree, pins it with the limper named", async () => {
    const calls = rig();
    const hd = h();
    const r = await P.solvePreflopPoolLocked(hd, "BB", target);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.locks).toHaveLength(1);
    expect(calls.locks[0]![0].action_history).toEqual(["F"]);
    expect(r.solId).toBe("L");
    expect(r.actions.map((a) => a.frequency)).toEqual([55, 45]);
    expect(r.actions.map((a) => a.action)).toEqual(["Check", expect.stringMatching(/^Raise/)]);
    expect(r.note).toContain("POOL-LOCKED LIMPER");
    expect(r.note).toContain("limp_first_short_le60");
    const pin = Pin.preflopPinFor(hd);
    expect(pin?.piece).toBe("gtow-ai-preflop");
    expect((pin as any).solId).toBe("L");
    expect((pin as any).poolLocks).toEqual([{ pos: "HJ", key: "limp_first_short_le60" }]);
  });

  it("a lock that did not hold is no answer (the decision goes on as before)", async () => {
    rig({ lockHolds: false });
    const r = await P.solvePreflopPoolLocked(h(), "BB", target);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("the lock did not hold");
  });

  it("skipPin: a late answer pins nothing", async () => {
    rig();
    const hd = h();
    const r = await P.solvePreflopPoolLocked(hd, "BB", target, { skipPin: () => true });
    expect(r.ok).toBe(true);
    expect(Pin.preflopPinFor(hd)).toBeUndefined();
  });

  it("warmOnly: the tree and the lock, nothing of hero's read", async () => {
    const calls = rig();
    const r = await P.solvePreflopPoolLocked(h(), "BB", target, { warmOnly: true });
    expect(r.ok).toBe(false);
    expect(calls.locks).toHaveLength(1);
    expect(calls.reads.some((x) => x.startsWith("L:"))).toBe(false);
  });
});

describe("the floor and a pool-locked pin", () => {
  it("a limper the pin's tree locked is left as walked; another limper is still floored", () => {
    const hd = hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "call", 0.5], ["BB", "check"]], { HJ: 39, SB: 40 });
    const ranges = { HJ: { AKs: 0.5 }, SB: { QJs: 0.01 }, BB: { AKs: 1 } };
    const r = F.applyPoolLimpFloor({ hand: hd, heroPos: "BB", ranges, chartId: "gtow-ai · 6-handed · …", dealt: dealt(hd), planOf: V2,
      lockedPools: [{ pos: "HJ", key: "limp_first_short_le60" }] });
    expect(r.ranges.HJ).toEqual({ AKs: 0.5 });
    expect(r.applied.map((x) => x.pos)).toEqual(["SB"]);
  });
});

describe("the iso size over limpers (gtowAiPreflop.isoSizes)", () => {
  const sizes = (h: ParsedHand, heroPos: string) => {
    const dt = P.debugTree(h, heroPos);
    if ("error" in dt) throw new Error(dt.error);
    return Object.fromEntries(dt.body.bet_sizes.street_bet_sizes[0].position_bet_sizes.map((x: any) => [x.position, x.bet_sizes]));
  };
  it("a seat behind one limp isolates to 4bb, behind a limp and the SB's complete to 5bb; seats in front keep the 2.5x open", () => {
    const one = sizes(hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]]), "BB");
    expect(one.BB).toEqual(["4bb", "100bb"]);
    expect(one.CO).toEqual(["4bb", "100bb"]);
    expect(one.UTG).toEqual(["2.5x", "100bb"]);
    expect(one.HJ).toEqual(["2.5x", "100bb"]);
    const two = sizes(hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "call", 0.5]]), "BB");
    expect(two.BB).toEqual(["5bb", "100bb"]);
    expect(two.SB).toEqual(["4bb", "100bb"]);
  });
  it("an iso past a seat's stack is its all-in; a raised line and a heads-up tree keep their menus; no limp, no change", () => {
    expect(sizes(hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]], { BB: 3.5, HJ: 3.5, UTG: 3.5, CO: 3.5, BTN: 3.5, SB: 3.5 }), "BB").BB).toEqual(["3.5bb"]);
    expect(P.lineOf(hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "raise", 4]]), (P.debugTree(hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "raise", 4]]), "BB") as any).shape).iso).toBeNull();
    const open = sizes(hand("BB", [["UTG", "fold"], ["HJ", "raise", 2.5], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]]), "BB");
    expect(open.BB).toEqual(["2.5bb", "100bb"]);
    expect(P.isoSizes({ n: 2, positions: ["SB", "BB"] }, [], { SB: 0, BB: 1 })).toBeNull();
    expect(P.isoSizes({ n: 6, positions: ["UTG", "HJ", "CO", "BTN", "SB", "BB"] }, [], { UTG: 0, HJ: 0, CO: 0, BTN: 0, SB: 0, BB: 0 })).toBeNull();
  });
});
