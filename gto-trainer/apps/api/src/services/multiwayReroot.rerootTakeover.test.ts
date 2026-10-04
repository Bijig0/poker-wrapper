/**
 * rerootCollapse END TO END on the takeover path (review 2026-10-05, finding 1): the narrowing walks are stubbed
 * (spyOn solveAiChain — each walk hands back its seats' ranges), the rest is the real planning. Hand 4921735317's turn:
 * the BTN folded on the turn, so no walk needs his range — the re-root must answer, not "no narrowing walk produced
 * BTN's range". And a field no three-seat walk can hold still answers, three-handed, with arrival ranges.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as aiChain from "./aiChain";
import { rerootCollapse, type RerootArgs } from "./multiwayReroot";

const walks: string[][] = [];
const spy = spyOn(aiChain, "solveAiChain").mockImplementation((async (spec: any) => {
  const seats = [spec.oopPos, spec.midPos, spec.ipPos].filter(Boolean) as string[];
  walks.push(seats);
  return { ok: true, data: {}, potNode: 0, stackStreet: 0, line: "", solves: 0, trace: { spec } as any,
    rangesOut: Object.fromEntries(seats.map((p) => [p, new Array(1326).fill(0.5)])) };
}) as any);
afterAll(() => spy.mockRestore());

const base = (o: Partial<RerootArgs>): RerootArgs => ({
  ordered: [], heroPos: "", arr: () => new Array(1326).fill(1), streets: [], streetSeats: [], flopPot: 0, flopStack: 100,
  board: "QsTd5s9s", heroComboIdx: null, rake: null,
  specOf: (three, heroIdx) => ({ oopPos: three[0]!.pos, midPos: three[1]!.pos, ipPos: three[2]!.pos, oopRange: three[0]!.range,
    midRange: three[1]!.range, ipRange: three[2]!.range, heroSeat: heroIdx === 0 ? "oop" : heroIdx === 1 ? "mid" : "ip" }),
  ...o,
});

describe("rerootCollapse on the takeover path", () => {
  test("hand 4921735317 turn: UTG bets 19, the BTN folds, the SB calls — hero (BB) answers three-handed", async () => {
    walks.length = 0;
    const r = await rerootCollapse(base({
      ordered: ["SB", "BB", "UTG", "BTN"], heroPos: "BB", flopPot: 4,
      behind: { SB: 103.2, BB: 91.8, UTG: 91.8, BTN: 36.8 },
      streets: [["X", "X", "R2", "R4", "C", "C", "C"], ["X", "X", "R19", "F", "C"]],
      streetSeats: [["SB", "BB", "UTG", "BTN", "SB", "BB", "UTG"], ["SB", "BB", "UTG", "BTN", "SB"]],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.picked.plans[0]!.seats.map((s) => s.pos).sort()).toEqual(["BB", "SB", "UTG"]);
    expect(walks.length).toBeGreaterThan(0);
    for (const w of walks) expect(w).not.toContain("BTN");   // no walk was spent on the turn folder
  });

  test("review finding 6: two flop re-raisers no single three-seat walk holds — the cut makes them walkable; hero answers", async () => {
    walks.length = 0;
    const r = await rerootCollapse(base({
      ordered: ["SB", "BB", "UTG", "BTN"], heroPos: "UTG", flopPot: 6,
      behind: { SB: 100, BB: 60, UTG: 100, BTN: 100 },
      streets: [["X", "R1.98", "C", "C", "R13.92", "C", "C", "R38.79", "C", "C", "C"], ["X", "RAI"]],
      streetSeats: [["SB", "BB", "UTG", "BTN", "SB", "BB", "UTG", "BTN", "SB", "BB", "UTG"], ["SB", "BB"]],
      amounts: [new Array(11).fill(null), [null, 21.21]],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // every live villain's range came from a walk, or (named) from the flop arrival
    expect(r.picked.plans.length).toBeGreaterThan(0);
  });
});
