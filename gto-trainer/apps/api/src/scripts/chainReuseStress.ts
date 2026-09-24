/**
 * chainReuseStress — the reuse guarantee, tested against live GTO Wizard (2026-09-24, Brady: "ensure there is
 * NEVER a re-compute of a previous street's range"). Replays archived hands — CoinPoker heads-up and Ignition
 * 6-max alike — decision by decision through the shared postflop path (fastSolve.solvePostflopSite), exactly as the
 * poller would ask, and checks every stored trace: on a turn or river decision, every EARLIER street must have come
 * from the hand's checkpoint (trace.streets[].fromCheckpoint) — never re-walked, never re-solved. The current
 * street may create its tree (that is the one solve a decision is allowed). Prints one line per decision with the
 * [chain] anatomy behind it, and a hit-rate summary; exits 1 unless the hit rate is 100%.
 *
 *   cd gto-trainer/apps/api
 *   GTOW_SECONDARY=0 GTOW_REQUEST_ORIGIN=stress bun src/scripts/chainReuseStress.ts --hands=140508800003,4919645501,rowid:704 [--drift=-1.4] [--stack=100] [--twice]
 *
 * --hands   archived hands by CoinPoker id, Ignition clientHandId, or hands.db rowid
 * --drift   perturb the SHORTER villain's read stack on every street after the flop, as live readings do — the
 *           pin must keep the trees and the checkpoints must keep the ranges regardless
 * --twice   ask each decision twice (the poller re-asks while villain thinks) — the second ask must be all-checkpoint
 * Costs real cloud solves: roughly one per postflop street per hand.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fastSolve, forgetPostflopPin, CP_HU_STRATEGY } from "../services/fastSolve";
import { forgetCheckpoints } from "../services/aiChain";
import { solveStore } from "../services/solveStore";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { gtowApi } from "../services/gtowApi";

const SIX_MAX_STRATEGY = "ign200-ring-6max-equilibrium";
const args = process.argv.slice(2);
const ids = (args.find((a) => a.startsWith("--hands="))?.slice(8) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
if (!ids.length) { console.error("usage: chainReuseStress --hands=<id,...> [--drift=N] [--stack=N] [--twice]"); process.exit(2); }
const drift = Number(args.find((a) => a.startsWith("--drift="))?.slice(8) ?? 0);
const dealtStack = Number(args.find((a) => a.startsWith("--stack="))?.slice(8) ?? 100);
const twice = args.includes("--twice");

// HANDS_DB: the archive to read (a worktree has no ignition-study-wrapper/data of its own — point it at the main one)
const dbPath = process.env.HANDS_DB ?? join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper", "data", "hands.db");
const db = new Database(dbPath, { readonly: true });
/** `site` lives on the RAW archived row ("coinpoker" | "ignition"), not on ParsedHand — normalizeHand drops it,
 *  which is why an earlier version of this script read `(hand as {site}).site` and got undefined every time,
 *  silently routing every hand (including CoinPoker's) through the 6-max strategy. */
function loadHand(id: string): { hand: ParsedHand; site: string } | null {
  const row = id.startsWith("rowid:")
    ? db.query<{ data: string }, [number]>("SELECT data FROM hands WHERE rowid = ?").get(Number(id.slice(6)))
    : db.query<{ data: string }, [string, string]>("SELECT data FROM hands WHERE hand_id = ? OR json_extract(data, '$.clientHandId') = ? ORDER BY rowid DESC LIMIT 1").get(id, id);
  if (!row) return null;
  const raw = JSON.parse(row.data);
  return { hand: normalizeHand(raw).hand, site: String(raw.site ?? "ignition") };
}

/** The hand before actions[upto] with stacks rebuilt from `dealtStack` (archived rows carry end-of-hand stacks). */
function snapshot(hand: ParsedHand, upto: number): ParsedHand {
  const act = hand.actions[upto]!;
  const street = act.street as ParsedHand["street"];
  const boardLen = street === "flop" ? 3 : street === "turn" ? 4 : street === "river" ? 5 : 0;
  const actions = hand.actions.slice(0, upto);
  const seats = Object.keys(hand.positions).map(Number);
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
    stacks[s] = Math.round((dealtStack - spent) * 100) / 100;
  }
  if (drift && street !== "flop") {
    // the shortest villain moves — that is the reading the effective stack follows
    const villains = seats.filter((s) => s !== hand.heroSeatId).sort((a, b) => stacks[a]! - stacks[b]!);
    if (villains[0] != null) stacks[villains[0]] = Math.round((stacks[villains[0]]! + drift) * 100) / 100;
  }
  const top = Math.max(0, ...Object.values(committed));
  // THE POT AS IT STOOD (2026-09-25, round 2): the archive's currentNode.pot is the END of the hand's, and the capture
  // gate's pot ledger (round 1) refused every later-street snapshot as \"chips with no action\". Ignition reports the
  // closed rounds' chips, so that is what the snapshot carries.
  let pot = 0;
  for (const [st, m] of per) if (st !== street) for (const v of m.values()) pot += v;
  return {
    ...hand, actions, street, board: hand.board.slice(0, boardLen), ended: false, stacks, committed,
    currentNode: { ...hand.currentNode, street, toActIsHero: true, toCall: Math.max(0, top - (committed[hand.heroSeatId] ?? 0)), complete: false, pot: Math.round(pot * 100) / 100 },
  };
}

const SI: Record<string, number> = { flop: 0, turn: 1, river: 2 };
let decisions = 0, later = 0, reused = 0, fresh = 0, answered = 0, nodesRead = 0, nodesRecomputed = 0;
const failures: string[] = [];
/** every node this hand has read so far: plan|street|codes */
const seenNodes = new Set<string>();
const before = gtowApi.requestStats().last24h.total;
/** one row per decision — the timing rollup is built from this, not from the log lines */
interface TimingRow { hand: string; street: string; ask: number; ms: number; ok: boolean; answered: boolean; fresh: number; cachedStreets: number }
const timings: TimingRow[] = [];

for (const id of ids) {
  const loaded = loadHand(id);
  if (!loaded) { console.log(`\n${id}: not in ${dbPath}`); failures.push(`${id}: not found`); continue; }
  const { hand, site } = loaded;
  const seats = Object.keys(hand.positions).length;
  const strategyId = site === "coinpoker" ? CP_HU_STRATEGY : SIX_MAX_STRATEGY;
  const heroPos = hand.positions[hand.heroSeatId] ?? null;
  const key = String(hand.clientHandId ?? hand.handId ?? "");
  forgetPostflopPin(key);
  forgetCheckpoints(key);
  seenNodes.clear();
  const decs = hand.actions.map((a, i) => ({ a, i })).filter(({ a }) => a.hero && (a.street === "flop" || a.street === "turn" || a.street === "river"));
  console.log(`\n== hand ${key} (${id}): ${seats} seats, hero ${heroPos} ${hand.heroCards.join("")}, board ${hand.board.join("")}, ${decs.length} decisions · ${strategyId}${drift ? ` · drift ${drift}bb` : ""}`);
  for (const { a, i } of decs) {
    for (let ask = 0; ask < (twice ? 2 : 1); ask++) {
      const h = snapshot(hand, i);
      const t0 = Date.now();
      const r = await fastSolve(h, heroPos, { strategyId, origin: "stress" });
      const ms = Date.now() - t0;
      decisions++;
      const cur = SI[a.street] ?? 0;
      const verdict: string[] = [];
      let ok = true;
      if (r.ok) answered++;
      const stored = r.ok && r.solveId != null ? solveStore.get(r.solveId) : null;
      const tr = stored?.trace;
      if (tr) {
        const first = tr.spec?.firstStreet ?? 0;
        for (const s of tr.streets ?? []) {
          const k = s.si + first;
          if (s.created) fresh++;
          if (k < cur) {
            later++;
            // a street from the closed checkpoint, or resumed at hero's node from the mid-street one (only what
            // happened AFTER his node was read), is reuse; a walk from the root is not
            if (s.fromCheckpoint || s.resumedAt != null) reused++;
            else { ok = false; verdict.push(`${s.street} RE-WALKED from the root (${s.created ? `tree CREATED — ${s.treeWhy}` : "tree cached"}, ${s.nodeSrc?.fetched ?? "?"} nodes fetched)`); }
          }
          if (s.resumeMiss && !s.fromCheckpoint) verdict.push(`${s.street} not resumed: ${s.resumeMiss}`);
        }
        // THE STRICT RULE: no node this hand has already read is read again — by street, action path and plan.
        // Nodes from a checkpoint (closed or mid-street) are not reads. Hero's own node re-served from the
        // mid-street checkpoint (src "checkpoint") is not a read either.
        const plan = String(tr.spec?.planTag ?? "");
        // a node is the same node only on the same TREE: a street re-pinned to a new size is a new tree, and the
        // node where the wager is offered must be read on it once (the nodes before it are not — that is the check)
        const solOf = new Map<number, string>((tr.streets ?? []).map((s: { si: number; solId: string | null }) => [s.si, String(s.solId ?? "?")]));
        for (const n of tr.nodes ?? []) {
          const key = `${plan}|${n.street}|${solOf.get(n.si) ?? "?"}|${n.codes.join("-")}`;
          const isRead = !n.fromCheckpoint && n.src !== "checkpoint";
          if (isRead) {
            nodesRead++;
            if (seenNodes.has(key)) { nodesRecomputed++; ok = false; verdict.push(`node ${n.street} [${n.codes.join("-") || "root"}] read AGAIN (${n.src})`); }
          }
          seenNodes.add(key);
        }
        if (tr.checkpoint?.note && !tr.checkpoint.from && cur > 0) verdict.push(tr.checkpoint.note);
      } else if (cur > 0 || ask === 1) {
        ok = false; verdict.push(r.ok ? "no stored trace to check" : `NO ANSWER — ${r.reason}`);
      }
      const top = r.ok ? (r.actions ?? []).slice().sort((x, y) => y.frequency - x.frequency).slice(0, 2).map((x) => `${x.action} ${x.frequency.toFixed(0)}%`).join(", ") : "";
      console.log(`  ${a.street.toUpperCase()}${ask ? " (asked again)" : ""}: ${ms} ms · ${r.ok ? `${r.tier} · ${top}` : "NO ANSWER"} · ${ok ? "OK" : "FAIL"}${verdict.length ? ` · ${verdict.join("; ")}` : ""}`);
      if (!ok) failures.push(`${key} ${a.street}${ask ? " (again)" : ""}: ${verdict.join("; ") || (r.ok ? "" : r.reason)}`);
      const streetsFresh = tr?.streets?.filter((s: { created?: boolean }) => s.created).length ?? -1;
      const streetsCached = tr?.streets ? tr.streets.length - streetsFresh : -1;
      timings.push({ hand: key, street: a.street, ask, ms, ok, answered: r.ok, fresh: streetsFresh, cachedStreets: streetsCached });
    }
  }
}

// ── per-street timing rollup ────────────────────────────────────────────────────────────────────────────────────
// The claim under test: a LATER street must never cost MORE than a fresh street of its own, because everything
// before it is a checkpoint read (memory), not a re-solve. First-ask numbers show the real cost of the ONE fresh
// cloud solve each decision needs; second-ask numbers (--twice) show the all-cache floor — what the poller pays
// when it re-polls a decision nobody has acted on yet.
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const byStreetAsk = (street: string, ask: number) => timings.filter((t) => t.street === street && t.ask === ask && t.answered).map((t) => t.ms);
console.log("\n── per-street timing (first ask = the real cost; second ask = all-cache floor) ──");
console.log("street   n(1st)  p50    mean    max    ‖  n(2nd)  p50    mean    max");
for (const street of ["flop", "turn", "river"]) {
  const first = byStreetAsk(street, 0);
  const second = byStreetAsk(street, 1);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const row = (xs: number[]) => `${String(xs.length).padStart(5)}  ${String(pct(xs, 0.5)).padStart(5)}  ${String(mean(xs)).padStart(5)}  ${String(xs.length ? Math.max(...xs) : 0).padStart(5)}`;
  console.log(`${street.padEnd(8)} ${row(first)}  ‖  ${row(second)}`);
}
console.log("\n── per-hand timeline (flop → turn → river, first ask only) ──");
const byHand = new Map<string, TimingRow[]>();
for (const t of timings) { if (t.ask !== 0) continue; (byHand.get(t.hand) ?? byHand.set(t.hand, []).get(t.hand)!).push(t); }
for (const [hand, rows] of byHand) {
  console.log(`  ${hand}: ${rows.map((r) => `${r.street} ${r.ms}ms${r.ok ? "" : "(FAIL)"}`).join(" → ")}`);
}
const flopMean = byStreetAsk("flop", 0).reduce((a, b) => a + b, 0) / Math.max(1, byStreetAsk("flop", 0).length);
const turnMean = byStreetAsk("turn", 0).reduce((a, b) => a + b, 0) / Math.max(1, byStreetAsk("turn", 0).length);
const riverMean = byStreetAsk("river", 0).reduce((a, b) => a + b, 0) / Math.max(1, byStreetAsk("river", 0).length);
console.log(`\nmean first-ask latency: flop ${Math.round(flopMean)} ms, turn ${Math.round(turnMean)} ms, river ${Math.round(riverMean)} ms` +
  ` — river should track flop/turn (one fresh solve), not climb with street depth`);

console.log(`\n${decisions} decisions, ${answered} answered · earlier-street reuse ${reused}/${later} (${later ? Math.round(100 * reused / later) : 100}%) · node reads ${nodesRead}, of which read twice ${nodesRecomputed} · ${fresh} fresh cloud solves · ${gtowApi.requestStats().last24h.total - before} GTO Wizard requests`);
if (failures.length) { console.log("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
console.log("every earlier street came from its checkpoint and no node was read twice — nothing was computed twice");
process.exit(0);
