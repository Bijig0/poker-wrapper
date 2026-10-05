/**
 * EVERY HAND CHECKED AGAINST IGNITION. Once the wrapper archives a hand (its hands.db row is written when the hand is
 * over), Ignition's own record of it is fetched and compared with what the reader captured. The verdict is kept per
 * hand for the hand page's Actual tab. Ignition may not have the record the moment the hand ends, so a "not found" is
 * retried on a schedule before the hand is marked unavailable; an unreachable client costs no try.
 *
 * Only hands archived after the first start are checked ("from here on"): the older archive is the audit script's job
 * (scripts/hhAudit.ts). The state machine (nextCheck) is pure; the store and the loop are the only I/O.
 *
 * WHICH HANDS (2026-09-25, the central DB): a hand's row is written LIVE when it starts and finished in place when it
 * ends, so rowids are handed out at hand START and hands finish out of order across tables. A rowid watermark would skip
 * a hand still in play (or, held at the lowest live row, let one long hand stall the other tables). So: a one-time
 * cutoff ("from here on", set on the first start and never moved), and every FINISHED hand after it that has no check
 * row yet. A finished row is never reopened, so "no check yet" is the whole rule.
 */
import { offTreeLog } from "./offTreeLog";
import type { Database } from "bun:sqlite";
import { archivedByClientHandId, doneIgnitionHandIdsAfter, doneIgnitionHandsAfter, lastArchivedRowid, type Enriched } from "../routes/dashboard";
import { hhChecksDbPath, openStore } from "./storePaths";
import { compareHand, compareThroughHero, parseIgnitionHh, type HhDiff, type IgnHand } from "../utils/ignitionHh/ignitionHh";
import { fetchIgnitionRecord, type RecordResult } from "./ignitionRecord";
import { asActivity } from "./answerTrace";

export type CheckStatus = "pending" | "match" | "mismatch" | "unavailable";
export interface HhCheck {
  clientHandId: string;
  dbId: number;
  playedAt: number | null;
  status: CheckStatus;
  /** agrees up to hero's last action — what every answer was built on (null until compared) */
  throughOk: boolean | null;
  diffs: HhDiff[];
  through: HhDiff[];
  tries: number;
  nextAt: number | null;
  checkedAt: number | null;
  error: string | null;
}
export interface Comparison { ignition: IgnHand; diffs: HhDiff[]; through: HhDiff[] }

// ----------------------------------------------------------------------------------------------- pure core

/** Wait before try n (ms): Ignition's record usually lands within a minute of the hand, rarely later. */
export const RETRY_DELAYS_MS = [0, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];
/** An unreachable client (wrapper down, table closed, network) is asked again after this, without spending a try. */
export const UNREACHABLE_RETRY_MS = 60_000;

export const freshCheck = (e: Pick<Enriched, "clientHandId" | "dbId" | "playedAt">, now: number): HhCheck => ({
  clientHandId: e.clientHandId!, dbId: e.dbId, playedAt: e.playedAt, status: "pending", throughOk: null,
  diffs: [], through: [], tries: 0, nextAt: now + RETRY_DELAYS_MS[0]!, checkedAt: null, error: null,
});

export const compareRecord = (body: unknown, archived: Enriched): Comparison => {
  const ignition = parseIgnitionHh(body);
  return { ignition, diffs: compareHand(archived.hand, ignition), through: compareThroughHero(archived.hand, ignition) };
};

export type Outcome = { kind: "compared"; diffs: HhDiff[]; through: HhDiff[] } | Extract<RecordResult, { ok: false }>;

/** The check after one attempt. */
export function nextCheck(prev: HhCheck, outcome: Outcome, now: number): HhCheck {
  if ("kind" in outcome) {
    return { ...prev, status: outcome.diffs.length ? "mismatch" : "match", throughOk: !outcome.through.length,
      diffs: outcome.diffs, through: outcome.through, tries: prev.tries + 1, nextAt: null, checkedAt: now, error: null };
  }
  if (outcome.reason === "unreachable") return { ...prev, nextAt: now + UNREACHABLE_RETRY_MS, error: outcome.error };
  const tries = prev.tries + 1;
  const wait = RETRY_DELAYS_MS[tries];
  return wait == null
    ? { ...prev, tries, status: "unavailable", nextAt: null, checkedAt: now, error: outcome.error }
    : { ...prev, tries, nextAt: now + wait, error: outcome.error };
}

// ------------------------------------------------------------------------------------------------- store

interface Row {
  client_hand_id: string; db_id: number; played_at: number | null; status: CheckStatus; through_ok: number | null;
  diffs: string; through: string; tries: number; next_at: number | null; checked_at: number | null; error: string | null;
}
const fromRow = (r: Row): HhCheck => ({
  clientHandId: r.client_hand_id, dbId: r.db_id, playedAt: r.played_at, status: r.status,
  throughOk: r.through_ok == null ? null : r.through_ok === 1, diffs: JSON.parse(r.diffs), through: JSON.parse(r.through),
  tries: r.tries, nextAt: r.next_at, checkedAt: r.checked_at, error: r.error,
});

export class HhCheckStore {
  private db: Database;
  constructor(path: string) {
    this.db = openStore(path);   // the central DB (WAL + busy timeout), or a test's own file
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hh_checks (
        client_hand_id TEXT PRIMARY KEY, db_id INTEGER NOT NULL, played_at INTEGER, status TEXT NOT NULL, through_ok INTEGER,
        diffs TEXT NOT NULL, through TEXT NOT NULL, tries INTEGER NOT NULL, next_at INTEGER, checked_at INTEGER, error TEXT);
      CREATE INDEX IF NOT EXISTS hh_checks_due ON hh_checks (status, next_at);
      CREATE TABLE IF NOT EXISTS hh_checks_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  }
  get(clientHandId: string): HhCheck | null {
    const r = this.db.query<Row, [string]>("SELECT * FROM hh_checks WHERE client_hand_id = ?").get(clientHandId);
    return r ? fromRow(r) : null;
  }
  save(c: HhCheck): void {
    this.db.query(`INSERT OR REPLACE INTO hh_checks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      c.clientHandId, c.dbId, c.playedAt, c.status, c.throughOk == null ? null : c.throughOk ? 1 : 0,
      JSON.stringify(c.diffs), JSON.stringify(c.through), c.tries, c.nextAt, c.checkedAt, c.error);
  }
  due(now: number, limit: number): HhCheck[] {
    return this.db.query<Row, [number, number]>("SELECT * FROM hh_checks WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?")
      .all(now, limit).map(fromRow);
  }
  meta(k: string): string | null {
    return this.db.query<{ v: string }, [string]>("SELECT v FROM hh_checks_meta WHERE k = ?").get(k)?.v ?? null;
  }
  setMeta(k: string, v: string): void {
    this.db.query("INSERT OR REPLACE INTO hh_checks_meta VALUES (?, ?)").run(k, v);
  }
}

// -------------------------------------------------------------------------------------------------- loop

export interface CheckerDeps {
  store: HhCheckStore;
  fetchRecord: (clientHandId: string) => Promise<RecordResult>;
  findArchived: (clientHandId: string) => Enriched | null;
  /** FINISHED hands after the cutoff row (routes/dashboard.doneIgnitionHandsAfter) */
  doneAfter: (rowid: number) => Enriched[];
  /** the same hands' client ids only, nothing enriched (routes/dashboard.doneIgnitionHandIdsAfter) — when given, the
   *  queue is built from these and only the hands with no check row yet are enriched */
  doneIdsAfter?: (rowid: number) => string[];
  lastRowid: () => number;
  now: () => number;
}

/** One attempt at a pending check: fetch, compare, move the state machine on. */
export async function attempt(prev: HhCheck, deps: Pick<CheckerDeps, "fetchRecord" | "findArchived" | "now">): Promise<HhCheck> {
  const archived = deps.findArchived(prev.clientHandId);
  if (!archived) return { ...prev, status: "unavailable", nextAt: null, error: "no longer in the archive" };
  const rec = await deps.fetchRecord(prev.clientHandId);
  if (!rec.ok) return nextCheck(prev, rec, deps.now());
  // villains' hole cards, when the history shows them, onto the hand's off-tree lines (services/offTreeLog)
  try { offTreeLog.fillShown(prev.clientHandId, parseIgnitionHh(rec.body).seats); } catch { /* a convenience, never the check */ }
  const { diffs, through } = compareRecord(rec.body, archived);
  return nextCheck({ ...prev, dbId: archived.dbId }, { kind: "compared", diffs, through }, deps.now());
}

/** Queue every finished hand after the cutoff that has no check yet, then work through what is due. */
export async function tick(deps: CheckerDeps, maxAttempts = 5): Promise<void> {
  const { store } = deps;
  const cutoff = Number(store.meta("cutoffRowid") ?? NaN);
  if (!Number.isFinite(cutoff)) {
    store.setMeta("cutoffRowid", String(deps.lastRowid())); // first start: from here on (never moved again)
    return;
  }
  // THE QUEUE WITHOUT ENRICHING THE CHECKED (2026-10-05): every tick enriched EVERY finished hand since the cutoff to
  // skip the ones already checked — synchronous work that grew with the archive (3,350 hands: 120 s a tick, every
  // 10 s) and froze the API until its supervisor killed each new worker as hung. Ids first; only an unchecked hand is
  // read in full.
  if (deps.doneIdsAfter) {
    for (const id of deps.doneIdsAfter(cutoff)) {
      if (store.get(id)) continue;
      const e = deps.findArchived(id);
      if (e) store.save(freshCheck(e, deps.now()));
    }
  } else {
    for (const e of deps.doneAfter(cutoff)) if (!store.get(e.clientHandId!)) store.save(freshCheck(e, deps.now()));
  }
  for (const c of store.due(deps.now(), maxAttempts)) store.save(await attempt(c, deps));
}

let store: HhCheckStore | null = null;
export const hhCheckStore = (): HhCheckStore => (store ??= new HhCheckStore(hhChecksDbPath()));

class HhChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  start(everyMs = 10_000): void {
    if (this.timer) return;
    const deps: CheckerDeps = {
      store: hhCheckStore(), fetchRecord: (id) => fetchIgnitionRecord(id), findArchived: archivedByClientHandId,
      doneAfter: doneIgnitionHandsAfter, doneIdsAfter: doneIgnitionHandIdsAfter, lastRowid: lastArchivedRowid, now: Date.now,
    };
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      asActivity("timer hhCheck", () => tick(deps)).catch((e) => console.error(`[hh-check] ${e?.message ?? e}`)).finally(() => { this.busy = false; });
    }, everyMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
export const hhChecker = new HhChecker();
