import { describe, expect, it } from "bun:test";
import { classesToCombos, combosToClasses, forcedHandOf, normalised, normalisedCombos, planReducedArrival, readCaller, type ReducedCaller } from "./reducedArrival";
import { COMBOS } from "../comboIndex/comboIndex";
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE REDUCED TREE's plan and read (2026-10-01, hand 4921846667 — see reducedArrival.ts). The fixtures are that hand
 * and its neighbours: the same table with the BB calling too, the limper as the re-raiser (the raiser out of
 * position), four to the flop, a short caller all in, and the lines that have no reduced tree.
 */

const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as const;
const a = (type: string, seatId: number, amount?: number, street = "preflop") =>
  ({ seatId, hero: seatId === 2, type, street, ...(amount != null ? { amount } : {}) });
const hand = (actions: any[], extra: Partial<ParsedHand> = {}): ParsedHand => ({
  handId: 66, clientHandId: "4921846667", bbCents: 5, heroSeatId: 2, heroCards: ["7s", "7c"], board: ["Ks", "9s", "Qd"], street: "flop",
  actions, liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { ...POS },
  stacks: { 1: 73.9, 2: 135.9, 3: 95.5, 4: 28.5, 5: 112.1, 6: 50.5 },
  currentNode: { street: "flop", toActSeatId: 2, toActIsHero: true, pot: 78.2, toCall: 32.6, legalActions: [], complete: false }, ended: false,
  ...extra,
} as unknown as ParsedHand);

const OPENING = [a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("call", 1, 1), a("call", 2, 1), a("raise", 3, 5), a("fold", 4), a("fold", 5)];
/** the hand as played: BB and UTG call the iso, hero limp-reraises to 17.6, CO and BB fold, UTG calls */
const REAL = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("fold", 6), a("call", 1, 12.6), a("bet", 1, 32.6, "flop")]);
/** the BB calls the limp-reraise too: three to the flop */
const THREE = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("call", 6, 12.6), a("call", 1, 12.6)]);
/** UTG is the limp-reraiser, hero calls: the raiser is out of position */
const UTG_RERAISES = hand([...OPENING, a("fold", 6), a("raise", 1, 17.6), a("call", 2, 16.6), a("fold", 3)]);
/** UTG limp-reraises, hero and then the BB call */
const MIDDLE = hand([...OPENING, a("call", 6, 4), a("raise", 1, 17.6), a("call", 2, 16.6), a("fold", 3), a("call", 6, 12.6)]);
/** four to the flop: the CO, the BB and UTG all call hero's limp-reraise */
const FOUR = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("call", 3, 12.6), a("call", 6, 12.6), a("call", 1, 12.6)]);

const plan = (h: ParsedHand) => {
  const p = planReducedArrival(h, "HJ");
  if (!p.ok) throw new Error(p.reason);
  return p;
};
const brief = (c: ReducedCaller) => `${c.pos}: had ${c.prior} in, ${c.toCall} to call into ${c.potBefore} (${c.deadBb} dead) · raiser ${c.raiserInPosition ? "in" : "out of"} position → ${c.tree.raiser} posts ${c.tree.raiserPost}, ${c.tree.caller} posts ${c.tree.callerPost}`;

describe("planReducedArrival", () => {
  it("the hand as played: hero raised to 17.6 with 1 in; UTG had 5 in and met it for 12.6 into 33, 10.4 of it dead", () => {
    const p = plan(REAL);
    expect(p.live).toEqual(["UTG", "HJ"]);                    // postflop order: UTG acts first
    expect(p.potBb).toBe(45.6);
    expect(p.raiser).toEqual({ seat: 2, pos: "HJ", putIn: 17.6, prior: 1 });
    expect(p.raiseTo).toBe(17.6);
    expect(REAL.actions[p.raiseIndex]).toMatchObject({ type: "raise", seatId: 2 });
    // the raiser acts after UTG on the flop: he is the tree's SB (its button), UTG its BB — each posting what he had in
    expect(p.callers.map(brief)).toEqual(["UTG: had 5 in, 12.6 to call into 33 (10.4 dead) · raiser in position → SB posts 17.6, BB posts 5"]);
    // the tree's pot once he calls is the table's flop pot
    const c = p.callers[0]!;
    expect(c.tree.raiserPost + c.tree.callerPost + c.toCall + c.deadBb).toBeCloseTo(p.potBb, 5);
  });

  it("the raiser out of position: the caller is the tree's SB (in position) and acts at its root", () => {
    const p = plan(UTG_RERAISES);
    expect(p.raiser).toMatchObject({ pos: "UTG", prior: 1, putIn: 17.6 });
    expect(p.callers.map(brief)).toEqual(["HJ: had 1 in, 16.6 to call into 25 (6.4 dead) · raiser out of position → BB posts 17.6, SB posts 1"]);
  });

  it("three to the flop: one tree per caller — a later caller's pot holds the earlier caller's chips as dead money", () => {
    const p = plan(THREE);
    expect(p.live).toEqual(["BB", "UTG", "HJ"]);
    expect(p.callers.map(brief)).toEqual([
      "BB: had 5 in, 12.6 to call into 33 (10.4 dead) · raiser in position → SB posts 17.6, BB posts 5",
      "UTG: had 5 in, 12.6 to call into 45.6 (23 dead) · raiser in position → SB posts 17.6, BB posts 5",
    ]);
    expect(p.potBb).toBe(58.2);
  });

  it("the raiser between two callers: each caller seated by HIS position against the raiser", () => {
    const p = plan(MIDDLE);
    expect(p.raiser.pos).toBe("UTG");
    expect(p.callers.map(brief)).toEqual([
      "BB: had 5 in, 12.6 to call into 45.6 (23 dead) · raiser in position → SB posts 17.6, BB posts 5",      // called second, after hero
      "HJ: had 1 in, 16.6 to call into 29 (10.4 dead) · raiser out of position → BB posts 17.6, SB posts 1",
    ]);
  });

  it("four to the flop: three callers, three trees, every live seat accounted for", () => {
    const p = plan(FOUR);
    expect(p.live).toEqual(["BB", "UTG", "HJ", "CO"]);
    expect([p.raiser.pos, ...p.callers.map((c) => c.pos)].sort()).toEqual([...p.live].sort());
    expect(p.callers.map(brief)).toEqual([
      "BB: had 5 in, 12.6 to call into 45.6 (23 dead) · raiser in position → SB posts 17.6, BB posts 5",
      "UTG: had 5 in, 12.6 to call into 58.2 (35.6 dead) · raiser in position → SB posts 17.6, BB posts 5",
      "CO: had 5 in, 12.6 to call into 33 (10.4 dead) · raiser out of position → BB posts 17.6, SB posts 5",   // the CO called first
    ]);
  });

  it("a caller all in for less: what the call cost him is what he had left, the pot he met is the same", () => {
    const short = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("fold", 6), a("all-in", 1, 12)]);
    const p = plan(short);
    expect(REAL.actions[p.raiseIndex]).toMatchObject({ seatId: 2 });        // the all-in for less than the price is a call, not the last raise
    expect(p.callers.map(brief)).toEqual(["UTG: had 5 in, 7 to call into 33 (10.4 dead) · raiser in position → SB posts 17.6, BB posts 5"]);
  });

  it("a raiser with nothing in before his raise; a caller with nothing in yet posts the tree's minimum", () => {
    // UTG opens, hero calls, the BTN squeezes to 11 (his first chip), both call
    const squeeze = plan(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("raise", 1, 2.5), a("call", 2, 2.5), a("fold", 3), a("raise", 4, 11), a("fold", 5), a("fold", 6), a("call", 1, 8.5), a("call", 2, 8.5)]));
    expect(squeeze.raiser).toMatchObject({ pos: "BTN", prior: 0, putIn: 11 });
    expect(squeeze.callers.map((c) => `${c.pos}:${c.tree.callerPost}`)).toEqual(["UTG:2.5", "HJ:2.5"]);
    // UTG opens, hero 3-bets to 9, the CO cold-calls with nothing in, UTG calls
    const cold = plan(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("raise", 1, 2.5), a("raise", 2, 9), a("call", 3, 9), a("fold", 4), a("fold", 5), a("fold", 6), a("call", 1, 6.5)]));
    expect(cold.callers.map(brief)).toEqual([
      "UTG: had 2.5 in, 6.5 to call into 21.9 (10.4 dead) · raiser in position → SB posts 9, BB posts 2.5",
      "CO: had 0 in, 9 to call into 12.9 (3.9 dead) · raiser out of position → BB posts 9, SB posts 0.01",
    ]);
    // a blind who had only his blind in
    const bb = plan(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("raise", 1, 2.5), a("fold", 2), a("fold", 3), a("raise", 4, 9), a("fold", 5), a("call", 6, 8), a("call", 1, 6.5)]));
    expect(bb.callers.map(brief)[0]).toBe("BB: had 1 in, 8 to call into 12.9 (2.9 dead) · raiser in position → SB posts 9, BB posts 1");
  });

  it("has no reduced tree: a limped pot, one player left, a raiser who is not there", () => {
    const limped = planReducedArrival(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("call", 1, 1), a("call", 2, 1), a("fold", 3), a("fold", 4), a("call", 5, 0.6), a("check", 6)]), "HJ");
    expect(limped.ok).toBe(false);
    if (!limped.ok) expect(limped.reason).toContain("nobody raised");
    const walk = planReducedArrival(hand([a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("raise", 2, 2.5), a("fold", 1), a("fold", 3), a("fold", 4), a("fold", 5), a("fold", 6)]), "HJ");
    expect(walk.ok).toBe(false);
  });
});

describe("forcedHandOf", () => {
  it("the caller and the raiser on the heads-up set, the two posts as its blinds, hero kept as hero", () => {
    const p = plan(REAL);
    const r = forcedHandOf(REAL, p, p.callers[0]!);
    expect(r.positions).toEqual({ 2: "SB", 1: "BB" });
    expect(r.heroSeatId).toBe(2);
    expect(r.actions.map((x) => `${x.seatId}:${x.type} ${x.amount}${x.hero ? " (hero)" : ""}`)).toEqual(["2:post-sb 17.6 (hero)", "1:post-bb 5"]);
    expect(r.liveSeats).toEqual([2, 1]);
    expect(r.currentNode.street).toBe("preflop");
  });
  it("the raiser out of position posts the tree's BB; a pair without hero has the raiser stand in", () => {
    const p = plan(UTG_RERAISES);
    const r = forcedHandOf(UTG_RERAISES, p, p.callers[0]!);
    expect(r.positions).toEqual({ 2: "SB", 1: "BB" });
    expect(r.actions.map((x) => `${x.seatId}:${x.type} ${x.amount}`)).toEqual(["2:post-sb 1", "1:post-bb 17.6"]);
    const m = plan(MIDDLE);                                    // UTG raised; the BB's tree holds no hero
    const bb = forcedHandOf(MIDDLE, m, m.callers.find((c) => c.pos === "BB")!);
    expect(bb.heroSeatId).toBe(1);
    expect(bb.positions).toEqual({ 1: "SB", 6: "BB" });
  });
});

const arr = (v: number | ((cls: string) => number)) => COMBOS.map((c) => (typeof v === "number" ? v : v(c.cls)));
const node = (actor: string, actions: { code: string; type?: string; allin?: boolean; freq?: number; strategy: number[] }[]) => ({
  data: {
    game: { players: [{ position: actor, is_hero: true }] },
    action_solutions: actions.map((x) => ({
      action: { code: x.code, type: x.type ?? (x.code[0] === "R" ? "RAISE" : x.code === "C" ? "CALL" : x.code === "X" ? "CHECK" : "FOLD"), allin: !!x.allin },
      total_frequency: x.freq ?? 0, strategy: x.strategy,
    })),
  },
});
const getter = (nodes: Record<string, any>) => async (l: string) => nodes[l] ?? { error: `no node ${l}` };

describe("readCaller", () => {
  const ip = plan(REAL).callers[0]!;                          // the raiser in position: the caller is behind his check
  const oop = plan(UTG_RERAISES).callers[0]!;                 // the raiser out of position: the caller is at the root

  it("the raiser out of position: the caller's node is the root — every hand that does not fold stays", async () => {
    const r = await readCaller(oop, getter({
      "": node("SB", [
        { code: "F", freq: 0.28, strategy: arr((c) => (c === "72o" ? 1 : c === "T9s" ? 0.4 : 0)) },
        { code: "C", freq: 0.0, strategy: arr(0) },
        { code: "R44", freq: 0.03, strategy: arr((c) => (c === "T9s" ? 0.6 : 0)) },
        { code: "R91.5", allin: true, freq: 0.69, strategy: arr((c) => (c === "72o" || c === "T9s" ? 0 : 1)) },
      ]),
    }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.line).toBe("");
    const at = (cls: string) => r.stays[COMBOS.findIndex((c) => c.cls === cls)];
    expect(at("72o")).toBe(0);
    expect(at("T9s")).toBeCloseTo(0.6, 5);
    expect(at("AA")).toBe(1);                                  // the solver shoves it; the player called — it stays
    expect([r.fold, r.call, r.raise]).toEqual([28, 0, 72]);
  });

  it("the raiser in position: he checks first (his all-in, when the tree adds one, is not walked), then the caller", async () => {
    const r = await readCaller(ip, getter({
      "": node("SB", [{ code: "X", freq: 0.7, strategy: arr(0.7) }, { code: "R153.5", allin: true, freq: 0.3, strategy: arr(0.3) }]),
      "X": node("BB", [{ code: "F", freq: 0.12, strategy: arr((c) => (c === "72o" ? 1 : 0.1)) }, { code: "C", freq: 0.25, strategy: arr(0.3) }, { code: "R91.5", allin: true, freq: 0.63, strategy: arr(0.6) }]),
    }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.line).toBe("X");
    expect(r.stays[COMBOS.findIndex((c) => c.cls === "AA")]).toBeCloseTo(0.9, 5);
    expect(r.stays[COMBOS.findIndex((c) => c.cls === "72o")]).toBe(0);
    expect([r.fold, r.call, r.raise]).toEqual([12, 25, 63]);
  });

  it("refuses out loud: the wrong seat to act, no check for the raiser, a node the tree does not have", async () => {
    const wrongRoot = await readCaller(oop, getter({ "": node("BB", [{ code: "F", strategy: arr(1) }]) }));
    expect(wrongRoot.ok).toBe(false);
    if (!wrongRoot.ok) expect(wrongRoot.reason).toContain("not the caller's seat (SB)");
    const noCheck = await readCaller(ip, getter({ "": node("SB", [{ code: "R153.5", allin: true, strategy: arr(1) }]) }));
    expect(noCheck.ok).toBe(false);
    if (!noCheck.ok) expect(noCheck.reason).toContain("no check at the root");
    const missing = await readCaller(ip, getter({ "": node("SB", [{ code: "X", strategy: arr(1) }]) }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("the node behind the raiser's check");
    const dead = await readCaller(oop, getter({}));
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.reason).toContain("reduced tree (HJ): the root");
  });
});

describe("range helpers", () => {
  it("normalised: the heaviest class becomes 1, the composition is kept, zeros dropped", () => {
    expect(normalised({ AQs: 0.2545, "77": 0.1798, "72o": 0 })).toEqual({ AQs: 1, "77": 0.7065 });
    expect(normalised({})).toEqual({});
  });
  it("classesToCombos / combosToClasses / normalisedCombos", () => {
    const w = classesToCombos({ "77": 0.5 })!;
    expect(w.length).toBe(1326);
    expect(w.filter((x) => x > 0).length).toBe(6);
    expect(w.every((x, i) => (COMBOS[i]!.cls === "77" ? x === 0.5 : x === 0))).toBe(true);
    expect(classesToCombos(null)).toBeNull();
    expect(classesToCombos({ "77": 0 })).toBeNull();
    expect(combosToClasses(w)).toEqual({ "77": 0.5 });
    expect(normalisedCombos(w)!.filter((x) => x === 1).length).toBe(6);
    expect(normalisedCombos(new Array(1326).fill(0))).toBeNull();
  });
});
