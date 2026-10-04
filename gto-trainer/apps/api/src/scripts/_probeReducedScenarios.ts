/**
 * The reduced tree, live, on the neighbours of hand 4921846667 (2026-10-01): the BB calling too (two callers), the
 * limper as the re-raiser with hero calling (the raiser out of position), four to the flop, a caller with nothing in.
 * Every tree form GTO Wizard has to accept, and a look at the ranges that come back.
 *
 *   POKER_DATA_DIR=C:/Users/Brady/poker-data bun run src/scripts/_probeReducedScenarios.ts [name ...]
 *
 * NOT while a session is live.
 */
import { Database } from "bun:sqlite";
import { arrivalRangesGtowAi } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const db = new Database("C:/Users/Brady/poker-data/poker.sqlite", { readonly: true });
if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — not running"); process.exit(1); }

const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as const;
const DEALT = { 1: 91.5, 2: 153.5, 3: 100.5, 4: 28.5, 5: 112.5, 6: 55.5 };
const a = (type: string, seatId: number, amount?: number) => ({ seatId, hero: seatId === 2, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const hand = (actions: any[], heroCards = ["7s", "7c"]): ParsedHand => {
  const put: Record<number, number> = {};
  for (const x of actions) { if (x.amount == null) continue; put[x.seatId] = x.type === "call" ? (put[x.seatId] ?? 0) + x.amount : Math.max(put[x.seatId] ?? 0, x.amount); }
  return {
    handId: 66, clientHandId: "4921846667", bbCents: 5, heroSeatId: 2, heroCards, board: ["Ks", "9s", "Qd"], street: "flop",
    actions, liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { ...POS },
    stacks: Object.fromEntries(Object.entries(DEALT).map(([s, d]) => [s, Math.round((d - (put[Number(s)] ?? 0)) * 100) / 100])),
    currentNode: { street: "flop", toActSeatId: 2, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
};
const OPENING = [a("post-sb", 5, 0.4), a("post-bb", 6, 1), a("call", 1, 1), a("call", 2, 1), a("raise", 3, 5), a("fold", 4), a("fold", 5)];
const SCENARIOS: Record<string, { what: string; hand: ParsedHand }> = {
  three: { what: "the BB calls hero's limp-reraise too: BB, UTG and hero see the flop",
           hand: hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("call", 6, 12.6), a("call", 1, 12.6)]) },
  utgReraises: { what: "UTG is the limp-reraiser, hero calls: the raiser out of position",
                 hand: hand([...OPENING, a("fold", 6), a("raise", 1, 17.6), a("call", 2, 16.6), a("fold", 3)]) },
  four: { what: "the CO, the BB and UTG all call hero's limp-reraise",
          hand: hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("call", 3, 12.6), a("call", 6, 12.6), a("call", 1, 12.6)]) },
  shortCaller: { what: "the hand as played, UTG with 12bb: his call is all in for less",
                 hand: (() => { const h = hand([...OPENING, a("call", 6, 4), a("call", 1, 4), a("raise", 2, 17.6), a("fold", 3), a("fold", 6), a("all-in", 1, 12)]); return h; })() },
};
const summary = (rec: Record<string, number>) => {
  const classes = Object.entries(rec);
  const combos = classes.reduce((s, [c, w]) => s + w * (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12), 0);
  return `${String(classes.length).padStart(3)} classes · ${combos.toFixed(0).padStart(4)} combos · top: ${classes.sort((x, y) => y[1] - x[1]).slice(0, 9).map(([c, w]) => `${c} ${w.toFixed(2)}`).join(", ")}`;
};
const want = process.argv.slice(2);
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (want.length && !want.includes(name)) continue;
  const dealt = name === "shortCaller" ? { ...DEALT, 1: 12 } : DEALT;
  const t0 = Date.now();
  const r = await arrivalRangesGtowAi(sc.hand, "HJ", 6, dealt);
  console.log(`\n== ${name}: ${sc.what}\n   ${r.ok ? "ok" : "REFUSED — " + r.reason} (${Date.now() - t0} ms)`);
  if (!r.ok) continue;
  console.log("   id:", r.id, "· fitted callers:", r.reduced?.fitted ?? "(not reduced)");
  for (const [pos, rec] of Object.entries(r.ranges)) console.log(`   ${pos.padEnd(4)} ${summary(rec)}`);
  console.log("   note:", String(r.note).slice(0, 1400));
}
process.exit(0);
