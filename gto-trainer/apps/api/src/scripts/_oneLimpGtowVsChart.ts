/** SB facing ONE limp (BTN limps, F-F-F-C): our D100 limp chart vs a GTO Wizard AI custom tree of the same table.
 *  GTO Wizard can hold one non-SB limper, so this is the only limped node it can cross-check. */
import { solvePreflopGtowAi } from "../services/gtowAiPreflop";
import { fetchNode } from "../services/hrc3max";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
const mk = (cards: [string, string]): ParsedHand => ({
  handId: 1, clientHandId: "onelimp", bbCents: 200, heroSeatId: 5, heroCards: cards, board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: true, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "fold", street: "preflop" },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "call", amount: 1, street: "preflop" },
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: { 4: 1, 5: 0.5, 6: 1 }, potByStreet: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
  stacks: { 1: 100, 2: 100, 3: 100, 4: 99, 5: 99.5, 6: 99 },
  currentNode: { street: "preflop", toActSeatId: 5, toActIsHero: true, pot: 2.5, toCall: 0.5, legalActions: [], complete: false },
  ended: false,
} as any);
const chart: any = await fetchNode("ign200_6max_D100_olimp", "F-F-F-C");
const fmt = (o: Record<string, number>) => Object.entries(o).filter(([, v]) => v >= 0.5).map(([k, v]) => `${k.replace("Raise ", "R")} ${Math.round(v)}`).join(" / ");
console.log("chart menu:", chart?.actions?.map((a: any) => a.token).join(" "));
for (const h of [["Ah", "Ad"], ["Kh", "Kd"], ["Qh", "Qd"], ["Th", "Td"], ["Ah", "Kd"], ["Kh", "Qd"], ["Th", "9h"], ["Ah", "5h"]] as [string, string][]) {
  const cls = h[0][0] === h[1][0] ? h[0][0] + h[1][0] : h[0][0] + h[1][0] + (h[0][1] === h[1][1] ? "s" : "o");
  const c = chart?.cells?.find((x: any) => x.hand === cls)?.actions ?? {};
  const t0 = Date.now();
  const ai = await solvePreflopGtowAi(mk(h), "SB", "cross-check");
  const aiTxt = ai.ok ? fmt(Object.fromEntries(ai.actions.map((a) => [a.action, a.frequency]))) : `FAIL ${ai.reason.slice(0, 120)}`;
  console.log(`${cls.padEnd(4)} chart: ${fmt(c).padEnd(48)} | GTOW AI: ${aiTxt}  (${Date.now() - t0} ms)`);
  if (ai.ok && h[0] === "Ah" && h[1] === "Ad") console.log("   AI shape:", ai.note.slice(0, 260));
}
