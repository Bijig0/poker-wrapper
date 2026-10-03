/**
 * THE REPLAY GATE (2026-10-04, the standing pre-deploy gate): REAL decisions through THIS checkout's full answer path —
 * fastSolve's entry to its answer (the preflop pieces, postflopSetup, the flop pot and stacks, the field's stack, the
 * collapse / re-root / last resort, the chain and its resume and memo paths) — compared with what was SERVED live.
 *
 *   bun src/scripts/replayGate.ts --session <session id> [--extra-since 2026-09-27] [--data C:/Users/Brady/poker-data]
 *        [--work <temp dir>] [--reuse-copy] [--hands id,id] [--max-hands N] [--env <the live API's local.env>]
 *   bun src/scripts/replayGate.ts --from 2026-10-03T00:00 --to 2026-10-04T00:00 …
 *
 * WHAT IS REPLAYED: every logged decision of the session (or the date range), plus with --extra-since every logged
 * decision since that date in a hand with an all-in (by the action or by the chips: a whole-stack raise) on any street,
 * or whose chain plan was a collapse, a re-root or the last resort. Hands IN ORDER, a hand's decisions IN ORDER, in
 * one process — a hand's second and third decisions take the resume / memo-hit paths exactly as live (the shape that
 * crashed on hand 4922269408). Each decision is the stored hand cut before it (archivedHand.truncateAt, the money
 * rebuilt as dealt, as /api/dashboard/resolve-chain does) with the session's declared strategy.
 *
 * NOTHING LIVE IS TOUCHED: the central poker.sqlite and the solve cache are COPIED (VACUUM INTO, read-only source) to
 * the work dir and POKER_DATA_DIR points there — the solve store, the request ledger, hand facts all write to the
 * copy. NO GTO WIZARD REQUEST LEAVES: fetch is replaced — only the local chart server (:8777) is reachable — and the
 * account tokens are stubbed, so a tree or node the cache does not hold is recorded as a NEW BODY / NEW NODE (the tree
 * body diffed against the nearest body this hand stored live) and that hand's replay stops there.
 *
 * VERDICTS per decision: SAME (the served mix to 0.5pp, or both refused) · DIFF (both answered, mixes differ) ·
 * NEW BODY / NEW NODE (a request the cache lacks — the branch built something live did not) · REFUSAL-CHANGE (one
 * answered, the other refused) · CRASH (a throw, or the solver-error refusal a throw becomes) · SKIPPED (after a hand
 * stopped) · CACHE-MISS (live answered on a tree the copied solve cache no longer holds: the hand stops). A DIFF is EXPLAINED when the answer's path differs (a plan, the narrowing) — the cause is named.
 * PREFLOP (--preflop served, the default since 2026-10-04): a hand's preflop decisions are replayed and reported on
 * their own (SAME, or DIFF classified: the chart's content changed / a different chart picked / a GTO Wizard AI tree,
 * same body or new) but they no longer decide what the postflop replays from: the flop-entering ranges are the ones
 * the LIVE solve used (the hand's stored traces, through fastSolve's replay seam), so the postflop decisions replay
 * against the cached trees whatever the charts have become. A preflop DIFF or NEW BODY never stops the hand.
 * --preflop charts: today's charts decide the postflop too (the first gate).
 *
 * Exit: 0 clean · 1 a CRASH or an unexplained DIFF · 2 a poker session went live (stopped; re-run later).
 *
 * ONE COMMAND (--control <commit>): makes a temporary worktree of <commit> (node_modules linked, this script and the
 * seam copied in, the seam put into its fastSolve), runs the gate there, runs it here against that run, prints the
 * verdict and removes the worktree (--keep-control keeps it):
 *   bun src/scripts/replayGate.ts --session session_20261003_111447 --extra-since 2026-09-27 --control 0a2bae4
 *
 * THE LIVE DATA MOVES (first run, 2026-10-04): the same decisions replayed with the code that SERVED them still differ
 * from what was served — a chart node re-baked since, a short-stack rung picked from the stacks as dealt instead of
 * the live reading, an archived capture that differs from the one answered live — and every flop after a preflop
 * that moved is a NEW BODY. So the gate's verdict is taken AGAINST A BASELINE: run it first from a checkout of the
 * commit that served live (git worktree add --detach <dir> <live commit>; link node_modules; copy this script), then
 * from the candidate with --baseline <that run's report>. Only what the candidate changes counts:
 *   (live commit checkout)  bun src/scripts/replayGate.ts --session S --extra-since D --work <tmp>/control
 *   (candidate checkout)    bun src/scripts/replayGate.ts --session S --extra-since D --work <tmp>/candidate  *                               --baseline <tmp>/control/replay-gate-S.json
 * With a baseline, exit 1 = a CRASH, or a decision that became a DIFF / refusal change against the baseline.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ---- arguments ---------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? "" : null; };
const flag = (k: string) => argv.includes(`--${k}`);
const SESSION = arg("session");
const PREFLOP = (arg("preflop") ?? "served") === "charts" ? "charts" : "served";
const CONTROL = arg("control");
const FROM = arg("from"), TO = arg("to");
const EXTRA_SINCE = arg("extra-since");
const LIVE_DIR = (arg("data") ?? process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/");
const WORK = (arg("work") ?? join(tmpdir(), "replay-gate")).replace(/\\/g, "/");
const ONLY = arg("hands")?.split(",").filter(Boolean) ?? null;
const MAX_HANDS = Number(arg("max-hands") ?? Infinity);
if (!SESSION && !(FROM && TO)) { console.error("usage: --session <id> | --from <iso> --to <iso> [--extra-since <date>]"); process.exit(64); }

const liveDb = () => new Database(join(LIVE_DIR, "poker.sqlite"), { readonly: true });
const liveSession = (): string | null => {
  const d = liveDb();
  try { return (d.query("select id from sessions where ended_at is null limit 1").get() as { id: string } | null)?.id ?? null; } finally { d.close(); }
};
{ const s = liveSession(); if (s) { console.error(`a poker session is LIVE (${s}) — not replaying; run again when it has ended`); process.exit(2); } }

if (CONTROL) {
  const git = (...a: string[]) => { const r = spawnSync("git", a, { cwd: import.meta.dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  const top = git("rev-parse", "--show-toplevel");
  const commit = git("rev-parse", "--short", CONTROL);
  const dir = join(tmpdir(), `replay-gate-control-${commit}`).replace(/\\/g, "/");
  const api = "gto-trainer/apps/api";
  if (!existsSync(dir)) git("-C", top, "worktree", "add", "--detach", dir, commit);
  for (const nm of ["gto-trainer/node_modules", `${api}/node_modules`]) {
    if (existsSync(join(dir, nm)) || !existsSync(join(top, nm))) continue;
    const r = spawnSync("cmd", ["/c", "mklink", "/J", join(dir, nm), join(top, nm)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`linking ${nm}: ${r.stderr || r.stdout}`);
  }
  for (const f of ["replayGate.ts", "replayGateSeam.ts"]) copyFileSync(join(import.meta.dir, f), join(dir, api, "src", "scripts", f));
  const { withReplaySeam } = await import("./replayGateSeam");
  const fsPath = join(dir, api, "src", "services", "fastSolve.ts");
  writeFileSync(fsPath, withReplaySeam(readFileSync(fsPath, "utf8")));
  const pass = argv.filter((a, i) => !["--control", "--baseline", "--work"].includes(a) && !["--control", "--baseline", "--work"].includes(argv[i - 1] ?? "") && a !== "--keep-control");
  const workC = `${WORK}-control-${commit}`, workN = `${WORK}-candidate`;
  console.log(`== control ${commit} (${dir})`);
  const c = spawnSync("bun", ["src/scripts/replayGate.ts", ...pass, "--work", workC], { cwd: join(dir, api), stdio: "inherit" });
  if (c.status === 2) process.exit(2);
  const tag = (SESSION ?? `${FROM}_${TO}`).replace(/[^\w.-]+/g, "_");
  console.log(`== candidate ${git("rev-parse", "--short", "HEAD")} (this checkout)`);
  const n = spawnSync("bun", [join(import.meta.dir, "replayGate.ts"), ...pass, "--work", workN, "--baseline", join(workC, `replay-gate-${tag}.json`)], { cwd: join(import.meta.dir, "..", ".."), stdio: "inherit" });
  if (!flag("keep-control")) { try { git("-C", top, "worktree", "remove", "--force", dir); } catch (e) { console.error(`(the control worktree stays: ${(e as Error).message})`); } }
  console.log(`\nVERDICT against ${commit}: ${n.status === 0 ? "PASS" : n.status === 2 ? "STOPPED (a session went live)" : "FAIL"}`);
  process.exit(n.status ?? 1);
}

// ---- the work copy -----------------------------------------------------------------------------------------------
mkdirSync(WORK, { recursive: true });
const t0 = Date.now();
const copyDb = (name: string) => {
  const to = join(WORK, name);
  if (flag("reuse-copy") && existsSync(to)) return;
  const tmp = `${to}.copying`;
  for (const p of [to, tmp]) { try { require("node:fs").rmSync(p, { force: true }); } catch { /* none */ } }
  const src = new Database(join(LIVE_DIR, name), { readonly: true });
  try { src.run(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { src.close(); }
  require("node:fs").renameSync(tmp, to);
};
copyDb("poker.sqlite");
copyDb("gtow-cache.sqlite");
for (const f of ["gtow-accounts.json", "wrapper/profiles.json", "api/fx.json", "api/tasks.json", "api/balance-acks.json", "api/river_mes_config.json"]) {
  const from = join(LIVE_DIR, f);
  if (!existsSync(from)) continue;
  mkdirSync(dirname(join(WORK, f)), { recursive: true });
  copyFileSync(from, join(WORK, f));
}
const copyMs = Date.now() - t0;

// ---- the environment: the live API's settings (config/local.env — the trust guard, chart dirs, …), then everything
// in the work copy and nothing to GTO Wizard ------------------------------------------------------------------------
const ENV_FILE = arg("env") ?? "C:/Users/Brady/poker-wrapper/config/local.env";
if (existsSync(ENV_FILE)) {
  for (const line of require("node:fs").readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
  }
}
Object.assign(process.env, {
  POKER_DATA_DIR: WORK, GTOW_CACHE_DB_PATH: join(WORK, "gtow-cache.sqlite"), HAND_FACTS_DB_PATH: ":memory:",
  GTOW_REQUEST_ORIGIN: "replay-gate", GTOW_PREFETCH: "0",
});
delete process.env.GTOW_BLOCK;
delete process.env.GTOW_CACHE;
// THE CHARTS ARE THE LIVE API'S (2026-10-04, the coordinator's finding): the 6-max bake is read where the live API reads
// it — factoryFile("hrc6max-preflop.sqlite") under FACTORY_DATA_DIR from config/local.env — in place, read-only (never
// copied: 11 GB). The first gate set HRC6MAX_DB to the wrapper repo's apps/api/data copy, a STALE bake of 2026-09-27
// (124 charts, the bodies before the 2026-10-01 re-conversion): that, not a re-bake, was its 37 preflop DIFFs. So no
// override here, and the run refuses to start unless the bake resolves to the factory's file.
{
  const factory = process.env.FACTORY_DATA_DIR;
  if (process.env.HRC6MAX_DB) { console.error(`HRC6MAX_DB is set (${process.env.HRC6MAX_DB}) — the replay must read the live API's bake; unset it`); process.exit(64); }
  if (!factory) { console.error(`FACTORY_DATA_DIR is not set (${ENV_FILE}) — the bake would resolve to the checkout's own data/ copy, which may be stale`); process.exit(64); }
}
type Blocked = { kind: "tree" | "node" | "other"; url: string; body: unknown };
let blocked: Blocked[] = [];
let arrivalBlocked = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (/^https?:\/\/(localhost|127\.0\.0\.1):8777\//.test(url)) return realFetch(input, init);   // the local chart server
  let body: unknown = null;
  try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = String(init?.body ?? "").slice(0, 2000); }
  const kind = /custom-trees|custom-solutions\/?$/.test(url) && (init?.method ?? "GET") !== "GET" ? "tree" : /spot-solution/.test(url) ? "node" : "other";
  if (((globalThis as any).__replaySeams?.computingArrival ?? 0) > 0) arrivalBlocked++;   // an old preflop tree: the stored ranges stand in
  else blocked.push({ kind, url, body });
  return new Response(JSON.stringify({ detail: "replay gate: no network" }), { status: 503 });
}) as typeof fetch;
(globalThis as any).WebSocket = class { constructor(u: string) { blocked.push({ kind: "other", url: String(u), body: null }); throw new Error("replay gate: no websockets"); } };

{
  const { factoryFile } = await import("../services/repoPaths");
  const bake = factoryFile("hrc6max-preflop.sqlite");
  const want = join(process.env.FACTORY_DATA_DIR!, "hrc6max-preflop.sqlite");
  if (bake.replace(/\\/g, "/").toLowerCase() !== want.replace(/\\/g, "/").toLowerCase() || !existsSync(bake)) {
    console.error(`the 6-max bake resolves to ${bake}, not the live API's ${want} — refusing to replay against other charts`);
    process.exit(64);
  }
  const b = new Database(bake, { readonly: true });
  let trees = 0, built = 0;
  try { const r = b.query("select count(*) n, max(built_at) m from trees").get() as { n: number; m: number }; trees = r.n; built = r.m; } finally { b.close(); }
  console.log(`charts: ${bake} (read-only) · ${trees} trees · last built ${new Date(built * 1000).toISOString()}`);
  (globalThis as any).__replayBake = { path: bake, trees, built };
}
const FS = await import("../services/fastSolve");
const { fastSolve } = FS;
const seams = (FS as any).replaySeams as { arrival: ((h: any) => any) | null; computingArrival: number } | undefined;
if (PREFLOP === "served" && !seams) { console.error("this checkout's fastSolve has no replay seam (scripts/replayGateSeam.ts withReplaySeam) — run with --preflop charts, or through --control"); process.exit(64); }
(globalThis as any).__replaySeams = seams;
const { normalizeHand } = await import("../feed/normalizeHand/normalizeHand");
const { truncateAt, withStartStacks } = await import("../utils/archivedHand/archivedHand");
const { canonicalStrategyId } = await import("../services/strategies");
const { gtowSessions } = await import("../services/gtowSessions");
const { gtowApi } = await import("../services/gtowApi");
(gtowSessions as any).tokenFor = async () => "replay-gate-no-token";
(gtowApi as any).accessToken = async () => "replay-gate-no-token";

// ---- the decisions -----------------------------------------------------------------------------------------------
const db = new Database(join(WORK, "poker.sqlite"), { readonly: true });
type Row = { id: number; ts: number; client_hand_id: string; street: string; decision_key: string; text: string | null; decision_json: string | null;
  path: string | null; path_verdict: string | null; fail_reason: string | null; session_id: string | null; warning: string | null; chart: string | null; depth: number | null; line: string | null };
const COLS = "id, ts, client_hand_id, street, decision_key, text, decision_json, path, path_verdict, fail_reason, session_id, warning, chart, depth, line";
let rows: Row[] = SESSION
  ? db.query(`select ${COLS} from answers where session_id = ? and client_hand_id is not null order by ts`).all(SESSION) as Row[]
  : db.query(`select ${COLS} from answers where ts >= ? and ts < ? and client_hand_id is not null order by ts`).all(Date.parse(FROM!), Date.parse(TO!)) as Row[];
const why = new Map<string, string>();   // hand → why it is in the extra set
if (EXTRA_SINCE) {
  const since = Date.parse(EXTRA_SINCE);
  const hands = db.query("select client_hand_id h, data from hands where client_hand_id in (select distinct client_hand_id from answers where ts >= ?)").all(since) as { h: string; data: string }[];
  for (const { h, data } of hands) {
    try {
      const d = JSON.parse(data);
      const start = d.startStacks ?? {};
      const put = new Map<number, number>();
      for (const a of d.actions ?? []) {
        const seat = a.hero ? d.heroSeatId : a.seatId;
        if (a.type === "all-in") { why.set(h, "all-in"); break; }
        // chips by street: a raise/bet/all-in amount is the street total, a call adds (archivedHand.roundContributions)
        const k = seat * 10 + ["preflop", "flop", "turn", "river"].indexOf(a.street);
        const amt = Number(a.amount ?? 0);
        if (a.type === "call") put.set(k, (put.get(k) ?? 0) + amt); else if (/^(post|raise|bet)/.test(a.type)) put.set(k, Math.max(put.get(k) ?? 0, amt));
        const total = [0, 1, 2, 3].reduce((s, i) => s + (put.get(seat * 10 + i) ?? 0), 0);
        if (start[seat] != null && total >= Number(start[seat]) - 0.05 && Number(start[seat]) > 0) { why.set(h, "whole-stack"); break; }
      }
    } catch { /* unreadable row */ }
  }
  for (const s of db.query("select client_hand_id h, trace from solves where ts >= ? and trace is not null and client_hand_id is not null").all(since) as { h: string; trace: Uint8Array }[]) {
    if (why.has(s.h)) continue;
    try {
      const sp = JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(s.trace))).toString("utf-8")).spec ?? {};
      if (/^last-resort/.test(sp.planTag ?? "")) why.set(s.h, "last-resort");
      else if (sp.firstStreet) why.set(s.h, "re-root");
      else if (sp.planTag) why.set(s.h, "collapse");
    } catch { /* unreadable trace */ }
  }
  const have = new Set(rows.map((r) => r.id));
  const extra = db.query(`select ${COLS} from answers where ts >= ? and client_hand_id is not null order by ts`).all(since) as Row[];
  rows = [...rows, ...extra.filter((r) => why.has(r.client_hand_id) && !have.has(r.id))];
}
// one row per decision: the answered one (the last), else the last refusal
const keyOf = (r: Row) => `${r.client_hand_id}|${r.decision_key}`;
// ---- the flop ranges the live solve used (--preflop served): each seat's range as a stored tree request had it at the
// flop — the hand's walks from the flop (exact, ghost and the last resort's unnarrowed seats; a merged seat holds two
// ranges and is left out), class weights by position (the arrays are built from class weights, so this is exact)
const { COMBOS } = await import("../utils/comboIndex/comboIndex");
const flopSeatsOf = new Map<string, string[]>();
const storedArrival = new Map<string, { ranges: Record<string, Record<string, number>>; complete: boolean } | null>();
const arrivalFor = (hand: string): { ranges: Record<string, Record<string, number>>; complete: boolean } | null => {
  if (storedArrival.has(hand)) return storedArrival.get(hand)!;
  const ranges: Record<string, Record<string, number>> = {};
  for (const s of db.query("select id from solves where client_hand_id = ? and ok = 1 order by id").all(hand) as { id: number }[]) {
    const sp = traceOf(s.id)?.spec;
    if (!sp) continue;
    if (sp.firstStreet && !/^last-resort/.test(sp.planTag ?? "")) continue;          // a re-root's ranges are narrowed
    if (/narrowing/.test(sp.rangeSource ?? "")) continue;                             // so are the narrowed last resort's
    const merged = new Set([...(sp.planTag ?? "").matchAll(/merge:(UTG\+[12]|MP\+1|[A-Z]+)\+(UTG\+[12]|MP\+1|[A-Z]+)/g)].flatMap((m) => [m[1], m[2]]));
    for (const [pos, r] of [[sp.oopPos, sp.oopRange], [sp.midPos, sp.midRange], [sp.ipPos, sp.ipRange]] as [string, number[]][]) {
      if (!pos || ranges[pos] || merged.has(pos) || !Array.isArray(r) || r.length !== 1326) continue;
      const w: Record<string, number> = {};
      r.forEach((x, i) => { const c = COMBOS[i]!.cls; if (x > (w[c] ?? 0)) w[c] = x; });
      ranges[pos] = w;
    }
  }
  const seats = flopSeatsOf.get(hand) ?? [];
  const have = new Set(Object.keys(ranges).map((p) => p.toUpperCase()));
  const hu = seats.length === 2;
  const covered = (p: string) => have.has(p) || (hu && ((p === "BTN" && have.has("SB")) || (p === "SB" && have.has("BTN"))));
  const ov = Object.keys(ranges).length ? { ranges, complete: seats.length > 0 && seats.every(covered) } : null;
  storedArrival.set(hand, ov);
  return ov;
};
if (PREFLOP === "served" && seams) seams.arrival = (h: any) => arrivalFor(String(h.clientHandId ?? ""));
const byDecision = new Map<string, Row>();
for (const r of rows.sort((a, b) => a.ts - b.ts)) {
  const k = keyOf(r), had = byDecision.get(k);
  if (!had || r.text != null || had.text == null) byDecision.set(k, r);
}
const nOf = (r: Row): number => { try { return Number(JSON.parse(r.decision_key)[4]); } catch { return NaN; } };
const hands = new Map<string, Row[]>();
for (const r of byDecision.values()) (hands.get(r.client_hand_id) ?? hands.set(r.client_hand_id, []).get(r.client_hand_id)!).push(r);
let handIds = [...hands.keys()].sort((a, b) => Math.min(...hands.get(a)!.map((r) => r.ts)) - Math.min(...hands.get(b)!.map((r) => r.ts)));
if (ONLY) handIds = handIds.filter((h) => ONLY.includes(h));
handIds = handIds.slice(0, MAX_HANDS);
const strategyOf = new Map<string, string | null>();
const strategyFor = (sid: string | null): string | null => {
  if (!sid) return null;
  if (!strategyOf.has(sid)) {
    const s = db.query("select config from sessions where id = ?").get(sid) as { config: string } | null;
    let id: string | null = null;
    try { id = canonicalStrategyId(JSON.parse(s?.config ?? "{}").strategy ?? null); } catch { id = null; }
    strategyOf.set(sid, id);
  }
  return strategyOf.get(sid)!;
};
const traceOf = (solveId: number) => {
  const r = db.query("select trace from solves where id = ?").get(solveId) as { trace: Uint8Array } | null;
  try { return r?.trace ? JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(r.trace))).toString("utf-8")) : null; } catch { return null; }
};

// ---- comparing ---------------------------------------------------------------------------------------------------
const mixOf = (acts: { action: string; frequency: number }[] | null | undefined) => new Map((acts ?? []).map((a) => [String(a.action), Number(a.frequency) || 0]));
const sameMix = (a: Map<string, number>, b: Map<string, number>) => {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if (Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0)) > 0.5) return false;
  return true;
};
const fmtMix = (m: Map<string, number>) => [...m].filter(([, f]) => f >= 0.05).map(([a, f]) => `${a} ${f.toFixed(1)}`).join(" · ");
const plansOf = (path: any): string => [...new Set((path?.streets ?? []).map((s: any) => s.plan ?? "exact"))].join("+") || "—";
const kindOf = (plans: string): string => /last-resort/.test(plans) ? "last-resort" : /re-?root|rerooted/.test(plans) ? "re-root" : /merge|ghost|all-in left/.test(plans) ? "collapse" : plans === "—" ? "none" : "exact";
/** a flat view of a body: arrays of numbers (ranges) by fingerprint, everything else by path */
const flat = (x: unknown, p = "", out: Record<string, string> = {}): Record<string, string> => {
  if (Array.isArray(x) && x.length > 40 && x.every((v) => typeof v === "number")) out[p] = `#${Bun.hash(JSON.stringify(x)).toString(36).slice(0, 8)}`;
  else if (typeof x === "string" && x.length > 200) out[p] = `#${Bun.hash(x).toString(36).slice(0, 8)}`;
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) flat(v, p ? `${p}.${k}` : k, out);
  else out[p] = JSON.stringify(x);
  return out;
};
const summarized = (body: any): any => !body || !Array.isArray(body.players) ? body : { ...body, players: body.players.map((p: any) => {
  if (!Array.isArray(p.range)) return p;
  let combos = 0, weight = 0;
  for (const w of p.range) if (w > 0) { combos++; weight += w; }
  return { ...p, range: { combos, weight: Math.round(weight * 100) / 100 } };
}) };
const bodyDiff = (a: unknown, b: unknown): string[] => {
  const fa = flat(a), fb = flat(b);
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => fa[k] !== fb[k]).map((k) => `${k}: ${fb[k] ?? "—"} → ${fa[k] ?? "—"}`);
};
/** the stored bodies this hand sent live, every street of every walk */
const storedBodies = (hand: string): { street: string; body: unknown }[] => {
  const out: { street: string; body: unknown }[] = [];
  for (const s of db.query("select id from solves where client_hand_id = ? order by id").all(hand) as { id: number }[]) {
    const tr = traceOf(s.id);
    for (const st of tr?.streets ?? []) if (st.sent) out.push({ street: st.street, body: st.sent });
  }
  return out;
};

// ---- the replay --------------------------------------------------------------------------------------------------
type Verdict = "SAME" | "DIFF" | "NEW BODY" | "NEW NODE" | "REFUSAL-CHANGE" | "CRASH" | "CACHE-MISS" | "SKIPPED";
const results: any[] = [];
const hows: Record<string, number> = {};
let stoppedLive: string | null = null;
const tReplay = Date.now();
for (const [hi, h] of handIds.entries()) {
  if (hi % 25 === 0) { const s = liveSession(); if (s) { stoppedLive = s; break; } }
  const row = db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1").get(h) as { data: string } | null;
  const decisions = hands.get(h)!.sort((a, b) => nOf(a) - nOf(b) || a.ts - b.ts);
  if (!row) { for (const r of decisions) results.push({ hand: h, answer: r.id, street: r.street, verdict: "SKIPPED", why: "hand not archived" }); continue; }
  let raw: any, hand: any;
  try { raw = JSON.parse(row.data); hand = normalizeHand(raw).hand; } catch (e) { for (const r of decisions) results.push({ hand: h, answer: r.id, street: r.street, verdict: "SKIPPED", why: `hand unreadable: ${(e as Error).message}` }); continue; }
  const heroPos = hand.positions?.[hand.heroSeatId] ?? null;
  {
    // the seats that saw the flop and can act there: not folded, not all-in preflop (by the action or by the chips)
    const pos = (a: any) => String(hand.positions?.[a.hero ? hand.heroSeatId : a.seatId] ?? "").toUpperCase();
    const pre = hand.actions.filter((a: any) => a.street === "preflop");
    const folded = new Set(pre.filter((a: any) => a.type === "fold").map(pos));
    const put = new Map<string, number>();
    for (const a of pre) { const p = pos(a), x = Number(a.amount ?? 0); if (a.type === "call") put.set(p, (put.get(p) ?? 0) + x); else if (/^(post|raise|bet|all-in)/.test(a.type)) put.set(p, Math.max(put.get(p) ?? 0, x)); }
    const dealt = raw.startStacks ?? {};
    const allIn = new Set(pre.filter((a: any) => a.type === "all-in").map(pos));
    for (const [sid, d] of Object.entries(dealt)) { const p = String(hand.positions?.[Number(sid)] ?? "").toUpperCase(); if ((put.get(p) ?? 0) >= Number(d) - 0.05 && Number(d) > 0) allIn.add(p); }
    flopSeatsOf.set(h, Object.values(hand.positions ?? {}).map((p: any) => String(p).toUpperCase()).filter((p) => !folded.has(p) && !allIn.has(p)));
  }
  let stopped: string | null = null;
  for (const r of decisions) {
    const base = { hand: h, answer: r.id, street: r.street, set: r.session_id === SESSION ? "session" : (why.get(h) ?? "range"), livePlans: plansOf(r.path ? JSON.parse(r.path) : null) };
    if (stopped) { results.push({ ...base, verdict: "SKIPPED", why: stopped }); continue; }
    const n = nOf(r);
    if (!Number.isFinite(n) || n > hand.actions.length) { results.push({ ...base, verdict: "SKIPPED", why: `decision key ${r.decision_key} past the archived line` }); continue; }
    const cut = withStartStacks(truncateAt(hand, n));
    const t = { ...cut, currentNode: { ...cut.currentNode, toActIsHero: true } };
    const strategyId = strategyFor(r.session_id ?? raw.sessionId ?? null);
    blocked = [];
    arrivalBlocked = 0;
    const tA = Date.now();
    let res: any;
    try {
      res = await fastSolve(t, heroPos, { heroPos, origin: "live", ...(r.session_id ? { sessionId: r.session_id } : {}), ...(strategyId ? { strategyId } : {}) });
    } catch (e) {
      results.push({ ...base, verdict: "CRASH", why: `threw: ${(e as Error)?.stack ?? e}` });
      stopped = "after a crash";
      continue;
    }
    const ms = Date.now() - tA;
    for (const s of res?.path?.streets ?? []) hows[s.how] = (hows[s.how] ?? 0) + 1;
    /** the decision's paths: how each street was walked, and whether the last resort served the narrowed tree */
    const paths = [...new Set([...(res?.path?.streets ?? []).map((s: any) => s.how), ...(/narrowed by the earlier streets by/.test(String(res?.warning ?? "")) ? ["narrowed"] : [])])];
    const arrivalFrom = r.street === "preflop" || PREFLOP !== "served" || !storedArrival.get(h) ? null
      : res?.path?.arrival?.producer === "replay-stored" ? `stored (the arrival itself refused${arrivalBlocked ? ": a preflop tree the cache lacks" : ""})` : "stored";
    const plans = plansOf(res?.path);
    const out: any = { ...base, ms, plans, kind: kindOf(plans === "—" ? base.livePlans : plans), paths, ...(arrivalFrom ? { arrivalFrom } : {}),
      chart: { live: `${r.chart ?? "—"} @${r.depth ?? "?"}`, replay: `${res?.rangeSource ?? res?.gametype ?? "—"} @${res?.depth ?? "?"}` },
      line: { live: r.line ?? null, replay: res?.line ?? null } };
    // A TREE LIVE ASKED FOR TOO: the body (ranges as combos/weight) equals one this hand sent live — live got no tree
    // either (a 429, a failed walk) and went on without it, as this replay just did: not a new body, the answer stands
    let liveAlso = 0;
    if (blocked.some((b) => b.kind === "tree")) {
      const sent = storedBodies(h);
      blocked = blocked.filter((b) => { const same = b.kind === "tree" && sent.some((x) => bodyDiff(summarized(b.body), x.body).length === 0); if (same) liveAlso++; return !same; });
    }
    if (liveAlso) out.liveAlsoFailed = liveAlso;
    if (blocked.length) {
      const tree = blocked.find((b) => b.kind === "tree");
      if (tree) {
        const st = String((tree.body as any)?.starting_street ?? (tree.body as any)?.startingStreet ?? "").toUpperCase();
        const cands = storedBodies(h).filter((x) => !st || String(x.street).toUpperCase() === st);
        const best = cands.map((c) => bodyDiff(summarized(tree.body), c.body)).sort((a, b) => a.length - b.length)[0] ?? null;
        Object.assign(out, { verdict: "NEW BODY" as Verdict, why: best ? `${best.length} field(s) differ from the nearest body sent live on the ${st.toLowerCase()}` : `no body sent live on the ${st.toLowerCase() || "street"} for this hand`, diff: best?.slice(0, 15) ?? null });
      } else {
        Object.assign(out, { verdict: blocked.some((b) => b.kind === "node") ? "NEW NODE" : "NEW BODY", why: `not in the cache: ${blocked[0]!.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 200)}` });
      }
      out.liveMix = fmtMix(mixOf(r.decision_json ? JSON.parse(r.decision_json) : null));
      // a PREFLOP request the cache lacks (a GTO Wizard AI preflop tree built from other stacks) is reported, and with
      // the served preflop it does not stop the hand: the postflop starts from the stored ranges either way
      if (r.street === "preflop") out.preflopClass = "AI-tree answer: a new body";
      if (!(PREFLOP === "served" && r.street === "preflop")) stopped = `stopped: ${out.verdict} at answer ${r.id}`;
      results.push(out);
      continue;
    }
    const liveAnswered = r.text != null && r.decision_json != null;
    const replayAnswered = !!(res?.ok && res.decision != null);
    if (res && res.ok === false && res.kind === "solver-error") Object.assign(out, { verdict: "CRASH", why: res.reason });
    else if (out.liveAlsoFailed && liveAnswered && !replayAnswered) {
      // THE CACHE LOST LIVE'S TREE: live answered on a tree whose body this replay asked for again, and the copy of the
      // solve cache does not hold it (written after the copy, lost when the API worker was killed before its flush, or
      // evicted). Nothing about the code: the hand stops here, as it would at any request the cache cannot answer.
      Object.assign(out, { verdict: "CACHE-MISS", why: `live answered on a tree the solve cache no longer holds (${String(res?.reason ?? "").slice(0, 120)})` });
      stopped = `stopped: CACHE-MISS at answer ${r.id}`;
    }
    else if (liveAnswered !== replayAnswered) Object.assign(out, { verdict: "REFUSAL-CHANGE", why: liveAnswered ? `live answered (${r.text?.slice(0, 80)}), the replay refused: ${res?.reason ?? "no decision"}` : `live refused (${r.fail_reason?.slice(0, 120)}), the replay answered` });
    else if (!liveAnswered) Object.assign(out, { verdict: "SAME", why: "both refused" });
    else {
      const a = mixOf(JSON.parse(r.decision_json!)), b = mixOf(res.actions);
      if (sameMix(a, b)) Object.assign(out, { verdict: "SAME" });
      else {
        const causes: string[] = [];
        if (plans !== base.livePlans) causes.push(`plan ${base.livePlans} → ${plans}`);
        if (out.chart.live !== out.chart.replay) causes.push(`chart ${out.chart.live} → ${out.chart.replay}`);
        if (out.line.live && out.line.replay && out.line.live !== out.line.replay) causes.push(`line ${out.line.live} → ${out.line.replay}`);
        const nl = /narrowed by the earlier streets/.test(res.warning ?? ""), wasNl = /narrowed by the earlier streets/.test(r.warning ?? "");
        if (nl !== wasNl) causes.push(nl ? "the branch served the narrowed last resort" : "the branch served the unnarrowed last resort");
        if (r.street === "preflop") {
          out.preflopClass = /^gtow-ai/.test(r.chart ?? "") && /^gtow-ai/.test(String(res.rangeSource ?? res.gametype ?? "")) ? "AI-tree answer: the same body (cached), a different read"
            : out.chart.live !== out.chart.replay ? `a different chart picked (${out.chart.live} → ${out.chart.replay})`
            : out.line.live && out.line.replay && out.line.live !== out.line.replay ? `a different line (${out.line.live} → ${out.line.replay})`
            : `the chart's content changed (${out.chart.live}, node ${out.line.live ?? "?"})`;
          if (!causes.length) causes.push(out.preflopClass);
        }
        Object.assign(out, { verdict: "DIFF", liveMix: fmtMix(a), replayMix: fmtMix(b), why: causes.join("; ") || null, explained: causes.length > 0,
          warnings: { live: (r.warning ?? "").slice(0, 400), replay: String(res.warning ?? "").slice(0, 400) } });
      }
    }
    // the two live failures of checks #1 / #9 (and any other): the replay's results beside the live ones
    const liveChecks = r.path ? JSON.parse(r.path).checks ?? {} : {};
    const failedLive = Object.entries(liveChecks).flatMap(([s, cs]: any) => (cs ?? []).filter((c: any) => c.status === "fail" && (c.id === 1 || c.id === 9)).map((c: any) => `${s} #${c.id}`));
    if (failedLive.length) {
      const now = res?.path?.checks ?? {};
      out.checks = failedLive.map((k: string) => { const [s, id] = k.split(" #"); const c = (now[s!] ?? []).find((x: any) => x.id === Number(id)); return `${k}: live fail → replay ${c?.status ?? "absent"}${c ? ` (${String(c.text).slice(0, 140)})` : ""}`; });
    }
    out.replay = replayAnswered ? fmtMix(mixOf(res.actions)) : `refused: ${String(res?.reason ?? "no decision").slice(0, 160)}`;
    results.push(out);
  }
}
const replayMs = Date.now() - tReplay;

// ---- the report --------------------------------------------------------------------------------------------------
const tally = (by: (r: any) => string) => {
  const m: Record<string, Record<string, number>> = {};
  for (const r of results) { const k = by(r); (m[k] ??= {})[r.verdict] = (m[k]![r.verdict] ?? 0) + 1; }
  return m;
};
const totals: Record<string, number> = {};
for (const r of results) totals[r.verdict] = (totals[r.verdict] ?? 0) + 1;
const crashes = results.filter((r) => r.verdict === "CRASH");
const unexplained = results.filter((r) => r.verdict === "DIFF" && !r.explained);
const report = {
  args: { SESSION, FROM, TO, EXTRA_SINCE, WORK, LIVE_DIR }, decisions: results.length, hands: handIds.length, totals,
  byStreet: tally((r) => r.street), byPlanKind: tally((r) => r.kind ?? kindOf(r.livePlans ?? "—")), bySet: tally((r) => r.set),
  streetHows: hows, copyMs, replayMs, stoppedLive, preflopMode: PREFLOP, bake: (globalThis as any).__replayBake ?? null,
  preflop: (() => {
    const pf = results.filter((r) => r.street === "preflop");
    const cls: Record<string, number> = {};
    for (const r of pf.filter((x) => x.verdict !== "SAME")) { const k = String(r.preflopClass ?? r.why ?? r.verdict).replace(/\(.*$/, "").trim(); cls[k] = (cls[k] ?? 0) + 1; }
    return { decisions: pf.length, verdicts: pf.reduce((m: Record<string, number>, r) => { m[r.verdict] = (m[r.verdict] ?? 0) + 1; return m; }, {}), classes: cls };
  })(),
  coverage: (() => {
    const post = results.filter((r) => r.street !== "preflop");
    const compared = post.filter((r) => ["SAME", "DIFF", "REFUSAL-CHANGE", "CRASH"].includes(r.verdict));
    const by = (f: (r: any) => string[]) => { const m: Record<string, number> = {}; for (const r of compared) for (const k of f(r)) m[k] = (m[k] ?? 0) + 1; return m; };
    const skipped: Record<string, number> = {};
    for (const r of post.filter((x) => !compared.includes(x))) { const k = `${r.verdict}: ${String(r.why ?? "").replace(/\d+/g, "N").slice(0, 90)}`; skipped[k] = (skipped[k] ?? 0) + 1; }
    const ses = post.filter((r) => r.set === "session");
    return { postflop: post.length, compared: compared.length, session: { postflop: ses.length, compared: ses.filter((r) => compared.includes(r)).length },
      byPlanKind: by((r) => [r.kind ?? "?"]), byPath: by((r) => (r.paths?.length ? r.paths : ["—"])), arrivalStored: compared.filter((r) => r.arrivalFrom).length, notCompared: skipped };
  })(),
  nonSame: results.filter((r) => r.verdict !== "SAME"),
  /** every decision's verdict and the replay's own answer — what a later run compares itself with (--baseline) */
  all: results.map((r) => ({ answer: r.answer, hand: r.hand, street: r.street, verdict: r.verdict, replay: r.replay ?? null, plans: r.plans ?? null, why: r.verdict === "SAME" ? null : r.why ?? null })),
};
const outFile = join(WORK, `replay-gate-${(SESSION ?? `${FROM}_${TO}`).replace(/[^\w.-]+/g, "_")}.json`);
await Bun.write(outFile, JSON.stringify(report, null, 1));
console.log(`REPLAY GATE — ${results.length} decisions in ${handIds.length} hands · copy ${(copyMs / 1000).toFixed(0)} s · replay ${(replayMs / 1000).toFixed(0)} s`);
console.log(`totals ${JSON.stringify(totals)}`);
console.log(`by street ${JSON.stringify(report.byStreet)}`);
console.log(`by plan kind ${JSON.stringify(report.byPlanKind)}`);
console.log(`by set ${JSON.stringify(report.bySet)}`);
console.log(`chain streets by how ${JSON.stringify(hows)}`);
console.log(`preflop (${PREFLOP}) ${JSON.stringify(report.preflop)}`);
console.log(`postflop coverage ${JSON.stringify(report.coverage)}`);
for (const r of report.nonSame.filter((x: any) => x.verdict !== "SKIPPED")) {
  console.log(`  ${r.verdict} · answer ${r.answer} · hand ${r.hand} ${r.street} · ${r.set} · plans live ${r.livePlans} / replay ${r.plans ?? "—"} — ${r.why ?? ""}`);
  if (r.liveMix || r.replayMix) console.log(`      live ${r.liveMix ?? "—"} | replay ${r.replayMix ?? "—"}`);
  if (r.chart && r.chart.live !== r.chart.replay) console.log(`      chart live ${r.chart.live} | replay ${r.chart.replay}`);
  for (const d of r.diff ?? []) console.log(`      ${d}`);
}
for (const r of results.filter((x) => x.checks)) console.log(`  checks · answer ${r.answer} · hand ${r.hand} ${r.street}: ${r.checks.join(" | ")}`);
console.log(`report: ${outFile}`);
if (stoppedLive) { console.error(`STOPPED: a poker session went live (${stoppedLive}) — re-run when it has ended`); process.exit(2); }
// ---- against a baseline: the same decisions replayed with the code that SERVED them (a checkout of the live commit) —
// what is left is this checkout's own doing, not the data that moved since (charts, profiles, the cache)
const BASELINE = arg("baseline");
let codeDiffs: any[] = [];
if (BASELINE) {
  const base = JSON.parse(require("node:fs").readFileSync(BASELINE, "utf8"));
  const was = new Map<number, any>((base.all ?? []).map((x: any) => [x.answer, x]));
  for (const r of report.all) {
    const b = was.get(r.answer);
    if (!b) continue;
    if (b.verdict === r.verdict && (b.replay ?? null) === (r.replay ?? null)) continue;
    codeDiffs.push({ answer: r.answer, hand: r.hand, street: r.street, baseline: `${b.verdict}${b.replay ? ` · ${b.replay}` : ""}${b.why ? ` · ${String(b.why).slice(0, 120)}` : ""}`,
      now: `${r.verdict}${r.replay ? ` · ${r.replay}` : ""}${r.why ? ` · ${String(r.why).slice(0, 160)}` : ""}` });
  }
  console.log(`\nAGAINST THE BASELINE (${BASELINE}): ${codeDiffs.length} decision(s) differ from the code that served them`);
  for (const d of codeDiffs) console.log(`  answer ${d.answer} · hand ${d.hand} ${d.street}\n      baseline ${d.baseline}\n      this     ${d.now}`);
  await Bun.write(outFile.replace(/\.json$/, ".vs-baseline.json"), JSON.stringify(codeDiffs, null, 1));
}
// the exit: a CRASH always fails; without a baseline an unexplained DIFF fails; with one, only what THIS code changed
// counts — a decision that became a DIFF, a refusal change or a crash (a NEW BODY is listed: the intended changes build
// new trees, and the replay cannot price them without GTO Wizard)
// (a decision the baseline CRASHED on and this code answers is the fix, not a failure)
const codeFails = codeDiffs.filter((d) => /^(DIFF|REFUSAL-CHANGE|CRASH)/.test(d.now) && !/^CRASH/.test(d.baseline));
process.exit(crashes.length || (BASELINE ? codeFails.length : unexplained.length) ? 1 : 0);
