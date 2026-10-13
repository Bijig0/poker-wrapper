/**
 * THE RESIDUE GATE, END TO END on the real bake (2026-10-13, services/residueGate). Hand 4923399329's line: at 50bb the
 * HJ (hero) opens 2.5, the CO 3-bets to 9.2 — read on ign200_6max_D50_o2_5 at R9, a size the CO takes with 0.14% of his
 * range while his 3-bets (R7.5) are 8.18%. Hero holds QQ (the chart jams it: not the Fold exemption) or AhTh (13446's own
 * hand, Fold 99.77%: exempt).
 *   - log (the default): the verdict rides on the answer's treeGap, a "[residue-gate] would route" line is logged, and
 *     the chart's answer is exactly what it is with the gate off;
 *   - live: the chart refuses ("RESIDUE GATE: …"); with GTO Wizard blocked (the harness) the chart answers after all
 *     under preflop:residue-gate-ai-failed — verdict failed, unsafe, the pin marked; the flop then says its ranges are
 *     the leftover node's (the exact tree was never built);
 *   - a later decision of a hand the rule routed is routed again (stickiness), and the warm-up pre-builds the tree.
 * What is asserted is read off the bake: a bake whose 50bb chart for this table is not D50_o2_5 (or no longer has the
 * leftover R9) logs that and asserts nothing. Gated like the other bake-backed tests (MUTATION_GATE=1, setup/regress.ts).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { harnessEnv } from "../scripts/mutationHarness";
import { fastSolve, solvePreflop6max, warmPreflop6max, forgetPreflopPin, forgetGapGateWarms, dropArrivalMemo } from "./fastSolve";
import { getPreflopPin, setPreflopPin } from "./preflopPin";
import { handFacts } from "./handFacts";
import { unsafeReasons } from "./unsafeAnswer";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";
import { SIX_MAX_STRATEGY_ID } from "./strategies";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const gated = process.env.MUTATION_GATE !== "1";
const CHART = "ign200_6max_D50_o2_5";
let restore: (() => void) | null = null;
const saved = { mode: process.env.PREFLOP_RESIDUE_GATE, ms: process.env.GAP_GATE_AI_MS };
beforeAll(() => { if (!gated) { restore = harnessEnv(); process.env.GAP_GATE_AI_MS = "8000"; } });
afterAll(() => {
  restore?.();
  for (const [k, v] of [["PREFLOP_RESIDUE_GATE", saved.mode], ["GAP_GATE_AI_MS", saved.ms]] as const) { if (v == null) delete process.env[k]; else process.env[k] = v; }
});
const withMode = async <T>(mode: string | null, f: () => Promise<T>): Promise<T> => {
  const was = process.env.PREFLOP_RESIDUE_GATE;
  if (mode == null) delete process.env.PREFLOP_RESIDUE_GATE; else process.env.PREFLOP_RESIDUE_GATE = mode;
  try { return await f(); } finally { if (was == null) delete process.env.PREFLOP_RESIDUE_GATE; else process.env.PREFLOP_RESIDUE_GATE = was; }
};

const act = (seatId: number, type: string, street = "preflop", amount?: number, hero = false) => ({ seatId, hero, type, street, ...(amount != null ? { amount } : {}) });
/** UTG folds, hero (HJ) opens 2.5, the CO 3-bets to `threeBet`, the rest fold; hero calls; the flop: hero to act */
const raw = (id: string, cards: string[], threeBet = 9.2) => ({
  handId: 7101, tableSlot: 1, clientHandId: id, bbCents: 200, heroSeatId: 2, heroCards: cards, board: ["K♦", "7♣", "2♥"], street: "flop",
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
  stacks: { 1: 50, 2: 50 - threeBet, 3: 50 - threeBet, 4: 50, 5: 49.5, 6: 49 },
  startStacks: { 1: 50, 2: 50, 3: 50, 4: 50, 5: 50, 6: 50 },
  currentNode: { street: "flop", toActSeatId: 2, toActIsHero: true, pot: 1.5 + 2 * threeBet, toCall: 0, legalActions: [], complete: false },
  actions: [
    act(5, "post-sb", "preflop", 0.5), act(6, "post-bb", "preflop", 1), act(1, "fold"), act(2, "raise", "preflop", 2.5, true),
    act(3, "raise", "preflop", threeBet), act(4, "fold"), act(5, "fold"), act(6, "fold"), act(2, "call", "preflop", threeBet - 2.5, true),
  ],
  heroFolded: false, ended: false, lineSource: "ws", sessionId: "session_residue_gate_test", stakes: "$1/$2",
});
/** hero's decision facing the 3-bet (actions[8] is his call) */
const FACING = 8;
const at = (id: string, cards: string[], upto: number, threeBet?: number): ParsedHand => withStartStacks(truncateAt(normalizeHand(raw(id, cards, threeBet)).hand!, upto));
const forget = (id: string) => { forgetPreflopPin(id); handFacts.forget(id); };
const QQ = ["Q♠", "Q♥"], ATS = ["A♥", "T♥"];

/** is this bake's chart for the line the calibration's (D50_o2_5 with the leftover R9)? */
async function calibrated(id: string): Promise<boolean> {
  const r = await withMode("log", () => solvePreflop6max(at(id, QQ, FACING), "HJ", "audit", SIX_MAX_STRATEGY_ID));
  forget(id);
  if (!r?.ok || r.gametype !== CHART || r.line !== "F-R2.5-R9-F-F-F") {
    console.log(`[residue gate] this bake answers the line on ${r && r.ok ? `${r.gametype} at ${r.line}` : `nothing (${r?.reason?.slice(0, 120) ?? "null"})`} — nothing asserted`);
    return false;
  }
  return true;
}

describe.skipIf(gated)("solvePreflop6max: the residue gate on hand 13446's line", () => {
  test("log (the default): the verdict is recorded and logged; the chart's answer is the one the gate off gives", async () => {
    if (!(await calibrated("rg-probe-log"))) return;
    const log = spyOn(console, "log");
    let r: Awaited<ReturnType<typeof solvePreflop6max>>;
    try {
      r = await withMode(null, () => solvePreflop6max(at("rg-log", QQ, FACING), "HJ", "audit", SIX_MAX_STRATEGY_ID));
      expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("[residue-gate] would route hand rg-log") && l.includes(`CO R9 at "F-R2.5" s 0.14% a 8.32%`) && l.includes("hero QQ"))).toBe(true);
    } finally { log.mockRestore(); }
    forget("rg-log");
    const off = await withMode("off", () => solvePreflop6max(at("rg-off", QQ, FACING), "HJ", "audit", SIX_MAX_STRATEGY_ID));
    forget("rg-off");
    expect(r!?.ok).toBe(true);
    if (!r!?.ok || !off?.ok) return;
    expect(r.treeGap?.residue?.mode).toBe("log");
    expect(r.treeGap?.residue?.fire).toBe(true);
    expect(r.treeGap?.residue?.hits.map((h) => `${h.seat} ${h.code}`)).toEqual(["CO R9"]);
    expect(r.treeGap?.gate.route).toBe(false);
    expect(off.treeGap?.residue).toBeUndefined();
    // served exactly as with the gate off
    expect(r.actions).toEqual(off.actions);
    expect(r.gametype).toBe(off.gametype);
    expect(r.line).toBe(off.line);
    expect(r.warning).toBe(off.warning);
  });

  test("live: the chart refuses, saying RESIDUE GATE, with what it would have said; nothing is pinned", async () => {
    if (!(await calibrated("rg-probe-live"))) return;
    const r = await withMode("live", () => solvePreflop6max(at("rg-live", QQ, FACING), "HJ", "audit", SIX_MAX_STRATEGY_ID));
    expect(r?.ok).toBe(false);
    if (!r || r.ok) return;
    expect(r.reason).toStartWith("RESIDUE GATE: the CO's Raise 9 at \"F-R2.5\" is 0.14% of his range while his raises are 8.32%");
    expect(r.treeGap?.gate.reasons.map((x) => x.rule)).toEqual(["residue"]);
    expect(r.treeGap?.routed?.chartMix.find((x) => x.action === "All-in")?.frequency).toBeGreaterThan(99);
    expect(getPreflopPin("rg-live")).toBeUndefined();
    // the fallback's re-run (noGate) answers from the chart
    const again = await withMode("live", () => solvePreflop6max(at("rg-live", QQ, FACING), "HJ", "audit", SIX_MAX_STRATEGY_ID, { noGate: true }));
    expect(again?.ok).toBe(true);
    forget("rg-live");
  });

  test("live, 13446's own AhTh (Fold 99.77%): exempt — the chart answers", async () => {
    if (!(await calibrated("rg-probe-ats"))) return;
    const r = await withMode("live", () => solvePreflop6max(at("rg-ats", ATS, FACING), "HJ", "audit", SIX_MAX_STRATEGY_ID));
    forget("rg-ats");
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.treeGap?.residue?.exempt).toBe("fold");
    expect(r.treeGap?.residue?.fire).toBe(false);
    expect(r.actions.find((x) => x.action === "Fold")?.frequency).toBeGreaterThanOrEqual(99);
  });

  test("a snapped size the CO uses commonly (his 3-bet to 8 read at R7.5, 8.18%) never fires, even live", async () => {
    if (!(await calibrated("rg-probe-common"))) return;
    const r = await withMode("live", () => solvePreflop6max(at("rg-common", QQ, FACING, 8), "HJ", "audit", SIX_MAX_STRATEGY_ID));
    forget("rg-common");
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.line).toBe("F-R2.5-R7.5-F-F-F");
    expect(r.treeGap?.residue?.hits).toEqual([]);
    expect(r.treeGap?.residue?.fire).toBe(false);
  });

  test("hand consistency: a later decision of a hand the rule routed is routed too, on a line that would not fire alone", async () => {
    if (!(await calibrated("rg-probe-sticky"))) return;
    const id = "rg-sticky";
    const h = at(id, QQ, FACING, 8);                 // the CO's 8 → R7.5: clean on its own
    // an earlier decision of this hand (hero's open, actions.length 3) was routed by the rule — its pin carries the mark
    setPreflopPin({ piece: "chart6max", handKey: id, chartId: CHART, codes: ["F"], rawTokens: ["F"], heroPos: "HJ", depth: 50, actionIndex: 3, at: Date.now(),
      residue: { at: 3, rawTokens: ["F"], chart: CHART, seat: "HJ", code: "R3", line: "F", s: 0.004, a: 0.22 } });
    const r = await withMode("live", () => solvePreflop6max(h, "HJ", "audit", SIX_MAX_STRATEGY_ID));
    expect(r?.ok).toBe(false);
    if (r && !r.ok) {
      expect(r.reason).toStartWith("RESIDUE GATE: an earlier decision of this hand was routed");
      expect(r.treeGap?.residue?.sticky?.code).toBe("R3");
    }
    // log mode: recorded, served as before
    const l = await withMode("log", () => solvePreflop6max(h, "HJ", "audit", SIX_MAX_STRATEGY_ID));
    expect(l?.ok).toBe(true);
    forget(id);
  });
});

describe.skipIf(gated)("fastSolve live: GTO Wizard fails (the harness blocks it) → the chart, FAILED, unsafe; the flop says so", () => {
  test("preflop:residue-gate-ai-failed, the mark on the pin, then the flop's arrival:residue-gate-ai-failed note", async () => {
    if (!(await calibrated("rg-probe-e2e"))) return;
    const id = "rg-e2e";
    forget(id); dropArrivalMemo();
    await withMode("live", async () => {
      const r = await fastSolve(at(id, QQ, FACING), "HJ", { heroPos: "HJ", origin: "audit", strategyId: SIX_MAX_STRATEGY_ID } as any);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.source).toBe("hrc-6max-preflop");
      expect(r.warning).toContain("RESIDUE GATE: the CO's Raise 9");
      expect(r.warning).toContain("THE EXACT TREE FAILED TO ANSWER");
      expect(r.path?.preflop?.code).toBe("preflop:residue-gate-ai-failed");
      expect(r.path?.verdict).toBe("failed");
      expect(r.path?.treeGap?.routed?.ai).toMatch(/failed|timeout/);
      expect(unsafeReasons(r.path).join(" ")).toContain("the residue gate's exact tree did not answer");
      const pin = getPreflopPin(id);
      expect(pin?.piece).toBe("chart6max");
      expect(pin?.residue?.aiFailed).toBe(true);
      expect(pin?.residue?.code).toBe("R9");

      // the flop: hero called; the exact tree was never built (GTO Wizard blocked) — the ranges are the pinned chart's,
      // walked off the leftover node, and the arrival says so (the dry run carries the note)
      const f = await fastSolve(at(id, QQ, 9), "HJ", { heroPos: "HJ", origin: "audit", strategyId: SIX_MAX_STRATEGY_ID } as any);
      expect(f.ok).toBe(true);
      if (!f.ok) return;
      expect(f.warning).toContain("RESIDUE GATE FAILED AT THE FLOP: hero's preflop answer was read behind the CO's R9");
      expect(f.warning).toContain("the exact tree was not built by the flop");
    });
    forget(id); dropArrivalMemo();
  }, 60_000);
});

describe.skipIf(gated)("warmPreflop6max live: the exact tree is pre-built the tick the 3-bet lands", () => {
  test("the BTN is on the clock after the CO's 9.2: [residue-gate] pre-building", async () => {
    if (!(await calibrated("rg-probe-warm"))) return;
    forgetGapGateWarms();
    const log = spyOn(console, "log");
    try {
      await withMode("live", async () => {
        const h = at("rg-warm", QQ, 5);             // UTG F, HJ R2.5, CO R9.2 — the BTN to act
        h.currentNode = { ...h.currentNode, toActSeatId: 4, toActIsHero: false };
        warmPreflop6max(h, "HJ", SIX_MAX_STRATEGY_ID);
        const want = (l: string) => /^\[residue-gate\] hand rg-warm: RESIDUE GATE: the CO's Raise 9/.test(l) && l.includes("pre-building the exact tree");
        for (let i = 0; i < 150 && !log.mock.calls.some((c) => want(String(c[0]))); i++) await new Promise((res) => setTimeout(res, 20));
        expect(log.mock.calls.some((c) => want(String(c[0])))).toBe(true);
      });
    } finally { log.mockRestore(); forget("rg-warm"); }
  });
});

const withGapMode = async <T>(mode: string | null, f: () => Promise<T>): Promise<T> => {
  const was = process.env.PREFLOP_GAP_GATE;
  if (mode == null) delete process.env.PREFLOP_GAP_GATE; else process.env.PREFLOP_GAP_GATE = mode;
  try { return await f(); } finally { if (was == null) delete process.env.PREFLOP_GAP_GATE; else process.env.PREFLOP_GAP_GATE = was; }
};

describe.skipIf(gated)("THE ORDER (Brady 2026-10-13): gap gate first, the residue rule on the chart that stays the answer", () => {
  // the CO 3-bets to 10.5: read at R9 (the leftover) AND 1.167x off it — past the 3-bet size bound (1.15x)
  test("both fire: the gap gate's refusal alone (GAP GATE, size reasons only); the residue verdict rides as info", async () => {
    if (!(await calibrated("rg-probe-both"))) return;
    const r = await withMode("live", () => solvePreflop6max(at("rg-both", QQ, FACING, 10.5), "HJ", "audit", SIX_MAX_STRATEGY_ID));
    forget("rg-both");
    expect(r?.ok).toBe(false);
    if (!r || r.ok) return;
    expect(r.reason).toStartWith("GAP GATE: the 3-bet R10.5→R9");
    expect(r.reason).not.toContain("RESIDUE GATE");
    expect(r.treeGap?.gate.reasons.map((x) => x.rule)).toEqual(["size"]);
    expect(r.treeGap?.residue?.fire).toBe(true);
  });

  test("gap gate log + the residue rule fires: RESIDUE GATE routes", async () => {
    if (!(await calibrated("rg-probe-gaplog"))) return;
    const r = await withGapMode("log", () => withMode("live", () => solvePreflop6max(at("rg-gaplog", QQ, FACING, 10.5), "HJ", "audit", SIX_MAX_STRATEGY_ID)));
    forget("rg-gaplog");
    expect(r?.ok).toBe(false);
    if (!r || r.ok) return;
    expect(r.reason).toStartWith("RESIDUE GATE: the CO's Raise 9");
    expect(r.reason).not.toContain("GAP GATE");
  });

  test("gap-gate route + GTO Wizard failure: preflop:gap-gate-ai-failed primary, preflop:residue-gate-ai-failed beside it (FAILED, unsafe), pin marked, the flop's residue handling", async () => {
    if (!(await calibrated("rg-probe-both-e2e"))) return;
    const id = "rg-both-e2e";
    forget(id); dropArrivalMemo();
    await withMode("live", async () => {
      const r = await fastSolve(at(id, QQ, FACING, 10.5), "HJ", { heroPos: "HJ", origin: "audit", strategyId: SIX_MAX_STRATEGY_ID } as any);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.source).toBe("hrc-6max-preflop");
      expect(r.path?.preflop?.code).toBe("preflop:gap-gate-ai-failed");
      expect(r.path?.reasons.map((x) => `${x.code}:${x.v}`)).toContain("preflop:residue-gate-ai-failed:failed");
      expect(r.path?.verdict).toBe("failed");
      expect(r.warning).toContain("GAP GATE: the 3-bet R10.5→R9");
      expect(r.warning).toContain("RESIDUE GATE: on the chart that answers instead, the CO's Raise 9");
      expect(unsafeReasons(r.path).join(" ")).toContain("the residue gate's exact tree did not answer");
      expect(getPreflopPin(id)?.residue?.aiFailed).toBe(true);
      const f = await fastSolve(at(id, QQ, 9, 10.5), "HJ", { heroPos: "HJ", origin: "audit", strategyId: SIX_MAX_STRATEGY_ID } as any);
      expect(f.ok && f.warning).toContain("RESIDUE GATE FAILED AT THE FLOP");
    });
    forget(id); dropArrivalMemo();
  }, 60_000);

  test("gap-gate route + GTO Wizard failure with the residue rule in LOG: the gap gate's failure only, nothing marked", async () => {
    if (!(await calibrated("rg-probe-both-log"))) return;
    const id = "rg-both-log";
    forget(id);
    const r = await withMode("log", () => fastSolve(at(id, QQ, FACING, 10.5), "HJ", { heroPos: "HJ", origin: "audit", strategyId: SIX_MAX_STRATEGY_ID } as any));
    forget(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path?.preflop?.code).toBe("preflop:gap-gate-ai-failed");
    expect(r.path?.reasons.some((x) => x.code.startsWith("preflop:residue"))).toBe(false);
    expect(r.warning).not.toContain("RESIDUE GATE");
  }, 60_000);
});

describe.skipIf(gated)("GTO Wizard's own residue: a routed answer whose trigger is under 1% in the exact tree too", () => {
  const fakeAi = (villainFreq: number) => async (_h: unknown, _p: unknown, _why: string, opts: { villainLines?: boolean } = {}) => ({
    ok: true as const, actions: [{ action: "Fold", frequency: 30 }, { action: "Call", frequency: 70 }], decision: null, line: "F-R2.5-R9.2-F-F-F", pos: "HJ", heroClass: "QQ",
    treeKey: "fake", solId: "fake-sol", usedLine: "F-R2.5-R9.2-F-F-F", solveSecs: 0, cached: true, note: "GTO Wizard AI preflop (Ultra) answered (a fake)",
    shape: { n: 6, apiOf: { UTG: "UTG", HJ: "HJ", CO: "CO", BTN: "BTN", SB: "SB", BB: "BB" }, seatOf: { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 },
      positions: ["UTG", "HJ", "CO", "BTN", "SB", "BB"], stacks: { UTG: 50, HJ: 50, CO: 50, BTN: 50, SB: 50, BB: 50 }, sb: 0.5, bb: 1, straddle: null,
      rakeCapBb: 1.5, deadSb: false, deadBb: 0, heroApiPos: "HJ" },
    ...(opts.villainLines ? { villainLines: [{ seat: "CO", code: "R9.2", line: "F-R2.5", nodeFreq: villainFreq, maxHand: 1, offTree: false }] } : {}),
  });
  test("under 1%: served, but preflop:residue-gate-ai-residue — FAILED and unsafe; at a real share: preflop:residue-gate, not that", async () => {
    if (!(await calibrated("rg-probe-aires"))) return;
    const AI = await import("./gtowAiPreflop");
    for (const [freq, fires] of [[0.003, true], [0.08, false]] as const) {
      const id = `rg-aires-${fires}`;
      forget(id);
      const spy = spyOn(AI, "solvePreflopGtowAi").mockImplementation(fakeAi(freq) as never);
      try {
        const r = await withMode("live", () => fastSolve(at(id, QQ, FACING), "HJ", { heroPos: "HJ", origin: "audit", strategyId: SIX_MAX_STRATEGY_ID } as any));
        expect(spy.mock.calls.length).toBeGreaterThan(0);
        expect((spy.mock.calls[0]![3] as { villainLines?: boolean }).villainLines).toBe(true);   // the residue route asks for them
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        expect(r.source).toBe("gtow-ai-preflop");
        expect(r.path?.preflop?.code).toBe("preflop:residue-gate");
        const codes = r.path?.reasons.map((x) => x.code) ?? [];
        if (fires) {
          expect(codes).toContain("preflop:residue-gate-ai-residue");
          expect(r.path?.verdict).toBe("failed");
          expect(r.warning).toContain("RESIDUE GATE: GTO Wizard's own tree also barely takes the trigger — the CO's R9.2");
          expect(unsafeReasons(r.path).join(" ")).toContain("in GTO Wizard's own tree the villain's action is also under 1%");
        } else {
          expect(codes).not.toContain("preflop:residue-gate-ai-residue");
          expect(r.path?.verdict).not.toBe("failed");
        }
      } finally { spy.mockRestore(); forget(id); }
    }
  });
});
