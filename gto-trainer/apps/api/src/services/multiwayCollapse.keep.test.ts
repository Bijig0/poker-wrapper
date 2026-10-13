import { afterEach, describe, expect, it } from "bun:test";
import { pickCollapses, planCollapses, replayPlan, type CollapseSeat, type SeatTok } from "./multiwayCollapse";
import { forgetKeptCollapses, keepCollapses, keptCollapsePick } from "./fastSolve";

const seat = (pos: string, w = 1): CollapseSeat => ({ pos, range: new Array(6).fill(w) });
const toks = (...xs: [string, string][]): SeatTok[] => xs.map(([tok, s]) => ({ tok, seat: s }));

/** hand 4924401943 (2026-10-13): five to the flop, hero SB (AsQd), every seat its own range */
const FIVE = [seat("SB", 1), seat("BB", 2), seat("HJ", 3), seat("CO", 4), seat("BTN", 5)];
const FLOP = toks(["X", "SB"], ["X", "BB"], ["X", "HJ"], ["X", "CO"], ["X", "BTN"]);
/** the turn as hero was asked on it: checked to the BTN, who overbets */
const TURN_ASKED = [FLOP, toks(["X", "SB"], ["X", "BB"], ["X", "HJ"], ["X", "CO"], ["R7.2", "BTN"])];
/** the river as hero is asked on it: he raised the turn, the three others folded, the BTN called */
const RIVER_ASKED = [FLOP,
  toks(["X", "SB"], ["X", "BB"], ["X", "HJ"], ["X", "CO"], ["R7.2", "BTN"], ["R18.8", "SB"], ["F", "BB"], ["F", "HJ"], ["F", "CO"], ["C", "BTN"]),
  toks()];

describe("replayPlan: a hand keeps its collapses (2026-10-14, hand 4924401943)", () => {
  const turn = pickCollapses(planCollapses(FIVE, "SB", TURN_ASKED))!;

  it("the turn was answered on three two-ghost collapses that keep the BTN", () => {
    expect(turn.mode).toBe("blend");
    expect(turn.plans.map((p) => p.kind)).toEqual(["ghost:BB + ghost:CO", "ghost:BB + ghost:HJ", "ghost:HJ + ghost:CO"]);
    for (const p of turn.plans) expect(p.recipe).toBeDefined();
  });

  it("picked afresh on the river, the three folders leave from the FLOP: a heads-up hand that never was (the defect)", () => {
    const fresh = pickCollapses(planCollapses(FIVE, "SB", RIVER_ASKED))!;
    expect(fresh.plans.map((p) => p.kind)).toEqual(["fold:BB + fold:HJ + fold:CO"]);
    expect(fresh.plans[0]!.seats.map((s) => s.pos)).toEqual(["SB", "BTN"]);
    expect(fresh.plans[0]!.streets[0]!.map((t) => t.seat)).toEqual(["SB", "BTN"]);   // the flop without them
  });

  it("replayed on the river, each turn collapse is the same tree: same seats, same ranges, the turn's tokens as a prefix", () => {
    for (const p of turn.plans) {
      const r = replayPlan(FIVE, "SB", RIVER_ASKED, p.recipe!)!;
      expect(r).not.toBeNull();
      expect(r.kind).toBe(p.kind);
      // the checkpoint key is the seats and their ranges (aiChain.rootKeyOf): unchanged, so the flop is reused
      expect(r.seats).toEqual(p.seats);
      expect(r.heroIdx).toBe(p.heroIdx);
      expect(r.streets[0]).toEqual(p.streets[0]!);
      expect(r.streets[1]!.slice(0, p.streets[1]!.length)).toEqual(p.streets[1]!);
      // the kept villain folds INSIDE the tree, after hero's raise; the BTN calls; two seats see the river
      const kept = r.seats.find((s) => s.pos !== "SB" && s.pos !== "BTN")!.pos;
      expect(r.streets[1]!.slice(p.streets[1]!.length).map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:R18.8", `${kept}:F`, "BTN:C"]);
    }
  });

  it("does not hold once a ghosted seat has put chips in", () => {
    const p = turn.plans.find((x) => x.kind === "ghost:BB + ghost:CO")!;
    const coBets = [FLOP, toks(["X", "SB"], ["X", "BB"], ["X", "HJ"], ["R3", "CO"], ["C", "BTN"])];
    expect(replayPlan(FIVE, "SB", coBets, p.recipe!)).toBeNull();
  });

  it("does not hold once a member of a merged pair has folded (the composite would carry his range)", () => {
    // four-way, hero CO: SB checks, BB bets — the flop answered on SB+BB merged (the pair commits once)
    const FOUR = [seat("SB", 1), seat("BB", 2), seat("CO", 3), seat("BTN", 4)];
    const flop = [toks(["X", "SB"], ["R3", "BB"])];
    const merged = planCollapses(FOUR, "CO", flop).find((p) => p.kind.startsWith("merge:SB+BB"))!;
    expect(merged).toBeDefined();
    // hero calls, the BTN calls, the SB folds: the merge is still legal (one commitment), but SB's range is gone
    const later = [toks(["X", "SB"], ["R3", "BB"], ["C", "CO"], ["C", "BTN"], ["F", "SB"]), toks()];
    expect(replayPlan(FOUR, "CO", later, merged.recipe!)).toBeNull();
  });

  it("a fold the recipe already made stays a fold; the exact plan replays", () => {
    const FOUR = [seat("SB", 1), seat("BB", 2), seat("CO", 3), seat("BTN", 4)];
    const asked = [toks(["R3", "SB"], ["C", "BB"], ["F", "CO"])];
    const p = pickCollapses(planCollapses(FOUR, "BTN", asked))!.plans[0]!;
    expect(p.kind).toBe("fold:CO");
    const later = [toks(["R3", "SB"], ["C", "BB"], ["F", "CO"], ["C", "BTN"]), toks(["X", "SB"], ["F", "BB"])];
    const r = replayPlan(FOUR, "BTN", later, p.recipe!)!;
    expect(r.kind).toBe("fold:CO");
    expect(r.seats).toEqual(p.seats);
    expect(r.streets[1]!.map((t) => `${t.seat}:${t.tok}`)).toEqual(["SB:X", "BB:F"]);
  });
});

describe("fastSolve keeps the hand's collapses between its decisions", () => {
  afterEach(() => { forgetKeptCollapses(); delete process.env.COLLAPSE_KEEP; });
  const turn = () => pickCollapses(planCollapses(FIVE, "SB", TURN_ASKED))!;

  it("the river reuses the turn's three collapses and says who folded since", () => {
    keepCollapses("4924401943", "SB", turn());
    const kept = keptCollapsePick("4924401943", "SB", FIVE, RIVER_ASKED)!;
    expect(kept.plans.map((p) => p.kind)).toEqual(turn().plans.map((p) => p.kind));
    expect(kept.mode).toBe("blend");
    expect(kept.why).toContain("BB, HJ, CO folded since");
  });

  it("another hand, another hero seat, or COLLAPSE_KEEP=off: nothing kept", () => {
    keepCollapses("4924401943", "SB", turn());
    expect(keptCollapsePick("4924401944", "SB", FIVE, RIVER_ASKED)).toBeNull();
    expect(keptCollapsePick("4924401943", "BB", FIVE, RIVER_ASKED)).toBeNull();
    process.env.COLLAPSE_KEEP = "off";
    expect(keptCollapsePick("4924401943", "SB", FIVE, RIVER_ASKED)).toBeNull();
  });

  it("a collapse that no longer holds drops the hand's memo: picked afresh from then on", () => {
    keepCollapses("h1", "SB", turn());
    const coBets = [FLOP, toks(["X", "SB"], ["X", "BB"], ["X", "HJ"], ["R3", "CO"], ["C", "BTN"])];
    expect(keptCollapsePick("h1", "SB", FIVE, coBets)).toBeNull();
    expect(keptCollapsePick("h1", "SB", FIVE, RIVER_ASKED)).toBeNull();   // gone, not just refused once
  });
});
