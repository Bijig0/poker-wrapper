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

export interface CatalogEntry {
  id: string;
  /** Which corpus/walker understands this chart. */
  source: "hrc" | "gtow";
  family:
    | "3max-asym"
    | "3max"
    | "hu-grid"
    | "hu-size"
    | "husng"
    | "gtow"
    | "other";
  label: string;
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
  shortSeat?: "BTN" | "SB" | "BB" | "EQ";
  open?: number;
  threeBet?: number | "jam";
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

/** Structured dims out of an HRC solution id — the one place this grammar is
 *  parsed. (The analysis app's sources.ts still has its own copy for the
 *  SolverStudy picker; both die when the resolver reads catalog fields.) */
export function parseHrcId(id: string): Partial<CatalogEntry> {
  const asym = id.match(/^(\w+?)_3maxasym_D([\d_]+?)_s([\d_]+?)_(btn|sb|bb|eq)$/);
  if (asym) {
    const d = num(asym[2]!);
    const s = num(asym[3]!);
    const seat = asym[4]!.toUpperCase() as "BTN" | "SB" | "BB" | "EQ";
    const stacksBB: Record<string, number> = { BTN: d, SB: d, BB: d };
    if (seat !== "EQ") stacksBB[seat] = s;
    return {
      family: "3max-asym", site: asym[1]!, players: 3,
      depth: d, shortDepth: s, shortSeat: seat, stacksBB,
    };
  }
  const tri = id.match(/^(\w+?)_3max_(\d+)_(btn|sb)([\d_]+?)_3b([\d_]+)$/);
  if (tri) {
    const d = Number(tri[2]!);
    return {
      family: "3max", site: tri[1]!, players: 3, depth: d,
      stacksBB: { BTN: d, SB: d, BB: d },
      open: num(tri[4]!), threeBet: num(tri[5]!),
    };
  }
  const grid = id.match(/^hrc_hu_(\w+?)_d(\d+)_o([\d_]+?)_3b([\d_]+)$/);
  if (grid) {
    const d = Number(grid[2]!);
    return {
      family: "hu-grid", site: grid[1]!, players: 2, depth: d,
      stacksBB: { SB: d, BB: d }, open: num(grid[3]!), threeBet: num(grid[4]!),
    };
  }
  const size = id.match(/^hrc_hu_(\w+?)_([\d_]+)x$/);
  if (size) {
    return {
      family: "hu-size", site: size[1]!, players: 2, depth: 100,
      stacksBB: { SB: 100, BB: 100 }, open: num(size[2]!),
    };
  }
  const sng = id.match(/^husng_d([\d_]+?)_o([\d_]+?)_3b([\d_]+|jam)$/);
  if (sng) {
    const d = num(sng[1]!);
    return {
      family: "husng", players: 2, depth: d, stacksBB: { SB: d, BB: d },
      open: num(sng[2]!), threeBet: sng[3] === "jam" ? "jam" : num(sng[3]!),
    };
  }
  return { family: "other" };
}

/** How the live study path uses a chart (see fastSolve). */
const routedFor = (e: Partial<CatalogEntry>, id: string): string | null => {
  if (e.family === "3max-asym") return "3-handed preflop (live)";
  if (e.family !== "gtow") return null; // HRC HU/3max/husng: SolverStudy browse-only
  if (id.startsWith("gtow:Cash6m500zGeneral@")) return "6-max default + 3-max fallback";
  if (id.startsWith("gtow:CashHu500zComplex@")) return "heads-up default";
  return "on request (setId)";
};

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
    return {
      id,
      source: "gtow" as const,
      family: "gtow" as const,
      label: `${set?.label ?? r.gametype} · ${r.depth}bb`,
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
