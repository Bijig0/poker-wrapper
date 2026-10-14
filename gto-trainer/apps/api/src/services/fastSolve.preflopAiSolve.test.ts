/**
 * THE SERVED AI PREFLOP ANSWER WRITES A SOLVE (2026-10-14, the answer-path audit's finding 9: solve_id 0 on all 1,021 AI
 * preflop answers of 14 days). fastSolve stores the piece's record (gtowAiPreflop.AiPreflopTrace) in the solve store
 * under origin "preflop-ai" once the served answer is known, and the result carries its id — what studyPoller's logBase
 * writes into answers.solve_id. A warm-up stores nothing. Through the real fastSolve under the CoinPoker ring strategy
 * (no charts in front of the AI piece), against a synthetic GTO Wizard (the cpRing test's), the store's save stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gtowRequests } from "./gtowRequestLog";
import { gtowSessions } from "./gtowSessions";
import { solveStore, type SolveMeta } from "./solveStore";
import { fastSolve, forgetPreflopPin, CP_RING_STRATEGY } from "./fastSolve";
import { resetAiPreflopMemory } from "./gtowAiPreflop";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { withStartStacks } from "../utils/archivedHand/archivedHand";

const HID = "cp-ring-pre-solve-1";
const U = new Array(1326).fill(0.5);
const ORDER = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

function raw(extra: { street: string; board: string[]; actions: any[]; committed: Record<number, number>; stacks: Record<number, number> }) {
  return {
    handId: 900002, clientHandId: HID, site: "coinpoker", bb: 0.5, sb: 0.25, ante: 0.1, bbCents: 50,
    rake: { rake: 5, rakeHeadsUp: 5, rakeCap: 1.2, isPotRakePf: true },
    heroSeatId: 4, heroCards: ["Ah", "Kd"], liveSeats: [1, 2, 3, 4, 5, 6], potByStreet: {},
    positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
    startStacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
    currentNode: { street: extra.street, toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false },
    ended: false, lineSource: "log", sessionId: "session_test_pre_solve",
    ...extra,
  };
}
const PRE = [
  { seatId: 5, hero: false, type: "post-sb", street: "preflop", amount: 0.5 },
  { seatId: 6, hero: false, type: "post-bb", street: "preflop", amount: 1 },
  { seatId: 1, hero: false, type: "fold", street: "preflop" },
  { seatId: 2, hero: false, type: "fold", street: "preflop" },
  { seatId: 3, hero: false, type: "raise", street: "preflop", amount: 2.5 },
];

const preTrees: any[] = [];
let n = 0;
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
function preflopNode(line: string) {
  const toks = line ? line.split("-") : [];
  const actor = ORDER[toks.length % 6]!;
  const lastRaise = [...toks].reverse().find((t) => t.startsWith("R"));
  const size = lastRaise ? Math.round(parseFloat(lastRaise.slice(1)) * 3 * 10) / 10 : 2.5;
  const acts = [{ code: "F", type: "FOLD", betsize: "" }, { code: "C", type: "CALL", betsize: "" }, { code: `R${size}`, type: "RAISE", betsize: String(size) }];
  return {
    game: { players: [{ position: actor, is_hero: true }] },
    action_solutions: acts.map((a) => ({ action: { ...a, allin: false, position: actor }, total_frequency: 1 / 3, strategy: U, evs: U })),
    players_info: [],
  };
}
const reqs = gtowRequests as any, pool = gtowSessions as any;
const saved = {
  save: (solveStore as any).save, fetch: reqs.fetch,
  route: pool.route, routeIb: pool.routeIgnoringBlocks, tokenFor: pool.tokenFor, best: pool.bestToken, ok: pool.noteSuccess, bad: pool.noteFailure,
  block: process.env.GTOW_BLOCK, prefetch: process.env.GTOW_PREFETCH,
};
/** every save the store was asked for: the meta and the trace */
const saves: { meta: SolveMeta; trace: any }[] = [];
function install() {
  process.env.GTOW_BLOCK = "1";
  process.env.GTOW_PREFETCH = "0";
  pool.route = () => ["primary"];
  pool.routeIgnoringBlocks = () => ["primary"];
  pool.tokenFor = async () => "test-token";
  pool.bestToken = async () => ({ id: "primary", token: "test-token" });
  pool.noteSuccess = () => {};
  pool.noteFailure = () => null;
  reqs.fetch = async (_s: unknown, kind: string, url: string, init?: RequestInit) => {
    if (kind === "tree") { preTrees.push(JSON.parse(String(init?.body))); return json({ id: `tree${++n}` }); }
    if (kind === "solution") return json({ id: `pre${++n}` });
    if (kind === "poll") {
      const line = new URL(url).searchParams.get("preflop_actions") ?? "";
      await new Promise((r) => setTimeout(r, 5));
      return json(preflopNode(line));
    }
    return json({ error: `unexpected ${kind}` }, 500);
  };
  (solveStore as any).save = (meta: SolveMeta, trace: unknown) => { saves.push({ meta, trace }); return 4242; };
}
function uninstall() {
  (solveStore as any).save = saved.save;
  reqs.fetch = saved.fetch;
  Object.assign(pool, { route: saved.route, routeIgnoringBlocks: saved.routeIb, tokenFor: saved.tokenFor, bestToken: saved.best, noteSuccess: saved.ok, noteFailure: saved.bad });
  for (const [k, v] of [["GTOW_BLOCK", saved.block], ["GTOW_PREFETCH", saved.prefetch]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

beforeAll(() => { install(); forgetPreflopPin(HID); resetAiPreflopMemory(); });
afterAll(() => { forgetPreflopPin(HID); resetAiPreflopMemory(); uninstall(); });

describe("the served AI preflop answer's solve (2026-10-14)", () => {
  test("the answer carries the id of the stored record; the record is the piece's trace with the decision's final path", async () => {
    saves.length = 0; preTrees.length = 0;
    const hand = withStartStacks(normalizeHand(raw({ street: "preflop", board: [], actions: PRE, committed: { 3: 2.5, 5: 0.5, 6: 1 }, stacks: {} })).hand);
    const r: any = await fastSolve(hand, "BTN", { strategyId: CP_RING_STRATEGY, origin: "test", sessionId: "session_test_pre_solve" });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("gtow-ai-preflop");
    expect(r.tier).toBe("ai-preflop");
    expect(r.solveId).toBe(4242);
    expect(r).not.toHaveProperty("aiTrace");            // internal: never on the result the poller sees
    expect(saves.length).toBe(1);
    const { meta, trace } = saves[0]!;
    expect(meta.origin).toBe("preflop-ai");
    expect(meta.tier).toBe("ai-preflop");
    expect(meta.street).toBe("preflop");
    expect(meta.clientHandId).toBe(HID);
    expect(meta.wrapperHandId).toBe(900002);
    expect(meta.sessionId).toBe("session_test_pre_solve");
    expect(meta.heroPos).toBe("BTN");
    expect(meta.line).toBe("F-F-R2.5");
    expect(meta.ok).toBe(true);
    // the key studyPoller logs the answer under (decisionKey): the same five fields, so the hand page finds it by key too
    expect(meta.decisionKey).toBe(JSON.stringify([hand.street, hand.board, hand.heroCards, hand.currentNode.toCall, hand.actions.length]));
    expect(trace.kind).toBe("preflop-ai");
    expect(trace.askedBy).toBe("test");
    expect(trace.path?.verdict).toBeDefined();
    expect(trace.request.body).toEqual(preTrees[0]);   // the tree exactly as sent
    expect(trace.request.account).toBe("primary");
    expect(trace.line.used).toBe("F-F-R2.5");
    expect(trace.hero.node.actor).toBe("BTN");
    expect(trace.hero.mix).toEqual(r.actions);
    expect(trace.prefix.length).toBe(3);
  });

  test("a warm-up stores nothing and carries no id", async () => {
    saves.length = 0;
    forgetPreflopPin(HID);
    const hand = withStartStacks(normalizeHand(raw({ street: "preflop", board: [], actions: PRE, committed: { 3: 2.5, 5: 0.5, 6: 1 }, stacks: {} })).hand);
    const r: any = await fastSolve(hand, "BTN", { strategyId: CP_RING_STRATEGY, origin: "warm" });
    expect(r.ok).toBe(true);
    expect(r.solveId).toBeUndefined();
    expect(saves.length).toBe(0);
  });
});
