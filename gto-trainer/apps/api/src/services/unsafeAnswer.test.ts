/**
 * THE UNSAFE-ANSWER GUARD (2026-10-13). The calibration case is hand 4923635257 (answers row 16058): HJ QQ vs a CO 3-bet
 * and an SB cold-call; the pool cold-call lock timed out, QQ was answered on the plain tree where the SB's call is 0.10%
 * of his range, told Fold 77% — and every check passed, verdict by-design, no banner, auto-pressed. These tests pin the
 * pieces that now catch it: check #3 by node share alone, the lock failure as a FAILED path reason, the unsafe classifier,
 * check #2's residue villain, and check #3 on chart answers (the walk-snapped trap size, hand 4923399329).
 */
import { describe, expect, it } from "bun:test";
import { checkPreflopVillainLines, checkRangesSane } from "./chainChecks";
import { unsafeReasons, unsafeHoldOn } from "./unsafeAnswer";
import { scoreChartLine } from "./fastSolve";
import type { HrcNode } from "./hrc3max";

describe("check #3 preflop: residue by node share alone", () => {
  it("hand 4923635257's SB cold-call (0.10% of his range, trap hands above 2%) is a RESIDUE flag, not a pass", () => {
    const c = checkPreflopVillainLines([
      { seat: "CO", code: "R10.2", line: "F-R2.6", nodeFreq: 0.0671, maxHand: 1, offTree: false },
      { seat: "SB", code: "C", line: "F-R2.6-R10.2-F", nodeFreq: 0.001, maxHand: 0.6, offTree: false },
    ]);
    expect(c.status).toBe("flag");
    expect(c.text).toStartWith("RESIDUE:");
    expect(c.text).toContain("SB C");
    expect(c.text).not.toContain("CO R10.2");
  });
  it("every action at 1% or more passes, and the text says so (it used to say 'none under 1%' at 0.10%)", () => {
    const c = checkPreflopVillainLines([{ seat: "CO", code: "R10.2", line: "F-R2.6", nodeFreq: 0.0671, maxHand: 1, offTree: false }]);
    expect(c.status).toBe("pass");
    expect(c.text).toContain("all at 1% of his range or more");
  });
  it("not scored: na with the reason, never an absent check", () => {
    const c = checkPreflopVillainLines(null, "the villain actions on hero's line could not be scored inside 3 s");
    expect(c.status).toBe("na");
    expect(c.text).toContain("could not be scored");
  });
});

describe("check #2: a villain who is residue on the street", () => {
  const full = (w: number) => new Array<number>(1326).fill(w);
  it("a limper at 0.09 combos (answer 16384) is a RESIDUE flag", () => {
    const villain = new Array<number>(1326).fill(0);
    villain[100] = 0.09;
    const c = checkRangesSane({ seats: [{ pos: "UTG", range: villain }, { pos: "BB", range: full(1) }], heroIdx: 1, heroCombo: null, board: ["2c", "7d", "9h"] });
    expect(c.status).toBe("flag");
    expect(c.text).toStartWith("RESIDUE:");
    expect(c.text).toContain("UTG holds 0.09 combos");
  });
  it("real ranges pass", () => {
    const c = checkRangesSane({ seats: [{ pos: "UTG", range: full(0.2) }, { pos: "BB", range: full(1) }], heroIdx: 1, heroCombo: null, board: ["2c", "7d", "9h"] });
    expect(c.status).toBe("pass");
  });
});

describe("unsafeReasons", () => {
  const pass = (id: number) => ({ id, status: "pass" as const, text: "ok" });
  it("the calibration case, as it is built now: lock failed + #3 residue → unsafe on both counts", () => {
    const r = unsafeReasons({
      street: "preflop",
      reasons: [{ v: "by-design", code: "preflop:fit-empties", text: "" }, { v: "failed", code: "preflop:pool-coldcall-lock-failed", text: "COLD-CALL LOCK FAILED …" }],
      checks: { preflop: [checkPreflopVillainLines([{ seat: "SB", code: "C", line: "F-R2.6-R10.2-F", nodeFreq: 0.001, maxHand: 0.6, offTree: false }]), pass(12), pass(15)] },
    } as any);
    expect(r.some((x) => x.includes("cold-call lock failed"))).toBe(true);
    expect(r.some((x) => x.startsWith("preflop: RESIDUE:"))).toBe(true);
  });
  it("as it was stored on 2026-10-10 (no lock reason, #3 passed): nothing — which is exactly what went wrong", () => {
    expect(unsafeReasons({ street: "preflop", reasons: [{ v: "by-design", code: "preflop:fit-empties", text: "" }],
      checks: { preflop: [pass(3), pass(12), pass(14), pass(15), pass(16), pass(17)] } } as any)).toEqual([]);
  });
  it("a slow or costly answer is not unsafe (#9 #12 fails); an input / output check fail is (#5)", () => {
    expect(unsafeReasons({ street: "flop", checks: { flop: [{ id: 12, status: "fail", text: "slow" }, { id: 9, status: "fail", text: "extra tree" }] } } as any)).toEqual([]);
    expect(unsafeReasons({ street: "flop", checks: { flop: [{ id: 5, status: "fail", text: "pot 12 vs 18" }] } } as any)[0]).toContain("Pot and stack add up failed");
  });
  it("a postflop villain mistake line: unsafe on the decision street, by design on an earlier street (the soft range carries it)", () => {
    const flag = { id: 3, status: "flag" as const, text: "BB R17.6: 0.06% of his range, no hand above 12%" };
    expect(unsafeReasons({ street: "turn", checks: { turn: [flag] } } as any).length).toBe(1);
    expect(unsafeReasons({ street: "river", checks: { turn: [flag], river: [pass(3)] } } as any)).toEqual([]);
  });
  it("a pool lock lost at the flop: unsafe unless a floor gave the seat a pool range", () => {
    const lost = { how: "rebuilt", producer: "ai-arrival", code: "arrival:pool-lock-lost", lockLost: [{ pos: "SB", key: "coldcall3b_SB_40_80_large" }] };
    expect(unsafeReasons({ street: "flop", arrival: lost } as any)[0]).toContain("SB's pool lock");
    expect(unsafeReasons({ street: "flop", arrival: { ...lost, poolSeats: [{ pos: "SB", code: "arrival:pool-coldcall-floor" }] } } as any)).toEqual([]);
  });
  it("UNSAFE_HOLD: on unless set off", () => {
    const was = process.env.UNSAFE_HOLD;
    delete process.env.UNSAFE_HOLD; expect(unsafeHoldOn()).toBe(true);
    process.env.UNSAFE_HOLD = "off"; expect(unsafeHoldOn()).toBe(false);
    if (was === undefined) delete process.env.UNSAFE_HOLD; else process.env.UNSAFE_HOLD = was;
  });
});

describe("check #3 on a chart answer (scoreChartLine)", () => {
  // hand 4923399329's shape: HJ (hero) opens 2.6, the CO 3-bets and the walk read the 9.2 at R9 — a size the chart's CO
  // uses with almost nothing (his 3-bet lives at R7.5)
  const cells = (rows: [string, Record<string, number>][]) => rows.map(([hand, actions]) => ({ hand, actions }));
  const nodes: Record<string, HrcNode> = {
    "F": { pos: "HJ", terminal: false, actions: [{ action: "Fold", token: "F" }, { action: "Raise 2.6", token: "R2.6" }],
      cells: cells([["AA", { "Raise 2.6": 100 }], ["ATs", { "Raise 2.6": 100 }], ["72o", { Fold: 100 }]]) },
    "F-R2.6": { pos: "CO", terminal: false,
      actions: [{ action: "Fold", token: "F" }, { action: "Call", token: "C" }, { action: "Raise 7.5", token: "R7.5" }, { action: "Raise 9", token: "R9" }],
      cells: cells([["AA", { "Raise 7.5": 99, "Raise 9": 1 }], ["KK", { "Raise 7.5": 100 }], ["AKs", { "Raise 7.5": 100 }],
        ["QJs", { Call: 100 }], ["72o", { Fold: 100 }], ["T9o", { Fold: 100 }], ["K5o", { Fold: 100 }]]) },
    "": { pos: "UTG", terminal: false, actions: [{ action: "Fold", token: "F" }], cells: cells([["AA", { Fold: 100 }]]) },
  };
  const get = async (line: string) => nodes[line] ?? null;
  it("the 3-bet read at R9 is residue (AA's 1% alone), at R7.5 it is not", async () => {
    const r9 = await scoreChartLine(get, "F-R2.6-R9", "HJ");
    expect("lines" in r9).toBe(true);
    const lines = (r9 as { lines: any[] }).lines;
    expect(lines.map((l) => `${l.seat} ${l.code}`)).toEqual(["CO R9"]);            // UTG's fold and hero's open are not scored
    expect(lines[0].nodeFreq).toBeLessThan(0.01);
    expect(checkPreflopVillainLines(lines).text).toStartWith("RESIDUE:");
    const r75 = await scoreChartLine(get, "F-R2.6-R7.5", "HJ");
    expect(checkPreflopVillainLines((r75 as { lines: any[] }).lines).status).toBe("pass");
  });
  it("a node it cannot read: na with the reason", async () => {
    const r = await scoreChartLine(async () => null, "F-R2.6-R9", "HJ");
    expect("na" in r).toBe(true);
  });
});
