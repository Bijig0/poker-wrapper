/**
 * GET /api/dashboard/live-node (2026-09-30): the side panel's "ranges at this node" for a LIVE decision — keyed by the
 * client's hand id and the decision key, never a hands row (a CoinPoker hand has none until it ends). Postflop it is the
 * stored AI-chain solve's last hero node: hero's strategy by class and every seat's range arriving there; preflop it is
 * the pinned AI tree, and a hand with no pin (or a chart pin) says so.
 */
import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as gtowApiMod from "../services/gtowApi";
import { solveStore } from "../services/solveStore";
import { setPreflopPin, forgetPreflopPin } from "../services/preflopPin";
import { COMBOS } from "../utils/comboIndex/comboIndex";

spyOn(gtowApiMod.gtowApi, "tokenStatus").mockImplementation((() => ({})) as never);
afterAll(() => mock.restore());

const board = "Kc7d2h";
const blocked = new Set(board.match(/.{2}/g)!);
const heroIdx = COMBOS.findIndex((c) => c.hand === "AsKs");
/** a range: every unblocked combo in, hero's combo included */
const full = () => COMBOS.map((c) => (blocked.has(c.cards[0]) || blocked.has(c.cards[1]) ? 0 : 1));
/** a strategy: hero's combo bets, everything else checks */
const strat = (arr: number[]) => [arr.map((w, i) => (w > 0 && i !== heroIdx ? 1 : 0)), arr.map((w, i) => (w > 0 && i === heroIdx ? 1 : 0))];

function trace() {
  const oop = full(), ip = full();
  const oopS = strat(oop), ipS = strat(ip);
  return {
    spec: { oopPos: "SB", ipPos: "BTN", oopRange: oop, ipRange: ip, flopPot: 5.5, flopStack: 97.5, board, streets: [["X"]], heroSeat: "ip", heroComboIdx: heroIdx },
    streets: [{ si: 0, street: "FLOP", board, potIn: 5.5, stackIn: 97.5, labels: ["Check"], fixedLevels: null, solId: "sol-live-1", created: true, oopIn: oop, ipIn: ip }],
    nodes: [
      { si: 0, ti: 0, street: "FLOP", board, codes: [], actor: 0, potNode: 5.5, invested: [0, 0],
        actions: ["Check", "Bet"].map((name, k) => ({ name, code: String(k), betsize: k ? 1.8 : null, position: "SB", totalFrequency: k ? 0.1 : 0.9, totalEv: 2, strategy: oopS[k], evs: oopS[k]!.map(() => 0) })),
        taken: 0, heroNode: false },
      { si: 0, ti: 1, street: "FLOP", board, codes: ["0"], actor: 1, potNode: 5.5, invested: [0, 0],
        actions: ["Check", "Bet"].map((name, k) => ({ name, code: String(k), betsize: k ? 1.8 : null, position: "BTN", totalFrequency: k ? 0.1 : 0.9, totalEv: 2, strategy: ipS[k], evs: ipS[k]!.map(() => 0) })),
        taken: null, heroNode: true },
    ],
    result: { ok: true, solves: 1 },
  };
}

const HAND = "4900000777";
const KEY = JSON.stringify(["flop", ["Kc", "7d", "2h"], ["As", "Ks"], 0, 6]);
const solveId = solveStore.save({
  origin: "live", clientHandId: HAND, wrapperHandId: 7, decisionKey: KEY, street: "flop", board, heroCards: "AsKs", heroPos: "BTN",
  tier: "ai-chain", line: "R2.5-C / X", solves: 1, solveMs: 1200, ok: true, why: null,
}, trace());

const { default: app } = await import("./dashboard");
const get = async (path: string) => { const r = await app.request(path); return { status: r.status, json: (await r.json()) as any }; };

describe("GET /live-node", () => {
  it("postflop: the stored solve's hero node — hero's strategy by class, every seat's arriving range, no dbId needed", async () => {
    expect(solveId).not.toBeNull();
    const { status, json: j } = await get(`/live-node?hand=${HAND}&key=${encodeURIComponent(KEY)}&solveId=${solveId}`);
    expect(status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.source).toBe("ai-chain");
    expect(j.street).toBe("flop");
    expect(j.board).toEqual(["Kc", "7d", "2h"]);
    expect(j.line).toBe("0");
    expect(j.heroCards).toEqual(["As", "Ks"]);
    expect(j.solveId).toBe(solveId);
    expect(j.hero.pos).toBe("BTN");
    expect(j.hero.actions).toEqual(["Check", "Bet 1.8"]);
    // AKs: 4 combos less the blocked (Kc): 3 in range; hero's AsKs bets, the other two check
    const aks = j.hero.strategy["AKs"];
    expect(aks.w).toBe(3);
    expect(aks.acts).toEqual([2, 1]);
    expect(j.hero.range["AKs"].w).toBe(3);
    expect(j.hero.stack).toBe(97.5);
    expect(j.opponents.map((o: any) => o.pos)).toEqual(["SB"]);
    // the SB's range arriving here: whole, less the board's cards
    expect(j.opponents[0].range["AA"].w).toBe(6);
    expect(j.opponents[0].range["KK"].w).toBe(3);
    // the SB acted on this street before hero (checked): his action chart at that decision, the check named
    const act = j.opponents[0].action;
    expect(act.actions).toEqual(["Check", "Bet 1.8"]);
    expect(act.taken).toBe("Check");
    expect(act.takenIndex).toBe(0);
    expect(act.takenPct).toBe(90);                                          // the node's own overall frequency
    expect(act.strategy["AKs"]).toEqual({ w: 3, acts: [2, 1] });           // AsKs bets, the other two check
    expect(j.note).toBeNull();
  });

  it("the same node by hand + key alone, and never another hand's", async () => {
    const { json: j } = await get(`/live-node?hand=${HAND}&key=${encodeURIComponent(KEY)}`);
    expect(j.ok).toBe(true);
    expect(j.solveId).toBe(solveId);
    const other = await get(`/live-node?hand=4900000778&key=${encodeURIComponent(KEY)}`);
    expect(other.status).toBe(404);
    expect(other.json.ok).toBe(false);
  });

  it("preflop: no pinned AI tree says so; a chart pin says which", async () => {
    const pre = JSON.stringify(["preflop", [], ["As", "Ks"], 1.5, 3]);
    const none = await get(`/live-node?hand=4900000779&key=${encodeURIComponent(pre)}`);
    expect(none.status).toBe(404);
    expect(String(none.json.error)).toContain("no preflop tree is pinned");
    setPreflopPin({ piece: "chart6max", handKey: "4900000779", chartId: "ign200_6max_D100_o2_5", depth: 100, codes: ["R2.5"], rawTokens: ["R2.5"], heroPos: "BB", actionIndex: 3, at: Date.now() });
    try {
      const chart = await get(`/live-node?hand=4900000779&key=${encodeURIComponent(pre)}`);
      expect(chart.status).toBe(404);
      expect(String(chart.json.error)).toContain("ign200_6max_D100_o2_5");
    } finally {
      forgetPreflopPin("4900000779");
    }
    const bad = await get(`/live-node`);
    expect(bad.status).toBe(400);
  });
});
