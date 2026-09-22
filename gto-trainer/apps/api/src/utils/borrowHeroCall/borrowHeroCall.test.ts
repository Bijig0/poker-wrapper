import { describe, expect, it } from "bun:test";
import { actorsOfLine, borrowHeroCall, type BorrowNode } from "./borrowHeroCall";

const node = (pos: string | null, tokens: (string | null)[], terminal = false): BorrowNode => ({
  pos, terminal, actions: tokens.map((token) => ({ token })),
});
const table = (m: Record<string, BorrowNode>) => async (line: string) => m[line] ?? null;

describe("actorsOfLine", () => {
  it("walks the 6-max rotation, dropping folded seats", () => {
    expect(actorsOfLine(["R2.5", "C", "C"])).toEqual(["UTG", "HJ", "CO"]);
    expect(actorsOfLine(["F", "F", "R2.5", "C", "F", "C"])).toEqual(["UTG", "HJ", "CO", "BTN", "SB", "BB"]);
  });
});

describe("borrowHeroCall", () => {
  const heroNode = node("BTN", ["F", "R7.5", "R9"]);            // the real spot: no call in the tree
  const donorNode = node("BTN", ["F", "C", "R7.5", "R9"]);      // one caller fewer: the call exists

  it("borrows hero's decision from the node with the earlier caller folded", async () => {
    const r = await borrowHeroCall(["R2.5", "C", "C"], heroNode, table({ "R2.5-F-C": donorNode }), { heroPos: "BTN" });
    expect(r).not.toBeNull();
    expect(r!.line).toBe("R2.5-F-C");
    expect(r!.dropped).toBe("HJ");                              // the FIRST other caller, not the last
    expect(r!.index).toBe(1);
    expect(r!.node).toBe(donorNode);
  });

  it("does nothing when hero's call is already in the tree", async () => {
    const withCall = node("BTN", ["F", "C", "R7.5"]);
    let asked = 0;
    const r = await borrowHeroCall(["R2.5", "C", "C"], withCall, async (l) => { asked++; return donorNode; }, { heroPos: "BTN" });
    expect(r).toBeNull();
    expect(asked).toBe(0);                                      // not even a lookup
  });

  it("leaves a no-limp tree alone — no donor offers a call either, so it is design, not a caller cap", async () => {
    const noLimpDonor = node("BTN", ["F", "R7.5"]);
    const r = await borrowHeroCall(["R2.5", "C", "C"], heroNode, table({ "R2.5-F-C": noLimpDonor }), { heroPos: "BTN" });
    expect(r).toBeNull();
  });

  it("never folds hero's OWN earlier call out of the line", async () => {
    // UTG limps (hero), HJ limps, CO raises, UTG (hero) faces it with no call in the tree
    const r = await borrowHeroCall(
      ["C", "C", "R5"], node("UTG", ["F", "R12"]),
      table({ "F-C-R5": node("UTG", ["F", "C", "R12"]), "C-F-R5": node("UTG", ["F", "C", "R12"]) }),
      { heroPos: "UTG" }
    );
    expect(r).not.toBeNull();
    expect(r!.dropped).toBe("HJ");                              // hero's own limp at index 0 was skipped
    expect(r!.index).toBe(1);
  });

  it("refuses a donor whose acting seat differs — the fold shifted the rotation", async () => {
    const r = await borrowHeroCall(["R2.5", "C", "C"], heroNode, table({ "R2.5-F-C": node("SB", ["F", "C"]) }), { heroPos: "BTN" });
    expect(r).toBeNull();
  });

  it("refuses a terminal or missing donor", async () => {
    expect(await borrowHeroCall(["R2.5", "C", "C"], heroNode, table({ "R2.5-F-C": node("BTN", ["F", "C"], true) }), { heroPos: "BTN" })).toBeNull();
    expect(await borrowHeroCall(["R2.5", "C", "C"], heroNode, table({}), { heroPos: "BTN" })).toBeNull();
    expect(await borrowHeroCall(["R2.5", "C", "C"], heroNode, async () => "unreachable", { heroPos: "BTN" })).toBeNull();
  });

  it("tries every earlier caller, not just the first", async () => {
    const r = await borrowHeroCall(
      ["R2.5", "C", "C", "C"], node("BTN", ["F", "R7.5"]),
      table({ "R2.5-C-F-C": node("BTN", ["F", "C", "R7.5"]) }), // only the SECOND caller's fold has a donor
      { heroPos: "BTN" }
    );
    expect(r).not.toBeNull();
    expect(r!.index).toBe(2);
    expect(r!.dropped).toBe("CO");
  });
});
