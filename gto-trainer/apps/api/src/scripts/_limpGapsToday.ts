/** What the answer path returns TODAY for the tree gaps: two limps + iso 6.5 (within τ), + iso 8 (past τ), three limps. */
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
const POS: Record<number, string> = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
const mk = (hero: number, cards: [string, string], acts: [number, string, number?][], toCall: number): ParsedHand => ({
  handId: 1, clientHandId: "gaps", bbCents: 200, heroSeatId: hero, heroCards: cards, board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: hero === 5, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: hero === 6, type: "post-bb", amount: 1, street: "preflop" },
    ...acts.map(([s, t, a]) => ({ seatId: s, hero: s === hero, type: t, ...(a != null ? { amount: a } : {}), street: "preflop" } as ParsedAction)),
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: POS,
  stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 99.5, 6: 99 },
  currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 4, toCall, legalActions: [], complete: false },
  ended: false,
} as any);
const cases: [string, ParsedHand][] = [
  ["two limps, BTN isos to 6.5, hero BB with KQo", mk(6, ["Kh", "Qd"], [[1, "fold"], [2, "call", 1], [3, "call", 1], [4, "raise", 6.5], [5, "fold"]], 5.5)],
  ["two limps, BTN isos to 8, hero BB with KQo", mk(6, ["Kh", "Qd"], [[1, "fold"], [2, "call", 1], [3, "call", 1], [4, "raise", 8], [5, "fold"]], 7)],
  ["THREE limps, hero SB with A5s", mk(5, ["Ah", "5h"], [[1, "call", 1], [2, "call", 1], [3, "call", 1], [4, "fold"]], 0.5)],
];
for (const [label, hand] of cases) {
  const t0 = Date.now();
  const r = await fastSolve(hand, POS[hand.heroSeatId]!, { strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
  console.log(`\n### ${label}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (r.ok) console.log(`  ${(r as any).source ?? r.tier} · ${r.decision?.action} · ${r.actions.map((a) => `${a.action} ${Math.round(a.frequency)}`).join(" / ")}\n  ${(r.warning ?? "").slice(0, 420)}`);
  else console.log("  MISS:", (r as any).reason.slice(0, 300));
}
