/** Emulate a LIMP LOCK in GTO Wizard: give the BTN a 1326-combo starting range (a pool-ish limp range) and no raise
 *  sizes, so his only actions are fold/limp. Does the tree solve, and does hero's node reflect it? */
import { debugCreateTree, debugPreflopNode } from "../services/gtowAiPreflop";
import { comboIndex, COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
const hand: ParsedHand = {
  handId: 1, clientHandId: "rangelock", bbCents: 200, heroSeatId: 5, heroCards: ["Ah", "5h"], board: [], street: "preflop",
  actions: [
    { seatId: 5, hero: true, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" }, { seatId: 2, hero: false, type: "fold", street: "preflop" }, { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "call", amount: 1, street: "preflop" },
  ],
  liveSeats: [1, 2, 3, 4, 5, 6], committed: { 4: 1, 5: 0.5, 6: 1 }, potByStreet: {},
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
  stacks: { 1: 100, 2: 100, 3: 100, 4: 99, 5: 99.5, 6: 99 },
  currentNode: { street: "preflop", toActSeatId: 5, toActIsHero: true, pot: 2.5, toCall: 0.5, legalActions: [], complete: false },
  ended: false,
} as any;
// a pool-flavoured limp range: mid pairs, broadways, suited aces/kings, suited connectors — weight 1; everything else 0
const inPool = (cls: string) => /^(22|33|44|55|66|77|88|99|TT|JJ)$/.test(cls) || /^A[2-9TJQ]s$/.test(cls) || /^K[5-9TJQ]s$/.test(cls) || /^(QJ|QT|JT|T9|98|87|76|65)s$/.test(cls) || /^(AJ|AT|A9|KQ|KJ|KT|QJ|QT|JT)o$/.test(cls) || /^AQo$/.test(cls);
const range = new Array(1326).fill(0);
let n = 0; for (const c of COMBOS as any[]) { const i = comboIndex(c.cards[0], c.cards[1]); if (inPool(c.cls)) { range[i] = 1; n++; } }
console.log(`pool-ish limp range: ${n} of 1326 combos`);
const base = await debugCreateTree(hand, "SB", {});
const players = (base.sent.players as any[]).map((p) => (p.position === "BTN" ? { ...p, range } : p));
const sizes = (base.sent.bet_sizes.street_bet_sizes[0].position_bet_sizes as any[]).map((x) => (x.position === "BTN" ? { ...x, bet_sizes: [], raise_sizes: [], second_raise_sizes: [], third_plus_raise_sizes: [] } : x));
const patch = { players, bet_sizes: { ...base.sent.bet_sizes, street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: sizes }] } };
const t = await debugCreateTree(hand, "SB", patch);
console.log("tree:", t.status, t.status >= 300 ? JSON.stringify(t.got).slice(0, 300) : `stored BTN range items ${(t.got?.players ?? []).find((p: any) => p.position === "BTN")?.range?.length ?? "?"}`);
for (const line of ["F-F-F", "F-F-F-C"]) {
  const r = await debugPreflopNode(hand, "SB", line, patch);
  console.log(`node ${line}: ${r.ok ? `${r.actor} ` + r.actions.map((a) => `${a.code} ${((a.freq ?? 0) * 100).toFixed(0)}%`).join(" / ") : "FAIL " + r.reason.slice(0, 200)}`);
}
const plain = await debugPreflopNode(hand, "SB", "F-F-F-C", {});
console.log(`node F-F-F-C with the equilibrium limper: ${plain.ok ? plain.actions.map((a) => `${a.code} ${((a.freq ?? 0) * 100).toFixed(0)}%`).join(" / ") : "FAIL"}`);
