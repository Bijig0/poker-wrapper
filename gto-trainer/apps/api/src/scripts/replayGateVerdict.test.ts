/**
 * The replay gate's verdict against a baseline (scripts/replayGateVerdict, 2026-10-13): the exit rule is the one of
 * 2026-10-04, and a PASS over decisions that changed without failing names them instead of reading as a clean PASS
 * (the 2026-10-13 run: 294 changed — SAME → CACHE-MISS / SKIPPED — and "VERDICT: PASS").
 */
import { describe, expect, it } from "bun:test";
import { type CodeDiff, fmtTransitions, gateVerdict, isCodeFail, transitions } from "./replayGateVerdict";

const VERDICTS = ["SAME", "DIFF", "NEW BODY", "NEW NODE", "REFUSAL-CHANGE", "CRASH", "CACHE-MISS", "SKIPPED"];
let n = 0;
const diff = (was: string, is: string): CodeDiff => ({ answer: ++n, hand: `h${n}`, street: "flop", was, is, baseline: `${was} · x`, now: `${is} · y` });
const many = (k: number, was: string, is: string) => Array.from({ length: k }, () => diff(was, is));

describe("isCodeFail", () => {
  it("is the exit rule of 2026-10-04 over every pair of verdicts", () => {
    const old = (d: CodeDiff) => /^(DIFF|REFUSAL-CHANGE|CRASH)/.test(d.now) && !/^CRASH/.test(d.baseline);
    for (const was of VERDICTS) for (const is of VERDICTS) { const d = diff(was, is); expect(isCodeFail(d)).toBe(old(d)); }
  });
});

describe("transitions", () => {
  it("counts by transition, the most first; the same verdict with another replay is named so", () => {
    const ds = [...many(4, "SAME", "SKIPPED"), ...many(290, "SAME", "CACHE-MISS"), diff("SAME", "SAME")];
    expect(transitions(ds)).toEqual([["SAME → CACHE-MISS", 290], ["SAME → SKIPPED", 4], ["SAME (another replay)", 1]]);
    expect(fmtTransitions(ds)).toBe("SAME → CACHE-MISS 290 · SAME → SKIPPED 4 · SAME (another replay) 1");
  });
});

describe("gateVerdict", () => {
  it("a bare PASS only when nothing differs from the control", () => {
    expect(gateVerdict("a9638ca", 0, [])).toEqual({ lines: ["VERDICT against a9638ca: PASS (0 decisions differ from the control)"], exit: 0 });
  });
  it("the 2026-10-13 run: SAME → CACHE-MISS / SKIPPED is a PASS to check, loudly, with the re-run hint — the exit stays 0", () => {
    const v = gateVerdict("a9638ca", 0, [...many(290, "SAME", "CACHE-MISS"), ...many(4, "SAME", "SKIPPED")]);
    expect(v.exit).toBe(0);
    expect(v.lines[0]).toBe("VERDICT against a9638ca: PASS — BUT 294 decision(s) changed against the control — CHECK THEM");
    expect(v.lines[1]).toBe("  SAME → CACHE-MISS 290 · SAME → SKIPPED 4");
    expect(v.lines.join("\n")).toMatch(/294 of them the control compared and this run did not/);
    expect(v.lines.join("\n")).toMatch(/re-run before trusting this PASS/);
  });
  it("an intended change (a DIFF fixed, a crash fixed) is a PASS to check, without the not-compared hint", () => {
    const v = gateVerdict("abc", 0, [diff("DIFF", "SAME"), diff("CRASH", "SAME")]);
    expect(v.lines[0]).toMatch(/PASS — BUT 2 decision\(s\) changed/);
    expect(v.lines.join("\n")).not.toMatch(/did not/);
  });
  it("decisions only one side replayed are no bare PASS (the comparison skips them)", () => {
    const v = gateVerdict("abc", 0, [], 7);
    expect(v.exit).toBe(0);
    expect(v.lines[0]).toBe("VERDICT against abc: PASS — BUT 7 replayed on one side only — CHECK THEM");
    expect(v.lines[1]).toMatch(/7 decision\(s\) were replayed by one of the two runs only/);
    expect(gateVerdict("abc", 0, [diff("SAME", "SKIPPED")], 2).lines[0]).toBe("VERDICT against abc: PASS — BUT 1 decision(s) changed against the control and 2 replayed on one side only — CHECK THEM");
  });
  it("a FAIL names the failing transitions and the rest", () => {
    expect(gateVerdict("abc", 1, [diff("SAME", "DIFF"), diff("SAME", "DIFF"), diff("SAME", "NEW BODY")])).toEqual({ exit: 1, lines: [
      "VERDICT against abc: FAIL (2 decision(s) became DIFF / REFUSAL-CHANGE / CRASH against the control)",
      "  SAME → DIFF 2",
      "  and 1 more changed without failing: SAME → NEW BODY 1",
    ] });
    expect(gateVerdict("abc", 1, [])).toEqual({ lines: ["VERDICT against abc: FAIL (a CRASH in this run)"], exit: 1 });
  });
  it("a stop, an odd exit, and a comparison that could not be read (no PASS without it)", () => {
    expect(gateVerdict("abc", 2, null)).toEqual({ lines: ["VERDICT against abc: STOPPED (a session went live)"], exit: 2 });
    expect(gateVerdict("abc", 64, null)).toEqual({ lines: ["VERDICT against abc: FAIL (the candidate run exited 64)"], exit: 64 });
    expect(gateVerdict("abc", null, null)).toEqual({ lines: ["VERDICT against abc: FAIL (the candidate run exited on a signal)"], exit: 1 });
    expect(gateVerdict("abc", 0, null)).toEqual({ lines: ["VERDICT against abc: FAIL (the candidate exited 0, but its comparison with the control could not be read)"], exit: 1 });
  });
});
