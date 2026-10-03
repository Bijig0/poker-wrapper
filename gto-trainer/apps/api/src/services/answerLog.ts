import { Database } from "bun:sqlite";
import type { PathRow } from "./chainPath";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { answersDbPath, openStore, storeWriteFailed } from "./storePaths";

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
  /** HOW THE ANSWER WAS PRODUCED (2026-09-25, services/chainPath): the verdict — clean / by-design / rebuilt / leaked /
   *  fault — and the whole path as JSON (arrival, streets, reasons, requests). Null when there is nothing to say
   *  about the chain (hero acted first, the hand ended). */
  pathVerdict?: string | null;
  path?: string | null;
  /** THE [chain] SUMMARY (2026-09-25): every street's tree (cached / CREATED and why), every node read (cache /
   *  joined / fetched), the fresh cloud solves — the line that answers "was an earlier street re-solved?". Kept ON
   *  the answer so the question never depends on which log file survived (hand 973: none did). */
  chain?: string | null;
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
  // THE CHAIN PATH (2026-09-25, services/chainPath): the answer's verdict and how it was produced — the clean rate,
  // the panel's banner and the session's Technical tab all read these two columns
  ["path_verdict", "TEXT"],
  ["path", "TEXT"],
  ["chain", "TEXT"],
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
  "not-to-act-live",
  // THE 6-MAX / AI-PREFLOP REFUSALS (2026-09-23, EIP-15 + PF-10). The five kinds above
  // were the library era's vocabulary; the strategies that answer today refuse in
  // sentences none of them match, so 922 rows — 344 of them preflop, 45 "preflop
  // betting didn't close", 27 "3 players reach the flop", 21 "not walkable", 12
  // "nearest size … too far" — sat under "unknown" and Analytics could not tell a
  // capture bug from a chart gap from a dead cloud. Three families:
  //
  //  capture-fault        the hand as captured cannot have happened (a seat posted the
  //                       big blind out of place, acts twice in a row, hero's seat is
  //                       unknown) — a READER bug, never a poker fact
  //  no-hero-cards        hero's cards never reached the export
  //  board-incomplete     fewer board cards than the street implies
  //  tree-gap             the line is fine, the chart/tree simply has no node for it
  //  ai-node-missing      GTO Wizard's own tree says NODE_DOES_NOT_EXIST and the walk
  //                       could not repair the line
  //  line-terminal        the line runs past a terminal, ends on a terminal or on a
  //                       villain's turn, or never closed — the LINE is wrong, not
  //                       the chart (usually a missed action)
  //  table-shape          seat count the strategy's pieces do not cover
  //  size-too-far         the nearest tree size is more than 2x from the one played
  //  multiway-unsupported too many players reach the flop for a heads-up/3-way solve
  //
  // The fast-solver stamps a `kind` on its refusals too (fastSolve.ts); the poller
  // logs that when present and this classifier covers the history.
  "capture-fault", "no-hero-cards", "board-incomplete", "tree-gap", "ai-node-missing",
  "line-terminal", "table-shape", "size-too-far", "multiway-unsupported",
  // the solver THREW (a bug, not the spot) — fastSolve turns it into this refusal instead of an HTTP 500 (2026-10-04)
  "solver-error",
  "unknown",
] as const;
export type FailKind = (typeof FAIL_KINDS)[number];

/** A machine `kind` from the fast-solver is only trusted when it is one of ours. */
export const isFailKind = (k: unknown): k is FailKind =>
  typeof k === "string" && (FAIL_KINDS as readonly string[]).includes(k);

/** Classify the solve chain's own free-text refusal. The poller passes an
 *  explicit kind for everything it knows first-hand; this covers what comes
 *  back from the chain, and re-classifies the history on read.
 *
 *  Order matters where sentences compose: a 6-max refusal reads
 *  "6-max chart X: nearest size R7.5 is too far from R9; fitting the line …", and
 *  an AI-chain one "AI chain: … not walkable at FLOP#1; street-root AI: …", so the
 *  most specific needle is tested first and the infrastructure needles last. */
export function failKindOf(reason: string | null | undefined): FailKind {
  const r = (reason ?? "").toLowerCase();
  if (!r) return "unknown";
  if (r.includes("not hero's turn")) return "not-heros-turn";
  if (r.includes("hand is over")) return "hand-over";
  if (r.includes("isn't in the chart range") || r.includes("not in range")) return "not-in-range";
  if (r.includes("not offered (have")) return "off-tree";
  if (r.includes("no solution for this spot")) return "no-solution";
  // capture faults (repairPostflopRotation faults, fastSolve "internally inconsistent")
  if (r.includes("internally inconsistent") || r.includes("posted the big blind")
      || r.includes("out of rotation") || r.includes("acts twice") || r.includes("hero position unknown")) return "capture-fault";
  if (r.includes("hero's cards are not known")) return "no-hero-cards";
  if (r.includes("board too short") || r.includes("board has fewer cards") || r.includes("no full flop on the board")) return "board-incomplete";
  // sizes: hrc3max/hrc6max snap refusals ("nearest size R40 is too far from R75",
  // "nearest size R40 is more than 2x away from R75")
  if (r.includes("nearest size") && (r.includes("too far") || r.includes("more than 2x away"))) return "size-too-far";
  // a chart node the walk met as terminal while the line went on: the CHART is missing the branch (the converter
  // labels a subtree HRC never exported as "closes the preflop action") — a tree gap, and it must be tested BEFORE
  // the multiway needle because the 6-max refusal appends "…; BTN's range on the fitted line: 1 players reach the
  // flop" to it (2026-09-25, hand 4920396764 sat under multiway-unsupported)
  if (r.includes("terminal before the line ends")) return "tree-gap";
  // table shape and multiway, before the generic line/tree needles
  if (r.includes("players reach the flop")) return "multiway-unsupported";
  if (r.includes("table thinned") || r.includes("seats: the ai preflop piece covers")) return "table-shape";
  // GTO Wizard's own tree (gtowAiPreflop): the node is not there and the walk could not mend it
  if (r.includes("node_does_not_exist") || r.includes("does not exist and the line could not be walked")) return "ai-node-missing";
  // the line itself is wrong: past/onto a terminal, on a villain's turn, or never closed
  if (r.includes("past a terminal") || r.includes("ends on a terminal") || r.includes("didn't close")
      || r.includes("ends on villain's turn") || r.includes("walked line puts")) return "line-terminal";
  // the tree/chart has no node for a well-formed line ("node not in chart", reconstructFlopRanges
  // "not in the charts", aiChain "… not walkable at FLOP#1 (offered: …)")
  if (r.includes("node not in chart") || r.includes("not in the charts") || r.includes("not walkable")
      || r.includes("no 6-max chart for this state")) return "tree-gap";
  // infrastructure, last: the same sentences ride along inside composed refusals
  if (r.includes("no gto wizard session") || r.includes("no gto wizard token") || r.includes("did not return the node in time")) return "gtow-down";
  if (r.includes("unable to connect") || r.includes("unreachable")) return "solver-unreachable";
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
  path_verdict: string | null;
  path: string | null;
  chain: string | null;
}

/**
 * NO TEST EVER OPENS A REAL ANSWER LOG (2026-09-25). Setting ANSWERS_DB_PATH inside a test file was not enough:
 * `bun test` runs every file in ONE process, the singleton below is built by whichever file imports answerLog
 * first, and the env assignment in studyPoller.test.ts ran after it — so every full run (setup/regress.ts) still
 * wrote the poller fixtures ("FLOP — Check 76% · Bet 1.8 (33%) 7% · roll N → CHECK", NODE_DOES_NOT_EXIST, …) into
 * data/answers.sqlite: 213 happy-path rows alone by 2026-09-24. bunfig.toml now preloads
 * src/test/isolateLiveState.ts (ANSWERS_DB_PATH=:memory:) before any test file loads, and under `bun test`
 * (NODE_ENV=test) the log refuses any path that is neither in memory nor in the OS temp dir — so a test run from
 * another directory, or pointed at any checkout's live file, fails at import instead of writing to it.
 */
function assertTestSafePath(path: string): void {
  if (process.env.NODE_ENV !== "test") return;
  if (path === ":memory:" || path.startsWith("file::memory:")) return;
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(realpathSync(tmpdir())), norm(path));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return;
  throw new Error(
    `answerLog: refusing to open ${path} under bun test — tests must use ANSWERS_DB_PATH=:memory: or a temp file ` +
    `(bunfig.toml preloads src/test/isolateLiveState.ts; run bun test from apps/api)`
  );
}

class AnswerLog {
  private db: Database | null = null;
  private readonly path: string;
  /**
   * rows(days) is read by every dashboard page and the reconciler, and re-read the whole table each time — on the
   * thread that answers live decisions. It is cached per window until something writes: this connection's writes bump
   * writeSeq, another connection's inserts move max(id), and the minute in the key bounds the rest (another process's
   * update, the window's moving edge).
   */
  private writeSeq = 0;
  private readonly rowsCache = new Map<number, { key: string; rows: LoggedAnswer[] }>();

  /**
   * ANSWERS_DB_PATH (2026-09-23, EIP-07 + PF-11): the process-wide singleton below
   * is created at import, so a test that drives the poller wrote into the LIVE
   * data/answers.sqlite — every `bun test studyPoller.test.ts` appended its
   * fixtures ("PREFLOP — Raise 2.5 80%", the NODE_DOES_NOT_EXIST line, the AcQc
   * "Unable to connect" rows) and the failure statistics were mostly fixtures:
   * 368/462/336/441 test-shaped rows per day 09-19..09-22 against ~40-170 real
   * answers. Same convention as HANDS_DB_PATH (sessionsStore.ts): tests set the
   * env to a temp file BEFORE importing the services.
   */
  constructor(path?: string) {
    this.path = path ?? answersDbPath();
    assertTestSafePath(this.path);
  }

  get dbPath(): string {
    return this.path;
  }

  private open(): Database {
    if (this.db) return this.db;
    this.db = openStore(this.path); // the central DB (WAL, busy timeout — a held lock must wait, not throw)
    this.db.exec(DDL);
    const cols = new Set(
      this.db.query<{ name: string }, []>("PRAGMA table_info(answers)").all().map((c) => c.name)
    );
    for (const [name, type] of EXTRA_COLUMNS) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE answers ADD COLUMN ${name} ${type}`);
    }
    // the Sessions pages read by session (forSession): without this each one scanned the whole table
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id)");
    // Classify the failures written before the column existed, once. The read
    // paths fall back to failKindOf anyway; this makes plain SQL over the table
    // agree with them. Rows already filed under "unknown" are re-tried too: the
    // classifier learns new sentences (2026-09-23 added nine kinds, see FAIL_KINDS)
    // and the history should move with it — only rows whose kind actually changes
    // are written.
    try {
      for (const row of this.db.query<{ id: number; fail_reason: string | null; fail_kind: string | null }, []>(
        "SELECT id, fail_reason, fail_kind FROM answers WHERE text IS NULL AND (fail_kind IS NULL OR fail_kind = 'unknown')"
      ).all()) {
        const kind = failKindOf(row.fail_reason);
        if (kind === row.fail_kind) continue;
        this.db.query("UPDATE answers SET fail_kind = ? WHERE id = ?").run(kind, row.id);
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
             depth, set_id, decision_json, line, solve_id, session_id, fail_kind, path_verdict, path, chain)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
          row.text == null ? (row.failKind ?? failKindOf(row.failReason)) : null,
          row.pathVerdict ?? null, row.path ?? null, row.chain ?? null
        );
      this.writeSeq++;
    } catch (e) {
      storeWriteFailed("answers", e);   // never propagate — but never silent
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
      this.writeSeq++;
    } catch (e) {
      storeWriteFailed("answers.attach", e);
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

  /** A session's decisions that carry a chain path (services/chainPath folds them into the clean rate). `withPath` =
   *  false leaves the path JSON out — the panel's clean count needs only the verdicts. */
  pathRows(sessionId: string, withPath = true): PathRow[] {
    try {
      return this.open()
        .query<PathRow, [string]>(
          `SELECT ts, client_hand_id, wrapper_hand_id, table_slot, street, text, fail_kind, path_verdict${withPath ? ", path" : ""}
             FROM answers WHERE session_id = ? AND path_verdict IS NOT NULL ORDER BY ts`)
        .all(sessionId);
    } catch {
      return [];
    }
  }

  /** Every logged row in the window, oldest first (a fresh array; the rows are shared with the cache — read-only). */
  rows(days = 60): LoggedAnswer[] {
    try {
      const db = this.open();
      const now = Date.now();
      const maxId = db.query<{ m: number | null }, []>("SELECT max(id) m FROM answers").get()?.m ?? 0;
      const key = `${this.writeSeq}|${maxId}|${Math.floor(now / 60_000)}`;
      const hit = this.rowsCache.get(days);
      if (hit?.key === key) return hit.rows.slice();
      const rows = db
        .query<LoggedAnswer, [number]>("SELECT * FROM answers WHERE ts >= ? ORDER BY ts")
        .all(now - days * 86_400_000);
      if (this.rowsCache.size >= 8) this.rowsCache.clear();
      this.rowsCache.set(days, { key, rows });
      return rows.slice();
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
