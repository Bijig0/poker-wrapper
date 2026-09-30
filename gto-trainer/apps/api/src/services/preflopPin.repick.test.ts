import { describe, expect, it } from "bun:test";
import { resumeChartPreflopRanges, repickVillainRanges, chart6State, type ChartPreflopPin, type AiPreflopPin, type ResumedRanges, type RepickDeps } from "./preflopPin";
import { resolveChart6max, type Chart6Choice } from "./hrc6max";
import type { RawNode } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE VILLAINS' RANGES RE-PICKED (round 2.1, Brady 2026-09-25). The pin stays the rule; the villains' flop-entering
 * ranges move to the exact chart for the line as played only when (a) the pinned uneven chart's short seat folded, or
 * (b) the open was played at a size the set has its own chart for. Hero's range never moves. Synthetic charts, the
 * node getter and the chart resolver injected — no SQLite, no network.
 */

type Cells = Record<string, Record<string, number>>;
const node = (pos: string, actions: [string, string][], cells: Cells = {}): RawNode =>
  ({ pos, terminal: false, actions: actions.map(([action, token]) => ({ action, token })), cells: Object.entries(cells).map(([hand, a]) => ({ hand, actions: a })) });
const end = (pos: string): RawNode => ({ pos, terminal: true, actions: [], cells: [] });
const FR = (n: string): [string, string][] => [["Fold", "F"], [`Raise ${n}`, `R${n}`]];
const FCR = (n: string): [string, string][] => [["Fold", "F"], ["Call", "C"], [`Raise ${n}`, `R${n}`]];

type Charts = Record<string, Record<string, RawNode>>;
const depsFor = (charts: Charts, calls: string[] = []): Required<RepickDeps> => ({
  resolve: async (c: Chart6Choice) => { calls.push(c.id); return resolveChart6max(c, async (src, line) => (charts[src]?.[line] ?? null) as never); },
  getFor: (id) => async (line) => charts[id]?.[line] ?? null,
});

const a = (seatId: number, type: string, amount?: number, hero = false) =>
  ({ seatId, hero, type, street: "preflop", ...(amount != null ? { amount } : {}) }) as ParsedHand["actions"][number];
function flopHand(key: string, heroSeatId: number, positions: Record<number, string>, pre: ParsedHand["actions"]): ParsedHand {
  return {
    handId: 1, clientHandId: key, bbCents: 200, heroSeatId, heroCards: ["5h", "6h"], board: ["2c", "7d", "Ks"], street: "flop",
    actions: pre, liveSeats: Object.keys(positions).map(Number), committed: {}, potByStreet: {}, positions, stacks: {},
    currentNode: { street: "flop", toActSeatId: heroSeatId, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false }, ended: false,
  };
}
const resume = async (pin: ChartPreflopPin, hand: ParsedHand, heroPos: string, charts: Charts): Promise<ResumedRanges> => {
  const r = await resumeChartPreflopRanges(pin, hand, heroPos, async (l) => charts[pin.chartId]?.[l] ?? null);
  if (!r.ok) throw new Error(r.why);
  return r;
};

// ---- (a) hand 4920395179: five-handed, HJ (hero) opens 2.6, CO calls, the 78bb BTN (modelled) folds, SB folds, the 30bb BB calls
const P5 = { 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
const hand179 = flopHand("r21-179", 2, P5, [a(5, "post-sb", 0.4), a(6, "post-bb", 1), a(2, "raise", 2.6, true), a(3, "call", 2.6), a(4, "fold"), a(5, "fold"), a(6, "call", 1.6)]);
const dealt179 = { 2: 101, 3: 101.2, 4: 78.2, 5: 98, 6: 30 };
const PIN_179 = "ign200_6max_D100_s70_BTN_o2_5", EXACT_179 = "ign200_6max_D100_s30_BB_o2_5";
const line179 = (hj: Cells, co: Cells, bb: Cells): Record<string, RawNode> => ({
  "": node("UTG", FR("2.5")),
  "F": node("HJ", FR("2.5"), hj),
  "F-R2.5": node("CO", FCR("8"), co),
  "F-R2.5-C": node("BTN", FCR("10")),
  "F-R2.5-C-F": node("SB", FCR("11")),
  "F-R2.5-C-F-F": node("BB", FCR("12"), bb),
  "F-R2.5-C-F-F-C": end("BB"),
});
const charts179: Charts = {
  [PIN_179]: line179({ "56s": { "Raise 2.5": 98, Fold: 2 }, AJs: { "Raise 2.5": 100 } }, { "99": { Call: 75, "Raise 8": 25 } }, { AJs: { Call: 10, "Raise 12": 90 }, KQo: { Call: 40, Fold: 60 } }),
  [EXACT_179]: line179({ "56s": { "Raise 2.5": 50, Fold: 50 }, AJs: { "Raise 2.5": 100 } }, { "99": { Call: 45, "Raise 8": 55 } }, { AJs: { Call: 96, "Raise 12": 4 }, KQo: { Call: 100 } }),
};
const pin179: ChartPreflopPin = { piece: "chart6max", handKey: "r21-179", chartId: PIN_179, rawTokens: ["F"], codes: ["F"], heroPos: "HJ", depth: 100, actionIndex: 2, at: 0 };

describe("repickVillainRanges — trigger (a): the pinned chart's modelled short folded", () => {
  it("another short continues: the villains are read on that short's chart, hero stays on the pin (hand 4920395179)", async () => {
    const resumed = await resume(pin179, hand179, "HJ", charts179);
    expect(resumed.ranges.BB!.AJs).toBeCloseTo(0.1, 6);                        // the pinned chart's BB
    const r = await repickVillainRanges(pin179, hand179, "HJ", resumed, dealt179, depsFor(charts179));
    if (!r) throw new Error("no re-pick");
    expect(r.id).toBe(EXACT_179);
    expect(r.seats).toEqual(["CO", "BB"]);
    expect(r.kept).toEqual([]);
    expect(r.ranges.BB!.AJs).toBeCloseTo(0.96, 6);                              // the BB-short chart's BB
    expect(r.ranges.BB!.KQo).toBeCloseTo(1, 6);
    expect(r.ranges.CO!["99"]).toBeCloseTo(0.45, 6);
    expect(r.ranges.HJ).toEqual(resumed.ranges.HJ!);                           // hero's range never moves
    expect(r.ranges.HJ!["56s"]).toBeCloseTo(0.98, 6);
    expect(r.note).toContain("RANGES RE-PICKED FOR CO, BB: the pinned chart modelled the BTN as the 70bb short stack and the BTN folded");
    expect(r.note).toContain(`read on ${EXACT_179}, the chart for the line as played`);
    expect(r.note).toContain(`hero's range stays on ${PIN_179}`);
  });

  it("everyone left is deep: the villains are read on the even chart (hand 4920397441)", async () => {
    // six-handed; CO (hero) opens 2.5, the 30bb BTN (modelled) folds, the SB folds, the BB calls
    const P6 = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
    const h = flopHand("r21-441", 3, P6, [a(5, "post-sb", 1), a(6, "post-bb", 2), a(1, "fold"), a(2, "fold"), a(3, "raise", 2.5, true), a(4, "fold"), a(5, "fold"), a(6, "call", 1.5)]);
    const dealt = { 1: 100, 2: 100, 3: 99.2, 4: 30, 5: 100, 6: 104 };
    const mk = (bb: Cells): Record<string, RawNode> => ({
      "": node("UTG", FR("2.5")), "F": node("HJ", FR("2.5")), "F-F": node("CO", FR("2.5"), { Q5s: { "Raise 2.5": 100 } }),
      "F-F-R2.5": node("BTN", FCR("8")), "F-F-R2.5-F": node("SB", FCR("10")), "F-F-R2.5-F-F": node("BB", FCR("11"), bb), "F-F-R2.5-F-F-C": end("BB"),
    });
    const PIN = "ign200_6max_D100_s30_BTN_o2_5", EVEN = "ign200_6max_D100_o2_5";
    const charts: Charts = { [PIN]: mk({ Q8s: { Call: 31.22, Fold: 68.78 } }), [EVEN]: mk({ Q8s: { Call: 98.97, Fold: 1.03 } }) };
    const pin: ChartPreflopPin = { piece: "chart6max", handKey: "r21-441", chartId: PIN, rawTokens: ["F", "F"], codes: ["F", "F"], heroPos: "CO", depth: 100, actionIndex: 4, at: 0 };
    const resumed = await resume(pin, h, "CO", charts);
    const r = await repickVillainRanges(pin, h, "CO", resumed, dealt, depsFor(charts));
    if (!r) throw new Error("no re-pick");
    expect(r.id).toBe(EVEN);
    expect(r.seats).toEqual(["BB"]);
    expect(r.ranges.BB!.Q8s).toBeCloseTo(0.9897, 6);
    expect(r.ranges.CO).toEqual(resumed.ranges.CO!);
    expect(r.note).toContain("RANGES RE-PICKED FOR BB: the pinned chart modelled the BTN as the 30bb short stack and the BTN folded");
  });
});

// ---- (b) hand 4919312009: hero BTN's 2.5 pick executed as 2bb; the SB folds, the BB calls
const P6 = { 1: "CO", 2: "BTN", 3: "SB", 4: "BB", 5: "UTG", 6: "HJ" };
const hand009 = flopHand("r21-009", 2, P6, [a(3, "post-sb", 1), a(4, "post-bb", 2), a(5, "fold"), a(6, "fold"), a(1, "fold"), a(2, "raise", 2, true), a(3, "fold"), a(4, "call", 1)]);
const dealt009 = { 1: 98.5, 2: 108.8, 3: 100.5, 4: 131, 5: 83, 6: 113.1 };
const mk009 = (open: string, btn: Cells, bb: Cells): Record<string, RawNode> => ({
  "": node("UTG", FR(open)), "F": node("HJ", FR(open)), "F-F": node("CO", FR(open)), "F-F-F": node("BTN", FR(open), btn),
  [`F-F-F-R${open}`]: node("SB", FCR("9")), [`F-F-F-R${open}-F`]: node("BB", FCR("10"), bb), [`F-F-F-R${open}-F-C`]: end("BB"),
});
const charts009: Charts = {
  "ign200_6max_D100_o2_5": mk009("2.5", { Q9o: { "Raise 2.5": 100 }, A3o: { "Raise 2.5": 100 } }, { "65o": { Fold: 100 }, A3o: { Call: 30, Fold: 70 } }),
  "ign200_6max_D100_o2": mk009("2", { Q9o: { "Raise 2": 100 }, A3o: { "Raise 2": 1.21, Fold: 98.79 } }, { "65o": { Call: 100 }, A3o: { Call: 80, "Raise 10": 20 } }),
};
const pin009: ChartPreflopPin = { piece: "chart6max", handKey: "r21-009", chartId: "ign200_6max_D100_o2_5", rawTokens: ["F", "F", "F"], codes: ["F", "F", "F"], heroPos: "BTN", depth: 100, actionIndex: 5, at: 0 };

describe("repickVillainRanges — trigger (b): the open played has its own chart", () => {
  it("an exact 2x chart exists: the BB is read on it, hero's 2bb open stays read as 2.5bb on the pin (hand 4919312009)", async () => {
    const resumed = await resume(pin009, hand009, "BTN", charts009);
    expect(resumed.note).toContain("BTN's 2bb read as 2.5bb");
    expect(resumed.ranges.BB!["65o"]).toBeUndefined();
    const r = await repickVillainRanges(pin009, hand009, "BTN", resumed, dealt009, depsFor(charts009));
    if (!r) throw new Error("no re-pick");
    expect(r.id).toBe("ign200_6max_D100_o2");
    expect(r.seats).toEqual(["BB"]);
    expect(r.ranges.BB!["65o"]).toBeCloseTo(1, 6);
    expect(r.ranges.BB!.A3o).toBeCloseTo(0.8, 6);
    expect(r.ranges.BTN).toEqual(resumed.ranges.BTN!);
    expect(r.ranges.BTN!.A3o).toBeCloseTo(1, 6);
    expect(r.note).toContain("RANGES RE-PICKED FOR BB: the open was played at 2bb where the pinned chart opens 2.5bb, and the 2x chart exists");
    expect(r.note).toContain("hero's range stays on ign200_6max_D100_o2_5");
  });

  it("the exact chart is not in the set (the resolver falls back to another id): no switch", async () => {
    const charts = { "ign200_6max_D100_o2_5": charts009["ign200_6max_D100_o2_5"]! };
    const resumed = await resume(pin009, hand009, "BTN", charts);
    expect(await repickVillainRanges(pin009, hand009, "BTN", resumed, dealt009, depsFor(charts))).toBeNull();
  });

  it("a 2x open at a 70bb-short table: the 2x uneven tree is looked up (it is in the set since 2026-09-30) — not solved here, so no switch (hand 4919261748's shape, the BB in)", async () => {
    // BTN opens 2, hero SB calls, the 70bb BB (modelled) calls: the picker's chart for the full line is the pinned one
    const P = { 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB", 6: "UTG" };
    const h = flopHand("r21-748", 4, P, [a(4, "post-sb", 1), a(5, "post-bb", 2), a(6, "fold"), a(1, "fold"), a(2, "fold"), a(3, "raise", 2), a(4, "call", 1.5, true), a(5, "call", 1)]);
    const dealt = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 72, 6: 100 };
    const PIN = "ign200_6max_D100_s70_BB_o2_5";
    const charts: Charts = { [PIN]: {
      "": node("UTG", FR("2.5")), "F": node("HJ", FR("2.5")), "F-F": node("CO", FR("2.5")), "F-F-F": node("BTN", FR("2.5"), { A3o: { "Raise 2.5": 100 } }),
      "F-F-F-R2.5": node("SB", FCR("9"), { AJo: { Call: 50, "Raise 9": 50 } }), "F-F-F-R2.5-C": node("BB", FCR("11"), { KQo: { Call: 100 } }), "F-F-F-R2.5-C-C": end("BB"),
    }, "ign200_6max_D100_o2": charts009["ign200_6max_D100_o2"]! };
    const pin: ChartPreflopPin = { piece: "chart6max", handKey: "r21-748", chartId: PIN, rawTokens: ["F", "F", "F", "R2"], codes: ["F", "F", "F", "R2.5"], heroPos: "SB", depth: 100, actionIndex: 6, at: 0 };
    const resumed = await resume(pin, h, "SB", charts);
    const calls: string[] = [];
    expect(await repickVillainRanges(pin, h, "SB", resumed, dealt, depsFor(charts, calls))).toBeNull();
    expect(calls).toEqual(["ign200_6max_D100_s70_BB_o2"]);                     // looked up (the set has 2x now); absent here, so no switch
  });

  it("…the same hand as dealt, where the modelled BB folded: trigger (a) fires, the even 2x chart reads the BTN", async () => {
    const P = { 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB", 6: "UTG" };
    const h = flopHand("r21-748b", 4, P, [a(4, "post-sb", 1), a(5, "post-bb", 2), a(6, "fold"), a(1, "fold"), a(2, "fold"), a(3, "raise", 2), a(4, "call", 1.5, true), a(5, "fold")]);
    const dealt = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 72, 6: 100 };
    const PIN = "ign200_6max_D100_s70_BB_o2_5";
    const sbOn = (open: string, cells: Cells) => ({ [`F-F-F-R${open}`]: node("SB", FCR("9"), cells), [`F-F-F-R${open}-C`]: node("BB", FCR("11")), [`F-F-F-R${open}-C-F`]: end("BB") });
    const charts: Charts = {
      [PIN]: { "": node("UTG", FR("2.5")), "F": node("HJ", FR("2.5")), "F-F": node("CO", FR("2.5")), "F-F-F": node("BTN", FR("2.5"), { A3o: { "Raise 2.5": 100 } }), ...sbOn("2.5", { AJo: { Call: 50 } }) },
      "ign200_6max_D100_o2": { "": node("UTG", FR("2")), "F": node("HJ", FR("2")), "F-F": node("CO", FR("2")), "F-F-F": node("BTN", FR("2"), { A3o: { "Raise 2": 1.21 } }), ...sbOn("2", { AJo: { Call: 20 } }) },
    };
    const pin: ChartPreflopPin = { piece: "chart6max", handKey: "r21-748b", chartId: PIN, rawTokens: ["F", "F", "F", "R2"], codes: ["F", "F", "F", "R2.5"], heroPos: "SB", depth: 100, actionIndex: 6, at: 0 };
    const resumed = await resume(pin, h, "SB", charts);
    const r = await repickVillainRanges(pin, h, "SB", resumed, dealt, depsFor(charts));
    if (!r) throw new Error("no re-pick");
    expect(r.id).toBe("ign200_6max_D100_o2");
    expect(r.ranges.BTN!.A3o).toBeCloseTo(0.0121, 6);
    expect(r.ranges.SB!.AJo).toBeCloseTo(0.5, 6);                               // hero: the pin's
    expect(r.note).toContain("the BB folded after hero's decision; the open was played at 2bb where the pinned chart opens 2.5bb");
  });
});

describe("repickVillainRanges — what never switches, and the per-villain fallback", () => {
  it("an AI-tree pin never re-picks", async () => {
    const resumed = await resume(pin179, hand179, "HJ", charts179);
    const ai: AiPreflopPin = { piece: "gtow-ai-preflop", handKey: "r21-179", solId: "s", shape: {} as never, id: "gtow-ai", rawTokens: ["F"], codes: ["F"],
      heroPos: "HJ", actionIndex: 2, at: 0, reduced: null, warm: null };
    const calls: string[] = [];
    expect(await repickVillainRanges(ai, hand179, "HJ", resumed, dealt179, depsFor(charts179, calls))).toBeNull();
    expect(calls).toEqual([]);
  });

  it("the modelled short still in, and the open as the pinned chart's: nothing fires", async () => {
    // the same five-handed hand, but the 78bb BTN calls instead of folding
    const h = flopHand("r21-179c", 2, P5, [a(5, "post-sb", 0.4), a(6, "post-bb", 1), a(2, "raise", 2.6, true), a(3, "fold"), a(4, "call", 2.6), a(5, "fold"), a(6, "fold")]);
    const charts: Charts = { [PIN_179]: { "": node("UTG", FR("2.5")), "F": node("HJ", FR("2.5"), { "56s": { "Raise 2.5": 98 } }), "F-R2.5": node("CO", FCR("8")),
      "F-R2.5-F": node("BTN", FCR("10"), { "99": { Call: 70 } }), "F-R2.5-F-C": node("SB", FCR("11")), "F-R2.5-F-C-F": node("BB", FCR("12")), "F-R2.5-F-C-F-F": end("BB") } };
    const resumed = await resume(pin179, h, "HJ", charts);
    const calls: string[] = [];
    expect(await repickVillainRanges(pin179, h, "HJ", resumed, dealt179, depsFor(charts, calls))).toBeNull();
    expect(calls).toEqual([]);
  });

  it("the re-picked chart missing a node: every villain it cannot read keeps the pinned read, said — never a refusal", async () => {
    const holed: Charts = { ...charts179, [EXACT_179]: { ...charts179[EXACT_179]! } };
    delete holed[EXACT_179]!["F-R2.5-C-F-F"];                                 // the BB's node
    const resumed = await resume(pin179, hand179, "HJ", holed);
    const r = await repickVillainRanges(pin179, hand179, "HJ", resumed, dealt179, depsFor(holed));
    if (!r) throw new Error("no outcome");
    expect(r.seats).toEqual([]);
    expect(r.kept.map((k) => k.seat)).toEqual(["CO", "BB"]);
    expect(r.ranges).toEqual(resumed.ranges);
    expect(r.note).not.toContain("RANGES RE-PICKED FOR");
    expect(r.note).toContain(`RANGES RE-PICK FELL BACK for BB: ${EXACT_179} cannot read it`);
    expect(r.note).toContain(`BB's range stays on ${PIN_179}`);
  });

  it("…and a villain the re-picked chart gives no weight keeps the pinned read while the other moves", async () => {
    const noCo: Charts = { ...charts179, [EXACT_179]: { ...charts179[EXACT_179]!, "F-R2.5": node("CO", FCR("8"), { "99": { "Raise 8": 100 } }) } };
    const resumed = await resume(pin179, hand179, "HJ", noCo);
    const r = await repickVillainRanges(pin179, hand179, "HJ", resumed, dealt179, depsFor(noCo));
    if (!r) throw new Error("no re-pick");
    expect(r.seats).toEqual(["BB"]);
    expect(r.kept.map((k) => k.seat)).toEqual(["CO"]);
    expect(r.ranges.CO).toEqual(resumed.ranges.CO!);
    expect(r.ranges.BB!.AJs).toBeCloseTo(0.96, 6);
    expect(r.note).toContain("RANGES RE-PICKED FOR BB:");
    expect(r.note).toContain("RANGES RE-PICK FELL BACK for CO");
  });

  it("chart6State reads every id shape", () => {
    expect(chart6State("ign200_6max_D100_s30_BB_o2_5")).toEqual({ depth: 100, short: { bb: 30, seat: "BB" }, open: 2.5 });
    expect(chart6State("ign200_6max_D125_o2")).toEqual({ depth: 125, short: null, open: 2 });
    expect(chart6State("ign200_6max_D100_olimp_pool3")).toEqual({ depth: 100, short: null, open: "limp" });
    expect(chart6State("ign200_6max_P_BB80_o2")).toBeNull();
  });
});
