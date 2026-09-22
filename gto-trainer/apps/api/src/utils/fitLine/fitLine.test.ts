import { describe, expect, test } from "bun:test";
import { actorsWithAllins, walkFitted } from "./fitLine";

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
