/** UTG opens 2.5, HJ calls, CO calls, hero on the BTN — the spot that used to answer from a tree with no
 *  call branch. Runs the real fastSolve entry point under the 6-max ring strategy. */
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const hand = (heroCards: string[]): ParsedHand => ({
  handId: 1, clientHandId: "pfx", bbCents: 200, heroSeatId: 3,
  heroCards, board: [], street: "preflop",
  actions: [
    { seatId: 4, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 5, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 0, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 1, hero: false, type: "call", amount: 2.5, street: "preflop" },
    { seatId: 2, hero: false, type: "call", amount: 2.5, street: "preflop" },
  ],
  liveSeats: [0, 1, 2, 3, 4, 5], committed: { 0: 2.5, 1: 2.5, 2: 2.5, 4: 0.5, 5: 1 }, potByStreet: {},
  positions: { 0: "UTG", 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB" },
  stacks: { 0: 97.5, 1: 97.5, 2: 97.5, 3: 100, 4: 99.5, 5: 99 },
  currentNode: { street: "preflop", toActSeatId: 3, toActIsHero: true, pot: 9, toCall: 2.5, legalActions: ["fold", "call", "raise"], complete: false },
  ended: false,
});

for (const cards of [["Td", "Th"], ["7c", "7d"], ["2c", "2d"], ["Ac", "Qd"], ["Kc", "Qc"]]) {
  const r = await fastSolve(hand(cards), null, { strategyId: "ign200-ring-6max-equilibrium", origin: "adhoc" });
  if (!r.ok) { console.log(`${cards.join("")}  MISS: ${r.reason}`); continue; }
  const acts = (r.actions ?? []).map((a) => `${a.action} ${a.frequency.toFixed(0)}%`).join("  ");
  console.log(`${cards.join("")}  ${String(r.decision?.action ?? "-").padEnd(10)} | ${acts}`);
  if (cards[0] === "Td") console.log(`   line: ${r.line}\n   warning: ${r.warning}`);
}
