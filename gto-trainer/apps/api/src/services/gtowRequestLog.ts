/**
 * GTO WIZARD REQUEST LEDGER (2026-09-23).
 *
 * GTO Wizard's daily cap is on REQUESTS — the 429 body says it exactly:
 * `{"request_limit": 1275, "time_period_in_seconds": 86400}` — and one cloud solve is many requests: a tree
 * create, a solution create, then a poll every 400 ms until the strategy lands (a 12 s solve is ~30 polls).
 * Nothing counted them. So nothing could pace a backtest, and nothing could say how close a live session sat
 * to the wall until the wall answered.
 *
 * Every HTTP request any process sends to api.gtowizard.com — the live API worker, a backtest script, a probe —
 * appends ONE line here, and `stats()` answers "how many in the last 24 h / since 00:00 UTC, per account, per
 * kind". Append-only JSONL so several processes can write at once (a backtest beside the live worker is the
 * normal case); ~90 bytes a line, ~1,300 lines a day at the cap. The file is compacted to the last 48 h when it
 * passes COMPACT_LINES so it never grows without bound.
 *
 * Whether GTO Wizard counts POLLS or distinct solves is settled by reading this ledger against the next 429,
 * not by guessing: the count at the moment of the 429 is their unit.
 */
import { timed } from "./answerTrace";
import { countRequest, currentRequestScope } from "./requestScope";
import { gtowRequestsPath } from "./storePaths";
import type { Database } from "bun:sqlite";
import { openStore } from "./storePaths";
import { ensureEventTables } from "../../../../packages/data-root/eventTables";

export type GtowRequestKind = "tree" | "solution" | "poll" | "library" | "other";

export interface GtowRequestRow {
  /** epoch ms */
  ts: number;
  /** which account minted the token (primary = Ultra, secondary = Elite, unknown when no owner is known) */
  s: string;
  k: GtowRequestKind;
  /** HTTP status; 0 = the fetch threw (timeout / connection) */
  st: number;
  /** who sent it: "api" for the worker, else the script name (GTOW_REQUEST_ORIGIN or process.argv[1]) */
  o: string;
  /** THE HAND IT WAS FOR (2026-09-25, services/requestScope): the hand key, the street and the call's origin
   *  ("live" / "warm" / "replay"), when the request was made inside a fastSolve call. Absent for scripts and probes. */
  h?: string;
  sr?: string;
  go?: string;
  /** the request target, path + query (2026-09-26) — a poll's solution id and node */
  q?: string;
  /** the response's rate-limit / retry / cache headers, JSON, when it carried any */
  hd?: string;
}

/** A stored response: every 402/403/429 whole, plus hourly header samples of normal replies. */
export interface GtowResponseRow {
  ts: number;
  s: string;
  k: GtowRequestKind;
  st: number;
  o: string;
  why: "limit" | "sample";
  url: string | null;
  headers: Record<string, string>;
  body: string | null;
}

/** Headers worth keeping on EVERY ledger row: anything that could carry a count, a reset time, or say the reply
 *  came from a cache (a cached reply may be why some requests are not counted). */
const LIMIT_HEADER = /rate|limit|quota|usage|remain|retry|reset|throttl|cache|^age$/i;
/** statuses kept whole — the ones a plan or a throttle answers with */
const LIMIT_STATUS = new Set([402, 403, 429]);
const SAMPLE_EVERY_MS = 3_600_000;
const BODY_CAP = 16_000;

export function requestTarget(url: string): string {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

export function limitHeaders(h: Headers): string | null {
  const keep: Record<string, string> = {};
  h.forEach((v, k) => { if (LIMIT_HEADER.test(k)) keep[k] = v; });
  return Object.keys(keep).length ? JSON.stringify(keep) : null;
}

export interface GtowRequestStats {
  file: string;
  lastAt: number | null;
  last24h: { total: number; bySession: Record<string, number>; byKind: Record<string, number>; byOrigin: Record<string, number>; status429: number };
  sinceUtcMidnight: { total: number; bySession: Record<string, number>; status429: number };
  lastHour: { total: number };
  /** the cap GTO Wizard's own 429 body states for the Ultra plan */
  cap: number;
}

/** rows kept: a month of requests (~1,300 a day at the cap) — the per-hand columns feed the session Technical tab */
const KEEP_MS = 30 * 86_400_000;
const CAP = 1275;
const LOG_EVERY = 100;

class GtowRequestLog {
  readonly path: string;
  private origin: string;
  private written = 0;
  private db: Database | null = null;

  constructor(path?: string) {
    this.path = path ?? gtowRequestsPath();
    const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
    this.origin = process.env.GTOW_REQUEST_ORIGIN
      ?? (/(^|\/)index\.ts$/.test(argv1) ? "api" : argv1.split("/").pop()?.replace(/\.ts$/, "") || "unknown");
  }

  /** The gtow_requests table (the central poker.sqlite; a test passes its own file). Every process appends to the
   *  same table — a backtest beside the live worker is the normal case, and SQLite serializes the writers. */
  private open(): Database {
    if (this.db) return this.db;
    const db = openStore(this.path);
    ensureEventTables(db);
    this.db = db;
    return db;
  }

  /** Release the database (tests; a process that is done with the ledger). */
  close(): void {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }

  /** Record one request. Never throws — the ledger must not be able to fail a solve. */
  note(row: { session?: string | null; kind: GtowRequestKind; status: number; q?: string | null; hd?: string | null }): void {
    try {
      const scope = currentRequestScope();
      countRequest(row.kind, row.status);
      const rec: GtowRequestRow = { ts: Date.now(), s: row.session ?? "unknown", k: row.kind, st: row.status, o: this.origin,
        ...(scope ? { h: scope.handKey, ...(scope.street ? { sr: scope.street } : {}), go: scope.origin } : {}) };
      this.open().query("INSERT INTO gtow_requests (ts, s, k, st, o, h, sr, go, q, hd) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(rec.ts, rec.s, rec.k, rec.st, rec.o, rec.h ?? null, rec.sr ?? null, rec.go ?? null, row.q ?? null, row.hd ?? null);
      if (++this.written % LOG_EVERY === 0) {
        const s = this.stats();
        console.log(`[gtow-requests] ${s.last24h.total} in the last 24 h (${Object.entries(s.last24h.bySession).map(([k, v]) => `${k} ${v}`).join(", ")}; ${s.last24h.status429} x 429) · cap ${CAP}`);
      }
      if (this.written % 500 === 0) this.compact();
    } catch {
      /* the ledger is an observer; a write failure must never fail a solve */
    }
  }

  /**
   * THE GATE (2026-09-23). Two environment switches let a SCRIPT be held to a budget without the script having
   * to predict which spots will reach the cloud (the fallback pieces make that unknowable up front — the first
   * hardening backtest spent 119 requests under a "cloud off" heuristic):
   *   GTOW_BLOCK=1          no request leaves this process at all — every call gets a synthetic 503
   *   GTOW_RESERVE=<n>      requests are refused (503) once the account's trailing-24 h headroom is below n
   * Neither is set for the live API worker, which must never refuse its own table; a script sets them.
   * A refused request is NOT written to the ledger — nothing reached GTO Wizard.
   */
  gate(session: string | null | undefined): Response | null {
    if (process.env.GTOW_BLOCK === "1") {
      return new Response(JSON.stringify({ blocked: "GTOW_BLOCK=1: this process may not call GTO Wizard" }),
        { status: 503, statusText: "blocked by GTOW_BLOCK", headers: { "content-type": "application/json" } });
    }
    const reserve = Number(process.env.GTOW_RESERVE ?? 0);
    if (reserve > 0) {
      const acct = session ?? "primary";
      const left = this.headroom(acct);
      if (left < reserve) {
        return new Response(JSON.stringify({ blocked: `GTOW_RESERVE: ${acct} has ${left} requests of headroom, reserve is ${reserve}` }),
          { status: 503, statusText: "blocked by GTOW_RESERVE", headers: { "content-type": "application/json" } });
      }
    }
    return null;
  }

  /**
   * fetch() with the ledger attached. Counts the request whatever happens to it: a timeout or a connection
   * error is a request GTO Wizard may well have received, so it is counted as status 0 rather than dropped.
   */
  async fetch(session: string | null | undefined, kind: GtowRequestKind, url: string, init?: RequestInit): Promise<Response> {
    const blocked = this.gate(session);
    if (blocked) return blocked;
    try {
      const r = await timed(`GTO Wizard ${kind} (${session ?? "?"})`, () => fetch(url, init), (x) => `HTTP ${x.status}`);
      this.note({ session, kind, status: r.status, q: requestTarget(url), hd: limitHeaders(r.headers) });
      await this.keepResponse(session, kind, url, r);
      return r;
    } catch (e) {
      this.note({ session, kind, status: 0, q: requestTarget(url) });
      throw e;
    }
  }

  private sampledAt = new Map<string, number>();

  /**
   * Keep a response whole when it is a plan/throttle answer (402/403/429: every header + the full body — the logs
   * cut the 429 body off mid-sentence), and one header sample per account × kind × status per hour otherwise.
   * The body is read from a clone, so the caller still reads its own. Never throws.
   */
  async keepResponse(session: string | null | undefined, kind: GtowRequestKind, url: string, r: Response): Promise<void> {
    try {
      const limit = LIMIT_STATUS.has(r.status);
      const key = `${session ?? "unknown"}|${kind}|${r.status}`;
      const now = Date.now();
      if (!limit && now - (this.sampledAt.get(key) ?? 0) < SAMPLE_EVERY_MS) return;
      this.sampledAt.set(key, now);
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      const body = limit ? (await r.clone().text().catch(() => "")).slice(0, BODY_CAP) : null;
      this.open().query("INSERT INTO gtow_responses (ts, s, k, st, o, why, url, headers, body) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(now, session ?? "unknown", kind, r.status, this.origin, limit ? "limit" : "sample", requestTarget(url), JSON.stringify(headers), body);
      if (r.status === 429) console.log(`[gtow-requests] 429 on ${session ?? "?"} ${kind} — kept whole in gtow_responses: ${(body ?? "").slice(0, 400)} | headers ${JSON.stringify(headers)}`);
    } catch {
      /* the ledger is an observer */
    }
  }

  /** Stored responses since `sinceMs`, oldest first (`why` narrows to limit answers or samples). */
  responses(sinceMs = 0, why?: "limit" | "sample"): GtowResponseRow[] {
    try {
      return this.open()
        .query<Omit<GtowResponseRow, "headers"> & { headers: string }, [number, string, string]>(
          "SELECT ts, s, k, st, o, why, url, headers, body FROM gtow_responses WHERE ts >= ? AND (? = '' OR why = ?) ORDER BY id")
        .all(sinceMs, why ?? "", why ?? "")
        .map((x) => ({ ...x, headers: JSON.parse(x.headers) as Record<string, string> }));
    } catch {
      return [];
    }
  }

  /** Requests since `sinceMs` (default: all kept), oldest first. */
  rows(sinceMs = 0): GtowRequestRow[] {
    try {
      return this.open()
        .query<GtowRequestRow & { h: string | null; sr: string | null; go: string | null }, [number]>(
          "SELECT ts, s, k, st, o, h, sr, go FROM gtow_requests WHERE ts >= ? ORDER BY id")
        .all(sinceMs)
        .map((r) => {
          const { h, sr, go, ...rest } = r;
          return { ...rest, ...(h != null ? { h } : {}), ...(sr != null ? { sr } : {}), ...(go != null ? { go } : {}) } as GtowRequestRow;
        });
    } catch {
      return [];
    }
  }

  stats(now = Date.now()): GtowRequestStats {
    const dayAgo = now - 86_400_000;
    const hourAgo = now - 3_600_000;
    const midnight = new Date(now); midnight.setUTCHours(0, 0, 0, 0);
    const since = midnight.getTime();
    try {
      const db = this.open();
      const by = (col: "s" | "k" | "o", from: number): Record<string, number> => Object.fromEntries(
        db.query<{ v: string; n: number }, [number, number]>(`SELECT ${col} v, COUNT(*) n FROM gtow_requests WHERE ts >= ? AND ts <= ? GROUP BY ${col}`)
          .all(from, now).map((r) => [r.v, r.n]));
      const tally = (from: number) => {
        const t = db.query<{ n: number; x: number }, [number, number]>(
          "SELECT COUNT(*) n, COALESCE(SUM(st = 429), 0) x FROM gtow_requests WHERE ts >= ? AND ts <= ?").get(from, now)!;
        return { total: t.n, bySession: by("s", from), byKind: by("k", from), byOrigin: by("o", from), status429: t.x };
      };
      const d = tally(dayAgo);
      const m = tally(since);
      const last = db.query<{ ts: number | null }, []>("SELECT MAX(ts) ts FROM gtow_requests").get()?.ts ?? null;
      const hour = db.query<{ n: number }, [number, number]>("SELECT COUNT(*) n FROM gtow_requests WHERE ts >= ? AND ts <= ?").get(hourAgo, now)!.n;
      return { file: this.path, lastAt: last, last24h: d, sinceUtcMidnight: { total: m.total, bySession: m.bySession, status429: m.status429 },
        lastHour: { total: hour }, cap: CAP };
    } catch {
      return { file: this.path, lastAt: null, last24h: { total: 0, bySession: {}, byKind: {}, byOrigin: {}, status429: 0 },
        sinceUtcMidnight: { total: 0, bySession: {}, status429: 0 }, lastHour: { total: 0 }, cap: CAP };
    }
  }

  /** How many requests one account may still send before the stated cap, over the trailing 24 h. */
  headroom(session: string, now = Date.now()): number {
    try {
      const n = this.open().query<{ n: number }, [string, number, number]>(
        "SELECT COUNT(*) n FROM gtow_requests WHERE s = ? AND ts >= ? AND ts <= ?").get(session, now - 86_400_000, now)!.n;
      return Math.max(0, CAP - n);
    } catch {
      return CAP;
    }
  }

  /** Keep the table bounded: drop rows older than KEEP_MS. */
  compact(now = Date.now()): void {
    try {
      this.open().query("DELETE FROM gtow_requests WHERE ts < ?").run(now - KEEP_MS);
      this.open().query("DELETE FROM gtow_responses WHERE ts < ?").run(now - KEEP_MS);
    } catch {
      /* best effort */
    }
  }
}

export const gtowRequests = new GtowRequestLog();
export { GtowRequestLog };
