import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GtowRequestLog } from "./gtowRequestLog";
import { ensureEventTables } from "../../../../packages/data-root/eventTables";

// The ledger is the gtow_requests table of the central poker.sqlite since 2026-09-25 (it was a JSONL file);
// each test gets its own database file.
const dirs: string[] = [];
const logs: GtowRequestLog[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "gtow-req-"));
  dirs.push(d);
  const log = new GtowRequestLog(join(d, "poker.sqlite"));
  logs.push(log);
  return log;
};
afterEach(() => {
  for (const l of logs.splice(0)) l.close();              // Windows will not delete a folder with an open database in it
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* WAL handle still settling */ }
});

/** rows written straight into the table, so the timestamps can be controlled */
function seed(log: GtowRequestLog, rows: { ts: number; s: string; k: string; st: number; o: string }[]): void {
  const db = new Database(log.path);
  ensureEventTables(db);
  const ins = db.prepare("INSERT INTO gtow_requests (ts, s, k, st, o) VALUES (?,?,?,?,?)");
  db.transaction(() => { for (const r of rows) ins.run(r.ts, r.s, r.k, r.st, r.o); })();
  db.close();
}

const count = (log: GtowRequestLog) => {
  let db: Database;
  try { db = new Database(log.path, { readonly: true }); } catch { return 0; }   // never created: nothing was written
  try { return (db.query("SELECT COUNT(*) n FROM gtow_requests").get() as { n: number }).n; } catch { return 0; } finally { db.close(); }
};

describe("gtowRequestLog", () => {
  test("every note is one row, and stats count it per account and kind", () => {
    const log = fresh();
    log.note({ session: "primary", kind: "tree", status: 201 });
    log.note({ session: "primary", kind: "poll", status: 200 });
    log.note({ session: "primary", kind: "poll", status: 429 });
    log.note({ session: "secondary", kind: "solution", status: 201 });
    log.note({ session: null, kind: "poll", status: 0 });
    expect(count(log)).toBe(5);
    const s = log.stats();
    expect(s.last24h.total).toBe(5);
    expect(s.last24h.bySession).toEqual({ primary: 3, secondary: 1, unknown: 1 });
    expect(s.last24h.byKind).toEqual({ tree: 1, poll: 3, solution: 1 });
    expect(s.last24h.status429).toBe(1);
    expect(s.cap).toBe(1275);
    expect(log.headroom("primary")).toBe(1275 - 3);
    expect(log.headroom("secondary")).toBe(1275 - 1);
  });

  test("the trailing-24h window drops old rows; since-midnight is a separate count", () => {
    const log = fresh();
    const now = Date.UTC(2026, 8, 23, 12, 0, 0);          // 12:00 UTC
    seed(log, [
      { ts: now - 30 * 3_600_000, s: "primary", k: "poll", st: 200, o: "t" },   // 30 h ago: outside both
      { ts: now - 20 * 3_600_000, s: "primary", k: "poll", st: 200, o: "t" },   // 20 h ago: in 24h, before midnight
      { ts: now - 2 * 3_600_000, s: "primary", k: "poll", st: 200, o: "t" },    // 2 h ago: in both
    ]);
    const s = log.stats(now);
    expect(s.last24h.total).toBe(2);
    expect(s.sinceUtcMidnight.total).toBe(1);
    expect(s.lastHour.total).toBe(0);
    expect(log.headroom("primary", now)).toBe(1275 - 2);
  });

  test("two ledgers on one database (the live worker and a backtest) count each other's requests", () => {
    const a = fresh();
    const b = new GtowRequestLog(a.path);
    logs.push(b);
    a.note({ session: "primary", kind: "poll", status: 200 });
    b.note({ session: "primary", kind: "poll", status: 200 });
    expect(a.stats().last24h.total).toBe(2);
    expect(b.headroom("primary")).toBe(1275 - 2);
  });

  test("fetch wrapper counts a thrown request as status 0 and rethrows", async () => {
    const log = fresh();
    const orig = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => { throw new Error("boom"); };
    try {
      await expect(log.fetch("primary", "poll", "https://api.gtowizard.com/x")).rejects.toThrow("boom");
    } finally {
      globalThis.fetch = orig;
    }
    const s = log.stats();
    expect(s.last24h.total).toBe(1);
    expect(log.rows()[0]).toMatchObject({ s: "primary", k: "poll", st: 0 });
  });

  test("GTOW_BLOCK=1 refuses every request with a 503 and writes nothing", async () => {
    const log = fresh();
    const prev = process.env.GTOW_BLOCK;
    process.env.GTOW_BLOCK = "1";
    try {
      const r = await log.fetch("primary", "tree", "https://api.gtowizard.com/x");
      expect(r.status).toBe(503);
      expect(await r.text()).toContain("GTOW_BLOCK");
    } finally {
      if (prev === undefined) delete process.env.GTOW_BLOCK; else process.env.GTOW_BLOCK = prev;
    }
    expect(count(log)).toBe(0);
  });

  test("GTOW_RESERVE refuses once the account's headroom is below the reserve", async () => {
    const log = fresh();
    const prev = process.env.GTOW_RESERVE;
    process.env.GTOW_RESERVE = String(1275 - 1);          // headroom 1275, 1274 pass; 1273 is below the reserve
    const orig = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      expect((await log.fetch("primary", "poll", "https://api.gtowizard.com/1")).status).toBe(200);
      expect((await log.fetch("primary", "poll", "https://api.gtowizard.com/2")).status).toBe(200);
      const r = await log.fetch("primary", "poll", "https://api.gtowizard.com/3");
      expect(r.status).toBe(503);
      expect(await r.text()).toContain("GTOW_RESERVE");
      // another account is not affected by the primary's headroom
      expect((await log.fetch("secondary", "poll", "https://api.gtowizard.com/4")).status).toBe(200);
    } finally {
      globalThis.fetch = orig;
      if (prev === undefined) delete process.env.GTOW_RESERVE; else process.env.GTOW_RESERVE = prev;
    }
    expect(log.stats().last24h.total).toBe(3);           // the refused one was never a request
  });

  test("compact drops rows older than a month", () => {
    const log = fresh();
    const now = Date.UTC(2026, 8, 23, 12, 0, 0);
    seed(log, [
      { ts: now - 40 * 86_400_000, s: "primary", k: "poll", st: 200, o: "t" },
      { ts: now - 3_600_000, s: "primary", k: "poll", st: 200, o: "t" },
    ]);
    log.compact(now);
    expect(count(log)).toBe(1);
  });
  test("a 429 is kept whole (every header, the full body) and the caller still reads the body", async () => {
    const log = fresh();
    const body = JSON.stringify({ detail: "Request limit exceeded", request_limit: 1275, time_period_in_seconds: 86400,
      simplified_time_period: "x".repeat(300), code: "SOMETHING_AFTER_THE_OLD_CUT" });
    const orig = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => new Response(body, { status: 429, headers: { "retry-after": "321", "x-request-id": "abc", "cf-cache-status": "DYNAMIC" } });
    try {
      const r = await log.fetch("primary", "poll", "https://api.gtowizard.com/v4/solutions/spot-solution/?custom_solution_id=s1&preflop_actions=R2.5");
      expect(await r.text()).toBe(body);
    } finally {
      globalThis.fetch = orig;
    }
    const kept = log.responses(0, "limit");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ s: "primary", k: "poll", st: 429, why: "limit", body,
      url: "/v4/solutions/spot-solution/?custom_solution_id=s1&preflop_actions=R2.5" });
    expect(kept[0].headers).toMatchObject({ "retry-after": "321", "x-request-id": "abc" });
    const db = new Database(log.path, { readonly: true });
    try {
      const row = db.query("SELECT q, hd FROM gtow_requests").get() as { q: string; hd: string };
      expect(row.q).toBe("/v4/solutions/spot-solution/?custom_solution_id=s1&preflop_actions=R2.5");
      expect(JSON.parse(row.hd)).toEqual({ "retry-after": "321", "cf-cache-status": "DYNAMIC" });   // the request id is not a limit header
    } finally { db.close(); }
  });

  test("a poll's purpose and caller ride the row (pm / cl), and are absent when the caller gave none", async () => {
    const log = fresh();
    const orig = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => new Response(null, { status: 204 });
    try {
      await log.fetch("secondary", "poll", "https://api.gtowizard.com/v4/solutions/spot-solution/?custom_solution_id=s1", undefined, { pm: "probe", cl: "prefetch" });
      await log.fetch("secondary", "poll", "https://api.gtowizard.com/v4/solutions/spot-solution/?custom_solution_id=s1");
    } finally {
      globalThis.fetch = orig;
    }
    const rows = log.rows();
    expect(rows[0]).toMatchObject({ st: 204, pm: "probe", cl: "prefetch" });
    expect(rows[1]).not.toHaveProperty("pm");
    expect(rows[1]).not.toHaveProperty("cl");
  });

  test("normal replies: one header sample per account x kind x status per hour, no body; hd null without limit headers", async () => {
    const log = fresh();
    const orig = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => new Response("{}", { status: 200, headers: { server: "x" } });
    try {
      for (let i = 0; i < 3; i++) await log.fetch("primary", "poll", `https://api.gtowizard.com/${i}`);
      await log.fetch("secondary", "poll", "https://api.gtowizard.com/9");
    } finally {
      globalThis.fetch = orig;
    }
    const s = log.responses(0, "sample");
    expect(s.map((x) => x.s)).toEqual(["primary", "secondary"]);
    expect(s[0].body).toBeNull();
    expect(log.responses(0, "limit")).toHaveLength(0);
    const db = new Database(log.path, { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) n FROM gtow_requests WHERE hd IS NULL").get()).toEqual({ n: 4 });
    } finally { db.close(); }
  });

  test("a ledger created before the q/hd columns is migrated in place and keeps its rows", () => {
    const d = mkdtempSync(join(tmpdir(), "gtow-req-"));
    dirs.push(d);
    const path = join(d, "poker.sqlite");
    const old = new Database(path);
    old.run(`CREATE TABLE gtow_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, s TEXT NOT NULL, k TEXT NOT NULL,
      st INTEGER NOT NULL, o TEXT NOT NULL, h TEXT, sr TEXT, go TEXT)`);
    old.run("INSERT INTO gtow_requests (ts, s, k, st, o) VALUES (1, 'primary', 'poll', 200, 'api')");
    old.close();
    const log = new GtowRequestLog(path);
    logs.push(log);
    log.note({ session: "primary", kind: "poll", status: 200, q: "/v4/x?y=1" });
    expect(count(log)).toBe(2);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("SELECT q FROM gtow_requests ORDER BY id").all()).toEqual([{ q: null }, { q: "/v4/x?y=1" }]);
    } finally { db.close(); }
    const again = new Database(path);
    try { ensureEventTables(again); } finally { again.close(); }   // running the migration again is a no-op
  });
});
