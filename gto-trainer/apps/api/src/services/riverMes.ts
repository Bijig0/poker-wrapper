/**
 * On-the-fly river MES for the 6-max ring strategy.
 *
 * The 6-max postflop answer is GTO Wizard AI's equilibrium, walked street by
 * street (aiChain). By the river that walk already holds every seat's exact
 * per-combo range for THIS line — so the river subgame can be solved locally,
 * the villain locked to how the pool actually plays, and hero's best response
 * read off, in about a tenth of a second (livemes_bench.py: p50 0.09 s over 202
 * recorded spots, against GTO Wizard's 1.6 s river solve).
 *
 *   1. spot context from the chain trace: pot type, river positions, each
 *      player's flop/turn aggression, the river card's class
 *   2. lock table (data/river_lock.json, analysis/pipeline/solve/river/
 *      riverlock.py): CoinPoker's structure at Ignition's level, validated on
 *      held-out Ignition hands; bets and raises answered separately
 *   3. riverroot (equilibrium) -> exploitsolve (v3 tilt lock, raise_ctx)
 *   4. THE GATE, per hero combo, off the two dumps:
 *        G  what the MES action gains over the equilibrium mix vs the pool
 *        L  what it gives up if villain plays equilibrium instead (<= 0)
 *        p* = -L / (G - L): how sure you must be that villain plays like the
 *        pool for MES to be right. Deviating inside the equilibrium's own
 *        indifference costs nothing (L = 0, p* = 0).
 *      Serve MES iff G >= gMinBb and p* <= tau.
 *
 * The adaptive-nemesis counter is logged but is NOT the gate: an anonymous
 * pool player cannot see hero's river strategy within a hand, and it would veto
 * every exploit (median -31.6 bb against a +4.0 bb gain on the benchmark).
 *
 * MODES (data/river_mes_config.json, else env RIVER_MES, else "shadow"):
 *   off     nothing runs
 *   shadow  runs after every heads-up river answer and is LOGGED only — the
 *           answer on the panel is untouched (default: collect evidence first)
 *   serve   MES becomes the primary pick (see serveWhen); the chain's
 *           equilibrium rides along as the GTO tab. Any failure or timeout
 *           leaves the chain's answer exactly as it was.
 *
 * serveWhen (backtest 2026-09-22, 800 river decisions from Brady's Ignition 6-max corpus):
 *   "first" (default)  serve MES only at hero's FIRST river decision — nothing to call (first to act,
 *           or checked to) — ungated; every later hero node (facing a bet or a raise) keeps the chain.
 *           Measured MES-first-then-GTO vs GTO Wizard: +0.97 bb/decision [+0.48, +1.42] on 565 spots,
 *           the same with every lock variant. Facing a bet MES LOST 3.08 bb/decision: its locked range
 *           is the pool average, and the pool bets into hero's passive lines with far more air (hero
 *           ahead 42% out of sample vs 35% modelled), so it over-folded.
 *   "gated" the original rule: wherever G >= gMinBb and p* <= tau. The gate's G did not predict what
 *           MES gained (slope 0.45, corr 0.12), so this is kept for comparison only.
 * The config file is re-read on change, so switching modes needs no restart.
 *
 * Python twin: analysis/pipeline/solve/river/livemes_gate.py — same keys, same
 * gate; riverMes.test.ts pins the pure pieces to it.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickWeightedAction, type WeightedPick } from "../utils/pickWeightedAction/pickWeightedAction";
import { openStore, riverMesConfigPath, riverMesDbPath } from "./storePaths";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const DATA = join(import.meta.dir, "..", "..", "data");
const LOCK_PATH = join(DATA, "river_lock.json");
// runtime records (the shadow log + its hand-edited config) live in the data root; the lock (tracked) stays with the code
const CONFIG_PATH = riverMesConfigPath();
const LOG_PATH = riverMesDbPath();
const EXE = process.platform === "win32" ? ".exe" : "";

export type RiverMesMode = "off" | "shadow" | "serve";

export interface RiverMesConfig {
  mode: RiverMesMode;
  /** serve only if p* (break-even belief that villain is the pool) is at most this */
  tau: number;
  /** ...and the gain vs the pool is at least this many bb */
  gMinBb: number;
  menu: string;
  raise: string;
  accuracyPct: number;
  timeoutMs: number;
  binDir: string;
  serveWhen: "first" | "gated";
}

const DEFAULTS: RiverMesConfig = {
  mode: "shadow",
  tau: 0.5,
  gMinBb: 0.1,
  // one size per exploitsolve bet bucket (s <.40, m <.65, b <1.0, o >=1.0), so every villain bet
  // frequency the lock table carries has a tree action to land on
  menu: "33%, 55%, 80%, 150%",
  raise: "60%",
  accuracyPct: 0.5,
  timeoutMs: 1500,
  serveWhen: "first",
  binDir: join(REPO, "analysis", "pipeline", "solve", "compare", "target", "release"),
};

let cfgCache: { mtime: number; cfg: RiverMesConfig } | null = null;

export function riverMesConfig(): RiverMesConfig {
  const envMode = process.env.RIVER_MES as RiverMesMode | undefined;
  const base: RiverMesConfig = {
    ...DEFAULTS,
    ...(envMode && ["off", "shadow", "serve"].includes(envMode) ? { mode: envMode } : {}),
    ...(process.env.RIVER_MES_BIN ? { binDir: process.env.RIVER_MES_BIN } : {}),
  };
  try {
    const m = statSync(CONFIG_PATH).mtimeMs;
    if (!cfgCache || cfgCache.mtime !== m) {
      cfgCache = { mtime: m, cfg: { ...base, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) } };
    }
    return cfgCache.cfg;
  } catch {
    return base;
  }
}

// ---------------------------------------------------------------- context

export interface RiverCtx {
  pot: "limped" | "srp" | "3bp";
  tex: "flush" | "straight" | "pair" | "brick";
  hero: "oop" | "ip";
  villain: "oop" | "ip";
  heroLine: "turn" | "flop" | "none";
  villainLine: "turn" | "flop" | "none";
  aggrFlop: "oop" | "ip" | "none";
  aggrTurn: "oop" | "ip" | "none";
}

const RANKS = "23456789TJQKA";

/** Preflop raises in the chain's preflop tokens: 0 limped, 1 single-raised, 2+ three-bet or more. */
export function potTypeOf(preTokens: string[]): RiverCtx["pot"] {
  const n = preTokens.filter((t) => t.startsWith("R")).length;
  return n === 0 ? "limped" : n === 1 ? "srp" : "3bp";
}

/** flush | straight | pair | brick — riverfeatures.coarse's precedence. A straight "arrives" only when a
 *  ONE-card straight is newly possible: two-card wheels change nobody's river. */
export function riverClassOf(board: string): RiverCtx["tex"] {
  const cards = board.match(/../g) ?? [];
  if (cards.length < 5) return "brick";
  const ranks = cards.map((c) => RANKS.indexOf(c[0]!));
  const suits = cards.map((c) => c[1]!);
  const rs = suits[4]!;
  if (suits.slice(0, 4).filter((s) => s === rs).length === 2) return "flush";
  const wins = [[12, 0, 1, 2, 3], ...Array.from({ length: 9 }, (_, i) => [i, i + 1, i + 2, i + 3, i + 4])];
  const ocs = (set: Set<number>) => wins.some((w) => w.filter((r) => set.has(r)).length === 4);
  if (ocs(new Set(ranks)) && !ocs(new Set(ranks.slice(0, 4)))) return "straight";
  if (ranks.slice(0, 4).includes(ranks[4]!)) return "pair";
  return "brick";
}

type Trace = any;

export function riverContext(trace: Trace, preTokens: string[]): RiverCtx | null {
  const spec = trace?.spec;
  const streets: Record<string, any> = Object.fromEntries((trace?.streets ?? []).map((s: any) => [s.street, s]));
  const rv = streets.RIVER;
  if (!spec || !rv) return null;
  const players: string[] = rv.players ?? [spec.oopPos, spec.ipPos];
  if (players.length !== 2) return null;
  const [oop, ip] = [players[0], players[1]];
  const aggressor = (street: string): RiverCtx["aggrFlop"] => {
    const s = streets[street];
    if (!s) return "none";
    const seats: string[] = s.players ?? [spec.oopPos, spec.ipPos];
    const nodes = (trace.nodes ?? []).filter((n: any) => n.street === street).sort((a: any, b: any) => a.ti - b.ti);
    let who: string | null = null;
    for (const n of nodes) {
      const t = n.taken;
      if (t != null && String(n.actions?.[t]?.code ?? "").startsWith("R")) who = seats[n.actor] ?? null;
    }
    return who === oop ? "oop" : who === ip ? "ip" : "none";
  };
  const aggrFlop = aggressor("FLOP");
  const aggrTurn = aggressor("TURN");
  const line = (p: "oop" | "ip") => (aggrTurn === p ? "turn" : aggrFlop === p ? "flop" : "none") as RiverCtx["heroLine"];
  const hero: "oop" | "ip" = spec.heroSeat === "oop" ? "oop" : "ip";
  const villain = hero === "oop" ? "ip" : "oop";
  return {
    pot: potTypeOf(preTokens), tex: riverClassOf(rv.board), hero, villain,
    heroLine: line(hero), villainLine: line(villain), aggrFlop, aggrTurn,
  };
}

// ---------------------------------------------------------------- lock table

let lockCache: { mtime: number; lock: any } | null = null;

export function loadLock(path = LOCK_PATH): any | null {
  try {
    const m = statSync(path).mtimeMs;
    if (!lockCache || lockCache.mtime !== m) lockCache = { mtime: m, lock: JSON.parse(readFileSync(path, "utf-8")) };
    return lockCache.lock;
  } catch {
    return null;
  }
}

const FACING = ["vs_s", "vs_m", "vs_b", "vs_o"] as const;

/** exploitsolve `freqs` for this spot: villain's first action keyed by HIS line, his answers to hero's wagers
 *  keyed by HERO's line, bets and raises separately. A cell the table lacks falls back to the context marginal. */
export function lockFreqs(lock: any, ctx: RiverCtx): { freqs: Record<string, any>; used: Record<string, string> } {
  const freqs: Record<string, any> = {};
  const used: Record<string, string> = {};
  const first = `${ctx.pot}|${ctx.villain}|${ctx.villainLine}|${ctx.tex}`;
  freqs["river|first"] = lock.first?.[first] ?? lock.marginal?.first;
  used["river|first"] = lock.first?.[first] ? first : "marginal";
  for (const fac of FACING) {
    for (const suf of ["", ":raise"]) {
      const c = `${fac}${suf}`;
      const k = `${c}|${ctx.pot}|${ctx.hero}|${ctx.heroLine}|${ctx.tex}`;
      const cell = lock.resp?.[k] ?? lock.marginal?.[c];
      if (cell) {
        freqs[`river|${c}`] = cell;
        used[`river|${c}`] = lock.resp?.[k] ? k : "marginal";
      }
    }
  }
  return { freqs, used };
}

// ---------------------------------------------------------------- line + labels

/** The chain's river line up to hero's node, as exploitsolve tokens, plus the observed first-wager sizes
 *  (they join the menu so the line exists in our tree exactly, instead of snapping). */
export function riverLine(trace: Trace): { line: string[]; extra: string[]; raiseExtra: string[] } | null {
  const nodes = (trace?.nodes ?? []).filter((n: any) => n.street === "RIVER").sort((a: any, b: any) => a.ti - b.ti);
  const heroNodes = nodes.filter((n: any) => n.heroNode);
  if (!heroNodes.length) return null;
  const heroTi = heroNodes[heroNodes.length - 1].ti;
  const line: string[] = [];
  const extra: string[] = [];
  const raiseExtra: string[] = [];
  for (const n of nodes) {
    if (n.ti >= heroTi || n.taken == null) continue;
    const a = n.actions[n.taken];
    const code = String(a.code);
    if (code === "X") line.push("Check");
    else if (code === "C") line.push("Call");
    else if (code === "F") line.push("Fold");
    else {
      line.push(`~${Math.round(Number(a.betsize) * 100)}`);
      const inv: number[] = n.invested ?? [0, 0];
      if (inv.every((v) => v === 0) && Number(n.potNode) > 0) {
        extra.push(`${((100 * Number(a.betsize)) / Number(n.potNode)).toFixed(1)}%`);
      } else if (Math.max(...inv) > 0) {
        // a RAISE, exact as a multiple of the wager it raised ("2.5x" = raise to 2.5x the previous bet);
        // snapped to the menu raise instead, hero's call is priced against a raise he never faced
        raiseExtra.push(`${(Number(a.betsize) / Math.max(...inv)).toFixed(4)}x`);
      }
    }
  }
  return { line, extra, raiseExtra };
}

/** postflop-solver label -> the chain's label ("Bet(1880)" -> "BET 18.8"), sizes as street totals in bb —
 *  byte-identical to what labelOf() gives GTO Wizard's answers, so the relay executes it unchanged. */
export function toGtowLabel(label: string, callTotalBb?: number | null): { action: string; betsize?: string } {
  const m = label.match(/^(Bet|Raise|AllIn)\((\d+)\)$/);
  if (m) {
    const bb = Math.round(Number(m[2]) / 100 * 100) / 100;
    return { action: `${{ Bet: "BET", Raise: "RAISE", AllIn: "ALLIN" }[m[1] as "Bet"]} ${bb}`, betsize: String(bb) };
  }
  // GTO Wizard labels a call with the street total it matches ("CALL 18.8"); our tree's Call carries no
  // amount, so the chain's own hero node supplies it
  if (label === "Call" && callTotalBb != null && callTotalBb > 0) {
    const bb = Math.round(callTotalBb * 100) / 100;
    return { action: `CALL ${bb}`, betsize: String(bb) };
  }
  return { action: label.toUpperCase() };
}

/** The street total a call matches at hero's river node, read off the chain's own action there. */
export function callTotalOf(trace: Trace): number | null {
  const hn = (trace?.nodes ?? []).filter((n: any) => n.street === "RIVER" && n.heroNode).pop();
  const c = hn?.actions?.find((a: any) => String(a.code) === "C");
  return c ? Number(c.betsize) : null;
}

// ---------------------------------------------------------------- gate

export interface GateResult {
  ok: boolean;
  why?: string;
  actions?: string[];
  mes?: number[];
  gto?: number[];
  evPool?: number[];
  evEq?: number[];
  G?: number;
  L?: number;
  pStar?: number;
  served?: boolean;
}

export function gateOf(x: any, hero: 0 | 1, heroCards: string, cfg: Pick<RiverMesConfig, "tau" | "gMinBb">): GateResult {
  const holes: string[] = hero === 0 ? x.oop_holes : x.ip_holes;
  const want = new Set([heroCards, heroCards.slice(2) + heroCards.slice(0, 2)]);
  const i = holes.findIndex((h) => want.has(h));
  const b = x.baseline?.nodes?.[0];
  const e = x.exploit?.nodes?.[0];
  if (i < 0) return { ok: false, why: "hero combo not in range" };
  if (!b || !e || JSON.stringify(b.actions) !== JSON.stringify(e.actions)) return { ok: false, why: "menus differ" };
  const col = (m: number[][]) => m.map((row) => row[i]!);
  const norm = (v: number[]) => { const t = v.reduce((s, z) => s + z, 0); return t > 0 ? v.map((z) => z / t) : v; };
  const sGto = norm(col(b.strategy));
  const sMes = norm(col(e.strategy));
  const evEq = col(b.ev).map((v) => v / 100);
  const evPool = col(e.ev).map((v) => v / 100);
  const dot = (p: number[], q: number[]) => p.reduce((s, z, k) => s + z * q[k]!, 0);
  const G = dot(sMes, evPool) - dot(sGto, evPool);
  const L = Math.min(0, dot(sMes, evEq) - dot(sGto, evEq));
  const pStar = G > 0 ? -L / (G - L) : Infinity;
  return { ok: true, actions: b.actions, mes: sMes, gto: sGto, evPool, evEq, G, L, pStar,
    served: G >= cfg.gMinBb && pStar <= cfg.tau };
}

// ---------------------------------------------------------------- runner

export interface RiverMesInput {
  trace: Trace;
  preTokens: string[];
  heroCards: string[];
}

export interface RiverMesResult {
  ok: boolean;
  why?: string;
  ctx?: RiverCtx;
  cells?: Record<string, string>;
  gate?: GateResult;
  /** hero combo's MES mix, labelled exactly like the chain's answers */
  actions?: { action: string; frequency: number; ev?: number; betsize?: string }[];
  gtoActions?: { action: string; frequency: number; ev?: number; betsize?: string }[];
  mesTop?: string;
  gtoTop?: string;
  counterBb?: number | null;
  unread?: number;
  ms: number;
}

async function runBin(cfg: RiverMesConfig, name: string, spec: object, dir: string, deadline: number): Promise<any> {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify(spec));
  const proc = Bun.spawn([join(cfg.binDir, name + EXE), p], { stdout: "pipe", stderr: "pipe" });
  const left = Math.max(1, deadline - Date.now());
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, left);
  try {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const last = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    return last ? JSON.parse(last) : null;
  } finally {
    clearTimeout(timer);
  }
}

export async function solveRiverMes(input: RiverMesInput, cfg = riverMesConfig()): Promise<RiverMesResult> {
  const t0 = Date.now();
  const deadline = t0 + cfg.timeoutMs;
  const done = (r: Omit<RiverMesResult, "ms">): RiverMesResult => ({ ...r, ms: Date.now() - t0 });
  const trace = input.trace;
  const rv = (trace?.streets ?? []).find((s: any) => s.street === "RIVER");
  if (!rv?.oopIn || !rv?.ipIn) return done({ ok: false, why: "no river-entry ranges in the chain trace" });
  if (rv.players && rv.players.length !== 2) return done({ ok: false, why: "river is not heads-up" });
  const heroCards = input.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c)).join("");
  if (heroCards.length !== 4) return done({ ok: false, why: "hero cards unknown" });
  const ctx = riverContext(trace, input.preTokens);
  if (!ctx) return done({ ok: false, why: "spot context unreadable" });
  const lock = loadLock();
  if (!lock) return done({ ok: false, why: "data/river_lock.json missing" });
  const ln = riverLine(trace);
  if (!ln) return done({ ok: false, why: "no hero node on the river" });
  const { freqs, used } = lockFreqs(lock, ctx);
  const rake = trace.spec?.rake ?? {};
  const dir = mkdtempSync(join(tmpdir(), "rivermes-"));
  try {
    const tree = join(dir, "tree.bin");
    const r1 = await runBin(cfg, "riverroot", {
      board: rv.board, pot: Math.round(Number(rv.potIn) * 100), eff_stack: Math.round(Number(rv.stackIn) * 100),
      rake_rate: Number(rake.pct_of_pot ?? 5) / 100, rake_cap: Number(rake.cap_in_chips ?? 2) * 100,
      oop_raw: rv.oopIn, ip_raw: rv.ipIn,
      river_bets: [cfg.menu, ...ln.extra].join(", "), raise: [cfg.raise, ...ln.raiseExtra].join(", "),
      accuracy_pct: cfg.accuracyPct, save_tree: tree,
    }, dir, deadline);
    if (!r1?.ok) return done({ ok: false, why: Date.now() >= deadline ? "timeout (equilibrium solve)" : "riverroot failed", ctx });
    const xo = join(dir, "x.json");
    await runBin(cfg, "exploitsolve", {
      mode: "solve", tree, villain: ctx.hero === "oop" ? 1 : 0, line: ln.line, freqs,
      tilt: true, counter: true, raise_ctx: true, accuracy_pct: cfg.accuracyPct, out: xo,
    }, dir, deadline);
    if (!existsSync(xo)) return done({ ok: false, why: Date.now() >= deadline ? "timeout (lock + counter)" : "exploitsolve failed", ctx, cells: used });
    const x = JSON.parse(readFileSync(xo, "utf-8"));
    const g = gateOf(x, ctx.hero === "oop" ? 0 : 1, heroCards, cfg);
    if (!g.ok) return done({ ok: false, why: g.why, ctx, cells: used, gate: g });
    const callTotal = callTotalOf(trace);
    const mk = (strat: number[], ev: number[]) => g.actions!.map((lab, k) => ({
      ...toGtowLabel(lab, callTotal), frequency: Math.round(strat[k]! * 1e4) / 100, ev: Math.round(ev[k]! * 100) / 100,
    }));
    const actions = mk(g.mes!, g.evPool!);
    const gtoActions = mk(g.gto!, g.evEq!);
    const top = (a: { action: string; frequency: number }[]) => a.reduce((m, z) => (z.frequency > m.frequency ? z : m)).action;
    return done({
      ok: true, ctx, cells: used, gate: g, actions, gtoActions, mesTop: top(actions), gtoTop: top(gtoActions),
      counterBb: x.counter?.vs_baseline_bb ?? null, unread: (x.unread ?? []).length,
    });
  } catch (err) {
    return done({ ok: false, why: `river MES error: ${(err as Error).message}`, ctx });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
  }
}

// ---------------------------------------------------------------- log

let db: Database | null = null;

function logDb(): Database {
  if (db) return db;
  db = openStore(LOG_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS river_mes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    solve_id INTEGER, client_hand_id TEXT, session_id TEXT, origin TEXT,
    board TEXT, hero_cards TEXT, mode TEXT, ok INTEGER, served INTEGER, why TEXT,
    mes_top TEXT, gto_top TEXT, chain_top TEXT,
    g_bb REAL, l_bb REAL, p_star REAL, counter_bb REAL, ms INTEGER,
    ctx TEXT, cells TEXT, actions TEXT, gto_actions TEXT)`);
  return db;
}

export function logRiverMes(r: RiverMesResult, meta: {
  solveId?: number | null; clientHandId?: string | null; sessionId?: string | null; origin?: string | null;
  board?: string | null; heroCards?: string | null; mode: RiverMesMode; chainTop?: string | null;
  served?: boolean;
}): void {
  try {
    logDb().run(
      `INSERT INTO river_mes (ts, solve_id, client_hand_id, session_id, origin, board, hero_cards, mode, ok, served,
        why, mes_top, gto_top, chain_top, g_bb, l_bb, p_star, counter_bb, ms, ctx, cells, actions, gto_actions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), meta.solveId ?? null, meta.clientHandId ?? null, meta.sessionId ?? null, meta.origin ?? null,
        meta.board ?? null, meta.heroCards ?? null, meta.mode, r.ok ? 1 : 0,
        r.ok && meta.mode === "serve" && (meta.served ?? r.gate?.served) ? 1 : 0, r.why ?? null,
        r.mesTop ?? null, r.gtoTop ?? null, meta.chainTop ?? null,
        r.gate?.G ?? null, r.gate?.L ?? null, Number.isFinite(r.gate?.pStar) ? r.gate!.pStar! : null,
        r.counterBb ?? null, r.ms, JSON.stringify(r.ctx ?? null), JSON.stringify(r.cells ?? null),
        JSON.stringify(r.actions ?? null), JSON.stringify(r.gtoActions ?? null)],
    );
  } catch { /* logging must never break an answer */ }
}

// ---------------------------------------------------------------- answer overlay

/** Would serve mode play MES here? "first": only where hero has nothing to call (no Fold in his menu). */
export function servesMes(g: GateResult, cfg: Pick<RiverMesConfig, "serveWhen">): boolean {
  if (!g.ok || !g.actions) return false;
  if (cfg.serveWhen === "gated") return !!g.served;
  return !g.actions.some((a) => a.startsWith("Fold"));
}

/** Minimal shape of the chain's answer this overlay reads and (in serve mode) rewrites. */
export interface ChainAnswerLike {
  ok: boolean;
  actions?: { action: string; frequency: number; ev?: number; betsize?: string }[];
  decision?: WeightedPick | null;
  exploitDecision?: WeightedPick;
  chartDecision?: WeightedPick;
  exploitTag?: string;
  strategyMode?: "exploit" | "chart";
  mesEvGainBb?: number;
  warning?: string | null;
  solveId?: number | null;
}

/**
 * Run the river MES for a finished chain answer. shadow: fire and forget, log only. serve: wait (bounded by
 * cfg.timeoutMs), and if the gate passes make MES the primary with the chain's equilibrium as the GTO tab.
 * Never throws; on any failure the chain's answer is returned exactly as it was.
 */
export async function applyRiverMes<T extends ChainAnswerLike>(res: T, input: RiverMesInput, meta: {
  clientHandId?: string | null; sessionId?: string | null; origin?: string | null; board?: string | null;
}): Promise<T> {
  const cfg = riverMesConfig();
  if (cfg.mode === "off" || !res.ok || meta.origin === "warm") return res;
  const chainTop = res.actions?.length
    ? res.actions.reduce((m, z) => (z.frequency > m.frequency ? z : m)).action : null;
  const logMeta = { ...meta, solveId: res.solveId ?? null, heroCards: input.heroCards.join(""), mode: cfg.mode, chainTop };
  if (cfg.mode === "shadow") {
    void solveRiverMes(input, cfg).then((r) => logRiverMes(r, logMeta)).catch(() => {});
    return res;
  }
  const r = await solveRiverMes(input, cfg);
  const serve = !!r.ok && !!r.gate && servesMes(r.gate, cfg);
  logRiverMes(r, { ...logMeta, served: serve });
  if (!r.ok || !r.actions || !r.gate) return res;
  const mesPick = pickWeightedAction(r.actions) ?? undefined;
  if (!mesPick) return res;
  const g = r.gate;
  const tag = `river MES: +${g.G!.toFixed(2)}bb vs pool, ${g.L! > -0.005 ? "free (inside the equilibrium's indifference)"
    : `costs ${(-g.L!).toFixed(2)}bb vs an equilibrium villain (break-even belief ${(100 * g.pStar!).toFixed(0)}%)`}`;
  res.exploitDecision = mesPick;
  res.exploitTag = tag;
  res.mesEvGainBb = Math.round(g.G! * 100) / 100;
  if (serve) {
    res.chartDecision = res.decision ?? undefined;
    res.decision = mesPick;
    res.actions = r.actions;
    res.strategyMode = "exploit";
  } else {
    res.chartDecision = res.decision ?? undefined;
    res.strategyMode = "chart";
  }
  return res;
}
