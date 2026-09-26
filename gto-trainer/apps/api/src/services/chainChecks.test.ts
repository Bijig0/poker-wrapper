/**
 * THE CHAIN'S INVARIANTS (services/chainChecks, 2026-09-27): every check is a pure function; the verdict folds them in.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  CHECKS, SolveTimes, addChecks, asWalkedEarlier, checkAnswerClock, checkBoard, checkButtons, checkCode, checkFlopArrival,
  checkFresh, checkHandoff, checkHeroCombo, checkLine, checkMistakeLines, checkMix, checkNodeReads, checkPotStack,
  checkPreflopInRange, checkRake, checkRangesSane, checkReasons, checkSeats, checkSolveTime, checkTrees, checkWarmTree,
  comboName, coverageReport, expectedOrder, mergeChecks, type CheckResult, type PathChecks,
} from "./chainChecks";
import { classifyPath, cleanRate, VERDICT_LABEL } from "./chainPath";
import { comboIndex } from "../utils/comboIndex/comboIndex";
import type { OffTreeLine } from "./offTree";

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
    expect(CHECKS.find((c) => c.id === 13)!.build).toBe("to build");
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
});

describe("#4 seats right", () => {
  it("postflop order by position; heads-up the big blind first", () => {
    expect(expectedOrder(["BTN", "BB"])).toEqual(["BB", "BTN"]);
    expect(expectedOrder(["BB", "SB"])).toEqual(["BB", "SB"]);
    expect(expectedOrder(["CO", "SB", "BB"])).toEqual(["SB", "BB", "CO"]);
    expect(expectedOrder(["SB+BB", "CO"])).toBeNull();
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
  it("na until a baseline; over 3× (and a second) the median fails; the multiple is configurable", () => {
    expect(checkSolveTime({ street: "flop", ms: 9000, median: 2000, samples: 4, created: true }).status).toBe("na");
    expect(checkSolveTime({ street: "flop", ms: 9000, median: 2000, samples: 20, created: true }).status).toBe("fail");
    expect(checkSolveTime({ street: "flop", ms: 5000, median: 2000, samples: 20, created: true }).status).toBe("pass");
    expect(checkSolveTime({ street: "flop", ms: 40, median: 5, samples: 20, created: false }).status).toBe("pass");   // under a second over
    process.env.CHECK_SOLVE_MEDIAN_X = "2";
    expect(checkSolveTime({ street: "flop", ms: 5000, median: 2000, samples: 20, created: true }).status).toBe("fail");
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
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 20], ["Allin", 30]), toCall: 20, heroBehind: 15 }).text).toContain("all in");
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "BTN", heroPos: "CO" }).status).toBe("fail");
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "SB", heroPos: "BTN", hu: true }).status).toBe("pass");
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "OOP", heroPos: "CO" }).status).toBe("pass");
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "BU", heroPos: "BTN" }).status).toBe("pass");   // a chart's name for the button
    expect(checkButtons({ actions: mix(["Fold", 50], ["Call", 50]), toCall: 1, nodePos: "LJ", heroPos: "UTG" }).status).toBe("pass");   // another vocabulary: not evidence
    expect(checkButtons({ actions: mix(["Check", 100]), toCall: 0, legal: ["fold", "call"] }).status).toBe("fail");
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
    expect([thirteen.seen, thirteen.build]).toEqual([false, "to build"]);
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
