import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { actorsOf, solveAiChain, StreetState, type AiChainSpec } from "./aiChain";

describe("StreetState", () => {
  it("heads-up: check-check closes, bet-call closes, a bet re-opens", () => {
    const s = new StreetState(2);
    expect(s.actor).toBe(0);
    s.apply("Check"); expect(s.closed).toBe(false); expect(s.actor).toBe(1);
    s.apply("Check"); expect(s.closed).toBe(true);
    const t = new StreetState(2);
    t.apply("Check"); t.apply("Bet", 3);
    expect(t.closed).toBe(false); expect(t.actor).toBe(0); expect(t.outstanding).toBe(3);
    t.apply("Call"); expect(t.closed).toBe(true); expect(t.potIn).toBe(6);
  });

  it("three-way: X-X-R2.5-F leaves OOP+1 facing the bet (the probe of 2026-09-19)", () => {
    const s = new StreetState(3);
    s.apply("Check"); s.apply("Check"); s.apply("Bet", 2.5);
    expect(s.actor).toBe(0);
    s.apply("Fold");
    expect(s.live).toEqual([1, 2]);
    expect(s.actor).toBe(1);
    expect(s.closed).toBe(false);
    expect(s.inv).toEqual([0, 0, 2.5]);
  });

  it("three-way: X-X-R2.5-C-F closes the street with two left", () => {
    const s = new StreetState(3);
    s.apply("Check"); s.apply("Check"); s.apply("Bet", 2.5); s.apply("Call"); s.apply("Fold");
    expect(s.closed).toBe(true);
    expect(s.live).toEqual([0, 2]);
    expect(s.potIn).toBe(5);
  });

  it("three-way: the last seat folding wraps the pointer to the first", () => {
    const s = new StreetState(3);
    s.apply("Bet", 2); s.apply("Call");
    expect(s.actor).toBe(2);
    s.apply("Fold");
    expect(s.actor).toBe(0);
    expect(s.closed).toBe(true);   // OOP bet, OOP+1 called, IP folded: nobody owes an action
  });

  it("refuses a wager that is not over the outstanding amount", () => {
    const s = new StreetState(2);
    s.apply("Bet", 3);
    expect(() => s.apply("Raise", 2)).toThrow();
  });
});

describe("actorsOf", () => {
  it("rotates three seats through a fold", () => {
    expect(actorsOf(["Check", "Check", "Bet(250)", "Fold", "Raise(1000)"], 3)).toEqual([0, 1, 2, 0, 1]);
  });
  it("alternates heads-up", () => {
    expect(actorsOf(["Check", "Bet(300)", "Raise(900)", "Call"], 2)).toEqual([0, 1, 0, 1]);
  });
});

/**
 * The walker against a scripted GTO Wizard: nodes keyed by (tree, actions). Each node says who acts, as the
 * real API does (game.players[].is_hero), and offers the actions the line needs.
 */
const full = () => new Array(1326).fill(1);
const half = () => new Array(1326).fill(0.5);
type Node = { toAct: string; acts: { code: string; name: string; betsize?: number }[] };
const nodeJson = (nd: Node) => ({
  game: { players: [{ position: nd.toAct, is_hero: true }] },
  action_solutions: nd.acts.map((a) => ({
    action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: nd.toAct },
    total_frequency: 0.5, total_ev: 0, strategy: half(), evs: half(),
  })),
});
const X = { code: "X", name: "Check" };
const F = { code: "F", name: "Fold" };
const C = (b: number) => ({ code: "C", name: "Call", betsize: b });
const B = (b: number) => ({ code: `R${b}`, name: "Bet", betsize: b });
const R = (b: number) => ({ code: `R${b}`, name: "Raise", betsize: b });

function script(nodes: Record<string, Node>) {
  const trees: any[] = [];
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode };
  api.ensureCustomSolution = async (input: any) => { trees.push(input); return { ok: true, solId: `sol-${input.startingStreet}`, created: true }; };
  api.customNode = async (solId: string, q: any) => {
    const acts = q.flopActions ?? q.turnActions ?? q.riverActions ?? "";
    const nd = nodes[`${solId}|${acts}`];
    if (!nd) return { ok: false, status: 404, error: `unscripted node ${solId}|${acts}` };
    return { ok: true, data: nodeJson(nd), solveSecs: 0, cached: false };
  };
  return { trees, restore: () => { api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; } };
}

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

// Hand 4919080309 (dashboard #396): CO opens, SB calls, BB (hero) calls → three-way flop 2s3sQd, pot 7.5.
const base: Omit<AiChainSpec, "streets"> = {
  oopPos: "SB", midPos: "BB", ipPos: "CO",
  oopRange: full(), midRange: full(), ipRange: full(),
  flopPot: 7.5, flopStack: 97.5, board: "2s3sQdJs", heroSeat: "mid", heroComboIdx: null,
};

describe("solveAiChain three-way", () => {
  it("reaches hero's flop node after OOP checks, with a 3-seat tree", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "SB", acts: [X, B(2.5)] },
      "sol-FLOP|X": { toAct: "BB", acts: [X, B(2.5)] },
    });
    restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X"]] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.potNode).toBe(7.5);
    expect(s.trees).toHaveLength(1);
    expect(s.trees[0].mid).toEqual({ pos: "BB", range: expect.any(Array) });
    expect(r.trace.streets[0]!.players).toEqual(["SB", "BB", "CO"]);
    expect(r.trace.nodes.at(-1)!.heroNode).toBe(true);
    expect(r.trace.nodes.at(-1)!.actor).toBe(1);
  });

  it("walks flop X-X-X then turn X-X-R4.71-F to hero facing the bet, pot rolled to 12.21", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "SB", acts: [X, B(2.5)] },
      "sol-FLOP|X": { toAct: "BB", acts: [X, B(2.5)] },
      "sol-FLOP|X-X": { toAct: "CO", acts: [X, B(2.5)] },
      "sol-TURN|": { toAct: "SB", acts: [X, B(2.5)] },
      "sol-TURN|X": { toAct: "BB", acts: [X, B(2.5)] },
      "sol-TURN|X-X": { toAct: "CO", acts: [X, B(4.71)] },
      "sol-TURN|X-X-R4.71": { toAct: "SB", acts: [F, C(4.71), R(14)] },
      "sol-TURN|X-X-R4.71-F": { toAct: "BB", acts: [F, C(4.71), R(14)] },
    });
    restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X", "X", "X"], ["X", "X", "R4.71", "F"]] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.potNode).toBe(12.21);
    expect(r.solves).toBe(2);
    expect(s.trees[1].startingStreet).toBe("TURN");
    expect(s.trees[1].fixedLevels).toEqual({ TURN: ["62.8%"] });   // 4.71 / 7.5
    expect(s.trees[1].mid).toBeDefined();                            // still three seats entering the turn
    const hero = r.trace.nodes.at(-1)!;
    expect(hero.heroNode).toBe(true);
    expect(hero.invested).toEqual([0, 0, 4.71]);
    expect(r.trace.nodes).toHaveLength(8);
  });

  it("re-roots a heads-up tree for the street after a fold", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "SB", acts: [X, B(2.5)] },
      "sol-FLOP|X": { toAct: "BB", acts: [X, B(2.5)] },
      "sol-FLOP|X-X": { toAct: "CO", acts: [X, B(2.5)] },
      "sol-FLOP|X-X-R2.5": { toAct: "SB", acts: [F, C(2.5)] },
      "sol-FLOP|X-X-R2.5-F": { toAct: "BB", acts: [F, C(2.5)] },
      "sol-TURN|": { toAct: "BB", acts: [X, B(4)] },
    });
    restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X", "X", "R2.5", "F", "C"], []] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.potNode).toBe(12.5);
    expect(s.trees[1].mid).toBeUndefined();
    expect(s.trees[1].oopPos).toBe("BB");
    expect(s.trees[1].ipPos).toBe("CO");
    expect(r.trace.streets[1]!.players).toEqual(["BB", "CO"]);
  });

  it("refuses when GTO Wizard names a different seat to act than the rotation", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "SB", acts: [X, B(2.5)] },
      "sol-FLOP|X": { toAct: "CO", acts: [X, B(2.5)] },   // the API skipped the BB
    });
    restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X"]] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("rotation disagrees");
  });

  // Hand 4919211085 (dashboard #425): the reconciler stamped hero's preflop check onto the flop, so the
  // captured flop read "hero checks, SB checks" — the right two actions, the wrong order. The walk is
  // positional, so hero's pending node came out as the THIRD seat's and 13 probes died on the bare "line
  // ends on villain's turn". With the seats carried alongside the tokens the walk names what disagreed.
  it("names the seat when the capture's actions are out of order", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "SB", acts: [X, B(2.5)] },
      "sol-FLOP|X": { toAct: "BB", acts: [X, B(2.5)] },
      "sol-FLOP|X-X": { toAct: "CO", acts: [X, B(2.5)] },
    });
    restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X", "X"]], streetSeats: [["BB", "SB"]] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toContain("capture's line disagrees with the rotation");
      expect(r.why).toContain("it has BB acting");
      expect(r.why).toContain("SB is to act");
    }
  });

  it("walks the same spot once the capture's order is right", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "SB", acts: [X, B(2.5)] },
      "sol-FLOP|X": { toAct: "BB", acts: [X, B(2.5)] },
    });
    restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X"]], streetSeats: [["SB"]] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.trace.nodes.at(-1)!.heroNode).toBe(true);
  });

  it("ignores a seat name this street doesn't have rather than inventing a miss", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "SB", acts: [X, B(2.5)] },
      "sol-FLOP|X": { toAct: "BB", acts: [X, B(2.5)] },
    });
    restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [["X"]], streetSeats: [["LJ"]] });
    expect(r.ok).toBe(true);
  });

  it("names the seat to act when the line stops short of hero", async () => {
    const s = script({ "sol-FLOP|": { toAct: "SB", acts: [X, B(2.5)] } });
    restore = s.restore;
    const r = await solveAiChain({ ...base, streets: [[]] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toContain("walked line ends on villain's turn");
      expect(r.why).toContain("SB is to act");
      expect(r.why).toContain("not hero (BB)");
    }
  });

  it("has nothing to solve once everyone else has folded", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "SB", acts: [X, B(3)] },
      "sol-FLOP|R3": { toAct: "BB", acts: [F, C(3)] },
      "sol-FLOP|R3-F": { toAct: "CO", acts: [F, C(3)] },
    });
    restore = s.restore;
    const r = await solveAiChain({ ...base, heroSeat: "oop", streets: [["R3", "F", "F"], []] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("everyone else folded");
  });
});

describe("solveAiChain heads-up (unchanged behaviour)", () => {
  it("bet-call closes the flop and the turn tree is a two-seat AUTOMATIC one", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "BB", acts: [X, B(3)] },
      "sol-FLOP|R3": { toAct: "CO", acts: [F, C(3)] },
      "sol-TURN|": { toAct: "BB", acts: [X, B(6)] },
    });
    restore = s.restore;
    const r = await solveAiChain({
      oopPos: "BB", ipPos: "CO", oopRange: full(), ipRange: full(), flopPot: 6, flopStack: 97.5,
      board: "Ts7h2d8c", heroSeat: "oop", heroComboIdx: null, streets: [["R3", "C"], []],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.potNode).toBe(12);
    expect(r.stackStreet).toBe(94.5);
    expect(s.trees[0].fixedLevels).toEqual({ FLOP: ["50%"] });
    expect(s.trees[1].fixedLevels).toBeUndefined();
    expect(s.trees[1].mid).toBeUndefined();
  });
});
