/**
 * The pool-locked limper end to end (2026-10-05): every hero decision of a real hand, in order, through THIS checkout's
 * fastSolve — preflop through the lock (gtowAiPreflop.solvePreflopPoolLocked), then the flop resuming from the locked
 * tree's pin (the floor leaves the locked limper alone). Live GTO Wizard requests.
 *
 *   POKER_DATA_DIR=C:/Users/Brady/poker-data bun run src/scripts/_probePoolLockE2e.ts 4922555015 4922265890
 *
 * NOT while a session is live.
 */
import { Database } from "bun:sqlite";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt } from "../utils/archivedHand/archivedHand";
import { fastSolve } from "../services/fastSolve";
import { preflopPinFor } from "../services/preflopPin";

const db = new Database("C:/Users/Brady/poker-data/poker.sqlite", { readonly: true });
if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — not running"); process.exit(2); }
const ids = process.argv.slice(2).filter((x) => /^\d{10}$/.test(x));
for (const id of ids) {
  const row = db.query("select data from hands where client_hand_id = ?").get(id) as any;
  const hand = normalizeHand(JSON.parse(row.data)).hand;
  const heroPos = hand.positions[hand.heroSeatId] ?? null;
  console.log(`\n=== hand ${id}: hero ${heroPos} ${hand.heroCards.join(" ")}`);
  const at = hand.actions.map((a, i) => (a.hero && !/^post/.test(a.type) ? i : -1)).filter((i) => i >= 0);
  for (const i of at) {
    const t = truncateAt(hand, i);
    const h = { ...t, currentNode: { ...t.currentNode, toActIsHero: true } };
    const t0 = Date.now();
    const r: any = await fastSolve(h, heroPos, { heroPos, strategyId: "ign200-ring-6max-equilibrium", origin: "probe" } as any);
    const ms = Date.now() - t0;
    const took = hand.actions[i]!;
    const head = `${h.street.padEnd(7)} (hero then ${took.type}${took.amount != null ? ` ${took.amount}` : ""})`;
    if (!r.ok) { console.log(`  ${head} NO ANSWER (${ms} ms): ${String(r.reason).slice(0, 300)}`); continue; }
    const mix = (r.actions ?? []).map((a: any) => `${a.action} ${Number(a.frequency).toFixed(1)}`).join(" · ");
    const code = r.path?.reasons?.map((x: any) => x.code).join(",") || r.path?.verdict || "";
    console.log(`  ${head} ${r.source} [${code}] ${ms} ms — ${mix}`);
    const w = String(r.warning ?? "");
    for (const tag of ["POOL-LOCKED LIMPER", "POOL LIMP LOCK FAILED", "POOL LIMP RANGE", "PREFLOP RANGES FROM THE PIN"]) {
      const k = w.indexOf(tag);
      if (k >= 0) console.log(`      ${w.slice(k, k + 230)}…`);
    }
    if (h.street === "preflop") {
      const pin: any = preflopPinFor(h);
      console.log(`      pin: ${pin ? `${pin.piece} ${pin.id ?? pin.chartId}${pin.poolLocks ? ` · poolLocks ${JSON.stringify(pin.poolLocks)}` : ""}` : "none"}`);
    }
  }
}
process.exit(0);
