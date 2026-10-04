/**
 * Probe (2026-10-04): CAN A GTO WIZARD AI PREFLOP SOLVE BE MADE TO RESPECT A GIVEN RANGE / STRATEGY FOR A SEAT?
 *
 * Background: `players[].range` is ignored on a PREFLOP tree (_probeForcedDecision.ts `range`; the web app itself sends
 * `range: null` for every preflop player — its tree builder writes `range: isPreflop ? null : <range>`). The web app's
 * NODELOCK is the only range/strategy input it has for preflop, and it is NOT a tree field: it is a new custom
 * solution forked from a solved one. Read from the web app's own client code (app.gtowizard.com/react bundle,
 * `nodeLock.dialog` → createCustomSolution):
 *
 *   POST /v4/custom-solutions/
 *   { parent_solution_id: "<solved solution id>",
 *     last_node_lock: {
 *       action_history: ["<preflop_actions of the locked node>", ...flop/turn/river only postflop],
 *       strategy: [ { action: "<code as the node names it: F / C / R2.5 / ...>", strategy: number[1326] }, ... one per action ],
 *       hands_locked: boolean[1326],            // the web app's default "Lock all before nodelocking" sends all true
 *       previous_nodes_lock_type: "street_all" | "last_node" | "street_current_player"   // UI default street_all
 *     } }
 *   → a NEW solution id; its nodes read through the usual GET /v4/solutions/spot-solution/?custom_solution_id=<new id>.
 *
 * (`tree_operations` on the tree body is NODE EDITING — [{actions: [...], action_history: [...]}], add/remove actions —
 * not a range input; player profiles are fold/call/check/bet "incentives", not ranges.)
 *
 * What this probe does, on the smallest tree (heads-up 100bb, SB opens 2.5x only):
 *   1. the plain tree: SB root, and BB's node facing the open ('R2.5')
 *   2. the same solution with SB's ROOT locked to "open AA only, fold the rest" → BB's node facing the open
 *   3. … locked to "open 72o only" / a fractional range (premiums at 0.5) → BB's node facing the open
 *   chain    the raiser IN POSITION: SB limps every hand (lock 1), BB raises with a range (lock 2, forked from lock 1)
 *   replica  _probeForcedDecision's `range` case rebuilt with the raiser ACTING instead of posting his raise
 *
 * RESULTS (2026-10-04, account "primary" = Ultra, 47 requests over four runs, no 429; every locked solve answered the
 * first poll, < 1.4 s):
 *   YES — A NODELOCK IMPOSES A SEAT'S RANGE ON A PREFLOP TREE. POST → 201 with a new id; the locked node reads back
 *   exactly as locked (hands_locked 1326 true) and the next node reports the locked seat's range as sent:
 *     plain     BB facing R2.5: F 36.7 / C 41.3 / R8.8 22.0 · SB's node range 804.2 combos
 *     aa        BB facing R2.5: F 85.2 / C 14.8 / R 0     · SB's node range 6.0 (AA 6.0)
 *     72o       BB facing R2.5: F 0 / C 0 / R 100         · SB's node range 12.0 (72o 12.0)
 *     frac      BB facing R2.5: F 84.4 / C 14.4 / R 1.2   · SB's node range 26.0 = half of the 52 premium combos (AA 3.0)
 *     chain     SB facing C-R2.5: F 74.4 / C 25.1 / R 0.5 · BB's range 52.0, SB's 1326 (plain tree: F 30.5 / C 55.0 / R 14.5)
 *               locks ACCUMULATE: the child of a locked solution keeps the parent's lock (its root still reads C 100%)
 *     replica   hero SB facing X-R13 (16.6 in the pot): raiser = KK/QQ/JJ/AK/AQs/KQs/AJs (46 combos) F 96.6 / C 0.6 / R 2.8;
 *               raiser = his own equilibrium raise (413 combos) F 58.5 / C 32.5 / R 9.0; the forced tree (raiser = any
 *               two, _probeForcedDecision) F 18.1 / C 51.7 / R 30.2
 *   SIZE UNIT: "13bb" in BB's raise list came back R33.8 = 13 x 2.6 when SB had posted 2.6 and BB 1 — a "bb" amount
 *   counted in the larger post here; "5x" (a multiple of the bet faced) gave R13.
 *
 *   . config/env.ps1; & $env:BUN run src/scripts/_probePreflopNodeLock.ts [aa] [72o] [strong] [frac] [chain] [replica]
 *
 * NOT while a session is live. Spends ~8-17 GTO Wizard requests a run; stops on any 429 / limit 401/403.
 */
import { Database } from "bun:sqlite";
import { debugTree } from "../services/gtowAiPreflop";
import { gtowSessions } from "../services/gtowSessions";
import { gtowRequests } from "../services/gtowRequestLog";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const API = "https://api.gtowizard.com";
const db = new Database(`${(process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/")}/poker.sqlite`, { readonly: true });
const T0 = Date.now();
function guard(): void {
  if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — stopping"); process.exit(1); }
  const hr = (db.query("select count(*) n from gtow_requests where ts > ?").get(Date.now() - 3_600_000) as any).n as number;
  if (hr > 1200) { console.log(`account busy: ${hr} requests in the last hour — stopping (wait and re-run)`); process.exit(1); }
  if (++sent > 70) { console.log(`probe budget spent (${sent - 1} requests this run) — stopping`); process.exit(1); }
}
let sent = 0;
function wall(status: number, text: string): void {
  if (status === 429 || ((status === 401 || status === 403) && /limit|quota|exceed/i.test(text))) {
    console.log(`WALL ${status}: ${text.slice(0, 300)} — stopping`); process.exit(2);
  }
}

const pre = (type: string, seatId: number, amount?: number) => ({ seatId, hero: seatId === 2, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const hu: ParsedHand = {
  handId: 1, clientHandId: "probe-preflop-nodelock", bbCents: 200, heroSeatId: 2, heroCards: ["7s", "7c"], board: [], street: "preflop",
  actions: [pre("post-sb", 2, 0.5), pre("post-bb", 1, 1)], liveSeats: [1, 2], committed: {}, potByStreet: {}, positions: { 2: "SB", 1: "BB" }, stacks: { 2: 100, 1: 100 },
  currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 1.5, toCall: 0.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand;
const dt = debugTree(hu, null);
if ("error" in dt) throw new Error(dt.error);
const base: any = dt.body;
// the smallest useful tree: SB opens 2.5x (or limps), BB 3-bets 3.5x, SB 4-bets 2.2x, all-in listed
const body = {
  ...base,
  bet_sizes: { ...base.bet_sizes, street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: ["SB", "BB"].map((position) => ({
    position, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true, allow_3betplus_cold_calls: true,
    bet_sizes: ["2.5x", "100bb"], raise_sizes: ["3.5x", "100bb"], second_raise_sizes: ["2.2x", "100bb"], third_plus_raise_sizes: ["100bb"],
  })) }] },
  players: base.players.map((p: any) => ({ ...p, stack: 100, range: null })),
};

guard();
const best = await gtowSessions.bestToken({ preflop: true });
if (!best) { console.log("no GTO Wizard token"); process.exit(1); }
const SID = best.id;
const H = () => ({ Authorization: `Bearer ${best.token}`, "Content-Type": "application/json" });
console.log(`session ${SID}`);

async function post(kind: "tree" | "solution", path: string, data: any): Promise<any> {
  guard();
  const r = await gtowRequests.fetch(SID, kind, `${API}${path}`, { method: "POST", headers: H(), body: JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
  const t = await r.text();
  wall(r.status, t);
  let j: any = null; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, j, t };
}
async function node(solId: string, line: string, extra: Record<string, string> = {}): Promise<any | null> {
  for (let i = 0; i < 14; i++) {
    guard();
    const q = new URLSearchParams({ custom_solution_id: solId, preflop_actions: line, flop_actions: "", turn_actions: "", river_actions: "", board: "", ...extra });
    const r = await gtowRequests.fetch(SID, "poll", `${API}/v4/solutions/spot-solution/?${q}`, { headers: { Authorization: `Bearer ${best!.token}` }, signal: AbortSignal.timeout(10_000) });
    const t = await r.text();
    wall(r.status, t);
    if (r.status === 200 && t) { const j = JSON.parse(t); if (j?.action_solutions?.length) return j; }
    if (r.status >= 400 && r.status !== 404) { console.log(`   '${line || "root"}' ${r.status}: ${t.slice(0, 300)}`); return null; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  console.log(`   '${line || "root"}' not solved after 14 polls`);
  return null;
}

const idx = (cls: string) => COMBOS.map((c, i) => (c.cls === cls ? i : -1)).filter((i) => i >= 0);
const full = COMBOS.map(() => 1);
const share = (w: number[], s: number[]) => { let a = 0, b = 0; for (let i = 0; i < 1326; i++) { a += w[i]!; b += w[i]! * (s[i] ?? 0); } return a ? b / a : 0; };
function show(label: string, n: any): void {
  if (!n) return;
  const sols: any[] = n.action_solutions;
  const actor = n.game?.players?.find((p: any) => p.is_hero)?.position ?? "?";
  console.log(`   ${label} — ${actor} to act: ` + sols.map((a) => `${a.action.code} ${(100 * share(full, a.strategy)).toFixed(1)}%`).join(" · "));
  for (const p of n.players_info ?? []) {
    const r: number[] = p.range ?? [];
    console.log(`     node range ${p.player?.position}: ${r.reduce((x, y) => x + y, 0).toFixed(1)} combos` +
      (r.length ? ` (AA ${idx("AA").reduce((x, i) => x + r[i]!, 0).toFixed(1)}, 72o ${idx("72o").reduce((x, i) => x + r[i]!, 0).toFixed(1)})` : "") +
      (p.hands_locked ? ` · hands_locked ${Array.isArray(p.hands_locked) ? p.hands_locked.filter(Boolean).length : JSON.stringify(p.hands_locked).slice(0, 60)}` : ""));
  }
  if (n.hands_locked !== undefined) console.log(`     node hands_locked: ${Array.isArray(n.hands_locked) ? n.hands_locked.filter(Boolean).length + " true" : JSON.stringify(n.hands_locked).slice(0, 80)}`);
  for (const k of ["is_node_locked", "is_edited"]) if (n[k] !== undefined) console.log(`     ${k}: ${JSON.stringify(n[k])}`);
  for (const c of ["AA", "KK", "AKs", "T9s", "72o"]) {
    const i = idx(c)[0]!;
    console.log(`     ${c.padEnd(4)} ` + sols.map((a) => `${a.action.code} ${(100 * a.strategy[i]).toFixed(0)}% (ev ${Number(a.evs?.[i] ?? 0).toFixed(2)})`).join(" · "));
  }
}

// 1. the plain tree
const tr = await post("tree", "/v4/custom-solutions/custom-trees/", body);
if (tr.status >= 300) { console.log(`tree refused ${tr.status}: ${tr.t.slice(0, 300)}`); process.exit(1); }
const so = await post("solution", "/v4/custom-solutions/", { custom_tree_id: tr.j.id, actions: "", board: "" });
if (so.status >= 300) { console.log(`solution refused ${so.status}: ${so.t.slice(0, 300)}`); process.exit(1); }
const parent = String(so.j.id);
console.log(`\n== PLAIN tree ${tr.j.id} · solution ${parent}`);
const root = await node(parent, "");
show("root", root);
if (!root) process.exit(1);
const openCode: string = root.action_solutions.find((a: any) => a.action.type === "RAISE" && !a.action.allin)?.action.code;
console.log(`   open code: ${openCode}`);
const plainBB = await node(parent, openCode);
show(`'${openCode}'`, plainBB);

/** Lock one node of `parentSol`: every hand locked, `w(code, cls)` = the probability the hand takes that action. */
async function lock(parentSol: string, line: string, at: any, w: (code: string, cls: string) => number, label: string): Promise<string | null> {
  const codes: string[] = at.action_solutions.map((a: any) => a.action.code);
  const strategy = codes.map((code) => ({ action: code, strategy: COMBOS.map((c) => w(code, c.cls)) }));
  const lockBody = { parent_solution_id: parentSol, last_node_lock: { strategy, hands_locked: COMBOS.map(() => true), action_history: [line], previous_nodes_lock_type: "street_all" } };
  console.log(`\n== LOCK ${label} (node '${line || "root"}', actions ${codes.join("/")})`);
  const lk = await post("solution", "/v4/custom-solutions/", lockBody);
  console.log(`   POST /v4/custom-solutions/ {parent_solution_id, last_node_lock} → ${lk.status}: ` +
    (lk.j?.id ? `id ${lk.j.id} · keys ${Object.keys(lk.j).join(",")} · node_locks ${JSON.stringify(lk.j.node_locks ?? lk.j.node_locks_count ?? null).slice(0, 200)}` : lk.t.slice(0, 400)));
  return lk.status < 300 && lk.j?.id ? String(lk.j.id) : null;
}

// 2/3. the root locked
const want = process.argv.slice(2);
const strongRe = /^(AA|KK|QQ|JJ|AKs|AKo|AQs|KQs|AJs)$/;
const locks: [string, (cls: string) => number][] = [
  ["aa", (c) => (c === "AA" ? 1 : 0)], ["72o", (c) => (c === "72o" ? 1 : 0)], ["strong", (c) => (strongRe.test(c) ? 1 : 0)],
  // a FRACTIONAL range: the premiums at weight 0.5 — does the node report half of each class?
  ["frac", (c) => (strongRe.test(c) ? 0.5 : 0)],
];
for (const [name, opens] of locks) {
  if (want.length ? !want.includes(name) : name === "strong" || name === "frac") continue;
  const child = await lock(parent, "", root, (code, cls) => (code === openCode ? opens(cls) : code === "F" ? 1 - opens(cls) : 0),
    `'${name}': SB root = ${openCode} with ${name}, F the rest`);
  if (!child) continue;
  show("root", await node(child, ""));
  show(`'${openCode}'`, await node(child, openCode));
}

// 4. THE RAISER IN POSITION (the tree's BB): a lock CHAIN. SB limps every hand (lock 1), then BB raises with the strong
//    range and checks the rest (lock 2, forked from lock 1's solution); SB's node facing that raise is the read.
if (want.includes("chain")) {
  const c1 = await lock(parent, "", root, (code) => (code === "C" ? 1 : 0), "chain 1: SB limps every hand");
  const limpNode = c1 ? await node(c1, "C") : null;
  show("'C' after lock 1", limpNode);
  if (c1 && limpNode) {
    const rCode: string = limpNode.action_solutions.find((a: any) => a.action.type === "RAISE" && !a.action.allin)?.action.code;
    const c2 = await lock(c1, "C", limpNode, (code, cls) => (code === rCode ? (strongRe.test(cls) ? 1 : 0) : code === "X" ? (strongRe.test(cls) ? 0 : 1) : 0),
      `chain 2: BB raises ${rCode} with the strong range, checks the rest`);
    if (c2) {
      show("root of chain 2 (lock 1 must hold)", await node(c2, ""));
      show(`'C-${rCode}'`, await node(c2, `C-${rCode}`));
      if (!want.includes("noplain")) show(`'C-${rCode}' on the PLAIN tree`, await node(parent, `C-${rCode}`));
    }
  }
}
// 5. THE REDUCED ARRIVAL TREE'S OWN CASE (_probeForcedDecision.ts `range`: hero SB in for 2.6, the raiser BB raises to
//    13, 1 dead, 100bb each — solved there as a forced tree, the raiser's 13 posted as his blind, read vs ANY TWO CARDS:
//    hero F 18.1 / C 51.7 / R 30.2, AA call ev 36.64). Here the raiser ACTS: SB posts 2.6, BB posts 1, 1 dead; SB checks
//    every hand (lock 1), BB raises to 13 with KK/QQ/JJ/AK/AQs/KQs/AJs and folds the rest (lock 2); hero's node 'X-R13'
//    has the same 16.6 in the pot and 10.4 to call.
const forcedStrong = /^(KK|QQ|JJ|AKs|AKo|AQs|KQs|AJs)$/;
if (want.includes("replica")) {
  const rb = {
    ...body, pot: 1,
    bet_sizes: { ...body.bet_sizes, street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: ["SB", "BB"].map((position) => ({
      position, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true, allow_3betplus_cold_calls: true,
      // "13bb" came back as R33.8 = 13 x 2.6: a "bb" amount counts in the LARGER post (the SB's 2.6 here), so the raise to 13
      // is written as a multiple of the bet faced, "5x" (2.6 x 5)
      bet_sizes: position === "BB" ? ["5x"] : ["2.5x"], raise_sizes: position === "BB" ? ["5x"] : ["2.5x"],
      second_raise_sizes: ["2.5x"], third_plus_raise_sizes: ["2.2x"],
    })) }] },
    players: body.players.map((p: any) => ({ ...p, blind: p.position === "SB" ? 2.6 : 1, stack: 100, range: null })),
  };
  const t2 = await post("tree", "/v4/custom-solutions/custom-trees/", rb);
  if (t2.status >= 300) console.log(`replica tree refused ${t2.status}: ${t2.t.slice(0, 300)}`);
  const s2 = t2.status < 300 ? await post("solution", "/v4/custom-solutions/", { custom_tree_id: t2.j.id, actions: "", board: "" }) : null;
  if (s2 && s2.status < 300) {
    const p2 = String(s2.j.id);
    console.log(`\n== REPLICA tree ${t2.j.id} · solution ${p2}`);
    const r2 = await node(p2, "");
    show("replica root", r2);
    if (r2) {
      const xCode = r2.action_solutions.find((a: any) => a.action.type === "CHECK" || a.action.code === "X")?.action.code ?? "X";
      const c1 = await lock(p2, "", r2, (code) => (code === xCode ? 1 : 0), `replica 1: SB checks every hand`);
      const xn = c1 ? await node(c1, xCode) : null;
      show(`'${xCode}' after lock 1`, xn);
      if (c1 && xn) {
        const rCode: string = xn.action_solutions.find((a: any) => a.action.type === "RAISE" && !a.action.allin)?.action.code;
        const c2 = await lock(c1, xCode, xn, (code, cls) => (code === rCode ? (forcedStrong.test(cls) ? 1 : 0) : code === "F" ? (forcedStrong.test(cls) ? 0 : 1) : 0),
          `replica 2: BB raises ${rCode} with KK/QQ/JJ/AK/AQs/KQs/AJs (the forced probe's set), folds the rest`);
        if (c2) {
          show(`'${xCode}-${rCode}' LOCKED`, await node(c2, `${xCode}-${rCode}`));
          show(`'${xCode}-${rCode}' after lock 1 only (BB's own raising range)`, await node(c1, `${xCode}-${rCode}`));
        }
      }
    }
  }
}

const spent = (db.query("select count(*) n, sum(st=429) x from gtow_requests where ts > ?").get(T0) as any);
console.log(`\nrequests this run: ${sent} (all processes on the account since start: ${spent.n} · 429s ${spent.x ?? 0})`);
process.exit(0);
