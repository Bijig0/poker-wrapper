import { afterEach, describe, expect, it } from "bun:test";
import { keptVillains, pickCollapses, planCollapses, replanKeeping, type CollapsePlan, type CollapseSeat, type SeatTok } from "./multiwayCollapse";
import { forgetKeptCollapses, keepCollapses, keptCollapsePick } from "./fastSolve";
import { handFacts } from "./handFacts";

/**
 * SURVIVORS ARE KEPT, THE COVER TOPPED UP (2026-10-14 evening, replanKeeping). The six live hands of 2026-10-14 where one of
 * the three single-ghost collapses broke (its ghosted villain put chips in) and the other two still held: the memo used
 * to be dropped whole and the fresh pick took the villains who had folded since out of the FLOP.
 */

const seat = (pos: string, w = 1): CollapseSeat => ({ pos, range: new Array(6).fill(w) });
const toks = (...xs: [string, string][]): SeatTok[] => xs.map(([tok, s]) => ({ tok, seat: s }));
const X = (...seats: string[]) => seats.map((s) => ["X", s] as [string, string]);
const seatsOf = (...ps: string[]) => ps.map((p, i) => seat(p, i + 1));

interface Shape {
  hand: string;
  hero: string;
  seats: CollapseSeat[];
  /** the streets at the decision whose collapses were kept */
  earlier: SeatTok[][];
  /** the streets at the later decision */
  later: SeatTok[][];
  dropped: string;
  why: string;
  kept: string[];
  folders: string[];
}

const SHAPES: Shape[] = [
  {
    hand: "4924195300", hero: "BTN", seats: seatsOf("SB", "BB", "CO", "BTN"),
    earlier: [toks(...X("SB", "BB", "CO"))],
    later: [toks(...X("SB", "BB", "CO", "BTN")), toks(["R4", "SB"], ["F", "BB"], ["F", "CO"])],
    dropped: "ghost:SB", why: "ghost:SB dropped — the SB bet the turn", kept: ["ghost:BB", "ghost:CO"], folders: ["BB", "CO"],
  },
  {
    hand: "4923556567", hero: "SB", seats: seatsOf("SB", "BB", "CO", "BTN"),
    earlier: [toks()],
    later: [toks(...X("SB", "BB", "CO", "BTN")), toks(["R5", "SB"], ["F", "BB"], ["C", "CO"], ["F", "BTN"]), toks(["X", "SB"], ["R8", "CO"])],
    dropped: "ghost:CO", why: "ghost:CO dropped — the CO called the turn", kept: ["ghost:BB", "ghost:BTN"], folders: ["BB", "BTN"],
  },
  {
    hand: "4923565359", hero: "SB", seats: seatsOf("SB", "BB", "HJ", "CO"),
    earlier: [toks()],
    later: [toks(...X("SB", "BB", "HJ", "CO")), toks(...X("SB", "BB", "HJ", "CO")), toks(["X", "SB"], ["R6", "BB"], ["F", "HJ"], ["F", "CO"])],
    dropped: "ghost:BB", why: "ghost:BB dropped — the BB bet the river", kept: ["ghost:CO", "ghost:HJ"], folders: ["HJ", "CO"],
  },
  {
    hand: "4923553178", hero: "BB", seats: seatsOf("SB", "BB", "CO", "BTN"),
    earlier: [toks(["X", "SB"])],
    later: [toks(...X("SB", "BB", "CO", "BTN")), toks(["R4", "SB"], ["C", "BB"], ["F", "CO"], ["F", "BTN"]), toks(["R9", "SB"])],
    dropped: "ghost:SB", why: "ghost:SB dropped — the SB bet the turn", kept: ["ghost:BTN", "ghost:CO"], folders: ["CO", "BTN"],
  },
  {
    hand: "4924403091", hero: "HJ", seats: seatsOf("BB", "HJ", "CO", "BTN"),
    earlier: [toks(["X", "BB"])],
    later: [toks(...X("BB", "HJ", "CO", "BTN")), toks(["X", "BB"], ["X", "HJ"], ["R5", "CO"], ["F", "BTN"], ["F", "BB"])],
    dropped: "ghost:CO", why: "ghost:CO dropped — the CO bet the turn", kept: ["ghost:BB", "ghost:BTN"], folders: ["BB", "BTN"],
  },
  {
    hand: "4923484379", hero: "SB", seats: seatsOf("SB", "BB", "HJ", "CO"),
    earlier: [toks()],
    // the turn, checked through to hero's river: flop HJ bets, CO folds, hero calls, BB folds
    later: [toks(["X", "SB"], ["X", "BB"], ["R3", "HJ"], ["F", "CO"], ["C", "SB"], ["F", "BB"]), toks(["X", "SB"], ["X", "HJ"]), toks()],
    dropped: "ghost:HJ", why: "ghost:HJ dropped — the HJ bet the flop", kept: ["ghost:BB", "ghost:CO"], folders: ["BB", "CO"],
  },
];

const villainsOf = (s: Shape) => s.seats.map((x) => x.pos).filter((p) => p !== s.hero);
const byKind = (ps: CollapsePlan[], kind: string) => ps.find((p) => p.kind === kind)!;

describe("replanKeeping: the six hands of 2026-10-14 keep the two collapses that still hold", () => {
  for (const s of SHAPES) {
    describe(`hand ${s.hand} (hero ${s.hero})`, () => {
      const earlier = pickCollapses(planCollapses(s.seats, s.hero, s.earlier))!;
      const r = replanKeeping(s.seats, s.hero, s.later, earlier.plans.map((p) => p.recipe!), 3, earlier.why)!;

      it("the earlier decision was a blend of the three single ghosts", () => {
        expect(earlier.mode).toBe("blend");
        expect(earlier.plans.map((p) => p.kind).sort()).toEqual(villainsOf(s).map((v) => `ghost:${v}`).sort());
      });

      it(`the two that hold are kept as they were (same seats, ranges and flop: the same root key); ${s.dropped} is gone`, () => {
        expect(r).not.toBeNull();
        expect(r.plans.map((p) => p.kind)).toEqual(s.kept);
        expect(r.plans.map((p) => p.kind)).not.toContain(s.dropped);
        expect(r.dropped.map((d) => d.kind)).toEqual([s.dropped]);
        expect(r.mode).toBe("blend");
        for (const k of s.kept) {
          const was = byKind(earlier.plans, k);
          const now = byKind(r.plans, k);
          expect(now.seats).toEqual(was.seats);
          expect(now.heroIdx).toBe(was.heroIdx);
          // the earlier decision's flop is a prefix of the flop now (the same root, the flop's checkpoint reused)
          expect(now.streets[0]!.slice(0, was.streets[0]!.length)).toEqual(was.streets[0]!);
          expect(now.recipe!.folds).toEqual([]);
        }
      });

      it("every villain is still in a tree — no legal ghost-only top-up exists, none is needed", () => {
        expect(r.added).toEqual([]);
        expect(r.uncovered).toEqual([]);
        expect(new Set(r.plans.flatMap(keptVillains))).toEqual(new Set(villainsOf(s)));
      });

      it("the villains who folded since fold INSIDE the trees that keep them (F tokens), not removed from the flop", () => {
        expect(r.since.sort()).toEqual(s.folders.slice().sort());
        for (const p of r.plans) {
          for (const f of s.folders) {
            if (!keptVillains(p).includes(f)) continue;
            expect(p.seats.map((x) => x.pos)).toContain(f);
            expect(p.streets.flat().some((t) => t.seat === f && t.tok === "F")).toBe(true);
          }
        }
      });

      it("the why names the dropped collapse and why, the kept ones, and who folded since", () => {
        expect(r.why).toContain(s.why);
        expect(r.why).toContain(`${s.kept.join(", ")} kept from the hand's earlier decision`);
        expect(r.why).toContain(`${s.folders.join(", ")} folded since`);
        expect(r.baseWhy).not.toContain("folded since");
      });
    });
  }

  it("hand 4923553178's river replays the turn's two (the memo is what the turn used): nothing dropped again", () => {
    const s = SHAPES[3]!;
    const earlier = pickCollapses(planCollapses(s.seats, s.hero, s.earlier))!;
    const turn = [s.later[0]!, toks(["R4", "SB"])];
    const t = replanKeeping(s.seats, s.hero, turn, earlier.plans.map((p) => p.recipe!), 3, earlier.why)!;
    expect(t.plans.map((p) => p.kind)).toEqual(["ghost:BTN", "ghost:CO"]);
    const river = replanKeeping(s.seats, s.hero, s.later, t.plans.map((p) => p.recipe!), 3, t.baseWhy)!;
    expect(river.dropped).toEqual([]);
    expect(river.plans.map((p) => p.kind)).toEqual(["ghost:BTN", "ghost:CO"]);
    expect(river.why).toBe(`${t.baseWhy}; CO, BTN folded since, inside the trees that hold them`);
  });
});

describe("replanKeeping tops a five-way pick back up to three, on the hand's real history", () => {
  const FIVE = seatsOf("SB", "BB", "HJ", "CO", "BTN");
  const flop0 = [toks()];
  // the CO bets the flop, the BTN folds: every kept collapse that ghosted the CO breaks
  const coBets = [toks(["X", "SB"], ["X", "BB"], ["X", "HJ"], ["R3", "CO"], ["F", "BTN"])];
  const earlier = pickCollapses(planCollapses(FIVE, "SB", flop0))!;
  const r = replanKeeping(FIVE, "SB", coBets, earlier.plans.map((p) => p.recipe!), 3, earlier.why)!;

  it("the earlier pick is the covering three", () => {
    expect(earlier.plans.map((p) => p.kind)).toEqual(["ghost:BB + ghost:BTN", "ghost:HJ + ghost:CO", "ghost:BB + ghost:CO"]);
  });

  it("the survivor first, then the top-ups that put the uncovered villains back, every villain in a tree", () => {
    expect(r.kept.map((p) => p.kind)).toEqual(["ghost:BB + ghost:BTN"]);
    expect(r.added.map((p) => p.kind)).toEqual(["ghost:BB + ghost:HJ", "ghost:HJ + ghost:BTN"]);
    expect(r.plans.length).toBe(3);
    expect(r.mode).toBe("blend");
    expect(new Set(r.plans.flatMap(keptVillains))).toEqual(new Set(["BB", "HJ", "CO", "BTN"]));
    // built over the original seats with the earlier folds (none): the BTN, who folded since, folds inside his trees
    for (const p of r.added) {
      expect(p.recipe!.folds).toEqual([]);
      if (keptVillains(p).includes("BTN")) expect(p.streets[0]!.map((t) => `${t.seat}:${t.tok}`)).toContain("BTN:F");
    }
    expect(r.why).toContain("ghost:HJ + ghost:CO dropped — the CO bet the flop; ghost:BB + ghost:CO dropped — the CO bet the flop");
    expect(r.why).toContain("ghost:BB + ghost:HJ added to keep the BTN in a tree; ghost:HJ + ghost:BTN added to keep the BB in a tree");
  });

  it("a fresh pick instead takes the BTN out of the flop (fold:BTN) — the history the top-ups avoid", () => {
    const fresh = pickCollapses(planCollapses(FIVE, "SB", coBets))!;
    expect(fresh.plans.every((p) => p.kind.startsWith("fold:BTN"))).toBe(true);
  });

  it("a merge never tops up ghost-only survivors, and a top-up never ghosts a seat with chips in", () => {
    for (const p of r.added) {
      expect(p.ghostOnly).toBe(true);
      expect(p.recipe!.ops.some((op) => "ghost" in op && op.ghost === "CO")).toBe(false);
    }
  });
});

describe("fastSolve: the kept collapses after a drop, a restart, and COLLAPSE_KEEP=off", () => {
  afterEach(() => { forgetKeptCollapses(); delete process.env.COLLAPSE_KEEP; });
  const s = SHAPES[0]!;   // hand 4924195300
  const earlier = () => pickCollapses(planCollapses(s.seats, s.hero, s.earlier))!;

  it("the memo becomes what was used: the next decision replays the two survivors", () => {
    keepCollapses(s.hand, s.hero, earlier());
    const turn = keptCollapsePick(s.hand, s.hero, s.seats, s.later)!;
    expect(turn.plans.map((p) => p.kind)).toEqual(["ghost:BB", "ghost:CO"]);
    expect(handFacts.collapses(s.hand)!.recipes).toEqual(turn.plans.map((p) => p.recipe!));
    const river = [...s.later, toks()];
    const again = keptCollapsePick(s.hand, s.hero, s.seats, river)!;
    expect(again.plans.map((p) => p.kind)).toEqual(["ghost:BB", "ghost:CO"]);
    expect(again.why).toContain("ghost:SB dropped — the SB bet the turn");
  });

  it("an API restart mid-hand (memory gone, the hand ledger kept) replays the same plans", () => {
    keepCollapses(s.hand, s.hero, earlier());
    const before = keptCollapsePick(s.hand, s.hero, s.seats, s.later)!;
    forgetKeptCollapses(true);
    handFacts.dropMemory();
    const after = keptCollapsePick(s.hand, s.hero, s.seats, s.later)!;
    expect(after).not.toBeNull();
    expect(after.plans.map((p) => p.kind)).toEqual(before.plans.map((p) => p.kind));
    expect(after.plans.map((p) => p.seats)).toEqual(before.plans.map((p) => p.seats));
    expect(after.why).toBe(before.why);
  });

  it("forgetKeptCollapses() clears the ledger too", () => {
    keepCollapses(s.hand, s.hero, earlier());
    expect(handFacts.collapses(s.hand)).toBeDefined();
    forgetKeptCollapses();
    expect(handFacts.collapses(s.hand)).toBeUndefined();
    expect(keptCollapsePick(s.hand, s.hero, s.seats, s.later)).toBeNull();
  });

  it("COLLAPSE_KEEP=off: nothing kept, the fresh pick at every decision", () => {
    keepCollapses(s.hand, s.hero, earlier());
    process.env.COLLAPSE_KEEP = "off";
    expect(keptCollapsePick(s.hand, s.hero, s.seats, s.later)).toBeNull();
  });

  it("nothing holds → null and the memo is dropped from memory and the ledger", () => {
    keepCollapses(s.hand, s.hero, earlier());
    // the SB bets, the BB raises, the CO calls: every single ghost is broken
    const all = [toks(...X("SB", "BB", "CO", "BTN")), toks(["R4", "SB"], ["R12", "BB"], ["C", "CO"])];
    expect(keptCollapsePick(s.hand, s.hero, s.seats, all)).toBeNull();
    expect(handFacts.collapses(s.hand)).toBeUndefined();
  });
});
