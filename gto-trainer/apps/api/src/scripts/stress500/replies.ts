/**
 * STRESS-500 REVIEW REPLIES (2026-10-07, Brady) — HARNESS ONLY, FOR REVIEW. NOT THE LIVE PATH.
 *
 * The replayer showed no node for the villain actions AFTER hero's last decision on a street (po_3way-006: hero SB bets
 * 4.9 on the river, BB folds, UTG folds), because the live answer path never reads GTO Wizard's reply to hero's last
 * action: hero has no further decision there, so nothing would act on it. Brady: "re-add it and just target the spots
 * that need it, and mark somewhere clearly that this is only for testing purposes, in the live path we don't read cuz
 * this is hero's last action". This script reads those nodes for the replayer and nothing else; src/services is not
 * touched and never calls it.
 *
 * WHAT IT READS. Per hand (or --only id,id): hero's LAST decision. When the SCRIPT's action there (d.took — what the hand
 * played, not our pick) is a bet / raise / all-in and villains act after it on the same street, GTO Wizard's node for
 * each of those villains, in order, on the SAME solved tree that answered hero's node (its stored chain trace in
 * <data>/root/poker.sqlite): hero's action, then each villain's action as the table played it. A size the tree does not
 * offer is snapped to the NEAREST tree size and the view says so (`snapped`); no new tree is ever built — the reads go
 * to that tree's own solve (its GTO Wizard id while it lives, else the same stored tree from the solve cache, re-posted
 * byte for byte by gtowApi's materialisation). A blended multiway answer: each villain is read on the first of the
 * decision's trees that holds him (the served tree first).
 * Skipped: hero's last action check / call / fold (nothing to reply to), no postflop answer, no villain after him.
 *
 * WHERE IT GOES. `replies: { "<step>": view }` on the hand's json (<data>/hands/<id>.json) — the replayer's NodeView
 * (views.ts) plus `reviewOnly: true`, `snapped: {from, to, label} | null`, `requests` (GTO Wizard requests that read
 * spent), `note`. export.ts carries it as `rep`, the replayer draws it with a REVIEW ONLY banner. Nothing is written to
 * the live answers / solves; node replies land in the stress root's own solve cache (<data>/root/gtow-cache.sqlite).
 *
 * SAFETY (run.ts's guards): refuses to start / stops while a poker session is live (the live DB's open sessions and
 * :2000/api/load sessionLive); stops for good on any 429 (exit 3); its own hard cap --budget (default 400 requests,
 * counted in the live ledger under origin "stress500-review"); --gap seconds between reads (default 2). Run --plan
 * first: it counts the candidate hands and reply nodes and estimates the requests without sending any.
 *
 *   powershell: bun src/scripts/stress500/replies.ts --plan [--only id,id]
 *               bun src/scripts/stress500/replies.ts [--budget 400] [--gap 2] [--only id,id] [--force] [--no-real-id]
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { roundContributions } from "../../utils/archivedHand/archivedHand";
import { traceSeats, traceToViews, type NodeView } from "./views";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k: string): boolean => argv.includes(`--${k}`);
const DATA = (arg("data") ?? "C:/Users/Brady/poker-data-stress500").replace(/\\/g, "/");
const LIVE_DIR = "C:/Users/Brady/poker-data";
const WORK = join(DATA, "root");
const PLAN = flag("plan");
const FORCE = flag("force");
const BUDGET = Number(arg("budget") ?? 400);
const GAP_MS = Number(arg("gap") ?? 2) * 1000;
const ONLY = arg("only")?.split(",").filter(Boolean) ?? null;
/** try the tree's own GTO Wizard solve id first (cheapest while it lives); --no-real-id goes straight to the stored tree */
let REAL_ID = !flag("no-real-id");
const ORIGIN = "stress500-review";
const startedAt = Date.now();
const r2 = (x: number): number => Math.round(x * 100) / 100;
const STREET_Q: Record<string, "flopActions" | "turnActions" | "riverActions"> = { FLOP: "flopActions", TURN: "turnActions", RIVER: "riverActions" };
const STREET_ADDR: Record<string, "flop" | "turn" | "river"> = { FLOP: "flop", TURN: "turn", RIVER: "river" };
const log = (s: string): void => { const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`; console.log(line); try { require("node:fs").appendFileSync(join(DATA, "replies.log"), line + "\n"); } catch { /* best effort */ } };

// ── the guards (run.ts's) ────────────────────────────────────────────────────────────────────────────────────────
const liveDb = new Database(join(LIVE_DIR, "poker.sqlite"), { readonly: true });
const isLiveDb = (): boolean => ((liveDb.query("select count(*) n from sessions where ended_at is null").get() as { n: number }).n ?? 0) > 0;
async function isLive(): Promise<string | null> {
  if (isLiveDb()) return "the live DB has an open session";
  try {
    const r = await fetch("http://127.0.0.1:2000/api/load", { signal: AbortSignal.timeout(3000) });
    const j: any = await r.json();
    if (j?.sessionLive) return ":2000/api/load says sessionLive";
  } catch { /* the API down: no session can be live through it */ }
  return null;
}
const ownSince = (t: number): number => (liveDb.query("select count(*) n from gtow_requests where ts >= ? and o = ?").get(t, ORIGIN) as { n: number }).n ?? 0;
const wallsSinceStart = (): number => (liveDb.query("select count(*) n from gtow_requests where ts > ? and st = 429").get(startedAt) as { n: number }).n ?? 0;

// ── the stored traces and the solve cache's trees ────────────────────────────────────────────────────────────────
const rootDb = new Database(join(WORK, "poker.sqlite"), { readonly: true });
const tracesOf = (clientHandId: string, since: number): { id: number; decisionIndex: number | null; trace: any }[] => {
  const rows = rootDb.query("select id, decision_key, trace from solves where client_hand_id = ? and ts >= ? order by ts").all(clientHandId, since) as { id: number; decision_key: string | null; trace: Uint8Array }[];
  const di = (key: string | null): number | null => { try { const k = JSON.parse(key ?? "null"); const i = Array.isArray(k) ? Number(k[k.length - 1]) : NaN; return Number.isFinite(i) ? i : null; } catch { return null; } };
  return rows.flatMap((r) => { try { return [{ id: r.id, decisionIndex: di(r.decision_key), trace: JSON.parse(Buffer.from(Bun.gunzipSync(r.trace as Uint8Array<ArrayBuffer>)).toString("utf-8")) }]; } catch { return []; } });
};
/** the solve cache (read-only here): node address → the tree keys holding it, so a trace's tree is found by its hero node */
const cacheDb = new Database(join(WORK, "gtow-cache.sqlite"), { readonly: true });
const keysByAddr = new Map<string, string[]>();
for (const r of cacheDb.query("select key, addr from gtow_cache_nodes").all() as { key: string; addr: string }[]) {
  const l = keysByAddr.get(r.addr) ?? [];
  l.push(r.key);
  keysByAddr.set(r.addr, l);
}
const addrOf = (street: string, codes: string[], board: string): string => {
  const a: Record<string, string> = { flop: "", turn: "", river: "" };
  a[STREET_ADDR[street]!] = codes.join("-");
  return ["", a.flop, a.turn, a.river, board].join("|");   // gtowSolveCache.nodeAddr
};
/** the cache key of the tree a trace node was read on: the stored node at its address whose actions match it */
function treeKeyOf(n: any): string | null {
  const addr = addrOf(n.street, n.codes ?? [], n.board);
  for (const key of keysByAddr.get(addr) ?? []) {
    const row = cacheDb.query("select status, reply from gtow_cache_nodes where key = ? and addr = ?").get(key, addr) as { status: number; reply: Uint8Array | null } | null;
    if (!row || row.status !== 200 || !row.reply) continue;
    try {
      const d = JSON.parse(Buffer.from(Bun.gunzipSync(row.reply as Uint8Array<ArrayBuffer>)).toString("utf-8"));
      const sols: any[] = d?.action_solutions ?? [];
      if (sols.length !== (n.actions ?? []).length) continue;
      const same = sols.every((s, j) => String(s.action?.code ?? "") === String(n.actions[j]?.code ?? "")
        && Math.abs(Number(s.total_frequency ?? 0) - Number(n.actions[j]?.totalFrequency ?? 0)) < 1e-6);
      if (same) return key;
    } catch { /* unreadable row: not this one */ }
  }
  return null;
}
const nodeCached = (key: string | null, street: string, codes: string[], board: string): boolean =>
  !!key && !!(cacheDb.query("select 1 from gtow_cache_nodes where key = ? and addr = ? and status = 200").get(key, addrOf(street, codes, board)));

// ── matching a table action to a tree action ─────────────────────────────────────────────────────────────────────
const kindOf = (a: any): "fold" | "check" | "call" | "wager" | "allin" => {
  const n = String(a?.name ?? a?.action?.display_name ?? "").toUpperCase(), c = String(a?.code ?? a?.action?.code ?? "");
  if (n.startsWith("FOLD") || c === "F") return "fold";
  if (n.startsWith("CHECK") || c === "X") return "check";
  if (n.startsWith("CALL") || c === "C") return "call";
  if (n.startsWith("ALLIN") || n.startsWith("ALL-IN") || c === "RAI") return "allin";
  return "wager";
};
/** the walk's own tolerance for "the same size" (aiChain matchActionLoose: 5% or 0.15bb) */
const sameSize = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(0.05 * b, 0.15);
interface Pick { idx: number; snapped: { from: number; to: number; label: string } | null; why?: string }
/**
 * The tree action for a table action: fold / check / call by kind; a bet / raise / all-in by SIZE, in the tree's terms
 * (the table's raise-to less what the seat had in on the street beyond the tree's own chips — a dead-money preload),
 * snapped to the nearest wager the tree offers. An all-in for no more than the bet to call is a call.
 */
function pickAction(actions: any[], type: string, amount: number | null, offset: number, toCall: number): Pick {
  const find = (k: string) => actions.findIndex((a) => kindOf(a) === k);
  if (type === "fold") { const i = find("fold"); return i >= 0 ? { idx: i, snapped: null } : { idx: -1, snapped: null, why: "no FOLD on the tree here" }; }
  if (type === "check") { const i = find("check"); return i >= 0 ? { idx: i, snapped: null } : { idx: -1, snapped: null, why: "no CHECK on the tree here" }; }
  if (type === "call") { const i = find("call"); return i >= 0 ? { idx: i, snapped: null } : { idx: -1, snapped: null, why: "no CALL on the tree here" }; }
  const want = amount != null ? r2(amount - offset) : null;
  if (type === "all-in" && want != null && want <= toCall + 0.01) {
    const i = find("call");
    if (i >= 0) return { idx: i, snapped: null };
  }
  const wagers = actions.map((a, i) => ({ a, i })).filter((x) => ["wager", "allin"].includes(kindOf(x.a)));
  if (!wagers.length) return { idx: -1, snapped: null, why: "no bet / raise on the tree here" };
  let best = wagers[0]!;
  if (type === "all-in") best = wagers.find((x) => kindOf(x.a) === "allin") ?? best;
  else if (want != null) for (const x of wagers) if (Math.abs(Number(x.a.betsize) - want) < Math.abs(Number(best.a.betsize) - want)) best = x;
  const to = Number(best.a.betsize);
  const label = `${String(best.a.name ?? "").toUpperCase() === "ALLIN" || kindOf(best.a) === "allin" ? "ALL-IN" : String(best.a.name ?? "BET").toUpperCase()} ${r2(to)}`;
  const snapped = want != null && Number.isFinite(to) && !sameSize(to, want) ? { from: want, to: r2(to), label } : null;
  return { idx: best.i, snapped };
}

// ── the candidates ───────────────────────────────────────────────────────────────────────────────────────────────
const scen = JSON.parse(readFileSync(join(DATA, "scenarios.json"), "utf8")).scenarios as any[];
const clientIdOf = new Map(scen.map((s) => [s.id, String(s.raw?.clientHandId ?? `stress-s5-${s.id}`)]));
interface Follower { step: number; pos: string; type: string; amount: number | null; seatId: number }
interface Walk { traceId: number; trace: any; heroNodeAt: number; key: string | null; realId: string | null; account: string | null; followers: Follower[]; assigned: Set<number> }
interface Cand { id: string; file: string; h: any; d: any; followers: Follower[]; walks: Walk[]; unheld: Follower[] }
const files = readdirSync(join(DATA, "hands")).filter((f) => f.endsWith(".json")).filter((f) => !ONLY || ONLY.includes(f.replace(/\.json$/, "")));
const cands: Cand[] = [];
const skipped: Record<string, number> = {};
const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
for (const f of files.sort()) {
  const file = join(DATA, "hands", f);
  const h = JSON.parse(readFileSync(file, "utf8"));
  if (h.replies && !FORCE) { skip("already has replies"); continue; }
  const ds: any[] = h.decisions ?? [];
  if (!ds.length) { skip("no hero decision"); continue; }
  const d = ds.reduce((a, b) => (b.index > a.index ? b : a));
  if (d.street === "preflop") { skip("hero's last decision is preflop"); continue; }
  if (!["bet", "raise", "all-in"].includes(String(d.took?.type))) { skip(`hero's last action is ${d.took?.type ?? "?"}`); continue; }
  if (!d.ok) { skip("hero's last decision had no answer"); continue; }
  const acts: any[] = h.hand.actions;
  const followers: Follower[] = [];
  for (let j = d.index + 1; j < acts.length; j++) {
    const a = acts[j]!;
    if (a.street !== d.street) break;
    if (a.hero) break;
    followers.push({ step: j, pos: String(h.hand.positions[a.seatId] ?? "").toUpperCase(), type: a.type, amount: a.amount ?? null, seatId: a.seatId });
  }
  if (!followers.length) { skip("no villain acts after hero's last action"); continue; }
  const traces = tracesOf(clientIdOf.get(h.id) ?? `stress-s5-${h.id}`, h.startedAt ? Date.parse(h.startedAt) : 0).filter((t) => t.decisionIndex === d.index);
  if (!traces.length) { skip("no stored trace for hero's last decision"); continue; }
  traces.sort((a, b) => (a.id === d.solveId ? -1 : b.id === d.solveId ? 1 : a.id - b.id));
  const walks: Walk[] = [];
  const held = new Set<number>();
  for (const t of traces) {
    const nodes: any[] = t.trace?.nodes ?? [];
    let at = -1;
    for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k].heroNode) { at = k; break; }
    if (at < 0 || String(nodes[at].street).toLowerCase() !== d.street) continue;
    const hn = nodes[at];
    const st = (t.trace.streets ?? []).find((x: any) => x.si === hn.si);
    const players = traceSeats(t.trace.spec ?? {}, st).players.map((p) => p.toUpperCase());
    const mine = followers.filter((x) => players.includes(x.pos));
    const assigned = new Set(mine.filter((x) => !held.has(x.step)).map((x) => x.step));
    if (!assigned.size) continue;
    for (const s of assigned) held.add(s);
    // the tree's walk goes through every follower it holds up to the last one assigned to it
    const last = Math.max(...assigned);
    walks.push({ traceId: t.id, trace: t.trace, heroNodeAt: at, key: treeKeyOf(hn), realId: st?.solId && !String(st.solId).startsWith("gc:") ? String(st.solId) : null,
      account: st?.account ?? null, followers: mine.filter((x) => x.step <= last), assigned });
  }
  const unheld = followers.filter((x) => !held.has(x.step));
  if (!walks.length) { skip("no tree of the decision holds a villain who acts after hero"); continue; }
  cands.push({ id: h.id, file, h, d, followers, walks, unheld });
}

// ── the plan: candidates, reply nodes, the estimate ──────────────────────────────────────────────────────────────
/** a stored tree re-created for real: tree + solution POSTs + the readiness probe (measured 2026-10-07 on pf_srp-004:
 *  tree, solution, one probe at 2.5 s, then the node) — one more probe of margin */
const MATERIALISE = 4;
let nodesTotal = 0, cachedTotal = 0, estLow = 0, estHigh = 0;
const planRows: string[] = [];
for (const c of cands) {
  for (const w of c.walks) {
    const hn = w.trace.nodes[w.heroNodeAt];
    // the first reply node's address is known before any read (hero's snapped code); later ones depend on the reads
    const heroPick = pickAction(hn.actions, c.d.took.type, c.d.took.amount ?? null, 0, Math.max(...(hn.invested ?? [0])) - (hn.invested?.[hn.actor] ?? 0));
    const first = heroPick.idx >= 0 ? [...(hn.codes ?? []), String(hn.actions[heroPick.idx].code)] : null;
    const n = w.followers.length;
    const c0 = first && nodeCached(w.key, hn.street, first, hn.board) ? 1 : 0;
    nodesTotal += n; cachedTotal += c0;
    const uncached = n - c0;
    estLow += uncached ? 1 + uncached : 0;                                                  // the solve id still lives
    estHigh += uncached ? (REAL_ID && w.realId ? 1 : 0) + (w.key ? MATERIALISE : 0) + uncached : 0;   // it does not
    planRows.push(`${c.id.padEnd(22)} ${String(c.d.street).padEnd(5)} hero ${c.d.took.type} ${c.d.took.amount ?? ""} → ${heroPick.idx >= 0 ? `${hn.actions[heroPick.idx].code}${heroPick.snapped ? ` (snapped ${heroPick.snapped.from} → ${heroPick.snapped.to})` : ""}` : `NOT ON TREE (${heroPick.why})`} · tree #${w.traceId}${w.trace.spec?.planTag ? ` ${w.trace.spec.planTag}` : ""} · ${n} node(s) [${w.followers.map((x) => `${x.pos} ${x.type}`).join(", ")}]${c0 ? " · first cached" : ""}${w.key ? "" : " · NO CACHE KEY"}`);
  }
  if (c.unheld.length) planRows.push(`${"".padEnd(22)} not in any tree: ${c.unheld.map((x) => `${x.pos} ${x.type} (step ${x.step})`).join(", ")}`);
}
console.log(planRows.join("\n"));
console.log(`\nskipped: ${JSON.stringify(skipped)}`);
console.log(`PLAN: ${cands.length} candidate hands · ${cands.reduce((t, c) => t + c.walks.length, 0)} tree walks · ${nodesTotal} reply nodes (${cachedTotal} first nodes already in the solve cache) · estimate ${estLow} requests if the trees' solve ids still live, up to ${estHigh} if every tree must be re-created from the solve cache · budget ${BUDGET}`);
if (PLAN) process.exit(0);
if (!cands.length) { log("nothing to read"); process.exit(0); }

// ── the real run ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const why = await isLive();
  if (why) { log(`a poker session is LIVE (${why}) — not starting (exit 2)`); process.exit(2); }
}
const ENV_FILE = "C:/Users/Brady/poker-wrapper/config/local.env";
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
  }
}
Object.assign(process.env, {
  POKER_DATA_DIR: WORK, GTOW_CACHE_DB_PATH: join(WORK, "gtow-cache.sqlite"), HAND_FACTS_DB_PATH: ":memory:", ANSWERS_DB_PATH: ":memory:",
  GTOW_REQUEST_ORIGIN: ORIGIN, GTOW_REQUESTS_PATH: join(LIVE_DIR, "poker.sqlite"),
  // fewer polls on a re-created solve (this process only): the first at 2.5 s, then every second
  GTOW_POLL_MS: process.env.REVIEW_POLL_MS ?? "1000", GTOW_FIRST_POLL_MS: process.env.REVIEW_FIRST_POLL_MS ?? "2500",
});
delete process.env.GTOW_BLOCK;
delete process.env.GTOW_CACHE;
const { gtowApi } = await import("../../services/gtowApi");
const { storedSolId } = await import("../../services/gtowSolveCache");
const { gtowSessions } = await import("../../services/gtowSessions");
const commit = (() => { try { return require("node:child_process").execSync("git rev-parse --short HEAD", { cwd: import.meta.dir }).toString().trim(); } catch { return "?"; } })();
if (!((await gtowSessions.tokenFor("primary" as any).catch(() => null)) ?? (await gtowSessions.tokenFor("primary" as any, true).catch(() => null)))) {
  log("GTO Wizard primary has no access token — not starting (exit 4)"); process.exit(4);
}
log(`review replies on ${commit} · ${cands.length} hands · budget ${BUDGET} · gap ${GAP_MS / 1000} s · origin ${ORIGIN}`);

let lastReadAt = 0;
let realOk = 0, realDead = 0;
class Stop extends Error { constructor(public code: number, msg: string) { super(msg); } }
async function guard(need: number): Promise<void> {
  const why = await isLive();
  if (why) throw new Stop(2, `a poker session went LIVE (${why}) — stopping (exit 2); resume with the same command when it ends`);
  const w = wallsSinceStart();
  if (w > 0) throw new Stop(3, `GTO Wizard answered 429 ${w}× since this run started — STOPPING for good (exit 3)`);
  const spent = ownSince(startedAt);
  if (spent + need > BUDGET) throw new Stop(5, `budget: ${spent} of ${BUDGET} requests spent, the next read may need ${need} — stopping (exit 5)`);
}
/**
 * One node of the tree, through gtowApi.customNode (the live path's own reader: the solve cache first, then GTO Wizard):
 * on the tree's own GTO Wizard solve while it lives, else on the stored tree (`gc:<key>` — gtowApi re-creates exactly
 * the stored body once and reads it). The real id is registered with gtowApi's owner and cache-key maps (private: the
 * live path learns them when it creates a solve; this process did not create it) so the poll carries the right
 * account's token and the reply is kept in the stress root's cache.
 */
async function readNode(w: Walk, street: string, codes: string[], board: string): Promise<{ ok: boolean; data?: any; status?: number; error?: string; reqs: number }> {
  const q = { [STREET_Q[street]!]: codes.join("-"), board } as any;
  const t0 = Date.now();
  const cached = nodeCached(w.key, street, codes, board);
  await guard(cached ? 0 : (REAL_ID && w.realId ? 1 : 0) + (w.key ? MATERIALISE : 0) + 1);
  if (!cached && GAP_MS > 0) { const wait = lastReadAt + GAP_MS - Date.now(); if (wait > 0) await Bun.sleep(wait); }
  if (!cached) lastReadAt = Date.now();
  let r: any = null;
  if (w.key) {
    // the stored tree's node, if the cache has it, costs nothing whichever id is asked
    if (cached) r = await gtowApi.customNode(storedSolId(w.key), q, 30_000, "review");
  }
  if (!r && REAL_ID && w.realId) {
    const api: any = gtowApi;
    if (w.account === "primary" || w.account === "secondary") api.solOwner?.set?.(w.realId, w.account);
    if (w.key) api.noteSolKey?.(w.realId, w.key);
    // 10 s: a solve a day or two old answers its first poll after ~8 s (GTO Wizard loads it again) — pf_srp-004's
    // was given up at 2.5 s and the stored tree re-created for 3 more requests
    r = await gtowApi.customNode(w.realId, q, 10_000, "review");
    if (r.ok || r.status === 204 || r.status === 400 || r.status === 422) realOk++;
    else if (r.status === 429) { /* the guard stops on the next read */ }
    else {
      realDead++;
      log(`  tree #${w.traceId}: its GTO Wizard solve ${w.realId.slice(0, 8)} did not answer (${String(r.error).slice(0, 100)}) — reading the stored tree instead`);
      w.realId = null;
      if (realDead >= 3 && realOk === 0) { REAL_ID = false; log("  three solve ids in a row did not answer: reading every tree from the solve cache from now on"); }
      r = null;
    }
  }
  if (!r && w.key) r = await gtowApi.customNode(storedSolId(w.key), q, 30_000, "review");
  if (!r) return { ok: false, error: "the tree is neither a live GTO Wizard solve nor in the solve cache", reqs: ownSince(t0) };
  const reqs = ownSince(t0);
  if (!r.ok && r.status === 429) throw new Stop(3, `GTO Wizard answered 429 — STOPPING for good (exit 3)`);
  return r.ok ? { ok: true, data: r.data, reqs } : { ok: false, status: r.status, error: r.error, reqs };
}

const BANNER = "REVIEW ONLY — GTO Wizard's reply to hero's last action, read for the harness. The live path never reads this node: hero has no further decision here.";
let handsDone = 0, nodesRead = 0;
const snappedHands: string[] = [];
try {
  for (const c of cands) {
    const replies: Record<string, any> = {};
    const notes: string[] = [];
    const contrib = roundContributions(c.h.hand, c.d.index).get(c.d.street) ?? new Map<number, number>();
    for (const w of c.walks) {
      const nodes: any[] = w.trace.nodes;
      const hn = nodes[w.heroNodeAt];
      const st = (w.trace.streets ?? []).find((x: any) => x.si === hn.si);
      const players = traceSeats(w.trace.spec ?? {}, st).players.map((p) => p.toUpperCase());
      const inv: number[] = (hn.invested ?? players.map(() => 0)).slice();
      let pot = Number(hn.potNode ?? 0);
      const heroSeatId = c.h.hand.heroSeatId;
      // hero's action on the tree: his chips on the street at the table beyond the tree's are its preload
      const heroOffset = r2((contrib.get(heroSeatId) ?? 0) - (inv[hn.actor] ?? 0));
      const heroPick = pickAction(hn.actions, c.d.took.type, c.d.took.amount ?? null, heroOffset, Math.max(...inv) - (inv[hn.actor] ?? 0));
      if (heroPick.idx < 0) { notes.push(`tree #${w.traceId}: hero's ${c.d.took.type} is not on the tree (${heroPick.why})`); continue; }
      const heroA = hn.actions[heroPick.idx];
      const applyTo = (actor: number, a: any): void => {
        const k = kindOf(a);
        if (k === "fold" || k === "check") return;
        const to = Number(a.betsize ?? 0) || (k === "call" ? Math.max(...inv) : inv[actor]!);
        pot = r2(pot + Math.max(0, to - inv[actor]!));
        inv[actor] = to;
      };
      applyTo(hn.actor, heroA);
      const codes = [...(hn.codes ?? []), String(heroA.code)];
      const heroSnap = heroPick.snapped;
      if (heroSnap) snappedHands.push(`${c.id} (${c.d.street}: ${c.d.took.type} ${heroSnap.from} → tree ${heroSnap.label})`);
      const newNodes: any[] = [];
      const meta: { step: number; reqs: number; note: string }[] = [];
      for (const fo of w.followers) {
        const actor = players.indexOf(fo.pos);
        const r = await readNode(w, hn.street, codes, hn.board);
        if (!r.ok) {
          notes.push(`tree #${w.traceId} ${fo.pos} at [${codes.join("-")}]: ${r.status === 204 ? "no decision node (the line closes the street on this tree)" : String(r.error ?? "read failed").slice(0, 200)}`);
          break;
        }
        nodesRead++;
        const sols: any[] = r.data?.action_solutions ?? [];
        const said = r.data?.game?.players?.find?.((p: any) => p?.is_hero)?.position;
        const actions = sols.map((a) => ({
          name: String(a.action?.display_name ?? "?"), code: String(a.action?.code ?? ""),
          betsize: a.action?.betsize != null && a.action.betsize !== "" ? Number(a.action.betsize) : null,
          position: a.action?.position ?? null, totalFrequency: a.total_frequency ?? null, totalEv: a.total_ev ?? null,
          strategy: (a.strategy ?? []).map((x: number) => Math.round(x * 1e4) / 1e4), evs: [] as number[],
        }));
        const toCall = Math.max(...inv) - (inv[actor] ?? 0);
        const offset = r2((contrib.get(fo.seatId) ?? 0) - (inv[actor] ?? 0));
        const vp = pickAction(actions, fo.type, fo.amount, Math.max(0, offset), toCall);
        const rec = { si: hn.si, ti: (hn.ti ?? 0) + newNodes.length + 1, street: hn.street, board: hn.board, codes: codes.slice(), actor, potNode: pot, invested: inv.slice(),
          actions, taken: vp.idx >= 0 ? vp.idx : null, heroNode: false, src: "review" };
        newNodes.push(rec);
        const bits: string[] = [];
        if (said && String(said).toUpperCase() !== fo.pos && players.includes(String(said).toUpperCase())) bits.push(`GTO Wizard's node names ${said} to act (the table: ${fo.pos})`);
        if (vp.idx < 0) bits.push(`the table's ${fo.type} is not on the tree here (${vp.why}) — the walk stops`);
        else if (vp.snapped) bits.push(`${fo.pos}'s ${fo.type} ${vp.snapped.from} taken as the tree's ${vp.snapped.label}`);
        meta.push({ step: fo.step, reqs: r.reqs, note: bits.join("; ") });
        if (vp.idx < 0) break;
        applyTo(actor, actions[vp.idx]);
        codes.push(String(actions[vp.idx]!.code));
      }
      if (!newNodes.length) continue;
      // the views: the stored trace up to hero's node, hero's (snapped) action taken there, then the nodes read here —
      // views.ts conditions every seat's range node by node exactly as for the answered nodes
      const synth = { ...w.trace, nodes: [...nodes.slice(0, w.heroNodeAt), { ...hn, taken: heroPick.idx }, ...newNodes] };
      const src = `tree #${w.traceId}${w.trace.spec?.planTag ? ` · ${w.trace.spec.planTag}` : ""} · review read`;
      const vs = traceToViews(synth, src).slice(-newNodes.length);
      vs.forEach((v: NodeView, k: number) => {
        const m = meta[k]!;
        if (!w.assigned.has(m.step) || replies[String(m.step)]) return;
        replies[String(m.step)] = {
          ...v, reviewOnly: true, banner: BANNER,
          snapped: heroSnap,
          requests: m.reqs,
          note: [heroSnap ? `GTO's reply to the nearest tree size: ${heroSnap.label} (the script ${c.d.took.type === "raise" ? "raised to" : c.d.took.type === "all-in" ? "went all-in for" : "bet"} ${heroSnap.from})` : null, m.note || null].filter(Boolean).join(" · ") || null,
          solveId: w.traceId,
        };
      });
    }
    if (c.unheld.length) notes.push(`not in any tree of the decision: ${c.unheld.map((x) => `${x.pos} (step ${x.step})`).join(", ")}`);
    // the hand file as it is NOW (another tool may have touched it), with the replies beside
    const h = JSON.parse(readFileSync(c.file, "utf8"));
    h.replies = replies;
    h.repliesMeta = { at: new Date().toISOString(), commit, reviewOnly: true, decision: c.d.index, requests: Object.values(replies).reduce((t: number, v: any) => t + (v.requests ?? 0), 0), notes };
    writeFileSync(c.file + ".tmp", JSON.stringify(h));
    renameSync(c.file + ".tmp", c.file);
    handsDone++;
    log(`${String(handsDone).padStart(3)}/${cands.length} ${c.id.padEnd(22)} steps ${Object.keys(replies).join(",") || "-"} · ${h.repliesMeta.requests} req · spent ${ownSince(startedAt)}${notes.length ? ` · ${notes.join(" | ")}` : ""}`);
  }
} catch (e) {
  if (e instanceof Stop) {
    log(e.message);
    log(`stopped: ${handsDone} hands, ${nodesRead} nodes read, ${ownSince(startedAt)} requests`);
    process.exit(e.code);
  }
  throw e;
}
log(`done: ${handsDone} hands, ${nodesRead} nodes read, ${ownSince(startedAt)} requests (origin ${ORIGIN}) · solve ids alive ${realOk}, gone ${realDead}`);
if (snappedHands.length) log(`hero's size snapped in ${snappedHands.length}: ${snappedHands.join("; ")}`);
process.exit(0);
