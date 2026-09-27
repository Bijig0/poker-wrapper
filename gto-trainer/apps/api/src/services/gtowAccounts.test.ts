import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAccounts, loadAccounts, removeAccount, slugOf, upsertAccount } from "./gtowAccounts";
import { GtowRequestLog } from "./gtowRequestLog";
import { ensureEventTables } from "../../../../packages/data-root/eventTables";

/**
 * The account registry (2026-09-27) and the ledger's account meters. The registry file is pointed at a temp dir by
 * GTOW_ACCOUNTS_PATH; under test loadAccounts() serves the seeded defaults without writing.
 */
let dir: string;
const prevPath = process.env.GTOW_ACCOUNTS_PATH;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gtow-acct-")); process.env.GTOW_ACCOUNTS_PATH = join(dir, "gtow-accounts.json"); });
afterEach(() => {
  if (prevPath === undefined) delete process.env.GTOW_ACCOUNTS_PATH; else process.env.GTOW_ACCOUNTS_PATH = prevPath;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL handle */ }
});

describe("registry", () => {
  test("seeds Brady's two accounts by name, keeping the pool's old slot ids, and does not write under test", () => {
    const f = loadAccounts();
    expect(f.accounts.map((a) => [a.id, a.name, a.tier, a.multiway])).toEqual([["secondary", "Elite 1", "elite", false], ["primary", "Ultra", "ultra", true]]);
    expect(existsSync(process.env.GTOW_ACCOUNTS_PATH!)).toBe(false);
    expect(defaultAccounts({ GTOW_PREFER: "primary" } as any).find((a) => a.id === "primary")!.order).toBe(1);
  });

  test("upsert edits a row by id, adds a new one by name (slug id), and remove forgets it", () => {
    const edited = upsertAccount({ id: "secondary", name: "Elite 1", priceMonthly: 169, notes: "renews 2 Oct" });
    expect(edited).toMatchObject({ id: "secondary", name: "Elite 1", priceMonthly: 169, notes: "renews 2 Oct", enabled: true, multiway: false });
    const added = upsertAccount({ name: "Elite 2", tier: "elite", cdpHost: "127.0.0.1:9224", launchHint: "" });
    expect(added.id).toBe("elite-2");
    expect(slugOf("Elite 2")).toBe("elite-2");
    const onDisk = JSON.parse(readFileSync(process.env.GTOW_ACCOUNTS_PATH!, "utf8"));
    expect(onDisk.accounts.map((a: any) => a.id)).toEqual(["secondary", "primary", "elite-2"]);
    expect(loadAccounts().accounts.find((a) => a.id === "elite-2")).toMatchObject({ name: "Elite 2", tier: "elite", multiway: false, order: 9, enabled: true });
    expect(removeAccount("elite-2")).toBe(true);
    expect(removeAccount("elite-2")).toBe(false);
    expect(loadAccounts().accounts.map((a) => a.id)).toEqual(["secondary", "primary"]);
  });

  test("a partial edit keeps every field it did not name", () => {
    upsertAccount({ id: "primary", enabled: false });
    const p = loadAccounts().accounts.find((a) => a.id === "primary")!;
    expect(p).toMatchObject({ name: "Ultra", tier: "ultra", multiway: true, enabled: false, cdpHost: "127.0.0.1:9222" });
  });
});

describe("ledger meters", () => {
  const seed = (log: GtowRequestLog, rows: { ts: number; s: string; st: number; o?: string }[]) => {
    const db = new Database(log.path);
    ensureEventTables(db);
    const ins = db.prepare("INSERT INTO gtow_requests (ts, s, k, st, o) VALUES (?,?,?,?,?)");
    db.transaction(() => { for (const r of rows) ins.run(r.ts, r.s, "poll", r.st, r.o ?? "api"); })();
    db.close();
  };

  test("windows: requests, since-when, refusals and origins per account for the last hour and day", () => {
    const log = new GtowRequestLog(join(dir, "poker.sqlite"));
    const now = 10_000_000_000;
    const H = 3_600_000;
    seed(log, [
      { ts: now - 30 * H, s: "primary", st: 200 },                   // outside both windows
      { ts: now - 5 * H, s: "primary", st: 200 },                    // day only
      { ts: now - 40 * 60_000, s: "primary", st: 200 },              // hour + day
      { ts: now - 10 * 60_000, s: "primary", st: 429, o: "probe" },
      { ts: now - 2 * H, s: "secondary", st: 200 },
    ]);
    const w = log.windows(now);
    expect(w.primary!.h1).toMatchObject({ n: 2, x429: 1, ok: 1, sinceMs: now - 40 * 60_000, byOrigin: { api: 1, probe: 1 } });
    expect(w.primary!.h24).toMatchObject({ n: 3, x429: 1, ok: 2, sinceMs: now - 5 * H });
    expect(w.secondary!.h1).toBeUndefined();
    expect(w.secondary!.h24).toMatchObject({ n: 1, x429: 0 });
    log.close();
  });

  test("wallState: walled while the last 429 is newer than the last success, since the first 429 of that run; cleared once a 2xx follows", () => {
    const log = new GtowRequestLog(join(dir, "poker.sqlite"));
    const now = 10_000_000_000;
    const M = 60_000;
    seed(log, [
      { ts: now - 90 * M, s: "primary", st: 429 },   // an older wall …
      { ts: now - 80 * M, s: "primary", st: 200 },   // … that cleared
      { ts: now - 50 * M, s: "primary", st: 200 },
      { ts: now - 30 * M, s: "primary", st: 429 },   // the current wall starts here
      { ts: now - 10 * M, s: "primary", st: 429 },
    ]);
    const w = log.wallState("primary", now, 24 * 3_600_000);
    expect(w).toMatchObject({ walled: true, sinceMs: now - 30 * M, expectedLiftMs: now - 30 * M + 24 * 3_600_000, last429Ms: now - 10 * M, lastOkMs: now - 50 * M, clearedAtMs: null, leaks: 0 });
    // ONE success inside the wall is a leak (Elite, 2026-09-27 09:40 local), not a lift: still walled, since unchanged
    seed(log, [{ ts: now - 8 * M, s: "primary", st: 200 }, { ts: now - 7 * M, s: "primary", st: 429 }]);
    expect(log.wallState("primary", now, 24 * 3_600_000)).toMatchObject({ walled: true, sinceMs: now - 30 * M, leaks: 1, last429Ms: now - 7 * M });
    // the newest request a lone success: reported walled with the leak, so the page says "probe again"
    seed(log, [{ ts: now - 6 * M, s: "primary", st: 200 }]);
    expect(log.wallState("primary", now, 24 * 3_600_000)).toMatchObject({ walled: true, sinceMs: now - 30 * M, leaks: 2 });
    // two successes in a row end it — cleared at the first of them
    seed(log, [{ ts: now - 5 * M, s: "primary", st: 200 }]);
    const c = log.wallState("primary", now, 24 * 3_600_000);
    expect(c).toMatchObject({ walled: false, sinceMs: null, clearedAtMs: now - 6 * M, last429Ms: now - 7 * M });
    expect(log.wallState("secondary", now)).toMatchObject({ walled: false, sinceMs: null, last429Ms: null });
    log.close();
  });
});
