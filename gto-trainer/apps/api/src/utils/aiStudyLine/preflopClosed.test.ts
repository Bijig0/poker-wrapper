import { describe, expect, it } from "bun:test";
import { preflopClosed } from "./aiStudyLine";

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
