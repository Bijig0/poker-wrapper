import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import {
  CAPTURE_FAULT, PREFLOP_STACK_CAP_BB, TREE_REFUSED, debugTree, lineOf, seatAllInsPreflop, shapeOf, treeKeyOf, menus,
} from "./gtowAiPreflop";
import { failKindOf } from "./answerLog";

/**
 * THE 250BB CAP (2026-10-03, session_20261003_153908). GTO Wizard AI preflop refuses a tree whose effective stack (the
 * second-deepest seat) is over 250bb: 422 VALIDATION_ERROR "Preflop: Only effective stacks up to 250bb are supported"
 * on every node, root included. That read as a capture fault and hero got no pick twice:
 *   - 4922315540: 3-handed, hero BTN 369 / SB 255.5 / BB 77, hero first in (root)
 *   - 4922316453: 5-handed, hero CO 256 / BB 254, line F-R2.6-F-C-R15
 * One deep seat alone answers (4922315369: BTN 213 / SB 126 / BB 367) and must stay exactly as it was.
 */
const hand3 = (stacks: Record<number, number>, extra: ParsedHand["actions"] = [], hero = 1): ParsedHand => ({
  handId: 1, clientHandId: "cap250-3", bbCents: 200, heroSeatId: hero, heroCards: ["Ah", "Kd"], board: [], street: "preflop",
  actions: [
    { seatId: 2, hero: hero === 2, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 3, hero: hero === 3, type: "post-bb", amount: 1, street: "preflop" },
    ...extra,
  ],
  liveSeats: [1, 2, 3],
  committed: { 2: 0.5, 3: 1, ...Object.fromEntries(extra.filter((a) => a.amount != null).map((a) => [a.seatId, a.amount!])) },
  potByStreet: {}, positions: { 1: "BTN", 2: "SB", 3: "BB" }, stacks,
  currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 1.5, toCall: 1, legalActions: [], complete: false },
  ended: false,
} as unknown as ParsedHand);

/** hand 4922315540: BTN (hero) 369, SB 255.5, BB 77 — behind after the blinds */
const h540 = hand3({ 1: 369, 2: 255, 3: 76 });

/** hand 4922316453: five dealt, HJ folds, hero (CO, 256) opens 2.6, BTN folds, SB calls, BB (254) 3-bets to 15 */
const h453: ParsedHand = {
  handId: 2, clientHandId: "cap250-5", bbCents: 200, heroSeatId: 2, heroCards: ["Qs", "Qd"], board: [], street: "preflop",
  actions: [
    { seatId: 4, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 5, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: true, type: "raise", amount: 2.6, street: "preflop" },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "call", amount: 2.1, street: "preflop" },
    { seatId: 5, hero: false, type: "raise", amount: 15, street: "preflop" },
  ],
  liveSeats: [1, 2, 3, 4, 5],
  committed: { 2: 2.6, 4: 2.6, 5: 15 },
  potByStreet: {}, positions: { 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB" },
  stacks: { 1: 100, 2: 253.4, 3: 98, 4: 120, 5: 239 },
  currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 20.2, toCall: 12.4, legalActions: [], complete: false },
  ended: false,
} as unknown as ParsedHand;

describe("shapeOf — GTO Wizard's 250bb preflop limit", () => {
  it("hand 4922315540: 369 / 255.5 / 77 → 250 / 250 / 77, the real figures on the shape", () => {
    const s = shapeOf(h540, null);
    if ("error" in s) throw new Error(s.error);
    expect(PREFLOP_STACK_CAP_BB).toBe(250);
    expect(s.positions.map((p) => s.stacks[p])).toEqual([250, 250, 77]);
    expect(s.stackCap).toEqual({ cap: 250, real: { BTN: 369, SB: 255.5 } });
    expect(lineOf(h540, s).tokens).toEqual([]);
    const t = debugTree(h540, null);
    if ("error" in t) throw new Error(t.error);
    expect(t.body.players.map((p: any) => p.stack)).toEqual([250, 250, 77]);
  });

  it("one deep seat alone (4922315369: BTN 213 / SB 126 / BB 367) is left exactly as it was", () => {
    const h = hand3({ 1: 213, 2: 125.5, 3: 366 });
    const s = shapeOf(h, null);
    if ("error" in s) throw new Error(s.error);
    expect(s.positions.map((p) => s.stacks[p])).toEqual([213, 126, 367]);
    expect("stackCap" in s).toBe(false);
    // the key is what it was before the cap existed: built from the same stacks, no new field in it
    expect(treeKeyOf(s, menus([], 3))).toContain("[213,126,367]");
  });

  it("two seats at exactly 250 are not capped (250 is supported)", () => {
    const s = shapeOf(hand3({ 1: 250, 2: 249.5, 3: 80 }), null);
    if ("error" in s) throw new Error(s.error);
    expect(s.positions.map((p) => s.stacks[p])).toEqual([250, 250, 81]);
    expect("stackCap" in s).toBe(false);
  });

  it("hand 4922316453 (five-handed): CO 256 and BB 254 both → 250, the line unchanged", () => {
    const s = shapeOf(h453, null);
    if ("error" in s) throw new Error(s.error);
    expect(s.positions).toEqual(["HJ", "CO", "BTN", "SB", "BB"]);
    expect(s.stacks.CO).toBe(250);
    expect(s.stacks.BB).toBe(250);
    expect(s.stacks.SB).toBe(122.5);
    expect(s.stackCap).toEqual({ cap: 250, real: { CO: 256, BB: 254 } });
    expect(lineOf(h453, s).tokens.join("-")).toBe("F-R2.6-F-C-R15");
  });

  it("a 255.5bb shove by a capped seat is that seat's tree all-in: R250, listed as 250bb", () => {
    // BTN (369) opens 2.5, the SB shoves his 255.5, hero (BB, 77) to act
    const h = hand3({ 1: 366.5, 2: 0, 3: 76 }, [
      { seatId: 1, hero: false, type: "raise", amount: 2.5, street: "preflop" },
      { seatId: 2, hero: false, type: "all-in", amount: 255.5, street: "preflop" },
    ], 3);
    const s = shapeOf(h, null);
    if ("error" in s) throw new Error(s.error);
    expect(s.stackCap).toEqual({ cap: 250, real: { BTN: 369, SB: 255.5 } });
    const { tokens, levels } = lineOf(h, s);
    expect(tokens.join("-")).toBe("R2.5-R250");
    expect(levels).toEqual([2.5, 250]);
    expect(seatAllInsPreflop(s)).toEqual({ BTN: 250, SB: 250, BB: 77 });
    const t = debugTree(h, null);
    if ("error" in t) throw new Error(t.error);
    const sb = t.body.bet_sizes.street_bet_sizes[0].position_bet_sizes.find((x: any) => x.position === "SB");
    expect(sb.raise_sizes).toEqual(["250bb"]);   // the 3-bet played (its exact amount) IS the all-in
  });

  it("an uncapped tree keeps a raise's amount as played", () => {
    const h = hand3({ 1: 97.5, 2: 99.5, 3: 99 }, [{ seatId: 1, hero: false, type: "raise", amount: 2.5, street: "preflop" }], 2);
    const s = shapeOf(h, null);
    if ("error" in s) throw new Error(s.error);
    expect(lineOf(h, s).tokens).toEqual(["R2.5"]);
  });
});

// --- the refusal's reason and kind: a fake GTO Wizard (no request leaves the process) ----------------------------
let P: typeof import("./gtowAiPreflop");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
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
  P.setPreflopSolveCache(null);
});
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of savedPool) { if (own) s[m] = fn; else delete s[m]; }
  P.resetAiPreflopMemory();
});
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; P.resetAiPreflopMemory(); });

const BODY_250 = { code: "VALIDATION_ERROR", detail: "Preflop: Only effective stacks up to 250bb are supported", data: { detail: "Preflop: Only effective stacks up to 250bb are supported" } };
const arr = (x: number) => new Array(1326).fill(x);
/** every node answers `reply` (a status + body, or a node); the trees POSTed are kept */
function fakeGtow(reply: { status: number; body: object } | object) {
  const bodies: any[] = [];
  let seq = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/custom-trees/")) { bodies.push(JSON.parse(init.body)); return Response.json({ id: `tree-${++seq}` }, { status: 201 }); }
    if (u.pathname.endsWith("/custom-solutions/")) return Response.json({ id: `sol-${++seq}` }, { status: 201 });
    if ("status" in reply && "body" in reply) return new Response(JSON.stringify(reply.body), { status: (reply as any).status });
    return Response.json(reply);
  }) as typeof fetch;
  return bodies;
}

describe("a VALIDATION_ERROR that is not about the line", () => {
  it("GTO Wizard's 250bb refusal: the reason carries its detail, the kind is not a capture fault", async () => {
    // a 3-handed 100bb hand: the shape is irrelevant, the fake refuses every node the way GTO Wizard refused these
    const h = hand3({ 1: 100, 2: 99.5, 3: 99 });
    fakeGtow({ status: 422, body: BODY_250 });
    const r = await P.solvePreflopGtowAi(h, null, "test");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe(TREE_REFUSED);
    expect(r.kind).not.toBe(CAPTURE_FAULT);
    expect(r.reason).toContain("GTO Wizard refused the tree: Preflop: Only effective stacks up to 250bb are supported");
    expect(r.reason).not.toContain("not a legal betting sequence");
    expect(failKindOf(r.reason)).toBe("table-shape");
  });

  it("'Incorrect actions' is still a capture fault", async () => {
    const h = hand3({ 1: 100, 2: 99.5, 3: 99 });
    fakeGtow({ status: 400, body: { code: "VALIDATION_ERROR", detail: "Incorrect actions" } });
    const r = await P.solvePreflopGtowAi(h, null, "test");
    expect(!r.ok && r.kind).toBe(CAPTURE_FAULT);
    expect(!r.ok && r.reason).toContain("not a legal betting sequence");
  });

  it("hand 4922315540 is sent as a 250/250/77 tree, and the answer says the stacks were capped", async () => {
    const bodies = fakeGtow({
      game: { players: [{ position: "BTN", is_hero: true }] },
      action_solutions: [
        { action: { code: "F", type: "FOLD", betsize: "" }, strategy: arr(0.4), total_frequency: 0.4 },
        { action: { code: "R2.5", type: "RAISE", betsize: "2.5" }, strategy: arr(0.6), total_frequency: 0.6 },
      ],
    });
    const r = await P.solvePreflopGtowAi(h540, null, "test");
    if (!r.ok) throw new Error(r.reason);
    expect(bodies[0].players.map((p: any) => p.stack)).toEqual([250, 250, 77]);
    expect(r.note).toContain("stacks over 250bb capped at 250bb for the preflop tree (GTO Wizard's limit): BTN 369→250, SB 255.5→250");
    expect(r.actions.map((a) => a.action)).toEqual(["Fold", "Raise 2.5"]);
    await Bun.sleep(20);   // the pin's background prefix warm
  });
});
