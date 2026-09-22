/** Does allow_call_facing_2plus_distinct_bets open up a SECOND cold-caller? */
import { debugPreflopNode } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
const hand: ParsedHand = {
  handId: 1, clientHandId: "flag", bbCents: 200, heroSeatId: 5,
  heroCards: ["Kh", "Qd"], board: ["Jc", "7d", "2s"], street: "flop",
  actions: [
    { seatId: 4, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 5, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 0, hero: false, type: "fold", street: "preflop" },
    { seatId: 1, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 2, hero: false, type: "call", amount: 2.5, street: "preflop" },
    { seatId: 3, hero: false, type: "call", amount: 2.5, street: "preflop" },
    { seatId: 4, hero: false, type: "call", amount: 2, street: "preflop" },
    { seatId: 5, hero: true, type: "call", amount: 1.5, street: "preflop" },
  ],
  liveSeats: [1, 2, 3, 4, 5], committed: {}, potByStreet: {},
  positions: { 0: "UTG", 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB" },
  stacks: { 0: 100, 1: 97.5, 2: 97.5, 3: 97.5, 4: 97.5, 5: 97.5 },
  currentNode: { street: "flop", toActSeatId: 5, toActIsHero: true, pot: 12.5, toCall: 0, legalActions: [], complete: false },
  ended: false,
};
const VARIANTS: { name: string; pos?: Record<string, unknown> }[] = [
  { name: "as shipped" },
  { name: "allow_call_facing_2plus_distinct_bets=true", pos: { allow_call_facing_2plus_distinct_bets: true } },
];
for (const v of VARIANTS) {
  console.log(`\n--- ${v.name}`);
  for (const line of ["F-R2.5", "F-R2.5-C", "F-R2.5-C-C", "F-R2.5-C-C-C", "F-R2.5-C-C-C-C"]) {
    const r = await debugPreflopNode(hand, null, line, undefined, v.pos);
    if (!r.ok) { console.log(`  ${line.padEnd(16)} ERROR ${String(r.reason).slice(0, 110)}`); continue; }
    const hasCall = r.actions.some((a) => /^C/i.test(a.code));
    console.log(`  ${line.padEnd(16)} ${String(r.actor).padEnd(4)} ${hasCall ? "CALL-OK " : "NO-CALL "} ${r.actions.map((a) => a.code).join(" ")}`);
  }
}
