/** Postflop robustness probes: range reconstruction on ugly preflop lines, an all-in street, and a 4-way turn shape. */
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
const POS: Record<number, string> = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
function mk(hero: number, cards: [string, string], pre: [number, string, number?][], board: string[], post: [string, [number, string, number?][]][], toCall: number): ParsedHand {
  const committed: Record<number, number> = { 5: 0.5, 6: 1 };
  const acts: ParsedAction[] = [{ seatId: 5, hero: hero === 5, type: "post-sb", amount: 0.5, street: "preflop" }, { seatId: 6, hero: hero === 6, type: "post-bb", amount: 1, street: "preflop" }];
  const apply = (street: string, list: [number, string, number?][], round: Record<number, number>) => {
    for (const [s, t, a] of list) { acts.push({ seatId: s, hero: s === hero, type: t, ...(a != null ? { amount: a } : {}), street } as ParsedAction);
      if (t === "call") round[s] = (round[s] ?? 0) + (a ?? 0); else if (t === "raise" || t === "bet" || t === "all-in") round[s] = a ?? 0; }
  };
  apply("preflop", pre, committed);
  const totals: Record<number, number> = { ...committed };
  const rounds = post.map(([st, list]) => { const r: Record<number, number> = {}; apply(st, list, r); for (const [s, v] of Object.entries(r)) totals[+s] = (totals[+s] ?? 0) + v; return r; });
  const cur = post.length ? post[post.length - 1]![0] : "preflop"; const curRound = rounds[rounds.length - 1] ?? {};
  const potBefore = Object.values(totals).reduce((x, y) => x + y, 0) - Object.values(curRound).reduce((x, y) => x + y, 0);
  return { handId: 1, clientHandId: "pfgap2", bbCents: 200, heroSeatId: hero, heroCards: cards, board, street: cur, actions: acts, liveSeats: [1, 2, 3, 4, 5, 6], committed: curRound, potByStreet: {}, positions: POS,
    stacks: Object.fromEntries([1, 2, 3, 4, 5, 6].map((s) => [s, Math.max(0, 100 - (totals[s] ?? 0))])),
    currentNode: { street: cur, toActSeatId: hero, toActIsHero: true, pot: potBefore, toCall, legalActions: [], complete: false }, ended: false } as any;
}
const SPOTS: [string, ParsedHand][] = [
  ["D: off-tree iso over two limps + three callers — CO/BTN limp, SB isos 7.5, BB calls, CO calls, BTN calls; flop Ts9s4h 4-way, SB bets 5, BB(hero) to act (Qs Js)",
    mk(6, ["Qs", "Js"], [[1, "fold"], [2, "fold"], [3, "call", 1], [4, "call", 1], [5, "raise", 7.5], [6, "call", 6.5], [3, "call", 6.5], [4, "call", 6.5]], ["Ts", "9s", "4h"], [["flop", [[5, "bet", 5]]]], 5)],
  ["E: 4-way TURN, everyone committed the turn, hero between — limped pot CO/BTN/SB/BB(hero); flop all check; turn 2d: SB bets 3, hero calls 3, CO raises 10, BTN calls 10, SB calls 10; hero to act (KdQd on Kc7h2s2d)",
    mk(6, ["Kd", "Qd"], [[1, "fold"], [2, "fold"], [3, "call", 1], [4, "call", 1], [5, "call", 0.5], [6, "check"]], ["Kc", "7h", "2s", "2d"], [["flop", [[5, "check"], [6, "check"], [3, "check"], [4, "check"]]], ["turn", [[5, "bet", 3], [6, "call", 3], [3, "raise", 10], [4, "call", 10], [5, "call", 10]]]], 7)],
  ["F: facing an ALL-IN 4-way on the flop — limped pot, flop 8h8d3c: SB bets 3, BB(hero) calls, CO jams 99, BTN folds, SB folds; hero to act (A8s)",
    mk(6, ["Ah", "8s"], [[1, "fold"], [2, "fold"], [3, "call", 1], [4, "call", 1], [5, "call", 0.5], [6, "check"]], ["8h", "8d", "3c"], [["flop", [[5, "bet", 3], [6, "call", 3], [3, "all-in", 99], [4, "fold"], [5, "fold"]]]], 96)],
  ["G: 3-bet pot 4-way with a cold 4-bet call — UTG opens 2.5, HJ calls, CO 3-bets 9, BTN calls 9, UTG calls, HJ calls; flop Jh7c2c 4-way, checks to hero CO (AcKc), BTN bets 12 after? no: hero CO to act after UTG, HJ check",
    mk(3, ["Ac", "Kc"], [[1, "raise", 2.5], [2, "call", 2.5], [3, "raise", 9], [4, "call", 9], [5, "fold"], [6, "fold"], [1, "call", 6.5], [2, "call", 6.5]], ["Jh", "7c", "2c"], [["flop", [[1, "check"], [2, "check"]]]], 0)],
];
for (const [label, hand] of SPOTS) {
  const t0 = Date.now();
  const r = await fastSolve(hand, POS[hand.heroSeatId]!, { strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
  console.log(`\n### ${label}\n  (${((Date.now() - t0) / 1000).toFixed(1)} s) ${r.ok ? `${(r as any).source ?? r.tier} · ${r.actions.filter((a) => a.frequency >= 0.5).map((a) => `${a.action} ${Math.round(a.frequency)}`).join(" / ")}\n  ${(r.warning ?? "").slice(0, 330)}` : "MISS: " + (r as any).reason.slice(0, 420)}`);
}
