/**
 * Probe (2026-10-01): the last raise as a FORCED BET. In a reduced tree where the raise is a decision, the solver
 * never makes it (root: limp 73 / jam 27 / the raise 0.0), so the caller's node behind it is untrained — it jammed 22
 * and every pair (measured on the first build, see utils/reducedArrival). Posted as a blind instead, the caller's fold / call / re-raise is the
 * tree's first decision. Both ways round: the raiser in position (the tree's SB posts the raise, the BB — the caller —
 * his earlier chips) and out of position (the BB posts the raise, the SB his earlier chips).
 *
 *   POKER_DATA_DIR=C:/Users/Brady/poker-data bun run src/scripts/_probeForcedRaise.ts
 */
import { debugCreateTree, debugPreflopNode, debugTree } from "../services/gtowAiPreflop";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const pre = (type: string, seatId: number, amount?: number) => ({ seatId, hero: seatId === 2, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const hu: ParsedHand = {
  handId: 1, clientHandId: "probe-forced", bbCents: 200, heroSeatId: 2, heroCards: ["7s", "7c"], board: [], street: "preflop",
  actions: [pre("post-sb", 2, 0.5), pre("post-bb", 1, 1)], liveSeats: [1, 2], committed: {}, potByStreet: {}, positions: { 2: "SB", 1: "BB" }, stacks: { 2: 153.5, 1: 91.5 },
  currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 1.5, toCall: 0.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand;
const dt = debugTree(hu, null);
if ("error" in dt) throw new Error(dt.error);
const b = dt.body;
const strong: number[] = COMBOS.map((c) => (/^(KK|QQ|JJ|AKs|AKo|AQs|KQs|AJs)$/.test(c.cls) ? 1 : 0));
const limpy: number[] = COMBOS.map((c) => (/^(AA|KK|QQ|JJ|TT|99|88|77|66|55|44|33|22|A[2-9TJQK]s|K[9TJQ]s|Q[9TJ]s|J[9T]s|T9s|98s|87s|76s|AKo|AQo|AJo|KQo|KJo|QJo)$/.test(c.cls) ? 1 : c.cls.endsWith("s") ? 0.2 : 0.03));
const sizes = (per: Record<string, string[]>) => ({
  ...b.bet_sizes, street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: b.bet_sizes.street_bet_sizes[0].position_bet_sizes.map((x: any) => ({ ...x, bet_sizes: per[x.position] ?? [] })) }],
});
const players = (sb: { blind: number; stack: number; range: number[] }, bb: { blind: number; stack: number; range: number[] }) =>
  b.players.map((p: any) => ({ ...p, ...(p.position === "SB" ? sb : bb) }));
const show = (label: string, r: any) => console.log(`   ${label.padEnd(20)} ${r.ok ? `${String(r.actor).padEnd(3)} ${r.actions.map((a: any) => `${a.code} ${a.freq == null ? "?" : (100 * a.freq).toFixed(1)}`).join(" · ")}` : "REFUSED — " + String(r.reason).slice(0, 300)}`);
const want = process.argv.slice(2);
const on = (k: string) => !want.length || want.includes(k);

if (on("ip")) {
  console.log("== the raiser IN POSITION: SB posts 17.6 (153.5 behind it), BB (the caller) posts 5 (91.5), 10.4 dead");
  const patch = { pot: 10.4, players: players({ blind: 17.6, stack: 153.5, range: strong }, { blind: 5, stack: 91.5, range: limpy }), bet_sizes: sizes({ BB: ["8.8x"] }) };
  const root = await debugPreflopNode(hu, null, "", patch);
  show("root", root);
  if (!root.ok) console.log("   create:", JSON.stringify((await debugCreateTree(hu, null, patch)).got ?? null).slice(0, 600));
  else for (const code of root.actions.map((a: any) => a.code)) show(`after ${code}`, await debugPreflopNode(hu, null, code, patch));
}
if (on("oop")) {
  console.log("== the raiser OUT OF POSITION: BB posts 17.6 (153.5), SB (the caller) posts 5 (91.5), 10.4 dead");
  const patch = { pot: 10.4, players: players({ blind: 5, stack: 91.5, range: limpy }, { blind: 17.6, stack: 153.5, range: strong }), bet_sizes: sizes({ SB: ["2.5x"] }) };
  const root = await debugPreflopNode(hu, null, "", patch);
  show("root", root);
  if (!root.ok) console.log("   create:", JSON.stringify((await debugCreateTree(hu, null, patch)).got ?? null).slice(0, 600));
}
if (on("zero")) {
  console.log("== a caller with nothing in yet, in position: SB posts 0.01, BB posts 17.6");
  const patch = { pot: 10.4, players: players({ blind: 0.01, stack: 91.5, range: limpy }, { blind: 17.6, stack: 153.5, range: strong }), bet_sizes: sizes({ SB: ["2.5x"] }) };
  show("root", await debugPreflopNode(hu, null, "", patch));
}
process.exit(0);
