/**
 * The preflop pin defeated by the AI tree's own cap (one caller behind an open, one limper) is the DESIGN for a 4-way
 * line, not a recovery (2026-10-07, Brady): by-design under arrival:pin-cap, counted clean. Every other pin miss stays
 * rebuilt under arrival:pin-unusable; no pin at all stays arrival:no-pin.
 */
import { describe, expect, test } from "bun:test";
import { pinMissProv } from "./fastSolve";
import { checkFlopArrival } from "./chainChecks";
import { isClean } from "./chainPath";

const via = "read from a GTO Wizard AI preflop tree built from the table";

describe("pinMissProv", () => {
  test("a second caller the tree does not offer is by design (clean) under its own code", () => {
    const p = pinMissProv({ pin: true, pinPiece: "gtow-ai-preflop", producer: "ai-arrival", via,
      pinMiss: "pinned AI tree gtow-ai · 6-handed · UTG:100/HJ:100/CO:100/BTN:100/SB:100/BB:100: 'C' is not offered at 'R2.5-F-F-C' (offered: F, R8.8, R100)" });
    expect(p.how).toBe("by-design");
    expect(p.code).toBe("arrival:pin-cap");
    expect(p.why).toContain("one caller behind an open and one limper");
    expect(p.why).toContain("'C' is not offered at 'R2.5-F-F-C'");
    const c = checkFlopArrival({ arrival: p });
    expect(c.status).toBe("pass");
    expect(c.text).toContain("by design");
    expect(isClean("by-design")).toBe(true);
  });
  test("a second limper ('C' at 'C-F-F') is the same cap", () => {
    expect(pinMissProv({ pin: true, pinMiss: "…: 'C' is not offered at 'C-F-F' (offered: F, R4, R49)", producer: "ai-arrival", via }).code).toBe("arrival:pin-cap");
  });
  test("any other pin miss stays a rebuilt recovery", () => {
    for (const miss of ["'R7' is not offered at 'R2.5' (offered: F, R8.8, R100)", "the line no longer starts with the pin", null]) {
      const p = pinMissProv({ pin: true, pinPiece: "chart6max", pinMiss: miss, producer: "recon6max", via: "read again from the 6-max chart the picker chooses" });
      expect(p.how).toBe("rebuilt");
      expect(p.code).toBe("arrival:pin-unusable");
      expect(checkFlopArrival({ arrival: p }).status).toBe("fail");
    }
  });
  test("no pin at all stays arrival:no-pin", () => {
    const p = pinMissProv({ pin: false, pinMiss: null, producer: "recon6max", via: "read again", extra: "probe never ran" });
    expect(p.code).toBe("arrival:no-pin");
    expect(p.how).toBe("rebuilt");
    expect(p.why).toContain("probe never ran");
  });
});
