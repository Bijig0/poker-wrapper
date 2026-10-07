/**
 * THE SHORT ALL-IN PRESS (services/allInPress, 2026-10-07). Fixtures: stress-500 brief_I-004 — 5-way on 8h9h9c, the
 * 17.5bb SB jams 15, hero BB (Ts9s, 97.5 behind), UTG 24.5 / CO 100 / BTN 100 behind him. Decision 9 (hero facing the
 * 15 jam) was read on three ghost trees: ghost:CO+ghost:BTN (SB/BB/UTG — hero's all-in 22, UTG's stack), ghost:UTG+
 * ghost:BTN and ghost:UTG+ghost:CO (all-in 97.5). Decision 13 (hero called 15, UTG jammed 22, CO and BTN called) on
 * dead-money trees whose preload moved hero's 15 into the starting pot: the tree's "ALLIN 82.5" is 15 + 82.5 = his whole
 * 97.5 — not short. The node values are the stored traces' (stress DB solves 9087-9089, 9093-9095).
 * Brady 2026-10-07: a short all-in is pressed only when the tree's own amount is a legal raise at the table; under the
 * minimum (decision 9: 22 < 30) it is DROPPED from the mix and the pick re-rolled — never lifted, never the shove. And
 * every collapse stays in the blend, aligned by action class (codesOnRef) — decision 9's two trees that hold CO / BTN
 * (hero calls 99.9-100%) were being left out, so the served ALLIN 22 4.4% was the UTG tree alone.
 */
import { describe, expect, test } from "bun:test";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";
import {
  allInSizeToTreeOn, dropNote, dropShortAllIns, pressForPick, pressNote, pressReasons, shortAllInPress, streetMoneyAt, treeAllInTo, withPressNote,
  type PressEntry, type TreeAllIn,
} from "./allInPress";
import { codesOnRef, tableTotalActions } from "./deadMoneyCollapse";
import { alignStrategy, blendStrategies } from "./multiwayCollapse";
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

const D9_MIX = [{ action: "FOLD", frequency: 0 }, { action: "CALL 15", frequency: 95.56 }, { action: "ALLIN 22", frequency: 4.44 }];
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
  test("decision 9: ALLIN 22 with CO and BTN deeper outside the 22 tree, under the table's minimum raise 30 → DROPPED, never lifted", () => {
    const money = streetMoneyAt(at(9), "flop");
    const p = shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: D9_WALKS.map((w) => pressTreeOf(w, money)) });
    expect(p).toHaveLength(1);
    const e = p[0]!;
    expect(e).toMatchObject({ action: "ALLIN 22", kind: "dropped", share: 4.44, verb: "raise", treeAmount: 22, heroAllIn: 97.5, minRaiseTo: 30, plan: "ghost:CO + ghost:BTN" });
    expect(e.amount).toBeUndefined();
    expect(e.outside).toEqual([{ pos: "CO", chips: 97.5 }, { pos: "BTN", chips: 97.5 }]);
    expect(e.trees).toEqual([{ plan: "ghost:CO + ghost:BTN", to: 22 }, { plan: "ghost:UTG + ghost:BTN", to: 97.5 }, { plan: "ghost:UTG + ghost:CO", to: 97.5 }]);
    expect(e.why).toContain("the tree's all-in is 22 (UTG's 22, the deepest seat it holds)");
    expect(e.why).toContain("CO (97.5) and BTN (97.5) are outside the tree and deeper");
    expect(e.why).toContain("the table's smallest raise is to 30 (level 15), so 22 cannot be played there");
    expect(e.why).not.toContain("lifted");
    expect(e.why).toContain("the blended trees disagree (ghost:CO + ghost:BTN 22, ghost:UTG + ghost:BTN 97.5, ghost:UTG + ghost:CO 97.5) — the smallest is the one judged");
    expect(pressForPick(p, "ALLIN 22")).toBeNull();          // nothing to press: the wrapper never sees it as a pick
  });
  test("the drop: out of the mix, the rest re-spread to the mix's sum, the share recorded in the note", () => {
    const money = streetMoneyAt(at(9), "flop");
    const p = shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: D9_WALKS.map((w) => pressTreeOf(w, money)) });
    const d = dropShortAllIns(D9_MIX, p);
    expect(d.actions.map((x) => x.action)).toEqual(["FOLD", "CALL 15"]);
    expect(d.actions[1]!.frequency).toBeCloseTo(100, 6);
    expect(d.dropped).toBe(4.44);
    expect(d.toPassive).toBeNull();
    expect(dropNote(p[0]!, d.toPassive)).toStartWith("SHORT ALL-IN DROPPED: ALLIN 22 cannot be played at the table (minimum raise 30): dropped from the mix (its share 4.44%) and the pick re-rolled — ");
    // the all-in the whole mix: the passive action takes it all (a rare multiway spot leans conservative)
    const whole = dropShortAllIns([{ action: "FOLD", frequency: 0 }, { action: "CALL 15", frequency: 0 }, { action: "ALLIN 22", frequency: 100 }], p);
    expect(whole.actions).toEqual([{ action: "FOLD", frequency: 0 }, { action: "CALL 15", frequency: 100 }]);
    expect(whole.toPassive).toBe("CALL 15");
    expect(dropNote({ ...p[0]!, share: 100 }, whole.toPassive)).toContain("it was the whole mix, so CALL 15 takes it");
    // a raise-to entry drops nothing
    expect(dropShortAllIns(D9_MIX, [{ ...p[0]!, kind: "raise-to", amount: 22 }]).actions).toBe(D9_MIX);
  });
  test("a tree amount the table allows is pressed as it is (kind raise-to, its own amount)", () => {
    const money = { ...streetMoneyAt(at(9), "flop"), minRaiseTo: 20 };
    const e = shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [pressTreeOf(D9_WALKS[0]!, money)] })[0]!;
    expect(e).toMatchObject({ kind: "raise-to", amount: 22, minRaiseTo: 20 });
    expect(e.share).toBeUndefined();
    expect(e.trees).toBeUndefined();
    expect(e.why).not.toContain("cannot be played");
    expect(pressNote(e)).toStartWith("SHOVE SIZED TO THE TREE: pressed as a raise to 22bb, not hero's 97.5bb — ");
    expect(dropShortAllIns(D9_MIX, [e]).actions).toBe(D9_MIX);
  });
  test("decision 13: the dead-money trees' ALLIN 82.5 is hero's whole 97.5 → no press", () => {
    const money = streetMoneyAt(at(13), "flop");
    const dm = (kind: string, seats: [string, string, string]) => walk(kind, seats, node(0, [0, 22, 22], [["FOLD", 0], ["CALL", 22], ["ALLIN", 82.5]]));
    const trees = [dm("dead:SB + dead:BTN (called level in the pot)", ["BB", "UTG", "CO"]), dm("dead:SB + dead:CO (called level in the pot)", ["BB", "UTG", "BTN"]),
      walk("dead:CO + dead:BTN", ["SB", "BB", "UTG"], node(1, [15, 15, 22], [["FOLD", 0], ["CALL", 22]]))].map((w) => pressTreeOf(w, money));
    expect(trees.map((t) => t.to)).toEqual([97.5, 97.5, null]);
    expect(shortAllInPress({ actions: [{ action: "FOLD" }, { action: "CALL 22" }, { action: "ALLIN 82.5" }], heroPos: "BB", money, trees })).toEqual([]);
  });
  test("decision 13 with the dead-money pot fixed (2026-10-07): UTG's all-in sent as the 7 over his preloaded 15 — hero faces CALL 7, still no press", () => {
    // the called-level trees as the chain now walks them (deadMoneyCollapse.treeAllInAmounts): BB X, UTG all in for 7, CO
    // calls 7 — hero 0 in the tree, his ALLIN his 82.5 tree stack = 15 + 82.5 = his whole 97.5 at the table
    const money = streetMoneyAt(at(13), "flop");
    const dm = (kind: string, seats: [string, string, string]) => walk(kind, seats, node(0, [0, 7, 7], [["FOLD", 0], ["CALL", 7], ["ALLIN", 82.5]]));
    const trees = [dm("dead:SB + dead:BTN (called level in the pot)", ["BB", "UTG", "CO"]), dm("dead:SB + dead:CO (called level in the pot)", ["BB", "UTG", "BTN"]),
      walk("dead:CO + dead:BTN", ["SB", "BB", "UTG"], node(1, [15, 15, 22], [["FOLD", 0], ["CALL", 7]]))].map((w) => pressTreeOf(w, money));
    expect(trees.map((t) => t.to)).toEqual([97.5, 97.5, null]);
    expect(shortAllInPress({ actions: [{ action: "FOLD" }, { action: "CALL 7" }, { action: "ALLIN 82.5" }], heroPos: "BB", money, trees })).toEqual([]);
  });
  test("decision 13 served in TABLE totals (tableTotalActions): ALLIN 97.5 — still no press, the preload never added twice", () => {
    const money = streetMoneyAt(at(13), "flop");
    const dm = (kind: string, seats: [string, string, string]) => walk(kind, seats, node(0, [0, 7, 7], [["FOLD", 0], ["CALL", 7], ["RAISE", 76.3], ["ALLIN", 82.5]]));
    const trees = [dm("dead:SB + dead:BTN (called level in the pot)", ["BB", "UTG", "CO"]), dm("dead:SB + dead:CO (called level in the pot)", ["BB", "UTG", "BTN"])]
      .map((w) => pressTreeOf(w, money));
    expect(trees.map((t) => t.to)).toEqual([97.5, 97.5]);   // from the trace (tree terms) + hero's 15 on the street, once
    const served = tableTotalActions([{ action: "FOLD", frequency: 0, betsize: "0" }, { action: "CALL 7", frequency: 100, betsize: "7.000" },
      { action: "RAISE 76.3", frequency: 0, betsize: "76.3" }, { action: "ALLIN 82.5", frequency: 0, betsize: "82.500" }], 15);
    expect(served.map((a) => a.action)).toEqual(["FOLD", "CALL 22", "RAISE 91.3", "ALLIN 97.5"]);
    expect(shortAllInPress({ actions: served, heroPos: "BB", money, trees })).toEqual([]);
  });
  test("a SHORT all-in on a preloaded tree: the press entry carries the SERVED label and the table amount (no double preload)", () => {
    // hypothetical: the tree caps hero at 30 over his preloaded 15 (table 45 < his 97.5), BTN deeper outside the tree
    const money = streetMoneyAt(at(13), "flop");
    const w = walk("dead:SB + dead:BTN (called level in the pot)", ["BB", "UTG", "CO"], node(0, [0, 7, 7], [["FOLD", 0], ["CALL", 7], ["ALLIN", 30]]));
    const served = tableTotalActions([{ action: "FOLD", frequency: 50, betsize: "0" }, { action: "CALL 7", frequency: 40, betsize: "7.000" },
      { action: "ALLIN 30", frequency: 10, betsize: "30.000" }], 15);
    const p = shortAllInPress({ actions: served, heroPos: "BB", money, trees: [pressTreeOf(w, money)] });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ action: "ALLIN 45", kind: "raise-to", amount: 45, treeAmount: 45, heroAllIn: 97.5, minRaiseTo: 37 });
    expect(pressForPick(p, "ALLIN 45")).toBe(p[0]!);   // the wrapper matches the entry to the served pick
    expect(pressForPick(p, "ALLIN 30")).toBeNull();
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
  test("the table's smallest raise is hero's whole stack → no sized raise exists: dropped", () => {
    const money = { ...streetMoneyAt(at(9), "flop"), minRaiseTo: 97.3 };
    expect(shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: [pressTreeOf(D9_WALKS[0]!, money)] })[0]?.kind).toBe("dropped");
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
    expect(e).toMatchObject({ kind: "raise-to", verb: "bet", amount: 10, heroAllIn: 80 });
  });
});

describe("the note and the pick", () => {
  // the same spot with a table minimum the tree's 22 clears (a raise-to entry)
  const money = { ...streetMoneyAt(at(9), "flop"), minRaiseTo: 20 };
  const press = shortAllInPress({ actions: D9_MIX, heroPos: "BB", money, trees: D9_WALKS.map((w) => pressTreeOf(w, money)) });
  test("pressForPick matches the label, case and spacing aside", () => {
    expect(pressForPick(press, "ALLIN 22")?.amount).toBe(22);
    expect(pressForPick(press, "allin  22")?.amount).toBe(22);
    expect(pressForPick(press, "CALL 15")).toBeNull();
    expect(pressForPick(null, "ALLIN 22")).toBeNull();
  });
  test("withPressNote opens the warning on the all-in pick, and takes it off again on another pick", () => {
    const w = "5-WAY APPROXIMATION — collapsed · STACKS OF THE PLAYERS IN THE TREE: …";
    const on = withPressNote(w, press, "ALLIN 22")!;
    expect(on).toStartWith("SHOVE SIZED TO THE TREE: pressed as a raise to 22bb, not hero's 97.5bb — ");
    expect(on.endsWith(` · ${w}`)).toBe(true);
    expect(withPressNote(on, press, "CALL 15")).toBe(w);
    expect(withPressNote(on, press, "ALLIN 22")).toBe(on);   // idempotent
    expect(withPressNote(null, press, "ALLIN 22")).toStartWith("SHOVE SIZED TO THE TREE:");
    expect(withPressNote(null, press, "CALL 15")).toBeNull();
    // a drop note stays whatever the pick
    const drop = `SHORT ALL-IN DROPPED: ALLIN 22 … · ${w}`;
    expect(withPressNote(drop, press, "CALL 15")).toBe(drop);
  });
  test("the path reasons are by-design, and the register knows the codes and the notes", () => {
    const [r] = pressReasons(press, "flop");
    expect(r!.v).toBe("by-design");
    expect(r!.code).toBe("postflop:allin-sized-to-tree");
    expect(r!.text).toContain("if ALLIN 22: raise to 22, not hero's 97.5");
    const dropped: PressEntry = { ...press[0]!, kind: "dropped", amount: undefined, share: 4.44, minRaiseTo: 30 };
    const [rd] = pressReasons([dropped], "flop");
    expect(rd).toMatchObject({ v: "by-design", code: "postflop:short-allin-dropped" });
    expect(rd!.text).toContain("ALLIN 22 dropped from the mix (share 4.44%)");
    expect(departureForCode("postflop:allin-sized-to-tree")?.id).toBe("allin-sized-to-tree");
    expect(departureForCode("postflop:short-allin-dropped")?.id).toBe("allin-sized-to-tree");
    expect(departureForWarning(pressNote(press[0]!))?.id).toBe("allin-sized-to-tree");
    expect(departureForWarning(dropNote(dropped, null))?.id).toBe("allin-sized-to-tree");
    expect(departureForWarning("ALIGNED BY ACTION CLASS: ghost:UTG + ghost:BTN (RAISE 40.5→ALLIN 22)")?.id).toBe("field-cap-3");
  });
});

/** a node menu as GTO Wizard sends it (code, display name) with one combo's strategy */
const sols = (xs: [string, string, number][]) => xs.map(([code, name, f]) => ({ code, name, f }));

describe("every collapse stays in the blend, aligned by action class (codesOnRef)", () => {
  test("brief_I-004 decision 9: the CO / BTN trees (RAISE 40.5 and an ALLIN of 97.5) align onto the UTG tree's menu; hero's ALLIN blends to 0", () => {
    // the UTG tree (the reference): F / C / ALLIN 22 — code R97.5, betsize 22; hero Ts9s calls 95.56%, shoves 4.44%
    const ref = sols([["F", "FOLD", 0], ["C", "CALL", 0.9556], ["R97.5", "ALLIN", 0.0444]]);
    // the trees keeping CO and BTN: hero calls 99.9-100% (stress DB 9088 / 9089)
    const co = sols([["F", "FOLD", 0], ["C", "CALL", 0.999], ["R40.5", "RAISE", 0.0005], ["R97.5", "ALLIN", 0.0005]]);
    const btn = sols([["F", "FOLD", 0], ["C", "CALL", 1], ["R40.5", "RAISE", 0], ["R97.5", "ALLIN", 0]]);
    const codes = ref.map((x) => x.code);
    // by exact code they could never align (R40.5 is not on the reference menu) — that is how they were left out
    expect(alignStrategy(codes, co.map((x) => ({ code: x.code, strategy: [x.f] })))).toBeNull();
    const on = (m: typeof ref) => { const c = codesOnRef(ref, m); return alignStrategy(codes, m.map((x, i) => ({ code: c.codes[i] ?? `${x.code}?`, strategy: [x.f] }))); };
    expect(codesOnRef(ref, co)).toEqual({ codes: ["F", "C", "R97.5", "R97.5"], byClass: true });
    const blended = blendStrategies(codes, [on(ref)!, on(co)!, on(btn)!]);
    expect(blended[2]![0]).toBe(0);                    // the all-in: as often as the least shoving collapse
    expect(blended[1]![0]).toBeCloseTo(1, 9);          // the call takes the rest
  });
  test("the 11 live cases' shape (4919957671 turn AcAh: CO trees bet 2.3 81%, BTN trees check 100%; sizes illustrative) → aligned, the bet blends to 0", () => {
    const ref = sols([["X", "CHECK", 0.19], ["B2.3", "BET", 0.81], ["B5.6", "BET", 0], ["R48.2", "ALLIN", 0]]);
    const btn = sols([["X", "CHECK", 1], ["B2.6", "BET", 0], ["B6.1", "BET", 0], ["R52.4", "ALLIN", 0]]);
    const codes = ref.map((x) => x.code);
    const c = codesOnRef(ref, btn);
    expect(c).toEqual({ codes: ["X", "B2.3", "B5.6", "R48.2"], byClass: true });
    const a = alignStrategy(codes, btn.map((x, i) => ({ code: c.codes[i]!, strategy: [x.f] })))!;
    const r = alignStrategy(codes, ref.map((x) => ({ code: x.code, strategy: [x.f] })))!;
    const b = blendStrategies(codes, [r, a]);
    expect(b.map((x) => x[0])).toEqual([1, 0, 0, 0]);
  });
  test("identical menus keep their own codes (nothing changes where the exact blend already worked); dead-money trees always by class", () => {
    const ref = sols([["F", "FOLD", 0], ["C", "CALL", 1], ["R30", "RAISE", 0]]);
    expect(codesOnRef(ref, ref)).toEqual({ codes: ["F", "C", "R30"], byClass: false });
    expect(codesOnRef(ref, ref, true).byClass).toBe(true);
  });
  test("a class the reference has nothing of still cannot be aligned (that collapse is left out, said)", () => {
    const ref = sols([["F", "FOLD", 0], ["C", "CALL", 1]]);
    const other = sols([["F", "FOLD", 0], ["C", "CALL", 0.9], ["R40", "RAISE", 0.1]]);
    expect(codesOnRef(ref, other).codes).toEqual(["F", "C", null]);
  });
});
