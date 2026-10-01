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
    expect(one.inWalk).toBe(1);
    expect(run.inWalk).toBe(2);
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
