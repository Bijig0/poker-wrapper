/**
 * THE CHAIN LEDGER, END TO END (2026-09-25). A heads-up-to-the-river 6-max hand replayed decision by decision through
 * the real fastSolve — the 6-max chart and its preflop pin, the arrival memo, the chain's content-addressed street
 * memo — against a SYNTHETIC GTO Wizard that caches trees and nodes by content, as gtowApi does. Asserts the HAPPY
 * PATH the ledger exists for: the flop ranges are computed once (from the pin), every later decision takes them from
 * the memo, every closed street is a hit or a resume, nothing is created or fetched twice, and the chain path says
 * "clean" with the requests it cost. Then a RESTART (the derived memo dropped, the facts read back from SQLite): the
 * ranges come back from the pin, the flop is walked again, and the path says "rebuilt" and why.
 *
 * Gated like the harness fixtures (MUTATION_GATE=1, run by setup/regress.ts in its own process): it needs the chart
 * bake, which a worktree does not carry (harnessEnv points HRC6MAX_DB at the main checkout's).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { harnessEnv } from "../scripts/mutationHarness";
import { gtowApi } from "./gtowApi";
import { StreetState, forgetCheckpoints, dropChainMemo } from "./aiChain";
import { solveStore } from "./solveStore";
import { fastSolve, forgetPreflopPin, forgetPostflopPin, dropArrivalMemo } from "./fastSolve";
import { handFacts } from "./handFacts";
import { countRequest } from "./requestScope";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";

const gated = process.env.MUTATION_GATE !== "1";
const HID = "4999000001";
const STRATEGY = "ign200-ring-6max-equilibrium";

// hero CO opens 2.5 with AKo, BB calls; flop A72: BB checks, hero bets 1.7, BB calls; turn K: BB checks, hero bets 4,
// BB calls; river 3: BB checks, hero to act
const RAW = {
  handId: 7001, tableSlot: 1, clientHandId: HID, bbCents: 200, heroSeatId: 5, heroCards: ["A♦", "K♣"],
  board: ["A♠", "7♦", "2♣", "K♥", "3♠"], street: "river", liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {},
  positions: { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" },
  stacks: { 1: 99.5, 2: 91.8, 3: 100, 4: 100, 5: 91.8, 6: 100 },
  startStacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
  currentNode: { street: "river", toActSeatId: 5, toActIsHero: true, pot: 17.9, toCall: 0, legalActions: [], complete: false },
  actions: [
    { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 },
    { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 5, hero: true, type: "raise", street: "preflop", amount: 2.5 },
    { seatId: 6, hero: false, type: "fold", street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "call", street: "preflop", amount: 1.5 },
    { seatId: 2, hero: false, type: "check", street: "flop" },
    { seatId: 5, hero: true, type: "bet", street: "flop", amount: 1.7 },
    { seatId: 2, hero: false, type: "call", street: "flop", amount: 1.7 },
    { seatId: 2, hero: false, type: "check", street: "turn" },
    { seatId: 5, hero: true, type: "bet", street: "turn", amount: 4 },
    { seatId: 2, hero: false, type: "call", street: "turn", amount: 4 },
    { seatId: 2, hero: false, type: "check", street: "river" },
  ],
  heroFolded: false, ended: false, lineSource: "ws", sessionId: "session_chain_ledger_test", stakes: "$1/$2",
};
/** hero's decisions: the open, the flop bet, the turn bet, the river (after BB's check) */
const OPEN = 4, FLOP = 9, TURN = 12, RIVER = 15;

// ---- a synthetic GTO Wizard with gtowApi's own cache semantics: one solution per tree body, one fetch per node -------
const trees = new Map<string, any>();
const solByKey = new Map<string, string>();
const nodeSeen = new Set<string>();
let n = 0;
const U = new Array(1326).fill(0.5);
const api = gtowApi as any;
const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, peekNode: api.peekNode, save: (solveStore as any).save };
const keyOf = (input: any) => JSON.stringify([input.board, input.pot, input.stack, input.startingStreet ?? "FLOP", input.oopRange, input.ipRange,
  input.rake ?? null, input.fixedLevels ?? null, input.mid?.range ?? null, input.huGrid ?? null]);
function nodeOf(solId: string, q: any): any {
  const t = trees.get(solId);
  const codesStr: string = q.flopActions ?? q.turnActions ?? q.riverActions ?? "";
  const seats = [t.oopPos, ...(t.mid ? [t.mid.pos] : []), t.ipPos];
  const st = new StreetState(seats.length);
  for (const c of codesStr ? codesStr.split("-") : []) {
    if (c === "X") st.apply("Check"); else if (c === "C") st.apply("Call"); else if (c === "F") st.apply("Fold");
    else st.apply(st.outstanding > 0 ? "Raise" : "Bet", parseFloat(c.slice(1)));
  }
  const stack = t.stack, out = st.outstanding, own = st.inv[st.actor] ?? 0;
  const grid = (from: number) => { const xs: number[] = []; for (let x = Math.ceil(from * 10) / 10; x < stack - 0.05; x = Math.round((x + 0.1) * 10) / 10) xs.push(x); return xs; };
  const acts: { code: string; name: string; betsize?: number }[] = [];
  if (out > own) {
    acts.push({ code: "F", name: "Fold" }, { code: "C", name: "Call", betsize: Math.min(out, stack) });
    if (out < stack - 0.01) { for (const x of grid(out + 0.1)) acts.push({ code: `R${x}`, name: "Raise", betsize: x }); acts.push({ code: `R${stack}`, name: "Allin", betsize: stack }); }
  } else {
    acts.push({ code: "X", name: "Check" });
    for (const x of grid(0.1)) acts.push({ code: `R${x}`, name: "Bet", betsize: x });
    acts.push({ code: `R${stack}`, name: "Allin", betsize: stack });
  }
  // every hand mixes the node's actions evenly: a strategy that sums to 1 per hand, as GTO Wizard's does (the
  // "mix valid" check, chainChecks #15, reads hero's mix off it)
  const even = new Array(1326).fill(1 / acts.length);
  return {
    game: { players: seats.map((p, i) => ({ position: p, is_hero: i === st.actor })) },
    action_solutions: acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: seats[st.actor] }, total_frequency: 1 / acts.length, total_ev: 0, strategy: even, evs: U })),
  };
}
const nodeKey = (solId: string, q: any) => JSON.stringify([solId, q.flopActions ?? "", q.turnActions ?? "", q.riverActions ?? "", q.board]);
function install() {
  api.peekSolution = (input: any) => solByKey.get(keyOf(input)) ?? null;
  api.peekNode = (solId: string, q: any) => (nodeSeen.has(nodeKey(solId, q)) ? nodeOf(solId, q) : null);
  api.ensureCustomSolution = async (input: any) => {
    const k = keyOf(input);
    const hit = solByKey.get(k);
    if (hit) return { ok: true, solId: hit, created: false, session: "mock" };
    const solId = `mock${++n}`;
    trees.set(solId, input);
    solByKey.set(k, solId);
    countRequest("tree", 200); countRequest("solution", 200);
    return { ok: true, solId, created: true, session: "mock", why: `first ${input.startingStreet} tree` };
  };
  api.customNode = async (solId: string, q: any) => {
    if (!trees.has(solId)) return { ok: false, status: 404, error: "unknown solution" };
    const k = nodeKey(solId, q);
    const cached = nodeSeen.has(k);
    if (!cached) { nodeSeen.add(k); countRequest("poll", 200); }
    return { ok: true, cached, solveSecs: 0, src: cached ? "cache" : "fetched", data: nodeOf(solId, q) };
  };
  (solveStore as any).save = () => null;
}
function uninstall() {
  api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; api.peekSolution = saved.peek; api.peekNode = saved.peekNode; (solveStore as any).save = saved.save;
}

const hand = () => normalizeHand(RAW).hand!;
/** the same hand under another id, for the warm-up test (a cold ledger) */
const HID2 = "4999000002";
const hand2 = () => normalizeHand({ ...RAW, clientHandId: HID2 }).hand!;
/** the flop as it lands: every preflop action, no flop action yet (BB, out of position, is to act) */
const FLOP_LANDS = 8;
const ask = (i: number) => {
  const h = hand();
  return fastSolve(withStartStacks(truncateAt(h, i)), h.positions[h.heroSeatId] ?? null, { strategyId: STRATEGY, origin: "live" }) as Promise<any>;
};
const hows = (r: any) => (r.path?.streets ?? []).map((s: any) => `${s.street}:${s.how}`);
/** a street's checks (services/chainChecks) as id → status */
const checkMap = (r: any, street: string) => Object.fromEntries((r.path?.checks?.[street] ?? []).map((c: any) => [c.id, c.status]));
/** each street's hand-off check: from which street, and whether it held */
const checks = (r: any) => (r.path?.streets ?? []).map((s: any) => `${s.street}<${s.check?.from ?? "preflop"}:${s.check?.ok}`);

let restoreEnv: (() => void) | null = null;
beforeAll(() => {
  if (gated) return;
  restoreEnv = harnessEnv();
  delete process.env.POSTFLOP_DRY_RUN;   // the chain runs — against the synthetic GTO Wizard
  process.env.GTOW_PREFETCH = "0";
  install();
  forgetPreflopPin(HID); forgetPostflopPin(HID); forgetCheckpoints(HID); handFacts.forget(HID);
});
afterAll(() => {
  if (gated) return;
  forgetPreflopPin(HID2); forgetPostflopPin(HID2); forgetCheckpoints(HID2); handFacts.forget(HID2);
  uninstall();
  restoreEnv?.();
  delete process.env.GTOW_PREFETCH;
  forgetPreflopPin(HID); forgetPostflopPin(HID); forgetCheckpoints(HID); handFacts.forget(HID);
});

describe.skipIf(gated)("the chain ledger: each street's ranges computed once, reused after", () => {
  test("preflop: the chart answers, the pin is a fact of the hand, the path is clean", async () => {
    const r = await ask(OPEN);
    expect(r.ok).toBe(true);
    expect(r.source).toBe("hrc-6max-preflop");
    expect(r.path.verdict).toBe("clean");
    expect(handFacts.preflop(HID)?.piece).toBe("chart6max");
  });

  test("flop: the flop ranges come from the pin; the flop is walked for the first time; a re-ask resumes and costs nothing", async () => {
    const r = await ask(FLOP);
    expect(r.ok).toBe(true);
    expect(r.path.arrival.how).toBe("pin");
    expect(r.path.arrival.producer).toBe("pin-chart6max");
    expect(hows(r)).toEqual(["flop:first"]);
    expect(r.path.verdict).toBe("clean");
    expect(r.path.requests.tree).toBe(1);
    const again = await ask(FLOP);
    expect(again.path.arrival.how).toBe("hit");
    expect(hows(again)).toEqual(["flop:resumed"]);
    expect(again.path.requests.tree + again.path.requests.poll).toBe(0);
    expect(again.path.verdict).toBe("clean");
  });

  test("turn: flop ranges from the memo, the flop resumed at hero's node and closed, the turn walked once", async () => {
    const r = await ask(TURN);
    expect(r.ok).toBe(true);
    expect(r.path.arrival.how).toBe("hit");
    expect(r.path.arrival.first.how).toBe("pin");
    expect(hows(r)).toEqual(["flop:resumed", "turn:first"]);
    expect(r.path.streets[0].tree).toBe("cached");
    expect(r.path.requests.tree).toBe(1);                // the turn's tree only
    expect(r.path.verdict).toBe("clean");
  });

  test("river: the flop is a memo hit, the turn resumes, the river is new — and nothing was created or fetched twice", async () => {
    const r = await ask(RIVER);
    expect(r.ok).toBe(true);
    expect(hows(r)).toEqual(["flop:hit", "turn:resumed", "river:first"]);
    expect(r.path.streets.every((s: any) => !s.leak)).toBe(true);
    expect(r.path.verdict).toBe("clean");
    const facts = handFacts.get(HID)!;
    expect(facts.requests?.live?.tree).toBe(3);         // one tree per street, the whole hand
    expect((facts.streets ?? []).filter((s) => s.kind === "closed").map((s) => s.k).sort()).toEqual([0, 1]);
  });

  test("the chain's invariants (services/chainChecks): every check on every street holds, nothing fails", async () => {
    const r = await ask(RIVER);
    expect(r.ok).toBe(true);
    for (const st of ["flop", "turn", "river"]) {
      const m = checkMap(r, st);
      expect(Object.values(m).filter((s) => s === "fail")).toEqual([]);
      // the inputs and the process, checked on every street against the capture and the hand's ledgers
      for (const id of [1, 2, 4, 5, 6, 7, 8, 9, 10]) expect([st, id, m[id]]).toEqual([st, id, "pass"]);
    }
    // the decision's own: hero's node, the mix, the key, hero's combo — on the river
    const river = checkMap(r, "river");
    for (const id of [14, 15, 16, 17]) expect([id, river[id]]).toEqual([id, "pass"]);
    expect(river[12]).toBeDefined();                      // the clock (the street's baseline may still be collecting)
    expect(r.path.checks.flop.find((c: any) => c.id === 1).text).toContain("preflop pin");
    expect(r.path.checks.river.find((c: any) => c.id === 5).text).toContain("16.9bb at hero's node");
    expect(r.path.checks.river.find((c: any) => c.id === 7).text).toContain("5% cap");
  });

  test("the hand-off check: the turn started from the flop solve's output, the river from the turn's", async () => {
    const turn = await ask(TURN);
    expect(checks(turn)).toEqual(["flop<preflop:null", "turn<flop:true"]);
    expect(turn.path.streets[1].check.why).toContain("verified: uses the flop solve's output ranges");
    const river = await ask(RIVER);
    expect(checks(river).at(-1)).toBe("river<turn:true");
    // every closed street recorded what it handed on
    const closed = (handFacts.get(HID)!.streets ?? []).filter((s) => s.kind === "closed");
    expect(closed.every((s) => typeof s.out === "string" && s.out.length > 0)).toBe(true);
  });

  test("the hand-off check catches a street that did not start from the previous solve's output", async () => {
    const facts = handFacts.get(HID)!;
    const turnRec = (facts.streets ?? []).find((s) => s.kind === "closed" && s.k === 1)!;
    handFacts.recordStreet(HID, { ...turnRec, out: "tampered" });   // the ledger now says the turn handed on something else
    try {
      const r = await ask(RIVER);                                     // the river resumes from its own checkpoint
      const river = r.path.streets.at(-1);
      expect(river.check.ok).toBe(false);
      expect(river.check.why).toContain("did NOT start from the turn solve's output ranges");
      expect(r.path.reasons.map((x: any) => x.code)).toContain("check:range-handoff");
      expect(r.path.verdict).toBe("rebuilt");
    } finally {
      handFacts.recordStreet(HID, turnRec);
    }
  });

  test("the flop warm-up with hero IN position seats BB out of position; the live flop reuses its tree and reads clean", async () => {
    forgetPreflopPin(HID2); forgetPostflopPin(HID2); forgetCheckpoints(HID2); handFacts.forget(HID2);
    const h = hand2();
    await fastSolve(withStartStacks(truncateAt(h, OPEN)), "CO", { strategyId: STRATEGY, origin: "live" });   // the preflop pin
    const asked: any[] = [];
    const ensure = api.ensureCustomSolution;
    api.ensureCustomSolution = async (input: any) => { asked.push(input); return ensure(input); };
    try { await fastSolve(withStartStacks(truncateAt(h, FLOP_LANDS)), "CO", { strategyId: STRATEGY, origin: "warm" }); }
    finally { api.ensureCustomSolution = ensure; }
    expect(asked.length).toBe(1);
    expect([asked[0].oopPos, asked[0].ipPos]).toEqual(["BB", "CO"]);   // hero (CO) is in position
    const r = await fastSolve(withStartStacks(truncateAt(h, FLOP)), "CO", { strategyId: STRATEGY, origin: "live" }) as any;
    expect(r.ok).toBe(true);
    expect(r.path.verdict).toBe("clean");
    expect(r.path.streets[0].tree).toBe("cached");    // the warm-up's tree, not a second one
    // …and the checks say so: the live flop walked the warm-up's tree (#11), seated as the warm-up did (#4)
    const flop = checkMap(r, "flop");
    expect([flop[11], flop[4], flop[9]]).toEqual(["pass", "pass", "pass"]);
    expect(r.path.checks.flop.find((c: any) => c.id === 11).text).toContain("the warm-up's tree");
    expect(r.path.checks.flop.find((c: any) => c.id === 4).text).toContain("the warm-up seated the same");
  });

  test("a restart: the derived memo is gone, the facts come back from SQLite — the path says REBUILT and why", async () => {
    dropArrivalMemo();
    dropChainMemo();
    handFacts.dropMemory();
    const r = await ask(RIVER);
    expect(r.ok).toBe(true);
    expect(r.path.arrival.how).toBe("pin");               // the pin survived: the flop ranges are its, not a re-pick
    expect(r.path.streets[0].how).toBe("rebuilt");
    expect(r.path.streets[0].code).toBe("street:memo-lost");
    expect(r.path.verdict).toBe("rebuilt");
    expect(r.path.reasons.map((x: any) => x.code)).toContain("street:memo-lost");
  });
});
