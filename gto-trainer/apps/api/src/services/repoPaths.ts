import { join, resolve } from "node:path";

/**
 * Where things are, from the API's own location. One place, so no module counts "..", "..", ".." to the checkout root.
 *
 * The chart index and the pool files are FACTORY OUTPUTS (the `poker` repo solves the charts and fits the pool): they
 * arrive by download (R2) or by the factory's export, never from code in this repo. Each can be pointed elsewhere by env.
 */
/** gto-trainer/apps/api */
export const API_DIR = resolve(import.meta.dir, "..", "..");
/** gto-trainer/apps/api/data — the API's read-only data and (by default) its runtime records */
export const DATA_DIR = join(API_DIR, "data");
/** the checkout (or installed copy) root: config/, setup/, bin/, ignition-study-wrapper/ … */
export const REPO = resolve(API_DIR, "..", "..", "..");
/** the chart index — one <id>.meta.json per chart — and the chart bodies cached beside it (<id>.json.gz, from R2) */
export const CHARTS_DIR = process.env.CHART_SOLUTIONS_DIR ?? join(DATA_DIR, "charts");
/** the pool: opponent model, exploit ranges, villain frequencies, the Zone node corpus */
export const POOL_DIR = process.env.POOL_DIR ?? join(DATA_DIR, "pool");
/**
 * Where the chart factory's DATA outputs are read from: the 6-max preflop bake, node trust, the re-solved rungs, the MES
 * studies (flop file, turn files, reach values, the river lock), the strategy matrix and the backtests. Default data/
 * (committed exports + downloaded data parts). FACTORY_DATA_DIR points it at the factory's own folder instead (the
 * owner's machine: poker/gto-trainer/apps/api/data), so what the factory writes is read at once, with no export —
 * docs/CUTOVER.md. A file's own override (HRC6MAX_DB, MES_POSTFLOP, MES_TURN_DIR) still wins. Read per call.
 */
export const factoryFile = (name: string): string => join(process.env.FACTORY_DATA_DIR || DATA_DIR, name);
/**
 * The CHART MANIFEST (2026-10-03): chart id -> the raw export (sha256) its body is built from. It is git-tracked in the
 * FACTORY repo beside its tool (poker/analysis/pipeline/solve/chart_manifest.json), not in the factory's data dir, so it
 * resolves the way factoryFile does but from the factory checkout: CHART_MANIFEST wins; else FACTORY_DATA_DIR
 * (= <factory>/gto-trainer/apps/api/data) four levels up + analysis/pipeline/solve/; else data/chart_manifest.json (an
 * installed copy, normally absent - then the 6-max provenance check says "manifest not readable"). Read per call.
 */
export const factoryManifestFile = (): string =>
  process.env.CHART_MANIFEST
  || (process.env.FACTORY_DATA_DIR
    ? resolve(process.env.FACTORY_DATA_DIR, "..", "..", "..", "..", "analysis", "pipeline", "solve", "chart_manifest.json")
    : join(DATA_DIR, "chart_manifest.json"));
