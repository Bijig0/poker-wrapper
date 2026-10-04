import { afterEach, describe, expect, it } from "bun:test";
import { reducedArrivalRanges, reducedSeams } from "./gtowAiPreflop";
import { POOL_LIMP_CHART } from "./hrc6max";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE REDUCED TREE, end to end over stubbed reads (2026-10-01, hand 4921846667 — utils/reducedArrival; the caller read
 * on the exact tree since 2026-10-04). Where each range starts (the chart, the pool's limp range, the exact tree), how
 * each caller is read (hero's call, a limper kept whole, a villain's answer walked on the exact tree), what comes back
 * (ranges on the table's own position names, the table's own line for the pot), what the note says — and what is
 * refused. Nothing is solved here: every read is a ctx closure (lastRaiseReads in the live path).
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
/** a chart node: every class folds, the named classes take `action` with these percentages */
const chart = (pos: string, action: string, token: string, pct: Record<string, number>) => ({
  pos, terminal: false, actions: [{ action: "Fold", token: "F" }, { action, token }],
  cells: [...new Set(COMBOS.map((c) => c.cls))].map((h) => ({ hand: h, actions: { Fold: 100 - (pct[h] ?? 0), [action]: pct[h] ?? 0 } })),
});

const seams0 = { ...reducedSeams };
afterEach(() => { Object.assign(reducedSeams, seams0); });

function rig(answers: any[] | null = null) {
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
  return { chartReads };
}
/** the exact tree's reading of hero's limp-reraise: 77 half the time, ATs a quarter, 55 never */
const heroRaise = async (pos: string) => (pos === "HJ" ? arr((c) => (c === "77" ? 0.5 : c === "ATs" ? 0.25 : 0)) : null);
/** a stayRange stub that records who was asked */
const stays = (by: Record<string, { range: number[]; folded: string[] } | null>, asked: string[] = []) =>
  async (pos: string) => { asked.push(pos); return by[pos] ?? null; };
const ctx = (extra: Record<string, unknown> = {}) => ({ why: WHY, tokens: TOKENS, seatOrder: SEATS, raiseFilter: heroRaise, ...extra });

describe("reducedArrivalRanges", () => {
  it("hand 4921846667: hero's range from the chart and the exact tree; UTG limped in, so the pool's limp range stands whole", async () => {
    const { chartReads } = rig();
    const asked: string[] = [];
    const r = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx({ stayRange: stays({}, asked) }));
    if (!r.ok) throw new Error(r.reason);
    expect(asked).toEqual([]);                                 // a limper is not read at all
    expect(chartReads).toContain(`${POOL_LIMP_CHART}|`);
    expect(chartReads).toContain("ign200_6max_D100_olimp|C");
    expect(Object.keys(r.ranges).sort()).toEqual(["HJ", "UTG"]);
    // hero: the chart's limp (ATs 28.79, 77 12.17, 55 19.85) × the exact tree's raise (ATs 0.25, 77 0.5, 55 0)
    expect(r.ranges.HJ!.ATs).toBeCloseTo(1, 3);
    expect(r.ranges.HJ!["77"]).toBeCloseTo((12.17 * 0.5) / (28.79 * 0.25), 3);
    expect(Object.keys(r.ranges.HJ!).sort()).toEqual(["77", "ATs"]);
    // UTG: the pool's limp range, scaled so the heaviest is 1 — nothing taken out
    expect(r.ranges.UTG!.AQs).toBeCloseTo(1, 3);
    expect(r.ranges.UTG!.T9s).toBeCloseTo(10 / 25.45, 3);
    expect(r.ranges.UTG!["72o"]).toBeCloseTo(0.5 / 25.45, 3);
    expect(r.tokens).toEqual(TOKENS);
    expect(r.seatOrder).toEqual(SEATS);
    expect(r.piece).toBe("gtow-ai-preflop");
    expect(r.id).toBe("gtow-ai · reduced · HJ:153.5 raises 17.6 / UTG:91.5");
    expect(r.reduced).toEqual({ why: WHY, live: ["UTG", "HJ"], fitted: 0 });
    expect(r.note).toContain("REDUCED TREE");
    expect(r.note).toContain("token C is not an action at 'C'");
    expect(r.note).toContain(`HJ (hero) raised to 17.6bb: his own range as the chart played it (Limp at "C" of ign200_6max_D100_olimp), narrowed by that raise as the exact tree plays it`);
    expect(r.note).toContain("UTG met it for 12.6bb more into a pot of 33bb: the pool's limp range (shown limps, as the pool-locked limp chart holds it) — his 1 later action before the raise not applied, kept whole — a limper's call of the raise is not narrowed");
    expect(r.note).toContain("A limper's range is the pool's whole limp range, wide by design");
    expect(r.note).not.toContain("forced bet");
    expect(r.note).not.toContain("still read WIDE");             // nobody was read on a fitted line
  });

  it("refused: a raiser whose raise the exact tree cannot read has no range to put behind it", async () => {
    rig();
    const none = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, { why: WHY, tokens: TOKENS, seatOrder: SEATS });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toContain("HJ's raise to 17.6bb cannot be read on the exact tree (the line up to it does not fit");
    const zero = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx({ raiseFilter: async () => arr(0) }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.reason).toContain("none of his starting range makes it there");
  });

  it("hero's own hand is never left out of his range", async () => {
    rig();
    const r = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx({ raiseFilter: async () => arr((c) => (c === "ATs" ? 1 : 0)) }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.ranges.HJ!["77"]).toBe(0.05);
    expect(r.note).toContain("Hero's 77 was not in the range read for his line and is kept at 5%");
  });

  it("the limper re-raises and hero calls: his call is read on the exact tree when it holds his line", async () => {
    rig();
    const asked: string[] = [];
    const r = await reducedArrivalRanges(UTG_RERAISES, "HJ", 6, DEALT, {
      why: WHY, tokens: ["C", "C", "R5", "F", "F", "F", "R17.6", "C", "F"], seatOrder: SEATS,
      raiseFilter: async (pos) => { asked.push(`raise ${pos}`); return arr((c) => (c === "QQ" ? 1 : c === "AQs" ? 0.2 : 0)); },
      callFilter: async (pos) => { asked.push(`call ${pos}`); return arr((c) => (c === "77" ? 0.8 : 0.1)); },
      stayRange: async (pos) => { asked.push(`stay ${pos}`); return null; },
    });
    if (!r.ok) throw new Error(r.reason);
    expect(asked).toEqual(["raise UTG", "call HJ"]);           // hero is never read by stayRange
    // UTG: the pool's limp range × the exact tree's limp-reraise — a narrow range, not every hand he limps
    expect(Object.keys(r.ranges.UTG!).sort()).toEqual(["AQs", "QQ"]);
    expect(r.ranges.UTG!.QQ).toBeCloseTo(1, 3);
    expect(r.ranges.UTG!.AQs).toBeCloseTo((25.45 * 0.2) / 17.98, 3);
    // hero: the chart's limp × his call as the exact tree plays it
    expect(r.ranges.HJ!["77"]).toBeCloseTo(1, 3);              // 12.17 × 0.8 = 9.7, the heaviest
    expect(r.ranges.HJ!.ATs).toBeCloseTo((28.79 * 0.1) / (12.17 * 0.8), 3);
    expect(r.reduced?.fitted).toBe(0);
    expect(r.note).toContain("HJ (hero) met it for 16.6bb more into a pot of 25bb");
    expect(r.note).toContain("then his call as the exact tree plays it");
  });

  it("… and when it cannot: hero's starting range stands whole (no other read), the floor still holds his hand", async () => {
    rig();
    const r = await reducedArrivalRanges(UTG_RERAISES, "HJ", 6, DEALT, {
      why: WHY, tokens: ["C", "C", "R5", "F", "F", "F", "R17.6", "C", "F"], seatOrder: SEATS,
      raiseFilter: async () => arr((c) => (c === "QQ" ? 1 : 0)), callFilter: async () => null,
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.ranges.HJ!.ATs).toBeCloseTo(1, 3);
    expect(r.ranges.HJ!["77"]).toBeCloseTo(12.17 / 28.79, 3);
    expect(r.ranges.HJ!["55"]).toBeCloseTo(19.85 / 28.79, 3);
    expect(r.note).toContain("kept whole — the exact tree cannot read his call");
  });

  it("four to the flop: each villain caller read on the exact tree, the limper kept whole, every live seat with a range", async () => {
    rig();
    const asked: string[] = [], before: string[] = [];
    const r = await reducedArrivalRanges(FOUR, "HJ", 6, DEALT, ctx({
      before: async (pos: string) => { before.push(pos); return pos === "BB" ? arr((c) => (c === "JJ" ? 0.5 : c === "A5s" ? 0.25 : 0)) : null; },
      stayRange: stays({
        BB: { range: arr((c) => (c === "JJ" ? 0.4 : c === "A5s" ? 0.1 : c === "72o" ? 0 : 0.02)), folded: ["UTG"] },
        CO: { range: arr((c) => (c === "AA" ? 0.3 : c === "KQs" ? 0.2 : 0)), folded: [] },
      }, asked),
    }));
    if (!r.ok) throw new Error(r.reason);
    expect(asked.sort()).toEqual(["BB", "CO"]);                // UTG limped: not read
    expect(Object.keys(r.ranges).sort()).toEqual(["BB", "CO", "HJ", "UTG"]);
    // the walked range is HIS range: scaled so the heaviest is 1, the starting range (`before`) not multiplied in again
    expect(r.ranges.BB!.JJ).toBeCloseTo(1, 3);
    expect(r.ranges.BB!.A5s).toBeCloseTo(0.25, 3);
    expect(r.ranges.BB!["72o"]).toBeUndefined();
    expect(r.ranges.BB!.KQo).toBeCloseTo(0.05, 3);
    expect(r.ranges.CO!.AA).toBeCloseTo(1, 3);
    expect(r.ranges.CO!.KQs).toBeCloseTo(0.2 / 0.3, 3);
    expect(r.ranges.UTG!.AQs).toBeCloseTo(1, 3);               // the pool's limp range, whole
    expect(r.ranges.UTG!["72o"]).toBeCloseTo(0.5 / 25.45, 3);
    expect(r.reduced).toEqual({ why: WHY, live: ["BB", "UTG", "HJ", "CO"], fitted: 2 });
    expect(r.note).toContain("BB met it for 12.6bb more into a pot of 45.6bb: his range on the exact tree, walked on the line fitted for him (UTG folded out), less the hands that fold to the raise at his node there");
    expect(r.note).toContain("CO met it for 12.6bb more into a pot of 33bb: his range on the exact tree through his own node, less the hands that fold to the raise there");
    expect(r.note).toContain("A caller read on a fitted line is still read WIDE");
    // capped by what the caller can use
    const capped = await reducedArrivalRanges(FOUR, "HJ", 3, DEALT, ctx());
    expect(capped.ok).toBe(false);
  });

  it("a villain caller the exact tree cannot read keeps his starting range whole, and the note says why", async () => {
    rig();
    const before = async (pos: string) => (pos === "BB" ? arr((c) => (c === "JJ" ? 0.5 : c === "A5s" ? 0.25 : 0)) : null);
    const r = await reducedArrivalRanges(FOUR, "HJ", 6, DEALT, ctx({ before, stayRange: stays({ CO: { range: arr(0), folded: [] } }) }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.ranges.BB!.JJ).toBeCloseTo(1, 3);                 // `before`, scaled: JJ 0.5 → 1, A5s 0.25 → 0.5
    expect(r.ranges.BB!.A5s).toBeCloseTo(0.5, 3);
    expect(r.note).toContain("BB met it for 12.6bb more into a pot of 45.6bb: his range on the exact tree up to the raise, kept whole — the exact tree could not read his answer to the raise, even on a line fitted for him");
    expect(r.ranges.CO!.AA).toBeCloseTo(1, 3);                 // the full range: the tree folds all of it, he did not fold
    expect(r.note).toContain("CO met it for 12.6bb more into a pot of 33bb: the full range (his earlier action is not modelled), kept whole — on the exact tree every hand he holds there folds to the raise, and he did not fold");
    expect(r.reduced?.fitted).toBe(0);
    // no stayRange at all (an older caller of this function): the same
    const bare = await reducedArrivalRanges(FOUR, "HJ", 6, DEALT, ctx({ before }));
    if (!bare.ok) throw new Error(bare.reason);
    expect(bare.ranges.BB!.A5s).toBeCloseTo(0.5, 3);
  });

  it("a caller all in for less than the raise is not read: his range before the raise stands whole", async () => {
    // the BB, not a limper: he called the iso (4), then shoved 12 total over hero's 17.6 — all in for less
    const short = hand([...OPENING, a("call", 6, 4), a("fold", 1), a("raise", 2, 17.6), a("fold", 3), a("all-in", 6, 12)]);
    rig();
    const asked: string[] = [];
    const r = await reducedArrivalRanges(short, "HJ", 6, { ...DEALT, 6: 12 }, ctx({
      before: async (pos: string) => (pos === "BB" ? arr((c) => (c === "JJ" ? 1 : c === "A5s" ? 0.5 : 0)) : null),
      stayRange: stays({}, asked),
    }));
    if (!r.ok) throw new Error(r.reason);
    expect(asked).toEqual([]);
    expect(r.ranges.BB!.JJ).toBeCloseTo(1, 3);
    expect(r.ranges.BB!.A5s).toBeCloseTo(0.5, 3);
    expect(r.note).toContain("BB met it for 7bb more into a pot of 29bb");
    expect(r.note).toContain("kept whole — taken as not folding (all in for 7bb more)");
  });

  it("no chart answer on record for hero's limp: the pool's limp range stands in, and says so", async () => {
    rig([]);
    const r = await reducedArrivalRanges(REAL, "HJ", 6, DEALT, ctx({ raiseFilter: async () => arr(0.5) }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.ranges.HJ!.AQs).toBeCloseTo(1, 3);
    expect(r.note).toContain("HJ (hero) raised to 17.6bb: the pool's limp range");
  });

  it("refuses with the reason: a line with no raise, hero not in the hand", async () => {
    rig();
    const limped = hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("call", 1, 1), a("call", 2, 1), a("fold", 3), a("fold", 4), a("fold", 5), a("check", 6)]);
    const noRaise = await reducedArrivalRanges(limped, "HJ", 6, DEALT, ctx());
    expect(noRaise.ok).toBe(false);
    if (!noRaise.ok) expect(noRaise.reason).toContain("nobody raised");
    const heroOut = hand([...OPENING.slice(0, 3), a("fold", 2), a("raise", 3, 5), a("fold", 4), a("fold", 5), a("fold", 6), a("call", 1, 4)]);
    const gone = await reducedArrivalRanges(heroOut, "HJ", 6, DEALT, ctx());
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toContain("hero is not among the players who reach the flop");
  });
});
