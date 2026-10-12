import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { hrc6maxDb } from "./hrc6maxDb";
import { testTempDir } from "../test/tempDir";

// The 6-max bake was opened once: missing at API start = missing for the life of the process (only a test called
// reload()). These walk it through absent → baked → re-baked in place → another file → a broken file.
const dir = testTempDir("data-reread-", { release: () => hrc6maxDb.reload() });
const ACTIONS = [{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }];
const CELLS = [{ hand: "AA", actions: { "Raise 2.5": 100 } }];
let n = 0;
/** give the file an mtime of its own (Windows' coarse clock can give two quick writes the same one) */
const aged = (p: string) => { const t = new Date(Date.now() - 60_000 + ++n * 1000); utimesSync(p, t, t); };

function bake(path: string, trees: string[]): void {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE IF NOT EXISTS nodes (source TEXT, line TEXT, pos TEXT, terminal INTEGER NOT NULL,
             actions TEXT NOT NULL, cells BLOB NOT NULL, PRIMARY KEY (source,line)) WITHOUT ROWID;
           CREATE TABLE IF NOT EXISTS trees (source TEXT PRIMARY KEY, nodes INTEGER NOT NULL, built_at INTEGER NOT NULL,
             src_mtime INTEGER NOT NULL, src_size INTEGER NOT NULL);`);
  const blob = deflateSync(Buffer.from(JSON.stringify(CELLS)));
  for (const t of trees) {
    db.query("INSERT OR REPLACE INTO nodes VALUES (?,?,?,?,?,?)").run(t, "", "UTG", 0, JSON.stringify(ACTIONS), blob);
    db.query("INSERT OR REPLACE INTO trees VALUES (?,?,?,?,?)").run(t, 1, 0, 0, 0);
  }
  db.close();
  aged(path);
}

const saved = process.env.HRC6MAX_DB;
const A = join(dir, "bake-a.sqlite"), B = join(dir, "bake-b.sqlite"), JUNK = join(dir, "junk.sqlite");
beforeAll(() => { process.env.HRC6MAX_DB = A; hrc6maxDb.reload(); });
afterAll(() => {
  hrc6maxDb.setRecheckMs(30_000);
  if (saved === undefined) delete process.env.HRC6MAX_DB; else process.env.HRC6MAX_DB = saved;
  hrc6maxDb.reload();
});
beforeEach(() => hrc6maxDb.setRecheckMs(0));

describe("hrc6maxDb follows its file", () => {
  test("no bake at start, baked later → read, no reload() needed (looked for again after the recheck interval)", () => {
    hrc6maxDb.setRecheckMs(60_000);
    expect(hrc6maxDb.present()).toBe(false);
    bake(A, ["ign200_6max_D100_o2_5"]);
    expect(hrc6maxDb.present()).toBe(false);           // inside the interval: still absent, no stat
    hrc6maxDb.setRecheckMs(0);                         // the interval has passed
    expect(hrc6maxDb.present()).toBe(true);
    expect(hrc6maxDb.covers("ign200_6max_D100_o2_5")).toBe(true);
    expect(hrc6maxDb.node("ign200_6max_D100_o2_5", "")).toEqual({ pos: "UTG", terminal: false, actions: ACTIONS, cells: CELLS });
  });

  test("a tree baked into the open file shows at the next check, not after the minute's coverage refresh", () => {
    expect(hrc6maxDb.size).toBe(1);
    bake(A, ["ign200_6max_D75_o3"]);
    expect(hrc6maxDb.covers("ign200_6max_D75_o3")).toBe(true);
    expect(hrc6maxDb.size).toBe(2);
  });

  test("another file at the bake's path is opened (and the old handle let go); a broken one keeps the old handle", () => {
    bake(B, ["ign200_6max_D150_o3"]);
    process.env.HRC6MAX_DB = B;                        // stands in for a replace-by-rename (Windows refuses one while open)
    expect(hrc6maxDb.covers("ign200_6max_D150_o3")).toBe(true);
    expect(hrc6maxDb.covers("ign200_6max_D100_o2_5")).toBe(false);
    expect(hrc6maxDb.size).toBe(1);
    writeFileSync(JUNK, "not a sqlite file ".repeat(64));
    process.env.HRC6MAX_DB = JUNK;
    expect(hrc6maxDb.covers("ign200_6max_D150_o3")).toBe(true);   // still the good bake
    expect(hrc6maxDb.node("ign200_6max_D150_o3", "")).toMatchObject({ pos: "UTG" });
    process.env.HRC6MAX_DB = A;
    expect(hrc6maxDb.size).toBe(2);
  });
});
