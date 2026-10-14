import { Database } from "bun:sqlite";
import type { PathRow } from "./chainPath";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { answersDbPath, openStore, storeWriteFailed } from "./storePaths";
import { AnswerView } from "./answerView";
import { pagedSeed, type PagedSeedResult } from "./sqlitePager";

const DAY_MS = 86_400_000;
/** how far back the in-memory view keeps rows (ANSWER_VIEW_DAYS; the catalogue's yearly rebase reads 365 d) */
export const ANSWER_VIEW_DAYS_DEFAULT = 400;
/** the view is rebuilt from the table this often, between sessions — another PROCESS's UPDATE (scripts/rescoreChecks.ts
 *  rewriting paths) is not seen by the tail read, only by a reseed */
export const ANSWER_VIEW_RESEED_MS = 6 * 3_600_000;
/** a seed that failed is not retried sooner than this (the SQL path serves meanwhile) */
const ANSWER_VIEW_RETRY_MS = 5 * 60_000;
/** the seed's page: ~1.3 KB a row (paths, chains and mixes), so 500 rows ≈ 650 KB a slice */
const ANSWER_VIEW_PAGE = 500;

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
  /** THE SHORT ALL-IN PRESS (2026-10-07, services/allInPress): the answer's press entries (JSON) — how an ALLIN in its
   *  mix is pressed when a collapsed tree capped it below hero's stack. Null = every action presses as before. */
  press?: string | null;
  /** PER-SEAT SESSION VPIP / PFR (2026-10-09, services/seatStats): every villain seat of the hand — hands seen this
   *  session for the seat's current occupant, VPIP and PFR counts, how the occupant was carried (JSON). Logging only:
   *  the groundwork for a session-VPIP band (memory player-type-study). Null when the table was never observed. */
  seatStats?: string | null;
  /** WHAT THE API SAW (2026-10-14, hand 4924546540): the hand this decision was asked on, compact (captureJson below) —
   *  every action as seatId:type[:amount], the wrapper's lineSource / lineUncertain / lineNote, positions, live seats,
   *  start stacks, toCall. Written on EVERY row the poller writes, failed ones included. */
  captureJson?: string | null;
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
  // THE SHORT ALL-IN PRESS (2026-10-07, services/allInPress): an ALLIN pressed as a raise to the tree's amount
  ["press", "TEXT"],
  // PER-SEAT SESSION VPIP / PFR (2026-10-09, services/seatStats): logging only, the player-type groundwork
  ["seat_stats", "TEXT"],
  // WHAT THE API SAW (2026-10-14, hand 4924546540): the live hand per decision — see captureJson
  ["capture_json", "TEXT"],
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
 *  socket-stall         never asked about because the table's connection went silent: hero's turn reached the
 *                       wrapper late or not at all (the wrapper stamps the hand's `connStalls`, ignition/stall.ts)
 *
 * The last five used to leave no trace whatsoever: the poller returned early
 * and the node simply had no row.
 */
export const FAIL_KINDS = [
  "no-solution", "off-tree", "not-in-range", "not-heros-turn", "hand-over",
  "solver-timeout", "solver-unreachable", "solver-bad-response", "gtow-down",
  "abandoned-stale", "no-probe", "socket-stall",
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
  // the wrapper's socket joined the hand after it began (2026-10-14): its earlier actions were never seen, so the
  // hand's decisions are refused unasked-for — availability, not a capture that went wrong (fastSolve.unsolvableCapture)
  "joined-mid-hand",
  // the solver THREW (a bug, not the spot) — fastSolve turns it into this refusal instead of an HTTP 500 (2026-10-04)
  "solver-error",
  // GTO Wizard answered too late or refused for load: a solve / poll timed out, or its request limit (429) — 2026-10-10,
  // ~15 of the 47 "unknown" no-answers since 09-28 were these (a time box, not the spot)
  "gtow-timeout",
  "unknown",
] as const;
export type FailKind = (typeof FAIL_KINDS)[number];

/** Rows that record a decision nobody ASKED about — not a solve that failed, so never counted as one. */
export const NEVER_ASKED: ReadonlySet<string> = new Set<FailKind>(["no-probe", "socket-stall"]);

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
  if (r.includes("joined this hand mid-way")) return "joined-mid-hand";
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
  // …and stacks past GTO Wizard's preflop limit ("GTO Wizard refused the tree: Preflop: Only effective stacks up to
  // 250bb are supported", 2026-10-03 — the tree is capped since; a refusal of it is still a table GTO Wizard cannot hold)
  if (r.includes("table thinned") || r.includes("seats: the ai preflop piece covers") || r.includes("only effective stacks up to")) return "table-shape";
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
  // …and an auth refusal the token refresh did not cure ("GTO Wizard auth failed twice (token rotation)", services/gtowAuth)
  if (r.includes("no gto wizard session") || r.includes("no gto wizard token") || r.includes("did not return the node in time")
      || r.includes("gto wizard auth failed")) return "gtow-down";
  if (r.includes("unable to connect") || r.includes("unreachable")) return "solver-unreachable";
  if (r.includes("ai solve timed out") || r.includes("poll request failed") || r.includes("timed out")
      || r.includes(" 429") || r.includes("request limit") || r.includes("no answer inside")) return "gtow-timeout";
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
  /** read per hand / session (forHand, forSession); left out of the in-memory view, so rows(days) may not carry it */
  capture_json?: string | null;
}

/**
 * WHAT THE API SAW (2026-10-14, hand 4924546540, session_20261014_131738). A live decision got no answer because the
 * action list the API received carried a fold for a seat that was ALL-IN; the wrapper's own archive of the hand (written
 * 20 s later) had no such fold, and its /state carried it through two asks. Nothing kept the live hand per decision —
 * decision_json is written for served answers only, the wrapper's lineSource nowhere — so the occurrence could not be
 * attributed. Every row the poller writes now carries this: the hand as the solve read it (the /fast-solver reply's
 * `hand`), else as the probe read it (/ingest's `hand`). Bounded: at most CAPTURE_MAX_ACTIONS actions and
 * CAPTURE_MAX_CHARS characters, shrunk with a `truncated` marker rather than refused — a capture never blocks a row.
 */
export const CAPTURE_MAX_ACTIONS = 60;
export const CAPTURE_MAX_CHARS = 4096;

/** The hand fields a capture reads — /fast-solver's and /ingest's `hand` projection (both loose JSON here). */
export interface CaptureHand {
  street?: string | null;
  actions?: unknown[] | null;
  positions?: Record<string, unknown> | null;
  liveSeats?: unknown;
  startStacks?: Record<string, unknown> | null;
  node?: { toCall?: number | null } | null;
  lineSource?: string | null;
  lineUncertain?: string | null;
  lineNote?: string | null;
}

const capNum = (v: unknown): number | null => {
  const x = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
};

/** One action as `seatId:type[:amount]` (amount rounded to 0.001). */
const captureAction = (a: unknown): string => {
  if (typeof a !== "object" || a === null) return "?";
  const r = a as { seatId?: unknown; type?: unknown; amount?: unknown };
  const amt = capNum(r.amount);
  return `${r.seatId ?? "?"}:${String(r.type ?? "?")}${amt != null ? `:${amt}` : ""}`;
};

/** The capture_json of one decision: null only when there is no hand at all. */
export function captureJson(hand: CaptureHand | null | undefined): string | null {
  if (!hand || typeof hand !== "object") return null;
  try {
    const acts = Array.isArray(hand.actions) ? hand.actions : [];
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const nums = (o: unknown): Record<string, number> | undefined => {
      if (typeof o !== "object" || o === null) return undefined;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(o)) { const x = capNum(v); if (x != null) out[k] = x; }
      return Object.keys(out).length ? out : undefined;
    };
    const positions: Record<string, string> = {};
    if (typeof hand.positions === "object" && hand.positions !== null) {
      for (const [k, v] of Object.entries(hand.positions)) if (typeof v === "string") positions[k] = v;
    }
    const cap: Record<string, unknown> = {
      lineSource: str(hand.lineSource),
      lineUncertain: str(hand.lineUncertain),
      lineNote: str(hand.lineNote),
      street: typeof hand.street === "string" ? hand.street : null,
      actions: acts.slice(0, CAPTURE_MAX_ACTIONS).map(captureAction),
      positions,
      liveSeats: Array.isArray(hand.liveSeats) ? hand.liveSeats.filter((s) => typeof s === "number")
        : typeof hand.liveSeats === "object" && hand.liveSeats !== null ? Object.keys(hand.liveSeats).map(Number) : [],
      ...((): { startStacks?: Record<string, number> } => { const ss = nums(hand.startStacks); return ss ? { startStacks: ss } : {}; })(),
      toCall: capNum(hand.node?.toCall),
      actionCount: acts.length,
      ...(acts.length > CAPTURE_MAX_ACTIONS ? { truncated: `actions: first ${CAPTURE_MAX_ACTIONS} of ${acts.length}` } : {}),
    };
    let out = JSON.stringify(cap);
    if (out.length <= CAPTURE_MAX_CHARS) return out;
    // too long: the free-text notes first, then the action list from its end — the marker says what went
    for (const k of ["lineNote", "lineUncertain", "lineSource"] as const) {
      if (typeof cap[k] === "string" && (cap[k] as string).length > 200) cap[k] = `${(cap[k] as string).slice(0, 200)}…`;
    }
    const list = cap.actions as string[];
    for (;;) {
      cap.truncated = `size: ${list.length} of ${acts.length} actions kept`;
      out = JSON.stringify(cap);
      if (out.length <= CAPTURE_MAX_CHARS || !list.length) break;
      list.splice(Math.max(0, list.length - 8));
    }
    return out.length <= CAPTURE_MAX_CHARS ? out
      : JSON.stringify({ street: cap.street, lineSource: typeof cap.lineSource === "string" ? (cap.lineSource as string).slice(0, 200) : null, actionCount: acts.length, truncated: "size: capture dropped" });
  } catch {
    return null;   // a capture is evidence, never a reason to lose the row
  }
}

/** The in-memory view's copy of a row: without capture_json (read per hand, never by the window readers — ~0.5-1 KB a
 *  row the view would otherwise hold for 400 days). */
const forView = (r: LoggedAnswer): LoggedAnswer => {
  if (r.capture_json === undefined) return r;
  const { capture_json: _drop, ...rest } = r;
  void _drop;
  return rest as LoggedAnswer;
};

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
   * THE INCREMENTAL VIEW (2026-10-09, catalogue-incremental; services/answerView.ts has the why). When on, rows(days),
   * bySource, stats, countWarnings and countPathCodes read MEMORY: the view is seeded ONCE off the loop (a Bun Worker
   * reads the table in pages, services/sqlitePager.ts; each page applied in its own short slice, after the live answers),
   * add() pushes each new row into it at once, attach() re-reads the row it changed, and a read first takes the rows
   * another process appended (one `max(id)` primary-key read; normally nothing more). Until the seed lands — or if it
   * failed — the SQL path below serves, exactly as before. Off under bun test unless a test asks (`{ view: true }`), and
   * with ANSWER_VIEW=off.
   */
  private readonly viewOn: boolean;
  private readonly viewMaxAgeMs: number;
  private view: AnswerView | null = null;
  /** every id <= this has been read into the view (the tail read starts after it) */
  private viewTailId = 0;
  private viewSeededAt = 0;
  private viewFailedAt = 0;
  private seeding: Promise<boolean> | null = null;
  /** ids attach() changed while a seed ran: re-read when it lands (the seed may have read them before the change) */
  private dirtyDuringSeed: Set<number> | null = null;
  /** the last seed's numbers (the [answer-view] line; tests) */
  lastSeed: (PagedSeedResult & { at: number; reseed: boolean }) | null = null;
  /** a reseed waits while this is true (routes/sources.ts sets it: a poker session is live, or the setup page is open) */
  viewHold: () => boolean = () => false;
  /** the seed's reader: "auto" = a Worker for a file, the loop for ":memory:" (tests pin one) */
  viewSeedMode: "auto" | "worker" | "loop" = "auto";

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
  constructor(path?: string, opts: { view?: boolean; viewDays?: number } = {}) {
    this.path = path ?? answersDbPath();
    assertTestSafePath(this.path);
    this.viewOn = opts.view ?? false;
    this.viewMaxAgeMs = (opts.viewDays ?? ANSWER_VIEW_DAYS_DEFAULT) * DAY_MS;
  }

  get dbPath(): string {
    return this.path;
  }

  /**
   * Release the sqlite handle; the next call reopens it. Tests close before removing their temp dir — Windows refuses
   * to delete a database (and its WAL) that is still open, which is how answers-test-* dirs piled up in %TEMP%.
   */
  close(): void {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
    this.rowsCache.clear();
    this.view = null; this.viewTailId = 0; this.viewSeededAt = 0; this.dirtyDuringSeed = null;
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
      const res = this.open()
        .query(
          `INSERT INTO answers (ts, wrapper_hand_id, client_hand_id, street, board,
             hero_cards, decision_key, text, pick, roll, tier, warning, latency_ms, fail_reason, chart,
             strategy_mode, source, band_lo, band_hi, exploit_pick, chart_pick, exploit_tag,
             mes_family, mes_board, mes_ev_gain_bb, mes_exact, bb_cents, table_seats, table_slot, hero_pos,
             depth, set_id, decision_json, line, solve_id, session_id, fail_kind, path_verdict, path, chain, press, seat_stats, capture_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
          row.pathVerdict ?? null, row.path ?? null, row.chain ?? null, row.press ?? null, row.seatStats ?? null,
          row.captureJson ?? null
        );
      this.writeSeq++;
      this.pushToView(Number(res.lastInsertRowid));
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
      this.dirtyDuringSeed?.add(id);
      if (this.view?.has(id)) this.pushToView(id, false);
    } catch (e) {
      storeWriteFailed("answers.attach", e);
    }
  }

  // ── the incremental view ────────────────────────────────────────────────────────────────────────────────────────

  /** Is the view on for this log, and seeded? */
  viewState(): { on: boolean; ready: boolean; seeding: boolean; rows: number; seededAt: number | null; lastSeed: AnswerLog["lastSeed"] } {
    return { on: this.viewOn, ready: this.view != null, seeding: this.seeding != null, rows: this.view?.size ?? 0,
      seededAt: this.viewSeededAt || null, lastSeed: this.lastSeed };
  }

  /** Resolves once the view is seeded (true), or the seed failed / the view is off (false: the SQL path serves). Starts
   *  the seed if none ran yet. The catalogue build awaits this, so it never falls back to a whole-table read. */
  viewReady(): Promise<boolean> {
    if (!this.viewOn) return Promise.resolve(false);
    if (this.view) return Promise.resolve(true);
    return this.seedView();
  }

  /** Seed (or reseed) the view off the loop; the current view keeps serving until the new one lands. */
  seedView(): Promise<boolean> {
    if (!this.viewOn) return Promise.resolve(false);
    if (this.seeding) return this.seeding;
    if (!this.view && this.viewFailedAt && Date.now() - this.viewFailedAt < ANSWER_VIEW_RETRY_MS) return Promise.resolve(false);
    const reseed = this.view != null;
    const p = (async () => {
      try {
        const db = this.open();   // the DDL, the column migrations and the one-off classification run first, as before
        const now = Date.now();
        const cutoff = now - this.viewMaxAgeMs;
        const v = new AnswerView(this.viewMaxAgeMs);
        // the view is complete from the cutoff when older rows exist, else it holds the whole table
        const minTs = db.query<{ m: number | null }, []>("SELECT min(ts) m FROM answers").get()?.m ?? null;
        if (minTs != null && minTs < cutoff) v.completeSince = cutoff;
        const startId = db.query<{ m: number | null }, [number]>("SELECT min(id) m FROM answers WHERE ts >= ?").get(cutoff)?.m ?? null;
        this.dirtyDuringSeed = new Set();
        let lastId = startId == null ? (db.query<{ m: number | null }, []>("SELECT max(id) m FROM answers").get()?.m ?? 0) : startId - 1;
        const r: PagedSeedResult = startId == null
          ? { ok: true, mode: "loop", pages: 0, rows: 0, ms: 0, maxSliceMs: 0 }
          : await pagedSeed({
            path: this.path, db: () => this.open(), mode: this.viewSeedMode, pageSize: ANSWER_VIEW_PAGE, derive: "pathCodes",
            sql: "SELECT * FROM answers WHERE id > $after AND ts >= $cutoff ORDER BY id LIMIT $limit", params: { cutoff },
            after: lastId,
            onPage: (rows: LoggedAnswer[], derived?: unknown[]) => {
              for (let i = 0; i < rows.length; i++) v.upsert(forView(rows[i]!), derived?.[i] as string[] | undefined, now);
              lastId = Math.max(lastId, rows[rows.length - 1]!.id);
            },
          });
        this.lastSeed = { ...r, at: Date.now(), reseed };
        if (!r.ok) {
          this.viewFailedAt = Date.now();
          console.warn(`[answer-view] seed failed after ${r.rows} rows (${r.error}) — the SQL path keeps serving`);
          return this.view != null;
        }
        // catch up on the loop: rows appended while it ran, and rows attach() changed under it (a few, by primary key)
        this.viewTailId = lastId;
        this.syncViewTail(v);
        for (const id of this.dirtyDuringSeed ?? []) this.readIntoView(v, id);
        this.view = v;
        this.viewSeededAt = Date.now();
        this.viewFailedAt = 0;
        console.log(`[answer-view] ${reseed ? "reseeded" : "seeded"} ${v.size.toLocaleString()} answers in ${(r.ms / 1000).toFixed(1)} s (${r.mode}, ${r.pages} pages) — longest slice on the loop ${r.maxSliceMs} ms; reads are memory from here`);
        return true;
      } catch (e) {
        this.viewFailedAt = Date.now();
        console.warn(`[answer-view] seed failed: ${e instanceof Error ? e.message : e} — the SQL path keeps serving`);
        return this.view != null;
      } finally {
        this.dirtyDuringSeed = null;
      }
    })();
    this.seeding = p;
    void p.finally(() => { if (this.seeding === p) this.seeding = null; });
    return p;
  }

  /** The view's rows of the last `days`, or null (view off / not seeded / asked further back than it holds). */
  private viewWindow(days: number, now = Date.now()): { rows: LoggedAnswer[]; view: AnswerView } | null {
    if (!this.viewOn) return null;
    const v = this.view;
    if (!v) { void this.seedView(); return null; }
    // a reseed (another process's UPDATEs) only between sessions; the current view serves until the new one lands
    if (now - this.viewSeededAt > ANSWER_VIEW_RESEED_MS && !this.seeding && !this.viewHoldNow()) void this.seedView();
    v.evict(now);
    const since = now - days * DAY_MS;
    if (!v.covers(since)) return null;
    try { this.syncViewTail(v); } catch { /* the next read catches up */ }
    return { rows: v.window(since), view: v };
  }

  private viewHoldNow(): boolean { try { return this.viewHold(); } catch { return false; } }

  /** Another process's appends: one max(id) read, and the rows past the view's tail when there are any. */
  private syncViewTail(v: AnswerView): void {
    const db = this.open();
    const m = db.query<{ m: number | null }, []>("SELECT max(id) m FROM answers").get()?.m ?? 0;
    if (m <= this.viewTailId) return;
    for (;;) {
      const rows = db.query<LoggedAnswer, [number]>("SELECT * FROM answers WHERE id > ? ORDER BY id LIMIT 1000").all(this.viewTailId);
      for (const r of rows) v.upsert(forView(r));
      if (rows.length) this.viewTailId = rows[rows.length - 1]!.id;
      if (rows.length < 1000) return;
    }
  }

  private readIntoView(v: AnswerView, id: number): void {
    const row = this.open().query<LoggedAnswer, [number]>("SELECT * FROM answers WHERE id = ?").get(id);
    if (row) v.upsert(forView(row));
  }

  /** The writer's push: the row just written (or changed) goes into the view at once (one primary-key read). */
  private pushToView(id: number, isInsert = true): void {
    const v = this.view;
    if (!v || !Number.isFinite(id) || id <= 0) return;
    try {
      this.readIntoView(v, id);
      // the tail stays contiguous: a gap (another process wrote in between) is left for the tail read to fill
      if (isInsert && id === this.viewTailId + 1) this.viewTailId = id;
    } catch { /* the tail read catches up */ }
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
      const w = this.viewWindow(days);
      if (w) return w.rows;
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
      const rows = this.viewWindow(days)?.rows ?? this.open()
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
      const rows = this.viewWindow(days)?.rows ?? this.open()
        .query<{ ts: number; warning: string | null; text: string | null }, [number]>(
          "SELECT ts, warning, text FROM answers WHERE ts >= ? AND text IS NOT NULL AND warning IS NOT NULL AND warning <> ''"
        )
        .all(since);
      const lowered = needles.map((x) => [x, x.toLowerCase()] as const);
      for (const r of rows) {
        if (r.text == null || !r.warning) continue;   // the view holds every row; the SQL above filtered these already
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

  /**
   * How many answered decisions' chain paths carried each reason code (services/chainPath), over the last `days` —
   * the register's `pathCodes` join (2026-10-05). One SQL pass over the paths' `reasons` (~80 ms over 30 days of
   * ~11,000 answers); remembered for a minute, because the Sources page asks on every visit.
   */
  countPathCodes(days = 30): Record<string, { n: number; lastTs: number | null }> {
    // from the view: each row's codes were parsed once, when it arrived (in the seed's worker, or by the writer's push)
    const w = this.viewWindow(days);
    if (w) {
      const out: Record<string, { n: number; lastTs: number | null }> = {};
      for (const r of w.rows) {
        if (r.text == null) continue;
        for (const code of w.view.codesOf(r)) {
          const o = (out[code] ??= { n: 0, lastTs: null });
          o.n++;
          if (o.lastTs == null || r.ts > o.lastTs) o.lastTs = r.ts;
        }
      }
      return out;
    }
    const key = `${this.path}|${days}`;
    const hit = this.pathCodeMemo;
    if (hit && hit.key === key && Date.now() - hit.at < 60_000) return hit.out;
    const out: Record<string, { n: number; lastTs: number | null }> = {};
    try {
      const since = Date.now() - days * 86_400_000;
      const rows = this.open()
        .query<{ code: string | null; n: number; last: number | null }, [number]>(
          // the reasons' codes, and the arrival's own code and its first computation's (a flop floor's code rides on
          // the arrival — on a later street's memo hit, on arrival.first — even where it is not a reason); UNION counts
          // an answer once per code
          `SELECT code, count(*) AS n, max(ts) AS last FROM (
             SELECT a.id, a.ts, json_extract(j.value, '$.code') AS code
               FROM answers a, json_each(a.path, '$.reasons') j
              WHERE a.ts >= ?1 AND a.text IS NOT NULL AND a.path IS NOT NULL AND json_valid(a.path)
             UNION
             SELECT a.id, a.ts, json_extract(a.path, '$.arrival.code') AS code
               FROM answers a
              WHERE a.ts >= ?1 AND a.text IS NOT NULL AND a.path IS NOT NULL AND json_valid(a.path)
             UNION
             SELECT a.id, a.ts, json_extract(a.path, '$.arrival.first.code') AS code
               FROM answers a
              WHERE a.ts >= ?1 AND a.text IS NOT NULL AND a.path IS NOT NULL AND json_valid(a.path)
           ) WHERE code IS NOT NULL GROUP BY code`
        )
        .all(since);
      for (const r of rows) if (r.code) out[r.code] = { n: r.n, lastTs: r.last };
    } catch {
      /* the register degrades to "unmeasured", it never throws */
    }
    this.pathCodeMemo = { key, at: Date.now(), out };
    return out;
  }
  private pathCodeMemo: { key: string; at: number; out: Record<string, { n: number; lastTs: number | null }> } | null = null;

  /** Latency percentiles + counts per tier, over the last `days`. */
  stats(days = 30): unknown {
    try {
      const since = Date.now() - days * 86_400_000;
      const rows = this.viewWindow(days)?.rows ?? this.open()
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

/** The process's log: the incremental view is on in the API (ANSWER_VIEW=off turns it off), off under bun test (a test
 *  constructs its own `new AnswerLog(path, { view: true })`). */
export const answerLog = new AnswerLog(undefined, {
  view: process.env.NODE_ENV !== "test" && !/^(off|0|false|no)$/i.test(process.env.ANSWER_VIEW?.trim() ?? ""),
  viewDays: Number(process.env.ANSWER_VIEW_DAYS) > 0 ? Number(process.env.ANSWER_VIEW_DAYS) : undefined,
});
export { AnswerLog };
