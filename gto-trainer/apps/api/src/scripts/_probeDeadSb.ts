/** Which encodings of a DEAD SMALL BLIND does GTO Wizard's custom-tree API accept? Hand 732 (2026-09-23): 5 dealt,
 *  seat 1 skipped as the SB, seat 2 posted the BB, hero HJ first to act. Positions here are the CORRECTED labels. */
import { debugCreateTree, debugTree } from "../services/gtowAiPreflop";
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
console.log("--- our shape ---", JSON.stringify("error" in t ? t : { shape: t.shape, line: t.line, players: t.body.players }, null, 0));
const base = "error" in t ? [] : (t.body.players as any[]);
const withSb = (blind: number | null, stack: number) => base.map((p) => (p.position === "SB" ? { ...p, blind, stack } : p));
const cases: [string, Record<string, unknown>][] = [
  ["A default: SB blind 0.5 stack 0.5 (current dead-SB model)", {}],
  ["B SB blind 0, stack 100", { players: withSb(0, 100) }],
  ["C SB blind null, stack 100", { players: withSb(null, 100) }],
  ["D SB blind 0.01, stack 0.01 (ghost for a penny)", { players: withSb(0.01, 0.01) }],
  ["E SB blind 0.1, stack 0.1", { players: withSb(0.1, 0.1) }],
  ["F five players, no SB position at all", { players: base.filter((p) => p.position !== "SB") }],
];
for (const [label, patch] of cases) {
  try {
    const r = await debugCreateTree(hand, null, patch);
    const got = r.got;
    const players = got?.players ?? got?.tree?.players ?? null;
    console.log(`\n=== ${label}\nstatus ${r.status}`);
    if (r.status >= 300) console.log("  refused:", JSON.stringify(got).slice(0, 400));
    else console.log("  stored players:", JSON.stringify((players ?? []).map((p: any) => [p.position, p.blind, p.stack])), "| id", got?.id ?? got?.uuid ?? "?");
  } catch (e) { console.log(`\n=== ${label}\nERROR`, String(e).slice(0, 300)); }
}
