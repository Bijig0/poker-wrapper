/** Can GTO Wizard's preflop custom tree carry DEAD MONEY (a folded-out limper's 1bb) via `pot`? Line-fit case:
 *  three limps read as two, the third limper's blind kept in the pot. Hero SB with A5s facing HJ+CO limps. */
import { debugCreateTree, debugPreflopNode } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
const hand: ParsedHand = {
  handId: 1, clientHandId: "deadpot", bbCents: 200, heroSeatId: 5, heroCards: ["Ah", "5h"], board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: true, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "call", amount: 1, street: "preflop" },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: { 2: 1, 5: 0.5, 6: 1 }, potByStreet: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
  stacks: { 1: 100, 2: 99, 3: 100, 4: 100, 5: 99.5, 6: 99 },
  currentNode: { street: "preflop", toActSeatId: 5, toActIsHero: true, pot: 2.5, toCall: 0.5, legalActions: [], complete: false },
  ended: false,
} as any;
for (const [label, patch] of [["pot 0 (as today)", {}], ["pot 1 (one folded limper's blind as dead money)", { pot: 1 }], ["pot 2", { pot: 2 }]] as [string, any][]) {
  const t = await debugCreateTree(hand, "SB", patch);
  const stored = t.got?.pot ?? t.got?.tree?.pot ?? "?";
  const n = await debugPreflopNode(hand, "SB", "F-C-F-F", patch);
  console.log(`${label}: tree status ${t.status}, stored pot=${JSON.stringify(stored)} | node: ${n.ok ? `${n.actor} ` + n.actions.map((a) => `${a.code} ${((a.freq ?? 0) * 100).toFixed(0)}%`).join(" / ") : "FAIL " + n.reason.slice(0, 160)}`);
}
