/** Does the 4-way blend actually discriminate by hand strength, or does it check everything? */
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
const actions: ParsedAction[] = [
  { seatId: 4, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
  { seatId: 5, hero: false, type: "post-bb", amount: 1, street: "preflop" },
  { seatId: 0, hero: false, type: "raise", amount: 2.5, street: "preflop" },
  { seatId: 1, hero: false, type: "fold", street: "preflop" },
  { seatId: 2, hero: false, type: "call", amount: 2.5, street: "preflop" },
  { seatId: 3, hero: true, type: "call", amount: 2.5, street: "preflop" },
  { seatId: 4, hero: false, type: "fold", street: "preflop" },
  { seatId: 5, hero: false, type: "call", amount: 1.5, street: "preflop" },
  { seatId: 5, hero: false, type: "check", street: "flop" },
  { seatId: 0, hero: false, type: "check", street: "flop" },
  { seatId: 2, hero: false, type: "check", street: "flop" },
];
for (const cards of [["2h","2d"], ["7h","7s"], ["Ad","Kc"], ["Kh","Qd"], ["6h","5h"], ["Ac","Jc"]]) {
  const hand: ParsedHand = {
    handId: 1, clientHandId: "fwh", bbCents: 200, heroSeatId: 3,
    heroCards: cards, board: ["Ah", "7d", "2c"], street: "flop",
    actions, liveSeats: [0, 2, 3, 5], committed: {}, potByStreet: { flop: 10.5 },
    positions: { 0: "UTG", 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB" },
    stacks: { 0: 97.5, 1: 97.5, 2: 97.5, 3: 97.5, 4: 99.5, 5: 97.5 },
    currentNode: { street: "flop", toActSeatId: 3, toActIsHero: true, pot: 10.5, toCall: 0, legalActions: [], complete: false },
    ended: false,
  };
  const r = await fastSolve(hand, "BTN", { strategyId: "ign200-ring-6max-equilibrium", origin: "adhoc" });
  if (!r.ok) { console.log(`${cards.join("")}  MISS ${r.reason}`); continue; }
  console.log(`${cards.join("").padEnd(5)} ${(r.actions ?? []).map((a) => `${a.action} ${a.frequency.toFixed(0)}%`).join("   ")}`);
}
