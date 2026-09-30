/**
 * THE COINPOKER RING-WITH-ANTES STRATEGY, END TO END (2026-09-30). A CoinPoker NL50 6-max hand — ante 0.1 (0.2bb) per
 * player, the table's rake terms as the CoinPoker server sends them (5%, cap 1.2 USDT = 2.4bb, preflop pots raked) — run
 * through the real fastSolve under `cp-ring-6max-ante-ondemand`, against a SYNTHETIC GTO Wizard: the AI preflop piece's
 * requests (gtowRequests.fetch) and the postflop chain's (gtowApi.ensureCustomSolution / customNode) are replaced, and
 * GTOW_BLOCK=1 stops anything else leaving the process. What is asserted is what GTO Wizard would have been SENT:
 *
 *   - preflop: one six-handed tree with the stacks as dealt (before the ante), `ante: 0.2` per player, and the table's
 *     own rake — 5%, cap 2.4bb, preflop pots raked ("full") — never Ignition's no-flop-no-drop cap by seats dealt;
 *   - postflop, with no preflop Solve pressed first (the on-demand case): the flop ranges come from an AI preflop tree
 *     built from the table (never a 6-max Ignition chart), the flop pot carries all six antes, the stack is the dealt
 *     stack less the ante and the preflop money, and the flop tree rakes at the table's terms.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gtowApi } from "./gtowApi";
import { gtowRequests } from "./gtowRequestLog";
import { gtowSessions } from "./gtowSessions";
import { StreetState, forgetCheckpoints } from "./aiChain";
import { solveStore } from "./solveStore";
import { fastSolve, forgetPreflopPin, forgetPostflopPin, warmArrivalCpRing, forgetArrivalWarms, CP_RING_STRATEGY } from "./fastSolve";
import { fetchNode, resetAiPreflopMemory } from "./gtowAiPreflop";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { withStartStacks } from "../utils/archivedHand/archivedHand";

const HID = "cp-ring-test-1";
const U = new Array(1326).fill(0.5);
const ORDER = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

/** a CoinPoker export as the wrapper sends it (sites/cpFeed.exportHand): money in bb, `bb`/`ante` in table currency */
function raw(extra: { street: string; board: string[]; actions: any[]; committed: Record<number, number>; stacks: Record<number, number> }) {
  return {
    handId: 900001, clientHandId: HID, site: "coinpoker", bb: 0.5, sb: 0.25, ante: 0.1, bbCents: 50,
    // the table's rake terms (roomProperties), copied onto the live hand by resolveHand
    rake: { rake: 5, rakeHeadsUp: 5, rakeCap: 1.2, isPotRakePf: true },
    heroSeatId: 4, heroCards: ["Ah", "Kd"], liveSeats: [1, 2, 3, 4, 5, 6], potByStreet: {},
    positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
    startStacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
    currentNode: { street: extra.street, toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false },
    ended: false, lineSource: "log",
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

// ---- a synthetic GTO Wizard -----------------------------------------------------------------------------------
/** every preflop tree body POSTed, and every postflop tree input */
const preTrees: any[] = [];
const postTrees = new Map<string, any>();
let n = 0;
/** the preflop node polls: how many, how many at once (the prefix prefetch reads them together), and whether the
 *  address R9.9 exists yet (the speculative-look test) */
const polls = { n: 0, inFlight: 0, max: 0, r99: false };
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
/** a preflop node: the seat to act in the first orbit, offered fold / call / one raise (2.5 unopened, else 3x) */
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
const api = gtowApi as any, reqs = gtowRequests as any, pool = gtowSessions as any;
const saved = {
  ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, save: (solveStore as any).save, fetch: reqs.fetch,
  route: pool.route, routeIb: pool.routeIgnoringBlocks, tokenFor: pool.tokenFor, best: pool.bestToken, ok: pool.noteSuccess, bad: pool.noteFailure,
  block: process.env.GTOW_BLOCK, prefetch: process.env.GTOW_PREFETCH,
};
function install() {
  process.env.GTOW_BLOCK = "1";      // nothing that escapes the stubs below reaches GTO Wizard
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
      polls.n++; polls.inFlight++; polls.max = Math.max(polls.max, polls.inFlight);
      await new Promise((r) => setTimeout(r, 15));
      polls.inFlight--;
      if (line.includes("R9.9") && !polls.r99) return json({ detail: "NODE_DOES_NOT_EXIST" }, 404);
      return json(preflopNode(line));
    }
    return json({ error: `unexpected ${kind}` }, 500);
  };
  api.peekSolution = () => null;
  api.ensureCustomSolution = async (input: any) => { const solId = `post${++n}`; postTrees.set(solId, input); return { ok: true, solId, created: true, session: "mock" }; };
  api.customNode = async (solId: string, q: any) => {
    const t = postTrees.get(solId);
    if (!t) return { ok: false, status: 404, error: "unknown solution" };
    const codes: string = q.flopActions ?? q.turnActions ?? q.riverActions ?? "";
    const seats = [t.oopPos, ...(t.mid ? [t.mid.pos] : []), t.ipPos];
    const st = new StreetState(seats.length);
    for (const c of codes ? codes.split("-") : []) {
      if (c === "X") st.apply("Check"); else if (c === "C") st.apply("Call"); else if (c === "F") st.apply("Fold");
      else st.apply(st.outstanding > 0 ? "Raise" : "Bet", parseFloat(c.slice(1)));
    }
    const facing = st.outstanding > (st.inv[st.actor] ?? 0);
    const acts = facing
      ? [{ code: "F", name: "Fold" }, { code: "C", name: "Call", betsize: st.outstanding }]
      : [{ code: "X", name: "Check" }, { code: `R${Math.round(t.pot * 0.33 * 10) / 10}`, name: "Bet", betsize: Math.round(t.pot * 0.33 * 10) / 10 }];
    return { ok: true, cached: false, solveSecs: 0, src: "fetched", data: {
      game: { players: seats.map((p, i) => ({ position: p, is_hero: i === st.actor })) },
      action_solutions: acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: (a as any).betsize ?? "", position: seats[st.actor] }, total_frequency: 1 / acts.length, total_ev: 0, strategy: U, evs: U })),
    } };
  };
  (solveStore as any).save = () => null;
}
function uninstall() {
  api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; api.peekSolution = saved.peek; (solveStore as any).save = saved.save;
  reqs.fetch = saved.fetch;
  Object.assign(pool, { route: saved.route, routeIgnoringBlocks: saved.routeIb, tokenFor: saved.tokenFor, bestToken: saved.best, noteSuccess: saved.ok, noteFailure: saved.bad });
  for (const [k, v] of [["GTOW_BLOCK", saved.block], ["GTOW_PREFETCH", saved.prefetch]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const forget = () => { forgetPreflopPin(HID); forgetPostflopPin(HID); forgetCheckpoints(HID); };

beforeAll(() => { install(); forget(); });
afterAll(() => { forget(); uninstall(); });

describe("CoinPoker ring with antes — what GTO Wizard is sent", () => {
  test("the live hand reads the table's rake terms (cap in bb) and the ante per player", () => {
    const h = normalizeHand(raw({ street: "preflop", board: [], actions: PRE, committed: { 3: 2.5, 5: 0.5, 6: 1 }, stacks: {} })).hand;
    expect(h.anteBb).toBe(0.2);
    expect(h.siteRake).toEqual({ pct: 5, pctHeadsUp: 5, capBb: 2.4, preflopPots: true });
  });

  test("preflop: one six-handed tree, stacks as dealt, ante 0.2 per player, the table's rake with preflop pots raked", async () => {
    preTrees.length = 0;
    const hand = withStartStacks(normalizeHand(raw({ street: "preflop", board: [], actions: PRE, committed: { 3: 2.5, 5: 0.5, 6: 1 }, stacks: {} })).hand);
    const r: any = await fastSolve(hand, "BTN", { strategyId: CP_RING_STRATEGY, origin: "test" });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("gtow-ai-preflop");
    expect(r.line).toBe("F-F-R2.5");
    expect(r.warning).toContain("CoinPoker ring: solved at ante 0.2bb · 5% capped at 2.4bb · preflop pots raked");
    expect(preTrees.length).toBe(1);
    const body = preTrees[0];
    expect(body.ante).toBe(0.2);
    expect(body.ante_distribution_method).toBe("PER_PLAYER");
    expect(body.rake).toEqual({ pct_of_pot: 5, cap_in_chips: 2.4, preflop_rake_type: "full" });
    expect(body.players.map((p: any) => p.position)).toEqual(ORDER);
    expect(body.players.map((p: any) => p.stack)).toEqual([100, 100, 100, 100, 100, 100]);
    expect(body.players.find((p: any) => p.position === "SB").blind).toBe(0.5);
  });

  test("postflop with NO preflop Solve first (on demand): AI-tree ranges, all six antes in the pot, the table's rake", async () => {
    forget();
    preTrees.length = 0; postTrees.clear();
    const actions = [...PRE,
      { seatId: 4, hero: true, type: "call", street: "preflop", amount: 2.5 },
      { seatId: 5, hero: false, type: "fold", street: "preflop" },
      { seatId: 6, hero: false, type: "fold", street: "preflop" },
      { seatId: 3, hero: false, type: "check", street: "flop" },
    ];
    const hand = withStartStacks(normalizeHand(raw({ street: "flop", board: ["Kc", "7d", "2s"], actions, committed: {}, stacks: {} })).hand);
    const r: any = await fastSolve(hand, "BTN", { strategyId: CP_RING_STRATEGY, origin: "test" });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("ai-chain");
    expect(r.setId).toBe("cp-ring-ante");
    // the flop ranges came from an AI preflop tree built from the table — the same ante and rake as a preflop Solve
    expect(String(r.rangeSource)).toMatch(/^gtow-ai · 6-handed/);
    // (the tree the preflop test solved is reused when the shape and menus match — the process keeps solutions per
    // shape — so count nothing; whatever preflop tree was sent carried the ante and the table's rake)
    expect(preTrees.every((b) => b.ante === 0.2 && b.rake?.preflop_rake_type === "full" && b.rake?.cap_in_chips === 2.4)).toBe(true);
    // the flop tree: CO 2.5 + BTN 2.5 + the blinds 1.5 + six antes 1.2 = 7.7; stack 100 - 0.2 ante - 2.5 = 97.3
    const flop = [...postTrees.values()][0];
    expect(flop.pot).toBeCloseTo(7.7, 5);
    expect(flop.stack).toBeCloseTo(97.3, 5);
    expect(flop.rake).toEqual({ pct_of_pot: 5, cap_in_chips: 2.4, preflop_rake_type: null });
    expect(r.warning).toContain("CoinPoker ring: solved at ante 0.2bb");
  });

  test("a hand whose table sent no rake terms is solved at 5% with no cap — and says so", async () => {
    forget();
    preTrees.length = 0;
    const r0 = raw({ street: "preflop", board: [], actions: PRE, committed: { 3: 2.5, 5: 0.5, 6: 1 }, stacks: {} }) as any;
    delete r0.rake;
    const hand = withStartStacks(normalizeHand(r0).hand);
    expect(hand.siteRake).toBeUndefined();
    const r: any = await fastSolve(hand, "BTN", { strategyId: CP_RING_STRATEGY, origin: "test" });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("RAKE ASSUMED");
    expect(preTrees[0].rake).toEqual({ pct_of_pot: 5, cap_in_chips: 1000, preflop_rake_type: "full" });
  });
});

describe("nothing changes for Ignition", () => {
  test("a hand with no ante and no site rake builds the tree it always did (no ante, Ignition's rake, the old key)", async () => {
    const { debugTree, treeKeyOf, menus, shapeOf } = await import("./gtowAiPreflop");
    const ign = normalizeHand({ ...raw({ street: "preflop", board: [], actions: PRE, committed: { 3: 2.5, 5: 0.5, 6: 1 }, stacks: { 1: 100, 2: 100, 3: 97.5, 4: 100, 5: 99.5, 6: 99 } }),
      site: undefined, ante: undefined, bb: undefined, rake: undefined, bbCents: 200, startStacks: undefined }).hand;
    expect(ign.anteBb).toBeUndefined();
    expect(ign.siteRake).toBeUndefined();
    const t = debugTree(ign, "BTN");
    if ("error" in t) throw new Error(t.error);
    expect(t.body.ante).toBeNull();
    expect(t.body.rake).toEqual({ pct_of_pot: 5, cap_in_chips: 2, preflop_rake_type: "no_flop_no_drop" });
    const shape = shapeOf(ign, "BTN");
    if ("error" in shape) throw new Error(shape.error);
    expect("anteBb" in shape || "siteRake" in shape).toBe(false);
    expect(JSON.parse(treeKeyOf(shape, menus([2.5], shape.n))).length).toBe(9);   // the pre-2026-09-30 key, element for element
  });
});

describe("the catalogue", () => {
  test("the ring strategy is selectable, on demand, and offered at the CoinPoker ring formats", async () => {
    const { evaluate, isOnDemandStrategy, CP_RING_ANTE_STRATEGY_ID } = await import("./strategies");
    const v = evaluate().find((s) => s.id === CP_RING_ANTE_STRATEGY_ID)!;
    expect(v.status).toBe("ok");
    expect(v.onDemand).toBe(true);
    expect(v.formats).toEqual(["cp-ring-NL10-6", "cp-ring-NL25-6", "cp-ring-NL50-6", "cp-ring-NL100-6", "cp-ring-NL200-6", "cp-ring-NL500-6"]);
    expect(v.preflopLayer.source).toBe("gtow-ai-preflop");
    expect(v.advisories.some((a) => a.startsWith("ON DEMAND"))).toBe(true);
    expect(isOnDemandStrategy(CP_RING_ANTE_STRATEGY_ID)).toBe(true);
    expect(isOnDemandStrategy("cp200-hu-equilibrium")).toBe(false);
    expect(isOnDemandStrategy("ign200-ring-6max-equilibrium")).toBe(false);
  });
});

describe("the arrival warm-up and the parallel prefix walk (2026-10-01)", () => {
  const savedPrefetch = process.env.GTOW_PREFETCH;
  beforeAll(() => { process.env.GTOW_PREFETCH = "1"; });
  afterAll(() => { process.env.GTOW_PREFETCH = savedPrefetch ?? "0"; });
  const CLOSED = [...PRE,
    { seatId: 4, hero: true, type: "call", street: "preflop", amount: 2.5 },
    { seatId: 5, hero: false, type: "fold", street: "preflop" },
    { seatId: 6, hero: false, type: "fold", street: "preflop" },
  ];
  /** the flop as the wrapper reports it: with no flop action yet the CO (out of position) is on the clock, not hero;
   *  once the CO has acted, hero is */
  const flopHand = (extra: any[] = []) => {
    const r: any = raw({ street: "flop", board: ["Kc", "7d", "2s"], actions: [...CLOSED, ...extra], committed: {}, stacks: {} });
    if (!extra.some((a) => a.street === "flop" && !a.hero)) r.currentNode = { ...r.currentNode, toActSeatId: 3, toActIsHero: false };
    return withStartStacks(normalizeHand(r).hand);
  };
  const CHECK = { seatId: 3, hero: false, type: "check", street: "flop" };
  const cold = () => { forget(); forgetArrivalWarms(); resetAiPreflopMemory(); preTrees.length = 0; postTrees.clear(); polls.n = 0; polls.max = 0; };

  test("the flop lands: the preflop tree is built and walked, NO flop tree is opened, and hero's Solve finds the ranges ready", async () => {
    cold();
    const w = warmArrivalCpRing(flopHand(), "BTN", CP_RING_STRATEGY);
    expect(w).not.toBeNull();
    expect(warmArrivalCpRing(flopHand(), "BTN", CP_RING_STRATEGY)).toBeNull();   // the next tick, mid-walk: nothing started
    await w;
    expect(preTrees.length).toBe(1);
    expect(postTrees.size).toBe(0);
    // F-F-R2.5-C-F-F: the root and one node per token before the last, six reads, asked for TOGETHER
    expect(polls.n).toBe(6);
    expect(polls.max).toBeGreaterThan(1);
    const afterWarm = polls.n;
    expect(warmArrivalCpRing(flopHand(), "BTN", CP_RING_STRATEGY)).toBeNull();   // once per hand
    // hero's Solve, villain having checked: the ranges come from the memo (no preflop node re-read), one flop tree
    const r: any = await fastSolve(flopHand([CHECK]), "BTN", { strategyId: CP_RING_STRATEGY, origin: "test" });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("ai-chain");
    expect(String(r.rangeSource)).toMatch(/^gtow-ai/);
    expect(polls.n).toBe(afterWarm);
    expect(preTrees.length).toBe(1);
    expect(postTrees.size).toBe(1);
  });

  test("a Solve that arrives while the warm-up is still walking joins it: one preflop tree, the node reads shared", async () => {
    cold();
    const w = warmArrivalCpRing(flopHand(), "BTN", CP_RING_STRATEGY);
    const r: any = await fastSolve(flopHand([CHECK]), "BTN", { strategyId: CP_RING_STRATEGY, origin: "test" });
    await w;
    expect(r.ok).toBe(true);
    expect(preTrees.length).toBe(1);
    expect(polls.n).toBe(6);
    expect(postTrees.size).toBe(1);
  });

  test("nothing is warmed for a hand hero folded, a preflop hand, or another strategy", () => {
    forgetArrivalWarms();
    expect(warmArrivalCpRing(flopHand([CHECK, { seatId: 4, hero: true, type: "fold", street: "flop" }]), "BTN", CP_RING_STRATEGY)).toBeNull();
    const pre = withStartStacks(normalizeHand(raw({ street: "preflop", board: [], actions: PRE, committed: { 3: 2.5, 5: 0.5, 6: 1 }, stacks: {} })).hand);
    expect(warmArrivalCpRing(pre, "BTN", CP_RING_STRATEGY)).toBeNull();
    expect(warmArrivalCpRing(flopHand(), "BTN", "6max-ign200-equilibrium")).toBeNull();
  });

  test("a speculative look at a node the cloud does not have is ONE request and poisons nothing", async () => {
    resetAiPreflopMemory(); polls.n = 0; polls.r99 = false;
    const miss = await fetchNode("pre-spec", "R9.9", { once: true });
    expect("error" in miss).toBe(true);
    expect(polls.n).toBe(1);
    polls.r99 = true;   // the cloud has it now: the real read finds it at once
    const hit = await fetchNode("pre-spec", "R9.9");
    expect("error" in hit).toBe(false);
    expect(polls.n).toBe(2);
  });

  test("two reads of one node in flight share ONE request", async () => {
    resetAiPreflopMemory(); polls.n = 0;
    const [a, b] = await Promise.all([fetchNode("pre-join", "F-F"), fetchNode("pre-join", "F-F")]);
    expect("error" in a).toBe(false);
    expect("error" in b).toBe(false);
    expect(polls.n).toBe(1);
  });
});
