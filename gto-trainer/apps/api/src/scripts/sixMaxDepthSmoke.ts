/**
 * Smoke test for the postflop STACK the 6-max ring strategy (and the generic library-set path) sends to GTO
 * Wizard: synthetic 6-max hands at 100bb through fastSolve, with gtowApi.ensureCustomSolution spied so the
 * tree request's pot and stack are printed. preflopPotStack wants the stack AS DEALT — a 100bb single-raised
 * pot must reach the flop tree as 97.5 behind, not 95 (the double subtraction fixed 2026-09-22).
 *
 * Without --solve the spy answers "not solved" after printing, so no GTO Wizard solve is spent.
 *
 *   bun src/scripts/sixMaxDepthSmoke.ts [--solve]
 */
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { gtowApi } from "../services/gtowApi";

const SOLVE = process.argv.includes("--solve");
const trees: any[] = [];
const ensure = (gtowApi as any).ensureCustomSolution.bind(gtowApi);
(gtowApi as any).ensureCustomSolution = async (t: any) => {
  trees.push(t);
  console.log(`   [tree] ${t.startingStreet} board ${t.board} pot ${t.pot} stack ${t.stack} ${t.oopPos}${t.mid ? "/" + t.mid.pos : ""}/${t.ipPos}`);
  return SOLVE ? ensure(t) : { ok: false, error: "smoke: tree not solved (pass --solve)" };
};

type Act = { seatId: number; hero?: boolean; type: string; amount?: number; street: string };
const POS: Record<number, string> = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
let n = 0;

function hand(hero: number, cards: string[], acts: Act[], street: string, board: string[], behind: Record<number, number>): ParsedHand {
  const stacks: Record<number, number> = {};
  for (const s of [1, 2, 3, 4, 5, 6]) stacks[s] = behind[s] ?? 100;
  return {
    handId: ++n, clientHandId: `depth-smoke-${Date.now()}-${n}`, bbCents: 200,
    heroSeatId: hero, heroCards: cards, board, street: street as any,
    actions: [{ seatId: 5, type: "post-sb", amount: 0.5, street: "preflop" },
              { seatId: 6, type: "post-bb", amount: 1, street: "preflop" }, ...acts]
      .map((a) => ({ hero: a.seatId === hero, ...a })) as any,
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: POS, stacks,
    currentNode: { street: street as any, toActSeatId: hero, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false },
    ended: false,
  } as ParsedHand;
}

const srp: Act[] = [
  { seatId: 1, type: "fold", street: "preflop" }, { seatId: 2, type: "fold", street: "preflop" },
  { seatId: 3, type: "fold", street: "preflop" }, { seatId: 4, type: "raise", amount: 2.5, street: "preflop" },
  { seatId: 5, type: "fold", street: "preflop" }, { seatId: 6, type: "call", amount: 1.5, street: "preflop" },
];
const threeWay: Act[] = [
  { seatId: 1, type: "fold", street: "preflop" }, { seatId: 2, type: "fold", street: "preflop" },
  { seatId: 3, type: "raise", amount: 2.5, street: "preflop" }, { seatId: 4, type: "call", amount: 2.5, street: "preflop" },
  { seatId: 5, type: "fold", street: "preflop" }, { seatId: 6, type: "call", amount: 1.5, street: "preflop" },
];
const board = ["9h", "7c", "2d"];
const flopBet: Act[] = [
  { seatId: 6, type: "check", street: "flop" }, { seatId: 4, type: "bet", amount: 3.3, street: "flop" },
  { seatId: 6, type: "call", amount: 3.3, street: "flop" },
];

const cases: [string, number, ParsedHand][] = [
  ["FLOP  BTN 2.5x / BB call, 100bb dealt", 97.5,
    hand(4, ["As", "Kd"], [...srp, { seatId: 6, type: "check", street: "flop" }], "flop", board, { 4: 97.5, 6: 97.5 })],
  ["TURN  same, flop x / bet 3.3 / call", 97.5,
    hand(4, ["As", "Kd"], [...srp, ...flopBet, { seatId: 6, type: "check", street: "turn" }], "turn", [...board, "Qs"], { 4: 94.2, 6: 94.2 })],
  ["RIVER same, turn x / x", 97.5,
    hand(4, ["As", "Kd"], [...srp, ...flopBet, { seatId: 6, type: "check", street: "turn" }, { seatId: 4, type: "check", street: "turn" },
      { seatId: 6, type: "check", street: "river" }], "river", [...board, "Qs", "3h"], { 4: 94.2, 6: 94.2 })],
  ["TURN  3-bet pot: BTN 2.5x / BB 3-bet 11 / call, flop BB bet 6 / call", 89,
    hand(4, ["Qs", "Qd"], [
      { seatId: 1, type: "fold", street: "preflop" }, { seatId: 2, type: "fold", street: "preflop" },
      { seatId: 3, type: "fold", street: "preflop" }, { seatId: 4, type: "raise", amount: 2.5, street: "preflop" },
      { seatId: 5, type: "fold", street: "preflop" }, { seatId: 6, type: "raise", amount: 11, street: "preflop" },
      { seatId: 4, type: "call", amount: 8.5, street: "preflop" },
      { seatId: 6, type: "bet", amount: 6, street: "flop" }, { seatId: 4, type: "call", amount: 6, street: "flop" },
      { seatId: 6, type: "check", street: "turn" }], "turn", [...board, "Qs"].map((c) => (c === "Qs" ? "Ks" : c)), { 4: 83, 6: 83 })],
  ["3-WAY FLOP CO 2.5x / BTN call / BB call", 97.5,
    hand(4, ["Ts", "Tc"], [...threeWay, { seatId: 6, type: "check", street: "flop" }, { seatId: 3, type: "check", street: "flop" }],
      "flop", board, { 3: 97.5, 4: 97.5, 6: 97.5 })],
];

const modes: [string, any][] = [
  ["6-max strategy", { strategyId: "ign200-ring-6max-equilibrium" }],
  ["generic (no strategy)", {}],
];
let bad = 0;
for (const [mname, opts] of modes) {
  console.log(`\n######## ${mname}`);
  for (const [label, want, h] of cases) {
    trees.length = 0;
    console.log(`\n== ${label} (want flop stack ${want})`);
    const r: any = await fastSolve(h, h.positions[h.heroSeatId]!, opts);
    const flop = trees.find((t) => t.startingStreet === "flop") ?? trees[0];
    if (!flop) console.log(`   no tree requested — ${r.ok ? `answered by ${r.source}/${r.tier}` : r.reason}`);
    else {
      const ok = Math.abs(Number(flop.stack) - want) < 0.05;
      if (!ok) bad++;
      console.log(`   ${ok ? "OK " : "BAD"} flop tree stack ${flop.stack} (want ${want})${SOLVE && r.ok ? ` -> ${r.decision?.action}` : ""}`);
    }
  }
}
console.log(`\n${bad ? `${bad} case(s) sent the wrong stack` : "every tree carried the stack as dealt"}`);
process.exit(bad ? 1 : 0);
