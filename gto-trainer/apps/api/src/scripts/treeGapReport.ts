/**
 * HOW FAR ARE THE 6-MAX CHART ANSWERS FROM THEIR TABLES? (2026-10-01, services/treeGap — the log-only stack bound)
 *
 *   bun src/scripts/treeGapReport.ts [--days 14] [--tau 1.25] [--list 15]
 *
 * For every preflop answer the 6-max charts gave: the effective-stack ratio between the table and the chart that
 * answered, per live opponent. An answer logged since the measurement shipped carries it on its path ($.treeGap); an
 * older one is rebuilt here from the archived hand (the stacks as dealt, who had folded / raised / called, the chart
 * id), so the report needs no waiting. Prints the distribution, how many decisions each candidate bound would send
 * to the exact tree, and how much of the gap is a tree that had not landed (closed by solving it) rather than the
 * grid's own step. Reads only; spends no GTO Wizard requests.
 */
import { Database } from "bun:sqlite";
import { answersDbPath, handsDbPath } from "../services/storePaths";
import { startStacksOf } from "../utils/archivedHand/archivedHand";
import { SEATS6, type Seat6 } from "../services/hrc6max";
import { treeGap6, STACK_GAP_TAU, type TreeGap } from "../services/treeGap";

const arg = (name: string, d: number) => { const i = process.argv.indexOf(name); return i >= 0 ? Number(process.argv[i + 1]) || d : d; };
const days = arg("--days", 14), tau = arg("--tau", STACK_GAP_TAU), list = arg("--list", 15);

type Row = { id: number; ts: number; client_hand_id: string | null; hero_pos: string | null; chart: string | null;
  decision_key: string | null; warning: string | null; path: string | null };
const adb = new Database(answersDbPath(), { readonly: true });
const hdb = new Database(handsDbPath(), { readonly: true });
const rows = adb.query<Row, [number]>(
  `SELECT id, ts, client_hand_id, hero_pos, chart, decision_key, warning, path FROM answers
    WHERE source = 'hrc-6max-preflop' AND street = 'preflop' AND pick IS NOT NULL AND ts >= ? ORDER BY ts`).all(Date.now() - days * 86_400_000);
const handOf = hdb.query<{ data: string }, [string]>(`SELECT data FROM hands WHERE client_hand_id = ? ORDER BY rowid DESC LIMIT 1`);

/** the measurement for an answer logged before it existed, from the archived hand */
function rebuild(r: Row): TreeGap | null {
  if (!r.client_hand_id || !r.chart || !r.hero_pos) return null;
  const raw = handOf.get(r.client_hand_id);
  if (!raw) return null;
  let hand: any, upto = 0;
  try { hand = JSON.parse(raw.data); upto = Number(JSON.parse(r.decision_key ?? "null")?.[4]); } catch { return null; }
  if (!hand?.positions || !Number.isFinite(upto)) return null;
  const dealt = startStacksOf(hand);
  const byPos: Partial<Record<Seat6, number>> = {};
  for (const [seat, pos] of Object.entries(hand.positions)) {
    const p = String(pos).toUpperCase() as Seat6;
    if (SEATS6.includes(p) && dealt[Number(seat)] != null) byPos[p] = dealt[Number(seat)]!;
  }
  const folded = new Set<string>(SEATS6.filter((p) => !(p in byPos)));
  // roles from the actions: the last raiser, the seats that called or limped; everyone else live is still to act
  let aggressor: string | null = null;
  const inPot = new Set<string>();
  for (const a of (hand.actions ?? []).slice(0, upto)) {
    const pos = hand.positions[a.seatId] ? String(hand.positions[a.seatId]).toUpperCase() : null;
    if (!pos) continue;
    if (a.type === "fold") folded.add(pos);
    else if (a.type === "raise" || a.type === "bet" || a.type === "all-in") { aggressor = pos; inPot.add(pos); }
    else if (a.type === "call") inPot.add(pos);
  }
  const hero = r.hero_pos.toUpperCase();
  if (aggressor === hero) aggressor = null;
  const after = SEATS6.filter((p) => p !== hero && !folded.has(p) && !inPot.has(p));
  const wanted = /no (\S+) tree in the set/.exec(r.warning ?? "")?.[1] ?? null;
  return treeGap6({ chartId: r.chart, byPos, hero, folded, aggressor, after, wantedId: wanted, mode: "off" });
}

const measured: { r: Row; g: TreeGap; logged: boolean }[] = [];
let unmeasured = 0;
for (const r of rows) {
  let g: TreeGap | null = null, logged = false;
  try { g = (JSON.parse(r.path ?? "null")?.treeGap as TreeGap | undefined) ?? null; logged = !!g; } catch { /* legacy row */ }
  g ??= rebuild(r);
  if (g?.stack) measured.push({ r, g, logged }); else unmeasured++;
}

const pct = (k: number, d: number) => (d ? `${((100 * k) / d).toFixed(1)}%` : "—");
const n = measured.length;
console.log(`6-max chart preflop answers, last ${days} days: ${rows.length}  (measured ${n}: ${measured.filter((m) => m.logged).length} logged live, ` +
  `${measured.filter((m) => !m.logged).length} rebuilt from the archive; ${unmeasured} not measurable)`);
if (!n) process.exit(0);

/** the seat the provisional gate reads: the worst seat already in the pot, else (hero first in) the worst behind */
const gateSeat = (g: TreeGap) => g.pot ?? g.stack!;
const table = (title: string, pick: (g: TreeGap) => number) => {
  console.log(`\n${title}`);
  const xs = measured.map((m) => pick(m.g)).sort((a, b) => a - b);
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  console.log(`  p50 ${q(0.5)}x · p75 ${q(0.75)}x · p90 ${q(0.9)}x · p95 ${q(0.95)}x · max ${xs[xs.length - 1]}x`);
  for (const t of [1.1, 1.15, 1.25, 1.33, 1.5, 2]) {
    const k = xs.filter((x) => x > t).length;
    console.log(`  past ${t.toFixed(2)}x   ${String(k).padStart(5)}  ${pct(k, n)}${t === tau ? "   ← provisional bound" : ""}`);
  }
};
table("A. WORST OF EVERY LIVE SEAT (raiser, callers, seats still to act) — effective stack, table vs chart", (g) => g.stack!.ratio);
table("B. SEATS ALREADY IN THE POT (hero first in: the seats behind) — what the log-only gate reads", (g) => gateSeat(g).ratio);
const first = measured.filter((m) => !m.g.pot), facing = measured.filter((m) => m.g.pot);
console.log(`\nB by spot:  hero first in ${first.length} answers, ${pct(first.filter((m) => gateSeat(m.g).ratio > tau).length, first.length)} past ${tau}x  ·  ` +
  `facing action ${facing.length} answers, ${pct(facing.filter((m) => gateSeat(m.g).ratio > tau).length, facing.length)} past ${tau}x`);

console.log(`\nTHE SAME GAP IN BB (B's seat): answers more than N bb of effective stack off`);
for (const b of [5, 10, 20, 30, 50]) {
  const k = measured.filter((m) => gateSeat(m.g).bb > b).length;
  console.log(`  > ${String(b).padStart(2)}bb   ${String(k).padStart(5)}  ${pct(k, n)}`);
}

const over = measured.filter((m) => gateSeat(m.g).ratio > tau);
const closable = over.filter((m) => m.g.wanted && m.g.wanted.ratio != null && m.g.wanted.ratio <= tau);
console.log(`\nPAST ${tau}x ON B: ${over.length} (${pct(over.length, n)}). ${closable.length} of them wanted a tree that had not landed and would be inside the bound on it ` +
  `(solving it closes the gap); the other ${over.length - closable.length} are the grid's own step, or a stack the chart takes as 100bb.`);
const byRole = new Map<string, number>();
for (const m of over) byRole.set(gateSeat(m.g).role, (byRole.get(gateSeat(m.g).role) ?? 0) + 1);
console.log(`  the seat that is off: ${[...byRole].map(([k, v]) => `${k} ${v}`).join(" · ")}`);

const byChart = new Map<string, number>();
for (const m of over) byChart.set(m.g.chart, (byChart.get(m.g.chart) ?? 0) + 1);
console.log(`\nCHARTS ANSWERING PAST THE BOUND MOST`);
for (const [c, k] of [...byChart].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(k).padStart(4)}  ${c}`);

console.log(`\nTHE FARTHEST ${list} (B)`);
for (const m of over.sort((a, b) => gateSeat(b.g).ratio - gateSeat(a.g).ratio).slice(0, list)) {
  const x = gateSeat(m.g);
  console.log(`  ${x.ratio.toFixed(2)}x  ${String(x.bb).padStart(5)}bb  hand ${m.r.client_hand_id}  ${m.r.hero_pos} vs ${x.seat} (${x.role}): ${x.real}bb at the table, ${x.chart}bb in ${m.g.chart.replace(/^ign200_6max_/, "")}` +
    `${m.g.wanted ? `  (wanted ${m.g.wanted.chart.replace(/^ign200_6max_/, "")}: ${m.g.wanted.ratio ?? "?"}x)` : ""}`);
}
