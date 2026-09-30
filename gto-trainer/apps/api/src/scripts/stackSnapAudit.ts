/**
 * STACK-SNAP AUDIT (2026-09-29) — what the 6-max charts' STACK approximations cost, measured against a tree solved
 * at the table's exact stacks.
 *
 * The preflop hand-off (fastSolve → solvePreflop6max → the GTO Wizard AI preflop tree) bounds only one axis: a
 * raise size more than ~1.5x from the chart's nearest is refused and the exact tree answers. Stacks have no such
 * bound — a short seat is read from the 30/50/70 rung (or a two-short 20/40/60/80 patch) however far off, a second
 * short seat and every other seat are taken as 100bb, a limped pot with a short seat reads the even limp chart, and
 * anything past 165bb reads the 150bb chart. This script measures what those reads cost:
 *
 *   pass 1 (--dry, no GTO Wizard): every hero preflop decision of every live 6-max hand is rebuilt (hands →
 *           normalizeHand → truncateAt, as /resolve-chain does) and answered by the CHART piece exactly as the live
 *           system answers it today (patches and all); the ones whose pick carries a stack approximation are the
 *           spots, plus a control sample of clean picks (the chart-vs-AI gap that exists even with matching stacks —
 *           the two are different trees, and without that baseline the stack cost is confounded);
 *   pass 2 (--solve): each spot goes to solvePreflopGtowAi — the same piece the live fallback uses, a tree built
 *           from the actual table — and hero's node is read back with its per-combo EVs. The cost of the chart's
 *           answer is max_a EV[a] − Σ_a chartMix[a]·EV[a] on that node, for hero's actual combo: how much the chart's
 *           mix gives up if the exact-stack equilibrium is the truth. The AI's own mix scored the same way (≈0) is the
 *           sanity check on units and action mapping.
 *
 * Costs the Ultra account requests (a tree + a solution + ~2 polls per new tree shape, one node read per spot);
 * refuses to start unless the live API reports the multiway account up, stops at --budget requests, paces itself
 * at --per-min spots. Files nothing: origin "audit" is not on the miss queue's whitelist, and the hand ids are
 * stripped so no preflop pin (and no prefix-node prefetch) fires. Results append to
 * POKER_DATA_DIR/audits/stack-snap-audit.jsonl; a re-run skips spots already solved.
 *
 *   bun src/scripts/stackSnapAudit.ts --dry
 *   bun src/scripts/stackSnapAudit.ts --solve --budget 900 --per-min 2 [--controls 60] [--limit N]
 *   bun src/scripts/stackSnapAudit.ts --report            summarise the jsonl without solving anything
 */
process.env.GTOW_REQUEST_ORIGIN ??= "stackSnapAudit";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { buildPreflopTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { truncateAt } from "../utils/archivedHand/archivedHand";
import { repairDeadSmallBlind } from "../utils/repairPostflopRotation/repairPostflopRotation";
import { comboIndex } from "../utils/comboIndex/comboIndex";
import { is6Handed, solvePreflop6max } from "../services/fastSolve";
import { chartFor6max } from "../services/hrc6max";
import { SIX_MAX_STRATEGY_ID } from "../services/strategies";
import { solvePreflopGtowAi, fetchNode, shapeOf, lineOf, menus, treeKeyOf } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const num = (n: string, d: number) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) || d : d; };
const DRY = flag("--dry"), SOLVE = flag("--solve"), REPORT = flag("--report"), SMOKE = flag("--smoke");
const BUDGET = num("--budget", 1200), PER_MIN = num("--per-min", 2), CONTROLS = num("--controls", 60), LIMIT = num("--limit", 0);
const API = process.env.STUDY_API ?? "http://127.0.0.1:2000";
const DATA = process.env.POKER_DATA_DIR ?? "C:\\Users\\Brady\\poker-data";
const OUT_DIR = join(DATA, "audits");
const OUT = join(OUT_DIR, "stack-snap-audit.jsonl");
const ORIGIN = "audit";   // not in missQueue's REAL_SOLVE_ORIGINS: files nothing

/** the stack-approximation notes the chart piece writes that are NOT Approx6 gaps (prose only) */
const STACK_NOTE = /also short — not modelled|is not modelled|the short chart plays him at|answered from the even \d+bb chart|short stacks and/;
const STACK_KINDS = new Set(["short-rung-snapped", "no-limp-uneven", "beyond-ladder"]);

interface Spot {
  key: string; cid: string; dbId: number; upto: number; heroPos: string; heroCards: string[]; heroClass: string;
  seats: number; stacks: Record<string, number>; tokens: string[];
  chart: { id: string; depth: number; line: string; actions: { action: string; frequency: number }[]; note: string; kinds: string[]; patch: string | null };
  control: boolean; treeKey: string | null;
}
interface Row extends Spot {
  run: string; ts: number;
  ai: { ok: true; treeKey: string; line: string; actions: { code: string; label: string; ev: number; aiFreq: number; chartFreq: number }[];
        evMax: number; evChart: number; evAi: number; loss: number; aiSelfLoss: number; tvd: number; topAgree: boolean; chartTop: string; aiTop: string; secs: number }
    | { ok: false; reason: string };
}

const classOf = (cards: string[]): string => {
  const R = "23456789TJQKA";
  const [a, b] = cards.map((c) => c[0]!.toUpperCase());
  const [sa, sb] = cards.map((c) => c.slice(1).toLowerCase());
  const hi = R.indexOf(a!) >= R.indexOf(b!) ? a : b, lo = hi === a ? b : a;
  return a === b ? `${a}${b}` : `${hi}${lo}${sa === sb ? "s" : "o"}`;
};

// ── pass 1: the spots ──────────────────────────────────────────────────────────────────────────────────────────
async function collectSpots(): Promise<{ spots: Spot[]; stats: Record<string, number> }> {
  const db = new Database(join(DATA, "poker.sqlite"), { readonly: true });
  const cids = db.query<{ cid: string }, []>(
    `SELECT DISTINCT client_hand_id cid FROM answers WHERE source IN ('hrc-6max-preflop','gtow-ai-preflop') AND session_id IS NOT NULL AND client_hand_id IS NOT NULL ORDER BY client_hand_id`).all().map((r) => r.cid);
  const q = db.query<{ rowid: number; data: string }, [string]>(`SELECT rowid, data FROM hands WHERE client_hand_id = ? AND status <> 'live'`);
  const stats: Record<string, number> = { hands: 0, decisions: 0, notSix: 0, postIn: 0, deadSb: 0, chartRefused: 0, chartNull: 0, noMix: 0, stackSpots: 0, clean: 0 };
  const spots: Spot[] = [];
  const seen = new Set<string>();
  for (const cid of cids) {
    const row = q.get(cid);
    if (!row) continue;
    let hand: ParsedHand;
    try { hand = normalizeHand(JSON.parse(row.data)).hand; } catch { continue; }
    stats.hands!++;
    if (hand.postIns?.length) { stats.postIn!++; continue; }
    if (repairDeadSmallBlind(hand).note) { stats.deadSb!++; continue; }
    const heroPos = hand.positions[hand.heroSeatId] ?? null;
    if (!heroPos || hand.heroCards.length !== 2) continue;
    for (let i = 0; i < hand.actions.length; i++) {
      const a = hand.actions[i]!;
      if (a.street !== "preflop") break;
      if (!a.hero || /^post/.test(a.type)) continue;
      stats.decisions!++;
      const t = truncateAt(hand, i);
      // no ids: no preflop pin, no prefix prefetch, nothing keyed to this hand (see the header)
      const cut = { ...t, currentNode: { ...t.currentNode, toActIsHero: true }, clientHandId: undefined, handId: undefined } as unknown as ParsedHand;
      if (!is6Handed(cut, heroPos)) { stats.notSix!++; continue; }
      const tokens = buildPreflopTokens(cut, heroPos);
      const choice = chartFor6max(cut, heroPos, tokens);
      let six: Awaited<ReturnType<typeof solvePreflop6max>>;
      try { six = await solvePreflop6max(cut, heroPos, ORIGIN, SIX_MAX_STRATEGY_ID); } catch (e) { console.warn(`  ${cid}@${i}: chart threw ${e instanceof Error ? e.message : e}`); continue; }
      if (six === null) { stats.chartNull!++; continue; }
      if (!six.ok) { stats.chartRefused!++; continue; }
      if (!six.actions?.length) { stats.noMix!++; continue; }
      const kinds = [...new Set([
        ...(choice.approx ?? []).filter((x) => STACK_KINDS.has(x.kind)).map((x) => x.kind),
        ...(choice.patch?.variant === "snapped" ? ["two-short-snapped"] : []),
        ...(choice.patch?.variant === "capped" ? ["patch-capped"] : []),
        ...((six.warning ?? "").split(" · ").filter((n) => STACK_NOTE.test(n)).map((n) => n.replace(/\b(UTG|HJ|CO|BTN|SB|BB)\b/g, "POS").replace(/\d+(\.\d+)?/g, "#"))),
      ])];
      const stacks: Record<string, number> = {};
      for (const [seat, pos] of Object.entries(cut.positions)) { const s = cut.stacks?.[Number(seat)]; if (s != null) stacks[pos] = Math.round(s + (cut.committed?.[Number(seat)] ?? 0)); }
      const shape = shapeOf(cut, heroPos);
      const treeKey = "error" in shape ? null : treeKeyOf(shape, menus(lineOf(cut, shape).levels, shape.n));
      const key = `${cid}@${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const spot: Spot = {
        key, cid, dbId: row.rowid, upto: i, heroPos, heroCards: cut.heroCards, heroClass: classOf(cut.heroCards),
        seats: Object.keys(cut.positions).length, stacks, tokens,
        chart: { id: six.gametype, depth: six.depth, line: six.line ?? "", actions: six.actions, note: six.warning ?? "", kinds, patch: choice.patch ? `${choice.patch.id} (${choice.patch.variant})` : null },
        control: kinds.length === 0, treeKey,
      };
      if (kinds.length) stats.stackSpots!++; else stats.clean!++;
      spots.push(spot);
    }
  }
  db.close();
  return { spots, stats };
}

// ── pass 2: the exact tree ─────────────────────────────────────────────────────────────────────────────────────
async function ultraUp(): Promise<{ ok: boolean; why: string }> {
  try {
    const j = await (await fetch(`${API}/api/gtow/accounts`, { signal: AbortSignal.timeout(5000) })).json() as any;
    const u = (j.accounts as any[]).find((a) => a.multiway);
    if (!u) return { ok: false, why: "no multiway account in the registry" };
    if (u.wall?.walled) return { ok: false, why: `${u.name} walled until ${new Date(u.wall.expectedLiftMs).toLocaleString()}` };
    if (u.live?.state !== "up") return { ok: false, why: `${u.name}: ${u.live?.text ?? u.live?.state}` };
    return { ok: true, why: `${u.name} up, ${u.windows?.h24?.n ?? "?"} requests in 24 h` };
  } catch (e) { return { ok: false, why: `API unreachable: ${e instanceof Error ? e.message : e}` }; }
}
function requestsSince(ts: number): number {
  const db = new Database(join(DATA, "poker.sqlite"), { readonly: true });
  const n = db.query<{ n: number }, [string, number]>(`SELECT count(*) n FROM gtow_requests WHERE o = ? AND ts >= ?`).get(process.env.GTOW_REQUEST_ORIGIN!, ts)?.n ?? 0;
  db.close();
  return n;
}
const aiLabel = (action: any): string => {
  const type = String(action?.type ?? "").toUpperCase(); const bb = Number(action?.betsize);
  if (action?.allin === true) return "All-in";
  if (type.startsWith("FOLD")) return "Fold"; if (type.startsWith("CHECK")) return "Check"; if (type.startsWith("CALL")) return "Call";
  if (type.startsWith("RAISE") || type.startsWith("BET")) return Number.isFinite(bb) && bb > 0 ? `Raise ${Math.round(bb * 100) / 100}` : "Raise";
  return String(action?.code ?? "?");
};
/** the AI action a chart action means: fold→fold, call/limp/check→the passive action offered, a raise→the nearest size (all-in→the jam) */
function mapChartAction(label: string, offered: { code: string; label: string; bb: number | null; allin: boolean }[]): string | null {
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
async function solveSpot(spot: Spot, hand: ParsedHand): Promise<Row["ai"]> {
  const t0 = Date.now();
  const ai = await solvePreflopGtowAi(hand, spot.heroPos, "stack-snap audit");
  if (!ai.ok) return { ok: false, reason: ai.reason };
  const node = await fetchNode(ai.solId, ai.usedLine);
  if ("error" in node) return { ok: false, reason: `node: ${node.error}` };
  const idx = comboIndex(hand.heroCards[0]!, hand.heroCards[1]!);
  const sols = (node.data.action_solutions as any[]);
  const offered = sols.map((s) => ({ code: String(s.action?.code ?? "?"), label: aiLabel(s.action), bb: Number.isFinite(Number(s.action?.betsize)) ? Number(s.action.betsize) : null, allin: s.action?.allin === true }));
  const evOf: Record<string, number> = {}, aiOf: Record<string, number> = {};
  sols.forEach((s, k) => { evOf[offered[k]!.code] = Number(s.evs?.[idx] ?? NaN); aiOf[offered[k]!.code] = Number(s.strategy?.[idx] ?? 0); });
  if (Object.values(evOf).some((v) => !Number.isFinite(v))) return { ok: false, reason: "node has no per-combo EVs" };
  const chartOf: Record<string, number> = {};
  for (const a of spot.chart.actions) { const code = mapChartAction(a.action, offered); if (!code) return { ok: false, reason: `chart action '${a.action}' has no counterpart among ${offered.map((o) => o.label).join("/")}` }; chartOf[code] = (chartOf[code] ?? 0) + a.frequency / 100; }
  const evMax = Math.max(...Object.values(evOf));
  const evChart = Object.entries(chartOf).reduce((s, [c, f]) => s + f * evOf[c]!, 0);
  const evAi = Object.entries(aiOf).reduce((s, [c, f]) => s + f * evOf[c]!, 0);
  const tvd = 0.5 * offered.reduce((s, o) => s + Math.abs((chartOf[o.code] ?? 0) - (aiOf[o.code] ?? 0)), 0);
  const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
  return {
    ok: true, treeKey: ai.treeKey, line: ai.usedLine, secs: (Date.now() - t0) / 1000,
    actions: offered.map((o) => ({ code: o.code, label: o.label, ev: evOf[o.code]!, aiFreq: aiOf[o.code]!, chartFreq: chartOf[o.code] ?? 0 })),
    evMax, evChart, evAi, loss: evMax - evChart, aiSelfLoss: evMax - evAi, tvd, topAgree: top(chartOf) === top(aiOf), chartTop: top(chartOf), aiTop: top(aiOf),
  };
}

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────────
function report(rows: Row[]): void {
  const ok = rows.filter((r) => r.ai.ok) as (Row & { ai: Extract<Row["ai"], { ok: true }> })[];
  const q = (xs: number[], p: number) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
  const line = (name: string, g: typeof ok) => {
    if (!g.length) return;
    const loss = g.map((r) => r.ai.loss), self = g.map((r) => r.ai.aiSelfLoss);
    const share = (th: number) => `${Math.round(100 * loss.filter((x) => x > th).length / g.length)}%`;
    console.log(`  ${name.padEnd(46)} n=${String(g.length).padStart(3)}  loss bb/hand: mean ${(loss.reduce((a, b) => a + b, 0) / g.length).toFixed(3)}  p50 ${q(loss, .5).toFixed(3)}  p90 ${q(loss, .9).toFixed(3)}  max ${Math.max(...loss).toFixed(3)}` +
      `  >0.05bb ${share(0.05)}  >0.2bb ${share(0.2)}  | top differs ${Math.round(100 * g.filter((r) => !r.ai.topAgree).length / g.length)}%  tvd p50 ${q(g.map((r) => r.ai.tvd), .5).toFixed(2)}  | AI self-loss p90 ${q(self, .9).toFixed(4)}`);
  };
  console.log(`\n[audit] ${rows.length} spots solved, ${ok.length} scored, ${rows.length - ok.length} failed`);
  line("CONTROL (no stack approximation)", ok.filter((r) => r.control));
  line("ALL stack-approximated", ok.filter((r) => !r.control));
  const kinds = [...new Set(ok.flatMap((r) => r.chart.kinds))].sort();
  for (const k of kinds) line(`  ${k}`, ok.filter((r) => r.chart.kinds.includes(k)));
  const worst = ok.filter((r) => !r.control).sort((a, b) => b.ai.loss - a.ai.loss).slice(0, 12);
  if (worst.length) {
    console.log("\n  worst stack-approximated spots:");
    for (const r of worst) console.log(`    ${r.key} ${r.heroPos} ${r.heroClass} at "${r.chart.line}" on ${r.chart.id}: chart ${r.ai.chartTop} vs exact ${r.ai.aiTop}, loss ${r.ai.loss.toFixed(3)} — ${r.chart.kinds.join(", ")} — stacks ${Object.entries(r.stacks).map(([p, s]) => `${p}${s}`).join(" ")}`);
  }
  const failed = rows.filter((r) => !r.ai.ok);
  if (failed.length) { const why: Record<string, number> = {}; for (const r of failed) { const k = (r.ai as { reason: string }).reason.replace(/\d+/g, "#").slice(0, 80); why[k] = (why[k] ?? 0) + 1; } console.log("\n  failures:", why); }
}
function loadRows(): Row[] {
  if (!existsSync(OUT)) return [];
  return readFileSync(OUT, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────────────
if (REPORT) { report(loadRows()); process.exit(0); }
if (SMOKE) {
  // the AI path end to end on ONE heads-up decision (the Elite account solves heads-up preflop; multiway needs Ultra):
  // tree, node, per-combo EVs, the action mapping, and the self-loss ≈ 0 check — a handful of requests
  const db = new Database(join(DATA, "poker.sqlite"), { readonly: true });
  const rows = db.query<{ data: string; cid: string }, []>(`SELECT data, client_hand_id cid FROM hands WHERE status <> 'live' AND data LIKE '%"bbCents": 5%' ORDER BY rowid DESC LIMIT 400`).all();
  db.close();
  for (const r of rows) {
    let hand: ParsedHand; try { hand = normalizeHand(JSON.parse(r.data)).hand; } catch { continue; }
    if (Object.keys(hand.positions).length !== 2 || hand.heroCards.length !== 2 || hand.postIns?.length) continue;
    const heroPos = hand.positions[hand.heroSeatId]; if (!heroPos) continue;
    const i = hand.actions.findIndex((a) => a.street === "preflop" && a.hero && !/^post/.test(a.type));
    if (i < 0) continue;
    const t = truncateAt(hand, i);
    const cut = { ...t, currentNode: { ...t.currentNode, toActIsHero: true }, clientHandId: undefined, handId: undefined } as unknown as ParsedHand;
    const spot: Spot = { key: `${r.cid}@${i}`, cid: r.cid, dbId: 0, upto: i, heroPos, heroCards: cut.heroCards, heroClass: classOf(cut.heroCards), seats: 2, stacks: {}, tokens: [],
      chart: { id: "smoke", depth: 0, line: "", actions: [{ action: "Fold", frequency: 50 }, { action: "Call", frequency: 50 }], note: "", kinds: [], patch: null }, control: true, treeKey: null };
    console.log(`[smoke] ${spot.key} ${heroPos} ${spot.heroClass} (${cut.heroCards.join("")}) heads-up, synthetic chart mix Fold 50 / Call 50`);
    const ai = await solveSpot(spot, cut);
    console.log(JSON.stringify(ai, null, 1));
    process.exit(ai.ok ? 0 : 1);
  }
  console.error("[smoke] no heads-up decision found"); process.exit(1);
}
const t0 = Date.now();
const { spots, stats } = await collectSpots();
console.log(`[audit] pass 1 in ${((Date.now() - t0) / 1000).toFixed(0)} s:`, stats);
const stackSpots = spots.filter((s) => !s.control);
const byKind: Record<string, number> = {};
for (const s of stackSpots) for (const k of s.chart.kinds) byKind[k] = (byKind[k] ?? 0) + 1;
console.log(`[audit] ${stackSpots.length} stack-approximated spots, by kind:`, byKind);
const shapes = new Set(stackSpots.map((s) => s.treeKey).filter(Boolean)).size;
console.log(`[audit] unique tree shapes among them: ${shapes} — every table's stacks differ, so nearly every spot is its own tree: ≈ 3-5 requests per spot (tree, solution, 1-3 polls; the smoke test cost 3)`);
// a seeded shuffle so a partial run is representative; controls interleaved
let seed = 20260929; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const shuffle = <T,>(xs: T[]) => xs.map((x) => [rnd(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const controls = shuffle(spots.filter((s) => s.control)).slice(0, CONTROLS);
let queue = shuffle([...stackSpots, ...controls]);
if (LIMIT) queue = queue.slice(0, LIMIT);
if (DRY || !SOLVE) {
  console.log(`[audit] would solve ${queue.length} spots (${controls.length} controls). Sample:`);
  for (const s of queue.slice(0, 8)) console.log(`  ${s.key} ${s.heroPos} ${s.heroClass} "${s.chart.line}" ${s.chart.id} → ${s.chart.actions.map((a) => `${a.action} ${a.frequency}`).join(" / ")} | ${s.chart.kinds.join(", ") || "control"} | stacks ${Object.entries(s.stacks).map(([p, v]) => `${p}${v}`).join(" ")}`);
  process.exit(0);
}
// pass 2
const gate = await ultraUp();
if (!gate.ok) { console.error(`[audit] NOT solving: ${gate.why}`); process.exit(2); }
console.log(`[audit] ${gate.why}; budget ${BUDGET} requests, ${PER_MIN} spots/min`);
mkdirSync(OUT_DIR, { recursive: true });
const done = new Set(loadRows().filter((r) => r.ai.ok).map((r) => r.key));
const run = new Date().toISOString().slice(0, 16);
const db = new Database(join(DATA, "poker.sqlite"), { readonly: true });
const handQ = db.query<{ data: string }, [string]>(`SELECT data FROM hands WHERE client_hand_id = ? AND status <> 'live'`);
let solved = 0;
for (const spot of queue) {
  if (done.has(spot.key)) continue;
  const used = requestsSince(t0);
  if (used >= BUDGET) { console.log(`[audit] budget reached (${used} requests) — stopping; re-run to continue`); break; }
  const g = await ultraUp();
  if (!g.ok) { console.log(`[audit] stopping: ${g.why}`); break; }
  const raw = handQ.get(spot.cid); if (!raw) continue;
  const hand = normalizeHand(JSON.parse(raw.data)).hand;
  const t = truncateAt(hand, spot.upto);
  const cut = { ...t, currentNode: { ...t.currentNode, toActIsHero: true }, clientHandId: undefined, handId: undefined } as unknown as ParsedHand;
  const ai = await solveSpot(spot, cut);
  const row: Row = { ...spot, run, ts: Date.now(), ai };
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  solved++;
  console.log(ai.ok
    ? `  ${spot.key} ${spot.heroPos} ${spot.heroClass} "${spot.chart.line}": chart ${ai.chartTop} / exact ${ai.aiTop}, loss ${ai.loss.toFixed(3)} (self ${ai.aiSelfLoss.toFixed(4)}) ${spot.control ? "[control]" : spot.chart.kinds.join(",")} ${ai.secs.toFixed(1)} s`
    : `  ${spot.key}: FAILED ${ai.reason.slice(0, 120)}`);
  await new Promise((r) => setTimeout(r, Math.max(0, 60_000 / PER_MIN)));
}
db.close();
console.log(`[audit] ${solved} spots solved this run, ${requestsSince(t0)} requests`);
report(loadRows());
process.exit(0);
