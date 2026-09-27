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
