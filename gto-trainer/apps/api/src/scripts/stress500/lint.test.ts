import { describe, expect, test } from "bun:test";
import { actionKind, classOf, evaluate, lintHand, strongMade, type LintDecision, type LintHand, type LintView } from "./lint";
import { CLASSES } from "./views";

const cards = (s: string): string[] => s.match(/../g) ?? [];

describe("evaluate (7 cards)", () => {
  const cat = (s: string) => evaluate(cards(s)).name;
  test("every category", () => {
    expect(cat("AsKd7c4h2s9dJc")).toBe("high card");
    expect(cat("AsAd7c4h2s9dJc")).toBe("pair");
    expect(cat("AsAd7c7h2s9dJc")).toBe("two pair");
    expect(cat("AsAd7c7h2s2dJc")).toBe("two pair"); // three pairs: still two pair
    expect(cat("AsAdAc7h2s9dJc")).toBe("trips");
    expect(cat("5s6d7c8h9sKdKc")).toBe("straight");
    expect(cat("As2d3c4h5sKdKc")).toBe("straight"); // the wheel
    expect(cat("TsJdQcKhAs2d3c")).toBe("straight"); // broadway
    expect(cat("QsKdAc2h3s8d8c")).toBe("pair"); // no wrap-around
    expect(cat("As9s7s4s2sKdKc")).toBe("flush");
    expect(cat("AsAdAc7h7s9dJc")).toBe("full house");
    expect(cat("AsAdAc7h7s7dJc")).toBe("full house"); // two trips
    expect(cat("AsAdAcAh7s9dJc")).toBe("quads");
    expect(cat("5s6s7s8s9sKdKc")).toBe("straight flush");
    expect(cat("As2s3s4s5sKdKc")).toBe("straight flush"); // steel wheel
  });
  test("a flush beats the straight it sits beside; a flush and a straight in different cards is not a straight flush", () => {
    expect(cat("5s6s7s8d9sKsKc")).toBe("flush");
  });
  test("works on 5 and 6 cards", () => {
    expect(cat("AsAd7c7h2s")).toBe("two pair");
    expect(cat("5s6d7c8h9sKd")).toBe("straight");
  });
});

describe("strongMade", () => {
  const m = (h: string, b: string) => strongMade(cards(h), cards(b));
  test("real two pair only", () => {
    expect(m("AdKc", "AsKh7c")).toBe("two pair");
    expect(m("6h6c", "9c9sTd")).toBeNull(); // pocket pair under a paired board
    expect(m("Ad5d", "5s6s6c")).toBeNull(); // one pair + the board's pair
  });
  test("set and trips, not board trips", () => {
    expect(m("7d7c", "7sKhQc")).toBe("set");
    expect(m("KsJs", "4s4h4cTs")).toBeNull(); // board trips
    expect(m("AhKs", "AsAdQc")).toBe("trips");
  });
  test("straight only on a clean board", () => {
    expect(m("QdTd", "9sJs3c8hKd")).toBe("straight");
    expect(m("QdTd", "9sJs3s8sKd")).toBeNull(); // 4-flush board
    expect(m("QdTd", "9sJh9c8hKd")).toBeNull(); // paired board
  });
  test("flush or better always", () => {
    expect(m("AsKs", "2s7s9sQd")).toBe("flush");
    expect(m("AsAd", "AcKhKd")).toBe("full house");
  });
  test("nothing for one pair or a draw", () => {
    expect(m("AsKd", "AcJh2s")).toBeNull();
    expect(m("AsKs", "2s7s9d")).toBeNull();
  });
});

test("classOf / actionKind", () => {
  expect(classOf(["Kd", "As"])).toBe("AKo");
  expect(classOf(["9h", "Th"])).toBe("T9s");
  expect(classOf(["5c", "5h"])).toBe("55");
  expect(actionKind("BET 9.1")).toBe("bet-raise");
  expect(actionKind("Raise 42")).toBe("bet-raise");
  expect(actionKind("ALLIN 69.75")).toBe("all-in");
  expect(actionKind("All-in 94.2")).toBe("all-in");
  expect(actionKind("RAISE 21")).toBe("bet-raise");
  expect(actionKind("CALL 5.25")).toBe("call");
  expect(actionKind("CHECK")).toBe("check");
  expect(actionKind("Fold")).toBe("fold");
});

// ── the rules on tiny hands ─────────────────────────────────────────────────────────────────────────────────────────

const HAND = (heroCards: string, board: string, stacks?: Record<string, number>): LintHand => ({
  positions: { "1": "BTN", "2": "SB", "3": "BB" }, heroSeatId: 3, heroCards: cards(heroCards), board: cards(board),
  startStacks: stacks ?? { "1": 100, "2": 100, "3": 100 },
});
const mix = (xs: Record<string, number>) => Object.entries(xs).map(([action, frequency]) => ({ action, frequency }));
const D = (index: number, street: string, actions: Record<string, number>, extra: Partial<LintDecision> = {}): LintDecision =>
  ({ index, street, ok: true, toCall: 0, actions: mix(actions), took: { type: "check" }, ...extra });
const range = (cls: string, w: number): number[] => CLASSES.map((c) => (c === cls ? w : 0.5));
const V = (street: string, actor: string, heroRange: number[] | null, heroMix?: Record<string, number>, src = "tree #1"): LintView => ({
  street, actor, src, ranges: { BB: heroRange, BTN: null }, heroMix: heroMix ? Object.entries(heroMix).map(([action, p]) => ({ action, p })) : null,
});
const flagsOf = (r: ReturnType<typeof lintHand>, i: number) => r.flags.get(i) ?? [];

describe("fold-strong", () => {
  test("a set folding 60% to a bet", () => {
    const r = lintHand(HAND("7d7c", "7sKhQc2d3h"), [D(5, "flop", { FOLD: 60, "CALL 4": 40 }, { toCall: 4, took: { type: "call" } })], {});
    expect(flagsOf(r, 5)).toEqual(["fold-strong"]);
    expect(r.notes.get(5)?.[0]).toContain("set with 7d7c on 7sKhQc folds 60%");
  });
  test("not a pocket pair under a paired board, not under 50%, not when checking is free", () => {
    expect(flagsOf(lintHand(HAND("6h6c", "9c9sTd"), [D(5, "flop", { FOLD: 100 }, { toCall: 3 })], {}), 5)).toEqual([]);
    expect(flagsOf(lintHand(HAND("7d7c", "7sKhQc"), [D(5, "flop", { FOLD: 40, "CALL 4": 60 }, { toCall: 4 })], {}), 5)).toEqual([]);
    expect(flagsOf(lintHand(HAND("7d7c", "7sKhQc"), [D(5, "flop", { FOLD: 60, CHECK: 40 }, { toCall: 0 })], {}), 5)).toEqual([]);
  });
  test("reads the board as of the decision's street", () => {
    // the river pairs nothing here, but on the flop hero only has a gutshot
    expect(flagsOf(lintHand(HAND("QdTd", "9sJs3c8hKd"), [D(5, "flop", { FOLD: 90 }, { toCall: 5 })], {}), 5)).toEqual([]);
    expect(flagsOf(lintHand(HAND("QdTd", "9sJs3c8hKd"), [D(7, "turn", { FOLD: 90 }, { toCall: 5 })], {}), 7)).toEqual(["fold-strong"]);
  });
});

describe("check-monster-river", () => {
  test("a full house checking 95% when checked to", () => {
    const r = lintHand(HAND("AsAd", "AcKhKd2s3c"), [D(9, "river", { CHECK: 95, "BET 10": 5 })], {});
    expect(flagsOf(r, 9)).toEqual(["check-monster-river"]);
  });
  test("not under 90%, not facing a bet, not on the turn, not a flush", () => {
    expect(flagsOf(lintHand(HAND("AsAd", "AcKhKd2s3c"), [D(9, "river", { CHECK: 80, "BET 10": 20 })], {}), 9)).toEqual([]);
    expect(flagsOf(lintHand(HAND("AsAd", "AcKhKd2s3c"), [D(9, "river", { "CALL 5": 95, FOLD: 5 }, { toCall: 5 })], {}), 9)).toEqual([]);
    expect(flagsOf(lintHand(HAND("AsAd", "AcKhKd2s3c"), [D(9, "turn", { CHECK: 95, "BET 10": 5 })], {}), 9)).toEqual([]);
    expect(flagsOf(lintHand(HAND("AsKs", "2s7s9sQd3c"), [D(9, "river", { CHECK: 99 })], {}), 9)).toEqual([]);
  });
});

describe("hero-hand-absent", () => {
  const hero = "AsKd"; // AKo
  test("real: every earlier hero action at 1%+ of our mix", () => {
    const decs = [D(4, "preflop", { Fold: 70, Call: 30 }, { took: { type: "call" }, toCall: 2 }), D(8, "flop", { CHECK: 50, "BET 3": 50 })];
    const r = lintHand(HAND(hero, "2c7h9d"), decs, { "8": V("flop", "BB", range("AKo", 0.01)) });
    expect(flagsOf(r, 8)).toEqual(["hero-hand-absent-real"]);
  });
  test("script: an earlier hero action our mix gave under 1%", () => {
    const decs = [D(4, "preflop", { Fold: 99.5, Call: 0.5 }, { took: { type: "call" }, toCall: 2 }), D(8, "flop", { CHECK: 50, "BET 3": 50 })];
    const r = lintHand(HAND(hero, "2c7h9d"), decs, { "8": V("flop", "BB", range("AKo", 0.01)) });
    expect(flagsOf(r, 8)).toEqual(["hero-hand-absent-script"]);
    expect(r.notes.get(8)?.[0]).toContain("call (our mix 0.5%, step 4)");
  });
  test("a scripted raise counts any aggressive share (bet / raise / all-in), so a raise-vs-all-in label is not off the pick", () => {
    const decs = [D(4, "preflop", { Fold: 90, "All-in": 10 }, { took: { type: "raise" }, toCall: 2 }), D(8, "flop", { CHECK: 100 })];
    expect(flagsOf(lintHand(HAND(hero, "2c7h9d"), decs, { "8": V("flop", "BB", range("AKo", 0)) }), 8)).toEqual(["hero-hand-absent-real"]);
  });
  test("not when another tree of the blend holds the hand, not at 0.02+, not at a villain's node", () => {
    const decs = [D(8, "flop", { CHECK: 100 })];
    expect(flagsOf(lintHand(HAND(hero, "2c7h9d"), decs, { "8": V("flop", "BB", range("AKo", 0)) }, { "8": [V("flop", "BB", range("AKo", 0.3))] }), 8)).toEqual([]);
    expect(flagsOf(lintHand(HAND(hero, "2c7h9d"), decs, { "8": V("flop", "BB", range("AKo", 0.02)) }), 8)).toEqual([]);
    expect(flagsOf(lintHand(HAND(hero, "2c7h9d"), decs, { "8": V("flop", "BTN", range("AKo", 0)) }), 8)).toEqual([]);
  });
});

describe("collapses-disagree / served-minority", () => {
  const decs = (pick: string) => [D(8, "flop", { CHECK: 50, "BET 3": 50 }, { pick })];
  test("two trees, check vs bet, each 60%+", () => {
    const r = lintHand(HAND("AsKd", "2c7h9d"), decs("CHECK"), { "8": V("flop", "BB", null, { Check: 90, "Bet 3 (33%)": 10 }, "tree #1 · ghost:CO") },
      { "8": [V("flop", "BB", null, { Check: 20, "Bet 3 (33%)": 80 }, "tree #2 · ghost:SB")] });
    expect(flagsOf(r, 8)).toEqual(["collapses-disagree"]); // 1 vs 1: no strict majority
    expect(r.plans.get(8)?.map((p) => p.kind)).toEqual(["check", "bet-raise"]);
    expect(r.notes.get(8)?.[0]).toContain("#1 · ghost:CO: Check 90% | #2 · ghost:SB: Bet 3 (33%) 80% → served CHECK");
  });
  test("served-minority when a strict majority picks another kind (case-insensitive: CHECK = Check)", () => {
    const views = { "8": V("flop", "BB", null, { Check: 90, "Bet 3": 10 }) };
    const alts = { "8": [V("flop", "BB", null, { Check: 10, "Bet 3": 90 }), V("flop", "BB", null, { Check: 5, "Bet 3": 95 })] };
    expect(flagsOf(lintHand(HAND("AsKd", "2c7h9d"), decs("CHECK"), views, alts), 8)).toEqual(["collapses-disagree", "served-minority"]);
    expect(flagsOf(lintHand(HAND("AsKd", "2c7h9d"), decs("BET 3"), views, alts), 8)).toEqual(["collapses-disagree"]);
  });
  test("bet and raise are one kind; a top under 60% does not count; one tree is no disagreement; not preflop", () => {
    expect(flagsOf(lintHand(HAND("AsKd", "2c7h9d"), decs("BET 3"), { "8": V("flop", "BB", null, { "Bet 3": 90, Check: 10 }) }, { "8": [V("flop", "BB", null, { "Raise 9": 90, Fold: 10 })] }), 8)).toEqual([]);
    expect(flagsOf(lintHand(HAND("AsKd", "2c7h9d"), decs("CHECK"), { "8": V("flop", "BB", null, { Check: 90, "Bet 3": 10 }) }, { "8": [V("flop", "BB", null, { Check: 45, "Bet 3": 55 })] }), 8)).toEqual([]);
    expect(flagsOf(lintHand(HAND("AsKd", "2c7h9d"), decs("CHECK"), { "8": V("flop", "BB", null, { Check: 90, "Bet 3": 10 }) }), 8)).toEqual([]);
    expect(lintHand(HAND("AsKd", "2c7h9d"), decs("CHECK"), { "8": V("flop", "BB", null, { Check: 90, "Bet 3": 10 }) }).plans.size).toBe(0);
  });
});

describe("deep-vs-rung", () => {
  const chart = (gametype: string) => [D(4, "preflop", { Fold: 50, "Raise 2.5": 50 }, { source: "hrc-6max-preflop", gametype })];
  test("a D100 chart for an effective 200bb", () => {
    const r = lintHand(HAND("AsKd", "", { "1": 250, "2": 100, "3": 200 }), chart("ign200_6max_D100_s70_UTG_o3"), {});
    expect(flagsOf(r, 4)).toEqual(["deep-vs-rung"]);
    expect(r.notes.get(4)?.[0]).toContain("effective 200bb (hero 200, deepest other 250)");
  });
  test("effective = hero against the DEEPEST other stack; inside / 1.35 is fine; GTO Wizard answers are not charts", () => {
    expect(flagsOf(lintHand(HAND("AsKd", "", { "1": 100, "2": 100, "3": 300 }), chart("ign200_6max_D100_o2_5"), {}), 4)).toEqual([]);
    expect(flagsOf(lintHand(HAND("AsKd", "", { "1": 130, "2": 100, "3": 130 }), chart("ign200_6max_D100_o2_5"), {}), 4)).toEqual([]);
    expect(flagsOf(lintHand(HAND("AsKd", "", { "1": 140, "2": 100, "3": 140 }), chart("ign200_6max_D100_o2_5"), {}), 4)).toEqual(["deep-vs-rung"]);
    const ai = [D(4, "preflop", { Fold: 100 }, { source: "gtow-ai-preflop", gametype: "gtow-ai · 6-handed · UTG:300" })];
    expect(flagsOf(lintHand(HAND("AsKd", "", { "1": 300, "2": 100, "3": 300 }), ai, {}), 4)).toEqual([]);
  });
});

test("a refused decision is never linted", () => {
  const r = lintHand(HAND("7d7c", "7sKhQc"), [{ ...D(5, "flop", { FOLD: 100 }, { toCall: 4 }), ok: false }], {});
  expect(r.flags.size).toBe(0);
});
