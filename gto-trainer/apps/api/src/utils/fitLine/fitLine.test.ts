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
