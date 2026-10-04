import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { COMBOS } from "../utils/comboIndex/comboIndex";

/**
 * THE CALLER'S READ ON THE EXACT TREE (lastRaiseReads.stayRange, 2026-10-04 — what the reduced tree reads a villain
 * caller with instead of the forced-bet tree). His range is WALKED on the line as the tree holds it — as it stands, else
 * fitted keeping his own actions — through his own node, less the hands that fold there ("did not fold"). Hermetic: a
 * fake GTO Wizard over fetch, a stubbed session pool, no solve cache.
 */
let P: typeof import("./gtowAiPreflop");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
const savedTimeout = process.env.GTOW_NODE_TIMEOUT_MS;
beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  ({ gtowSessions } = await import("./gtowSessions"));
  const s = gtowSessions as any;
  for (const m of POOL_METHODS) savedPool.push({ m, own: Object.prototype.hasOwnProperty.call(s, m), fn: s[m] });
  s.route = () => ["primary"];
  s.routeIgnoringBlocks = s.route;
  s.liveFirst = (ids: string[]) => ids;
  s.tokenFor = async () => "t";
  s.bestToken = async () => ({ id: "primary", token: "t" });
  s.noteSuccess = () => {};
  s.noteFailure = () => null;
  s.forceRefresh = async () => true;
  process.env.GTOW_NODE_TIMEOUT_MS = "300";                  // a node the fake does not hold answers "not solved" — give up fast
});
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of savedPool) { if (own) s[m] = fn; else delete s[m]; }
  if (savedTimeout == null) delete process.env.GTOW_NODE_TIMEOUT_MS; else process.env.GTOW_NODE_TIMEOUT_MS = savedTimeout;
  P.resetAiPreflopMemory();
});
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; P.resetAiPreflopMemory(); });

const at = (cls: string) => COMBOS.findIndex((c) => c.cls === cls);
/** per-combo strategy: AA, KK the named share, everything else `rest` */
const strat = (rest: number, named: Record<string, number> = {}) => COMBOS.map((c) => named[c.cls] ?? rest);
const pnode = (actor: string, acts: [string, string, number[]][]) => ({
  game: { players: [{ position: actor, is_hero: true }] },
  action_solutions: acts.map(([code, type, s]) => ({ action: { code, type, betsize: code.startsWith("R") ? code.slice(1) : "" }, strategy: s, total_frequency: 0 })),
});
function fakeGtow(nodes: Record<string, object>): { polls: string[] } {
  const log = { polls: [] as string[] };
  let seq = 0;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/custom-trees/")) return Response.json({ id: `tree-${++seq}` }, { status: 201 });
    if (u.pathname.endsWith("/custom-solutions/")) return Response.json({ id: `sol-${++seq}` }, { status: 201 });
    const line = u.searchParams.get("preflop_actions") ?? "";
    log.polls.push(line);
    const v = nodes[line];
    return v ? Response.json(v) : new Response(JSON.stringify({ code: "NODE_DOES_NOT_EXIST", detail: "NODE_DOES_NOT_EXIST" }), { status: 422 });
  }) as typeof fetch;
  return log;
}

// three-handed: hero (BTN) opens 2.5, the SB calls, the BB calls — the BB's call is the one read
const hand: ParsedHand = {
  handId: 1, clientHandId: "stay-range-1", bbCents: 200, heroSeatId: 5, heroCards: ["Kh", "Qd"], board: ["2c", "7d", "9h"], street: "flop",
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 5, hero: true, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 1, hero: false, type: "call", amount: 2, street: "preflop" },
    { seatId: 6, hero: false, type: "call", amount: 1.5, street: "preflop" },
  ],
  liveSeats: [1, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "SB", 5: "BTN", 6: "BB" }, stacks: { 1: 100, 5: 100, 6: 100 },
  currentNode: { street: "flop", toActSeatId: 1, toActIsHero: false, pot: 7.5, toCall: 0, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand;
const NODES = {
  "": pnode("BTN", [["F", "FOLD", strat(0.5)], ["R2.5", "RAISE", strat(0.5)]]),
  "R2.5": pnode("SB", [["F", "FOLD", strat(0.9)], ["C", "CALL", strat(0.1)]]),
  // the BB behind the SB's call: folds 72o, keeps AA, re-raises KK half the time (a raise is "did not fold")
  "R2.5-C": pnode("BB", [["F", "FOLD", strat(0.3, { "72o": 1, AA: 0, KK: 0 })], ["C", "CALL", strat(0.7, { "72o": 0, AA: 1, KK: 0.5 })], ["R11", "RAISE", strat(0, { KK: 0.5 })]]),
  // the BB with the SB folded out: tighter for the walk to tell apart
  "R2.5-F": pnode("BB", [["F", "FOLD", strat(0.6, { "72o": 1, AA: 0 })], ["C", "CALL", strat(0.4, { "72o": 0, AA: 1 })]]),
};
const TOKENS = ["R2.5", "C", "C"];

async function readsFor(opts: { fitOnly?: boolean } = {}) {
  const dt = P.debugTree(hand, "BTN");
  if ("error" in dt) throw new Error(dt.error);
  const sol = await P.debugSolveBody("stay-range-test", dt.body, dt.shape.n);
  if ("error" in sol) throw new Error(sol.error);
  return P.lastRaiseReads(sol.solId, dt.shape, TOKENS, opts);
}

describe("lastRaiseReads.stayRange", () => {
  it("the tree holds his line: his range through his own node, less the hands that fold there (a re-raise stays)", async () => {
    const log = fakeGtow(NODES);
    const r = await (await readsFor()).stayRange("BB");
    if (!r) throw new Error("no read");
    expect(r.folded).toEqual([]);
    expect(r.range[at("72o")]).toBe(0);
    expect(r.range[at("AA")]).toBe(1);
    expect(r.range[at("KK")]).toBe(1);                         // half calls, half re-raises: none of it folds
    expect(r.range[at("T9s")]).toBeCloseTo(0.7, 6);
    expect(log.polls).not.toContain("R2.5-F");
  });

  it("the tree cannot: the line fitted for him (the SB folded out), his range walked on it", async () => {
    fakeGtow(NODES);
    const r = await (await readsFor({ fitOnly: true })).stayRange("BB");
    if (!r) throw new Error("no read");
    expect(r.folded).toEqual(["SB"]);                          // the table's own position name
    expect(r.range[at("72o")]).toBe(0);
    expect(r.range[at("AA")]).toBe(1);
    expect(r.range[at("T9s")]).toBeCloseTo(0.4, 6);
  });

  it("no read: a seat that did not call the last raise, a seat not at the table, a tree without his node", async () => {
    fakeGtow(NODES);
    const reads = await readsFor();
    expect(await reads.stayRange("BTN")).toBeNull();           // the raiser
    expect(await reads.stayRange("CO")).toBeNull();
    fakeGtow({ "": NODES[""], "R2.5": NODES["R2.5"] });
    P.resetAiPreflopMemory();
    expect(await (await readsFor()).stayRange("BB")).toBeNull();
  });
});
