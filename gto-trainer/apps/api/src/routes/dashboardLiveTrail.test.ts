/**
 * GET /api/dashboard/live-trail (2026-10-12, docs/2026-10-12-hand-trail.md): the side panel's hand trail for a hand IN
 * PLAY — read from its live row, its logged answers and the stored solve; every street's chips tied to the node the
 * answer was read on, hero's decision with the action he faces and the other seats at his node, and the inputs as used.
 */
import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as gtowApiMod from "../services/gtowApi";
import { solveStore } from "../services/solveStore";
import { answerLog } from "../services/answerLog";
import { handsDbPath, openStore } from "../services/storePaths";
import { ensureHandsSchema } from "../../../../packages/data-root/handsSchema";
import { COMBOS } from "../utils/comboIndex/comboIndex";

spyOn(gtowApiMod.gtowApi, "tokenStatus").mockImplementation((() => ({})) as never);

const CID = "4900000881";
const board = "Kc7d2h";
const blocked = new Set(board.match(/.{2}/g)!);
const heroIdx = COMBOS.findIndex((c) => c.hand === "AsKs");
const full = () => COMBOS.map((c) => (blocked.has(c.cards[0]) || blocked.has(c.cards[1]) ? 0 : 1));
/** hero's combo bets, everything else checks */
const strat = (arr: number[]) => [arr.map((w, i) => (w > 0 && i !== heroIdx ? 1 : 0)), arr.map((w, i) => (w > 0 && i === heroIdx ? 1 : 0))];
function trace() {
  const oop = full(), ip = full();
  const oopS = strat(oop), ipS = strat(ip);
  const acts = (pos: string, s: number[][]) => ["Check", "Bet"].map((name, k) => ({ name, code: String(k), betsize: k ? 1.8 : null, position: pos, totalFrequency: k ? 0.1 : 0.9, totalEv: 2, strategy: s[k], evs: s[k]!.map(() => 0) }));
  return {
    spec: { oopPos: "BB", ipPos: "BTN", oopRange: oop, ipRange: ip, flopPot: 5.5, flopStack: 97.5, board, streets: [["X"]], heroSeat: "ip", heroComboIdx: heroIdx,
            rake: { pct_of_pot: 5, cap_in_chips: 2 } },
    streets: [{ si: 0, street: "FLOP", board, potIn: 5.5, stackIn: 97.5, labels: ["Check"], fixedLevels: null, solId: "sol-trail-1", created: true, oopIn: oop, ipIn: ip, account: "primary" }],
    nodes: [
      { si: 0, ti: 0, street: "FLOP", board, codes: [], actor: 0, potNode: 5.5, invested: [0, 0], actions: acts("BB", oopS), taken: 0, heroNode: false },
      { si: 0, ti: 1, street: "FLOP", board, codes: ["0"], actor: 1, potNode: 5.5, invested: [0, 0], actions: acts("BTN", ipS), taken: null, heroNode: true },
    ],
    result: { ok: true, solves: 1 },
  };
}

// the hand as the wrapper's live row has it: BTN (hero) opened, BB called, BB checked the flop — hero to act
const act = (seatId: number, type: string, street: string, amount?: number) => ({ seatId, hero: seatId === 4, type, street, ...(amount != null ? { amount } : {}) });
const HAND = {
  heroSeatId: 4, heroCards: ["As", "Ks"], board: ["Kc", "7d", "2h"], street: "flop",
  actions: [act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(5, "fold", "preflop"), act(6, "fold", "preflop"), act(3, "fold", "preflop"),
            act(4, "raise", "preflop", 2.5), act(1, "fold", "preflop"), act(2, "call", "preflop", 2.5), act(2, "check", "flop")],
  liveSeats: [1, 2, 3, 4, 5, 6], positions: { 1: "SB", 2: "BB", 3: "CO", 4: "BTN", 5: "UTG", 6: "HJ" }, stacks: { 1: 99.5, 2: 97.5, 3: 100, 4: 97.5, 5: 100, 6: 100 },
  currentNode: { street: "flop", toActSeatId: 4, toActIsHero: true, pot: 5.5, toCall: 0 },
  ended: false, stakes: "$1.00/$2.00", handId: 881, clientHandId: CID,
};
const PRE_KEY = JSON.stringify(["preflop", [], ["As", "Ks"], 0, 5]);
const FLOP_KEY = JSON.stringify(["flop", ["Kc", "7d", "2h"], ["As", "Ks"], 0, 9]);

const db = openStore(handsDbPath());
ensureHandsSchema(db);
const rowid = Number(db.query(`INSERT INTO hands (hand_id, played_at, stakes, street, hero_cards, action_count, data, client_hand_id, status, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(881, Date.now(), HAND.stakes, "flop", "As,Ks", HAND.actions.length, JSON.stringify(HAND), CID, "live", 1000).lastInsertRowid);
const solveId = solveStore.save({
  origin: "live", clientHandId: CID, wrapperHandId: 881, decisionKey: FLOP_KEY, street: "flop", board, heroCards: "AsKs", heroPos: "BTN",
  tier: "ai-chain", line: "R2.5-C / X", solves: 1, solveMs: 1200, ok: true, why: null,
}, trace());
const base = { wrapperHandId: 881, clientHandId: CID, heroCards: "AsKs", pick: null, roll: null, warning: null, failReason: null };
// preflop: an AI answer whose tree was never kept (no hand facts here) — the decision still shows, with no node
answerLog.add({ ...base, ts: Date.now() - 5000, street: "preflop", board: null, decisionKey: PRE_KEY, text: "PREFLOP — Raise 2.5 100%", tier: "ai-preflop",
  latencyMs: 4200, chart: "gtow-ai · 6-handed · UTG:100/HJ:100/CO:100/BTN:100/SB:100/BB:100", source: "gtow-ai-preflop" } as any);
answerLog.add({ ...base, ts: Date.now(), street: "flop", board, decisionKey: FLOP_KEY, text: "≈ FLOP — BET 1.8 100%", tier: "ai-chain",
  latencyMs: 3100, source: "gtow-api-postflop", solveId } as any);

const { default: app, _restartForTests } = await import("./dashboard");
afterAll(() => {
  mock.restore();
  db.run("DELETE FROM hands WHERE rowid = ?", [rowid]);
  db.close();
  _restartForTests();
});
const get = async (path: string) => { const r = await app.request(path); return { status: r.status, json: (await r.json()) as any }; };

describe("GET /live-trail", () => {
  it("draws every street of the hand in play: chips tied to nodes, hero's pending decision, what he faces, the inputs", async () => {
    const { status, json: j } = await get(`/live-trail?hand=${CID}`);
    expect(status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.live).toBe(true);
    expect(j.pending).toEqual({ idx: 9, street: "flop" });
    expect(j.streets.map((s: any) => s.street)).toEqual(["preflop", "flop"]);

    const pre = j.streets[0];
    expect(pre.chips.map((c: any) => `${c.pos} ${c.label}`)).toEqual(["UTG fold", "HJ fold", "CO fold", "BTN raise 2.5bb", "SB fold", "BB call 2.5bb"]);
    expect(pre.decisions).toHaveLength(1);
    expect(pre.decisions[0].actionIndex).toBe(5);
    expect(pre.decisions[0].answer.source).toBe("gtow-ai-preflop");
    expect(pre.decisions[0].node).toBeNull();                                   // no tree was kept for it
    expect(pre.inputs.kind).toBe("gtow-ai-preflop");
    expect(pre.inputs.ai[0].view).toContain("no record");

    const flop = j.streets[1];
    expect(flop.board).toEqual(["Kc", "7d", "2h"]);
    expect(flop.chips.map((c: any) => `${c.pos} ${c.label}`)).toEqual(["BB check", "BTN ?"]);
    expect(flop.chips[0].node).toBe("flop-0");
    expect(flop.chips[1]).toMatchObject({ pending: true, hero: true, node: "flop-1" });
    const bbNode = flop.nodes.find((n: any) => n.id === "flop-0");
    expect(bbNode).toMatchObject({ pos: "BB", hero: false, taken: "Check", takenPct: 90, actions: ["Check", "Bet 1.8"] });
    expect(bbNode.strategy["AKs"]).toEqual({ w: 3, acts: [2, 1] });
    const heroNode = flop.nodes.find((n: any) => n.id === "flop-1");
    expect(heroNode).toMatchObject({ pos: "BTN", hero: true, pending: true, taken: null });
    const d = flop.decisions[0];
    expect(d).toMatchObject({ actionIndex: 9, node: "flop-1", facing: "flop-0" });   // facing the BB's check
    expect(d.others).toEqual([{ pos: "BB", node: "flop-0", range: null }]);
    expect(d.heroMix).toEqual([{ action: "Bet 1.8", pct: 100 }]);
    expect(d.answer).toMatchObject({ source: "gtow-api-postflop", latencyMs: 3100, solveId });
    // the inputs: the tree request as sent (rebuilt here: this trace recorded none), the rake, the account
    expect(flop.inputs.kind).toBe("ai-chain");
    expect(flop.inputs.solveId).toBe(solveId);
    expect(flop.inputs.spec.rakeSent).toEqual({ pct_of_pot: 5, cap_in_chips: 2 });
    expect(flop.inputs.spec.rakeDefaulted).toBe(false);
    expect(flop.inputs.street).toMatchObject({ potIn: 5.5, stackIn: 97.5, players: ["BB", "BTN"], account: "primary", sentFrom: "rebuilt" });
    expect(flop.inputs.street.sent.pot).toBe(5.5);
    expect(flop.inputs.street.combosIn).toEqual({ BB: 1176, BTN: 1176 });                 // C(49,2): the board's cards out
  });

  it("is kept until the row or the answers change", async () => {
    const a = await get(`/live-trail?hand=${CID}`);
    const b = await get(`/live-trail?hand=${CID}`);
    expect(b.json).toEqual(a.json);
    db.run("UPDATE hands SET updated_at = 2000 WHERE rowid = ?", [rowid]);
    const c = await get(`/live-trail?hand=${CID}`);
    expect(c.json.ok).toBe(true);
  });

  it("says why when there is nothing, and turns off", async () => {
    expect((await get(`/live-trail`)).status).toBe(400);
    const none = await get(`/live-trail?hand=4900000882`);
    expect(none.status).toBe(404);
    expect(String(none.json.error)).toContain("no row");
    process.env.PANEL_TRAIL = "off";
    try {
      const off = await get(`/live-trail?hand=${CID}`);
      expect(off.status).toBe(404);
      expect(off.json.off).toBe(true);
    } finally {
      delete process.env.PANEL_TRAIL;
    }
  });
});
