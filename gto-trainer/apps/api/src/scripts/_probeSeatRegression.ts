/** Heads-up and three-way flops must answer exactly as before the 4-way collapse landed. */
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
const blinds: ParsedAction[] = [
  { seatId: 4, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
  { seatId: 5, hero: false, type: "post-bb", amount: 1, street: "preflop" },
];
const run = async (name: string, acts: ParsedAction[], live: number[], pot: number, toCall: number) => {
  const hand: ParsedHand = {
    handId: 1, clientHandId: `reg${name.length}`, bbCents: 200, heroSeatId: 3,
    heroCards: ["Ad", "Kc"], board: ["Ah", "7d", "2c"], street: "flop",
    actions: [...blinds, ...acts], liveSeats: live, committed: {}, potByStreet: { flop: pot },
    positions: { 0: "UTG", 1: "HJ", 2: "CO", 3: "BTN", 4: "SB", 5: "BB" },
    stacks: { 0: 97.5, 1: 97.5, 2: 97.5, 3: 97.5, 4: 99.5, 5: 97.5 },
    currentNode: { street: "flop", toActSeatId: 3, toActIsHero: true, pot, toCall, legalActions: [], complete: false },
    ended: false,
  };
  const t0 = Date.now();
  const r = await fastSolve(hand, "BTN", { strategyId: "ign200-ring-6max-equilibrium", origin: "adhoc" });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!r.ok) { console.log(`${name.padEnd(22)} (${secs}s)  MISS ${r.reason}`); return; }
  console.log(`${name.padEnd(22)} (${secs}s)  ${(r.actions ?? []).map((a) => `${a.action} ${a.frequency.toFixed(0)}%`).join("  ")}`);
  const w = String(r.warning ?? "");
  console.log(`${" ".repeat(22)}  collapse: ${/APPROXIMATION/.test(w) ? w.match(/collapsed to three: [^.]*/)?.[0] : "none (field already fits a tree)"}`);
};
// heads-up: BTN opens, BB calls
await run("2-way flop", [
  { seatId: 0, hero: false, type: "fold", street: "preflop" }, { seatId: 1, hero: false, type: "fold", street: "preflop" },
  { seatId: 2, hero: false, type: "fold", street: "preflop" }, { seatId: 3, hero: true, type: "raise", amount: 2.5, street: "preflop" },
  { seatId: 4, hero: false, type: "fold", street: "preflop" }, { seatId: 5, hero: false, type: "call", amount: 1.5, street: "preflop" },
  { seatId: 5, hero: false, type: "check", street: "flop" },
], [3, 5], 5.5, 0);
// three-way: CO opens, BTN calls, BB calls
await run("3-way flop", [
  { seatId: 0, hero: false, type: "fold", street: "preflop" }, { seatId: 1, hero: false, type: "fold", street: "preflop" },
  { seatId: 2, hero: false, type: "raise", amount: 2.5, street: "preflop" }, { seatId: 3, hero: true, type: "call", amount: 2.5, street: "preflop" },
  { seatId: 4, hero: false, type: "fold", street: "preflop" }, { seatId: 5, hero: false, type: "call", amount: 1.5, street: "preflop" },
  { seatId: 5, hero: false, type: "check", street: "flop" }, { seatId: 2, hero: false, type: "check", street: "flop" },
], [2, 3, 5], 8, 0);
