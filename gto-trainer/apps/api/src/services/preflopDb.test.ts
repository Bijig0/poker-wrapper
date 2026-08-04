import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PreflopDb } from "./preflopDb";

const dbPath = join(tmpdir(), `preflop-db-test-${process.pid}.sqlite`);
const GT = "CashHu500zComplex";

beforeAll(() => {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE nodes (
    gametype TEXT NOT NULL, depth INTEGER NOT NULL, line TEXT NOT NULL,
    pos TEXT, reach REAL NOT NULL, actions TEXT NOT NULL, cells TEXT NOT NULL,
    terminal INTEGER NOT NULL DEFAULT 0, crawled_at INTEGER NOT NULL,
    PRIMARY KEY (gametype, depth, line)
  );`);
  const ins = db.query("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run(GT, 100, "", "SB", 1,
    JSON.stringify([
      { action: "Fold", rangePct: 11, token: "F" },
      { action: "Call", rangePct: 25, token: "C" },
      { action: "Raise 2.5", rangePct: 64, token: "R2.5" },
    ]),
    JSON.stringify([
      { hand: "AA", actions: { "Raise 2.5": 81, Call: 19 } },
      { hand: "72o", actions: { Fold: 100 } },
    ]),
    0, 1);
  ins.run(GT, 100, "R2.5", "BB", 0.64,
    JSON.stringify([
      { action: "Fold", rangePct: 55, token: "F" },
      { action: "Call", rangePct: 35, token: "C" },
      { action: "Raise 10", rangePct: 10, token: "R10" },
    ]),
    JSON.stringify([{ hand: "KQs", actions: { Call: 60, "Raise 10": 40 } }]),
    0, 2);
  ins.run(GT, 100, "R2.5-C", null, 0.22, "[]", "[]", 1, 3);
  db.close();
});
afterAll(() => { try { unlinkSync(dbPath); } catch { /* gone */ } });

describe("PreflopDb", () => {
  it("reports availability per (gametype, depth)", () => {
    const db = new PreflopDb(dbPath);
    expect(db.available(GT, 100)).toBe(true);
    expect(db.available(GT, 50)).toBe(false);
    expect(db.available("Cash6m500zGeneral", 100)).toBe(false);
  });

  it("answers an on-tree line with the hero class strategy", () => {
    const db = new PreflopDb(dbPath);
    const a = db.answer(GT, 100, ["R2.5"], "KQs");
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.pos).toBe("BB");
      expect(a.actions).toEqual([
        { action: "Call", frequency: 60 },
        { action: "Raise 10", frequency: 40 },
      ]);
      expect(a.decision?.action).toMatch(/Call|Raise 10/);
      expect(a.notInRange).toBe(false);
    }
  });

  it("snaps an off-tree open and reports the repair", () => {
    const db = new PreflopDb(dbPath);
    const a = db.answer(GT, 100, ["R3.2"], "KQs");
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.line).toBe("R2.5");
      expect(a.repaired).toEqual([{ index: 0, from: 3.2, to: 2.5 }]);
    }
  });

  it("flags a class outside the range", () => {
    const db = new PreflopDb(dbPath);
    const a = db.answer(GT, 100, ["R2.5"], "T2o");
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.notInRange).toBe(true);
      expect(a.decision).toBeNull();
    }
  });

  it("misses cleanly on an uncrawled node", () => {
    const db = new PreflopDb(dbPath);
    const a = db.answer(GT, 100, ["R2.5", "R10"], "AA");
    expect(a.ok).toBe(false);
  });

  it("handles a missing DB file without throwing", () => {
    const db = new PreflopDb(join(tmpdir(), "does-not-exist.sqlite"));
    expect(db.available(GT, 100)).toBe(false);
  });
});
