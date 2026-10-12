import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileStamp, FollowedSqlite, sameStamp } from "./fileStamp";
import { testTempDir } from "../test/tempDir";

const followers: FollowedSqlite[] = [];
const dir = testTempDir("data-reread-", { release: () => followers.forEach((f) => f.close()) });
/** Windows keeps a coarse mtime: two writes a few ms apart can carry the same one. A real re-export is seconds after
 *  the last; this stands in for that time passing. */
const aged = (p: string, secondsAgo: number) => { const t = new Date(Date.now() - secondsAgo * 1000); utimesSync(p, t, t); };

function bake(path: string, rows: number[]): void {
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
  for (const v of rows) db.query("INSERT INTO t VALUES (?)").run(v);
  db.close();
}
const values = (db: Database | null) => (db?.query("SELECT v FROM t ORDER BY v").all() as { v: number }[]).map((r) => r.v);

describe("fileStamp", () => {
  test("missing is null; a rewrite with another size, or another file renamed over it, is a different stamp", () => {
    const p = join(dir, "stamp.txt");
    expect(fileStamp(p)).toBeNull();
    expect(sameStamp(null, null)).toBe(true);
    writeFileSync(p, "one");
    const a = fileStamp(p);
    expect(sameStamp(a, fileStamp(p))).toBe(true);
    writeFileSync(p, "three");
    const b = fileStamp(p);
    expect(sameStamp(a, b)).toBe(false);
    // same size, written in the same clock tick: only the file id tells them apart
    writeFileSync(join(dir, "stamp.next"), "THREE");
    renameSync(join(dir, "stamp.next"), p);
    expect(sameStamp(b, fileStamp(p))).toBe(false);
  });
});

describe("FollowedSqlite", () => {
  test("missing → null; appears later → opened", () => {
    const p = join(dir, "late.sqlite");
    const f = new FollowedSqlite(() => p, 0);
    followers.push(f);
    expect(f.get()).toBeNull();
    bake(p, [1]);
    expect(values(f.get())).toEqual([1]);
  });

  test("an open file is stat'ed at most every checkMs; a changed one is reopened (new handle), the old one closed", () => {
    const p = join(dir, "changing.sqlite");
    bake(p, [1]);
    const f = new FollowedSqlite(() => p, 60_000);
    followers.push(f);
    const first = f.get()!;
    bake(p, [2]);
    aged(p, 30);
    expect(f.get()).toBe(first);                  // inside checkMs: no stat, same handle (it sees in-place rows anyway)
    f.setCheckMs(0);
    const second = f.get()!;
    expect(second).not.toBe(first);               // the stamp changed: reopened
    expect(values(second)).toEqual([1, 2]);
    expect(() => first.query("SELECT 1").get()).toThrow();   // the old handle was closed
    expect(f.get()).toBe(second);                 // unchanged since: the same handle
  });

  test("another file at the followed path is read; one that will not open keeps the old handle serving", () => {
    const a = join(dir, "a.sqlite"), b = join(dir, "b.sqlite"), junk = join(dir, "junk.sqlite");
    bake(a, [10]); bake(b, [20]);
    writeFileSync(junk, "this is not a sqlite file, and it is long enough to have a header-sized prefix ".repeat(4));
    let path = a;
    const log: string[] = [];
    const f = new FollowedSqlite(() => path, 0, (m) => log.push(m));
    followers.push(f);
    expect(values(f.get())).toEqual([10]);
    path = b;                                     // stands in for a replace-by-rename (Windows refuses one while open)
    expect(values(f.get())).toEqual([20]);
    expect(log.some((m) => m.includes("was replaced"))).toBe(true);
    path = junk;
    expect(values(f.get())).toEqual([20]);        // the broken file never replaced the good handle
    expect(log.some((m) => m.includes("would not open"))).toBe(true);
  });
});
