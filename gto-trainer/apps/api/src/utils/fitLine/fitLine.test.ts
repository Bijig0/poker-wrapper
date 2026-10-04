import { describe, expect, test } from "bun:test";
import { actorsWithAllins, foldEarliestCaller, foldSeatsOut, walkFitted } from "./fitLine";

const n = (pos: string, toks: string[], terminal = false) =>
  ({ pos, terminal, actions: toks.map((t) => ({ action: t, token: t })), cells: [] });

describe("actorsWithAllins", () => {
  test("a jam takes the seat out of the rotation", () => {
    // UTG limps, HJ isos, UTG limp-JAMS (30bb stack), HJ calls — UTG never acts again
    expect(actorsWithAllins(["C", "R4.5", "F", "F", "F", "F", "R30", "C"], 30)).toEqual(
      ["UTG", "HJ", "CO", "BTN", "SB", "BB", "UTG", "HJ"]);
  });
});

describe("walkFitted", () => {
  // A tree that holds TWO limpers: at "C-C" the CO may not limp.
  const TREE: Record<string, any> = {
    "": n("UTG", ["F", "C", "R2.5"]),
    "C": n("HJ", ["F", "C", "R2.5"]),
    "F": n("HJ", ["F", "C", "R2.5"]),
    "C-C": n("CO", ["F", "R2.5"]),
    "F-C": n("CO", ["F", "C", "R2.5"]),
    "C-F": n("CO", ["F", "C", "R2.5"]),
    "F-C-C": n("BTN", ["F", "C", "R2.5"]),
    "C-F-C": n("BTN", ["F", "C", "R2.5"]),
  };
  const get = async (l: string) => TREE[l] ?? null;

  test("a third limper is fitted by folding the EARLIEST limper", async () => {
    const w = await walkFitted(["C", "C", "C"], get, { heroSeat: "BTN", stack: 100 });
    expect(w.ok).toBe(true);
    expect(w.fittedLine).toEqual(["F", "C", "C"]);
    expect(w.folds.map((f) => f.seat)).toEqual(["UTG"]);
  });

  test("hero's own limp is never the one folded", async () => {
    // hero is UTG, the first limper — the fold must skip him and take HJ
    const t: Record<string, any> = { ...TREE, "C-F-C": n("BTN", ["F", "C"]) };
    const w = await walkFitted(["C", "C", "C"], async (l) => t[l] ?? null, { heroSeat: "UTG", stack: 100 });
    expect(w.folds.every((f) => f.seat !== "UTG")).toBe(true);
  });

  test("a player who raises later is never folded — his raise is the spot", async () => {
    // UTG limps, HJ limps, CO limps, then UTG raises: UTG may not be folded, HJ goes first
    const w = await walkFitted(["C", "C", "C", "F", "F", "F", "R12"], async () => null, { heroSeat: "HJ", stack: 100, maxFolds: 3 });
    expect(w.folds.every((f) => f.seat !== "UTG")).toBe(true);
  });

  test("a chain of forced folds is stepped through", async () => {
    // after four entrants the SB AND the BB are force-folded: neither node exists, UTG's does
    const t: Record<string, any> = { "": n("UTG", ["F", "C"]), "C": n("HJ", ["F", "C"]), "C-C": n("CO", ["F", "R5"]),
      "C-C-R5": n("BTN", ["F", "C"]), "C-C-R5-C-F-F": n("UTG", ["F", "C"]) };
    const w = await walkFitted(["C", "C", "R5", "C", "F", "F"], async (l) => t[l] ?? null, { heroSeat: "UTG", stack: 100 });
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.node.pos).toBe("UTG");
    expect(w.folds).toEqual([]);
  });
});

describe("foldEarliestCaller", () => {
  const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
  test("eso-14: the limper who later folds goes, the limp-JAMMER stays (his raise is the spot)", () => {
    // UTG limp, HJ limp, CO iso 5, BTN 3-bet 17, SB 4-bet 38, BB folds, UTG jams, HJ folds — hero CO to act
    const r = foldEarliestCaller(["C", "C", "R5", "R17", "R38", "F", "R100", "F"], { keep: new Set(["CO"]), stack: 100, seats: SEATS })!;
    expect(r.fold.seat).toBe("HJ");
    expect(r.tokens).toEqual(["C", "F", "R5", "R17", "R38", "F", "R100"]);
    expect(r.fold.dropped).toEqual(["F"]);
  });
  test("per-seat stacks: a short limper's jam ends his turn, so the next token is the next seat's", () => {
    // UTG 30bb limps, HJ isos to 4.5, UTG jams 30 (all-in), HJ calls: the call is HJ's, and UTG may not be folded
    const who = actorsWithAllins(["C", "R4.5", "F", "F", "F", "F", "R30", "C"], { UTG: 30, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 });
    expect(who[7]).toBe("HJ");
    expect(foldEarliestCaller(["C", "R4.5", "F", "F", "F", "F", "R30"], { keep: new Set(["HJ"]), stack: { UTG: 30 }, seats: SEATS })).toBeNull();
  });
  test("the only caller is hero: nobody left to fold, null", () => {
    expect(foldEarliestCaller(["R2.5", "F", "C"], { keep: new Set(["CO"]), stack: 100, seats: SEATS })).toBeNull();
  });
});

describe("foldSeatsOut — the players an earlier decision was read without stay folded (harness seed 589 [limps])", () => {
  test("UTG's limp folded, his later fold dropped: hero's 3-bet decision reads the line his iso was read on", () => {
    // UTG and HJ limp, CO (hero) isos to 5 — read with UTG's limp folded (caller cap) — BTN 3-bets, blinds and
    // both limpers fold, back to hero: the walk must run F-C-R5-R15-F-F-F, not the real two-limp node
    expect(foldSeatsOut(["C", "C", "R5", "R15", "F", "F", "F", "F"], ["UTG"], 100)).toEqual(["F", "C", "R5", "R15", "F", "F", "F"]);
  });

  test("a seat with no call in the line is left alone; nothing to fold is the line itself", () => {
    const line = ["F", "C", "R5", "F"];
    expect(foldSeatsOut(line, ["UTG"], 100)).toEqual(line);
    expect(foldSeatsOut(line, [], 100)).toBe(line);
  });

  test("two seats, each its first call folded and its later actions dropped", () => {
    // UTG, HJ, CO limp; BTN isos; UTG and HJ call the iso: UTG and HJ folded out → F-F-C-R5 + the rest without them
    expect(foldSeatsOut(["C", "C", "C", "R5", "F", "F", "C", "C", "F"], ["UTG", "HJ"], 100)).toEqual(["F", "F", "C", "R5", "F", "F", "F"]);
  });
});

describe("emptiedGroups — the fit may thin a crowd, never empty it (2026-10-04, hand 4922293970)", () => {
  const { callerGroups, emptiedGroups, groupText } = require("./fitLine");
  const opts = (heroSeat: string, stack: number | Record<string, number> = 100) => ({ heroSeat, stack });

  test("groups are per raise level: limpers at 0, callers of the k-th raise at k; hero is in none", () => {
    // UTG limps, HJ (hero) limps, CO isos, BTN calls the iso, SB 3-bets, BB calls the 3-bet
    expect(callerGroups(["C", "C", "R5", "C", "R18", "C"], opts("HJ"))).toEqual([
      { level: 0, kind: "limp", seats: ["UTG"] },
      { level: 1, kind: "call", seats: ["BTN"] },
      { level: 2, kind: "call", seats: ["BB"] },
    ]);
    // the big blind's free check is not a call; hero's own calls are nobody's group
    expect(callerGroups(["F", "F", "F", "F", "C", "X"], opts("BB"))).toEqual([{ level: 0, kind: "limp", seats: ["SB"] }]);
    expect(callerGroups(["R2.5", "F", "C"], opts("CO"))).toEqual([]);
  });

  test("the only limper folded out: emptied — the short UTG limp the chart pruned (HJ ATo read as first in)", () => {
    const e = emptiedGroups(["C"], ["UTG"], opts("HJ"));
    expect(e).toEqual([{ level: 0, kind: "limp", seats: ["UTG"] }]);
    expect(groupText(e[0])).toBe("UTG's limp");
    // …also when the pot has been raised since: he is still the table's only limper
    expect(emptiedGroups(["C", "F", "R3", "R9"], ["UTG"], opts("SB"))).toHaveLength(1);
  });

  test("the only caller of a raise folded out: emptied — the short SB's flat of a button open", () => {
    const e = emptiedGroups(["F", "F", "F", "R2.6", "C"], ["SB"], opts("BB"));
    expect(e).toEqual([{ level: 1, kind: "call", seats: ["SB"] }]);
    expect(groupText(e[0])).toBe("SB's call of the raise");
    // the cold-caller of a 3-bet (hand 4921727399: CO opens, BTN 3-bets, SB calls, back to the CO)
    const e3 = emptiedGroups(["F", "F", "R2.6", "R7", "C", "F"], ["SB"], opts("CO"));
    expect(e3.map(groupText)).toEqual(["SB's call of the 3-bet"]);
  });

  test("a crowd thinned is not emptied: three limpers read as two, three callers as two", () => {
    expect(emptiedGroups(["C", "C", "C"], ["UTG"], opts("BTN"))).toEqual([]);
    expect(emptiedGroups(["R2.5", "C", "C", "C"], ["HJ"], opts("SB"))).toEqual([]);
    // the caller-cap borrow behind two limpers (F-C-C, HJ folded out): the CO still limps
    expect(emptiedGroups(["F", "C", "C"], ["HJ"], opts("BTN"))).toEqual([]);
  });

  test("…but every member folded out is: both limpers gone, or the limper kept and the lone caller gone", () => {
    expect(emptiedGroups(["C", "C"], ["UTG", "HJ"], opts("CO")).map(groupText)).toEqual(["UTG's and HJ's limps"]);
    // UTG limps, HJ isos, CO and BTN call: folding the limper AND one caller empties the limpers only
    expect(emptiedGroups(["C", "R5", "C", "C"], ["UTG", "CO"], opts("SB")).map((g: any) => g.level)).toEqual([0]);
  });

  test("nothing folded, or a seat with no call in the line: nothing emptied", () => {
    expect(emptiedGroups(["C", "R4"], [], opts("CO"))).toEqual([]);
    expect(emptiedGroups(["F", "C", "R4"], ["UTG"], opts("BTN"))).toEqual([]);
  });

  test("a short stack's limp-jam takes him out of the rotation: the later call is the next seat's", () => {
    // UTG (30bb) limps, HJ isos, folds round, UTG jams, HJ calls — hero is the BB long gone; the level-2 caller is HJ
    const g = callerGroups(["C", "R4.5", "F", "F", "F", "F", "R30", "C"], opts("BB", { UTG: 30, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }));
    expect(g).toEqual([{ level: 0, kind: "limp", seats: ["UTG"] }, { level: 2, kind: "call", seats: ["HJ"] }]);
  });
});

describe("walkFitted on a branch the chart never exported (a pruned limp)", () => {
  const { emptiedGroups } = require("./fitLine");
  // UTG's limp is a terminal with no actions (HRC pruned a 0.07% branch): the fit folds him and reads the first-in node
  const TREE: Record<string, any> = {
    "": n("UTG", ["F", "C", "R2.5"]),
    "C": n("HJ", [], true),
    "F": n("HJ", ["F", "C", "R2.5"]),
    "F-C": n("CO", ["F", "C", "R4"]),
  };
  const get = async (l: string) => TREE[l] ?? null;

  test("the fit succeeds by deleting the only limper — which is exactly what emptiedGroups names", async () => {
    const w = await walkFitted(["C"], get, { heroSeat: "HJ", stack: 100 });
    expect(w.ok).toBe(true);
    expect(w.fittedLine).toEqual(["F"]);
    expect(emptiedGroups(["C"], w.folds.map((f) => f.seat), { heroSeat: "HJ", stack: 100 })).toHaveLength(1);
  });

  test("two limpers, the pruned one folded: one limper is left, the chart keeps the line", async () => {
    const w = await walkFitted(["C", "C"], get, { heroSeat: "CO", stack: 100 });
    expect(w.ok).toBe(true);
    expect(w.fittedLine).toEqual(["F", "C"]);
    expect(emptiedGroups(["C", "C"], w.folds.map((f) => f.seat), { heroSeat: "CO", stack: 100 })).toEqual([]);
  });
});
