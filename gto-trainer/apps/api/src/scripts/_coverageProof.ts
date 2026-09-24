/** PROOF OF COVERAGE for the limped-pot classes the charts solve badly: what answers each, and how.
 *  Every spot goes through the LIVE entry (fastSolve, 6-max strategy) and, where the chart answered, ALSO through the
 *  GTO Wizard AI piece directly, so the two mechanisms can be compared. */
import { fastSolve } from "../services/fastSolve";
import { solvePreflopGtowAi, solvePreflopLastResort } from "../services/gtowAiPreflop";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
const POS: Record<number, string> = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
const mk = (hero: number, cards: [string, string], acts: [number, string, number?][]): ParsedHand => {
  const committed: Record<number, number> = { 5: 0.5, 6: 1 };
  for (const [s, t, a] of acts) if (t === "call") committed[s] = (committed[s] ?? 0) + (a ?? 0); else if (t === "raise" || t === "all-in") committed[s] = a ?? 0;
  const high = Math.max(...Object.values(committed));
  return { handId: 1, clientHandId: "proof", bbCents: 200, heroSeatId: hero, heroCards: cards, board: [], street: "preflop",
    actions: [{ seatId: 5, hero: hero === 5, type: "post-sb", amount: 0.5, street: "preflop" }, { seatId: 6, hero: hero === 6, type: "post-bb", amount: 1, street: "preflop" },
      ...acts.map(([s, t, a]) => ({ seatId: s, hero: s === hero, type: t, ...(a != null ? { amount: a } : {}), street: "preflop" } as ParsedAction))],
    liveSeats: [1, 2, 3, 4, 5, 6], committed, potByStreet: {}, positions: POS, stacks: Object.fromEntries([1, 2, 3, 4, 5, 6].map((s) => [s, 100 - (committed[s] ?? 0)])),
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: Object.values(committed).reduce((x, y) => x + y, 0), toCall: high - (committed[hero] ?? 0), legalActions: [], complete: false },
    ended: false } as any;
};
const SPOTS: [string, ParsedHand][] = [
  ["1 limp-3-bet, one limper: BTN limps, SB isos 5, BB folds, BTN 3-bets 15 — hero SB AQs", mk(5, ["Ah", "Qh"], [[1, "fold"], [2, "fold"], [3, "fold"], [4, "call", 1], [5, "raise", 5], [6, "fold"], [4, "raise", 15]])],
  ["2 limp-3-bet, two limpers: CO+BTN limp, SB isos 5, BB folds, CO folds, BTN 3-bets 15 — hero SB AQs", mk(5, ["Ah", "Qh"], [[1, "fold"], [2, "fold"], [3, "call", 1], [4, "call", 1], [5, "raise", 5], [6, "fold"], [3, "fold"], [4, "raise", 15]])],
  ["3 limp-jam: CO limps, BTN isos 5, SB folds, BB 3-bets 15, CO jams 100 — hero BTN QQ", mk(4, ["Qh", "Qd"], [[1, "fold"], [2, "fold"], [3, "call", 1], [4, "raise", 5], [5, "fold"], [6, "raise", 15], [3, "all-in", 100]])],
  ["4 third limper: UTG+HJ+CO limp — hero BTN 77", mk(4, ["7h", "7d"], [[1, "call", 1], [2, "call", 1], [3, "call", 1]])],
  ["5 iso above the menu over two limps: CO+BTN limp, SB isos 7.5 — hero BB AJo", mk(6, ["Ah", "Jd"], [[1, "fold"], [2, "fold"], [3, "call", 1], [4, "call", 1], [5, "raise", 7.5]])],
  ["6 BB behind two limps + SB complete: CO+BTN limp, SB completes — hero BB KJs", mk(6, ["Kh", "Jh"], [[1, "fold"], [2, "fold"], [3, "call", 1], [4, "call", 1], [5, "call", 0.5]])],
  ["7 named 4-bet in a limped pot: BTN limps, SB isos 5, BB folds, BTN 3-bets 15, SB 4-bets 35 — hero BTN AKo", mk(4, ["Ah", "Kd"], [[1, "fold"], [2, "fold"], [3, "fold"], [4, "call", 1], [5, "raise", 5], [6, "fold"], [4, "raise", 15], [5, "raise", 35]])],
];
const fmt = (acts: { action: string; frequency: number }[]) => acts.filter((a) => a.frequency >= 0.5).map((a) => `${a.action} ${Math.round(a.frequency)}`).join(" / ");
for (const [label, hand] of SPOTS) {
  console.log(`\n### ${label}`);
  let t0 = Date.now();
  const r = await fastSolve(hand, POS[hand.heroSeatId]!, { strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
  console.log(`  LIVE PATH (${((Date.now() - t0) / 1000).toFixed(1)} s): ${r.ok ? `${(r as any).source} · ${fmt(r.actions)} · ${(r.warning ?? "clean chart node").slice(0, 200)}` : "MISS " + (r as any).reason.slice(0, 200)}`);
  t0 = Date.now();
  const ai = await solvePreflopGtowAi(hand, POS[hand.heroSeatId]!, "proof");
  console.log(`  GTOW AI direct (${((Date.now() - t0) / 1000).toFixed(1)} s): ${ai.ok ? `${fmt(ai.actions)} · ${ai.note.slice(ai.note.indexOf("Tree built"), ai.note.indexOf("Tree built") + 150)}${ai.note.includes("LINE FITTED") ? " · " + ai.note.slice(ai.note.indexOf("LINE FITTED"), ai.note.indexOf("LINE FITTED") + 200) : ""}` : "cannot: " + ai.reason.slice(0, 160)}`);
  if (!ai.ok) {
    t0 = Date.now();
    const lr = await solvePreflopLastResort(hand, POS[hand.heroSeatId]!, "proof");
    console.log(`  LAST RESORT (${((Date.now() - t0) / 1000).toFixed(1)} s): ${lr.ok ? `${fmt(lr.actions)} · ${lr.note.slice(0, 220)}` : "cannot: " + lr.reason.slice(0, 160)}`);
  }
}
