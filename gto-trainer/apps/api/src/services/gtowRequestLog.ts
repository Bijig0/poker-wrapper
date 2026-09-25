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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const COMPACT_LINES = 60_000;
const CAP = 1275;
const LOG_EVERY = 100;

class GtowRequestLog {
  readonly path: string;
  private origin: string;
  private written = 0;
  private cache: { mtimeMs: number; size: number; rows: GtowRequestRow[] } | null = null;

  constructor(path?: string) {
    this.path = path ?? join(import.meta.dir, "..", "..", "data", "gtow_requests.jsonl");
    const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
    this.origin = process.env.GTOW_REQUEST_ORIGIN
      ?? (/(^|\/)index\.ts$/.test(argv1) ? "api" : argv1.split("/").pop()?.replace(/\.ts$/, "") || "unknown");
  }

  /** Record one request. Never throws — the ledger must not be able to fail a solve. */
  note(row: { session?: string | null; kind: GtowRequestKind; status: number }): void {
    try {
      const scope = currentRequestScope();
      countRequest(row.kind, row.status);
      const rec: GtowRequestRow = { ts: Date.now(), s: row.session ?? "unknown", k: row.kind, st: row.status, o: this.origin,
        ...(scope ? { h: scope.handKey, ...(scope.street ? { sr: scope.street } : {}), go: scope.origin } : {}) };
      mkdirSync(join(this.path, ".."), { recursive: true });
      appendFileSync(this.path, JSON.stringify(rec) + "\n");
      this.cache = null;
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
      this.note({ session, kind, status: r.status });
      return r;
    } catch (e) {
      this.note({ session, kind, status: 0 });
      throw e;
    }
  }

  rows(): GtowRequestRow[] {
    try {
      if (!existsSync(this.path)) return [];
      const st = statSync(this.path);
      if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.rows;
      const rows: GtowRequestRow[] = [];
      for (const l of readFileSync(this.path, "utf8").split("\n")) {
        if (!l) continue;
        try { rows.push(JSON.parse(l)); } catch { /* a torn line from a concurrent writer */ }
      }
      this.cache = { mtimeMs: st.mtimeMs, size: st.size, rows };
      return rows;
    } catch {
      return [];
    }
  }

  stats(now = Date.now()): GtowRequestStats {
    const rows = this.rows();
    const dayAgo = now - 86_400_000;
    const hourAgo = now - 3_600_000;
    const midnight = new Date(now); midnight.setUTCHours(0, 0, 0, 0);
    const since = midnight.getTime();
    const tally = (rs: GtowRequestRow[]) => {
      const bySession: Record<string, number> = {}, byKind: Record<string, number> = {}, byOrigin: Record<string, number> = {};
      let status429 = 0;
      for (const r of rs) {
        bySession[r.s] = (bySession[r.s] ?? 0) + 1;
        byKind[r.k] = (byKind[r.k] ?? 0) + 1;
        byOrigin[r.o] = (byOrigin[r.o] ?? 0) + 1;
        if (r.st === 429) status429++;
      }
      return { total: rs.length, bySession, byKind, byOrigin, status429 };
    };
    const d = tally(rows.filter((r) => r.ts >= dayAgo));
    const m = tally(rows.filter((r) => r.ts >= since));
    return {
      file: this.path,
      lastAt: rows.length ? rows[rows.length - 1]!.ts : null,
      last24h: d,
      sinceUtcMidnight: { total: m.total, bySession: m.bySession, status429: m.status429 },
      lastHour: { total: rows.filter((r) => r.ts >= hourAgo).length },
      cap: CAP,
    };
  }

  /** How many requests one account may still send before the stated cap, over the trailing 24 h. */
  headroom(session: string, now = Date.now()): number {
    const s = this.stats(now);
    return Math.max(0, CAP - (s.last24h.bySession[session] ?? 0));
  }

  /** Keep the file bounded: rewrite it with the last 48 h once it passes COMPACT_LINES lines. */
  compact(now = Date.now()): void {
    try {
      const rows = this.rows();
      if (rows.length < COMPACT_LINES) return;
      const keep = rows.filter((r) => r.ts >= now - 2 * 86_400_000);
      const tmp = this.path + ".tmp";
      writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
      renameSync(tmp, this.path);
      this.cache = null;
    } catch {
      /* best effort */
    }
  }
}

export const gtowRequests = new GtowRequestLog();
export { GtowRequestLog };
