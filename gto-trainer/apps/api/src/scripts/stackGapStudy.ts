/**
 * PREFLOP GAP STUDY (2026-10-01/02) — WHEN IS A CHART "CLOSE ENOUGH"? Measured in EV against the exact GTO Wizard AI
 * tree, which Brady takes as the truth. Calibrates the chart → AI hand-off on both axes: STACKS (services/treeGap, log
 * only today) and RAISE SIZES (utils/snapToken: a snap past 1.49x is refused today).
 *
 * THE SCORE is the EV an answer gives up at hero's node, the exact tree's continuation taken as given:
 *   loss = mean over hero's range of ( max_a EV[a] − Σ_a mix[a]·EV[a] )
 * with the share of the range whose action changes (total variation) beside it. The AI's own mix scored the same way
 * (≈ 0) is the check on units and on the action mapping. Hero's range is every combo on his first decision; after an
 * earlier action of his own it is weighted by the strategy of that action on the same tree.
 *
 * THE EXPERIMENTS (--exp, in this order):
 *   0  STACK SWEEP (done 2026-10-01): one seat's stack off — the raiser, a caller, a seat still to act, a deep pair.
 *   1  SIZE SWEEP, AI against AI: single-size trees (one open, one 3-bet, one 4-bet for every seat — the tree an HRC
 *      chart at that size is) on a ladder of sizes: facing an open (5 spots × 13 sizes), facing a 3-bet (3 spots),
 *      facing a 4-bet (2 spots). Tree(size') played inside tree(size) is "the raise was `size`, we read `size'`".
 *      Plus the LIVE-MENU check: the live fallback gives the raiser 2.5x AND the size he used — is hero's answer on
 *      that two-size tree the single-size tree's?
 *   2  STACKS IN 3-BET POTS: hero opens, a seat 3-bets (jams when short) — the 3-bettor's stack on the ladder.
 *   3  REAL DECISIONS WITH A SIZE SNAP, chart against AI: logged chart answers whose line was snapped onto a tree
 *      size, sampled across (level × ratio) among tables whose stacks are near the chart's, plus exact controls;
 *      scored on the tree the live fallback would build.
 *   5  SHORT STACKS, THOROUGH (2026-10-02, Brady: "20bb on a 10bb chart is not 210 on a 200"): the stack sweeps of
 *      experiment 0 on a fine ladder down to 7.5bb, plus the spots a short stack actually makes — an open JAM in
 *      front of hero (three seats), blind against blind (SB first in; BB facing the SB's open, and its limp), a short
 *      limper, a min-raise. Read by RATIO WITHIN A DEPTH BAND, so "1.3x at 10bb" and "1.3x at 80bb" are told apart.
 *   4  UNEVEN TABLES: (a) TWO seats off where the chart models one; (b) hero's OWN stack off (the picker reads the
 *      even chart at his stack); (c) the real chart decisions sampled across (role × stack ratio) — exp 0's real half.
 *
 * SAFE TO LEAVE RUNNING: one spot every --every seconds; before each spot it WAITS while a poker session is live,
 * waits while the Ultra account has more than --hour-cap requests in the trailing hour (the wall is 2,250), stops at
 * --budget requests of its own, and stops dead on anything that reads like a rate limit. A missed token or a network
 * drop waits and asks the same spot again. Files nothing (origin "audit", ids stripped). Results append to
 * POKER_DATA_DIR/audits/{stack-sweep,stack-gap-real,size-gap-real}.jsonl; a re-run skips what is already there.
 *
 *   bun src/scripts/stackGapStudy.ts --plan  [--exp 1,2,3,4]     what would run, no requests
 *   bun src/scripts/stackGapStudy.ts --trees [--exp 1,2,4]       the synthetic trees and lines as they would be built
 *   bun src/scripts/stackGapStudy.ts --run   [--exp 1,2,3,4] [--every 45] [--hour-cap 900] [--budget 2600] [--real-size 190] [--real-stack 233] [--limit N]
 *   bun src/scripts/stackGapStudy.ts --report
 */
process.env.GTOW_REQUEST_ORIGIN ??= "stackGapStudy";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { buildPreflopTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { truncateAt } from "../utils/archivedHand/archivedHand";
import { repairDeadSmallBlind } from "../utils/repairPostflopRotation/repairPostflopRotation";
import { comboIndex, COMBOS } from "../utils/comboIndex/comboIndex";
import { is6Handed, solvePreflop6max } from "../services/fastSolve";
import { nodeGetter } from "../services/hrc6max";
import { SIX_MAX_STRATEGY_ID } from "../services/strategies";
import { solvePreflopGtowAi, solvePreflopWithMenus, fetchNode, debugTree } from "../services/gtowAiPreflop";
import type { TreeGap } from "../services/treeGap";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const num = (n: string, d: number) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) || d : d; };
const PLAN = flag("--plan"), RUN = flag("--run"), REPORT = flag("--report"), TREES = flag("--trees");
const EVERY = num("--every", 45), HOUR_CAP = num("--hour-cap", 900), BUDGET = num("--budget", 2600), LIMIT = num("--limit", 0);
const REAL_SIZE = num("--real-size", 190), REAL_STACK = num("--real-stack", 233);
const EXPS = (argv.includes("--exp") ? String(argv[argv.indexOf("--exp") + 1]) : "1,2,3,4").split(",").map(Number);
const API = process.env.STUDY_API ?? "http://127.0.0.1:2000";
const DATA = process.env.POKER_DATA_DIR ?? "C:\\Users\\Brady\\poker-data";
const DB = join(DATA, "poker.sqlite");
const OUT_DIR = join(DATA, "audits");
const SWEEP_OUT = join(OUT_DIR, "stack-sweep.jsonl"), REAL_OUT = join(OUT_DIR, "stack-gap-real.jsonl"), SIZE_OUT = join(OUT_DIR, "size-gap-real.jsonl");
const ORIGIN = "audit";   // not in missQueue's REAL_SOLVE_ORIGINS: files nothing
const log = (s: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

// ── the AI node, scored ────────────────────────────────────────────────────────────────────────────────────────
interface Offered { code: string; label: string; bb: number | null; allin: boolean }
const aiLabel = (action: any): string => {
  const type = String(action?.type ?? "").toUpperCase(); const bb = Number(action?.betsize);
  if (action?.allin === true) return "All-in";
  if (type.startsWith("FOLD")) return "Fold"; if (type.startsWith("CHECK")) return "Check"; if (type.startsWith("CALL")) return "Call";
  if (type.startsWith("RAISE") || type.startsWith("BET")) return Number.isFinite(bb) && bb > 0 ? `Raise ${Math.round(bb * 100) / 100}` : "Raise";
  return String(action?.code ?? "?");
};
const offeredOf = (sols: any[]): Offered[] => sols.map((s) => ({ code: String(s.action?.code ?? "?"), label: aiLabel(s.action),
  bb: Number.isFinite(Number(s.action?.betsize)) ? Number(s.action.betsize) : null, allin: s.action?.allin === true }));
/** the offered action another tree's (a chart's, another AI tree's) action means: fold→fold, call/limp/check→the
 *  passive action, a raise→the nearest size, an all-in→the jam (else the largest raise) */
function mapAction(label: string, offered: Offered[]): string | null {
  const l = label.toLowerCase();
  if (l === "fold") return offered.find((o) => o.code === "F")?.code ?? null;
  if (l === "call" || l === "limp" || l === "check") return (offered.find((o) => o.code === "C") ?? offered.find((o) => o.code === "X"))?.code ?? null;
  const raises = offered.filter((o) => o.bb != null && o.bb > 0 && (o.code.startsWith("R") || o.allin));
  if (!raises.length) return null;
  if (l.startsWith("all-in") || l === "allin") return (raises.find((o) => o.allin) ?? raises.reduce((a, b) => (b.bb! > a.bb! ? b : a))).code;
  const m = /([\d.]+)/.exec(label); const want = m ? parseFloat(m[1]!) : NaN;
  if (!(want > 0)) return raises[0]!.code;
  return raises.reduce((a, b) => (Math.abs(Math.log(want / b.bb!)) < Math.abs(Math.log(want / a.bb!)) ? b : a)).code;
}
/** per-action 1326 arrays of a node; strategies as fractions */
function arraysOf(sols: any[]): { strat: number[][]; evs: number[][] } {
  const strat = sols.map((s) => (s.strategy as number[]).map(Number)), evs = sols.map((s) => (s.evs as number[]).map(Number));
  let top = 0; for (let i = 0; i < 1326; i++) { let t = 0; for (const a of strat) t += a[i] ?? 0; if (t > top) top = t; }
  if (top > 1.5) for (const a of strat) for (let i = 0; i < a.length; i++) a[i] = a[i]! / 100;
  return { strat, evs };
}
/**
 * The EV given up by playing `mix` (combo → offered code → fraction) at a node with `evs`, averaged over hero's range
 * (`w`: per-combo weight, every combo equal when absent), and the share of that range `mix` plays differently from
 * `own` (total variation) when given. Combos the node has no EV for, or whose mix is mostly an action the node does
 * not offer (the AI tree's caller cap), are left out. `n` = combos counted.
 */
function rangeLoss(offered: Offered[], evs: number[][], mix: (i: number) => Record<string, number> | null, w?: number[] | null, own?: number[][]): { loss: number; tvd: number; n: number } {
  let sum = 0, tv = 0, tw = 0, n = 0;
  for (let i = 0; i < 1326; i++) {
    const wi = w ? w[i] ?? 0 : 1;
    if (!(wi > 0)) continue;
    let best = -Infinity, ok = true;
    for (const a of evs) { const v = a[i]; if (v == null || !Number.isFinite(v)) { ok = false; break; } if (v > best) best = v; }
    if (!ok) continue;
    const m = mix(i);
    if (!m) continue;
    let tot = 0, ev = 0;
    offered.forEach((o, k) => { const f = m[o.code] ?? 0; tot += f; ev += f * evs[k]![i]!; });
    if (!(tot > 0.9)) continue;
    sum += wi * (best - ev / tot); tw += wi; n++;
    if (own) { let d = 0; offered.forEach((o, k) => { d += Math.abs((m[o.code] ?? 0) / tot - (own[k]![i] ?? 0)); }); tv += wi * d / 2; }
  }
  return { loss: tw ? sum / tw : NaN, tvd: tw ? tv / tw : NaN, n };
}

// ── safety: live sessions, the hour window, the account ───────────────────────────────────────────────────────
function dbRead<T>(f: (db: Database) => T): T { const db = new Database(DB, { readonly: true }); try { return f(db); } finally { db.close(); } }
const liveSession = (): string | null => dbRead((db) => db.query<{ id: string }, []>(`SELECT id FROM sessions WHERE ended_at IS NULL LIMIT 1`).get()?.id ?? null);
const hourCount = (): number => dbRead((db) => db.query<{ n: number }, [number]>(`SELECT count(*) n FROM gtow_requests WHERE s = 'primary' AND ts >= ?`).get(Date.now() - 3_600_000)?.n ?? 0);
const ownSince = (ts: number): number => dbRead((db) => db.query<{ n: number }, [string, number]>(`SELECT count(*) n FROM gtow_requests WHERE o = ? AND ts >= ?`).get(process.env.GTOW_REQUEST_ORIGIN!, ts)?.n ?? 0);
async function ultraUp(): Promise<{ ok: boolean; walled: boolean; why: string }> {
  try {
    const j = await (await fetch(`${API}/api/gtow/accounts`, { signal: AbortSignal.timeout(8000) })).json() as any;
    const u = (j.accounts as any[]).find((a) => a.multiway);
    if (!u) return { ok: false, walled: false, why: "no multiway account in the registry" };
    if (u.wall?.walled) return { ok: false, walled: true, why: `${u.label ?? u.id} WALLED` };
    if (u.live?.state !== "up") return { ok: false, walled: false, why: `${u.label ?? u.id}: ${u.live?.text ?? u.live?.state}` };
    return { ok: true, walled: false, why: `${u.label ?? u.id} up` };
  } catch (e) { return { ok: false, walled: false, why: `API unreachable: ${e instanceof Error ? e.message : e}` }; }
}
const RATE_LIMIT = /\b429\b|request limit|rate.?limit|walled|too many requests/i;
const NETWORK = /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timed out|fetch failed|network|socket|unable to connect|poll failed/i;
/** wait until it is safe to spend one more spot; false = stop the run */
async function gate(t0: number): Promise<boolean> {
  let said = "", notUp = 0;
  const say = (s: string) => { if (s !== said) { log(s); said = s; } };
  for (;;) {
    const used = ownSince(t0);
    if (used >= BUDGET) { log(`STOP: budget reached (${used} requests of ${BUDGET}); re-run to continue`); return false; }
    const live = liveSession();
    if (live) { say(`PAUSED: session ${live} is live — waiting for it to end`); await sleep(60_000); continue; }
    const h = hourCount();
    if (h >= HOUR_CAP) { say(`PAUSED: Ultra has ${h} requests in the trailing hour (cap ${HOUR_CAP}) — waiting`); await sleep(60_000); continue; }
    const g = await ultraUp();
    if (g.walled) { log(`STOP: ${g.why}`); return false; }
    if (!g.ok) { if (++notUp > 30) { log(`STOP: ${g.why} for 30 minutes`); return false; } say(`waiting: ${g.why}`); await sleep(60_000); continue; }
    if (said) log("resuming");
    return true;
  }
}

// ── the sweeps: synthetic 6-handed spots ───────────────────────────────────────────────────────────────────────
const SEAT: Record<string, number> = { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 };
type Act = [pos: string, type: "fold" | "raise" | "call" | "all-in", amount?: number];
interface Build { stacks?: Record<string, number>; line: Act[]; menu?: Record<string, unknown> }
interface SweepCfg { id: string; exp: 0 | 1 | 2 | 4 | 5; axis: "stack" | "size" | "pair" | "check"; role: string; hero: string; ladder: number[]; at: (v: number) => Build; say: string;
  /** the sizes our charts hold on this axis: "true → read" is printed against the nearest of them */
  grid?: number[] }
const F = (...pos: string[]): Act[] => pos.map((p) => [p, "fold"] as Act);
const mult = (v: number) => `${Math.round(v * 1000) / 1000}x`;
/** single-size menus for every seat: the open (bb), the 3-bet and the 4-bet as multiples of the bet before */
const menu = (open: number, three: number, four: number) => ({ bet_sizes: [mult(open)], raise_sizes: [mult(three)], second_raise_sizes: [mult(four)], third_plus_raise_sizes: ["2.2x"] });
/** a 3-bet to 3.5x the 2.5 open, or the jam when that is 60% of the stack or more (the tree's all-in threshold) */
const threeBet = (pos: string, stack: number): Act => (8.75 >= 0.6 * stack ? [pos, "all-in", stack] : [pos, "raise", 8.75]);
const SHORT_LADDER = [100, 90, 80, 70, 60, 50, 40, 30, 25, 20, 15, 10];
/** the fine ladder of experiment 5: every chart rung from 7.5bb up, and the stacks between them */
const FINE_LADDER = [100, 90, 80, 70, 60, 50, 40, 35, 30, 25, 22.5, 20, 17.5, 15, 12.5, 10, 7.5];
const SHORT_FINE = [100, 60, 40, 30, 25, 22.5, 20, 17.5, 15, 12.5, 10, 7.5];
const JAM_LADDER = [40, 30, 25, 22.5, 20, 17.5, 15, 12.5, 10, 7.5, 5];
/** the short-stack rungs the chart picker can name (hrc6max SHORTS6) that sit on these ladders, and the 100bb default */
const STACK_GRID = [7.5, 10, 15, 20, 25, 30, 50, 60, 70, 80, 100];
const OPEN_SIZES = [2, 2.1, 2.2, 2.3, 2.5, 2.7, 3, 3.3, 3.5, 4, 4.5, 5, 6];
const OPEN_GRID = [2, 2.5, 3, 3.5];
const PAIRS = [100, 60, 30].flatMap((a) => [100, 60, 30, 15].map((b) => a * 1000 + b));
const pairOf = (v: number) => [Math.floor(v / 1000), v % 1000] as const;
const stackCfg = (id: string, role: string, hero: string, vary: string[], line: Act[], ladder: number[], say: string, exp: 0 | 5 = 0): SweepCfg =>
  ({ id, exp, axis: "stack", role, hero, ladder, say, ...(ladder[0]! <= 100 ? { grid: STACK_GRID } : {}), at: (v) => ({ stacks: Object.fromEntries(vary.map((p) => [p, v])), line }) });
/** a short stack's own line: its stack is the variable, and its action may be the jam of exactly that stack */
const shortCfg = (id: string, role: string, hero: string, seat: string, line: (s: number) => Act[], ladder: number[], say: string): SweepCfg =>
  ({ id, exp: 5, axis: "stack", role, hero, ladder, grid: STACK_GRID, say, at: (v) => ({ stacks: { [seat]: v }, line: line(v) }) });
const openCfg = (id: string, hero: string, line: (s: number) => Act[], say: string): SweepCfg =>
  ({ id, exp: 1, axis: "size", role: "open", hero, ladder: OPEN_SIZES, grid: OPEN_GRID, say, at: (s) => ({ line: line(s), menu: menu(s, 3.5, 2.3) }) });
const SWEEP: SweepCfg[] = [
  // 0 — one seat's stack off (2026-10-01)
  stackCfg("raiser-co", "raiser", "BTN", ["CO"], [...F("UTG", "HJ"), ["CO", "raise", 2.5]], FINE_LADDER, "BTN facing a CO open; the CO's stack varies"),
  stackCfg("caller-btn", "in", "SB", ["BTN"], [...F("UTG", "HJ"), ["CO", "raise", 2.5], ["BTN", "call", 2.5]], FINE_LADDER, "SB facing a CO open and a BTN call; the BTN's stack varies (hand 4921874909)"),
  stackCfg("behind-bb", "behind", "BTN", ["BB"], F("UTG", "HJ", "CO"), FINE_LADDER, "BTN first in; the BB's stack varies"),
  stackCfg("behind-btn", "behind", "CO", ["BTN"], F("UTG", "HJ"), SHORT_LADDER, "CO first in; the BTN's stack varies"),
  stackCfg("raiser-btn-vs-bb", "raiser", "BB", ["BTN"], [...F("UTG", "HJ", "CO"), ["BTN", "raise", 2.5], ["SB", "fold"]], FINE_LADDER, "BB facing a BTN open; the BTN's stack varies"),
  // (GTO Wizard refuses the 300bb tree: VALIDATION_ERROR)
  stackCfg("deep-pair", "deep", "BTN", ["CO", "BTN"], [...F("UTG", "HJ"), ["CO", "raise", 2.5]], [100, 125, 150, 175, 200, 250], "BTN facing a CO open; BOTH stacks vary (the deep ladder)"),
  // 1 — the size of the raise hero faces
  openCfg("open-btn-vs-co", "BTN", (s) => [...F("UTG", "HJ"), ["CO", "raise", s]], "BTN facing a CO open of this size"),
  openCfg("open-bb-vs-btn", "BB", (s) => [...F("UTG", "HJ", "CO"), ["BTN", "raise", s], ["SB", "fold"]], "BB facing a BTN open of this size"),
  openCfg("open-sb-vs-btn", "SB", (s) => [...F("UTG", "HJ", "CO"), ["BTN", "raise", s]], "SB facing a BTN open of this size"),
  openCfg("open-bb-vs-sb", "BB", (s) => [...F("UTG", "HJ", "CO", "BTN"), ["SB", "raise", s]], "BB facing an SB open of this size"),
  openCfg("open-bb-vs-utg", "BB", (s) => [["UTG", "raise", s], ...F("HJ", "CO", "BTN", "SB")], "BB facing a UTG open of this size"),
  { id: "3b-co-vs-btn", exp: 1, axis: "size", role: "3-bet", hero: "CO", ladder: [6, 6.5, 7, 7.5, 8, 8.5, 9, 10, 11, 12.5], say: "CO opened 2.5, the BTN 3-bets to this size (3-bettor in position)",
    at: (t) => ({ line: [...F("UTG", "HJ"), ["CO", "raise", 2.5], ["BTN", "raise", t], ...F("SB", "BB")], menu: menu(2.5, t / 2.5, 2.3) }) },
  { id: "3b-btn-vs-bb", exp: 1, axis: "size", role: "3-bet", hero: "BTN", ladder: [8, 9, 10, 11, 12, 13, 14, 16], say: "BTN opened 2.5, the BB 3-bets to this size",
    at: (t) => ({ line: [...F("UTG", "HJ", "CO"), ["BTN", "raise", 2.5], ["SB", "fold"], ["BB", "raise", t]], menu: menu(2.5, t / 2.5, 2.3) }) },
  { id: "3b-btn-vs-sb", exp: 1, axis: "size", role: "3-bet", hero: "BTN", ladder: [8, 9, 10, 11, 12, 13, 14, 16], say: "BTN opened 2.5, the SB 3-bets to this size",
    at: (t) => ({ line: [...F("UTG", "HJ", "CO"), ["BTN", "raise", 2.5], ["SB", "raise", t], ["BB", "fold"]], menu: menu(2.5, t / 2.5, 2.3) }) },
  { id: "4b-btn-vs-co", exp: 1, axis: "size", role: "4-bet", hero: "BTN", ladder: [17, 18.5, 20, 22, 24, 27], say: "CO opened 2.5, BTN 3-bet to 8.75, the CO 4-bets to this size",
    at: (k) => ({ line: [...F("UTG", "HJ"), ["CO", "raise", 2.5], ["BTN", "raise", 8.75], ...F("SB", "BB"), ["CO", "raise", k]], menu: menu(2.5, 3.5, k / 8.75) }) },
  { id: "4b-bb-vs-btn", exp: 1, axis: "size", role: "4-bet", hero: "BB", ladder: [20, 22, 24, 26, 28, 32], say: "BTN opened 2.5, BB 3-bet to 10, the BTN 4-bets to this size",
    at: (k) => ({ line: [...F("UTG", "HJ", "CO"), ["BTN", "raise", 2.5], ["SB", "fold"], ["BB", "raise", 10], ["BTN", "raise", k]], menu: menu(2.5, 4, k / 10) }) },
  { id: "livemenu-bb-vs-btn", exp: 1, axis: "check", role: "open", hero: "BB", ladder: [3, 4, 5], say: "the LIVE fallback tree (the raiser may open 2.5x or this size) against the single-size tree open-bb-vs-btn",
    at: (s) => ({ line: [...F("UTG", "HJ", "CO"), ["BTN", "raise", s], ["SB", "fold"]] }) },
  // 2 — the 3-bettor's stack, hero having opened
  { id: "s3b-co-vs-btn", exp: 2, axis: "stack", role: "3-bettor", hero: "CO", ladder: SHORT_LADDER, say: "CO opened 2.5, the BTN 3-bets to 8.75 (jams when short); the BTN's stack varies",
    at: (s) => ({ stacks: { BTN: s }, line: [...F("UTG", "HJ"), ["CO", "raise", 2.5], threeBet("BTN", s), ...F("SB", "BB")], menu: menu(2.5, 3.5, 2.3) }) },
  { id: "s3b-btn-vs-bb", exp: 2, axis: "stack", role: "3-bettor", hero: "BTN", ladder: SHORT_LADDER, say: "BTN opened 2.5, the BB 3-bets to 8.75 (jams when short); the BB's stack varies",
    at: (s) => ({ stacks: { BB: s }, line: [...F("UTG", "HJ", "CO"), ["BTN", "raise", 2.5], ["SB", "fold"], threeBet("BB", s)], menu: menu(2.5, 3.5, 2.3) }) },
  // 5 — what a short stack actually does (the fine ladders above are the rest of it)
  shortCfg("jam-bb-vs-btn", "jam", "BB", "BTN", (v) => [...F("UTG", "HJ", "CO"), ["BTN", "all-in", v], ["SB", "fold"]], JAM_LADDER, "BB facing a BTN open JAM of this stack"),
  shortCfg("jam-btn-vs-co", "jam", "BTN", "CO", (v) => [...F("UTG", "HJ"), ["CO", "all-in", v]], JAM_LADDER, "BTN facing a CO open JAM of this stack (two blinds still to act)"),
  shortCfg("jam-bb-vs-sb", "jam", "BB", "SB", (v) => [...F("UTG", "HJ", "CO", "BTN"), ["SB", "all-in", v]], JAM_LADDER, "BB facing an SB open JAM of this stack (blind against blind)"),
  shortCfg("bvb-sb-first", "behind", "SB", "BB", () => F("UTG", "HJ", "CO", "BTN"), [...FINE_LADDER, 5], "SB first in, blind against blind; the BB's stack varies"),
  shortCfg("bvb-bb-vs-sb-open", "raiser", "BB", "SB", () => [...F("UTG", "HJ", "CO", "BTN"), ["SB", "raise", 2.5]], FINE_LADDER, "BB facing an SB open to 2.5; the SB's stack varies"),
  shortCfg("bvb-bb-vs-sb-limp", "limper", "BB", "SB", () => [...F("UTG", "HJ", "CO", "BTN"), ["SB", "call"]], SHORT_FINE, "BB facing an SB limp; the SB's stack varies"),
  shortCfg("limp-btn-vs-co", "limper", "BTN", "CO", () => [...F("UTG", "HJ"), ["CO", "call"]], SHORT_FINE, "BTN facing a CO limp; the CO's stack varies"),
  shortCfg("minraise-bb-vs-btn", "raiser", "BB", "BTN", () => [...F("UTG", "HJ", "CO"), ["BTN", "raise", 2], ["SB", "fold"]], SHORT_FINE, "BB facing a BTN min-raise to 2; the BTN's stack varies"),
  // 4 — uneven tables
  { id: "two-raiser-bb", exp: 4, axis: "pair", role: "two seats", hero: "BTN", ladder: PAIRS, say: "BTN facing a CO open; the CO's stack AND the BB's (still to act) are off",
    at: (v) => ({ stacks: { CO: pairOf(v)[0], BB: pairOf(v)[1] }, line: [...F("UTG", "HJ"), ["CO", "raise", 2.5]] }) },
  { id: "two-btn-bb", exp: 4, axis: "pair", role: "two seats", hero: "CO", ladder: PAIRS, say: "CO first in; the BTN's stack AND the BB's are off",
    at: (v) => ({ stacks: { BTN: pairOf(v)[0], BB: pairOf(v)[1] }, line: F("UTG", "HJ") }) },
  { id: "hero-own", exp: 4, axis: "check", role: "hero", hero: "BTN", ladder: [100, 85, 70, 60, 50, 40, 30, 20, 15, 10], say: "BTN facing a CO open; HERO's own stack is this, everyone else 100",
    at: (h) => ({ stacks: { BTN: h }, line: [...F("UTG", "HJ"), ["CO", "raise", 2.5]] }) },
  { id: "even-all", exp: 4, axis: "check", role: "hero", hero: "BTN", ladder: [100, 75, 50, 30], say: "the same spot with EVERY seat at this stack (the even chart the picker reads for a hero who has not reloaded)",
    at: (d) => ({ stacks: Object.fromEntries(Object.keys(SEAT).map((p) => [p, d])), line: [...F("UTG", "HJ"), ["CO", "raise", 2.5]] }) },
];
function synthHand(heroPos: string, b: Build): ParsedHand {
  const positions: Record<number, string> = {}, dealt: Record<number, number> = {}, committed: Record<number, number> = { 5: 0.5, 6: 1 };
  for (const [pos, seat] of Object.entries(SEAT)) { positions[seat] = pos; dealt[seat] = b.stacks?.[pos] ?? 100; }
  const hero = SEAT[heroPos]!;
  const actions: any[] = [{ seatId: 5, hero: hero === 5, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 6, hero: hero === 6, type: "post-bb", street: "preflop", amount: 1 }];
  let price = 1;
  for (const [pos, type, amount] of b.line) {
    const seat = SEAT[pos]!;
    if (type === "raise" || type === "all-in") { price = amount!; committed[seat] = amount!; }
    if (type === "call") committed[seat] = price;
    actions.push({ seatId: seat, hero: seat === hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
  }
  const stacks: Record<number, number> = {};
  for (const seat of Object.values(SEAT)) stacks[seat] = dealt[seat]! - (committed[seat] ?? 0);
  return { heroSeatId: hero, heroCards: ["As", "Kd"], board: [], street: "preflop", actions, liveSeats: [1, 2, 3, 4, 5, 6], committed, potByStreet: {}, positions, stacks,
    bbCents: 200, ended: false, heroFolded: false,
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 0, toCall: Math.max(0, price - (committed[hero] ?? 0)), legalActions: [], complete: false },
  } as unknown as ParsedHand;
}
interface SweepRow { kind: "sweep"; key: string; cfg: string; exp?: number; role: string; stack: number; ts: number; secs: number;
  ok: boolean; reason?: string; treeKey?: string; line?: string; offered?: Offered[]; strat?: number[][]; evs?: number[][];
  /** hero's range at the node when he acted earlier in the line: per-combo weight (absent = every combo) */
  w?: number[]; wWhy?: string }
async function solveSweep(cfg: SweepCfg, v: number): Promise<SweepRow> {
  const t0 = Date.now();
  const base = { kind: "sweep" as const, key: `${cfg.id}@${v}`, cfg: cfg.id, exp: cfg.exp, role: cfg.role, stack: v, ts: t0 };
  const fail = (reason: string): SweepRow => ({ ...base, ok: false, reason, secs: (Date.now() - t0) / 1000 });
  const b = cfg.at(v);
  const hand = synthHand(cfg.hero, b);
  let solId: string, line: string, data: any, treeKey: string;
  if (b.menu) {
    const r = await solvePreflopWithMenus(hand, cfg.hero, b.menu);
    if (!r.ok) return fail(r.reason);
    ({ solId, line, treeKey } = r); data = r.node;
  } else {
    const ai = await solvePreflopGtowAi(hand, cfg.hero, "preflop gap study");
    if (!ai.ok) return fail(ai.reason);
    const node = await fetchNode(ai.solId, ai.usedLine);
    if ("error" in node) return fail(`node: ${node.error}`);
    solId = ai.solId; line = ai.usedLine; treeKey = ai.treeKey; data = node.data;
  }
  const sols = data.action_solutions as any[];
  if (!sols?.length) return fail(`node '${line}' offers no action`);
  const { strat, evs } = arraysOf(sols);
  // hero's range when he acted earlier in the line: the strategy of each action he took, on this tree
  let w: number[] | undefined, wWhy: string | undefined;
  const heroIdx = b.line.map((a, i) => (a[0] === cfg.hero ? i : -1)).filter((i) => i >= 0);
  if (heroIdx.length) {
    const codes = line ? line.split("-") : [];
    if (codes.length !== b.line.length) wWhy = `the walked line has ${codes.length} actions, the spot ${b.line.length}`;
    else {
      w = new Array(1326).fill(1);
      for (const i of heroIdx) {
        const n = await fetchNode(solId, codes.slice(0, i).join("-"));
        if ("error" in n) { w = undefined; wWhy = `hero's earlier node: ${n.error}`; break; }
        const prior = n.data.action_solutions as any[];
        const k = prior.findIndex((s) => String(s.action?.code) === codes[i]);
        if (k < 0) { w = undefined; wWhy = `hero's earlier action ${codes[i]} is not at its node`; break; }
        const st = arraysOf(prior).strat[k]!;
        for (let c = 0; c < 1326; c++) w[c] = w[c]! * (st[c] ?? 0);
      }
      if (w) w = w.map(r4);
    }
  }
  return { ...base, ok: true, treeKey, line, offered: offeredOf(sols), strat: strat.map((a) => a.map(r4)), evs: evs.map((a) => a.map(r4)), ...(w ? { w } : {}), ...(wWhy ? { wWhy } : {}), secs: (Date.now() - t0) / 1000 };
}

// ── the real decisions ─────────────────────────────────────────────────────────────────────────────────────────
interface Spot {
  key: string; cid: string; upto: number; heroPos: string; heroCards: string[]; heroClass: string; first: boolean;
  chart: { id: string; line: string; actions: { action: string; frequency: number }[]; note: string };
  gap: TreeGap; stratum: string;
  /** the largest size snap on the walked line: which raise it was (1 = the open, 2 = the 3-bet …) and its cell among
   *  tables whose stacks are near the chart's (null otherwise) */
  level: number; sizeStratum: string | null;
}
const classOf = (cards: string[]): string => COMBOS[comboIndex(cards[0]!, cards[1]!)]!.cls;
const BUCKETS: [string, number][] = [["1.00-1.05", 1.05], ["1.05-1.15", 1.15], ["1.15-1.25", 1.25], ["1.25-1.50", 1.5], ["1.50-2.00", 2], ["2.00+", Infinity]];
const bucketOf = (ratio: number) => BUCKETS.find(([, hi]) => ratio <= hi)![0];
const SIZE_BUCKETS: [string, number][] = [["1.00-1.03", 1.03], ["1.03-1.06", 1.06], ["1.06-1.12", 1.12], ["1.12-1.25", 1.25], ["1.25-1.50", Infinity]];
const sizeBucketOf = (ratio: number) => SIZE_BUCKETS.find(([, hi]) => ratio <= hi)![0];
const LEVELS = ["?", "open", "3-bet", "4-bet+"];
/** the seat that is OFF: the one the bound would read (treeGap's gate seat — the worst seat in the pot, else the worst
 *  behind), unless that one is exact and a seat still to act is not — then that seat */
const gateSeat = (g: TreeGap) => { const s = g.pot ?? g.stack!; return s.ratio <= 1.05 && g.stack!.ratio > 1.05 ? g.stack! : s; };
const cutAt = (hand: ParsedHand, i: number): ParsedHand => {
  const t = truncateAt(hand, i);
  // no ids: no preflop pin, no prefix prefetch, nothing keyed to this hand
  return { ...t, currentNode: { ...t.currentNode, toActIsHero: true }, clientHandId: undefined, handId: undefined } as unknown as ParsedHand;
};
async function collectSpots(): Promise<{ spots: Spot[]; stats: Record<string, number> }> {
  const db = new Database(DB, { readonly: true });
  const cids = db.query<{ cid: string }, []>(
    `SELECT DISTINCT client_hand_id cid FROM answers WHERE source = 'hrc-6max-preflop' AND session_id IS NOT NULL AND client_hand_id IS NOT NULL ORDER BY client_hand_id`).all().map((r) => r.cid);
  const q = db.query<{ data: string }, [string]>(`SELECT data FROM hands WHERE client_hand_id = ? AND status <> 'live' ORDER BY rowid DESC LIMIT 1`);
  const stats: Record<string, number> = { hands: 0, decisions: 0, notSix: 0, postIn: 0, deadSb: 0, chartRefused: 0, noMix: 0, noGap: 0, spots: 0 };
  const spots: Spot[] = [];
  for (const cid of cids) {
    const row = q.get(cid);
    if (!row) continue;
    let hand: ParsedHand;
    try { hand = normalizeHand(JSON.parse(row.data)).hand!; } catch { continue; }
    if (!hand) continue;
    stats.hands!++;
    if (hand.postIns?.length) { stats.postIn!++; continue; }
    if (repairDeadSmallBlind(hand).note) { stats.deadSb!++; continue; }
    const heroPos = hand.positions[hand.heroSeatId] ?? null;
    if (!heroPos || hand.heroCards.length !== 2) continue;
    let first = true;
    for (let i = 0; i < hand.actions.length; i++) {
      const a = hand.actions[i]!;
      if (a.street !== "preflop") break;
      if (!a.hero || /^post/.test(a.type)) continue;
      const isFirst = first; first = false;
      stats.decisions!++;
      const cut = cutAt(hand, i);
      if (!is6Handed(cut, heroPos)) { stats.notSix!++; continue; }
      let six: Awaited<ReturnType<typeof solvePreflop6max>>;
      try { six = await solvePreflop6max(cut, heroPos, ORIGIN, SIX_MAX_STRATEGY_ID); } catch { continue; }
      if (!six || !six.ok) { stats.chartRefused!++; continue; }
      if (!six.actions?.length) { stats.noMix!++; continue; }
      const gap = six.treeGap;
      if (!gap?.stack) { stats.noGap!++; continue; }
      const off = gateSeat(gap);            // a control therefore has EVERY live seat within 1.05x
      const bucket = bucketOf(off.ratio);
      // which raise was snapped: its place among the line's raises
      const raises = buildPreflopTokens(cut, heroPos).map((t) => String(t).toUpperCase()).filter((t) => /^R[\d.]+$/.test(t));
      const level = gap.size ? Math.min(3, raises.indexOf(gap.size.from.toUpperCase()) + 1) : 0;
      const nearStacks = gap.stack.ratio <= 1.15;
      spots.push({ key: `${cid}@${i}`, cid, upto: i, heroPos, heroCards: cut.heroCards, heroClass: classOf(cut.heroCards), first: isFirst,
        chart: { id: six.gametype, line: six.line ?? "", actions: six.actions, note: six.warning ?? "" }, gap,
        stratum: `${bucket === "1.00-1.05" ? "control" : off.role}|${bucket}`, level,
        sizeStratum: !nearStacks ? null : gap.size && level > 0 ? `${LEVELS[level]}|${sizeBucketOf(gap.size.ratio)}` : !gap.size && bucket === "1.00-1.05" ? "control|exact" : null });
      stats.spots!++;
    }
  }
  db.close();
  return { spots, stats };
}
/** the same number from every cell of `key` — `controlW` times that for the controls, the baseline every other cell is
 *  read against — first decisions first (they score over the whole range) */
function stratified(spots: Spot[], n: number, key: (s: Spot) => string | null, controlW = 3): Spot[] {
  let seed = 20261001; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const by = new Map<string, Spot[]>();
  for (const s of spots) { const k = key(s); if (k == null) continue; (by.get(k) ?? by.set(k, []).get(k)!).push(s); }
  const lists = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, xs]) => ({ w: name.startsWith("control") ? controlW : 1, at: 0,
    xs: xs.map((s) => [rnd(), s] as const).sort((a, b) => Number(b[1].first) - Number(a[1].first) || a[0] - b[0]).map((s) => s[1]) }));
  const out: Spot[] = [];
  while (out.length < n && lists.some((l) => l.at < l.xs.length)) {
    for (const l of lists) for (let k = 0; k < l.w && l.at < l.xs.length && out.length < n; k++) out.push(l.xs[l.at++]!);
  }
  return out;
}
const counts = (xs: Spot[], key: (s: Spot) => string | null) => { const c: Record<string, number> = {}; for (const s of xs) { const k = key(s); if (k != null) c[k] = (c[k] ?? 0) + 1; } return Object.entries(c).sort().map(([k, v]) => `${k} ${v}`).join(" · "); };
interface RealRow { kind: "real"; key: string; ts: number; secs: number; heroPos: string; heroClass: string; first: boolean; stratum: string;
  chart: Spot["chart"]; gap: TreeGap; ok: boolean; reason?: string; treeKey?: string; line?: string;
  actions?: { code: string; label: string; ev: number; aiFreq: number; chartFreq: number }[];
  /** hero's actual combo */
  loss?: number; aiSelfLoss?: number; topAgree?: boolean;
  /** hero's whole range (first decisions only): chart mix per class from the chart node, scored on every combo */
  range?: { loss: number; tvd?: number; aiSelfLoss: number; n: number; cellMatch: boolean } | null; rangeWhy?: string;
  /** chart actions with no counterpart at the exact tree's node; combos that use them are not scored */
  notOffered?: string[];
  /** exp 3: the snapped raise's level and (level | ratio) cell */
  level?: number; sizeStratum?: string | null }
async function solveReal(spot: Spot, hand: ParsedHand): Promise<RealRow> {
  const t0 = Date.now();
  const base = { kind: "real" as const, key: spot.key, ts: t0, heroPos: spot.heroPos, heroClass: spot.heroClass, first: spot.first, stratum: spot.stratum, chart: spot.chart, gap: spot.gap,
    level: spot.level, sizeStratum: spot.sizeStratum };
  const done = (r: Partial<RealRow>): RealRow => ({ ...base, ok: false, secs: (Date.now() - t0) / 1000, ...r });
  const ai = await solvePreflopGtowAi(hand, spot.heroPos, "preflop gap study");
  if (!ai.ok) return done({ reason: ai.reason });
  const node = await fetchNode(ai.solId, ai.usedLine);
  if ("error" in node) return done({ reason: `node: ${node.error}` });
  const sols = node.data.action_solutions as any[];
  const offered = offeredOf(sols);
  const { strat, evs } = arraysOf(sols);
  const idx = comboIndex(hand.heroCards[0]!, hand.heroCards[1]!);
  if (evs.some((a) => !Number.isFinite(a[idx]!))) return done({ reason: "node has no EV for hero's combo" });
  // hero's combo: the answer's own mix. An action the exact tree does not offer at this node (GTO Wizard's tree lets
  // one player cold-call: behind an open and a call, a seat that does not close the action has fold or 3-bet only)
  // cannot be scored there — the combo is left out when more than a tenth of its mix is such an action
  const chartOf: Record<string, number> = {};
  const unmapped: string[] = [];
  for (const a of spot.chart.actions) {
    const code = mapAction(a.action, offered);
    if (!code) { if (a.frequency > 0) unmapped.push(a.action); continue; }
    chartOf[code] = (chartOf[code] ?? 0) + a.frequency / 100;
  }
  const comboOk = Object.values(chartOf).reduce((s, f) => s + f, 0) > 0.9;
  const one = (m: Record<string, number>) => { const tot = Object.values(m).reduce((s, f) => s + f, 0) || 1; return offered.reduce((s, o, k) => s + ((m[o.code] ?? 0) / tot) * evs[k]![idx]!, 0); };
  const aiOf = Object.fromEntries(offered.map((o, k) => [o.code, strat[k]![idx]!]));
  const evMax = Math.max(...evs.map((a) => a[idx]!));
  const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
  // hero's whole range, when he holds all of it: the chart node's mix for every class
  let range: RealRow["range"] = null, rangeWhy: string | undefined;
  /** chart actions the exact tree's node does not offer at all (hero's combo's, or any class's) */
  let notOffered = unmapped.slice();
  if (!spot.first) rangeWhy = "not hero's first decision";
  else if (/CALLER CAP|LINE FITTED|CHART KEPT|LINE KEPT/.test(spot.chart.note)) rangeWhy = "the chart read another node (caller cap / fitted line)";
  else {
    const cn = await nodeGetter(spot.chart.id)(spot.chart.line === "(root)" ? "" : spot.chart.line);
    if (!cn || cn === "unreachable") rangeWhy = "chart node unreadable";
    else {
      const codeOf: Record<string, string | null> = {};
      for (const a of cn.actions) { codeOf[a.action] = mapAction(a.action, offered); if (!codeOf[a.action]) notOffered.push(a.action); }
      notOffered = [...new Set(notOffered)];
      const byClass = new Map<string, Record<string, number>>();
      for (const c of cn.cells) {
        const m: Record<string, number> = {};
        for (const [label, f] of Object.entries(c.actions)) { const code = codeOf[label] ?? mapAction(label, offered); if (code) m[code] = (m[code] ?? 0) + Number(f) / 100; }
        byClass.set(c.hand, m);
      }
      const mine = byClass.get(spot.heroClass) ?? {};
      const cellMatch = offered.every((o) => Math.abs((mine[o.code] ?? 0) - (chartOf[o.code] ?? 0)) < 0.02);
      const rc = rangeLoss(offered, evs, (i) => byClass.get(COMBOS[i]!.cls) ?? null, null, strat);
      const ra = rangeLoss(offered, evs, (i) => Object.fromEntries(offered.map((o, k) => [o.code, strat[k]![i] ?? 0])));
      range = rc.n >= 200 ? { loss: r4(rc.loss), tvd: r4(rc.tvd), aiSelfLoss: r4(ra.loss), n: rc.n, cellMatch } : null;
      if (!range) rangeWhy = `only ${rc.n} combos scored`;
    }
  }
  return done({ ok: true, treeKey: ai.treeKey, line: ai.usedLine,
    actions: offered.map((o, k) => ({ code: o.code, label: o.label, ev: r4(evs[k]![idx]!), aiFreq: r4(aiOf[o.code]!), chartFreq: r4(chartOf[o.code] ?? 0) })),
    ...(comboOk ? { loss: r4(evMax - one(chartOf)), topAgree: top(chartOf) === top(aiOf) } : {}), aiSelfLoss: r4(evMax - one(aiOf)), range,
    ...(rangeWhy ? { rangeWhy } : {}), ...(notOffered.length ? { notOffered } : {}) });
}

// ── files ──────────────────────────────────────────────────────────────────────────────────────────────────────
const load = <T,>(p: string): T[] => (existsSync(p) ? readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────────
const q = (xs: number[], p: number) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pc = (v: number) => (Number.isFinite(v) ? `${(100 * v).toFixed(1)}%` : "—");
type OkSweep = SweepRow & { offered: Offered[]; strat: number[][]; evs: number[][] };
const ownMix = (t: OkSweep) => (i: number) => Object.fromEntries(t.offered.map((o, k) => [o.code, t.strat[k]![i] ?? 0]));
const selfLoss = (t: OkSweep) => rangeLoss(t.offered, t.evs, ownMix(t), t.w).loss;
/** tree A's strategy played inside tree T: the EV lost above T's own (noise) and the share of the range that changes */
function played(t: OkSweep, a: OkSweep): { loss: number; tvd: number } | null {
  const codes = a.offered.map((o) => mapAction(o.label, t.offered));
  const l = rangeLoss(t.offered, t.evs, (i) => { const m: Record<string, number> = {}; a.offered.forEach((_, k) => { const c = codes[k]; if (c) m[c] = (m[c] ?? 0) + (a.strat[k]![i] ?? 0); }); return m; }, t.w, t.strat);
  return Number.isFinite(l.loss) ? { loss: l.loss - selfLoss(t), tvd: l.tvd } : null;
}
const STACK_BINS: [string, number][] = [["≤1.15x", 1.15], ["≤1.30x", 1.3], ["≤1.50x", 1.5], ["≤2.0x", 2], ["≤3.0x", 3], [">3x", Infinity]];
const SIZE_BINS: [string, number][] = [["≤1.05x", 1.05], ["≤1.10x", 1.1], ["≤1.15x", 1.15], ["≤1.25x", 1.25], ["≤1.50x", 1.5], ["≤2.0x", 2], [">2x", Infinity]];
const EXP_NAME: Record<number, string> = { 0: "one seat's stack off (first decisions)", 1: "the size of the raise hero faces", 2: "the 3-bettor's stack, hero having opened", 4: "uneven tables", 5: "short stacks, thorough: jams, blind against blind, limps, a min-raise" };
/** the depth of the TRUE stack: the same ratio is a different amount of money at 10bb and at 80bb */
const BANDS: [string, number, number][] = [["true ≤ 12.5bb", 0, 12.5], ["true 15-25bb  ", 15, 25], ["true 30-50bb  ", 30, 50], ["true 60bb+    ", 60, Infinity]];
const BAND_BINS: [string, number][] = [["≤1.15x", 1.15], ["≤1.3x", 1.3], ["≤1.5x", 1.5], ["≤2x", 2], ["≤3x", 3], [">3x", Infinity]];
function reportSweep(rows: SweepRow[]): void {
  const ok = rows.filter((r) => r.ok && r.offered && r.evs) as OkSweep[];
  const latest = new Map<string, OkSweep>(); for (const r of ok) latest.set(r.key, r);
  const of = (cfg: string) => [...latest.values()].filter((r) => r.cfg === cfg);
  const at = (cfg: string, v: number) => latest.get(`${cfg}@${v}`) ?? null;
  console.log(`\nSWEEPS — tree(read) played inside tree(true): bb lost per decision over hero's range, and the share of the range whose action changes (${latest.size} trees)`);
  for (const exp of [0, 5, 1, 2, 4]) {
    const cfgs = SWEEP.filter((c) => c.exp === exp && of(c.id).length >= 2);
    if (!cfgs.length) continue;
    console.log(`\n═══ EXPERIMENT ${exp}: ${EXP_NAME[exp]} ═══`);
    for (const cfg of cfgs) {
      const xs = of(cfg.id).sort((a, b) => b.stack - a.stack);
      console.log(`\n  ${cfg.id} [${cfg.role}] — ${cfg.say}`);
      if (cfg.axis === "stack" || cfg.axis === "size") {
        const size = cfg.axis === "size";
        const pairs: { t: number; a: number; ratio: number; loss: number; tvd: number }[] = [];
        for (const t of xs) for (const a of xs) { if (t === a) continue; const p = played(t, a); if (p) pairs.push({ t: t.stack, a: a.stack, ratio: Math.max(t.stack, a.stack) / Math.min(t.stack, a.stack), ...p }); }
        console.log(`    solved: ${xs.map((t) => t.stack).join(", ")}   (self-loss mean ${mean(xs.map(selfLoss)).toFixed(4)}${xs.some((t) => t.w) ? "; weighted by hero's range" : ""}${xs.some((t) => t.wWhy) ? `; UNWEIGHTED: ${xs.find((t) => t.wWhy)!.wWhy}` : ""})`);
        let lo = 1;
        for (const [name, hi] of size ? SIZE_BINS : STACK_BINS) {
          const up = pairs.filter((p) => p.ratio > lo && p.ratio <= hi && p.a > p.t), dn = pairs.filter((p) => p.ratio > lo && p.ratio <= hi && p.a < p.t);
          const cell = (g: typeof pairs) => (g.length ? `mean ${mean(g.map((p) => p.loss)).toFixed(3)}  max ${Math.max(...g.map((p) => p.loss)).toFixed(3)}  range changed ${pc(mean(g.map((p) => p.tvd)))}  (n ${g.length})` : "—");
          if (up.length || dn.length) console.log(`    ${name.padEnd(7)} read ${size ? "BIGGER " : "DEEPER "}: ${cell(up).padEnd(62)} read ${size ? "SMALLER" : "SHALLOWER"}: ${cell(dn)}`);
          lo = hi;
        }
        const grid = cfg.grid;
        const near = xs.map((t) => {
          if (grid?.includes(t.stack)) return "";
          const o = pairs.filter((p) => p.t === t.stack && (!grid || grid.includes(p.a))).sort((m, n) => m.ratio - n.ratio)[0];
          return o ? `${t.stack}→${o.a}: ${o.loss.toFixed(3)} (${pc(o.tvd)})` : "";
        }).filter(Boolean);
        console.log(`    ${grid ? `read on the nearest chart ${size ? "size" : "rung"} (${grid.join("/")})` : "nearest neighbour"} — true→read: loss (range changed):  ${near.join("   ")}`);
        if (!size && xs.some((t) => t.stack <= 30)) {
          // BY DEPTH: the mean (max) loss of a ratio bin among the pairs whose TRUE stack is in the band, both directions
          console.log(`    by the depth of the true stack — mean (max) per ratio:`);
          for (const [band, lo2, hi2] of BANDS) {
            const inBand = pairs.filter((p) => p.t >= lo2 && p.t <= hi2);
            if (!inBand.length) continue;
            let from = 1;
            const cells = BAND_BINS.map(([name, hi]) => { const g = inBand.filter((p) => p.ratio > from && p.ratio <= hi); from = hi; return g.length ? `${name} ${mean(g.map((p) => p.loss)).toFixed(3)} (${Math.max(...g.map((p) => p.loss)).toFixed(3)})` : null; }).filter(Boolean);
            console.log(`      ${band}  ${cells.join("   ")}`);
          }
          // the seat is not modelled at all: the chart holds it at 100bb
          const as100 = xs.filter((t) => t.stack < 100).map((t) => { const o = pairs.find((p) => p.t === t.stack && p.a === 100); return o ? `${t.stack}: ${o.loss.toFixed(3)} (${pc(o.tvd)})` : ""; }).filter(Boolean);
          if (as100.length) console.log(`    read as 100bb (the seat not modelled) — true: loss (range changed):  ${as100.join("   ")}`);
        }
      } else if (cfg.axis === "pair") {
        // the chart models the first seat; the second is read as 100bb
        for (const t of xs) {
          const [a, b] = pairOf(t.stack);
          if (b === 100) continue;
          const one = at(cfg.id, a * 1000 + 100), none = at(cfg.id, 100100);
          const p1 = one ? played(t, one) : null, p0 = none && a !== 100 ? played(t, none) : null;
          console.log(`    table ${String(a).padStart(3)} / ${String(b).padStart(3)}:  second seat read as 100: ${p1 ? `${p1.loss.toFixed(3)} (${pc(p1.tvd)})` : "—"}` + (p0 ? `   both read as 100: ${p0.loss.toFixed(3)} (${pc(p0.tvd)})` : ""));
        }
      } else if (cfg.id === "livemenu-bb-vs-btn") {
        for (const t of xs) { const s = at("open-bb-vs-btn", t.stack); const p = s ? played(s, t) : null; console.log(`    open ${t.stack}x: the live two-size tree's answer inside the single-size tree: ${p ? `${p.loss.toFixed(3)} (${pc(p.tvd)} of the range changes)` : "—"}`); }
      } else if (cfg.id === "hero-own") {
        const rung = (h: number) => [30, 50, 75, 100].reduce((m, n) => (Math.abs(n - h) < Math.abs(m - h) ? n : m));
        for (const t of xs) {
          if (t.stack === 100) continue;
          const even = at("even-all", rung(t.stack)), full = at("hero-own", 100);
          const pe = even ? played(t, even) : null, pf = full ? played(t, full) : null;
          console.log(`    hero ${String(t.stack).padStart(3)}bb:  read on the even ${rung(t.stack)}bb chart: ${pe ? `${pe.loss.toFixed(3)} (${pc(pe.tvd)})` : "—"}   read as 100bb: ${pf ? `${pf.loss.toFixed(3)} (${pc(pf.tvd)})` : "—"}`);
        }
      }
    }
  }
}
function realLine(name: string, g: RealRow[]): void {
  if (!g.length) return;
  const rr = g.filter((r) => r.range), rg = rr.map((r) => r.range!.loss), cb = g.filter((r) => r.loss != null).map((r) => r.loss!);
  console.log(`  ${name.padEnd(22)} n ${String(g.length).padStart(3)} | whole range (n ${String(rg.length).padStart(3)}): mean ${mean(rg).toFixed(3)}  p50 ${q(rg, .5).toFixed(3)}  p90 ${q(rg, .9).toFixed(3)}  changed ${pc(mean(rr.map((r) => r.range!.tvd ?? NaN).filter(Number.isFinite)))}` +
    ` | hero's combo: mean ${mean(cb).toFixed(3)}  p90 ${q(cb, .9).toFixed(3)}  top differs ${Math.round(100 * g.filter((r) => r.topAgree === false).length / Math.max(1, cb.length))}%` +
    (g.some((r) => r.notOffered?.length) ? `  | ${g.filter((r) => r.notOffered?.length).length} had a chart action the exact tree does not offer` : ""));
}
function realTail(rows: RealRow[], what: (r: RealRow) => string): void {
  const ok = rows.filter((r) => r.ok);
  const worst = ok.filter((r) => r.range).sort((a, b) => b.range!.loss - a.range!.loss).slice(0, 8);
  if (worst.length) { console.log(`\n  the costliest (whole range):`); for (const r of worst) console.log(`    ${r.range!.loss.toFixed(3)}  ${r.key} ${r.heroPos} "${r.chart.line}" on ${r.chart.id.replace(/^ign200_6max_/, "")} — ${what(r)}`); }
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) { const why: Record<string, number> = {}; for (const r of failed) { const k = (r.reason ?? "?").replace(/[\d.]+/g, "#").slice(0, 90); why[k] = (why[k] ?? 0) + 1; } console.log("\n  failures:", why); }
}
function reportRealStack(rows: RealRow[]): void {
  const ok = rows.filter((r) => r.ok);
  console.log(`\n═══ EXPERIMENT 4c: REAL DECISIONS BY STACK GAP — the chart's answer scored in the exact-stack tree (${ok.length} scored, ${rows.length - ok.length} failed) ═══`);
  console.log(`  AI self-loss (should be ≈ 0): whole range mean ${mean(ok.filter((r) => r.range).map((r) => r.range!.aiSelfLoss)).toFixed(4)}, combo mean ${mean(ok.map((r) => r.aiSelfLoss!)).toFixed(4)}`);
  realLine("CONTROL (≤1.05x)", ok.filter((r) => r.stratum.startsWith("control")));
  for (const role of ["raiser", "in", "behind"]) {
    console.log(`  — the off seat is ${role === "in" ? "a caller in the pot" : role === "raiser" ? "the raiser hero faces" : "still to act"}`);
    for (const [b] of BUCKETS.slice(1)) realLine(`  ${b}x`, ok.filter((r) => r.stratum === `${role}|${b}`));
  }
  realTail(rows, (r) => { const s = gateSeat(r.gap); return `${s.seat} (${s.role}) ${s.real}bb at the table, ${s.chart}bb in the chart, ${s.ratio}x`; });
}
function reportRealSize(rows: RealRow[]): void {
  const ok = rows.filter((r) => r.ok);
  console.log(`\n═══ EXPERIMENT 3: REAL DECISIONS BY SIZE SNAP — the chart's answer scored on the tree the live fallback builds (${ok.length} scored, ${rows.length - ok.length} failed) ═══`);
  realLine("CONTROL (exact)", ok.filter((r) => r.sizeStratum === "control|exact"));
  for (const lv of LEVELS.slice(1)) {
    console.log(`  — the snapped raise is the ${lv}`);
    for (const [b] of SIZE_BUCKETS) realLine(`  ${b}x`, ok.filter((r) => r.sizeStratum === `${lv}|${b}`));
  }
  realTail(rows, (r) => (r.gap.size ? `${LEVELS[r.level ?? 0]} ${r.gap.size.from} read as ${r.gap.size.to}, ${r.gap.size.ratio}x` : "no size snap"));
}
if (TREES) {
  for (const cfg of SWEEP.filter((c) => EXPS.includes(c.exp))) for (const v of cfg.ladder) {
    const b = cfg.at(v);
    const t = debugTree(synthHand(cfg.hero, b), cfg.hero);
    console.log("error" in t ? `${cfg.id} ${v} ERROR ${t.error}`
      : `${cfg.id.padEnd(18)} ${String(v).padStart(6)}  hero ${t.shape.heroApiPos}  line "${t.line}"  ${t.shape.positions.map((p) => `${p}:${t.shape.stacks[p]}`).join(" ")}${b.menu ? `  menu ${JSON.stringify(b.menu).replace(/"/g, "")}` : ""}`);
  }
  process.exit(0);
}
if (REPORT) { reportSweep(load<SweepRow>(SWEEP_OUT)); reportRealSize(load<RealRow>(SIZE_OUT)); reportRealStack(load<RealRow>(REAL_OUT)); process.exit(0); }

// ── plan / run ─────────────────────────────────────────────────────────────────────────────────────────────────
type Outcome = { ok: boolean; reason?: string; text: string };
interface Task { label: string; go: () => Promise<Outcome> }
const t0 = Date.now();
const sweepDone = new Set(load<SweepRow>(SWEEP_OUT).filter((r) => r.ok).map((r) => r.key));
/** a failure that says nothing about the spot (the network, a token, a rate limit): asked again, never written */
const transient = (reason: string | undefined) => NETWORK.test(reason ?? "") || /no token/i.test(reason ?? "") || RATE_LIMIT.test(reason ?? "");
/** an experiment's trees in ladder order across its spots, so a partial run still has every spot */
const sweepTasks = (exp: number): Task[] => {
  const cfgs = SWEEP.filter((c) => c.exp === exp);
  const out: Task[] = [];
  for (let k = 0; k < Math.max(0, ...cfgs.map((c) => c.ladder.length)); k++) for (const cfg of cfgs) {
    const v = cfg.ladder[k];
    if (v == null || sweepDone.has(`${cfg.id}@${v}`)) continue;
    out.push({ label: `exp ${exp} tree ${cfg.id}@${v}`, go: async () => {
      const row = await solveSweep(cfg, v);
      if (!row.ok && transient(row.reason)) return { ok: false, reason: row.reason, text: `FAILED ${row.reason}` };
      appendFileSync(SWEEP_OUT, JSON.stringify(row) + "\n");
      return { ok: row.ok, reason: row.reason, text: row.ok
        ? `${row.offered!.map((o) => o.label).join(" / ")} at "${row.line}"${row.w ? ` (hero's range ${Math.round(row.w.reduce((a, b) => a + b, 0))} combos)` : ""}${row.wWhy ? ` [unweighted: ${row.wWhy}]` : ""} ${row.secs.toFixed(1)} s`
        : `FAILED ${row.reason!.slice(0, 160)}` };
    } });
  }
  return out;
};
const handQ = (cid: string): ParsedHand | null => dbRead((db) => {
  const raw = db.query<{ data: string }, [string]>(`SELECT data FROM hands WHERE client_hand_id = ? AND status <> 'live' ORDER BY rowid DESC LIMIT 1`).get(cid);
  try { return raw ? normalizeHand(JSON.parse(raw.data)).hand ?? null : null; } catch { return null; }
});
const realTasks = (exp: string, queue: Spot[], out: string, tag: (s: Spot) => string): Task[] => queue.map((spot) => ({
  label: `exp ${exp} ${spot.key} ${spot.heroPos} ${spot.heroClass} "${spot.chart.line}" ${tag(spot)}`,
  go: async () => {
    const hand = handQ(spot.cid);
    let row: RealRow;
    if (!hand) row = { kind: "real", key: spot.key, ts: Date.now(), secs: 0, heroPos: spot.heroPos, heroClass: spot.heroClass, first: spot.first, stratum: spot.stratum, chart: spot.chart, gap: spot.gap, ok: false, reason: "hand not found" };
    else row = await solveReal(spot, cutAt(hand, spot.upto));
    if (!row.ok && transient(row.reason)) return { ok: false, reason: row.reason, text: `FAILED ${row.reason}` };
    appendFileSync(out, JSON.stringify(row) + "\n");
    return { ok: row.ok, reason: row.reason, text: row.ok
      ? `range loss ${row.range ? `${row.range.loss.toFixed(3)} over ${row.range.n} combos` : `n/a (${row.rangeWhy})`}, combo ${row.loss != null ? row.loss.toFixed(3) : "n/a"} (AI self ${row.aiSelfLoss!.toFixed(4)})${row.notOffered?.length ? ` [not offered: ${row.notOffered.join("/")}]` : ""} ${row.secs.toFixed(1)} s`
      : `FAILED ${row.reason!.slice(0, 160)}` };
  },
}));

let spots: Spot[] = [];
if (EXPS.includes(3) || EXPS.includes(4)) {
  const c = await collectSpots();
  spots = c.spots;
  log(`pass 1 in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${JSON.stringify(c.stats)}`);
}
const tasks: Task[] = [];
for (const exp of EXPS) {
  if (exp === 3) {
    const done = new Set(load<RealRow>(SIZE_OUT).map((r) => r.key));
    log(`exp 3 pool, near-stack tables by (level | size ratio): ${counts(spots, (s) => s.sizeStratum)}`);
    const sample = stratified(spots, REAL_SIZE, (s) => s.sizeStratum, 2);
    log(`exp 3 sample of ${sample.length}: ${counts(sample, (s) => s.sizeStratum)}`);
    tasks.push(...realTasks("3", sample.filter((s) => !done.has(s.key)), SIZE_OUT, (s) => `${s.sizeStratum}${s.gap.size ? ` (${s.gap.size.from}→${s.gap.size.to})` : ""}`));
  } else if (exp === 4) {
    tasks.push(...sweepTasks(4));
    const done = new Set(load<RealRow>(REAL_OUT).map((r) => r.key));
    const sample = stratified(spots, REAL_STACK, (s) => s.stratum);
    log(`exp 4c sample of ${sample.length}: ${counts(sample, (s) => s.stratum)} (${sample.filter((s) => done.has(s.key)).length} already done)`);
    tasks.push(...realTasks("4c", sample.filter((s) => !done.has(s.key)), REAL_OUT, (s) => { const g = gateSeat(s.gap); return `${s.stratum} (${g.seat} ${g.real}→${g.chart}bb)`; }));
  } else tasks.push(...sweepTasks(exp));
}
/** --only <text>: just the spots whose label holds it (a smoke test of one tree) */
const ONLY = argv.includes("--only") ? String(argv[argv.indexOf("--only") + 1]) : null;
const picked = ONLY ? tasks.filter((t) => ONLY.split(",").some((o) => t.label.includes(o))) : tasks;
const todo = LIMIT ? picked.slice(0, LIMIT) : picked;
const perExp: Record<string, number> = {};
for (const t of todo) { const k = t.label.split(" ").slice(0, 2).join(" "); perExp[k] = (perExp[k] ?? 0) + 1; }
log(`to do: ${Object.entries(perExp).map(([k, v]) => `${k}: ${v}`).join(" · ")} = ${todo.length} spots, one every ${EVERY} s ≈ ${(todo.length * EVERY / 3600).toFixed(1)} h; ` +
  `hour cap ${HOUR_CAP} (Ultra has ${hourCount()} in the trailing hour), budget ${BUDGET} requests`);
if (PLAN || !RUN) process.exit(0);

mkdirSync(OUT_DIR, { recursive: true });
/**
 * A MISSED TOKEN IS NOT A RESULT, NOR IS A NETWORK DROP. The token is read off the GTO Wizard browser and expires every
 * ~15 minutes; a read that misses holds off for a minute (gtowSessions SNIFF_FAIL_HOLD_MS). The run of 2026-10-01 died on
 * `getaddrinfo ENOTFOUND api.gtowizard.com` thrown out of the tree POST. Either waits and asks the same spot again — a
 * token 4 times, the network for 40 minutes; "stop" = the network stayed down or it reads like a rate limit.
 */
async function withRetry(go: Task["go"]): Promise<Outcome | "stop"> {
  let tokenTries = 0, netTries = 0;
  for (;;) {
    let r: Outcome;
    try { r = await go(); } catch (e) { const m = e instanceof Error ? e.message : String(e); r = { ok: false, reason: `threw: ${m}`, text: `FAILED threw: ${m.slice(0, 160)}` }; }
    if (r.ok) return r;
    const reason = r.reason ?? "";
    if (RATE_LIMIT.test(reason)) { log(`STOP: this reads like a rate limit — ${reason.slice(0, 200)}`); return "stop"; }
    if (/no token/i.test(reason) && tokenTries < 4) { log(`  no token yet — waiting 70 s and asking the same spot again (${++tokenTries}/4)`); await sleep(70_000); continue; }
    if (NETWORK.test(reason)) {
      if (netTries >= 40) { log(`STOP: the network has been down for 40 minutes — ${reason.slice(0, 160)}`); return "stop"; }
      log(`  network trouble (${reason.slice(0, 100)}) — waiting 60 s and asking the same spot again (${++netTries}/40)`);
      await sleep(60_000); continue;
    }
    return r;
  }
}
let n = 0, fails = 0, streak = 0;
for (const task of todo) {
  if (!(await gate(t0))) break;
  const started = Date.now();
  const r = await withRetry(task.go);
  if (r === "stop") break;
  n++;
  log(`[${n}/${todo.length}] ${task.label}: ${r.text}  (${ownSince(t0)} requests)`);
  if (!r.ok) { fails++; streak++; if (streak >= 12) { log("STOP: twelve spots in a row failed"); break; } } else streak = 0;
  await sleep(Math.max(0, EVERY * 1000 - (Date.now() - started)));
}
log(`done: ${n} spots this run (${fails} failed), ${ownSince(t0)} requests`);
reportSweep(load<SweepRow>(SWEEP_OUT)); reportRealSize(load<RealRow>(SIZE_OUT)); reportRealStack(load<RealRow>(REAL_OUT));
process.exit(0);
