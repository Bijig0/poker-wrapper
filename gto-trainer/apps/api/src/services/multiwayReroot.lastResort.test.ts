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
import { handFacts } from "./handFacts";
import { currentRequestScope } from "./requestScope";
import { StreetState, forgetCheckpoints } from "./aiChain";
import { forgetLrNarrowing, narrowForLastResort, type RerootArgs } from "./multiwayReroot";
import { raceNarrowing } from "./fastSolve";

const api = gtowApi as any;
let restore: (() => void) | null = null;
/** the request scopes the synthetic GTO Wizard was called under ("hand|origin") */
const scopes = new Set<string>();
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
describe("raceNarrowing: one deadline for the narrowed path (review 3)", () => {
  type Ch = { ok: boolean; why?: string; tag?: string };
  const failedC = (why: string): Ch => ({ ok: false, why });
  /** a race with fake solvers; times in ms; `floorMs` 0 unless a test sets it */
  const race = (o: { budget: number; startAgo?: number; floor?: number; later?: boolean; narrowing: () => Promise<any>; un: () => Promise<Ch>; n: () => Promise<Ch> }) =>
    raceNarrowing<Ch>({ start: Date.now() - (o.startAgo ?? 0), budgetMs: o.budget, floorMs: o.floor ?? 0, later: o.later ?? true,
      narrowing: o.narrowing, unnarrowed: o.un, narrowed: o.n, failed: failedC });
  const unhandled: string[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(String((e as Error)?.message ?? e)); };
  process.on("unhandledRejection", onUnhandled);

  it("N's answer (walk + tree) inside the deadline: the narrowed tree is served; U ran beside it", async () => {
    let unn = 0;
    const r = await race({ budget: 300, narrowing: () => after(20, nrOk), un: () => { unn++; return after(10, okChain("U")); }, n: () => after(10, okChain("N")) });
    expect([(r.chain as Ch).tag, r.record.served, r.record.narrowedPath]).toEqual(["N", "narrowed", "raced"]);
    expect(unn).toBe(1);
    expect(r.record.narrowedMs).not.toBeNull();
    expect(r.clause).toContain("narrowed by the earlier streets by 1 three-seat walk(s) (BTN/CO");
  });
  it("a SLOW narrowed tree: U (ready at 10 ms) is served AT the deadline, never later; N's late answer is ignored", async () => {
    const t = Date.now();
    const r = await race({ budget: 150, narrowing: () => after(20, nrOk), un: () => after(10, okChain("U")), n: () => after(600, okChain("N")) });
    const at = Date.now() - t;
    expect([(r.chain as Ch).tag, r.record.served]).toEqual(["U", "unnarrowed"]);
    expect(at).toBeGreaterThanOrEqual(140);
    expect(at).toBeLessThan(400);
    expect(r.record.narrowedMs).toBeNull();
    expect(r.clause).toContain("did not answer within 0.1 s of the decision");
  });
  it("a THROWING narrowed tree: U served (no rejection)", async () => {
    const r = await race({ budget: 300, narrowing: () => after(5, nrOk), un: () => after(30, okChain("U")), n: async () => { throw new Error("tree boom"); } });
    expect([(r.chain as Ch).tag, r.record.why]).toEqual(["U", "the narrowed tree failed: the narrowed tree threw: tree boom"]);
  });
  it("a throw anywhere is a failure, never a rejection: the walk throws, U throws synchronously", async () => {
    const a = await race({ budget: 300, narrowing: () => { throw new Error("walk boom"); }, un: () => after(5, okChain("U")), n: () => after(5, okChain("N")) });
    expect([(a.chain as Ch).tag, a.record.why]).toEqual(["U", "the narrowing walk threw: walk boom"]);
    const b = await race({ budget: 300, narrowing: () => after(5, nrOk), un: () => { throw new Error("U boom"); }, n: () => after(5, okChain("N")) });
    expect([(b.chain as Ch).tag, b.record.served]).toEqual(["N", "narrowed"]);
  });
  it("U fails fast: N is awaited past the deadline (nothing else to serve) and served", async () => {
    const r = await race({ budget: 50, narrowing: () => after(30, nrOk), un: () => after(5, failedC("429")), n: () => after(200, okChain("N")) });
    expect([(r.chain as Ch).tag, r.record.served, r.record.why]).toEqual(["N", "narrowed", "the unnarrowed tree failed: 429"]);
    expect(r.record.servedMs).toBeGreaterThanOrEqual(200);
  });
  it("U fails fast and N cannot help (refused): U's failure at once", async () => {
    const t = Date.now();
    const r = await race({ budget: 500, narrowing: () => after(5, { ok: false as const, why: "UTG, BTN all bet or raised earlier", ms: 0 }), un: () => after(15, failedC("429")), n: () => after(5, okChain("N")) });
    expect([(r.chain as Ch).ok, (r.chain as Ch).why]).toEqual([false, "429"]);
    expect(Date.now() - t).toBeLessThan(200);
  });
  it("N refused before the deadline: U served as soon as it is ready, no wait for the deadline", async () => {
    const t = Date.now();
    const r = await race({ budget: 2000, narrowing: () => after(5, { ok: false as const, why: "no group", ms: 0 }), un: () => after(30, okChain("U")), n: () => after(5, okChain("N")) });
    expect([(r.chain as Ch).tag, r.record.why]).toEqual(["U", "no group"]);
    expect(Date.now() - t).toBeLessThan(500);
  });
  it("no room left (elapsed + the floor past the deadline): N is not raced — detached for the memo when the hand goes on, else not started", async () => {
    let walks = 0, trees = 0;
    const go = (later: boolean) => race({ budget: 6000, startAgo: 4000, floor: 2500, later, narrowing: () => { walks++; return after(5, nrOk); }, un: () => after(5, okChain("U")), n: () => { trees++; return after(5, okChain("N")); } });
    const a = await go(false);
    expect([(a.chain as Ch).tag, a.record.narrowedPath, walks, trees]).toEqual(["U", "skipped", 0, 0]);
    const b = await go(true);
    expect([(b.chain as Ch).tag, b.record.narrowedPath, walks, trees]).toEqual(["U", "detached", 1, 0]);
    expect(b.clause).toContain("2.0 s of the 6.0 s narrowing deadline was left");
  });
  it("a memo hit (the walk already done) whose narrowed tree is still too slow: U served at the deadline", async () => {
    const r = await race({ budget: 100, narrowing: () => Promise.resolve(nrOk), un: () => after(10, okChain("U")), n: () => after(500, okChain("N")) });
    expect([(r.chain as Ch).tag, r.record.served]).toEqual(["U", "unnarrowed"]);
    expect(r.record.narrowingMs).not.toBeNull();
    expect(r.record.servedMs).toBeLessThan(400);
  });
  it("the deadline runs from the decision's start, not the walk's", async () => {
    const r = await race({ budget: 100, startAgo: 150, narrowing: () => after(20, nrOk), un: () => after(5, okChain("U")), n: () => after(5, okChain("N")) });
    expect(r.record.served).toBe("unnarrowed");
  });
  it("no unhandled rejection from any of the above", async () => {
    await after(700, null);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

describe("a late narrowing lands in the hand's memo", () => {
  const turn = args([["X", "X", "R5", "C", "C", "F"], ["X", "R10"]], [["SB", "BB", "CO", "BTN", "SB", "BB"], ["SB", "CO"]]);
  const river = args([["X", "X", "R5", "C", "C", "F"], ["X", "R10", "C", "C"], ["X", "R20"]], [["SB", "BB", "CO", "BTN", "SB", "BB"], ["SB", "CO", "BTN", "SB"], ["SB", "CO"]]);
  it("the turn serves unnarrowed past the budget; the walk finishes; a re-ask joins it and the river walks only the turn", async () => {
    forgetLrNarrowing(); forgetCheckpoints("hand-lr-memo#lr-narrow"); scopes.clear();
    const trees = install(false, 40);   // every node 40 ms: the flop walk takes > 100 ms
    const narrowingP = narrowForLastResort({ ...turn, memoKey: "hand-lr-memo" }, "CO");
    const r = await raceNarrowing<{ ok: boolean; why?: string }>({ start: Date.now(), budgetMs: 60, floorMs: 0, later: true, narrowing: () => narrowingP, unnarrowed: async () => okChain("unnarrowed"), narrowed: async () => okChain("narrowed"), failed: (why) => ({ ok: false, why }) });
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
    // review 3: the walks' requests are the hand's (scope: the real hand, caller tag lr-narrow), and their checkpoints
    // stay in this process — nothing in the hand's persistent facts, under any key
    expect([...scopes]).toEqual(["hand-lr-memo|lr-narrow"]);
    expect(handFacts.streets("hand-lr-memo#lr-narrow")).toEqual([]);
    expect(handFacts.trees("hand-lr-memo#lr-narrow")).toEqual([]);
    expect(handFacts.trees("hand-lr-memo")).toEqual([]);
  });
});
