/**
 * THE LAST RESORT NARROWS ITS TWO RANGES THROUGH THE EARLIER STREETS (multiwayReroot.narrowForLastResort, 2026-10-03,
 * Brady: "do 1-3"). The re-root's own narrowing walks (narrowingPlan + narrowThroughEarlier), for the one group that
 * holds the aggressor; nothing to narrow on the flop; more must-seats than a walk holds, or a walk that fails, is a
 * refusal (the caller keeps today's unnarrowed last resort and says why). Against a synthetic GTO Wizard that answers
 * every node from the tree it was sent, each action at an equal share — so a range leaving a street is the arrival
 * range times the shares of the actions its seat took.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { StreetState, forgetCheckpoints } from "./aiChain";
import { forgetLrNarrowing, narrowForLastResort, type RerootArgs } from "./multiwayReroot";
import { raceNarrowing } from "./fastSolve";

const api = gtowApi as any;
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });
/** the synthetic GTO Wizard; `fail` makes every node a 429 */
function install(fail = false, delayMs = 0) {
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, peekNode: api.peekNode };
  const trees = new Map<string, any>();
  let n = 0;
  api.peekSolution = () => null;
  api.peekNode = () => null;
  api.ensureCustomSolution = async (input: any) => { const solId = `lr${++n}`; trees.set(solId, input); return { ok: true, solId, created: true, session: "mock" }; };
  api.customNode = async (solId: string, q: any) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail) return { ok: false, status: 429, error: `spot-solution 429: {"detail": "Request limit exceeded"}` };
    const t = trees.get(solId)!;
    const seats = [t.oopPos, ...(t.mid ? [t.mid.pos] : []), t.ipPos];
    const st = new StreetState(seats.length);
    const codes: string = q.flopActions ?? q.turnActions ?? q.riverActions ?? "";
    for (const c of codes ? codes.split("-") : []) {
      if (c === "X") st.apply("Check"); else if (c === "C") st.apply("Call"); else if (c === "F") st.apply("Fold");
      else st.apply(st.outstanding > 0 ? "Raise" : "Bet", parseFloat(c.slice(1)));
    }
    const out = st.outstanding, own = st.inv[st.actor] ?? 0, stack = t.stack;
    const acts: { code: string; name: string; betsize?: number }[] = [];
    if (out > own) {
      acts.push({ code: "F", name: "Fold" }, { code: "C", name: "Call", betsize: out });
      for (const x of [15, 30]) if (x > out && x < stack) acts.push({ code: `R${x}`, name: "Raise", betsize: x });
    } else {
      acts.push({ code: "X", name: "Check" });
      for (const x of [5, 10]) if (x < stack) acts.push({ code: `R${x}`, name: "Bet", betsize: x });
    }
    acts.push({ code: `R${stack}`, name: "Allin", betsize: stack });
    const share = new Array(1326).fill(1 / acts.length);
    return { ok: true, cached: false, solveSecs: 0, src: "fetched", data: {
      game: { players: seats.map((p, i) => ({ position: p, is_hero: i === st.actor })) },
      action_solutions: acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: seats[st.actor] }, total_frequency: 1 / acts.length, total_ev: 0, strategy: share, evs: share })),
    } };
  };
  restore = () => Object.assign(api, { ensureCustomSolution: saved.ensure, customNode: saved.node, peekSolution: saved.peek, peekNode: saved.peekNode });
  return trees;
}

const ones = () => new Array(1326).fill(1);
const args = (streets: string[][], streetSeats: string[][]): RerootArgs => ({
  ordered: ["SB", "BB", "CO", "BTN"], heroPos: "BTN", arr: ones, streets, streetSeats, flopPot: 12, flopStack: 97,
  board: "5d6d5h7c", heroComboIdx: 100, rake: null,
  specOf: (three, heroIdx) => ({ oopPos: three[0]!.pos, midPos: three[1]!.pos, ipPos: three[2]!.pos, oopRange: three[0]!.range, midRange: three[1]!.range, ipRange: three[2]!.range,
    heroSeat: heroIdx === 0 ? "oop" : heroIdx === 1 ? "mid" : "ip" }),
  behind: { SB: 97, BB: 97, CO: 97, BTN: 97 },
});

describe("narrowForLastResort", () => {
  it("on the flop there is nothing earlier to narrow", async () => {
    const r = await narrowForLastResort(args([["X", "X", "R5"]], [["SB", "BB", "CO"]]), "CO");
    expect(r).toEqual({ ok: false, why: "on the flop there is nothing earlier to narrow", ms: 0 });
  });

  it("the turn: ONE three-seat walk of the flop (hero, the aggressor, the caller) — both ranges leave it narrowed", async () => {
    forgetCheckpoints("");
    const trees = install();
    // flop: SB x, BB x, CO bets 5, hero calls, SB calls, BB folds; turn: SB x, CO bets 10 → hero faces CO
    const r = await narrowForLastResort(args([["X", "X", "R5", "C", "C", "F"], ["X", "R10"]], [["SB", "BB", "CO", "BTN", "SB", "BB"], ["SB", "CO"]]), "CO");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.walks).toBe(1);
    expect(r.group).toEqual(["BTN", "CO", "SB"]);
    // the walk is a flop tree of SB / CO / BTN with the BB, who folded, out of it
    const flop = [...trees.values()].filter((t) => t.startingStreet === "FLOP");
    expect(flop.length).toBeGreaterThan(0);
    expect([flop[0].oopPos, flop[0].mid?.pos, flop[0].ipPos]).toEqual(["SB", "CO", "BTN"]);
    // each range is the arrival's times the share of each action its seat took (hero: one call facing F/C/R15/R30/all-in)
    expect(r.hero[100]).toBeCloseTo(1 / 5, 6);
    expect(r.villain[100]).toBeLessThan(1);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("more earlier aggressors than a three-seat walk holds: refused, saying why (the caller keeps the unnarrowed last resort)", async () => {
    install();
    // flop: SB bets 5, BB raises 15, CO raises 30, hero calls, SB calls, BB calls; turn: SB x, CO bets 10
    const r = await narrowForLastResort(args([["R5", "R15", "R30", "C", "C", "C"], ["X", "X", "R10"]], [["SB", "BB", "CO", "BTN", "SB", "BB"], ["SB", "BB", "CO"]]), "CO");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toContain("more than a three-seat walk holds");
  });

  it("a narrowing walk that fails (GTO Wizard 429): refused with the walk's reason", async () => {
    forgetCheckpoints("");
    install(true);
    const r = await narrowForLastResort(args([["X", "X", "R5", "C", "C", "F"], ["X", "R10"]], [["SB", "BB", "CO", "BTN", "SB", "BB"], ["SB", "CO"]]), "CO");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/^narrowing walk BTN\/CO\/SB|narrowing walk SB\/CO\/BTN/);
  });

  it("a bet with no amount on the earlier street: refused before any walk", async () => {
    const trees = install();
    const r = await narrowForLastResort(args([["X", "X", "R", "C", "C", "F"], ["X", "R10"]], [["SB", "BB", "CO", "BTN", "SB", "BB"], ["SB", "CO"]]), "CO");
    expect(r.ok).toBe(false);
    expect(trees.size).toBe(0);
  });
});

// ---- the race (fastSolve.raceNarrowing): the narrowing never costs an answer -----------------------------------------
const okChain = (tag: string) => ({ ok: true as const, tag });
const nrOk = { ok: true as const, hero: [1], villain: [1], walks: 1, ms: 5, group: ["BTN", "CO"] };
const after = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
describe("raceNarrowing", () => {
  it("the narrowing inside the budget: the narrowed tree is served (the unnarrowed one ran beside it)", async () => {
    let unn = 0;
    const r = await raceNarrowing({ start: Date.now(), budgetMs: 300, narrowing: () => after(20, nrOk), unnarrowed: () => { unn++; return after(10, okChain("unnarrowed")); }, narrowed: () => after(10, okChain("narrowed")) });
    expect((r.chain as any).tag).toBe("narrowed");
    expect(r.record.served).toBe("narrowed");
    expect(r.record.narrowingMs).toBeGreaterThanOrEqual(15);
    expect(r.record.unnarrowedMs).not.toBeNull();
    expect(r.record.narrowedMs).not.toBeNull();
    expect(unn).toBe(1);
    expect(r.clause).toContain("narrowed by the earlier streets by 1 three-seat walk(s) (BTN/CO");
  });
  it("past the budget: the unnarrowed answer is served with the note; the walk is left to finish", async () => {
    let finished = false;
    const r = await raceNarrowing({ start: Date.now(), budgetMs: 50, narrowing: () => after(200, nrOk).then((x) => { finished = true; return x; }),
      unnarrowed: () => after(10, okChain("unnarrowed")), narrowed: () => after(10, okChain("narrowed")) });
    expect((r.chain as any).tag).toBe("unnarrowed");
    expect(r.record).toMatchObject({ served: "unnarrowed", budgetMs: 50, narrowingMs: null, why: "the narrowing walk took longer than 0.1 s" });
    expect(r.clause).toBe("ranges NOT narrowed: the narrowing walk took longer than 0.1 s (it finishes in the background for the hand's next decision)");
    expect(finished).toBe(false);
    await after(250, null);
    expect(finished).toBe(true);
  });
  it("the budget runs from the decision's start, not from the walk's", async () => {
    const r = await raceNarrowing({ start: Date.now() - 150, budgetMs: 100, narrowing: () => after(20, nrOk), unnarrowed: () => after(5, okChain("unnarrowed")), narrowed: () => after(5, okChain("narrowed")) });
    expect(r.record.served).toBe("unnarrowed");
  });
  it("a narrowing that refuses, or a narrowed tree that fails: the unnarrowed answer, saying why", async () => {
    const a = await raceNarrowing({ start: Date.now(), budgetMs: 300, narrowing: () => after(5, { ok: false as const, why: "UTG, BTN all bet or raised earlier", ms: 0 }),
      unnarrowed: () => after(5, okChain("unnarrowed")), narrowed: () => after(5, okChain("narrowed")) });
    expect([(a.chain as any).tag, a.record.why]).toEqual(["unnarrowed", "UTG, BTN all bet or raised earlier"]);
    const b = await raceNarrowing({ start: Date.now(), budgetMs: 300, narrowing: () => after(5, nrOk),
      unnarrowed: () => after(5, okChain("unnarrowed")), narrowed: () => after(5, { ok: false as const, why: "429" }) as any });
    expect([(b.chain as any).tag, b.record.why]).toEqual(["unnarrowed", "the narrowed tree failed: 429"]);
  });
});

describe("a late narrowing lands in the hand's memo", () => {
  const turn = args([["X", "X", "R5", "C", "C", "F"], ["X", "R10"]], [["SB", "BB", "CO", "BTN", "SB", "BB"], ["SB", "CO"]]);
  const river = args([["X", "X", "R5", "C", "C", "F"], ["X", "R10", "C", "C"], ["X", "R20"]], [["SB", "BB", "CO", "BTN", "SB", "BB"], ["SB", "CO", "BTN", "SB"], ["SB", "CO"]]);
  it("the turn serves unnarrowed past the budget; the walk finishes; a re-ask joins it and the river walks only the turn", async () => {
    forgetLrNarrowing(); forgetCheckpoints("hand-lr-memo#lr-narrow");
    const trees = install(false, 40);   // every node 40 ms: the flop walk takes > 100 ms
    const narrowingP = narrowForLastResort({ ...turn, memoKey: "hand-lr-memo" }, "CO");
    const r = await raceNarrowing({ start: Date.now(), budgetMs: 60, narrowing: () => narrowingP, unnarrowed: async () => okChain("unnarrowed"), narrowed: async () => okChain("narrowed") });
    expect(r.record.served).toBe("unnarrowed");
    const late = await narrowingP;                      // the walk went on in the background
    expect(late.ok).toBe(true);
    const flopTrees = () => [...trees.values()].filter((t) => t.startingStreet === "FLOP").length;
    const n0 = trees.size, f0 = flopTrees();
    // the same decision asked again: the memo, no walk
    const again = await narrowForLastResort({ ...turn, memoKey: "hand-lr-memo" }, "CO");
    expect(again).toBe(late);
    expect(trees.size).toBe(n0);
    // the river: the flop comes from the hand's checkpoint — only the turn is walked
    const rv = await narrowForLastResort({ ...river, memoKey: "hand-lr-memo" }, "CO");
    expect(rv.ok).toBe(true);
    expect(flopTrees()).toBe(f0);
    expect([...trees.values()].filter((t) => t.startingStreet === "TURN").length).toBeGreaterThan(0);
  });
});
