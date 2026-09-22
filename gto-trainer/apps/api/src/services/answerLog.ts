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
 *
 * 2026-09-03: the provenance that rode on every panel push but was never
 * persisted (strategy mode, source, MES/GTO picks, MES EV at stake, band,
 * stake, seats, position, depth, the full action mix) is now logged too —
 * the Sources tab's live grading is built entirely on it. Rows before that
 * date have those columns null.
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
  /** WHY there is no text — one of FAIL_KINDS, set whenever text is null. */
  failKind?: FailKind | null;
  pick: string | null;
  roll: number | null;
  tier: string | null;
  warning: string | null;
  latencyMs: number | null;
  failReason: string | null;
  /** Chart/gametype the answer came from (e.g. ign200_3maxasym_D100_s40_sb),
   *  the join key to the chart catalog's "recently queried" view. */
  chart?: string | null;
  // ---- provenance (2026-09-03) ----
  strategyMode?: string | null;
  source?: string | null;
  bandLo?: number | null;
  bandHi?: number | null;
  exploitPick?: string | null;
  chartPick?: string | null;
  exploitTag?: string | null;
  mesFamily?: string | null;
  mesBoard?: string | null;
  mesEvGainBb?: number | null;
  mesExact?: boolean | null;
  bbCents?: number | null;
  tableSeats?: number | null;
  /** 1-4 when several tables are open; null on the single-table setup. */
  tableSlot?: number | null;
  heroPos?: string | null;
  depth?: number | null;
  setId?: string | null;
  /** The full action mix (JSON) so a decision can be re-graded later. */
  decisionJson?: string | null;
  /** The (snapped) line the chart answered at — with `chart`, the exact node. */
  line?: string | null;
  /** data/solves.sqlite id of the stored AI-chain trace, when the chain answered. */
  solveId?: number | null;
  /** The wrapper's declared session (sessions.py). */
  sessionId?: string | null;
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

/** Additive migrations, in the order they were introduced. */
const EXTRA_COLUMNS: [string, string][] = [
  ["chart", "TEXT"],
  ["strategy_mode", "TEXT"],
  ["source", "TEXT"],
  ["band_lo", "REAL"],
  ["band_hi", "REAL"],
  ["exploit_pick", "TEXT"],
  ["chart_pick", "TEXT"],
  ["exploit_tag", "TEXT"],
  ["mes_family", "TEXT"],
  ["mes_board", "TEXT"],
  ["mes_ev_gain_bb", "REAL"],
  ["mes_exact", "INTEGER"],
  ["bb_cents", "INTEGER"],
  ["table_seats", "INTEGER"],
  // WHICH TABLE (2026-09-19): 1-4 when several are open, null on the single-table
  // setup. wrapper_hand_id is a per-PROCESS counter and collides across tables;
  // this is what attributes an answer to one of them within a session that spans
  // all four. The wrapper stamps it on /hand as `tableSlot`.
  ["table_slot", "INTEGER"],
  ["hero_pos", "TEXT"],
  ["depth", "INTEGER"],
  ["set_id", "TEXT"],
  ["decision_json", "TEXT"],
  ["line", "TEXT"],
  ["solve_id", "INTEGER"],
  ["session_id", "TEXT"],
  // WHY a decision got no answer, as a countable token rather than free text:
  // 180 of the first 203 failures were the single string "no solution for this
  // spot", which cannot be aggregated or acted on. See FAIL_KINDS.
  ["fail_kind", "TEXT"],
];

/**
 * The ways a decision ends up with no answer.
 *
 *  no-solution          the solve chain had nothing for this spot
 *  off-tree             the line contains a size the tree does not offer
 *  not-in-range         hero's combo has no weight in the chart at this node
 *  not-heros-turn       the solver re-read the table and hero was not on the clock
 *  hand-over            the hand had ended by the time the solve ran
 *  solver-timeout       the fast-solver request passed its deadline
 *  solver-unreachable   the fast-solver could not be reached at all
 *  solver-bad-response  it answered, but not with JSON
 *  gtow-down            GTO Wizard was not connected while hero was on the clock
 *  abandoned-stale      the verdict arrived after hero had already acted
 *  no-probe             hero's decision was never asked about at all
 *
 * The last five used to leave no trace whatsoever: the poller returned early
 * and the node simply had no row.
 */
export const FAIL_KINDS = [
  "no-solution", "off-tree", "not-in-range", "not-heros-turn", "hand-over",
  "solver-timeout", "solver-unreachable", "solver-bad-response", "gtow-down",
  "abandoned-stale", "no-probe",
  // hero's buttons were up for 2 s while the wrapper's export said "not hero's
  // turn" — the reason (notToActWhy) is in failReason. Written LIVE, the first
  // time it happens, so this class can never again pass in silence (2026-09-19,
  // hand 4919080696: a villain's SITTING OUT label read as hero's, 19 s silent).
  "not-to-act-live", "unknown",
] as const;
export type FailKind = (typeof FAIL_KINDS)[number];

/** Classify the solve chain's own free-text refusal. The poller passes an
 *  explicit kind for everything it knows first-hand; this covers what comes
 *  back from the chain, and re-classifies the history on read. */
export function failKindOf(reason: string | null | undefined): FailKind {
  const r = (reason ?? "").toLowerCase();
  if (!r) return "unknown";
  if (r.includes("not hero's turn")) return "not-heros-turn";
  if (r.includes("hand is over")) return "hand-over";
  if (r.includes("isn't in the chart range") || r.includes("not in range")) return "not-in-range";
  if (r.includes("not offered (have")) return "off-tree";
  if (r.includes("no solution for this spot")) return "no-solution";
  return "unknown";
}

export interface LoggedAnswer {
  id: number;
  ts: number;
  wrapper_hand_id: number | null;
  client_hand_id: string | null;
  street: string | null;
  board: string | null;
  hero_cards: string | null;
  decision_key: string | null;
  text: string | null;
  pick: string | null;
  roll: number | null;
  tier: string | null;
  warning: string | null;
  latency_ms: number | null;
  fail_reason: string | null;
  fail_kind: string | null;
  chart: string | null;
  strategy_mode: string | null;
  source: string | null;
  band_lo: number | null;
  band_hi: number | null;
  exploit_pick: string | null;
  chart_pick: string | null;
  exploit_tag: string | null;
  mes_family: string | null;
  mes_board: string | null;
  mes_ev_gain_bb: number | null;
  mes_exact: number | null;
  bb_cents: number | null;
  table_seats: number | null;
  table_slot: number | null;
  hero_pos: string | null;
  depth: number | null;
  set_id: string | null;
  decision_json: string | null;
  line: string | null;
  solve_id: number | null;
  session_id: string | null;
}

class AnswerLog {
  private db: Database | null = null;
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? join(import.meta.dir, "..", "..", "data", "answers.sqlite");
  }

  get dbPath(): string {
    return this.path;
  }

  private open(): Database {
    if (this.db) return this.db;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec("PRAGMA busy_timeout = 5000"); // see services/jobs.ts — a held lock must wait, not throw
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(DDL);
    const cols = new Set(
      this.db.query<{ name: string }, []>("PRAGMA table_info(answers)").all().map((c) => c.name)
    );
    for (const [name, type] of EXTRA_COLUMNS) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE answers ADD COLUMN ${name} ${type}`);
    }
    // Classify the failures written before the column existed, once. The read
    // paths fall back to failKindOf anyway; this makes plain SQL over the table
    // agree with them.
    try {
      for (const row of this.db.query<{ id: number; fail_reason: string | null }, []>(
        "SELECT id, fail_reason FROM answers WHERE text IS NULL AND fail_kind IS NULL"
      ).all()) {
        this.db.query("UPDATE answers SET fail_kind = ? WHERE id = ?").run(failKindOf(row.fail_reason), row.id);
      }
    } catch { /* classification is a convenience, never a boot blocker */ }
    return this.db;
  }

  /** Best-effort append — a logging failure must never break the poller. */
  add(row: AnswerRow): void {
    try {
      this.open()
        .query(
          `INSERT INTO answers (ts, wrapper_hand_id, client_hand_id, street, board,
             hero_cards, decision_key, text, pick, roll, tier, warning, latency_ms, fail_reason, chart,
             strategy_mode, source, band_lo, band_hi, exploit_pick, chart_pick, exploit_tag,
             mes_family, mes_board, mes_ev_gain_bb, mes_exact, bb_cents, table_seats, table_slot, hero_pos,
             depth, set_id, decision_json, line, solve_id, session_id, fail_kind)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          row.ts, row.wrapperHandId, row.clientHandId, row.street, row.board,
          row.heroCards, row.decisionKey, row.text, row.pick, row.roll,
          row.tier, row.warning, row.latencyMs, row.failReason, row.chart ?? null,
          row.strategyMode ?? null, row.source ?? null, row.bandLo ?? null, row.bandHi ?? null,
          row.exploitPick ?? null, row.chartPick ?? null, row.exploitTag ?? null,
          row.mesFamily ?? null, row.mesBoard ?? null, row.mesEvGainBb ?? null,
          row.mesExact == null ? null : row.mesExact ? 1 : 0,
          row.bbCents ?? null, row.tableSeats ?? null, row.tableSlot ?? null, row.heroPos ?? null,
          row.depth ?? null, row.setId ?? null, row.decisionJson ?? null, row.line ?? null, row.solveId ?? null, row.sessionId ?? null,
          row.text == null ? (row.failKind ?? failKindOf(row.failReason)) : null
        );
    } catch {
      /* never propagate */
    }
  }

  /**
   * Give an unattributed failure its hand. The poller writes timeouts and
   * client-down rows from a PROBE, which carries no hand id; once the hand is
   * archived services/answerReconciler.ts knows which one it belonged to.
   */
  attach(id: number, clientHandId: string, sessionId: string | null, wrapperHandId: number | null): void {
    try {
      this.open()
        .query("UPDATE answers SET client_hand_id = ?, session_id = COALESCE(session_id, ?), wrapper_hand_id = COALESCE(wrapper_hand_id, ?) WHERE id = ? AND client_hand_id IS NULL")
        .run(clientHandId, sessionId, wrapperHandId, id);
    } catch {
      /* never propagate */
    }
  }

  /** Charts that actually answered live spots recently, most recent first. */
  recentCharts(days = 30): { chart: string; n: number; lastTs: number }[] {
    try {
      const since = Date.now() - days * 86_400_000;
      return this.open()
        .query<{ chart: string; n: number; lastTs: number }, [number]>(
          `SELECT chart, COUNT(*) n, MAX(ts) lastTs FROM answers
           WHERE ts >= ? AND chart IS NOT NULL AND text IS NOT NULL
           GROUP BY chart ORDER BY lastTs DESC`
        )
        .all(since);
    } catch {
      return [];
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

  /** Every logged row of one declared session, oldest first. */
  forSession(sessionId: string): LoggedAnswer[] {
    try {
      return this.open()
        .query<LoggedAnswer, [string]>("SELECT * FROM answers WHERE session_id = ? ORDER BY ts")
        .all(sessionId);
    } catch {
      return [];
    }
  }

  /** Every logged row in the window, oldest first. */
  rows(days = 60): LoggedAnswer[] {
    try {
      const since = Date.now() - days * 86_400_000;
      return this.open()
        .query<LoggedAnswer, [number]>("SELECT * FROM answers WHERE ts >= ? ORDER BY ts")
        .all(since);
    } catch {
      return [];
    }
  }

  /**
   * Answered counts per source and per tier in the window, plus a per-day
   * series for the registry's trend strips. Failed solves are counted
   * separately (they have no source).
   */
  bySource(days = 30): {
    sources: Record<string, { n: number; p50: number | null; lastTs: number | null; byDay: number[] }>;
    tiers: Record<string, number>;
    failed: number;
    provenanceRows: number;
  } {
    const out = { sources: {} as Record<string, { n: number; p50: number | null; lastTs: number | null; byDay: number[] }>, tiers: {} as Record<string, number>, failed: 0, provenanceRows: 0 };
    try {
      const since = Date.now() - days * 86_400_000;
      const rows = this.open()
        .query<{ ts: number; tier: string | null; source: string | null; latency_ms: number | null; text: string | null; strategy_mode: string | null }, [number]>(
          "SELECT ts, tier, source, latency_ms, text, strategy_mode FROM answers WHERE ts >= ?"
        )
        .all(since);
      const lat: Record<string, number[]> = {};
      for (const r of rows) {
        if (r.text == null) { out.failed++; continue; }
        if (r.strategy_mode != null) out.provenanceRows++;
        const tier = r.tier ?? "unknown";
        out.tiers[tier] = (out.tiers[tier] ?? 0) + 1;
        // Rows before the provenance columns existed have no source — infer
        // it from the tier so the registry can still attribute them.
        const src = r.source ?? sourceForTier(tier);
        const s = (out.sources[src] ??= { n: 0, p50: null, lastTs: null, byDay: new Array(days).fill(0) });
        s.n++;
        s.lastTs = Math.max(s.lastTs ?? 0, r.ts);
        const day = Math.min(days - 1, Math.max(0, Math.floor((r.ts - since) / 86_400_000)));
        s.byDay[day]++;
        if (r.latency_ms != null) (lat[src] ??= []).push(r.latency_ms);
      }
      for (const [src, xs] of Object.entries(lat)) {
        xs.sort((a, b) => a - b);
        out.sources[src]!.p50 = xs[Math.floor(xs.length / 2)] ?? null;
      }
    } catch {
      /* empty */
    }
    return out;
  }

  /**
   * How many logged answers actually SAID each of these things.
   *
   * The register of known approximations (services/approximations.ts) names
   * the phrase each one writes into an answer's warning; this turns that into
   * a frequency. Matching is a plain case-insensitive substring on `warning`,
   * because the warnings are composed prose — the needles are chosen to be
   * distinctive ("OFF-TREE SIZE", "CALLER CAP"), not parsed.
   *
   * Only ANSWERED rows count: a warning on a row with no text is a failure
   * that happened to carry a note, not an approximation we acted on.
   */
  countWarnings(needles: string[], days = 30): Record<string, { n: number; lastTs: number | null }> {
    const out: Record<string, { n: number; lastTs: number | null }> = {};
    for (const n of needles) out[n] = { n: 0, lastTs: null };
    if (!needles.length) return out;
    try {
      const since = Date.now() - days * 86_400_000;
      const rows = this.open()
        .query<{ ts: number; warning: string | null }, [number]>(
          "SELECT ts, warning FROM answers WHERE ts >= ? AND text IS NOT NULL AND warning IS NOT NULL AND warning <> ''"
        )
        .all(since);
      const lowered = needles.map((x) => [x, x.toLowerCase()] as const);
      for (const r of rows) {
        const w = (r.warning ?? "").toLowerCase();
        for (const [key, needle] of lowered) {
          if (!w.includes(needle)) continue;
          const o = out[key]!;
          o.n++;
          o.lastTs = Math.max(o.lastTs ?? 0, r.ts);
        }
      }
    } catch {
      /* the register degrades to "unmeasured", it never throws */
    }
    return out;
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

/** Tier → source, for rows logged before `source` was persisted. */
export function sourceForTier(tier: string | null): string {
  switch (tier) {
    case "exploit-3max": return "pool-exploit-preflop";
    case "chart-3max": return "hrc-3max-preflop";
    case "local-preflop": return "local-preflop";
    case "exploit-postflop": return "mes-postflop";
    case "ai-chain":
    case "ai-exact":
    case "library-exact":
    case "library-snap":
    case "far-snap": return "gtow-api-postflop";
    default: return "unknown";
  }
}

export const answerLog = new AnswerLog();
export { AnswerLog };
