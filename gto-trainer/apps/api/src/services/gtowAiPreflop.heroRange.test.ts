import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import FIX from "./__fixtures__/bbFits4922577588.json";

/**
 * HERO'S FLOP RANGE IS THE RANGE HE WAS ANSWERED WITH (2026-10-07, re-port of claude/tight-fit-2's GTO Wizard half; register
 * entry hero-range-as-answered, switch HERO_RANGE_AS_ANSWERED). On a line GTO Wizard's preflop tree cannot hold, hero's
 * preflop answer is the blend of every fit (fold at the most folding fit's frequency, raise at the least raising one's);
 * his flop-entering range was read on ONE fit (the earliest other caller folded) and disagreed with it. Live hand
 * 4922577588: CO 26bb opens to 2, BTN and SB call, hero BB 66 — answered Call 95 / Raise 5 from two fits, while his flop
 * range was the BTN-folded fit's, which 3-bets 77/88/AJo/ATs and calls 73s/J2s/A8o. The two BB nodes here are that
 * tree's own (gtow-cache 15696a16b7, per class). Hermetic: a fake fetch, a stubbed session pool.
 */
let P: typeof import("./gtowAiPreflop");
let PIN: typeof import("./preflopPin");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
const savedSwitch = process.env.HERO_RANGE_AS_ANSWERED;
beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  PIN = await import("./preflopPin");
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
afterEach(() => {
  globalThis.fetch = realFetch;
  P.resetAiPreflopMemory();
  if (savedSwitch === undefined) delete process.env.HERO_RANGE_AS_ANSWERED; else process.env.HERO_RANGE_AS_ANSWERED = savedSwitch;
});

/** GTO Wizard with one tree: a node per line in `nodes`, NODE_DOES_NOT_EXIST for any other. */
function fakeGtow(nodes: Record<string, object>): { polls: string[] } {
  const log = { polls: [] as string[] };
  let seq = 0;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/custom-trees/")) return Response.json({ id: `tree-${++seq}` }, { status: 201 });
    if (u.pathname.endsWith("/custom-solutions/")) return Response.json({ id: `sol-${++seq}` }, { status: 201 });
    const line = u.searchParams.get("preflop_actions") ?? "";
    log.polls.push(line);
    await Bun.sleep(2);
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
/** a BB node from the fixture: the tree's own strategies, class by class */
const realBb = (line: string) => {
  const n = (FIX as any).nodes[line];
  return {
    game: { players: [{ position: "BB", is_hero: true }] },
    action_solutions: n.actions.map((a: any, k: number) => ({
      action: { code: a.code, type: a.type, betsize: a.betsize, allin: a.allin },
      strategy: COMBOS.map((c) => n.classes[c.cls][k] as number),
    })),
  };
};

const SEATS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
/** Hand 4922577588 as dealt: UTG and HJ fold, CO (26bb) opens to 2, BTN calls, SB calls — hero in the BB with 66.
 *  `heroCall` appends hero's call (the line runs to the flop). */
const hand66 = (id: string, heroCall = false, cards = ["6h", "6c"]): ParsedHand => ({
  handId: 1, clientHandId: id, bbCents: 200, heroSeatId: 6, heroCards: cards, board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "fold", street: "preflop" },
    { seatId: 3, hero: false, type: "raise", amount: 2, street: "preflop" },
    { seatId: 4, hero: false, type: "call", amount: 2, street: "preflop" },
    { seatId: 5, hero: false, type: "call", amount: 1.5, street: "preflop" },
    ...(heroCall ? [{ seatId: 6, hero: true, type: "call", amount: 1, street: "preflop" }] : []),
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: SEATS, stacks: { 1: 147, 2: 172.5, 3: 26, 4: 99.5, 5: 119, 6: 99.5 },
  currentNode: { street: "preflop", toActSeatId: 6, toActIsHero: true, pot: 7.5, toCall: 1, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand);

/** The tree as GTO Wizard builds it: one cold-caller (then the SB may only fold or raise); the two BB nodes are the two
 *  fits, the real ones by default. `sbCall` = how often the SB flats when the BTN folded. */
const tree66 = (o: { sbCall?: number; btnCall?: number; keepBtn?: object; keepSb?: object } = {}): Record<string, object> => ({
  "": pnode("UTG", [["F", "FOLD", 0.85], ["R2", "RAISE", 0.15]]),
  F: pnode("HJ", [["F", "FOLD", 0.82], ["R2", "RAISE", 0.18]]),
  "F-F": pnode("CO", [["F", "FOLD", 0.7], ["R2", "RAISE", 0.3]]),
  "F-F-R2": pnode("BTN", [["F", "FOLD", 0.88 - (o.btnCall ?? 0.06)], ["C", "CALL", o.btnCall ?? 0.06], ["R7", "RAISE", 0.12]]),
  "F-F-R2-C": pnode("SB", [["F", "FOLD", 0.95], ["R9", "RAISE", 0.05]]),                     // no flat behind a cold-caller
  "F-F-R2-F": pnode("SB", [["F", "FOLD", 0.9 - (o.sbCall ?? 0.05)], ["C", "CALL", o.sbCall ?? 0.05], ["R9", "RAISE", 0.1]]),
  "F-F-R2-C-F": o.keepBtn ?? realBb("F-F-R2-C-F"),     // the SB folded out: BTN kept
  "F-F-R2-F-C": o.keepSb ?? realBb("F-F-R2-F-C"),      // the BTN folded out: SB kept
});

/** the fixture's call share of a class on one fit (what one fit alone gives the BB's calling range) */
const callOn = (line: string, cls: string) => (FIX as any).nodes[line].classes[cls][1] as number;
const combos = (r: Record<string, number>) => Object.entries(r).reduce((s, [c, w]) => s + w * (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12), 0);

describe("hand 4922577588: hero's flop range is the blend his preflop answer was read on", () => {
  it("the answer: two fits (SB folded Call 95 / Raise 5; BTN folded Call 83 / Raise 17), blended to Call 95 / Raise 5", async () => {
    fakeGtow(tree66());
    const r = await P.solvePreflopGtowAi(hand66("hr-answer"), null, "test");
    if (!r.ok) throw new Error(r.reason);
    expect(r.fits?.map((f) => f.folds.join("+")).sort()).toEqual(["BTN", "SB"]);
    const m = Object.fromEntries(r.actions.map((a) => [a.action, a.frequency]));
    expect(m.Call).toBeCloseTo(95.44, 1);
    expect((m["Raise 7"] ?? 0) + (m["All-in"] ?? 0)).toBeCloseTo(4.56, 1);
  });

  it("the calling range holds 77 / 88 / AJo / ATs at the blend's call and drops 73s / J2s / A8o to it — not the BTN-folded fit's", async () => {
    fakeGtow(tree66());
    const r = await P.arrivalRangesGtowAi(hand66("hr-range", true), null, 6);
    if (!r.ok) throw new Error(r.reason);
    const bb = r.ranges.BB!;
    // the investigation's numbers (fit-keeps-one-tf2-report.md 1(a)): BTN-folded fit → blend
    expect(callOn("F-F-R2-F-C", "77")).toBeCloseTo(0.04, 2);
    expect(bb["77"]!).toBeCloseTo(0.92, 2);
    expect(callOn("F-F-R2-F-C", "88")).toBe(0);
    expect(bb["88"]!).toBeCloseTo(0.75, 2);
    expect(bb.AJo!).toBeCloseTo(0.98, 2);
    expect(bb.ATs!).toBeCloseTo(0.63, 2);
    expect(bb["99"]!).toBeCloseTo(0.43, 1);
    expect(bb.A9s!).toBeCloseTo(0.61, 1);
    // the blend's call for hands it folds: fold at the most folding fit, the rest called (raise at the least raising)
    expect(callOn("F-F-R2-F-C", "73s")).toBeCloseTo(0.93, 2);
    expect(bb["73s"]!).toBeCloseTo(0.25, 2);
    expect(callOn("F-F-R2-F-C", "J2s")).toBeCloseTo(0.64, 2);
    expect(bb.J2s!).toBeCloseTo(0.08, 2);
    expect(callOn("F-F-R2-F-C", "A8o")).toBeCloseTo(0.66, 2);
    expect(bb.A8o!).toBeCloseTo(0.18, 2);
    // hero's own 66: the answer's call
    expect(bb["66"]!).toBeCloseTo(0.9544, 3);
    // 406.7 combos on the BTN-folded fit, 394.8 on the blend (the investigation's counts)
    expect(combos(bb)).toBeCloseTo(394.8, 0);
    expect(r.note).toContain("LINE FITTED FOR THE RANGES");
    expect(r.note).toContain(`HERO'S OWN RANGE IS THE ANSWER'S: his decision at "F-F-R2-C-C" was read on 2 fits`);
    expect(r.note).toMatch(/406\.\d → 394\.\d combos/);
    // the villains: read as before, each on the line that keeps his own call (pool-calls owns them from here)
    expect(r.ranges.SB).toBeDefined();
    expect(r.ranges.BTN).toBeDefined();
    expect(r.ranges.CO).toBeDefined();
    expect(r.fitted?.folded.sort()).toEqual(["BTN", "SB"]);
  });

  it("the answer and the range agree for hero's own hand, class by class", async () => {
    fakeGtow(tree66());
    for (const cards of [["6h", "6c"], ["7h", "7c"], ["Ah", "Jc"], ["7s", "3s"], ["Jd", "2d"]]) {
      P.resetAiPreflopMemory();
      const id = `hr-agree-${cards.join("")}`;
      const a = await P.solvePreflopGtowAi(hand66(id, false, cards), null, "test");
      if (!a.ok) throw new Error(a.reason);
      const call = a.actions.find((x) => x.action === "Call")?.frequency ?? 0;
      const r = await P.arrivalRangesGtowAi(hand66(id, true, cards), null, 6);
      if (!r.ok) throw new Error(r.reason);
      const cls = a.heroClass!;
      expect((r.ranges.BB![cls] ?? 0) * 100).toBeCloseTo(call, 1);      // the answer rounds to 0.01%
    }
  });

  it("HERO_RANGE_AS_ANSWERED=off: the single fit, as before — the BTN-folded fit's call, no note", async () => {
    process.env.HERO_RANGE_AS_ANSWERED = "off";
    fakeGtow(tree66());
    const r = await P.arrivalRangesGtowAi(hand66("hr-off", true), null, 6);
    if (!r.ok) throw new Error(r.reason);
    for (const cls of ["77", "88", "AJo", "73s", "J2s", "A8o", "66"]) {
      const w = callOn("F-F-R2-F-C", cls);
      if (w > 0) expect(r.ranges.BB![cls]!).toBeCloseTo(w, 6); else expect(r.ranges.BB![cls]).toBeUndefined();
    }
    expect(r.note).not.toContain("HERO'S OWN RANGE");
    expect(combos(r.ranges.BB!)).toBeCloseTo(406.7, 0);
  });

  it("switch off is byte-identical to the switch on minus hero's seat and the note", async () => {
    fakeGtow(tree66());
    process.env.HERO_RANGE_AS_ANSWERED = "off";
    const off = await P.arrivalRangesGtowAi(hand66("hr-same", true), null, 6);
    P.resetAiPreflopMemory();
    delete process.env.HERO_RANGE_AS_ANSWERED;
    const on = await P.arrivalRangesGtowAi(hand66("hr-same", true), null, 6);
    if (!off.ok || !on.ok) throw new Error("refused");
    for (const p of ["CO", "BTN", "SB"]) expect(on.ranges[p]).toEqual(off.ranges[p]!);
    expect(on.note!.startsWith(off.note!)).toBe(true);
    expect(on.fitted).toEqual(off.fitted!);
  });

  it("a HERO SELF-LOCKED hand keeps the single fit and says so", async () => {
    fakeGtow(tree66());
    const h = hand66("hr-selflock", true);
    // the pin of a self-locked answer (gtowAiPreflop.heroSelfLock: his own action at the root of his line locked)
    PIN.setPreflopPin({
      piece: "gtow-ai-preflop", handKey: "hr-selflock", solId: "sol-locked", shape: {} as any, codes: ["F", "F", "R2", "C", "F"], rawTokens: ["F", "F", "R2", "C", "C"],
      warm: null, id: "test", heroPos: "BB", reduced: null, actionIndex: 7, at: Date.now(), heroSelfLock: "F-F-R2-C-F",
    }, "6h6c");
    const r = await P.arrivalRangesGtowAi(h, null, 6);
    if (!r.ok) throw new Error(r.reason);
    expect(r.ranges.BB!["77"]!).toBeCloseTo(callOn("F-F-R2-F-C", "77"), 6);
    expect(combos(r.ranges.BB!)).toBeCloseTo(406.7, 0);
    expect(r.note).not.toContain("HERO'S OWN RANGE IS THE ANSWER'S");
    expect(r.note).toContain("Hero's own range is read on one fit like the others: his preflop answer was read on a tree where his own action at \"F-F-R2-C-F\" was node-locked (hero self-lock)");
  });
});

describe("one fit: the range is the node the answer was read on", () => {
  it("the only on-path fit IS the earliest-caller fit: the range is byte-identical to the single-fit read", async () => {
    // the SB's flat (BTN folded) is 0.05% of his range: only the SB-folded fit is on the path… and the old read folds
    // the EARLIEST caller (BTN) — so make the BTN's cold-call the off-path one instead: the earliest-caller fit is the
    // answer's only fit
    fakeGtow(tree66({ btnCall: 0.0005 }));
    process.env.HERO_RANGE_AS_ANSWERED = "off";
    const off = await P.arrivalRangesGtowAi(hand66("hr-one-same", true), null, 6);
    P.resetAiPreflopMemory();
    delete process.env.HERO_RANGE_AS_ANSWERED;
    const on = await P.arrivalRangesGtowAi(hand66("hr-one-same", true), null, 6);
    if (!off.ok || !on.ok) throw new Error("refused");
    expect(on.ranges).toEqual(off.ranges);
    expect(on.note).toBe(off.note);
    expect(on.ranges.BB!["77"]!).toBeCloseTo(callOn("F-F-R2-F-C", "77"), 9);
  });

  it("the only on-path fit is NOT the earliest-caller fit: hero's range follows the answer's fit", async () => {
    // the SB's flat behind a folded BTN is off the tree's path: the answer reads the SB-folded fit (BTN kept) alone,
    // the old read folded the BTN — the range now agrees with the answer
    fakeGtow(tree66({ sbCall: 0.0005 }));
    const a = await P.solvePreflopGtowAi(hand66("hr-one-diff"), null, "test");
    if (!a.ok) throw new Error(a.reason);
    expect(a.fits?.map((f) => f.folds.join("+"))).toEqual(["SB"]);
    const r = await P.arrivalRangesGtowAi(hand66("hr-one-diff", true), null, 6);
    if (!r.ok) throw new Error(r.reason);
    for (const cls of ["66", "77", "88", "AJo", "73s", "J2s"]) {
      const w = callOn("F-F-R2-C-F", cls);
      if (w > 0) expect(r.ranges.BB![cls]!).toBeCloseTo(w, 9); else expect(r.ranges.BB![cls]).toBeUndefined();
    }
    expect(r.note).toContain(`HERO'S OWN RANGE IS THE ANSWER'S: his decisions are read at the nodes his answer was read on ("F-F-R2-C-C" with SB folded)`);
  });
});

describe("readFitNodes: the answer's fits, one rule", () => {
  it("returns the fits the answer blends, off-path ones left out", async () => {
    fakeGtow(tree66({ sbCall: 0.0005 }));
    const h = hand66("hr-rfn");
    const shape = P.shapeOf(h, null);
    if ("error" in shape) throw new Error(shape.error);
    const a = await P.solvePreflopGtowAi(h, null, "test");
    if (!a.ok) throw new Error(a.reason);
    const { tokens } = P.lineOf(h, shape);
    const use = await P.readFitNodes(a.solId, tokens, a.shape);
    expect(use.map((u) => [u.fit.folds.join("+"), u.fit.line, u.offPath])).toEqual([["SB", "F-F-R2-C-F", false]]);
    expect(a.fits?.map((f) => [f.folds.join("+"), f.line])).toEqual(use.map((u) => [u.fit.folds.join("+"), u.fit.line]));
  });

  it("heroWeightsAsAnswered: per combo, the blended frequency of the action hero took; null when hero folded", async () => {
    fakeGtow(tree66());
    const h = hand66("hr-hwa", true);
    const a = await P.solvePreflopGtowAi(hand66("hr-hwa"), null, "test");
    if (!a.ok) throw new Error(a.reason);
    const { tokens } = P.lineOf(h, a.shape);
    const w = await P.heroWeightsAsAnswered(a.solId, tokens, a.shape);
    expect(w?.blended).toBe(2);
    expect(w?.reads).toEqual([{ at: "F-F-R2-C-C", token: "C", fits: expect.arrayContaining([["SB"], ["BTN"]]) }]);
    const i77 = COMBOS.findIndex((c) => c.cls === "77");
    expect(w!.weights[i77]!).toBeCloseTo(0.9197, 3);
    const folded = await P.heroWeightsAsAnswered(a.solId, [...tokens.slice(0, -1), "F"], a.shape);
    expect(folded).toBeNull();
  });
});
