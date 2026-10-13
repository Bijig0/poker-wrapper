/**
 * GET /api/dashboard/live-trail — the paths the independent review (2026-10-13) found untested: hero's chart on a street
 * from the solve that answered him while the villain's reply after it comes from a later street's solve; a street that
 * cannot be built (a note, never a 500); a rebuild when a new answer lands; a hand hero folded; and a LAST-RESORT AI
 * preflop tree, whose two seats are named SB / BB by the heads-up reduction and must land on the table's seats.
 */
import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as gtowApiMod from "../services/gtowApi";
import * as aiPreflop from "../services/gtowAiPreflop";
import { solveStore } from "../services/solveStore";
import { answerLog } from "../services/answerLog";
import { recordPreflopNode } from "../services/preflopPin";
import { handsDbPath, openStore } from "../services/storePaths";
import { ensureHandsSchema } from "../../../../packages/data-root/handsSchema";
import { truncateAt } from "../utils/archivedHand/archivedHand";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { COMBOS } from "../utils/comboIndex/comboIndex";

spyOn(gtowApiMod.gtowApi, "tokenStatus").mockImplementation((() => ({})) as never);

const db = openStore(handsDbPath());
ensureHandsSchema(db);
const rowids: number[] = [];
function putHand(h: any, status = "live"): number {
  const id = Number(db.query(`INSERT INTO hands (hand_id, played_at, stakes, street, hero_cards, action_count, data, client_hand_id, status, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(h.handId, Date.now(), h.stakes, h.street, h.heroCards.join(","), h.actions.length, JSON.stringify(h), h.clientHandId, status, 1000).lastInsertRowid);
  rowids.push(id);
  return id;
}
const act = (hero: number) => (seatId: number, type: string, street: string, amount?: number) => ({ seatId, hero: seatId === hero, type, street, ...(amount != null ? { amount } : {}) });
const SIX = { liveSeats: [1, 2, 3, 4, 5, 6], positions: { 1: "SB", 2: "BB", 3: "CO", 4: "BTN", 5: "UTG", 6: "HJ" }, stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 }, stakes: "$1.00/$2.00" };
const base = (cid: string) => ({ wrapperHandId: 1, clientHandId: cid, heroCards: "AsKs", pick: null, roll: null, warning: null, failReason: null });

// ---- a two-street hand: BB checks, BTN (hero) bets, BB calls the flop; turn BB checks, hero to act ----
const board = "Kc7d2h";
const heroIdx = COMBOS.findIndex((c) => c.hand === "AsKs");
const blockedBy = (b: string) => { const s = new Set(b.match(/.{2}/g)!); return (c: (typeof COMBOS)[number]) => s.has(c.cards[0]) || s.has(c.cards[1]); };
const full = (b: string) => COMBOS.map((c) => (blockedBy(b)(c) ? 0 : 1));
/** two actions: everything takes action `all` except hero's combo, which takes `heroTakes` */
const strat = (r: number[], all: number, heroTakes: number) => [0, 1].map((k) => r.map((w, i) => (w > 0 ? ((i === heroIdx ? heroTakes : all) === k ? 1 : 0) : 0)));
const actions = (pos: string, names: [string, string], s: number[][], size: number | null) =>
  names.map((name, k) => ({ name, code: String(k), betsize: k ? size : null, position: pos, totalFrequency: 0.5, totalEv: 1, strategy: s[k], evs: s[k]!.map(() => 0) }));
const spec = (b: string) => ({ oopPos: "BB", ipPos: "BTN", oopRange: full(b), ipRange: full(b), flopPot: 5.5, flopStack: 97.5, board: b, streets: [["X"]], heroSeat: "ip", heroComboIdx: heroIdx, rake: { pct_of_pot: 5, cap_in_chips: 2 } });
const flopStreet = { si: 0, street: "FLOP", board, potIn: 5.5, stackIn: 97.5, labels: [], fixedLevels: null, solId: "sol-flop", created: true, oopIn: full(board), ipIn: full(board), account: "primary" };
const R = full(board);
// the FLOP answer's own solve: hero's node CHECKS everything but his AsKs, which bets
const flopSolve = {
  spec: spec(board), streets: [flopStreet],
  nodes: [
    { si: 0, ti: 0, street: "FLOP", board, codes: [], actor: 0, actions: actions("BB", ["Check", "Bet"], strat(R, 0, 0), 1.8), taken: 0 },
    { si: 0, ti: 1, street: "FLOP", board, codes: ["0"], actor: 1, actions: actions("BTN", ["Check", "Bet"], strat(R, 0, 1), 1.8), taken: null },
  ],
};
// the TURN answer's solve re-walked the flop on ANOTHER tree (hero's node here bets everything) and read BB's call
const turnBoard = "Kc7d2h5s";
const turnSolve = {
  spec: spec(board),
  streets: [{ ...flopStreet, solId: "sol-flop-retree" }, { si: 1, street: "TURN", board: turnBoard, potIn: 9.1, stackIn: 95.7, labels: [], fixedLevels: null, solId: "sol-turn", created: true, oopIn: full(turnBoard), ipIn: full(turnBoard), account: "primary" }],
  nodes: [
    { si: 0, ti: 0, street: "FLOP", board, codes: [], actor: 0, actions: actions("BB", ["Check", "Bet"], strat(R, 0, 0), 1.8), taken: 0 },
    { si: 0, ti: 1, street: "FLOP", board, codes: ["0"], actor: 1, actions: actions("BTN", ["Check", "Bet"], strat(R, 1, 1), 1.8), taken: 1 },
    { si: 0, ti: 2, street: "FLOP", board, codes: ["0", "1"], actor: 0, actions: actions("BB", ["Fold", "Call"], strat(R, 1, 1), null), taken: 1 },
    { si: 1, ti: 0, street: "TURN", board: turnBoard, codes: [], actor: 0, actions: actions("BB", ["Check", "Bet"], strat(full(turnBoard), 0, 0), 3), taken: 0 },
    { si: 1, ti: 1, street: "TURN", board: turnBoard, codes: ["0"], actor: 1, actions: actions("BTN", ["Check", "Bet"], strat(full(turnBoard), 0, 1), 3), taken: null },
  ],
};
const A = act(4);
const CID2 = "4900000891";
const HAND2 = {
  ...SIX, heroSeatId: 4, heroCards: ["As", "Ks"], board: ["Kc", "7d", "2h", "5s"], street: "turn", handId: 891, clientHandId: CID2, ended: false,
  actions: [A(1, "post-sb", "preflop", 0.5), A(2, "post-bb", "preflop", 1), A(5, "fold", "preflop"), A(6, "fold", "preflop"), A(3, "fold", "preflop"),
            A(4, "raise", "preflop", 2.5), A(1, "fold", "preflop"), A(2, "call", "preflop", 2.5),
            A(2, "check", "flop"), A(4, "bet", "flop", 1.8), A(2, "call", "flop", 1.8), A(2, "check", "turn")],
  currentNode: { street: "turn", toActSeatId: 4, toActIsHero: true, pot: 9.1, toCall: 0 },
};
const FLOP_KEY = JSON.stringify(["flop", ["Kc", "7d", "2h"], ["As", "Ks"], 0, 9]);
const TURN_KEY = JSON.stringify(["turn", ["Kc", "7d", "2h", "5s"], ["As", "Ks"], 0, 12]);
const row2 = putHand(HAND2);
const flopId = solveStore.save({ origin: "live", clientHandId: CID2, wrapperHandId: 891, decisionKey: FLOP_KEY, street: "flop", board, heroCards: "AsKs", heroPos: "BTN", tier: "ai-chain", line: "", solves: 1, solveMs: 1, ok: true, why: null }, flopSolve);
const turnId = solveStore.save({ origin: "live", clientHandId: CID2, wrapperHandId: 891, decisionKey: TURN_KEY, street: "turn", board: turnBoard, heroCards: "AsKs", heroPos: "BTN", tier: "ai-chain", line: "", solves: 1, solveMs: 1, ok: true, why: null }, turnSolve);
answerLog.add({ ...base(CID2), ts: Date.now() - 3000, street: "flop", board, decisionKey: FLOP_KEY, text: "≈ FLOP — BET 1.8 100%", tier: "ai-chain", latencyMs: 2000, source: "gtow-api-postflop", solveId: flopId } as any);

// ---- hero folds preflop, the board runs out ----
const CID3 = "4900000892";
const F = act(3);
const HAND3 = {
  ...SIX, heroSeatId: 3, heroCards: ["7c", "2d"], board: ["Kc", "7d", "2h"], street: "flop", handId: 892, clientHandId: CID3, ended: true,
  actions: [F(1, "post-sb", "preflop", 0.5), F(2, "post-bb", "preflop", 1), F(5, "raise", "preflop", 2.5), F(6, "fold", "preflop"), F(3, "fold", "preflop"),
            F(4, "fold", "preflop"), F(1, "fold", "preflop"), F(2, "call", "preflop", 2.5), F(2, "check", "flop"), F(5, "bet", "flop", 2)],
  currentNode: { street: "flop", toActSeatId: null, toActIsHero: false, pot: 5.5, toCall: 0 },
};
putHand(HAND3, "done");
answerLog.add({ ...base(CID3), heroCards: "7c2d", ts: Date.now() - 9000, street: "preflop", board: null, decisionKey: JSON.stringify(["preflop", [], ["7c", "2d"], 2.5, 4]),
  text: "PREFLOP — Fold 100%", tier: "ai-preflop", latencyMs: 3000, chart: "gtow-ai · 6-handed", source: "gtow-ai-preflop" } as any);

// ---- a last-resort AI preflop tree: CO (hero) opened, BTN 3-bet; the tree holds CO and BTN as the reduction's SB / BB ----
const CID4 = "4900000893";
const C = act(3);
const HAND4 = {
  ...SIX, heroSeatId: 3, heroCards: ["Ah", "Qh"], board: [], street: "preflop", handId: 893, clientHandId: CID4, ended: false,
  actions: [C(1, "post-sb", "preflop", 0.5), C(2, "post-bb", "preflop", 1), C(5, "fold", "preflop"), C(6, "fold", "preflop"), C(3, "raise", "preflop", 2.5),
            C(4, "raise", "preflop", 8), C(1, "fold", "preflop"), C(2, "fold", "preflop")],
  currentNode: { street: "preflop", toActSeatId: 3, toActIsHero: true, pot: 11.5, toCall: 5.5 },
};
putHand(HAND4);
const PRE4 = JSON.stringify(["preflop", [], ["Ah", "Qh"], 5.5, 8]);
answerLog.add({ ...base(CID4), heroCards: "AhQh", ts: Date.now() - 1000, street: "preflop", board: null, decisionKey: PRE4,
  text: "PREFLOP — Call 100%", tier: "ai-preflop", latencyMs: 3000, chart: "gtow-ai · 2-handed", source: "gtow-ai-preflop" } as any);
const red = aiPreflop.reduceToHeadsUp(truncateAt(normalizeHand(HAND4 as any).hand, 8), "CO");
recordPreflopNode({ piece: "gtow-ai-preflop", handKey: CID4, solId: "sol-red", id: "gtow-ai · 2-handed", shape: { positions: ["SB", "BB"] } as any,
  codes: ["R2.5", "R8"], rawTokens: ["F", "F", "R2.5", "R8", "F", "F"], heroPos: "CO", actionIndex: 8, at: Date.now(), cacheKey: "test-key",
  reduced: { droppedPos: ["UTG", "HJ", "SB", "BB"] }, warm: null } as any, "AhQh");
// the reduction's names: which of SB / BB is the CO (hero) and which the BTN (the 3-bettor)
const nameOf = (tablePos: string) => (red?.keptPos[0] === tablePos ? "SB" : "BB");
const g = { AQs: { w: 4, acts: [0, 4] } };
const viewSpy = spyOn(aiPreflop, "livePreflopNodeView").mockImplementation((async () => ({
  ok: true, source: "gtow-ai-preflop", street: "preflop", board: [], line: "R2.5-R8", heroCards: ["Ah", "Qh"],
  hero: { pos: nameOf("CO"), stack: 100, actions: ["Fold", "Call"], strategy: g, range: {} },
  opponents: [{ pos: nameOf("BTN"), stack: 100, range: {}, action: { actions: ["Fold", "Raise 8"], strategy: g, taken: "Raise 8", takenIndex: 1, takenPct: 9.5 } }],
  folded: [], note: "a last-resort tree",
})) as never);

const { default: app, _restartForTests } = await import("./dashboard");
afterAll(() => {
  viewSpy.mockRestore();
  mock.restore();
  for (const id of rowids) db.run("DELETE FROM hands WHERE rowid = ?", [id]);
  db.close();
  _restartForTests();
});
const get = async (path: string) => { const r = await app.request(path); return { status: r.status, json: (await r.json()) as any }; };

describe("GET /live-trail — the reviewed paths", () => {
  it("hero's flop chart is the flop answer's own solve; the BB's call after it comes from the turn's solve", async () => {
    let j = (await get(`/live-trail?hand=${CID2}`)).json;
    // before the turn answer: the flop's own solve only — the BB's call was never read
    let flop = j.streets.find((s: any) => s.street === "flop");
    expect(flop.chips.map((c: any) => `${c.pos} ${c.label}`)).toEqual(["BB check", "BTN bet 1.8bb", "BB call 1.8bb"]);
    expect(flop.chips[2].node).toBeNull();
    expect(flop.inputs.solveId).toBe(flopId);

    // the turn answer lands: the trail rebuilds (the cache key moves with the answers)
    answerLog.add({ ...base(CID2), ts: Date.now(), street: "turn", board: turnBoard, decisionKey: TURN_KEY, text: "≈ TURN — BET 3 100%", tier: "ai-chain", latencyMs: 2500, source: "gtow-api-postflop", solveId: turnId } as any);
    j = (await get(`/live-trail?hand=${CID2}`)).json;
    expect(j.pending).toEqual({ idx: 12, street: "turn" });
    flop = j.streets.find((s: any) => s.street === "flop");
    const heroFlop = flop.nodes.find((n: any) => n.hero);
    // hero's chart: the flop solve's (everything checks but AsKs), NOT the turn chain's re-tree (everything bets)
    expect(heroFlop.strategy["AKs"]).toEqual({ w: 3, acts: [2, 1] });
    expect(heroFlop.taken).toBe("bet");                                           // his own solve ends at his node: the table's action
    // the BB's call: read by the turn's chain, marked as the later solve's node
    expect(flop.chips[2].node).toMatch(/^flop-l/);
    expect(flop.nodes.find((n: any) => n.id === flop.chips[2].node)).toMatchObject({ pos: "BB", taken: "Call" });
    expect(flop.inputs.solveId).toBe(flopId);                                    // the inputs: the flop answer's own solve
    expect(flop.inputs.street.solId).toBe("sol-flop");
    const turn = j.streets.find((s: any) => s.street === "turn");
    expect(turn.chips.map((c: any) => `${c.pos} ${c.label}`)).toEqual(["BB check", "BTN ?"]);
    expect(turn.decisions[0]).toMatchObject({ actionIndex: 12, facing: turn.chips[0].node });
    expect(turn.inputs.solveId).toBe(turnId);
  });

  it("a street that cannot be built says so in its note — the rest still draws, never a 500", async () => {
    // a fresh hand (no expanded solve kept for it yet) whose solve store read throws
    const CID5 = "4900000895";
    putHand({ ...HAND2, handId: 895, clientHandId: CID5, board: ["Kc", "7d", "2h"], street: "flop", actions: HAND2.actions.slice(0, 9),
              currentNode: { street: "flop", toActSeatId: 4, toActIsHero: true, pot: 5.5, toCall: 0 } });
    answerLog.add({ ...base(CID5), ts: Date.now(), street: "flop", board, decisionKey: FLOP_KEY, text: "≈ FLOP — BET 1.8 100%", tier: "ai-chain", latencyMs: 2000, source: "gtow-api-postflop", solveId: 999999 } as any);
    const boom = spyOn(solveStore, "forAnswer").mockImplementation((() => { throw new Error("store exploded"); }) as never);
    try {
      const { status, json: j } = await get(`/live-trail?hand=${CID5}`);
      expect(status).toBe(200);
      expect(j.ok).toBe(true);
      expect(j.streets.map((s: any) => s.street)).toEqual(["preflop", "flop"]);
      expect(j.streets[1].note).toBe("this street's trail could not be built: store exploded");
    } finally {
      boom.mockRestore();
    }
  });

  it("a hand hero folded: the streets after it say so", async () => {
    const j = (await get(`/live-trail?hand=${CID3}`)).json;
    expect(j.ok).toBe(true);
    expect(j.live).toBe(false);
    expect(j.pending).toBeNull();
    const flop = j.streets.find((s: any) => s.street === "flop");
    expect(flop.chips.map((c: any) => `${c.pos} ${c.label}`)).toEqual(["BB check", "UTG bet 2bb"]);
    expect(flop.note).toBe("you folded on the preflop — nothing was solved here");
  });

  it("a last-resort AI tree: its SB / BB seats land on the table's CO and BTN, not the real SB's fold", async () => {
    expect(red).not.toBeNull();
    const j = (await get(`/live-trail?hand=${CID4}`)).json;
    const pre = j.streets[0];
    expect(j.pending).toEqual({ idx: 8, street: "preflop" });
    const chip = (pos: string) => pre.chips.find((c: any) => c.pos === pos && !c.pending);
    expect(chip("BTN").node).toBe("pf-5");                                       // the 3-bet chart sits on the BTN's raise
    expect(pre.nodes.find((n: any) => n.id === "pf-5")).toMatchObject({ pos: "BTN", taken: "Raise 8" });
    expect(chip("SB").node).toBeNull();                                           // the real SB folded: no chart there
    const d = pre.decisions.find((x: any) => x.actionIndex === 8);
    expect(pre.nodes.find((n: any) => n.id === d.node)).toMatchObject({ pos: "CO", hero: true, pending: true });
    expect(d.facing).toBe("pf-5");
    expect(d.others).toEqual([{ pos: "BTN", node: "pf-5", range: null }]);
  });
});
