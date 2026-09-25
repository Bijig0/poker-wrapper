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
});
