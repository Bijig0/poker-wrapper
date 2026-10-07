/**
 * THE SHORT ALL-IN PRESS (services/allInPress, 2026-10-07). Fixtures: stress-500 brief_I-004 — 5-way on 8h9h9c, the
 * 17.5bb SB jams 15, hero BB (Ts9s, 97.5 behind), UTG 24.5 / CO 100 / BTN 100 behind him. Decision 9 (hero facing the
 * 15 jam) was read on three ghost trees: ghost:CO+ghost:BTN (SB/BB/UTG — hero's all-in 22, UTG's stack), ghost:UTG+
 * ghost:BTN and ghost:UTG+ghost:CO (all-in 97.5). Decision 13 (hero called 15, UTG jammed 22, CO and BTN called) on
 * dead-money trees whose preload moved hero's 15 into the starting pot: the tree's "ALLIN 82.5" is 15 + 82.5 = his whole
 * 97.5 — not short. The node values are the stored traces' (stress DB solves 9087-9089, 9093-9095).
 */
import { describe, expect, test } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";
import {
  allInSizeToTreeOn, pressForPick, pressNote, pressReason, shortAllInPress, streetMoneyAt, treeAllInTo, withPressNote, type TreeAllIn,
} from "./allInPress";
import { pressTreeOf } from "./fastSolve";
import { departureForCode, departureForWarning } from "./approximations";

const A = (seatId: number, type: string, street: string, amount?: number) =>
  ({ seatId, hero: seatId === 4, type, street, ...(amount != null ? { amount } : {}) }) as ParsedHand["actions"][number];

/** brief_I-004 as the stress harness stored it (seats: 1 CO, 2 BTN, 3 SB, 4 BB = hero, 5 UTG, 6 HJ) */
const BRIEF_I_004: ParsedHand = {
  handId: 1, heroSeatId: 4, heroCards: ["Ts", "9s"], board: ["8h", "9h", "9c", "8s", "4c"], street: "river",
  positions: { 1: "CO", 2: "BTN", 3: "SB", 4: "BB", 5: "UTG", 6: "HJ" },
  startStacks: { 1: 100, 2: 100, 3: 17.5, 4: 100, 5: 24.5, 6: 100 },
  stacks: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, committed: {}, potByStreet: {}, liveSeats: [1, 2, 3, 4, 5, 6],
  actions: [
    A(3, "post-sb", "preflop", 0.5), A(4, "post-bb", "preflop", 1), A(5, "raise", "preflop", 2.5), A(6, "fold", "preflop"),
    A(1, "call", "preflop", 2.5), A(2, "call", "preflop", 2.5), A(3, "call", "preflop", 2), A(4, "call", "preflop", 1.5),
    A(3, "all-in", "flop", 15), A(4, "call", "flop", 15), A(5, "all-in", "flop", 22), A(1, "call", "flop", 22),
    A(2, "call", "flop", 22), A(4, "call", "flop", 7), A(4, "check", "turn"), A(1, "bet", "turn", 46.2), A(2, "call", "turn", 46.2),
    A(4, "fold", "turn"),
  ],
  currentNode: { street: "river", toActSeatId: null, toActIsHero: false, pot: 0, toCall: 0, legalActions: [], complete: true },
  ended: true,
};
const at = (i: number) => withStartStacks(truncateAt(BRIEF_I_004, i));

/** hero's node of a stored walk, cut to what the detection reads */
const node = (actor: number, invested: number[], actions: [string, number][]) =>
  ({ si: 0, ti: 1, street: "FLOP" as const, board: "8h9h9c", codes: [], actor, potNode: 0, invested, taken: null, heroNode: true,
     actions: actions.map(([name, betsize]) => ({ name, code: name[0]!, betsize, position: "BB", totalFrequency: null, totalEv: null, strategy: [], evs: [] })) });
const walk = (kind: string, seats: [string, string, string], n: ReturnType<typeof node>, members?: Record<string, string[]>) =>
  ({ kind, members, trace: { spec: { oopPos: seats[0], midPos: seats[1], ipPos: seats[2] }, streets: [], nodes: [n] } as any });

const D9_MIX = [{ action: "FOLD" }, { action: "CALL 15" }, { action: "ALLIN 22" }];
const D9_WALKS = [
  walk("ghost:CO + ghost:BTN", ["SB", "BB", "UTG"], node(1, [15, 0, 0], [["FOLD", 0], ["CALL", 15], ["ALLIN", 22]])),
  walk("ghost:UTG + ghost:BTN", ["SB", "BB", "CO"], node(1, [15, 0, 0], [["FOLD", 0], ["CALL", 15], ["RAISE", 40.5], ["ALLIN", 97.5]])),
  walk("ghost:UTG + ghost:CO", ["SB", "BB", "BTN"], node(1, [15, 0, 0], [["FOLD", 0], ["CALL", 15], ["RAISE", 40.5], ["ALLIN", 97.5]])),
];

describe("the street's money at hero's node", () => {
  test("decision 9: hero 97.5 behind, nothing in; the SB's 15 jam is a full bet — the smallest raise is to 30", () => {
    const m = streetMoneyAt(at(9), "flop");
    expect(m.heroBehind).toBe(97.5);
    expect(m.heroCommitted).toBe(0);
    expect(m.level).toBe(15);
    expect(m.minRaiseTo).toBe(30);
    expect(Object.fromEntries(m.villains.map((v) => [v.pos, v.chips]))).toEqual({ CO: 97.5, BTN: 97.5, SB: 15, UTG: 22 });
  });
  test("decision 13: UTG's 22 jam is an incomplete raise — the last full raise stays 15", () => {
    const m = streetMoneyAt(at(13), "flop");
    expect(m.heroBehind).toBe(82.5);
    expect(m.heroCommitted).toBe(15);
    expect(m.level).toBe(22);
    expect(m.minRaiseTo).toBe(37);
  });
  test("an empty street: the smallest bet is 1bb", () => {
    expect(streetMoneyAt(at(14), "turn").minRaiseTo).toBe(1);
  });
});

describe("hero's all-in in a tree, in table terms", () => {
  test("a ghost tree: the betsize is the street total", () => {
    expect(treeAllInTo(D9_WALKS[0]!.trace.nodes[0], 0)).toBe(22);
  });
  test("a dead-money tree with hero's 15 preloaded: ALLIN 82.5 is his whole 97.5", () => {
    expect(treeAllInTo(node(0, [0, 22, 22], [["FOLD", 0], ["CALL", 22], ["ALLIN", 82.5]]), 15)).toBe(97.5);
  });
  test("no all-in at the node", () => {
    expect(treeAllInTo(node(1, [15, 15, 22], [["FOLD", 0], ["CALL", 22]]), 15)).toBeNull();
  });
});

describe("shortAllInPress — brief_I-004", () => {
  test("decision 9: ALLIN 22 with CO and BTN deeper outside the 22 tree → pressed as a raise, lifted to the table's minimum 30", () => {
    const money = streetMoneyAt(at(9), "flop");
    const p = shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: D9_WALKS.map((w) => pressTreeOf(w, money)) });
    expect(p).toHaveLength(1);
    const e = p[0]!;
    expect(e).toMatchObject({ action: "ALLIN 22", kind: "raise-to", amount: 30, verb: "raise", treeAmount: 22, heroAllIn: 97.5, minRaiseTo: 30, plan: "ghost:CO + ghost:BTN" });
    expect(e.outside).toEqual([{ pos: "CO", chips: 97.5 }, { pos: "BTN", chips: 97.5 }]);
    expect(e.trees).toEqual([{ plan: "ghost:CO + ghost:BTN", to: 22 }, { plan: "ghost:UTG + ghost:BTN", to: 97.5 }, { plan: "ghost:UTG + ghost:CO", to: 97.5 }]);
    expect(e.why).toContain("the tree's all-in is 22 (UTG's 22, the deepest seat it holds)");
    expect(e.why).toContain("CO (97.5) and BTN (97.5) are outside the tree and deeper");
    expect(e.why).toContain("a shove at the table would be 97.5");
    expect(e.why).toContain("the smallest is pressed");
    expect(pressNote(e)).toStartWith("SHOVE SIZED TO THE TREE: pressed as a raise to 30bb, not hero's 97.5bb — ");
  });
  test("a tree amount the table allows is pressed as it is (no lift)", () => {
    const money = { ...streetMoneyAt(at(9), "flop"), minRaiseTo: 20 };
    const e = shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [pressTreeOf(D9_WALKS[0]!, money)] })[0]!;
    expect(e.amount).toBe(22);
    expect(e.minRaiseTo).toBeUndefined();
    expect(e.trees).toBeUndefined();
    expect(e.why).not.toContain("lifted");
  });
  test("decision 13: the dead-money trees' ALLIN 82.5 is hero's whole 97.5 → no press", () => {
    const money = streetMoneyAt(at(13), "flop");
    const dm = (kind: string, seats: [string, string, string]) => walk(kind, seats, node(0, [0, 22, 22], [["FOLD", 0], ["CALL", 22], ["ALLIN", 82.5]]));
    const trees = [dm("dead:SB + dead:BTN (called level in the pot)", ["BB", "UTG", "CO"]), dm("dead:SB + dead:CO (called level in the pot)", ["BB", "UTG", "BTN"]),
      walk("dead:CO + dead:BTN", ["SB", "BB", "UTG"], node(1, [15, 15, 22], [["FOLD", 0], ["CALL", 22]]))].map((w) => pressTreeOf(w, money));
    expect(trees.map((t) => t.to)).toEqual([97.5, 97.5, null]);
    expect(shortAllInPress({ actions: [{ action: "FOLD" }, { action: "CALL 22" }, { action: "ALLIN 82.5" }], heroPos: "BB", money, trees })).toEqual([]);
  });
  test("the deeper seats are not live (folded) → no press", () => {
    const h = at(9);
    h.actions = [...h.actions, A(1, "fold", "flop"), A(2, "fold", "flop")];   // as if CO and BTN had folded before
    const money = streetMoneyAt(h, "flop");
    expect(shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [pressTreeOf(D9_WALKS[0]!, money)] })).toEqual([]);
  });
  test("the deeper seat is IN the tree (a merged seat holds CO) → the outside seat must still be deeper", () => {
    const money = streetMoneyAt(at(9), "flop");
    // UTG+CO merged in the tree: only BTN is outside — still deeper → press, naming BTN alone
    const merged = walk("merge:UTG+CO", ["SB", "BB", "UTG"], node(1, [15, 0, 0], [["FOLD", 0], ["CALL", 15], ["ALLIN", 22]]), { UTG: ["UTG", "CO"] });
    const p = shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [pressTreeOf(merged, money)] });
    expect(p[0]!.outside).toEqual([{ pos: "BTN", chips: 97.5 }]);
    // every live villain in the tree: nothing outside → no press
    const all = walk("merge:all", ["SB", "BB", "UTG"], node(1, [15, 0, 0], [["FOLD", 0], ["CALL", 15], ["ALLIN", 22]]), { UTG: ["UTG", "CO", "BTN"] });
    expect(shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [pressTreeOf(all, money)] })).toEqual([]);
  });
  test("outside villains no deeper than the tree's all-in → no press (a shove is the same raise)", () => {
    const money = streetMoneyAt(at(9), "flop");
    money.villains = money.villains.map((v) => (v.pos === "CO" || v.pos === "BTN" ? { ...v, chips: 22.3 } : v));
    expect(shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [pressTreeOf(D9_WALKS[0]!, money)] })).toEqual([]);
  });
  test("hero shorter than (or equal to) the tree's all-in → no press", () => {
    const money = { ...streetMoneyAt(at(9), "flop"), heroBehind: 22 };
    expect(shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [pressTreeOf(D9_WALKS[0]!, money)] })).toEqual([]);
    const money2 = { ...money, heroBehind: 22.4 };   // within 0.5bb
    expect(shortAllInPress({ actions: D9_MIX, heroPos: "BB", money: money2, trees: [pressTreeOf(D9_WALKS[0]!, money2)] })).toEqual([]);
  });
  test("the table's smallest raise is hero's whole stack → no sized raise exists, no press", () => {
    const money = { ...streetMoneyAt(at(9), "flop"), minRaiseTo: 97.3 };
    expect(shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [pressTreeOf(D9_WALKS[0]!, money)] })).toEqual([]);
  });
  test("no ALLIN in the mix, or no tree carrying one → no press", () => {
    const money = streetMoneyAt(at(9), "flop");
    expect(shortAllInPress({ actions: [{ action: "FOLD" }, { action: "CALL 15" }], heroPos: "BB", money, trees: [pressTreeOf(D9_WALKS[0]!, money)] })).toEqual([]);
    const none: TreeAllIn = { plan: null, seats: ["SB", "BB", "UTG"], to: null };
    expect(shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [none] })).toEqual([]);
  });
  test("the off switch: ALLIN_SIZE_TO_TREE=off → no press", () => {
    const money = streetMoneyAt(at(9), "flop");
    expect(shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: D9_WALKS.map((w) => pressTreeOf(w, money)), on: false })).toEqual([]);
    expect(allInSizeToTreeOn({ ALLIN_SIZE_TO_TREE: "off" })).toBe(false);
    expect(allInSizeToTreeOn({ ALLIN_SIZE_TO_TREE: "OFF " })).toBe(false);
    expect(allInSizeToTreeOn({})).toBe(true);
    expect(allInSizeToTreeOn({ ALLIN_SIZE_TO_TREE: "on" })).toBe(true);
  });
  test("a checked-to hero's short all-in is a BET to the amount", () => {
    const money = { heroCommitted: 0, heroBehind: 80, level: 0, minRaiseTo: 1, villains: [{ pos: "CO", chips: 80, seat: 1 }, { pos: "SB", chips: 10, seat: 3 }] };
    const e = shortAllInPress({ actions: [{ action: "CHECK" }, { action: "ALLIN 10" }], heroPos: "BB", money,
      trees: [{ plan: "ghost:CO", seats: ["SB", "BB"], to: 10 }] })[0]!;
    expect(e).toMatchObject({ verb: "bet", amount: 10, heroAllIn: 80 });
  });
});

describe("the note and the pick", () => {
  const money = streetMoneyAt(at(9), "flop");
  const press = shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: D9_WALKS.map((w) => pressTreeOf(w, money)) });
  test("pressForPick matches the label, case and spacing aside", () => {
    expect(pressForPick(press, "ALLIN 22")?.amount).toBe(30);
    expect(pressForPick(press, "allin  22")?.amount).toBe(30);
    expect(pressForPick(press, "CALL 15")).toBeNull();
    expect(pressForPick(null, "ALLIN 22")).toBeNull();
  });
  test("withPressNote opens the warning on the all-in pick, and takes it off again on another pick", () => {
    const w = "5-WAY APPROXIMATION — collapsed · STACKS OF THE PLAYERS IN THE TREE: …";
    const on = withPressNote(w, press, "ALLIN 22")!;
    expect(on).toStartWith("SHOVE SIZED TO THE TREE: pressed as a raise to 30bb, not hero's 97.5bb — ");
    expect(on.endsWith(` · ${w}`)).toBe(true);
    expect(withPressNote(on, press, "CALL 15")).toBe(w);
    expect(withPressNote(on, press, "ALLIN 22")).toBe(on);   // idempotent
    expect(withPressNote(null, press, "ALLIN 22")).toStartWith("SHOVE SIZED TO THE TREE:");
    expect(withPressNote(null, press, "CALL 15")).toBeNull();
  });
  test("the path reason is by-design, and the register knows its code and its note", () => {
    const r = pressReason(press, "flop");
    expect(r.v).toBe("by-design");
    expect(r.code).toBe("postflop:allin-sized-to-tree");
    expect(r.text).toContain("if ALLIN 22: raise to 30, not hero's 97.5");
    expect(departureForCode("postflop:allin-sized-to-tree")?.id).toBe("allin-sized-to-tree");
    expect(departureForWarning(pressNote(press[0]!))?.id).toBe("allin-sized-to-tree");
  });
});
