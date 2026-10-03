/**
 * THE CHECKS AGAINST THE CAPTURE (fastSolve.chainPathChecks / decisionChecks, 2026-09-27): #1 #5 #7 #8 per street of a
 * stored walk, and the decision's own #12 #14 #15 #16 #17 — on a synthetic trace of a real-shaped hand, no network.
 * CO opens 2.5 with AdKc, BB calls; flop As7d2c: BB checks, hero bets 1.7, BB calls; turn Kh: BB checks, hero bets 4,
 * BB calls; river 3s: BB checks, hero to act. Pot 5.5 → 8.9 → 16.9; stacks 97.5 → 95.8 → 91.8.
 */
import { describe, expect, it } from "bun:test";
import { chainPathChecks, decisionChecks } from "./fastSolve";
import { rangesFp, type ChainTrace } from "./aiChain";
import { classifyPath } from "./chainPath";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import type { FastSolveResult } from "./fastSolve";

const RAW = {
  handId: 7001, clientHandId: "4999000077", bbCents: 200, heroSeatId: 5, heroCards: ["A♦", "K♣"],
  board: ["A♠", "7♦", "2♣", "K♥", "3♠"], street: "river", liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" },
  stacks: { 1: 99.5, 2: 91.8, 3: 100, 4: 100, 5: 91.8, 6: 100 },
  startStacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
  currentNode: { street: "river", toActSeatId: 5, toActIsHero: true, pot: 16.9, toCall: 0, legalActions: [], complete: false },
  actions: [
    { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 },
    { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 5, hero: true, type: "raise", street: "preflop", amount: 2.5 },
    { seatId: 6, hero: false, type: "fold", street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "call", street: "preflop", amount: 1.5 },
    { seatId: 2, hero: false, type: "check", street: "flop" },
    { seatId: 5, hero: true, type: "bet", street: "flop", amount: 1.7 },
    { seatId: 2, hero: false, type: "call", street: "flop", amount: 1.7 },
    { seatId: 2, hero: false, type: "check", street: "turn" },
    { seatId: 5, hero: true, type: "bet", street: "turn", amount: 4 },
    { seatId: 2, hero: false, type: "call", street: "turn", amount: 4 },
    { seatId: 2, hero: false, type: "check", street: "river" },
  ],
  heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$1/$2",
};
const hand = () => normalizeHand(RAW).hand!;
const RAKE = { pct_of_pot: 5, cap_in_chips: 2 };
const oop = new Array(1326).fill(0.5), ip = new Array(1326).fill(0.4);
const fp = rangesFp([{ pos: "BB", range: oop }, { pos: "CO", range: ip }]);

type St = ChainTrace["streets"][number];
const st = (si: number, street: St["street"], board: string, potIn: number, stackIn: number, over: Partial<St> = {}): St => ({
  si, street, board, potIn, stackIn, labels: [], fixedLevels: null, solId: `s${si}`, created: false, oopIn: [], ipIn: [],
  players: ["BB", "CO"], sent: { rake: RAKE },
  rangeCheck: si === 0 ? { from: null, ok: null, inFp: fp, expected: null, why: "the flop starts from the preflop ranges" }
    : { from: si === 1 ? "flop" : "turn", ok: true, inFp: "x", expected: "x", why: "verified" },
  ...over,
});
const trace = (streets: St[]): ChainTrace => ({
  spec: { oopPos: "BB", ipPos: "CO", oopRange: oop, ipRange: ip, flopPot: 5.5, flopStack: 97.5, board: "As7d2cKh3s", streets: [[], [], []], heroSeat: "ip", heroComboIdx: null },
  streets,
  nodes: [{ si: 2, ti: 1, street: "RIVER", board: "As7d2cKh3s", codes: ["X"], actor: 1, potNode: 16.9, invested: [0, 0], actions: [], taken: null, heroNode: true }],
  result: { ok: true },
});
const good = () => [st(0, "FLOP", "As7d2c", 5.5, 97.5), st(1, "TURN", "As7d2cKh", 8.9, 95.8), st(2, "RIVER", "As7d2cKh3s", 16.9, 91.8)];
const run = (streets: St[], over: Partial<Parameters<typeof chainPathChecks>[0]> = {}) => {
  const h = hand();
  return chainPathChecks({
    hand: h, walks: [{ kind: null, trace: trace(streets) }], arrival: { how: "pin", producer: "pin-chart6max" }, potExtra: 0,
    dealt: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 }, treePos: (sid) => h.positions[sid] ?? null, rake: RAKE,
    site: "the table's", handTrees: [], ...over,
  });
};
const status = (c: ReturnType<typeof run>, street: "flop" | "turn" | "river", id: number) => c[street]!.find((x) => x.id === id)?.status;

describe("chainPathChecks: #1 #5 #7 #8 against the capture", () => {
  it("a walk whose pots, stacks, rake and board are the table's passes all four on every street", () => {
    const c = run(good());
    for (const s of ["flop", "turn", "river"] as const) for (const id of [1, 5, 7, 8]) expect([s, id, status(c, s, id)]).toEqual([s, id, "pass"]);
    expect(c.flop!.find((x) => x.id === 1)!.text).toContain("verified");
    expect(c.river!.find((x) => x.id === 5)!.text).toContain("16.9bb at hero's node");
    expect(classifyPath({ street: "river", streets: [], checks: c }).verdict).toBe("clean");
  });
  it("#5: a turn solved at a pot the table never had fails, and the path's verdict is 'failed'", () => {
    const s = good();
    s[1] = st(1, "TURN", "As7d2cKh", 12, 95.8);
    const c = run(s);
    expect(status(c, "turn", 5)).toBe("fail");
    const p = classifyPath({ street: "river", streets: [], checks: c });
    expect(p.verdict).toBe("failed");
    expect(p.reasons[0]!.text).toContain("pot entering the turn 12bb, the capture's 8.9bb");
  });
  it("#5: a stack that is not the effective stack of the players still in fails", () => {
    const s = good();
    s[2] = st(2, "RIVER", "As7d2cKh3s", 16.9, 60);
    expect(status(run(s), "river", 5)).toBe("fail");
  });
  it("#7: a rake that changed within the hand, or is not the table's, fails", () => {
    const s = good();
    s[1] = st(1, "TURN", "As7d2cKh", 8.9, 95.8, { sent: { rake: { pct_of_pot: 5, cap_in_chips: 0.6 } } });
    const c = run(s);
    expect(status(c, "turn", 7)).toBe("fail");
    expect(status(c, "flop", 7)).toBe("fail");   // the flop's rake is fine, but the hand's turn differs
    expect(status(run(good(), { handTrees: [{ k: 0, rake: { pct_of_pot: 5, cap_in_chips: 3 } }] }), "river", 7)).toBe("fail");
  });
  it("#8: a board the capture does not show fails; #1: a flop that started from other ranges fails", () => {
    const s = good();
    s[0] = st(0, "FLOP", "As7d2h", 5.5, 97.5);
    expect(status(run(s), "flop", 8)).toBe("fail");
    const t = good();
    t[0] = st(0, "FLOP", "As7d2c", 5.5, 97.5, { rangeCheck: { from: null, ok: null, inFp: "different", expected: null, why: "x" } });
    expect(status(run(t), "flop", 1)).toBe("fail");
  });
  it("a memo-hit street's process checks describe the decision that walked it", () => {
    const s = good();
    s[0] = { ...st(0, "FLOP", "As7d2c", 5.5, 97.5), fromCheckpoint: true, checks: [{ id: 12, status: "fail", text: "flop 9.1 s" }] };
    const c = run(s);
    const twelve = c.flop!.find((x) => x.id === 12)!;
    expect(twelve.text).toBe("when walked: flop 9.1 s");
    expect(twelve.covered).toBe("earlier-decision");
  });
});

describe("decisionChecks: the answer's own #12 #14 #15 #16", () => {
  const ok = (actions: { action: string; frequency: number }[]): FastSolveResult => ({
    ok: true, source: "gtow-api-postflop", street: "river", setId: "x", gametype: "x", depth: 100, line: "", pos: null, heroClass: "AKo",
    actions: actions.map((a) => ({ ...a, ev: 0, betsize: null })) as any, decision: null,
  });
  it("a live river answer within the clock, consistent with nothing to call, summing to 100%", () => {
    const xs = decisionChecks(hand(), ok([{ action: "Check", frequency: 40 }, { action: "Bet 8", frequency: 60 }]), "live", 3200, "CO");
    expect(xs.map((x) => [x.id, x.status])).toEqual([[12, "pass"], [14, "pass"], [15, "pass"], [16, "pass"]]);
  });
  it("a FOLD with nothing to call and a mix that does not sum fail", () => {
    const xs = decisionChecks(hand(), ok([{ action: "Fold", frequency: 10 }, { action: "Check", frequency: 50 }]), "live", 18000, "CO");
    expect(Object.fromEntries(xs.map((x) => [x.id, x.status]))).toEqual({ 12: "fail", 14: "fail", 15: "fail", 16: "pass" });
  });
  it("a refusal surfaces its guard, covered by the refusal itself", () => {
    const zero = decisionChecks(hand(), { ok: false, street: "river", reason: "hero's AdKc has every action at 0% over Check/Bet: …" }, "live", 100, "CO");
    expect(zero).toEqual([{ id: 15, status: "fail", text: expect.stringContaining("zero-mix guard"), covered: "fault:no-answer" }]);
    const dup = decisionChecks(hand(), { ok: false, kind: "capture-fault", street: "river", reason: "the capture … — hero holds As and As is on the board As 7d 2c" }, "live", 100, "CO");
    expect(dup[0]!.id).toBe(8);
    expect(dup[0]!.covered).toBe("fault:capture-fault");
  });
});

/**
 * #14 ON THE REAL HANDS (2026-10-03, audit finding 5): the three answers #14 failed since 2026-09-27, as the capture
 * stood when each was asked (poker.sqlite hands.data, cut back to the decision; Ignition's own history agrees).
 */
describe("decisionChecks #14 on the three hands it failed", () => {
  const aiPre = (actions: { action: string; frequency: number }[], pos: string): FastSolveResult => ({
    ok: true, source: "gtow-ai-preflop", street: "preflop", setId: "gtow-ai-preflop", gametype: "x", depth: 59, line: "", pos, heroClass: "x",
    actions: actions.map((a) => ({ ...a, ev: 0, betsize: null })) as any, decision: null,
  });
  // 4921651217 (2026-09-30): seats 1 BB, 2 CO (hero, 6c2h), 4 BTN, 6 SB — seat 4 sat out (not in liveSeats, no action),
  // so three were dealt; Ignition's history names hero UTG; the AI tree "3-handed · BTN:109/SB:70/BB:59" put hero's
  // 108.8bb at its BTN. Hero is first to act facing the big blind: Fold 99.98.
  const deadButton = (id: string, stacks: Record<number, number>) => normalizeHand({
    handId: 19, clientHandId: id, bbCents: 5, heroSeatId: 2, heroCards: ["6♣", "2♥"], board: [], street: "preflop",
    liveSeats: [1, 2, 6], committed: { 6: 0.4, 1: 1 }, potByStreet: {}, positions: { 6: "SB", 1: "BB", 2: "CO", 4: "BTN" },
    stacks, startStacks: stacks,
    currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 1.4, toCall: 1, legalActions: [], complete: false },
    actions: [
      { seatId: 6, hero: false, type: "post-sb", street: "preflop", amount: 0.4 },
      { seatId: 1, hero: false, type: "post-bb", street: "preflop", amount: 1 },
    ],
    heroFolded: false, ended: false, lineSource: "ws", sessionId: "session_20260930_150739", stakes: "$0.02/$0.05",
  }).hand!;
  it("4921651217 / 4922085772: a dead button, three dealt — the tree's BTN is hero's CO seat: pass", () => {
    // SINCE 2026-10-04 normalizeHand renames a dead button's dealt seats among the dealt (utils/dealtSeats
    // .relabelUndealt): hero's seat 2, labelled CO beside the undealt BTN, IS the button of a table dealt three — the
    // name the AI tree gave him all along. The node and the label now agree outright, and the label's own check says
    // where the name came from.
    const h = deadButton("4921651217", { 1: 57.8, 2: 108.8, 6: 69.4 });
    expect(h.positions).toEqual({ 6: "SB", 1: "BB", 2: "BTN" });
    const xs = decisionChecks(h, aiPre([{ action: "Fold", frequency: 99.98 }], "BTN"), "live", 4237, "CO");
    const c14 = xs.filter((x) => x.id === 14);
    expect(c14.map((x) => x.status)).toEqual(["pass", "pass"]);
    expect(c14[1]!.text).toContain("hero's BTN is his name among the 3 seats dealt (button seat 4, not dealt — a dead button) (the source labelled him CO");
    // a node of another seat at the same table still fails
    expect(decisionChecks(h, aiPre([{ action: "Fold", frequency: 100 }], "SB"), "live", 4237, "CO").find((x) => x.id === 14)!.status).toBe("fail");
    expect(classifyPath({ street: "preflop", streets: [], checks: { preflop: xs } }).verdict).toBe("clean");
    // the hand as the old wrapper sent it, had nothing renamed it: hero's CO is NOT his name among the seats dealt
    const raw = { ...h, positions: { 6: "SB", 1: "BB", 2: "CO" }, seatRelabel: { ...h.seatRelabel!, from: { 6: "SB", 1: "BB", 2: "CO", 4: "BTN" } } };
    const bad = decisionChecks(raw, aiPre([{ action: "Fold", frequency: 99.98 }], "BTN"), "live", 4237, "CO").filter((x) => x.id === 14);
    expect(bad.map((x) => x.status)).toEqual(["pass", "fail"]);
    expect(bad[1]!.text).toContain("hero is labelled CO but is the BTN among the 3 seats dealt");
    expect(classifyPath({ street: "preflop", streets: [], checks: { preflop: bad } }).verdict).toBe("failed");
  });
  it("4921673474: QQ in the BB, 13 in, the button shoves 111.8 — All-in is the call for 87: pass", () => {
    const h = normalizeHand({
      handId: 3, clientHandId: "4921673474", bbCents: 5, heroSeatId: 1, heroCards: ["Q♠", "Q♥"], board: [], street: "preflop",
      liveSeats: [1, 2, 3, 5, 6], committed: { 1: 13, 5: 111.8, 6: 0.4, 3: 1 }, potByStreet: {},
      positions: { 6: "SB", 1: "BB", 2: "HJ", 3: "CO", 5: "BTN" },
      stacks: { 1: 87, 2: 92.4, 3: 124.8, 5: 0, 6: 21.8 }, startStacks: { 6: 22.2, 1: 100, 2: 92.4, 3: 125.8, 5: 111.8 },
      currentNode: { street: "preflop", toActSeatId: 1, toActIsHero: true, pot: 126.2, toCall: 98.8, legalActions: [], complete: false },
      actions: [
        { seatId: 6, hero: false, type: "post-sb", street: "preflop", amount: 0.4 },
        { seatId: 1, hero: true, type: "post-bb", street: "preflop", amount: 1 },
        { seatId: 2, hero: false, type: "fold", street: "preflop" },
        { seatId: 3, hero: false, type: "call", street: "preflop", amount: 1 },
        { seatId: 5, hero: false, type: "raise", street: "preflop", amount: 7 },
        { seatId: 6, hero: false, type: "fold", street: "preflop" },
        { seatId: 1, hero: true, type: "raise", street: "preflop", amount: 13 },
        { seatId: 3, hero: false, type: "fold", street: "preflop" },
        { seatId: 5, hero: false, type: "raise", street: "preflop", amount: 111.8 },
      ],
      heroFolded: false, ended: false, lineSource: "ws", sessionId: "session_20260930_190719", stakes: "$0.02/$0.05",
    }).hand!;
    expect(h.stacks?.[1]).toBe(87);
    const xs = decisionChecks(h, aiPre([{ action: "Fold", frequency: 0.17 }, { action: "All-in", frequency: 99.83 }], "BB"), "live", 4537, "BB");
    const c14 = xs.find((x) => x.id === 14)!;
    expect(c14.status).toBe("pass");
    expect(c14.text).toContain("its all-in is the call for less (87bb behind, 98.8bb to call)");
    // a SIZED raise there is still impossible
    expect(decisionChecks(h, aiPre([{ action: "Raise 40", frequency: 100 }], "BB"), "live", 4537, "BB").find((x) => x.id === 14)!.status).toBe("fail");
  });
});
