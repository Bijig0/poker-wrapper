/**
 * The reduced tree, live (2026-10-01): hand 4921846667's flop decision — 77 on K♠9♠Q♦ facing UTG's 32.6bb lead after
 * limp / over-limp / iso / limp-reraise / call — through the path the live API runs (fastSolve at the flop, the hand's
 * own preflop pin), and the ranges on their own. At the table this was "no answer": a timeout and a sit-out.
 *
 *   POKER_DATA_DIR=C:/Users/Brady/poker-data bun run src/scripts/_probeReducedE2e.ts [clientHandId] [ranges|solve]
 *
 * NOT while a session is live (it solves on the live GTO Wizard accounts and loads this machine).
 */
import { Database } from "bun:sqlite";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt } from "../utils/archivedHand/archivedHand";
import { arrivalRangesGtowAi } from "../services/gtowAiPreflop";
import { fastSolve } from "../services/fastSolve";

const id = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : "4921846667";
const mode = process.argv.includes("ranges") ? "ranges" : process.argv.includes("solve") ? "solve" : "both";
const db = new Database("C:/Users/Brady/poker-data/poker.sqlite", { readonly: true });
if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — not running"); process.exit(1); }
const row = db.query("select data from hands where client_hand_id = ?").get(id) as any;
const hand = normalizeHand(JSON.parse(row.data)).hand;
const upto = hand.actions.findIndex((a) => a.hero && a.street !== "preflop");
if (upto < 0) { console.log("hero has no postflop decision in this hand"); process.exit(1); }
const t = truncateAt(hand, upto);
const at = { ...t, currentNode: { ...t.currentNode, toActIsHero: true } };
const heroPos = hand.positions[hand.heroSeatId] ?? null;
console.log(`hand ${id}: hero ${heroPos} ${hand.heroCards.join(" ")} · ${at.street} ${at.board.join(" ")} · ${at.actions.length} actions before the decision`);

const summary = (rec: Record<string, number>) => {
  const classes = Object.entries(rec);
  const combos = classes.reduce((s, [c, w]) => s + w * (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12), 0);
  return `${classes.length} classes · ${combos.toFixed(0)} combos · top: ${classes.sort((x, y) => y[1] - x[1]).slice(0, 10).map(([c, w]) => `${c} ${w.toFixed(2)}`).join(", ")}`;
};
if (mode !== "solve") {
  const t0 = Date.now();
  const r = await arrivalRangesGtowAi(at, heroPos, 6);
  console.log(`\n== arrival ranges: ${r.ok ? "ok" : "REFUSED — " + r.reason} (${Date.now() - t0} ms)`);
  if (r.ok) {
    console.log("   id:", r.id, "| reduced:", JSON.stringify(r.reduced ?? null));
    for (const [pos, rec] of Object.entries(r.ranges)) console.log(`   ${pos.padEnd(4)} ${summary(rec)}`);
    console.log("   tokens:", r.tokens.join("-"), "· seats:", r.seatOrder.join("/"));
    console.log("   note:", r.note);
  }
}
if (mode !== "ranges") {
  const t0 = Date.now();
  const sol: any = await fastSolve(at, heroPos, { heroPos, strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
  console.log(`\n== fastSolve at the flop: ${sol.ok ? "ANSWERED" : "NO ANSWER — " + sol.reason} (${Date.now() - t0} ms)`);
  if (sol.ok) {
    console.log("   source", sol.source, "· tier", sol.tier, "· line", sol.line, "· range source:", sol.gametype);
    console.log("   actions:", (sol.actions ?? []).map((x: any) => `${x.action} ${x.frequency}%`).join(" · "), "→", sol.decision?.action ?? sol.decision);
    console.log("   path:", sol.path?.verdict, JSON.stringify((sol.path?.reasons ?? []).map((x: any) => x.code)));
    console.log("   warning:", String(sol.warning ?? "").slice(0, 900));
  }
}
process.exit(0);
