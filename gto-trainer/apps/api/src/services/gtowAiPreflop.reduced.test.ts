import { afterEach, describe, expect, it } from "bun:test";
import { reducedArrivalRanges, reducedSeams } from "./gtowAiPreflop";
import { POOL_LIMP_CHART } from "./hrc6max";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE REDUCED TREE, end to end over stubbed solves (2026-10-01, hand 4921846667 — utils/reducedArrival). What each
 * caller's tree is built with (the two posts, the dead money, the stacks as dealt, both starting ranges and where
 * they came from), what comes back (ranges on the table's own position names, the table's own line for the pot), what
 * the note says — and what is refused. The live half is scripts/_probeReducedE2e.ts.
 */

const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as const;
const a = (type: string, seatId: number, amount?: number, street = "preflop") =>
  ({ seatId, hero: seatId === 2, type, street, ...(amount != null ? { amount } : {}) });
const hand = (actions: any[], extra: Partial<ParsedHand> = {}): ParsedHand => ({
  handId: 66, clientHandId: "4921846667", bbCents: 5, heroSeatId: 2, heroCards: ["7s", "7c"], board: ["Ks", "9s", "Qd"], street: "flop",
  actions, liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { ...POS },
  stacks: { 1: 73.9, 2: 135.9, 3: 95.5, 4: 28.5, 5: 112.1, 6: 50.5 },
  currentNode: { street: "flop", toActSeatId: 2, toActIsHero: true, pot: 78.2, toCall: 32.6, legalActions: [], complete: false }, ended: false,
  ...extra,
} as unknown as ParsedHand);
const OPENING = [a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("call", 1, 1), a("call", 2, 1), a("raise", 3, 5), a("fold", 4), a("fold", 5)];
const REAL = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("fold", 6), a("call", 1, 12.6), a("bet", 1, 32.6, "flop")]);
const UTG_RERAISES = hand([...OPENING, a("fold", 6), a("raise", 1, 17.6), a("call", 2, 16.6), a("fold", 3)]);
const FOUR = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("call", 3, 12.6), a("call", 6, 12.6), a("call", 1, 12.6)]);
const DEALT = { 1: 91.5, 2: 153.5, 3: 100.5, 4: 28.5, 5: 112.5, 6: 55.5 };
const TOKENS = ["C", "C", "R5", "F", "F", "C", "C", "R17.6", "F", "F", "C"];
const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const WHY = "GTO Wizard AI preflop ranges: token C is not an action at 'C'";

const arr = (v: number | ((cls: string) => number)) => COMBOS.map((c) => (typeof v === "number" ? v : v(c.cls)));
const node = (actor: string, actions: { code: string; allin?: boolean; freq?: number; strategy: number[] }[]) => ({
  data: {
    game: { players: [{ position: actor, is_hero: true }] },
    action_solutions: actions.map((x) => ({
      action: { code: x.code, type: x.code[0] === "R" ? "RAISE" : x.code === "C" ? "CALL" : x.code === "X" ? "CHECK" : "FOLD", allin: !!x.allin },
      total_frequency: x.freq ?? 0, strategy: x.strategy,
    })),
  },
});
/** a chart node: every class folds, the named classes take `action` with these percentages */
const chart = (pos: string, action: string, token: string, pct: Record<string, number>) => ({
  pos, terminal: false, actions: [{ action: "Fold", token: "F" }, { action, token }],
  cells: [...new Set(COMBOS.map((c) => c.cls))].map((h) => ({ hand: h, actions: { Fold: 100 - (pct[h] ?? 0), [action]: pct[h] ?? 0 } })),
});
/** the raiser in position: he checks, then the caller folds `foldOf(class)` and continues with the rest */
const ipTree = (foldOf: (cls: string) => number) => ({
  "": node("SB", [{ code: "X", freq: 0.7, strategy: arr(0.7) }, { code: "R153.5", allin: true, freq: 0.3, strategy: arr(0.3) }]),
  "X": node("BB", [{ code: "F", freq: 0.14, strategy: arr(foldOf) }, { code: "C", freq: 0.2, strategy: arr((c) => (1 - foldOf(c)) * 0.25) }, { code: "R91.5", allin: true, freq: 0.66, strategy: arr((c) => (1 - foldOf(c)) * 0.75) }]),
});
/** the raiser out of position: the caller is at the root */
const oopTree = (foldOf: (cls: string) => number) => ({
  "": node("SB", [{ code: "F", freq: 0.3, strategy: arr(foldOf) }, { code: "R44", freq: 0.7, strategy: arr((c) => 1 - foldOf(c)) }]),
});

const seams0 = { ...reducedSeams };
afterEach(() => { Object.assign(reducedSeams, seams0); });

function rig(nodesFor: (body: any) => Record<string, any>, answers: any[] | null = null) {
  const solves: { key: string; body: any; n: number }[] = [];
  const chartReads: string[] = [];
  reducedSeams.chartNode = async (id: string, line: string) => {
    chartReads.push(`${id}|${line}`);
    if (id === POOL_LIMP_CHART && line === "") return chart("UTG", "Limp", "C", { AQs: 25.45, "77": 17.98, QQ: 17.98, T9s: 10, "72o": 0.5 }) as any;
    if (id === POOL_LIMP_CHART && line === "F-F-F-C") return chart("SB", "Limp", "C", { JTo: 100, "54s": 60 }) as any;
    if (id === "ign200_6max_D100_olimp" && line === "C") return chart("HJ", "Limp", "C", { ATs: 28.79, "77": 12.17, "55": 19.85 }) as any;
    return null;
  };
  reducedSeams.answersFor = () => answers ?? [
    { id: 1, ts: 1, street: "preflop", source: "hrc-6max-preflop", chart: "ign200_6max_D100_olimp", line: "C", pick: "Limp", decision_key: "k1" },
    { id: 2, ts: 2, street: "preflop", source: "hrc-6max-preflop", chart: "ign200_6max_D100_olimp", line: "C", pick: "Limp", decision_key: "k1" },   // the same decision, probed again
    { id: 3, ts: 3, street: "preflop", source: "gtow-ai-preflop", chart: "gtow-ai · 6-handed", line: "F-C-R5-F-F-C", pick: "Raise 17.5", decision_key: "k2" },
  ];
  reducedSeams.solve = async (key: string, body: any, n: number) => {
    solves.push({ key, body, n });
    const nodes = nodesFor(body);
    return { get: async (l: string) => nodes[l] ?? { error: `no node ${l}` } };
  };
  return { solves, chartReads };
}
const playerOf = (body: any, pos: string) => body.players.find((p: any) => p.position === pos);
const sizesOf = (body: any) => Object.fromEntries(body.bet_sizes.street_bet_sizes[0].position_bet_sizes.map((x: any) => [x.position, x.bet_sizes]));
const weightOf = (range: number[], cls: string) => range[COMBOS.findIndex((c) => c.cls === cls)];
/** the exact tree's reading of hero's limp-reraise: 77 half the time, ATs a quarter, 55 never */
const heroRaise = async (pos: string) => (pos === "HJ" ? arr((c) => (c === "77" ? 0.5 : c === "ATs" ? 0.25 : 0)) : null);
const ctx = (extra: Record<string, unknown> = {}) => ({ why: WHY, tokens: TOKENS, seatOrder: SEATS, raiseFilter: heroRaise, ...extra });

describe("reducedArrivalRanges", () => {
  it("hand 4921846667: hero's range from the chart and the exact tree, UTG's the pool limpers who do not fold to the raise", async () => {
    const { solves, chartReads } = rig(() => ipTree((c) => (c === "72o" ? 1 : c === "T9s" ? 0.5 : 0)));
    const r = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx());
    if (!r.ok) throw new Error(r.reason);

    // ONE tree: UTG against the raiser, the raise a forced bet
    expect(solves.length).toBe(1);
    const { body, n, key } = solves[0]!;
    expect(n).toBe(2);
    expect(key.startsWith("reduced|")).toBe(true);
    expect(body.starting_street).toBe("PREFLOP");
    expect(body.pot).toBe(10.4);                               // the dead money as it lay when UTG met the raise
    expect(body.players.map((p: any) => `${p.position} posts ${p.blind} of ${p.stack}`)).toEqual(["SB posts 17.6 of 153.5", "BB posts 5 of 91.5"]);
    expect(sizesOf(body)).toEqual({ SB: [], BB: ["8.8x"] });   // only the caller may put more in first: to ~2.5x the raise (8.8 of his 5)
    expect(body.rake.cap_in_chips).toBeGreaterThan(0);
    // the raiser's range in the tree: the chart's limp (ATs 28.79, 77 12.17, 55 19.85) × the exact tree's raise
    // (ATs 0.25, 77 0.5, 55 0) — 7.2 and 6.1, scaled so the heaviest is 1
    const hero = playerOf(body, "SB").range as number[], utg = playerOf(body, "BB").range as number[];
    expect(weightOf(hero, "ATs")).toBe(1);
    expect(weightOf(hero, "77")).toBeCloseTo((12.17 * 0.5) / (28.79 * 0.25), 3);
    expect(weightOf(hero, "55")).toBe(0);
    // the caller's: the pool's limp range, scaled the same way
    expect(weightOf(utg, "AQs")).toBe(1);
    expect(weightOf(utg, "77")).toBeCloseTo(17.98 / 25.45, 3);
    expect(weightOf(utg, "AA")).toBe(0);
    expect(chartReads).toContain(`${POOL_LIMP_CHART}|`);
    expect(chartReads).toContain("ign200_6max_D100_olimp|C");

    // what comes back
    expect(Object.keys(r.ranges).sort()).toEqual(["HJ", "UTG"]);
    expect(r.ranges.HJ!.ATs).toBeCloseTo(1, 3);
    expect(r.ranges.HJ!["77"]).toBeCloseTo((12.17 * 0.5) / (28.79 * 0.25), 3);
    expect(Object.keys(r.ranges.HJ!).sort()).toEqual(["77", "ATs"]);
    expect(r.ranges.UTG!.AQs).toBeCloseTo(1, 3);               // the solver shoves it — the player called: it stays, in full
    expect(r.ranges.UTG!.T9s).toBeCloseTo((10 / 25.45) * 0.5, 3);
    expect(r.ranges.UTG!["72o"]).toBeUndefined();              // folds
    expect(r.tokens).toEqual(TOKENS);
    expect(r.seatOrder).toEqual(SEATS);
    expect(r.piece).toBe("gtow-ai-preflop");
    expect(r.id).toBe("gtow-ai · reduced · HJ:153.5 raises 17.6 / UTG:91.5");
    expect(r.reduced).toEqual({ why: WHY, live: ["UTG", "HJ"], trees: 1 });
    expect(r.note).toContain("REDUCED TREE");
    expect(r.note).toContain("token C is not an action at 'C'");
    expect(r.note).toContain(`HJ (hero) raised to 17.6bb: his own range as the chart played it (Limp at "C" of ign200_6max_D100_olimp), narrowed by that raise as the exact tree plays it`);
    expect(r.note).toContain("UTG met it for 12.6bb more into a pot of 33bb: the pool's limp range");
    expect(r.note).toContain("his 1 later action before the raise not applied");
    expect(r.note).toContain("the hands that do not fold to it (the tree: fold 14% · call 20% · re-raise 66%)");
    expect(r.note).toContain("the raise as a forced bet and the other 10.4bb as dead money");
  });

  it("refused: a raiser whose raise the exact tree cannot read has no range to put behind it", async () => {
    const { solves } = rig(() => ipTree(() => 0));
    const none = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, { why: WHY, tokens: TOKENS, seatOrder: SEATS });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toContain("HJ's raise to 17.6bb cannot be read on the exact tree (the line up to it does not fit");
    const zero = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx({ raiseFilter: async () => arr(0) }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.reason).toContain("none of his starting range makes it there");
    expect(solves.length).toBe(0);                             // nothing was solved for a spot that is refused
  });

  it("hero's own hand is never left out of his range", async () => {
    rig(() => ipTree(() => 0));
    const r = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx({ raiseFilter: async () => arr((c) => (c === "ATs" ? 1 : 0)) }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.ranges.HJ!["77"]).toBe(0.05);
    expect(r.note).toContain("Hero's 77 was not in the range read for his line and is kept at 5%");
  });

  it("the limper re-raises and hero calls: his call is read on the exact tree when it holds his line — no tree is solved", async () => {
    const { solves } = rig(() => oopTree(() => 0.5));
    const asked: string[] = [];
    const r = await reducedArrivalRanges(UTG_RERAISES, "HJ", 6, DEALT, {
      why: WHY, tokens: ["C", "C", "R5", "F", "F", "F", "R17.6", "C", "F"], seatOrder: SEATS,
      raiseFilter: async (pos) => { asked.push(`raise ${pos}`); return arr((c) => (c === "QQ" ? 1 : c === "AQs" ? 0.2 : 0)); },
      callFilter: async (pos) => { asked.push(`call ${pos}`); return arr((c) => (c === "77" ? 0.8 : 0.1)); },
    });
    if (!r.ok) throw new Error(r.reason);
    expect(asked).toEqual(["raise UTG", "call HJ"]);
    expect(solves.length).toBe(0);
    // UTG: the pool's limp range × the exact tree's limp-reraise — a narrow range, not every hand he limps
    expect(Object.keys(r.ranges.UTG!).sort()).toEqual(["AQs", "QQ"]);
    expect(r.ranges.UTG!.QQ).toBeCloseTo(1, 3);
    expect(r.ranges.UTG!.AQs).toBeCloseTo((25.45 * 0.2) / 17.98, 3);
    // hero: the chart's limp × his call as the exact tree plays it
    expect(r.ranges.HJ!["77"]).toBeCloseTo(1, 3);              // 12.17 × 0.8 = 9.7, the heaviest
    expect(r.ranges.HJ!.ATs).toBeCloseTo((28.79 * 0.1) / (12.17 * 0.8), 3);
    expect(r.reduced?.trees).toBe(0);
    expect(r.note).toContain("HJ (hero) met it for 16.6bb more into a pot of 25bb");
    expect(r.note).toContain("then his call as the exact tree plays it");
  });

  it("… and on his own forced-raise tree when it cannot: the raiser out of position, hero at the root", async () => {
    const { solves } = rig(() => oopTree((c) => (c === "55" ? 1 : 0.25)));
    const r = await reducedArrivalRanges(UTG_RERAISES, "HJ", 6, DEALT, {
      why: WHY, tokens: ["C", "C", "R5", "F", "F", "F", "R17.6", "C", "F"], seatOrder: SEATS,
      raiseFilter: async () => arr((c) => (c === "QQ" ? 1 : 0)), callFilter: async () => null,
    });
    if (!r.ok) throw new Error(r.reason);
    expect(solves.length).toBe(1);
    const { body } = solves[0]!;
    expect(body.players.map((p: any) => `${p.position} posts ${p.blind} of ${p.stack}`)).toEqual(["SB posts 1 of 153.5", "BB posts 17.6 of 91.5"]);
    expect(body.pot).toBe(6.4);
    expect(sizesOf(body)).toEqual({ SB: ["2.5x"], BB: [] });
    expect(r.ranges.HJ!.ATs).toBeCloseTo(0.75, 3);
    expect(r.ranges.HJ!["55"]).toBeUndefined();
    expect(r.ranges.HJ!["77"]).toBeCloseTo((12.17 / 28.79) * 0.75, 3);
  });

  it("four to the flop: a tree per caller, each at its own price, every live seat with a range", async () => {
    const { solves } = rig((body) => (playerOf(body, "SB").blind === 17.6 ? ipTree(() => 0.5) : oopTree(() => 0.25)));
    const asked: string[] = [];
    const before = async (pos: string) => { asked.push(pos); return pos === "BB" ? arr((c) => (c === "JJ" ? 0.5 : c === "A5s" ? 0.25 : 0)) : null; };
    const r = await reducedArrivalRanges(FOUR, "HJ", 6, DEALT, ctx({ before }));
    if (!r.ok) throw new Error(r.reason);
    expect(solves.length).toBe(3);
    // by the dead money each caller met: the CO called first (10.4), then the BB (23), then UTG (35.6)
    expect(solves.map((s) => s.body.pot).sort((x, y) => x - y)).toEqual([10.4, 23, 35.6]);
    const co = solves.find((s) => s.body.pot === 10.4)!.body;
    expect(co.players.map((p: any) => `${p.position} posts ${p.blind} of ${p.stack}`)).toEqual(["SB posts 5 of 100.5", "BB posts 17.6 of 153.5"]);   // the CO acts after hero on the flop
    const bb = solves.find((s) => s.body.pot === 23)!.body;
    expect(bb.players.map((p: any) => `${p.position} posts ${p.blind} of ${p.stack}`)).toEqual(["SB posts 17.6 of 153.5", "BB posts 5 of 55.5"]);
    // the same raiser's range in every tree
    for (const s of solves) expect(playerOf(s.body, s.body.players.find((p: any) => p.blind === 17.6).position).range).toEqual(playerOf(solves[0]!.body, solves[0]!.body.players.find((p: any) => p.blind === 17.6).position).range);
    // starting ranges: UTG limped (the pool's); the BB and the CO did not come in limping — the exact tree's reading, or the full range
    expect(asked.sort()).toEqual(["BB", "CO"]);
    expect(weightOf(playerOf(bb, "BB").range, "JJ")).toBe(1);
    expect(playerOf(co, "SB").range).toBeNull();
    expect(Object.keys(r.ranges).sort()).toEqual(["BB", "CO", "HJ", "UTG"]);
    expect(r.ranges.BB!.JJ).toBeCloseTo(0.5, 3);
    expect(r.ranges.CO!.AA).toBeCloseTo(0.75, 3);
    expect(r.ranges.UTG!.AQs).toBeCloseTo(0.5, 3);
    expect(r.reduced).toEqual({ why: WHY, live: ["BB", "UTG", "HJ", "CO"], trees: 3 });
    expect(r.note).toContain("the other callers when one is read");
    // capped by what the caller can use
    const capped = await reducedArrivalRanges(FOUR, "HJ", 3, DEALT, ctx());
    expect(capped.ok).toBe(false);
  });

  it("a caller all in for less than the raise is not solved for: his range before the raise stands whole", async () => {
    const short = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("fold", 6), a("all-in", 1, 12)]);
    const { solves } = rig(() => ipTree(() => 0.9));
    const r = await reducedArrivalRanges(short, "HJ", 6, { ...DEALT, 1: 12 }, ctx());
    if (!r.ok) throw new Error(r.reason);
    expect(solves.length).toBe(0);
    expect(r.ranges.UTG!.AQs).toBeCloseTo(1, 3);
    expect(r.ranges.UTG!["77"]).toBeCloseTo(17.98 / 25.45, 3);
    expect(r.reduced?.trees).toBe(0);
    expect(r.note).toContain("UTG met it for 7bb more into a pot of 33bb");
    expect(r.note).toContain("taken as not folding (all in for 7bb more)");
  });

  it("a caller the tree folds entirely keeps his starting range — he did not fold", async () => {
    rig(() => ipTree(() => 1));
    const r = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx());
    if (!r.ok) throw new Error(r.reason);
    expect(r.ranges.UTG!.AQs).toBeCloseTo(1, 3);
    expect(r.note).toContain("UTG: the tree folds everything he starts with, so his starting range stands.");
  });

  it("no chart answer on record for hero's limp: the pool's limp range stands in, and says so", async () => {
    const { solves } = rig(() => ipTree(() => 0), []);
    const r = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx({ raiseFilter: async () => arr(0.5) }));
    if (!r.ok) throw new Error(r.reason);
    expect(weightOf(playerOf(solves[0]!.body, "SB").range, "AQs")).toBe(1);
    expect(r.note).toContain("HJ (hero) raised to 17.6bb: the pool's limp range");
  });

  it("refuses with the reason: a solve that fails, a line with no raise, hero not in the hand", async () => {
    rig(() => ({}));
    reducedSeams.solve = async () => ({ error: "primary: no token" });
    const down = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx());
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.reason).toBe("primary: no token");
    const limped = hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("call", 1, 1), a("call", 2, 1), a("fold", 3), a("fold", 4), a("fold", 5), a("check", 6)]);
    const noRaise = await reducedArrivalRanges(limped, "HJ", 6, DEALT, ctx());
    expect(noRaise.ok).toBe(false);
    if (!noRaise.ok) expect(noRaise.reason).toContain("nobody raised");
    const heroOut = hand([...OPENING.slice(0, 3), a("fold", 2), a("raise", 3, 5), a("fold", 4), a("fold", 5), a("fold", 6), a("call", 1, 4)]);
    const gone = await reducedArrivalRanges(heroOut, "HJ", 6, DEALT, ctx());
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toContain("hero is not among the players who reach the flop");
    // a tree that comes back without the caller's node
    rig(() => ({ "": node("SB", [{ code: "X", strategy: arr(1) }]) }));
    const broken = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx());
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toContain("reduced tree (UTG): the node behind the raiser's check");
  });
});
