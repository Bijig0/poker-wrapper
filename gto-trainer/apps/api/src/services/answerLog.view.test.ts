import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { testTempDir } from "../test/tempDir";
import { AnswerLog } from "./answerLog";

// THE INCREMENTAL ANSWER VIEW (2026-10-09, catalogue-incremental): seeded once off the loop, pushed by the writer, tail-read
// for other processes, age-evicted — and every read it serves equals the SQL path's.
const logs: AnswerLog[] = [];
const dbs: Database[] = [];
const dir = testTempDir("answer-view-", { release: () => { logs.forEach((l) => l.close()); dbs.forEach((d) => { try { d.close(); } catch { /* closed */ } }); } });
let n = 0;
const fresh = (view: boolean, opts: { viewDays?: number; file?: string } = {}) => {
  const file = opts.file ?? join(dir, `v${++n}.sqlite`);
  const log = new AnswerLog(file, { view, viewDays: opts.viewDays });
  logs.push(log);
  return { log, file };
};
const DAY = 86_400_000;

const path = (i: number) => JSON.stringify({
  reasons: [{ code: i % 3 === 0 ? "FLOOR" : "CAP" }, ...(i % 5 === 0 ? [{ code: "SOFT" }] : [])],
  arrival: { code: i % 2 ? "ARR" : null, first: i % 7 === 0 ? { code: "FIRST" } : null },
  pad: "x".repeat(600),
});
const answer = (i: number, ts = Date.now()) => ({
  ts, wrapperHandId: i, clientHandId: i % 4 === 0 ? null : `49200${i}`, street: "flop", board: "AsKd2c", heroCards: "QhQd",
  decisionKey: `${i}:flop:0`, text: i % 9 === 0 ? null : "Call 100%", pick: "Call", roll: null, tier: i % 2 ? "ai-chain" : "chart-3max",
  warning: i % 6 === 0 ? "OFF-TREE SIZE nearest 33%" : i % 10 === 0 ? "CALLER CAP applied" : null, latencyMs: 1000 + i,
  failReason: i % 9 === 0 ? "no solution for this spot" : null, sessionId: "session_20261009_120000", strategyMode: i % 2 ? "chart" : "exploit",
  source: i % 2 ? "gtow-api-postflop" : null, bbCents: 200, tableSeats: 6, path: path(i), pathVerdict: "clean",
}) as any;

/** a whole table written by ANOTHER connection (the live table this process finds at boot) */
function fill(file: string, count: number, tsOf: (i: number) => number): void {
  const w = new AnswerLog(file);   // creates the schema
  w.add(answer(0, tsOf(0)));
  w.close();
  const db = new Database(file);
  const ins = db.query("INSERT INTO answers (ts, client_hand_id, text, tier, source, strategy_mode, latency_ms, warning, path, bb_cents, table_seats) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 1; i < count; i++) {
      const a = answer(i, tsOf(i));
      ins.run(a.ts, a.clientHandId, a.text, a.tier, a.source, a.strategyMode, a.latencyMs, a.warning, a.path, a.bbCents, a.tableSeats);
    }
  })();
  db.close();
}

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

describe("answerLog's incremental view", () => {
  for (const mode of ["loop", "worker"] as const) {
    it(`seeds off the request path (${mode}) and then serves exactly the SQL path's rows and counts`, async () => {
      const { log, file } = fresh(true);
      log.viewSeedMode = mode;
      const now = Date.now();
      fill(file, 1_200, (i) => now - (1_200 - i) * 60_000);
      const { log: sql } = fresh(false, { file });
      expect(await log.viewReady()).toBe(true);
      const st = log.viewState();
      expect(st.ready).toBe(true);
      expect(st.rows).toBe(1_200);
      expect(log.lastSeed!.mode).toBe(mode);
      expect(log.lastSeed!.pages).toBeGreaterThanOrEqual(3);          // 500-row pages (or smaller, adapted)
      expect(ids(log.rows(1))).toEqual(ids(sql.rows(1)));
      expect(ids(log.rows(60))).toEqual(ids(sql.rows(60)));
      expect(log.countPathCodes(30)).toEqual(sql.countPathCodes(30));
      const needles = ["OFF-TREE SIZE", "CALLER CAP", "never said"];
      expect(log.countWarnings(needles, 30)).toEqual(sql.countWarnings(needles, 30));
      expect(log.bySource(30)).toEqual(sql.bySource(30));
      expect(log.stats(60)).toEqual(sql.stats(60));
    });
  }

  it("the writer pushes each new row at once; attach is seen; another process's insert is read from the tail", async () => {
    const { log, file } = fresh(true);
    log.viewSeedMode = "loop";
    log.add(answer(1));
    expect(await log.viewReady()).toBe(true);
    log.add(answer(2));
    expect(log.viewState().rows).toBe(2);                  // in the view before any read
    log.add(answer(4));                                    // no hand id yet (a probe failure)
    const probe = log.rows(1).find((r) => r.client_hand_id == null)!;
    log.attach(probe.id, "4920999", "session_x", 7);
    expect(log.rows(1).find((r) => r.id === probe.id)!.client_hand_id).toBe("4920999");
    const other = new Database(file); dbs.push(other);
    other.run("INSERT INTO answers (ts, client_hand_id, text) VALUES (?, ?, ?)", [Date.now(), "4920777", "Fold 100%"]);
    log.add(answer(5));                                    // our own row lands after the other's: a gap the tail fills
    const { log: sql } = fresh(false, { file });
    expect(ids(log.rows(1))).toEqual(ids(sql.rows(1)));
    expect(log.rows(1).some((r) => r.client_hand_id === "4920777")).toBe(true);
  });

  it("rows written while the seed runs are all there when it lands", async () => {
    const { log, file } = fresh(true);
    log.viewSeedMode = "worker";
    const now = Date.now();
    fill(file, 2_000, (i) => now - (2_000 - i) * 1_000);
    const seeding = log.viewReady();
    for (let i = 0; i < 20; i++) log.add(answer(10_000 + i));
    const probeId = log.rows(1)[0]!.id;                    // (the SQL path serves until the seed lands)
    log.attach(probeId, "attached-mid-seed", null, null);
    expect(await seeding).toBe(true);
    const { log: sql } = fresh(false, { file });
    expect(ids(log.rows(1))).toEqual(ids(sql.rows(1)));
    expect(log.rows(1).find((r) => r.id === probeId)!.client_hand_id).toBe("attached-mid-seed");
  });

  it("age eviction: the view holds its window; a caller asking further back gets the SQL path's rows", async () => {
    const { log, file } = fresh(true, { viewDays: 2 });
    log.viewSeedMode = "loop";
    const now = Date.now();
    fill(file, 50, (i) => now - (i < 10 ? 5 * DAY : 60_000 * i));       // 10 rows five days old
    expect(await log.viewReady()).toBe(true);
    expect(log.viewState().rows).toBe(40);
    const { log: sql } = fresh(false, { file });
    expect(ids(log.rows(1))).toEqual(ids(sql.rows(1)));
    expect(log.rows(10).length).toBe(50);                  // beyond the view: the table answers
  });

  it("a warm view answers a catalogue's reads in well under 100 ms (12,500 answers, ~1 KB paths)", async () => {
    const { log, file } = fresh(true);
    log.viewSeedMode = "worker";
    const now = Date.now();
    fill(file, 12_500, (i) => now - (12_500 - i) * 200_000);           // ~29 days
    expect(await log.viewReady()).toBe(true);
    expect(log.lastSeed!.maxSliceMs).toBeLessThan(50);     // no page held the loop past the bound
    log.rows(32); log.countPathCodes(30);                  // (first touch)
    const t0 = performance.now();
    log.rows(32);
    log.rows(365);
    log.countPathCodes(30);
    log.countWarnings(["OFF-TREE SIZE", "CALLER CAP"], 30);
    log.bySource(30);
    log.stats(60);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(100);
  });

  it("off (the default for a log a test builds): the SQL path, no seed", async () => {
    const { log } = fresh(false);
    log.add(answer(1));
    expect(await log.viewReady()).toBe(false);
    expect(log.viewState()).toMatchObject({ on: false, ready: false });
    expect(log.rows(1).length).toBe(1);
  });
});
