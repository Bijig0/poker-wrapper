/**
 * THE COLD-CALL LOCK CUTOFF STUDY (2026-10-05, Brady: "Idk about the cutoff number, is 1% ok? Should we do research?").
 * The live trigger (gtowAiPreflop.solvePreflopColdCallLocked): a lone villain cold-called a 3-bet, the charts could not
 * hold the line, and the exact GTO Wizard AI tree gives his call under COLD_CALL_LOCK_BELOW (1%) of his range → his call
 * is node-locked to the pool range. This measures where real spots fall and how much hero's answer moves.
 *
 *   powershell: . C:\Users\Brady\poker-wrapper\config\env.ps1
 *     bun src/scripts/coldCallCutoffStudy.ts --phase scan            # offline: every spot, GTO's share from the cache
 *     bun src/scripts/coldCallCutoffStudy.ts --phase share [--ids …]  # live: GTO's share where the cache has no tree
 *     bun src/scripts/coldCallCutoffStudy.ts --phase solve [--ids …]  # live: hero unlocked vs locked
 *
 * SAFE BY CONSTRUCTION:
 *   - PRIVATE DATA ROOT (<data>/root): poker.sqlite and the live GTO Wizard solve cache copied with VACUUM INTO (the
 *     stress-500 cache merged in); hand facts / answers in memory; nothing of the live archive is written.
 *   - EVERY GTO WIZARD REQUEST GOES THROUGH ONE GATE (globalThis.fetch is wrapped): scan = none at all (cache only);
 *     share/solve = one at a time, ≥ --pace-ms (2,000) apart, refused when a poker session is live, when primary's
 *     trailing 24 h in the LIVE ledger is at --day-cap (5,500, every origin counts), when any 429 was logged since this
 *     run began, or past --cap (400) of this run's own. A 429 stops the run. Ledger origin "cutoffStudy".
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const PHASE = (arg("phase") ?? "scan") as "scan" | "share" | "solve";
const DATA = (arg("data") ?? "C:/Users/Brady/poker-data-cutoff").replace(/\\/g, "/");
const LIVE_DIR = "C:/Users/Brady/poker-data";
const STRESS_DIR = "C:/Users/Brady/poker-data-stress500";
const WORK = join(DATA, "root");
const CAP = Number(arg("cap") ?? 400);
const DAY_CAP = Number(arg("day-cap") ?? 5500);
const PACE_MS = Number(arg("pace-ms") ?? 2000);
const IDS = arg("ids")?.split(",").filter(Boolean) ?? null;
const startedAt = Date.now();
mkdirSync(WORK, { recursive: true });
const log = (s: string): void => { const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`; console.log(line); try { require("node:fs").appendFileSync(join(DATA, "study.log"), line + "\n"); } catch { /* best effort */ } };

// ── the guards (the LIVE ledger, read-only) ─────────────────────────────────────────────────────────────────────
const liveDb = new Database(join(LIVE_DIR, "poker.sqlite"), { readonly: true });
const isLive = (): boolean => ((liveDb.query("select count(*) n from sessions where ended_at is null").get() as { n: number }).n ?? 0) > 0;
const primaryDay = (): number => (liveDb.query("select count(*) n from gtow_requests where s = 'primary' and ts > ?").get(Date.now() - 86_400_000) as { n: number }).n ?? 0;
const wallsSinceStart = (): number => (liveDb.query("select count(*) n from gtow_requests where ts > ? and st = 429").get(startedAt) as { n: number }).n ?? 0;
if (PHASE !== "scan" && isLive()) { log("a poker session is LIVE — not starting"); process.exit(2); }

let own = 0, stopped: string | null = null, lastAt = 0;
let queue: Promise<void> = Promise.resolve();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (!/gtowizard\.com/i.test(url)) return realFetch(input, init);
  if (PHASE === "scan") throw new Error("OFFLINE SCAN: cache only");
  // one at a time, paced
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
  GTOW_REQUEST_ORIGIN: "cutoffStudy", RIVER_MES: "off", GTOW_PREFETCH: "0",
  // scan: the private copy takes the ledger rows (nothing is sent anyway); share/solve: the LIVE ledger, so its meters see us
  GTOW_REQUESTS_PATH: PHASE === "scan" ? join(WORK, "poker.sqlite") : join(LIVE_DIR, "poker.sqlite"),
});
delete process.env.GTOW_CACHE;
if (process.env.HRC6MAX_DB) { log(`HRC6MAX_DB is set — must read the live bake; unset it`); process.exit(64); }
if (!process.env.FACTORY_DATA_DIR) { log(`FACTORY_DATA_DIR is not set — load ${ENV_FILE}`); process.exit(64); }

const { normalizeHand } = await import("../feed/normalizeHand/normalizeHand");
const { truncateAt, withStartStacks } = await import("../utils/archivedHand/archivedHand");
const { coldCallLockTarget, coldCallRange, coldCallersOf, coldCallLockBelow } = await import("../services/poolColdCall");
const G = await import("../services/gtowAiPreflop");
const { comboIndex } = await import("../utils/comboIndex/comboIndex");

// ── the spots ────────────────────────────────────────────────────────────────────────────────────────────────────
interface Spot {
  id: string; src: "live" | "stress" | "synth"; handId: string; idx: number; heroPos: string; heroCards: string;
  line: string; caller: string; callerStack: number; key: string; size?: string | null; poolFreq: number; lockBelow?: number;
  n: number; stacks: string; preflopActions: string;
  share?: number | null; shareWhy?: string; callerLine?: string; chart?: string | null;
}
const hands = new Map<string, any>();
function collect(): { spots: Spot[]; other: Record<string, number> } {
  const spots: Spot[] = [];
  const other: Record<string, number> = {};
  const add = (src: Spot["src"], id: string, raw: any): void => {
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
      const { callers } = coldCallersOf(h, heroPos);
      if (!callers.length) continue;
      const t = coldCallLockTarget({ hand: h, heroPos });
      if (!t.ok) { other[t.why.replace(/^\d+ /, "N ")] = (other[t.why.replace(/^\d+ /, "N ")] ?? 0) + 1; continue; }
      const line = (() => { try { const sh = G.shapeOf(h, heroPos); return "error" in sh ? "?" : G.lineOf(h, sh).tokens.join("-"); } catch { return "?"; } })();
      if (seen.has(line)) continue;
      seen.add(line);
      const sh: any = G.shapeOf(h, heroPos);
      const sid = `${src}:${id}:${i}`;
      hands.set(sid, { hand: h, heroPos });
      spots.push({
        id: sid, src, handId: id, idx: i, heroPos, heroCards: (hand.heroCards ?? []).join(""), line,
        caller: t.target.pos, callerStack: t.target.stack, key: t.target.key, size: (t.target as any).size ?? null,
        poolFreq: coldCallRange(t.target.key).freq, lockBelow: coldCallLockBelow(t.target.key),
        n: "error" in sh ? 0 : sh.n, stacks: "error" in sh ? "" : sh.positions.map((p: string) => `${p}:${sh.stacks[p]}`).join("/"),
        preflopActions: h.actions.filter((x: any) => x.street === "preflop" && !/^post/.test(x.type)).map((x: any) => `${h.positions[x.seatId]}:${x.type}${x.amount ? ` ${x.amount}` : ""}`).join(", "),
      });
    }
  };
  const db = new Database(join(WORK, "poker.sqlite"), { readonly: true });
  for (const r of db.query("select client_hand_id h, data from hands where rowid in (select max(rowid) from hands group by client_hand_id)").all() as { h: string; data: string }[]) {
    try { add("live", r.h, JSON.parse(r.data)); } catch { /* unreadable */ }
  }
  db.close();
  const set = JSON.parse(readFileSync(join(STRESS_DIR, "scenarios.json"), "utf8")) as { scenarios: any[] };
  for (const sc of set.scenarios) add("stress", sc.id, sc.raw);
  // synthetic variants of real spots (a stack or a 3-bet size changed), <data>/synth.json: [{ id, from, raw }]
  const synth = join(DATA, "synth.json");
  if (existsSync(synth)) for (const x of JSON.parse(readFileSync(synth, "utf8")) as { id: string; raw: any }[]) add("synth", x.id, x.raw);
  return { spots, other };
}

// ── GTO's share at the caller's node (the product's own loop, solvePreflopColdCallLocked) ───────────────────────────
interface ShareRead { share: number; callerLine: string; parent: string; heroLine: string; callCombos: number }
async function readShare(s: Spot): Promise<ShareRead | { error: string }> {
  const { hand, heroPos } = hands.get(s.id)!;
  const shape: any = G.shapeOf(hand, heroPos);
  if ("error" in shape) return { error: shape.error };
  const { tokens, levels, iso } = G.lineOf(hand, shape);
  const m = G.menus(levels, shape.n, iso);
  const dbg: any = G.debugTree(hand, heroPos);
  if ("error" in dbg) return { error: dbg.error };
  const parent = await G.poolLockSeams.solve(G.treeKeyOf(shape, m), dbg.body, { multiway: shape.n > 2, preflop: true });
  if ("error" in parent) return { error: `tree: ${parent.error}` };
  const rep = await G.poolLockSeams.repair(parent.solId, tokens);
  if ("error" in rep) return { error: `repair: ${rep.error}` };
  const codes = rep.line.split("-").filter(Boolean);
  const api = shape.apiOf[s.caller];
  let raises = 0;
  for (let k = 0; k < codes.length; k++) {
    const tok = codes[k]!;
    if (/^R/i.test(tok)) { raises++; continue; }
    if (tok !== "C" || raises !== 2) continue;
    const prefix = codes.slice(0, k).join("-");
    const n = await G.poolLockSeams.node(parent.solId, prefix);
    if ("error" in n) return { error: `node '${prefix}': ${n.error}` };
    if (n.data?.game?.players?.find((p: any) => p.is_hero)?.position !== api) continue;
    const call = (n.data?.action_solutions ?? []).find((a: any) => /^C/i.test(String(a?.action?.code ?? "")));
    if (!call) return { error: `no call at '${prefix}'` };
    return { share: Number(call.total_frequency ?? 0), callerLine: prefix, parent: parent.solId, heroLine: rep.line, callCombos: Number(call.total_combos ?? NaN) };
  }
  return { error: `no cold-call by the ${s.caller} on '${rep.line}'` };
}

// ── hero's node, unlocked vs locked ──────────────────────────────────────────────────────────────────────────────
function heroView(data: any, heroApi: string, callerApi: string) {
  const sols = (data?.action_solutions ?? []) as any[];
  const pi = (data?.players_info ?? []) as any[];
  const heroInfo = pi.find((p) => p?.player?.position === heroApi) ?? pi.find((p) => p?.player?.is_hero);
  const callerInfo = pi.find((p) => p?.player?.position === callerApi);
  const range: number[] = (heroInfo?.range ?? []).map(Number);
  const sum = (a: number[]) => a.reduce((t, x) => t + x, 0);
  return {
    codes: sols.map((a) => String(a.action.code)),
    labels: sols.map((a) => `${a.action.type}${a.action.betsize && a.action.betsize !== "0" ? ` ${a.action.betsize}` : ""}`),
    freq: sols.map((a) => Number(a.total_frequency ?? 0)),
    strat: sols.map((a) => (a.strategy ?? []).map(Number) as number[]),
    evs: sols.map((a) => (a.evs ?? []).map(Number) as number[]),
    range, heroCombos: sum(range), callerCombos: callerInfo ? sum((callerInfo.range ?? []).map(Number)) : NaN,
  };
}
type HV = ReturnType<typeof heroView>;
/** hero's range-weighted EV at the node of strategy `st` (per code), with the action EVs of `ev` */
function evOf(st: HV, ev: HV, range: number[]): number {
  let t = 0, w = 0;
  for (let i = 0; i < 1326; i++) {
    const r = range[i] ?? 0;
    if (!(r > 0)) continue;
    let e = 0;
    for (let a = 0; a < ev.codes.length; a++) {
      const j = st.codes.indexOf(ev.codes[a]!);
      const p = j >= 0 ? st.strat[j]![i] ?? 0 : 0;
      e += p * (ev.evs[a]![i] ?? 0);
    }
    t += r * e; w += r;
  }
  return w > 0 ? t / w : NaN;
}

const outFile = join(DATA, "spots.json");
const prev: Spot[] = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")).spots ?? [] : [];
const { spots, other } = collect();
for (const s of spots) { const p = prev.find((x) => x.id === s.id); if (p) Object.assign(s, { share: p.share, shareWhy: p.shareWhy, callerLine: p.callerLine, chart: p.chart }); }
log(`${spots.length} lone 3-bet cold-call spots (hero to act after the call): live ${spots.filter((s) => s.src === "live").length}, stress ${spots.filter((s) => s.src === "stress").length}; not a lock target: ${JSON.stringify(other)}`);
const save = (): void => writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), other, spots }, null, 1));

if (PHASE === "scan" || PHASE === "share") {
  const { fastSolve, forgetPreflopPin } = await import("../services/fastSolve");
  const { preflopPinKey } = await import("../services/preflopPin");
  for (const s of spots) {
    if (IDS && !IDS.includes(s.id)) continue;
    if (PHASE === "share" && s.share != null) continue;
    if (stopped) break;
    const r = await readShare(s).catch((e) => ({ error: String(e) }));
    if ("error" in r) { if (PHASE === "scan" || s.share == null) { s.share = null; s.shareWhy = r.error.slice(0, 200); } }
    else { s.share = r.share; s.callerLine = r.callerLine; s.shareWhy = undefined; }
    if (PHASE === "scan" && s.chart === undefined) {
      // would the charts hold the line? (the lock stands only when GTO Wizard AI answered) — offline, the lock switched off
      process.env.COLD_CALL_POOL = "off";
      const { hand, heroPos } = hands.get(s.id)!;
      try { const a: any = await fastSolve(hand, heroPos, { heroPos, strategyId: "ign200-ring-6max-equilibrium", origin: "stress" } as any); s.chart = a.ok ? String(a.source ?? "?") : `refused: ${String(a.reason ?? "").slice(0, 80)}`; }
      catch (e) { s.chart = `threw: ${String(e).slice(0, 80)}`; }
      try { const k = preflopPinKey(hand); if (k) forgetPreflopPin(k); } catch { /* best effort */ }
    }
    log(`${s.id.padEnd(34)} ${s.caller}@${s.callerStack}bb pool ${(100 * s.poolFreq).toFixed(1)}% · GTO ${s.share == null ? `n/a (${s.shareWhy?.slice(0, 70)})` : `${(100 * s.share).toFixed(2)}%`} · ${s.chart ?? ""}${PHASE !== "scan" ? ` · req ${own}` : ""}`);
    save();
  }
  save();
  log(`done (${own} requests)`);
  process.exit(0);
}

// ── solve: hero unlocked vs locked ───────────────────────────────────────────────────────────────────────────────
const resFile = join(DATA, arg("tag") ? `solved-${arg("tag")}.json` : "solved.json");
const solved: Record<string, any> = existsSync(resFile) ? JSON.parse(readFileSync(resFile, "utf8")) : {};
for (const s of spots) {
  if (!IDS?.includes(s.id)) continue;
  if (solved[s.id]?.ok) continue;
  if (stopped) break;
  const { hand, heroPos } = hands.get(s.id)!;
  const shape: any = G.shapeOf(hand, heroPos);
  const r0 = own;
  const sh = await readShare(s).catch((e) => ({ error: String(e) }));
  if ("error" in sh) { solved[s.id] = { ok: false, why: `share: ${sh.error}`, req: own - r0 }; log(`${s.id}: share failed — ${sh.error}`); writeFileSync(resFile, JSON.stringify(solved, null, 1)); continue; }
  s.share = sh.share; s.callerLine = sh.callerLine;
  const un = await G.fetchNode(sh.parent, sh.heroLine);
  if ("error" in un) { solved[s.id] = { ok: false, why: `unlocked hero node: ${un.error}`, req: own - r0 }; writeFileSync(resFile, JSON.stringify(solved, null, 1)); continue; }
  const lk: any = await G.solvePreflopColdCallLocked(hand, heroPos, { pos: s.caller as any, key: s.key as any, stack: s.callerStack, size: (s.size ?? null) as any }, { skipPin: () => true, lockBelow: 1.01 })
    .catch((e) => ({ ok: false, reason: String(e) }));
  if (!lk.ok) { solved[s.id] = { ok: false, why: `locked: ${lk.reason}`, req: own - r0, share: sh.share }; log(`${s.id}: locked failed — ${lk.reason}`); writeFileSync(resFile, JSON.stringify(solved, null, 1)); continue; }
  const ln = await G.fetchNode(lk.solId, lk.usedLine);
  if ("error" in ln) { solved[s.id] = { ok: false, why: `locked hero node: ${ln.error}`, req: own - r0 }; writeFileSync(resFile, JSON.stringify(solved, null, 1)); continue; }
  const heroApi = shape.heroApiPos, callerApi = shape.apiOf[s.caller];
  const U = heroView(un.data, heroApi, callerApi), L = heroView(ln.data, heroApi, callerApi);
  const range = L.range.length === 1326 ? L.range : U.range;
  // total variation between the two strategies over hero's range (0-1), and per action
  let tv = 0, w = 0;
  for (let i = 0; i < 1326; i++) {
    const r = range[i] ?? 0; if (!(r > 0)) continue;
    let d = 0;
    const codes = new Set([...U.codes, ...L.codes]);
    for (const c of codes) { const a = U.codes.indexOf(c), b = L.codes.indexOf(c); d += Math.abs((a >= 0 ? U.strat[a]![i]! : 0) - (b >= 0 ? L.strat[b]![i]! : 0)); }
    tv += r * d / 2; w += r;
  }
  const hi = s.heroCards.length >= 4 ? (() => { try { const c = (hand.heroCards ?? []) as string[]; return comboIndex(c[0]!, c[1]!); } catch { return null; } })() : null;
  const handMix = (v: HV) => hi == null ? null : Object.fromEntries(v.codes.map((c, a) => [v.labels[a], Math.round(1000 * (v.strat[a]![hi] ?? 0)) / 10]));
  const evLockedOpt = evOf(L, L, range), evUnlockedInLocked = evOf(U, L, range);
  const evUnlockedOpt = evOf(U, U, range), evLockedInUnlocked = evOf(L, U, range);
  solved[s.id] = {
    ok: true, share: sh.share, poolFreq: s.poolFreq, lockBelow: s.lockBelow, locksByRule: sh.share < (s.lockBelow ?? 0.01), caller: s.caller, callerStack: s.callerStack, key: s.key, heroPos: s.heroPos, line: s.line, heroLine: lk.usedLine,
    req: own - r0, heroCombos: Math.round(U.heroCombos * 10) / 10,
    callerCombosUnlocked: Math.round(U.callerCombos * 100) / 100, callerCombosLocked: Math.round(L.callerCombos * 100) / 100,
    mixUnlocked: Object.fromEntries(U.labels.map((l, a) => [l, Math.round(1000 * U.freq[a]!) / 10])),
    mixLocked: Object.fromEntries(L.labels.map((l, a) => [l, Math.round(1000 * L.freq[a]!) / 10])),
    tvPct: Math.round(1000 * tv / w) / 10,
    handMixUnlocked: handMix(U), handMixLocked: handMix(L), heroCards: s.heroCards,
    // what ignoring the pool caller costs if the pool is right, and what locking costs if GTO is right (bb per hand at the node)
    costIgnorePool: Math.round(1000 * (evLockedOpt - evUnlockedInLocked)) / 1000,
    costLockIfGto: Math.round(1000 * (evUnlockedOpt - evLockedInUnlocked)) / 1000,
  };
  log(`${s.id}: GTO ${(100 * sh.share).toFixed(2)}% vs pool ${(100 * s.poolFreq).toFixed(1)}% · TV ${solved[s.id].tvPct}% · cost ${solved[s.id].costIgnorePool} / ${solved[s.id].costLockIfGto} bb · req ${own - r0} (run ${own}, primary 24 h ${primaryDay()})`);
  writeFileSync(resFile, JSON.stringify(solved, null, 1));
  save();
}
log(`done (${own} requests)`);
process.exit(0);
