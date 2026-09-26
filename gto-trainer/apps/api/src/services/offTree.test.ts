import { describe, expect, it } from "bun:test";
import { isOffTree, offTreeFamily, offTreeStats, offTreeText } from "./offTree";
import { OffTreeLog } from "./offTreeLog";

const N = 1326;
const range = (w = 1) => new Array(N).fill(0).map((_, i) => (i < 300 ? w : 0));   // 300 hands in range
/** a two-action node (check / bet) where each hand bets with `bet(i)` and the EVs are `ev(i)` */
const node = (bet: (i: number) => number, evCheck: (i: number) => number, evBet: (i: number) => number) => [
  { strategy: range().map((_, i) => 1 - bet(i)), evs: range().map((_, i) => evCheck(i)) },
  { strategy: range().map((_, i) => bet(i)), evs: range().map((_, i) => evBet(i)) },
];

describe("off-tree villain lines (2026-09-27)", () => {
  it("noise — every hand bets a sliver and every hand loses by it: flagged (hand 4920638634's HJ flop bet)", () => {
    const s = offTreeStats(range(), node((i) => 0.001 + (i % 4) * 0.001, () => 1.0, () => 0.86), 1);
    expect(s.nodeFreq).toBeLessThan(0.01);
    expect(s.maxHand).toBeCloseTo(0.004, 6);
    expect(s.evGapBb).toBeCloseTo(0.14, 6);
    expect(isOffTree(s)).toBe(true);
  });

  it("a real narrow line — a few hands bet it often: rare overall, but NOT flagged", () => {
    const s = offTreeStats(range(), node((i) => (i < 3 ? 0.25 : 0), () => 1, () => 1), 1);
    expect(s.nodeFreq).toBeLessThan(0.01);
    expect(s.maxHand).toBe(0.25);
    expect(isOffTree(s)).toBe(false);
  });

  it("a common action is never flagged; missing EVs give a null gap", () => {
    const s = offTreeStats(range(), [{ strategy: range().map(() => 0.6) }, { strategy: range().map(() => 0.4) }], 1);
    expect(s.nodeFreq).toBeCloseTo(0.4, 6);
    expect(s.evGapBb).toBeNull();
    expect(isOffTree(s)).toBe(false);
  });

  it("names the spot family and reads as one line", () => {
    const l = { street: "flop" as const, seat: "HJ", inPosition: false, action: "BET", code: "R2.6", betsize: 2.6, codes: [], potNode: 8.5,
      nodeFreq: 0.0016, maxHand: 0.0041, evGapBb: 0.14 };
    expect(offTreeFamily(l, "Td6h7s")).toBe("flop · bet out of position · T-high board");
    expect(offTreeText(l)).toBe("HJ BET 2.6 is off-tree — the solver takes it 0.16%, no hand above 0.41%, costs him 0.14bb on average");
  });

  it("the log keeps a spot once per hand, fills villain's shown cards by position, and groups by family", () => {
    const log = new OffTreeLog(":memory:");
    const l = { street: "flop" as const, seat: "HJ", inPosition: false, action: "BET", code: "R2.6", betsize: 2.6, codes: [], potNode: 8.5,
      nodeFreq: 0.0016, maxHand: 0.0041, evGapBb: 0.14 };
    const meta = { clientHandId: "4920638634", sessionId: "session_20260926_030543", origin: "live", board: "Td6h7s7c", heroPos: "BTN" };
    log.record(meta, l);
    log.record({ ...meta, origin: "warm" }, l);                        // the same spot again: kept once
    log.record({ ...meta, clientHandId: "4920638700" }, l);
    expect(log.forSession("session_20260926_030543").length).toBe(2);
    expect(log.forHand("4920638634")[0]!.board).toBe("Td6h7s");         // the board as of the line's street
    expect(log.fillShown("4920638634", [{ position: "BTN", cards: ["As", "Ts"], hero: true }, { position: "HJ", cards: ["Kd", "Kc"] }])).toBe(1);
    const fams = log.families(log.recent());
    expect(fams).toEqual([{ family: "flop · bet out of position · T-high board", n: 2, shown: [{ hand: "4920638634", cards: "KdKc", action: "HJ BET 2.6" }] }]);
  });
});
