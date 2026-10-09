import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { testTempDir } from "../test/tempDir";
import { GtowSolveCache, NODE_OK, NO_NODE, runScanWorker } from "./gtowSolveCache";
import { scanCache, type ScanReply } from "./gtowCacheScanWorker";

// THE ROW COUNTERS (2026-10-09): the cache's size is never COUNTED on the API's thread any more — summary(), stats via
// the route and the size cap read four counters kept in gtow_cache_totals, moved in the same transaction as each write.
// A file from before the counters is counted once, in a Worker, never while a session is live.
const caches: GtowSolveCache[] = [];
const dir = testTempDir("gtow-cache-counters-", { release: () => { for (const c of caches) c.close(); } });
let n = 0;
const fileOf = () => join(dir, `c${++n}.sqlite`);
const open = (path: string, opts: { maxBytes?: number } = {}) => { const c = new GtowSolveCache({ path, flushMs: 1, ...opts }); caches.push(c); return c; };
const node = (pad = 10) => JSON.stringify({ action_solutions: [{ pad: "x".repeat(pad) }] });
const counters = (path: string) => {
  const db = new Database(path, { readonly: true });
  const m = Object.fromEntries((db.query("SELECT name, n FROM gtow_cache_totals WHERE name LIKE 'rows_%'").all() as { name: string; n: number }[]).map((r) => [r.name, r.n]));
  db.close();
  return m;
};
const truth = (path: string) => { const r = scanCache(path, 0); if (!r.ok) throw new Error(r.error); return r.rows; };

describe("gtow cache row counters", () => {
  it("a new file is seeded at zero and the counters follow every insert and verdict upgrade exactly", () => {
    const path = fileOf();
    const c = open(path);
    c.noteTree("k1", "post", JSON.stringify({ a: 1 }));
    c.putNode("k1", "a", NODE_OK, node(500));
    c.putNode("k1", "b", NO_NODE, null);
    c.flush();
    c.putNode("k1", "b", NODE_OK, node(800));               // the verdict replaced by a full node
    c.noteTree("k2", "pre", JSON.stringify({ b: 2 }));
    c.putNode("k2", "x", NO_NODE, null);
    c.flush();
    const t = truth(path);
    expect(c.summary()).toMatchObject({ trees: t.trees, nodes: t.nodes });
    const k = counters(path);
    expect(k).toMatchObject({ rows_trees: t.trees, rows_nodes: t.nodes, rows_neg: t.negatives, rows_bytes: t.storedBytes });
    expect(k.rows_seeded).toBeGreaterThan(0);
    expect(t).toMatchObject({ trees: 2, nodes: 3, negatives: 1 });
  });

  it("age deletion and eviction move the counters with the rows; the cap is read from them", () => {
    const path = fileOf();
    const c = open(path);
    c.noteTree("old", "post", "{}");
    c.putNode("old", "x", NODE_OK, node(50));
    c.noteTree("new", "post", "{}");
    for (const a of ["n1", "n2", "n3", "n4", "n5"]) c.putNode("new", a, NODE_OK, JSON.stringify({ action_solutions: [{ pad: Array.from({ length: 1500 }, () => Math.random().toString(36).slice(2)).join("") }] }));
    c.close();
    const now = Date.now();
    const db = new Database(path);
    db.query("UPDATE gtow_cache_trees SET last_hit_ms = ? WHERE key = 'old'").run(now - 61 * 86_400_000);
    db.query("UPDATE gtow_cache_nodes SET last_hit_ms = ? WHERE key = 'old'").run(now - 61 * 86_400_000);
    ["n1", "n2", "n3", "n4", "n5"].forEach((a, i) => db.query("UPDATE gtow_cache_nodes SET last_hit_ms = ? WHERE addr = ?").run(now - (10 - i) * 60_000, a));
    const total = (db.query("SELECT SUM(bytes) b FROM gtow_cache_nodes WHERE key = 'new'").get() as { b: number }).b;
    db.close();
    const c2 = open(path, { maxBytes: Math.round(total * 0.62) });
    expect(c2.summary().trees).toBe(1);
    const t = truth(path);
    expect(counters(path)).toMatchObject({ rows_trees: t.trees, rows_nodes: t.nodes, rows_neg: t.negatives, rows_bytes: t.storedBytes });
    expect(t.storedBytes).toBeLessThanOrEqual(total * 0.62);
  });

  it("a file from before the counters reads 'counting…' and is counted once, off the loop (the scan is the Worker's)", async () => {
    const path = fileOf();
    const a = open(path);
    a.noteTree("k", "post", "{}");
    a.putNode("k", "a", NODE_OK, node(300));
    a.putNode("k", "b", NO_NODE, null);
    a.close();
    const db = new Database(path);
    db.query("DELETE FROM gtow_cache_totals WHERE name LIKE 'rows_%'").run();   // as an old file
    db.close();
    const c = new GtowSolveCache({ path, flushMs: 1 });
    caches.push(c);
    let scans = 0;
    let release!: (r: ScanReply) => void;
    c.scanOffLoop = (p, recent) => { scans++; return new Promise((res) => { release = (r) => res(r); void recent; void p; }); };
    c.liveNow = () => false;
    expect(c.summary()).toMatchObject({ trees: null, nodes: null });
    expect(scans).toBe(1);
    // a write while the scan runs is added to its totals
    c.putNode("k", "c", NODE_OK, node(100));
    c.flush();
    release(scanCache(path, 0));           // the scan saw the file as it is now — this test's write included
    await c.whenSeeded();
    const t = truth(path);
    const k = counters(path);
    // the in-flight write is counted twice at most (scan + delta): the documented bound of a seed racing a write
    expect(k.rows_trees).toBe(t.trees);
    expect(k.rows_nodes).toBeGreaterThanOrEqual(t.nodes);
    expect(k.rows_nodes).toBeLessThanOrEqual(t.nodes + 1);
    (c as any).summaryMemo = null;
    expect(c.summary().trees).toBe(1);
  });

  it("never starts the counting scan while a poker session is live", () => {
    const path = fileOf();
    const a = open(path);
    a.noteTree("k", "post", "{}");
    a.putNode("k", "a", NODE_OK, node(10));
    a.close();
    const db = new Database(path);
    db.query("DELETE FROM gtow_cache_totals WHERE name LIKE 'rows_%'").run();
    db.close();
    const c = new GtowSolveCache({ path, flushMs: 1 });
    caches.push(c);
    let scans = 0;
    c.scanOffLoop = async () => { scans++; return { ok: false, error: "no" }; };
    c.liveNow = () => true;
    expect(c.summary().trees).toBeNull();
    expect(scans).toBe(0);
  });

  it("the Worker counts a real file on its own thread", async () => {
    const path = fileOf();
    const a = open(path);
    a.noteTree("k", "post", "{}");
    a.putNode("k", "a", NODE_OK, node(300));
    a.flush();
    const r = await runScanWorker(path, 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toMatchObject({ trees: 1, nodes: 1, negatives: 0 });
  });
});
