import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * AN ALL-IN SEAT HAS NO FURTHER ACTION (2026-10-14, hand 4924546540). 4-handed, hero BB with AcAh: CO folds, the BTN
 * shoves his whole 2.2bb (typed "raise", 0 behind), SB 3.4, hero 7.8, SB 18.6. The hand's list also carried a FOLD by
 * the all-in BTN before the SB's 18.6, and lineOf tokenized it: 'F-R2.2-R3.4-R7.8-F-R18.6'. GTO Wizard skips an all-in
 * seat (the SB is on the clock at 'F-R2.2-R3.4-R7.8'), so that node does not exist, it is answered 204 "not solved yet"
 * for ever, and the decision ran to the 30 s cap. Two guards: lineOf drops the all-in seat's action (and names it), and
 * the walk refuses a token whose seat is not the tree's actor. Hermetic: a fake GTO Wizard, a stubbed session pool.
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
});
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of savedPool) { if (own) s[m] = fn; else delete s[m]; }
  P.resetAiPreflopMemory();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedTimeout === undefined) delete process.env.GTOW_NODE_TIMEOUT_MS; else process.env.GTOW_NODE_TIMEOUT_MS = savedTimeout;
  P.resetAiPreflopMemory();
});

/** GTO Wizard with one tree: a node per line in `nodes`, 204 "not solved yet" for ever on any other (what a node the
 *  tree does not hold is answered on a multiway tree); every read takes 25 ms. */
function fakeGtow204(nodes: Record<string, object>): { polls: string[] } {
  const log = { polls: [] as string[] };
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

const arr = (x: number) => new Array(1326).fill(x);
const pnode = (actor: string, acts: [string, string, number][]) => ({
  game: { players: [{ position: actor, is_hero: true }] },
  action_solutions: acts.map(([code, type, f]) => ({ action: { code, type, betsize: code.startsWith("R") ? code.slice(1) : "" }, strategy: arr(f), total_frequency: f })),
});

const STACKS = { 3: 55.6, 4: 2.2, 5: 88.4, 6: 100 };
/** The hand: seats 3 CO, 4 BTN (2.2bb), 5 SB, 6 BB hero; `acts` are the actions after the blinds. */
const fourHanded = (id: string, acts: object[]): ParsedHand => ({
  handId: 1, clientHandId: id, bbCents: 5, heroSeatId: 6, heroCards: ["Ac", "Ah"], board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: false, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    ...acts,
  ],
  liveSeats: [3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: { 3: "CO", 4: "BTN", 5: "SB", 6: "BB" }, stacks: { ...STACKS }, startStacks: { ...STACKS },
  currentNode: { street: "preflop", toActSeatId: 6, toActIsHero: true, pot: 28.6, toCall: 10.8, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand);

const SHOVE_TO_HERO = [
  { seatId: 4, hero: false, type: "raise", amount: 2.2, street: "preflop" },
  { seatId: 5, hero: false, type: "raise", amount: 3.4, street: "preflop" },
  { seatId: 6, hero: true, type: "raise", amount: 7.8, street: "preflop" },
];
const SB_REJAM = { seatId: 5, hero: false, type: "raise", amount: 18.6, street: "preflop" };
const STRAY_FOLD = { seatId: 4, hero: false, type: "fold", street: "preflop" };
/** the live hand's list: no CO fold, and the all-in BTN's fold before the SB's 18.6 */
const strayHand = (id: string) => fourHanded(id, [...SHOVE_TO_HERO, STRAY_FOLD, SB_REJAM]);
/** the clean list: the CO's fold shown, nothing after the BTN's shove */
const cleanHand = (id: string) => fourHanded(id, [{ seatId: 3, hero: false, type: "fold", street: "preflop" }, ...SHOVE_TO_HERO, SB_REJAM]);

const HERO_LINE = "F-R2.2-R3.4-R7.8-R18.6";
/** the real tree's nodes on this line (shape of aa_nodes.json): the all-in BTN is never on the clock again */
const NODES: Record<string, object> = {
  "": pnode("CO", [["F", "FOLD", 0.8], ["C", "CALL", 0.05], ["R2.2", "RAISE", 0.1], ["R55.5", "RAISE", 0.05]]),
  F: pnode("BTN", [["F", "FOLD", 0.6], ["C", "CALL", 0.1], ["R2.2", "RAISE", 0.3]]),
  "F-R2.2": pnode("SB", [["F", "FOLD", 0.5], ["C", "CALL", 0.2], ["R3.4", "RAISE", 0.2], ["R88.5", "RAISE", 0.1]]),
  "F-R2.2-R3.4": pnode("BB", [["F", "FOLD", 0.3], ["C", "CALL", 0.3], ["R7.8", "RAISE", 0.3], ["R100", "RAISE", 0.1]]),
  "F-R2.2-R3.4-R7.8": pnode("SB", [["F", "FOLD", 0.5], ["C", "CALL", 0.2], ["R17.2", "RAISE", 0.1], ["R18.6", "RAISE", 0.1], ["R88.5", "RAISE", 0.1]]),
  [HERO_LINE]: pnode("BB", [["F", "FOLD", 0], ["C", "CALL", 0.3], ["R88.5", "RAISE", 0.7]]),
};

const shapeFor = (hand: ParsedHand) => {
  const s = P.shapeOf(hand, null);
  if ("error" in s) throw new Error(s.error);
  return s;
};

describe("lineOf: an action by a seat already all in is dropped", () => {
  it("the stray fold of the all-in BTN: the tree's line, the fold named, a seat per token", () => {
    const hand = strayHand("allin-skip-unit");
    const shape = shapeFor(hand);
    expect(shape.positions).toEqual(["CO", "BTN", "SB", "BB"]);
    expect(shape.stacks).toEqual({ CO: 55.5, BTN: 2.2, SB: 88.5, BB: 100 });
    const r = P.lineOf(hand, shape);
    expect(r.tokens.join("-")).toBe(HERO_LINE);
    expect(r.seats).toEqual(["CO", "BTN", "SB", "BB", "SB"]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toContain("BTN's fold after his all-in (seat 4)");
  });

  it("the clean list (the CO's fold shown, no stray fold): the same line, nothing dropped", () => {
    const hand = cleanHand("allin-skip-clean");
    const r = P.lineOf(hand, shapeFor(hand));
    expect(r.tokens.join("-")).toBe(HERO_LINE);
    expect(r.seats).toEqual(["CO", "BTN", "SB", "BB", "SB"]);
    expect(r.dropped).toEqual([]);
  });
});

describe("solvePreflopGtowAi: the stray fold never reaches GTO Wizard", () => {
  it("answers from the tree's node at once — no poll of a line with the all-in seat's fold in it", async () => {
    process.env.GTOW_NODE_TIMEOUT_MS = "1500";
    P.resetAiPreflopMemory();
    const log = fakeGtow204(NODES);
    const t0 = Date.now();
    const r = await P.solvePreflopGtowAi(strayHand("4924546540"), null, "test");
    const ms = Date.now() - t0;
    if (!r.ok) throw new Error(r.reason);
    expect(r.usedLine).toBe(HERO_LINE);
    expect(r.line).toBe(HERO_LINE);
    expect(r.pos).toBe("BB");
    expect(r.actions).toHaveLength(2);                                          // the fold reads 0 and is left out
    expect(r.actions.map((a) => a.action)).toContain("Call");
    expect(r.note).toContain("BTN's fold after his all-in (seat 4)");
    expect(ms).toBeLessThan(1000);
    await Bun.sleep(120);                                                       // the pin's background prefix reads
    expect(log.polls.some((l) => l.includes("-F-R18.6") || l === "F-R2.2-R3.4-R7.8-F")).toBe(false);
  });
});

describe("the walk refuses a token whose seat is not the tree's actor", () => {
  /** the stray-fold line as the walk received it before the lineOf guard, each token on the seat it was read from */
  const BAD_TOKENS = ["F", "R2.2", "R3.4", "R7.8", "F", "R18.6"];
  const BAD_SEATS = ["CO", "BTN", "SB", "BB", "BTN", "SB"];
  const POSITIONS = ["CO", "BTN", "SB", "BB"];
  const getter = (asked: string[]) => async (line: string) => {
    asked.push(line);
    const v = NODES[line];
    return v ? { data: v } : { error: "the cloud did not return the node in time" };
  };

  it("repairLineWith: 'F' is the BTN's but the SB is on the clock — refused at that node, the child never asked for", async () => {
    const asked: string[] = [];
    const r = await P.repairLineWith(BAD_TOKENS, getter(asked), { seats: BAD_SEATS, positions: POSITIONS });
    expect("error" in r && r.error).toBe("actor mismatch: 'F' is BTN's but the tree puts SB on the clock at 'F-R2.2-R3.4-R7.8'");
    expect(asked).not.toContain("F-R2.2-R3.4-R7.8-F");
  });

  it("without seats, or with an actor the positions do not spell, the walk is what it was", async () => {
    const asked: string[] = [];
    const r = await P.repairLineWith(BAD_TOKENS, getter(asked));
    expect("error" in r && r.error).toContain("walking 'F-R2.2-R3.4-R7.8-F'");
    const renamed = await P.repairLineWith(BAD_TOKENS, getter([]), { seats: BAD_SEATS, positions: ["UTG", "HJ"] });
    expect("error" in renamed && renamed.error).toContain("walking 'F-R2.2-R3.4-R7.8-F'");
  });

  it("solvePreflopGtowAi: a token the tree gives another seat is refused at once, not polled to the timeout", async () => {
    // a tree that (wrongly) keeps the all-in BTN on the clock after hero's 7.8 and never holds hero's node: the line's
    // R18.6 is the SB's, the walk refuses it, and the direct read of the 204 node is dropped instead of waited for
    process.env.GTOW_NODE_TIMEOUT_MS = "5000";
    P.resetAiPreflopMemory();
    const { [HERO_LINE]: _hero, ...rest } = NODES;
    fakeGtow204({ ...rest, "F-R2.2-R3.4-R7.8": pnode("BTN", [["F", "FOLD", 0.5], ["C", "CALL", 0.3], ["R18.6", "RAISE", 0.2]]) });
    const t0 = Date.now();
    const r = await P.solvePreflopGtowAi(cleanHand("allin-skip-mismatch"), null, "test");
    const ms = Date.now() - t0;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("actor mismatch: 'R18.6' is SB's but the tree puts BTN on the clock at 'F-R2.2-R3.4-R7.8'");
    expect(ms).toBeLessThan(2000);
  });
});
