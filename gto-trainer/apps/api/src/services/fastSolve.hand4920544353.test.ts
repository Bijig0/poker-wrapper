/**
 * HAND 4920544353, END TO END (2026-09-25, Ignition NL5 6-max, session_20260925_135420). The archived hand replayed
 * decision by decision through the real fastSolve — the pinned 6-max chart, the four-way collapse, the chain and its
 * checkpoints, the postflop last resort — against a SYNTHETIC GTO Wizard that answers any node from the tree it was
 * sent (check / bet grid / all-in at the tree's own stack, or fold / call / raise grid / all-in). Nothing leaves the
 * process (GTOW_BLOCK=1 and both cloud calls replaced); stored traces are kept in memory.
 *
 * Hero CO 100bb opens 2.6; BTN (34.2), SB (52.4) and BB (34) call. Flop 6s8hKs: SB checks, BB bets 1, hero calls,
 * BTN raises to 10, both blinds fold, hero calls. Turn Qh: hero checks, BTN jams his last 21.6. Live, the answer was
 * "ALLIN 39.8 100%": the turn tree carried the four-way field's stack (49.8, the SB's) rolled forward, so the jam was a
 * bet with 18.2 behind it. Asserted here, both ways the turn is answered: through the merge collapse (the SB+BB seat
 * folds on the flop and the chain goes heads-up), and through the last resort (every multiway node 429, as live).
 *
 * Gated like the harness fixtures (MUTATION_GATE=1, run by setup/regress.ts in its own process): it needs the chart
 * bake, which a worktree does not carry (harnessEnv points HRC6MAX_DB at the main checkout's).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { harnessEnv } from "../scripts/mutationHarness";
import { gtowApi } from "./gtowApi";
import { StreetState, forgetCheckpoints } from "./aiChain";
import { solveStore } from "./solveStore";
import { fastSolve, forgetPreflopPin, forgetPostflopPin } from "./fastSolve";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";

const gated = process.env.MUTATION_GATE !== "1";
const HID = "4920544353";
const STRATEGY = "ign200-ring-6max-equilibrium";

// the archived export (ignition-study-wrapper/data/hands.db rowid 1176), without its feed lines and result
const RAW = {
  handId: 12, tableSlot: 1, clientHandId: HID, bbCents: 5, heroSeatId: 5, heroCards: ["K♦", "J♥"],
  board: ["6♠", "8♥", "K♠", "Q♥", "Q♣"], street: "river", liveSeats: [1, 2, 3, 4, 5, 6], committed: { 6: 21.6 }, potByStreet: {},
  positions: { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" },
  stacks: { 1: 49.8, 2: 30.4, 3: 104.4, 4: 226.6, 5: 87.4, 6: 51.6 },
  startStacks: { 1: 52.4, 2: 34, 3: 104.4, 4: 226.6, 5: 100, 6: 34.2 },
  currentNode: { street: "river", toActSeatId: 6, toActIsHero: false, pot: 31.4, toCall: 21.6, legalActions: [], complete: false },
  actions: [
    { seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.4 },
    { seatId: 2, hero: false, type: "post-bb", street: "preflop", amount: 1 },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 5, hero: true, type: "raise", street: "preflop", amount: 2.6 },
    { seatId: 6, hero: false, type: "call", street: "preflop", amount: 2.6 },
    { seatId: 1, hero: false, type: "call", street: "preflop", amount: 2.2 },
    { seatId: 2, hero: false, type: "call", street: "preflop", amount: 1.6 },
    { seatId: 1, hero: false, type: "check", street: "flop" },
    { seatId: 2, hero: false, type: "bet", street: "flop", amount: 1 },
    { seatId: 5, hero: true, type: "call", street: "flop", amount: 1 },
    { seatId: 6, hero: false, type: "raise", street: "flop", amount: 10 },
    { seatId: 1, hero: false, type: "fold", street: "flop" },
    { seatId: 2, hero: false, type: "fold", street: "flop" },
    { seatId: 5, hero: true, type: "call", street: "flop", amount: 9 },
    { seatId: 5, hero: true, type: "check", street: "turn" },
    { seatId: 6, hero: false, type: "all-in", street: "turn", amount: 21.6 },
    { seatId: 5, hero: true, type: "fold", street: "turn" },
  ],
  heroFolded: true, ended: true, lineSource: "ws", sessionId: "session_20260925_135420", stakes: "$0.03/$0.05",
};
/** hero's decision the live answer got wrong: the turn, facing the BTN's 21.6 jam */
const JAM = 17;

// ---- a synthetic GTO Wizard: every tree recorded, every node answered from the tree's own pot and stack ----------
const trees = new Map<string, any>();
let n = 0;
let multiway429 = false;
const U = new Array(1326).fill(0.5);
const api = gtowApi as any;
const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, save: (solveStore as any).save };
function install() {
  api.peekSolution = () => null;
  api.ensureCustomSolution = async (input: any) => { const solId = `mock${++n}`; trees.set(solId, input); return { ok: true, solId, created: true, session: "mock" }; };
  api.customNode = async (solId: string, q: any) => {
    const t = trees.get(solId);
    if (!t) return { ok: false, status: 404, error: "unknown solution" };
    if (multiway429 && t.mid) return { ok: false, status: 429, error: `spot-solution 429: {"detail": "Request limit exceeded"}` };
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
    return {
      ok: true, cached: false, solveSecs: 0, src: "fetched",
      data: {
        game: { players: seats.map((p, i) => ({ position: p, is_hero: i === st.actor })) },
        action_solutions: acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: seats[st.actor] }, total_frequency: 1 / acts.length, total_ev: 0, strategy: U, evs: U })),
      },
    };
  };
  (solveStore as any).save = () => null;
}
function uninstall() {
  api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; api.peekSolution = saved.peek; (solveStore as any).save = saved.save;
}

/** hero's decisions in order up to and including `upto`, as the poller asks them; the last one's answer */
async function replayTo(upto: number): Promise<any> {
  forgetPreflopPin(HID); forgetPostflopPin(HID); forgetCheckpoints(HID);
  const hand = normalizeHand(RAW).hand!;
  const heroPos = hand.positions[hand.heroSeatId] ?? null;
  let last: any = null;
  for (let i = 0; i <= upto; i++) {
    const a = hand.actions[i]!;
    if (!a.hero || /^post/.test(a.type)) continue;
    last = await fastSolve(withStartStacks(truncateAt(hand, i)), heroPos, { strategyId: STRATEGY, origin: "replay" });
  }
  return last;
}
const treesOn = (street: string) => [...trees.values()].filter((t) => t.startingStreet === street);

let restoreEnv: (() => void) | null = null;
beforeAll(() => {
  if (gated) return;
  restoreEnv = harnessEnv();
  delete process.env.POSTFLOP_DRY_RUN;   // the chain runs — against the synthetic GTO Wizard
  process.env.GTOW_PREFETCH = "0";
  install();
});
afterAll(() => {
  if (gated) return;
  uninstall();
  restoreEnv?.();
  delete process.env.GTOW_PREFETCH;
  forgetPreflopPin(HID); forgetPostflopPin(HID); forgetCheckpoints(HID);
});

describe.skipIf(gated)("hand 4920544353: the BTN's turn jam is an all-in in the tree (the table's stacks after the blinds fold)", () => {
  test("through the merge collapse: the turn goes heads-up at the BTN's 21.6 and hero may only fold or call", async () => {
    multiway429 = false; trees.clear();
    const r = await replayTo(JAM);
    expect(r.ok).toBe(true);
    expect(r.source).toBe("gtow-api-postflop");
    expect(r.actions.map((a: any) => a.action.split(" ")[0].toUpperCase())).toEqual(["FOLD", "CALL"]);
    expect(r.actions[1].action).toMatch(/21\.6/);
    const turn = treesOn("TURN");
    expect(turn.length).toBeGreaterThan(0);
    for (const t of turn) expect(t.stack).toBe(21.6);
    expect(r.warning).toContain("CO 87.4 / BTN 21.6 behind");
  }, 120_000);

  test("through the last resort (every multiway node 429, as live): hero vs the BTN at 21.6, facing his ALL-IN", async () => {
    multiway429 = true; trees.clear();
    const r = await replayTo(JAM);
    multiway429 = false;
    expect(r.ok).toBe(true);
    expect(r.actions.map((a: any) => a.action.split(" ")[0].toUpperCase())).toEqual(["FOLD", "CALL"]);
    const lr = treesOn("TURN").filter((t) => /^last-resort/.test(t.planTag ?? ""));
    expect(lr.length).toBeGreaterThan(0);
    for (const t of lr) { expect(t.stack).toBe(21.6); expect(t.pot).toBe(31.4); }
    expect(r.warning).toContain("POSTFLOP LAST RESORT");
    expect(r.warning).toContain("before the 21.6bb ALL-IN hero faces, 21.6bb behind (CO 87.4 / BTN 21.6)");
    // the last resort's two ranges are narrowed through the flop by the re-root's own walk (2026-10-03): hero and the BTN,
    // the BB and SB folded there — one heads-up walk, its tree a flop tree of CO / BTN alone
    expect(r.warning).toContain("the two entering ranges are narrowed by the earlier streets by 1 three-seat walk(s) (CO/BTN");
    const walk = treesOn("FLOP").filter((t) => !t.mid && t.oopPos === "CO" && t.ipPos === "BTN");
    expect(walk.length).toBeGreaterThan(0);
  }, 120_000);
});
