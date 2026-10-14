/**
 * THE CHAIN'S INVARIANTS (services/chainChecks, 2026-09-27): every check is a pure function; the verdict folds them in.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  CHECKS, SolveTimes, addChecks, asWalkedEarlier, checkAnswerClock, checkBoard, checkButtons, checkCode, checkFlopArrival,
  checkFresh, checkHandoff, checkHeroCombo, checkLine, checkMistakeLines, checkMix, checkNodeReads, checkPotStack, HERO_ABSENT_DUST, heroAbsentBound,
  checkPreflopInRange, checkRake, checkRangesSane, checkReasons, checkSeats, checkSolveTime, checkTrees, checkWarmTree,
  comboName, coverageReport, cumulativeOf, dealtSetName, expectedOrder, mergeChecks, sidePotParts, solvePopulation, SOLVE_FLAG_NOTE, type CheckResult, type PathChecks,
} from "./chainChecks";
import { classifyPath, cleanRate, VERDICT_LABEL } from "./chainPath";
import { comboIndex } from "../utils/comboIndex/comboIndex";
import type { OffTreeLine } from "./offTree";
import { chainPathChecks } from "./fastSolve";
import type { ChainTrace } from "./aiChain";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";

const N = 1326;
const full = (w = 1) => new Array(N).fill(w);
const AdKc = comboIndex("Ad", "Kc");

describe("the catalogue is the spec", () => {
  it("has the seventeen, in order, each with the owner's words and a build status", () => {
    expect(CHECKS.map((c) => c.id)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    for (const c of CHECKS) {
      expect(c.spec.length).toBeGreaterThan(10);
      expect(["built", "partial", "to build"]).toContain(c.build);
    }
    expect(CHECKS.find((c) => c.id === 13)!.build).toBe("built");   // the daily replay (services/replayCheck)
    expect([14, 16].map((id) => CHECKS.find((c) => c.id === id)!.build)).toEqual(["built", "built"]);   // the press (autoExec)
    // the villain-mistake wording (QRE), not "solver noise"
    expect(CHECKS.find((c) => c.id === 3)!.how).toContain("QRE");
    expect(JSON.stringify(CHECKS)).not.toMatch(/rests on (solver )?noise/i);
  });
  it("codes group a check's failures", () => {
    expect(checkCode(5)).toBe("check:5-pot-and-stack-add-up");
    expect(checkCode(12)).toBe("check:12-solve-time-bounded");
  });
});

describe("folding results: the worst status wins, a failure is a reason, a flag never is", () => {
  it("mergeChecks keeps one per id, the worst, with its texts; passes add up", () => {
    const m = mergeChecks([
      { id: 12, status: "pass", text: "flop 1.2 s" }, { id: 12, status: "pass", text: "answered in 3 s" },
      { id: 5, status: "pass", text: "a" }, { id: 5, status: "fail", text: "b" }, { id: 5, status: "na", text: "c" },
      { id: 11, status: "na", text: "x" }, { id: 11, status: "na", text: "y" },
    ]);
    expect(m.map((x) => [x.id, x.status, x.text])).toEqual([[5, "fail", "b"], [11, "na", "x · y"], [12, "pass", "flop 1.2 s · answered in 3 s"]]);
  });
  it("a flag keeps the passes beside it (#12: the median flag and the clock's pass); a fail still shows only fails", () => {
    const flag = mergeChecks([
      { id: 12, status: "pass", text: "answered in 3.1 s, inside the 15.0 s action clock" },
      { id: 12, status: "flag", text: "the flop took 2.8 s, over 3× its rolling median of 0.6 s" }, { id: 12, status: "na", text: "x" },
    ]);
    expect(flag).toEqual([{ id: 12, status: "flag", text: "the flop took 2.8 s, over 3× its rolling median of 0.6 s · answered in 3.1 s, inside the 15.0 s action clock" }]);
    const failed = mergeChecks([
      { id: 12, status: "flag", text: "slow street" }, { id: 12, status: "fail", text: "the answer took 16.3 s, past the 15.0 s action clock" },
    ]);
    expect(failed).toEqual([{ id: 12, status: "fail", text: "the answer took 16.3 s, past the 15.0 s action clock" }]);
    expect(classifyPath({ street: "flop", streets: [], checks: { flop: flag } }).verdict).toBe("clean");
    expect(classifyPath({ street: "flop", streets: [], checks: { flop: failed } }).verdict).toBe("failed");
  });
  it("a collapse plan's results carry its name", () => {
    const c: PathChecks = {};
    addChecks(c, "flop", [{ id: 6, status: "pass", text: "ok" }], "SB+BB merged");
    expect(c.flop![0]!.text).toBe("SB+BB merged: ok");
  });
  it("a fail makes the verdict 'failed' (label 'check failed'); a covered fail and a flag do not", () => {
    const failed = classifyPath({ street: "turn", streets: [], checks: { turn: [{ id: 5, status: "fail", text: "pot 12 vs 14" }] } });
    expect(failed.verdict).toBe("failed");
    expect(VERDICT_LABEL.failed).toBe("check failed");
    expect(failed.reasons).toEqual([{ v: "failed", code: "check:5-pot-and-stack-add-up", text: "turn: Pot and stack add up — pot 12 vs 14" }]);
    const covered = classifyPath({ street: "turn", streets: [], checks: { turn: [{ id: 9, status: "fail", text: "x", covered: "tree:recreated" }] } });
    expect(covered.verdict).toBe("clean");
    const flagged = classifyPath({ street: "turn", streets: [], checks: { flop: [{ id: 3, status: "flag", text: "HJ bet 0.16%" }] } });
    expect(flagged.verdict).toBe("clean");
    expect(checkReasons({ flop: [{ id: 3, status: "flag", text: "x" }, { id: 2, status: "na", text: "y" }] })).toEqual([]);
  });
  it("'failed' outranks extra requests and counts against the clean rate", () => {
    const p = classifyPath({ street: "turn", streets: [{ street: "turn", plan: null, how: "resumed", tree: "created", leak: { code: "tree:recreated", why: "x" } }],
      checks: { turn: [{ id: 6, status: "fail", text: "size" }] } });
    expect(p.verdict).toBe("failed");
    const c = cleanRate([{ ts: 1, client_hand_id: "h1", street: "flop", text: "x", path_verdict: "failed" }]);
    expect(c.byVerdict.failed).toBe(1);
    expect(c.clean).toBe(0);
  });
  it("a memo hit's process checks describe the decision that walked it, and add no reason again", () => {
    const x = asWalkedEarlier({ id: 12, status: "fail", text: "flop 9 s" });
    expect(x.text).toBe("when walked: flop 9 s");
    expect(x.covered).toBe("earlier-decision");
    expect(asWalkedEarlier({ id: 5, status: "fail", text: "pot" }).covered).toBeUndefined();
  });
});

describe("#1 ranges handed on", () => {
  it("turn/river: the recorded hand-off check", () => {
    expect(checkHandoff({ from: "flop", ok: true, inFp: "a", expected: "a", why: "verified" }).status).toBe("pass");
    const f = checkHandoff({ from: "flop", ok: false, inFp: "a", expected: "b", why: "mismatch" });
    expect([f.status, f.covered]).toEqual(["fail", "check:range-handoff"]);
    expect(checkHandoff(null).status).toBe("na");
  });
  it("the flop: from the pin passes and the fingerprint is verified; a rebuilt arrival fails (its own reason reports it)", () => {
    const pin = checkFlopArrival({ arrival: { how: "pin", producer: "pin-chart6max" }, started: "abc123", expected: "abc123" });
    expect(pin.status).toBe("pass");
    expect(pin.text).toContain("preflop pin");
    expect(pin.text).toContain("verified");
    const hit = checkFlopArrival({ arrival: { how: "hit", producer: "pin-chart6max", first: { how: "pin", producer: "pin-chart6max" } } });
    expect(hit.status).toBe("pass");
    const rebuilt = checkFlopArrival({ arrival: { how: "rebuilt", producer: "recon6max", code: "arrival:no-pin", why: "no pin" } });
    expect([rebuilt.status, rebuilt.covered]).toEqual(["fail", "arrival:no-pin"]);
    const mismatch = checkFlopArrival({ arrival: { how: "pin", producer: "pin-chart6max" }, started: "aaaaaa", expected: "bbbbbb" });
    expect(mismatch.status).toBe("fail");
    expect(mismatch.covered).toBeUndefined();
  });
});

describe("#2 ranges sane", () => {
  const board = ["As", "7d", "2c"];
  it("full ranges with hero's combo: pass, and the floor is said", () => {
    const hero = full(0);
    hero[AdKc] = 0.05;
    hero[comboIndex("Qh", "Qd")] = 1;
    const r = checkRangesSane({ seats: [{ pos: "BB", range: full() }, { pos: "CO", range: hero }], heroIdx: 1, heroCombo: AdKc, heroBefore: 0.01, board });
    expect(r.status).toBe("pass");
    expect(r.text).toContain("hero's AdKc 0.050 (floored from 0.010)");
  });
  it("a negative weight, an empty seat, hero's combo missing or on the board: fail", () => {
    const neg = full(); neg[5] = -0.1;
    expect(checkRangesSane({ seats: [{ pos: "BB", range: neg }, { pos: "CO", range: full() }], heroIdx: 1, heroCombo: null, board }).text).toContain("negative");
    expect(checkRangesSane({ seats: [{ pos: "BB", range: full(0) }, { pos: "CO", range: full() }], heroIdx: 1, heroCombo: null, board }).text).toContain("empty");
    const noHero = full(); noHero[AdKc] = 0;
    expect(checkRangesSane({ seats: [{ pos: "BB", range: full() }, { pos: "CO", range: noHero }], heroIdx: 1, heroCombo: AdKc, board }).text).toContain("no weight");
    expect(checkRangesSane({ seats: [{ pos: "BB", range: full() }, { pos: "CO", range: full() }], heroIdx: 1, heroCombo: AdKc, board: ["Ad", "7d", "2c"] }).text).toContain("shares a card with the board");
  });
  it("a villain whose every hand holds one of hero's cards: fail", () => {
    const v = full(0);
    v[comboIndex("Ah", "Ad")] = 1;     // AdAh only — blocked by hero's Ad
    const r = checkRangesSane({ seats: [{ pos: "BB", range: v }, { pos: "CO", range: full() }], heroIdx: 1, heroCombo: AdKc, board });
    expect(r.status).toBe("fail");
    expect(r.text).toContain("shares no card with hero's");
  });
  it("names combos high card first", () => { expect(comboName(AdKc)).toBe("AdKc"); });
});

describe("#3 villain mistake lines: a flag, never a fail", () => {
  const line: OffTreeLine = { street: "flop", seat: "HJ", inPosition: false, action: "BET", code: "R2.6", betsize: 2.6, codes: [], potNode: 6, nodeFreq: 0.0016, maxHand: 0.0041, evGapBb: 0.14 };
  it("flags the line with the QRE wording", () => {
    const r = checkMistakeLines([line], 2);
    expect(r.status).toBe("flag");
    expect(r.text).toContain("villain mistake line");
    expect(r.text).toContain("QRE");
  });
  it("no villain action: na; villain actions none off-tree: pass", () => {
    expect(checkMistakeLines([], 0).status).toBe("na");
    expect(checkMistakeLines([], 3).status).toBe("pass");
  });
  it("CUMULATIVE (2026-10-09): 24.83 → 0.17 combos over X-X-R-C, every step ≥1% — a flag naming the line, never a fail", () => {
    const c = cumulativeOf({ seat: "SB", flopCombos: 24.83, nowCombos: 0.17, codes: ["X", "X", "R", "C"], anyStepUnder1: false });
    expect(c).toEqual({ seat: "SB", flop: 24.83, now: 0.17, codes: ["X", "X", "R", "C"] });
    const r = checkMistakeLines([], 4, [c!]);
    expect(r.status).toBe("flag");
    expect(r.text).toStartWith("cumulative: SB 24.83 → 0.17 combos over X-X-R-C (0.68% of his flop range — every action ≥1% alone, the line under 1%)");
    // beside a single off-tree action of another seat: both said
    const both = checkMistakeLines([line], 5, [c!]);
    expect(both.text).toContain("villain mistake line");
    expect(both.text).toContain("cumulative: SB 24.83 → 0.17");
    // the verdict never moves: a flag is not a reason
    expect(checkReasons({ flop: [r] })).toEqual([]);
  });
  it("cumulativeOf: not when the line keeps ≥1%, not when a step was itself under 1% (already flagged), not for an arrival residue", () => {
    expect(cumulativeOf({ seat: "SB", flopCombos: 24.83, nowCombos: 0.25, codes: [], anyStepUnder1: false })).toBeNull();     // 1.0%
    expect(cumulativeOf({ seat: "SB", flopCombos: 24.83, nowCombos: 0.17, codes: [], anyStepUnder1: true })).toBeNull();
    expect(cumulativeOf({ seat: "SB", flopCombos: 10, nowCombos: 0.01, codes: [], anyStepUnder1: false })).toBeNull();      // entered under 1% of hands
    const noCodes = cumulativeOf({ seat: "CO", flopCombos: 41, nowCombos: 0.3, codes: [], anyStepUnder1: false })!;
    expect(checkMistakeLines([], 2, [noCodes]).text).toContain("CO 41.00 → 0.30 combos since the flop");
  });
});

describe("#4 seats right", () => {
  it("postflop order by position; on a table DEALT two the big blind first", () => {
    expect(expectedOrder(["BTN", "BB"])).toEqual(["BB", "BTN"]);
    expect(expectedOrder(["BTN", "BB"], 2)).toEqual(["BB", "BTN"]);
    expect(expectedOrder(["BTN", "BB"], 6)).toEqual(["BB", "BTN"]);
    expect(expectedOrder(["BB", "SB"], 2)).toEqual(["BB", "SB"]);
    expect(expectedOrder(["SB", "BB"], 2)).toEqual(["BB", "SB"]);
    expect(expectedOrder(["CO", "SB", "BB"])).toEqual(["SB", "BB", "CO"]);
    expect(expectedOrder(["SB+BB", "CO"])).toBeNull();
  });
  it("a blind-vs-blind pot at a table dealt 3-6 is the small blind first (audit finding 5: 198 false fails); dealt unknown: not ordered", () => {
    for (const dealt of [3, 4, 5, 6]) {
      expect(expectedOrder(["SB", "BB"], dealt)).toEqual(["SB", "BB"]);
      const r = checkSeats({ players: ["SB", "BB"], agreed: 4, unnamed: 0, warmSeats: ["SB", "BB"], origin: "live", dealt });
      expect(r.status).toBe("pass");
      expect(r.text).toContain(`in postflop order by position (${dealt} dealt)`);
      // the tree the old check wanted is now the wrong one
      expect(checkSeats({ players: ["BB", "SB"], agreed: 4, unnamed: 0, dealt }).status).toBe("fail");
    }
    const hu = checkSeats({ players: ["BB", "SB"], agreed: 4, unnamed: 0, dealt: 2 });
    expect([hu.status, hu.text.includes("heads-up, the big blind first")]).toEqual(["pass", true]);
    const huWrong = checkSeats({ players: ["SB", "BB"], agreed: 4, unnamed: 0, dealt: 2 });
    expect([huWrong.status, huWrong.text]).toEqual(["fail", "the tree seats SB → BB in acting order; by position it is BB → SB (out of position first; 2 dealt)"]);
    expect(expectedOrder(["SB", "BB"])).toBeNull();
    expect(expectedOrder(["SB", "BB"], null)).toBeNull();
    const unknown = checkSeats({ players: ["SB", "BB"], agreed: 2, unnamed: 0 });
    expect([unknown.status, unknown.text.includes("a blind-vs-blind order is not checked")]).toEqual(["pass", true]);
    // the re-score has no node count: it says so instead of claiming one
    expect(checkSeats({ players: ["SB", "BB"], agreed: null, unnamed: null, dealt: 5 }).text).toContain("the node agreement was not recorded");
  });
  it("OOP out of order, or a warm-up seated otherwise: fail", () => {
    expect(checkSeats({ players: ["CO", "BB"], agreed: 2, unnamed: 0 }).status).toBe("fail");
    expect(checkSeats({ players: ["BB", "CO"], agreed: 2, unnamed: 0, warmSeats: ["CO", "BB"], origin: "live" }).text).toContain("warm-up seated");
    const ok = checkSeats({ players: ["BB", "CO"], agreed: 3, unnamed: 0, warmSeats: ["BB", "CO"], origin: "live" });
    expect(ok.status).toBe("pass");
    expect(ok.text).toContain("GTO Wizard named the same seat to act at 3 nodes");
  });
});

describe("#5 pot and stack add up", () => {
  it("within 0.5bb / 5% passes; a pot that drifted fails", () => {
    expect(checkPotStack({ street: "flop", potIn: 5.5, capturePot: 5.5, stackIn: 97.5, captureStack: 97.5 }).status).toBe("pass");
    expect(checkPotStack({ street: "flop", potIn: 5.9, capturePot: 5.5, stackIn: 97.5, captureStack: 97.5 }).status).toBe("pass");
    const f = checkPotStack({ street: "turn", potIn: 12, capturePot: 14, stackIn: 90, captureStack: 90 });
    expect(f.status).toBe("fail");
    expect(f.text).toContain("pot entering the turn 12bb, the capture's 14bb");
  });
  it("the stack of the players still in; a plan's tree may be shallower, never deeper", () => {
    expect(checkPotStack({ street: "turn", potIn: 10, capturePot: 10, stackIn: 39.8, captureStack: 21.6 }).text).toContain("effective stack of the players still in is 21.6bb");
    expect(checkPotStack({ street: "turn", potIn: 10, capturePot: 10, stackIn: 20, captureStack: 40, plan: "SB+BB merged" }).status).toBe("pass");
    expect(checkPotStack({ street: "turn", potIn: 10, capturePot: 10, stackIn: 60, captureStack: 40, plan: "SB+BB merged" }).status).toBe("fail");
  });
  it("hero's node pot is compared too; nothing known is na", () => {
    expect(checkPotStack({ street: "river", potIn: 16.9, capturePot: 16.9, stackIn: 83.4, captureStack: 83.4, potNode: 16.9, captureNodePot: 19 }).status).toBe("fail");
    expect(checkPotStack({ street: "flop", potIn: 5, capturePot: null, stackIn: 90, captureStack: null }).status).toBe("na");
  });
});

describe("#6 line matches the table", () => {
  it("every action walked in order; sizes within 0.5bb / 10%", () => {
    const r = checkLine({ captured: ["Check", "Bet(170)", "Call"], walked: [{ name: "Check", betsize: null }, { name: "Bet", betsize: 1.7 }, { name: "Call", betsize: 1.7 }] });
    expect(r.status).toBe("pass");
    expect(checkLine({ captured: ["Bet(300)"], walked: [{ name: "Bet", betsize: 3.3 }] }).status).toBe("pass");   // 0.3bb
  });
  it("a size walked far from the size bet fails — it used to be a note", () => {
    const r = checkLine({ captured: ["Check", "Bet(1000)"], walked: [{ name: "Check", betsize: null }, { name: "Bet", betsize: 12 }] });
    expect(r.status).toBe("fail");
    expect(r.text).toContain("10bb bet at the table, walked as the tree's BET 12bb");
  });
  it("a kind that differs, or an action not walked, fails; both all-in is equal", () => {
    expect(checkLine({ captured: ["Check"], walked: [{ name: "Bet", betsize: 2 }] }).status).toBe("fail");
    expect(checkLine({ captured: ["Check", "Call"], walked: [{ name: "Check", betsize: null }, null] }).status).toBe("fail");
    expect(checkLine({ captured: ["AllIn(9750)"], walked: [{ name: "Allin", betsize: 95 }] }).status).toBe("pass");
    expect(checkLine({ captured: [], walked: [] }).status).toBe("pass");
  });
  it("a table all-in walked as a SMALLER tree all-in (capped at what the others can call) passes; a bigger one fails", () => {
    // stress brief_A-007: SB all-in to 87.1bb, hero has 7.1bb behind — the tree's all-in is 7.1
    const capped = checkLine({ captured: ["AllIn(8710)"], walked: [{ name: "ALLIN", betsize: 7.1 }] });
    expect(capped.status).toBe("pass");
    expect(capped.text).toContain("87.1 all-in → the tree's 7.1");
    // the tree's stack too deep: a 28bb shove walked as a 97.8 all-in
    expect(checkLine({ captured: ["AllIn(2800)"], walked: [{ name: "ALLIN", betsize: 97.8 }] }).status).toBe("fail");
    // a raise (not an all-in) bigger than the tree's all-in is still a mismatch
    expect(checkLine({ captured: ["Raise(8710)"], walked: [{ name: "ALLIN", betsize: 7.1 }] }).status).toBe("fail");
  });
});

describe("#7 rake and stake", () => {
  const six = { pct_of_pot: 5, cap_in_chips: 2 };
  it("the table's rake on every street passes", () => {
    expect(checkRake({ rake: six, expected: six, site: "6-max", others: [{ street: "flop", rake: six }] }).status).toBe("pass");
  });
  it("another rake than the table's, or a rake that changed within the hand: fail", () => {
    expect(checkRake({ rake: { pct_of_pot: 5, cap_in_chips: 0.6 }, expected: six, others: [] }).status).toBe("fail");
    const drift = checkRake({ rake: six, expected: six, others: [{ street: "flop", rake: { pct_of_pot: 5, cap_in_chips: 1.5 } }] });
    expect(drift.status).toBe("fail");
    expect(drift.text).toContain("changed within the hand");
  });
  it("no rake set by the strategy, or none recorded: na", () => {
    expect(checkRake({ rake: six, expected: null, others: [] }).status).toBe("na");
    expect(checkRake({ rake: null, expected: six, others: [] }).status).toBe("na");
  });
});

describe("#8 board right", () => {
  it("the capture's cards, the street's count, no card twice", () => {
    expect(checkBoard({ board: "As7d2c", capture: ["As", "7d", "2c", "Kh"], k: 0, heroCards: ["Ad", "Kc"] }).status).toBe("pass");
    expect(checkBoard({ board: "As7d2cKh", capture: ["As", "7d", "2c", "Kd"], k: 1, heroCards: ["Ad", "Kc"] }).text).toContain("the capture shows");
    expect(checkBoard({ board: "As7d", capture: ["As", "7d"], k: 0, heroCards: [] }).status).toBe("fail");
    expect(checkBoard({ board: "As7d2c", capture: ["As", "7d", "2c"], k: 0, heroCards: ["As", "Kc"] }).text).toContain("appears twice");
  });
});

describe("#9 no unnecessary trees, #10 no node fetched twice, #11 warm-up tree = live tree", () => {
  it("one default tree per street, pinned sizes and 429s allowed; a default tree created twice fails", () => {
    expect(checkTrees({ street: "flop", tree: "cached", trees: [{ solId: "a", sizeFree: true }, { solId: "b", sizeFree: false }, { solId: "c", sizeFree: true, reroute: true }] }).status).toBe("pass");
    expect(checkTrees({ street: "flop", tree: "created", trees: [{ solId: "a", sizeFree: true }, { solId: "d", sizeFree: true }] }).status).toBe("fail");
    const re = checkTrees({ street: "turn", tree: "created", leak: { code: "tree:recreated", why: "stack drifted" }, trees: [] });
    expect([re.status, re.covered]).toEqual(["fail", "tree:recreated"]);
  });
  it("a node read twice fails, covered by its leak", () => {
    expect(checkNodeReads({ leak: { code: "node:read-twice", why: "x" } }).covered).toBe("node:read-twice");
    expect(checkNodeReads({ reads: { cache: 2, joined: 0, fetched: 1 } }).status).toBe("pass");
  });
  it("the warm-up's tree, unless a size was pinned", () => {
    expect(checkWarmTree({ street: "flop", origin: "live", solId: "w1", fixed: null, warm: ["w1"] }).status).toBe("pass");
    expect(checkWarmTree({ street: "flop", origin: "live", solId: "x", fixed: ["33%"], warm: ["w1"] }).status).toBe("pass");
    expect(checkWarmTree({ street: "flop", origin: "live", solId: "x", fixed: null, warm: ["w1"] }).status).toBe("fail");
    expect(checkWarmTree({ street: "flop", origin: "warm", solId: "w1", fixed: null, warm: ["w1"] }).status).toBe("na");
    expect(checkWarmTree({ street: "flop", origin: "live", solId: "x", fixed: null, warm: [] }).status).toBe("na");
  });
  // THE HUNG-POLL RE-ROUTE (2026-10-14 audit finding 7; handFacts.recordTree carries the mark): 4923405062's flop ledger —
  // the warm-up solved 0322e5a9; the live decision 7615 hung on it and re-posted 6514cb7e; 7616 found 6514cb7e in the
  // cache (recorded plain before the fix), hung again and re-posted 2c2afa0e. #9 read "created 2 times (0322e5a9,
  // 6514cb7e)", #11 "the warm-up solved tree 0322e5a9/6514cb7e, the live walk 2c2afa0e" — over byte-identical requests.
  it("a tree re-created after a hung poll, found in the cache by the next decision, is not a second default tree (#9) and is the warm-up's tree (#11)", () => {
    const ledger = [
      { solId: "0322e5a9", sizeFree: true, origin: "warm" },
      { solId: "0322e5a9", sizeFree: true, origin: "live" },
      { solId: "6514cb7e", sizeFree: true, origin: "live", reroute: true },
      { solId: "6514cb7e", sizeFree: true, origin: "warm", reroute: true },
      { solId: "6514cb7e", sizeFree: true, origin: "live", reroute: true },   // 7616's cached find, the mark carried
      { solId: "2c2afa0e", sizeFree: true, origin: "live", reroute: true },
    ];
    const nine = checkTrees({ street: "flop", tree: "cached", trees: ledger });
    expect(nine.status).toBe("pass");
    expect(nine.text).toContain("1 default tree + 2 re-created on another account after a 429 or a hung poll (allowed)");
    const reroutes = [...new Set(ledger.filter((t) => t.reroute).map((t) => t.solId))];
    const warm = [...new Set(ledger.filter((t) => t.origin === "warm").map((t) => t.solId))];
    const eleven = checkWarmTree({ street: "flop", origin: "live", solId: "2c2afa0e", fixed: null, warm, reroutes });
    expect(eleven.status).toBe("pass");
    expect(eleven.text).toContain("re-created on another account");
    // 4924409838 (9164): the warm-up's 2a920ee3, the live walk's re-creation 515950a2
    expect(checkWarmTree({ street: "flop", origin: "live", solId: "515950a2", fixed: null, warm: ["2a920ee3"], reroutes: ["515950a2"] }).status).toBe("pass");
    // a tree that is NOT a re-route — ranges, pot or stack really changed — still fails both
    expect(checkTrees({ street: "flop", tree: "created", trees: [...ledger, { solId: "d0d0d0d0", sizeFree: true, origin: "live" }] }).status).toBe("fail");
    expect(checkWarmTree({ street: "flop", origin: "live", solId: "d0d0d0d0", fixed: null, warm, reroutes }).status).toBe("fail");
  });
});

describe("#12 solve time bounded", () => {
  const saved = { x: process.env.CHECK_SOLVE_MEDIAN_X, clock: process.env.CHECK_ACTION_CLOCK_MS };
  afterEach(() => {
    if (saved.x == null) delete process.env.CHECK_SOLVE_MEDIAN_X; else process.env.CHECK_SOLVE_MEDIAN_X = saved.x;
    if (saved.clock == null) delete process.env.CHECK_ACTION_CLOCK_MS; else process.env.CHECK_ACTION_CLOCK_MS = saved.clock;
  });
  it("the rolling median over a window", () => {
    const t = new SolveTimes();
    for (let i = 1; i <= 60; i++) t.record("FLOP:new", i * 100);
    expect(t.median("FLOP:new")).toEqual({ median: 3550, samples: 50 });
  });
  it("na until a baseline; over 3× (and a second) the median is a FLAG, never a fail; the multiple is configurable", () => {
    expect(checkSolveTime({ street: "flop", ms: 9000, median: 2000, samples: 4, created: true }).status).toBe("na");
    const slow = checkSolveTime({ street: "flop", ms: 9000, median: 2000, samples: 20, created: true });
    expect(slow.status).toBe("flag");
    expect(slow.text).toBe(`the flop took 9.0 s, over 3× its rolling median of 2.0 s (new trees, last 20)${SOLVE_FLAG_NOTE}`);
    expect(checkSolveTime({ street: "flop", ms: 5000, median: 2000, samples: 20, created: true }).status).toBe("pass");
    expect(checkSolveTime({ street: "flop", ms: 40, median: 5, samples: 20, created: false }).status).toBe("pass");   // under a second over
    process.env.CHECK_SOLVE_MEDIAN_X = "2";
    expect(checkSolveTime({ street: "flop", ms: 5000, median: 2000, samples: 20, created: true }).status).toBe("flag");
    // the case the log is full of (hand 4921619944): a normal 2.8 s walk against a median a run of cache hits pulled to 0.6 s
    const noise = checkSolveTime({ street: "flop", ms: 2800, median: 600, samples: 21, created: false, population: "cached-fetched" });
    expect(noise.status).toBe("flag");
    expect(classifyPath({ street: "flop", streets: [], checks: { flop: [noise] } }).verdict).toBe("clean");
  });
  it("three populations: new trees, cached trees served from the cache, cached trees whose nodes were fetched", () => {
    expect(solvePopulation(true, { joined: 0, fetched: 3 })).toBe("new");
    expect(solvePopulation(false, { joined: 0, fetched: 0 })).toBe("cached-hit");
    expect(solvePopulation(false, null)).toBe("cached-hit");
    expect(solvePopulation(false, { joined: 1, fetched: 0 })).toBe("cached-fetched");
    expect(solvePopulation(false, { joined: 0, fetched: 2 })).toBe("cached-fetched");
    expect(checkSolveTime({ street: "turn", ms: 2500, median: 2400, samples: 12, created: false, population: "cached-fetched" }).text).toContain("cached trees, nodes fetched");
    expect(checkSolveTime({ street: "turn", ms: 25, median: 24, samples: 12, created: false, population: "cached-hit" }).text).toContain("every node from the cache");
  });
  it("a live answer inside the action clock; other origins are not against it", () => {
    expect(checkAnswerClock({ ms: 4200, origin: "live" }).status).toBe("pass");
    expect(checkAnswerClock({ ms: 16000, origin: "live" }).status).toBe("fail");
    expect(checkAnswerClock({ ms: 16000, origin: "warm" }).status).toBe("na");
    process.env.CHECK_ACTION_CLOCK_MS = "20000";
    expect(checkAnswerClock({ ms: 16000, origin: "live" }).status).toBe("pass");
  });
});

describe("#14 buttons, #15 mix, #16 fresh, #17 hero's combo", () => {
  const mix = (...xs: [string, number][]) => xs.map(([action, frequency]) => ({ action, frequency }));
  it("#14: no CHECK facing a bet, no FOLD/CALL unfaced, no raise when calling is all in, the node is hero's", () => {
    expect(checkButtons({ actions: mix(["Fold", 20], ["Call", 50], ["Raise 9", 30]), toCall: 3 }).status).toBe("pass");
    expect(checkButtons({ actions: mix(["Check", 60], ["Bet 3", 40]), toCall: 3 }).text).toContain("CHECK facing 3bb");
    expect(checkButtons({ actions: mix(["Fold", 10], ["Check", 90]), toCall: 0 }).status).toBe("fail");
    expect(checkButtons({ actions: mix(["Fold", 10], ["Check", 0], ["Bet 3", 90]), toCall: 0 }).status).toBe("fail");
    const sized = checkButtons({ actions: mix(["Fold", 50], ["Call", 20], ["Raise 40", 30]), toCall: 20, heroBehind: 15 });
    expect([sized.status, sized.text]).toEqual(["fail", "the answer offers a raise (Raise 40) although calling 20bb puts hero all in (15bb behind)"]);
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "BTN", heroPos: "CO" }).status).toBe("fail");
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "SB", heroPos: "BTN", hu: true }).status).toBe("pass");
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "OOP", heroPos: "CO" }).status).toBe("pass");
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "BU", heroPos: "BTN" }).status).toBe("pass");   // a chart's name for the button
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "LJ", heroPos: "UTG" }).status).toBe("pass");   // another vocabulary: not evidence
    expect(checkButtons({ actions: mix(["Check", 100]), toCall: 0, legal: ["fold", "call"] }).status).toBe("fail");
  });
  it("#14: an all-in for no more than the call IS the call (hand 4921673474: QQ, 98.8 to call, 87 behind, ALL-IN 87 BB offered)", () => {
    // the stored answer: All-in 99.83 / Fold 0.17, hero's stack as dealt 100 (the tree's BB:100), 13 in, 87 behind
    const r = checkButtons({ actions: mix(["Fold", 0.17], ["All-in", 99.83]), toCall: 98.8, heroBehind: 87, legal: [], nodePos: "BB", heroPos: "BB" });
    expect(r.status).toBe("pass");
    expect(r.text).toContain("its all-in is the call for less (87bb behind, 98.8bb to call)");
    for (const l of ["Allin", "ALL-IN 87 BB", "All In", "Jam"]) expect(checkButtons({ actions: mix([l, 100]), toCall: 20, heroBehind: 15 }).status).toBe("pass");
    // an all-in that is MORE than the call is a raise, and fine when hero has chips behind the call
    expect(checkButtons({ actions: mix(["All-in", 100]), toCall: 5, heroBehind: 40 }).status).toBe("pass");
  });
  it("#14: the node names hero's seat as a tree for that many DEALT names it (hands 4921651217, 4922085772: dead button)", () => {
    // three dealt — CO (hero), SB, BB — the BTN seat sat out: GTO Wizard's three-handed tree calls hero's seat BTN
    const dead = { actions: mix(["Fold", 99.98]), toCall: 1, legal: [] as string[], nodePos: "BTN", heroPos: "CO", hu: false, dealtLabels: ["BB", "CO", "SB"] as string[] | null };
    const r = checkButtons(dead);
    expect(r.status).toBe("pass");
    expect(r.text).toContain("hero's CO is the tree's BTN at a table dealt 3 (BB/CO/SB)");
    // another seat's node is still caught: the tree's SB or BB answering for hero's CO
    expect(checkButtons({ ...dead, nodePos: "SB" }).status).toBe("fail");
    expect(checkButtons({ ...dead, nodePos: "BB" }).text).toBe("the answer is BB's node, not hero's (CO; BTN in the names of a table dealt 3)");
    // without the dealt seats the old comparison stands (the table's label only)
    expect(checkButtons({ ...dead, dealtLabels: null }).status).toBe("fail");
    // four dealt with the BTN seat empty: HJ, CO, SB, BB → the tree's CO, BTN
    expect(checkButtons({ ...dead, heroPos: "CO", nodePos: "BTN", dealtLabels: ["HJ", "CO", "SB", "BB"] }).status).toBe("pass");
    expect(checkButtons({ ...dead, heroPos: "HJ", nodePos: "CO", dealtLabels: ["HJ", "CO", "SB", "BB"] }).status).toBe("pass");
    expect(checkButtons({ ...dead, heroPos: "HJ", nodePos: "BTN", dealtLabels: ["HJ", "CO", "SB", "BB"] }).status).toBe("fail");
  });
  it("dealtSetName: GTO Wizard's seat names for a table dealt N", () => {
    expect(dealtSetName("CO", ["CO", "SB", "BB"])).toBe("BTN");
    expect(dealtSetName("UTG", ["UTG", "HJ", "CO", "BTN", "SB", "BB"])).toBe("UTG");
    expect(dealtSetName("HJ", ["HJ", "CO", "BTN", "SB", "BB"])).toBe("HJ");
    expect(dealtSetName("CO", ["UTG", "CO", "BTN", "SB", "BB"])).toBe("CO");     // UTG, CO, BTN -> HJ, CO, BTN
    expect(dealtSetName("UTG", ["UTG", "CO", "BTN", "SB", "BB"])).toBe("HJ");
    expect(dealtSetName("BTN", ["BTN", "BB"])).toBe("SB");                     // heads-up: the dealer is the small blind
    expect(dealtSetName("BU", ["BU", "SB", "BB"])).toBe("BTN");
    expect(dealtSetName("CO", ["CO", "BTN", "BB"])).toBe("CO");                // dead SB: the four-handed set with an SB ghost
    expect(dealtSetName("SB", ["CO", "SB", "BB"])).toBe("SB");
    expect(dealtSetName("CO", ["SB", "BB"])).toBeNull();                       // hero not among the dealt
    expect(dealtSetName("CO", ["SB+BB", "CO"])).toBeNull();
  });
  it("#15: ~100%, not all zero", () => {
    expect(checkMix(mix(["Check", 60], ["Bet", 40])).status).toBe("pass");
    expect(checkMix(mix(["Check", 0], ["Bet", 0])).text).toBe("every action at 0%");
    expect(checkMix(mix(["Check", 60], ["Bet", 30])).status).toBe("fail");
  });
  it("#16: the answer's street is the decision's", () => {
    expect(checkFresh({ answerStreet: "turn", handStreet: "turn", key: "turn · …" }).status).toBe("pass");
    expect(checkFresh({ answerStreet: "flop", handStreet: "turn", key: "turn · …" }).status).toBe("fail");
  });
  it("#17: hero's combo carries weight at the node; preflop the chart holds his class", () => {
    expect(checkHeroCombo({ heroCombo: AdKc, weight: 0.3 }).status).toBe("pass");
    expect(checkHeroCombo({ heroCombo: AdKc, weight: 0 }).status).toBe("fail");
    expect(checkHeroCombo({ heroCombo: null, weight: null }).status).toBe("na");
    // THE BOUND IS RELATIVE (2026-10-14): 1e-3 of his heaviest live combo — a thin range floored to 5 % of its heaviest
    // combo (rel5) passes; without the heaviest combo the absolute 1e-3 holds as before
    expect(heroAbsentBound(null)).toBe(1e-3);
    expect(heroAbsentBound(1)).toBeCloseTo(1e-3, 12);
    expect(heroAbsentBound(0.006)).toBeCloseTo(6e-6, 15);
    expect(heroAbsentBound(0.0002)).toBe(HERO_ABSENT_DUST);   // never under the solver's dust: a range of dust is absent
    const thin = checkHeroCombo({ heroCombo: AdKc, weight: 3e-4, maxLive: 0.006 });   // 16237: rel5's floor 0.05 × 0.0062
    expect(thin.status).toBe("pass");
    expect(thin.text).toContain("% of his heaviest live combo");
    expect(checkHeroCombo({ heroCombo: AdKc, weight: 3e-4 }).status).toBe("fail");      // the absolute bound, as before
    const under = checkHeroCombo({ heroCombo: AdKc, weight: 5e-6, maxLive: 0.006 });
    expect(under.status).toBe("fail");
    expect(under.covered).toBe("postflop:hero-absent");
    expect(under.text).toContain("0.001 × his heaviest live combo");
    expect(checkHeroCombo({ heroCombo: AdKc, weight: 9.5e-5, maxLive: 1 }).status).toBe("fail");
    expect(checkPreflopInRange({ notInRange: true, heroClass: "T4o" }).status).toBe("fail");
  });
});

describe("the Coverage page: counts per check over the window's decisions", () => {
  const path = (checks: PathChecks) => JSON.stringify(classifyPath({ street: "turn", streets: [], checks }));
  const r = (hand: string, ts: number, checks: PathChecks | null) => ({ ts, client_hand_id: hand, street: "turn", path: checks ? path(checks) : JSON.stringify({ v: 1 }) });
  const c = (id: number, status: CheckResult["status"], text = `${id} ${status}`): CheckResult => ({ id, status, text });
  it("each decision counts once per check (its worst street); failing hands are listed, most recent first", () => {
    const rep = coverageReport([
      r("h1", 1, { flop: [c(5, "pass")], turn: [c(5, "fail", "pot 12 vs 14"), c(3, "flag")] }),
      r("h2", 2, { flop: [c(5, "pass"), c(3, "pass")] }),
      r("h3", 3, { turn: [c(5, "fail", "stack 40 vs 21")] }),
      r("h4", 4, null),
    ]);
    expect([rep.decisions, rep.withChecks, rep.hands]).toEqual([4, 3, 3]);
    const five = rep.checks.find((x) => x.id === 5)!;
    expect([five.pass, five.fail, five.flag, five.na, five.seen, five.failHands]).toEqual([1, 2, 0, 0, true, 2]);
    expect(five.examples.map((e) => [e.hand, e.street, e.text])).toEqual([["h3", "turn", "stack 40 vs 21"], ["h1", "turn", "pot 12 vs 14"]]);
    const three = rep.checks.find((x) => x.id === 3)!;
    expect([three.pass, three.flag]).toEqual([1, 1]);
    const thirteen = rep.checks.find((x) => x.id === 13)!;
    expect([thirteen.seen, thirteen.build]).toEqual([false, "built"]);   // not on the paths: the replay table fills it (routes/dashboard)
  });
});

describe("a check never costs an answer (2026-09-27)", () => {
  it("a check that throws reads as not checked, with the error", async () => {
    const { guardCheck, guardChecks } = await import("./chainChecks");
    const r = guardCheck(5, () => { throw new Error("pot missing on an old capture"); });
    expect(r).toEqual({ id: 5, status: "na", text: "the check errored: pot missing on an old capture" });
    expect(guardChecks(0, () => { throw new Error("boom"); }, { kept: true })).toEqual({ kept: true });
    expect(guardChecks(0, () => 7, 0)).toBe(7);
  });
});

describe("checks #14 / #16 at the press (2026-09-27)", () => {
  const PATH = JSON.stringify({ v: 1, verdict: "clean", reasons: [], street: "flop", streets: [],
    checks: { flop: [{ id: 14, status: "pass", text: "no CHECK facing a bet" }, { id: 16, status: "pass", text: "the answer's street is the capture's" }] } });
  const row = { path: PATH, decision_key: JSON.stringify(["flop", ["Td", "6h", "7s"], ["As", "Ts"], 2.6, 9]),
    decision_json: JSON.stringify([{ action: "FOLD", frequency: 8.9e-7 }, { action: "CALL 2.6", frequency: 69.4 }, { action: "RAISE 6.8", frequency: 30.6 }]) };
  const checksOf = (p: string | null, id: number) => (JSON.parse(p!).checks.flop as any[]).find((c) => c.id === id);

  it("the answer's actions among the press's buttons, the spot unchanged: both hold, merged onto the answer's own", async () => {
    const { pressedAnswerPath } = await import("./chainChecks");
    const p = pressedAnswerPath(row, [{ street: "flop", keyActs: 9, buttons: ["FOLD", "CALL 2.6", "RAISE TO 6.8"], atPress: "flop|9", stale: false }]);
    expect(checksOf(p, 14).status).toBe("pass");
    expect(checksOf(p, 14).text).toContain("at the press: CALL 2.6 / RAISE 6.8 ⊆ the table's buttons");
    expect(checksOf(p, 16).text).toContain("at the press the table still showed the answer's spot (flop|9)");
  });
  it("a RAISE the table did not offer, and a spot that moved on, fail", async () => {
    const { pressedAnswerPath } = await import("./chainChecks");
    const p = pressedAnswerPath(row, [{ street: "flop", keyActs: 9, buttons: ["FOLD", "CALL 2.6"], atPress: "flop|10", stale: true }]);
    // FOLD / CALL only and CALL is not hero's stack here — but the relay can offer a shove as a CALL, so a wager passes
    // only through that door: this one is judged a pass-with-note, the stale spot a fail
    expect(checksOf(p, 14).text).toContain("the shove offered as a CALL");
    expect(checksOf(p, 16)).toMatchObject({ status: "fail" });
    expect(checksOf(p, 16).text).toContain("the table showed flop|10");
    const q = pressedAnswerPath(row, [{ street: "flop", keyActs: 9, buttons: ["CHECK", "BET"], atPress: "flop|9", stale: false }]);
    expect(checksOf(q, 14)).toMatchObject({ status: "fail" });
    expect(checksOf(q, 14).text).toContain("the answer offers CALL; the table's buttons were CHECK / BET");   // the 1e-6 % FOLD is residue, not an action
  });
  it("a CALL the client offers only as its ALL-IN N BB passes (hand 4922346841); an ALL-IN in dollars is a raise, never the call", async () => {
    const { pressedAnswerPath } = await import("./chainChecks");
    const callRow = { ...row, decision_key: JSON.stringify(["flop", ["Qh", "8h", "4c"], ["Ah", "Qc"], 245.2, 7]),
      decision_json: JSON.stringify([{ action: "FOLD", frequency: 0 }, { action: "CALL 88.4", frequency: 100 }]) };
    const covered = pressedAnswerPath(callRow, [{ street: "flop", keyActs: 7, buttons: ["FOLD", "ALL-IN 88.4 BB"], atPress: "flop|7", stale: false }]);
    expect(checksOf(covered, 14)).toMatchObject({ status: "pass" });
    expect(checksOf(covered, 14).text).toContain("the call offered as ALL-IN");
    // allInRaiseButton (session_20261003_153922 / 153908): "ALL-IN $0.04" beside CHECK, "ALL-IN $5.17" beside FOLD
    const dollars = pressedAnswerPath(callRow, [{ street: "flop", keyActs: 7, buttons: ["FOLD", "ALL-IN $5.17"], atPress: "flop|7", stale: false }]);
    expect(checksOf(dollars, 14)).toMatchObject({ status: "fail" });
    expect(checksOf(dollars, 14).text).toContain("the answer offers CALL");
    // ... and a RAISE beside an ALL-IN N BB means the ALL-IN is not the call either
    const beside = pressedAnswerPath(callRow, [{ street: "flop", keyActs: 7, buttons: ["FOLD", "ALL-IN 88.4 BB", "RAISE TO 20 BB"], atPress: "flop|7", stale: false }]);
    expect(checksOf(beside, 14)).toMatchObject({ status: "fail" });
    // the only raise is ALL-IN $N: a raise / shove answer passes on it (hand 51: ALLIN 0.8 on CHECK / ALL-IN $0.04)
    const shoveRow = { ...row, decision_key: JSON.stringify(["river", ["2c", "7s", "9d", "Jh", "Kc"], ["2d", "2h"], 0, 5]),
      decision_json: JSON.stringify([{ action: "CHECK", frequency: 40 }, { action: "ALLIN 0.8", frequency: 60 }]),
      path: PATH.replace(/"flop"/g, '"river"') };
    const only = pressedAnswerPath(shoveRow, [{ street: "river", keyActs: 5, buttons: ["CHECK", "ALL-IN $0.04"], atPress: "river|5", stale: false }]);
    expect((JSON.parse(only!).checks.river as any[]).find((c) => c.id === 14)).toMatchObject({ status: "pass" });
  });
  it("no press for this decision (another street, or no read) leaves the path as it was", async () => {
    const { pressedAnswerPath } = await import("./chainChecks");
    expect(pressedAnswerPath(row, [{ street: "turn", keyActs: 11, buttons: ["CHECK"], stale: false }])).toBe(PATH);
    expect(pressedAnswerPath(row, [{ street: "flop", keyActs: 9, tries: 1 }])).toBe(PATH);
    expect(pressedAnswerPath(row, null)).toBe(PATH);
  });
});

// ── #5 at hero's node: the HERO-CONTESTABLE pot (2026-10-08) ────────────────────────────────────────────────────────
/**
 * Brady 2026-10-08, stress-500: check #5 failed on three hands for one reason that is no defect in the answers — the
 * table's pot holds SIDE-POT money hero cannot win (a seat put in more than hero's stack), while a dead-money plan caps a
 * dropped seat's chips at hero's stack and GTO Wizard prices a kept seat's side pot natively. Both pots are now compared
 * less their side pot (each seat's street chips above hero's stack on the street). The traces below are the stored
 * ones (poker-data-stress500 root/poker.sqlite solves) — players, the pot entering, each seat's stack as sent, hero's
 * node — and the hands the stress scenarios' own lines.
 */
describe("check #5 compares the HERO-CONTESTABLE pot at hero's node (2026-10-08)", () => {
  type A = [number, string, number?, string?];
  const handOf = (positions: Record<number, string>, startStacks: Record<number, number>, heroSeatId: number, acts: A[], toCall: number) => normalizeHand({
    handId: 900000 + heroSeatId, clientHandId: `check5-${heroSeatId}`, bbCents: 200, heroSeatId, heroCards: ["A♦", "Q♣"], board: ["K♥", "T♦", "T♥"], street: "flop",
    liveSeats: Object.keys(positions).map(Number), committed: {}, potByStreet: {}, positions, stacks: {}, startStacks,
    currentNode: { street: "flop", toActSeatId: heroSeatId, toActIsHero: true, pot: 0, toCall, legalActions: [], complete: false },
    actions: acts.map(([seatId, type, amount, street]) => ({ seatId, hero: seatId === heroSeatId, type, street: street ?? "flop", ...(amount != null ? { amount } : {}) })),
    heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$1/$2",
  } as any).hand!;
  /** a stored walk: its seats in acting order, hero's index, the pot entering, each seat's stack as sent, and the nodes
   *  [codes, actor, invested, pot, taken] with hero's last */
  const traceOf = (plan: string, players: string[], heroIdx: number, potIn: number, stacksIn: number[],
      nodes: [string[], number, number[], number, string | null][]): ChainTrace => ({
    spec: { oopPos: players[0]!, ...(players.length === 3 ? { midPos: players[1]!, midRange: [] } : {}), ipPos: players.at(-1)!, oopRange: [], ipRange: [],
      flopPot: potIn, flopStack: Math.min(...stacksIn), board: "KhTdTh", streets: [nodes.at(-1)![0]], heroComboIdx: null, planTag: plan,
      heroSeat: heroIdx === 0 ? "oop" : heroIdx === players.length - 1 ? "ip" : "mid" },
    streets: [{ si: 0, street: "FLOP", board: "KhTdTh", potIn, stackIn: Math.min(stacksIn[heroIdx]!, Math.max(...stacksIn.filter((_, i) => i !== heroIdx))),
      labels: [], fixedLevels: null, solId: "s", created: false, oopIn: [], ipIn: [], players, stacksIn: Object.fromEntries(players.map((p, i) => [p, stacksIn[i]!])) }],
    nodes: nodes.map(([codes, actor, invested, potNode, taken], ti) => ({ si: 0, ti, street: "FLOP", board: "KhTdTh", codes, actor, potNode, invested,
      actions: taken ? [{ name: taken, code: "", betsize: null, position: null, totalFrequency: null, totalEv: null, strategy: [], evs: [] }] : [],
      taken: taken ? 0 : null, heroNode: taken == null })),
    result: { ok: true },
  } as ChainTrace);
  const five = (h: any, dealt: Record<number, number>, walks: ChainTrace[]) => chainPathChecks({
    hand: h, walks: walks.map((t) => ({ kind: t.spec.planTag ?? null, trace: t })), arrival: undefined, potExtra: 0, dealt,
    treePos: (sid) => h.positions[sid] ?? null, rake: null, site: null, handTrees: [],
  }).flop!.find((x) => x.id === 5)!;

  it("sidePotParts: each seat's chips above hero's stack, nothing for a seat at or under it, nothing with no stack", () => {
    expect(sidePotParts([["BB", 149], ["UTG", 119], ["HJ", 59], ["SB", 0]], 79)).toEqual([{ pos: "BB", bb: 70 }, { pos: "UTG", bb: 40 }]);
    expect(sidePotParts([["CO", 15], ["BTN", 15.004]], 15)).toEqual([]);
    expect(sidePotParts([["CO", 18]], null)).toEqual([]);
  });

  it("checkPotStack: each pot less its side pot; the text names what was left out; no side pot = the old text byte for byte", () => {
    const sidePot = { heroStack: 79, table: [{ pos: "BB", bb: 70 }, { pos: "UTG", bb: 40 }], treeStack: 79, tree: [{ pos: "BB", bb: 40 }, { pos: "UTG", bb: 40 }] };
    const c = checkPotStack({ street: "flop", potIn: 65, capturePot: 6, stackIn: 79, captureStack: 79, potNode: 303, captureNodePot: 333, skipPotIn: true, plan: "ghost:SB + dead:HJ + ghost:BTN", sidePot });
    expect(c.status).toBe("pass");
    expect(c.text).toContain("223bb at hero's node (table 333, hero can contest 223: BB 70 and UTG 40 above hero's stack (79) are a side pot; tree 303, hero can contest 223: BB 40 and UTG 40 above hero's 79)");
    const plain = { street: "flop", potIn: 16.9, capturePot: 16.9, stackIn: 83.4, captureStack: 83.4, potNode: 30, captureNodePot: 30, potRule: "the table's pot" };
    expect(checkPotStack({ ...plain, sidePot: { heroStack: 83.4, table: [], tree: [] } })).toEqual(checkPotStack(plain));
  });

  it("brief_I-004 flop decision 13 (the preload double count, fixed 2026-10-07): 138.5 against the table's 108.5 STILL FAILS — no side pot hides it", () => {
    // SB jams 15, hero BB (97.5 behind) calls, UTG jams 22, CO and BTN call: the table's 108.5, hero facing 7, no seat
    // above hero's 97.5. The plan keeping UTG and CO layers the 15 hero called (15 each into a starting pot of 94.5):
    // fixed, UTG's all-in goes out as the 7 he has in the tree → 108.5; the bug sent the table's 22 → 138.5
    const h = handOf({ 1: "CO", 2: "BTN", 3: "SB", 4: "BB", 5: "UTG", 6: "HJ" }, { 1: 100, 2: 100, 3: 17.5, 4: 100, 5: 24.5, 6: 100 }, 4, [
      [3, "post-sb", 0.5, "preflop"], [4, "post-bb", 1, "preflop"], [5, "raise", 2.5, "preflop"], [6, "fold", undefined, "preflop"], [1, "call", 2.5, "preflop"],
      [2, "call", 2.5, "preflop"], [3, "call", 2, "preflop"], [4, "call", 1.5, "preflop"],
      [3, "all-in", 15], [4, "call", 15], [5, "all-in", 22], [1, "call", 22], [2, "call", 22]], 7);
    const dealt = { 1: 100, 2: 100, 3: 17.5, 4: 100, 5: 24.5, 6: 100 };
    const plan = "dead:SB + dead:BTN (called level in the pot)";
    const walk = (inv: number) => traceOf(plan, ["BB", "UTG", "CO"], 0, 94.5, [82.5, 7, 82.5], [
      [[], 0, [0, 0, 0], 94.5, "CHECK"], [["X"], 1, [0, 0, 0], 94.5, "ALLIN"], [["X", `R${inv}`], 2, [0, inv, 0], 94.5 + inv, "CALL"],
      [["X", `R${inv}`, "C"], 0, [0, inv, inv], 94.5 + 2 * inv, null]]);
    const fixed = five(h, dealt, [walk(7)]);
    expect(fixed.status).toBe("pass");
    expect(fixed.text).toContain("108.5bb at hero's node (the table's pot)");
    expect(fixed.text).not.toContain("side pot");
    const bug = five(h, dealt, [walk(22)]);
    expect(bug.status).toBe("fail");
    expect(bug.potOff).toBe(true);
    expect(bug.text).toContain("pot at hero's node 138.5bb, the capture's 108.5bb (Δ 30bb; the table's pot)");
  });

  // UTG bets 4, HJ calls, CO raises to 18, BTN calls 18, hero BB to act with his stack under 18 (the SB folded preflop:
  // 13 in the pot). brief_I-011: hero 15 behind; brief_I-012: hero 10 (its seats renumbered onto I-011's)
  const shortHero = (bb: number) => {
    const h = handOf({ 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" }, { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: bb + 2.5 }, 6, [
      [5, "post-sb", 0.5, "preflop"], [6, "post-bb", 1, "preflop"], [1, "raise", 2.5, "preflop"], [2, "call", 2.5, "preflop"], [3, "call", 2.5, "preflop"],
      [4, "call", 2.5, "preflop"], [5, "fold", undefined, "preflop"], [6, "call", 1.5, "preflop"],
      [6, "check"], [1, "bet", 4], [2, "call", 4], [3, "raise", 18], [4, "call", 18]], bb);
    const dealt = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: bb + 2.5 };
    // the three stored plans: two drop the BTN (his 18 dead, capped at hero's stack) and keep the CO's raise of 18; the
    // third keeps the CO and the BTN, 18 each
    const raiseTo18 = (plan: string, seat: string) => traceOf(plan, ["BB", seat, "CO"], 0, 13 + 4 + bb, [bb, 97.5, 97.5], [
      [[], 0, [0, 0, 0], 17 + bb, "CHECK"], [["X"], 1, [0, 0, 0], 17 + bb, "BET"], [["X", "R4"], 2, [0, 4, 0], 21 + bb, "RAISE"],
      [["X", "R4", "R18"], 0, [0, 4, 18], 39 + bb, null]]);
    const both = traceOf("dead:UTG + dead:HJ", ["BB", "CO", "BTN"], 0, 21, [bb, 97.5, 97.5], [
      [[], 0, [0, 0, 0], 21, "CHECK"], [["X"], 1, [0, 0, 0], 21, "BET"], [["X", "R18"], 2, [0, 18, 0], 39, "CALL"], [["X", "R18", "C"], 0, [0, 18, 18], 57, null]]);
    return { h, dealt, walks: [raiseTo18("dead:HJ + dead:BTN", "UTG"), raiseTo18("dead:UTG + dead:BTN", "HJ"), both] };
  };

  it("brief_I-011 flop decision 13 (hero 15): table 57 less CO 3 and BTN 3 = 51; trees 54 / 54 / 57 less their CO / CO+BTN above 15 = 51 — PASS", () => {
    const s = shortHero(15);
    expect(s.walks.map((w) => w.nodes.at(-1)!.potNode)).toEqual([54, 54, 57]);
    const c = five(s.h, s.dealt, s.walks);
    expect(c.status).toBe("pass");
    expect(c.text).toContain("dead:HJ + dead:BTN: pot entering not compared (dead:HJ + dead:BTN: this street's dead chips are in it); 51bb at hero's node (the table's pot; table 57, hero can contest 51: CO 3 and BTN 3 above hero's stack (15) are a side pot; tree 54, hero can contest 51: CO 3 above hero's 15)");
    expect(c.text).toContain("dead:UTG + dead:HJ: pot entering not compared (dead:UTG + dead:HJ: this street's dead chips are in it); 51bb at hero's node (the table's pot; table 57, hero can contest 51: CO 3 and BTN 3 above hero's stack (15) are a side pot; tree 57, hero can contest 51: CO 3 and BTN 3 above hero's 15)");
  });

  it("brief_I-012 flop decision 13 (hero 10): table 57 → 41; trees 49 / 49 / 57 → 41 — PASS", () => {
    const s = shortHero(10);
    expect(s.walks.map((w) => w.nodes.at(-1)!.potNode)).toEqual([49, 49, 57]);
    const c = five(s.h, s.dealt, s.walks);
    expect(c.status).toBe("pass");
    expect(c.text).toContain("41bb at hero's node (the table's pot; table 57, hero can contest 41: CO 8 and BTN 8 above hero's stack (10) are a side pot; tree 49, hero can contest 41: CO 8 above hero's 10)");
  });

  it("a tree pot off by more than its side pot still FAILS (hero 15, the dropped BTN's dead chips counted at 18, not 15)", () => {
    const s = shortHero(15);
    const off = traceOf("dead:HJ + dead:BTN", ["BB", "UTG", "CO"], 0, 35, [15, 97.5, 97.5], [[["X", "R4", "R18"], 0, [0, 4, 18], 57, null]]);
    const c = five(s.h, s.dealt, [off]);
    expect(c.status).toBe("fail");
    expect(c.text).toContain("pot at hero's node 54bb, the capture's 51bb (Δ 3bb; the table's pot; table 57, hero can contest 51: CO 3 and BTN 3 above hero's stack (15) are a side pot; tree 57, hero can contest 54: CO 3 above hero's 15)");
  });

  it("po_56way-006 flop decision 12 (hero CO 79; BB jams 149, UTG calls 119 all in, HJ 59 all in): every plan's 223 = the table's 333 less BB 70 and UTG 40", () => {
    const h = handOf({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, { 1: 100, 2: 150, 3: 120, 4: 60, 5: 80, 6: 150 }, 5, [
      [1, "post-sb", 0.5, "preflop"], [2, "post-bb", 1, "preflop"], [3, "call", 1, "preflop"], [4, "call", 1, "preflop"], [5, "call", 1, "preflop"],
      [6, "call", 1, "preflop"], [1, "call", 0.5, "preflop"], [2, "check", undefined, "preflop"],
      [1, "check"], [2, "all-in", 149], [3, "call", 119], [4, "call", 59]], 79);
    const dealt = { 1: 100, 2: 150, 3: 120, 4: 60, 5: 80, 6: 150 };
    // as stored: GTO Wizard's pot counts the BB's jam up to the deepest OTHER tree seat — hero's 79, the SB's 99, the UTG's 119
    const walks = [
      traceOf("dead:UTG + dead:HJ + ghost:BTN", ["SB", "BB", "CO"], 2, 144, [99, 149, 79], [[[], 0, [0, 0, 0], 144, "CHECK"], [["X"], 1, [0, 0, 0], 144, "ALLIN"], [["X", "R149"], 2, [0, 99, 0], 243, null]]),
      traceOf("ghost:SB + dead:HJ + ghost:BTN", ["BB", "UTG", "CO"], 2, 65, [149, 119, 79], [[[], 0, [0, 0, 0], 65, "ALLIN"], [["R149"], 1, [119, 0, 0], 184, "CALL"], [["R149", "C"], 2, [119, 119, 0], 303, null]]),
      traceOf("ghost:SB + dead:UTG + ghost:BTN", ["BB", "HJ", "CO"], 2, 85, [149, 59, 79], [[[], 0, [0, 0, 0], 85, "ALLIN"], [["R149"], 1, [79, 0, 0], 164, "CALL"], [["R149", "C"], 2, [79, 59, 0], 223, null]]),
    ];
    const c = five(h, dealt, walks);
    expect(c.status).toBe("pass");
    const side = "table 333, hero can contest 223: BB 70 and UTG 40 above hero's stack (79) are a side pot";
    expect(c.text).toContain(`dead:UTG + dead:HJ + ghost:BTN: pot entering not compared (dead:UTG + dead:HJ + ghost:BTN: this street's dead chips are in it); 223bb at hero's node (the table's pot; ${side}; tree 243, hero can contest 223: BB 20 above hero's 79)`);
    expect(c.text).toContain(`223bb at hero's node (the table's pot; ${side}; tree 303, hero can contest 223: BB 40 and UTG 40 above hero's 79)`);
    expect(c.text).toContain(`223bb at hero's node (the table's pot; ${side})`);
  });

  it("a trace without each seat's stack (before 2026-10-03): both pots whole, as before", () => {
    const s = shortHero(15);
    const old = s.walks[2]!;
    const bare = { ...old, streets: old.streets.map(({ stacksIn: _, ...x }) => x) } as ChainTrace;
    const c = five(s.h, s.dealt, [bare]);
    expect(c.status).toBe("pass");
    expect(c.text).toContain("57bb at hero's node (the table's pot)");
    expect(c.text).not.toContain("side pot");
  });
});
