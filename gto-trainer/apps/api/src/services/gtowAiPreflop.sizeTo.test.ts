import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { debugTree, largestPostOf, raiseCodeAt, sizeTo, sizesFor } from "./gtowAiPreflop";
import type { LockedPlan } from "../utils/lockedHeadsUp/lockedHeadsUp";

/**
 * THE SIZE UNIT (2026-10-04, gtowAiPreflop.sizeTo; probes in scripts/_probeNodeLockStageA.ts `units` `straddle`):
 * "<N>bb" in a preflop size list is N × the tree's LARGEST post. Every tree the builder makes today has a 1bb largest
 * post, so its body must be BYTE-IDENTICAL to what main (2a39ce6) built: 24 archived decisions (2-6 seats, limps, every
 * raise level, all-ins, a 0.4 NL5 small blind) were dumped from main into __fixtures__/preflopTreeBodies.2a39ce6.json.
 */
const FIX = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "preflopTreeBodies.2a39ce6.json"), "utf8")) as { id: string; heroPos: string | null; hand: any; line: string; body: any }[];

describe("a tree whose largest post is 1bb is written exactly as before", () => {
  it(`${FIX.length} archived decisions: the same body, byte for byte`, () => {
    expect(FIX.length).toBeGreaterThanOrEqual(20);
    for (const f of FIX) {
      const dt = debugTree(f.hand, f.heroPos);
      if ("error" in dt) throw new Error(`${f.id}: ${dt.error}`);
      expect(largestPostOf(dt.shape)).toBe(1);
      expect(dt.line).toBe(f.line);
      expect(JSON.stringify(dt.body)).toBe(JSON.stringify(f.body));
    }
  });
  it("sizeTo at a 1bb largest post is the chips, as written before; sizesFor leaves the list alone", () => {
    for (const x of [2, 2.5, 2.6, 8.75, 13.4, 82.6, 100, 153.5, 0.01]) expect(sizeTo(x, 1)).toBe(`${Math.round(x * 100) / 100}bb`);
    const list = ["2.2x", "8.75bb", "100bb"];
    expect(sizesFor(list, 1)).toBe(list);
  });
});

describe("a larger post: N of it", () => {
  it("measured: 6bb over 0.5/3 is R18, 13bb over 2.6/1 is R33.8, 6bb on a straddle of 2 is R12 — so a raise to R chips is R / the largest post", () => {
    expect(sizeTo(18, 3)).toBe("6bb");
    expect(sizeTo(33.8, 2.6)).toBe("13bb");
    expect(sizeTo(12, 2)).toBe("6bb");
    expect(sizeTo(8.75, 2)).toBe("4.375bb");                         // three decimals: the amount survives
    expect(sizesFor(["2.5x", "13bb", "100bb"], 2)).toEqual(["2.5x", "6.5bb", "50bb"]);   // a multiple is of the bet faced: kept
    expect(largestPostOf({ sb: 0.5, bb: 1, straddle: { pos: "UTG", bb: 2 } })).toBe(2);
    expect(largestPostOf({ sb: 0.01, bb: 1, straddle: null })).toBe(1);
  });
  it("a node named at another amount than the one listed is not used (the locked tree's raise)", () => {
    const plan = { raiserAllIn: false, raiseToTree: 8.2, stacks: { SB: 100, BB: 100 } } as unknown as LockedPlan;
    const sols = (codes: string[]) => codes.map((code) => ({ action: { code, allin: false } }));
    expect(raiseCodeAt(sols(["F", "R8.2", "R100"]), plan)).toBe("R8.2");
    expect(raiseCodeAt(sols(["F", "R8.3", "R100"]), plan)).toBeNull();
    expect(raiseCodeAt(sols(["F", "R16.4"]), plan)).toBeNull();     // "8.2bb" read as 8.2 × 2
  });
});
