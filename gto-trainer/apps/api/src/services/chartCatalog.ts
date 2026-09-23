import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOLUTION_SETS } from "./gtowCdp";

/**
 * The chart catalog: one structured inventory of every preflop chart this
 * machine can answer from, across all storage tiers — the HRC solution
 * corpus (sidecar-indexed, bodies local-cached / canonical in R2) and the
 * GTOW crawl SQLite. Ids are parsed into structured dimensions ONCE here, at
 * build time; consumers (the dashboard's Catalog view, and eventually the
 * chart resolver) read fields, never regexes.
 *
 * This is the read side of the centralization plan: the same entries,
 * uploaded to R2 as manifest.json, become the portable catalog a fresh
 * machine bootstraps from.
 */

/** Every seat name that appears in a chart id, in preflop acting order. */
export const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
export type Seat = (typeof SEATS)[number];

export interface CatalogEntry {
  id: string;
  /** Which corpus/walker understands this chart. */
  source: "hrc" | "gtow";
  family:
    | "3max-asym"
    | "3max-lock"
    | "3max"
    | "6max"
    | "hu-grid"
    | "hu-size"
    | "husng"
    | "gtow"
    | "other";
  /** The sidecar's own label, as written by the solver run. Kept for provenance. */
  label: string;
  /** What a human reads — generated from the dims. See describeChart. */
  name: string;
  format?: string;
  /** Rake model site key (ign200, cp100, …) when the id carries one. */
  site?: string;
  players?: number;
  seats?: string[];
  /** Per-seat starting stacks in bb — the real dimensions of the solve. */
  stacksBB?: Record<string, number>;
  /** Effective/deep depth in bb. */
  depth?: number;
  shortDepth?: number;
  shortSeat?: Seat | "EQ";
  /** Open size the tree was solved with; "limp" for a limp tree. */
  open?: number | "limp";
  threeBet?: number | "jam";
  /** Stake the rake model is for, as played: "NL200", "NL25", "NL50". */
  stake?: string;
  /** Which solve GENERATION this is. Charts of the same shape differ by the tree
   *  and the rake they were solved under, and picking the wrong generation is a
   *  silent wrong answer — so it is a first-class dimension, not a suffix. */
  variant?: "base" | "v2" | "v2b" | "v2ci" | "lock" | "patch" | "accept";
  /** Lock charts only: whose action is pinned at the root, and to what. */
  lock?: { seat: Seat; action: string };
  /** Stack shape, for filtering: every seat equal, one seat short, or a bespoke patch. */
  shape?: "even" | "short" | "patch";
  nodes?: number;
  /** Canonical location (R2 for HRC bodies, the tracked sqlite for GTOW). */
  location: string;
  /** HRC only: the body .json.gz is on this machine's disk right now. */
  cachedLocally?: boolean;
  /** How the Ignition study path uses this chart. Null = browse-only. */
  routed: string | null;
}

export interface Catalog {
  builtAt: number;
  entries: CatalogEntry[];
  summary: {
    total: number;
    routed: number;
    byFamily: Record<string, number>;
    solutionsDir: string | null;
    gtowDb: boolean;
  };
}

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const SOLUTIONS_DIR =
  process.env.CHART_SOLUTIONS_DIR ??
  join(REPO_ROOT, "analysis", "pipeline", "solve", "exploit_ui", "solutions");
const GTOW_DB = join(import.meta.dir, "..", "..", "data", "preflop-db.sqlite");
const R2_UI = "r2://poker-solve-db/hrc-ui";

const num = (s: string): number => Number(s.replace("_", "."));
/** Seats a 6-max patch chart leaves alone sit at the reload line. */
const DEEP_DEFAULT = 100;

/** Structured dims out of an HRC solution id — the one place this grammar is
 *  parsed. (The analysis app's sources.ts still has its own copy for the
 *  SolverStudy picker; both die when the resolver reads catalog fields.) */
/** Rake-model site key → the stake it is the rake for. A trailing "a" on a CoinPoker
 *  key means the with-ante structure (hrc_hu_cp200a_*), which is a different solve at
 *  the same stake. */
const stakeOf = (site: string): string | undefined => {
  const m = site.toLowerCase().match(/^(ign|cp)(\d+)(a?)$/);
  return m ? `NL${m[2]}${m[3] ? " + ante" : ""}` : undefined;
};
const openOf = (tok: string): number | "limp" => (tok === "limp" ? "limp" : num(tok));

/**
 * Structured dims out of a chart id. THE ONE PLACE THIS GRAMMAR IS PARSED — and it
 * has to know all of it: until 2026-09-20 it knew five grammars, and the three newest
 * families (the 6-max ring grid, the 2ci re-solves, the locked-root charts) fell
 * through to `family: "other"` with no dims at all. That was 345 of 2,183 charts —
 * including every chart the ring strategy actually answers from — rendering as a bare
 * id with em-dashes in every column, and unreachable by any filter. Every id shape in
 * the corpus is covered below; anything genuinely unknown still lands on "other".
 */
export function parseHrcId(id: string): Partial<CatalogEntry> {
  // 3-max asymmetric grid, all four generations:
  //   ign200_3maxasym_D100_s70_btn      the original
  //   ign200_3maxasym2_D100_s100_eq     v2, full postflop
  //   ign200_3maxasym2b_D100_s100_eq    A/B, flop-only betting
  //   ign25_3maxasym2ci_D100_s70_bb     v2 + river betting + CFR refinement (what we play)
  //   ..._eq_hrc1                       the same recipe, solved on a box, as an acceptance check
  const asym = id.match(/^(\w+?)_3maxasym(2|2b|2ci)?_D([\d_]+?)_s([\d_]+?)_(btn|sb|bb|eq)(?:_(hrc\d+))?$/);
  if (asym) {
    const d = num(asym[3]!);
    const sd = num(asym[4]!);
    const seat = asym[5]!.toUpperCase() as Seat | "EQ";
    const stacksBB: Record<string, number> = { BTN: d, SB: d, BB: d };
    if (seat !== "EQ") stacksBB[seat] = sd;
    const gen = asym[2];
    return {
      family: "3max-asym", site: asym[1]!, stake: stakeOf(asym[1]!), players: 3,
      seats: ["BTN", "SB", "BB"],
      depth: d, shortDepth: sd, shortSeat: seat, stacksBB,
      shape: seat === "EQ" ? "even" : "short",
      variant: asym[6] ? "accept" : gen === "2ci" ? "v2ci" : gen === "2b" ? "v2b" : gen === "2" ? "v2" : "base",
    };
  }
  // Locked-root 3-max: the same even tree with one seat's first action PINNED, so the
  // rest of the tree is a best response to it — ign25_3maxlock_D100_s100_eq_BTN2x,
  // ..._eq_SBlimp. The lock is the whole point of the chart, so it is a dimension.
  const lock = id.match(/^(\w+?)_3maxlock_D([\d_]+?)_s([\d_]+?)_(btn|sb|bb|eq)_(BTN|SB|BB)(limp|[\d_]+x)$/);
  if (lock) {
    const d = num(lock[2]!);
    return {
      family: "3max-lock", site: lock[1]!, stake: stakeOf(lock[1]!), players: 3,
      seats: ["BTN", "SB", "BB"],
      depth: d, shortDepth: num(lock[3]!), shortSeat: lock[4]!.toUpperCase() as Seat | "EQ",
      stacksBB: { BTN: d, SB: d, BB: d }, shape: "even", variant: "lock",
      lock: { seat: lock[5]! as Seat, action: lock[6] === "limp" ? "limp" : `${lock[6]!.replace("_", ".")} open` },
      open: lock[6] === "limp" ? "limp" : num(lock[6]!.replace(/x$/, "")),
    };
  }
  // 6-max ring grid. A tree is solved with EVERY seat opening ONE size, so the open
  // size is a chart dimension here and the seat is NOT — one 2.5x tree holds UTG's
  // open, HJ's open and the rest. See services/hrc6max.ts.
  //   even      ign200_6max_D100_o2_5, ign200_6max_D125_olimp
  //   one short ign200_6max_D100_s70_BTN_o2_5
  //   patch     ign200_6max_P_BTN150_BB80_o2   (bespoke per-seat stacks)
  const six = id.match(/^(\w+?)_6max_D([\d_]+?)(?:_s([\d_]+?)_(UTG|HJ|CO|BTN|SB|BB))?_o(limp|[\d_]+)$/);
  if (six) {
    const d = num(six[2]!);
    const stacksBB: Record<string, number> = Object.fromEntries(SEATS.map((p) => [p, d]));
    if (six[3] && six[4]) stacksBB[six[4]!] = num(six[3]!);
    return {
      family: "6max", site: six[1]!, stake: stakeOf(six[1]!), players: 6, seats: [...SEATS],
      depth: d, stacksBB, open: openOf(six[5]!),
      ...(six[3] ? { shortDepth: num(six[3]!), shortSeat: six[4]! as Seat } : {}),
      shape: six[3] ? "short" : "even",
      variant: "base",
    };
  }
  // a SIZE patch (2026-09-22) adds a menu-level suffix — _i20 (iso), _3b8, _4b30 — and an all-100 table is P_EVEN
  const patch = id.match(/^(\w+?)_6max_P_((?:(?:UTG|HJ|CO|BTN|SB|BB)[\d_]+_)*(?:UTG|HJ|CO|BTN|SB|BB)[\d_]+|EVEN)_o(limp|\d+(?:_5)?)(?:_(?:i|3b|4b|5b)[\d_]+)*$/);
  if (patch) {
    const stacksBB: Record<string, number> = Object.fromEntries(SEATS.map((p) => [p, DEEP_DEFAULT]));
    for (const m of patch[2]!.matchAll(/(UTG|HJ|CO|BTN|SB|BB)([\d_]+)/g)) stacksBB[m[1]!] = num(m[2]!);
    return {
      family: "6max", site: patch[1]!, stake: stakeOf(patch[1]!), players: 6, seats: [...SEATS],
      depth: Math.max(...Object.values(stacksBB)), stacksBB, open: openOf(patch[3]!),
      shape: "patch", variant: "patch",
    };
  }
  const tri = id.match(/^(\w+?)_3max_(\d+)_(btn|sb)([\d_]+?)_3b([\d_]+)$/);
  if (tri) {
    const d = Number(tri[2]!);
    return {
      family: "3max", site: tri[1]!, stake: stakeOf(tri[1]!), players: 3, depth: d,
      seats: ["BTN", "SB", "BB"], shape: "even", variant: "base",
      stacksBB: { BTN: d, SB: d, BB: d },
      open: num(tri[4]!), threeBet: num(tri[5]!),
    };
  }
  const grid = id.match(/^hrc_hu_(\w+?)_d(\d+)_o([\d_]+?)_3b([\d_]+)$/);
  if (grid) {
    const d = Number(grid[2]!);
    return {
      family: "hu-grid", site: grid[1]!, stake: stakeOf(grid[1]!), players: 2, depth: d,
      seats: ["SB", "BB"], shape: "even", variant: "base",
      stacksBB: { SB: d, BB: d }, open: num(grid[3]!), threeBet: num(grid[4]!),
    };
  }
  const size = id.match(/^hrc_hu_(\w+?)_([\d_]+)x$/);
  if (size) {
    return {
      family: "hu-size", site: size[1]!, stake: stakeOf(size[1]!), players: 2, depth: 100,
      seats: ["SB", "BB"], shape: "even", variant: "base",
      stacksBB: { SB: 100, BB: 100 }, open: num(size[2]!),
    };
  }
  const sng = id.match(/^husng_d([\d_]+?)_o([\d_]+?)_3b([\d_]+|jam)$/);
  if (sng) {
    const d = num(sng[1]!);
    return {
      family: "husng", players: 2, depth: d, stacksBB: { SB: d, BB: d },
      seats: ["SB", "BB"], shape: "even", variant: "base",
      open: num(sng[2]!), threeBet: sng[3] === "jam" ? "jam" : num(sng[3]!),
    };
  }
  return { family: "other" };
}

/** Deep rungs that have a re-solved (v2ci) even chart — services/hrc3max.ts prefers one
 *  over EVERY base chart at that rung, uneven ones included, and falls back to the base
 *  generation at every other rung. Read here for the same reason it is read there: which
 *  generation answers is a fact about the manifest, not about the id. */
const v2ciRungs = (): Record<string, Set<number>> => {
  try {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "resolved-charts.json"), "utf-8")) as Record<string, number[]>;
    return Object.fromEntries(Object.entries(raw).map(([site, rungs]) => [site, new Set(rungs)]));
  } catch { return {}; }
};
const V2CI = v2ciRungs();

/** How the live study path uses a chart (see fastSolve). */
const routedFor = (e: Partial<CatalogEntry>, id: string): string | null => {
  if (e.family === "3max-asym") {
    if (e.variant === "v2" || e.variant === "v2b") return "superseded experiment";
    if (e.variant === "accept") return "acceptance check";
    if (e.variant === "v2ci") return e.shortSeat === "EQ" || e.site === "ign25" ? "3-handed preflop (live)" : "solved, not picked";
    // base generation: live at every rung the re-solve has not reached
    return e.depth != null && V2CI[e.site ?? ""]?.has(e.depth) ? "superseded by the re-solved rung" : "3-handed preflop (live)";
  }
  // The ring strategy has answered preflop from this grid since the 2026-09-17 cutover
  // (services/hrc6max.ts). The catalog still said browse-only for all 64 of them.
  if (e.family === "6max") return e.shape === "patch" ? "6-max ring, bespoke stacks (on demand)" : "6-max ring preflop (live)";
  if (e.family === "3max-lock") return "locked-root study (browse)";
  if (e.family !== "gtow") return null; // HRC HU/3max/husng: SolverStudy browse-only
  if (id.startsWith("gtow:Cash6m500zGeneral@")) return "6-max default + 3-max fallback";
  if (id.startsWith("gtow:CashHu500zComplex@")) return "heads-up default";
  return "on request (setId)";
};

/**
 * The name a human reads. Built from the PARSED DIMS, never from the sidecar `label`:
 * a quarter of those labels are mojibake ("3-max 100bb even Â· rich tree"), they
 * disagree with each other on word order, and several are stale. The id stays as the
 * tooltip and the mono column — this is what goes in the first column and what the
 * search box matches against.
 */
export function describeChart(e: Partial<CatalogEntry> & { id: string; label?: string }): string {
  const bits: string[] = [];
  const game = e.family === "6max" ? "6-max" : e.family === "husng" ? "HU SnG"
    : e.players === 2 ? "heads-up" : e.players === 3 ? "3-max" : e.players ? `${e.players}-max` : null;
  if (game) bits.push(game);
  if (e.depth != null) {
    if (e.shape === "patch" && e.stacksBB) bits.push(SEATS.filter((p) => e.stacksBB![p] != null).map((p) => `${p} ${e.stacksBB![p]}bb`).join(" · "));
    else if (e.shortSeat && e.shortSeat !== "EQ" && e.shortDepth != null && e.shortDepth !== e.depth) bits.push(`${e.depth}bb, ${e.shortSeat} short ${e.shortDepth}bb`);
    else bits.push(`${e.depth}bb even`);
  }
  if (e.open != null && !e.lock) bits.push(e.open === "limp" ? "limp tree" : `${e.open}x open`);
  if (e.threeBet != null) bits.push(e.threeBet === "jam" ? "3-bet jam" : `${e.threeBet}bb 3-bet`);
  if (e.lock) bits.push(`${e.lock.seat} locked to ${e.lock.action}`);
  const gen = e.variant === "v2ci" ? (e.site === "ign25" ? null : "re-solved (v2ci)") : e.variant === "v2b" ? "A/B flop-only"
    : e.variant === "v2" ? "v2 full postflop" : e.variant === "accept" ? "acceptance check" : null;
  if (gen) bits.push(gen);
  if (e.stake) bits.push(`${e.site?.startsWith("cp") ? "CoinPoker" : "Ignition"} ${e.stake}`);
  else if (e.site) bits.push(e.site);
  return bits.length ? bits.join(" · ") : (e.label ?? e.id);
}

function hrcEntries(): CatalogEntry[] {
  if (!existsSync(SOLUTIONS_DIR)) return [];
  const out: CatalogEntry[] = [];
  for (const f of readdirSync(SOLUTIONS_DIR)) {
    if (!f.endsWith(".meta.json")) continue;
    const base = f.slice(0, -".meta.json".length);
    let meta: any;
    try {
      meta = JSON.parse(readFileSync(join(SOLUTIONS_DIR, f), "utf-8"));
    } catch {
      continue; // one bad sidecar shouldn't hide the corpus
    }
    const id = String(meta.id ?? base);
    const dims = parseHrcId(id);
    out.push({
      id,
      source: "hrc",
      family: dims.family ?? "other",
      label: String(meta.label ?? id),
      name: describeChart({ ...dims, id, label: String(meta.label ?? id) }),
      format: meta.format ? String(meta.format) : undefined,
      ...(dims.site ? { site: dims.site } : {}),
      players: dims.players ?? (Array.isArray(meta.seats) ? meta.seats.length : undefined),
      ...(Array.isArray(meta.seats) ? { seats: meta.seats as string[] } : {}),
      ...(dims.stacksBB ? { stacksBB: dims.stacksBB } : {}),
      ...(dims.depth != null ? { depth: dims.depth } : {}),
      ...(dims.shortDepth != null ? { shortDepth: dims.shortDepth } : {}),
      ...(dims.shortSeat ? { shortSeat: dims.shortSeat } : {}),
      ...(dims.open != null ? { open: dims.open } : {}),
      ...(dims.threeBet != null ? { threeBet: dims.threeBet } : {}),
      ...(dims.stake ? { stake: dims.stake } : {}),
      ...(dims.variant ? { variant: dims.variant } : {}),
      ...(dims.shape ? { shape: dims.shape } : {}),
      ...(dims.lock ? { lock: dims.lock } : {}),
      ...(typeof meta.nodes === "number" ? { nodes: meta.nodes } : {}),
      location: `${R2_UI}/${id}.json.gz`,
      // older solutions were written uncompressed (.json) — both count
      cachedLocally:
        existsSync(join(SOLUTIONS_DIR, `${base}.json.gz`)) ||
        existsSync(join(SOLUTIONS_DIR, `${base}.json`)),
      routed: routedFor(dims, id),
    });
  }
  return out;
}

function gtowEntries(): CatalogEntry[] {
  if (!existsSync(GTOW_DB)) return [];
  let rows: { gametype: string; depth: number; n: number }[];
  try {
    const db = new Database(GTOW_DB, { readonly: true });
    try {
      rows = db
        .query<{ gametype: string; depth: number; n: number }, []>(
          "SELECT gametype, depth, COUNT(*) n FROM nodes GROUP BY gametype, depth"
        )
        .all();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
  return rows.map((r) => {
    const set = SOLUTION_SETS.find((s) => s.gametype === r.gametype);
    const id = `gtow:${r.gametype}@${r.depth}`;
    const players = set?.seats.length;
    // "Cash6m500zGeneral" / "CashHu500zComplex" — the crawl's own naming. Pulling the
    // stake and tree flavour out makes the library filterable next to our own charts.
    const gm = r.gametype.match(/^Cash(?:(\d)m|(Hu))(\d+)z(\w+)$/);
    const stake = gm ? `NL${gm[3]}` : undefined;
    const flavour = gm ? gm[4]! : undefined;
    return {
      id,
      source: "gtow" as const,
      family: "gtow" as const,
      label: `${set?.label ?? r.gametype} · ${r.depth}bb`,
      name: gm
        ? `${gm[2] ? "heads-up" : `${gm[1]}-max`} · ${r.depth}bb even · ${flavour} tree · GTO Wizard ${stake} library`
        : `${set?.label ?? r.gametype} · ${r.depth}bb · GTO Wizard library`,
      ...(stake ? { stake } : {}),
      shape: "even" as const,
      format: "GTOW crawl",
      ...(players ? { players } : {}),
      ...(set ? { seats: set.seats } : {}),
      depth: r.depth,
      ...(players
        ? { stacksBB: Object.fromEntries(set!.seats.map((s) => [s, r.depth])) }
        : {}),
      nodes: r.n,
      location: "sqlite://data/preflop-db.sqlite",
      routed: routedFor({ family: "gtow" }, id),
    };
  });
}

let cached: Catalog | null = null;
const TTL_MS = 60_000;

/** Build (or reuse, within TTL) the full catalog. */
export function getCatalog(force = false): Catalog {
  if (!force && cached && Date.now() - cached.builtAt < TTL_MS) return cached;
  const entries = [...hrcEntries(), ...gtowEntries()];
  const byFamily: Record<string, number> = {};
  for (const e of entries) byFamily[e.family] = (byFamily[e.family] ?? 0) + 1;
  cached = {
    builtAt: Date.now(),
    entries,
    summary: {
      total: entries.length,
      routed: entries.filter((e) => e.routed && !e.routed.startsWith("on request")).length,
      byFamily,
      solutionsDir: existsSync(SOLUTIONS_DIR) ? SOLUTIONS_DIR : null,
      gtowDb: existsSync(GTOW_DB),
    },
  };
  return cached;
}
