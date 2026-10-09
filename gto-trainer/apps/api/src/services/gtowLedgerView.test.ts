import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { testTempDir } from "../test/tempDir";
import { GtowRequestLog } from "./gtowRequestLog";
import { GtowLedgerView } from "./gtowLedgerView";
import { ensureEventTables } from "../../../../packages/data-root/eventTables";

// THE ACCOUNTS PAGE'S LEDGER IN MEMORY (2026-10-09, catalogue-incremental): the meters and walls it answers are the SQL's,
// and a refresh's reads cost the loop well under the 20 ms asked for.
const logs: GtowRequestLog[] = [];
const dir = testTempDir("gtow-ledger-view-", { release: () => logs.forEach((l) => l.close()) });
let k = 0;
const HOUR = 3_600_000, DAY = 86_400_000;

type Row = { ts: number; s: string; k: string; st: number; o: string };
function setup(rows: Row[], mode: "loop" | "worker" = "loop", now = Date.now()) {
  const log = new GtowRequestLog(join(dir, `l${++k}.sqlite`));
  logs.push(log);
  const db = new Database(log.path);
  ensureEventTables(db);
  const ins = db.prepare("INSERT INTO gtow_requests (ts, s, k, st, o) VALUES (?,?,?,?,?)");
  db.transaction(() => { for (const r of rows) ins.run(r.ts, r.s, r.k, r.st, r.o); })();
  db.close();
  const view = new GtowLedgerView();
  let t = now;
  view.setClock(() => t);
  view.seedMode = mode;
  view.setSource({ path: log.path, db: () => log.handle() });
  return { log, view, setNow: (x: number) => { t = x; }, now: () => t };
}

/** a mix: a walled account with a lone leak, one whose wall lifted, a clean one, several origins, rows older than 3 days */
function mix(now: number): Row[] {
  const rows: Row[] = [];
  const r = (ts: number, s: string, st: number, o = "api") => rows.push({ ts, s, k: "poll", st, o });
  for (let i = 0; i < 300; i++) r(now - 4 * DAY + i * 60_000, "primary", 200);              // too old for the wall scan
  for (let i = 0; i < 200; i++) r(now - 30 * HOUR + i * 60_000, "primary", 200, i % 3 ? "api" : "stress");
  for (let i = 0; i < 50; i++) r(now - 20 * HOUR + i * 60_000, "primary", 429);
  r(now - 10 * HOUR, "primary", 200);                                                           // a leak
  for (let i = 0; i < 30; i++) r(now - 9 * HOUR + i * 60_000, "primary", 429);
  for (let i = 0; i < 40; i++) r(now - 50 * HOUR + i * 60_000, "secondary", 200);
  for (let i = 0; i < 20; i++) r(now - 40 * HOUR + i * 60_000, "secondary", 429);
  for (let i = 0; i < 60; i++) r(now - 2 * HOUR + i * 60_000, "secondary", i % 10 ? 200 : 204, "probe");
  for (let i = 0; i < 100; i++) r(now - 50 * 60_000 + i * 20_000, "ultra-2", i % 13 ? 200 : 400);
  return rows;
}

describe("GtowLedgerView", () => {
  for (const mode of ["loop", "worker"] as const) {
    it(`seeds (${mode}) and answers the SQL's windows and walls`, async () => {
      const now = Date.now();
      const { log, view } = setup(mix(now), mode, now);
      expect(await view.whenReady()).toBe(true);
      expect(view.lastSeed!.mode).toBe(mode);
      expect(view.windows(now)).toEqual(log.windows(now));
      for (const s of ["primary", "secondary", "ultra-2", "nobody"]) expect(view.wallState(s, now)).toEqual(log.wallState(s, now));
      expect(view.wallState("primary", now).walled).toBe(true);
      expect(view.wallState("primary", now).leaks).toBe(1);
      expect(view.wallState("secondary", now).walled).toBe(false);
    });
  }

  it("this process's own rows count at once and are not counted twice when the sync meets them; others' rows come from the sync", async () => {
    const now = Date.now();
    const { log, view } = setup(mix(now), "loop", now);
    await view.whenReady();
    log.note({ session: "primary", kind: "poll", status: 200 });            // (a test log does not feed the view itself)
    const id = (log.handle().query("SELECT max(id) m FROM gtow_requests").get() as { m: number }).m;
    const row = log.handle().query("SELECT id, s, ts, st, o FROM gtow_requests WHERE id = ?").get(id) as any;
    view.note(row);                                                         // the writer's push
    const other = new Database(log.path);
    other.run("INSERT INTO gtow_requests (ts, s, k, st, o) VALUES (?,?,?,?,?)", [Date.now(), "secondary", "poll", 429, "stress"]);
    other.close();
    view.sync(true);
    const t = Date.now();
    expect(view.windows(t)).toEqual(log.windows(t));
    expect(view.wallState("secondary", t)).toEqual(log.wallState("secondary", t));
  });

  it("rows older than three days leave", async () => {
    const now = Date.now();
    const { view, setNow } = setup(mix(now), "loop", now);
    await view.whenReady();
    const before = view.size;
    expect(before).toBe(mix(now).length - 300);                              // the four-day-old ones were never read
    setNow(now + 2 * DAY);
    view.windows(now + 2 * DAY);
    expect(view.size).toBeLessThan(before);
    expect(view.wallState("primary", now + 2 * DAY).walled).toBe(true);     // still the newest run of 429s
  });

  it("a refresh's ledger reads stay far under 20 ms with three busy accounts (30,000 rows)", async () => {
    const now = Date.now();
    const rows: Row[] = [];
    for (let i = 0; i < 30_000; i++) rows.push({ ts: now - 3 * DAY + i * 8_600, s: ["primary", "secondary", "ultra-2"][i % 3]!, k: "poll", st: i % 97 ? 200 : 429, o: i % 5 ? "api" : "stress" });
    const { view } = setup(rows, "worker", now);
    expect(await view.whenReady()).toBe(true);
    expect(view.lastSeed!.maxSliceMs).toBeLessThan(50);
    view.windows(now);
    const t0 = performance.now();
    view.windows(now);
    for (const s of ["primary", "secondary", "ultra-2"]) view.wallState(s, now);
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it("no source: not ready, the caller reads the table", async () => {
    const view = new GtowLedgerView();
    expect(await view.whenReady()).toBe(false);
  });
});
