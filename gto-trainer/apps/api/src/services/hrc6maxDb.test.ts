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

  it("falls back to the server for a tree that was never baked", async () => {
    const { fetchNode6max, hrc6maxDb } = await load();
    httpCalls = [];
    httpReply = { pos: "BTN", terminal: false, actions: [], cells: [] };
    expect(hrc6maxDb.node("ign200_6max_D150_o3", "")).toBeUndefined();
    expect(await fetchNode6max("ign200_6max_D150_o3", "")).toEqual(httpReply as never);
    expect(httpCalls).toEqual([{ source: "ign200_6max_D150_o3", line: "" }]);
  });

  it("never claims a non-6max chart — the 3-max corpus stays on :8777", async () => {
    const { fetchNode6max, hrc6maxDb } = await load();
    httpCalls = [];
    httpReply = null;
    expect(hrc6maxDb.covers("ign200_3maxasym_D100_s50_BB")).toBe(false);
    await fetchNode6max("ign200_3maxasym_D100_s50_BB", "");
    expect(httpCalls).toHaveLength(1);
  });

  it("passes 'unreachable' through unchanged", async () => {
    const { fetchNode6max } = await load();
    httpReply = "unreachable";
    expect(await fetchNode6max("ign200_6max_D150_o3", "")).toBe("unreachable");
  });
});
