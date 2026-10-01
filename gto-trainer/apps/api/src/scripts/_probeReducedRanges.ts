/**
 * Probe (2026-10-01, hand 4921846667: the flop had no ranges because the AI fit had folded out the limper who then saw
 * it). Does GTO Wizard AI solve a REDUCED preflop tree — two or three players, everyone else's chips as dead money
 * (`pot`) — when the players are given STARTING RANGES (`players[].range`, 1,326 weights)? Both were probed apart on
 * 2026-09-23 (memory gtow-ai-preflop); never together, and never three-handed.
 *
 *   POKER_DATA_DIR=C:/Users/Brady/poker-data bun run src/scripts/_probeReducedRanges.ts
 */
import { debugPreflopNode, debugTree } from "../services/gtowAiPreflop";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const pre = (type: string, seatId: number, amount?: number) => ({ seatId, hero: seatId === 2, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const mk = (positions: Record<number, string>, stacks: Record<number, number>, actions: any[]): ParsedHand => ({
  handId: 1, clientHandId: "probe", bbCents: 200, heroSeatId: 2, heroCards: ["7s", "7c"], board: [], street: "preflop", actions,
  liveSeats: Object.keys(positions).map(Number), committed: {}, potByStreet: {}, positions, stacks,
  currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 1.5, toCall: 0.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand);

// a limper-like range: pairs, suited aces, suited broadways, a few offsuit broadways; nothing else
const LIMPY = /^(22|33|44|55|66|77|88|99|TT|JJ|A[2-9TJQ]s|K[9TJQ]s|Q[9TJ]s|J[9T]s|T9s|98s|AJo|AQo|KQo)$/;
const limpRange: number[] = COMBOS.map((c) => (LIMPY.test(c.cls) ? 1 : 0));
const heroRange: number[] = COMBOS.map((c) => (/^(22|33|44|55|66|77|88|99|A[2-9T]s|K[9TJ]s|QJs|JTs|T9s|98s|87s|76s)$/.test(c.cls) ? 1 : 0));
console.log("combos in the limper's range:", limpRange.reduce((a, b) => a + b, 0), "· hero's:", heroRange.reduce((a, b) => a + b, 0));

const show = (label: string, r: any) => console.log(`   ${label.padEnd(22)} ${r.ok ? `${String(r.actor).padEnd(3)} ${r.actions.map((a: any) => `${a.code} ${a.freq == null ? "?" : (100 * a.freq).toFixed(1)}`).join(" · ")}` : "REFUSED — " + String(r.reason).slice(0, 300)}`);
const withRanges = (h: ParsedHand, ranges: Record<string, number[]>, pot: number) => {
  const dt = debugTree(h, null);
  if ("error" in dt) throw new Error(dt.error);
  return { pot, players: dt.body.players.map((p: any) => ({ ...p, range: ranges[p.position] ?? null })) };
};

// 1. HEADS-UP: the limper is the tree's SB (acts first), hero its BB; 11.4bb dead
const hu = mk({ 1: "SB", 2: "BB" }, { 1: 73.8, 2: 153.5 }, [pre("post-sb", 1, 0.5), pre("post-bb", 2, 1)]);
console.log("\n== heads-up, no ranges, no dead money (baseline)");
show("root", await debugPreflopNode(hu, null, ""));
console.log("== heads-up, 11.4bb dead, both ranges set");
const huPatch = withRanges(hu, { SB: limpRange, BB: heroRange }, 11.4);
show("root", await debugPreflopNode(hu, null, "", huPatch));
show("after SB limp (C)", await debugPreflopNode(hu, null, "C", huPatch));

// 2. THREE-HANDED: BTN / SB / BB, 6bb dead, all three ranges set
const three = mk({ 1: "BTN", 2: "SB", 3: "BB" }, { 1: 73.8, 2: 153.5, 3: 100 }, [pre("post-sb", 2, 0.5), pre("post-bb", 3, 1)]);
console.log("\n== three-handed, no ranges, no dead money (baseline)");
show("root", await debugPreflopNode(three, null, ""));
console.log("== three-handed, 6bb dead, all three ranges set");
const p3 = withRanges(three, { BTN: limpRange, SB: heroRange, BB: limpRange }, 6);
show("root", await debugPreflopNode(three, null, "", p3));
show("after BTN limp (C)", await debugPreflopNode(three, null, "C", p3));
process.exit(0);
