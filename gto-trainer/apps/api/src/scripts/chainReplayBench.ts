/**
 * chainReplayBench — replay one archived hand's postflop decisions through the live AI chain, street by street,
 * and print each decision's timing anatomy: the [chain] line (every street's tree cached or CREATED-and-why, every
 * node's source, the fresh cloud solves) plus the answer. Built 2026-09-24 to measure the turn/river leak (the
 * flop tree re-created on the turn, both re-created on the river) before and after the per-hand stack pin.
 *
 *   cd gto-trainer/apps/api
 *   GTOW_REQUEST_ORIGIN=bench bun src/scripts/chainReplayBench.ts <hand_id> [--nopin] [--drift=1.4] [--stack=100]
 *
 * <hand_id>   a row of ignition-study-wrapper/data/hands.db (Ignition stage id or CoinPoker hand id)
 * --nopin     forget the postflop pin before every decision — the code's behaviour before 2026-09-24
 * --drift=N   add N bb to a villain's read stack on every street after the flop, as the wrapper's live readings
 *             drift (hand 140706500001 read 69.28 at the flop and 67.88 at the turn); with the pin this must
 *             change nothing, without it every later street re-creates every earlier tree
 * --stack=N   the stack each seat is taken to have been dealt (archived rows carry end-of-hand stacks only)
 * --snap-hero replace each of hero's wagers with the size the answer BEFORE it recommended — what pick-to-relay
 *             does in auto mode — so the next street can show the size-free tree being reused
 *
 * Costs real GTO Wizard cloud solves: one per street when the cache holds, up to three on a river when it does not.
 * Never touches :2000 — it runs the chain in this process, with its own caches, and stores its traces as
 * origin "bench" (services/solveStore.ts).
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fastSolve, forgetPostflopPin, CP_HU_STRATEGY } from "../services/fastSolve";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { gtowApi } from "../services/gtowApi";
import { handsDbPath } from "../services/storePaths";

const SIX_MAX_STRATEGY = "ign200-ring-6max-equilibrium";
const args = process.argv.slice(2);
const handId = args.find((a) => !a.startsWith("--"));
if (!handId) { console.error("usage: chainReplayBench <hand_id> [--nopin] [--drift=N] [--stack=N]"); process.exit(2); }
const nopin = args.includes("--nopin");
const snapHero = args.includes("--snap-hero");
/** action index → the size hero is taken to have bet there (--snap-hero) */
const snapped = new Map<number, number>();
const drift = Number(args.find((a) => a.startsWith("--drift="))?.slice(8) ?? 0);
const dealt = Number(args.find((a) => a.startsWith("--stack="))?.slice(8) ?? 100);

const dbPath = handsDbPath();
const db = new Database(dbPath, { readonly: true });
const row = db.query<{ data: string }, [string]>("SELECT data FROM hands WHERE hand_id = ? ORDER BY rowid DESC LIMIT 1").get(handId);
if (!row) { console.error(`no hand ${handId} in ${dbPath}`); process.exit(1); }
const raw = JSON.parse(row.data);
const hand: ParsedHand = normalizeHand(raw).hand;
const heroPos = hand.positions[hand.heroSeatId] ?? null;
const seats = Object.keys(hand.positions).map(Number);
const strategyId = seats.length === 2 ? CP_HU_STRATEGY : SIX_MAX_STRATEGY;
const pinKey = String(hand.clientHandId ?? hand.handId ?? "");

/** The hand as it stood before actions[upto], with stacks reconstructed from `dealt` (routes/dashboard.truncateAt + stacks). */
function snapshot(upto: number): ParsedHand {
  const act = hand.actions[upto]!;
  const street = act.street as ParsedHand["street"];
  const boardLen = street === "flop" ? 3 : street === "turn" ? 4 : street === "river" ? 5 : 0;
  const actions = hand.actions.slice(0, upto).map((a, idx) => (snapped.has(idx) ? { ...a, amount: snapped.get(idx)! } : a));
  // chips each seat put in per street: a bet/raise/post is a street total, a call adds
  const per = new Map<string, Map<number, number>>();
  for (const a of actions) {
    const m = per.get(a.street) ?? new Map<number, number>();
    per.set(a.street, m);
    const seat = a.hero ? hand.heroSeatId : a.seatId;
    const amt = Number((a as { amount?: number }).amount ?? 0);
    if (!(amt > 0)) continue;
    if (a.type === "call") m.set(seat, (m.get(seat) ?? 0) + amt);
    else m.set(seat, Math.max(m.get(seat) ?? 0, amt));
  }
  const stacks: Record<number, number> = {};
  const committed: Record<number, number> = {};
  for (const s of seats) {
    let spent = 0;
    for (const [st, m] of per) { const v = m.get(s) ?? 0; if (st === street) committed[s] = v; spent += v; }
    stacks[s] = Math.round((dealt - spent) * 100) / 100;
    if (drift && street !== "flop" && s !== hand.heroSeatId) stacks[s] = Math.round((stacks[s]! + drift) * 100) / 100;
  }
  const top = Math.max(0, ...Object.values(committed));
  return {
    ...hand, actions, street, board: hand.board.slice(0, boardLen), ended: false, stacks, committed,
    currentNode: { ...hand.currentNode, street, toActIsHero: true, toCall: Math.max(0, top - (committed[hand.heroSeatId] ?? 0)), complete: false },
  };
}

const decisions = hand.actions
  .map((a, i) => ({ a, i }))
  .filter(({ a }) => a.hero && (a.street === "flop" || a.street === "turn" || a.street === "river"));
console.log(`hand ${pinKey}: ${seats.length} seats, hero ${heroPos} ${hand.heroCards.join("")}, board ${hand.board.join("")}, ` +
  `${decisions.length} postflop decision(s) [${decisions.map((d) => d.a.street).join(", ")}] · strategy ${strategyId} · ` +
  `pin ${nopin ? "OFF (pre-2026-09-24 behaviour)" : "on"}${drift ? ` · villain stack drift +${drift}bb per later street` : ""}`);
const before = gtowApi.requestStats().last24h.total;

for (const { a, i } of decisions) {
  const h = snapshot(i);
  if (nopin) forgetPostflopPin(pinKey);
  const t0 = Date.now();
  const r = await fastSolve(h, heroPos, { strategyId, origin: "bench" });
  const ms = Date.now() - t0;
  if (r.ok) {
    const top = (r.actions ?? []).slice().sort((x, y) => y.frequency - x.frequency).slice(0, 3)
      .map((x) => `${x.action} ${x.frequency.toFixed(0)}%`).join(", ");
    console.log(`  ${a.street.toUpperCase()} decision (hero ${a.type}${(a as { amount?: number }).amount != null ? ` ${(a as { amount?: number }).amount}` : ""} in the hand): ` +
      `${ms} ms · ${r.tier} · ${top}${r.warning ? ` · ${r.warning.slice(0, 140)}` : ""}`);
    if (snapHero && (a.type === "bet" || a.type === "raise")) {
      const rec = (r.actions ?? []).slice().sort((x, y) => y.frequency - x.frequency).find((x) => /^(bet|raise)/i.test(x.action) && x.betsize != null);
      const size = rec ? Number(rec.betsize) : NaN;
      if (Number.isFinite(size) && size > 0) { snapped.set(i, size); console.log(`  (--snap-hero: hero's ${a.type} taken as the recommended ${size})`); }
    }
  } else {
    console.log(`  ${a.street.toUpperCase()} decision: ${ms} ms · NO ANSWER — ${r.reason}`);
  }
}
console.log(`GTO Wizard requests spent by this run: ${gtowApi.requestStats().last24h.total - before}`);
process.exit(0);
