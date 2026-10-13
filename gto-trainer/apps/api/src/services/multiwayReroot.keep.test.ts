/**
 * A HAND RE-ROOTED AT STREET S STAYS RE-ROOTED AT S (2026-10-14, multiwayRerootKeep). The narrowing walks are stubbed
 * (spyOn solveAiChain: each walk hands back its seats' ranges, a different value per walk, so ranges from a NEW walk can
 * be told from the kept ones); everything else is the real planning and the real hand facts (in memory, :memory: db).
 *
 * The hand: four to the flop, SB bets 3 and BB, CO (hero) and BTN all call — no collapse fits from the flop (SB and BB
 * both put chips in, hero sits between BB and BTN), so the turn is re-rooted.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as aiChain from "./aiChain";
import { forgetRerootNarrowing, rerootCollapse, type RerootArgs, type RerootResult } from "./multiwayReroot";
import { keptVillains, planCollapses, type SeatTok } from "./multiwayCollapse";
import { handFacts } from "./handFacts";
import { departureForCode } from "./approximations";
import { rerootNotKeptReason } from "./fastSolve";

const walkSpecs: any[] = [];
let walkNo = 0;
const spy = spyOn(aiChain, "solveAiChain").mockImplementation((async (spec: any) => {
  walkSpecs.push(spec);
  const n = ++walkNo;
  // a real timer: a fake that never yields to one can wedge Bun 1.3.14 on Windows (bun-abortsignal-timeout-wedge)
  await new Promise((res) => setTimeout(res, 2));
  const seats = [spec.oopPos, spec.midPos, spec.ipPos].filter(Boolean) as string[];
  return { ok: true, data: {}, potNode: 0, stackStreet: 0, line: "", solves: 0, trace: { spec } as any,
    rangesOut: Object.fromEntries(seats.map((p) => [p, new Array(1326).fill(0.1 + n / 1000)])) };
}) as any);
afterAll(() => spy.mockRestore());

const HAND = "4925000001";
afterEach(() => {
  walkSpecs.length = 0;
  handFacts.forget(HAND);
  handFacts.forget("4925000002");
  forgetRerootNarrowing();
  delete process.env.REROOT_KEEP;
});

const FOUR = ["SB", "BB", "CO", "BTN"];
const FLOP = ["R3", "C", "C", "C"];
const specOf: RerootArgs["specOf"] = (three, heroIdx) => ({ oopPos: three[0]!.pos, midPos: three[1]!.pos, ipPos: three[2]!.pos, oopRange: three[0]!.range,
  midRange: three[1]!.range, ipRange: three[2]!.range, heroSeat: heroIdx === 0 ? "oop" : heroIdx === 1 ? "mid" : "ip" });
/** the decision's re-root args, as fastSolve builds them; `streets` = [seat, token] pairs per street */
const decision = (streets: [string, string][][], o: Partial<RerootArgs> = {}): RerootArgs => ({
  ordered: FOUR, heroPos: "CO", arr: (p) => new Array(1326).fill(1 + FOUR.indexOf(p)),
  streets: streets.map((st) => st.map(([, t]) => t)), streetSeats: streets.map((st) => st.map(([p]) => p)),
  flopPot: 6, flopStack: 97, behind: { SB: 97, BB: 97, CO: 97, BTN: 97 },
  board: "Ks7d2c9h4s".slice(0, 6 + 2 * (streets.length - 1)), heroComboIdx: 7, rake: null, specOf,
  deadline: Date.now() + 60_000, handKey: HAND, ...o,
});
const flop: [string, string][] = FOUR.map((p, i) => [p, FLOP[i]!]);
/** the turn hero (CO) is first asked on: SB and BB check to him */
const TURN_ASKED = [flop, [["SB", "X"], ["BB", "X"]]] as [string, string][][];

const hashOf = (x: unknown) => Bun.hash(JSON.stringify(x)).toString(36);
/** everything aiChain's root key (rootKeyOf) hashes that the re-root decides, per tree: the chain's first street, its seats
 *  and their ranges, hero's seat, the pot and each seat's stack — and the plan's name (the chain's plan tag) */
const rootInputs = (r: RerootResult) => {
  if (!r.ok) throw new Error(r.why);
  return r.picked.plans.map((p) => ({
    first: r.first, kind: p.kind, heroIdx: p.heroIdx, pot: r.pot, stack: r.stack,
    seats: p.seats.map((s) => [s.pos, hashOf(s.range)]),
    seatStacks: Object.fromEntries(p.seats.map((s) => [s.pos, r.behind?.[s.pos]])),
  }));
};
const toks = (st: SeatTok[]) => st.map((t) => `${t.seat}:${t.tok}`);

describe("a hand re-rooted at the turn stays re-rooted at the turn", () => {
  test("(a) the river runs the turn's chain: first street 1, same seats / ranges / pot / stack / plan names, the turn's tokens as a prefix", async () => {
    const turn = await rerootCollapse(decision(TURN_ASKED));
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    expect(turn.first).toBe(1);
    expect(turn.picked.plans.map((p) => p.kind).sort()).toEqual(["ghost:BB", "ghost:BTN", "ghost:SB"]);
    expect(turn.kept).toBeUndefined();
    // hero checks, the BTN checks behind; on the river SB and BB check to him again
    const river = await rerootCollapse(decision([flop, [["SB", "X"], ["BB", "X"], ["CO", "X"], ["BTN", "X"]], [["SB", "X"], ["BB", "X"]]]));
    expect(river.ok).toBe(true);
    if (!river.ok) return;
    expect(river.first).toBe(1);
    expect(rootInputs(river)).toEqual(rootInputs(turn));
    expect(river.picked.mode).toBe(turn.picked.mode);
    for (const [i, p] of river.picked.plans.entries()) {
      const was = turn.picked.plans[i]!;
      expect(p.streets.length).toBe(2);
      expect(toks(p.streets[0]!).slice(0, was.streets[0]!.length)).toEqual(toks(was.streets[0]!));
    }
    expect(river.kept).toContain("the hand stays re-rooted at the turn");
    expect(river.picked.why).toContain("the hand stays re-rooted at the turn");
    expect(river.notKept).toBeUndefined();
  });

  test("(b) the narrowing walks run with the hand's key, checkpoint-only; a later decision walks nothing; a concurrent one joins", async () => {
    const [x, y] = await Promise.all([rerootCollapse(decision(TURN_ASKED)), rerootCollapse(decision(TURN_ASKED))]);
    expect(x.ok && y.ok).toBe(true);
    // SB bet the flop: every walk keeps hero and the SB, one caller each — two walks, walked once for both decisions
    expect(walkSpecs.length).toBe(2);
    for (const s of walkSpecs) {
      expect(s.walkThrough).toBe(true);
      expect(s.handKey).toBe(`${HAND}#reroot-narrow`);
      expect(s.checkpointOnly).toBe(true);
    }
    expect(rootInputs(y)).toEqual(rootInputs(x));
    walkSpecs.length = 0;
    const again = await rerootCollapse(decision([flop, [["SB", "X"], ["BB", "X"], ["CO", "R6"], ["BTN", "C"], ["SB", "R18"], ["BB", "F"]]]));
    expect(again.ok).toBe(true);
    expect(walkSpecs.length).toBe(0);
  });

  test("(c) a villain who folds since folds INSIDE the kept tree — not removed from its root", async () => {
    const turn = await rerootCollapse(decision(TURN_ASKED));
    if (!turn.ok) throw new Error(turn.why);
    // hero bets 6 on the turn, the BTN folds, the SB calls, the BB folds; on the river the SB checks to hero
    const river = await rerootCollapse(decision([flop,
      [["SB", "X"], ["BB", "X"], ["CO", "R6"], ["BTN", "F"], ["SB", "C"], ["BB", "F"]], [["SB", "X"]]]));
    expect(river.ok).toBe(true);
    if (!river.ok) return;
    expect(river.first).toBe(1);
    // ghost:SB no longer holds (the SB called); the two others do, and keep every villain between them
    expect(river.picked.plans.map((p) => p.kind).sort()).toEqual(["ghost:BB", "ghost:BTN"]);
    const byKind = (r: typeof turn, k: string) => r.picked.plans.find((p) => p.kind === k)!;
    const keepsBtn = byKind(river, "ghost:BB");
    expect(keepsBtn.seats.map((s) => s.pos)).toEqual(["SB", "CO", "BTN"]);
    expect(keepsBtn.seats).toEqual(byKind(turn, "ghost:BB").seats);
    expect(toks(keepsBtn.streets[0]!)).toEqual(["SB:X", "CO:R6", "BTN:F", "SB:C"]);
    expect(toks(keepsBtn.streets[1]!)).toEqual(["SB:X"]);
    expect(river.picked.why).toContain("ghost:SB no longer holds");
    expect(river.picked.why).toContain("BB, BTN folded since, inside the trees");
    // re-rooted afresh (REROOT_KEEP=off) the two folders leave from the river's root: one heads-up tree, new ranges
    process.env.REROOT_KEEP = "off";
    const fresh = await rerootCollapse(decision([flop,
      [["SB", "X"], ["BB", "X"], ["CO", "R6"], ["BTN", "F"], ["SB", "C"], ["BB", "F"]], [["SB", "X"]]]));
    if (!fresh.ok) throw new Error(fresh.why);
    expect(fresh.first).toBe(2);
    expect(fresh.picked.plans.length).toBe(1);
    expect(fresh.picked.plans[0]!.seats.map((s) => s.pos)).toEqual(["SB", "CO"]);
  });

  test("(d) a ghosted villain bets: the plans that ghosted him are dropped, and the cover is topped back up", async () => {
    // five to the flop, hero the BTN; SB bets, all call; on the turn the four villains check to hero (all of them free)
    const FIVE = ["SB", "BB", "UTG", "CO", "BTN"];
    const five = (streets: [string, string][][]): RerootArgs => decision(streets, {
      ordered: FIVE, heroPos: "BTN", arr: (p) => new Array(1326).fill(1 + FIVE.indexOf(p)), handKey: "4925000002",
      behind: { SB: 97, BB: 97, UTG: 97, CO: 97, BTN: 97 },
    });
    const flop5: [string, string][] = FIVE.map((p, i) => [p, i === 0 ? "R3" : "C"]);
    const turnChecks: [string, string][] = [["SB", "X"], ["BB", "X"], ["UTG", "X"], ["CO", "X"]];
    const turn = await rerootCollapse(five([flop5, turnChecks]));
    if (!turn.ok) throw new Error(turn.why);
    // three two-ghost collapses that between them keep every villain (coverPick)
    expect(turn.picked.plans.map((p) => p.kind)).toEqual(["ghost:BB + ghost:CO", "ghost:SB + ghost:UTG", "ghost:BB + ghost:UTG"]);
    // hero checks the turn back; on the river SB, BB, UTG check and the CO — ghosted by the first — bets
    const riverToks: [string, string][] = [["SB", "X"], ["BB", "X"], ["UTG", "X"], ["CO", "R5"]];
    const river = await rerootCollapse(five([flop5, [...turnChecks, ["BTN", "X"]], riverToks]));
    if (!river.ok) throw new Error(river.why);
    expect(river.first).toBe(1);
    // the plan that ghosted the CO is dropped; the two survivors keep the CO but neither keeps the UTG — the top-up adds
    // the legal plan that does, so every villain is in at least one tree again
    expect(river.picked.plans.map((p) => p.kind)).toEqual(["ghost:SB + ghost:UTG", "ghost:BB + ghost:UTG", "ghost:SB + ghost:BB"]);
    expect(river.picked.mode).toBe("blend");
    for (const p of river.picked.plans) expect(keptVillains(p)).toContain("CO");
    expect(new Set(river.picked.plans.flatMap(keptVillains))).toEqual(new Set(["SB", "BB", "UTG", "CO"]));
    expect(river.picked.why).toContain("ghost:BB + ghost:CO no longer holds");
    expect(river.picked.why).toContain("ghost:SB + ghost:BB added so every villain is in at least one tree");
    // the survivors are the turn's trees (same seats and ranges), the added one is legal on the kept streets
    for (const k of ["ghost:SB + ghost:UTG", "ghost:BB + ghost:UTG"]) {
      expect(river.picked.plans.find((p) => p.kind === k)!.seats).toEqual(turn.picked.plans.find((p) => p.kind === k)!.seats);
    }
    const cur: SeatTok[][] = [[...turnChecks, ["BTN", "X"]], riverToks].map((st) => st.map(([seat, tok]) => ({ tok, seat })));
    expect(planCollapses(FIVE.map((p) => ({ pos: p, range: [] })), "BTN", cur).map((p) => p.kind)).toContain("ghost:SB + ghost:BB");
    // the next decision keeps the topped-up pick
    const kept = handFacts.reroot("4925000002")!;
    expect(kept.plans!.map((p) => p.kind)).toEqual(river.picked.plans.map((p) => p.kind));
  });

  test("(e) REROOT_KEEP=off: every decision re-roots at its own street, its walks unkeyed (the behaviour before)", async () => {
    process.env.REROOT_KEEP = "off";
    const turn = await rerootCollapse(decision(TURN_ASKED));
    if (!turn.ok) throw new Error(turn.why);
    expect(turn.first).toBe(1);
    for (const s of walkSpecs) { expect(s.handKey).toBeUndefined(); expect(s.checkpointOnly).toBeUndefined(); }
    walkSpecs.length = 0;
    const river = await rerootCollapse(decision([flop, [["SB", "X"], ["BB", "X"], ["CO", "X"], ["BTN", "X"]], [["SB", "X"], ["BB", "X"]]]));
    if (!river.ok) throw new Error(river.why);
    expect(river.first).toBe(2);
    expect(walkSpecs.length).toBeGreaterThan(0);
    expect(walkSpecs.every((s) => s.streets.length === 2)).toBe(true);   // flop + turn walked again
    expect(river.kept).toBeUndefined();
    expect(handFacts.reroot(HAND)).toBeUndefined();
  });

  test("(f) an API restart (memory gone, the hand's facts kept) replays the same spec", async () => {
    const RIVER = [flop, [["SB", "X"], ["BB", "X"], ["CO", "X"], ["BTN", "X"]], [["SB", "X"], ["BB", "X"]]] as [string, string][][];
    const turn = await rerootCollapse(decision(TURN_ASKED));
    if (!turn.ok) throw new Error(turn.why);
    const live = await rerootCollapse(decision(RIVER));
    // the restart: the hand's facts only on disk, every in-process memo gone
    handFacts.dropMemory();
    forgetRerootNarrowing();
    walkSpecs.length = 0;
    const restarted = await rerootCollapse(decision(RIVER));
    expect(walkSpecs.length).toBe(0);
    expect(rootInputs(restarted)).toEqual(rootInputs(live));
    expect(rootInputs(restarted)).toEqual(rootInputs(turn));
  });

  test("the kept re-root cannot stand (the capture of the flop changed): re-rooted afresh, and the answer says why", async () => {
    await rerootCollapse(decision(TURN_ASKED));
    const reread: [string, string][] = FOUR.map((p, i) => [p, i === 0 ? "R4" : "C"]);
    const river = await rerootCollapse(decision([reread, [["SB", "X"], ["BB", "X"], ["CO", "X"], ["BTN", "X"]], [["SB", "X"], ["BB", "X"]]]));
    if (!river.ok) throw new Error(river.why);
    expect(river.first).toBe(2);
    expect(river.notKept).toBe("the flop was [R3,C,C,C] when the hand was re-rooted at the turn, the capture now says [R4,C,C,C]");
    // the fresh re-root is the hand's kept one from here on
    expect(handFacts.reroot(HAND)?.first).toBe(2);
    const reason = rerootNotKeptReason(river.notKept!, "river");
    expect(reason.code).toBe("postflop:reroot-not-kept");
    expect(departureForCode(reason.code)?.id).toBe("no-legal-collapse");
  });

  test("another hero seat on the same hand key is not kept", async () => {
    await rerootCollapse(decision(TURN_ASKED));
    const r = await rerootCollapse(decision([flop, [["SB", "X"], ["BB", "X"], ["CO", "X"]]], { heroPos: "BTN" }));
    if (!r.ok) throw new Error(r.why);
    expect(r.notKept).toBe("hero sits BTN now, CO when the hand was re-rooted at the turn");
  });
});
