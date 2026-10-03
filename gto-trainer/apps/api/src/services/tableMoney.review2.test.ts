/**
 * THE SECOND REVIEW OF THE TABLE-MONEY REFACTOR (2026-10-03, audits/postflop-allin-fix-2026-10/review2/): each finding
 * as a test, at the fastSolve level.
 *  1. check #5 prices a MERGE plan with every member of the merged seat contesting (it priced the second member's
 *     chips as dead money, or as nothing when the named villains had folded — a false potOff, a wasted re-solve)
 *  2. a bet or raise with no amount (a bare "R") is never a throw: left out where it proves nothing, refused where the
 *     money depends on it
 *  3. the field's stack from the table — tableFlopPot.paid → each seat's stack → the field's stack → the tree's stack —
 *     on the paths the logged replays never reached; no tree is ever sent at a stack of 0.5bb or less
 *  5. an earlier round's uncalled excess comes off the stacks as dealt (dealtBySeat) instead of being counted twice
 * (4, the property tests, is utils/tableMoney/tableMoney.test.ts.)
 */
import { describe, expect, it } from "bun:test";
import { chainPathChecks, flopFieldMoney, flopSeatStacks, heroVsAggressor, mergeMembers, tableFlopPot, treeStackFor } from "./fastSolve";
import { moneyThrough } from "./multiwayReroot";
import { StreetState, type ChainTrace } from "./aiChain";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { buildSpotSolutionTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { dealtBySeat, truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";

// ---- 1 ---------------------------------------------------------------------------------------------------------
// SB hero 100 behind, BB 20, CO and BTN 100; the plan merges CO+BTN (named CO). Pot 12 entering the turn.
const pre = [
  { seatId: 1, hero: true, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
  { seatId: 3, hero: false, type: "raise", street: "preflop", amount: 3 }, { seatId: 4, hero: false, type: "call", street: "preflop", amount: 3 },
  { seatId: 1, hero: true, type: "call", street: "preflop", amount: 2.5 }, { seatId: 2, hero: false, type: "call", street: "preflop", amount: 2 },
  { seatId: 1, hero: true, type: "check", street: "flop" }, { seatId: 2, hero: false, type: "check", street: "flop" },
  { seatId: 3, hero: false, type: "check", street: "flop" }, { seatId: 4, hero: false, type: "check", street: "flop" },
];
const mergeHand = (turn: object[]) => normalizeHand({
  handId: 3, clientHandId: "4999000904", bbCents: 200, heroSeatId: 1, heroCards: ["A♦", "K♦"], board: ["5♦", "6♦", "5♥", "7♣"], street: "turn",
  liveSeats: [1, 2, 3, 4], committed: {}, potByStreet: {}, positions: { 1: "SB", 2: "BB", 3: "CO", 4: "BTN" }, stacks: {},
  startStacks: { 1: 103, 2: 23, 3: 103, 4: 103 },
  currentNode: { street: "turn", toActSeatId: 1, toActIsHero: true, pot: 0, toCall: 30, legalActions: [], complete: false },
  actions: [...pre, ...turn], heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$1/$2",
} as any).hand!;
/** the merged plan's trace: the tree SB / BB / CO(+BTN), the turn line as the tree walked it, hero's node priced by the tree */
function mergeTrace(turnToks: string[], walk: (t: StreetState) => void, invested: number[]): ChainTrace {
  const tree = new StreetState(3, [100, 20, 100]);
  walk(tree);
  const potNode = 12 + tree.matchedPotIn;
  const s = (si: number, street: string, board: string) => ({ si, street, board, potIn: 12, stackIn: 100, labels: [], fixedLevels: null, solId: "s", created: false, oopIn: [], ipIn: [], players: ["SB", "BB", "CO"] });
  return {
    spec: { oopPos: "SB", midPos: "BB", ipPos: "CO", oopRange: [], midRange: [], ipRange: [], flopPot: 12, flopStack: 100, board: "5d6d5h7c",
      streets: [["X", "X", "X"], turnToks], heroSeat: "oop", heroComboIdx: null, planTag: "merge:CO+BTN (BTN's action)" },
    streets: [s(0, "FLOP", "5d6d5h"), s(1, "TURN", "5d6d5h7c")] as any,
    nodes: [{ si: 1, ti: turnToks.length, street: "TURN", board: "5d6d5h7c", codes: turnToks, actor: 0, potNode, invested, actions: [], taken: null, heroNode: true }],
    result: { ok: true },
  } as ChainTrace;
}
const check5 = (h: any, trace: ChainTrace, members?: Record<string, string[]>) => chainPathChecks({
  hand: h, walks: [{ kind: trace.spec.planTag ?? null, trace, ...(members ? { members } : {}) }], arrival: undefined, potExtra: 0,
  dealt: { 1: 103, 2: 23, 3: 103, 4: 103 }, treePos: (sid) => h.positions[sid] ?? null, rake: null, site: null, handTrees: [],
}).turn!.find((x) => x.id === 5)!;

describe("1. a merged seat contests with every member (check #5's plan rule)", () => {
  // turn: hero checks, BB bets 10, CO folds, BTN raises to 30 — the tree's merged CO carries the BTN's raise
  const h1 = mergeHand([
    { seatId: 1, hero: true, type: "check", street: "turn" }, { seatId: 2, hero: false, type: "bet", street: "turn", amount: 10 },
    { seatId: 3, hero: false, type: "fold", street: "turn" }, { seatId: 4, hero: false, type: "raise", street: "turn", amount: 30 },
  ]);
  const t1 = mergeTrace(["X", "R10", "R30"], (t) => { t.apply("Check"); t.apply("Bet", 10); t.apply("Raise", 30); }, [0, 10, 30]);
  it("CO folds, the BTN raises 30 over BB's 10: the tree's 52 is the table's side (it read 42 — the BTN's chips as dead money)", () => {
    expect(t1.nodes[0]!.potNode).toBe(52);
    const five = check5(h1, t1, { CO: ["CO", "BTN"] });
    expect(five.status).toBe("pass");
    expect(five.text).toContain("52bb at hero's node");
  });
  it("a stored trace with no members: the plan's name gives them (mergeMembers)", () => {
    expect(mergeMembers("drop:UTG + merge:CO+BTN (BTN's action)")).toEqual({ CO: ["CO", "BTN"] });
    expect(mergeMembers("merge:BTN+SB + merge:CO+BTN")).toEqual({ BTN: ["BTN", "SB"], CO: ["CO", "BTN", "SB"] });
    // review 3: the names are the table's positions — "UTG+1" is one seat, not UTG and "1"
    expect(mergeMembers("merge:UTG+1+HJ")).toEqual({ "UTG+1": ["UTG+1", "HJ"] });
    expect(mergeMembers("merge:UTG+UTG+1 + merge:HJ+UTG")).toEqual({ UTG: ["UTG", "UTG+1"], HJ: ["HJ", "UTG", "UTG+1"] });
    expect(check5(h1, t1).status).toBe("pass");
  });
  it("without the members (the old rule) the same spot is a false fail", () => {
    expect(check5(h1, t1, {}).status).toBe("fail");
  });
  it("both named villains fold (hero bets 10, BB and CO fold, the BTN raises 30): the tree's 52, the table's 52 (it read 12 + 10)", () => {
    const h2 = mergeHand([
      { seatId: 1, hero: true, type: "bet", street: "turn", amount: 10 }, { seatId: 2, hero: false, type: "fold", street: "turn" },
      { seatId: 3, hero: false, type: "fold", street: "turn" }, { seatId: 4, hero: false, type: "raise", street: "turn", amount: 30 },
    ]);
    const t2 = mergeTrace(["R10", "F", "R30"], (t) => { t.apply("Bet", 10); t.apply("Fold"); t.apply("Raise", 30); }, [10, 0, 30]);
    expect(t2.nodes[0]!.potNode).toBe(52);
    const five = check5(h2, t2, { CO: ["CO", "BTN"] });
    expect(five.status).toBe("pass");
    expect(five.text).toContain("52bb at hero's node");
  });
});

// ---- 2 ---------------------------------------------------------------------------------------------------------
describe("2. a bet with no amount is never a throw", () => {
  // the capture lost the CO's flop bet size: actionToken emits a bare "R"
  const h = normalizeHand({
    handId: 4, clientHandId: "4999000905", bbCents: 200, heroSeatId: 4, heroCards: ["A♦", "K♦"], board: ["5♦", "6♦", "5♥"], street: "flop",
    liveSeats: [2, 3, 4], committed: {}, potByStreet: {}, positions: { 2: "BB", 3: "CO", 4: "BTN" }, stacks: {},
    startStacks: { 2: 100, 3: 100, 4: 100 },
    currentNode: { street: "flop", toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false },
    actions: [
      { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 }, { seatId: 3, hero: false, type: "raise", street: "preflop", amount: 3 },
      { seatId: 4, hero: true, type: "call", street: "preflop", amount: 3 }, { seatId: 2, hero: false, type: "call", street: "preflop", amount: 2 },
      { seatId: 2, hero: false, type: "check", street: "flop" }, { seatId: 3, hero: false, type: "bet", street: "flop" },
    ],
    heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$1/$2",
  } as any).hand!;
  it("the hand's flop tokens carry a bare R; the flop stacks are read without it (as before the money model)", () => {
    const tk = buildSpotSolutionTokens(h, "BTN");
    expect(tk.flop).toEqual(["X", "R"]);
    const table = tableFlopPot(h, { 2: 100, 3: 100, 4: 100 });
    const run = () => flopFieldMoney({
      flopSeats: ["BB", "CO", "BTN"], heroPos: "BTN", chainPos: (sid) => h.positions[sid] ?? null, depth: 100, flopStack: 97,
      streets: [tk.flop], streetSeats: [["BB", "CO"]], allIns: [], dealt: { 2: 100, 3: 100, 4: 100 }, table, antePerSeat: 0,
    });
    expect(run).not.toThrow();
    expect(run()).toEqual({ behindFlop: { BB: 97, CO: 97, BTN: 97 }, fieldStack: 97 });
  });
  it("an all-in after a bare R proves nothing about the chips before it: the reading stays", () => {
    const r = flopSeatStacks({ seats: ["BB", "CO", "BTN"], depth: 100, flopStack: 97, dealtByPos: { BB: 100, CO: 100, BTN: 100 }, paidPre: { BB: 3, CO: 3, BTN: 3 },
      streets: [["X", "R", "C", "C"], ["RAI"]], streetSeats: [["BB", "CO", "BTN", "BB"], ["BB"]], allIns: [{ pos: "BB", k: 1, to: 50 }] });
    expect(r).toEqual({ BB: 97, CO: 97, BTN: 97 });
  });
  it("the re-root's money and the last resort refuse a line they cannot price, cleanly", () => {
    const a = { ordered: ["SB", "BB", "CO", "BTN"], heroPos: "BTN", streets: [["X", "R", "C", "C", "C"], ["X", "R20"]],
      streetSeats: [["SB", "BB", "CO", "BTN", "SB"], ["SB", "BB"]], flopPot: 12, flopStack: 97 };
    expect(moneyThrough(a, 1).unpriced).toBe(1);
    expect(heroVsAggressor({ ...a, arr: () => [] })).toBeNull();
    expect(heroVsAggressor({ ...a, streets: [["X", "X", "X", "X"], ["X", "R"]], streetSeats: [["SB", "BB", "CO", "BTN"], ["SB", "BB"]], arr: () => [] })).toBeNull();
  });
});

// ---- 3 ---------------------------------------------------------------------------------------------------------
describe("3. the field's stack and the tree's stack, from the table", () => {
  const pos = (m: Record<number, string>) => (sid: number) => m[sid] ?? null;
  it("a tree seat with an UNKNOWN stack: the base binds (the field's stack), never the unknown seat", () => {
    expect(treeStackFor(["BB", "CO", "BTN"], "BTN", { BTN: 150, BB: 40 }, 60, false)).toBe(60);
    expect(treeStackFor(["BB", "CO", "BTN"], "BTN", { BTN: 150, BB: 40, CO: 80 }, 60, false)).toBe(80);   // all known: theirs, uncapped
    expect(treeStackFor(["BB", "CO", "BTN"], "BTN", { BTN: 150, BB: 40, CO: 80 }, 60, true)).toBe(60);    // a re-root: always capped
  });
  it("a villain whose reading his own bet contradicts is UNKNOWN: the field's stack is hero's own (intended — see flopFieldMoney)", () => {
    // CO read at 100 dealt bets 120 on the flop: he has more than read. Hero BTN 200 deep. The token rebuild says 97.
    const h = normalizeHand({
      handId: 5, clientHandId: "4999000906", bbCents: 200, heroSeatId: 4, heroCards: ["A♦", "K♦"], board: ["5♦", "6♦", "5♥"], street: "flop",
      liveSeats: [1, 2, 3, 4], committed: {}, potByStreet: {}, positions: { 1: "SB", 2: "BB", 3: "CO", 4: "BTN" }, stacks: {},
      startStacks: { 1: 100, 2: 100, 3: 100, 4: 200 },
      currentNode: { street: "flop", toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 120, legalActions: [], complete: false },
      actions: [
        { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
        { seatId: 3, hero: false, type: "raise", street: "preflop", amount: 3 }, { seatId: 4, hero: true, type: "call", street: "preflop", amount: 3 },
        { seatId: 1, hero: false, type: "fold", street: "preflop" }, { seatId: 2, hero: false, type: "fold", street: "preflop" },
        { seatId: 3, hero: false, type: "bet", street: "flop", amount: 120 },
      ],
      heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$1/$2",
    } as any).hand!;
    const dealt = { 1: 100, 2: 100, 3: 100, 4: 200 };
    const r = flopFieldMoney({ flopSeats: ["CO", "BTN"], heroPos: "BTN", chainPos: pos(h.positions), depth: 100, flopStack: 97,
      streets: [["R120"]], streetSeats: [["CO"]], allIns: [], dealt, table: tableFlopPot(h, dealt), antePerSeat: 0 });
    expect(r.behindFlop).toEqual({ BTN: 197 });
    expect(r.fieldStack).toBe(197);
    expect(treeStackFor(["CO", "BTN"], "BTN", r.behindFlop, r.fieldStack, false)).toBe(197);
  });
  it("an unknown-stack villain beside a short preflop jammer: answered at hero's own stack (> 0.5), not refused", () => {
    // hero BTN opens 2.5, the SB jams his 10, the BB (no stack reading) and hero call: the flop is BB vs BTN, the SB's
    // chips in the pot. The token rebuild's field stack is the jam's level (0 left — the old "(near) all-in" refusal).
    const h = normalizeHand({
      handId: 6, clientHandId: "4999000907", bbCents: 200, heroSeatId: 3, heroCards: ["A♦", "K♦"], board: ["5♦", "6♦", "5♥"], street: "flop",
      liveSeats: [1, 2, 3], committed: {}, potByStreet: {}, positions: { 1: "SB", 2: "BB", 3: "BTN" }, stacks: {},
      startStacks: { 1: 10, 3: 100 },
      currentNode: { street: "flop", toActSeatId: 3, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false },
      actions: [
        { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
        { seatId: 3, hero: true, type: "raise", street: "preflop", amount: 2.5 }, { seatId: 1, hero: false, type: "all-in", street: "preflop", amount: 10 },
        { seatId: 2, hero: false, type: "call", street: "preflop", amount: 9 }, { seatId: 3, hero: true, type: "call", street: "preflop", amount: 7.5 },
        { seatId: 2, hero: false, type: "check", street: "flop" },
      ],
      heroFolded: false, ended: false, lineSource: "ws", sessionId: "s", stakes: "$1/$2",
    } as any).hand!;
    const dealt = { 1: 10, 3: 100 };
    const table = tableFlopPot(h, dealt);
    expect(table.pot).toBe(30);
    const r = flopFieldMoney({ flopSeats: ["BB", "BTN"], heroPos: "BTN", chainPos: pos(h.positions), depth: 10, flopStack: 0,
      streets: [["X"]], streetSeats: [["BB"]], allIns: [], dealt, table, antePerSeat: 0 });
    expect(r.behindFlop).toEqual({ BTN: 90 });
    expect(r.fieldStack).toBe(90);
    expect(treeStackFor(["BB", "BTN"], "BTN", r.behindFlop, r.fieldStack, false)).toBe(90);
  });
  it("the tree's stack over 5,000 random seat stacks and bases: the effective stack, the base where a seat is unknown, null at 0.5bb or less and only then", () => {
    expect(treeStackFor(["BB", "BTN"], "BTN", { BB: 0.3, BTN: 50 }, 60, false)).toBeNull();
    expect(treeStackFor(["BB", "BTN"], "BTN", { BTN: 50 }, 0.4, false)).toBeNull();
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 5000; i++) {
      const seats = ["BB", "CO", "BTN"].slice(0, 2 + Math.floor(rnd() * 2));
      const ss: Record<string, number> = {};
      for (const p of seats) if (rnd() < 0.8) ss[p] = Math.round(rnd() * (rnd() < 0.2 ? 1.2 : 200) * 100) / 100;
      const base = Math.round(rnd() * (rnd() < 0.2 ? 1 : 150) * 100) / 100, rerooted = rnd() < 0.3;
      // the rule, stated on its own: hero against the deepest villain (an unknown stack never binds); every stack known
      // and not re-rooted → that, else capped by the base; refused (null) at 0.5bb or less — and ONLY then
      const v = seats.filter((p) => p !== "BTN").map((p) => ss[p] ?? Infinity);
      const eff = Math.round(Math.min(ss.BTN ?? Infinity, Math.max(...v)) * 100) / 100;
      const sent = !rerooted && seats.every((p) => ss[p] != null) ? eff : Math.min(base, eff);
      expect(treeStackFor(seats, "BTN", ss, base, rerooted)).toBe(sent > 0.5 ? sent : null);
    }
  });
});

// ---- 5 ---------------------------------------------------------------------------------------------------------
describe("5. an earlier round's uncalled excess is not counted twice in the stacks as dealt", () => {
  it("BTN raises 50 (dealt 100), the BB calls all-in for 20: on the flop the BTN read 80 behind is 100 dealt, not 130", () => {
    const h: any = {
      heroSeatId: 3, positions: { 1: "SB", 2: "BB", 3: "BTN" }, stacks: { 1: 99.5, 2: 0, 3: 80 }, committed: {},
      currentNode: { street: "flop" },
      actions: [
        { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
        { seatId: 3, hero: true, type: "raise", street: "preflop", amount: 50 }, { seatId: 1, hero: false, type: "fold", street: "preflop" },
        { seatId: 2, hero: false, type: "all-in", street: "preflop", amount: 20 },
      ],
    };
    expect(dealtBySeat(h)).toEqual({ 1: 100, 2: 20, 3: 100 });
  });
  it("the replay's own money agrees: withStartStacks / truncateAt hand the excess back behind (80), out of the pot, and dealtBySeat reads the dealt 100", () => {
    const h: any = {
      heroSeatId: 3, positions: { 1: "SB", 2: "BB", 3: "BTN" }, stacks: {}, committed: {}, startStacks: { 1: 100, 2: 20, 3: 100 }, board: ["5d", "6d", "5h"], street: "flop",
      currentNode: { street: "flop" },
      actions: [
        { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
        { seatId: 3, hero: true, type: "raise", street: "preflop", amount: 50 }, { seatId: 1, hero: false, type: "fold", street: "preflop" },
        { seatId: 2, hero: false, type: "all-in", street: "preflop", amount: 20 }, { seatId: 3, hero: true, type: "check", street: "flop" },
      ],
    };
    const live = withStartStacks(h);
    expect(live.stacks).toEqual({ 1: 99.5, 2: 0, 3: 80 });
    expect(dealtBySeat(live)).toEqual({ 1: 100, 2: 20, 3: 100 });
    const cut = truncateAt(h, 5);
    expect(cut.stacks).toEqual({ 1: 99.5, 2: 0, 3: 80 });
    expect(cut.currentNode.pot).toBe(40.5);   // 20 + 20 + the SB's 0.5 — not the BTN's 50
    expect(dealtBySeat(cut)).toEqual({ 1: 100, 2: 20, 3: 100 });
  });
  it("no excess: exactly the old sum (behind + committed + the earlier streets)", () => {
    const h: any = {
      heroSeatId: 3, positions: { 1: "SB", 2: "BB", 3: "BTN" }, stacks: { 1: 99.5, 2: 97, 3: 92 }, committed: { 3: 5 },
      currentNode: { street: "flop" },
      actions: [
        { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
        { seatId: 3, hero: true, type: "raise", street: "preflop", amount: 3 }, { seatId: 1, hero: false, type: "fold", street: "preflop" },
        { seatId: 2, hero: false, type: "call", street: "preflop", amount: 2 }, { seatId: 2, hero: false, type: "check", street: "flop" },
        { seatId: 3, hero: true, type: "bet", street: "flop", amount: 5 },
      ],
    };
    expect(dealtBySeat(h)).toEqual({ 1: 100, 2: 100, 3: 100 });
  });
});
