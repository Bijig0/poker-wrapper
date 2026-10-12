import { readFileSync } from "node:fs";
import { factoryFile } from "./repoPaths";
import { fileStamp, sameStamp, type FileStamp } from "./fileStamp";

/**
 * resolved-charts.json — per site, the deep rungs that have a re-solved (v2ci) even chart. services/hrc3max.ts prefers
 * that chart at those rungs (chart SELECTION on the answer path); services/chartCatalog.ts labels the base generation
 * there as superseded. It is a factory output (re-exported when a rung's re-solve lands).
 *
 * FOLLOWED, NOT READ ONCE (2026-10-13). Both modules read it at module load, so a re-export changed nothing until the
 * API restarted. Now: stat'ed at most every CHECK_MS (a chart pick costs a clock read, not a syscall), re-read when its
 * size / mtime / file id changed. A read that does not parse (the factory mid-copy) keeps the last good manifest.
 * RESOLVED_CHARTS_PATH overrides the file (read per call, so a test can point it at a temp file).
 *
 * null = no manifest here (absent, or unparseable with nothing read before) — each caller keeps its own fallback.
 */
export type ResolvedRungs = Record<string, Set<number>>;

const resolvedPath = (): string => process.env.RESOLVED_CHARTS_PATH ?? factoryFile("resolved-charts.json");
let checkMs = 5_000;
let cache: { path: string; stamp: FileStamp | null; checkedAt: number; value: ResolvedRungs | null } | null = null;

export function resolvedRungs(): ResolvedRungs | null {
  const path = resolvedPath();
  const now = Date.now();
  const mine = cache?.path === path ? cache : null;
  if (mine && now - mine.checkedAt < checkMs) return mine.value;
  const stamp = fileStamp(path);
  if (mine && sameStamp(stamp, mine.stamp)) { mine.checkedAt = now; return mine.value; }
  let value: ResolvedRungs | null = null;
  if (stamp) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, number[]>;
      value = Object.fromEntries(Object.entries(raw).map(([site, rungs]) => [site, new Set(rungs)]));
    } catch (e) {
      if (mine?.value) {
        cache = { path, stamp, checkedAt: now, value: mine.value };   // read again when it changes again
        console.warn(`[resolved-charts] ${path} does not parse (${(e as Error).message}) - keeping the manifest read before`);
        return mine.value;
      }
      value = null;
    }
  }
  if (mine) console.log(`[resolved-charts] ${path} ${stamp ? "changed" : "is gone"} - re-solved rungs now ` +
    (value ? Object.entries(value).map(([s, r]) => `${s} [${[...r].sort((a, b) => a - b).join(",")}]`).join(" ") : "none (fallback)"));
  cache = { path, stamp, checkedAt: now, value };
  return value;
}

/** Test hook: how often the file is stat'ed (default 5 s). */
export function setResolvedChartsCheckMs(ms: number): void { checkMs = ms; }
