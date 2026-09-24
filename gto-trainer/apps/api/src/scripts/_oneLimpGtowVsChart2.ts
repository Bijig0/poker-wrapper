/** Two more one-limp nodes vs GTO Wizard AI: hero BB facing BTN limp + SB complete (F-F-F-C-C), hero BTN facing a CO limp (F-F-C). */
import { solvePreflopGtowAi } from "../services/gtowAiPreflop";
import { fetchNode } from "../services/hrc3max";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
const POS: Record<number, string> = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
const mk = (hero: number, cards: [string, string], acts: [number, string, number?][]): ParsedHand => ({
  handId: 1, clientHandId: "onelimp2", bbCents: 200, heroSeatId: hero, heroCards: cards, board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: hero === 5, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: hero === 6, type: "post-bb", amount: 1, street: "preflop" },
    ...acts.map(([s, t, a]) => ({ seatId: s, hero: s === hero, type: t, ...(a != null ? { amount: a } : {}), street: "preflop" } as ParsedAction)),
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: POS,
  stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 99.5, 6: 99 },
  currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 2.5, toCall: 0, legalActions: [], complete: false },
  ended: false,
} as any);
const cases: [string, string, number, [number, string, number?][]][] = [
  ["F-F-F-C-C", "BB vs BTN limp + SB complete", 6, [[1, "fold"], [2, "fold"], [3, "fold"], [4, "call", 1], [5, "call", 0.5]]],
  ["F-F-C", "BTN vs CO limp", 4, [[1, "fold"], [2, "fold"], [3, "call", 1]]],
];
const fmt = (o: Record<string, number>) => Object.entries(o).filter(([, v]) => v >= 0.5).map(([k, v]) => `${k.replace("Raise ", "R")} ${Math.round(v)}`).join(" / ");
for (const [line, what, hero, acts] of cases) {
  const chart: any = await fetchNode("ign200_6max_D100_olimp", line);
  console.log(`\n### ${line} — ${what} (chart node pos ${chart?.pos}, menu ${chart?.actions?.map((a: any) => a.token).join(" ")})`);
  for (const h of [["Ah", "Ad"], ["Kh", "Kd"], ["Th", "Td"], ["Ah", "Kd"], ["Kh", "Qd"], ["Ah", "5h"], ["Th", "9h"], ["Qh", "Jd"]] as [string, string][]) {
    const cls = h[0][0] === h[1][0] ? h[0][0] + h[1][0] : h[0][0] + h[1][0] + (h[0][1] === h[1][1] ? "s" : "o");
    const c = chart?.cells?.find((x: any) => x.hand === cls)?.actions ?? {};
    const ai = await solvePreflopGtowAi(mk(hero, h, acts), POS[hero]!, "cross-check");
    console.log(`${cls.padEnd(4)} chart: ${fmt(c).padEnd(46)} | GTOW AI: ${ai.ok ? fmt(Object.fromEntries(ai.actions.map((a) => [a.action, a.frequency]))) : "FAIL " + ai.reason.slice(0, 140)}`);
  }
}
