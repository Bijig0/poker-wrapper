/** Postflop gap probes: (A) a flop after a preflop line only the LAST RESORT could answer; (B) the register's refused
 *  4+ way shape (every villain committed THIS street, hero between); (C) a 5-way limped flop after a fitted preflop. */
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
const POS: Record<number, string> = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
function mk(hero: number, cards: [string, string], pre: [number, string, number?][], board: string[], post: [string, [number, string, number?][]][], toCall: number): ParsedHand {
  const committed: Record<number, number> = { 5: 0.5, 6: 1 }; const put: Record<number, number> = { 5: 0.5, 6: 1 };
  const acts: ParsedAction[] = [{ seatId: 5, hero: hero === 5, type: "post-sb", amount: 0.5, street: "preflop" }, { seatId: 6, hero: hero === 6, type: "post-bb", amount: 1, street: "preflop" }];
  const apply = (street: string, list: [number, string, number?][], round: Record<number, number>) => {
    for (const [s, t, a] of list) {
      acts.push({ seatId: s, hero: s === hero, type: t, ...(a != null ? { amount: a } : {}), street } as ParsedAction);
      if (t === "call") round[s] = (round[s] ?? 0) + (a ?? 0); else if (t === "raise" || t === "bet" || t === "all-in") round[s] = a ?? 0;
    }
  };
  apply("preflop", pre, committed);
  for (const s of Object.keys(committed)) put[+s] = committed[+s]!;
  const streetsIn = post.map(([st, list]) => { const r: Record<number, number> = {}; apply(st, list, r); return r; });
  const totals: Record<number, number> = { ...put };
  for (const r of streetsIn) for (const [s, v] of Object.entries(r)) totals[+s] = (totals[+s] ?? 0) + v;
  const cur = post.length ? post[post.length - 1]![0] : "preflop";
  const curRound = streetsIn[streetsIn.length - 1] ?? {};
  const potBefore = Object.values(totals).reduce((x, y) => x + y, 0) - Object.values(curRound).reduce((x, y) => x + y, 0);
  return { handId: 1, clientHandId: "pfgap", bbCents: 200, heroSeatId: hero, heroCards: cards, board, street: cur, actions: acts,
    liveSeats: [1, 2, 3, 4, 5, 6], committed: curRound, potByStreet: {}, positions: POS,
    stacks: Object.fromEntries([1, 2, 3, 4, 5, 6].map((s) => [s, 100 - (totals[s] ?? 0)])),
    currentNode: { street: cur, toActSeatId: hero, toActIsHero: true, pot: potBefore, toCall, legalActions: [], complete: false }, ended: false } as any;
}
const SPOTS: [string, ParsedHand][] = [
  ["A: LAST-RESORT preflop line, 3-way flop — UTG limp, HJ(hero) limp, CO isos 5, folds, UTG limp-3-bets 18, hero calls, CO calls; flop 9s7h2c, UTG checks, hero to act (AKs)",
    mk(2, ["Ac", "Ks"], [[1, "call", 1], [2, "call", 1], [3, "raise", 5], [4, "fold"], [5, "fold"], [6, "fold"], [1, "raise", 18], [2, "call", 17], [3, "call", 13]], ["9s", "7h", "2c"], [["flop", [[1, "check"]]]], 0)],
  ["B: REFUSED shape — 4-way limped flop (CO, BTN, SB, BB=hero); flop Jd8c3s: SB bets 2, hero calls 2, CO raises 7, BTN calls 7, SB calls 7; hero to act (JTs)",
    mk(6, ["Jh", "Th"], [[1, "fold"], [2, "fold"], [3, "call", 1], [4, "call", 1], [5, "call", 0.5], [6, "check"]], ["Jd", "8c", "3s"], [["flop", [[5, "bet", 2], [6, "call", 2], [3, "raise", 7], [4, "call", 7], [5, "call", 7]]]], 5)],
  ["C: 5-way limped flop after a FITTED preflop (three limpers) — UTG/HJ/CO limp, BTN(hero) limps, SB completes, BB checks; flop Qc6d6h checked to hero (99)",
    mk(4, ["9c", "9d"], [[1, "call", 1], [2, "call", 1], [3, "call", 1], [4, "call", 1], [5, "call", 0.5], [6, "check"]], ["Qc", "6d", "6h"], [["flop", [[5, "check"], [6, "check"], [1, "check"], [2, "check"], [3, "check"]]]], 0)],
];
for (const [label, hand] of SPOTS) {
  const t0 = Date.now();
  const r = await fastSolve(hand, POS[hand.heroSeatId]!, { strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
  console.log(`\n### ${label}\n  (${((Date.now() - t0) / 1000).toFixed(1)} s) ${r.ok ? `${(r as any).source ?? r.tier} · ${r.actions.filter((a) => a.frequency >= 0.5).map((a) => `${a.action} ${Math.round(a.frequency)}`).join(" / ")}\n  ${(r.warning ?? "").slice(0, 380)}` : "MISS: " + (r as any).reason.slice(0, 420)}`);
}
