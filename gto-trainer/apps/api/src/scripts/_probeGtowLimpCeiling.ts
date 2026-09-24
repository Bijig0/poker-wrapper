/** Can GTO Wizard's preflop tree hold TWO non-SB limpers (max_allowed_limps 3/4)? And a starting RANGE per player? */
import { debugCreateTree, debugPreflopNode } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
const hand: ParsedHand = {
  handId: 1, clientHandId: "limpceil", bbCents: 200, heroSeatId: 5, heroCards: ["Ah", "Ad"], board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: true, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "fold", street: "preflop" },
    { seatId: 3, hero: false, type: "call", amount: 1, street: "preflop" },
    { seatId: 4, hero: false, type: "call", amount: 1, street: "preflop" },
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: { 3: 1, 4: 1, 5: 0.5, 6: 1 }, potByStreet: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
  stacks: { 1: 100, 2: 100, 3: 99, 4: 99, 5: 99.5, 6: 99 },
  currentNode: { street: "preflop", toActSeatId: 5, toActIsHero: true, pot: 3.5, toCall: 0.5, legalActions: [], complete: false },
  ended: false,
} as any;
for (const lim of [2, 3, 4, null]) {
  const patch: any = { max_allowed_limps: lim };
  const t = await debugCreateTree(hand, "SB", patch);
  const n = await debugPreflopNode(hand, "SB", "F-F-C-C", patch);
  console.log(`max_allowed_limps ${lim}: tree ${t.status} (stored ${JSON.stringify(t.got?.max_allowed_limps ?? t.got?.tree?.max_allowed_limps ?? "?")}) | node F-F-C-C: ${n.ok ? `${n.actor} ` + n.actions.map((a) => `${a.code} ${((a.freq ?? 0) * 100).toFixed(0)}%`).join(" / ") : "FAIL " + n.reason.slice(0, 140)}`);
}
// starting range for a player: try two plausible formats
const base = await debugCreateTree(hand, "SB", {});
const players = base.sent.players as any[];
for (const [label, range] of [["string range", "AA,KK,QQ,AKs,AKo,77,99,KQo,AQo"], ["weighted string", "AA:1,KK:1,77:0.5,KQo:0.5"], ["169 array", new Array(169).fill(0).map((_, i) => (i % 7 === 0 ? 1 : 0))]] as [string, any][]) {
  const t = await debugCreateTree(hand, "SB", { players: players.map((p) => (p.position === "BTN" ? { ...p, range } : p)) });
  const stored = (t.got?.players ?? []).find((p: any) => p.position === "BTN")?.range;
  console.log(`BTN range as ${label}: tree ${t.status} | stored range: ${String(JSON.stringify(stored) ?? "undefined").slice(0, 120)} ${t.status >= 300 ? JSON.stringify(t.got).slice(0, 200) : ""}`);
}
