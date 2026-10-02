import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi, DEFAULT_TREE_RAKE } from "./gtowApi";
import { actorsOf, checkpointsFor, effectiveBehind, forgetCheckpoints, solveAiChain, StreetState, type AiChainSpec } from "./aiChain";
import { withRequestScope } from "./requestScope";
import { solveTimes, type CheckResult } from "./chainChecks";
import { comboIndex } from "../utils/comboIndex/comboIndex";

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

describe("solveAiChain reuses the street's size-free tree when the observed sizes are on it (2026-09-24)", () => {
  const nodes: Record<string, Node> = {
    // the size-free (AUTOMATIC) flop tree, solved when the flop opened: it offers ONE bet size, 3
    "sol-FLOP|": { toAct: "BB", acts: [X, B(3)] },
    "sol-FLOP|X": { toAct: "CO", acts: [X, B(3)] },
    "sol-FLOP|X-R3": { toAct: "BB", acts: [F, C(3), R(9)] },
    // the FIXED flop tree the walk falls back to, pinned to hero's off-tree 4.5
    "sol-FLOP-fixed|": { toAct: "BB", acts: [X, B(4.5)] },
    "sol-FLOP-fixed|X": { toAct: "CO", acts: [X, B(4.5)] },
    "sol-FLOP-fixed|X-R4.5": { toAct: "BB", acts: [F, C(4.5)] },
    "sol-TURN|": { toAct: "BB", acts: [X, B(6)] },
    "sol-TURN|X": { toAct: "CO", acts: [X, B(6)] },
  };
  /** the size-free flop tree "sol-FLOP" is cached with the given nodes; a pinned flop tree gets its own id */
  const cachedAuto = (cachedKeys: string[]) => {
    const api = gtowApi as any;
    const saved = { peekSolution: api.peekSolution, peekNode: api.peekNode, ensure: api.ensureCustomSolution };
    const trees: any[] = [];
    api.peekSolution = (input: any) => (input.startingStreet === "FLOP" && !input.fixedLevels ? "sol-FLOP" : null);
    api.peekNode = (solId: string, q: any) => {
      const acts = q.flopActions ?? q.turnActions ?? q.riverActions ?? "";
      const nd = nodes[`${solId}|${acts}`];
      return cachedKeys.includes(`${solId}|${acts}`) && nd ? nodeJson(nd) : null;
    };
    api.ensureCustomSolution = async (input: any) => {
      trees.push(input);
      return { ok: true, solId: input.fixedLevels ? `sol-${input.startingStreet}-fixed` : `sol-${input.startingStreet}`, created: !!input.fixedLevels || input.startingStreet !== "FLOP" };
    };
    return { trees, restore: () => { api.peekSolution = saved.peekSolution; api.peekNode = saved.peekNode; api.ensureCustomSolution = saved.ensure; } };
  };
  // hero (CO, in position) acts after BB on the flop; the turn is hero's decision after BB checks
  const spec = (flop: string[]): AiChainSpec => ({
    oopPos: "BB", ipPos: "CO", oopRange: full(), ipRange: full(), flopPot: 6, flopStack: 97.5,
    board: "Ts7h2d8c", heroSeat: "ip", heroComboIdx: null, streets: [flop, ["X"]],
  });

  it("walks the cached size-free tree — no FIXED tree — when hero's bet is the size it offers", async () => {
    const s = script(nodes);
    const c = cachedAuto(["sol-FLOP|", "sol-FLOP|X"]);
    restore = () => { c.restore(); s.restore(); };
    const r = await solveAiChain(spec(["X", "R3", "C"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(c.trees[0].startingStreet).toBe("FLOP");
    expect(c.trees[0].fixedLevels).toBeUndefined();            // the size-free tree, not a pinned one
    expect(r.trace.streets[0]!.reuse).toContain("size-free tree reused");
    expect(r.trace.streets[0]!.fixedLevels).toBeNull();
    expect(r.trace.streets[0]!.created).toBe(false);
    expect(r.solves).toBe(1);                                  // only the turn was fresh
    expect(r.potNode).toBe(12);
  });

  it("snaps a wager inside the walk's tolerance to the tree's size and says so", async () => {
    const s = script(nodes);
    const c = cachedAuto(["sol-FLOP|", "sol-FLOP|X"]);
    restore = () => { c.restore(); s.restore(); };
    const r = await solveAiChain(spec(["X", "R3.1", "C"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(c.trees[0].fixedLevels).toBeUndefined();
    expect(r.trace.streets[0]!.reuse).toContain("Bet(310) taken as the tree's Bet(300)");
    expect(r.trace.streets[0]!.labels).toEqual(["Check", "Bet(300)", "Call"]);
  });

  it("falls back to a FIXED tree when the size is not on the cached one, and names the miss", async () => {
    const s = script(nodes);
    const c = cachedAuto(["sol-FLOP|", "sol-FLOP|X"]);
    restore = () => { c.restore(); s.restore(); };
    const r = await solveAiChain(spec(["X", "R4.5", "C"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(c.trees[0].fixedLevels).toEqual({ FLOP: ["75%"] });
    expect(r.trace.streets[0]!.created).toBe(true);
    expect(r.trace.streets[0]!.reuse).toContain("not reusable");
    expect(r.trace.streets[0]!.reuse).toContain("Bet(450) is not on it");
    expect(r.solves).toBe(2);
  });

  it("fetches at most one node to decide — enough when that node is hero's", async () => {
    const s = script(nodes);
    const c = cachedAuto([]);   // the tree is cached but none of its nodes are
    restore = () => { c.restore(); s.restore(); };
    const r = await solveAiChain(spec(["X", "R3", "C"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trace.streets[0]!.reuse).toContain("size-free tree reused");
    expect(c.trees[0].fixedLevels).toBeUndefined();
    expect(r.trace.streets[0]!.nodeSrc!.fetched).toBeGreaterThanOrEqual(1);
  });

  it("gives up rather than fetch a second node (two wagers, nothing cached)", async () => {
    // the FIXED tree this line ends up on pins both sizes (3, then the raise to 9)
    const s = script({ ...nodes,
      "sol-FLOP-fixed|": { toAct: "BB", acts: [X, B(3)] },
      "sol-FLOP-fixed|X": { toAct: "CO", acts: [X, B(3)] },
      "sol-FLOP-fixed|X-R3": { toAct: "BB", acts: [F, C(3), R(9)] },
      "sol-FLOP-fixed|X-R3-R9": { toAct: "CO", acts: [F, C(9)] },
    });
    const c = cachedAuto([]);
    restore = () => { c.restore(); s.restore(); };
    const r = await solveAiChain({ ...spec(["X", "R3", "R9"]), streets: [["X", "R3", "R9"]] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trace.streets[0]!.reuse).toContain("one fetch already spent");
    expect(c.trees[0].fixedLevels?.FLOP).toHaveLength(2);
    expect(r.trace.streets[0]!.created).toBe(true);
  });
});

describe("per-hand street checkpoints (2026-09-24)", () => {
  const nodes: Record<string, Node> = {
    "sol-FLOP|": { toAct: "BB", acts: [X, B(3)] },
    "sol-FLOP|X": { toAct: "CO", acts: [X, B(3)] },
    "sol-FLOP|X-R3": { toAct: "BB", acts: [F, C(3)] },
    "sol-FLOP|X-X": { toAct: "BB", acts: [X] },
    "sol-TURN|": { toAct: "BB", acts: [X, B(6)] },
    "sol-TURN|X": { toAct: "CO", acts: [X, B(6)] },
    "sol-RIVER|": { toAct: "BB", acts: [X, B(6)] },
    "sol-RIVER|X": { toAct: "CO", acts: [X, B(6)] },
  };
  const hand = (streets: string[][], board = "Ts7h2d8c3s"): AiChainSpec => ({
    oopPos: "BB", ipPos: "CO", oopRange: full(), ipRange: full(), flopPot: 6, flopStack: 97.5,
    board, heroSeat: "ip", heroComboIdx: null, streets, handKey: "hand-ck-1",
  });
  /** count node reads through the scripted API */
  const counting = () => {
    const api = gtowApi as any;
    const inner = api.customNode;
    const c = { n: 0 };
    api.customNode = async (...a: any[]) => { c.n++; return inner(...a); };
    return c;
  };

  it("the next decision starts from the deepest checkpoint; no earlier street is walked or read again", async () => {
    forgetCheckpoints("hand-ck-1");
    const s = script(nodes);
    restore = s.restore;
    // hero's flop decision after BB's check: nothing closed yet, so nothing checkpointed
    const r1 = await solveAiChain(hand([["X"]], "Ts7h2d"));
    expect(r1.ok).toBe(true);
    expect(checkpointsFor("hand-ck-1")).toEqual([]);
    // the turn decision walks the flop through (X-R3-C closes it) — the flop is checkpointed
    const r2 = await solveAiChain(hand([["X", "R3", "C"], ["X"]], "Ts7h2d8c"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.trace.checkpoint?.streetsReused).toBe(0);
    expect(r2.trace.checkpoint?.note).toContain("no checkpoint for this hand yet");
    // …but the flop RESUMED from hero's node (the mid-street checkpoint r1 left): hero's bet was conditioned from
    // the stored node, only villain's call node was read; then the turn root + hero's turn node
    expect(r2.trace.streets[0]!.resumedAt).toBe(1);
    expect(r2.trace.nodes.filter((n) => n.street === "FLOP").map((n) => [n.ti, !!n.fromCheckpoint, n.src])).toEqual([
      [0, true, "fetched"], [1, false, "checkpoint"], [2, false, "fetched"],
    ]);
    expect(checkpointsFor("hand-ck-1").map((c) => c.streets)).toEqual([[0]]);
    // the river decision: the flop comes from the closed checkpoint, the turn resumes from hero's node (his check
    // conditioned from the stored node, nothing read), the river is solved: root + hero's node = 2 reads
    const c = counting();
    const r3 = await solveAiChain(hand([["X", "R3", "C"], ["X", "X"], ["X"]]));
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.trace.checkpoint?.from).toBe("FLOP");
    expect(r3.trace.checkpoint?.streetsReused).toBe(1);
    // the flop's record still says how it was walked when it closed (resumed at hero's node in r2) — history, not a re-walk
    expect(r3.trace.streets.map((x) => [x.street, !!x.fromCheckpoint, x.resumedAt ?? null])).toEqual([["FLOP", true, 1], ["TURN", false, 1], ["RIVER", false, null]]);
    expect(r3.trace.nodes.filter((n) => n.street === "FLOP")).toHaveLength(3);   // the flop's records travel with it
    expect(c.n).toBe(2);                                                          // river root + hero's river node only
    expect(r3.potNode).toBe(12);
    expect(r3.stackStreet).toBe(94.5);
    expect(checkpointsFor("hand-ck-1").map((x) => x.streets)).toEqual([[0, 1]]);
    // a second river probe (villain took time, the poller asked again): both closed streets from checkpoints, the
    // river resumes at hero's node from the mid-street checkpoint — NOTHING is read
    c.n = 0;
    const r4 = await solveAiChain(hand([["X", "R3", "C"], ["X", "X"], ["X"]]));
    expect(r4.ok).toBe(true);
    if (!r4.ok) return;
    expect(r4.trace.checkpoint?.from).toBe("TURN");
    expect(c.n).toBe(0);
    expect(r4.trace.streets.map((x) => !!x.fromCheckpoint)).toEqual([true, true, false]);
    expect(r4.trace.streets[2]!.resumedAt).toBe(1);
    expect(r4.trace.nodes.at(-1)!.src).toBe("checkpoint");
    expect(r4.trace.nodes.at(-1)!.heroNode).toBe(true);
  });

  it("a size pinned after hero's node means a new tree: the street resumes at hero's node ONTO it, keeping the prefix's conditioning", async () => {
    forgetCheckpoints("hand-ck-2");
    const s = script({
      ...nodes,
      // the FIXED flop tree the turn decision needs once hero's off-tree 4.5 is pinned — scripted under its own id
      "sol-FLOP-fixed|": { toAct: "BB", acts: [X, B(4.5)] },
      "sol-FLOP-fixed|X": { toAct: "CO", acts: [X, B(4.5)] },
      "sol-FLOP-fixed|X-R4.5": { toAct: "BB", acts: [F, C(4.5)] },
    });
    const api = gtowApi as any;
    const ensure = api.ensureCustomSolution;
    api.ensureCustomSolution = async (input: any) => ({ ...(await ensure(input)), solId: input.fixedLevels ? `sol-${input.startingStreet}-fixed` : `sol-${input.startingStreet}` });
    restore = () => { api.ensureCustomSolution = ensure; s.restore(); };
    const h = (streets: string[][], board: string): AiChainSpec => ({
      oopPos: "BB", ipPos: "CO", oopRange: full(), ipRange: full(), flopPot: 6, flopStack: 97.5,
      board, heroSeat: "ip", heroComboIdx: null, streets, handKey: "hand-ck-2",
    });
    const r1 = await solveAiChain(h([["X"]], "Ts7h2d"));
    expect(r1.ok).toBe(true);
    const r2 = await solveAiChain(h([["X", "R4.5", "C"], ["X"]], "Ts7h2d8c"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.trace.streets[0]!.created).toBe(true);                 // the FIXED tree, pinned to 4.5
    expect(r2.trace.streets[0]!.resumedAt).toBe(1);                   // …but walked from hero's node, not the root
    expect(r2.trace.streets[0]!.resumeMiss).toBeUndefined();
    // the root travels with the checkpoint; hero's node is read on the new tree (its old JSON offered 3, not 4.5)
    expect(r2.trace.nodes.filter((n) => n.street === "FLOP").map((n) => [n.ti, !!n.fromCheckpoint, n.src])).toEqual([
      [0, true, "fetched"], [1, false, "fetched"], [2, false, "fetched"],
    ]);
    expect(r2.potNode).toBe(15);
  });

  it("a street the capture re-reads differently is walked again, and the trace says which", async () => {
    forgetCheckpoints("hand-ck-1");
    const s = script(nodes);
    restore = s.restore;
    const r2 = await solveAiChain(hand([["X", "R3", "C"], ["X"]], "Ts7h2d8c"));
    expect(r2.ok).toBe(true);
    // the capture now says the flop went check-check
    const r3 = await solveAiChain(hand([["X", "X"], ["X", "X"], ["X"]]));
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.trace.checkpoint?.from).toBeNull();
    expect(r3.trace.checkpoint?.note).toContain("the flop was [X,R3,C] when walked, the capture now says [X,X]");
    expect(r3.trace.streets[0]!.fromCheckpoint).toBeUndefined();
    expect(r3.potNode).toBe(6);
    // and the corrected flop replaces the old checkpoint
    const r4 = await solveAiChain(hand([["X", "X"], ["X", "X"], ["X"]]));
    expect(r4.ok && r4.trace.checkpoint?.from).toBe("TURN");
  });

  it("two concurrent collapse plans that reduce to the SAME seat labels get SEPARATE checkpoints, keyed by planTag (2026-09-24)", async () => {
    forgetCheckpoints("hand-ck-multiway");
    // plan A: BB alone as OOP+1 (narrow range, weight 300). plan B: BB+CO merged into OOP+1 (full range, weight
    // 1326) — a realistic multiwayCollapse shape where the merged seat reuses BB's own position label, so the
    // seat-label string ("SB/BB/CO") is identical between plans even though the ranges are not.
    const narrow = new Array(1326).fill(0); for (let i = 0; i < 300; i++) narrow[i] = 1;
    const wide = full();
    const nodes: Record<string, Node> = {
      "sol-FLOP|": { toAct: "SB", acts: [X] }, "sol-FLOP|X": { toAct: "BB", acts: [X] },
      "sol-FLOP|X-X": { toAct: "CO", acts: [X] }, "sol-FLOP|X-X-X": { toAct: "SB", acts: [X] },
      "sol-TURN|": { toAct: "SB", acts: [X] },
    };
    const s = script(nodes);
    restore = s.restore;
    const specOf = (planTag: string, midRange: number[]): AiChainSpec => ({
      oopPos: "SB", midPos: "BB", ipPos: "CO", oopRange: full(), midRange, ipRange: full(),
      flopPot: 6, flopStack: 97.5, board: "2s3sQdJs", heroSeat: "oop", heroComboIdx: null,
      streets: [["X", "X", "X"], []], handKey: "hand-ck-multiway", planTag,
    });
    const a1 = await solveAiChain(specOf("plan-A", narrow));
    const b1 = await solveAiChain(specOf("plan-B", wide));
    expect(a1.ok).toBe(true);
    expect(b1.ok).toBe(true);
    // two distinct checkpoint entries under the same hand — plan B did not overwrite plan A's
    expect(checkpointsFor("hand-ck-multiway")).toHaveLength(2);
    // the SAME plan-A decision asked again (as --twice does live): it must read plan A's OWN flop checkpoint
    // (narrow), never plan B's (wide) — checked by the actual stored range, not node-fetch counting (a
    // fully-scripted mock has no real cache to count)
    const a2 = await solveAiChain(specOf("plan-A", narrow));
    expect(a2.ok).toBe(true);
    if (!a2.ok) return;
    expect(a2.trace.checkpoint?.from).toBe("FLOP");
    expect(a2.trace.streets[0]!.fromCheckpoint).toBe(true);
    const midWeight = a2.trace.streets[0]!.rangesIn![1]!.reduce((x, y) => x + y, 0);
    expect(midWeight).toBeCloseTo(300, 0);   // plan A's narrow range, not plan B's 1326
  });

  it("without a handKey nothing is checkpointed and the walk starts at the flop as before", async () => {
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain({ ...hand([["X", "R3", "C"], ["X"]], "Ts7h2d8c"), handKey: undefined });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trace.checkpoint).toBeUndefined();
  });
});

describe("solveAiChain accounting (2026-09-24)", () => {
  it("records why each tree was created and where each node came from", async () => {
    const s = script({
      "sol-FLOP|": { toAct: "BB", acts: [X, B(3)] },
      "sol-FLOP|R3": { toAct: "CO", acts: [F, C(3)] },
      "sol-TURN|": { toAct: "BB", acts: [X, B(6)] },
    });
    restore = s.restore;
    // the flop tree comes back from the cache (as it should on a turn decision); the turn tree is fresh, with a reason
    const api = gtowApi as any;
    const ensure = api.ensureCustomSolution;
    api.ensureCustomSolution = async (input: any) => {
      const r = await ensure(input);
      return input.startingStreet === "TURN" ? { ...r, created: true, why: "first TURN tree for Ts7h2d8c in this process" } : { ...r, created: false };
    };
    const node = api.customNode;
    let n = 0;
    api.customNode = async (solId: string, q: any) => {
      const r = await node(solId, q);
      return r.ok ? { ...r, src: n++ === 0 ? "cache" : "fetched" } : r;
    };
    const r = await solveAiChain({
      oopPos: "BB", ipPos: "CO", oopRange: full(), ipRange: full(), flopPot: 6, flopStack: 97.5,
      board: "Ts7h2d8c", heroSeat: "oop", heroComboIdx: null, streets: [["R3", "C"], []],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [flop, turn] = r.trace.streets;
    expect(flop!.created).toBe(false);
    expect(flop!.treeWhy).toBeNull();
    expect(flop!.nodeSrc).toEqual({ cache: 1, joined: 0, fetched: 1, fetchMs: expect.any(Number) });
    expect(turn!.created).toBe(true);
    expect(turn!.treeWhy).toContain("first TURN tree");
    expect(turn!.nodeSrc!.fetched).toBe(1);
    expect(r.trace.nodes.map((x) => x.src)).toEqual(["cache", "fetched", "fetched"]);
    expect(r.solves).toBe(1);
  });
});

/**
 * WHAT GTO WIZARD WAS SENT (2026-09-24, Brady: "what the inputs sent in was … e.g. what the rake cap you set was").
 * Every street of the trace keeps the tree request as sent (gtowApi.treeRequestSummary: the body the account
 * received, each range replaced by its size) and whose account solved it; the hand page reads both.
 */
describe("the trace records each street's tree request", () => {
  const hu: Omit<AiChainSpec, "streets"> = {
    oopPos: "BB", ipPos: "SB", oopRange: full(), ipRange: half(),
    flopPot: 20, flopStack: 114.4, board: "3c4s7c", heroSeat: "ip", heroComboIdx: null,
  };
  const huNodes = { "sol-FLOP|": { toAct: "BB", acts: [X, B(8)] }, "sol-FLOP|X": { toAct: "SB", acts: [X, B(8)] } };

  it("rake and cap, pot, stack, the size grid, ranges as their size — and the account", async () => {
    const s = script(huNodes);
    const api = gtowApi as any, ensure = api.ensureCustomSolution;
    api.ensureCustomSolution = async (input: any) => ({ ...(await ensure(input)), session: "secondary" });
    restore = () => { api.ensureCustomSolution = ensure; s.restore(); };
    const rake = { pct_of_pot: 5, cap_in_chips: 0.9, preflop_rake_type: null };
    const r = await solveAiChain({ ...hu, streets: [["X"]], rake });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const st = r.trace.streets[0]!;
    expect(st.account).toBe("secondary");
    const sent = st.sent as any;
    expect(sent.starting_street).toBe("FLOP");
    expect(sent.pot).toBe(20);
    expect(sent.rake).toEqual(rake);
    expect(sent.players.map((p: any) => [p.position, p.display_position, p.stack])).toEqual([["OOP", "BB", 114.4], ["IP", "SB", 114.4]]);
    // a range travels as its size, never 1,326 numbers (those are in rangesIn already)
    for (const p of sent.players) {
      expect(Array.isArray(p.range)).toBe(false);
      expect(p.range.combos).toBeGreaterThan(0);
      expect(p.range.combos).toBeLessThanOrEqual(1326);
      expect(p.range.weight).toBeGreaterThan(0);
    }
    expect(sent.players[1].range.weight).toBeLessThan(sent.players[0].range.weight);
    expect(sent.bet_sizes.street_bet_sizes.map((x: any) => [x.street, x.position_bet_sizes[0].type]))
      .toEqual([["FLOP", "AUTOMATIC"], ["TURN", "AUTOMATIC"], ["RIVER", "AUTOMATIC"]]);
  });

  it("a spec without a rake records the default the builder sent, not nothing", async () => {
    const s = script(huNodes);
    restore = s.restore;
    const r = await solveAiChain({ ...hu, streets: [["X"]] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.trace.streets[0]!.sent as any).rake).toEqual(DEFAULT_TREE_RAKE);
    // the stub returns no session: the trace says so rather than inventing one
    expect(r.trace.streets[0]!.account ?? null).toBeNull();
  });
});

/**
 * HERO'S OWN SIZE SNAPS TO THE TREE HE WAS ASKED ON (round 3, 2026-09-25; chainReuseStress hand 4920429872: hero
 * check-raised the flop to 4.8 where the tree he was asked on offered 4.7, and the turn re-created the flop tree with
 * both sizes pinned — one more cloud solve and a flop re-walk for a rounding difference in hero's own pick). A scripted
 * GTO Wizard with a real in-mock tree cache: a tree is "cached" once ensureCustomSolution has created it.
 */
describe("hero's own postflop size snaps to the tree he was asked on (no rebuild)", () => {
  const ASKED = ["30%"];   // the flop's levels once the CO's 1.8 bet into 6 is pinned: the tree hero was asked on
  const nodes: Record<string, Node> = {
    "sol-FLOP-asked|": { toAct: "BB", acts: [X, B(1.8)] },
    "sol-FLOP-asked|X": { toAct: "CO", acts: [X, B(1.8)] },
    // hero's node on the tree he was asked on: its raise level falls back to the pinned 30% — a raise to 4.7
    "sol-FLOP-asked|X-R1.8": { toAct: "BB", acts: [F, C(1.8), R(4.7)] },
    "sol-FLOP-asked|X-R1.8-R4.7": { toAct: "CO", acts: [F, C(4.7)] },
    // a flop tree re-created with a second level pinned (whatever size): scripted for the re-create cases
    "sol-FLOP-fixed2|": { toAct: "BB", acts: [X, B(1.8)] },
    "sol-FLOP-fixed2|X": { toAct: "CO", acts: [X, B(1.8)] },
    "sol-FLOP-fixed2|X-R1.8": { toAct: "BB", acts: [F, C(1.8), R(4.8), R(7)] },
    "sol-FLOP-fixed2|X-R1.8-R4.8": { toAct: "CO", acts: [F, C(4.8)] },
    "sol-FLOP-fixed2|X-R1.8-R7": { toAct: "CO", acts: [F, C(7)] },
    "sol-TURN|": { toAct: "BB", acts: [X, B(5)] },
  };
  /** the tree ids by what they pin; the cache is what ensureCustomSolution has created so far */
  const cachedTrees = () => {
    const api = gtowApi as any;
    const saved = { peekSolution: api.peekSolution, peekNode: api.peekNode, ensure: api.ensureCustomSolution, node: api.customNode };
    const created = new Set<string>();
    const readNodes = new Set<string>();
    const trees: { input: any; solId: string; created: boolean }[] = [];
    const idOf = (input: any) => {
      const fl = input.fixedLevels?.[input.startingStreet];
      return !fl ? `sol-${input.startingStreet}` : fl.length === 1 && fl[0] === ASKED[0] ? `sol-${input.startingStreet}-asked` : `sol-${input.startingStreet}-fixed2`;
    };
    api.peekSolution = (input: any) => (created.has(idOf(input)) ? idOf(input) : null);
    api.ensureCustomSolution = async (input: any) => {
      const solId = idOf(input);
      const fresh = !created.has(solId);
      created.add(solId);
      trees.push({ input, solId, created: fresh });
      return { ok: true, solId, created: fresh, session: "primary", ...(fresh ? { why: "scripted" } : {}) };
    };
    api.customNode = async (solId: string, q: any) => {
      const acts = q.flopActions ?? q.turnActions ?? q.riverActions ?? "";
      const nd = nodes[`${solId}|${acts}`];
      if (!nd) return { ok: false, status: 404, error: `unscripted node ${solId}|${acts}` };
      readNodes.add(`${solId}|${acts}`);
      return { ok: true, data: nodeJson(nd), solveSecs: 0, cached: false, src: "fetched" };
    };
    api.peekNode = (solId: string, q: any) => {
      const acts = q.flopActions ?? q.turnActions ?? q.riverActions ?? "";
      const nd = nodes[`${solId}|${acts}`];
      return readNodes.has(`${solId}|${acts}`) && nd ? nodeJson(nd) : null;
    };
    return { trees, restore: () => Object.assign(api, { peekSolution: saved.peekSolution, peekNode: saved.peekNode, ensureCustomSolution: saved.ensure, customNode: saved.node }) };
  };
  // hero is the BB, out of position: he checks, the CO bets 1.8 into 6, hero is asked — then raises, the CO calls
  const handSpec = (streets: string[][], board: string, handKey?: string): AiChainSpec => ({
    oopPos: "BB", ipPos: "CO", oopRange: full(), ipRange: full(), flopPot: 6, flopStack: 97.5,
    board, heroSeat: "oop", heroComboIdx: null, streets, ...(handKey ? { handKey } : {}),
  });

  it("hero's raise to 4.8 against an offered 4.7: no tree re-created, the node read on the tree he was asked on", async () => {
    forgetCheckpoints("hand-hero-snap");
    const c = cachedTrees();
    restore = c.restore;
    // hero's flop decision facing the 1.8 bet: the tree is created pinned to the CO's size (hero's node offers 4.7)
    const r1 = await solveAiChain(handSpec([["X", "R1.8"]], "Ts7h2d", "hand-hero-snap"));
    expect(r1.ok).toBe(true);
    expect(c.trees.map((t) => [t.solId, t.created])).toEqual([["sol-FLOP-asked", true]]);
    // the turn: hero raised to 4.8 (the client's rounding), the CO called
    const r2 = await solveAiChain(handSpec([["X", "R1.8", "R4.8", "C"], []], "Ts7h2d8c", "hand-hero-snap"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const flop = c.trees.slice(1).filter((t) => t.input.startingStreet === "FLOP");
    expect(flop.map((t) => [t.solId, t.created])).toEqual([["sol-FLOP-asked", false]]);   // the same tree, from the cache
    expect(flop[0]!.input.fixedLevels).toEqual({ FLOP: ASKED });                            // never [30%, 31.3%]
    const st = r2.trace.streets[0]!;
    expect(st.created).toBe(false);
    expect(st.treeWhy).toBeNull();
    expect(st.reuse).toContain("hero's 4.8 read as the tree's 4.7");
    expect(st.labels).toEqual(["Check", "Bet(180)", "Raise(470)", "Call"]);
    // resumed at hero's node from the mid-street checkpoint: his raise conditioned from the stored node, only the CO's
    // call node read — nothing before hero's node read again
    expect(st.resumedAt).toBe(2);
    expect(r2.trace.nodes.filter((n) => n.street === "FLOP" && !n.fromCheckpoint).map((n) => [n.codes.join("-"), n.src])).toEqual([["X-R1.8", "checkpoint"], ["X-R1.8-R4.7", "fetched"]]);
    expect(r2.solves).toBe(1);                // the turn only
    expect(r2.potNode).toBe(15.4);            // 6 + 4.7 × 2, rolled on with the tree's size
    expect(r2.snaps ?? []).toEqual([]);       // 4.8 → 4.7 is rounding, not worth a word
  });

  it("a VILLAIN's 4.8 against the same offered 4.7 pins a new tree, as today", async () => {
    const c = cachedTrees();
    restore = c.restore;
    // hero is the CO (in position): BB checks, hero bets 1.8, the BB check-raises to 4.8 — hero decides
    await (gtowApi as any).ensureCustomSolution({ board: "Ts7h2d", startingStreet: "FLOP", fixedLevels: { FLOP: ASKED } });   // the 4.7 tree, cached
    const r = await solveAiChain({ ...handSpec([["X", "R1.8", "R4.8"]], "Ts7h2d"), heroSeat: "ip" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flop = c.trees.slice(1).filter((t) => t.input.startingStreet === "FLOP");
    expect(flop.map((t) => [t.solId, t.created])).toEqual([["sol-FLOP-fixed2", true]]);
    expect(flop[0]!.input.fixedLevels.FLOP).toHaveLength(2);
    expect(r.trace.streets[0]!.labels).toEqual(["Check", "Bet(180)", "Raise(480)"]);
    expect(r.trace.streets[0]!.reuse ?? "").not.toContain("hero's");
  });

  it("hero's size far from anything the tree offered (7 against 4.7) is pinned as played: re-created, as today", async () => {
    forgetCheckpoints("hand-hero-far");
    const c = cachedTrees();
    restore = c.restore;
    await solveAiChain(handSpec([["X", "R1.8"]], "Ts7h2d", "hand-hero-far"));
    const r = await solveAiChain(handSpec([["X", "R1.8", "R7", "C"], []], "Ts7h2d8c", "hand-hero-far"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flop = c.trees.slice(1).filter((t) => t.input.startingStreet === "FLOP");
    expect(flop.map((t) => [t.solId, t.created])).toEqual([["sol-FLOP-fixed2", true]]);
    expect(flop[0]!.input.fixedLevels).toEqual({ FLOP: ["30%", "54.2%"] });
    expect(r.trace.streets[0]!.reuse).toContain("hero's 7 is not on the tree he was asked on");
    expect(r.trace.streets[0]!.labels).toEqual(["Check", "Bet(180)", "Raise(700)", "Call"]);
  });
});

/**
 * HAND 4920544353 (2026-09-25, Ignition NL5): hero CO 100bb opens, BTN (34.2) and both blinds call — four-way flop,
 * collapsed by merging SB+BB into one seat (the merge plan the answer used). The tree is solved at the field's 49.8
 * (the SB's depth). On the flop the merged blinds fold to the BTN's raise; on the turn the BTN jams his last 21.6.
 * Live, the turn tree was solved at 39.8 behind — the field's number rolled forward — so the jam was a bet with
 * 18.2bb behind it and hero's answer was "ALLIN 39.8 100%" where the table offered only fold or call.
 */
describe("the stack of the players still in (seatStacks, hand 4920544353)", () => {
  const AI = (b: number) => ({ code: `R${b}`, name: "Allin", betsize: b });
  const nodes: Record<string, Node> = {
    "sol-FLOP|": { toAct: "SB", acts: [X, B(1)] },
    "sol-FLOP|R1": { toAct: "CO", acts: [F, C(1), R(10)] },
    "sol-FLOP|R1-C": { toAct: "BTN", acts: [F, C(1), R(10)] },
    "sol-FLOP|R1-C-R10": { toAct: "SB", acts: [F, C(10)] },
    "sol-FLOP|R1-C-R10-F": { toAct: "CO", acts: [F, C(10)] },
    "sol-TURN|": { toAct: "CO", acts: [X, B(10), AI(21.6)] },
    "sol-TURN|X": { toAct: "BTN", acts: [X, B(10), AI(21.6)] },
    "sol-TURN|X-R21.6": { toAct: "CO", acts: [F, C(21.6)] },
  };
  const FLOP = ["R1", "C", "R10", "F", "C"];
  const spec = (turn: string[], extra: Partial<AiChainSpec> = {}): AiChainSpec => ({
    oopPos: "SB", midPos: "CO", ipPos: "BTN", oopRange: full(), midRange: full(), ipRange: full(),
    flopPot: 10.4, flopStack: 49.8, board: "6s8hKsQh", heroSeat: "mid", heroComboIdx: null,
    streets: [FLOP, turn], streetSeats: [["SB", "CO", "BTN", "SB", "CO"], turn.map((_, i) => (i % 2 ? "BTN" : "CO"))],
    seatStacks: { SB: 49.8, CO: 97.4, BTN: 31.6 },
    ...extra,
  });

  it("effectiveBehind: hero against the deepest villain; an unknown stack never shrinks it", () => {
    expect(effectiveBehind(["SB", "CO", "BTN"], "CO", { SB: 49.8, CO: 97.4, BTN: 31.6 })).toBe(49.8);
    expect(effectiveBehind(["CO", "BTN"], "CO", { CO: 87.4, BTN: 21.6 })).toBe(21.6);
    expect(effectiveBehind(["CO", "BTN"], "CO", { CO: 15, BTN: 21.6 })).toBe(15);
    expect(effectiveBehind(["CO", "BTN"], "CO", { CO: 87.4 })).toBe(87.4);
    expect(effectiveBehind(["CO", "BTN"], "CO", undefined)).toBe(Infinity);
  });

  it("after the blinds fold the turn is solved at the BTN's 21.6, and his jam is the tree's all-in", async () => {
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(spec(["X", "R21.6"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(s.trees.map((t) => [t.startingStreet, t.stack])).toEqual([["FLOP", 49.8], ["TURN", 21.6]]);
    expect(r.stackStreet).toBe(21.6);
    expect(r.potNode).toBe(53);
    // the BTN's 21.6 was walked as the ALL-IN (everything he had), and hero faces fold or call — nothing else
    const btn = r.trace.nodes.find((n) => n.street === "TURN" && n.codes.join("-") === "X")!;
    expect(btn.actions[btn.taken!]!.name).toBe("Allin");
    expect(r.data.action_solutions.map((a: any) => a.action.display_name)).toEqual(["Fold", "Call"]);
    expect(r.stackNotes?.[0]).toContain("CO 87.4 / BTN 21.6 behind after SB left — solved at 21.6bb, not the 39.8bb");
  });

  it("without seat stacks the old rolled number stands (a missing reading never shrinks a tree)", async () => {
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(spec(["X", "R21.6"], { seatStacks: undefined }));
    expect(r.ok).toBe(true);
    expect(s.trees.map((t) => t.stack)).toEqual([49.8, 39.8]);
    if (r.ok) expect(r.stackNotes).toBeUndefined();
  });

  it("the flop checkpoint carries each seat's stack: the next decision starts from it at 21.6, flop not re-walked", async () => {
    forgetCheckpoints("hand-4920544353");
    const s = script(nodes);
    restore = s.restore;
    const r1 = await solveAiChain(spec([], { handKey: "hand-4920544353" }));   // hero's turn decision at the root
    expect(r1.ok).toBe(true);
    const r2 = await solveAiChain(spec(["X", "R21.6"], { handKey: "hand-4920544353" }));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.trace.checkpoint?.from).toBe("FLOP");
    expect(s.trees.map((t) => [t.startingStreet, t.stack])).toEqual([["FLOP", 49.8], ["TURN", 21.6], ["TURN", 21.6]]);
    expect(r2.stackStreet).toBe(21.6);
    expect(r2.stackNotes?.[0]).toContain("solved at 21.6bb");
    forgetCheckpoints("hand-4920544353");
  });
});

describe("the street's checks, as the walk sees them (services/chainChecks, 2026-09-27)", () => {
  const nodes: Record<string, Node> = {
    "sol-FLOP|": { toAct: "BB", acts: [X, B(3)] },
    "sol-FLOP|X": { toAct: "CO", acts: [X, B(3)] },
    "sol-FLOP|X-R3": { toAct: "BB", acts: [F, C(3)] },
    "sol-TURN|": { toAct: "BB", acts: [X, B(6)] },
    "sol-TURN|X": { toAct: "CO", acts: [X, B(6)] },
  };
  const AdKc = comboIndex("Ad", "Kc");
  const spec = (streets: string[][], board: string, handKey: string): AiChainSpec => ({
    oopPos: "BB", ipPos: "CO", oopRange: full(), ipRange: full(), flopPot: 6, flopStack: 97.5,
    board, heroSeat: "ip", heroComboIdx: AdKc, streets, handKey,
  });
  const byId = (xs: CheckResult[] | undefined) => Object.fromEntries((xs ?? []).map((c) => [c.id, c.status]));
  /** the scripted API, answering every tree under the solution id `sol()` gives */
  const withSolId = (sol: () => string) => {
    const api = gtowApi as any;
    const inner = api.ensureCustomSolution;
    api.ensureCustomSolution = async (input: any) => ({ ...(await inner(input)), solId: sol() });
    return () => { api.ensureCustomSolution = inner; };
  };

  it("every street carries #2 #3 #4 #6 #9 #10 #11 #12; hero's street adds #14 and #17", async () => {
    forgetCheckpoints("hand-checks-1");
    solveTimes.reset();   // #12 is "na" until the street has a baseline
    const s = script(nodes);
    restore = s.restore;
    const r = await solveAiChain(spec([["X", "R3", "C"], ["X"]], "Ts7h2d8c", "hand-checks-1"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [flop, turn] = r.trace.streets;
    expect(byId(flop!.checks)).toEqual({ 2: "pass", 3: "pass", 4: "pass", 6: "pass", 9: "pass", 10: "pass", 11: "na", 12: "na" });
    expect(byId(turn!.checks)).toEqual({ 2: "pass", 3: "pass", 4: "pass", 6: "pass", 9: "pass", 10: "pass", 11: "na", 12: "na", 14: "pass", 17: "pass" });
    expect(flop!.checks!.find((c) => c.id === 6)!.text).toContain("3 actions walked as captured");
    expect(turn!.checks!.find((c) => c.id === 17)!.text).toContain("hero's AdKc carries weight");
    expect(turn!.checks!.find((c) => c.id === 4)!.text).toContain("GTO Wizard named the same seat to act");
    forgetCheckpoints("hand-checks-1");
  });

  it("#11: the live walk on the warm-up's tree passes; on another size-free tree it fails, and #9 sees two default trees", async () => {
    forgetCheckpoints("hand-checks-2");
    const s = script({ ...nodes, "sol-OTHER|": nodes["sol-FLOP|"]!, "sol-OTHER|X": nodes["sol-FLOP|X"]! });
    let sol = "sol-FLOP";
    const undo = withSolId(() => sol);
    restore = () => { undo(); s.restore(); };
    // the warm-up opens the flop when it lands (BB to act: its walk ends on villain's turn — its tree is recorded anyway)
    await withRequestScope({ handKey: "hand-checks-2", origin: "warm", street: "flop" }, () => solveAiChain(spec([[]], "Ts7h2d", "hand-checks-2")));
    const live = await withRequestScope({ handKey: "hand-checks-2", origin: "live", street: "flop" }, () => solveAiChain(spec([["X"]], "Ts7h2d", "hand-checks-2")));
    expect(live.value.ok).toBe(true);
    if (!live.value.ok) return;
    expect(live.value.trace.streets[0]!.checks!.find((c) => c.id === 11)!.status).toBe("pass");
    // the same street asked again, live, on ANOTHER size-free tree (its key drifted) — no size pinned to explain it
    forgetCheckpoints("hand-checks-3");
    sol = "sol-FLOP";
    await withRequestScope({ handKey: "hand-checks-3", origin: "warm", street: "flop" }, () => solveAiChain(spec([[]], "Ts7h2d", "hand-checks-3")));
    sol = "sol-OTHER";
    const drift = await withRequestScope({ handKey: "hand-checks-3", origin: "live", street: "flop" }, () => solveAiChain(spec([["X"]], "Ts7h2d", "hand-checks-3")));
    expect(drift.value.ok).toBe(true);
    if (!drift.value.ok) return;
    const cks = drift.value.trace.streets[0]!.checks!;
    expect(cks.find((c) => c.id === 11)!.status).toBe("fail");
    expect(cks.find((c) => c.id === 9)!.status).toBe("fail");
    forgetCheckpoints("hand-checks-2");
    forgetCheckpoints("hand-checks-3");
  });

  // 2026-10-03, audit finding 5: the heads-up rule (big blind first) only on a table DEALT two
  it("#4: a blind-vs-blind pot seated SB → BB passes at a table dealt 5, fails at a table dealt 2 — the spec's dealt count decides", async () => {
    const sbbb: Record<string, Node> = {
      "sol-FLOP|": { toAct: "SB", acts: [X, B(3)] },
      "sol-FLOP|X": { toAct: "BB", acts: [X, B(3)] },
    };
    const run = async (dealt: number | undefined, key: string) => {
      forgetCheckpoints(key);
      const s = script(sbbb);
      restore = s.restore;
      const r = await solveAiChain({ ...spec([["X"]], "Ts7h2d", key), oopPos: "SB", ipPos: "BB", heroSeat: "ip", ...(dealt != null ? { dealt } : {}) });
      s.restore(); restore = null;
      forgetCheckpoints(key);
      expect(r.ok).toBe(true);
      return r.ok ? r.trace.streets[0]!.checks!.find((c) => c.id === 4)! : null;
    };
    const ring = await run(5, "hand-checks-4a");
    expect(ring!.status).toBe("pass");
    expect(ring!.text).toContain("SB → BB in postflop order by position (5 dealt)");
    const hu = await run(2, "hand-checks-4b");
    expect(hu!.status).toBe("fail");
    expect(hu!.text).toContain("by position it is BB → SB (out of position first; 2 dealt)");
    const unknown = await run(undefined, "hand-checks-4c");
    expect([unknown!.status, unknown!.text.includes("a blind-vs-blind order is not checked")]).toEqual(["pass", true]);
  });

  it("#12: each street's time goes to ITS population's median (new / cached-hit / cached-fetched), and a slow street is never a fail", async () => {
    forgetCheckpoints("hand-checks-5");
    solveTimes.reset();
    const pops = ["new", "cached-hit", "cached-fetched"] as const;
    for (const p of pops) for (let i = 0; i < 10; i++) solveTimes.record(`FLOP:${p}`, 0);
    const s = script(nodes);
    restore = s.restore;
    const TEXT = { new: "(new trees", "cached-hit": "(cached trees, every node from the cache", "cached-fetched": "(cached trees, nodes fetched" } as const;
    const walk = async (key: string) => {
      forgetCheckpoints(key);
      const r = await solveAiChain(spec([["X"]], "Ts7h2d", key));
      forgetCheckpoints(key);
      expect(r.ok).toBe(true);
      return r.ok ? r.trace.streets[0]!.checks!.find((c) => c.id === 12)! : null;
    };
    // a tree created on this decision: the "new" median
    const created = await walk("hand-checks-5");
    expect(pops.map((p) => solveTimes.median(`FLOP:${p}`).samples)).toEqual([11, 10, 10]);
    expect(created!.status).not.toBe("fail");
    expect(created!.text).toContain(TEXT.new);
    // the same tree from the cache, its nodes fetched from GTO Wizard: the "cached-fetched" median, not a full cache hit's
    const api = gtowApi as any;
    const inner = api.ensureCustomSolution;
    api.ensureCustomSolution = async (input: any) => ({ ...(await inner(input)), created: false });
    restore = () => { api.ensureCustomSolution = inner; s.restore(); };
    const cached = await walk("hand-checks-6");
    expect(pops.map((p) => solveTimes.median(`FLOP:${p}`).samples)).toEqual([11, 10, 11]);
    expect(cached!.text).toContain(TEXT["cached-fetched"]);
    solveTimes.reset();
  });
});
