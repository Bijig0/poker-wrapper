import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { dropAnsweredNodes, forgetCheckpoints, solveAiChain, walkPolicy, WALK_POLICY_KEYS, type AiChainSpec, type ChainTrace } from "./aiChain";
import { derivedWalkPolicy, ReplayChecks, replayText, replayTrace, withEnv } from "./replayCheck";

/** A scripted GTO Wizard (as aiChain.test.ts): nodes keyed by tree + actions, each naming who acts. */
const half = () => new Array(1326).fill(0.5);
const full = () => new Array(1326).fill(1);
type Node = { toAct: string; acts: { code: string; name: string; betsize?: number }[] };
const X = { code: "X", name: "Check" };
const C = (b: number) => ({ code: "C", name: "Call", betsize: b });
const B = (b: number) => ({ code: `R${b}`, name: "Bet", betsize: b });
const nodes: Record<string, Node> = {
  "sol-FLOP|": { toAct: "BB", acts: [X, B(3)] },
  "sol-FLOP|X": { toAct: "CO", acts: [X, B(3)] },
  "sol-FLOP|X-R3": { toAct: "BB", acts: [{ code: "F", name: "Fold" }, C(3)] },
  "sol-TURN|": { toAct: "BB", acts: [X, B(6)] },
  "sol-TURN|X": { toAct: "CO", acts: [X, B(6)] },
  "sol-RIVER|": { toAct: "BB", acts: [X, B(6)] },
  "sol-RIVER|X": { toAct: "CO", acts: [X, B(6)] },
};
let restore: (() => void) | null = null;
/** two flop trees whose nodes play their first action differently — A (hero's flop decision was answered on it) 0.8,
 *  B (the turn decision's re-tree) 0.2; the turn tree as scripted() */
function twoTrees() {
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode };
  let flops = 0;
  api.ensureCustomSolution = async (input: any) => {
    if (input.startingStreet === "FLOP") { flops++; return { ok: true, solId: flops === 1 ? "A-FLOP" : "B-FLOP", created: flops <= 2 }; }
    return { ok: true, solId: `sol-${input.startingStreet}`, created: true };
  };
  api.customNode = async (solId: string, q: any) => {
    const street = String(solId).replace(/^(A|B|sol)-/, "");
    const nd = nodes[`sol-${street}|${q.flopActions ?? q.turnActions ?? q.riverActions ?? ""}`];
    if (!nd) return { ok: false, status: 404, error: "unscripted" };
    const w = solId === "A-FLOP" ? 0.8 : solId === "B-FLOP" ? 0.2 : 0.5;
    return { ok: true, cached: false, solveSecs: 0, data: {
      game: { players: [{ position: nd.toAct, is_hero: true }] },
      action_solutions: nd.acts.map((a, i) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: nd.toAct },
        total_frequency: 0.5, total_ev: 0, strategy: new Array(1326).fill(i === 0 ? w : 1 - w), evs: half() })),
    } };
  };
  restore = () => { api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; };
}
function scripted() {
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode };
  api.ensureCustomSolution = async (input: any) => ({ ok: true, solId: `sol-${input.startingStreet}`, created: true });
  api.customNode = async (solId: string, q: any) => {
    const nd = nodes[`${solId}|${q.flopActions ?? q.turnActions ?? q.riverActions ?? ""}`];
    if (!nd) return { ok: false, status: 404, error: "unscripted" };
    return { ok: true, cached: false, solveSecs: 0, data: {
      game: { players: [{ position: nd.toAct, is_hero: true }] },
      action_solutions: nd.acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: nd.toAct },
        total_frequency: 0.5, total_ev: 0, strategy: half(), evs: half() })),
    } };
  };
  restore = () => { api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; };
}
afterEach(() => { restore?.(); restore = null; });

const spec = (streets: string[][], handKey: string, board = "Ts7h2d8c3s"): AiChainSpec => ({
  oopPos: "BB", ipPos: "CO", oopRange: full(), ipRange: full(), flopPot: 6, flopStack: 97.5,
  board, heroSeat: "ip", heroComboIdx: null, streets, handKey,
});
/** a live trace, recorded against the scripted GTO Wizard — then the scripted API is gone again */
async function liveTrace(streets: string[][], handKey: string, board?: string): Promise<ChainTrace> {
  scripted();
  const r = await solveAiChain(spec(streets, handKey, board));
  restore!(); restore = null;
  expect(r.ok).toBe(true);
  return r.trace!;
}

describe("check #13 — replay determinism (2026-09-27)", () => {
  it("a river decision walked from scratch replays identically against its own recording", async () => {
    forgetCheckpoints("rp-1");
    const t = await liveTrace([["X", "R3", "C"], ["X", "X"], ["X"]], "rp-1");
    const r = await replayTrace(t);
    expect(r).toEqual({ ok: true, diffs: [], note: null });
  });

  it("a decision that resumed from the hand's checkpoints (flop memo, turn at hero's node) replays identically", async () => {
    forgetCheckpoints("rp-2");
    await liveTrace([["X"]], "rp-2", "Ts7h2d");
    await liveTrace([["X", "R3", "C"], ["X"]], "rp-2", "Ts7h2d8c");
    const t = await liveTrace([["X", "R3", "C"], ["X", "X"], ["X"]], "rp-2");
    expect(t.checkpoint?.streetsReused).toBeGreaterThan(0);                    // the live walk really did reuse
    expect((await replayTrace(t)).ok).toBe(true);
  });

  it("a trace the replay can't reproduce is a failure that names what differed", async () => {
    forgetCheckpoints("rp-3");
    const t = await liveTrace([["X", "R3", "C"], ["X", "X"], ["X"]], "rp-3");
    const tampered = structuredClone(t);
    (tampered.streets[1]!.sent as any).pot = 99;                               // the live turn "asked" for another pot
    const r = await replayTrace(tampered);
    expect(r.ok).toBe(false);
    expect(r.diffs.map((d) => d.what)).toContain("TURN tree request.pot");
    const gone = structuredClone(t);
    gone.nodes = gone.nodes.filter((n) => !(n.street === "TURN" && n.codes.join("-") === "X"));   // a node the recording lacks
    const g = await replayTrace(gone);
    expect(g.ok).toBe(false);
    expect(g.note).toContain("TURN [X]");
  });

  it("a failed live walk is not replayable; the stub never outlives the replay", async () => {
    const api = gtowApi as any;
    const before = api.ensureCustomSolution;
    const r = await replayTrace({ spec: spec([["X"]], "rp-4"), streets: [{} as any], nodes: [], result: { ok: false, why: "x" } } as ChainTrace);
    expect(r.ok).toBeNull();
    expect(api.ensureCustomSolution).toBe(before);
  });

  // THE SEED (2026-10-14, audit finding 6): hero's flop CHECK was answered on tree A (0.8); the turn decision re-walked
  // the flop on tree B (0.2) and narrowed his check by A's answered strategy (retree-consistency) — the trace records
  // B's node and `heroAnswered.strategy` 0.8. A replay under its own key found no answered node and narrowed by B: hero's
  // turn range a quarter of the live one (8441 / 4923565359 SB 210.08 vs 105.15). Now the trace seeds it.
  it("hero's earlier action narrowed by the strategy he was answered with on another tree replays identically — only when seeded", async () => {
    forgetCheckpoints("rp-seed"); dropAnsweredNodes();
    twoTrees();
    const first = await solveAiChain(spec([["X"]], "rp-seed", "Ts7h2d"));        // his flop decision, answered on A-FLOP
    expect(first.ok).toBe(true);
    forgetCheckpoints("rp-seed");                                                  // the turn walks the flop again, on B-FLOP; A's answer is still in memory
    const turn = await solveAiChain(spec([["X", "X"], ["X"]], "rp-seed", "Ts7h2d8c"));
    restore!(); restore = null;
    expect(turn.ok).toBe(true);
    const t = turn.trace!;
    const heroFlop = t.nodes.find((n) => n.street === "FLOP" && n.codes.join("-") === "X")!;
    expect(heroFlop.heroAnswered?.src).toBe("memory");
    expect(heroFlop.heroAnswered?.strategy?.[0]).toBeCloseTo(0.8, 4);             // A's CHECK: what his range was multiplied by
    expect(heroFlop.actions[0]!.strategy[0]).toBeCloseTo(0.2, 4);                  // the recording holds B's node
    const r = await replayTrace(t);
    expect(r).toEqual({ ok: true, diffs: [], note: null });
    // the same trace with the answered strategies gone: the walk narrows his check by B's 0.2 — a quarter of the live range
    const unseeded = structuredClone(t);
    for (const n of unseeded.nodes) delete n.heroAnswered;
    const u = await replayTrace(unseeded);
    expect(u.ok).toBe(false);
    expect(u.diffs.map((d) => d.what)).toContain("TURN tree request.players.1.range.weight");
    dropAnsweredNodes();
  });

  it("a request that differs in its menu alone is the menu rule that changed since the hand — not replayable, never a fail", async () => {
    forgetCheckpoints("rp-menu");
    const t = await liveTrace([["X", "X"], ["X", "X"], ["X"]], "rp-menu");
    const drifted = structuredClone(t);
    (drifted.streets[0]!.sent as any).bet_sizes = { street_bet_sizes: [{ street: "FLOP", position_bet_sizes: [{ position: "OOP", type: "AUTOMATIC" }, { position: "IP", type: "AUTOMATIC" }] }] };
    const r = await replayTrace(drifted);
    expect(r.ok).toBeNull();
    expect(r.note).toContain("menu-rule-changed");
    expect(r.note).toContain("FLOP live OOP AUTOMATIC · IP AUTOMATIC / replay OOP FIXED");
    expect(r.note).toContain("HU_FIXED_MENU=");
    expect(r.diffs.every((d) => d.what.startsWith("FLOP tree request.bet_sizes"))).toBe(true);
    // the menu AND the pot: a fail, the pot first (the menu's diffs never hide the rest behind the diff cap)
    (drifted.streets[0]!.sent as any).pot = 99;
    const f = await replayTrace(drifted);
    expect(f.ok).toBe(false);
    expect(f.diffs[0]!.what).toBe("FLOP tree request.pot");
  });

  it("a trace from before the policy record is replayed under what it shows: the off-tree rule, its weight and lock, the absolute floor", () => {
    expect(derivedWalkPolicy({ streets: [{} as any], nodes: [{ offTree: { soft: { mode: "soft", t: 0.2, applied: true } } } as any] }))
      .toEqual({ HERO_CLASS_FLOOR: "abs", OFFTREE_RANGE: "soft", OFFTREE_RANGE_T: "0.2", OFFTREE_LOCK: "off" });
    expect(derivedWalkPolicy({ streets: [{ heroFloor: { mode: "rel5" } } as any], nodes: [{ offTree: { soft: { mode: "blend", w: 0.5, t: 0.2, lock: { ok: true } } } } as any] }))
      .toEqual({ HERO_CLASS_FLOOR: "rel5", OFFTREE_RANGE: "blend", OFFTREE_BLEND_W: "0.5", OFFTREE_RANGE_T: "0.2", OFFTREE_LOCK: "on" });
    expect(derivedWalkPolicy({ streets: [], nodes: [{ offTree: {} } as any] })).toEqual({ HERO_CLASS_FLOOR: "abs", OFFTREE_RANGE: "off", OFFTREE_LOCK: "off" });
    expect(derivedWalkPolicy({ streets: [], nodes: [] })).toEqual({ HERO_CLASS_FLOOR: "abs" });
  });

  it("the walk runs under the trace's recorded rules, and the process's own are back after", async () => {
    forgetCheckpoints("rp-pol");
    const before = process.env.OFFTREE_RANGE;
    const t = await liveTrace([["X", "X"], ["X", "X"], ["X"]], "rp-pol");
    expect(t.policy).toEqual(walkPolicy());
    const seen = new Set<string>();
    const api = gtowApi as any;
    const summary = api.treeRequestSummary;
    api.treeRequestSummary = function (input: any) { seen.add(String(process.env.OFFTREE_RANGE)); return summary.call(this, input); };
    try {
      expect((await replayTrace({ ...t, policy: { ...t.policy, OFFTREE_RANGE: "log" } })).ok).toBe(true);
    } finally { api.treeRequestSummary = summary; }
    expect([...seen]).toEqual(["log"]);
    expect(process.env.OFFTREE_RANGE).toBe(before);
  });

  it("walkPolicy round-trips: set as env, every switch reads back the same", async () => {
    const p = walkPolicy();
    expect(Object.keys(p).sort()).toEqual([...WALK_POLICY_KEYS].sort());
    const other = { HERO_CLASS_FLOOR: "rel1", HERO_STREET_AS_ANSWERED: "off", OFFTREE_RANGE: "soft", OFFTREE_BLEND_W: "0.3", OFFTREE_RANGE_T: "0.1", OFFTREE_MAX_HAND: "0.02",
      OFFTREE_LOCK: "off", OFFTREE_LOCK_FALLBACK: "off", HU_FIXED_MENU: "b", THREEWAY_MENU: "b", MENU_POT: "gross" };
    await withEnv(other, async () => {
      expect(walkPolicy()).toEqual(other);
      await withEnv(walkPolicy(), async () => expect(walkPolicy()).toEqual(other));
    });
    await withEnv({ OFFTREE_MAX_HAND: "" }, async () => expect(walkPolicy().OFFTREE_MAX_HAND).toBe(""));
    expect(walkPolicy()).toEqual(p);
  });

  it("the results table: saved once per solve, read by window and session", () => {
    const db = new ReplayChecks(":memory:");
    db.save({ solveId: 7, ts: Date.now(), replayedAt: Date.now(), clientHandId: "4920638634", sessionId: "s1", street: "river", ok: false,
      diffs: [{ what: "TURN walk", live: "root → X*", replay: "root → R6*" }], note: null });
    db.save({ solveId: 8, ts: Date.now(), replayedAt: Date.now(), clientHandId: "4920638700", sessionId: "s2", street: "flop", ok: true, diffs: [], note: null });
    expect(db.done([7, 8, 9])).toEqual(new Set([7, 8]));
    expect(db.rows(1, "s1").map((r) => r.solveId)).toEqual([7]);
    expect(replayText(db.rows(1, "s1")[0]!)).toBe("replay differs — TURN walk: live root → X* / replay root → R6*");
  });
});
