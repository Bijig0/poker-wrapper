/**
 * WHICH HANDS CALL THE LAST RAISE — the reduced tree's caller read scored against the exact tree (2026-10-04).
 *
 * When the exact GTO Wizard AI preflop tree cannot hold a line, reducedArrivalRanges (services/gtowAiPreflop) reads
 * each villain who called the last raise. Until 2026-10-04 that was a heads-up tree with the raise as a forced bet —
 * read against ANY TWO CARDS, since GTO Wizard ignores `range` on a preflop tree. This scores reads on lines the exact
 * tree DOES hold, so the exact node is the truth:
 *
 *   truth     the caller's own node on the exact tree: per combo 1 - fold, on his range entering it (the walk)
 *   current   the retired forced-bet tree (stored: collected on branch claude/caller-read-tree, c664fa4)
 *   whole     no narrowing
 *   fitWalk   (stored) one other caller/limper ahead of him folded out, his range walked on that line
 *   SHIPPED   what reducedArrivalRanges reads now, by its own code: a caller all in for less or one who came in
 *             limping (utils/reducedArrival cameInLimping) is kept whole; anyone else is lastRaiseReads(...).stayRange —
 *             run here with `fitOnly`, i.e. as the reduced tree meets him: on the line FITTED for him (fitAiLine, the
 *             earliest other limper/caller folded), never the direct line the exact tree holds
 *
 * RESULT (2026-10-04, the 65 decisions of study2.json; SHIPPED re-read from the solve cache, 0 requests). SHIPPED:
 * 22 read on a fitted line, 17 read directly (nobody ahead of him to fold — his own node, exact), 26 limpers kept whole.
 * Means per decision, over the decisions both current and SHIPPED answered:
 *                                      n  truth cont%  est cont%   TV%   est. range truth folds  truth range est. folds
 *   ALL                current         61     35.7        84.5      55.2          61.5                    0.0
 *                      whole           61     35.7       100.0      58.6          64.3                    0.0
 *                      SHIPPED         61     35.7        58.6      30.4          38.6                    3.2
 *   fitted line (22)   current         22     18.2        78.3      74.1          79.3                    0.0
 *                      SHIPPED         22     18.2        31.2      42.1          49.8                    2.1
 *   limpers etc. (25)  current         25     55.5       100.0      37.1          44.5                    0.0
 *                      SHIPPED (whole) 25     55.5       100.0      37.1          44.5                    0.0
 *   direct (14)        current         14     27.9        66.8      57.5          64.2                    0.0
 *                      SHIPPED         14     27.9        27.9       0.0          10.5 *                 10.5 *
 *   by line: limp-iso (41) SHIPPED TV 41.3 (current 54.4) · single-raised (12) 4.1 (69.2) · 3bet+ (8) 13.9 (37.9)
 *   blinds (31) SHIPPED TV 34.0 (current 76.5) · not blinds (30) 26.7 (33.1)
 *   head to head: SHIPPED closer in 33, equal in 24 (limpers the forced tree did not narrow), further in 4 (limpers it
 *   had trimmed by under 1.5%); median TV 69.1% → 22.8%.
 *   (* the floor of those two columns: a combo the node mixes counts partly as folded even in the node's own range)
 * The fitted read on the 22 is the study's fitWalk exactly (the same 22 numbers): the shipped code is what was measured.
 * WHAT THIS DOES NOT SHOW: a limper's start in the live code is the POOL's limp range, not the exact tree's (the truth's
 * entry here), so "limpers kept whole" is scored kinder than it plays; the study's fitWalk narrowed limpers to TV 23.8
 * (from 37.1) — keeping them whole is a decision (two other studies), not this measurement's verdict. A real reduced
 * spot folds two or more seats; every fit here folded one.
 *
 *   . config/env.ps1; & $env:BUN run src/scripts/callerReadStudy.ts --data <study2.json> [--shipped] [--list]
 *
 * --shipped re-reads the shipped estimate into the data file; without it the report reads what the file holds. It reads
 * the solve cache only (every request is refused in-process); a read the cache cannot serve is counted, not made. It
 * never runs while a poker session is live. The data file (truth, the forced-tree and fit reads, per combo) is made by
 * the collector on branch claude/caller-read-tree (scripts/callerReadStudy.ts --collect there, c664fa4).
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";
import { debugSolveBody, debugTree, dealtFromTreeId, lastRaiseReads, lineOf } from "../services/gtowAiPreflop";
import { cacheKeyOf, gtowSolveCache } from "../services/gtowSolveCache";
import { gtowRequests } from "../services/gtowRequestLog";
import { gtowSessions } from "../services/gtowSessions";
import { cameInLimping, planReducedArrival } from "../utils/reducedArrival/reducedArrival";
import { COMBOS, RANKS } from "../utils/comboIndex/comboIndex";

const argv = process.argv.slice(2);
const has = (k: string) => argv.includes(`--${k}`);
const arg = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? "" : null; };
const DATA_FILE = arg("data");
if (!DATA_FILE || !existsSync(DATA_FILE)) { console.log("--data <study2.json> is required (made by the collector on claude/caller-read-tree)"); process.exit(2); }
const DATA = (process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/");

type Est = { s: number[]; note?: string; Bfit?: number[]; range?: number[] };
interface Decision {
  id: string; hand: string; line: string; lineType: "limp-iso" | "single-raised" | "3bet+"; caller: string; callerTable: string;
  blind: boolean; raiser: string; raiserIsHero: boolean; ip: boolean; nCallers: number; n: number; callIdx: number;
  B: number[]; sTrue: number[]; sCall: number[];
  est: Record<string, Est | { error: string }>;
}
const store = JSON.parse(readFileSync(DATA_FILE, "utf8")) as { decisions: Decision[]; spent?: number };

// ===================================================================================================================
// --shipped: the shipped read, by the shipped code, from the solve cache
// ===================================================================================================================
if (has("shipped")) {
  const db = new Database(`${DATA}/poker.sqlite`, { readonly: true });
  if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — not running"); process.exit(2); }
  // no request leaves this process, and no token is sniffed off the browser: a node the cache lacks is a failed read
  let refused = 0;
  (gtowRequests as any).fetch = async () => { refused++; return new Response("study: cache only", { status: 503 }); };
  const s = gtowSessions as any;
  s.route = () => []; s.routeIgnoringBlocks = () => []; s.tokenFor = async () => null; s.bestToken = async () => null;
  const handRow = db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1");
  const chartsOf = db.query(`select distinct chart from answers where client_hand_id = ? and chart like 'gtow-ai · %-handed%'`);
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const tally: Record<string, number> = {};
  const count = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  for (const d of store.decisions) {
    const row = handRow.get(d.hand) as { data: string } | null;
    if (!row) { d.est.shipped = { error: "hand not archived" }; count("no hand"); continue; }
    const raw = normalizeHand(JSON.parse(row.data)).hand as any;
    const heroPos: string | null = raw.positions?.[raw.heroSeatId] ?? null;
    const cut = withStartStacks(truncateAt(raw, raw.actions.findIndex((a: any) => a.street !== "preflop"))) as any;
    // the exact tree the study read: the logged stacks first, then the hand's own
    const dealts: (Record<number, number> | undefined)[] = [];
    for (const r of chartsOf.all(d.hand) as { chart: string }[]) { const x = dealtFromTreeId(cut, heroPos, r.chart); if (x) dealts.push(x); }
    dealts.push(undefined);
    let found: { dt: Exclude<ReturnType<typeof debugTree>, { error: string }> } | null = null;
    for (const dealt of dealts) {
      const dt = debugTree(cut, heroPos, dealt);
      if ("error" in dt) continue;
      if (gtowSolveCache.hasTree(cacheKeyOf("pre", dt.body, { actions: "", board: "" }).key)) { found = { dt }; break; }
    }
    if (!found) { d.est.shipped = { error: "exact tree not in the cache" }; count("no tree"); continue; }
    const { shape } = found.dt;
    const sol = await debugSolveBody(`study|${d.id}`, found.dt.body, shape.n);
    if ("error" in sol) { d.est.shipped = { error: sol.error }; count("no solution"); continue; }
    const tokens = lineOf(cut, shape).tokens;
    // the shipped rules, in the shipped order (gtowAiPreflop.reducedArrivalRanges)
    const plan = planReducedArrival(cut, heroPos);
    const seat = shape.seatOf[d.caller];
    const c = plan.ok ? plan.callers.find((x) => x.seat === seat) : undefined;
    if (!plan.ok || !c) { d.est.shipped = { error: `plan: ${plan.ok ? "caller not in it" : plan.reason}` }; count("no plan"); continue; }
    if (c.putIn < plan.raiseTo - 0.05) { d.est.shipped = { s: new Array(1326).fill(1), note: "all in for less: kept whole" }; count("kept whole: all in for less"); continue; }
    if (cameInLimping(cut, seat!, plan.raiseIndex)) { d.est.shipped = { s: new Array(1326).fill(1), note: "limper: kept whole" }; count("kept whole: limper"); continue; }
    // as the reduced tree meets him: fitted. With nobody to fold ahead of him the live code reads his own node directly
    // (the line breaks after him) — exact by construction; that read is made the same way here and labelled so.
    let st = await lastRaiseReads(sol.solId, shape, tokens, { fitOnly: true }).stayRange(d.callerTable).catch(() => null);
    let how = "fitted";
    if (!st) { st = await lastRaiseReads(sol.solId, shape, tokens).stayRange(d.callerTable).catch(() => null); how = "direct"; }
    if (!st) { d.est.shipped = { s: new Array(1326).fill(1), note: "no read: kept whole" }; count("kept whole: no read"); continue; }
    d.est.shipped = { s: new Array(1326).fill(1), range: st.range.map(r4), note: `${how}, ${st.folded.join("/") || "nobody"} folded` };
    count(how === "fitted" ? "fitted read" : "direct read (nobody to fold ahead of him)");
  }
  writeFileSync(DATA_FILE, JSON.stringify(store));
  console.log(`shipped estimate re-read for ${store.decisions.length} decisions: ${JSON.stringify(tally)}; requests refused (cache misses): ${refused}`);
}

// ===================================================================================================================
// THE REPORT
// ===================================================================================================================
/** a 7-card evaluator (category in the high bits, kickers below), only for equity vs a random hand */
function eval7(c: number[]): number {
  const rc = new Array<number>(13).fill(0), sc = [0, 0, 0, 0], sm = [0, 0, 0, 0];
  let rm = 0;
  for (const x of c) { const r = x >> 2, s = x & 3; rc[r]!++; sc[s]!++; sm[s]! |= 1 << r; rm |= 1 << r; }
  const straight = (mask: number) => { for (let h = 12; h >= 4; h--) if (((mask >> (h - 4)) & 31) === 31) return h; return (mask & 0b1000000001111) === 0b1000000001111 ? 3 : -1; };
  const enc = (cat: number, ks: number[]) => ks.slice(0, 5).reduce((v, k) => v * 16 + k, cat) * Math.pow(16, 5 - Math.min(5, ks.length));
  const fs = sc.findIndex((n) => n >= 5);
  if (fs >= 0) { const sf = straight(sm[fs]!); if (sf >= 0) return enc(8, [sf]); }
  const by = (n: number) => { const o: number[] = []; for (let r = 12; r >= 0; r--) if (rc[r] === n) o.push(r); return o; };
  const q = by(4), t = by(3), p = by(2);
  const desc = (ex: number[]) => { const o: number[] = []; for (let r = 12; r >= 0; r--) if (rc[r]! > 0 && !ex.includes(r)) o.push(r); return o; };
  if (q.length) return enc(7, [q[0]!, desc([q[0]!])[0]!]);
  if (t.length && (t.length > 1 || p.length)) return enc(6, [t[0]!, t.length > 1 ? t[1]! : p[0]!]);
  if (fs >= 0) { const o: number[] = []; for (let r = 12; r >= 0; r--) if (sm[fs]! & (1 << r)) o.push(r); return enc(5, o); }
  const st = straight(rm);
  if (st >= 0) return enc(4, [st]);
  if (t.length) return enc(3, [t[0]!, ...desc([t[0]!])]);
  if (p.length >= 2) return enc(2, [p[0]!, p[1]!, desc([p[0]!, p[1]!])[0]!]);
  if (p.length) return enc(1, [p[0]!, ...desc([p[0]!])]);
  return enc(0, desc([]));
}
/** each class's all-in equity against a random hand (Monte Carlo, seeded; cached beside the data file) */
function classEquity(): Record<string, number> {
  const f = DATA_FILE!.replace(/\.json$/, "") + ".equity.json";
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  const out: Record<string, number> = {};
  const card = (s: string) => RANKS.indexOf(s[0]!) * 4 + "cdhs".indexOf(s[1]!);
  for (const c of COMBOS) {
    if (out[c.cls] != null) continue;
    const mine = c.cards.map(card);
    const deck = Array.from({ length: 52 }, (_, i) => i).filter((x) => !mine.includes(x));
    let w = 0; const N = 6000;
    for (let t = 0; t < N; t++) {
      for (let k = 0; k < 7; k++) { const j = k + Math.floor(rnd() * (deck.length - k)); [deck[k], deck[j]] = [deck[j]!, deck[k]!]; }
      const board = deck.slice(2, 7);
      const a = eval7([...mine, ...board]), b = eval7([deck[0]!, deck[1]!, ...board]);
      w += a > b ? 1 : a === b ? 0.5 : 0;
    }
    out[c.cls] = w / N;
  }
  writeFileSync(f, JSON.stringify(out));
  return out;
}
const eqCls = classEquity();
const eq = COMBOS.map((c) => eqCls[c.cls]!);
const top20 = new Array<number>(1326).fill(0);
{ const order = COMBOS.map((_, i) => i).sort((a, b) => eq[b]! - eq[a]!); const cut = eq[order[Math.round(0.2 * 1326) - 1]!]!; for (let i = 0; i < 1326; i++) if (eq[i]! >= cut) top20[i] = 1; }

interface M { freqT: number; freqE: number; tv: number; estFoldedByTruth: number; truthFoldedByEst: number; top20T: number; top20E: number; eqT: number; eqE: number }
/** truth T = B × sT; the estimate E = its own range when it has one (fitWalk: Bfit × s; SHIPPED: the read), else B × s.
 *  Continue shares are over the truth's entering range B (fitWalk: over its own walked entry). */
function metrics(d: Decision, e: Est): M {
  const B = d.B, sT = d.sTrue;
  const T = B.map((b, i) => b * sT[i]!);
  const E = e.range ? e.range : (e.Bfit ?? B).map((b, i) => b * e.s[i]!);
  const sb = B.reduce((x, y) => x + y, 0), sbe = (e.Bfit ?? B).reduce((x, y) => x + y, 0);
  const st = T.reduce((x, y) => x + y, 0), se = E.reduce((x, y) => x + y, 0);
  // the share of a combo the estimate keeps relative to the truth's entry, for "truth's range the estimate folds"
  const keepE = (i: number) => (e.range ? (B[i]! > 0 ? Math.min(1, e.range[i]! / B[i]!) : 0) : e.s[i]!);
  let tv = 0, efbt = 0, tfbe = 0, t20 = 0, e20 = 0, eqT = 0, eqE = 0;
  for (let i = 0; i < 1326; i++) {
    const t = st > 0 ? T[i]! / st : 0, x = se > 0 ? E[i]! / se : 0;
    tv += Math.abs(t - x) / 2; efbt += x * (1 - sT[i]!); tfbe += t * (1 - keepE(i));
    t20 += t * top20[i]!; e20 += x * top20[i]!; eqT += t * eq[i]!; eqE += x * eq[i]!;
  }
  return { freqT: st / sb, freqE: se / (e.range ? sb : sbe), tv, estFoldedByTruth: efbt, truthFoldedByEst: tfbe, top20T: t20, top20E: e20, eqT, eqE };
}
const ok = (e: any): e is Est => !!e && !("error" in e);
function derive(d: Decision): Record<string, Est> {
  const out: Record<string, Est> = {};
  if (ok(d.est.current)) out.current = { s: d.est.current.s };
  out.whole = { s: new Array(1326).fill(1) };
  const fits = Object.entries(d.est).filter(([k, v]) => k.startsWith("fit:") && ok(v)) as [string, Est][];
  if (fits.length === 1 && fits[0]![1].Bfit) out.fitWalk = { s: fits[0]![1].s, Bfit: fits[0]![1].Bfit };
  if (ok(d.est.shipped)) out.SHIPPED = d.est.shipped;
  return out;
}
const EST = ["current", "whole", "fitWalk", "SHIPPED"];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pc = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(1).padStart(5) : "   — ");
const sg = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}`.padStart(6) : "    — ");
function table(label: string, sel: (d: Decision) => boolean, common = true) {
  let ds = store.decisions.filter(sel);
  const der = new Map(ds.map((d) => [d.id, derive(d)]));
  if (common) ds = ds.filter((d) => der.get(d.id)!.current && der.get(d.id)!.SHIPPED);
  console.log(`\n== ${label}: ${ds.length} caller decisions${common ? " (current and SHIPPED both answered)" : ""}`);
  console.log(`   estimator     n   truth cont%  est cont%  est-truth   TV%   est∩truthFolds%  truth∩estFolds%  top20% T/E    eq% T/E`);
  for (const e of EST) {
    const rows = ds.filter((d) => der.get(d.id)![e]).map((d) => metrics(d, der.get(d.id)![e]!));
    if (!rows.length) { console.log(`   ${e.padEnd(12)}   0`); continue; }
    console.log(`   ${e.padEnd(12)} ${String(rows.length).padStart(3)}   ${pc(mean(rows.map((r) => r.freqT)))}      ${pc(mean(rows.map((r) => r.freqE)))}     ${sg(mean(rows.map((r) => r.freqE - r.freqT)))}  ${pc(mean(rows.map((r) => r.tv)))}       ${pc(mean(rows.map((r) => r.estFoldedByTruth)))}            ${pc(mean(rows.map((r) => r.truthFoldedByEst)))}       ${pc(mean(rows.map((r) => r.top20T)))}/${pc(mean(rows.map((r) => r.top20E)))}  ${pc(mean(rows.map((r) => r.eqT)))}/${pc(mean(rows.map((r) => r.eqE)))}`);
  }
}
const kind = (d: Decision) => String((d.est.shipped as Est | undefined)?.note ?? "");
console.log(`${store.decisions.length} caller decisions; SHIPPED: ${JSON.stringify(store.decisions.reduce((m: Record<string, number>, d) => { const k = ok(d.est.shipped) ? kind(d).replace(/, .*$/, "") : `error: ${(d.est.shipped as any)?.error ?? "not read"}`; m[k] = (m[k] ?? 0) + 1; return m; }, {}))}`);
table("ALL", () => true);
table("SHIPPED read on a fitted line (non-limper villains)", (d) => kind(d).startsWith("fitted"));
table("SHIPPED kept whole (limpers, all in for less, no read)", (d) => kind(d).includes("kept whole"));
table("SHIPPED read directly (nobody ahead of him to fold: exact)", (d) => kind(d).startsWith("direct"));
for (const t of ["limp-iso", "single-raised", "3bet+"]) table(`line ${t}`, (d) => d.lineType === t);
table("caller in the blinds", (d) => d.blind);
table("caller not in the blinds", (d) => !d.blind);
{
  const both = store.decisions.map((d) => ({ d, x: derive(d) })).filter(({ x }) => x.current && x.SHIPPED);
  const a = both.map(({ d, x }) => metrics(d, x.current!).tv), b = both.map(({ d, x }) => metrics(d, x.SHIPPED!).tv);
  const med = (xs: number[]) => { const s = xs.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]!; };
  console.log(`\nhead to head (${both.length}): SHIPPED closer (TV) in ${a.filter((v, i) => b[i]! < v - 1e-9).length}, equal in ${a.filter((v, i) => Math.abs(b[i]! - v) <= 1e-9).length}, ` +
    `further in ${a.filter((v, i) => b[i]! > v + 1e-9).length}; median TV current ${pc(med(a))}%, SHIPPED ${pc(med(b))}%`);
}
if (has("list")) {
  for (const d of store.decisions) {
    const der = derive(d);
    console.log(`${d.hand} ${d.lineType.padEnd(13)} ${d.raiser}→${d.callerTable} '${d.line}' ` +
      EST.filter((e) => der[e]).map((e) => { const m = metrics(d, der[e]!); return `${e} ${pc(m.freqE)}/${pc(m.freqT)} tv${pc(m.tv)}`; }).join(" · ") + ` · ${kind(d)}`);
  }
}
process.exit(0);
