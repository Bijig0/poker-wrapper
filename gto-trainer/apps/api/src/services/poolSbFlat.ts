/**
 * THE SB-FLAT TABLE v2 (2026-10-10 — poker branch claude/sbflat-ranges a0692acb, limp_study/locks_v2/
 * build_sbflat_ranges.py → sbflat_ranges.json, copied byte for byte to services/poolSbFlatRanges.json; the evidence in
 * sbflat_variables.md beside it). THE NODE: six-max, one raise in, nobody limped or called it, the SB is the first to
 * decide against it and FLATS (an all-in open, a flat followed by his own 4-bet and 7-max tables are not in it).
 *
 * WHAT IT REPLACES: today's pool-call cell for that flat (poolCallLocks.json `poolcall_flat_SB_vs<opener>[_o*]_<le40 |
 * 40_80 | 80p>` — CoinPoker levels, 3 stack buckets). The new table is Ignition-first: each cell's rate is Ignition's
 * own (NL100 + NL200 ring, 10,845 SB-vs-open chances, 1,109 flats, every card visible), shrunk toward the CoinPoker
 * 9.1M-hand within-cell effect, the structure chosen by nested CV, then × the NL200 factor 0.894; the shape is
 * CoinPoker's showdown flats bias-corrected per band × hand group against Ignition's visible SB flats. Gate (range_qa/
 * gate.py --slot call --family flat_SB): BETTER +0.100 [+0.058, +0.142] nats a hand on 1,110 Ignition SB flats.
 *
 * THE KEY (the builder's live_key(), ported verbatim — sbFlatKey; the test checks it against that function's own
 * outputs). Every key `poolcall_flat_SB_…`; the bucketers are read from the table's own `lookup.bucketers`:
 *   band   the SB's stack AS DEALT, bb, lo ≤ stack < hi: le25 [0,25) 25_65 65_80 80_98 98_110 110p [110,∞)
 *   vband  the same stack for the VPIP keys only: le75 [0,75) 75_90 90p [90,∞)
 *   size   the open's raise-to in bb: oS [0,2.25) oM [2.25,2.75) oL [2.75,∞) (the call table's oXL → oL)
 *   opener UTG / HJ / CO / BTN
 *   vpip   n = his hands at this table before this one, v = those with a voluntary call or raise preflop; known when
 *          n ≥ 20; vpip = (v + a·μ) / (n + a), a = 28.18, μ = 0.28 (Ignition's beta-binomial fit); v30 (< 0.30),
 *          v30_40, v40p (≥ 0.40)
 * Chains (lookup.chain — take the FIRST pattern whose placeholders are all known; every key of every pattern exists):
 *   vpip known:   vs{opener}_{size}_{vband}_{vpip} → {size}_{vband}_{vpip} → vs{opener}_{vband}_{vpip} → {vband}_{vpip}
 *                 → vs{opener}_{size}_{vpip} → {size}_{vpip} → vs{opener}_{vpip} → {vpip} → the whole unknown chain
 *   vpip unknown: vs{opener}_{size}_{band} → {size}_{band} → vs{opener}_{band} → {band} → vs{opener}_{size} → {size}
 *                 → vs{opener} → all
 *
 * THE VPIP AS LIVE CAN SEE IT — THE GAP (documented, not closed): the recipe is "his last 100 5-6-dealt hands at this
 * table before this hand". What the wrapper has (services/seatStats, fde13cf — in memory, per session × table slot ×
 * seat, the current occupant by stack continuity) is SESSION-TO-DATE: every completed hand that seat was dealt since its
 * occupant's tally began, at any table size, no 100-hand window. So: (1) a seat watched more than 100 hands carries
 * all of them (the estimate is steadier, not biased: the window was fixed a priori, never tuned); (2) hands dealt 3-4
 * handed count too (short-handed VPIP runs higher — a few hands at most in a 6-max session); (3) a hand whose last
 * snapshot stopped inside the preflop is not counted (`partial`), nor the hand in progress; (4) the tally is lost on an
 * API restart and restarts when the seat's stack falls between hands (a new occupant — Ignition is anonymous). Never a
 * DB scan on the decision path: the read is seatStats' memory (seatHistoryFor).
 *
 * THE STAKE: `freq` is NL200 (freq_pooled × 0.894) on the keys without a vpip, = freq_pooled on the VPIP keys (no stake
 * factor there). SB_FLAT_OWN_FACTOR=on multiplies freq_pooled by own_nl200_factor (0.765 — Brady's own NL200 tables)
 * INSTEAD on the keys without a vpip, the weights re-water-filled to it (the builder's note); default off (the md:
 * worth ~1 SE out of sample, a selection of tables, revisit when the own histories double). VPIP keys: unchanged.
 *
 * THE SWITCH SB_FLAT_TABLE (config/local.env, read at every decision): off (unset) = today's pool-call cell · v2 = this
 * table. Register entry pool-sbflat-v2. Pure apart from the table (a test hook swaps it).
 */
import TABLE_JSON from "./poolSbFlatRanges.json";
import { wilsonLower } from "./poolTrigger";

export type SbFlatTableMode = "v2" | "off";
export const sbFlatTableMode = (): SbFlatTableMode => (/^v2$/i.test(String(process.env.SB_FLAT_TABLE ?? "").trim()) ? "v2" : "off");
export const sbFlatOwnFactorOn = (): boolean => /^(on|1|true|yes)$/i.test(String(process.env.SB_FLAT_OWN_FACTOR ?? "").trim());

export interface SbFlatCell {
  opener: string | null; size: string | null; band: string | null; vpip: string | null;
  freq: number; freq_pooled: number;
  /** IGNITION flats / SB-vs-open chances in the cell (the trigger's evidence) */
  calls: number; chances: number; shown: number;
  nl200_calls: number; nl200_chances: number;
  cp_calls: number; cp_chances: number; cp_shown: number;
  freq_from: string; shape_from: string;
  groups: Record<string, number>;
  weights: Record<string, number>;
}
interface Bucketer { edges_bb: (number | null)[]; labels: string[] }
export interface SbFlatTable {
  nl200_factor: number; own_nl200_factor: number;
  lookup: {
    chain: { vpip_known: string[]; vpip_unknown: string[] };
    bucketers: {
      band: Bucketer; vband: Bucketer; opener: { labels: string[] };
      size: { edges: Record<string, [number | null, number | null]>; map: Record<string, string> };
      vpip: { mu: number; a: number; known_if: string; codes: Record<string, string> };
    };
  };
  ranges: Record<string, SbFlatCell>;
}
let table: SbFlatTable = TABLE_JSON as unknown as SbFlatTable;
/** TEST HOOK: a table to use instead (null = the shipped one). */
export function setSbFlatTable(t: SbFlatTable | null): void { table = t ?? (TABLE_JSON as unknown as SbFlatTable); waterMemo.clear(); }
export const sbFlatTable = (): SbFlatTable => table;

/** the VPIP is known with this many of his hands (the builder's MIN_VPIP_HANDS) */
export const SB_FLAT_MIN_HANDS = 20;
/** the codes' edges (the builder's VB_EDGES / VB_LAB) */
const VPIP_EDGES = [0.3, 0.4] as const;
const VPIP_CODES = ["v30", "v30_40", "v40p"] as const;

/** lo ≤ x < hi over the bucketer's edges; the builder's cut() CLIPS outside them (a stack ≥ the last finite edge is the
 *  last band). null for a stack that is not a positive number (the builder's `stack is not None and stack > 0`). */
function bucket(b: Bucketer, x: number | null | undefined): string | null {
  if (x == null || !Number.isFinite(x) || !(x > 0)) return null;
  const e = b.edges_bb.map((v) => (v == null ? Infinity : v));
  for (let i = 0; i < b.labels.length; i++) if (x >= e[i]! && x < e[i + 1]!) return b.labels[i]!;
  return x < e[0]! ? b.labels[0]! : b.labels[b.labels.length - 1]!;
}
/** the SB's stack as dealt → the band (the keys without a vpip) */
export const sbFlatBand = (stack: number | null | undefined): string | null => bucket(table.lookup.bucketers.band, stack);
/** the same stack → the VPIP keys' own band */
export const sbFlatVband = (stack: number | null | undefined): string | null => bucket(table.lookup.bucketers.vband, stack);
/** the open's raise-to in bb → oS / oM / oL (null when not a positive number) */
export function sbFlatSize(openTo: number | null | undefined): string | null {
  if (openTo == null || !Number.isFinite(openTo) || !(openTo > 0)) return null;
  for (const [k, [lo, hi]] of Object.entries(table.lookup.bucketers.size.edges)) {
    if ((lo == null || openTo >= lo) && (hi == null || openTo < hi)) return k;
  }
  return null;
}
/** the call table's open qualifier (poolCalls.openQual: oS / oM / oL / oXL) in this table's vocabulary: oXL → oL */
export const sbFlatSizeOfQual = (q: string | null | undefined): string | null =>
  q ? (table.lookup.bucketers.size.map[q] ?? (q in table.lookup.bucketers.size.edges ? q : null)) : null;

export interface SbFlatVpip {
  /** his counted hands (n) and voluntary ones (v) */
  n: number; v: number;
  known: boolean;
  /** the shrunk estimate (v + a·μ) / (n + a) — also for n < 20, for the log */
  est: number;
  /** v30 / v30_40 / v40p when known */
  code: string | null;
}
/** The VPIP recipe on (n, v): known when n ≥ 20, shrunk toward Ignition's pool (a, μ from the table). */
export function sbFlatVpip(n: number | null | undefined, v: number | null | undefined): SbFlatVpip | null {
  if (n == null || v == null || !Number.isFinite(n) || !Number.isFinite(v) || n < 0) return null;
  const { a, mu } = table.lookup.bucketers.vpip;
  const est = (v + a * mu) / (n + a);
  const known = n >= SB_FLAT_MIN_HANDS;
  let i = 0;
  while (i < VPIP_EDGES.length && est >= VPIP_EDGES[i]!) i++;
  return { n, v, known, est, code: known ? VPIP_CODES[i]! : null };
}

export interface SbFlatCtx {
  /** the opener's 6-max seat (UTG / HJ / CO / BTN; anything else = unknown) */
  opener?: string | null;
  /** the open's raise-to in bb */
  openTo?: number | null;
  /** the SB's stack as dealt, bb */
  stack?: number | null;
  /** his history at this table (seatStats): counted hands and VPIP hands; null = no history */
  seen?: { n: number; v: number } | null;
}
export interface SbFlatKey {
  key: string;
  chain: "vpip_known" | "vpip_unknown";
  vpipKnown: boolean;
  /** the 0-based position of the pattern taken in that chain (the vpip_known chain continues into the unknown one) */
  step: number;
  pattern: string;
  /** the bucketed values (absent = unknown) */
  fields: { opener?: string; size?: string; band?: string; vband?: string; vpip?: string };
  vpip: SbFlatVpip | null;
}

/** "poolcall_flat_SB_vs{opener}_{size}" filled, or null when a placeholder is unknown (the builder's fill()). */
function fill(pattern: string, d: Record<string, string | undefined>): string | null {
  let ok = true;
  const out = pattern.replace(/\{(\w+)\}/g, (_m, k: string) => { const v = d[k]; if (v == null) ok = false; return v ?? ""; });
  return ok ? out : null;
}

/** THE REFERENCE LOOKUP, ported from the builder's live_key(): bucket, then the first chain pattern fully known. */
export function sbFlatKey(ctx: SbFlatCtx): SbFlatKey {
  const d: SbFlatKey["fields"] = {};
  const op = String(ctx.opener ?? "").toUpperCase();
  if (table.lookup.bucketers.opener.labels.includes(op)) d.opener = op;
  const band = sbFlatBand(ctx.stack), vband = sbFlatVband(ctx.stack);
  if (band) d.band = band;
  if (vband) d.vband = vband;
  const size = sbFlatSize(ctx.openTo);
  if (size) d.size = size;
  const vp = ctx.seen ? sbFlatVpip(ctx.seen.n, ctx.seen.v) : null;
  const known = !!vp?.known;
  if (known) d.vpip = vp!.code!;
  const chainName = known ? "vpip_known" : "vpip_unknown";
  const chain = table.lookup.chain[chainName];
  for (let i = 0; i < chain.length; i++) {
    const k = fill(chain[i]!, d);
    // every key of every pattern exists (the builder asserts it); a missing one is skipped, never served
    if (k != null && k in table.ranges) return { key: k, chain: chainName, vpipKnown: known, step: i, pattern: chain[i]!, fields: d, vpip: vp };
  }
  return { key: "poolcall_flat_SB_all", chain: chainName, vpipKnown: known, step: chain.length - 1, pattern: "poolcall_flat_SB_all", fields: d, vpip: vp };
}

const classCombos = (c: string): number => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
/** the builder's waterfill(): scale the class weights (∝ his share / combos) so Σ PC·min(1, s·w) = f */
export function waterfill(weights: Record<string, number>, f: number): Record<string, number> {
  const entries = Object.entries(weights).map(([c, w]) => [c, Math.max(0, Number(w) || 0), classCombos(c) / 1326] as const);
  let lo = 0, hi = 1e6;
  for (let it = 0; it < 100; it++) {
    const s = (lo + hi) / 2;
    const tot = entries.reduce((acc, [, w, pc]) => acc + pc * Math.min(1, s * w), 0);
    if (tot < f) lo = s; else hi = s;
  }
  return Object.fromEntries(entries.map(([c, w]) => [c, Math.min(1, lo * w)]));
}
const waterMemo = new Map<string, Record<string, number>>();

export interface SbFlatRange {
  key: string;
  weights: Record<string, number>;
  /** the rate served (NL200; own NL200 under SB_FLAT_OWN_FACTOR on a key without a vpip) */
  freq: number;
  /** Ignition counts — the trigger's evidence (poolTrigger.poolCiLower) */
  calls: number; chances: number;
  nl200Calls: number; nl200Chances: number;
  /** the own-tables factor was applied (the weights re-water-filled to it) */
  own: boolean;
  cell: SbFlatCell;
}
/** The key's range. `own` (default: SB_FLAT_OWN_FACTOR) applies own_nl200_factor on a key without a vpip. */
export function sbFlatRange(key: string, opts: { own?: boolean } = {}): SbFlatRange | null {
  const cell = table.ranges[key];
  if (!cell) return null;
  const own = (opts.own ?? sbFlatOwnFactorOn()) && cell.vpip == null && table.own_nl200_factor > 0;
  let weights = cell.weights, freq = cell.freq;
  if (own) {
    freq = cell.freq_pooled * table.own_nl200_factor;
    const mk = `${key}|${freq}`;
    weights = waterMemo.get(mk) ?? waterfill(cell.weights, freq);
    waterMemo.set(mk, weights);
  }
  return { key, weights: { ...weights }, freq, calls: cell.calls, chances: cell.chances, nl200Calls: cell.nl200_calls, nl200Chances: cell.nl200_chances, own, cell };
}

/**
 * THE EVIDENCE BOUND FOR THE TRIGGER (2026-10-10, the independent review's P1 / P2). The served rate is NL200 (`freq` =
 * freq_pooled × 0.894 off the VPIP keys; = freq_pooled on them; × 0.765 under SB_FLAT_OWN_FACTOR) but the cell's
 * Ignition counts are NL100 + NL200 pooled, so the Wilson bound is taken on the POOLED counts and scaled by the same
 * factor as the rate: ci = wilsonLower(calls, chances) × (served freq / freq_pooled). Not the NL200 counts: 46 of the 72
 * full non-VPIP keys have under 50 NL200 chances and the VPIP keys ≤ 72 — the bound would be null or useless there.
 * A cell with NO Ignition chances (six VPIP cells, e.g. vsUTG_oS_le75_v40p: its freq is its parent's × the CoinPoker
 * ratio) takes the bound from the first key after it in its own chain with ≥ SB_FLAT_CI_MIN_CHANCES chances — the
 * evidence the hierarchy itself rests on — scaled by THAT key's factor; `borrowed` says so (the note names the key).
 */
export const SB_FLAT_CI_MIN_CHANCES = 20;
export interface SbFlatEvidence {
  /** the scaled 95% lower bound (null: no key in the chain carries counts) */
  ci: number | null;
  /** the key whose counts gave it (the key taken, or the ancestor when borrowed) */
  key: string;
  calls: number; chances: number;
  /** served freq / freq_pooled of that key */
  scale: number;
  borrowed: boolean;
}
export function sbFlatEvidence(k: Pick<SbFlatKey, "key" | "chain" | "step" | "fields">, opts: { own?: boolean } = {}): SbFlatEvidence {
  const ownOn = opts.own ?? sbFlatOwnFactorOn();
  const at = (key: string, cell: SbFlatCell, borrowed: boolean): SbFlatEvidence => {
    const own = ownOn && cell.vpip == null && table.own_nl200_factor > 0;
    const served = own ? cell.freq_pooled * table.own_nl200_factor : cell.freq;
    const scale = cell.freq_pooled > 0 ? served / cell.freq_pooled : 1;
    const lo = wilsonLower(cell.calls, cell.chances);
    return { ci: Number.isFinite(lo) ? lo * scale : null, key, calls: cell.calls, chances: cell.chances, scale, borrowed };
  };
  const cell = table.ranges[k.key];
  if (!cell) return { ci: null, key: k.key, calls: 0, chances: 0, scale: 1, borrowed: false };
  if (cell.chances > 0) return at(k.key, cell, false);
  const chain = table.lookup.chain[k.chain] ?? [];
  for (let i = k.step + 1; i < chain.length; i++) {
    const key = fill(chain[i]!, k.fields);
    const c = key != null ? table.ranges[key] : undefined;
    if (c && c.chances >= SB_FLAT_CI_MIN_CHANCES) return at(key!, c, true);
  }
  return { ci: null, key: k.key, calls: 0, chances: 0, scale: 1, borrowed: false };
}

/** "vpip v30 (n=45, v=10, 26.7%)" / "vpip unknown (n=12)" / "vpip unknown (no seat history)" — the note's and the log's */
export function sbFlatVpipText(k: Pick<SbFlatKey, "vpip" | "vpipKnown">): string {
  const vp = k.vpip;
  if (!vp) return "vpip unknown (no seat history)";
  return k.vpipKnown ? `vpip ${vp.code} (n=${vp.n}, v=${vp.v}, ${(100 * vp.est).toFixed(1)}%)` : `vpip unknown (n=${vp.n})`;
}
