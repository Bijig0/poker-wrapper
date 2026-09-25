import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openStore, solvesDbPath } from "./storePaths";
import { tspan } from "./answerTrace";

/**
 * Every GTO Wizard AI-chain solve, inputs and outputs, kept.
 *
 * The live answer path (services/aiChain.ts) walks one custom solution per
 * street, conditioning both ranges on every observed action. Until now only
 * the final verdict survived: the ranges it assumed, the per-node strategies
 * it multiplied through, and the cloud solution ids were gone the moment the
 * panel was pushed — so a "why did it say that?" could only be answered by
 * re-solving, which is a different solve (cache state, tree, quota).
 *
 * A trace is the whole walk: the spec (positions, flop-entering 1326-combo
 * ranges, pot/stack, board, tokens), each street's tree (pot/stack entering,
 * engine labels, pinned sizes, solution id, fresh-or-cached), and every node
 * walked with its full action_solutions (strategy + EV per combo) and which
 * action was taken. Gzipped JSON in its own SQLite file: a river decision is
 * ~100 KB compressed, so a season of play is tens of MB.
 *
 * `origin` says who asked: "live" (the study poller at the table), "replay"
 * (the dashboard re-solving an archived node to compare), "sweep"/"adhoc".
 */

export interface SolveMeta {
  origin: string;
  /** The wrapper's declared session (sessions.py) — null for solves outside one. */
  sessionId?: string | null;
  clientHandId: string | null;
  wrapperHandId: number | null;
  decisionKey: string | null;
  street: string | null;
  board: string | null;
  heroCards: string | null;
  heroPos: string | null;
  tier: string | null;
  line: string | null;
  solves: number | null;
  solveMs: number | null;
  ok: boolean;
  why: string | null;
}

export interface SolveRow extends SolveMeta {
  id: number;
  ts: number;
  bytes: number;
}

const DDL = `CREATE TABLE IF NOT EXISTS solves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  origin TEXT,
  client_hand_id TEXT,
  wrapper_hand_id INTEGER,
  decision_key TEXT,
  street TEXT,
  board TEXT,
  hero_cards TEXT,
  hero_pos TEXT,
  tier TEXT,
  line TEXT,
  solves INTEGER,
  solve_ms INTEGER,
  ok INTEGER,
  why TEXT,
  bytes INTEGER,
  trace BLOB,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_solves_hand ON solves(client_hand_id);
CREATE INDEX IF NOT EXISTS idx_solves_ts ON solves(ts)`;

class SolveStore {
  private db: Database | null = null;
  readonly path: string;

  constructor(path?: string) {
    this.path = path ?? solvesDbPath();
  }

  private open(): Database {
    if (this.db) return this.db;
    this.db = openStore(this.path); // the central DB (WAL, busy timeout — a held lock must wait, not throw)
    this.db.exec(DDL);
    const cols = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(solves)").all().map((c) => c.name));
    if (!cols.has("session_id")) this.db.exec("ALTER TABLE solves ADD COLUMN session_id TEXT");
    return this.db;
  }

  /** Persist a trace; returns its id, or null if storing failed (never throws). */
  save(meta: SolveMeta, trace: unknown): number | null {
    // synchronous on purpose (bun:sqlite is), and therefore recorded: a river trace is ~40 KB gzipped from a
    // few hundred KB of JSON, and this runs BEFORE the answer is returned (services/answerTrace.ts)
    const t0 = Date.now();
    try {
      const blob = Bun.gzipSync(Buffer.from(JSON.stringify(trace)));
      tspan("store trace (gzip)", t0, `${Math.round(blob.byteLength / 1024)} KB`);
      const r = this.open()
        .query(
          `INSERT INTO solves (ts, origin, client_hand_id, wrapper_hand_id, decision_key, street, board, hero_cards, hero_pos,
             tier, line, solves, solve_ms, ok, why, bytes, trace, session_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          Date.now(), meta.origin, meta.clientHandId, meta.wrapperHandId, meta.decisionKey, meta.street, meta.board,
          meta.heroCards, meta.heroPos, meta.tier, meta.line, meta.solves, meta.solveMs, meta.ok ? 1 : 0, meta.why,
          blob.byteLength, blob, meta.sessionId ?? null
        );
      return Number(r.lastInsertRowid);
    } catch {
      return null;
    }
  }

  get(id: number): { row: SolveRow; trace: any } | null {
    try {
      const r = this.open()
        .query<any, [number]>("SELECT * FROM solves WHERE id = ?")
        .get(id);
      if (!r) return null;
      const trace = JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString("utf-8"));
      return { row: this.rowOf(r), trace };
    } catch {
      return null;
    }
  }

  /**
   * THE STORED CHAIN FOR AN ANSWER, BY ITS STABLE KEY (2026-09-25). `answers.solve_id` is a row number, and a row number
   * only means something inside the file it was written to — hand 973's answers pointed at #62/#65/#72, which in this
   * store are Sep 16 ad-hoc solves of other hands. So row #id is returned only when it IS that hand's decision; otherwise
   * the chain is looked up by (client hand id, decision key); otherwise the answer says why there is none.
   */
  forAnswer(id: number | null, clientHandId: string | null, decisionKey: string | null):
    { ok: true; row: SolveRow; trace: any; via: "id" | "key" } | { ok: false; error: string } {
    const byId = id != null ? this.get(id) : null;
    if (byId && (!clientHandId || byId.row.clientHandId === clientHandId) && (!decisionKey || byId.row.decisionKey === decisionKey)) {
      return { ok: true, ...byId, via: "id" };
    }
    if (clientHandId) {
      try {
        const r = this.open()
          .query<any, [string, string | null, string | null]>(
            "SELECT * FROM solves WHERE client_hand_id = ? AND (? IS NULL OR decision_key = ?) ORDER BY ts DESC LIMIT 1"
          )
          .get(clientHandId, decisionKey, decisionKey);
        if (r) return { ok: true, row: this.rowOf(r), trace: JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString("utf-8")), via: "key" };
      } catch { /* fall through to the explanation */ }
    }
    if (byId) {
      return { ok: false, error: `this answer's stored chain is not in this data root: row #${id} here belongs to hand ${byId.row.clientHandId ?? "?"}` +
        ` (${byId.row.street ?? "?"}, ${new Date(byId.row.ts).toISOString().slice(0, 16).replace("T", " ")}), not hand ${clientHandId} — the chain was stored by an API writing somewhere else` };
    }
    return { ok: false, error: id != null ? `no stored solve #${id}` : `no stored chain for hand ${clientHandId ?? "?"}` };
  }

  /** Rows (no blobs) for a hand, oldest first. */
  forSession(sessionId: string): SolveRow[] {
    try {
      return this.open()
        .query<any, [string]>(
          "SELECT id, ts, origin, client_hand_id, wrapper_hand_id, decision_key, street, board, hero_cards, hero_pos, tier, line, solves, solve_ms, ok, why, bytes, session_id FROM solves WHERE session_id = ? ORDER BY ts"
        )
        .all(sessionId)
        .map((r) => this.rowOf(r));
    } catch {
      return [];
    }
  }

  forHand(clientHandId: string): SolveRow[] {
    try {
      return this.open()
        .query<any, [string]>(
          "SELECT id, ts, origin, client_hand_id, wrapper_hand_id, decision_key, street, board, hero_cards, hero_pos, tier, line, solves, solve_ms, ok, why, bytes FROM solves WHERE client_hand_id = ? ORDER BY ts"
        )
        .all(clientHandId)
        .map((r) => this.rowOf(r));
    } catch {
      return [];
    }
  }

  recent(limit = 50): SolveRow[] {
    try {
      return this.open()
        .query<any, [number]>(
          "SELECT id, ts, origin, client_hand_id, wrapper_hand_id, decision_key, street, board, hero_cards, hero_pos, tier, line, solves, solve_ms, ok, why, bytes FROM solves ORDER BY ts DESC LIMIT ?"
        )
        .all(limit)
        .map((r) => this.rowOf(r));
    } catch {
      return [];
    }
  }

  stats(): { count: number; bytes: number; live: number; replay: number; failed: number } {
    try {
      const r = this.open()
        .query<{ n: number; b: number; live: number; replay: number; failed: number }, []>(
          "SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b, SUM(origin='live') live, SUM(origin='replay') replay, SUM(ok=0) failed FROM solves"
        )
        .get();
      return { count: r?.n ?? 0, bytes: r?.b ?? 0, live: r?.live ?? 0, replay: r?.replay ?? 0, failed: r?.failed ?? 0 };
    } catch {
      return { count: 0, bytes: 0, live: 0, replay: 0, failed: 0 };
    }
  }

  private rowOf(r: any): SolveRow {
    return {
      id: r.id, ts: r.ts, origin: r.origin, clientHandId: r.client_hand_id, wrapperHandId: r.wrapper_hand_id,
      decisionKey: r.decision_key, street: r.street, board: r.board, heroCards: r.hero_cards, heroPos: r.hero_pos,
      tier: r.tier, line: r.line, solves: r.solves, solveMs: r.solve_ms, ok: r.ok === 1, why: r.why, bytes: r.bytes,
      sessionId: r.session_id ?? null,
    };
  }
}

export const solveStore = new SolveStore();
export { SolveStore };
