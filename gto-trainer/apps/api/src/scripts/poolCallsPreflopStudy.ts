/**
 * POOL CALLS, THE PREFLOP SIDE — ROUTE A PROTOTYPE (2026-10-07, Brady's Part 3). Where GTO Wizard's AI preflop tree
 * cannot hold the line (an open and two callers before hero, or two limpers — "'C' is not offered"), hero's preflop
 * answer today is read on FITTED lines (gtowAiPreflop.fitAiLines: one caller folded out, the mixes blended to the
 * tightest). A node lock can only change an action the tree OFFERS, and the second caller's node does not exist on the
 * exact tree, so "lock the caller to the pool range" is impossible there. Route A: a REDUCED tree — the earliest caller
 * folded out, his chips as dead money in `pot` — with the kept seats' EARLIER nodes node-locked to the ranges they
 * really hold: the opener's raise to the EXACT tree's own strategy at that node (no dead money), the kept caller's call
 * to the POOL's calling range (services/poolCalls); previous_nodes_lock_type street_all; hero's node read on the child.
 * The old dead-money design was rejected because dead money changed every seat's play from the root (memory
 * reduced-tree-arrival-ranges / dead-money-last-resort-reduced); the locks are meant to remove that distortion. This
 * measures whether they do, and what hero's mix becomes.
 *
 *   powershell: . C:\Users\Brady\poker-wrapper\config\env.ps1
 *     bun src/scripts/poolCallsPreflopStudy.ts --phase scan             # OFFLINE: every spot, today's fitted reads from the cache
 *     bun src/scripts/poolCallsPreflopStudy.ts --phase solve [--ids …]  # LIVE: the reduced tree, its locks, hero's node (Brady's go)
 *     bun src/scripts/poolCallsPreflopStudy.ts --phase report           # OFFLINE: the table
 *
 * Per spot the solve phase reads (requests, roughly, when the exact tree is cached): the reduced tree + solution (2-3),
 * its opener's node and the kept caller's node (2), lock 1 (opener := exact) (1), the caller's node on that child (1),
 * lock 2a (caller := pool) (1) + hero's node (1-3), lock 2b (caller := the EXACT tree's lone-caller range — the
 * dead-money residual alone) (1) + hero's node (1-3), one folded seat's node for the distortion check (1): ~15-18.
 *
 * SAFE BY CONSTRUCTION (the cutoff study's gate): a PRIVATE data root (<data>/root: poker.sqlite and the solve cache
 * copied with VACUUM INTO, the stress-500 cache merged in); every GTO Wizard request goes through one wrapped fetch —
 * scan/report = none at all; solve = one at a time, ≥ --pace-ms (2,000) apart, refused when a poker session is live,
 * when primary's trailing 24 h in the LIVE ledger is at --day-cap (5,000, every origin), when any 429 was logged since
 * this run began, or past --cap (450) of this run's own; a 429 stops the run. Ledger origin "poolCallsStudy".
 */
import { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const PHASE = (arg("phase") ?? "scan") as "scan" | "solve" | "report";
const DATA = (arg("data") ?? "C:/Users/Brady/poker-data-poolcalls").replace(/\\/g, "/");
const LIVE_DIR = "C:/Users/Brady/poker-data";
const STRESS_DIR = "C:/Users/Brady/poker-data-stress500";
const WORK = join(DATA, "root");
const CAP = Number(arg("cap") ?? 450);
const DAY_CAP = Number(arg("day-cap") ?? 5000);
const PACE_MS = Number(arg("pace-ms") ?? 2000);
const IDS = arg("ids")?.split(",").filter(Boolean) ?? null;
const SINCE = arg("since") ?? "2026-10-03";
const startedAt = Date.now();
mkdirSync(WORK, { recursive: true });
const log = (s: string): void => { const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`; console.log(line); try { appendFileSync(join(DATA, "study.log"), line + "\n"); } catch { /* best effort */ } };

// ── the guards (the LIVE ledger, read-only) ─────────────────────────────────────────────────────────────────────
const liveDb = new Database(join(LIVE_DIR, "poker.sqlite"), { readonly: true });
const isLive = (): boolean => ((liveDb.query("select count(*) n from sessions where ended_at is null").get() as { n: number }).n ?? 0) > 0;
const primaryDay = (): number => (liveDb.query("select count(*) n from gtow_requests where s = 'primary' and ts > ?").get(Date.now() - 86_400_000) as { n: number }).n ?? 0;
const wallsSinceStart = (): number => (liveDb.query("select count(*) n from gtow_requests where ts > ? and st = 429").get(startedAt) as { n: number }).n ?? 0;
if (PHASE === "solve" && isLive()) { log("a poker session is LIVE — not starting"); process.exit(2); }

let own = 0, stopped: string | null = null, lastAt = 0;
let queue: Promise<void> = Promise.resolve();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (!/gtowizard\.com/i.test(url)) return realFetch(input, init);
  if (PHASE !== "solve") throw new Error("OFFLINE: cache only");
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const before = queue;
  queue = before.then(() => mine);
  await before;
  try {
    if (stopped) throw new Error(`STUDY STOPPED: ${stopped}`);
    const wait = lastAt + PACE_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    if (isLive()) stopped = "a poker session went live";
    else if (wallsSinceStart() > 0) stopped = "a 429 is in the ledger since this run began";
    else if (own >= CAP) stopped = `this run's cap (${CAP} requests) reached`;
    else { const d = primaryDay(); if (d >= DAY_CAP) stopped = `primary's trailing 24 h is ${d} (cap ${DAY_CAP})`; }
    if (stopped) { log(`STOP: ${stopped}`); throw new Error(`STUDY STOPPED: ${stopped}`); }
    own++; lastAt = Date.now();
    const res = await realFetch(input, init);
    if (res.status === 429) { stopped = "GTO Wizard answered 429"; log(`STOP: 429 from ${url.slice(0, 120)}`); }
    return res;
  } finally { release(); }
}) as typeof fetch;

// ── the private data root ────────────────────────────────────────────────────────────────────────────────────────
const vacuumInto = (from: string, to: string): void => {
  const tmp = `${to}.copying`;
  rmSync(tmp, { force: true });
  const src = new Database(from, { readonly: true });
  try { src.run(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { src.close(); }
  renameSync(tmp, to);
};
if (!existsSync(join(WORK, "poker.sqlite"))) { vacuumInto(join(LIVE_DIR, "poker.sqlite"), join(WORK, "poker.sqlite")); log("private poker.sqlite made"); }
if (!existsSync(join(WORK, "gtow-cache.sqlite"))) {
  vacuumInto(join(LIVE_DIR, "gtow-cache.sqlite"), join(WORK, "gtow-cache.sqlite"));
  const stressCache = join(STRESS_DIR, "root", "gtow-cache.sqlite");
  if (existsSync(stressCache)) {
    const tmp = join(WORK, "stress-cache-copy.sqlite");
    rmSync(tmp, { force: true });
    vacuumInto(stressCache, tmp);
    const db = new Database(join(WORK, "gtow-cache.sqlite"));
    db.run(`ATTACH '${tmp.replace(/'/g, "''")}' AS s`);
    db.run("INSERT OR IGNORE INTO gtow_cache_trees SELECT * FROM s.gtow_cache_trees");
    db.run("INSERT OR IGNORE INTO gtow_cache_nodes SELECT * FROM s.gtow_cache_nodes");
    db.run("DETACH s");
    db.close();
    rmSync(tmp, { force: true });
  }
  log("private gtow-cache.sqlite made (live + stress-500)");
}
for (const f of ["gtow-accounts.json", "wrapper/profiles.json", "api/fx.json", "api/river_mes_config.json"]) {
  const from = join(LIVE_DIR, f);
  if (!existsSync(from)) continue;
  mkdirSync(dirname(join(WORK, f)), { recursive: true });
  copyFileSync(from, join(WORK, f));
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
  GTOW_REQUEST_ORIGIN: "poolCallsStudy", RIVER_MES: "off", GTOW_PREFETCH: "0",
  GTOW_REQUESTS_PATH: PHASE === "solve" ? join(LIVE_DIR, "poker.sqlite") : join(WORK, "poker.sqlite"),
});
delete process.env.GTOW_CACHE;
if (process.env.HRC6MAX_DB) { log(`HRC6MAX_DB is set — must read the live bake; unset it`); process.exit(64); }
if (!process.env.FACTORY_DATA_DIR) { log(`FACTORY_DATA_DIR is not set — load ${ENV_FILE}`); process.exit(64); }

const { normalizeHand } = await import("../feed/normalizeHand/normalizeHand");
const { truncateAt, withStartStacks } = await import("../utils/archivedHand/archivedHand");
const { actorsWithAllins, foldableCallers, foldSeatsOut } = await import("../utils/fitLine/fitLine");
const { poolCallersOf, poolCallKey, poolCallRange } = await import("../services/poolCalls");
const { COMBOS, comboIndex } = await import("../utils/comboIndex/comboIndex");
const G = await import("../services/gtowAiPreflop");
type NodeLock = import("../services/gtowAiPreflop").NodeLock;

// ── the spots: hero's preflop decision on a line the exact tree cannot hold ──────────────────────────────────────
interface Spot {
  id: string; src: "live" | "stress"; handId: string; idx: number; heroPos: string; heroCards: string;
  n: number; stacks: string; line: string; preflopActions: string;
  /** why the tree cannot hold it: "2 callers" / "2 limpers" */
  cap: string;
  /** the seats the reduced tree folds out (the earliest callers, as the fit does) and their chips (dead money) */
  foldOut: string[]; deadBb: number;
  /** the kept caller and his pool key (null: no pool range for his line) */
  kept: string | null; keptKey: string | null; keptFreq: number | null;
  /** today's answer for hero's hand (the stress result / the live answer log) */
  today?: string | null;
  /** the exact tree's reads from the cache: each fit's full-range mix at hero's node (scan) */
  fits?: { folds: string[]; line: string; mix: Record<string, number> }[] | null;
  fitsWhy?: string;
  capConfirmed?: boolean | null;
}
const hands = new Map<string, { hand: any; heroPos: string }>();
const SEATS6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

/** the tree's cap on the tokens BEFORE hero's decision: two non-BB callers of the open, or two non-SB limpers */
function capOf(tokens: string[], who: (string | null)[]): string | null {
  let raises = 0, callers = 0, limps = 0;
  tokens.forEach((t, i) => {
    if (/^R/.test(t)) { raises++; return; }
    if (t !== "C") return;
    if (raises === 0 && who[i] !== "SB") limps++;
    if (raises === 1 && who[i] !== "BB") callers++;
  });
  if (callers >= 2) return `${callers} callers of the open`;
  if (limps >= 2) return `${limps} limpers`;
  return null;
}

function collect(): Spot[] {
  const spots: Spot[] = [];
  const todayOf = new Map<string, string>();
  const add = (src: Spot["src"], id: string, raw: any, today?: (idx: number) => string | null): void => {
    let hand: any;
    try { hand = normalizeHand(raw).hand; } catch { return; }
    const heroPos = String(hand.positions?.[hand.heroSeatId] ?? "");
    if (!heroPos) return;
    const seen = new Set<string>();
    for (let i = 0; i < hand.actions.length; i++) {
      const a = hand.actions[i]!;
      if (!a.hero || a.street !== "preflop" || /^post/.test(a.type)) continue;
      const cut = withStartStacks(truncateAt(hand, i));
      const h = { ...cut, currentNode: { ...cut.currentNode, toActIsHero: true } };
      const sh: any = G.shapeOf(h, heroPos);
      if ("error" in sh) continue;
      const { tokens } = G.lineOf(h, sh);
      const who = actorsWithAllins(tokens, sh.stacks, sh.positions);
      const cap = capOf(tokens, who);
      if (!cap) continue;
      const line = tokens.join("-");
      if (seen.has(line)) continue;
      seen.add(line);
      // the reduced tree's folds: the earliest foldable callers until the tree can hold the rest (its own cap)
      const cands = foldableCallers(tokens, { keep: new Set([sh.heroApiPos].filter(Boolean)), stack: sh.stacks, seats: sh.positions });
      const folds: string[] = [];
      let rest = tokens;
      for (const c of cands) {
        if (!capOf(rest, actorsWithAllins(rest, sh.stacks, sh.positions))) break;
        folds.push(c);
        rest = foldSeatsOut(tokens, folds, sh.stacks, sh.positions);
      }
      const handPosOf: Record<string, string> = {};
      for (const [hp, ap] of Object.entries(sh.apiOf as Record<string, string>)) handPosOf[ap] = hp;
      const foldOut = folds.map((f) => handPosOf[f] ?? f);
      const deadBb = foldOut.reduce((t, p) => t + chipsIn(h, p), 0);
      // the kept caller: the last villain caller of the line not folded out, with his pool key
      const callers = poolCallersOf(h, heroPos).filter((c) => !foldOut.includes(c.pos) && !c.raisedLater);
      const kept = callers.length ? callers[callers.length - 1]! : null;
      const dealt = dealtOf(h);
      const key = kept ? poolCallKey(kept, Number(dealt[kept.pos] ?? NaN)) : null;
      const sid = `${src}:${id}:${i}`;
      hands.set(sid, { hand: h, heroPos });
      spots.push({
        id: sid, src, handId: id, idx: i, heroPos, heroCards: (hand.heroCards ?? []).join(""), n: sh.n,
        stacks: sh.positions.map((p: string) => `${p}:${sh.stacks[p]}`).join("/"), line, cap,
        preflopActions: h.actions.filter((x: any) => x.street === "preflop" && !/^post/.test(x.type)).map((x: any) => `${h.positions[x.seatId]}:${x.type}${x.amount ? ` ${x.amount}` : ""}`).join(", "),
        foldOut, deadBb: Math.round(deadBb * 100) / 100, kept: kept?.pos ?? null, keptKey: key?.key ?? null,
        keptFreq: key ? poolCallRange(key)?.freq ?? null : null, today: today?.(i) ?? null,
      });
    }
  };
  const db = new Database(join(WORK, "poker.sqlite"), { readonly: true });
  const since = Date.parse(`${SINCE}T00:00:00+07:00`);
  for (const r of db.query("select client_hand_id h, street, decision_key k, text from answers where ts >= ? and street = 'preflop' and text is not null").all(since) as any[]) {
    try { const k = JSON.parse(r.k); todayOf.set(`${r.h}:${k[4]}`, String(r.text).slice(0, 80)); } catch { /* skip */ }
  }
  for (const r of db.query("select client_hand_id h, data from hands where rowid in (select max(rowid) from hands where played_at >= ? group by client_hand_id)").all(since) as { h: string; data: string }[]) {
    try { add("live", r.h, JSON.parse(r.data), (i) => todayOf.get(`${r.h}:${i}`) ?? null); } catch { /* unreadable */ }
  }
  db.close();
  const set = JSON.parse(readFileSync(join(STRESS_DIR, "scenarios.json"), "utf8")) as { scenarios: any[] };
  const WANT = /^(brief_I|pf_chaos|po_56way|po_4way|pf_limp|pf_srp)/;
  for (const sc of set.scenarios) {
    if (!WANT.test(sc.id)) continue;
    const res = join(STRESS_DIR, "hands", `${sc.id}.json`);
    let today: ((i: number) => string | null) | undefined;
    if (existsSync(res)) {
      try {
        const d = JSON.parse(readFileSync(res, "utf8"));
        today = (i) => { const x = (d.decisions ?? []).find((q: any) => q.index === i); return x ? `${x.heroClass ?? ""} ${(x.actions ?? []).map((a: any) => `${a.action} ${a.frequency}%`).join(" / ")}` : null; };
      } catch { /* none */ }
    }
    add("stress", sc.id, sc.raw, today);
  }
  return spots;
}
function dealtOf(h: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [seat, pos] of Object.entries(h.positions ?? {})) { const v = h.startStacks?.[Number(seat)] ?? h.stacks?.[Number(seat)]; if (v != null) out[String(pos).toUpperCase()] = Number(v); }
  return out;
}
/** a seat's chips in the preflop pot (posts + calls, raise-to totals) — the dead money when he is folded out */
function chipsIn(h: any, pos: string): number {
  let put = 0;
  for (const a of h.actions ?? []) {
    if (a.street !== "preflop") continue;
    const p = String(h.positions?.[a.seatId] ?? "").toUpperCase();
    if (p !== pos.toUpperCase()) continue;
    const amt = Number(a.amount ?? 0);
    if (a.type === "post-sb" || a.type === "post-bb" || a.type === "post" || a.type === "raise" || a.type === "bet" || a.type === "all-in") put = Math.max(put, amt);
    else if (a.type === "call") put += amt;
  }
  return put;
}
/** the reduced hand: each folded seat's first call becomes a fold, his later preflop actions go */
function reducedHand(h: any, foldOut: string[]): any {
  const out = new Set(foldOut.map((p) => p.toUpperCase()));
  const folded = new Set<number>();
  const actions: any[] = [];
  for (const a of h.actions ?? []) {
    if (a.street !== "preflop") { actions.push(a); continue; }
    const p = String(h.positions?.[a.seatId] ?? "").toUpperCase();
    if (!out.has(p) || /^post/.test(a.type)) { actions.push(a); continue; }
    if (folded.has(a.seatId)) continue;
    folded.add(a.seatId);
    actions.push({ ...a, type: "fold", amount: undefined });
  }
  return { ...h, actions };
}

// ── node views ───────────────────────────────────────────────────────────────────────────────────────────────────
function view(data: any) {
  const sols = (data?.action_solutions ?? []) as any[];
  const actor: string | null = data?.game?.players?.find((p: any) => p.is_hero)?.position ?? null;
  const pi = (data?.players_info ?? []) as any[];
  const range: number[] = (pi.find((p) => p?.player?.position === actor)?.range ?? []).map(Number);
  return {
    actor, codes: sols.map((a) => String(a.action.code)),
    labels: sols.map((a) => `${a.action.type}${a.action.betsize && a.action.betsize !== "0" ? ` ${a.action.betsize}` : ""}`),
    freq: sols.map((a) => Number(a.total_frequency ?? 0)),
    strat: sols.map((a) => (a.strategy ?? []).map(Number) as number[]),
    sols, range,
    combosOf: (pos: string) => { const r = pi.find((p) => p?.player?.position === pos)?.range ?? []; return r.reduce((t: number, x: any) => t + Number(x), 0); },
  };
}
type V = ReturnType<typeof view>;
const mixOf = (v: V): Record<string, number> => Object.fromEntries(v.labels.map((l, a) => [l, Math.round(1000 * v.freq[a]!) / 10]));
/** total variation between two nodes' strategies over `range` (0-100) */
function tv(a: V, b: V, range: number[]): number {
  let t = 0, w = 0;
  const codes = new Set([...a.codes, ...b.codes]);
  for (let i = 0; i < 1326; i++) {
    const r = range[i] ?? 0; if (!(r > 0)) continue;
    let d = 0;
    for (const c of codes) { const x = a.codes.indexOf(c), y = b.codes.indexOf(c); d += Math.abs((x >= 0 ? a.strat[x]![i]! : 0) - (y >= 0 ? b.strat[y]![i]! : 0)); }
    t += r * d / 2; w += r;
  }
  return w > 0 ? Math.round(1000 * t / w) / 10 : NaN;
}
/** a lock that gives a node another node's strategy, action by action (a code the target lacks gets 0; renormalised) */
function lockAs(line: string, target: V, source: V): NodeLock {
  const strategy = target.codes.map((code) => {
    const j = source.codes.indexOf(code);
    return { action: code, strategy: j >= 0 ? source.strat[j]!.slice() : new Array<number>(1326).fill(0) };
  });
  for (let i = 0; i < 1326; i++) {
    const s = strategy.reduce((t, x) => t + x.strategy[i]!, 0);
    if (s > 1e-9) for (const x of strategy) x.strategy[i] = x.strategy[i]! / s;
    else { const f = strategy.findIndex((x) => /^F/i.test(x.action)); strategy[f >= 0 ? f : 0]!.strategy[i] = 1; }
  }
  return { action_history: [line], strategy, hands_locked: new Array<boolean>(1326).fill(true), previous_nodes_lock_type: "street_all" };
}
const weightsOf = (key: ReturnType<typeof poolCallKey>): number[] | null => {
  if (!key) return null;
  const r = poolCallRange(key);
  if (!r) return null;
  return COMBOS.map((c) => Math.max(0, Math.min(1, Number(r.weights[c.cls] ?? 0))));
};

// ── the exact tree: the cap confirmed, and today's fitted reads (from the cache in the scan) ────────────────────
async function exactReads(s: Spot): Promise<{ parent: string; shape: any; tokens: string[]; fits: NonNullable<Spot["fits"]>; capConfirmed: boolean } | { error: string }> {
  const { hand, heroPos } = hands.get(s.id)!;
  const shape: any = G.shapeOf(hand, heroPos);
  if ("error" in shape) return { error: shape.error };
  const { tokens, levels, iso } = G.lineOf(hand, shape);
  const m = G.menus(levels, shape.n, iso);
  const dbg: any = G.debugTree(hand, heroPos);
  if ("error" in dbg) return { error: dbg.error };
  const parent = await G.poolLockSeams.solve(G.treeKeyOf(shape, m), dbg.body, { multiway: shape.n > 2, preflop: true });
  if ("error" in parent) return { error: `exact tree: ${parent.error}` };
  const rep = await G.poolLockSeams.repair(parent.solId, tokens);
  const capConfirmed = "error" in rep ? /is not offered/.test(rep.error) : false;
  const fits: NonNullable<Spot["fits"]> = [];
  const cands = foldableCallers(tokens, { keep: new Set([shape.heroApiPos].filter(Boolean)), stack: shape.stacks, seats: shape.positions });
  for (const f of cands) {
    const cut = foldSeatsOut(tokens, [f], shape.stacks, shape.positions);
    const r = await G.poolLockSeams.repair(parent.solId, cut);
    if ("error" in r) continue;
    const n = await G.poolLockSeams.node(parent.solId, r.line);
    if ("error" in n) continue;
    const v = view(n.data);
    if (v.actor !== shape.heroApiPos) continue;
    fits.push({ folds: [f], line: r.line, mix: mixOf(v) });
  }
  return { parent: parent.solId, shape, tokens, fits, capConfirmed };
}

const outFile = join(DATA, "spots.json");
const prev: Spot[] = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")).spots ?? [] : [];
const spots = collect();
for (const s of spots) { const p = prev.find((x) => x.id === s.id); if (p) Object.assign(s, { fits: p.fits, fitsWhy: p.fitsWhy, capConfirmed: p.capConfirmed }); }
const save = (): void => writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), spots }, null, 1));
log(`${spots.length} spots where the exact tree cannot hold the line before hero's decision: live ${spots.filter((s) => s.src === "live").length}, stress ${spots.filter((s) => s.src === "stress").length}`);

if (PHASE === "scan") {
  for (const s of spots) {
    if (IDS && !IDS.includes(s.id)) continue;
    const r = await exactReads(s).catch((e) => ({ error: String(e) }));
    if ("error" in r) { s.fits = null; s.fitsWhy = r.error.slice(0, 160); s.capConfirmed = null; }
    else { s.fits = r.fits; s.fitsWhy = undefined; s.capConfirmed = r.capConfirmed; }
    log(`${s.id.padEnd(30)} ${s.heroPos} ${s.heroCards.padEnd(4)} ${s.line.padEnd(22)} ${s.cap.padEnd(22)} fold ${s.foldOut.join("+").padEnd(7)} dead ${String(s.deadBb).padEnd(5)} kept ${s.kept ?? "-"}:${s.keptKey ?? "no key"}` +
      ` · cap ${s.capConfirmed == null ? "?" : s.capConfirmed ? "yes" : "NO"} · fits ${s.fits ? s.fits.map((f) => `${f.folds.join("+")}: ${Object.entries(f.mix).map(([k, v]) => `${k} ${v}`).join("/")}`).join(" | ") : `n/a (${s.fitsWhy})`}` +
      ` · today ${s.today ?? "-"}`);
    save();
  }
  save();
  const ready = spots.filter((s) => s.keptKey && s.capConfirmed !== false);
  log(`scan done. ${ready.length} spots have a pool key for the kept caller (solve candidates); ~17 requests each ≈ ${17 * ready.length} for all, cap ${CAP}/run`);
  process.exit(0);
}

const resFile = join(DATA, arg("tag") ? `solved-${arg("tag")}.json` : "solved.json");
const solved: Record<string, any> = existsSync(resFile) ? JSON.parse(readFileSync(resFile, "utf8")) : {};

if (PHASE === "report") {
  const line = (s: string) => console.log(s);
  line(`POOL CALLS PREFLOP STUDY (route A) · ${spots.length} spots · solved ${Object.values(solved).filter((x: any) => x.ok).length}`);
  for (const s of spots) {
    const r = solved[s.id];
    line(`\n${s.id} · ${s.heroPos} ${s.heroCards} · ${s.line} · ${s.stacks} · ${s.cap}; reduced: ${s.foldOut.join("+")} folded, ${s.deadBb}bb dead; kept ${s.kept ?? "-"} → ${s.keptKey ?? "no key"}${s.keptFreq != null ? ` (${(100 * s.keptFreq).toFixed(1)}%)` : ""}`);
    line(`  today (hero's hand): ${s.today ?? "-"}`);
    for (const f of s.fits ?? []) line(`  fitted, ${f.folds.join("+")} folded, full range: ${Object.entries(f.mix).map(([k, v]) => `${k} ${v}%`).join(" / ")}`);
    if (!r) { line("  not solved"); continue; }
    if (!r.ok) { line(`  solve failed: ${r.why}`); continue; }
    const fmt = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}%`).join(" / ");
    line(`  reduced UNLOCKED:                 ${fmt(r.mixUnlocked)}   (opener's root vs exact: TV ${r.openerTvUnlocked}% · caller's node vs exact lone-caller: TV ${r.callerTvUnlocked}%)`);
    line(`  reduced, opener locked, caller := EXACT lone-caller range: ${fmt(r.mixGtoCaller)}   ← the dead-money residual alone`);
    line(`  reduced, opener locked, caller := POOL ${s.keptKey}: ${fmt(r.mixPool)}   ← route A`);
    line(`  hero's hand ${s.heroCards}: unlocked ${fmt(r.handUnlocked ?? {})} · GTO caller ${fmt(r.handGto ?? {})} · pool ${fmt(r.handPool ?? {})}`);
    line(`  TV over hero's range: unlocked vs GTO-caller ${r.tvUnlockedVsGto}% · GTO-caller vs pool ${r.tvGtoVsPool}% · pool vs best fit ${r.tvPoolVsFit}%${r.folderTv != null ? ` · ${r.folderSeat}'s fold node, reduced vs exact: TV ${r.folderTv}% (unlocked) / ${r.folderTvLocked}% (locked)` : ""}`);
    line(`  caller combos: exact lone-caller ${r.callerCombosExact} · reduced unlocked ${r.callerCombosUnlocked} · pool ${r.callerCombosPool} · requests ${r.req}`);
  }
  process.exit(0);
}

// ── solve: the reduced tree, its locks, hero's node ──────────────────────────────────────────────────────────────
for (const s of spots) {
  if (IDS ? !IDS.includes(s.id) : !s.keptKey) continue;
  if (solved[s.id]?.ok) continue;
  if (stopped) break;
  const r0 = own;
  const fail = (why: string) => { solved[s.id] = { ok: false, why, req: own - r0 }; log(`${s.id}: ${why}`); writeFileSync(resFile, JSON.stringify(solved, null, 1)); };
  const { hand, heroPos } = hands.get(s.id)!;
  const ex = await exactReads(s).catch((e) => ({ error: String(e) }));
  if ("error" in ex) { fail(`exact: ${ex.error}`); continue; }
  s.fits = ex.fits; s.capConfirmed = ex.capConfirmed;
  if (!ex.capConfirmed) { fail("the exact tree holds the line after all — nothing to reduce"); continue; }
  // the reduced tree: the folded seats' chips in the pot
  const red = reducedHand(hand, s.foldOut);
  const rshape: any = G.shapeOf(red, heroPos, s.deadBb);
  if ("error" in rshape) { fail(`reduced shape: ${rshape.error}`); continue; }
  const { tokens: rtok, levels: rlev, iso: riso } = G.lineOf(red, rshape);
  const rm = G.menus(rlev, rshape.n, riso);
  const rdbg: any = G.debugTree(red, heroPos);
  const rbody = { ...rdbg.body, pot: rshape.deadBb };
  const rsol = await G.poolLockSeams.solve(G.treeKeyOf(rshape, rm), rbody, { multiway: rshape.n > 2, preflop: true });
  if ("error" in rsol) { fail(`reduced tree: ${rsol.error}`); continue; }
  const rrep = await G.poolLockSeams.repair(rsol.solId, rtok);
  if ("error" in rrep) { fail(`reduced line: ${rrep.error}`); continue; }
  const rcodes = rrep.line.split("-").filter(Boolean);
  // the opener's node (the first raise) and the kept caller's node (his call) on the reduced line
  const openerAt = rcodes.findIndex((c) => /^R/.test(c));
  const keptApi = s.kept ? rshape.apiOf[s.kept] : null;
  let callerAt = -1;
  const rwho = actorsWithAllins(rcodes, rshape.stacks, rshape.positions);
  rcodes.forEach((c, i) => { if (c === "C" && rwho[i] === keptApi) callerAt = i; });
  if (openerAt < 0 || callerAt < 0) { fail(`no opener/caller node on the reduced line '${rrep.line}' (opener ${openerAt}, caller ${callerAt})`); continue; }
  const openerLine = rcodes.slice(0, openerAt).join("-"), callerLine = rcodes.slice(0, callerAt).join("-");
  const [exOpener, rOpener, rCaller, rHero] = await Promise.all([
    G.poolLockSeams.node(ex.parent, openerLine), G.poolLockSeams.node(rsol.solId, openerLine), G.poolLockSeams.node(rsol.solId, callerLine), G.poolLockSeams.node(rsol.solId, rrep.line),
  ]);
  if ("error" in exOpener || "error" in rOpener || "error" in rCaller || "error" in rHero) { fail(`nodes: ${[exOpener, rOpener, rCaller, rHero].map((x) => ("error" in x ? x.error : "ok")).join(" | ")}`); continue; }
  const EO = view(exOpener.data), RO = view(rOpener.data), RC = view(rCaller.data), RH = view(rHero.data);
  // the exact tree's LONE-caller node for the kept seat (the same line without the folded seats' calls: the fitted line)
  const exFit = await G.poolLockSeams.repair(ex.parent, foldSeatsOut(ex.tokens, s.foldOut.map((p) => ex.shape.apiOf[p] ?? p), ex.shape.stacks, ex.shape.positions));
  const exCallerNode = "error" in exFit ? null : await G.poolLockSeams.node(ex.parent, exFit.line.split("-").slice(0, callerAt).join("-"));
  const EC = exCallerNode && !("error" in exCallerNode) ? view(exCallerNode.data) : null;
  // lock 1: the opener's node := the exact tree's
  const l1 = lockAs(openerLine, RO, EO);
  const c1 = await G.poolLockSeams.lock(rsol.solId, rbody, [l1]);
  if ("error" in c1) { fail(`lock 1: ${c1.error}`); continue; }
  const c1Caller = await G.poolLockSeams.node(c1.solId, callerLine);
  if ("error" in c1Caller) { fail(`caller's node on the opener-locked child: ${c1Caller.error}`); continue; }
  const C1 = view(c1Caller.data);
  const callCode = C1.codes.find((c) => /^C/i.test(c)) ?? "C";
  // lock 2a: the caller := the pool range; 2b: the caller := the exact tree's lone-caller call strategy
  const w = weightsOf(poolCallKey(poolCallersOf(hand, heroPos).find((c) => c.pos === s.kept)!, Number(dealtOf(hand)[s.kept!] ?? NaN)));
  if (!w) { fail("no pool weights for the kept caller"); continue; }
  const l2a = G.poolLimpLockOf(callerLine, C1.sols, callCode, w);
  const c2a = await G.poolLockSeams.lock(rsol.solId, rbody, [l1, l2a]);
  if ("error" in c2a) { fail(`lock 2a: ${c2a.error}`); continue; }
  const h2a = await G.poolLockSeams.node(c2a.solId, rrep.line);
  if ("error" in h2a) { fail(`hero's node (pool): ${h2a.error}`); continue; }
  const HP = view(h2a.data);
  let HG: V | null = null;
  if (EC) {
    const l2b = lockAs(callerLine, C1, EC);
    const c2b = await G.poolLockSeams.lock(rsol.solId, rbody, [l1, l2b]);
    if (!("error" in c2b)) { const h2b = await G.poolLockSeams.node(c2b.solId, rrep.line); if (!("error" in h2b)) HG = view(h2b.data); }
  }
  // the distortion check on an unlocked node both trees hold: the first folder after the open (dead money moves him)
  let folderSeat: string | null = null, folderTv: number | null = null, folderTvLocked: number | null = null;
  const fIdx = rcodes.findIndex((c, i) => i > openerAt && c === "F");
  if (fIdx > 0) {
    const fl = rcodes.slice(0, fIdx).join("-");
    const [ef, rf, lf] = await Promise.all([G.poolLockSeams.node(ex.parent, fl), G.poolLockSeams.node(rsol.solId, fl), G.poolLockSeams.node(c2a.solId, fl)]);
    if (!("error" in ef) && !("error" in rf)) { const E = view(ef.data), R = view(rf.data); folderSeat = E.actor; folderTv = tv(E, R, E.range.length === 1326 ? E.range : new Array(1326).fill(1)); if (!("error" in lf)) folderTvLocked = tv(E, view(lf.data), E.range.length === 1326 ? E.range : new Array(1326).fill(1)); }
  }
  const hi = (() => { try { const c = (hand.heroCards ?? []) as string[]; return c.length === 2 ? comboIndex(c[0]!, c[1]!) : null; } catch { return null; } })();
  const handMix = (v: V | null) => (!v || hi == null) ? null : Object.fromEntries(v.codes.map((c, a) => [v.labels[a], Math.round(1000 * (v.strat[a]![hi] ?? 0)) / 10]));
  const range = HP.range.length === 1326 ? HP.range : new Array<number>(1326).fill(1);
  const bestFit = s.fits?.[0] ?? null;
  const fitV: V | null = bestFit ? await (async () => { const n = await G.poolLockSeams.node(ex.parent, bestFit.line); return "error" in n ? null : view(n.data); })() : null;
  solved[s.id] = {
    ok: true, req: own - r0, line: s.line, reducedLine: rrep.line, deadBb: s.deadBb, foldOut: s.foldOut, kept: s.kept, keptKey: s.keptKey,
    mixUnlocked: mixOf(RH), mixGtoCaller: HG ? mixOf(HG) : null, mixPool: mixOf(HP),
    handUnlocked: handMix(RH), handGto: handMix(HG), handPool: handMix(HP),
    openerTvUnlocked: tv(EO, RO, new Array(1326).fill(1)), callerTvUnlocked: EC ? tv(EC, RC, EC.range.length === 1326 ? EC.range : new Array(1326).fill(1)) : null,
    tvUnlockedVsGto: HG ? tv(RH, HG, range) : null, tvGtoVsPool: HG ? tv(HG, HP, range) : null, tvPoolVsFit: fitV ? tv(HP, fitV, range) : null,
    folderSeat, folderTv, folderTvLocked,
    callerCombosExact: EC && keptApi ? Math.round(EC.combosOf(keptApi) * 10) / 10 : null, callerCombosUnlocked: keptApi ? Math.round(RH.combosOf(keptApi) * 10) / 10 : null,
    callerCombosPool: keptApi ? Math.round(HP.combosOf(keptApi) * 10) / 10 : null,
  };
  log(`${s.id}: pool ${JSON.stringify(solved[s.id].mixPool)} · GTO caller ${JSON.stringify(solved[s.id].mixGtoCaller)} · unlocked ${JSON.stringify(solved[s.id].mixUnlocked)} · req ${own - r0} (run ${own}, primary 24 h ${primaryDay()})`);
  writeFileSync(resFile, JSON.stringify(solved, null, 1));
  save();
}
log(`done (${own} requests)`);
process.exit(0);
