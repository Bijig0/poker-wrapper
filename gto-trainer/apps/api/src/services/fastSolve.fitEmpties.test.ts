/**
 * THE FIT MAY THIN A CROWD, NEVER EMPTY IT (2026-10-04, utils/fitLine.emptiedGroups — hand 4922293970), END TO END on
 * the real bake. A 30bb UTG limps and hero is next in the HJ with ATo: the chart for that table
 * (ign200_6max_D100_s30_UTG_olimp) is an equilibrium solve whose UTG limps 0.07%, so HRC pruned the branch — the line
 * fit folded UTG's limp and hero was served the first-in "Raise 2.5". And the short small blind's flat of a button
 * open, which the short-SB chart never makes: the big blind was answered heads-up against the open.
 *
 * Now the chart refuses both (LINE NOT HELD, with the record of what it would have said) and the exact GTO Wizard
 * tree answers; with GTO Wizard blocked (the harness) the chart's fitted answer comes back flagged, under the path
 * code preflop:fit-empties-ai-failed. A crowd thinned but not emptied (two limpers read as one) stays the chart's.
 *
 * What is asserted is read off the bake: a bake that HOLDS the branch (a pool-locked short-UTG limp tree landing)
 * answers from it and the test says so instead of failing. Gated like the other bake-backed tests (MUTATION_GATE=1,
 * setup/regress.ts); the hermetic half is utils/fitLine/fitLine.test.ts.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { harnessEnv } from "../scripts/mutationHarness";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { fastSolve, solvePreflop6max, warmPreflop6max, forgetPreflopPin, forgetGapGateWarms } from "./fastSolve";
import { nodeGetter } from "./hrc6max";
import { getPreflopPin } from "./preflopPin";
import { SIX_MAX_STRATEGY_ID } from "./strategies";

const gated = process.env.MUTATION_GATE !== "1";
let restore: (() => void) | null = null;
beforeAll(() => { if (!gated) restore = harnessEnv(); });
afterAll(() => { restore?.(); });

const a = (seatId: number, type: string, amount?: number, hero = false) => ({ seatId, hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
const mk = (id: string, heroSeatId: number, cards: string[], stacks: Record<number, number>, acts: ReturnType<typeof a>[], toCall: number): ParsedHand => ({
  handId: 1, clientHandId: id, bbCents: 200, heroSeatId, heroCards: cards, board: [], street: "preflop",
  actions: [a(5, "post-sb", 0.5), a(6, "post-bb", 1), ...acts],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: POS, stacks, startStacks: stacks,
  currentNode: { street: "preflop", toActSeatId: heroSeatId, toActIsHero: true, pot: 1.5 + acts.reduce((s, x) => s + (x.amount ?? 0), 0), toCall, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand);
const SHORT_UTG = { 1: 30, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 };
const SHORT_SB = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 30, 6: 100 };
/** UTG (30bb) limps, hero in the HJ with ATo */
const limpHand = (id: string) => mk(id, 2, ["Ad", "Tc"], SHORT_UTG, [a(1, "call", 1)], 1);
/** folds to the BTN, who opens 2.5; the 30bb SB calls; hero in the BB with TT */
const flatHand = (id: string) => mk(id, 6, ["Th", "Tc"], SHORT_SB, [a(1, "fold"), a(2, "fold"), a(3, "fold"), a(4, "raise", 2.5), a(5, "call", 2.5)], 1.5);
/** UTG (30bb) and the HJ limp, hero in the CO */
const twoLimps = (id: string) => mk(id, 3, ["7h", "2d"], SHORT_UTG, [a(1, "call", 1), a(2, "call", 1)], 1);

/** does this chart hold the line (a decision node at it)? */
const holds = async (chart: string, line: string) => { const n = await nodeGetter(chart)(line); return !!n && n !== "unreachable" && !n.terminal; };

describe.skipIf(gated)("solvePreflop6max: the chart refuses a fit that deletes the only limper / caller", () => {
  test("a 30bb UTG limps, hero next in the HJ: LINE NOT HELD, with what the fit would have read", async () => {
    const id = "fit-empties-limp";
    const r = await solvePreflop6max(limpHand(id), "HJ");
    forgetPreflopPin(id);
    expect(r).not.toBeNull();
    if (r!.ok) {
      // this bake holds the short UTG's limp (a pool-locked tree landed): an exact chart answer, nothing folded out
      expect(r!.warning ?? "").not.toContain("LINE FITTED TO THE TREE");
      expect(await holds(r!.gametype, "C")).toBe(true);
      console.log(`[fit empties] ${r!.gametype} holds the 30bb UTG limp in this bake — answered from it`);
      return;
    }
    if (!/LINE NOT HELD/.test(r!.reason)) { console.log(`[fit empties] the limp spot was refused by another guard first: ${r!.reason.slice(0, 160)}`); return; }
    expect(r!.reason).toContain("UTG's limp");
    expect(r!.reason).toContain("the exact tree answers");
    expect(r!.fitEmpties?.groups).toEqual([{ level: 0, kind: "limp", seats: ["UTG"] }]);
    expect(r!.fitEmpties?.raw).toBe("C");
    expect(r!.fitEmpties?.readAt).toBe("F");
    expect(r!.fitEmpties?.chart).toBe(r!.gametype!);
    expect(await holds(r!.gametype!, "C")).toBe(false);
    // what the chart would have said for ATo first in — the answer the rule replaces
    expect(r!.fitEmpties?.chartMix?.some((x) => /^raise/i.test(x.action) && x.frequency > 0)).toBe(true);
    // a refusal pins nothing: the flop must not resume from a chart node that folds the limper
    expect(getPreflopPin(id)).toBeUndefined();
  });

  test("the same spot with the rule waived (the exact tree failed): the fitted answer, carrying the record", async () => {
    const id = "fit-empties-limp-waived";
    const refused = await solvePreflop6max(limpHand(id), "HJ");
    if (!refused || refused.ok || !refused.fitEmpties) return;      // see the first test: nothing to waive in this bake
    const r = await solvePreflop6max(limpHand(id), "HJ", "audit", null, { allowEmptied: true });
    forgetPreflopPin(id);
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.line).toBe("F");
    expect(r.warning).toContain("LINE FITTED TO THE TREE");
    expect(r.fitEmpties?.groups.map((g) => g.seats.join())).toEqual(["UTG"]);
  });

  test("the 30bb small blind flats a button open, hero in the BB: LINE NOT HELD (the only caller of the raise)", async () => {
    const id = "fit-empties-flat";
    const r = await solvePreflop6max(flatHand(id), "BB");
    forgetPreflopPin(id);
    expect(r).not.toBeNull();
    if (r!.ok) {
      expect(r!.warning ?? "").not.toContain("LINE FITTED TO THE TREE");
      console.log(`[fit empties] ${r!.gametype} holds the short SB's flat in this bake — answered from it`);
      return;
    }
    if (!/LINE NOT HELD/.test(r!.reason)) { console.log(`[fit empties] the flat spot was refused by another guard first: ${r!.reason.slice(0, 160)}`); return; }
    expect(r!.reason).toContain("SB's call of the raise");
    expect(r!.fitEmpties?.groups).toEqual([{ level: 1, kind: "call", seats: ["SB"] }]);
  });

  test("two limpers, the short UTG's folded out: one limper is left — never refused by this rule", async () => {
    const id = "fit-empties-two-limps";
    const r = await solvePreflop6max(twoLimps(id), "CO");
    forgetPreflopPin(id);
    expect(r).not.toBeNull();
    if (r!.ok) expect(r!.fitEmpties).toBeUndefined();
    else expect(r!.reason).not.toContain("LINE NOT HELD");
  });
});

describe.skipIf(gated)("fastSolve: the exact tree is asked; when it fails the chart's fitted answer is served, flagged", () => {
  test("GTO Wizard blocked (the harness): chart answer, path code preflop:fit-empties-ai-failed, the record on the path", async () => {
    const id = "fit-empties-e2e";
    const probe = await solvePreflop6max(limpHand(`${id}-probe`), "HJ");
    forgetPreflopPin(`${id}-probe`);
    if (!probe || probe.ok || !probe.fitEmpties) { console.log("[fit empties] the limp spot is not refused by the rule in this bake — nothing asserted"); return; }
    const r = await fastSolve(limpHand(id), "HJ", { heroPos: "HJ", origin: "audit", strategyId: SIX_MAX_STRATEGY_ID } as any);
    forgetPreflopPin(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("hrc-6max-preflop");
    expect(r.approx).toBe(true);
    expect(r.warning).toContain("LINE NOT HELD");
    expect(r.warning).toContain("THE EXACT TREE FAILED TO ANSWER");
    expect(r.path?.preflop?.code).toBe("preflop:fit-empties-ai-failed");
    expect(r.path?.verdict).not.toBe("clean");
    expect(r.path?.fitEmpties?.ai).toBe("failed");
    expect(r.path?.fitEmpties?.groups.map((g) => g.seats.join())).toEqual(["UTG"]);
  }, 60_000);   // a blocked GTO Wizard request is retried for some seconds before the AI piece gives up
});

describe.skipIf(gated)("warmPreflop6max: the exact tree is pre-built on the tick the limp lands", () => {
  test("hero on the button, the 30bb UTG has just limped: the walk refuses under the rule and the warm-up says so", async () => {
    const probe = await solvePreflop6max(limpHand("fit-empties-warm-probe"), "HJ");
    forgetPreflopPin("fit-empties-warm-probe");
    if (!probe || probe.ok || !probe.fitEmpties) return;
    forgetGapGateWarms();
    const log = spyOn(console, "log");
    try {
      // the line so far is "C": the HJ is on the clock, hero (BTN) two seats behind
      const h = { ...mk("fit-empties-warm", 4, ["Kh", "Qd"], SHORT_UTG, [a(1, "call", 1)], 1) } as ParsedHand;
      h.currentNode = { ...h.currentNode, toActSeatId: 2, toActIsHero: false };
      warmPreflop6max(h, "BTN", SIX_MAX_STRATEGY_ID);
      for (let i = 0; i < 100 && !log.mock.calls.some((c) => /\[fit-empties\] hand fit-empties-warm:/.test(String(c[0]))); i++) await new Promise((res) => setTimeout(res, 20));
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => /\[fit-empties\] hand fit-empties-warm:/.test(l));
      expect(line).toBeDefined();
      expect(line).toContain("UTG's limp");
      expect(line).toContain("pre-building the exact tree");
      // one check per (hand, line): the next tick with the same line does nothing
      const n = log.mock.calls.filter((c) => /\[fit-empties\] hand fit-empties-warm:/.test(String(c[0]))).length;
      warmPreflop6max(h, "BTN", SIX_MAX_STRATEGY_ID);
      await new Promise((res) => setTimeout(res, 100));
      expect(log.mock.calls.filter((c) => /\[fit-empties\] hand fit-empties-warm:/.test(String(c[0]))).length).toBe(n);
    } finally { log.mockRestore(); }
  });
});
