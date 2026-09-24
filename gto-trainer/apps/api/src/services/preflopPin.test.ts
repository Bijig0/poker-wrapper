import { describe, expect, it } from "bun:test";
import { setPreflopPin, getPreflopPin, forgetPreflopPin, pinRest, resumeChartPreflopRanges, flopSeatsOf, heroDeviation, type ChartPreflopPin } from "./preflopPin";
import type { RawNode } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * The preflop pin: the last preflop answer of a hand names the tree the flop resumes from. Modelled on hand
 * 4920396764 (2026-09-25): a 5-handed table, hero on the button opens 2.5 (the client executes 2.6), a 23bb small
 * blind flat-calls, the big blind folds. The chart the answer read (s30 SB) marks the node after the SB's call
 * terminal — the converter's label for a branch HRC never exported — so the old walk died there.
 */

const chart: Record<string, RawNode> = {
  "": { pos: "UTG", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }], cells: [] },
  "F": { pos: "HJ", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }], cells: [] },
  "F-F": { pos: "CO", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }], cells: [] },
  "F-F-F": {
    pos: "BTN", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }],
    cells: [{ hand: "A9s", actions: { "Raise 2.5": 100 } }, { hand: "K5o", actions: { "Raise 2.5": 40, Fold: 60 } }, { hand: "72o", actions: { Fold: 100 } }],
  },
  "F-F-F-R2.5": {
    pos: "SB", terminal: false,
    actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }, { action: "Raise 7.5", token: "R7.5" }, { action: "All-in", token: "R30" }],
    cells: [{ hand: "A9s", actions: { Call: 3.6, "Raise 7.5": 40, "All-in": 56.4 } }, { hand: "KJs", actions: { Call: 1.3, "Raise 7.5": 98.7 } }, { hand: "22", actions: { Fold: 100 } }],
  },
  // the pruned branch: HRC never exported it, the converter wrote it as a close
  "F-F-F-R2.5-C": { pos: "SB", terminal: true, actions: [], cells: [] },
  "F-F-F-R2.5-F": { pos: "BB", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }], cells: [{ hand: "T9s", actions: { Call: 60, Fold: 40 } }] },
};
const get = async (line: string): Promise<RawNode | null> => chart[line] ?? null;

const flopHand: ParsedHand = {
  handId: 30, clientHandId: "4920396764", bbCents: 5, heroSeatId: 2, heroCards: ["9d", "Ad"], board: ["6c", "Jh", "Ah"], street: "flop",
  actions: [
    { seatId: 3, hero: false, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 4, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 5, hero: false, type: "fold", street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: true, type: "raise", amount: 2.6, street: "preflop" },
    { seatId: 3, hero: false, type: "call", amount: 2.2, street: "preflop" },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 3, hero: false, type: "check", street: "flop" },
  ],
  liveSeats: [1, 2, 3, 4, 5], committed: {}, potByStreet: {}, positions: { 3: "SB", 4: "BB", 5: "HJ", 1: "CO", 2: "BTN" },
  stacks: { 1: 104.6, 2: 98, 3: 20.4, 4: 70.4, 5: 137 },
  currentNode: { street: "flop", toActSeatId: 2, toActIsHero: true, pot: 6.2, toCall: 0, legalActions: [], complete: false }, ended: false,
};

const pinAtOpen: ChartPreflopPin = {
  piece: "chart6max", handKey: "4920396764", chartId: "ign200_6max_D100_s30_SB_o2_5",
  rawTokens: ["F", "F", "F"], codes: ["F", "F", "F"], heroPos: "BTN", depth: 100, actionIndex: 4, at: 0,
};

describe("preflop pin registry", () => {
  it("the last answer of a hand wins, and a hand can be forgotten", () => {
    setPreflopPin(pinAtOpen);
    expect(getPreflopPin("4920396764")?.piece).toBe("chart6max");
    setPreflopPin({ ...pinAtOpen, chartId: "ign200_6max_D100_o2_5" });
    expect((getPreflopPin("4920396764") as ChartPreflopPin).chartId).toBe("ign200_6max_D100_o2_5");
    forgetPreflopPin("4920396764");
    expect(getPreflopPin("4920396764")).toBeUndefined();
  });

  it("pinRest: the capture must still start with the pinned line and carry hero's action", () => {
    expect(pinRest(pinAtOpen, ["F", "F", "F", "R2.6", "C", "F"])).toEqual({ ok: true, rest: ["R2.6", "C", "F"] });
    const grown = pinRest({ ...pinAtOpen, rawTokens: ["F", "R3", "F"] }, ["F", "F", "F", "R2.6"]);
    expect(grown.ok).toBe(false);
    if (!grown.ok) expect(grown.why).toContain("no longer starts with the pinned one");
    const pending = pinRest(pinAtOpen, ["F", "F", "F"]);
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.why).toContain("hero's own action is not in the line yet");
  });
});

/**
 * WHAT HERO WAS TOLD (2026-09-25, Brady's rule 3). Seed 144 [hero-deviates]: BTN A2o facing a 2.2bb open was told
 * Fold 99.33% / Raise 10 0.67% at a node whose menu also holds Raise 7 — and 3-bet to 7.7 anyway. The flop then
 * refused "hero's A2o is not in range", which is hero's doing, not a bug in the pieces.
 */
describe("heroDeviation — the picks each answer gave hero, carried from pin to pin", () => {
  const pick = (rawTokens: string[], mix: [string, string | null, number][], heroClass = "A2o") =>
    ({ rawTokens, codes: rawTokens, heroClass, mix: mix.map(([action, token, frequency]) => ({ action, token, frequency })) });
  const bb3bet = pick(["F", "F", "R2.2"], [["Fold", "F", 99.33], ["Call", "C", 0], ["Raise 7", "R7", 0], ["Raise 10", "R10", 0.67], ["All-in", "R100", 0]]);

  it("a size the pick gave 0% is a deviation — snapped to the NODE's menu (7.7 → Raise 7), not to the cell's", () => {
    const d = heroDeviation([bb3bet], ["F", "F", "R2.2", "R7.7", "C", "F", "R19.25", "C"]);
    expect(d).toEqual({ codes: ["F", "F", "R2.2"], took: "R7.7", action: "Raise 7", heroClass: "A2o" });
  });

  it("an action the pick gave any weight is hero following it (a 0.67% 3-bet is still the pick)", () => {
    expect(heroDeviation([bb3bet], ["F", "F", "R2.2", "R10", "F"])).toBeNull();
    expect(heroDeviation([bb3bet], ["F", "F", "R2.2", "R9.5", "F"])).toBeNull();     // 9.5 snaps to 10
  });

  it("our all-in token matches the node's largest raise", () => {
    expect(heroDeviation([bb3bet], ["F", "F", "R2.2", "RAI"])?.action).toBe("All-in");
  });

  it("no recorded pick, a capture that left the recorded line, or hero not acted yet: nothing to accuse hero of", () => {
    expect(heroDeviation(undefined, ["F", "F", "R2.2", "R7.7"])).toBeNull();
    expect(heroDeviation([bb3bet], ["F", "R3", "R2.2", "R7.7"])).toBeNull();
    expect(heroDeviation([bb3bet], ["F", "F", "R2.2"])).toBeNull();
  });

  it("setPreflopPin carries the earlier decisions' picks and drops a re-asked one", () => {
    const key = "picks-carry";
    const base = { piece: "chart6max" as const, handKey: key, chartId: "c", heroPos: "BTN", depth: 100, actionIndex: 0, at: 0 };
    setPreflopPin({ ...base, rawTokens: ["F", "F", "R2.2"], codes: ["F", "F", "R2"], picks: [bb3bet] });
    const later = pick(["F", "F", "R2.2", "R7.7", "C", "F", "R19.25"], [["Fold", "F", 100]]);
    setPreflopPin({ ...base, rawTokens: later.rawTokens, codes: later.rawTokens, picks: [later] });
    expect(getPreflopPin(key)?.picks?.map((p) => p.rawTokens.length)).toEqual([3, 7]);
    setPreflopPin({ ...base, rawTokens: later.rawTokens, codes: later.rawTokens, picks: [later] });   // the poller re-asks
    expect(getPreflopPin(key)?.picks?.map((p) => p.rawTokens.length)).toEqual([3, 7]);
    setPreflopPin({ ...base, rawTokens: ["F", "F", "R2.2"], codes: ["F", "F", "R2"], picks: [bb3bet] });  // a replay of the first
    expect(getPreflopPin(key)?.picks?.map((p) => p.rawTokens.length)).toEqual([3]);
    forgetPreflopPin(key);
  });
});

describe("resumeChartPreflopRanges", () => {
  it("resumes the answering chart at hero's node: 2.6 snaps to the tree's 2.5, the SB's call is read, the BB's fold past the pruned terminal is taken as read", async () => {
    const r = await resumeChartPreflopRanges(pinAtOpen, flopHand, "BTN", get);
    if (!r.ok) throw new Error(r.why);
    expect(r.id).toBe("ign200_6max_D100_s30_SB_o2_5");
    expect(r.tokens).toEqual(["F", "F", "F", "R2.6", "C", "F"]);      // the capture's own, for the pot
    expect(Object.keys(r.ranges).sort()).toEqual(["BTN", "SB"]);
    expect(r.ranges.BTN!.A9s).toBeCloseTo(1, 5);
    expect(r.ranges.BTN!.K5o).toBeCloseTo(0.4, 5);
    expect(r.ranges.BTN!["72o"]).toBeUndefined();
    expect(r.ranges.SB!.A9s).toBeCloseTo(0.036, 5);
    expect(r.ranges.SB!.KJs).toBeCloseTo(0.013, 5);
    expect(r.ranges.SB!["22"]).toBeUndefined();
    expect(r.note).toContain("PREFLOP RANGES FROM THE PIN");
    expect(r.note).toContain("taken as read");
    expect(r.reads).toBeGreaterThan(0);
  });

  it("a pin the capture has outgrown is unusable, not wrong", async () => {
    const r = await resumeChartPreflopRanges({ ...pinAtOpen, rawTokens: ["F", "R3", "F"], codes: ["F", "R3", "F"] }, flopHand, "BTN", get);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("no longer starts with the pinned one");
  });
});

/**
 * A FITTED PIN (2026-09-25, mutation harness seed 111 [limps]). Two limpers, hero in the BB squeezes, the FIRST
 * limper calls. The tree (like the real limp charts) holds one limper only, so hero's decision was read with UTG's
 * limp folded out — and UTG is the player hero meets on the flop. The old resume walked the pinned codes + the
 * rest positionally and handed UTG's call to the HJ: the flop had no UTG range ("reconstructed ranges don't cover
 * both seats"). Each flop seat is now read from a fitted line that keeps it, on the pinned chart.
 */
describe("resumeChartPreflopRanges — a pin read on a fitted line", () => {
  const node = (pos: string, acts: [string, string][], cells: RawNode["cells"] = []): RawNode =>
    ({ pos, terminal: false, actions: acts.map(([action, token]) => ({ action, token })), cells });
  const T: RawNode = { pos: null, terminal: true, actions: [], cells: [] };
  const FC: [string, string][] = [["Fold", "F"], ["Call", "C"]];
  const limpChart: Record<string, RawNode> = {
    "": node("UTG", FC, [{ hand: "87s", actions: { Call: 50, Fold: 50 } }]),
    "C": node("HJ", [["Fold", "F"]]),                       // the cap: no second limper
    "F": node("HJ", FC, [{ hand: "87s", actions: { Call: 100 } }]),
    // hero's decision, read with UTG folded out
    "F-C": node("CO", FC), "F-C-F": node("BTN", FC), "F-C-F-F": node("SB", FC),
    "F-C-F-F-F": node("BB", [["Check", "X"], ["Raise 4", "R4"]], [{ hand: "AKo", actions: { "Raise 4": 100 } }, { hand: "72o", actions: { Check: 100 } }]),
    "F-C-F-F-F-R4": node("HJ", FC, [{ hand: "87s", actions: { Call: 30, Fold: 70 } }]),
    "F-C-F-F-F-R4-F": T,
    // UTG's range, read with the HJ folded out instead
    "C-F": node("CO", FC), "C-F-F": node("BTN", FC), "C-F-F-F": node("SB", FC),
    "C-F-F-F-F": node("BB", [["Check", "X"], ["Raise 4", "R4"]], [{ hand: "AKo", actions: { "Raise 4": 100 } }]),
    "C-F-F-F-F-R4": node("UTG", FC, [{ hand: "87s", actions: { Call: 40, Fold: 60 } }]),
    "C-F-F-F-F-R4-C": T,
  };
  const getLimp = async (line: string): Promise<RawNode | null> => limpChart[line] ?? null;
  const a = (seatId: number, type: string, amount?: number, hero = false, street = "preflop") =>
    ({ seatId, hero, type, street, ...(amount != null ? { amount } : {}) }) as ParsedHand["actions"][number];
  // seats: 1 UTG, 2 HJ, 3 CO, 4 BTN, 5 SB, 6 BB (hero)
  const squeezeFlop: ParsedHand = {
    handId: 111, clientHandId: "mh-111-limps", bbCents: 200, heroSeatId: 6, heroCards: ["Ah", "Kd"], board: ["2c", "2s", "Ks"], street: "flop",
    actions: [a(5, "post-sb", 0.5), a(6, "post-bb", 1, true), a(1, "call", 1), a(2, "call", 1), a(3, "fold"), a(4, "fold"), a(5, "fold"),
      a(6, "raise", 4, true), a(1, "call", 3), a(2, "fold")],
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
    currentNode: { street: "flop", toActSeatId: 6, toActIsHero: true, pot: 10.5, toCall: 0, legalActions: [], complete: false }, ended: false,
  };
  const fittedPin: ChartPreflopPin = {
    piece: "chart6max", handKey: "mh-111-limps", chartId: "ign200_6max_D100_olimp_pool3",
    rawTokens: ["C", "C", "F", "F", "F"], codes: ["F", "C", "F", "F", "F"], heroPos: "BB", depth: 100, actionIndex: 7, at: 0,
  };

  it("the flop seats are the table's (BB and UTG), each read on a line that keeps it", async () => {
    const r = await resumeChartPreflopRanges(fittedPin, squeezeFlop, "BB", getLimp);
    if (!r.ok) throw new Error(r.why);
    expect(Object.keys(r.ranges).sort()).toEqual(["BB", "UTG"]);
    expect(r.ranges.BB!.AKo).toBeCloseTo(1, 5);                 // hero's squeeze, on the fold his decision was read with
    expect(r.ranges.BB!["72o"]).toBeUndefined();
    expect(r.ranges.UTG!["87s"]).toBeCloseTo(0.5 * 0.4, 5);     // limp, then call the squeeze — with the HJ folded out
    expect(r.codes).toEqual(["F", "C", "F", "F", "F", "R4"]);          // hero's range: his pinned node + his squeeze
    expect(r.tokens).toEqual(["C", "C", "F", "F", "F", "R4", "C", "F"]);   // the capture's own line, for the pot
    expect(r.note).toContain("fitted line that keeps that seat");
    expect(r.note).toContain("UTG with HJ folded");
  });

  it("a line past the tree's caps AFTER hero's decision: each seat fitted, hero on his pinned node (seed 93)", async () => {
    // HJ and CO limp, hero (BB) squeezes — asked at "F-C-C-F-F", a node the tree holds — and BOTH limpers call: the
    // tree holds one caller of a squeeze (CO's node offers only a fold). The pinned walk stops there; each villain is
    // read on a line that folds the other, hero on the node his decision was read at (with both limps in)
    const capChart: Record<string, RawNode> = {
      ...limpChart,
      "F-C-C": node("BTN", FC), "F-C-C-F": node("SB", FC),
      "F-C-C-F-F": node("BB", [["Check", "X"], ["Raise 4", "R4"]], [{ hand: "AKo", actions: { "Raise 4": 70, Check: 30 } }]),
      "F-C-C-F-F-R4": node("HJ", FC, [{ hand: "87s", actions: { Call: 30 } }]),
      "F-C-C-F-F-R4-C": node("CO", [["Fold", "F"]]),
      "F-C-F-F-F-R4-C": T,
      "F-F": node("CO", FC, [{ hand: "T9s", actions: { Call: 100 } }]), "F-F-C": node("BTN", FC), "F-F-C-F": node("SB", FC),
      "F-F-C-F-F": node("BB", [["Check", "X"], ["Raise 4", "R4"]]),
      "F-F-C-F-F-R4": node("CO", FC, [{ hand: "T9s", actions: { Call: 50 } }]),
      "F-F-C-F-F-R4-C": T,
    };
    const pin2: ChartPreflopPin = { ...fittedPin, rawTokens: ["F", "C", "C", "F", "F"], codes: ["F", "C", "C", "F", "F"] };
    const h: ParsedHand = { ...squeezeFlop, actions: [a(5, "post-sb", 0.5), a(6, "post-bb", 1, true), a(1, "fold"), a(2, "call", 1), a(3, "call", 1), a(4, "fold"), a(5, "fold"),
      a(6, "raise", 4, true), a(2, "call", 3), a(3, "call", 3)] };
    const r = await resumeChartPreflopRanges(pin2, h, "BB", async (l) => capChart[l] ?? null);
    if (!r.ok) throw new Error(r.why);
    expect(Object.keys(r.ranges).sort()).toEqual(["BB", "CO", "HJ"]);
    expect(r.ranges.BB!.AKo).toBeCloseTo(0.7, 5);              // the squeeze hero was told, at the node he was asked
    expect(r.ranges.HJ!["87s"]).toBeCloseTo(0.3, 5);            // HJ read with CO's limp folded out
    expect(r.ranges.CO!.T9s).toBeCloseTo(0.5, 5);               // CO read with HJ's limp folded out
    expect(r.codes).toEqual(["F", "C", "C", "F", "F", "R4"]);
    expect(r.note).toContain("the pinned walk stopped");
  });

  it("flopSeatsOf reads the seats from the capture's line, not the tree's", () => {
    expect(flopSeatsOf(["C", "C", "F", "F", "F", "R4", "C", "F"], 100)).toEqual(["UTG", "BB"]);
    expect(flopSeatsOf(["F", "F", "F", "R2.6", "C", "F"], 100)).toEqual(["BTN", "SB"]);
  });
});
