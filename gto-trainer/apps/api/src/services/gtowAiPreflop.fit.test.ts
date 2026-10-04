import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { blendFitMixes } from "../utils/fitBlend/fitBlend";
import { foldableCallers } from "../utils/fitLine/fitLine";
import { checkPreflopVillainLines } from "./chainChecks";

/**
 * THE LINE FIT READS EVERY FIT AND TAKES THE TIGHTEST, ON ONE TREE (2026-10-04, hand 4922379136). UTG min-raised, CO
 * and the SB called, hero in the big blind with K7o: the tree holds one cold-caller, the fit folded CO and REBUILT the
 * tree with his 2bb as dead money — an ante game in which UTG's raise was 0.06% of his range — and the answer was
 * "Call 100%" where both plain fits fold. What must hold now: one tree and one solve (no `pot`), hero's node read on
 * every fit the tree holds, the mixes blended (fold at the most folding fit's frequency, raise at the least raising
 * one's), an off-path fit left out when another is on the path, and check #3 saying so when none is.
 * Hermetic: a fake fetch, a stubbed session pool.
 */
let P: typeof import("./gtowAiPreflop");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  ({ gtowSessions } = await import("./gtowSessions"));
  const s = gtowSessions as any;
  for (const m of POOL_METHODS) savedPool.push({ m, own: Object.prototype.hasOwnProperty.call(s, m), fn: s[m] });
  s.route = () => ["primary"];
  s.routeIgnoringBlocks = s.route;
  s.liveFirst = (ids: string[]) => ids;
  s.tokenFor = async () => "t";
  s.bestToken = async () => ({ id: "primary", token: "t" });
  s.noteSuccess = () => {};
  s.noteFailure = () => null;
  s.forceRefresh = async () => true;
});
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of savedPool) { if (own) s[m] = fn; else delete s[m]; }
  P.resetAiPreflopMemory();
});
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; P.resetAiPreflopMemory(); });

interface FakeLog { trees: any[]; polls: string[] }
/** GTO Wizard with one tree: a node per line in `nodes`, NODE_DOES_NOT_EXIST for any other. */
function fakeGtow(nodes: Record<string, object>): FakeLog {
  const log: FakeLog = { trees: [], polls: [] };
  let seq = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/custom-trees/")) { log.trees.push(JSON.parse(String(init?.body ?? "{}"))); return Response.json({ id: `tree-${++seq}` }, { status: 201 }); }
    if (u.pathname.endsWith("/custom-solutions/")) return Response.json({ id: `sol-${++seq}` }, { status: 201 });
    const line = u.searchParams.get("preflop_actions") ?? "";
    log.polls.push(line);
    await Bun.sleep(5);
    const v = nodes[line];
    if (v === undefined) return new Response(JSON.stringify({ code: "NODE_DOES_NOT_EXIST", detail: "NODE_DOES_NOT_EXIST" }), { status: 400 });
    return Response.json(v);
  }) as typeof fetch;
  return log;
}

const arr = (x: number) => new Array(1326).fill(x);
const pnode = (actor: string, acts: [string, string, number][]) => ({
  game: { players: [{ position: actor, is_hero: true }] },
  action_solutions: acts.map(([code, type, f]) => ({ action: { code, type, betsize: code.startsWith("R") ? code.slice(1) : "" }, strategy: arr(f), total_frequency: f })),
});

/** Hand 4922379136's shape: UTG raises to 2, HJ folds, CO calls, BTN folds, SB calls — hero in the big blind with K7o. */
const hand4410 = (id: string): ParsedHand => ({
  handId: 1, clientHandId: id, bbCents: 200, heroSeatId: 6, heroCards: ["Kd", "7c"], board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "raise", amount: 2, street: "preflop" },
    { seatId: 2, hero: false, type: "fold", street: "preflop" },
    { seatId: 3, hero: false, type: "call", amount: 2, street: "preflop" },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 5, hero: false, type: "call", amount: 1.5, street: "preflop" },
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" }, stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
  currentNode: { street: "preflop", toActSeatId: 6, toActIsHero: true, pot: 7, toCall: 1, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand);

/** The tree as GTO Wizard builds it: one cold-caller, then only the big blind may still call. `coCall` is how often CO
 *  cold-calls the open; the two hero nodes are the two fits. */
const tree = (coCall: number, keepCo: [number, number, number], keepSb: [number, number, number], utgRaise = 0.16): Record<string, object> => ({
  "": pnode("UTG", [["F", "FOLD", 1 - utgRaise], ["R2", "RAISE", utgRaise]]),
  R2: pnode("HJ", [["F", "FOLD", 0.9], ["C", "CALL", 0.03], ["R7", "RAISE", 0.07]]),
  "R2-F": pnode("CO", [["F", "FOLD", 0.93 - coCall], ["C", "CALL", coCall], ["R7", "RAISE", 0.07]]),
  "R2-F-C": pnode("BTN", [["F", "FOLD", 0.92], ["R7", "RAISE", 0.08]]),                    // no call behind a cold-caller
  "R2-F-C-F": pnode("SB", [["F", "FOLD", 0.94], ["R7", "RAISE", 0.06]]),                   // … nor here: the line is refused
  "R2-F-C-F-F": pnode("BB", [["F", "FOLD", keepCo[0]], ["C", "CALL", keepCo[1]], ["R7", "RAISE", keepCo[2]]]),
  "R2-F-F": pnode("BTN", [["F", "FOLD", 0.84], ["C", "CALL", 0.09], ["R7", "RAISE", 0.07]]),
  "R2-F-F-F": pnode("SB", [["F", "FOLD", 0.87], ["C", "CALL", 0.075], ["R7", "RAISE", 0.055]]),
  "R2-F-F-F-C": pnode("BB", [["F", "FOLD", keepSb[0]], ["C", "CALL", keepSb[1]], ["R7", "RAISE", keepSb[2]]]),
});

const mix = (r: { actions: { action: string; frequency: number }[] }) => Object.fromEntries(r.actions.map((a) => [a.action, a.frequency]));

describe("AI preflop: a line the tree cannot hold is read on every fit and blended to the tightest", () => {
  it("open + two callers, hero in the BB: one tree with no dead money, both fits read, fold at the most folding one", async () => {
    const log = fakeGtow(tree(0.045, [0.6, 0.1, 0.3], [0.2, 0.7, 0.1]));
    const r = await P.solvePreflopGtowAi(hand4410("fit-blend"), null, "test");
    if (!r.ok) throw new Error(r.reason);
    // ONE tree, built as the table stands: nothing in the pot before the first action
    expect(log.trees.length).toBe(1);
    expect(log.trees[0].pot).toBe(0);
    // both fits, the most folding one (it keeps the cold-caller, the SB folded out) leading
    expect(r.fits?.map((f) => [f.folds.join("+"), f.line])).toEqual([["SB", "R2-F-C-F-F"], ["CO", "R2-F-F-F-C"]]);
    expect(r.usedLine).toBe("R2-F-C-F-F");
    // fold 60 (the keep-CO fit's), raise 10 (the keep-SB fit's), call the rest — neither fit's own mix
    expect(mix(r)).toEqual({ Fold: 60, Call: 30, "Raise 7": 10 });
    expect(r.note).toContain("LINE FITTED TO THE TREE: GTO Wizard");
    expect(r.note).toContain("blended to the TIGHTEST");
    expect(r.note).not.toContain("kept in the pot as dead money");
    // every villain action on the two lines is on the tree's path
    expect(r.villainLines?.map((l) => `${l.seat} ${l.code}`).sort()).toEqual(["CO C", "SB C", "UTG R2", "UTG R2"]);
    expect(r.villainLines?.some((l) => l.offTree)).toBe(false);
    expect(checkPreflopVillainLines(r.villainLines!).status).toBe("pass");
  });

  it("hand 4922379136: both fits fold K7o, so the answer is a fold — not the dead-money tree's call", async () => {
    fakeGtow(tree(0.045, [0.9998, 0, 0.0002], [0.9996, 0, 0.0004]));
    const r = await P.solvePreflopGtowAi(hand4410("fit-k7o"), null, "test");
    if (!r.ok) throw new Error(r.reason);
    expect(r.actions.map((a) => a.action)).toEqual(["Fold"]);          // the 0.02% raise is under the answer's floor
    expect(r.actions[0]!.frequency).toBeGreaterThan(99.9);
    expect(r.decision?.action).toBe("Fold");
  });

  it("a fit off the tree's path is left out when another is on it", async () => {
    // CO's cold-call is 0.05% of his range in this tree: the fit that keeps him is not the tree's own play
    fakeGtow(tree(0.0005, [1, 0, 0], [0.2, 0.7, 0.1]));
    const r = await P.solvePreflopGtowAi(hand4410("fit-offpath"), null, "test");
    if (!r.ok) throw new Error(r.reason);
    expect(r.fits?.map((f) => f.folds.join("+"))).toEqual(["CO"]);
    expect(r.usedLine).toBe("R2-F-F-F-C");
    expect(mix(r)).toEqual({ Fold: 20, Call: 70, "Raise 7": 10 });
    expect(r.note).toContain("the only fit");
  });

  it("every fit off the path: still answered, and check #3 flags the action the tree never takes", async () => {
    // the opener's raise is 0.06% of his range, as in the dead-money tree: both fits stand on it
    fakeGtow(tree(0.045, [0.6, 0.1, 0.3], [0.2, 0.7, 0.1], 0.0006));
    const r = await P.solvePreflopGtowAi(hand4410("fit-alloff"), null, "test");
    if (!r.ok) throw new Error(r.reason);
    expect(r.fits?.length).toBe(2);
    expect(mix(r)).toEqual({ Fold: 60, Call: 30, "Raise 7": 10 });
    expect(r.note).toContain("OFF THE TREE'S PATH: UTG's R2");
    const c = checkPreflopVillainLines(r.villainLines!);
    expect(c.id).toBe(3);
    expect(c.status).toBe("flag");
    expect(c.text).toContain("UTG R2");
  });

  it("a line the tree holds as it stands carries no fit and no villain lines", async () => {
    const nodes = tree(0.045, [0.6, 0.1, 0.3], [0.2, 0.7, 0.1]);
    fakeGtow(nodes);
    const h = hand4410("fit-none");
    h.actions = h.actions.filter((a) => !(a.seatId === 3 && a.type === "call"));
    h.actions.splice(4, 0, { seatId: 3, hero: false, type: "fold", street: "preflop" } as any);
    const r = await P.solvePreflopGtowAi(h, null, "test");
    if (!r.ok) throw new Error(r.reason);
    expect(r.usedLine).toBe("R2-F-F-F-C");
    expect(r.fits).toBeUndefined();
    expect(r.villainLines).toBeUndefined();
    expect(r.note).not.toContain("LINE FITTED");
  });
});

describe("blendFitMixes: fold at the most folding fit, raise at the least raising one", () => {
  it("two fits", () => {
    const out = blendFitMixes([
      [{ action: "Fold", frequency: 0.6 }, { action: "Call", frequency: 0.1 }, { action: "Raise 7", frequency: 0.3 }],
      [{ action: "Fold", frequency: 0.2 }, { action: "Call", frequency: 0.7 }, { action: "Raise 7", frequency: 0.1 }],
    ]);
    expect(out.map((a) => [a.action, Math.round(a.frequency)])).toEqual([["Fold", 60], ["Call", 30], ["Raise 7", 10]]);
  });
  it("the raise sizes are the least raising fit's, in its proportions; percent or fractions in, percent out", () => {
    const out = blendFitMixes([
      [{ action: "Fold", frequency: 50 }, { action: "Call", frequency: 10 }, { action: "Raise 7", frequency: 40 }],
      [{ action: "Fold", frequency: 30 }, { action: "Call", frequency: 50 }, { action: "Raise 7", frequency: 5 }, { action: "All-in", frequency: 15 }],
    ]);
    expect(out.map((a) => [a.action, Math.round(a.frequency)])).toEqual([["Fold", 50], ["Call", 30], ["Raise 7", 5], ["All-in", 15]]);
  });
  it("a limped pot hero may check: nothing to fold, raise at the least raising fit, check the rest", () => {
    const out = blendFitMixes([
      [{ action: "Check", frequency: 0.7 }, { action: "Raise 4", frequency: 0.3 }],
      [{ action: "Check", frequency: 0.9 }, { action: "Raise 4", frequency: 0.1 }],
    ]);
    expect(out.map((a) => [a.action, Math.round(a.frequency)])).toEqual([["Check", 90], ["Raise 4", 10]]);
  });
  it("one fit comes back as it is; a fit with no weight is ignored; none gives no mix", () => {
    const one = [{ action: "Fold", frequency: 0.25 }, { action: "Call", frequency: 0.75 }];
    expect(blendFitMixes([one]).map((a) => [a.action, a.frequency])).toEqual([["Fold", 25], ["Call", 75]]);
    expect(blendFitMixes([one, [{ action: "Fold", frequency: 0 }]]).map((a) => [a.action, a.frequency])).toEqual([["Fold", 25], ["Call", 75]]);
    expect(blendFitMixes([])).toEqual([]);
  });
  it("a node with no call or check: fold and raise are renormalised, no passive action is invented", () => {
    const out = blendFitMixes([
      [{ action: "Fold", frequency: 0.8 }, { action: "Raise 7", frequency: 0.2 }],
      [{ action: "Fold", frequency: 0.6 }, { action: "Raise 7", frequency: 0.4 }],
    ]);
    expect(out.map((a) => [a.action, Math.round(a.frequency)])).toEqual([["Fold", 80], ["Raise 7", 20]]);
  });
});

describe("foldableCallers: every caller a fit may fold", () => {
  const opts = (keep: string[]) => ({ keep: new Set(keep), stack: 100, seats: ["UTG", "HJ", "CO", "BTN", "SB", "BB"] });
  it("each plain caller once, in order — never a kept seat", () => {
    expect(foldableCallers(["R2", "F", "C", "F", "C"], opts(["BB"]))).toEqual(["CO", "SB"]);
    expect(foldableCallers(["R2", "F", "C", "F", "C"], opts(["BB", "CO"]))).toEqual(["SB"]);
  });
  it("never a limper who raises later: his raise is the spot", () => {
    // UTG limps, HJ limps, CO raises to 5, folds to UTG who re-raises to 16, HJ calls
    expect(foldableCallers(["C", "C", "R5", "F", "F", "F", "R16", "C"], opts(["CO"]))).toEqual(["HJ"]);
  });
});
