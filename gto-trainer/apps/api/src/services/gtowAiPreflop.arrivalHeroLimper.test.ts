import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * HERO IS ONE OF THE LIMPERS (2026-10-05, stress-500 po_4way-002 / brief_E-002 / brief_G-003 / pf_shortlimp-001). CO
 * limps, hero over-limps on the button, the SB completes, the BB checks: GTO Wizard's tree holds ONE non-SB limper, so
 * the flop-arrival walk refuses the second limp and every seat's range is read on a fitted line. Each fit kept hero's
 * own actions — and for CO (the other limper) a line that keeps both limps is one the tree cannot hold either, so the
 * fit failed, the reduced tree refused the limped pot ("nobody raised preflop") and hero got no answer on any street.
 * What must hold now: another limper's range is read on a line that folds hero's limp (the CO acted before hero: his
 * limp range is exactly the first-in one), hero's own range keeps hero's limp, and the flop gets all four ranges.
 * Hermetic: a fake fetch, a stubbed session pool.
 */
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
});
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of savedPool) { if (own) s[m] = fn; else delete s[m]; }
  P.resetAiPreflopMemory();
});
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; P.resetAiPreflopMemory(); });

/** GTO Wizard with one tree: a node per line in `nodes`, NODE_DOES_NOT_EXIST for any other. */
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

/** The tree as GTO Wizard builds it: one non-SB limper, then only the SB may complete — no second limp behind CO. */
const TREE: Record<string, object> = {
  "": pnode("UTG", [["F", "FOLD", 0.8], ["C", "CALL", 0.05], ["R2.5", "RAISE", 0.15]]),
  F: pnode("HJ", [["F", "FOLD", 0.8], ["C", "CALL", 0.05], ["R2.5", "RAISE", 0.15]]),
  "F-F": pnode("CO", [["F", "FOLD", 0.7], ["C", "CALL", 0.2], ["R2.5", "RAISE", 0.1]]),
  "F-F-C": pnode("BTN", [["F", "FOLD", 0.8], ["R4", "RAISE", 0.2]]),                       // no over-limp: the cap
  "F-F-C-F": pnode("SB", [["F", "FOLD", 0.6], ["C", "CALL", 0.3], ["R5", "RAISE", 0.1]]),
  "F-F-C-F-C": pnode("BB", [["X", "CHECK", 0.75], ["R5", "RAISE", 0.25]]),
  "F-F-F": pnode("BTN", [["F", "FOLD", 0.6], ["C", "CALL", 0.25], ["R2.5", "RAISE", 0.15]]),
  "F-F-F-C": pnode("SB", [["F", "FOLD", 0.5], ["C", "CALL", 0.4], ["R4", "RAISE", 0.1]]),
  "F-F-F-C-C": pnode("BB", [["X", "CHECK", 0.7], ["R4", "RAISE", 0.3]]),
};

/** po_4way-002's preflop: UTG and HJ fold, CO limps, hero over-limps on the button, SB completes, BB checks. */
const limpedFour = (id: string): ParsedHand => ({
  handId: 1, clientHandId: id, bbCents: 200, heroSeatId: 4, heroCards: ["9h", "9d"], board: ["Ah", "7c", "2d"], street: "flop",
  actions: [
    { seatId: 5, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "fold", street: "preflop" },
    { seatId: 3, hero: false, type: "call", amount: 1, street: "preflop" },
    { seatId: 4, hero: true, type: "call", amount: 1, street: "preflop" },
    { seatId: 5, hero: false, type: "call", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: false, type: "check", street: "preflop" },
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" }, stacks: { 1: 100, 2: 100, 3: 99, 4: 99, 5: 99, 6: 99 },
  currentNode: { street: "flop", toActSeatId: 5, toActIsHero: false, pot: 4, toCall: 0, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand);
const DEALT = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 };

describe("AI preflop flop arrival: hero over-limps behind a limper the tree holds alone", () => {
  it("every seat's range comes back — the other limper's on a line that folds hero's limp", async () => {
    fakeGtow(TREE);
    const r = await P.arrivalRangesGtowAi(limpedFour("arrival-hero-limper"), "BTN", 6, DEALT);
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.ranges).sort()).toEqual(["BB", "BTN", "CO", "SB"]);
    // CO's range is his first-in limp (0.2 of every class: the tree's "F-F" node), hero's limp folded out of his line
    expect(Object.values(r.ranges.CO!).every((w) => Math.abs(w - 0.2) < 1e-6)).toBe(true);
    // hero's range keeps hero's limp: the button's limp with CO folded out (the "F-F-F" node, 0.25)
    expect(Object.values(r.ranges.BTN!).every((w) => Math.abs(w - 0.25) < 1e-6)).toBe(true);
    // the blinds keep hero's limp too (CO folded): SB completes 0.4, BB checks 0.7
    expect(Object.values(r.ranges.SB!).every((w) => Math.abs(w - 0.4) < 1e-6)).toBe(true);
    expect(Object.values(r.ranges.BB!).every((w) => Math.abs(w - 0.7) < 1e-6)).toBe(true);
    expect(r.note).toContain("LINE FITTED FOR THE RANGES");
    expect(r.note).toContain("BTN");                                  // hero's limp is named among the seats folded
  });

  it("a hero who is not a limper is fitted as before (hero's actions kept in every seat's line)", async () => {
    fakeGtow({
      ...TREE,
      // UTG limps, CO over-limps (the cap refuses it), hero completes from the SB, BB checks
      "C": pnode("HJ", [["F", "FOLD", 0.9], ["R4", "RAISE", 0.1]]),
      "C-F": pnode("CO", [["F", "FOLD", 0.85], ["R4", "RAISE", 0.15]]),
      "C-F-F": pnode("BTN", [["F", "FOLD", 0.85], ["R4", "RAISE", 0.15]]),
      "C-F-F-F": pnode("SB", [["F", "FOLD", 0.5], ["C", "CALL", 0.35], ["R5", "RAISE", 0.15]]),
      "C-F-F-F-C": pnode("BB", [["X", "CHECK", 0.8], ["R5", "RAISE", 0.2]]),
    });
    const h = limpedFour("arrival-hero-sb");
    h.heroSeatId = 5;
    h.actions = [
      { seatId: 5, hero: true, type: "post-sb", amount: 0.5, street: "preflop" },
      { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
      { seatId: 1, hero: false, type: "call", amount: 1, street: "preflop" },
      { seatId: 2, hero: false, type: "fold", street: "preflop" },
      { seatId: 3, hero: false, type: "call", amount: 1, street: "preflop" },
      { seatId: 4, hero: false, type: "fold", street: "preflop" },
      { seatId: 5, hero: true, type: "call", amount: 0.5, street: "preflop" },
      { seatId: 6, hero: false, type: "check", street: "preflop" },
    ] as any;
    h.stacks = { 1: 99, 2: 100, 3: 99, 4: 100, 5: 99, 6: 99 } as any;
    const r = await P.arrivalRangesGtowAi(h, "SB", 6, DEALT);
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.ranges).sort()).toEqual(["BB", "CO", "SB", "UTG"]);
    // UTG's range: his limp with CO folded (hero's complete kept) — the "" node's C, 0.05
    expect(Object.values(r.ranges.UTG!).every((w) => Math.abs(w - 0.05) < 1e-6)).toBe(true);
    // CO's: his limp with UTG folded — "F-F" C, 0.2
    expect(Object.values(r.ranges.CO!).every((w) => Math.abs(w - 0.2) < 1e-6)).toBe(true);
    // hero (SB) and the BB on the earliest fit (UTG folded): complete behind CO 0.3, check 0.75
    expect(Object.values(r.ranges.SB!).every((w) => Math.abs(w - 0.3) < 1e-6)).toBe(true);
    expect(Object.values(r.ranges.BB!).every((w) => Math.abs(w - 0.75) < 1e-6)).toBe(true);
  });
});
