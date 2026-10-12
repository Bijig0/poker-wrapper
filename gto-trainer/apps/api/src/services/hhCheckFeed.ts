import type { Database } from "bun:sqlite";
import { FINISHED } from "../../../../packages/data-root/handsSchema";

/**
 * THE CHECKER'S FINISHED HANDS, INCREMENTALLY (2026-10-13). The checker's queue (services/hhCheck.ts tick) asked every
 * tick for every finished hand since the "from here on" cutoff: `SELECT client_hand_id … WHERE rowid > cutoff AND
 * status = 'done'`. idx_hands_status (status, rowid) finds the rows, but client_hand_id is stored AFTER the hand's JSON,
 * so every row since the cutoff was read from the table — every tick. On 2026-10-12 15:44–15:52Z, with the machine
 * paging (0.4 GB free), that was [stall] lines of 16–40 s at ~5% cpu: "timer hhCheck (finished ids …)".
 *
 * A plain rowid watermark is wrong here: rowids are handed out when a hand STARTS and hands finish out of order across
 * tables (services/hhCheck.ts header). So the feed keeps, per process:
 *   - `high`: the highest rowid it has looked at (it starts at the cutoff);
 *   - `open`: the rows at or under `high` that were not finished when it looked (a hand in play, or a live row the
 *     wrapper never finished — one index probe a tick each).
 * Each call asks only (high, max(rowid)] and the open rows, and returns each finished row's id ONCE. Which rows are
 * finished comes from idx_hands_status alone (COVERING: no hand is read); only the rows found finished by this call
 * are read for their client id — by primary key when they are few, from idx_hands_client (covering) when many (the
 * first call of a process: everything since the cutoff, once).
 *
 * A finished row is never reopened (packages/data-root/handsSchema.ts), so a row returned once is never needed again.
 * Nothing is moved until every query of the call has succeeded: a call that throws is asked again whole.
 */
export const FEED_SQL = {
  top: "SELECT max(rowid) AS r FROM hands",
  doneIn: `SELECT rowid AS r FROM hands WHERE ${FINISHED} AND rowid > ? AND rowid <= ? ORDER BY rowid`,
  doneOf: (n: number) => `SELECT rowid AS r FROM hands WHERE ${FINISHED} AND rowid IN (${marks(n)})`,
  exists: (n: number) => `SELECT rowid AS r FROM hands WHERE rowid IN (${marks(n)})`,
  idsOf: (n: number) => `SELECT rowid AS r, client_hand_id AS c FROM hands WHERE rowid IN (${marks(n)})`,
  idsIndexed: "SELECT rowid AS r, client_hand_id AS c FROM hands INDEXED BY idx_hands_client WHERE rowid > ? AND rowid <= ?",
};
/** Up to this many rows a call are read by primary key; more are read from idx_hands_client in one covering scan. */
export const FEED_BY_KEY_MAX = 64;
const CHUNK = 500;
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

export class FinishedHandsFeed {
  private high: number | null = null;
  private open = new Set<number>();
  /** `accept`: the client ids the caller wants (the checker: Ignition hand numbers only). */
  constructor(private readonly db: () => Database | null, private readonly accept: (id: string | null) => id is string) {}

  /** Client ids of the rows finished since the last call (all finished rows after `cutoff` on the first), oldest
   *  row first. */
  take(cutoff: number): string[] {
    const db = this.db();
    if (!db) return [];
    const high = Math.max(this.high ?? cutoff, cutoff);
    const top = db.query<{ r: number | null }, []>(FEED_SQL.top).get()?.r ?? 0;
    const finished: number[] = [];
    const open = new Set(this.open);
    if (top > high) {
      const done = db.query<{ r: number }, [number, number]>(FEED_SQL.doneIn).all(high, top).map((x) => x.r);
      const doneSet = new Set(done);
      finished.push(...done);
      // the rest of (high, top]: a live row is kept open; a rowid with no row (a rolled-back insert, a deleted row)
      // never comes back (AUTOINCREMENT never hands out a rowid under the max again)
      const rest: number[] = [];
      for (let r = high + 1; r <= top; r++) if (!doneSet.has(r)) rest.push(r);
      for (const part of chunks(rest)) for (const x of db.query<{ r: number }, number[]>(FEED_SQL.exists(part.length)).all(...part)) open.add(x.r);
    }
    // the open rows the previous calls saw that have finished since (open rows from this call were just asked)
    const before = [...this.open];
    for (const part of chunks(before)) {
      for (const x of db.query<{ r: number }, number[]>(FEED_SQL.doneOf(part.length)).all(...part)) { open.delete(x.r); finished.push(x.r); }
    }
    const ids = finished.length ? this.clientIds(db, finished) : [];
    this.high = Math.max(high, top);
    this.open = open;
    return ids;
  }

  /** rows still open (in play, or never finished) — for the [stall] lines and the tests */
  get openRows(): number { return this.open.size; }

  private clientIds(db: Database, rows: number[]): string[] {
    const byRow = new Map<number, string | null>();
    if (rows.length <= FEED_BY_KEY_MAX) {
      for (const x of db.query<{ r: number; c: string | null }, number[]>(FEED_SQL.idsOf(rows.length)).all(...rows)) byRow.set(x.r, x.c);
    } else {
      let lo = Infinity, hi = -Infinity;
      for (const r of rows) { if (r < lo) lo = r; if (r > hi) hi = r; }
      const want = new Set(rows);
      for (const x of db.query<{ r: number; c: string | null }, [number, number]>(FEED_SQL.idsIndexed).all(lo - 1, hi)) if (want.has(x.r)) byRow.set(x.r, x.c);
    }
    return [...rows].sort((a, b) => a - b).map((r) => byRow.get(r) ?? null).filter(this.accept);
  }
}

function* chunks<T>(xs: T[]): Generator<T[]> {
  for (let i = 0; i < xs.length; i += CHUNK) yield xs.slice(i, i + CHUNK);
}
