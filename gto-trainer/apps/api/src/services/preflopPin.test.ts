import { describe, expect, it } from "bun:test";
import { setPreflopPin, getPreflopPin, forgetPreflopPin, pinRest, resumeChartPreflopRanges, type ChartPreflopPin } from "./preflopPin";
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
