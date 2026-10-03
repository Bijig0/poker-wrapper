/**
 * HAND 4922269408 (2026-10-04, a live HTTP 500) and the third review's other findings, as tests:
 *  3. a preflop all-in is decided by the CHIPS — the CO's "raise" to 13.4 of his 13.4 (Ignition files the Raise button)
 *  4. check #1 fingerprints the seats the flop was walked with (the broke CO dropped), not the spec's three
 *  6. a throw inside the solve is a reasoned no-answer (kind "solver-error"), never an exception out of fastSolve
 * (1, the resume with a broke seat, is aiChain.resumeBroke.test.ts; 5, the race's narrowed tree as its own plan, is
 * checked through the race's own trace in multiwayReroot.lastResort.test.ts.)
 */
import { describe, expect, it } from "bun:test";
import { chainPathChecks, fastSolve, preflopAllInSeats } from "./fastSolve";
import { rangesFp, type ChainTrace } from "./aiChain";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";

// the capture as archived (poker.sqlite hands, client_hand_id 4922269408), cut at hero's turn decision
const RAW = {
  handId: 1, clientHandId: "4922269408", bbCents: 200, heroSeatId: 4, heroCards: ["A♠", "Q♠"], board: ["K♦", "8♠", "3♣", "2♥"], street: "turn",
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "BTN", 2: "SB", 3: "BB", 4: "UTG", 5: "HJ", 6: "CO" },
  stacks: { 1: 31.6, 2: 75.2, 3: 111.2, 4: 74.4, 5: 109.4, 6: 0 },
  startStacks: { 1: 31.6, 2: 75.6, 3: 139.6, 4: 102.8, 5: 109.4, 6: 13.4 },
  currentNode: { street: "turn", toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 33.6, legalActions: [], complete: false },
  actions: [
    { seatId: 2, hero: false, type: "post-sb", street: "preflop", amount: 0.4 }, { seatId: 3, hero: false, type: "post-bb", street: "preflop", amount: 1 },
    { seatId: 4, hero: true, type: "raise", street: "preflop", amount: 2.6 }, { seatId: 5, hero: false, type: "fold", street: "preflop" },
    { seatId: 6, hero: false, type: "raise", street: "preflop", amount: 13.4 }, { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "fold", street: "preflop" }, { seatId: 3, hero: false, type: "call", street: "preflop", amount: 12.4 },
    { seatId: 4, hero: true, type: "call", street: "preflop", amount: 10.8 },
    { seatId: 3, hero: false, type: "bet", street: "flop", amount: 15 }, { seatId: 4, hero: true, type: "call", street: "flop", amount: 15 },
    { seatId: 3, hero: false, type: "bet", street: "turn", amount: 33.6 },
  ],
  heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$1/$2",
};

describe("3. a preflop all-in is decided by the chips", () => {
  const h = normalizeHand(RAW as any).hand!;
  it("the CO's 'raise' to 13.4 of his 13.4 is an all-in (the Raise button pressed for the whole stack)", () => {
    expect([...preflopAllInSeats(h, RAW.startStacks)]).toEqual(["CO"]);
  });
  it("by type too, and never on a stack the capture does not know", () => {
    const typed = { ...h, actions: h.actions.map((a, i) => (i === 4 ? { ...a, type: "all-in" as const } : a)) };
    expect([...preflopAllInSeats(typed, {})]).toEqual(["CO"]);
    expect([...preflopAllInSeats(h, { 3: 139.6, 4: 102.8 })]).toEqual([]);   // the CO's stack unknown: not decided by chips
  });
});

describe("4. check #1 fingerprints the seats the flop was walked with", () => {
  const h = normalizeHand({ ...RAW, street: "flop", board: ["K♦", "8♠", "3♣"], actions: RAW.actions.slice(0, 10),
    currentNode: { ...RAW.currentNode, street: "flop", toCall: 15 } } as any).hand!;
  const r = (w: number) => new Array(1326).fill(w);
  const BB = r(0.4), UTG = r(0.6), CO = r(0.8);
  const trace = (inFp: string): ChainTrace => ({
    spec: { oopPos: "BB", midPos: "UTG", ipPos: "CO", oopRange: BB, midRange: UTG, ipRange: CO, flopPot: 41.6, flopStack: 87.6, board: "Kd8s3c",
      streets: [["R15"]], heroSeat: "mid", heroComboIdx: null } as any,
    streets: [{ si: 0, street: "FLOP", board: "Kd8s3c", potIn: 41.6, stackIn: 87.6, labels: [], fixedLevels: null, solId: "s", created: false,
      oopIn: [], ipIn: [], players: ["BB", "UTG"], rangeCheck: { inFp } } as any],
    nodes: [], result: { ok: true },
  } as ChainTrace);
  const one = (inFp: string) => chainPathChecks({ hand: h, walks: [{ kind: null, trace: trace(inFp) }], arrival: { how: "designed", producer: "test" } as any,
    potExtra: 0, dealt: RAW.startStacks as any, treePos: (sid) => h.positions[sid] ?? null, rake: null, site: null, handTrees: [] }).flop!.find((c) => c.id === 1)!;
  it("the walk dropped the broke CO and fingerprinted BB + UTG: verified (it failed against all three)", () => {
    const c = one(rangesFp([{ pos: "BB", range: BB }, { pos: "UTG", range: UTG }]));
    expect(c.status).toBe("pass");
    expect(c.text).toContain("verified");
  });
  it("a flop that really started from other ranges still fails", () => {
    expect(one(rangesFp([{ pos: "BB", range: r(0.1) }, { pos: "UTG", range: UTG }])).status).toBe("fail");
  });
});

describe("6. a throw inside the solve is a reasoned no-answer", () => {
  it("a capture that makes the solve throw: ok:false, kind solver-error, the message in the reason — no exception", async () => {
    const bad = { clientHandId: "test-throw", handId: 1, heroSeatId: 1, positions: null, actions: null, board: null, heroCards: null, currentNode: { street: "turn" } } as any;
    const res = await fastSolve(bad, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("solver-error");
      expect(res.reason).toContain("the solver threw");
    }
  });
});
