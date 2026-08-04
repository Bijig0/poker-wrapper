import { describe, expect, it } from "bun:test";
import { HU_SEATS, preflopClosed, preflopPotStack } from "./aiStudyLine";

describe("preflopClosed", () => {
  it("closed: fold-arounds and single raiser called", () => {
    expect(preflopClosed(["F", "F", "F", "F", "F"])).toBe(true); // walk
    expect(preflopClosed(["F", "F", "F", "R2.5", "F", "C"])).toBe(true); // BTN open, BB call
    expect(preflopClosed(["R2", "F", "F", "F", "F", "C"])).toBe(true); // UTG open, BB call
  });

  it("closed: 3-bet called after action returns to the opener", () => {
    // UTG opens, HJ 3-bets, folds around, UTG calls
    expect(preflopClosed(["R2", "R6.5", "F", "F", "F", "F", "C"])).toBe(true);
  });

  it("closed: limped pot needs the BB's check, not just the limp", () => {
    expect(preflopClosed(["F", "F", "F", "F", "C", "X"])).toBe(true); // SB limp, BB check
    expect(preflopClosed(["F", "F", "F", "F", "C"])).toBe(false); // BB still has the option
  });

  it("OPEN: the crawl's falsely-terminal holes", () => {
    // UTG opened, HJ 3-bet, everyone folded — UTG must still respond
    expect(preflopClosed(["R2", "R6.5", "F", "F", "F", "F"])).toBe(false);
    // HJ opened, CO 3-bet, BTN/SB folded, BB cold 4-bet — HJ and CO pending
    expect(preflopClosed(["F", "R2", "R6.5", "F", "F", "R17.5"])).toBe(false);
  });

  it("OPEN: unanswered open, unanswered 4-bet", () => {
    expect(preflopClosed(["R2", "F", "F", "F", "F"])).toBe(false); // BB never acted
    expect(preflopClosed(["R2", "R6.5", "F", "F", "F", "F", "R15"])).toBe(false); // HJ must respond
  });

  it("closed: everyone folds to a raise once all have acted", () => {
    expect(preflopClosed(["R2", "F", "F", "F", "F", "F"])).toBe(true); // hand over
  });
});

describe("preflopClosed — heads-up (HU_SEATS order)", () => {
  it("closed: SB open called, limp checked, 3-bet called", () => {
    expect(preflopClosed(["R2.5", "C"], HU_SEATS)).toBe(true);
    expect(preflopClosed(["C", "X"], HU_SEATS)).toBe(true);
    expect(preflopClosed(["R2.5", "R10", "C"], HU_SEATS)).toBe(true);
  });
  it("OPEN: unanswered SB open / limp", () => {
    expect(preflopClosed(["R2.5"], HU_SEATS)).toBe(false);
    expect(preflopClosed(["C"], HU_SEATS)).toBe(false);
  });
  it("the 6-max default MISREADS a closed HU line (the bug this guards)", () => {
    // with the 6-max rotation the walker thinks four more seats are pending
    expect(preflopClosed(["R2.5", "C"])).toBe(false);
  });
});

describe("preflopPotStack — heads-up (HU_SEATS order)", () => {
  it("SB open 2.5 called: pot 5, stacks 97.5 behind", () => {
    const { pot, stack } = preflopPotStack(["R2.5", "C"], 100, HU_SEATS);
    expect(pot).toBeCloseTo(5, 5);      // 2.5 + 2.5, blinds absorbed into the raise
    expect(stack).toBeCloseTo(97.5, 5);
  });
  it("limped pot: 1 + 1", () => {
    const { pot, stack } = preflopPotStack(["C", "X"], 100, HU_SEATS);
    expect(pot).toBeCloseTo(2, 5);
    expect(stack).toBeCloseTo(99, 5);
  });
  it("3-bet pot: 10 + 10", () => {
    const { pot } = preflopPotStack(["R2.5", "R10", "C"], 100, HU_SEATS);
    expect(pot).toBeCloseTo(20, 5);
  });
});
