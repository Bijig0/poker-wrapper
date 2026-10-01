/**
 * STACK-GAP STUDY (2026-10-01) — WHEN IS A CHART'S STACK "CLOSE ENOUGH"? Measured in EV against the exact GTO Wizard
 * AI tree, which Brady takes as the truth. Calibrates the log-only stack bound (services/treeGap).
 *
 * Two measurements, one paced run (supersedes scripts/stackSnapAudit.ts, whose pass 2 never ran):
 *
 *   1. THE SWEEP — AI against AI. One synthetic 6-handed spot per ROLE of the off-stack seat (the raiser hero faces, a
 *      caller in the pot, a seat still to act, a deep pair), solved at a ladder of stacks. Tree(s') played inside
 *      tree(s) is exactly "the table has s, we read s'": no chart, no menu difference, only the stack. Every ordered
 *      pair of the ladder comes from the same trees, so 66 trees give ~600 (true, assumed) pairs — the clean
 *      loss-vs-ratio curve per role.
 *   2. THE REAL DECISIONS — chart against AI. Logged hero preflop decisions, sampled evenly across (role × ratio)
 *      from the chart answer's treeGap, each solved at the table's own stacks. Ratio ≤ 1.05 on every live seat is the
 *      CONTROL: chart and AI differ a little even at equal stacks (different size menus), and a stack gap only counts
 *      for what it loses above that.
 *
 * THE SCORE is the EV the answer gives up at hero's node, the exact tree's continuation taken as given:
 *   loss = mean over combos of ( max_a EV[a] − Σ_a mix[a]·EV[a] )
 * over hero's WHOLE RANGE when this is his first decision of the hand (he holds every combo with equal weight; one
 * node read carries all 1,326 EVs), and for his actual combo always. The AI's own mix scored the same way (≈ 0) is the
 * check on units and on the action mapping.
 *
 * SAFE TO LEAVE RUNNING: one spot every --every seconds (default 45); before each spot it WAITS while a poker session
 * is live, waits while the Ultra account has more than --hour-cap requests in the trailing hour (the wall is 2,250),
 * stops at --budget requests of its own, and stops dead on anything that reads like a rate limit. Files nothing
 * (origin "audit", ids stripped: no pin, no miss rows). Results append to POKER_DATA_DIR/audits/stack-sweep.jsonl and
 * stack-gap-real.jsonl; a re-run skips what is already there.
 *
 *   bun src/scripts/stackGapStudy.ts --plan                     what would run, no requests
 *   bun src/scripts/stackGapStudy.ts --trees                    the sweep's trees and lines as they would be built, no requests
 *   bun src/scripts/stackGapStudy.ts --run [--spots 300] [--every 45] [--hour-cap 900] [--budget 2200] [--sweep-only|--real-only]
 *   bun src/scripts/stackGapStudy.ts --report
 */
process.env.GTOW_REQUEST_ORIGIN ??= "stackGapStudy";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt } from "../utils/archivedHand/archivedHand";
import { repairDeadSmallBlind } from "../utils/repairPostflopRotation/repairPostflopRotation";
import { comboIndex, COMBOS } from "../utils/comboIndex/comboIndex";
import { is6Handed, solvePreflop6max } from "../services/fastSolve";
import { nodeGetter } from "../services/hrc6max";
import { SIX_MAX_STRATEGY_ID } from "../services/strategies";
import { solvePreflopGtowAi, fetchNode, debugTree } from "../services/gtowAiPreflop";
import type { TreeGap } from "../services/treeGap";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const num = (n: string, d: number) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) || d : d; };
const PLAN = flag("--plan"), RUN = flag("--run"), REPORT = flag("--report");
const SPOTS = num("--spots", 300), EVERY = num("--every", 45), HOUR_CAP = num("--hour-cap", 900), BUDGET = num("--budget", 2200);
const SWEEP_ONLY = flag("--sweep-only"), REAL_ONLY = flag("--real-only");
const API = process.env.STUDY_API ?? "http://127.0.0.1:2000";
const DATA = process.env.POKER_DATA_DIR ?? "C:\\Users\\Brady\\poker-data";
const DB = join(DATA, "poker.sqlite");
const OUT_DIR = join(DATA, "audits");
const SWEEP_OUT = join(OUT_DIR, "stack-sweep.jsonl"), REAL_OUT = join(OUT_DIR, "stack-gap-real.jsonl");
const ORIGIN = "audit";   // not in missQueue's REAL_SOLVE_ORIGINS: files nothing
const log = (s: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

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
 * The EV given up over every combo by playing `mix` (combo → offered code → fraction) at a node with `evs`.
 * Combos the node has no EV for (or `mix` has nothing for) are left out. Returns the mean loss and how many counted.
 */
function rangeLoss(offered: Offered[], evs: number[][], mix: (i: number) => Record<string, number> | null): { loss: number; n: number } {
  let sum = 0, n = 0;
  for (let i = 0; i < 1326; i++) {
    let best = -Infinity, ok = true;
    for (const a of evs) { const v = a[i]; if (v == null || !Number.isFinite(v)) { ok = false; break; } if (v > best) best = v; }
    if (!ok) continue;
    const m = mix(i);
    if (!m) continue;
    let tot = 0, ev = 0;
    offered.forEach((o, k) => { const f = m[o.code] ?? 0; tot += f; ev += f * evs[k]![i]!; });
    if (!(tot > 0.9)) continue;       // the mix has an action this node does not offer (the AI tree's caller cap): not scoreable
    sum += best - ev / tot; n++;
  }
  return { loss: n ? sum / n : NaN, n };
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
/** wait until it is safe to spend one more spot; false = stop the run */
async function gate(t0: number): Promise<boolean> {
  let said = "", notUp = 0;
  const say = (s: string) => { if (s !== said) { log(s); said = s; } };
  for (;;) {
    const used = ownSince(t0);
    if (used >= BUDGET) { log(`budget reached (${used} requests of ${BUDGET}) — stopping; re-run to continue`); return false; }
    const live = liveSession();
    if (live) { say(`PAUSED: session ${live} is live — waiting for it to end`); await sleep(60_000); continue; }
    const h = hourCount();
    if (h >= HOUR_CAP) { say(`PAUSED: Ultra has ${h} requests in the trailing hour (cap ${HOUR_CAP}) — waiting`); await sleep(60_000); continue; }
    const g = await ultraUp();
    if (g.walled) { log(`STOP: ${g.why}`); return false; }
    if (!g.ok) { if (++notUp > 20) { log(`STOP: ${g.why} for 20 minutes`); return false; } say(`waiting: ${g.why}`); await sleep(60_000); continue; }
    return true;
  }
}

// ── 1. the sweep ───────────────────────────────────────────────────────────────────────────────────────────────
const SEAT: Record<string, number> = { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 };
type Act = [pos: string, type: "fold" | "raise" | "call", amount?: number];
interface SweepCfg { id: string; role: "raiser" | "in" | "behind" | "deep"; hero: string; vary: string[]; line: Act[]; ladder: number[]; say: string }
const SHORT_LADDER = [100, 90, 80, 70, 60, 50, 40, 30, 25, 20, 15, 10];
const SWEEP: SweepCfg[] = [
  { id: "raiser-co", role: "raiser", hero: "BTN", vary: ["CO"], line: [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5]], ladder: SHORT_LADDER, say: "BTN facing a CO open; the CO's stack varies" },
  { id: "caller-btn", role: "in", hero: "SB", vary: ["BTN"], line: [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5], ["BTN", "call", 2.5]], ladder: SHORT_LADDER, say: "SB facing a CO open and a BTN call; the BTN's stack varies (hand 4921874909)" },
  { id: "behind-bb", role: "behind", hero: "BTN", vary: ["BB"], line: [["UTG", "fold"], ["HJ", "fold"], ["CO", "fold"]], ladder: SHORT_LADDER, say: "BTN first in; the BB's stack varies" },
  { id: "behind-btn", role: "behind", hero: "CO", vary: ["BTN"], line: [["UTG", "fold"], ["HJ", "fold"]], ladder: SHORT_LADDER, say: "CO first in; the BTN's stack varies" },
  { id: "raiser-btn-vs-bb", role: "raiser", hero: "BB", vary: ["BTN"], line: [["UTG", "fold"], ["HJ", "fold"], ["CO", "fold"], ["BTN", "raise", 2.5], ["SB", "fold"]], ladder: SHORT_LADDER, say: "BB facing a BTN open; the BTN's stack varies" },
  { id: "deep-pair", role: "deep", hero: "BTN", vary: ["CO", "BTN"], line: [["UTG", "fold"], ["HJ", "fold"], ["CO", "raise", 2.5]], ladder: [100, 125, 150, 175, 200, 250, 300], say: "BTN facing a CO open; BOTH stacks vary (the deep ladder)" },
];
function synthHand(cfg: SweepCfg, stack: number): ParsedHand {
  const positions: Record<number, string> = {}, dealt: Record<number, number> = {}, committed: Record<number, number> = { 5: 0.5, 6: 1 };
  for (const [pos, seat] of Object.entries(SEAT)) { positions[seat] = pos; dealt[seat] = cfg.vary.includes(pos) ? stack : 100; }
  const actions: any[] = [{ seatId: 5, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 6, hero: false, type: "post-bb", street: "preflop", amount: 1 }];
  let price = 1;
  for (const [pos, type, amount] of cfg.line) {
    const seat = SEAT[pos]!;
    if (type === "raise") { price = amount!; committed[seat] = amount!; }
    if (type === "call") committed[seat] = price;
    actions.push({ seatId: seat, hero: false, type, street: "preflop", ...(amount != null ? { amount } : {}) });
  }
  const hero = SEAT[cfg.hero]!;
  const stacks: Record<number, number> = {};
  for (const seat of Object.values(SEAT)) stacks[seat] = dealt[seat]! - (committed[seat] ?? 0);
  return { heroSeatId: hero, heroCards: ["As", "Kd"], board: [], street: "preflop", actions, liveSeats: [1, 2, 3, 4, 5, 6], committed, potByStreet: {}, positions, stacks,
    bbCents: 200, ended: false, heroFolded: false,
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 0, toCall: Math.max(0, price - (committed[hero] ?? 0)), legalActions: [], complete: false },
  } as unknown as ParsedHand;
}
interface SweepRow { kind: "sweep"; key: string; cfg: string; role: string; stack: number; ts: number; secs: number;
  ok: boolean; reason?: string; treeKey?: string; line?: string; offered?: Offered[]; strat?: number[][]; evs?: number[][] }
async function solveSweep(cfg: SweepCfg, stack: number): Promise<SweepRow> {
  const t0 = Date.now();
  const base = { kind: "sweep" as const, key: `${cfg.id}@${stack}`, cfg: cfg.id, role: cfg.role, stack, ts: t0 };
  const ai = await solvePreflopGtowAi(synthHand(cfg, stack), cfg.hero, "stack-gap sweep");
  if (!ai.ok) return { ...base, ok: false, reason: ai.reason, secs: (Date.now() - t0) / 1000 };
  const node = await fetchNode(ai.solId, ai.usedLine);
  if ("error" in node) return { ...base, ok: false, reason: `node: ${node.error}`, secs: (Date.now() - t0) / 1000 };
  const sols = node.data.action_solutions as any[];
  const { strat, evs } = arraysOf(sols);
  return { ...base, ok: true, treeKey: ai.treeKey, line: ai.usedLine, offered: offeredOf(sols), strat: strat.map((a) => a.map(r4)), evs: evs.map((a) => a.map(r4)), secs: (Date.now() - t0) / 1000 };
}

// ── 2. the real decisions ──────────────────────────────────────────────────────────────────────────────────────
interface Spot {
  key: string; cid: string; upto: number; heroPos: string; heroCards: string[]; heroClass: string; first: boolean;
  chart: { id: string; line: string; actions: { action: string; frequency: number }[]; note: string };
  gap: TreeGap; stratum: string;
}
const classOf = (cards: string[]): string => COMBOS[comboIndex(cards[0]!, cards[1]!)]!.cls;
const BUCKETS: [string, number][] = [["1.00-1.05", 1.05], ["1.05-1.15", 1.15], ["1.15-1.25", 1.25], ["1.25-1.50", 1.5], ["1.50-2.00", 2], ["2.00+", Infinity]];
const bucketOf = (ratio: number) => BUCKETS.find(([, hi]) => ratio <= hi)![0];
/** the seat that is OFF: the one the bound would read (treeGap's gate seat — the worst seat in the pot, else the worst
 *  behind), unless that one is exact and a seat still to act is not — then that seat */
const gateSeat = (g: TreeGap) => { const x = g.pot ?? g.stack!; return x.ratio <= 1.05 && g.stack!.ratio > 1.05 ? g.stack! : x; };
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
      const x = gateSeat(gap);            // a control therefore has EVERY live seat within 1.05x
      const bucket = bucketOf(x.ratio);
      spots.push({ key: `${cid}@${i}`, cid, upto: i, heroPos, heroCards: cut.heroCards, heroClass: classOf(cut.heroCards), first: isFirst,
        chart: { id: six.gametype, line: six.line ?? "", actions: six.actions, note: six.warning ?? "" }, gap,
        stratum: `${bucket === "1.00-1.05" ? "control" : x.role}|${bucket}` });
      stats.spots!++;
    }
  }
  db.close();
  return { spots, stats };
}
/** the same number from every (role × ratio) cell — three times that for the controls, the baseline every other cell is
 *  read against — first decisions first (they score over the whole range) */
function stratified(spots: Spot[], n: number): Spot[] {
  let seed = 20261001; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const by = new Map<string, Spot[]>();
  for (const s of spots) (by.get(s.stratum) ?? by.set(s.stratum, []).get(s.stratum)!).push(s);
  const lists = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, xs]) => ({ w: name.startsWith("control") ? 3 : 1, at: 0,
    xs: xs.map((x) => [rnd(), x] as const).sort((a, b) => Number(b[1].first) - Number(a[1].first) || a[0] - b[0]).map((x) => x[1]) }));
  const out: Spot[] = [];
  while (out.length < n && lists.some((l) => l.at < l.xs.length)) {
    for (const l of lists) for (let k = 0; k < l.w && l.at < l.xs.length && out.length < n; k++) out.push(l.xs[l.at++]!);
  }
  return out;
}
interface RealRow { kind: "real"; key: string; ts: number; secs: number; heroPos: string; heroClass: string; first: boolean; stratum: string;
  chart: Spot["chart"]; gap: TreeGap; ok: boolean; reason?: string; treeKey?: string; line?: string;
  actions?: { code: string; label: string; ev: number; aiFreq: number; chartFreq: number }[];
  /** hero's actual combo */
  loss?: number; aiSelfLoss?: number; topAgree?: boolean;
  /** hero's whole range (first decisions only): chart mix per class from the chart node, scored on every combo */
  range?: { loss: number; aiSelfLoss: number; n: number; cellMatch: boolean } | null; rangeWhy?: string;
  /** chart actions with no counterpart at the exact tree's node; combos that use them are not scored */
  notOffered?: string[] }
async function solveReal(spot: Spot, hand: ParsedHand): Promise<RealRow> {
  const t0 = Date.now();
  const base = { kind: "real" as const, key: spot.key, ts: t0, heroPos: spot.heroPos, heroClass: spot.heroClass, first: spot.first, stratum: spot.stratum, chart: spot.chart, gap: spot.gap };
  const done = (x: Partial<RealRow>): RealRow => ({ ...base, ok: false, secs: (Date.now() - t0) / 1000, ...x });
  const ai = await solvePreflopGtowAi(hand, spot.heroPos, "stack-gap study");
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
  const comboOk = Object.values(chartOf).reduce((x, f) => x + f, 0) > 0.9;
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
      const rc = rangeLoss(offered, evs, (i) => byClass.get(COMBOS[i]!.cls) ?? null);
      const ra = rangeLoss(offered, evs, (i) => Object.fromEntries(offered.map((o, k) => [o.code, strat[k]![i] ?? 0])));
      range = rc.n >= 200 ? { loss: r4(rc.loss), aiSelfLoss: r4(ra.loss), n: rc.n, cellMatch } : null;
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
function reportSweep(rows: SweepRow[]): void {
  const ok = rows.filter((r) => r.ok);
  console.log(`\nSWEEP — tree(assumed stack) played inside tree(true stack), bb lost per decision over hero's whole range (${ok.length} trees, ${rows.length - ok.length} failed)`);
  const RB: [string, number][] = [["≤1.15x", 1.15], ["≤1.30x", 1.3], ["≤1.50x", 1.5], ["≤2.0x", 2], ["≤3.0x", 3], [">3x", Infinity]];
  for (const cfg of SWEEP) {
    const xs = ok.filter((r) => r.cfg === cfg.id).sort((a, b) => b.stack - a.stack);
    if (xs.length < 2) continue;
    const self = new Map(xs.map((t) => [t.stack, rangeLoss(t.offered!, t.evs!, (i) => Object.fromEntries(t.offered!.map((o, k) => [o.code, t.strat![k]![i] ?? 0]))).loss]));
    const pairs: { t: number; a: number; ratio: number; loss: number }[] = [];
    for (const t of xs) for (const a of xs) {
      if (t === a) continue;
      const codes = a.offered!.map((o) => mapAction(o.label, t.offered!));
      const l = rangeLoss(t.offered!, t.evs!, (i) => { const m: Record<string, number> = {}; a.offered!.forEach((_, k) => { const c = codes[k]; if (c) m[c] = (m[c] ?? 0) + (a.strat![k]![i] ?? 0); }); return m; });
      if (Number.isFinite(l.loss)) pairs.push({ t: t.stack, a: a.stack, ratio: Math.max(t.stack, a.stack) / Math.min(t.stack, a.stack), loss: l.loss - (self.get(t.stack) ?? 0) });
    }
    console.log(`\n  ${cfg.id} [${cfg.role}] — ${cfg.say}\n    stacks solved: ${xs.map((t) => t.stack).join(", ")}   (self-loss mean ${mean([...self.values()]).toFixed(4)})`);
    let lo = 1;
    for (const [name, hi] of RB) {
      const deeper = pairs.filter((p) => p.ratio > lo && p.ratio <= hi && p.a > p.t), shallower = pairs.filter((p) => p.ratio > lo && p.ratio <= hi && p.a < p.t);
      const cell = (g: typeof pairs) => (g.length ? `mean ${mean(g.map((p) => p.loss)).toFixed(3)}  max ${Math.max(...g.map((p) => p.loss)).toFixed(3)}  (n ${g.length})` : "—");
      console.log(`    ${name.padEnd(7)} read DEEPER than the table: ${cell(deeper).padEnd(36)} read SHALLOWER: ${cell(shallower)}`);
      lo = hi;
    }
    // the rungs the picker actually reads: each true stack against its nearest OTHER solved stack
    const near = xs.map((t) => { const o = pairs.filter((p) => p.t === t.stack).sort((x, y) => x.ratio - y.ratio)[0]; return o ? `${t.stack}→${o.a}: ${o.loss.toFixed(3)}` : ""; }).filter(Boolean);
    console.log(`    nearest neighbour (true→read: loss):  ${near.join("   ")}`);
  }
}
function reportReal(rows: RealRow[]): void {
  const ok = rows.filter((r) => r.ok);
  console.log(`\nREAL DECISIONS — the chart's answer scored in the exact-stack tree (${ok.length} scored, ${rows.length - ok.length} failed)`);
  const line = (name: string, g: RealRow[]) => {
    if (!g.length) return;
    const rg = g.filter((r) => r.range).map((r) => r.range!.loss), cb = g.filter((r) => r.loss != null).map((r) => r.loss!);
    console.log(`  ${name.padEnd(22)} n ${String(g.length).padStart(3)} | whole range (n ${String(rg.length).padStart(3)}): mean ${mean(rg).toFixed(3)}  p50 ${q(rg, .5).toFixed(3)}  p90 ${q(rg, .9).toFixed(3)}` +
      ` | hero's combo: mean ${mean(cb).toFixed(3)}  p90 ${q(cb, .9).toFixed(3)}  top differs ${Math.round(100 * g.filter((r) => r.topAgree === false).length / Math.max(1, cb.length))}%` +
      (g.some((r) => r.notOffered?.length) ? `  | ${g.filter((r) => r.notOffered?.length).length} had a chart action the exact tree does not offer` : ""));
  };
  console.log(`  AI self-loss (should be ≈ 0): whole range mean ${mean(ok.filter((r) => r.range).map((r) => r.range!.aiSelfLoss)).toFixed(4)}, combo mean ${mean(ok.map((r) => r.aiSelfLoss!)).toFixed(4)}`);
  line("CONTROL (≤1.05x)", ok.filter((r) => r.stratum.startsWith("control")));
  for (const role of ["raiser", "in", "behind"]) {
    console.log(`  — the off seat is ${role === "in" ? "a caller in the pot" : role === "raiser" ? "the raiser hero faces" : "still to act"}`);
    for (const [b] of BUCKETS.slice(1)) line(`  ${b}x`, ok.filter((r) => r.stratum === `${role}|${b}`));
  }
  const worst = ok.filter((r) => r.range).sort((a, b) => b.range!.loss - a.range!.loss).slice(0, 10);
  if (worst.length) {
    console.log(`\n  the costliest (whole range):`);
    for (const r of worst) { const x = gateSeat(r.gap); console.log(`    ${r.range!.loss.toFixed(3)}  ${r.key} ${r.heroPos} "${r.chart.line}" on ${r.chart.id.replace(/^ign200_6max_/, "")} — ${x.seat} (${x.role}) ${x.real}bb at the table, ${x.chart}bb in the chart, ${x.ratio}x`); }
  }
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) { const why: Record<string, number> = {}; for (const r of failed) { const k = (r.reason ?? "?").replace(/[\d.]+/g, "#").slice(0, 90); why[k] = (why[k] ?? 0) + 1; } console.log("\n  failures:", why); }
}
if (flag("--trees")) {
  for (const cfg of SWEEP) for (const stack of cfg.ladder) {
    const t = debugTree(synthHand(cfg, stack), cfg.hero);
    console.log("error" in t ? `${cfg.id} ${stack} ERROR ${t.error}`
      : `${cfg.id.padEnd(18)} ${String(stack).padStart(3)}  hero ${t.shape.heroApiPos}  line "${t.line}"  ${t.shape.positions.map((p) => `${p}:${t.shape.stacks[p]}`).join(" ")}  rake cap ${t.shape.rakeCapBb}`);
  }
  process.exit(0);
}
if (REPORT) { reportSweep(load<SweepRow>(SWEEP_OUT)); reportReal(load<RealRow>(REAL_OUT)); process.exit(0); }

// ── plan / run ─────────────────────────────────────────────────────────────────────────────────────────────────
// the sweep in ladder order across configs (100bb everywhere first), so a partial run still has every role
const sweepQueue: { cfg: SweepCfg; stack: number }[] = [];
for (let k = 0; k < Math.max(...SWEEP.map((c) => c.ladder.length)); k++) for (const cfg of SWEEP) if (k < cfg.ladder.length) sweepQueue.push({ cfg, stack: cfg.ladder[k]! });
const sweepDone = new Set(load<SweepRow>(SWEEP_OUT).filter((r) => r.ok).map((r) => r.key));
const realRows = load<RealRow>(REAL_OUT);
const realDone = new Set(realRows.map((r) => r.key));
const sweepTodo = REAL_ONLY ? [] : sweepQueue.filter((s) => !sweepDone.has(`${s.cfg.id}@${s.stack}`));
const realTarget = SWEEP_ONLY ? 0 : Math.max(0, SPOTS - (REAL_ONLY ? 0 : sweepQueue.length));

const t0 = Date.now();
let realQueue: Spot[] = [];
if (realTarget > 0) {
  const { spots, stats } = await collectSpots();
  log(`pass 1 in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${JSON.stringify(stats)}`);
  const by: Record<string, number> = {};
  for (const s of spots) by[s.stratum] = (by[s.stratum] ?? 0) + 1;
  log(`chart decisions by (role | ratio): ${Object.entries(by).sort().map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  realQueue = stratified(spots, realTarget).filter((s) => !realDone.has(s.key));
  const picked: Record<string, number> = {};
  for (const s of stratified(spots, realTarget)) picked[s.stratum] = (picked[s.stratum] ?? 0) + 1;
  log(`sample of ${realTarget}: ${Object.entries(picked).sort().map(([k, v]) => `${k} ${v}`).join(" · ")}`);
}
const total = sweepTodo.length + realQueue.length;
log(`to do: ${sweepTodo.length} sweep trees + ${realQueue.length} real decisions = ${total} spots, one every ${EVERY} s ≈ ${(total * EVERY / 3600).toFixed(1)} h; ` +
  `hour cap ${HOUR_CAP} (Ultra has ${hourCount()} in the trailing hour), budget ${BUDGET} requests`);
if (PLAN || !RUN) process.exit(0);

mkdirSync(OUT_DIR, { recursive: true });
const handQ = (cid: string): ParsedHand | null => dbRead((db) => {
  const raw = db.query<{ data: string }, [string]>(`SELECT data FROM hands WHERE client_hand_id = ? AND status <> 'live' ORDER BY rowid DESC LIMIT 1`).get(cid);
  try { return raw ? normalizeHand(JSON.parse(raw.data)).hand ?? null : null; } catch { return null; }
});
let n = 0, fails = 0;
const pace = async (started: number) => sleep(Math.max(0, EVERY * 1000 - (Date.now() - started)));
const stopOn = (reason: string | undefined): boolean => {
  if (reason && RATE_LIMIT.test(reason)) { log(`STOP: this reads like a rate limit — ${reason.slice(0, 200)}`); return true; }
  return false;
};
run: {
  for (const { cfg, stack } of sweepTodo) {
    if (!(await gate(t0))) break run;
    const started = Date.now();
    const row = await solveSweep(cfg, stack);
    appendFileSync(SWEEP_OUT, JSON.stringify(row) + "\n");
    n++;
    log(`[${n}/${total}] sweep ${row.key}: ${row.ok ? `${row.offered!.map((o) => o.label).join(" / ")} at "${row.line}" ${row.secs.toFixed(1)} s` : `FAILED ${row.reason!.slice(0, 160)}`}  (${ownSince(t0)} requests)`);
    if (!row.ok) { if (stopOn(row.reason)) break run; if (++fails >= 8 && fails > n / 2) { log("STOP: most spots are failing"); break run; } }
    await pace(started);
  }
  for (const spot of realQueue) {
    if (!(await gate(t0))) break run;
    const started = Date.now();
    const hand = handQ(spot.cid);
    if (!hand) continue;
    let row: RealRow;
    try { row = await solveReal(spot, cutAt(hand, spot.upto)); }
    catch (e) { row = { kind: "real", key: spot.key, ts: started, secs: 0, heroPos: spot.heroPos, heroClass: spot.heroClass, first: spot.first, stratum: spot.stratum, chart: spot.chart, gap: spot.gap, ok: false, reason: `threw: ${e instanceof Error ? e.message : e}` }; }
    appendFileSync(REAL_OUT, JSON.stringify(row) + "\n");
    n++;
    const x = gateSeat(spot.gap);
    log(`[${n}/${total}] ${spot.key} ${spot.heroPos} ${spot.heroClass} "${spot.chart.line}" ${spot.stratum} (${x.seat} ${x.real}→${x.chart}bb): ` +
      (row.ok ? `range loss ${row.range ? `${row.range.loss.toFixed(3)} over ${row.range.n} combos` : `n/a (${row.rangeWhy})`}, combo ${row.loss != null ? row.loss.toFixed(3) : "n/a"} (AI self ${row.aiSelfLoss!.toFixed(4)})${row.notOffered?.length ? ` [not offered: ${row.notOffered.join("/")}]` : ""} ${row.secs.toFixed(1)} s` : `FAILED ${row.reason!.slice(0, 160)}`) +
      `  (${ownSince(t0)} requests)`);
    if (!row.ok && stopOn(row.reason)) break run;
    await pace(started);
  }
}
log(`done: ${n} spots this run, ${ownSince(t0)} requests`);
reportSweep(load<SweepRow>(SWEEP_OUT)); reportReal(load<RealRow>(REAL_OUT));
process.exit(0);
