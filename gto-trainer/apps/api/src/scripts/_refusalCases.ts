/** Lines the line fit cannot fix: every extra limper/caller raises later, so nothing can be folded. What do we say today? */
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
const POS: Record<number, string> = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
export const mk = (hero: number, cards: [string, string], acts: [number, string, number?][], toCall: number, stacks?: Record<number, number>): ParsedHand => {
  const committed: Record<number, number> = { 5: 0.5, 6: 1 };
  for (const [s, t, a] of acts) if (t === "call" || t === "raise" || t === "all-in") committed[s] = t === "call" ? (committed[s] ?? 0) + (a ?? 0) : (a ?? 0);
  const st = stacks ?? { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 };
  const behind: Record<number, number> = {}; for (const k of Object.keys(st)) behind[+k] = st[+k]! - (committed[+k] ?? 0);
  return {
    handId: 1, clientHandId: "refusal", bbCents: 200, heroSeatId: hero, heroCards: cards, board: [], street: "preflop",
    actions: [
      { seatId: 5, hero: hero === 5, type: "post-sb", amount: 0.5, street: "preflop" },
      { seatId: 6, hero: hero === 6, type: "post-bb", amount: 1, street: "preflop" },
      ...acts.map(([s, t, a]) => ({ seatId: s, hero: s === hero, type: t, ...(a != null ? { amount: a } : {}), street: "preflop" } as ParsedAction)),
    ],
    liveSeats: [1, 2, 3, 4, 5, 6], committed, potByStreet: {}, positions: POS, stacks: behind,
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: Object.values(committed).reduce((a, b) => a + b, 0), toCall, legalActions: [], complete: false },
    ended: false,
  } as any;
};
export const CASES: [string, ParsedHand][] = [
  ["three limpers who ALL raise later: UTG/HJ/CO limp, BTN isos 5, UTG 3-bets 15, HJ 4-bets 35, CO jams; hero BTN AA", mk(4, ["Ah", "Ad"], [[1, "call", 1], [2, "call", 1], [3, "call", 1], [4, "raise", 5], [5, "fold"], [6, "fold"], [1, "raise", 15], [2, "raise", 35], [3, "all-in", 100]], 95)],
  ["three limpers, two raise later: UTG/HJ/CO limp, BTN isos 5, blinds fold, UTG 3-bets 15, HJ 4-bets 35, CO folds; hero BTN QQ", mk(4, ["Qh", "Qd"], [[1, "call", 1], [2, "call", 1], [3, "call", 1], [4, "raise", 5], [5, "fold"], [6, "fold"], [1, "raise", 15], [2, "raise", 35], [3, "fold"]], 30)],
  ["three cold-callers who all raise later: UTG opens 2.5, HJ/CO/BTN call, SB 3-bets 12, BB folds, UTG folds, HJ 4-bets 30, CO jams, BTN jams; hero SB KK", mk(5, ["Kh", "Kd"], [[1, "raise", 2.5], [2, "call", 2.5], [3, "call", 2.5], [4, "call", 2.5], [5, "raise", 12], [6, "fold"], [1, "fold"], [2, "raise", 30], [3, "all-in", 100], [4, "all-in", 100]], 88)],
];
if (import.meta.main) for (const [label, hand] of CASES) {
  const t0 = Date.now();
  const r = await fastSolve(hand, POS[hand.heroSeatId]!, { strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
  console.log(`\n### ${label}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (r.ok) console.log(`  ${(r as any).source ?? r.tier} · ${r.decision?.action} · ${r.actions.map((a) => `${a.action} ${Math.round(a.frequency)}`).join(" / ")}\n  ${(r.warning ?? "").slice(0, 300)}`);
  else console.log("  MISS:", (r as any).reason.slice(0, 500));
}
