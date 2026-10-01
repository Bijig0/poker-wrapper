/**
 * A PREFLOP CHART'S SETUP — what an answer's chart was solved WITH (2026-09-24, Brady on the hand page: "it just says
 * the stack size + ignition heads up whatever, but not the actual rake cap and config"; "for the uneven stacks … it
 * doesn't show what specifically the uneven stacks look like").
 *
 * One shape for every preflop source a hand's answers name:
 *   - our HRC charts: the sidecar the solver run wrote (chartCatalog.sidecarFacts — rake + cap, ante, the seat line,
 *     the size menu) and the id grammar (chartCatalog.parseHrcId — per-seat stacks, open / 3-bet, lock, generation);
 *   - the crawled GTO Wizard library ("Cash6m500zGeneral", "6max Cash6m500zGeneral@100"): THEIR structure, NL500;
 *   - a GTO Wizard AI preflop tree ("gtow-ai · 3-handed · BTN:100/SB:103.5/BB:102.5"): built from the table, so its
 *     label carries the seats' stacks and the answer's own note the rake cap it was sent.
 * Facts only: what the source does not state is null — never a default presented as a reading. The table's side
 * (its stacks as dealt, its ante) is routes/dashboard.ts's /chart-setup, beside this.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHrcId, describeChart, sidecarFacts, SOLUTIONS_DIR, SEATS } from "./chartCatalog";
import { SOLUTION_SETS } from "./gtowCdp";

export interface ChartSetupSeat {
  pos: string;
  stackBb: number | null;
}

export interface ChartSetup {
  id: string;
  kind: "hrc" | "gtow-library" | "gtow-ai-preflop";
  /** who solved it, in words */
  solver: string;
  /** what a human reads (chartCatalog.describeChart for our charts) */
  name: string;
  room: string | null;
  stake: string | null;
  /** the stake's big blind in dollars (NL200 → 2), to price the cap; null when the stake is not stated */
  bbUsd: number | null;
  /** every seat of the solve with its starting stack, in the solve's own order */
  seats: ChartSetupSeat[];
  /** every seat at the same depth */
  even: boolean | null;
  blinds: { sb: number; bb: number } | null;
  /** per player, bb; 0 = no ante; null = the source does not say */
  anteBb: number | null;
  rake: { pct: number; capBb: number; nfnd: boolean | null } | null;
  /** the size menu, as the solve states it */
  sizes: string[];
  /** which solve generation / variant, when it is not the plain base run */
  generation: string | null;
  nodes: number | null;
  /** the solver run's own description line (the sidecar's `format`), repaired */
  format: string | null;
  /** where these facts were read */
  from: string;
  notes: string[];
}

/** Families whose trees are cash games at 0.5 / 1 with no ante unless the sidecar says otherwise. */
const CASH = new Set(["6max", "3max-asym", "3max-lock", "3max", "hu-grid", "hu-size"]);
const GENERATION: Record<string, string | null> = {
  base: null,
  v2: "v2 · full postflop betting",
  v2b: "A/B run · flop-only betting",
  v2ci: "re-solved (v2ci) · river betting + CFR refinement",
  lock: "locked root",
  patch: "bespoke per-seat stacks (a patch chart)",
  accept: "acceptance check",
};
const usdOf = (stake: string | null | undefined): number | null => {
  const m = String(stake ?? "").match(/NL(\d+)/);
  return m ? Number(m[1]) / 100 : null;
};
const evenOf = (seats: ChartSetupSeat[]): boolean | null =>
  seats.length && seats.every((s) => s.stackBb != null) ? seats.every((s) => s.stackBb === seats[0]!.stackBb) : null;

const hrcCache = new Map<string, ChartSetup | null>();

function hrcSetup(id: string): ChartSetup | null {
  if (hrcCache.has(id)) return hrcCache.get(id)!;
  // an id reaches a file path: nothing but the id grammar's own characters
  if (!/^[\w.-]+$/.test(id)) return null;
  const dims = parseHrcId(id);
  let meta: any = null;
  const file = join(SOLUTIONS_DIR, `${id}.meta.json`);
  try { if (existsSync(file)) meta = JSON.parse(readFileSync(file, "utf-8")); } catch { meta = null; }
  if (!meta && dims.family === "other") { hrcCache.set(id, null); return null; }
  const f = sidecarFacts(meta);
  const order: string[] = Array.isArray(meta?.seats) ? meta.seats.map(String)
    : dims.seats ?? (dims.stacksBB ? SEATS.filter((p) => dims.stacksBB![p] != null) : []);
  const depth = Number(meta?.depth_bb);
  // the run's own seat line first (it is what HRC was given), then the id grammar, then the sidecar's one depth
  const seats: ChartSetupSeat[] = f.seatStacks
    ?? (dims.stacksBB ? order.filter((p) => dims.stacksBB![p] != null).map((p) => ({ pos: p, stackBb: dims.stacksBB![p]! })) : null)
    ?? order.map((p) => ({ pos: p, stackBb: Number.isFinite(depth) ? depth : null }));
  const cash = CASH.has(String(dims.family));
  const sizes = [...f.sizes];
  const has = (re: RegExp) => sizes.some((s) => re.test(s));
  if (dims.open != null && !has(/open/i)) sizes.unshift(dims.open === "limp" ? "limp tree" : `${order.length === 2 ? `${order[0]} opens` : "opens"} ${dims.open}x`);
  if (dims.threeBet != null && !has(/3-?bet/i)) sizes.push(dims.threeBet === "jam" ? "3-bet: all-in" : `3-bet to ${dims.threeBet}bb`);
  if (dims.lock) sizes.push(`${dims.lock.seat} locked to ${dims.lock.action}`);
  const site = dims.site ?? null;
  const out: ChartSetup = {
    id, kind: "hrc", solver: "HRC",
    name: describeChart({ ...dims, id, label: f.label ?? id }),
    room: site ? (site.startsWith("cp") ? "CoinPoker" : site.startsWith("ign") ? "Ignition" : site) : null,
    stake: dims.stake ?? null, bbUsd: usdOf(dims.stake),
    seats, even: evenOf(seats),
    blinds: f.sbBb != null ? { sb: f.sbBb, bb: 1 } : cash ? { sb: 0.5, bb: 1 } : null,
    anteBb: f.anteBb ?? (cash ? 0 : null),
    rake: f.rake,
    sizes,
    generation: GENERATION[dims.variant ?? "base"] ?? null,
    nodes: typeof meta?.nodes === "number" ? meta.nodes : null,
    format: f.format,
    from: meta ? `the solver run's sidecar (${id}.meta.json) and the chart id` : "the chart id alone (no sidecar on this machine)",
    notes: [],
  };
  if (hrcCache.size > 2000) hrcCache.clear();
  hrcCache.set(id, out);
  return out;
}

/** "Cash6m500zGeneral", "CashHu500zComplex", "6max Cash6m500zGeneral@100", "gtow:Cash6m500zGeneral@100" */
function librarySetup(id: string, depthHint: number | null): ChartSetup | null {
  const m = id.match(/^(?:gtow:|6max )?(Cash(?:(\d)m(\d+)|Hu(\d+))z(\w+?))(?:@(\d+))?$/);
  if (!m) return null;
  const gametype = m[1]!, stakeN = Number(m[3] ?? m[4]);
  const set = SOLUTION_SETS.find((s) => s.gametype === gametype);
  const depth = m[6] ? Number(m[6]) : depthHint;
  const seatNames: string[] = set?.seats ?? (m[2] ? SEATS.slice(-Number(m[2])) : ["SB", "BB"]);
  const seats = seatNames.map((pos) => ({ pos, stackBb: depth ?? null }));
  return {
    id, kind: "gtow-library", solver: "GTO Wizard library (crawled)",
    name: `${set?.label ?? gametype}${depth != null ? ` · ${depth}bb` : ""}`,
    room: "GTO Wizard library", stake: `NL${stakeN}`, bbUsd: stakeN / 100,
    seats, even: true, blinds: { sb: 0.5, bb: 1 }, anteBb: 0,
    // the library's own structure — the same the AI custom tree falls back to (gtowApi.DEFAULT_TREE_RAKE)
    rake: { pct: 5, capBb: 0.6, nfnd: null },
    sizes: [`GTO Wizard's own "${m[5]}" size menu`],
    generation: null, nodes: null, format: null,
    from: "the library's gametype (GTO Wizard's NL500 structure, not the table's)",
    notes: m[6] ? [] : [`depth ${depth != null ? `${depth}bb is the table's, as logged — the crawl answers from its nearest set` : "not recorded with the answer"}`],
  };
}

/** "gtow-ai · 3-handed · BTN:100/SB:103.5/BB:102.5" — a tree GTO Wizard AI built from the table (services/gtowAiPreflop). */
function aiPreflopSetup(id: string, note: string | null): ChartSetup | null {
  const m = id.match(/^gtow-ai · (\d+)-handed · (.+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const seats = m[2]!.split("/").map((x) => {
    const [pos, s] = x.split(":");
    return { pos: String(pos ?? "").trim(), stackBb: s != null && Number.isFinite(Number(s)) ? Number(s) : null };
  }).filter((s) => s.pos);
  const cap = note?.match(/rake (\d+(?:\.\d+)?)% cap (\d+(?:\.\d+)?)bb/);
  const notes: string[] = [];
  if (note && /dead SB approximated/.test(note)) notes.push("the missing small blind was approximated (a ghost seat posting a penny that can only fold)");
  const dead = note?.match(/(\d+(?:\.\d+)?)bb dead money in the pot/);
  if (dead) notes.push(`${dead[1]}bb of dead money in the pot`);
  if (!cap) notes.push("the rake cap was not in this answer's note");
  return {
    id, kind: "gtow-ai-preflop", solver: "GTO Wizard AI (Ultra) — a tree built from this table",
    name: `GTO Wizard AI preflop · ${n}-handed`,
    room: null, stake: null, bbUsd: null,
    seats, even: evenOf(seats),
    blinds: null,
    // the request sends no ante (gtowAiPreflop.treeBody: ante null)
    anteBb: 0,
    // the request's rake is 5% with the cap by players dealt, and preflop_rake_type no_flop_no_drop (treeBody)
    rake: cap ? { pct: Number(cap[1]), capBb: Number(cap[2]), nfnd: true } : null,
    sizes: n <= 2
      ? ["both seats: our size menu, plus every size seen in the line"]
      : ["your seat: our size menu, plus every size seen in the line", "the other seats: the size each actually used (one default where none)"],
    generation: null, nodes: null, format: null,
    from: "the tree's label (its seats and stacks) and the answer's note (its rake cap)",
    notes,
  };
}

/**
 * The setup of one chart id as logged on an answer. `depth` / `note` are that answer's own (`answers.depth`,
 * `answers.warning`): the library charts log no depth in their id, and an AI preflop tree states its rake cap in
 * the note. Null for an id that is not a preflop chart (an MES board, a composite label).
 */
export function chartSetup(id: string, hint: { depth?: number | null; note?: string | null } = {}): ChartSetup | null {
  const s = String(id ?? "").trim();
  if (!s) return null;
  if (/^gtow-ai · /.test(s)) return aiPreflopSetup(s, hint.note ?? null);
  const lib = librarySetup(s, hint.depth != null && Number.isFinite(Number(hint.depth)) ? Number(hint.depth) : null);
  if (lib) return lib;
  if (/\s/.test(s)) return null;
  return hrcSetup(s);
}
