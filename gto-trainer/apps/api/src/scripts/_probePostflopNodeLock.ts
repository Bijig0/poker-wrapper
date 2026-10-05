/**
 * Probe (2026-10-05, Brady: "test this first"): does GTO Wizard take a POSTFLOP node-lock — so a villain's off-tree
 * action MID-STREET (one hero answers on the same street, e.g. an off-tree check-raise) can carry a range we choose
 * instead of QRE's mistake sliver? And does GTO Wizard keep tiny range weights (a collapsed range) or round them away?
 *
 * Spot: po_hu-004's flop (stress-500): Qh2cQs, BB (OOP) 77.5 vs UTG (IP) 97.5, pot 5.5, the chain's own flop ranges
 * (read from the stress-500 private cache). FIXED sizes, one per level (bet 33%, raise 60%), no all-in: a small tree.
 *   lock   BB's node facing UTG's bet after BB checks ("X-R<b>") locked twice — check-raise with AIR only, then with
 *          TRIPS+ only — and UTG's node facing the check-raise read on each: if the lock works his response must move
 *          (call/raise more vs air, fold more vs trips) and his node must report BB's range = the locked raise range.
 *   scale  the same tree with BB's range × 1e-2 and × 1e-4: same strategies (scale-invariant) unless weights are rounded.
 *
 *   . config/env.ps1; & $env:BUN run src/scripts/_probePostflopNodeLock.ts [lock] [scale]
 *
 * RESULTS (2026-10-05, account "secondary" = Elite, 45 requests, no 429):
 *   lock   WORKS POSTFLOP. action_history is one line PER STREET from preflop: ["", "<flop line>"] on a flop tree,
 *          ["", "", "<turn line>"] on a tree that starts on the turn. ["<flop line>"] alone is accepted (201) but read as
 *          a PREFLOP line: the child then has no flop node (400 NODE_DOES_NOT_EXIST). Flop, BB's check-raise locked:
 *          UTG facing it F 44.3 / C 55.7 / jam 0 (GTO) → AIR only: F 0 / C 1.8 / jam 98.2 → TRIPS+ only: F 98.7 / C 0.1 /
 *          jam 1.2; BB's range at UTG's node = range × lock (max |Δ| 0.0008). Turn tree: GTO C 61.4 → vs air jam 99.8.
 *          Each lock = 1 POST + its node reads; answered at the first poll or two.
 *   scale  strategies identical at BB × 1e-2 (scale-invariant, as theory says); at × 1e-4 GTO Wizard FLOORS weights at
 *          ~1e-7: combos under it drop out (289 → 246 live combos), top-level strategy moved 0.1 pt. Node output carries
 *          weights down to 1e-7 (no 4-decimal rounding; the 0.0001 minimum seen before was our own input's dust).
 *
 * Account "secondary" (Elite: heads-up postflop) only. NOT while a session is live; stops on any 429 / limit-flavoured
 * 401/403, past 600 requests in the account's last hour, or past its own budget (PROBE_BUDGET, default 80).
 */
import { Database } from "bun:sqlite";
import { gtowSessions } from "../services/gtowSessions";
import { gtowRequests } from "../services/gtowRequestLog";
import { TREE_SETTINGS, DEFAULT_TREE_RAKE } from "../services/gtowApi";
import { COMBOS } from "../utils/comboIndex/comboIndex";

const API = "https://api.gtowizard.com";
const ACCT = "secondary";
const BUDGET = Number(process.env.PROBE_BUDGET ?? 80);
const BOARD = "Qh2cQs";
const db = new Database(`${(process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/")}/poker.sqlite`, { readonly: true });
let sent = 0;
function guard(): void {
  if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — stopping"); process.exit(1); }
  const hr = (db.query("select count(*) n from gtow_requests where s = ? and ts > ?").get(ACCT, Date.now() - 3_600_000) as any).n as number;
  if (hr > 600) { console.log(`account busy: ${hr} requests in the last hour — stopping`); process.exit(1); }
  if (++sent > BUDGET) { console.log(`probe budget spent (${sent - 1}) — stopping`); process.exit(1); }
}
function wall(status: number, text: string): void {
  if (status === 429 || ((status === 401 || status === 403) && /limit|quota|exceed/i.test(text))) { console.log(`WALL ${status}: ${text.slice(0, 300)}`); process.exit(2); }
}
const token = await gtowSessions.tokenFor(ACCT as any);
if (!token) { console.log(`no GTO Wizard token for ${ACCT}`); process.exit(1); }
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function post(kind: "tree" | "solution", path: string, data: any): Promise<{ status: number; j: any; t: string }> {
  guard();
  const r = await gtowRequests.fetch(ACCT, kind, `${API}${path}`, { method: "POST", headers: H, body: JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
  const t = await r.text(); wall(r.status, t);
  let j: any = null; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, j, t };
}
async function node(solId: string, flop: string, at: { turn?: string; board?: string } = {}): Promise<any | null> {
  for (let i = 0; i < 16; i++) {
    guard();
    const q = new URLSearchParams({ custom_solution_id: solId, preflop_actions: "", flop_actions: flop, turn_actions: at.turn ?? "", river_actions: "", board: at.board ?? BOARD });
    const r = await gtowRequests.fetch(ACCT, "poll", `${API}/v4/solutions/spot-solution/?${q}`, { headers: { Authorization: H.Authorization }, signal: AbortSignal.timeout(15_000) });
    const t = await r.text(); wall(r.status, t);
    if (r.status === 200 && t) { const j = JSON.parse(t); if (j?.action_solutions?.length) return j; }
    if (r.status >= 400 && r.status !== 404) { console.log(`   '${flop || "root"}${at.turn != null ? ` / turn ${at.turn || "root"}` : ""}' ${r.status}: ${t.slice(0, 300)}`); return null; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  console.log(`   '${flop || "root"}' not solved after 16 polls`); return null;
}

// ── the chain's flop ranges for po_hu-004, from the stress-500 private cache ──────────────────────────────────────
const cache = new Database("C:/Users/Brady/poker-data-stress500/root/gtow-cache.sqlite", { readonly: true });
const blob = (cache.query("select reply from gtow_cache_nodes where addr = ?").get(`||||${BOARD}`) as any)?.reply as Uint8Array | undefined;
if (!blob) { console.log("no cached root node for the spot"); process.exit(1); }
const text = (() => { for (const f of [(b: Uint8Array) => Bun.gunzipSync(b), (b: Uint8Array) => Bun.inflateSync(b), (b: Uint8Array) => b]) { try { const s = new TextDecoder().decode(f(blob)); JSON.parse(s); return s; } catch { /* next */ } } throw new Error("cached node unreadable"); })();
const root0 = JSON.parse(text);
const rangeOf = (pos: string): number[] => root0.players_info.find((p: any) => p.player?.position === pos).range;
const BB = rangeOf("BB"), UTG = rangeOf("UTG");
const sum = (r: number[]) => r.reduce((x, y) => x + y, 0);
console.log(`ranges from the cache: BB ${sum(BB).toFixed(2)}, UTG ${sum(UTG).toFixed(2)} combos`);

const seat = (position: string) => ({ position, type: "FIXED", use_fixed_sizes: true, allow_limp: false, bet_sizes: ["33%"], raise_sizes: ["60%"], second_raise_sizes: ["60%"], third_plus_raise_sizes: ["60%"] });
const body = (bb: number[], start: "FLOP" | "TURN" = "FLOP", pot = 5.5) => ({
  starting_street: start, pot, ante: null, ante_distribution_method: "PER_PLAYER",
  bet_sizes: { ...TREE_SETTINGS, max_num_raises: 3, street_bet_sizes: (["FLOP", "TURN", "RIVER"] as const).map((street) => ({ street, position_bet_sizes: [seat("OOP"), seat("IP")] })) },
  players: [
    { position: "OOP", display_position: "BB", blind: null, range: bb, stack: 77.5, tournament_instant_bounty: null, tournament_total_bounty: null },
    { position: "IP", display_position: "UTG", blind: null, range: UTG, stack: 97.5, tournament_instant_bounty: null, tournament_total_bounty: null },
  ],
  tree_operations: [], resolving_policy: null, rake: { ...DEFAULT_TREE_RAKE }, tournament_data: null,
});
async function solve(bb: number[], label: string, start: "FLOP" | "TURN" = "FLOP", board = BOARD, pot = 5.5): Promise<string | null> {
  const tr = await post("tree", "/v4/custom-solutions/custom-trees/", body(bb, start, pot));
  if (tr.status >= 300) { console.log(`   ${label}: tree refused ${tr.status}: ${tr.t.slice(0, 300)}`); return null; }
  const so = await post("solution", "/v4/custom-solutions/", { custom_tree_id: tr.j.id, actions: "", board });
  if (so.status >= 300) { console.log(`   ${label}: solution refused ${so.status}: ${so.t.slice(0, 300)}`); return null; }
  return String(so.j.id);
}
const totals = (n: any) => n.action_solutions.map((a: any) => `${a.action.code} ${(100 * (a.total_frequency ?? 0)).toFixed(1)}%`).join(" · ");
const rangeAt = (n: any, pos: string): number[] => n.players_info.find((p: any) => p.player?.position === pos)?.range ?? [];
function show(label: string, n: any): void {
  if (!n) { console.log(`   ${label}: (no node)`); return; }
  const r = rangeAt(n, "BB"), nz = r.filter((x) => x > 0);
  console.log(`   ${label} — ${n.game?.active_position}: ${totals(n)} · BB range ${sum(r).toFixed(4)} (${nz.length} combos >0, min ${nz.length ? Math.min(...nz) : 0}) · UTG ${sum(rangeAt(n, "UTG")).toFixed(2)}`);
}

const want = process.argv.slice(2);
const on = (k: string) => !want.length || want.includes(k);
const RANK = (c: string) => "23456789TJQKA".indexOf(c[0]!);

if (on("lock")) {
  console.log("\n== LOCK: an off-tree check-raise mid-street ==");
  const sol = await solve(BB, "base");
  if (!sol) process.exit(1);
  const r0 = await node(sol, ""); show("root", r0);
  const atIp = await node(sol, "X"); show("X (UTG after BB checks)", atIp);
  const betCode = atIp?.action_solutions.map((a: any) => a.action.code).find((c: string) => /^R/.test(c));
  const atBb = betCode ? await node(sol, `X-${betCode}`) : null; show(`X-${betCode} (BB facing the bet)`, atBb);
  if (!atBb) process.exit(1);
  const codes: string[] = atBb.action_solutions.map((a: any) => a.action.code);
  const raiseCode = codes.find((c) => /^R/.test(c))!;
  const vsRaise = await node(sol, `X-${betCode}-${raiseCode}`); show(`X-${betCode}-${raiseCode} (UTG facing the check-raise, unlocked)`, vsRaise);
  const line = `X-${betCode}`;
  // the two locks: BB check-raises with AIR only (no Q, no 2, no pocket pair, no ace) / with TRIPS+ only (a Q or 22);
  // every other hand calls (the lock is a full strategy at the node: one 1326 array per action, summing to 1 per hand)
  const air = (i: number) => { const [a, b] = COMBOS[i]!.cards; return a[0] !== b[0] && ![a, b].some((c) => c[0] === "Q" || c[0] === "2" || c[0] === "A"); };
  const trips = (i: number) => { const [a, b] = COMBOS[i]!.cards; return [a, b].some((c) => c[0] === "Q") || (a[0] === "2" && b[0] === "2"); };
  const historyForms: any[][] = [["", line], ["", line, "", ""]];   // ([line] alone: 201 but the child has no flop node — read as PREFLOP)
  for (const [label, raises] of [["AIR-only check-raise", air], ["TRIPS+-only check-raise", trips]] as const) {
    const strategy = codes.map((code) => ({ action: code, strategy: COMBOS.map((_, i) => (code === raiseCode ? (raises(i) ? 1 : 0) : /^C/.test(code) ? (raises(i) ? 0 : 1) : 0)) }));
    let child: string | null = null;
    for (const action_history of historyForms) {
      const lk = await post("solution", "/v4/custom-solutions/", { parent_solution_id: sol, last_node_lock: { strategy, hands_locked: COMBOS.map(() => true), action_history, previous_nodes_lock_type: "street_all" } });
      console.log(`\n   LOCK ${label}, action_history ${JSON.stringify(action_history)} → ${lk.status}${lk.j?.id ? ` id ${lk.j.id}, node_locks_count ${lk.j.node_locks_count}` : `: ${lk.t.slice(0, 300)}`}`);
      if (lk.status < 300 && lk.j?.id) { child = String(lk.j.id); historyForms.splice(0, historyForms.length, action_history); break; }
    }
    if (!child) continue;
    show("   child root (BB)", await node(child, ""));
    show("   locked node (BB facing the bet)", await node(child, line));
    const n = await node(child, `${line}-${raiseCode}`);
    show(`   UTG facing the check-raise, LOCKED (${label})`, n);
    if (n) { const r = rangeAt(n, "BB"); const want = COMBOS.map((_, i) => (raises(i) ? 1 : 0)); const off = r.reduce((m, w, i) => Math.max(m, Math.abs(w - want[i]! * (rangeAt(atBb, "BB")[i] ?? 0))), 0); console.log(`     BB's range at UTG's node vs (BB range × lock): max |Δ| ${off.toFixed(4)}`); }
  }
}

if (on("turn")) {
  // the chain solves each street as its own tree: a TURN-starting tree (pot 5.5 after the flop checked through), BB's
  // node facing UTG's turn bet locked to "check-raise with air only" — which history form names a turn node?
  console.log("\n== TURN: a lock on a tree that starts on the turn ==");
  const TB = `${BOARD}Tc`;
  const sol = await solve(BB, "turn base", "TURN", TB);
  if (!sol) process.exit(1);
  const atIp = await node(sol, "", { turn: "X", board: TB }); show("turn X (UTG after BB checks)", atIp);
  const betCode = atIp?.action_solutions.map((a: any) => a.action.code).find((c: string) => /^R/.test(c));
  const atBb = betCode ? await node(sol, "", { turn: `X-${betCode}`, board: TB }) : null; show(`turn X-${betCode} (BB facing the bet)`, atBb);
  if (!atBb) process.exit(1);
  const codes: string[] = atBb.action_solutions.map((a: any) => a.action.code);
  const raiseCode = codes.find((c) => /^R/.test(c))!;
  show("turn: UTG facing the check-raise, unlocked", await node(sol, "", { turn: `X-${betCode}-${raiseCode}`, board: TB }));
  const air = (i: number) => { const [a, b] = COMBOS[i]!.cards; return a[0] !== b[0] && ![a, b].some((c) => "QA2T".includes(c[0]!)); };
  const strategy = codes.map((code) => ({ action: code, strategy: COMBOS.map((_, i) => (code === raiseCode ? (air(i) ? 1 : 0) : /^C/.test(code) ? (air(i) ? 0 : 1) : 0)) }));
  const line = `X-${betCode}`;
  for (const action_history of [["", "", line], ["", line]]) {
    const lk = await post("solution", "/v4/custom-solutions/", { parent_solution_id: sol, last_node_lock: { strategy, hands_locked: COMBOS.map(() => true), action_history, previous_nodes_lock_type: "street_all" } });
    console.log(`\n   LOCK air-only turn check-raise, action_history ${JSON.stringify(action_history)} → ${lk.status}${lk.j?.id ? ` id ${lk.j.id}, node_locks_count ${lk.j.node_locks_count}` : `: ${lk.t.slice(0, 300)}`}`);
    if (!(lk.status < 300 && lk.j?.id)) continue;
    const n = await node(String(lk.j.id), "", { turn: `${line}-${raiseCode}`, board: TB });
    show("   turn: UTG facing the check-raise, LOCKED", n);
    if (n) break;
  }
}

if (on("scale")) {
  console.log("\n== SCALE: is a tiny range kept or rounded? ==");
  for (const k of [1, 1e-2, 1e-4]) {
    const sol = await solve(BB.map((w) => w * k), `×${k}`);
    if (!sol) continue;
    const n = await node(sol, "X");
    show(`BB range × ${k}: UTG after BB checks`, n);
    const r0 = await node(sol, "");
    show(`BB range × ${k}: root (BB)`, r0);
  }
}
console.log(`\n${sent} requests sent on ${ACCT}`);
process.exit(0);
