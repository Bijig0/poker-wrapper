/**
 * HAND 4922269408 (2026-10-04, HTTP 500 on hero's turn): a seat with nothing behind among the spec's seats at flop entry
 * (the CO, all-in preflop for 13.4 by a "raise"), hero's flop decision answered, then the turn decision — the flop
 * resumed from hero's node with the checkpoint's TWO seats while the seat count said three: `seats[n - 1].range` threw.
 * Through solveAiChain against a synthetic GTO Wizard (every node answered from the tree it was sent; a size-free tree
 * offers 33% / 75% pot and all-in, a pinned tree also the sizes the line played), the three ways the flop can resume:
 *   A  the same tree (the crash: BB bets 15, hero called; turn BB bets 33.6)
 *   B  onto a NEW tree, the prefix size-free (BB checks to hero, hero bets 7 — a size the size-free tree lacks)
 *   C  a new tree with a wager in the prefix: walked from the root (BB bets 15, hero raises 40)
 * Each must answer, on two seats, without a throw.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { StreetState, forgetCheckpoints, solveAiChain, type AiChainSpec } from "./aiChain";
import { handFacts } from "./handFacts";

const api = gtowApi as any;
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });
const U = new Array(1326).fill(0.5);
function install() {
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, peekNode: api.peekNode };
  const trees = new Map<string, any>();

  api.peekSolution = () => null;
  api.peekNode = () => null;
  api.ensureCustomSolution = async (input: any) => { const solId = `rb${Bun.hash(JSON.stringify(input)).toString(36)}`; /* the same tree, the same id (as GTO Wizard) */ trees.set(solId, input); return { ok: true, solId, created: true, session: "mock" }; };
  api.customNode = async (solId: string, q: any) => {
    const t = trees.get(solId);
    if (!t) return { ok: false, status: 404, error: "unknown solution" };
    const seats = [t.oopPos, ...(t.mid ? [t.mid.pos] : []), t.ipPos];
    const st = new StreetState(seats.length, t.stacks ?? undefined);
    const codes: string = q.flopActions ?? q.turnActions ?? q.riverActions ?? "";
    for (const c of codes ? codes.split("-") : []) {
      if (c === "X") st.apply("Check"); else if (c === "C") st.apply("Call"); else if (c === "F") st.apply("Fold");
      else st.apply(st.outstanding > 0 ? "Raise" : "Bet", parseFloat(c.slice(1)));
    }
    const out = st.outstanding, own = st.inv[st.actor] ?? 0, stack = (t.stacks?.[st.actor] ?? t.stack) as number;
    const played: number[] = Object.values(t.played ?? {}).flat().map((w: any) => Number(w.to)).filter((x) => Number.isFinite(x));
    const sizes = [...new Set([Math.round(t.pot * 0.33 * 10) / 10, Math.round(t.pot * 0.75 * 10) / 10, ...played])].sort((a, b) => a - b);
    const acts: { code: string; name: string; betsize?: number }[] = [];
    if (out > own) {
      acts.push({ code: "F", name: "Fold" }, { code: "C", name: "Call", betsize: Math.min(out, stack) });
      for (const x of [...sizes, Math.round(out * 2.5 * 10) / 10]) if (x > out && x < stack - 0.05) acts.push({ code: `R${x}`, name: "Raise", betsize: x });
    } else {
      acts.push({ code: "X", name: "Check" });
      for (const x of sizes) if (x > 0 && x < stack - 0.05) acts.push({ code: `R${x}`, name: "Bet", betsize: x });
    }
    if (out < stack - 0.01) acts.push({ code: `R${stack}`, name: "Allin", betsize: stack });
    return { ok: true, cached: false, solveSecs: 0, src: "fetched", data: {
      game: { players: seats.map((p, i) => ({ position: p, is_hero: i === st.actor })) },
      action_solutions: acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: seats[st.actor] }, total_frequency: 1 / acts.length, total_ev: 0, strategy: U, evs: U })),
    } };
  };
  restore = () => Object.assign(api, { ensureCustomSolution: saved.ensure, customNode: saved.node, peekSolution: saved.peek, peekNode: saved.peekNode });
}

const full = () => new Array(1326).fill(1);
/** BB / UTG (hero) / CO at the flop; the CO all-in preflop (0 behind) */
const spec = (handKey: string, streets: string[][], streetSeats: string[][]): AiChainSpec => ({
  oopPos: "BB", midPos: "UTG", ipPos: "CO", oopRange: full(), midRange: full(), ipRange: full(), heroSeat: "mid",
  flopPot: 41.6, flopStack: 87.6, seatStacks: { BB: 126.2, UTG: 89.4, CO: 0 },
  board: "Kd8s3c2h", heroComboIdx: 100, streets, streetSeats, handKey,
});
const twoSeats = (r: any) => (r.trace?.streets ?? []).every((s: any) => (s.players ?? []).length === 2 && !s.players.includes("CO"));

describe("hand 4922269408: a seat broke at flop entry, the flop resumed on the turn", () => {
  it("A — the same tree (BB bets 15, hero calls; turn BB bets 33.6): the turn answers on two seats", async () => {
    const hk = "test-resume-broke-a";
    forgetCheckpoints(hk); handFacts.forget(hk); install();
    const flop = await solveAiChain(spec(hk, [["R15"]], [["BB"]]));
    expect(flop.ok).toBe(true);
    expect(twoSeats(flop)).toBe(true);
    const turn = await solveAiChain(spec(hk, [["R15", "C"], ["R33.6"]], [["BB", "UTG"], ["BB"]]));
    expect(turn.ok).toBe(true);
    expect(twoSeats(turn)).toBe(true);
    if (turn.ok) expect(turn.trace.streets[0]!.resumedAt).toBe(1);
  });
  it("B — onto a NEW tree, the prefix size-free (BB checks, hero bets 7): answers on two seats", async () => {
    const hk = "test-resume-broke-b";
    forgetCheckpoints(hk); handFacts.forget(hk); install();
    expect((await solveAiChain(spec(hk, [["X"]], [["BB"]]))).ok).toBe(true);
    const turn = await solveAiChain(spec(hk, [["X", "R7", "C"], ["R20"]], [["BB", "UTG", "BB"], ["BB"]]));
    expect(turn.ok).toBe(true);
    expect(twoSeats(turn)).toBe(true);
  });
  it("C — a new tree with a wager in the prefix (BB bets 15, hero raises 40): walked from the root, two seats", async () => {
    const hk = "test-resume-broke-c";
    forgetCheckpoints(hk); handFacts.forget(hk); install();
    expect((await solveAiChain(spec(hk, [["R15"]], [["BB"]]))).ok).toBe(true);
    const turn = await solveAiChain(spec(hk, [["R15", "R40", "C"], ["R30"]], [["BB", "UTG", "BB"], ["BB"]]));
    expect(turn.ok).toBe(true);
    expect(twoSeats(turn)).toBe(true);
  });
});
