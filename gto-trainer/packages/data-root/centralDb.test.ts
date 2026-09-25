import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacy, centralDbPath, openStore } from "./centralDb";
import { dataLayout } from "./dataRoot";

const tmp = () => mkdtempSync(join(tmpdir(), "centraldb-"));

/** a legacy hands.db the way the wrapper wrote it, with gaps in the rowids (deleted rows) */
function legacyHands(dir: string, ids: number[]): string {
  const f = join(dir, "hands.db");
  const d = new Database(f);
  d.run(`CREATE TABLE IF NOT EXISTS hands (rowid INTEGER PRIMARY KEY AUTOINCREMENT, hand_id INTEGER, played_at INTEGER, data TEXT NOT NULL)`);
  for (const id of ids) d.run(`INSERT INTO hands (rowid, hand_id, played_at, data) VALUES (?, ?, ?, ?)`, [id, id * 10, id * 1000, `{"n":${id}}`]);
  d.close();
  return f;
}

function legacyAnswers(dir: string, n: number): string {
  const f = join(dir, "answers.sqlite");
  const d = new Database(f);
  d.run(`CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, client_hand_id TEXT, solve_id INTEGER)`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_answers_client_hand ON answers(client_hand_id)`);
  for (let i = 1; i <= n; i++) d.run(`INSERT INTO answers (ts, client_hand_id, solve_id) VALUES (?, ?, ?)`, [i, `h${i}`, 100 + i]);
  d.close();
  return f;
}

describe("adoptLegacy", () => {
  test("first adoption copies every table WITH its rowids, and its indexes", () => {
    const d = tmp();
    const hands = legacyHands(d, [3, 7, 973]);
    const answers = legacyAnswers(d, 4);
    const central = new Database(join(d, "poker.sqlite"));
    const r = adoptLegacy(central, [{ file: hands, tables: ["hands"] }, { file: answers, tables: ["answers"] }]);
    expect(r.errors).toEqual([]);
    expect(central.query("SELECT rowid, hand_id FROM hands ORDER BY rowid").all()).toEqual([
      { rowid: 3, hand_id: 30 }, { rowid: 7, hand_id: 70 }, { rowid: 973, hand_id: 9730 },
    ]);
    expect(central.query("SELECT id, solve_id FROM answers WHERE id = 4").get()).toEqual({ id: 4, solve_id: 104 });
    expect(central.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_answers_client_hand'").get()).toBeTruthy();
    expect(r.notes.every((n) => n.preservedIds)).toBe(true);
  });

  test("rows an old-code process appends afterwards are picked up once, by the watermark in the legacy file", () => {
    const d = tmp();
    const answers = legacyAnswers(d, 2);
    const central = new Database(join(d, "poker.sqlite"));
    adoptLegacy(central, [{ file: answers, tables: ["answers"] }]);
    // new code writes a row centrally, old code writes two more to the legacy file
    central.run(`INSERT INTO answers (ts, client_hand_id) VALUES (50, 'new-central')`);
    const l = new Database(answers);
    l.run(`INSERT INTO answers (ts, client_hand_id) VALUES (60, 'late-1')`);
    l.run(`INSERT INTO answers (ts, client_hand_id) VALUES (61, 'late-2')`);
    l.close();
    const r2 = adoptLegacy(central, [{ file: answers, tables: ["answers"] }]);
    expect(r2.notes).toEqual([{ file: answers, table: "answers", copied: 2, preservedIds: false }]);
    expect(central.query("SELECT client_hand_id FROM answers ORDER BY id").all().map((x: any) => x.client_hand_id))
      .toEqual(["h1", "h2", "new-central", "late-1", "late-2"]);
    // and a third pass copies nothing
    expect(adoptLegacy(central, [{ file: answers, tables: ["answers"] }]).notes).toEqual([]);
  });

  test("columns the central table gained later are left at their defaults; legacy-only columns are dropped", () => {
    const d = tmp();
    const answers = legacyAnswers(d, 1);
    const central = new Database(join(d, "poker.sqlite"));
    central.run(`CREATE TABLE answers (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, client_hand_id TEXT, chain TEXT)`);
    const r = adoptLegacy(central, [{ file: answers, tables: ["answers"] }]);
    expect(r.errors).toEqual([]);
    expect(central.query("SELECT id, client_hand_id, chain FROM answers").get()).toEqual({ id: 1, client_hand_id: "h1", chain: null });
  });

  test("a fully copied file nothing holds open is retired (renamed), so no stale copy can be read by mistake", () => {
    const d = tmp();
    const hands = legacyHands(d, [1, 2]);
    const central = new Database(join(d, "poker.sqlite"));
    const r = adoptLegacy(central, [{ file: hands, tables: ["hands"] }], { retire: true, now: Date.UTC(2026, 8, 25) });
    expect(r.retired).toEqual([hands]);
    expect(existsSync(hands)).toBe(false);
    expect(readdirSync(d).some((f) => f === "hands.db.adopted-20260925")).toBe(true);
    // the retired copy still carries its watermark
    const old = new Database(join(d, "hands.db.adopted-20260925"), { readonly: true });
    expect(old.query("SELECT max_rowid FROM _poker_adopted_into WHERE tbl='hands'").get()).toEqual({ max_rowid: 2 });
  });

  test("a legacy file re-created by old code later (no watermark) is copied again as new rows", () => {
    const d = tmp();
    const central = new Database(join(d, "poker.sqlite"));
    adoptLegacy(central, [{ file: legacyHands(d, [1, 2]), tables: ["hands"] }], { retire: true });
    const again = legacyHands(d, [1]);              // old wrapper started, made a fresh hands.db, wrote its first hand
    const r = adoptLegacy(central, [{ file: again, tables: ["hands"] }]);
    expect(r.notes[0]!.copied).toBe(1);
    expect(central.query("SELECT COUNT(*) n FROM hands").get()).toEqual({ n: 3 });
  });
});

describe("openStore", () => {
  test("the central path in test mode lives in the per-run temp root, never a checkout", () => {
    const p = centralDbPath();
    expect(p.startsWith(dataLayout().root)).toBe(true);
    expect(dataLayout().mode).toBe("test");
    const db = openStore(p);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  });

  test("an override path opens plainly (tests' :memory:)", () => {
    const db = openStore(":memory:");
    db.run("CREATE TABLE t (x)");
    expect(db.query("SELECT COUNT(*) n FROM t").get()).toEqual({ n: 0 });
  });

  test("the short busy timeout the wrapper's live writes use gives up instead of blocking", () => {
    const f = join(tmp(), "x.sqlite");
    const a = openStore(f);
    a.run("CREATE TABLE t (x)");
    a.run("BEGIN IMMEDIATE");
    a.run("INSERT INTO t VALUES (1)");
    const b = openStore(f, { busyMs: 30 });
    const t0 = Date.now();
    expect(() => b.run("INSERT INTO t VALUES (2)")).toThrow();
    expect(Date.now() - t0).toBeLessThan(1000);
    a.run("COMMIT");
  });
});

describe("adoptLegacy: WITHOUT ROWID tables", () => {
  test("hand_facts (keyed, no rowid) is copied by key, idempotently", () => {
    const d = tmp();
    const f = join(d, "hand_facts.sqlite");
    const l = new Database(f);
    l.run("CREATE TABLE hand_facts (hand_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, doc TEXT NOT NULL) WITHOUT ROWID");
    l.run("INSERT INTO hand_facts VALUES ('4920419883', 1, '{}'), ('4920419884', 2, '{}')");
    l.close();
    const central = new Database(join(d, "poker.sqlite"));
    const r = adoptLegacy(central, [{ file: f, tables: ["hand_facts"] }]);
    expect(r.errors).toEqual([]);
    expect(central.query("SELECT COUNT(*) n FROM hand_facts").get()).toEqual({ n: 2 });
    expect(adoptLegacy(central, [{ file: f, tables: ["hand_facts"] }]).notes).toEqual([]);
  });
});

describe("adoptJsonl (the two JSONL logs → tables)", () => {
  test("imports complete lines once, skips torn ones, resumes from the byte offset, retires the file", async () => {
    const { adoptJsonl } = await import("./eventTables");
    const { appendFileSync, writeFileSync } = await import("node:fs");
    const d = tmp();
    const f = join(d, "gtow_requests.jsonl");
    writeFileSync(f, '{"ts":1,"s":"primary","k":"poll","st":200,"o":"api","h":"4920419883","sr":"river","go":"live"}\n{"ts":2,"s":"prim\n{"ts":3,"s":"secondary","k":"tree","st":201,"o":"api"}\n{"ts":4,"s":"pri');
    const central = new Database(join(d, "poker.sqlite"));
    const r1 = adoptJsonl(central, [{ file: f, table: "gtow_requests" }]);
    expect(r1.notes).toEqual([{ file: f, table: "gtow_requests", copied: 2 }]);   // torn line 2 skipped, partial line 4 left
    expect(central.query("SELECT ts, h, sr FROM gtow_requests ORDER BY ts").all()).toEqual([
      { ts: 1, h: "4920419883", sr: "river" }, { ts: 3, h: null, sr: null },
    ]);
    appendFileSync(f, 'mary","k":"poll","st":429,"o":"api"}\n');                 // the old writer finishes line 4
    const r2 = adoptJsonl(central, [{ file: f, table: "gtow_requests" }], { retire: true });
    expect(r2.notes[0]!.copied).toBe(1);
    expect(r2.retired).toEqual([f]);
    expect(central.query("SELECT COUNT(*) n FROM gtow_requests").get()).toEqual({ n: 3 });
  });

  test("poller events keep the whole event as doc, with ts/outcome/street queryable", async () => {
    const { adoptJsonl } = await import("./eventTables");
    const { writeFileSync } = await import("node:fs");
    const d = tmp();
    const f = join(d, "poller-events.jsonl");
    writeFileSync(f, JSON.stringify({ ts: 1790282896909, ms: 14154, outcome: "ok", hand: 24, street: "river", trace: null }) + "\n");
    const central = new Database(join(d, "poker.sqlite"));
    adoptJsonl(central, [{ file: f, table: "poller_events" }]);
    const row: any = central.query("SELECT ts, outcome, hand, street, ms, doc FROM poller_events").get();
    expect(row).toMatchObject({ ts: 1790282896909, outcome: "ok", hand: "24", street: "river", ms: 14154 });
    expect(JSON.parse(row.doc).trace).toBeNull();
  });
});

describe("startAdoptionCatchUp (the mixed-version window)", () => {
  test("rows an old-code process keeps writing to a still-open legacy file reach the central DB without a restart", async () => {
    const { startAdoptionCatchUp, _setStillOpenForTests } = await import("./centralDb");
    const f = join(tmp(), "answers.sqlite");
    const l = new Database(f);
    l.run(`CREATE TABLE answers (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, client_hand_id TEXT)`);
    l.run(`INSERT INTO answers (ts, client_hand_id) VALUES (1, 'old-code-row')`);
    l.close();
    _setStillOpenForTests([f]);
    const lines: string[] = [];
    const stop = startAdoptionCatchUp((x) => lines.push(x), 50, () => ({ db: [{ file: f, tables: ["answers"] }], jsonl: [] }));
    await new Promise((r) => setTimeout(r, 300));
    stop();
    const db = new Database(centralDbPath(), { readonly: true });
    const got = db.query("SELECT client_hand_id FROM answers WHERE client_hand_id = 'old-code-row'").get();
    db.close();
    expect(got).toEqual({ client_hand_id: "old-code-row" });
    expect(lines.join(" ")).toContain("catch-up: +1");
    expect(existsSync(f)).toBe(false);                       // nothing held it any more: retired
  });
});

describe("the watermark belongs to its destination", () => {
  test("a copy into ANOTHER database (a scratch verify root) never makes the real adoption skip rows", () => {
    const d = tmp();
    const f = legacyAnswers(d, 3);
    const scratch = new Database(join(d, "scratch.sqlite"));
    adoptLegacy(scratch, [{ file: f, tables: ["answers"] }]);
    const real = new Database(join(d, "poker.sqlite"));
    const r = adoptLegacy(real, [{ file: f, tables: ["answers"] }]);
    expect(r.notes[0]!.copied).toBe(3);
    expect(real.query("SELECT COUNT(*) n FROM answers").get()).toEqual({ n: 3 });
  });
});

describe("chunked adoption (2026-09-26: a 123 MB copy in one transaction, before the port was open, got the API killed twice)", () => {
  test("a process killed half way keeps its committed chunks; the next start resumes from the watermark, rowids kept", async () => {
    const { adoptSteps } = await import("./centralDb");
    const d = tmp();
    const answers = legacyAnswers(d, 10);
    const central = new Database(join(d, "poker.sqlite"));
    const out = { notes: [], retired: [], stillOpen: [], errors: [] };
    const steps = adoptSteps(central, [{ file: answers, tables: ["answers"] }], out, { chunkRows: 3 });
    steps.next();
    steps.next();                                            // two chunks committed ...
    steps.return(undefined);                                 // ... then the process dies
    expect(central.query("SELECT COUNT(*) n FROM answers").get()).toEqual({ n: 6 });
    const r = adoptLegacy(central, [{ file: answers, tables: ["answers"] }], { chunkRows: 3 });
    expect(r.notes).toEqual([{ file: answers, table: "answers", copied: 4, preservedIds: true }]);
    expect(central.query("SELECT id, solve_id FROM answers ORDER BY id").all().map((x: any) => [x.id, x.solve_id]))
      .toEqual(Array.from({ length: 10 }, (_, i) => [i + 1, 101 + i]));
  });

  test("a row written by the serving API mid-adoption: no collision, the rest go over with new rowids", async () => {
    const { adoptSteps } = await import("./centralDb");
    const d = tmp();
    const answers = legacyAnswers(d, 6);
    const central = new Database(join(d, "poker.sqlite"));
    const out = { notes: [] as any[], retired: [], stillOpen: [], errors: [] as string[] };
    const steps = adoptSteps(central, [{ file: answers, tables: ["answers"] }], out, { chunkRows: 2 });
    steps.next();                                            // rows 1-2, rowids kept
    central.run(`INSERT INTO answers (ts, client_hand_id) VALUES (99, 'live-write')`);   // gets id 3
    for (const _ of steps) { /* drain */ }
    expect(out.errors).toEqual([]);
    expect(out.notes).toEqual([{ file: answers, table: "answers", copied: 6, preservedIds: false }]);
    const rows = central.query("SELECT id, client_hand_id FROM answers ORDER BY id").all().map((x: any) => [x.id, x.client_hand_id]);
    expect(rows.slice(0, 3)).toEqual([[1, "h1"], [2, "h2"], [3, "live-write"]]);
    expect(rows.map((r) => r[1]).sort()).toEqual(["h1", "h2", "h3", "h4", "h5", "h6", "live-write"]);
  });

  test("the async adoption gives the event loop a turn between chunks", async () => {
    const { adoptLegacyAsync } = await import("./centralDb");
    const d = tmp();
    const answers = legacyAnswers(d, 40);
    const central = new Database(join(d, "poker.sqlite"));
    let turns = 0;
    const iv = setInterval(() => turns++, 0);
    const probe = new Promise<number>((r) => setImmediate(() => r(Date.now())));
    const r = await adoptLegacyAsync(central, [{ file: answers, tables: ["answers"] }], { chunkRows: 4 });
    clearInterval(iv);
    expect(await probe).toBeGreaterThan(0);                  // a callback queued at the start ran before the end
    expect(turns).toBeGreaterThan(0);
    expect(r.notes[0]!.copied).toBe(40);
  });
});

describe("startAdoptionCatchUp is cheap when nothing moved", () => {
  test("a held-open legacy file nobody writes is not re-opened every pass; a new row is still picked up", async () => {
    const { startAdoptionCatchUp, _setStillOpenForTests } = await import("./centralDb");
    const f = join(tmp(), "answers.sqlite");
    const held = new Database(f);                            // an old-code process holding it (Windows: no rename)
    held.run(`CREATE TABLE answers (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, client_hand_id TEXT)`);
    held.run(`INSERT INTO answers (ts, client_hand_id) VALUES (1, 'catchup-a')`);
    _setStillOpenForTests([f]);
    let looked = 0;
    const lines: string[] = [];
    const stop = startAdoptionCatchUp((x) => lines.push(x), 40, () => { looked++; return { db: [{ file: f, tables: ["answers"] }], jsonl: [] }; });
    await new Promise((r) => setTimeout(r, 400));
    const idle = looked;
    held.run(`INSERT INTO answers (ts, client_hand_id) VALUES (2, 'catchup-b')`);
    await new Promise((r) => setTimeout(r, 300));
    stop();
    held.close();
    const db = new Database(centralDbPath(), { readonly: true });
    const got = db.query("SELECT client_hand_id FROM answers WHERE client_hand_id LIKE 'catchup-%' ORDER BY client_hand_id").all();
    db.close();
    if (process.platform === "win32") {
      expect(idle).toBe(1);                                  // ~10 passes, one look
      expect(looked).toBe(2);                                // the write moved the file: looked once more
    }
    expect(got).toEqual([{ client_hand_id: "catchup-a" }, { client_hand_id: "catchup-b" }]);
  });
});
