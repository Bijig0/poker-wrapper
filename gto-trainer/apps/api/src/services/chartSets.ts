import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getCatalog } from "./chartCatalog";

/**
 * CHART SETS — which charts each strategy is built from, and the table formats they are for.
 *
 * data/chart-sets.json is a FACTORY OUTPUT: the chart factory (the `poker` repo: the HRC solve fleet and its solve
 * ledger) exports it with every set's chart ids already worked out, and nothing here writes it. It is the player-side
 * slice of the factory's ledger — formats, sources, and per set {id, label, format, expectedIds} — with no fleet state
 * (boxes, machines, plans, proposals). What reads it:
 *   - services/strategies.ts: a chart strategy is ready only when every chart of its sets has landed in the chart
 *     index (chartsLanded) — else it reads `unavailable` and the wrapper will not start a session in it;
 *   - routes/sources.ts: each Sources card's formats and its coverage counts.
 * CHART_SETS_PATH overrides the file (read per call, so a test can point it at a temp file).
 */

export interface ChartFormat { id: string; label: string; site: string; seats: number; stake: string; blinds?: string; rake: { pct: number; capBb: number } | null; depths: number[]; note?: string }
export interface ChartSet {
  id: string; label: string; kind?: string; format: string; site?: string;
  /** every chart id the set is made of, as the factory counted them */
  expectedIds: string[];
  /** charts the factory will never produce, with the reason: excluded from the count, shown as a known gap */
  skipCharts?: { id: string; why: string }[];
}
export interface ChartSets { formats: ChartFormat[]; configs: ChartSet[]; sources: Record<string, string[]> }

const DATA_DIR = join(import.meta.dir, "..", "..", "data");
const setsPath = (): string => process.env.CHART_SETS_PATH ?? join(DATA_DIR, "chart-sets.json");
/** What a missing file reads as: no sets, nothing landed — never a crash of every page that reads it. */
const EMPTY: ChartSets = { formats: [], configs: [], sources: {} };
let cache: { path: string; mtimeMs: number; size: number; value: ChartSets } | null = null;

/** The chart sets as they are on disk now. A read that does not parse (the factory mid-copy) serves the last good one. */
export function loadChartSets(): ChartSets {
  const path = setsPath();
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { return EMPTY; }
  const good = cache?.path === path ? cache : null;
  if (good && good.mtimeMs === st.mtimeMs && good.size === st.size) return good.value;
  let value: ChartSets;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    value = { formats: raw.formats ?? [], configs: raw.configs ?? [], sources: raw.sources ?? {} };
  } catch (e) {
    if (good) return good.value;
    console.warn(`[chart-sets] ${path} does not parse (${(e as Error).message}) — no chart sets`);
    return EMPTY;
  }
  cache = { path, mtimeMs: st.mtimeMs, size: st.size, value };
  return value;
}

/** A set's chart ids, minus the ones it will never have. */
export function setChartIds(c: ChartSet): string[] {
  const skip = new Set((c.skipCharts ?? []).map((x) => x.id));
  return (c.expectedIds ?? []).filter((id) => !skip.has(id));
}

/** How many of these sets' charts are in the chart index — a strategy built from them is complete only at have = want. */
export function chartsLanded(setIds: string[]): {
  have: number; want: number; complete: boolean;
  perConfig: { id: string; label: string; have: number; want: number }[];
} {
  const S = loadChartSets();
  let catIds = new Set<string>();
  try { catIds = new Set((getCatalog().entries as any[]).map((e) => String(e.id))); } catch { /* index unavailable */ }
  const perConfig = setIds.map((id) => {
    const c = S.configs.find((x) => x.id === id);
    if (!c) return { id, label: id, have: 0, want: 0 };
    const want = setChartIds(c);
    return { id, label: c.label, have: want.filter((w) => catIds.has(w)).length, want: want.length };
  });
  const have = perConfig.reduce((s, x) => s + x.have, 0);
  const want = perConfig.reduce((s, x) => s + x.want, 0);
  return { have, want, complete: want > 0 && have === want, perConfig };
}

/** Formats for a Sources card, from the source → format map. */
export function formatsForSource(cardId: string): ChartFormat[] {
  const S = loadChartSets();
  return (S.sources[cardId] ?? []).map((id) => S.formats.find((f) => f.id === id)).filter((f): f is ChartFormat => !!f);
}
