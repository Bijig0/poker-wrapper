import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { hrc6maxDb } from "./hrc6maxDb";

// The HTTP path is what this module falls back TO, so it is stubbed and counted.
// It must be replaced before hrc6maxDb loads, which is why the import is dynamic.
let httpCalls: { source: string; line: string }[] = [];
let httpReply: unknown = null;
mock.module("./hrc3max", () => ({
  fetchNode: async (source: string, line: string) => {
    httpCalls.push({ source, line });
    return httpReply;
  },
}));

const dir = mkdtempSync(join(tmpdir(), "hrc6max-"));
const dbPath = join(dir, "baked.sqlite");

const CELLS = [{ hand: "AA", actions: { "Raise 2.5": 100 } }];
const ACTIONS = [{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }];

beforeAll(() => {
  const db = new Database(dbPath, { create: true });
  db.exec(`CREATE TABLE nodes (source TEXT, line TEXT, pos TEXT, terminal INTEGER NOT NULL,
             actions TEXT NOT NULL, cells BLOB NOT NULL, PRIMARY KEY (source,line)) WITHOUT ROWID;
           CREATE TABLE trees (source TEXT PRIMARY KEY, nodes INTEGER NOT NULL, built_at INTEGER NOT NULL,
             src_mtime INTEGER NOT NULL, src_size INTEGER NOT NULL);`);
  // Python's zlib.compress() is zlib-wrapped deflate; deflateSync is its Node twin.
  const blob = deflateSync(Buffer.from(JSON.stringify(CELLS)));
  db.query("INSERT INTO nodes VALUES (?,?,?,?,?,?)")
    .run("ign200_6max_D100_o2_5", "", "UTG", 0, JSON.stringify(ACTIONS), blob);
  db.query("INSERT INTO trees VALUES (?,?,?,?,?)").run("ign200_6max_D100_o2_5", 1, 0, 0, 0);
  db.close();
  process.env.HRC6MAX_DB = dbPath;
  // Another test file may already have imported hrc6max.ts (and through it this
  // module) and opened the REAL bake; drop that handle so the fixture is used.
  hrc6maxDb.reload();
});

afterAll(async () => {
  // Windows will not unlink a file SQLite still has open, so release the handle
  // before removing the directory.
  (await import("./hrc6maxDb")).hrc6maxDb.reload();
  delete process.env.HRC6MAX_DB;
  rmSync(dir, { recursive: true, force: true });
});

const load = async () => await import("./hrc6maxDb");

describe("hrc6maxDb", () => {
  it("reads a baked node without touching the chart server", async () => {
    const { fetchNode6max } = await load();
    httpCalls = [];
    const node = await fetchNode6max("ign200_6max_D100_o2_5", "");
    expect(node).toEqual({ pos: "UTG", terminal: false, actions: ACTIONS, cells: CELLS });
    expect(httpCalls).toHaveLength(0);
  });

  // THE DISTINCTION THIS MODULE TURNS ON. A null means "this chart does not
  // contain that line", which makes resolveChart6max move to the next candidate
  // chart. Returning it for a tree that was simply never baked would answer the
  // hand from the wrong chart, silently and plausibly — so an unbaked tree must
  // produce undefined and go to the server instead.
  it("returns null for a line missing from a BAKED tree, and does not ask the server", async () => {
    const { fetchNode6max, hrc6maxDb } = await load();
    httpCalls = [];
    expect(hrc6maxDb.node("ign200_6max_D100_o2_5", "F-F-R9.5")).toBeNull();
    expect(await fetchNode6max("ign200_6max_D100_o2_5", "F-F-R9.5")).toBeNull();
    expect(httpCalls).toHaveLength(0);
  });

  // THE BAKE IS THE RECORD (2026-09-27). With a bake on this machine, a 6-max id it lacks is a chart that does not
  // exist here — the picker moves to its next candidate — and the chart server is never asked. `node()` still says
  // undefined (the module's own "not covered" signal); the routing decision is fetchNode6max's.
  it("with a bake present, a 6-max tree the bake lacks is 'no such chart' and the server is not asked", async () => {
    const { fetchNode6max, hrc6maxDb } = await load();
    httpCalls = [];
    httpReply = { pos: "BTN", terminal: false, actions: [], cells: [] };
    expect(hrc6maxDb.present()).toBe(true);
    expect(hrc6maxDb.node("ign200_6max_D150_o3", "")).toBeUndefined();
    expect(await fetchNode6max("ign200_6max_D150_o3", "")).toBeNull();
    expect(httpCalls).toHaveLength(0);
  });

  it("never claims a non-6max chart — the 3-max corpus stays on :8777", async () => {
    const { fetchNode6max, hrc6maxDb } = await load();
    httpCalls = [];
    httpReply = null;
    expect(hrc6maxDb.covers("ign200_3maxasym_D100_s50_BB")).toBe(false);
    await fetchNode6max("ign200_3maxasym_D100_s50_BB", "");
    expect(httpCalls).toHaveLength(1);
  });

  it("passes 'unreachable' through unchanged for the families the server still holds", async () => {
    const { fetchNode6max } = await load();
    httpReply = "unreachable";
    expect(await fetchNode6max("ign200_3maxasym_D100_s50_BB", "")).toBe("unreachable");
  });

  it("with NO bake on this machine, the 6-max family still comes from the server", async () => {
    const { fetchNode6max, hrc6maxDb } = await load();
    const was = process.env.HRC6MAX_DB;
    process.env.HRC6MAX_DB = join(dir, "absent.sqlite");
    hrc6maxDb.reload();
    try {
      httpCalls = [];
      httpReply = { pos: "BTN", terminal: false, actions: [], cells: [] };
      expect(hrc6maxDb.present()).toBe(false);
      expect(hrc6maxDb.size).toBe(0);
      expect(await fetchNode6max("ign200_6max_D150_o3", "")).toEqual(httpReply as never);
      expect(httpCalls).toEqual([{ source: "ign200_6max_D150_o3", line: "" }]);
    } finally {
      process.env.HRC6MAX_DB = was;
      hrc6maxDb.reload();
    }
  });

  it("reports the coverage count from the file, not from first open (a tree baked later counts)", async () => {
    const { hrc6maxDb } = await load();
    hrc6maxDb.reload();
    expect(hrc6maxDb.size).toBe(1);
    const db = new Database(dbPath);
    const blob = deflateSync(Buffer.from(JSON.stringify(CELLS)));
    db.query("INSERT INTO nodes VALUES (?,?,?,?,?,?)").run("ign200_6max_D75_o3", "", "UTG", 0, JSON.stringify(ACTIONS), blob);
    db.query("INSERT INTO trees VALUES (?,?,?,?,?)").run("ign200_6max_D75_o3", 1, 0, 0, 0);
    db.close();
    // the coverage set is re-read at most once a minute; a reload stands in for the clock here
    hrc6maxDb.reload();
    expect(hrc6maxDb.size).toBe(2);
    expect(hrc6maxDb.covers("ign200_6max_D75_o3")).toBe(true);
  });

  // Runs last: it adds the column the 2026-09-25 bake carries. The fixture above is a bake from before it, and the
  // first test proves such a bake still reads (no `pruned` key at all).
  it("reads the pruned flag of a bake that carries it (A9dd: the SB's ~0% flat is not the flop)", async () => {
    const { hrc6maxDb } = await load();
    hrc6maxDb.reload();
    const db = new Database(dbPath);
    db.exec("ALTER TABLE nodes ADD COLUMN pruned INTEGER NOT NULL DEFAULT 0");
    const empty = deflateSync(Buffer.from("[]"));
    const ins = db.query("INSERT INTO nodes (source, line, pos, terminal, actions, cells, pruned) VALUES (?,?,?,?,?,?,?)");
    ins.run("ign200_6max_D100_o2_5", "F-F-F-R2.5-C", "SB", 1, "[]", empty, 1);
    ins.run("ign200_6max_D100_o2_5", "R2.5-C-C-C", "BTN", 1, "[]", empty, 2);
    ins.run("ign200_6max_D100_o2_5", "F-F-F-R2.5-F-C", "BB", 1, "[]", empty, 0);
    db.close();
    hrc6maxDb.reload();
    expect(hrc6maxDb.node("ign200_6max_D100_o2_5", "F-F-F-R2.5-C")).toMatchObject({ terminal: true, pruned: "reach" });
    expect(hrc6maxDb.node("ign200_6max_D100_o2_5", "R2.5-C-C-C")).toMatchObject({ terminal: true, pruned: "cut" });
    const close = hrc6maxDb.node("ign200_6max_D100_o2_5", "F-F-F-R2.5-F-C");
    expect(close).toMatchObject({ terminal: true });
    expect(close && "pruned" in close).toBe(false);
    expect(hrc6maxDb.node("ign200_6max_D100_o2_5", "")).toEqual({ pos: "UTG", terminal: false, actions: ACTIONS, cells: CELLS });
  });
});
