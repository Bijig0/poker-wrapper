/** What fields does GTO Wizard's custom-tree API actually accept? Print the stored tree, defaults and all. */
import { debugCreateTree } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
const hand: ParsedHand = {
  handId: 1, clientHandId: "schema", bbCents: 200, heroSeatId: 5,
  heroCards: ["Kh", "Qd"], board: ["Jc", "7d", "2s"], street: "flop",
  actions: [
    { seatId: 4, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 5, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 2, hero: false, type: "call", amount: 2.5, street: "preflop" },
    { seatId: 5, hero: true, type: "call", amount: 1.5, street: "preflop" },
  ],
  liveSeats: [1, 2, 4, 5], committed: {}, potByStreet: {},
  positions: { 0: "UTG", 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB" },
  stacks: { 0: 100, 1: 97.5, 2: 97.5, 3: 97.5, 4: 97.5, 5: 97.5 },
  currentNode: { street: "flop", toActSeatId: 5, toActIsHero: true, pot: 8, toCall: 0, legalActions: [], complete: false },
  ended: false,
};
const r = await debugCreateTree(hand, null);
console.log("status", r.status);
console.log("--- what the API STORED (its own vocabulary + defaults) ---");
console.log(JSON.stringify(r.got, null, 1).slice(0, 6000));
