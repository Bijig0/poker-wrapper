/**
 * Probe (2026-10-01): can a reduced tree START at the moment before the last raise — every kept player with the chips
 * he already had in posted as his "blind", the rest of the pot as dead money — so the raise and the calls are priced
 * as they were at the table? Heads-up with uneven posts (1 and 5), absolute sizes ("17.6bb"), and three-handed with a
 * post on the button.
 *
 *   POKER_DATA_DIR=C:/Users/Brady/poker-data bun run src/scripts/_probeReducedBlinds.ts
 */
import { debugCreateTree, debugPreflopNode, debugTree } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const pre = (type: string, seatId: number, amount?: number) => ({ seatId, hero: seatId === 2, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const mk = (positions: Record<number, string>, stacks: Record<number, number>, actions: any[]): ParsedHand => ({
  handId: 1, clientHandId: "probe-blinds", bbCents: 200, heroSeatId: 2, heroCards: ["7s", "7c"], board: [], street: "preflop", actions,
  liveSeats: Object.keys(positions).map(Number), committed: {}, potByStreet: {}, positions, stacks,
  currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 1.5, toCall: 0.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand);
const show = (label: string, r: any) => console.log(`   ${label.padEnd(26)} ${r.ok ? `${String(r.actor).padEnd(3)} ${r.actions.map((a: any) => `${a.code} ${a.freq == null ? "?" : (100 * a.freq).toFixed(1)}`).join(" · ")}` : "REFUSED — " + String(r.reason).slice(0, 330)}`);
const body = (h: ParsedHand) => { const dt = debugTree(h, null); if ("error" in dt) throw new Error(dt.error); return dt.body; };
const sizes = (b: any, per: Record<string, string[]>) => ({
  ...b.bet_sizes, street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: b.bet_sizes.street_bet_sizes[0].position_bet_sizes.map((x: any) => ({ ...x, bet_sizes: per[x.position] ?? [] })) }],
});
const want = process.argv.slice(2);
const on = (k: string) => !want.length || want.includes(k);

// hero = tree SB (in position), 1bb in; UTG = tree BB, 5bb in; 10.4 dead
const hu = mk({ 2: "SB", 1: "BB" }, { 2: 153.5, 1: 91.5 }, [pre("post-sb", 2, 0.5), pre("post-bb", 1, 1)]);
const b2 = body(hu);
const players2 = (sb: number, bb: number) => b2.players.map((p: any) => ({ ...p, blind: p.position === "SB" ? sb : bb }));
if (on("hu-bb")) {
  console.log("\n== heads-up, SB posts 1, BB posts 5, 10.4 dead, SB's one size written '17.6bb'");
  const patch = { pot: 10.4, players: players2(1, 5), bet_sizes: sizes(b2, { SB: ["17.6bb"] }) };
  const root = await debugPreflopNode(hu, null, "", patch);
  show("root", root);
  if (!root.ok) console.log("   create:", JSON.stringify((await debugCreateTree(hu, null, patch)).got ?? null).slice(0, 500));
  else { for (const l of ["R17.6", "C"]) show(`after ${l}`, await debugPreflopNode(hu, null, l, patch)); }
}
if (on("hu-x")) {
  console.log("\n== the same with the size as a multiple: '3.52x'");
  const patch = { pot: 10.4, players: players2(1, 5), bet_sizes: sizes(b2, { SB: ["3.52x"] }) };
  const root = await debugPreflopNode(hu, null, "", patch);
  show("root", root);
  if (!root.ok) console.log("   create:", JSON.stringify((await debugCreateTree(hu, null, patch)).got ?? null).slice(0, 500));
}
if (on("hu-rev")) {
  console.log("\n== heads-up, SB posts 5, BB posts 1 (the caller in position has more in), BB's size '17.6bb'");
  const patch = { pot: 5.4, players: players2(5, 1), bet_sizes: sizes(b2, { BB: ["17.6bb"] }) };
  const root = await debugPreflopNode(hu, null, "", patch);
  show("root", root);
  if (!root.ok) console.log("   create:", JSON.stringify((await debugCreateTree(hu, null, patch)).got ?? null).slice(0, 500));
  else show("after C", await debugPreflopNode(hu, null, "C", patch));
}
if (on("three")) {
  // BB(real)=tree SB with 5 in, UTG=tree BB with 5 in, hero=tree BTN with 1 in, 5.4 dead
  const three = mk({ 2: "BTN", 6: "SB", 1: "BB" }, { 2: 153.5, 6: 55.5, 1: 91.5 }, [pre("post-sb", 6, 0.5), pre("post-bb", 1, 1)]);
  const b3 = body(three);
  console.log("\n== three-handed, BTN posts 1, SB posts 5, BB posts 5, 5.4 dead, BTN's size '17.6bb'");
  const patch = { pot: 5.4, players: b3.players.map((p: any) => ({ ...p, blind: p.position === "BTN" ? 1 : 5 })), bet_sizes: sizes(b3, { BTN: ["17.6bb"] }) };
  const root = await debugPreflopNode(three, null, "", patch);
  show("root", root);
  if (!root.ok) console.log("   create:", JSON.stringify((await debugCreateTree(three, null, patch)).got ?? null).slice(0, 500));
  else { show("after R17.6", await debugPreflopNode(three, null, "R17.6", patch)); show("after R17.6-C", await debugPreflopNode(three, null, "R17.6-C", patch)); }
}
process.exit(0);
