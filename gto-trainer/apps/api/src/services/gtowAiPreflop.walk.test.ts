import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * The line walk reads each run together (gtowAiPreflop.repairLine / prefetchRun, 2026-10-01): a line the tree holds
 * under other sizes is walked in rounds — every node up to the next raise asked for at once — instead of one read at
 * a time. What must hold: the SAME answer as the one-at-a-time walk, no node asked for twice, and no request the
 * one-at-a-time walk would not have sent, except the look past a caller the tree turns out not to hold.
 * Hermetic: a fake fetch that answers after a delay and counts what is in flight, a stubbed session pool.
 */
let P: typeof import("./gtowAiPreflop");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
const savedPrefetch = process.env.GTOW_PREFETCH;
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
});
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of savedPool) { if (own) s[m] = fn; else delete s[m]; }
  P.resetAiPreflopMemory();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedPrefetch === undefined) delete process.env.GTOW_PREFETCH; else process.env.GTOW_PREFETCH = savedPrefetch;
  P.resetAiPreflopMemory();
});

interface FakeLog { polls: string[]; maxInFlight: number }
/** GTO Wizard with one tree: a node per line in `nodes`, NODE_DOES_NOT_EXIST for any other; every read takes 25 ms. */
function fakeGtow(nodes: Record<string, object>): FakeLog {
  const log: FakeLog = { polls: [], maxInFlight: 0 };
  let seq = 0, inFlight = 0;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/custom-trees/")) return Response.json({ id: `tree-${++seq}` }, { status: 201 });
    if (u.pathname.endsWith("/custom-solutions/")) return Response.json({ id: `sol-${++seq}` }, { status: 201 });
    const line = u.searchParams.get("preflop_actions") ?? "";
    log.polls.push(line);
    log.maxInFlight = Math.max(log.maxInFlight, ++inFlight);
    await Bun.sleep(25);
    inFlight--;
    const v = nodes[line];
    if (v === undefined) return new Response(JSON.stringify({ code: "NODE_DOES_NOT_EXIST", detail: "NODE_DOES_NOT_EXIST" }), { status: 400 });
    return Response.json(v);
  }) as typeof fetch;
  return log;
}

const arr = (x: number) => new Array(1326).fill(x);
const pnode = (actor: string, acts: [string, string, number][]) => ({
  game: { players: [{ position: actor, is_hero: true }] },
  action_solutions: acts.map(([code, type, f]) => ({ action: { code, type, betsize: code.startsWith("R") ? code.slice(1) : "" }, strategy: arr(f), total_frequency: f })),
});

/** Six-handed, hero in the big blind; `acts` are the actions after the blinds. */
const sixHanded = (id: string, acts: object[]): ParsedHand => ({
  handId: 1, clientHandId: id, bbCents: 200, heroSeatId: 6, heroCards: ["Kh", "Qd"], board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    ...acts,
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" }, stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
  currentNode: { street: "preflop", toActSeatId: 6, toActIsHero: true, pot: 4, toCall: 1.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand);

/** One answer with the prefetch on or off: what was decided, and every node read (the pin's background reads included). */
async function solve(hand: ParsedHand, nodes: Record<string, object>, prefetch: boolean) {
  if (prefetch) delete process.env.GTOW_PREFETCH; else process.env.GTOW_PREFETCH = "0";
  P.resetAiPreflopMemory();
  const log = fakeGtow(nodes);
  const r = await P.solvePreflopGtowAi(hand, null, "test");
  const inWalk = log.maxInFlight;
  await Bun.sleep(120);                                    // the pin's background reads of the prefix nodes
  if (!r.ok) throw new Error(r.reason);
  return { actions: r.actions, usedLine: r.usedLine, pos: r.pos, snapped: r.note.split("snapped to the tree's own: ")[1] ?? "",
    fitted: /LINE FITTED/.test(r.note), polls: log.polls.slice().sort(), inWalk };
}

describe("AI preflop: the line walk reads each run together", () => {
  // UTG folds, HJ opens 2.6, CO folds, BTN 3-bets to 11, SB calls — the tree holds the open at 2.5 and the 3-bet at 10.6
  const snapHand = (id: string) => sixHanded(id, [
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "raise", amount: 2.6, street: "preflop" },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "raise", amount: 11, street: "preflop" },
    { seatId: 5, hero: false, type: "call", amount: 10.5, street: "preflop" },
  ]);
  const SNAP_NODES: Record<string, object> = {
    "": pnode("UTG", [["F", "FOLD", 0.8], ["R2.5", "RAISE", 0.2]]),
    F: pnode("HJ", [["F", "FOLD", 0.7], ["R2.5", "RAISE", 0.3]]),
    "F-R2.5": pnode("CO", [["F", "FOLD", 0.9], ["C", "CALL", 0.05], ["R8", "RAISE", 0.05]]),
    "F-R2.5-F": pnode("BTN", [["F", "FOLD", 0.8], ["C", "CALL", 0.1], ["R10.6", "RAISE", 0.1]]),
    "F-R2.5-F-R10.6": pnode("SB", [["F", "FOLD", 0.9], ["C", "CALL", 0.1]]),
    "F-R2.5-F-R10.6-C": pnode("BB", [["F", "FOLD", 0.6], ["C", "CALL", 0.4]]),
  };

  it("two snapped raises: the same answer and the same requests as the one-at-a-time walk, read in rounds", async () => {
    const one = await solve(snapHand("walk-snap-seq"), SNAP_NODES, false);
    const run = await solve(snapHand("walk-snap-run"), SNAP_NODES, true);
    expect(one.usedLine).toBe("F-R2.5-F-R10.6-C");
    expect(one.snapped).toContain("R2.6→R2.5");
    expect(one.snapped).toContain("R11→R10.6");
    expect({ ...run, polls: null, inWalk: null }).toEqual({ ...one, polls: null, inWalk: null });
    // the refused line, then the six nodes of the walk — hero's among them — each asked for exactly once
    expect(one.polls).toEqual(["", "F", "F-R2.5", "F-R2.5-F", "F-R2.5-F-R10.6", "F-R2.5-F-R10.6-C", "F-R2.6-F-R11-C"]);
    expect(run.polls).toEqual(one.polls);
    // in flight together: the direct read and the walk beside it (2026-10-02) — one-at-a-time that is the two of them
    expect(one.inWalk).toBe(2);
    expect(run.inWalk).toBeGreaterThanOrEqual(2);
  });

  // UTG limps, HJ folds, CO limps, BTN raises to 5, SB folds — the tree holds one limper, so UTG's limp is folded out
  const limpHand = (id: string) => sixHanded(id, [
    { seatId: 1, hero: false, type: "call", amount: 1, street: "preflop" },
    { seatId: 2, hero: false, type: "fold", street: "preflop" },
    { seatId: 3, hero: false, type: "call", amount: 1, street: "preflop" },
    { seatId: 4, hero: false, type: "raise", amount: 5, street: "preflop" },
    { seatId: 5, hero: false, type: "fold", street: "preflop" },
  ]);
  const LIMP_NODES: Record<string, object> = {
    "": pnode("UTG", [["F", "FOLD", 0.7], ["C", "CALL", 0.1], ["R2.5", "RAISE", 0.2]]),
    C: pnode("HJ", [["F", "FOLD", 0.8], ["R4", "RAISE", 0.2]]),
    "C-F": pnode("CO", [["F", "FOLD", 0.8], ["R4", "RAISE", 0.2]]),
    F: pnode("HJ", [["F", "FOLD", 0.7], ["R2.5", "RAISE", 0.3]]),
    "F-F": pnode("CO", [["F", "FOLD", 0.6], ["C", "CALL", 0.1], ["R2.5", "RAISE", 0.3]]),
    "F-F-C": pnode("BTN", [["F", "FOLD", 0.5], ["C", "CALL", 0.2], ["R5", "RAISE", 0.3]]),
    "F-F-C-R5": pnode("SB", [["F", "FOLD", 0.9], ["C", "CALL", 0.1]]),
    "F-F-C-R5-F": pnode("BB", [["F", "FOLD", 0.5], ["C", "CALL", 0.5]]),
  };

  it("a second limper the tree cannot hold: the same fitted answer, one look past the limper it refuses and nothing else", async () => {
    const one = await solve(limpHand("walk-limp-seq"), LIMP_NODES, false);
    const run = await solve(limpHand("walk-limp-run"), LIMP_NODES, true);
    expect(one.usedLine).toBe("F-F-C-R5-F");
    expect(one.fitted).toBe(true);
    expect({ ...run, polls: null, inWalk: null }).toEqual({ ...one, polls: null, inWalk: null });
    // "C-F-C" is the run's look at the node behind the second limp, asked for before the walk learned it is not offered
    const extra = run.polls.slice();
    for (const p of one.polls) extra.splice(extra.indexOf(p), 1);
    expect(extra).toEqual(["C-F-C"]);
    expect(run.polls.length).toBe(one.polls.length + 1);
  });
});

/**
 * THE WALK IS THE JUDGE, NOT THE REFUSAL (2026-10-02, hand 4922086187). A three-handed GTO Wizard tree does not answer
 * NODE_DOES_NOT_EXIST for a size it does not hold: it answers 204, "not solved yet", for as long as it is asked. The
 * walk used to wait for the refusal — 30 s of polling, then the last resort. And when a node really never comes, the
 * reason says what the polls said.
 */
describe("AI preflop: a node the tree does not hold, answered 204 instead of refused", () => {
  /** like fakeGtow, but a line the tree does not hold is 204 for ever */
  function fakeGtow204(nodes: Record<string, object>): FakeLog {
    const log: FakeLog = { polls: [], maxInFlight: 0 };
    let seq = 0;
    globalThis.fetch = (async (input: any) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/custom-trees/")) return Response.json({ id: `tree-${++seq}` }, { status: 201 });
      if (u.pathname.endsWith("/custom-solutions/")) return Response.json({ id: `sol-${++seq}` }, { status: 201 });
      const line = u.searchParams.get("preflop_actions") ?? "";
      log.polls.push(line);
      await Bun.sleep(25);
      const v = nodes[line];
      return v === undefined ? new Response(null, { status: 204 }) : Response.json(v);
    }) as typeof fetch;
    return log;
  }
  // three-handed: hero on the BTN opens 2.6, the SB 3-bets to 13, the BB folds — the tree holds the open at 2.5
  const threeHanded = (id: string): ParsedHand => ({
    handId: 1, clientHandId: id, bbCents: 5, heroSeatId: 2, heroCards: ["Qd", "7d"], board: [], street: "preflop",
    actions: [
      { seatId: 5, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
      { seatId: 1, hero: false, type: "post-bb", amount: 1, street: "preflop" },
      { seatId: 2, hero: true, type: "raise", amount: 2.6, street: "preflop" },
      { seatId: 5, hero: false, type: "raise", amount: 13, street: "preflop" },
      { seatId: 1, hero: false, type: "fold", street: "preflop" },
    ],
    liveSeats: [1, 2, 5], committed: {}, potByStreet: {}, positions: { 1: "BB", 2: "BTN", 5: "SB" }, stacks: { 1: 89, 2: 114, 5: 86 },
    currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 16.6, toCall: 10.4, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand);
  const NODES: Record<string, object> = {
    "": pnode("BTN", [["F", "FOLD", 0.5], ["R2.5", "RAISE", 0.5]]),
    "R2.5": pnode("SB", [["F", "FOLD", 0.8], ["C", "CALL", 0.1], ["R13", "RAISE", 0.1]]),
    "R2.5-R13": pnode("BB", [["F", "FOLD", 0.9], ["C", "CALL", 0.1]]),
    "R2.5-R13-F": pnode("BTN", [["F", "FOLD", 0.7], ["C", "CALL", 0.3]]),
  };

  it("the walk finds the tree's own size and the answer comes at once — the address is not polled to the timeout", async () => {
    P.resetAiPreflopMemory();
    const log = fakeGtow204(NODES);
    const t0 = Date.now();
    const r = await P.solvePreflopGtowAi(threeHanded("walk-204"), null, "test");
    const ms = Date.now() - t0;
    if (!r.ok) throw new Error(r.reason);
    expect(r.usedLine).toBe("R2.5-R13-F");
    expect(r.note).toContain("R2.6→R2.5");
    expect(r.actions.map((a) => a.action)).toEqual(["Fold", "Call"]);
    expect(ms).toBeLessThan(1500);                                                // was NODE_TIMEOUT_MS, then the last resort
    await Bun.sleep(1400);                                                        // one poll interval: the dropped read ends
    expect(log.polls.filter((l) => l === "R2.6-R13-F").length).toBeLessThanOrEqual(2);
  });

  it("a node that never comes: the reason counts the polls that said 'not solved yet', not one stale failure", async () => {
    const saved = process.env.GTOW_NODE_TIMEOUT_MS;
    process.env.GTOW_NODE_TIMEOUT_MS = "300";
    try {
      P.resetAiPreflopMemory();
      const { "R2.5-R13-F": _hero, ...rest } = NODES;                              // the tree names the line, hero's node never solves
      fakeGtow204(rest);
      const r = await P.solvePreflopGtowAi(threeHanded("walk-never"), null, "test");
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain("did not return the node in time");
      expect(r.reason).toContain('answered "not solved yet"');
      expect(r.reason).not.toContain("poll failed");
    } finally { if (saved === undefined) delete process.env.GTOW_NODE_TIMEOUT_MS; else process.env.GTOW_NODE_TIMEOUT_MS = saved; }
  });
});
