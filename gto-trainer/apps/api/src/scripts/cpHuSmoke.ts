/**
 * Smoke test for the CoinPoker 200NL heads-up strategy (fastSolve CP_HU_STRATEGY): synthetic heads-up hands
 * through the real preflop path against the live chart server (:8777, bodies from R2), and — with --postflop —
 * one flop through the AI chain (spends a GTO Wizard Elite solve).
 *
 *   bun src/scripts/cpHuSmoke.ts [--postflop]
 */
import { fastSolve, CP_HU_STRATEGY } from "../services/fastSolve";
import { chartForHu } from "../services/hrc2max";
import { buildPreflopTokensHu } from "../feed/buildSolutionUrl/buildSolutionUrl";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { gtowApi } from "../services/gtowApi";

// show exactly what the postflop solve is asked to build: pot, stack, rake (the antes and cap must be in it)
const ensure = (gtowApi as any).ensureCustomSolution.bind(gtowApi);
(gtowApi as any).ensureCustomSolution = (t: any) => {
  console.log(`   [tree] ${t.startingStreet} board ${t.board} pot ${t.pot} stack ${t.stack} ${t.oopPos}/${t.ipPos} rake ${JSON.stringify(t.rake ?? "GTO Wizard default")}`);
  return ensure(t);
};

type Act = { seatId: number; hero: boolean; type: string; amount?: number; street: string };
const SB = 1, BB = 2;

function hand(heroSeat: number, cards: string[], acts: Act[], opts: { board?: string[]; stacks?: [number, number]; ante?: number; toCall?: number; street?: string } = {}): ParsedHand {
  const street = (opts.street ?? "preflop") as any;
  const [s1, s2] = opts.stacks ?? [100, 100];
  return {
    handId: 1, clientHandId: "smoke", bbCents: 200, anteBb: opts.ante ?? 0.2,
    heroSeatId: heroSeat, heroCards: cards, board: opts.board ?? [], street,
    actions: [{ seatId: SB, hero: heroSeat === SB, type: "post-sb", amount: 0.5, street: "preflop" },
              { seatId: BB, hero: heroSeat === BB, type: "post-bb", amount: 1, street: "preflop" }, ...acts] as any,
    liveSeats: [SB, BB], committed: {}, potByStreet: {}, positions: { [SB]: "SB", [BB]: "BB" },
    stacks: { [SB]: s1, [BB]: s2 },
    currentNode: { street, toActSeatId: heroSeat, toActIsHero: true, pot: 0, toCall: opts.toCall ?? 0, legalActions: [], complete: false },
    ended: false,
  } as ParsedHand;
}

const cases: [string, ParsedHand][] = [
  ["SB first in, 100bb, A5s", hand(SB, ["Ah", "5h"], [])],
  ["BB vs SB 2.5x open, 100bb, KJo", hand(BB, ["Kd", "Jc"], [{ seatId: SB, hero: false, type: "raise", amount: 2.5, street: "preflop" }], { toCall: 1.5 })],
  ["BB vs SB limp, 100bb, 98s", hand(BB, ["9s", "8s"], [{ seatId: SB, hero: false, type: "call", amount: 0.5, street: "preflop" }])],
  ["SB vs 3-bet to 10 after a 2.5x open, 60bb, QQ, ante 0.1 (table differs)", hand(SB, ["Qs", "Qh"], [
    { seatId: SB, hero: true, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: BB, hero: false, type: "raise", amount: 10, street: "preflop" }], { stacks: [60, 58], ante: 0.1, toCall: 7.5 })],
];

for (const [label, h] of cases) {
  const tokens = buildPreflopTokensHu(h, null);
  const choice = chartForHu(h, tokens);
  const t0 = Date.now();
  const r: any = await fastSolve(h, null, { strategyId: CP_HU_STRATEGY });
  console.log(`\n== ${label}\n   tokens [${tokens.join(" ")}] -> want ${choice.id}`);
  console.log(r.ok
    ? `   ${r.source}/${r.tier} ${r.gametype} line "${r.line}" pos ${r.pos} ${r.heroClass}: ${r.actions.map((a: any) => `${a.action} ${a.frequency}%`).join(", ")} -> pick ${r.decision?.action}  (${Date.now() - t0} ms)${r.warning ? `\n   note: ${r.warning}` : ""}`
    : `   MISS: ${r.reason}  (${Date.now() - t0} ms)`);
}

// a 3-handed hand must not be answered by this strategy
const three = hand(SB, ["Ah", "Kh"], []);
three.positions = { 1: "SB", 2: "BB", 3: "BTN" } as any;
const r3: any = await fastSolve(three, null, { strategyId: CP_HU_STRATEGY });
console.log(`\n== 3 seats dealt -> ${r3.ok ? "ANSWERED (wrong!)" : "refused: " + r3.reason}`);

if (process.argv.includes("--postflop")) {
  const f = hand(BB, ["9s", "8s"], [
    { seatId: SB, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: BB, hero: true, type: "call", amount: 1.5, street: "preflop" },
  ], { street: "flop", board: ["9h", "7c", "2d"], stacks: [97.3, 97.3] });
  const t0 = Date.now();
  const r: any = await fastSolve(f, null, { strategyId: CP_HU_STRATEGY });
  console.log(`\n== FLOP BB 98s on 9h7c2d after SB 2.5x / call`);
  console.log(r.ok ? `   ${r.source}/${r.tier} ${r.actions.map((a: any) => `${a.action} ${a.frequency}%`).join(", ")} -> ${r.decision?.action} (${Date.now() - t0} ms)\n   ranges: ${r.rangeSource ?? r.gametype} · ${r.warning ?? ""}`
    : `   MISS: ${r.reason} (${Date.now() - t0} ms)`);
}
process.exit(0);
