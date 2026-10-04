import type { Database } from "bun:sqlite";
import { answersDbPath, openStore } from "./storePaths";

/**
 * CHART REVIEWS (2026-10-04): Brady goes through every live 6-max chart by hand on /sources/charts-review before any solve
 * is promoted ("using my poker player instinct to second pass review before we launch to prod"). One row per verdict:
 * "ok" (looks right) or "flag", with a note. KEYED BY THE RAW SHA as well as the chart: a promoted chart is another solve
 * and needs a fresh look. The factory's `chart_manifest.py promote --apply` refuses a chart whose latest verdict for its
 * live raw is "flag". Lives in the central database beside the answers (answersDbPath: in-memory under bun test).
 */
export type ChartReview = { chartId: string; raw: string; verdict: "ok" | "flag"; note: string; at: number };

const DDL = `CREATE TABLE IF NOT EXISTS chart_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chart_id TEXT NOT NULL, raw_sha256 TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('ok','flag')), note TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chart_reviews_chart ON chart_reviews(chart_id, raw_sha256, at)`;

export class ChartReviews {
  private db: Database | null = null;
  constructor(private readonly path?: string) {}
  private open(): Database {
    if (this.db) return this.db;
    this.db = openStore(this.path ?? answersDbPath());
    this.db.exec(DDL);
    return this.db;
  }
  record(chartId: string, raw: string, verdict: "ok" | "flag", note = ""): ChartReview {
    if (!/^[A-Za-z0-9_]+$/.test(chartId)) throw new Error("bad chart id");
    if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error("raw must be the live raw sha256");
    if (verdict !== "ok" && verdict !== "flag") throw new Error("verdict is ok or flag");
    const at = Date.now();
    this.open().query("INSERT INTO chart_reviews (chart_id, raw_sha256, verdict, note, at) VALUES (?,?,?,?,?)").run(chartId, raw, verdict, note.slice(0, 2000), at);
    return { chartId, raw, verdict, note: note.slice(0, 2000), at };
  }
  /** the latest verdict per chart FOR THE GIVEN RAW (another raw = not reviewed) */
  latest(live: Record<string, string | null | undefined>): Record<string, ChartReview> {
    const out: Record<string, ChartReview> = {};
    const rows = this.open().query("SELECT chart_id, raw_sha256, verdict, note, at FROM chart_reviews ORDER BY id").all() as any[];
    for (const r of rows) {
      if (live[r.chart_id] && live[r.chart_id] !== r.raw_sha256) continue;
      out[r.chart_id] = { chartId: r.chart_id, raw: r.raw_sha256, verdict: r.verdict, note: r.note, at: r.at };
    }
    return out;
  }
  history(chartId: string): ChartReview[] {
    return (this.open().query("SELECT chart_id, raw_sha256, verdict, note, at FROM chart_reviews WHERE chart_id = ? ORDER BY id DESC").all(chartId) as any[])
      .map((r) => ({ chartId: r.chart_id, raw: r.raw_sha256, verdict: r.verdict, note: r.note, at: r.at }));
  }
}

export const chartReviews = new ChartReviews();
