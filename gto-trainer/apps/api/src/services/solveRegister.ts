import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { factoryFile } from "./repoPaths";

/**
 * THE SOLVE REGISTER, read side (2026-10-04, the factory's poker/analysis/pipeline/solve/solve_register.py).
 *
 * A chart id names a spot, not a solve: HRC is Monte Carlo, two solves of one spot differ, and the live chart for a spot
 * is meant to be the best MEASURED solve of it. The factory's register (solve-register.sqlite beside the bake, read through
 * factoryFile) lists every solve of every spot with its measured reach-weighted regret, and `chart_manifest.py promote
 * --propose` writes, per live chart, the best other solve of the same spot and whether it is CLEARLY better (>= 15% lower).
 *
 * This reads it with prepared statements, re-opened when the file changes. Honest when it cannot: "register not readable",
 * the count null - never 0.
 */
export type ChartRegister = { candidates: number | null; liveScore: number | null; runnerUpScore: number | null;
  runnerUpRaw: string | null; verdict: string | null; betterPct: number | null };
export type RegisterAudit = { readable: boolean; path: string; charts: number; clearlyBetter: number | null; clearlyBetterIds: string[];
  proposedAt: number | null };

const regPath = (): string => process.env.SOLVE_REGISTER ?? factoryFile("solve-register.sqlite");

class SolveRegister {
  private db: Database | null = null;
  private openedPath = "";
  private openedMtime = 0;
  private stmt: ReturnType<Database["query"]> | null = null;

  private open(): Database | null {
    const p = regPath();
    if (!existsSync(p)) { this.close(); return null; }
    let m = 0;
    try { m = statSync(p).mtimeMs; } catch { return null; }
    if (this.db && this.openedPath === p && Math.abs(m - this.openedMtime) < 1) return this.db;
    this.close();
    try {
      const db = new Database(p, { readonly: true });
      db.exec("PRAGMA busy_timeout = 2000");
      const has = db.query("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='proposals'").get();
      if (!has) { db.close(); return null; }
      this.stmt = db.query("SELECT candidates, live_score, runner_up_score, runner_up_raw, verdict, better_pct, live_raw FROM proposals WHERE chart_id = ?");
      this.db = db; this.openedPath = p; this.openedMtime = m;
      return db;
    } catch { this.close(); return null; }
  }
  private close(): void { try { this.db?.close(); } catch { /* gone */ } this.db = null; this.stmt = null; }
  /** test hook */
  reload(): void { this.close(); }

  chart(id: string): ChartRegister | null {
    if (!this.open() || !this.stmt) return null;
    const r = this.stmt.get(id) as any;
    if (!r) return null;
    return { candidates: r.candidates, liveScore: r.live_score, runnerUpScore: r.runner_up_score, runnerUpRaw: r.runner_up_raw,
      verdict: r.verdict, betterPct: r.better_pct };
  }

  /** `liveRaw(id)` = the raw sha the bake serves for the chart (hrc6maxDb provenance): a proposal made for ANOTHER raw is stale. */
  audit(ids: string[], liveRaw: (id: string) => string | null | undefined): RegisterAudit {
    const db = this.open();
    if (!db) return { readable: false, path: regPath(), charts: ids.length, clearlyBetter: null, clearlyBetterIds: [], proposedAt: null };
    const ids2: string[] = [];
    for (const id of ids) {
      const r = this.stmt!.get(id) as any;
      if (r && r.verdict === "promote" && (liveRaw(id) == null || liveRaw(id) === r.live_raw)) ids2.push(id);
    }
    const at = (db.query("SELECT MAX(at) AS at FROM proposals").get() as any)?.at ?? null;
    return { readable: true, path: regPath(), charts: ids.length, clearlyBetter: ids2.length, clearlyBetterIds: ids2, proposedAt: at };
  }
}

export const solveRegister = new SolveRegister();

/** The API's start line about the register (index.ts), beside the trust and provenance lines. */
export function registerAuditLine(a: RegisterAudit): string {
  if (!a.readable) return `[solveRegister] register not readable (${a.path}) - "a clearly better solve exists" is UNKNOWN for ${a.charts} charts`;
  return a.clearlyBetter === 0
    ? `[solveRegister] every baked chart is the best measured solve of its spot (${a.charts} charts)`
    : `[solveRegister] ${a.clearlyBetter} of ${a.charts} baked charts have a CLEARLY better solve of the same spot that is not live ` +
      `(${a.clearlyBetterIds.slice(0, 6).map((s) => s.replace("ign200_6max_", "")).join(", ")}${a.clearlyBetterIds.length > 6 ? ", …" : ""}) - ` +
      `review them on /sources/charts-review before chart_manifest.py promote --apply`;
}
