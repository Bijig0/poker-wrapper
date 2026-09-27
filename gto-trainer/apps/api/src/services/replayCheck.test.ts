import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { forgetCheckpoints, solveAiChain, type AiChainSpec, type ChainTrace } from "./aiChain";
import { ReplayChecks, replayText, replayTrace } from "./replayCheck";

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
