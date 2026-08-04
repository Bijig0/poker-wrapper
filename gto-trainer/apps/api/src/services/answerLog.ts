import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Persistent log of every study answer the poller pushed (and every solve
 * that failed) — the dashboard's source for "what was I told at this node",
 * answer-latency percentiles per tier, and advice-adherence stats. Nothing
 * was persisted before this; the only audit trail was an ad-hoc scratchpad
 * monitor.
 *
 * Joins to the wrapper's archived hands via clientHandId (the site's own
 * globally-unique id — wrapper handIds reset every restart).
 */

export interface AnswerRow {
  ts: number;
  wrapperHandId: number | null;
  clientHandId: string | null;
  street: string | null;
  board: string | null;
  heroCards: string | null;
  decisionKey: string | null;
  /** Panel text, null for a failed solve. */
  text: string | null;
  pick: string | null;
  roll: number | null;
  tier: string | null;
  warning: string | null;
  latencyMs: number | null;
  failReason: string | null;
}

const DDL = `CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  wrapper_hand_id INTEGER,
  client_hand_id TEXT,
  street TEXT,
  board TEXT,
  hero_cards TEXT,
  decision_key TEXT,
  text TEXT,
  pick TEXT,
  roll REAL,
  tier TEXT,
  warning TEXT,
  latency_ms INTEGER,
  fail_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_answers_client_hand ON answers(client_hand_id);
CREATE INDEX IF NOT EXISTS idx_answers_ts ON answers(ts)`;

class AnswerLog {
  private db: Database | null = null;
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? join(import.meta.dir, "..", "..", "data", "answers.sqlite");
  }

  private open(): Database {
    if (this.db) return this.db;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(DDL);
    return this.db;
  }

  /** Best-effort append — a logging failure must never break the poller. */
  add(row: AnswerRow): void {
    try {
      this.open()
        .query(
          `INSERT INTO answers (ts, wrapper_hand_id, client_hand_id, street, board,
             hero_cards, decision_key, text, pick, roll, tier, warning, latency_ms, fail_reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          row.ts, row.wrapperHandId, row.clientHandId, row.street, row.board,
          row.heroCards, row.decisionKey, row.text, row.pick, row.roll,
          row.tier, row.warning, row.latencyMs, row.failReason
        );
    } catch {
      /* never propagate */
    }
  }

  forHand(clientHandId: string): unknown[] {
    try {
      return this.open()
        .query("SELECT * FROM answers WHERE client_hand_id = ? ORDER BY ts")
        .all(clientHandId);
    } catch {
      return [];
    }
  }

  /** Latency percentiles + counts per tier, over the last `days`. */
  stats(days = 30): unknown {
    try {
      const db = this.open();
      const since = Date.now() - days * 86_400_000;
      const rows = db
        .query<{ tier: string | null; latency_ms: number | null; text: string | null }, [number]>(
          "SELECT tier, latency_ms, text FROM answers WHERE ts >= ?"
        )
        .all(since);
      const byTier: Record<string, number[]> = {};
      let answered = 0, failed = 0;
      for (const r of rows) {
        if (r.text == null) { failed++; continue; }
        answered++;
        if (r.latency_ms != null) (byTier[r.tier ?? "unknown"] ??= []).push(r.latency_ms);
      }
      const pct = (xs: number[], p: number) =>
        xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null;
      return {
        answered,
        failed,
        tiers: Object.fromEntries(
          Object.entries(byTier).map(([t, xs]) => [t, { n: xs.length, p50: pct(xs, 50), p90: pct(xs, 90), max: Math.max(...xs) }])
        ),
      };
    } catch {
      return { answered: 0, failed: 0, tiers: {} };
    }
  }
}

export const answerLog = new AnswerLog();
export { AnswerLog };
