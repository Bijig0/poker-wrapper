/** Four- and five-way flops through the real fastSolve entry point, under the 6-max ring strategy. */
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";

const pre = (): ParsedAction[] => [
  { seatId: 4, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
  { seatId: 5, hero: false, type: "post-bb", amount: 1, street: "preflop" },
];

interface Case { name: string; heroSeat: number; actions: ParsedAction[]; live: number[]; board: string[]; pot: number; toCall: number }

const CASES: Case[] = [
  {
    name: "4-way flop, checked to hero on the BTN",
    heroSeat: 3, live: [0, 2, 3, 5], board: ["Ah", "7d", "2c"], pot: 10.5, toCall: 0,
    actions: [
      ...pre(),
      { seatId: 0, hero: false, type: "raise", amount: 2.5, street: "preflop" },
      { seatId: 1, hero: false, type: "fold", street: "preflop" },
      { seatId: 2, hero: false, type: "call", amount: 2.5, street: "preflop" },
      { seatId: 3, hero: true, type: "call", amount: 2.5, street: "preflop" },
      { seatId: 4, hero: false, type: "fold", street: "preflop" },
      { seatId: 5, hero: false, type: "call", amount: 1.5, street: "preflop" },
      { seatId: 5, hero: false, type: "check", street: "flop" },
      { seatId: 0, hero: false, type: "check", street: "flop" },
      { seatId: 2, hero: false, type: "check", street: "flop" },
    ],
  },
  {
    name: "4-way flop, hero on the BTN facing a bet",
    heroSeat: 3, live: [0, 2, 3, 5], board: ["Ah", "7d", "2c"], pot: 14, toCall: 3.5,
    actions: [
      ...pre(),
      { seatId: 0, hero: false, type: "raise", amount: 2.5, street: "preflop" },
      { seatId: 1, hero: false, type: "fold", street: "preflop" },
      { seatId: 2, hero: false, type: "call", amount: 2.5, street: "preflop" },
      { seatId: 3, hero: true, type: "call", amount: 2.5, street: "preflop" },
      { seatId: 4, hero: false, type: "fold", street: "preflop" },
      { seatId: 5, hero: false, type: "call", amount: 1.5, street: "preflop" },
      { seatId: 5, hero: false, type: "check", street: "flop" },
      { seatId: 0, hero: false, type: "bet", amount: 3.5, street: "flop" },
      { seatId: 2, hero: false, type: "fold", street: "flop" },
    ],
  },
  {
    name: "5-way flop, checked to hero on the BTN",
    heroSeat: 3, live: [0, 1, 2, 3, 5], board: ["Ah", "7d", "2c"], pot: 13, toCall: 0,
    actions: [
      ...pre(),
      { seatId: 0, hero: false, type: "raise", amount: 2.5, street: "preflop" },
      { seatId: 1, hero: false, type: "call", amount: 2.5, street: "preflop" },
      { seatId: 2, hero: false, type: "call", amount: 2.5, street: "preflop" },
      { seatId: 3, hero: true, type: "call", amount: 2.5, street: "preflop" },
      { seatId: 4, hero: false, type: "fold", street: "preflop" },
      { seatId: 5, hero: false, type: "call", amount: 1.5, street: "preflop" },
      { seatId: 5, hero: false, type: "check", street: "flop" },
      { seatId: 0, hero: false, type: "check", street: "flop" },
      { seatId: 1, hero: false, type: "check", street: "flop" },
      { seatId: 2, hero: false, type: "check", street: "flop" },
    ],
  },
];

for (const c of CASES) {
  const hand: ParsedHand = {
    handId: 1, clientHandId: `fw${c.name.length}`, bbCents: 200, heroSeatId: c.heroSeat,
    heroCards: ["Kh", "Qd"], board: c.board, street: "flop",
    actions: c.actions, liveSeats: c.live, committed: {}, potByStreet: { flop: c.pot },
    positions: { 0: "UTG", 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB" },
    stacks: { 0: 97.5, 1: 97.5, 2: 97.5, 3: 97.5, 4: 99.5, 5: 97.5 },
    currentNode: { street: "flop", toActSeatId: c.heroSeat, toActIsHero: true, pot: c.pot, toCall: c.toCall, legalActions: [], complete: false },
    ended: false,
  };
  const t0 = Date.now();
  const r = await fastSolve(hand, "BTN", { strategyId: "ign200-ring-6max-equilibrium", origin: "adhoc" });
  console.log(`\n=== ${c.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!r.ok) { console.log(`  MISS: ${r.reason}`); continue; }
  console.log(`  ${r.decision?.action ?? "-"}   ${(r.actions ?? []).map((a) => `${a.action} ${a.frequency.toFixed(0)}%`).join("  ")}`);
  console.log(`  line: ${r.line}`);
  console.log(`  warning: ${String(r.warning ?? "").replace(/ · /g, "\n           · ")}`);
}
