/** Do the dead-SB encodings SOLVE, and what does hero (HJ, T9o, first in) get under each? Line "F" = UTG folded. */
import { debugPreflopNode, debugTree } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
const hand: ParsedHand = {
  handId: 17, clientHandId: "4919958486", bbCents: 200, heroSeatId: 4,
  heroCards: ["Ts", "9c"], board: [], street: "preflop",
  actions: [
    { seatId: 2, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
  ],
  liveSeats: [2, 3, 4, 5, 6], committed: { 2: 1 }, potByStreet: {},
  positions: { 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" },
  stacks: { 2: 99, 3: 96.1, 4: 101.5, 5: 151.2, 6: 100 },
  currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 1, toCall: 1, legalActions: [], complete: false },
  ended: false,
} as any;
const t = debugTree(hand, null);
if ("error" in t) throw new Error(t.error);
const base = t.body.players as any[];
const withSb = (blind: number | null, stack: number) => base.map((p) => (p.position === "SB" ? { ...p, blind, stack } : p));
const cases: [string, Record<string, unknown> | undefined][] = [
  ["A SB 0.5/0.5 (current model)", undefined],
  ["D SB blind 0.01 stack 0.01", { players: withSb(0.01, 0.01) }],
  ["G SB blind 0 stack 0", { players: withSb(0, 0) }],
  ["H SB blind 0 stack 0.01", { players: withSb(0, 0.01) }],
  ["B SB blind 0 stack 100 (a live extra player)", { players: withSb(0, 100) }],
];
for (const [label, patch] of cases) {
  const t0 = Date.now();
  try {
    const r = await debugPreflopNode(hand, null, "F", patch);
    console.log(`\n=== ${label}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(JSON.stringify(r).slice(0, 600));
  } catch (e) { console.log(`\n=== ${label}\nERROR`, String(e).slice(0, 300)); }
}
