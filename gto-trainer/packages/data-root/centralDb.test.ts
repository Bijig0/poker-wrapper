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
    expect(old.query("SELECT max_rowid FROM _poker_adopted WHERE tbl='hands'").get()).toEqual({ max_rowid: 2 });
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
